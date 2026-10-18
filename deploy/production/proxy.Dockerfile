# Upstream carries cap_net_bind_service on /usr/bin/caddy. Remove that file capability
# so exec works with an empty capability bounding set; this profile binds port 8443.
FROM caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
RUN setcap -r /usr/bin/caddy
USER 10001:10001
