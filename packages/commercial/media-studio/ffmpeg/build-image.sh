#!/usr/bin/env bash
# Build the media studio compose sandbox image (OCV5-588) on the host that runs master.
#
#   packages/commercial/media-studio/ffmpeg/build-image.sh [tag]
#
# Prints the image ID (sha256:...) to put into OC_STUDIO_FFMPEG_IMAGE_ID. The master only trusts the
# image ID, never a tag. Nothing is pushed to any registry. Re-running with unchanged inputs reuses
# the existing image via the oc.build.input_digest label.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${1:-$(git -C "$HERE" rev-parse --short=12 HEAD)}"
BASE_IMAGE="${OC_STUDIO_FFMPEG_BASE_IMAGE:-debian:bookworm-slim}"
DIGEST="$( { cat "$HERE/Dockerfile"; printf '%s' "$BASE_IMAGE"; } | sha256sum | cut -c1-64)"
EXISTING="$(docker images --filter "label=oc.build.input_digest=$DIGEST" --format '{{.ID}}' | head -1 || true)"
if [ -n "$EXISTING" ] && [ "${OC_BUILD_FORCE:-0}" != "1" ]; then
  docker tag "$EXISTING" "openclaude/studio-ffmpeg:$TAG"
else
  docker build --pull --build-arg "BASE_IMAGE=$BASE_IMAGE" --label "oc.build.input_digest=$DIGEST" \
    -t "openclaude/studio-ffmpeg:$TAG" -f "$HERE/Dockerfile" "$HERE"
fi
ID="$(docker image inspect --format '{{.Id}}' "openclaude/studio-ffmpeg:$TAG")"
docker run --rm --network none --read-only --user 1000:1000 "$ID" ffmpeg -hide_banner -version | head -1 >&2
echo "openclaude/studio-ffmpeg:$TAG"
echo "OC_STUDIO_FFMPEG_IMAGE_ID=$ID"
