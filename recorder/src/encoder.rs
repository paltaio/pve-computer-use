use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use thiserror::Error;
use tokio::sync::{mpsc, watch};
use tracing::{debug, error};

use crate::args::QualityMode;
use crate::qemu_source::{
    FrameEvent, SharedFrameState, PIXMAN_A8R8G8B8, PIXMAN_R5G6B5, PIXMAN_X8R8G8B8,
};

#[derive(Debug, Clone)]
pub struct EncoderConfig {
    pub output: PathBuf,
    pub fps: Option<u32>,
    pub quality: QualityMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncoderTerminal {
    Running,
    Eos,
    Fatal(String),
}

#[derive(Debug, Error)]
pub enum EncoderError {
    #[error("failed to set pipeline to ready")]
    SetReady(#[source] gst::StateChangeError),
    #[error("pipeline bus is unavailable")]
    MissingBus,
    #[error("failed to set pipeline to null")]
    SetNull(#[source] gst::StateChangeError),
    #[error("EOS timeout >=5 s")]
    EosTimeout,
    #[error("{0}")]
    Fatal(String),
    #[error("unsupported shared framebuffer format 0x{0:08x}")]
    UnsupportedFormat(u32),
    #[error("missing element factory {0}")]
    MissingElement(&'static str),
    #[error("output path is not valid UTF-8")]
    InvalidOutputPath,
    #[error("failed to add pipeline elements")]
    AddElements(#[source] gst::glib::BoolError),
    #[error("failed to link pipeline elements")]
    LinkElements(#[source] gst::glib::BoolError),
    #[error("failed to pause pipeline for caps reset")]
    PauseForReset(#[source] gst::StateChangeError),
    #[error("failed to resume pipeline after caps reset")]
    ResumeAfterReset(#[source] gst::StateChangeError),
    #[error("missing shared frame while encoding")]
    MissingSharedFrame,
    #[error("failed to allocate gst buffer")]
    AllocateBuffer(#[source] gst::glib::BoolError),
    #[error("gst buffer is not uniquely owned")]
    BufferNotWritable,
    #[error("failed to map gst buffer writable")]
    MapWritable,
    #[error("failed to push buffer into appsrc")]
    PushBuffer(#[source] gst::FlowError),
    #[error("failed to end appsrc stream")]
    EndOfStream(#[source] gst::FlowError),
}

pub struct Encoder {
    pipeline: gst::Pipeline,
    event_task: Option<tokio::task::JoinHandle<()>>,
    bus_task: Option<tokio::task::JoinHandle<()>>,
    terminal_rx: watch::Receiver<EncoderTerminal>,
    stop_bus: Arc<AtomicBool>,
}

impl Encoder {
    pub fn start(
        config: EncoderConfig,
        shared: SharedFrameState,
        rx: mpsc::Receiver<FrameEvent>,
    ) -> Result<Self, EncoderError> {
        let initial_caps = build_caps(640, 480, 640 * 4, PIXMAN_A8R8G8B8, 0)?;
        let (pipeline, appsrc) = build_pipeline(&config.output, &initial_caps, config.quality)?;
        pipeline
            .set_state(gst::State::Ready)
            .map_err(EncoderError::SetReady)?;

        let (terminal_tx, terminal_rx) = watch::channel(EncoderTerminal::Running);
        let stop_bus = Arc::new(AtomicBool::new(false));

        let event_task = tokio::spawn(run_event_loop(
            appsrc.clone(),
            pipeline.clone(),
            config,
            shared,
            rx,
            terminal_tx.clone(),
        ));

        let bus = pipeline.bus().ok_or(EncoderError::MissingBus)?;
        let stop_bus_flag = stop_bus.clone();
        let bus_task = tokio::task::spawn_blocking(move || {
            run_bus_loop(bus, terminal_tx, stop_bus_flag);
        });

        Ok(Self {
            pipeline,
            event_task: Some(event_task),
            bus_task: Some(bus_task),
            terminal_rx,
            stop_bus,
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
        match terminal {
            EncoderTerminal::Eos => {}
            EncoderTerminal::Fatal(message) => return Err(EncoderError::Fatal(message)),
            EncoderTerminal::Running => unreachable!(),
        }

        self.stop_bus.store(true, Ordering::Relaxed);
        self.pipeline
            .set_state(gst::State::Null)
            .map_err(EncoderError::SetNull)?;
        if let Some(event_task) = self.event_task.take() {
            let _ = event_task.await;
        }
        if let Some(bus_task) = self.bus_task.take() {
            let _ = bus_task.await;
        }
        Ok(())
    }

    pub async fn shutdown_now(&mut self) {
        self.stop_bus.store(true, Ordering::Relaxed);
        let _ = self.pipeline.set_state(gst::State::Null);
        if let Some(event_task) = self.event_task.take() {
            event_task.abort();
            let _ = event_task.await;
        }
        if let Some(bus_task) = self.bus_task.take() {
            bus_task.abort();
            let _ = bus_task.await;
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

pub fn build_caps(
    w: u32,
    h: u32,
    _stride: u32,
    fourcc: u32,
    _modifier: u64,
) -> Result<gst::Caps, EncoderError> {
    let format = match fourcc {
        PIXMAN_A8R8G8B8 => "BGRA",
        PIXMAN_X8R8G8B8 => "BGRx",
        PIXMAN_R5G6B5 => "RGB16",
        other => return Err(EncoderError::UnsupportedFormat(other)),
    };

    Ok(gst::Caps::builder("video/x-raw")
        .field("format", format)
        .field("width", w as i32)
        .field("height", h as i32)
        .field("framerate", gst::Fraction::new(0, 1))
        .build())
}

pub fn build_pipeline(
    output: &Path,
    caps: &gst::Caps,
    quality: QualityMode,
) -> Result<(gst::Pipeline, gst_app::AppSrc), EncoderError> {
    let pipeline = gst::Pipeline::new();
    let appsrc = gst_app::AppSrc::builder().name("source").caps(caps).build();
    appsrc.set_format(gst::Format::Time);
    appsrc.set_do_timestamp(false);
    appsrc.set_is_live(true);
    appsrc.set_block(false);

    let videoconvert = required_element("videoconvert")?;
    let x264enc_builder = gst::ElementFactory::make("x264enc");
    let x264enc_builder = match quality {
        QualityMode::Best => x264enc_builder
            .property_from_str("speed-preset", "slow")
            .property("quantizer", 18u32),
        QualityMode::Balanced => x264enc_builder
            .property_from_str("speed-preset", "medium")
            .property("quantizer", 21u32),
        QualityMode::Realtime => x264enc_builder
            .property_from_str("speed-preset", "ultrafast")
            .property_from_str("tune", "zerolatency")
            .property("quantizer", 24u32),
    };
    let x264enc = x264enc_builder
        .property("key-int-max", 60u32)
        .build()
        .map_err(|_| EncoderError::MissingElement("x264enc"))?;
    let h264parse = required_element("h264parse")?;
    let mp4mux = gst::ElementFactory::make("mp4mux")
        .property("faststart", true)
        .build()
        .map_err(|_| EncoderError::MissingElement("mp4mux"))?;
    let filesink = gst::ElementFactory::make("filesink")
        .property(
            "location",
            output.to_str().ok_or(EncoderError::InvalidOutputPath)?,
        )
        .build()
        .map_err(|_| EncoderError::MissingElement("filesink"))?;

    pipeline
        .add_many([
            appsrc.upcast_ref(),
            &videoconvert,
            &x264enc,
            &h264parse,
            &mp4mux,
            &filesink,
        ])
        .map_err(EncoderError::AddElements)?;
    gst::Element::link_many([
        appsrc.upcast_ref(),
        &videoconvert,
        &x264enc,
        &h264parse,
        &mp4mux,
        &filesink,
    ])
    .map_err(EncoderError::LinkElements)?;

    Ok((pipeline, appsrc))
}

async fn run_event_loop(
    appsrc: gst_app::AppSrc,
    pipeline: gst::Pipeline,
    config: EncoderConfig,
    shared: SharedFrameState,
    mut rx: mpsc::Receiver<FrameEvent>,
    terminal_tx: watch::Sender<EncoderTerminal>,
) {
    let mut last_pts_ns = None::<u64>;
    let mut eos_sent = false;

    while let Some(event) = rx.recv().await {
        let should_break = matches!(event, FrameEvent::Eos);
        let outcome = match event {
            FrameEvent::Reset {
                w,
                h,
                stride,
                fourcc,
                modifier,
            } => reset_caps(&appsrc, &pipeline, w, h, stride, fourcc, modifier),
            FrameEvent::Frame { ts_ns } => {
                if let Some(fps) = config.fps {
                    let min_delta = 1_000_000_000u64 / fps as u64;
                    if let Some(last) = last_pts_ns {
                        if ts_ns.saturating_sub(last) < min_delta {
                            continue;
                        }
                    }
                }
                last_pts_ns = Some(ts_ns);
                push_shared_frame(&appsrc, &shared, ts_ns)
            }
            FrameEvent::Eos => appsrc
                .end_of_stream()
                .map(|_| {
                    eos_sent = true;
                })
                .map_err(EncoderError::EndOfStream),
        };

        if let Err(error) = outcome {
            if is_transient_push_error(&error) {
                debug!(error = %error, "dropping transient frame during pipeline reconfiguration");
                continue;
            }
            error!(error = %error, "encoder event loop failed");
            let _ = terminal_tx.send(EncoderTerminal::Fatal(error.to_string()));
            return;
        }

        if should_break {
            break;
        }
    }

    if !eos_sent {
        if let Err(error) = appsrc.end_of_stream() {
            let _ = terminal_tx.send(EncoderTerminal::Fatal(
                EncoderError::EndOfStream(error).to_string(),
            ));
        }
    }
}

fn is_transient_push_error(error: &EncoderError) -> bool {
    matches!(
        error,
        EncoderError::PushBuffer(gst::FlowError::Flushing)
            | EncoderError::PushBuffer(gst::FlowError::NotNegotiated)
    )
}

fn reset_caps(
    appsrc: &gst_app::AppSrc,
    pipeline: &gst::Pipeline,
    w: u32,
    h: u32,
    stride: u32,
    fourcc: u32,
    modifier: u64,
) -> Result<(), EncoderError> {
    pipeline
        .set_state(gst::State::Paused)
        .map_err(EncoderError::PauseForReset)?;
    let caps = build_caps(w, h, stride, fourcc, modifier)?;
    appsrc.set_caps(Some(&caps));
    pipeline
        .set_state(gst::State::Playing)
        .map_err(EncoderError::ResumeAfterReset)?;
    Ok(())
}

fn push_shared_frame(
    appsrc: &gst_app::AppSrc,
    shared: &SharedFrameState,
    ts_ns: u64,
) -> Result<(), EncoderError> {
    let frame = shared.load_full().ok_or(EncoderError::MissingSharedFrame)?;
    let bytes = frame.storage.as_slice();
    let mut buffer = gst::Buffer::with_size(bytes.len()).map_err(EncoderError::AllocateBuffer)?;
    {
        let buffer_mut = buffer.get_mut().ok_or(EncoderError::BufferNotWritable)?;
        let mut map = buffer_mut
            .map_writable()
            .map_err(|_| EncoderError::MapWritable)?;
        map.as_mut_slice().copy_from_slice(bytes);
        drop(map);
        buffer_mut.set_pts(gst::ClockTime::from_nseconds(ts_ns));
    }

    appsrc
        .push_buffer(buffer)
        .map(|_| ())
        .map_err(EncoderError::PushBuffer)?;
    Ok(())
}

fn required_element(name: &'static str) -> Result<gst::Element, EncoderError> {
    gst::ElementFactory::make(name)
        .build()
        .map_err(|_| EncoderError::MissingElement(name))
}

fn run_bus_loop(
    bus: gst::Bus,
    terminal_tx: watch::Sender<EncoderTerminal>,
    stop_bus: Arc<AtomicBool>,
) {
    while !stop_bus.load(Ordering::Relaxed) {
        let message = bus.timed_pop(gst::ClockTime::from_mseconds(100));
        let Some(message) = message else {
            continue;
        };

        match message.view() {
            gst::MessageView::Eos(..) => {
                let _ = terminal_tx.send(EncoderTerminal::Eos);
                break;
            }
            gst::MessageView::Error(error_message) => {
                let source = error_message
                    .src()
                    .map(|src| src.path_string())
                    .unwrap_or_else(|| "unknown".into());
                let message = format!(
                    "gstreamer error from {source}: {} ({:?})",
                    error_message.error(),
                    error_message.debug()
                );
                let _ = terminal_tx.send(EncoderTerminal::Fatal(message));
                break;
            }
            gst::MessageView::StateChanged(state) => {
                debug!(
                    old = ?state.old(),
                    new = ?state.current(),
                    pending = ?state.pending(),
                    "pipeline state changed"
                );
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn init_gst() {
        let _ = gst::init();
    }

    #[test]
    fn build_caps_maps_formats() {
        init_gst();
        let caps = build_caps(1920, 1080, 1920 * 4, PIXMAN_A8R8G8B8, 0).unwrap();
        let structure = caps.structure(0).unwrap();
        assert_eq!(structure.name(), "video/x-raw");
        assert_eq!(structure.get::<&str>("format").unwrap(), "BGRA");
        assert_eq!(structure.get::<i32>("width").unwrap(), 1920);
        assert_eq!(structure.get::<i32>("height").unwrap(), 1080);
    }

    #[test]
    fn pipeline_graph_reaches_ready_state() {
        init_gst();
        let dir = tempdir().unwrap();
        let out = dir.path().join("graph.mp4");
        let caps = build_caps(640, 480, 640 * 4, PIXMAN_A8R8G8B8, 0).unwrap();
        let (pipeline, _appsrc) = build_pipeline(&out, &caps, QualityMode::Best).unwrap();
        pipeline.set_state(gst::State::Ready).unwrap();
        assert_eq!(pipeline.current_state(), gst::State::Ready);
        pipeline.set_state(gst::State::Null).unwrap();
    }
}
