use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Result};
use clap::{Parser, ValueEnum};
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;

#[derive(Debug, Parser, Clone)]
#[command(name = "pve-record")]
pub struct Args {
    pub vmid: u32,

    #[arg(short, long)]
    pub output: Option<PathBuf>,

    #[arg(short = 'd', long, value_parser = parse_duration)]
    pub duration: Option<Duration>,

    #[arg(long)]
    pub qmp: Option<PathBuf>,

    #[arg(long, default_value_t = 0)]
    pub console: u32,

    #[arg(long)]
    pub fps: Option<u32>,

    #[arg(long, value_enum, default_value_t = QualityMode::Best)]
    pub quality: QualityMode,

    #[arg(long, value_enum, default_value_t = EncoderMode::Auto)]
    pub encoder: EncoderMode,

    #[arg(short, long, default_value_t = false)]
    pub verbose: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum QualityMode {
    Best,
    Balanced,
    Realtime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum EncoderMode {
    Auto,
    X264,
    Openh264,
}

#[derive(Debug, Clone)]
pub struct ResolvedArgs {
    pub vmid: u32,
    pub output: PathBuf,
    pub duration: Option<Duration>,
    pub qmp: PathBuf,
    pub console: u32,
    pub fps: Option<u32>,
    pub quality: QualityMode,
    pub encoder: EncoderMode,
    pub verbose: bool,
    pub config_path: PathBuf,
}

impl Args {
    pub fn resolve(self) -> Result<ResolvedArgs, String> {
        if self.vmid == 0 {
            return Err("vmid must be greater than 0".into());
        }

        if let Some(fps) = self.fps {
            if fps == 0 {
                return Err("--fps must be greater than 0".into());
            }
        }

        let output = self
            .output
            .unwrap_or_else(|| default_output_path(self.vmid))
            .canonicalize_parent();
        validate_output_path(&output).map_err(|error| error.to_string())?;

        let qmp = self
            .qmp
            .unwrap_or_else(|| PathBuf::from(format!("/run/qemu-server/{}.qmp", self.vmid)));
        if !qmp.exists() {
            return Err(vm_not_running_message(self.vmid));
        }
        let metadata = std::fs::metadata(&qmp)
            .map_err(|error| format!("failed to stat QMP path {}: {error}", qmp.display()))?;
        let file_type = metadata.file_type();
        #[cfg(unix)]
        let is_socket_like = file_type.is_socket() || file_type.is_file();
        #[cfg(not(unix))]
        let is_socket_like = file_type.is_file();
        if !is_socket_like {
            return Err(format!(
                "QMP path is not a socket-like file: {}",
                qmp.display()
            ));
        }

        Ok(ResolvedArgs {
            vmid: self.vmid,
            output,
            duration: self.duration,
            qmp,
            console: self.console,
            fps: self.fps,
            quality: self.quality,
            encoder: self.encoder,
            verbose: self.verbose,
            config_path: config_path(self.vmid),
        })
    }
}

pub fn parse_duration(value: &str) -> Result<Duration, String> {
    humantime::parse_duration(value).map_err(|error| error.to_string())
}

pub fn config_path(vmid: u32) -> PathBuf {
    if let Some(path) = std::env::var_os("PVE_RECORD_VM_CONFIG") {
        return PathBuf::from(path);
    }

    PathBuf::from(format!("/etc/pve/qemu-server/{vmid}.conf"))
}

pub fn dbus_display_message(vmid: u32) -> String {
    format!(
        "VM {vmid} is not configured for D-Bus display. Add to /etc/pve/qemu-server/{vmid}.conf: args: -display dbus,p2p=yes  then: qm stop {vmid} && qm start {vmid}"
    )
}

pub fn vm_not_running_message(vmid: u32) -> String {
    format!("VM {vmid} is not running. Start it with: qm start {vmid}")
}

pub fn protocol_unavailable_message() -> &'static str {
    "QEMU D-Bus display protocol is unavailable. Check: qemu-system-x86_64 -display help | grep dbus"
}

pub fn non_shareable_surface_message(vmid: u32) -> String {
    format!(
        "VM {vmid}'s display surface is not backed by shared memory. Check /etc/pve/qemu-server/{vmid}.conf and ensure \"vga:\" is one of: std, virtio, qxl, vmware. Cirrus and custom passthrough VGAs are not supported. Then: qm stop {vmid} && qm start {vmid}"
    )
}

fn validate_output_path(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !(parent.exists() && parent.is_dir()) {
        return Err(anyhow!(
            "output directory does not exist: {}",
            parent.display()
        ));
    }

    let existed = path.exists();
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| anyhow!("output path is not writable ({}): {error}", path.display()))?;
    drop(file);

    if !existed {
        let _ = fs::remove_file(path);
    }

    Ok(())
}

fn default_output_path(vmid: u32) -> PathBuf {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    PathBuf::from(format!("./vm-{vmid}-{unix}.mp4"))
}

trait CanonicalizeParent {
    fn canonicalize_parent(self) -> PathBuf;
}

impl CanonicalizeParent for PathBuf {
    fn canonicalize_parent(self) -> PathBuf {
        if self.is_absolute() {
            return self;
        }

        if let Some(parent) = self.parent() {
            if parent.as_os_str().is_empty() {
                return self;
            }
            if let Ok(base) = parent.canonicalize() {
                if let Some(name) = self.file_name() {
                    return base.join(name);
                }
            }
        }

        self
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::net::UnixListener;

    use super::*;
    use clap::Parser;
    use tempfile::tempdir;

    #[test]
    fn parses_valid_args() {
        let tmp = tempdir().unwrap();
        let qmp = tmp.path().join("100.qmp");
        fs::write(&qmp, []).unwrap();
        let output = tmp.path().join("out.mp4");

        let args = Args::try_parse_from([
            "pve-record",
            "100",
            "--qmp",
            qmp.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
            "--duration",
            "1m30s",
            "--fps",
            "60",
            "--quality",
            "realtime",
            "--encoder",
            "openh264",
        ])
        .unwrap();

        let resolved = args.resolve().unwrap();
        assert_eq!(resolved.vmid, 100);
        assert_eq!(resolved.duration, Some(Duration::from_secs(90)));
        assert_eq!(resolved.fps, Some(60));
        assert_eq!(resolved.quality, QualityMode::Realtime);
        assert_eq!(resolved.encoder, EncoderMode::Openh264);
    }

    #[test]
    fn rejects_missing_qmp_socket() {
        let tmp = tempdir().unwrap();
        let output = tmp.path().join("out.mp4");

        let args = Args::try_parse_from([
            "pve-record",
            "101",
            "--qmp",
            tmp.path().join("missing.qmp").to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ])
        .unwrap();

        assert_eq!(args.resolve().unwrap_err(), vm_not_running_message(101));
    }

    #[test]
    fn rejects_unwritable_output_parent() {
        let tmp = tempdir().unwrap();
        let qmp = tmp.path().join("102.qmp");
        fs::write(&qmp, []).unwrap();
        let output = tmp.path().join("missing").join("out.mp4");

        let args = Args::try_parse_from([
            "pve-record",
            "102",
            "--qmp",
            qmp.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ])
        .unwrap();

        let error = args.resolve().unwrap_err();
        assert!(error.contains("output directory does not exist"));
    }

    #[cfg(unix)]
    #[test]
    fn accepts_unix_socket_qmp_path() {
        let tmp = tempdir().unwrap();
        let qmp = tmp.path().join("103.qmp");
        let _listener = UnixListener::bind(&qmp).unwrap();
        let output = tmp.path().join("out.mp4");

        let args = Args::try_parse_from([
            "pve-record",
            "103",
            "--qmp",
            qmp.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ])
        .unwrap();

        let resolved = args.resolve().unwrap();
        assert_eq!(resolved.qmp, qmp);
    }

    #[test]
    fn parses_duration_variants() {
        assert_eq!(parse_duration("10s").unwrap(), Duration::from_secs(10));
        assert_eq!(parse_duration("1m30s").unwrap(), Duration::from_secs(90));
        assert_eq!(parse_duration("2h").unwrap(), Duration::from_secs(7200));
    }
}
