use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use anyhow::{anyhow, Context};
use arc_swap::ArcSwapOption;
use nix::{
    sys::signal::{kill, Signal},
    time::{clock_gettime, ClockId},
    unistd::Pid,
};
use qemu_display::{
    ConsoleListenerHandler, ConsoleListenerMapHandler, Cursor, MouseSet, Scanout, ScanoutDMABUF,
    ScanoutMap, ScanoutMmap, Update, UpdateDMABUF, UpdateMap,
};
use tokio::{sync::mpsc, task::JoinHandle};
use tracing::{debug, info, warn};

pub type SharedFrameState = Arc<ArcSwapOption<FrameBuffer>>;

#[derive(Debug, Clone)]
pub struct FrameBuffer {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub fourcc: u32,
    pub modifier: u64,
    pub storage: FrameStorage,
}

#[derive(Debug, Clone)]
pub enum FrameStorage {
    Mmap(Arc<ScanoutMmap>),
    Bytes(Arc<[u8]>),
}

impl FrameStorage {
    pub fn as_slice(&self) -> &[u8] {
        match self {
            Self::Mmap(mmap) => mmap.as_ref().as_ref(),
            Self::Bytes(bytes) => bytes.as_ref(),
        }
    }
}

#[derive(Debug)]
pub enum FrameEvent {
    Reset {
        w: u32,
        h: u32,
        stride: u32,
        fourcc: u32,
        modifier: u64,
    },
    Frame {
        ts_ns: u64,
    },
    Eos,
}

#[derive(Debug, Clone)]
pub struct BaseListener {
    inner: Arc<ListenerState>,
}

pub struct MapListener {
    inner: Arc<ListenerState>,
    current_scanout: Option<Arc<ScanoutMmap>>,
}

#[derive(Debug, Clone)]
pub struct SourceHandle {
    inner: Arc<ListenerState>,
    _stats_task: Arc<JoinHandle<()>>,
}

#[derive(Debug)]
struct ListenerState {
    shared: SharedFrameState,
    tx: mpsc::Sender<FrameEvent>,
    frames_pushed: Arc<AtomicU64>,
    frames_dropped: Arc<AtomicU64>,
    non_shareable_detection_armed: Arc<AtomicBool>,
    non_shareable_path_detected: Arc<AtomicBool>,
    cpu_surface: Arc<Mutex<Option<CpuSurface>>>,
    fatal_error: Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Clone)]
struct CpuSurface {
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    pixels: Arc<[u8]>,
}

pub struct QemuSource;

impl QemuSource {
    pub fn shared_state() -> SharedFrameState {
        Arc::new(ArcSwapOption::from(None))
    }

    pub fn listeners(
        shared: SharedFrameState,
        tx: mpsc::Sender<FrameEvent>,
    ) -> (BaseListener, MapListener, SourceHandle) {
        let frames_pushed = Arc::new(AtomicU64::new(0));
        let frames_dropped = Arc::new(AtomicU64::new(0));
        let non_shareable_detection_armed = Arc::new(AtomicBool::new(false));
        let non_shareable_path_detected = Arc::new(AtomicBool::new(false));
        let cpu_surface = Arc::new(Mutex::new(None));
        let fatal_error = Arc::new(Mutex::new(None));
        let inner = Arc::new(ListenerState {
            shared,
            tx,
            frames_pushed: frames_pushed.clone(),
            frames_dropped: frames_dropped.clone(),
            non_shareable_detection_armed,
            non_shareable_path_detected: non_shareable_path_detected.clone(),
            cpu_surface,
            fatal_error: fatal_error.clone(),
        });
        let stats_task = Arc::new(tokio::spawn(spawn_stats_logger(
            frames_pushed,
            frames_dropped,
        )));

        (
            BaseListener {
                inner: inner.clone(),
            },
            MapListener {
                inner: inner.clone(),
                current_scanout: None,
            },
            SourceHandle {
                inner,
                _stats_task: stats_task,
            },
        )
    }

    pub fn store_test_frame(shared: &SharedFrameState, frame: FrameBuffer) {
        shared.store(Some(Arc::new(frame)));
    }
}

impl BaseListener {
    pub fn arm_non_shareable_detection(&self) {
        self.inner
            .non_shareable_detection_armed
            .store(true, Ordering::Relaxed);
    }
}

#[async_trait::async_trait]
impl ConsoleListenerHandler for BaseListener {
    async fn scanout(&mut self, scanout: Scanout) {
        debug!(
            width = scanout.width,
            height = scanout.height,
            stride = scanout.stride,
            format = format_args!("0x{:08x}", scanout.format),
            data_len = scanout.data.len(),
            armed = self
                .inner
                .non_shareable_detection_armed
                .load(Ordering::Relaxed),
            "received base Scanout callback"
        );
        if let Err(error) = self.inner.handle_scanout(scanout) {
            self.inner.fail(error);
        }
    }

    async fn update(&mut self, update: Update) {
        debug!(
            x = update.x,
            y = update.y,
            width = update.w,
            height = update.h,
            stride = update.stride,
            format = format_args!("0x{:08x}", update.format),
            data_len = update.data.len(),
            armed = self
                .inner
                .non_shareable_detection_armed
                .load(Ordering::Relaxed),
            "received base Update callback"
        );
        if let Err(error) = self.inner.handle_update(update) {
            self.inner.fail(error);
        }
    }

    async fn scanout_dmabuf(&mut self, scanout: ScanoutDMABUF) {
        warn!(
            width = scanout.width,
            height = scanout.height,
            stride0 = scanout.stride[0],
            fourcc = format_args!("0x{:08x}", scanout.fourcc),
            modifier = scanout.modifier,
            armed = self
                .inner
                .non_shareable_detection_armed
                .load(Ordering::Relaxed),
            "received unexpected ScanoutDMABUF callback"
        );
        self.inner.mark_non_shareable();
    }

    async fn update_dmabuf(&mut self, update: UpdateDMABUF) {
        warn!(
            x = update.x,
            y = update.y,
            width = update.w,
            height = update.h,
            armed = self
                .inner
                .non_shareable_detection_armed
                .load(Ordering::Relaxed),
            "received unexpected UpdateDMABUF callback"
        );
        self.inner.mark_non_shareable();
    }

    async fn disable(&mut self) {
        debug!("console disabled by qemu");
    }

    async fn mouse_set(&mut self, _set: MouseSet) {}

    async fn cursor_define(&mut self, _cursor: Cursor) {}

    fn disconnected(&mut self) {
        self.inner.emit_event(FrameEvent::Eos);
    }

    fn interfaces(&self) -> Vec<String> {
        vec!["org.qemu.Display1.Listener.Unix.Map".to_string()]
    }
}

#[async_trait::async_trait]
impl ConsoleListenerMapHandler for MapListener {
    async fn scanout_map(&mut self, scanout: ScanoutMap) {
        debug!(
            width = scanout.width,
            height = scanout.height,
            stride = scanout.stride,
            format = format_args!("0x{:08x}", scanout.format),
            offset = scanout.offset,
            "received ScanoutMap callback"
        );
        if let Err(error) = self.replace_scanout(scanout) {
            self.inner.fail(error);
        }
    }

    async fn update_map(&mut self, update: UpdateMap) {
        debug!(
            x = update.x,
            y = update.y,
            width = update.w,
            height = update.h,
            "received UpdateMap callback"
        );
        if self.current_scanout.is_none() {
            warn!("received UpdateMap before ScanoutMap");
            self.inner.frames_dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }

        self.inner.emit_event(FrameEvent::Frame {
            ts_ns: monotonic_raw_ns(),
        });
    }
}

impl MapListener {
    fn replace_scanout(&mut self, scanout: ScanoutMap) -> anyhow::Result<()> {
        let width = scanout.width;
        let height = scanout.height;
        let stride = scanout.stride;
        let format = scanout.format;
        ensure_supported_format(format)?;

        let mapped = Arc::new(
            scanout
                .mmap()
                .context("failed to mmap shared framebuffer")?,
        );
        let frame = FrameBuffer {
            width,
            height,
            stride,
            fourcc: format,
            modifier: 0,
            storage: FrameStorage::Mmap(mapped.clone()),
        };

        self.current_scanout = Some(mapped);
        self.inner.shared.store(Some(Arc::new(frame.clone())));
        self.inner.emit_event(FrameEvent::Reset {
            w: frame.width,
            h: frame.height,
            stride: frame.stride,
            fourcc: frame.fourcc,
            modifier: frame.modifier,
        });

        Ok(())
    }
}

impl ListenerState {
    fn emit_event(&self, event: FrameEvent) {
        match self.tx.try_send(event) {
            Ok(()) => {
                self.frames_pushed.fetch_add(1, Ordering::Relaxed);
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.frames_dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                warn!("encoder channel is closed");
            }
        }
    }

    fn mark_non_shareable(&self) {
        if !self.non_shareable_detection_armed.load(Ordering::Relaxed) {
            debug!("ignoring base listener callback before map listener is armed");
            return;
        }
        self.non_shareable_path_detected
            .store(true, Ordering::Relaxed);
        self.emit_event(FrameEvent::Eos);
        raise_sigterm();
    }

    fn handle_scanout(&self, scanout: Scanout) -> anyhow::Result<()> {
        ensure_supported_format(scanout.format)?;
        let expected_len = scanout.height as usize * scanout.stride as usize;
        if scanout.data.len() < expected_len {
            return Err(anyhow!(
                "short scanout payload: got {}, expected at least {}",
                scanout.data.len(),
                expected_len
            ));
        }

        let pixels = Arc::<[u8]>::from(scanout.data);
        {
            let mut surface = lock_cpu_surface(&self.cpu_surface);
            *surface = Some(CpuSurface {
                width: scanout.width,
                height: scanout.height,
                stride: scanout.stride,
                format: scanout.format,
                pixels: pixels.clone(),
            });
        }
        self.shared.store(Some(Arc::new(FrameBuffer {
            width: scanout.width,
            height: scanout.height,
            stride: scanout.stride,
            fourcc: scanout.format,
            modifier: 0,
            storage: FrameStorage::Bytes(pixels),
        })));
        self.emit_event(FrameEvent::Reset {
            w: scanout.width,
            h: scanout.height,
            stride: scanout.stride,
            fourcc: scanout.format,
            modifier: 0,
        });
        self.emit_event(FrameEvent::Frame {
            ts_ns: monotonic_raw_ns(),
        });
        Ok(())
    }

    fn handle_update(&self, update: Update) -> anyhow::Result<()> {
        ensure_supported_format(update.format)?;
        let bytes_per_pixel = bytes_per_pixel(update.format)?;
        let update_width = usize::try_from(update.w.max(0)).unwrap_or(0);
        let update_height = usize::try_from(update.h.max(0)).unwrap_or(0);
        let update_x = usize::try_from(update.x.max(0)).unwrap_or(0);
        let update_y = usize::try_from(update.y.max(0)).unwrap_or(0);
        let row_bytes = update_width * bytes_per_pixel;
        let src_stride = update.stride as usize;

        let snapshot = {
            let mut surface_guard = lock_cpu_surface(&self.cpu_surface);
            let Some(surface) = surface_guard.as_mut() else {
                warn!("received Update before Scanout");
                self.frames_dropped.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            };

            if surface.format != update.format {
                return Err(anyhow!(
                    "update format mismatch: got 0x{:08x}, expected 0x{:08x}",
                    update.format,
                    surface.format
                ));
            }

            let dest_end_x = update_x + update_width;
            let dest_end_y = update_y + update_height;
            if dest_end_x > surface.width as usize || dest_end_y > surface.height as usize {
                return Err(anyhow!(
                    "update region out of bounds: x={} y={} w={} h={} surface={}x{}",
                    update.x,
                    update.y,
                    update.w,
                    update.h,
                    surface.width,
                    surface.height
                ));
            }

            let min_source_len = src_stride.saturating_mul(update_height);
            if update.data.len() < min_source_len {
                return Err(anyhow!(
                    "short update payload: got {}, expected at least {}",
                    update.data.len(),
                    min_source_len
                ));
            }

            let dest_stride = surface.stride as usize;
            let pixels = Arc::make_mut(&mut surface.pixels);
            for row in 0..update_height {
                let src_offset = row * src_stride;
                let dst_offset = (update_y + row) * dest_stride + update_x * bytes_per_pixel;
                let src = &update.data[src_offset..src_offset + row_bytes];
                let dst = &mut pixels[dst_offset..dst_offset + row_bytes];
                dst.copy_from_slice(src);
            }

            FrameBuffer {
                width: surface.width,
                height: surface.height,
                stride: surface.stride,
                fourcc: surface.format,
                modifier: 0,
                storage: FrameStorage::Bytes(surface.pixels.clone()),
            }
        };

        self.shared.store(Some(Arc::new(snapshot)));
        self.emit_event(FrameEvent::Frame {
            ts_ns: monotonic_raw_ns(),
        });
        Ok(())
    }

    fn fail(&self, error: anyhow::Error) {
        let mut fatal = lock_fatal_error(&self.fatal_error);
        if fatal.is_none() {
            *fatal = Some(error.to_string());
        }
        drop(fatal);
        self.emit_event(FrameEvent::Eos);
        raise_sigterm();
    }
}

impl SourceHandle {
    pub fn send_eos(&self) {
        self.inner.emit_event(FrameEvent::Eos);
    }

    pub fn non_shareable_path_detected(&self) -> bool {
        self.inner
            .non_shareable_path_detected
            .load(Ordering::Relaxed)
    }

    pub fn take_fatal_error(&self) -> Option<String> {
        lock_fatal_error(&self.inner.fatal_error).take()
    }

    pub fn shared(&self) -> SharedFrameState {
        self.inner.shared.clone()
    }

    pub fn counters(&self) -> (u64, u64) {
        (
            self.inner.frames_pushed.load(Ordering::Relaxed),
            self.inner.frames_dropped.load(Ordering::Relaxed),
        )
    }
}

fn lock_fatal_error(
    fatal_error: &Arc<Mutex<Option<String>>>,
) -> std::sync::MutexGuard<'_, Option<String>> {
    match fatal_error.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("fatal error state is poisoned");
            poisoned.into_inner()
        }
    }
}

fn lock_cpu_surface(
    cpu_surface: &Arc<Mutex<Option<CpuSurface>>>,
) -> std::sync::MutexGuard<'_, Option<CpuSurface>> {
    match cpu_surface.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("cpu surface state is poisoned");
            poisoned.into_inner()
        }
    }
}

fn ensure_supported_format(format: u32) -> anyhow::Result<()> {
    match format {
        PIXMAN_A8R8G8B8 | PIXMAN_X8R8G8B8 | PIXMAN_R5G6B5 => Ok(()),
        other => Err(anyhow!(
            "unsupported shared framebuffer format: 0x{other:08x}"
        )),
    }
}

fn bytes_per_pixel(format: u32) -> anyhow::Result<usize> {
    match format {
        PIXMAN_A8R8G8B8 | PIXMAN_X8R8G8B8 => Ok(4),
        PIXMAN_R5G6B5 => Ok(2),
        other => Err(anyhow!(
            "unsupported shared framebuffer format: 0x{other:08x}"
        )),
    }
}

fn raise_sigterm() {
    if std::env::var_os("PVE_RECORD_SUPPRESS_SIGTERM").is_some() {
        return;
    }
    if let Err(error) = kill(Pid::this(), Signal::SIGTERM) {
        warn!(error = %error, "failed to signal recorder shutdown");
    }
}

fn monotonic_raw_ns() -> u64 {
    match clock_gettime(ClockId::CLOCK_MONOTONIC_RAW) {
        Ok(ts) => (ts.tv_sec() as u64)
            .saturating_mul(1_000_000_000)
            .saturating_add(ts.tv_nsec() as u64),
        Err(error) => {
            warn!(error = %error, "failed to read monotonic clock");
            0
        }
    }
}

async fn spawn_stats_logger(frames_pushed: Arc<AtomicU64>, frames_dropped: Arc<AtomicU64>) {
    let mut last_pushed = 0;
    let mut last_dropped = 0;

    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let pushed = frames_pushed.load(Ordering::Relaxed);
        let dropped = frames_dropped.load(Ordering::Relaxed);
        let pushed_delta = pushed.saturating_sub(last_pushed);
        let dropped_delta = dropped.saturating_sub(last_dropped);
        last_pushed = pushed;
        last_dropped = dropped;
        info!(pushed_delta, dropped_delta, "recorder frame queue stats");
    }
}

pub const PIXMAN_X8R8G8B8: u32 = 537_004_168;
pub const PIXMAN_A8R8G8B8: u32 = 537_036_936;
pub const PIXMAN_R5G6B5: u32 = 268_567_909;
