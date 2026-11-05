# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS verify
ARG KALA_VERSION
ARG KALA_REVISION
ARG KALA_SOURCE
ARG KALA_CREATED
ARG KALA_ASSET_SHA256
WORKDIR /opt/kala
COPY release/kala-dashboard-with-runtime.cjs ./kala-dashboard-with-runtime.cjs
RUN test -n "${KALA_VERSION}" \
    && test -n "${KALA_REVISION}" \
    && test -n "${KALA_SOURCE}" \
    && test -n "${KALA_CREATED}" \
    && test -n "${KALA_ASSET_SHA256}" \
    && printf '%s  %s\n' "${KALA_ASSET_SHA256}" kala-dashboard-with-runtime.cjs | sha256sum --check --strict \
    && install -d -o 65532 -g 65532 -m 0700 \
       /var/lib/kala /var/lib/kala/sessions /var/lib/kala/artifacts /var/lib/kala/audit

FROM gcr.io/distroless/nodejs22-debian13@sha256:5e72a679e328276f6ffc3c4bb45c94f847f6abf0b424a1f8cc984f7f1c1daf47 AS node-runtime-source
FROM scratch AS node-runtime
COPY --from=node-runtime-source /nodejs/bin/node /nodejs/bin/node
COPY --from=node-runtime-source /etc/os-release /etc/os-release
COPY --from=node-runtime-source /etc/debian_version /etc/debian_version
COPY --from=node-runtime-source /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=node-runtime-source /etc/passwd /etc/passwd
COPY --from=node-runtime-source /etc/group /etc/group
COPY --from=node-runtime-source /etc/nsswitch.conf /etc/nsswitch.conf
COPY --from=node-runtime-source /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=node-runtime-source /usr/lib/x86_64-linux-gnu/libdl.so.2 /usr/lib/x86_64-linux-gnu/libdl.so.2
COPY --from=node-runtime-source /usr/lib/x86_64-linux-gnu/libstdc++.so.6 /usr/lib/x86_64-linux-gnu/libstdc++.so.6
COPY --from=node-runtime-source /usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.33 /usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.33
COPY --from=node-runtime-source /usr/lib/x86_64-linux-gnu/libm.so.6 /usr/lib/x86_64-linux-gnu/libm.so.6
COPY --from=node-runtime-source /usr/lib/x86_64-linux-gnu/libgcc_s.so.1 /usr/lib/x86_64-linux-gnu/libgcc_s.so.1
COPY --from=node-runtime-source /usr/lib/x86_64-linux-gnu/libpthread.so.0 /usr/lib/x86_64-linux-gnu/libpthread.so.0
COPY --from=node-runtime-source /usr/lib/x86_64-linux-gnu/libc.so.6 /usr/lib/x86_64-linux-gnu/libc.so.6
COPY --from=node-runtime-source /usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2
COPY --from=node-runtime-source /usr/lib64/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2
COPY --from=node-runtime-source /var/lib/dpkg/status.d/base-files* /var/lib/dpkg/status.d/
COPY --from=node-runtime-source /var/lib/dpkg/status.d/ca-certificates* /var/lib/dpkg/status.d/
COPY --from=node-runtime-source /var/lib/dpkg/status.d/gcc-14-base* /var/lib/dpkg/status.d/
COPY --from=node-runtime-source /var/lib/dpkg/status.d/libc6* /var/lib/dpkg/status.d/
COPY --from=node-runtime-source /var/lib/dpkg/status.d/libgcc-s1* /var/lib/dpkg/status.d/
COPY --from=node-runtime-source /var/lib/dpkg/status.d/libstdc++6* /var/lib/dpkg/status.d/
COPY --from=node-runtime-source /var/lib/dpkg/status.d/tzdata* /var/lib/dpkg/status.d/
COPY --from=node-runtime-source --chmod=1777 /tmp /tmp

FROM node-runtime AS runtime
ARG KALA_VERSION
ARG KALA_REVISION
ARG KALA_SOURCE
ARG KALA_CREATED
ARG KALA_ASSET_SHA256
LABEL org.opencontainers.image.title="Kala Portable" \
      org.opencontainers.image.description="Kala Portable runtime with embedded Dashboard" \
      org.opencontainers.image.version="${KALA_VERSION}" \
      org.opencontainers.image.revision="${KALA_REVISION}" \
      org.opencontainers.image.source="${KALA_SOURCE}" \
      org.opencontainers.image.created="${KALA_CREATED}" \
      io.kala.distribution="portable" \
      io.kala.portable.asset.sha256="${KALA_ASSET_SHA256}" \
      io.kala.portable.runtime.source="gcr.io/distroless/nodejs22-debian13@sha256:5e72a679e328276f6ffc3c4bb45c94f847f6abf0b424a1f8cc984f7f1c1daf47"
ENV NODE_ENV=production \
    PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    HOME=/var/lib/kala \
    KALA_BIND_HOST=0.0.0.0 \
    KALA_PORT=3000 \
    KALA_SESSIONS_DIR=/var/lib/kala/sessions \
    KALA_ARTIFACTS_DIR=/var/lib/kala/artifacts \
    KALA_AUDIT_DIR=/var/lib/kala/audit
WORKDIR /opt/kala
COPY --from=verify --chown=65532:65532 /opt/kala/kala-dashboard-with-runtime.cjs ./kala-dashboard-with-runtime.cjs
COPY --from=verify --chown=65532:65532 /var/lib/kala/ /var/lib/kala/
USER 65532:65532
VOLUME ["/var/lib/kala"]
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/runtime/capabilities').then(r=>{if(!r.ok)throw Error(String(r.status))}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node", "/opt/kala/kala-dashboard-with-runtime.cjs"]
