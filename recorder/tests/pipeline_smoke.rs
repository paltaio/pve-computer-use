use std::{process::Command, sync::Arc, time::Duration};

use pve_record::{
    args::{EncoderMode, QualityMode},
    encoder::{Encoder, EncoderConfig},
    qemu_source::{FrameBuffer, FrameEvent, FrameStorage, QemuSource, PIXMAN_A8R8G8B8},
};
use tempfile::tempdir;
use tokio::sync::mpsc;

#[tokio::test(flavor = "multi_thread")]
async fn encoder_smoke_writes_h264_mp4() {
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
            output: output.clone(),
            fps: Some(60),
            quality: QualityMode::Best,
            encoder: EncoderMode::Openh264,
        },
        shared.clone(),
        rx,
    )
    .unwrap();

    tx.send(FrameEvent::Reset {
        w: 1280,
        h: 720,
        stride: 1280 * 4,
        fourcc: PIXMAN_A8R8G8B8,
        modifier: 0,
    })
    .await
    .unwrap();

    for frame_index in 0..60u32 {
        let pts_ns = u64::from(frame_index) * 1_000_000_000 / 60;
        let frame = FrameBuffer {
            width: 1280,
            height: 720,
            stride: 1280 * 4,
            fourcc: PIXMAN_A8R8G8B8,
            modifier: 0,
            storage: FrameStorage::Bytes(generate_bgra_frame(1280, 720, frame_index)),
        };
        QemuSource::store_test_frame(&shared, frame);
        if let Err(error) = tx.send(FrameEvent::Frame { ts_ns: pts_ns }).await {
            panic!(
                "failed to send frame event at frame {frame_index}: {error}; encoder terminal={:?}",
                encoder.wait_terminal().await
            );
        }
    }
    drop(tx);

    tokio::time::timeout(Duration::from_secs(10), encoder.finalize())
        .await
        .expect("encoder finalize timed out")
        .unwrap();

    let metadata = std::fs::metadata(&output).unwrap();
    assert!(metadata.len() > 4 * 1024);

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
    let report = String::from_utf8_lossy(&ffprobe.stdout);
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
async fn color_order_smoke_preserves_red_channel() {
    let temp = tempdir().unwrap();
    let output = temp.path().join("color-order.mp4");
    let decoded = temp.path().join("decoded.bgra");
    let shared = QemuSource::shared_state();
    let (tx, rx) = mpsc::channel(8);
    let mut encoder = Encoder::start(
        EncoderConfig {
            output: output.clone(),
            fps: Some(30),
            quality: QualityMode::Best,
            encoder: EncoderMode::Openh264,
        },
        shared.clone(),
        rx,
    )
    .unwrap();

    tx.send(FrameEvent::Reset {
        w: 64,
        h: 64,
        stride: 64 * 4,
        fourcc: PIXMAN_A8R8G8B8,
        modifier: 0,
    })
    .await
    .unwrap();

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
