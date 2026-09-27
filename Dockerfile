# syntax=docker/dockerfile:1.7-labs
###############################################################################
# zag — zag image
#
# Stages:
#   natives-builder — Rust + Bun → zag_natives.linux-<arch>.node
#   wheel-builder   — zag_rpc Python wheel
#   zag-base         — python + bun + rustup launcher + natives + zag_rpc
#                     + /usr/local/bin/zag shim
#   zag-runtime      — zag-base + zag source + bun install      (DEFAULT, runnable)
#
# Build:
#     docker build -t zag/zag:dev .                          # default = zag-runtime
#     docker build --target zag-base -t zag/zag-base:dev .    # base for derived images
#
# Run:
#     docker run --rm zag/zag:dev --help
#     docker run --rm -it -v "$PWD":/work zag/zag:dev cli    # interactive zag
#
# Consume as a base in another Dockerfile (see Dockerfile.robozag):
#     ARG ZAG_BASE=zag/zag:dev
#     FROM ${ZAG_BASE} AS zag-base
###############################################################################

ARG BUN_VERSION=1.4.2

############################
# 1) natives-builder — Rust + Bun → zag_natives.linux-<arch>.node (local cargo)
############################
FROM rust:1.86-slim-bookworm AS natives-builder

ARG BUN_VERSION

# The addon is built with the default cargo/napi-rs host backend, not Bazel:
# the image is one fixed host target, so Bazel's hermetic cross toolchains
# and crate_universe splice buy nothing while costing a bazelisk download
# plus a full analysis phase on every build. `ci` profile = release codegen,
# thin LTO, stripped.
ENV BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    CARGO_TERM_COLOR=never \
    ZAG_NATIVE_CARGO_PROFILE=ci

# clang/libclang-dev: bindgen for pipewire-sys/libspa-sys (Linux desktop capture);
# cmake/make/ninja-build: opusic-sys builds bundled libopus via CMake.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates pkg-config libssl-dev unzip git \
        clang libclang-dev cmake make ninja-build \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

WORKDIR /zag

# Layer 0 — the pinned nightly toolchain. Its own layer so a source or manifest
# edit never re-downloads ~5 rustup components.
COPY rust-toolchain.toml /zag/
RUN rustup show

# Layer 1 — manifests + lockfiles only. Source edits under packages/*/src and
# crates/*/src won't bust `bun install` below. `--parents` preserves the
# matched path under /zag/ (requires syntax 1.7-labs).
COPY --parents \
    package.json bun.lock bunfig.toml \
    patches/*.patch \
    tsconfig.base.json tsconfig.json \
    Cargo.toml Cargo.lock rust-toolchain.toml \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    python/robozag/web/package.json \
    crates/*/Cargo.toml \
    /zag/

# Layer 2 — hydrate node_modules from the manifests above.
RUN bun install --frozen-lockfile --ignore-scripts

# Layer 3 — full source. `Dockerfile.dockerignore` keeps target/, node_modules/,
# dist/, runs/, editor noise, etc. out of the context. node_modules from Layer 2
# is preserved across this COPY because it's never in the build context.
COPY . /zag/

# Layer 4 — compile zag-natives to a Linux N-API addon. Persistent caches keep
# repeat builds incremental: cargo's package index + git-deps (CARGO_HOME is
# /usr/local/cargo in the rust image, not ~/.cargo) + the workspace target dir.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/zag/target \
    set -eux; \
    bun --cwd=packages/natives run build; \
    mkdir -p /out; \
    cp packages/natives/native/zag_natives.linux-*.node /out/

############################
# 2) wheel-builder — zag-rpc wheel
############################
FROM python:3.12-slim-bookworm AS wheel-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip build

WORKDIR /src
COPY python/zag-rpc /src
RUN python -m build --wheel --outdir /out

############################
# 3) zag-base — python + bun + rustup + natives + zag_rpc + zag shim
#
# Sharable runtime base. Derived images (zag-runtime below, Dockerfile.robozag)
# extend this and overlay their own source tree. Default ZAG_ROOT=/work/zag is
# friendly to derived images that mount a host zag checkout there; zag-runtime
# overrides it to /zag because its source is baked in.
############################
FROM python:3.12-slim-bookworm AS zag-base

ARG BUN_VERSION
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BUN_INSTALL=/opt/bun \
    ZAG_ROOT=/work/zag \
    CARGO_HOME=/data/cache/cargo \
    CARGO_TARGET_DIR=/data/cache/cargo-target \
    RUSTUP_HOME=/data/cache/rustup \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates unzip openssh-client tini sqlite3 \
        build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

# Rustup launcher only — the real toolchain is fetched lazily into RUSTUP_HOME
# on first cargo invocation, driven by zag's `rust-toolchain.toml`. Keeps the
# image small while sharing the toolchain across reboots when /data is mounted.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup-bootstrap \
       sh /tmp/rustup-init.sh -y --no-modify-path --default-toolchain none --profile minimal \
    && rm -f /tmp/rustup-init.sh \
    && rm -rf /usr/local/rustup-bootstrap \
    && /usr/local/cargo/bin/rustup --version

# zag-natives addon: zag's loader probes /opt/bun/bin as a fallback path.
COPY --from=natives-builder /out/zag_natives.linux-*.node /opt/bun/bin/

# zag-rpc Python wheel.
COPY --from=wheel-builder /out/*.whl /tmp/wheels/
RUN pip install /tmp/wheels/zag_rpc-*.whl && rm -rf /tmp/wheels

# Legal payload for the reusable SDKs and the ZAG product installed in this image.
COPY LICENSE  THIRD-PARTY-NOTICES.txt /usr/share/doc/zag/

# `zag` shim — runs the coding-agent CLI against $ZAG_ROOT via Bun. Derived
# images override ZAG_ROOT to point at wherever their zag source lives.
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    ': "${ZAG_ROOT:=/work/zag}"' \
    'if [ ! -d "$ZAG_ROOT/packages/coding-agent" ]; then' \
    '  echo "zag: ZAG_ROOT=$ZAG_ROOT does not look like a zag checkout" >&2' \
    '  exit 127' \
    'fi' \
    'exec bun "$ZAG_ROOT/packages/coding-agent/src/cli.ts" "$@"' \
    > /usr/local/bin/zag \
    && chmod +x /usr/local/bin/zag

############################
# 4) zag-runtime — zag-base + zag source + bun install (DEFAULT)
#
# A self-contained, runnable zag image. `docker run zag/zag:dev --help`
# Just Works without a host checkout.
############################
FROM zag-base AS zag-runtime

ENV ZAG_ROOT=/zag
WORKDIR /zag

# Same manifests-only layered install pattern as natives-builder — `bun install`
# only re-runs when a package.json / lockfile changes.
COPY --parents \
    package.json bun.lock bunfig.toml \
    patches/*.patch \
    tsconfig.base.json tsconfig.json \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    python/robozag/web/package.json \
    /zag/

RUN bun install --frozen-lockfile --ignore-scripts

# Zag source. `Dockerfile.dockerignore` keeps **/node_modules out of the context
# so stale isolated-linker symlinks from a host install can't shadow the
# hoisted node_modules that `bun install` just produced.
COPY . /zag/

# Regenerate the tool views that `--ignore-scripts` skipped above. The root
# package.json's `prepare` script normally handles these on a vanilla install.
RUN bun --cwd=packages/coding-agent run gen:tool-views

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/zag"]
CMD ["--help"]
