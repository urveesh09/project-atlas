# Validation/rehearsal tooling, never installed in the service images.
FROM node@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
RUN apt-get update && apt-get install -y --no-install-recommends \
    nftables=1.1.3-1 systemd=257.13-1~deb13u1 iproute2=6.15.0-1 openssl=3.5.7-1~deb13u3 \
    && rm -rf /var/lib/apt/lists/*
