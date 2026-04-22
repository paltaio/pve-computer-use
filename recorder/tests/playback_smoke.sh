#!/usr/bin/env bash
set -euo pipefail

input="${1:?usage: playback_smoke.sh <file.mp4>}"
stderr_file="$(mktemp)"
trap 'rm -f "$stderr_file"' EXIT

ffmpeg -v error -i "$input" -f null - 2>"$stderr_file"

if grep -Eiq 'error|invalid|corrupt|decode|missing' "$stderr_file"; then
  cat "$stderr_file" >&2
  exit 1
fi
