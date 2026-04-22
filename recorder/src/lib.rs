#![warn(clippy::all)]
#![warn(clippy::pedantic)]

use std::{process::ExitCode, time::Duration};

use anyhow::{anyhow, Context};
use qemu_display::{Console, Display};
use thiserror::Error;
use tokio::sync::mpsc;
use tracing::debug;
use tracing_subscriber::EnvFilter;
#[cfg(unix)]
use {
    qapi::{qmp, Qmp},
    qemu_display::zbus::{self, names::BusName},
    std::io::{BufRead, BufReader, Write},
    std::os::{fd::AsRawFd, unix::net::UnixStream},
};

pub mod args;
pub mod encoder;
pub mod qemu_source;

use args::{
    dbus_display_message, non_shareable_surface_message, protocol_unavailable_message, Args,
    ResolvedArgs,
};
use encoder::{Encoder, EncoderConfig, EncoderTerminal, Mp4Sink};
use qemu_source::{BaseListener, MapListener, QemuSource};

#[derive(Debug, Error)]
pub enum RunFailure {
    #[error("{0}")]
    Preflight(String),
    #[error("{0}")]
    Dirty(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

#[async_trait::async_trait(?Send)]
trait RecorderBackend {
    async fn register(
        &self,
        args: &ResolvedArgs,
        base: BaseListener,
        map: MapListener,
    ) -> Result<Box<dyn RegisteredConsole>, anyhow::Error>;
}

trait RegisteredConsole: Send + Sync {
    fn unregister(&self);
}

struct QemuBackend;

struct QemuConsole {
    console: Console,
}

impl RegisteredConsole for QemuConsole {
    fn unregister(&self) {
        self.console.unregister_listener();
    }
}

#[async_trait::async_trait(?Send)]
impl RecorderBackend for QemuBackend {
    async fn register(
        &self,
        args: &ResolvedArgs,
        base: BaseListener,
        map: MapListener,
    ) -> Result<Box<dyn RegisteredConsole>, anyhow::Error> {
        let armed_base = base.clone();
        let display = open_display(&args.qmp).await?;
        let console = Console::new(display.connection(), args.console)
            .await
            .context("failed to open qemu console")?;
        console
            .register_listener(base)
            .await
            .context("failed to register qemu listener")?;
        let map_registered = console
            .set_map_listener(map)
            .await
            .context("failed to register qemu map listener")?;
        debug!(map_registered, "set_map_listener completed");
        if !map_registered {
            return Err(anyhow!("qemu listener map interface was not installed"));
        }
        armed_base.arm_non_shareable_detection();
        debug!("non-shareable detection armed");
        Ok(Box::new(QemuConsole { console }))
    }
}

async fn open_display(qmp_path: &std::path::Path) -> Result<Display<'static>, anyhow::Error> {
    #[cfg(unix)]
    {
        let conn = open_qmp_display_connection(qmp_path).await?;
        return Display::new(&conn, Option::<BusName<'static>>::None)
            .await
            .map_err(map_qemu_error);
    }

    #[cfg(not(unix))]
    {
        Display::new_qmp(qmp_path).await.map_err(map_qemu_error)
    }
}

#[cfg(unix)]
async fn open_qmp_display_connection(
    qmp_path: &std::path::Path,
) -> Result<zbus::Connection, anyhow::Error> {
    let stream = UnixStream::connect(qmp_path).context("failed to connect to QMP socket")?;
    let reader = stream
        .try_clone()
        .context("failed to clone QMP stream for reading")?;
    let writer = stream
        .try_clone()
        .context("failed to clone QMP stream for writing")?;
    let mut qmp = Qmp::new(qapi::Stream::new(BufReader::new(reader), writer));
    qmp.handshake().context("failed QMP handshake")?;

    let (p0, p1) = UnixStream::pair().context("failed to create local display socketpair")?;
    send_getfd(&stream, &mut qmp, p0.as_raw_fd(), "fdname").context("QMP getfd failed")?;
    qmp.execute(&qmp::add_client {
        skipauth: None,
        tls: None,
        protocol: "@dbus-display".into(),
        fdname: "fdname".into(),
    })
    .context("QMP add_client failed")?;

    zbus::connection::Builder::unix_stream(p1)
        .p2p()
        .build()
        .await
        .context("failed to build p2p D-Bus connection")
}

#[cfg(unix)]
fn send_getfd<S: BufRead + Write>(
    qmp_stream: &UnixStream,
    qmp: &mut Qmp<S>,
    fd: std::os::fd::RawFd,
    fdname: &str,
) -> Result<(), anyhow::Error> {
    use nix::sys::socket::{sendmsg, ControlMessage, MsgFlags};
    use std::io::IoSlice;

    let payload = format!("{{\"execute\":\"getfd\",\"arguments\":{{\"fdname\":\"{fdname}\"}}}}\n");
    let iov = [IoSlice::new(payload.as_bytes())];
    sendmsg::<()>(
        qmp_stream.as_raw_fd(),
        &iov,
        &[ControlMessage::ScmRights(&[fd])],
        MsgFlags::empty(),
        None,
    )
    .context("failed to send QMP fd via SCM_RIGHTS")?;

    qmp.read_response::<qmp::getfd>()
        .context("failed to read QMP getfd response")?;
    Ok(())
}

enum StopReason {
    Signal,
    Duration,
    Encoder(EncoderTerminal),
}

pub async fn run(args: Args) -> Result<ExitCode, RunFailure> {
    let resolved = args.resolve().map_err(RunFailure::Preflight)?;
    run_with_backend(resolved, &QemuBackend).await
}

pub fn init_logging(verbose: bool) {
    let filter = if verbose { "debug" } else { "info" };
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(filter)),
        )
        .with_target(false)
        .try_init();
}

async fn run_with_backend(
    args: ResolvedArgs,
    backend: &dyn RecorderBackend,
) -> Result<ExitCode, RunFailure> {
    preflight(&args).await?;

    let shared = QemuSource::shared_state();
    let (tx, rx) = mpsc::channel(2);
    let (base, map, source_handle) = QemuSource::listeners(shared.clone(), tx);
    let console = backend
        .register(&args, base, map)
        .await
        .map_err(RunFailure::Internal)?;
    let sinks: Vec<Box<dyn encoder::EncodedOutputSink>> = vec![Box::new(
        Mp4Sink::new(args.output.clone(), args.fps).map_err(anyhow::Error::from)?,
    )];
    let mut encoder = Encoder::start(
        EncoderConfig {
            fps: args.fps,
            quality: args.quality,
            encoder: args.encoder,
        },
        shared,
        rx,
        sinks,
    )
    .map_err(|error| RunFailure::Internal(error.into()))?;

    let stop = tokio::select! {
        _ = tokio::signal::ctrl_c() => StopReason::Signal,
        _ = wait_sigterm() => StopReason::Signal,
        _ = sleep_opt(args.duration) => StopReason::Duration,
        terminal = encoder.wait_terminal() => StopReason::Encoder(terminal),
    };

    console.unregister();
    if source_handle.non_shareable_path_detected() {
        encoder.shutdown_now().await;
        return Err(RunFailure::Preflight(non_shareable_surface_message(
            args.vmid,
        )));
    }
    if let Some(error) = source_handle.take_fatal_error() {
        encoder.shutdown_now().await;
        return Err(RunFailure::Internal(anyhow!(error)));
    }
    source_handle.send_eos().await;

    match stop {
        StopReason::Encoder(EncoderTerminal::Fatal(message)) => {
            let _ = finalize_with_exit3_window(StopReason::Duration, &mut encoder).await;
            Err(RunFailure::Internal(anyhow!(message)))
        }
        StopReason::Encoder(EncoderTerminal::Eos) => finalize_with_exit3_window(stop, &mut encoder)
            .await
            .map(|_| ExitCode::SUCCESS),
        StopReason::Signal | StopReason::Duration => finalize_with_exit3_window(stop, &mut encoder)
            .await
            .map(|_| ExitCode::SUCCESS),
        StopReason::Encoder(EncoderTerminal::Running) => unreachable!(),
    }
}

async fn finalize_with_exit3_window(
    stop: StopReason,
    encoder: &mut Encoder,
) -> Result<(), RunFailure> {
    match stop {
        StopReason::Signal => {
            tokio::select! {
                result = encoder.finalize() => {
                    result.map_err(|error| RunFailure::Dirty(error.to_string()))
                }
                _ = second_sigint_within(Duration::from_secs(2)) => {
                    Err(RunFailure::Dirty("second SIGINT within 2 s".into()))
                }
            }
        }
        _ => encoder
            .finalize()
            .await
            .map_err(|error| RunFailure::Dirty(error.to_string())),
    }
}

async fn preflight(args: &ResolvedArgs) -> Result<(), RunFailure> {
    if args.config_path.exists() {
        let config = tokio::fs::read_to_string(&args.config_path)
            .await
            .map_err(|error| {
                RunFailure::Internal(anyhow!(
                    "failed to read {}: {error}",
                    args.config_path.display()
                ))
            })?;
        if !config.contains("-display dbus") {
            return Err(RunFailure::Preflight(dbus_display_message(args.vmid)));
        }
    }

    Ok(())
}

async fn sleep_opt(duration: Option<Duration>) {
    if let Some(duration) = duration {
        tokio::time::sleep(duration).await;
    } else {
        std::future::pending::<()>().await;
    }
}

async fn wait_sigterm() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        if let Ok(mut signal) = signal(SignalKind::terminate()) {
            let _ = signal.recv().await;
            return;
        }
    }

    std::future::pending::<()>().await;
}

async fn second_sigint_within(duration: Duration) {
    if tokio::time::timeout(duration, tokio::signal::ctrl_c())
        .await
        .is_err()
    {
        std::future::pending::<()>().await;
    }
}

fn map_qemu_error(error: qemu_display::Error) -> anyhow::Error {
    if error.to_string().contains("ProtocolNotAvailable") {
        anyhow!(protocol_unavailable_message())
    } else {
        anyhow!(error)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use qemu_display::{ConsoleListenerHandler, Scanout};
    use tempfile::tempdir;

    use super::*;
    use crate::qemu_source::PIXMAN_X8R8G8B8;

    struct StubBackend {
        mode: StubMode,
    }

    enum StubMode {
        CpuPath,
    }

    struct StubConsole;

    impl RegisteredConsole for StubConsole {
        fn unregister(&self) {}
    }

    #[async_trait::async_trait(?Send)]
    impl RecorderBackend for StubBackend {
        async fn register(
            &self,
            _args: &ResolvedArgs,
            mut base: BaseListener,
            _map: MapListener,
        ) -> Result<Box<dyn RegisteredConsole>, anyhow::Error> {
            match self.mode {
                StubMode::CpuPath => {
                    base.arm_non_shareable_detection();
                    tokio::spawn(async move {
                        base.scanout(Scanout {
                            width: 640,
                            height: 480,
                            stride: 2560,
                            format: PIXMAN_X8R8G8B8,
                            data: vec![0; 640 * 480 * 4],
                        })
                        .await;
                    });
                }
            }

            Ok(Box::new(StubConsole))
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn layer3_cpu_path_fallback_returns_success() {
        let dir = tempdir().unwrap();
        let qmp = dir.path().join("100.qmp");
        let config = dir.path().join("100.conf");
        fs::write(&qmp, []).unwrap();
        fs::write(&config, "args: -display dbus,p2p=yes\n").unwrap();
        let output = dir.path().join("out.mp4");
        std::env::set_var("PVE_RECORD_VM_CONFIG", &config);
        std::env::set_var("PVE_RECORD_SUPPRESS_SIGTERM", "1");

        let args = Args {
            vmid: 100,
            output: Some(output),
            duration: Some(Duration::from_millis(50)),
            qmp: Some(qmp),
            console: 0,
            fps: None,
            quality: crate::args::QualityMode::Best,
            encoder: crate::args::EncoderMode::Openh264,
            verbose: false,
        }
        .resolve()
        .unwrap();

        let result = run_with_backend(
            args,
            &StubBackend {
                mode: StubMode::CpuPath,
            },
        )
        .await;
        std::env::remove_var("PVE_RECORD_VM_CONFIG");
        std::env::remove_var("PVE_RECORD_SUPPRESS_SIGTERM");

        match result {
            Ok(code) => assert_eq!(code, ExitCode::SUCCESS),
            other => panic!("unexpected result: {other:?}"),
        }
    }
}
