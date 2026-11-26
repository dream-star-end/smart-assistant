#!/usr/bin/env bash
# sync-referee.sh — Atomically sync verified $MASTER_LIVE_LINK gate scripts & baseline policies
# into a read-only Host Pinned Referee directory (/opt/openclaude/harness-gate/referee/)
# with cryptographic MANIFEST.json (sourceCommit + per-file SHA-256).
set -Eeuo pipefail

GOV_ROOT="${OC_GOVERNOR_ROOT:-/opt/openclaude/harness-gate}"
REFEREE_DEST="${OC_V5_REFEREE_ROOT:-${GOV_ROOT}/referee}"
LIVE_LINK="${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}"
LOCK_READONLY=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --live-link) LIVE_LINK="${2:-}"; shift 2 ;;
    --dest) REFEREE_DEST="${2:-}"; shift 2 ;;
    --no-readonly) LOCK_READONLY=0; shift ;;
    -h|--help)
      echo "Usage: sync-referee.sh [--live-link PATH] [--dest DIR] [--no-readonly]"
      exit 0
      ;;
    *)
      echo "✗ [sync-referee] unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

die() {
  echo "✗ [sync-referee] $*" >&2
  exit 1
}

[[ -e "$LIVE_LINK" ]] || die "MASTER_LIVE_LINK does not exist: $LIVE_LINK"
RESOLVED_LIVE="$(readlink -f -- "$LIVE_LINK" 2>/dev/null || true)"
[[ -n "$RESOLVED_LIVE" && -d "$RESOLVED_LIVE" ]] || die "cannot resolve live directory from $LIVE_LINK"
[[ -f "$RESOLVED_LIVE/.complete" ]] || die "verified .complete marker missing in $RESOLVED_LIVE"

SOURCE_COMMIT="$(python3 - "$RESOLVED_LIVE/.complete" <<'PY'
import json, re, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
sha = str(doc.get("sourceCommit") or "").strip()
if not re.fullmatch(r"[0-9a-f]{40}", sha):
    sys.exit(1)
print(sha)
PY
)" || die "invalid or missing 40-hex sourceCommit in $RESOLVED_LIVE/.complete"

PARENT_DIR="$(dirname "$REFEREE_DEST")"
mkdir -p "$PARENT_DIR"
STAGING_DIR="$(mktemp -d "${PARENT_DIR}/.referee-staging.$$.XXXXXX")"

cleanup_staging() {
  if [[ -n "${STAGING_DIR:-}" && -d "$STAGING_DIR" ]]; then
    chmod -R u+w "$STAGING_DIR" 2>/dev/null || true
    rm -rf "$STAGING_DIR"
  fi
}
trap cleanup_staging EXIT

copy_rel_path() {
  local rel="$1"
  local src="$RESOLVED_LIVE/$rel"
  [[ -e "$src" ]] || return 0
  local dst="$STAGING_DIR/$rel"
  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst"
}

# 1. Gate scripts & shared shell/TS libraries
if [[ -d "$RESOLVED_LIVE/scripts" ]]; then
  mkdir -p "$STAGING_DIR/scripts"
  for f in "$RESOLVED_LIVE"/scripts/check-*.ts "$RESOLVED_LIVE"/scripts/check-*.sh; do
    [[ -f "$f" ]] || continue
    cp -a "$f" "$STAGING_DIR/scripts/"
  done
  copy_rel_path "scripts/lib"
fi

# 2. Package-level lint/gate scripts & protocol model definitions imported by check-*.ts
copy_rel_path "packages/commercial/scripts"
copy_rel_path "packages/protocol/src"
copy_rel_path "packages/protocol/package.json"

# 3. Architecture map, monotonic baselines, CODEOWNERS, and incident ledgers
copy_rel_path "arch"
copy_rel_path "deploy/v5"
copy_rel_path "biome.json"
copy_rel_path "package.json"
copy_rel_path "tsconfig.json"

for gh_rel in \
  ".github/CODEOWNERS" \
  ".github/file-size-baseline.json" \
  ".github/file-size-ratchet-exceptions.json" \
  ".github/context-eval-baseline.json" \
  ".github/integ-tiers" \
  ".github/known-failures" \
  "e2e/session-display/incidents.json" \
  "e2e/session-display/incident-waivers.json" \
  "e2e/session-display/incident-trailer-enforced-from"; do
  copy_rel_path "$gh_rel"
done

# 4. Generate deterministic MANIFEST.json with SHA-256 of every synced file
MANIFEST_SUMMARY="$(python3 - "$STAGING_DIR" "$SOURCE_COMMIT" "$RESOLVED_LIVE" <<'PY'
import datetime as dt, hashlib, json, pathlib, sys

staging = pathlib.Path(sys.argv[1])
source_commit = sys.argv[2]
resolved_live = sys.argv[3]

files_map: dict[str, str] = {}
for p in sorted(staging.rglob("*")):
    if not p.is_file() or p.is_symlink():
        continue
    rel = p.relative_to(staging).as_posix()
    if rel == "MANIFEST.json":
        continue
    h = hashlib.sha256(p.read_bytes()).hexdigest()
    files_map[rel] = h

if not files_map:
    raise SystemExit("referee sync staged 0 files — refusing empty referee")

manifest = {
    "schemaVersion": 1,
    "sourceCommit": source_commit,
    "sourceRelease": resolved_live,
    "syncedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "fileCount": len(files_map),
    "files": files_map,
}
(staging / "MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"ok": True, "sourceCommit": source_commit, "fileCount": len(files_map)}))
PY
)" || die "failed to write MANIFEST.json (or 0 files staged)"

if [[ "$(id -u)" == "0" && "${OC_INSTALL_SKIP_CHOWN:-0}" != "1" ]]; then
  chown -R root:root "$STAGING_DIR"
fi

if [[ "$LOCK_READONLY" == "1" ]]; then
  # Directories 0555, executable .sh 0555, all other files 0444 (strictly read-only!)
  find "$STAGING_DIR" -type f -name '*.sh' -exec chmod 0555 {} +
  find "$STAGING_DIR" -type f ! -name '*.sh' -exec chmod 0444 {} +
  find "$STAGING_DIR" -type d -exec chmod 0555 {} +
fi

OLD_BACKUP=""
if [[ -e "$REFEREE_DEST" || -L "$REFEREE_DEST" ]]; then
  OLD_BACKUP="${PARENT_DIR}/.referee-prev.$$.${RANDOM}"
  mv "$REFEREE_DEST" "$OLD_BACKUP"
fi

if ! mv "$STAGING_DIR" "$REFEREE_DEST"; then
  if [[ -n "$OLD_BACKUP" && -e "$OLD_BACKUP" ]]; then
    mv "$OLD_BACKUP" "$REFEREE_DEST" 2>/dev/null || true
  fi
  die "atomic swap into $REFEREE_DEST failed"
fi
STAGING_DIR=""

if [[ -n "$OLD_BACKUP" && -e "$OLD_BACKUP" ]]; then
  chmod -R u+w "$OLD_BACKUP" 2>/dev/null || true
  rm -rf "$OLD_BACKUP"
fi

printf '%s\n' "$MANIFEST_SUMMARY"
