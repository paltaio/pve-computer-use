FROM rust:1.95-slim-trixie AS builder

WORKDIR /work

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        nasm \
        build-essential \
        pkg-config \
        ca-certificates \
        libc6-dev \
        git \
        libusb-1.0-0-dev \
        libusbredirparser-dev \
        libusbredirhost-dev \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src \
    && printf 'fn main() {}\n' > src/main.rs \
    && printf '' > src/lib.rs
RUN cargo fetch --locked

COPY . .

RUN cargo build --release --locked \
    && strip --strip-unneeded target/release/pve-record

FROM gcr.io/distroless/cc-debian13 AS release

COPY --from=builder /work/target/release/pve-record /pve-record

ENTRYPOINT ["/pve-record"]
