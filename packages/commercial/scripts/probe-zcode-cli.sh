#!/bin/sh
# Reusable probe for the experimental community ZCode CLI 0.15.0.
# Never logs in. Never prints env or credential values.
set -eu

OUT_DIR=${1:-/tmp/zcode-cli-probe}
mkdir -p "$OUT_DIR"
echo "probe-zcode-cli: writing sanitized fixtures under $OUT_DIR" >&2

echo "== npm registry (expect stub / ETARGET for 0.15.0) ==" >&2
if command -v npm >/dev/null 2>&1; then
  npm view zcode-cli versions --json > "$OUT_DIR/npm-zcode-cli-versions.json" 2>"$OUT_DIR/npm-zcode-cli.err" || true
  npm view zcode version --json > "$OUT_DIR/npm-zcode-version.json" 2>"$OUT_DIR/npm-zcode.err" || true
else
  echo "npm not available" > "$OUT_DIR/npm-skipped.txt"
fi

APP_VERSION=3.2.2
APP_SHA=40bf72d8a086b4dddf1d9d0866001a6a0f547f84475c4d05ac58be3a177c0b3d
APP_URL="https://cdn-zcode.z.ai/zcode/electron/releases/${APP_VERSION}/ZCode-${APP_VERSION}-linux-x64.AppImage"
archive="$OUT_DIR/ZCode-${APP_VERSION}-linux-x64.AppImage"

echo "== AppImage ${APP_VERSION} (community-verified pairing with CLI 0.15.0) ==" >&2
if [ ! -f "$archive" ]; then
  curl -fsSL --retry 2 --retry-all-errors -o "$archive" "$APP_URL"
fi
echo "${APP_SHA}  ${archive}" | sha256sum -c -

offset=$(LC_ALL=C grep -aobm1 "$(printf '\x68\x73\x71\x73')" "$archive" | head -1 | cut -d: -f1)
test -n "$offset"
if command -v unsquashfs >/dev/null 2>&1; then
  unsquashfs -o "$offset" -d "$OUT_DIR/squashfs-root" "$archive" resources/glm/zcode.cjs
else
  echo "unsquashfs missing; cannot extract zcode.cjs" >&2
  exit 2
fi

cjs="$OUT_DIR/squashfs-root/resources/glm/zcode.cjs"
test -f "$cjs"
PROBE_HOME="$OUT_DIR/isolated-home"
mkdir -p "$PROBE_HOME"
# Isolated, no credentials. Capture version/help/doctor only.
set +e
HOME="$PROBE_HOME" node "$cjs" --version > "$OUT_DIR/version.txt" 2>"$OUT_DIR/version.err"
HOME="$PROBE_HOME" node "$cjs" --help > "$OUT_DIR/help.txt" 2>"$OUT_DIR/help.err"
HOME="$PROBE_HOME" node "$cjs" doctor --json > "$OUT_DIR/doctor.json" 2>"$OUT_DIR/doctor.err"
HOME="$PROBE_HOME" node "$cjs" --prompt ping --json --mode yolo --no-color --cwd "$OUT_DIR" \
  > "$OUT_DIR/prompt-no-config.stdout" 2>"$OUT_DIR/prompt-no-config.stderr"
set -e

# Redact any accidental secret-shaped values from captured text.
for f in "$OUT_DIR"/*.txt "$OUT_DIR"/*.err "$OUT_DIR"/*.stdout "$OUT_DIR"/*.stderr "$OUT_DIR"/*.json; do
  [ -f "$f" ] || continue
  sed -i -E \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<redacted-email>/g' \
    -e 's/(api[_-]?key["=: ]+)[^[:space:]"]+/\1<redacted>/Ig' \
    "$f"
done

echo "probe-zcode-cli: done. Inspect $OUT_DIR/version.txt and $OUT_DIR/help.txt" >&2
