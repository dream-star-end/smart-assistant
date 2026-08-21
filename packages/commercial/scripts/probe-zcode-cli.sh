#!/bin/sh
# Reusable probe for the experimental community ZCode CLI 0.16.3.
# Never logs in. Never prints env or credential values.
set -eu

OUT_DIR=${1:-/tmp/zcode-cli-probe}
mkdir -p "$OUT_DIR"
echo "probe-zcode-cli: writing sanitized fixtures under $OUT_DIR" >&2

echo "== npm registry (expect stub / ETARGET for 0.16.3) ==" >&2
if command -v npm >/dev/null 2>&1; then
  npm view zcode-cli versions --json > "$OUT_DIR/npm-zcode-cli-versions.json" 2>"$OUT_DIR/npm-zcode-cli.err" || true
  npm view zcode version --json > "$OUT_DIR/npm-zcode-version.json" 2>"$OUT_DIR/npm-zcode.err" || true
else
  echo "npm not available" > "$OUT_DIR/npm-skipped.txt"
fi

APP_VERSION=3.8.1
APP_SHA=b420dea50961b77d5c75b08b924da41ab529c720a7ec32eacbe95a6d843199e0
APP_URL="https://cdn-zcode.z.ai/zcode/electron/releases/${APP_VERSION}/linux-x64/ZCode-${APP_VERSION}-linux-x64.AppImage"
archive="$OUT_DIR/ZCode-${APP_VERSION}-linux-x64.AppImage"

echo "== AppImage ${APP_VERSION} (community-verified pairing with CLI 0.16.3) ==" >&2
if [ ! -f "$archive" ]; then
  curl -fsSL --retry 2 --retry-all-errors -o "$archive" "$APP_URL"
fi
echo "${APP_SHA}  ${archive}" | sha256sum -c -
chmod 0755 "$archive"

# First hsqs offset is a false positive on 3.8.1. Use AppImage extract.
(cd "$OUT_DIR" && "$archive" --appimage-extract)
cjs=$(find "$OUT_DIR/squashfs-root" -name zcode.cjs -type f | head -1)
test -n "$cjs"
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

test "$(tr -d '[:space:]' < "$OUT_DIR/version.txt")" = "0.16.3"

# Redact any accidental secret-shaped values from captured text.
for f in "$OUT_DIR"/*.txt "$OUT_DIR"/*.err "$OUT_DIR"/*.stdout "$OUT_DIR"/*.stderr "$OUT_DIR"/*.json; do
  [ -f "$f" ] || continue
  sed -i -E \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<redacted-email>/g' \
    -e 's/(api[_-]?key["=: ]+)[^[:space:]"]+/\1<redacted>/Ig' \
    "$f"
done

echo "probe-zcode-cli: done. Inspect $OUT_DIR/version.txt and $OUT_DIR/help.txt" >&2
