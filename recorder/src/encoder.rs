use std::{
    collections::VecDeque,
    fs::File,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

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
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
    time::Instant,
};
use tracing::{debug, info, warn};

use crate::args::{EncoderMode, QualityMode};
use crate::qemu_source::{
    FrameBuffer, FrameEvent, SharedFrameState, PIXMAN_A8R8G8B8, PIXMAN_R5G6B5, PIXMAN_X8R8G8B8,
};

#[derive(Debug, Clone)]
pub struct EncoderConfig {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderBackend {
    OpenH264,
    X264,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecConfig {
    H264 { sps: Arc<[u8]>, pps: Arc<[u8]> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedStreamFormat {
    pub codec: VideoCodec,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedVideoUnit {
    pub ts_ns: u64,
    pub is_keyframe: bool,
    pub width: u32,
    pub height: u32,
    pub codec: VideoCodec,
    pub codec_config: Option<CodecConfig>,
    pub payload: Arc<[u8]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodedStreamEvent {
    Format(EncodedStreamFormat),
    Unit(EncodedVideoUnit),
    Eos,
}

pub trait EncodedOutputSink: Send {
    fn handle_event(&mut self, event: EncodedStreamEvent) -> Result<(), EncoderError>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EncoderStats {
    pub encoded_units: u64,
    pub sink_errors: u64,
    pub active_resolution: Option<(u32, u32)>,
    pub active_codec: Option<VideoCodec>,
    pub backend: Option<EncoderBackend>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LiveOutputStats {
    pub format_events: u64,
    pub received_units: u64,
    pub coalesced_units: u64,
    pub eos_events: u64,
}

#[derive(Debug, Clone)]
pub struct LiveOutputStream {
    snapshot_rx: watch::Receiver<LiveOutputSnapshot>,
    stats: Arc<Mutex<LiveOutputStats>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PacketizerEvent {
    StreamStarted {
        format: EncodedStreamFormat,
        codec_config: Option<CodecConfig>,
    },
    VideoSample(EncodedVideoUnit),
    EndOfStream,
}

#[derive(Debug, Clone)]
pub struct LivePacketizerAdapter {
    stream: LiveOutputStream,
    pending: VecDeque<PacketizerEvent>,
    last_revision: u64,
    last_format: Option<EncodedStreamFormat>,
    last_unit_ts_ns: Option<u64>,
    eos_emitted: bool,
}

#[derive(Debug)]
pub struct LiveOutputSink {
    snapshot_tx: watch::Sender<LiveOutputSnapshot>,
    stats: Arc<Mutex<LiveOutputStats>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LiveOutputSnapshot {
    pub format: Option<EncodedStreamFormat>,
    pub latest_unit: Option<EncodedVideoUnit>,
    pub eos: bool,
    pub revision: u64,
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
    #[error("failed to open ffmpeg stdout")]
    MissingFfmpegStdout,
    #[error("failed to read ffmpeg output")]
    ReadFfmpeg(#[source] std::io::Error),
    #[error("failed to write frame to ffmpeg stdin")]
    WriteFfmpeg(#[source] std::io::Error),
    #[error("ffmpeg exited unsuccessfully: {0}")]
    FfmpegFailed(String),
    #[error("encoder requires at least one encoded-output sink")]
    NoSinks,
    #[error("x264 emitted an access unit without a matching timestamp")]
    MissingX264Timestamp,
}

pub struct Encoder {
    event_task: Option<tokio::task::JoinHandle<()>>,
    terminal_rx: watch::Receiver<EncoderTerminal>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    stats: SharedEncoderStats,
}

pub struct Mp4Sink {
    mp4: Mp4Writer<File>,
    stream_format: Option<EncodedStreamFormat>,
    track_ready: bool,
    first_ts_ns: Option<u64>,
    last_sample_duration: u32,
    pending_sample: Option<PendingSample>,
}

type SharedEncoderStats = Arc<Mutex<EncoderStats>>;

struct FanoutSink {
    sinks: Vec<Box<dyn EncodedOutputSink>>,
    stats: SharedEncoderStats,
}

struct OpenH264State {
    encoder: OpenH264Encoder,
    sinks: FanoutSink,
    width: u32,
    height: u32,
    fourcc: u32,
    codec_config: Option<CodecConfig>,
    staging_bgra: Vec<u8>,
}

struct X264State {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout_task: Option<JoinHandle<()>>,
    stderr: Option<ChildStderr>,
    width: u32,
    height: u32,
    sinks: FanoutSink,
    staging_bgra: Vec<u8>,
    codec_config: Option<CodecConfig>,
    has_frame: bool,
    frame_generation: u64,
    last_written_generation: u64,
    ticker: tokio::time::Interval,
    period_ns: u64,
    next_ts_ns: u64,
    pending_timestamps: VecDeque<u64>,
    access_unit_rx: mpsc::Receiver<Result<ParsedAccessUnit, EncoderError>>,
}

struct PendingSample {
    start_time: u64,
    is_sync: bool,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct ParsedAccessUnit {
    payload: Vec<u8>,
    is_keyframe: bool,
    codec_config: Option<CodecConfig>,
}

#[derive(Default)]
struct AnnexBAccessUnitParser {
    buffer: Vec<u8>,
}

impl Encoder {
    pub fn start(
        config: EncoderConfig,
        shared: SharedFrameState,
        rx: mpsc::Receiver<FrameEvent>,
        sinks: Vec<Box<dyn EncodedOutputSink>>,
    ) -> Result<Self, EncoderError> {
        if sinks.is_empty() {
            return Err(EncoderError::NoSinks);
        }

        let backend = select_backend(config.encoder)?;
        let (terminal_tx, terminal_rx) = watch::channel(EncoderTerminal::Running);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let stats = Arc::new(Mutex::new(EncoderStats {
            backend: Some(backend),
            ..EncoderStats::default()
        }));
        info!(backend = ?backend, "starting encoder backend");
        let event_task = match backend {
            EncoderBackend::OpenH264 => tokio::spawn(run_openh264_event_loop(
                config,
                shared,
                rx,
                shutdown_rx,
                terminal_tx,
                sinks,
                stats.clone(),
            )),
            EncoderBackend::X264 => tokio::spawn(run_x264_event_loop(
                config,
                shared,
                rx,
                shutdown_rx,
                terminal_tx,
                sinks,
                stats.clone(),
            )),
        };

        Ok(Self {
            event_task: Some(event_task),
            terminal_rx,
            shutdown_tx: Some(shutdown_tx),
            stats,
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

    pub fn stats(&self) -> EncoderStats {
        lock_encoder_stats(&self.stats).clone()
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

impl Mp4Sink {
    pub fn new(output: PathBuf, fps: Option<u32>) -> Result<Self, EncoderError> {
        let file = File::create(output).map_err(EncoderError::CreateOutput)?;
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
        let fps = fps.unwrap_or(60).max(1);

        Ok(Self {
            mp4,
            stream_format: None,
            track_ready: false,
            first_ts_ns: None,
            last_sample_duration: 90_000u32 / fps,
            pending_sample: None,
        })
    }

    fn write_format(&mut self, format: EncodedStreamFormat) {
        self.stream_format = Some(format);
    }

    fn write_unit(&mut self, unit: EncodedVideoUnit) -> Result<(), EncoderError> {
        if !self.track_ready {
            if !unit.is_keyframe {
                return Ok(());
            }

            let Some(CodecConfig::H264 { sps, pps }) = unit.codec_config.as_ref() else {
                return Err(EncoderError::MissingParameterSets);
            };

            self.mp4
                .add_track(&TrackConfig {
                    track_type: TrackType::Video,
                    timescale: 90_000,
                    language: "und".into(),
                    media_conf: MediaConfig::AvcConfig(AvcConfig {
                        width: unit.width as u16,
                        height: unit.height as u16,
                        seq_param_set: sps.to_vec(),
                        pic_param_set: pps.to_vec(),
                    }),
                })
                .map_err(EncoderError::AddTrack)?;
            self.track_ready = true;
        }

        let sample_bytes = annex_b_to_avcc(unit.payload.as_ref())?;
        if sample_bytes.is_empty() {
            return Err(EncoderError::EmptySample);
        }

        let start_time = self.sample_start_time(unit.ts_ns);
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
            is_sync: unit.is_keyframe,
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

    fn finish(&mut self) -> Result<(), EncoderError> {
        self.flush_pending_sample()?;
        self.mp4.write_end().map_err(EncoderError::FinishMp4)
    }
}

impl EncodedOutputSink for Mp4Sink {
    fn handle_event(&mut self, event: EncodedStreamEvent) -> Result<(), EncoderError> {
        match event {
            EncodedStreamEvent::Format(format) => {
                self.write_format(format);
                Ok(())
            }
            EncodedStreamEvent::Unit(unit) => self.write_unit(unit),
            EncodedStreamEvent::Eos => self.finish(),
        }
    }
}

impl LiveOutputSink {
    pub fn new() -> (Self, LiveOutputStream) {
        let (snapshot_tx, snapshot_rx) = watch::channel(LiveOutputSnapshot::default());
        let stats = Arc::new(Mutex::new(LiveOutputStats::default()));
        (
            Self {
                snapshot_tx,
                stats: stats.clone(),
            },
            LiveOutputStream { snapshot_rx, stats },
        )
    }
}

impl LiveOutputStream {
    pub async fn changed(&mut self) -> Result<(), watch::error::RecvError> {
        self.snapshot_rx.changed().await
    }

    pub fn latest(&self) -> LiveOutputSnapshot {
        self.snapshot_rx.borrow().clone()
    }

    pub fn stats(&self) -> LiveOutputStats {
        lock_live_output_stats(&self.stats).clone()
    }

    pub fn into_packetizer_adapter(self) -> LivePacketizerAdapter {
        LivePacketizerAdapter {
            stream: self,
            pending: VecDeque::new(),
            last_revision: 0,
            last_format: None,
            last_unit_ts_ns: None,
            eos_emitted: false,
        }
    }
}

impl LivePacketizerAdapter {
    pub async fn next_event(&mut self) -> Result<Option<PacketizerEvent>, watch::error::RecvError> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }

            self.capture_pending_from_snapshot();
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }

            if self.eos_emitted {
                return Ok(None);
            }

            self.stream.changed().await?;
        }
    }

    fn capture_pending_from_snapshot(&mut self) {
        let snapshot = self.stream.latest();
        if snapshot.revision <= self.last_revision {
            return;
        }
        self.last_revision = snapshot.revision;

        if snapshot.format != self.last_format {
            if let Some(format) = snapshot.format.clone() {
                let codec_config = snapshot
                    .latest_unit
                    .as_ref()
                    .and_then(|unit| unit.codec_config.clone());
                self.pending.push_back(PacketizerEvent::StreamStarted {
                    format: format.clone(),
                    codec_config,
                });
                self.last_format = Some(format);
            }
        }

        if let Some(unit) = snapshot.latest_unit {
            if Some(unit.ts_ns) != self.last_unit_ts_ns {
                self.last_unit_ts_ns = Some(unit.ts_ns);
                self.pending.push_back(PacketizerEvent::VideoSample(unit));
            }
        }

        if snapshot.eos && !self.eos_emitted {
            self.pending.push_back(PacketizerEvent::EndOfStream);
            self.eos_emitted = true;
        }
    }
}

impl EncodedOutputSink for LiveOutputSink {
    fn handle_event(&mut self, event: EncodedStreamEvent) -> Result<(), EncoderError> {
        let mut snapshot = self.snapshot_tx.borrow().clone();
        let mut stats = lock_live_output_stats(&self.stats);
        match event {
            EncodedStreamEvent::Format(format) => {
                stats.format_events += 1;
                snapshot.format = Some(format);
            }
            EncodedStreamEvent::Unit(unit) => {
                stats.received_units += 1;
                if snapshot.latest_unit.replace(unit).is_some() {
                    stats.coalesced_units += 1;
                }
            }
            EncodedStreamEvent::Eos => {
                stats.eos_events += 1;
                snapshot.eos = true;
            }
        }
        snapshot.revision = snapshot.revision.saturating_add(1);
        drop(stats);
        let _ = self.snapshot_tx.send_replace(snapshot);
        Ok(())
    }
}

impl FanoutSink {
    fn new(sinks: Vec<Box<dyn EncodedOutputSink>>, stats: SharedEncoderStats) -> Self {
        Self { sinks, stats }
    }

    fn send(&mut self, event: EncodedStreamEvent) -> Result<(), EncoderError> {
        let is_unit = matches!(event, EncodedStreamEvent::Unit(_));
        for sink in &mut self.sinks {
            if let Err(error) = sink.handle_event(event.clone()) {
                let mut stats = lock_encoder_stats(&self.stats);
                stats.sink_errors += 1;
                drop(stats);
                return Err(error);
            }
        }
        if is_unit {
            lock_encoder_stats(&self.stats).encoded_units += 1;
        }
        Ok(())
    }
}

async fn run_openh264_event_loop(
    config: EncoderConfig,
    shared: SharedFrameState,
    mut rx: mpsc::Receiver<FrameEvent>,
    mut shutdown_rx: oneshot::Receiver<()>,
    terminal_tx: watch::Sender<EncoderTerminal>,
    sinks: Vec<Box<dyn EncodedOutputSink>>,
    stats: SharedEncoderStats,
) {
    let mut state = None::<OpenH264State>;
    let mut sinks = Some(FanoutSink::new(sinks, stats.clone()));
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
            } => ensure_openh264_state(
                &mut state, &mut sinks, &config, &stats, w, h, stride, fourcc,
            ),
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
            FrameEvent::Eos => finish_openh264_state(state.take()),
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
    sinks: Vec<Box<dyn EncodedOutputSink>>,
    stats: SharedEncoderStats,
) {
    let mut state = None::<X264State>;
    let mut sinks = Some(FanoutSink::new(sinks, stats.clone()));
    enum X264LoopAction {
        Shutdown,
        Event(Option<FrameEvent>),
        AccessUnit(Option<Result<ParsedAccessUnit, EncoderError>>),
        Tick,
    }

    loop {
        let action = if let Some(current) = state.as_mut() {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => X264LoopAction::Shutdown,
                maybe_event = rx.recv() => X264LoopAction::Event(maybe_event),
                maybe_unit = current.access_unit_rx.recv() => X264LoopAction::AccessUnit(maybe_unit),
                _ = current.ticker.tick() => X264LoopAction::Tick,
            }
        } else {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => X264LoopAction::Shutdown,
                maybe_event = rx.recv() => X264LoopAction::Event(maybe_event),
            }
        };

        match action {
            X264LoopAction::Shutdown => {
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
            X264LoopAction::Event(maybe_event) => {
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
                    FrameEvent::Reset {
                        w,
                        h,
                        stride,
                        fourcc,
                        ..
                    } => ensure_x264_state(
                        &mut state, &mut sinks, &config, &stats, w, h, stride, fourcc,
                    ),
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
            X264LoopAction::AccessUnit(maybe_unit) => {
                let Some(state) = state.as_mut() else {
                    continue;
                };
                let Some(result) = maybe_unit else {
                    continue;
                };
                match result {
                    Ok(unit) => {
                        if let Err(error) = state.push_access_unit(unit) {
                            let _ = terminal_tx.send(EncoderTerminal::Fatal(error.to_string()));
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = terminal_tx.send(EncoderTerminal::Fatal(error.to_string()));
                        return;
                    }
                }
            }
            X264LoopAction::Tick => {
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

fn ensure_openh264_state(
    state: &mut Option<OpenH264State>,
    sinks: &mut Option<FanoutSink>,
    config: &EncoderConfig,
    stats: &SharedEncoderStats,
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

    let Some(sinks) = sinks.take() else {
        return Err(EncoderError::Fatal(
            "encoder sink fanout already initialized".into(),
        ));
    };
    *state = Some(OpenH264State::new(
        config, sinks, stats, width, height, fourcc,
    )?);
    Ok(None)
}

fn finish_openh264_state(
    state: Option<OpenH264State>,
) -> Result<Option<EncoderTerminal>, EncoderError> {
    if let Some(mut state) = state {
        state.finish()?;
    }
    Ok(Some(EncoderTerminal::Eos))
}

fn encode_shared_frame(
    shared: &SharedFrameState,
    state: &mut Option<OpenH264State>,
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

    let unit = state.build_video_unit(ts_ns, annex_b, is_keyframe)?;
    state.sinks.send(EncodedStreamEvent::Unit(unit))?;
    Ok(None)
}

fn select_backend(mode: EncoderMode) -> Result<EncoderBackend, EncoderError> {
    match mode {
        EncoderMode::Openh264 => Ok(EncoderBackend::OpenH264),
        EncoderMode::X264 => {
            if x264_available() {
                Ok(EncoderBackend::X264)
            } else {
                Err(EncoderError::X264Unavailable)
            }
        }
        EncoderMode::Auto => {
            if x264_available() {
                Ok(EncoderBackend::X264)
            } else {
                Ok(EncoderBackend::OpenH264)
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
    sinks: &mut Option<FanoutSink>,
    config: &EncoderConfig,
    stats: &SharedEncoderStats,
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

    let Some(sinks) = sinks.take() else {
        return Err(EncoderError::Fatal(
            "encoder sink fanout already initialized".into(),
        ));
    };
    *state = Some(X264State::new(config, sinks, stats, width, height, fourcc)?);
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

impl OpenH264State {
    fn new(
        config: &EncoderConfig,
        mut sinks: FanoutSink,
        stats: &SharedEncoderStats,
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
        let format = EncodedStreamFormat {
            codec: VideoCodec::H264,
            width,
            height,
        };
        sinks.send(EncodedStreamEvent::Format(format.clone()))?;
        let mut stats_guard = lock_encoder_stats(stats);
        stats_guard.active_resolution = Some((width, height));
        stats_guard.active_codec = Some(VideoCodec::H264);
        drop(stats_guard);

        Ok(Self {
            encoder,
            sinks,
            width,
            height,
            fourcc,
            codec_config: None,
            staging_bgra: vec![0; width as usize * height as usize * 4],
        })
    }

    fn build_video_unit(
        &mut self,
        ts_ns: u64,
        annex_b: Vec<u8>,
        is_keyframe: bool,
    ) -> Result<EncodedVideoUnit, EncoderError> {
        if is_keyframe {
            let (sps, pps) = extract_parameter_sets(&annex_b)?;
            self.codec_config = Some(CodecConfig::H264 {
                sps: Arc::<[u8]>::from(sps),
                pps: Arc::<[u8]>::from(pps),
            });
        }

        Ok(EncodedVideoUnit {
            ts_ns,
            is_keyframe,
            width: self.width,
            height: self.height,
            codec: VideoCodec::H264,
            codec_config: self.codec_config.clone(),
            payload: Arc::<[u8]>::from(annex_b),
        })
    }

    fn finish(&mut self) -> Result<(), EncoderError> {
        self.sinks.send(EncodedStreamEvent::Eos)
    }
}

impl X264State {
    fn new(
        config: &EncoderConfig,
        mut sinks: FanoutSink,
        stats: &SharedEncoderStats,
        width: u32,
        height: u32,
        _fourcc: u32,
    ) -> Result<Self, EncoderError> {
        let fps = config.fps.unwrap_or(60).max(1);
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
            .arg("-x264-params")
            .arg("repeat-headers=1:aud=1:bframes=0")
            .arg("-f")
            .arg("h264")
            .arg("pipe:1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(EncoderError::SpawnFfmpeg)?;
        let stdin = child.stdin.take().ok_or(EncoderError::MissingFfmpegStdin)?;
        let stdout = child
            .stdout
            .take()
            .ok_or(EncoderError::MissingFfmpegStdout)?;
        let stderr = child.stderr.take();
        let (access_unit_tx, access_unit_rx) = mpsc::channel(16);
        let stdout_task = tokio::spawn(pump_x264_output(stdout, access_unit_tx));
        let period_ns = 1_000_000_000u64 / u64::from(fps);
        let period = Duration::from_nanos(period_ns);
        let mut ticker = tokio::time::interval_at(Instant::now() + period, period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let format = EncodedStreamFormat {
            codec: VideoCodec::H264,
            width,
            height,
        };
        sinks.send(EncodedStreamEvent::Format(format.clone()))?;
        let mut stats_guard = lock_encoder_stats(stats);
        stats_guard.active_resolution = Some((width, height));
        stats_guard.active_codec = Some(VideoCodec::H264);
        drop(stats_guard);

        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout_task: Some(stdout_task),
            stderr,
            width,
            height,
            sinks,
            staging_bgra: vec![0; width as usize * height as usize * 4],
            codec_config: None,
            has_frame: false,
            frame_generation: 0,
            last_written_generation: 0,
            ticker,
            period_ns,
            next_ts_ns: 0,
            pending_timestamps: VecDeque::new(),
            access_unit_rx,
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
        self.frame_generation = self.frame_generation.saturating_add(1);
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
            self.pending_timestamps.push_back(self.next_ts_ns);
            self.next_ts_ns = self.next_ts_ns.saturating_add(self.period_ns);
            self.last_written_generation = self.frame_generation;
        }
        Ok(())
    }

    fn push_access_unit(&mut self, unit: ParsedAccessUnit) -> Result<(), EncoderError> {
        if let Some(codec_config) = unit.codec_config.clone() {
            self.codec_config = Some(codec_config);
        }
        let ts_ns = self
            .pending_timestamps
            .pop_front()
            .ok_or(EncoderError::MissingX264Timestamp)?;
        let encoded = EncodedVideoUnit {
            ts_ns,
            is_keyframe: unit.is_keyframe,
            width: self.width,
            height: self.height,
            codec: VideoCodec::H264,
            codec_config: self.codec_config.clone(),
            payload: Arc::<[u8]>::from(unit.payload),
        };
        self.sinks.send(EncodedStreamEvent::Unit(encoded))
    }

    async fn finish(&mut self) -> Result<(), EncoderError> {
        if self.has_frame && self.last_written_generation != self.frame_generation {
            self.write_latest_frame().await?;
        }
        let _ = self.stdin.take();
        while let Some(result) = self.access_unit_rx.recv().await {
            let unit = result?;
            self.push_access_unit(unit)?;
        }
        if let Some(stdout_task) = self.stdout_task.take() {
            stdout_task.await.map_err(|error| {
                EncoderError::Fatal(format!("x264 stdout task failed: {error}"))
            })?;
        }
        let status = self.child.wait().await.map_err(EncoderError::SpawnFfmpeg)?;
        if status.success() {
            self.sinks.send(EncodedStreamEvent::Eos)?;
            Ok(())
        } else {
            let mut stderr = Vec::new();
            if let Some(mut handle) = self.stderr.take() {
                handle
                    .read_to_end(&mut stderr)
                    .await
                    .map_err(EncoderError::ReadFfmpeg)?;
            }
            let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
            Err(EncoderError::FfmpegFailed(stderr))
        }
    }
}

async fn pump_x264_output(
    mut stdout: ChildStdout,
    tx: mpsc::Sender<Result<ParsedAccessUnit, EncoderError>>,
) {
    let mut parser = AnnexBAccessUnitParser::default();
    let mut chunk = [0u8; 16 * 1024];

    loop {
        match stdout.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => match parser.push(&chunk[..read]) {
                Ok(units) => {
                    for unit in units {
                        if tx.send(Ok(unit)).await.is_err() {
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(error)).await;
                    return;
                }
            },
            Err(error) => {
                let _ = tx.send(Err(EncoderError::ReadFfmpeg(error))).await;
                return;
            }
        }
    }

    match parser.finish() {
        Ok(units) => {
            for unit in units {
                if tx.send(Ok(unit)).await.is_err() {
                    return;
                }
            }
        }
        Err(error) => {
            let _ = tx.send(Err(error)).await;
        }
    }
}

impl AnnexBAccessUnitParser {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<ParsedAccessUnit>, EncoderError> {
        self.buffer.extend_from_slice(bytes);
        self.drain_complete(false)
    }

    fn finish(&mut self) -> Result<Vec<ParsedAccessUnit>, EncoderError> {
        self.drain_complete(true)
    }

    fn drain_complete(&mut self, flush: bool) -> Result<Vec<ParsedAccessUnit>, EncoderError> {
        let mut units = Vec::new();
        let starts = nal_start_offsets(&self.buffer);
        let mut current_au_start = None;
        let mut current_has_vcl = false;
        let mut keep_from = 0usize;

        for offset in starts {
            let Some(nal) = strip_start_code(&self.buffer[offset..]) else {
                continue;
            };
            if nal.is_empty() {
                continue;
            }

            let nal_type = nal[0] & 0x1f;
            let is_vcl = matches!(nal_type, 1..=5);
            let starts_new_au = current_has_vcl
                && (nal_type == 9
                    || matches!(nal_type, 6..=8)
                    || (is_vcl && slice_starts_new_picture(nal)?));

            if starts_new_au {
                if let Some(start) = current_au_start.replace(offset) {
                    if let Some(unit) = parse_access_unit(self.buffer[start..offset].to_vec())? {
                        units.push(unit);
                        keep_from = offset;
                    }
                }
                current_has_vcl = false;
            } else if current_au_start.is_none() {
                current_au_start = Some(offset);
            }

            if is_vcl {
                current_has_vcl = true;
            }
        }

        if flush {
            if let Some(start) = current_au_start {
                if let Some(unit) = parse_access_unit(self.buffer[start..].to_vec())? {
                    units.push(unit);
                }
            }
            self.buffer.clear();
        } else if keep_from > 0 {
            self.buffer.drain(..keep_from);
        }

        Ok(units)
    }
}

fn parse_access_unit(bytes: Vec<u8>) -> Result<Option<ParsedAccessUnit>, EncoderError> {
    if bytes.is_empty() {
        return Ok(None);
    }

    let mut is_keyframe = false;
    let mut saw_payload = false;
    let mut sps = None;
    let mut pps = None;
    for nal in nal_units(&bytes) {
        let Some(nal) = strip_start_code(nal) else {
            continue;
        };
        if nal.is_empty() {
            continue;
        }
        saw_payload = true;
        match nal[0] & 0x1f {
            5 => is_keyframe = true,
            7 if sps.is_none() => sps = Some(Arc::<[u8]>::from(nal.to_vec())),
            8 if pps.is_none() => pps = Some(Arc::<[u8]>::from(nal.to_vec())),
            _ => {}
        }
    }

    if !saw_payload {
        return Ok(None);
    }

    let codec_config = match (sps, pps) {
        (Some(sps), Some(pps)) => Some(CodecConfig::H264 { sps, pps }),
        _ => None,
    };

    Ok(Some(ParsedAccessUnit {
        payload: bytes,
        is_keyframe,
        codec_config,
    }))
}

fn nal_start_offsets(bytes: &[u8]) -> Vec<usize> {
    let mut positions = Vec::new();
    let mut index = 0usize;

    while index + 3 < bytes.len() {
        let Some(start_code_len) = start_code_len(bytes, index) else {
            index += 1;
            continue;
        };
        let nal_start = index + start_code_len;
        if nal_start >= bytes.len() {
            break;
        }
        positions.push(index);
        index = nal_start;
    }

    positions
}

fn slice_starts_new_picture(nal: &[u8]) -> Result<bool, EncoderError> {
    let rbsp = nal_rbsp(&nal[1..]);
    let mut reader = BitReader::new(&rbsp);
    Ok(reader.read_ue()? == 0)
}

fn nal_rbsp(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len());
    let mut zero_count = 0usize;
    for &byte in payload {
        if zero_count >= 2 && byte == 0x03 {
            zero_count = 0;
            continue;
        }
        out.push(byte);
        if byte == 0 {
            zero_count += 1;
        } else {
            zero_count = 0;
        }
    }
    out
}

struct BitReader<'a> {
    bytes: &'a [u8],
    bit_offset: usize,
}

impl<'a> BitReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            bit_offset: 0,
        }
    }

    fn read_bit(&mut self) -> Result<u8, EncoderError> {
        if self.bit_offset >= self.bytes.len() * 8 {
            return Err(EncoderError::Fatal(
                "short H.264 slice header while parsing x264 output".into(),
            ));
        }
        let byte = self.bytes[self.bit_offset / 8];
        let shift = 7 - (self.bit_offset % 8);
        self.bit_offset += 1;
        Ok((byte >> shift) & 1)
    }

    fn read_ue(&mut self) -> Result<u32, EncoderError> {
        let mut leading_zero_bits = 0usize;
        while self.read_bit()? == 0 {
            leading_zero_bits += 1;
        }
        let mut value = 1u32;
        for _ in 0..leading_zero_bits {
            value = (value << 1) | u32::from(self.read_bit()?);
        }
        Ok(value - 1)
    }
}

fn start_code_len(bytes: &[u8], index: usize) -> Option<usize> {
    if bytes.get(index..index + 4) == Some(&[0, 0, 0, 1]) {
        Some(4)
    } else if bytes.get(index..index + 3) == Some(&[0, 0, 1]) {
        Some(3)
    } else {
        None
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
        if nal.is_empty() {
            continue;
        }
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
        if nal.is_empty() {
            continue;
        }
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
    state: &mut OpenH264State,
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

fn lock_encoder_stats(stats: &SharedEncoderStats) -> std::sync::MutexGuard<'_, EncoderStats> {
    match stats.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("encoder stats state is poisoned");
            poisoned.into_inner()
        }
    }
}

fn lock_live_output_stats(
    stats: &Arc<Mutex<LiveOutputStats>>,
) -> std::sync::MutexGuard<'_, LiveOutputStats> {
    match stats.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("live output stats state is poisoned");
            poisoned.into_inner()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{process::Command, sync::Arc};

    use openh264::formats::YUVSource;
    use tempfile::tempdir;
    use tokio::time::{timeout, Duration};

    use super::*;
    use crate::qemu_source::{FrameStorage, PIXMAN_A8R8G8B8};

    #[test]
    fn build_yuv_from_bgra_black_frame() {
        let (sink, _stream) = LiveOutputSink::new();
        let mut state = OpenH264State::new(
            &EncoderConfig {
                fps: Some(60),
                quality: QualityMode::Best,
                encoder: EncoderMode::Openh264,
            },
            FanoutSink::new(
                vec![Box::new(sink)],
                Arc::new(Mutex::new(EncoderStats::default())),
            ),
            &Arc::new(Mutex::new(EncoderStats::default())),
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
    fn mp4_sink_finishes_empty_mp4() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("empty.mp4");
        let mut sink = Mp4Sink::new(out.clone(), Some(60)).unwrap();
        sink.handle_event(EncodedStreamEvent::Format(EncodedStreamFormat {
            codec: VideoCodec::H264,
            width: 1280,
            height: 720,
        }))
        .unwrap();
        sink.handle_event(EncodedStreamEvent::Eos).unwrap();

        let probe = Command::new("ffprobe")
            .args(["-v", "error", "-show_format", out.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(probe.status.success(), "{probe:?}");
    }

    #[test]
    fn annex_b_parser_splits_on_aud_boundaries() {
        let mut parser = AnnexBAccessUnitParser::default();
        let bytes = vec![
            0, 0, 0, 1, 9, 16, 0, 0, 0, 1, 7, 1, 2, 3, 0, 0, 0, 1, 8, 4, 5, 6, 0, 0, 0, 1, 5, 7, 8,
            9, 0, 0, 0, 1, 9, 16, 0, 0, 0, 1, 1, 9, 9, 9,
        ];
        let units = parser.push(&bytes).unwrap();
        assert_eq!(units.len(), 1);
        assert!(units[0].is_keyframe);
        assert!(matches!(
            units[0].codec_config,
            Some(CodecConfig::H264 { .. })
        ));

        let tail = parser.finish().unwrap();
        assert_eq!(tail.len(), 1);
        assert!(!tail[0].is_keyframe);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn live_packetizer_adapter_emits_start_sample_and_eos() {
        let (mut sink, stream) = LiveOutputSink::new();
        let mut adapter = stream.into_packetizer_adapter();

        sink.handle_event(EncodedStreamEvent::Format(EncodedStreamFormat {
            codec: VideoCodec::H264,
            width: 128,
            height: 72,
        }))
        .unwrap();
        sink.handle_event(EncodedStreamEvent::Unit(EncodedVideoUnit {
            ts_ns: 33_000_000,
            is_keyframe: true,
            width: 128,
            height: 72,
            codec: VideoCodec::H264,
            codec_config: Some(CodecConfig::H264 {
                sps: Arc::<[u8]>::from(vec![1, 2, 3]),
                pps: Arc::<[u8]>::from(vec![4, 5]),
            }),
            payload: Arc::<[u8]>::from(vec![0, 0, 0, 1, 5, 9, 9, 9]),
        }))
        .unwrap();
        sink.handle_event(EncodedStreamEvent::Eos).unwrap();

        let start = timeout(Duration::from_secs(1), adapter.next_event())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(
            start,
            PacketizerEvent::StreamStarted {
                format: EncodedStreamFormat {
                    codec: VideoCodec::H264,
                    width: 128,
                    height: 72,
                },
                codec_config: Some(CodecConfig::H264 { .. }),
            }
        ));

        let sample = timeout(Duration::from_secs(1), adapter.next_event())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match sample {
            PacketizerEvent::VideoSample(unit) => {
                assert_eq!(unit.ts_ns, 33_000_000);
                assert!(unit.is_keyframe);
            }
            other => panic!("unexpected packetizer event: {other:?}"),
        }

        let eos = timeout(Duration::from_secs(1), adapter.next_event())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(eos, PacketizerEvent::EndOfStream);

        let done = timeout(Duration::from_secs(1), adapter.next_event())
            .await
            .unwrap()
            .unwrap();
        assert!(done.is_none());
    }
}
