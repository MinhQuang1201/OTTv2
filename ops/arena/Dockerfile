# OCI Container Image for OTTv2 Arena Untrusted Bot Build & Execution
# Base: Alpine 3.21.3 pinned
FROM alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c

# Install scoped runtimes: Python 3 and Node.js with exact pinned apk versions
RUN apk add --no-cache python3=3.12.15-r0 nodejs=22.23.2-r0

# Create non-root unprivileged sandbox user and group (uid 10001, gid 10001)
RUN addgroup -g 10001 -S sandbox && \
    adduser -u 10001 -S sandbox -G sandbox -h /tmp/scratch -s /sbin/nologin

# Create bot mountpoint and scratch workspace directory
RUN mkdir -p /bot /tmp/scratch && \
    chown -R sandbox:sandbox /tmp/scratch

USER 10001:10001
WORKDIR /tmp/scratch

CMD ["node", "--version"]
