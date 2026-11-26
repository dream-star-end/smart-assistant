#!/usr/bin/env bash
# sync-referee.sh — Atomically sync verified $MASTER_LIVE_LINK (or root-audited transition
# candidate for B1 schema/policy rollout) into a read-only Host Pinned Referee directory
# (/opt/openclaude/harness-gate/referee/) with cryptographic MANIFEST.json (per-file SHA-256).
#
# Modes:
#   1. Normal live sync (default):
#      sync-referee.sh [--live-link PATH] [--dest DIR] [--node-modules-from DIR] [--no-readonly]
#   2. Root-exclusive audited transition referee (B1):
#      sync-referee.sh --stage-audited <src_dir> --target-sha <40hex> --approval-file <a0_approval_json>
#        [--dest DIR] [--node-modules-from DIR] [--copy-node-modules] [--hmac-key-file PATH]
#        [--no-readonly] [--unsafe-test-skip-owner]
set -Eeuo pipefail

GOV_ROOT="${OC_GOVERNOR_ROOT:-/opt/openclaude/harness-gate}"
REFEREE_DEST="${OC_V5_REFEREE_ROOT:-${GOV_ROOT}/referee}"
LIVE_LINK="${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}"
LOCK_READONLY=1
STAGE_AUDITED_SRC=""
TARGET_SHA=""
APPROVAL_FILE=""
NODE_MODULES_FROM=""
COPY_NODE_MODULES=0
HMAC_KEY_FILE=""
REQUIRE_ROOT_OWNER=1
[[ "${OC_INSTALL_SKIP_CHOWN:-0}" == "1" || "${OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER:-0}" == "1" ]] && REQUIRE_ROOT_OWNER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --live-link) LIVE_LINK="${2:-}"; shift 2 ;;
    --dest) REFEREE_DEST="${2:-}"; shift 2 ;;
    --stage-audited) STAGE_AUDITED_SRC="${2:-}"; shift 2 ;;
    --target-sha) TARGET_SHA="${2:-}"; shift 2 ;;
    --approval-file) APPROVAL_FILE="${2:-}"; shift 2 ;;
    --node-modules-from) NODE_MODULES_FROM="${2:-}"; shift 2 ;;
    --copy-node-modules) COPY_NODE_MODULES=1; shift ;;
    --hmac-key-file) HMAC_KEY_FILE="${2:-}"; shift 2 ;;
    --no-readonly) LOCK_READONLY=0; shift ;;
    --unsafe-test-skip-owner) REQUIRE_ROOT_OWNER=0; shift ;;
    -h|--help)
      cat <<'EOF'
Usage:
  sync-referee.sh [--live-link PATH] [--dest DIR] [--node-modules-from DIR] [--no-readonly]
  sync-referee.sh --stage-audited <src_dir> --target-sha <40hex> --approval-file <a0_approval_json>
                  [--dest DIR] [--node-modules-from DIR] [--copy-node-modules]
                  [--hmac-key-file PATH] [--no-readonly] [--unsafe-test-skip-owner]
EOF
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

now_iso() {
  if [[ -n "${OC_GOVERNOR_NOW_ISO:-}" ]]; then printf '%s\n' "$OC_GOVERNOR_NOW_ISO"
  else date -u +%Y-%m-%dT%H:%M:%SZ; fi
}

MODE="live-sync"
SOURCE_DIR=""
SOURCE_COMMIT=""
APPROVAL_META_JSON=""

if [[ -n "$STAGE_AUDITED_SRC" ]]; then
  MODE="transition-audited"
  if [[ "$(id -u)" != "0" && "$REQUIRE_ROOT_OWNER" == "1" ]]; then
    die "--stage-audited requires root privileges (uid=0)"
  fi
  [[ -d "$STAGE_AUDITED_SRC" ]] || die "--stage-audited source directory does not exist: $STAGE_AUDITED_SRC"
  [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--stage-audited requires --target-sha <40-char lowercase hex>"
  [[ -n "$APPROVAL_FILE" ]] || die "--stage-audited requires --approval-file <a0_approval_json>"

  SOURCE_DIR="$(readlink -f -- "$STAGE_AUDITED_SRC" 2>/dev/null || true)"
  [[ -n "$SOURCE_DIR" && -d "$SOURCE_DIR/scripts" ]] || die "--stage-audited source missing scripts/: $STAGE_AUDITED_SRC"
  SOURCE_COMMIT="$TARGET_SHA"

  if [[ -z "$HMAC_KEY_FILE" ]]; then
    HMAC_KEY_FILE="$(dirname "$(dirname "$APPROVAL_FILE")")/.hmac-key"
    if [[ ! -e "$HMAC_KEY_FILE" && -e "$GOV_ROOT/control/.hmac-key" ]]; then
      HMAC_KEY_FILE="$GOV_ROOT/control/.hmac-key"
    fi
  fi

  # Cryptographically verify A0 approval file bound to exact --target-sha (byte-level parity with oc-governor / a0ApprovalReceipt.ts)
  APPROVAL_META_JSON="$(python3 - "$APPROVAL_FILE" "$TARGET_SHA" "$(now_iso)" "$REQUIRE_ROOT_OWNER" "$HMAC_KEY_FILE" <<'PY'
import datetime as dt, hashlib, hmac, json, os, re, stat, sys

path, want_sha, now_iso, req_root_s, hmac_key_file = sys.argv[1:]
req_root = req_root_s == "1"
SHA64_RE = re.compile(r"^[0-9a-f]{64}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$")

def fail(msg: str):
    sys.stderr.write(f"approval verification failed: {msg}\n")
    sys.exit(1)

try:
    st = os.lstat(path)
except OSError:
    fail(f"approval file not found: {path}")

if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
    fail("approval file must be a regular file (no symlinks)")
if (st.st_mode & 0o022) != 0:
    fail("approval file must not be group/world writable")
if req_root and st.st_uid != 0:
    fail(f"approval file must be owned by root (uid=0, got uid={st.st_uid})")

raw_bytes = open(path, "rb").read()
file_sha256 = hashlib.sha256(raw_bytes).hexdigest()
try:
    doc = json.loads(raw_bytes.decode("utf-8"))
except Exception as e:
    fail(f"invalid JSON: {e}")

if not isinstance(doc, dict) or type(doc.get("schemaVersion")) is not int or doc.get("schemaVersion") != 1:
    fail("approval must be a JSON object with schemaVersion=1")
if doc.get("sha") != want_sha:
    fail(f"approval sha mismatch (expected {want_sha}, got {doc.get('sha')!r})")

raw_reason = doc.get("reason")
if not isinstance(raw_reason, str) or "\r" in raw_reason or "\n" in raw_reason or len(raw_reason.strip()) < 8:
    fail("approval reason must be a single-line string of >= 8 chars after trimming")
trimmed_reason = raw_reason.strip()

issued, expires = doc.get("issuedAt"), doc.get("expiresAt")
if not isinstance(issued, str) or not isinstance(expires, str) or not ISO_RE.fullmatch(issued) or not ISO_RE.fullmatch(expires):
    fail("approval issuedAt/expiresAt must be valid ISO-8601 timestamps")
issued_dt = dt.datetime.fromisoformat(issued.replace("Z", "+00:00"))
expires_dt = dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
now_dt = dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
if expires_dt <= issued_dt:
    fail("approval expiresAt must be after issuedAt")
if now_dt >= expires_dt:
    fail(f"approval expired at {expires}")

allowed_paths = None
if "allowedPaths" in doc and doc["allowedPaths"] is not None:
    rp = doc["allowedPaths"]
    if not isinstance(rp, list) or len(rp) == 0 or any(not isinstance(x, str) or "\r" in x or "\n" in x or not x.strip() for x in rp):
        fail("approval allowedPaths must be a non-empty array of single-line strings")
    allowed_paths = sorted(set(x.strip() for x in rp))

paths_canonical = "*" if allowed_paths is None else json.dumps(allowed_paths, separators=(",", ":"), ensure_ascii=False)
canonical = (
    f"a0-approval-v1\nsha={want_sha}\nissuedAt={issued}\nexpiresAt={expires}\n"
    f"reason={trimmed_reason}\nallowedPaths={paths_canonical}\n"
)
sig = doc.get("sha256")
if not isinstance(sig, str) or not SHA64_RE.fullmatch(sig):
    fail("missing valid 64-hex sha256")
expected_sha = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
if not hmac.compare_digest(sig, expected_sha):
    fail("approval sha256 digest verification failed (tampered)")

hmac_key = None
if hmac_key_file and os.path.lexists(hmac_key_file):
    kst = os.lstat(hmac_key_file)
    if stat.S_ISLNK(kst.st_mode) or not stat.S_ISREG(kst.st_mode):
        fail("HMAC key file must be a regular file (no symlinks)")
    if (kst.st_mode & 0o077) != 0:
        fail("HMAC key file must be mode 0600/0400")
    if req_root and kst.st_uid != 0:
        fail("HMAC key file must be owned by root")
    hmac_key = open(hmac_key_file, encoding="utf-8").read().strip()
    if not hmac_key:
        fail("HMAC key file is empty")

hmac_field = doc.get("hmacSha256")
if hmac_key is not None:
    if not isinstance(hmac_field, str) or not SHA64_RE.fullmatch(hmac_field):
        fail("HMAC key active; receipt missing hmacSha256 (downgrade rejected)")
    expected_hmac = hmac.new(hmac_key.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(hmac_field, expected_hmac):
        fail("approval hmacSha256 verification failed")
elif hmac_field is not None:
    fail("approval carries hmacSha256 without active .hmac-key")

summary = {
    "approvalFile": os.path.realpath(path),
    "approvalSha256": file_sha256,
    "approval": {
        "schemaVersion": 1,
        "sha": want_sha,
        "reason": trimmed_reason,
        "approvedBy": doc.get("approvedBy"),
        "issuedAt": issued,
        "expiresAt": expires,
        "sha256": sig,
        **({"hmacSha256": hmac_field} if hmac_field is not None else {}),
        **({"allowedPaths": allowed_paths} if allowed_paths is not None else {}),
    },
}
print(json.dumps(summary, ensure_ascii=False))
PY
)" || die "invalid or untrusted --approval-file for targetSha $TARGET_SHA"
else
  [[ -e "$LIVE_LINK" ]] || die "MASTER_LIVE_LINK does not exist: $LIVE_LINK"
  SOURCE_DIR="$(readlink -f -- "$LIVE_LINK" 2>/dev/null || true)"
  [[ -n "$SOURCE_DIR" && -d "$SOURCE_DIR" ]] || die "cannot resolve live directory from $LIVE_LINK"
  [[ -f "$SOURCE_DIR/.complete" ]] || die "verified .complete marker missing in $SOURCE_DIR"

  SOURCE_COMMIT="$(python3 - "$SOURCE_DIR/.complete" <<'PY'
import json, re, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
sha = str(doc.get("sourceCommit") or "").strip()
if not re.fullmatch(r"[0-9a-f]{40}", sha):
    sys.exit(1)
print(sha)
PY
)" || die "invalid or missing 40-hex sourceCommit in $SOURCE_DIR/.complete"
fi

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
  local src="$SOURCE_DIR/$rel"
  [[ -e "$src" ]] || return 0
  local dst="$STAGING_DIR/$rel"
  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst"
}

# 1. Gate scripts & shared shell/TS libraries
if [[ -d "$SOURCE_DIR/scripts" ]]; then
  mkdir -p "$STAGING_DIR/scripts"
  for f in "$SOURCE_DIR"/scripts/check-*.ts "$SOURCE_DIR"/scripts/check-*.sh; do
    [[ -f "$f" ]] || continue
    cp -a "$f" "$STAGING_DIR/scripts/"
  done
  copy_rel_path "scripts/lib"
fi

# 2. Package-level lint/gate scripts, .github/scripts helpers, & protocol definitions imported by gates
copy_rel_path "packages/commercial/scripts"
copy_rel_path "packages/protocol/src"
copy_rel_path "packages/protocol/package.json"
copy_rel_path ".github/scripts"

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

# 4. Wire trusted node_modules so external referee executes with pinned runtime dependencies (B4)
RESOLVED_NM=""
if [[ -n "$NODE_MODULES_FROM" ]]; then
  if [[ -d "$NODE_MODULES_FROM/node_modules" ]]; then
    RESOLVED_NM="$(readlink -f -- "$NODE_MODULES_FROM/node_modules" 2>/dev/null || true)"
  elif [[ -d "$NODE_MODULES_FROM" && "$(basename "$NODE_MODULES_FROM")" == "node_modules" ]]; then
    RESOLVED_NM="$(readlink -f -- "$NODE_MODULES_FROM" 2>/dev/null || true)"
  else
    die "--node-modules-from does not contain node_modules: $NODE_MODULES_FROM"
  fi
elif [[ "$MODE" == "live-sync" && -d "$SOURCE_DIR/node_modules" ]]; then
  RESOLVED_NM="$(readlink -f -- "$SOURCE_DIR/node_modules" 2>/dev/null || true)"
elif [[ "$MODE" == "transition-audited" && -e "$LIVE_LINK" ]]; then
  live_resolved="$(readlink -f -- "$LIVE_LINK" 2>/dev/null || true)"
  if [[ -n "$live_resolved" && -f "$live_resolved/.complete" && -d "$live_resolved/node_modules" ]]; then
    RESOLVED_NM="$(readlink -f -- "$live_resolved/node_modules" 2>/dev/null || true)"
  fi
elif [[ "$MODE" == "transition-audited" && "$COPY_NODE_MODULES" == "1" && -d "$SOURCE_DIR/node_modules" ]]; then
  RESOLVED_NM="$(readlink -f -- "$SOURCE_DIR/node_modules" 2>/dev/null || true)"
fi

if [[ -n "$RESOLVED_NM" && -d "$RESOLVED_NM" ]]; then
  if [[ "$COPY_NODE_MODULES" == "1" ]]; then
    cp -a "$RESOLVED_NM" "$STAGING_DIR/node_modules"
  else
    ln -sfn "$RESOLVED_NM" "$STAGING_DIR/node_modules"
  fi
fi

# 5. In transition-audited mode, write TRANSITION_APPROVAL.json bound to exact targetSha
if [[ "$MODE" == "transition-audited" ]]; then
  ACTOR="$(id -un 2>/dev/null || echo unknown)"
  python3 - "$STAGING_DIR/TRANSITION_APPROVAL.json" "$TARGET_SHA" "$SOURCE_DIR" "$ACTOR" "$(now_iso)" "$APPROVAL_META_JSON" <<'PY'
import json, pathlib, sys
out_path, target_sha, source_dir, actor, staged_at, meta_raw = sys.argv[1:]
meta = json.loads(meta_raw)
doc = {
    "schemaVersion": 1,
    "mode": "transition-audited",
    "targetSha": target_sha,
    "stagedAt": staged_at,
    "stagedBy": actor,
    "sourceDir": source_dir,
    "approvalFile": meta["approvalFile"],
    "approvalSha256": meta["approvalSha256"],
    "approval": meta["approval"],
}
pathlib.Path(out_path).write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
fi

# 6. Generate deterministic MANIFEST.json with SHA-256 of every synced file (skipping node_modules/)
MANIFEST_SUMMARY="$(python3 - "$STAGING_DIR" "$SOURCE_COMMIT" "$SOURCE_DIR" "$MODE" "$TARGET_SHA" <<'PY'
import datetime as dt, hashlib, json, os, pathlib, sys

staging = pathlib.Path(sys.argv[1])
source_commit = sys.argv[2]
source_dir = sys.argv[3]
mode = sys.argv[4]
target_sha = sys.argv[5]

files_map: dict[str, str] = {}
for root_str, dirs, files in os.walk(staging, followlinks=False):
    dirs[:] = sorted(d for d in dirs if d != "node_modules")
    for fname in sorted(files):
        p = pathlib.Path(root_str) / fname
        if p.is_symlink() or not p.is_file():
            continue
        rel = p.relative_to(staging).as_posix()
        if rel == "MANIFEST.json":
            continue
        files_map[rel] = hashlib.sha256(p.read_bytes()).hexdigest()

if not files_map:
    raise SystemExit("referee sync staged 0 files — refusing empty referee")

manifest = {
    "schemaVersion": 1,
    "mode": mode,
    "sourceCommit": source_commit,
    "sourceRelease": source_dir,
    **({"targetSha": target_sha} if mode == "transition-audited" else {}),
    "syncedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "fileCount": len(files_map),
    "files": files_map,
}
(staging / "MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({
    "ok": True,
    "mode": mode,
    "sourceCommit": source_commit,
    **({"targetSha": target_sha} if mode == "transition-audited" else {}),
    "fileCount": len(files_map),
}))
PY
)" || die "failed to write MANIFEST.json (or 0 files staged)"

if [[ "$(id -u)" == "0" && "${OC_INSTALL_SKIP_CHOWN:-0}" != "1" ]]; then
  chown -R -h root:root "$STAGING_DIR"
fi

if [[ "$LOCK_READONLY" == "1" ]]; then
  # Lock copied referee files/dirs read-only (0555 dirs & .sh, 0444 other files); do not mutate node_modules/symlink targets!
  find "$STAGING_DIR" -path "$STAGING_DIR/node_modules" -prune -o -type f -name '*.sh' -exec chmod 0555 {} +
  find "$STAGING_DIR" -path "$STAGING_DIR/node_modules" -prune -o -type f ! -name '*.sh' -exec chmod 0444 {} +
  find "$STAGING_DIR" -path "$STAGING_DIR/node_modules" -prune -o -type d -exec chmod 0555 {} +
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
  find "$OLD_BACKUP" -path "$OLD_BACKUP/node_modules" -prune -o -exec chmod u+w {} + 2>/dev/null || true
  rm -rf "$OLD_BACKUP"
fi

printf '%s\n' "$MANIFEST_SUMMARY"
