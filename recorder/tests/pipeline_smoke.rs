use std::{process::Command, sync::Arc, time::Duration};

use gstreamer as gst;
use pve_record::{
    args::QualityMode,
    encoder::{Encoder, EncoderConfig},
    qemu_source::{FrameBuffer, FrameEvent, FrameStorage, QemuSource, PIXMAN_A8R8G8B8},
};
use tempfile::tempdir;
use tokio::sync::mpsc;

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_smoke_writes_h264_mp4() {
    gst::init().unwrap();

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
    let raw_frames = base_dir.join("videotestsrc.bgra");
    let shared = QemuSource::shared_state();
    let (tx, rx) = mpsc::channel(2);
    let mut encoder = Encoder::start(
        EncoderConfig {
            output: output.clone(),
            fps: None,
            quality: QualityMode::Best,
        },
        shared.clone(),
        rx,
    )
    .unwrap();

    eprintln!("layer2: generating raw frames");
    let generate = Command::new("gst-launch-1.0")
        .args([
            "-q",
            "videotestsrc",
            "num-buffers=60",
            "pattern=smpte",
            "!",
            "video/x-raw,format=BGRA,width=1280,height=720,framerate=60/1",
            "!",
            "filesink",
            &format!("location={}", raw_frames.display()),
        ])
        .output()
        .unwrap();
    assert!(generate.status.success(), "{generate:?}");

    let bytes = std::fs::read(&raw_frames).unwrap();
    let frame_size = 1280 * 720 * 4;
    assert_eq!(bytes.len(), frame_size * 60);
    eprintln!("layer2: generated {} bytes", bytes.len());

    tx.send(FrameEvent::Reset {
        w: 1280,
        h: 720,
        stride: 1280 * 4,
        fourcc: PIXMAN_A8R8G8B8,
        modifier: 0,
    })
    .await
    .unwrap();

    let mut pts = 0u64;
    for chunk in bytes.chunks_exact(frame_size) {
        QemuSource::store_test_frame(
            &shared,
            FrameBuffer {
                width: 1280,
                height: 720,
                stride: 1280 * 4,
                fourcc: PIXMAN_A8R8G8B8,
                modifier: 0,
                storage: FrameStorage::Bytes(Arc::<[u8]>::from(chunk)),
            },
        );
        tx.send(FrameEvent::Frame { ts_ns: pts }).await.unwrap();
        pts += 16_666_667;
    }

    drop(tx);
    eprintln!("layer2: waiting for encoder finalize");
    tokio::time::timeout(Duration::from_secs(10), encoder.finalize())
        .await
        .expect("encoder finalize timed out")
        .unwrap();
    eprintln!("layer2: encoder finalized");

    let metadata = std::fs::metadata(&output).unwrap();
    assert!(metadata.len() > 4 * 1024);

    eprintln!("layer2: running gst-discoverer");
    let discover = Command::new("gst-discoverer-1.0")
        .args(["-v", output.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(discover.status.success());
    let stdout = String::from_utf8_lossy(&discover.stdout);
    let stderr = String::from_utf8_lossy(&discover.stderr);
    let report = format!("{stdout}\n{stderr}");
    eprintln!("layer2: discoverer report\n{report}");
    assert!(report.contains("video/x-h264"));
    assert!(
        report.contains("width=1280")
            || report.contains("Width: 1280")
            || report.contains("width=(int)1280")
            || report.contains("width=(uint)1280")
    );
}
