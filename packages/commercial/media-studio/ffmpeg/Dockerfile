# Media studio compose sandbox image (OCV5-588).
# ffmpeg + ffprobe + CJK/emoji fonts for burned-in Chinese subtitles. Runs as uid 1000,
# read-only rootfs, no network (enforced by the master's runner, not by this file).
# Production builds pass a digest-pinned base via OC_STUDIO_FFMPEG_BASE_IMAGE=debian@sha256:...;
# build-image.sh prints the resulting image ID for OC_STUDIO_FFMPEG_IMAGE_ID (the master trusts only that ID).
ARG BASE_IMAGE=debian:bookworm-slim
FROM ${BASE_IMAGE}
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-noto-cjk fonts-noto-color-emoji ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd -g 1000 media; useradd -u 1000 -g 1000 -M -d /tmp -s /usr/sbin/nologin media; \
    mkdir -p /work/in /work/out; \
    fc-cache -f; \
    ffmpeg -hide_banner -filters > /tmp/filters 2>/dev/null; \
    for f in subtitles loudnorm sidechaincompress xfade tile amix adelay afade; do grep -qE " $f " /tmp/filters; done; \
    rm -f /tmp/filters
USER 1000:1000
WORKDIR /work
ENTRYPOINT []
CMD ["ffmpeg", "-version"]
