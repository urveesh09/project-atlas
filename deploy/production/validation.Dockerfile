# Validation/rehearsal tooling, never installed in the service images.
FROM node@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
RUN apt-get update && apt-get install -y --no-install-recommends \
    nftables=1.1.3-1 systemd=257.13-1~deb13u1 iproute2=6.15.0-1 openssl=3.5.7-1~deb13u3 \
    zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
    && rm -rf /var/lib/apt/lists/*
