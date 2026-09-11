# syntax=docker/dockerfile:1.7

FROM rust:1.90-bookworm AS rust-toolchain

FROM node:22-bookworm AS builder
COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
ENV PATH="/usr/local/cargo/bin:${PATH}" \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
WORKDIR /src
COPY . .
RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-pack --version 0.13.1 --locked \
    && npm --prefix web ci \
    && make web-build \
    && cargo build --release -p mb-cli

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 memberberry \
    && install -d -o memberberry -g memberberry /app/web /data /vault
COPY --from=builder /src/target/release/memberberry /usr/local/bin/memberberry
COPY --from=builder /src/web/dist/ /app/web/
COPY --chown=memberberry:memberberry deploy/container-entrypoint.sh /usr/local/bin/container-entrypoint
USER memberberry
ENV MEMBERBERRY_DATA_DIR=/data
EXPOSE 9010
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent --output /dev/null http://127.0.0.1:9010/
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/container-entrypoint"]
CMD ["serve"]
