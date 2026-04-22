use std::{fs::File, path::PathBuf, process::Stdio, time::Duration};

use mp4::{AvcConfig, Bytes, MediaConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig, TrackType};
use openh264::{
    encoder::{
        BitRate, Complexity, Encoder as OpenH264Encoder, EncoderConfig as OpenH264EncoderConfig,
        FrameRate, FrameType, IntraFramePeriod, Level, Profile, QpRange, RateControlMode,
        UsageType, VuiConfig,
    },
    formats::{BgraSliceU8, YUVBuffer, YUVSource},
    nal_units, OpenH264API,
};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStderr, ChildStdin, Command},
    time::Instant,
};
use tracing::{debug, info, warn};

use crate::args::{EncoderMode, QualityMode};
use crate::qemu_source::{
    FrameBuffer, FrameEvent, SharedFrameState, PIXMAN_A8R8G8B8, PIXMAN_R5G6B5, PIXMAN_X8R8G8B8,
};

#[derive(Debug, Clone)]
pub struct EncoderConfig {
    pub output: PathBuf,
    pub fps: Option<u32>,
    pub quality: QualityMode,
    pub encoder: EncoderMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncoderTerminal {
    Running,
    Eos,
    Fatal(String),
}

#[derive(Debug, Error)]
pub enum EncoderError {
    #[error("failed to create output file")]
    CreateOutput(#[source] std::io::Error),
    #[error("failed to configure openh264 encoder")]
    OpenH264Encoder(#[source] openh264::Error),
    #[error("failed to create mp4 writer: {0}")]
    CreateMp4(#[source] mp4::Error),
    #[error("failed to add mp4 track: {0}")]
    AddTrack(#[source] mp4::Error),
    #[error("failed to write mp4 sample: {0}")]
    WriteSample(#[source] mp4::Error),
    #[error("failed to finish mp4 writer: {0}")]
    FinishMp4(#[source] mp4::Error),
    #[error("failed to encode frame: {0}")]
    EncodeFrame(#[source] openh264::Error),
    #[error("EOS timeout >=5 s")]
    EosTimeout,
    #[error("{0}")]
    Fatal(String),
    #[error("unsupported shared framebuffer format 0x{0:08x}")]
    UnsupportedFormat(u32),
    #[error("shared framebuffer dimensions must be non-zero")]
    ZeroDimensions,
    #[error("shared framebuffer dimensions must be even for I420 output")]
    OddDimensions,
    #[error("shared framebuffer payload is too short")]
    ShortFrame,
    #[error("missing shared frame while encoding")]
    MissingSharedFrame,
    #[error("first keyframe is missing SPS/PPS parameter sets")]
    MissingParameterSets,
    #[error("encoded video sample is empty")]
    EmptySample,
    #[error("x264 backend requested but ffmpeg with libx264 is unavailable")]
    X264Unavailable,
    #[error("failed to spawn ffmpeg")]
    SpawnFfmpeg(#[source] std::io::Error),
    #[error("failed to open ffmpeg stdin")]
    MissingFfmpegStdin,
    #[error("failed to write frame to ffmpeg stdin")]
    WriteFfmpeg(#[source] std::io::Error),
    #[error("ffmpeg exited unsuccessfully: {0}")]
    FfmpegFailed(String),
}

pub struct Encoder {
    event_task: Option<tokio::task::JoinHandle<()>>,
    terminal_rx: watch::Receiver<EncoderTerminal>,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

struct EncodeState {
    encoder: OpenH264Encoder,
    mp4: Mp4Writer<File>,
    width: u32,
    height: u32,
    fourcc: u32,
    track_ready: bool,
    first_ts_ns: Option<u64>,
    last_sample_duration: u32,
    pending_sample: Option<PendingSample>,
    staging_bgra: Vec<u8>,
}

struct PendingSample {
    start_time: u64,
    is_sync: bool,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackendKind {
    OpenH264,
    X264,
}

struct X264State {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr: Option<ChildStderr>,
    width: u32,
    height: u32,
    staging_bgra: Vec<u8>,
    has_frame: bool,
    ticker: tokio::time::Interval,
}

impl Encoder {
    pub fn start(
        config: EncoderConfig,
        shared: SharedFrameState,
        rx: mpsc::Receiver<FrameEvent>,
    ) -> Result<Self, EncoderError> {
        let backend = select_backend(config.encoder)?;
        let (terminal_tx, terminal_rx) = watch::channel(EncoderTerminal::Running);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        info!(backend = ?backend, "starting encoder backend");
        let event_task = match backend {
            BackendKind::OpenH264 => tokio::spawn(run_openh264_event_loop(
                config,
                shared,
                rx,
                shutdown_rx,
                terminal_tx,
            )),
            BackendKind::X264 => tokio::spawn(run_x264_event_loop(
                config,
                shared,
                rx,
                shutdown_rx,
                terminal_tx,
            )),
        };

        Ok(Self {
            event_task: Some(event_task),
            terminal_rx,
            shutdown_tx: Some(shutdown_tx),
        })
    }

    pub async fn wait_terminal(&self) -> EncoderTerminal {
        let mut rx = self.terminal_rx.clone();
        loop {
            let current = rx.borrow().clone();
            if current != EncoderTerminal::Running {
                return current;
            }
            if rx.changed().await.is_err() {
                return EncoderTerminal::Fatal("encoder status channel closed".into());
            }
        }
    }

    pub async fn finalize(&mut self) -> Result<(), EncoderError> {
        let terminal = tokio::time::timeout(Duration::from_secs(5), self.wait_terminal())
            .await
            .map_err(|_| EncoderError::EosTimeout)?;
        if let Some(event_task) = self.event_task.take() {
            let _ = event_task.await;
        }

        match terminal {
            EncoderTerminal::Eos => Ok(()),
            EncoderTerminal::Fatal(message) => Err(EncoderError::Fatal(message)),
            EncoderTerminal::Running => unreachable!(),
        }
    }

    pub async fn shutdown_now(&mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        if let Some(event_task) = self.event_task.take() {
            event_task.abort();
            let _ = event_task.await;
        }
    }
}

async fn run_openh264_event_loop(
    config: EncoderConfig,
    shared: SharedFrameState,
    mut rx: mpsc::Receiver<FrameEvent>,
    mut shutdown_rx: oneshot::Receiver<()>,
    terminal_tx: watch::Sender<EncoderTerminal>,
) {
    let mut state = None::<EncodeState>;
    let mut last_pts_ns = None::<u64>;
    let fps_limit = config.fps;

    loop {
        let event = tokio::select! {
            biased;
            _ = &mut shutdown_rx => {
                FrameEvent::Eos
            }
            maybe_event = rx.recv() => {
                match maybe_event {
                    Some(event) => event,
                    None => FrameEvent::Eos,
                }
            }
        };

        let should_break = matches!(event, FrameEvent::Eos);
        let outcome = match event {
            FrameEvent::Reset {
                w,
                h,
                stride,
                fourcc,
                ..
            } => ensure_state(&mut state, &config, w, h, stride, fourcc),
            FrameEvent::Frame { ts_ns } => {
                if let Some(fps) = fps_limit {
                    let min_delta = 1_000_000_000u64 / fps as u64;
                    if let Some(last) = last_pts_ns {
                        if ts_ns.saturating_sub(last) < min_delta {
                            continue;
                        }
                    }
                }
                last_pts_ns = Some(ts_ns);
                encode_shared_frame(&shared, &mut state, ts_ns)
            }
            FrameEvent::Eos => finish_state(state.take()),
        };

        match outcome {
            Ok(terminal) => {
                if let Some(terminal) = terminal {
                    let _ = terminal_tx.send(terminal);
                    return;
                }
            }
            Err(error) => {
                let _ = terminal_tx.send(EncoderTerminal::Fatal(error.to_string()));
                return;
            }
        }

        if should_break {
            let _ = terminal_tx.send(EncoderTerminal::Eos);
            return;
        }
    }
}

async fn run_x264_event_loop(
    config: EncoderConfig,
    shared: SharedFrameState,
    mut rx: mpsc::Receiver<FrameEvent>,
    mut shutdown_rx: oneshot::Receiver<()>,
    terminal_tx: watch::Sender<EncoderTerminal>,
) {
    let mut state = None::<X264State>;

    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown_rx => {
                match finish_x264(state.take()).await {
                    Ok(()) => {
                        let _ = terminal_tx.send(EncoderTerminal::Eos);
                    }
                    Err(error) => {
                        let _ = terminal_tx.send(EncoderTerminal::Fatal(error.to_string()));
                    }
                }
                return;
            }
            maybe_event = rx.recv() => {
                let Some(event) = maybe_event else {
                    match finish_x264(state.take()).await {
                        Ok(()) => {
                            let _ = terminal_tx.send(EncoderTerminal::Eos);
                        }
                        Err(error) => {
                            let _ = terminal_tx.send(EncoderTerminal::Fatal(error.to_string()));
                        }
                    }
                    return;
                };

                let outcome = match event {
                    FrameEvent::Reset { w, h, stride, fourcc, .. } => ensure_x264_state(&mut state, &config, w, h, stride, fourcc),
                    FrameEvent::Frame { .. } => update_x264_frame(&mut state, &shared),
                    FrameEvent::Eos => {
                        match finish_x264(state.take()).await {
                            Ok(()) => {
                                let _ = terminal_tx.send(EncoderTerminal::Eos);
                            }
                            Err(error) => {
                                let _ = terminal_tx.send(EncoderTerminal::Fatal(error.to_string()));
                            }
                        }
                        return;
                    }
                };

                if let Err(error) = outcome {
                    let _ = terminal_tx.send(EncoderTerminal::Fatal(error.to_string()));
                    return;
                }
            }
            _ = async {
                if let Some(state) = state.as_mut() {
                    state.ticker.tick().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {
                if let Some(state) = state.as_mut() {
                    if let Err(error) = state.write_latest_frame().await {
                        let _ = terminal_tx.send(EncoderTerminal::Fatal(error.to_string()));
                        return;
                    }
                }
            }
        }
    }
}

fn ensure_state(
    state: &mut Option<EncodeState>,
    config: &EncoderConfig,
    width: u32,
    height: u32,
    _stride: u32,
    fourcc: u32,
) -> Result<Option<EncoderTerminal>, EncoderError> {
    ensure_supported_format(fourcc)?;
    ensure_even_dimensions(width, height)?;

    if let Some(existing) = state.as_ref() {
        if existing.width != width || existing.height != height {
            warn!(
                initial_width = existing.width,
                initial_height = existing.height,
                new_width = width,
                new_height = height,
                "resolution changed mid-recording; keeping original output dimensions"
            );
        }
        return Ok(None);
    }

    *state = Some(EncodeState::new(config, width, height, fourcc)?);
    Ok(None)
}

fn finish_state(state: Option<EncodeState>) -> Result<Option<EncoderTerminal>, EncoderError> {
    if let Some(mut state) = state {
        state.flush_pending_sample()?;
        state.mp4.write_end().map_err(EncoderError::FinishMp4)?;
    }
    Ok(Some(EncoderTerminal::Eos))
}

fn encode_shared_frame(
    shared: &SharedFrameState,
    state: &mut Option<EncodeState>,
    ts_ns: u64,
) -> Result<Option<EncoderTerminal>, EncoderError> {
    let Some(state) = state.as_mut() else {
        return Ok(None);
    };

    let frame = shared.load_full().ok_or(EncoderError::MissingSharedFrame)?;
    let yuv = build_yuv_from_bgra(frame.as_ref(), state)?;
    let (annex_b, is_keyframe) = {
        let bitstream = state
            .encoder
            .encode(&yuv)
            .map_err(EncoderError::EncodeFrame)?;
        (
            bitstream.to_vec(),
            matches!(bitstream.frame_type(), FrameType::IDR),
        )
    };
    if annex_b.is_empty() {
        return Ok(None);
    }

    state.write_encoded_sample(&annex_b, is_keyframe, ts_ns)?;
    Ok(None)
}

fn select_backend(mode: EncoderMode) -> Result<BackendKind, EncoderError> {
    match mode {
        EncoderMode::Openh264 => Ok(BackendKind::OpenH264),
        EncoderMode::X264 => {
            if x264_available() {
                Ok(BackendKind::X264)
            } else {
                Err(EncoderError::X264Unavailable)
            }
        }
        EncoderMode::Auto => {
            if x264_available() {
                Ok(BackendKind::X264)
            } else {
                Ok(BackendKind::OpenH264)
            }
        }
    }
}

fn x264_available() -> bool {
    let output = std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.contains("libx264 ")
        }
        _ => false,
    }
}

fn ensure_x264_state(
    state: &mut Option<X264State>,
    config: &EncoderConfig,
    width: u32,
    height: u32,
    _stride: u32,
    fourcc: u32,
) -> Result<(), EncoderError> {
    ensure_supported_format(fourcc)?;
    ensure_even_dimensions(width, height)?;

    if let Some(existing) = state.as_ref() {
        if existing.width != width || existing.height != height {
            warn!(
                initial_width = existing.width,
                initial_height = existing.height,
                new_width = width,
                new_height = height,
                "resolution changed mid-recording; keeping original x264 output dimensions"
            );
        }
        return Ok(());
    }

    *state = Some(X264State::new(config, width, height, fourcc)?);
    Ok(())
}

fn update_x264_frame(
    state: &mut Option<X264State>,
    shared: &SharedFrameState,
) -> Result<(), EncoderError> {
    let Some(state) = state.as_mut() else {
        return Ok(());
    };
    let frame = shared.load_full().ok_or(EncoderError::MissingSharedFrame)?;
    state.update_frame(frame.as_ref())
}

async fn finish_x264(state: Option<X264State>) -> Result<(), EncoderError> {
    if let Some(mut state) = state {
        state.finish().await?;
    }
    Ok(())
}

impl EncodeState {
    fn new(
        config: &EncoderConfig,
        width: u32,
        height: u32,
        fourcc: u32,
    ) -> Result<Self, EncoderError> {
        let fps = config.fps.unwrap_or(60);
        let keyframe_interval = fps.saturating_mul(2).max(1);
        let encoder_config = build_openh264_config(config.quality, fps, keyframe_interval);
        let api = OpenH264API::from_source();
        let encoder = OpenH264Encoder::with_api_config(api, encoder_config)
            .map_err(EncoderError::OpenH264Encoder)?;
        let file = File::create(&config.output).map_err(EncoderError::CreateOutput)?;
        let mp4 = Mp4Writer::write_start(
            file,
            &Mp4Config {
                major_brand: "isom".parse().expect("valid fourcc"),
                minor_version: 512,
                compatible_brands: vec![
                    "isom".parse().expect("valid fourcc"),
                    "iso2".parse().expect("valid fourcc"),
                    "avc1".parse().expect("valid fourcc"),
                    "mp41".parse().expect("valid fourcc"),
                ],
                timescale: 1_000,
            },
        )
        .map_err(EncoderError::CreateMp4)?;

        Ok(Self {
            encoder,
            mp4,
            width,
            height,
            fourcc,
            track_ready: false,
            first_ts_ns: None,
            last_sample_duration: 90_000u32 / fps.max(1),
            pending_sample: None,
            staging_bgra: vec![0; width as usize * height as usize * 4],
        })
    }

    fn write_encoded_sample(
        &mut self,
        annex_b: &[u8],
        is_keyframe: bool,
        ts_ns: u64,
    ) -> Result<(), EncoderError> {
        if !self.track_ready {
            if !is_keyframe {
                return Ok(());
            }

            let (sps, pps) = extract_parameter_sets(annex_b)?;
            self.mp4
                .add_track(&TrackConfig {
                    track_type: TrackType::Video,
                    timescale: 90_000,
                    language: "und".into(),
                    media_conf: MediaConfig::AvcConfig(AvcConfig {
                        width: self.width as u16,
                        height: self.height as u16,
                        seq_param_set: sps,
                        pic_param_set: pps,
                    }),
                })
                .map_err(EncoderError::AddTrack)?;
            self.track_ready = true;
        }

        let sample_bytes = annex_b_to_avcc(annex_b)?;
        if sample_bytes.is_empty() {
            return Err(EncoderError::EmptySample);
        }

        let start_time = self.sample_start_time(ts_ns);
        if let Some(pending) = self.pending_sample.take() {
            let duration = start_time
                .saturating_sub(pending.start_time)
                .try_into()
                .unwrap_or(u32::MAX)
                .max(1);
            self.write_sample(pending, duration)?;
            self.last_sample_duration = duration;
        }

        self.pending_sample = Some(PendingSample {
            start_time,
            is_sync: is_keyframe,
            bytes: sample_bytes,
        });
        Ok(())
    }

    fn sample_start_time(&mut self, ts_ns: u64) -> u64 {
        let base = *self.first_ts_ns.get_or_insert(ts_ns);
        let ticks = ts_ns.saturating_sub(base).saturating_mul(90_000) / 1_000_000_000;
        if let Some(pending) = self.pending_sample.as_ref() {
            ticks.max(pending.start_time.saturating_add(1))
        } else {
            ticks
        }
    }

    fn flush_pending_sample(&mut self) -> Result<(), EncoderError> {
        if let Some(pending) = self.pending_sample.take() {
            self.write_sample(pending, self.last_sample_duration.max(1))?;
        }
        Ok(())
    }

    fn write_sample(&mut self, pending: PendingSample, duration: u32) -> Result<(), EncoderError> {
        let sample = Mp4Sample {
            start_time: pending.start_time,
            duration,
            rendering_offset: 0,
            is_sync: pending.is_sync,
            bytes: Bytes::from(pending.bytes),
        };
        self.mp4
            .write_sample(1, &sample)
            .map_err(EncoderError::WriteSample)
    }
}

impl X264State {
    fn new(
        config: &EncoderConfig,
        width: u32,
        height: u32,
        _fourcc: u32,
    ) -> Result<Self, EncoderError> {
        let fps = config.fps.unwrap_or(60);
        let mut command = Command::new("ffmpeg");
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-y")
            .arg("-f")
            .arg("rawvideo")
            .arg("-pix_fmt")
            .arg("bgra")
            .arg("-video_size")
            .arg(format!("{width}x{height}"))
            .arg("-framerate")
            .arg(fps.to_string())
            .arg("-i")
            .arg("pipe:0")
            .arg("-an");
        apply_x264_quality_args(&mut command, config.quality);
        command
            .arg("-movflags")
            .arg("+faststart")
            .arg(config.output.as_os_str())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(EncoderError::SpawnFfmpeg)?;
        let stdin = child.stdin.take().ok_or(EncoderError::MissingFfmpegStdin)?;
        let stderr = child.stderr.take();
        let period = Duration::from_nanos(1_000_000_000u64 / u64::from(fps.max(1)));
        let mut ticker = tokio::time::interval_at(Instant::now() + period, period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        Ok(Self {
            child,
            stdin: Some(stdin),
            stderr,
            width,
            height,
            staging_bgra: vec![0; width as usize * height as usize * 4],
            has_frame: false,
            ticker,
        })
    }

    fn update_frame(&mut self, frame: &FrameBuffer) -> Result<(), EncoderError> {
        ensure_supported_format(frame.fourcc)?;
        ensure_even_dimensions(frame.width, frame.height)?;

        let bytes = frame.storage.as_slice();
        let required = frame.stride as usize * frame.height as usize;
        if bytes.len() < required {
            return Err(EncoderError::ShortFrame);
        }

        self.staging_bgra.fill(0);
        blit_frame_into_staging(
            frame,
            bytes,
            &mut self.staging_bgra,
            self.width,
            self.height,
        )?;
        self.has_frame = true;
        Ok(())
    }

    async fn write_latest_frame(&mut self) -> Result<(), EncoderError> {
        if self.has_frame {
            let Some(stdin) = self.stdin.as_mut() else {
                return Ok(());
            };
            stdin
                .write_all(&self.staging_bgra)
                .await
                .map_err(EncoderError::WriteFfmpeg)?;
        }
        Ok(())
    }

    async fn finish(&mut self) -> Result<(), EncoderError> {
        let _ = self.stdin.take();
        let status = self.child.wait().await.map_err(EncoderError::SpawnFfmpeg)?;
        if status.success() {
            Ok(())
        } else {
            let mut stderr = Vec::new();
            if let Some(mut handle) = self.stderr.take() {
                handle
                    .read_to_end(&mut stderr)
                    .await
                    .map_err(EncoderError::WriteFfmpeg)?;
            }
            let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
            Err(EncoderError::FfmpegFailed(stderr))
        }
    }
}

fn apply_x264_quality_args(command: &mut Command, quality: QualityMode) {
    command.arg("-c:v").arg("libx264");
    match quality {
        QualityMode::Best => {
            command
                .arg("-preset")
                .arg("veryslow")
                .arg("-qp")
                .arg("0")
                .arg("-pix_fmt")
                .arg("yuv444p")
                .arg("-profile:v")
                .arg("high444");
        }
        QualityMode::Balanced => {
            command
                .arg("-preset")
                .arg("slow")
                .arg("-crf")
                .arg("10")
                .arg("-pix_fmt")
                .arg("yuv444p")
                .arg("-profile:v")
                .arg("high444");
        }
        QualityMode::Realtime => {
            command
                .arg("-preset")
                .arg("veryfast")
                .arg("-crf")
                .arg("18")
                .arg("-pix_fmt")
                .arg("yuv420p")
                .arg("-profile:v")
                .arg("high");
        }
    }
}

fn build_openh264_config(
    quality: QualityMode,
    fps: u32,
    keyframe_interval: u32,
) -> OpenH264EncoderConfig {
    let base = OpenH264EncoderConfig::new()
        .max_frame_rate(FrameRate::from_hz(fps as f32))
        .skip_frames(false)
        .intra_frame_period(IntraFramePeriod::from_num_frames(keyframe_interval))
        .rate_control_mode(RateControlMode::Off)
        .adaptive_quantization(false)
        .background_detection(false);

    match quality {
        QualityMode::Best => base
            .usage_type(UsageType::ScreenContentRealTime)
            .profile(Profile::High)
            .level(Level::Level_5_1)
            .complexity(Complexity::High)
            .qp(QpRange::new(1, 6))
            .bitrate(BitRate::from_bps(120_000_000))
            .vui(VuiConfig::srgb()),
        QualityMode::Balanced => base
            .usage_type(UsageType::ScreenContentRealTime)
            .profile(Profile::High)
            .level(Level::Level_4_1)
            .complexity(Complexity::Medium)
            .qp(QpRange::new(8, 18))
            .bitrate(BitRate::from_bps(45_000_000))
            .vui(VuiConfig::srgb()),
        QualityMode::Realtime => base
            .usage_type(UsageType::ScreenContentRealTime)
            .profile(Profile::Main)
            .level(Level::Level_4_0)
            .complexity(Complexity::Low)
            .qp(QpRange::new(18, 32))
            .bitrate(BitRate::from_bps(16_000_000))
            .vui(VuiConfig::srgb()),
    }
}

fn extract_parameter_sets(annex_b: &[u8]) -> Result<(Vec<u8>, Vec<u8>), EncoderError> {
    let mut sps = None;
    let mut pps = None;
    for nal in nal_units(annex_b) {
        let Some(nal) = strip_start_code(nal) else {
            continue;
        };
        match nal[0] & 0x1f {
            7 if sps.is_none() => sps = Some(nal.to_vec()),
            8 if pps.is_none() => pps = Some(nal.to_vec()),
            _ => {}
        }
    }

    match (sps, pps) {
        (Some(sps), Some(pps)) => Ok((sps, pps)),
        _ => Err(EncoderError::MissingParameterSets),
    }
}

fn annex_b_to_avcc(annex_b: &[u8]) -> Result<Vec<u8>, EncoderError> {
    let mut out = Vec::with_capacity(annex_b.len());
    for nal in nal_units(annex_b) {
        let Some(nal) = strip_start_code(nal) else {
            continue;
        };
        match nal[0] & 0x1f {
            7 | 8 | 9 => continue,
            _ => {}
        }
        let len = u32::try_from(nal.len()).map_err(|_| EncoderError::EmptySample)?;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(nal);
    }
    Ok(out)
}

fn strip_start_code(nal: &[u8]) -> Option<&[u8]> {
    if nal.starts_with(&[0, 0, 0, 1]) {
        Some(&nal[4..])
    } else if nal.starts_with(&[0, 0, 1]) {
        Some(&nal[3..])
    } else {
        None
    }
}

fn build_yuv_from_bgra(
    frame: &FrameBuffer,
    state: &mut EncodeState,
) -> Result<YUVBuffer, EncoderError> {
    ensure_supported_format(frame.fourcc)?;
    ensure_even_dimensions(frame.width, frame.height)?;

    let bytes = frame.storage.as_slice();
    let required = frame.stride as usize * frame.height as usize;
    if bytes.len() < required {
        return Err(EncoderError::ShortFrame);
    }

    if frame.width == state.width
        && frame.height == state.height
        && frame.fourcc == state.fourcc
        && matches!(frame.fourcc, PIXMAN_A8R8G8B8 | PIXMAN_X8R8G8B8)
    {
        let bgra = frame_bgra_bytes(frame, bytes)?;
        let mut yuv = YUVBuffer::new(state.width as usize, state.height as usize);
        yuv.read_rgb(BgraSliceU8::new(
            bgra,
            (state.width as usize, state.height as usize),
        ));
        return Ok(expand_yuv_to_full_range(&yuv));
    }

    debug!(
        source_width = frame.width,
        source_height = frame.height,
        output_width = state.width,
        output_height = state.height,
        "copying frame into staging buffer to preserve original output dimensions"
    );
    state.staging_bgra.fill(0);
    blit_frame_into_staging(
        frame,
        bytes,
        &mut state.staging_bgra,
        state.width,
        state.height,
    )?;
    let mut yuv = YUVBuffer::new(state.width as usize, state.height as usize);
    yuv.read_rgb(BgraSliceU8::new(
        &state.staging_bgra,
        (state.width as usize, state.height as usize),
    ));
    Ok(expand_yuv_to_full_range(&yuv))
}

fn expand_yuv_to_full_range(yuv: &YUVBuffer) -> YUVBuffer {
    let (width, height) = yuv.dimensions();
    let y_plane_len = width * height;
    let uv_plane_len = y_plane_len / 4;
    let mut out = Vec::with_capacity(y_plane_len + uv_plane_len * 2);

    out.extend(yuv.y().iter().copied().map(expand_luma_full_range));
    out.extend(yuv.u().iter().copied().map(expand_chroma_full_range));
    out.extend(yuv.v().iter().copied().map(expand_chroma_full_range));

    YUVBuffer::from_vec(out, width, height)
}

fn expand_luma_full_range(value: u8) -> u8 {
    if value <= 16 {
        0
    } else if value >= 235 {
        255
    } else {
        (((u16::from(value) - 16) * 255 + 109) / 219) as u8
    }
}

fn expand_chroma_full_range(value: u8) -> u8 {
    let signed = i16::from(value) - 128;
    let expanded = (i32::from(signed) * 255 + 112) / 224;
    (expanded + 128).clamp(0, 255) as u8
}

fn frame_bgra_bytes<'a>(frame: &FrameBuffer, bytes: &'a [u8]) -> Result<&'a [u8], EncoderError> {
    let width = frame.width as usize;
    let height = frame.height as usize;
    let stride = frame.stride as usize;

    match frame.fourcc {
        PIXMAN_A8R8G8B8 | PIXMAN_X8R8G8B8 => {
            if stride == width * 4 {
                Ok(&bytes[..width * height * 4])
            } else {
                Err(EncoderError::ShortFrame)
            }
        }
        PIXMAN_R5G6B5 => Err(EncoderError::UnsupportedFormat(frame.fourcc)),
        other => Err(EncoderError::UnsupportedFormat(other)),
    }
}

fn blit_frame_into_staging(
    frame: &FrameBuffer,
    bytes: &[u8],
    dst: &mut [u8],
    out_width: u32,
    out_height: u32,
) -> Result<(), EncoderError> {
    let src_stride = frame.stride as usize;
    let dst_stride = out_width as usize * 4;
    let copy_width = frame.width.min(out_width) as usize;
    let copy_height = frame.height.min(out_height) as usize;

    match frame.fourcc {
        PIXMAN_A8R8G8B8 | PIXMAN_X8R8G8B8 => {
            let row_bytes = copy_width * 4;
            for row in 0..copy_height {
                let src_offset = row * src_stride;
                let dst_offset = row * dst_stride;
                dst[dst_offset..dst_offset + row_bytes]
                    .copy_from_slice(&bytes[src_offset..src_offset + row_bytes]);
            }
        }
        PIXMAN_R5G6B5 => {
            for row in 0..copy_height {
                for col in 0..copy_width {
                    let src_offset = row * src_stride + col * 2;
                    let dst_offset = row * dst_stride + col * 4;
                    let pixel = u16::from_le_bytes([bytes[src_offset], bytes[src_offset + 1]]);
                    let r = ((pixel >> 11) & 0x1f) as u8;
                    let g = ((pixel >> 5) & 0x3f) as u8;
                    let b = (pixel & 0x1f) as u8;
                    dst[dst_offset] = (b << 3) | (b >> 2);
                    dst[dst_offset + 1] = (g << 2) | (g >> 4);
                    dst[dst_offset + 2] = (r << 3) | (r >> 2);
                    dst[dst_offset + 3] = 0xff;
                }
            }
        }
        other => return Err(EncoderError::UnsupportedFormat(other)),
    }

    Ok(())
}

fn ensure_supported_format(fourcc: u32) -> Result<(), EncoderError> {
    match fourcc {
        PIXMAN_A8R8G8B8 | PIXMAN_X8R8G8B8 | PIXMAN_R5G6B5 => Ok(()),
        other => Err(EncoderError::UnsupportedFormat(other)),
    }
}

fn ensure_even_dimensions(width: u32, height: u32) -> Result<(), EncoderError> {
    if width == 0 || height == 0 {
        return Err(EncoderError::ZeroDimensions);
    }
    if width % 2 != 0 || height % 2 != 0 {
        return Err(EncoderError::OddDimensions);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{process::Command, sync::Arc};

    use openh264::formats::YUVSource;
    use tempfile::tempdir;

    use super::*;
    use crate::qemu_source::{FrameStorage, PIXMAN_A8R8G8B8};

    #[test]
    fn build_yuv_from_bgra_black_frame() {
        let dir = tempdir().unwrap();
        let mut state = EncodeState::new(
            &EncoderConfig {
                output: dir.path().join("black.mp4"),
                fps: Some(60),
                quality: QualityMode::Best,
                encoder: EncoderMode::Openh264,
            },
            2,
            2,
            PIXMAN_A8R8G8B8,
        )
        .unwrap();
        let frame = FrameBuffer {
            width: 2,
            height: 2,
            stride: 8,
            fourcc: PIXMAN_A8R8G8B8,
            modifier: 0,
            storage: FrameStorage::Bytes(Arc::<[u8]>::from(vec![
                0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
            ])),
        };

        let yuv = build_yuv_from_bgra(&frame, &mut state).unwrap();
        assert_eq!(yuv.y().len(), 4);
        assert_eq!(yuv.u().len(), 1);
        assert_eq!(yuv.v().len(), 1);
        assert!(yuv.y().iter().all(|value| *value <= 2));
        assert!((i16::from(yuv.u()[0]) - 128).abs() <= 2);
        assert!((i16::from(yuv.v()[0]) - 128).abs() <= 2);
    }

    #[test]
    fn expands_limited_range_endpoints_to_full_range() {
        assert_eq!(expand_luma_full_range(16), 0);
        assert_eq!(expand_luma_full_range(235), 255);
        assert!(expand_chroma_full_range(16) <= 1);
        assert!(expand_chroma_full_range(240) >= 254);
        assert_eq!(expand_chroma_full_range(128), 128);
    }

    #[test]
    fn finish_state_finishes_empty_mp4() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("empty.mp4");
        let state = EncodeState::new(
            &EncoderConfig {
                output: out.clone(),
                fps: Some(60),
                quality: QualityMode::Best,
                encoder: EncoderMode::Openh264,
            },
            1280,
            720,
            PIXMAN_A8R8G8B8,
        )
        .unwrap();
        let terminal = finish_state(Some(state)).unwrap();
        assert_eq!(terminal, Some(EncoderTerminal::Eos));

        let probe = Command::new("ffprobe")
            .args(["-v", "error", "-show_format", out.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(probe.status.success(), "{probe:?}");
    }
}
