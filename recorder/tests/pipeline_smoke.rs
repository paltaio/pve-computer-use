use std::{process::Command, sync::Arc, time::Duration};

use pve_record::{
    args::{EncoderMode, QualityMode},
    encoder::{
        CodecConfig, EncodedOutputSink, EncodedStreamEvent, Encoder, EncoderBackend, EncoderConfig,
        EncoderError, LiveOutputSink, Mp4Sink, VideoCodec,
    },
    qemu_source::{FrameBuffer, FrameEvent, FrameStorage, QemuSource, PIXMAN_A8R8G8B8},
};
use tempfile::tempdir;
use tokio::sync::mpsc;

#[tokio::test(flavor = "multi_thread")]
async fn encoded_unit_emission_exposes_metadata() {
    let shared = QemuSource::shared_state();
    let (tx, rx) = mpsc::channel(8);
    let (live_sink, mut live_stream) = LiveOutputSink::new();
    let mut encoder = Encoder::start(
        EncoderConfig {
            fps: Some(30),
            quality: QualityMode::Best,
            encoder: EncoderMode::Openh264,
        },
        shared.clone(),
        rx,
        vec![Box::new(live_sink)],
    )
    .unwrap();

    send_reset(&tx, 128, 72).await;
    send_frames(&tx, &shared, 128, 72, 3, 30).await;
    drop(tx);

    tokio::time::timeout(Duration::from_secs(10), encoder.finalize())
        .await
        .expect("encoder finalize timed out")
        .unwrap();

    wait_for_live_eos(&mut live_stream).await;

    let snapshot = live_stream.latest();
    let format = snapshot.format.expect("missing format event");
    assert_eq!(format.codec, VideoCodec::H264);
    assert_eq!(format.width, 128);
    assert_eq!(format.height, 72);

    let unit = snapshot.latest_unit.expect("missing encoded unit");
    assert_eq!(unit.codec, VideoCodec::H264);
    assert_eq!(unit.width, 128);
    assert_eq!(unit.height, 72);
    assert!(!unit.payload.is_empty());
    assert!(matches!(unit.codec_config, Some(CodecConfig::H264 { .. })));

    let live_stats = live_stream.stats();
    assert_eq!(live_stats.format_events, 1);
    assert_eq!(live_stats.eos_events, 1);
    assert!(snapshot.eos);
    assert_eq!(encoder.stats().active_resolution, Some((128, 72)));
    assert_eq!(encoder.stats().active_codec, Some(VideoCodec::H264));
}

#[tokio::test(flavor = "multi_thread")]
async fn mp4_sink_preserves_recording_output() {
    let keep_dir = std::env::var_os("PVE_RECORD_LAYER2_DIR").map(std::path::PathBuf::from);
    let temp = if keep_dir.is_none() {
        Some(tempdir().unwrap())
    } else {
        None
    };
    let base_dir = if let Some(path) = keep_dir {
        std::fs::create_dir_all(&path).unwrap();
        path
    } else {
        temp.as_ref().unwrap().path().to_path_buf()
    };

    let output = base_dir.join("pve-record-smoke.mp4");
    let shared = QemuSource::shared_state();
    let (tx, rx) = mpsc::channel(8);
    let mut encoder = Encoder::start(
        EncoderConfig {
            fps: Some(60),
            quality: QualityMode::Best,
            encoder: EncoderMode::Openh264,
        },
        shared.clone(),
        rx,
        vec![Box::new(Mp4Sink::new(output.clone(), Some(60)).unwrap())],
    )
    .unwrap();

    send_reset(&tx, 1280, 720).await;
    send_frames(&tx, &shared, 1280, 720, 60, 60).await;
    drop(tx);

    tokio::time::timeout(Duration::from_secs(10), encoder.finalize())
        .await
        .expect("encoder finalize timed out")
        .unwrap();

    let metadata = std::fs::metadata(&output).unwrap();
    assert!(metadata.len() > 4 * 1024);

    let report = ffprobe_stream_report(&output);
    assert!(report.contains("codec_name=h264"));
    assert!(report.contains("width=1280"));
    assert!(report.contains("height=720"));
    assert!(report.contains("nb_frames=60"));
    let duration = report
        .lines()
        .find_map(|line| line.strip_prefix("duration="))
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!(
        (duration - 1.0).abs() < 0.02,
        "unexpected duration: {duration}"
    );

    let playback = Command::new("bash")
        .arg("tests/playback_smoke.sh")
        .arg(&output)
        .output()
        .unwrap();
    assert!(playback.status.success(), "{playback:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn dual_sink_fanout_keeps_recording_and_coalesces_live_units() {
    let temp = tempdir().unwrap();
    let output = temp.path().join("fanout.mp4");
    let shared = QemuSource::shared_state();
    let (tx, rx) = mpsc::channel(8);
    let (live_sink, mut live_stream) = LiveOutputSink::new();
    let mut encoder = Encoder::start(
        EncoderConfig {
            fps: Some(30),
            quality: QualityMode::Best,
            encoder: EncoderMode::Openh264,
        },
        shared.clone(),
        rx,
        vec![
            Box::new(Mp4Sink::new(output.clone(), Some(30)).unwrap()),
            Box::new(live_sink),
        ],
    )
    .unwrap();

    send_reset(&tx, 320, 180).await;
    send_frames(&tx, &shared, 320, 180, 30, 30).await;
    drop(tx);

    tokio::time::timeout(Duration::from_secs(10), encoder.finalize())
        .await
        .expect("encoder finalize timed out")
        .unwrap();

    let report = ffprobe_stream_report(&output);
    assert!(report.contains("nb_frames=30"), "{report}");

    wait_for_live_eos(&mut live_stream).await;

    let live_stats = live_stream.stats();
    assert_eq!(live_stats.received_units, 30);
    assert!(live_stats.coalesced_units >= 29);
    assert_eq!(live_stats.eos_events, 1);
    assert!(live_stream.latest().latest_unit.is_some());

    let encoder_stats = encoder.stats();
    assert_eq!(encoder_stats.encoded_units, 30);
    assert_eq!(encoder_stats.sink_errors, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn sink_failure_transitions_encoder_to_fatal() {
    let shared = QemuSource::shared_state();
    let (tx, rx) = mpsc::channel(8);
    let mut encoder = Encoder::start(
        EncoderConfig {
            fps: Some(30),
            quality: QualityMode::Best,
            encoder: EncoderMode::Openh264,
        },
        shared.clone(),
        rx,
        vec![Box::new(FailingSink {
            fail_after_units: 1,
            seen_units: 0,
        }) as Box<dyn EncodedOutputSink>],
    )
    .unwrap();

    send_reset(&tx, 128, 72).await;
    send_frames(&tx, &shared, 128, 72, 3, 30).await;
    drop(tx);

    let error = tokio::time::timeout(Duration::from_secs(10), encoder.finalize())
        .await
        .expect("encoder finalize timed out")
        .unwrap_err();
    assert!(matches!(error, EncoderError::Fatal(message) if message.contains("test sink failure")));
    assert_eq!(encoder.stats().sink_errors, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn color_order_smoke_preserves_red_channel() {
    let temp = tempdir().unwrap();
    let output = temp.path().join("color-order.mp4");
    let decoded = temp.path().join("decoded.bgra");
    let shared = QemuSource::shared_state();
    let (tx, rx) = mpsc::channel(8);
    let mut encoder = Encoder::start(
        EncoderConfig {
            fps: Some(30),
            quality: QualityMode::Best,
            encoder: EncoderMode::Openh264,
        },
        shared.clone(),
        rx,
        vec![Box::new(Mp4Sink::new(output.clone(), Some(30)).unwrap())],
    )
    .unwrap();

    send_reset(&tx, 64, 64).await;

    for frame_index in 0..30u32 {
        let pts_ns = u64::from(frame_index) * 1_000_000_000 / 30;
        let frame = FrameBuffer {
            width: 64,
            height: 64,
            stride: 64 * 4,
            fourcc: PIXMAN_A8R8G8B8,
            modifier: 0,
            storage: FrameStorage::Bytes(Arc::<[u8]>::from({
                let mut bytes = vec![0u8; 64 * 64 * 4];
                for pixel in bytes.chunks_exact_mut(4) {
                    pixel.copy_from_slice(&[0, 0, 255, 255]);
                }
                bytes
            })),
        };
        QemuSource::store_test_frame(&shared, frame);
        tx.send(FrameEvent::Frame { ts_ns: pts_ns }).await.unwrap();
    }
    drop(tx);

    tokio::time::timeout(Duration::from_secs(10), encoder.finalize())
        .await
        .expect("encoder finalize timed out")
        .unwrap();

    let decode = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-i",
            output.to_str().unwrap(),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgra",
            decoded.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(decode.status.success(), "{decode:?}");

    let bytes = std::fs::read(decoded).unwrap();
    let pixel = &bytes[..4];
    assert!(pixel[2] > 180, "red channel too low: {}", pixel[2]);
    assert!(pixel[0] < 80, "blue channel too high: {}", pixel[0]);
    assert!(pixel[1] < 80, "green channel too high: {}", pixel[1]);
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_backend_selects_expected_encoder() {
    let shared = QemuSource::shared_state();
    let (_tx, rx) = mpsc::channel(1);
    let (live_sink, _live_stream) = LiveOutputSink::new();
    let encoder = Encoder::start(
        EncoderConfig {
            fps: Some(30),
            quality: QualityMode::Best,
            encoder: EncoderMode::Auto,
        },
        shared,
        rx,
        vec![Box::new(live_sink)],
    )
    .unwrap();

    let expected = if ffmpeg_has_libx264() {
        Some(EncoderBackend::X264)
    } else {
        Some(EncoderBackend::OpenH264)
    };
    assert_eq!(encoder.stats().backend, expected);
}

#[tokio::test(flavor = "multi_thread")]
async fn x264_backend_fanout_works_when_available() {
    if !ffmpeg_has_libx264() {
        return;
    }

    let temp = tempdir().unwrap();
    let output = temp.path().join("x264-fanout.mp4");
    let shared = QemuSource::shared_state();
    let (tx, rx) = mpsc::channel(8);
    let (live_sink, mut live_stream) = LiveOutputSink::new();
    let mut encoder = Encoder::start(
        EncoderConfig {
            fps: Some(30),
            quality: QualityMode::Balanced,
            encoder: EncoderMode::X264,
        },
        shared.clone(),
        rx,
        vec![
            Box::new(Mp4Sink::new(output.clone(), Some(30)).unwrap()),
            Box::new(live_sink),
        ],
    )
    .unwrap();

    send_reset(&tx, 320, 180).await;
    send_frames_realtime(&tx, &shared, 320, 180, 12, 30).await;
    drop(tx);

    tokio::time::timeout(Duration::from_secs(15), encoder.finalize())
        .await
        .expect("encoder finalize timed out")
        .unwrap();

    wait_for_live_eos(&mut live_stream).await;

    let report = ffprobe_stream_report(&output);
    assert!(report.contains("codec_name=h264"), "{report}");
    assert!(report.contains("nb_frames=12"), "{report}");

    let snapshot = live_stream.latest();
    let unit = snapshot.latest_unit.expect("missing x264 live unit");
    assert_eq!(unit.codec, VideoCodec::H264);
    assert!(matches!(unit.codec_config, Some(CodecConfig::H264 { .. })));
    assert_eq!(encoder.stats().backend, Some(EncoderBackend::X264));
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_x264_backend_errors_when_unavailable() {
    if ffmpeg_has_libx264() {
        return;
    }

    let shared = QemuSource::shared_state();
    let (_tx, rx) = mpsc::channel(1);
    let (live_sink, _live_stream) = LiveOutputSink::new();
    let result = Encoder::start(
        EncoderConfig {
            fps: Some(30),
            quality: QualityMode::Best,
            encoder: EncoderMode::X264,
        },
        shared,
        rx,
        vec![Box::new(live_sink)],
    );

    assert!(matches!(result, Err(EncoderError::X264Unavailable)));
}

struct FailingSink {
    fail_after_units: usize,
    seen_units: usize,
}

impl EncodedOutputSink for FailingSink {
    fn handle_event(&mut self, event: EncodedStreamEvent) -> Result<(), EncoderError> {
        if matches!(event, EncodedStreamEvent::Unit(_)) {
            self.seen_units += 1;
            if self.seen_units >= self.fail_after_units {
                return Err(EncoderError::Fatal("test sink failure".into()));
            }
        }
        Ok(())
    }
}

async fn wait_for_live_eos(stream: &mut pve_record::encoder::LiveOutputStream) {
    for _ in 0..16 {
        if stream.latest().eos {
            return;
        }
        tokio::time::timeout(Duration::from_secs(1), stream.changed())
            .await
            .expect("live stream wait timed out")
            .expect("live stream closed unexpectedly");
    }
    panic!("live output stream did not report eos");
}

async fn send_reset(tx: &mpsc::Sender<FrameEvent>, width: u32, height: u32) {
    tx.send(FrameEvent::Reset {
        w: width,
        h: height,
        stride: width * 4,
        fourcc: PIXMAN_A8R8G8B8,
        modifier: 0,
    })
    .await
    .unwrap();
}

async fn send_frames(
    tx: &mpsc::Sender<FrameEvent>,
    shared: &pve_record::qemu_source::SharedFrameState,
    width: u32,
    height: u32,
    frame_count: u32,
    fps: u32,
) {
    for frame_index in 0..frame_count {
        let pts_ns = u64::from(frame_index) * 1_000_000_000 / u64::from(fps.max(1));
        let frame = FrameBuffer {
            width,
            height,
            stride: width * 4,
            fourcc: PIXMAN_A8R8G8B8,
            modifier: 0,
            storage: FrameStorage::Bytes(generate_bgra_frame(
                width as usize,
                height as usize,
                frame_index,
            )),
        };
        QemuSource::store_test_frame(shared, frame);
        tx.send(FrameEvent::Frame { ts_ns: pts_ns }).await.unwrap();
    }
}

async fn send_frames_realtime(
    tx: &mpsc::Sender<FrameEvent>,
    shared: &pve_record::qemu_source::SharedFrameState,
    width: u32,
    height: u32,
    frame_count: u32,
    fps: u32,
) {
    let frame_period = Duration::from_nanos(1_000_000_000 / u64::from(fps.max(1)));
    let start = tokio::time::Instant::now();
    for frame_index in 0..frame_count {
        let pts_ns = u64::from(frame_index) * 1_000_000_000 / u64::from(fps.max(1));
        let frame = FrameBuffer {
            width,
            height,
            stride: width * 4,
            fourcc: PIXMAN_A8R8G8B8,
            modifier: 0,
            storage: FrameStorage::Bytes(generate_bgra_frame(
                width as usize,
                height as usize,
                frame_index,
            )),
        };
        QemuSource::store_test_frame(shared, frame);
        tx.send(FrameEvent::Frame { ts_ns: pts_ns }).await.unwrap();
        let target = start + frame_period.mul_f64(f64::from(frame_index + 1));
        tokio::time::sleep_until(target).await;
    }
    tokio::time::sleep_until(start + frame_period.mul_f64(f64::from(frame_count + 1))).await;
}

fn ffprobe_stream_report(output: &std::path::Path) -> String {
    let ffprobe = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,nb_frames,duration",
            "-of",
            "default=noprint_wrappers=1",
            output.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(ffprobe.status.success(), "{ffprobe:?}");
    String::from_utf8_lossy(&ffprobe.stdout).into_owned()
}

fn ffmpeg_has_libx264() -> bool {
    let output = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .unwrap();
    output.status.success() && String::from_utf8_lossy(&output.stdout).contains("libx264 ")
}

fn generate_bgra_frame(width: usize, height: usize, frame_index: u32) -> Arc<[u8]> {
    let mut bytes = vec![0u8; width * height * 4];
    for y in 0..height {
        for x in 0..width {
            let offset = (y * width + x) * 4;
            bytes[offset] = ((x + frame_index as usize) % 256) as u8;
            bytes[offset + 1] = ((y * 2 + frame_index as usize) % 256) as u8;
            bytes[offset + 2] = ((x / 2 + y / 3 + frame_index as usize * 3) % 256) as u8;
            bytes[offset + 3] = 0xff;
        }
    }
    Arc::<[u8]>::from(bytes)
}
