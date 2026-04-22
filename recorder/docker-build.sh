#!/usr/bin/env bash
set -euo pipefail

image="pve-record-builder:local"

mkdir -p dist

DOCKER_BUILDKIT=1 docker build --target builder -t "$image" .
docker run --rm -v "$PWD/dist:/out" --entrypoint /bin/sh "$image" -c 'cp /work/target/release/pve-record /out/pve-record'
