# Live Validation

1. Boot a minimal Alpine or Debian VM on a Proxmox VE host with `args: -display dbus,p2p=yes` and `vga: std`.
2. Run `pve-record <vmid> -d 5s -o out.mp4`.
3. Verify `ffprobe -v error -show_streams out.mp4` reports `codec_name=h264`, `r_frame_rate≈30-60`, `duration≈5.0`, and the expected width.
4. Run the same command a second time immediately and confirm it still succeeds.
5. Resize the guest display during recording and confirm the file plays through the renegotiation without corruption.

# Manual Playback

1. Record representative clips for idle desktop, mouse movement, and video playback.
2. Verify each clip with `ffprobe -v error -show_streams out.mp4`.
3. Confirm clean playback and seeking in one desktop player and one browser player.
