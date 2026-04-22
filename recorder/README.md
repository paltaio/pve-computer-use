# pve-record

`pve-record` records a Proxmox VM display exposed through QEMU's D-Bus display protocol and writes H.264 in MP4.

## Runtime requirements

- VM config includes `args: -display dbus,p2p=yes`
- VM `vga:` is one of `std`, `virtio`, `qxl`, or `vmware`
- Runtime host needs no GStreamer packages

## Build requirements

Install `nasm` on the build host if you want the OpenH264 assembly fast path.

```sh
apt install nasm
```

If `nasm` is missing, `openh264-sys2` falls back to the non-assembly build.

## Build

Quick build on the host:

```sh
cd recorder
cargo build --release
```

Produces:

```text
target/release/pve-record
```

Reproducible Docker build:

```sh
cd recorder
./docker-build.sh
```

Produces:

```text
dist/pve-record
```

## Notes

- `--encoder auto` prefers x264 via `ffmpeg` when `libx264` is available and otherwise falls back to `openh264` with MP4 output written through the `mp4` crate.
- Mid-recording resolution changes keep the original output dimensions for the current file. The recorder continues, but the new surface is copied into the original frame size instead of reopening the MP4 track.
- Audio is not recorded in v1.
