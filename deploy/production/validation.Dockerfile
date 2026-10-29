# Validation/rehearsal tooling, never installed in the service images.
FROM node@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a
RUN apt-get update && apt-get install -y --no-install-recommends \
    nftables=1.1.3-1 systemd=257.13-1~deb13u1 iproute2=6.15.0-1 openssl=3.5.7-1~deb13u3 \
    && rm -rf /var/lib/apt/lists/*
