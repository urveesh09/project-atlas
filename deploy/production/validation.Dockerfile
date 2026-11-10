# Validation/rehearsal tooling, never installed in the service images.
FROM node@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
RUN apt-get update && apt-get install -y --no-install-recommends \
    nftables=1.1.3-1 systemd=257.13-1~deb13u1 iproute2=6.15.0-1 openssl=3.5.7-1~deb13u3 \
    zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
    && rm -rf /var/lib/apt/lists/*
