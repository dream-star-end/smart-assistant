#!/usr/bin/env bash
# Activate a completely staged H3 worker release. Runtime jobs remain in the
# shared H3_WORKER_STATE directory and are never copied between releases.
set -euo pipefail

ROOT=${H3_WORKER_RELEASE_ROOT:-/opt/openclaude-h3-worker}
STATE_ROOT=${H3_WORKER_STATE:-/root/private_data/openclaude-h3-worker}
SERVICE=${H3_WORKER_SERVICE:-openclaude-h3-worker.service}
SYSTEMCTL=${H3_WORKER_SYSTEMCTL:-systemctl}
HEALTH_URL=${H3_WORKER_HEALTH_URL:-http://127.0.0.1:8390/v1/health}
ENV_FILE=${H3_WORKER_ENV_FILE:-/root/.secrets/openclaude-h3-worker.env}
if [[ -z "${H3_WORKER_TOKEN:-}" && -r "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
: "${H3_WORKER_TOKEN:?H3_WORKER_TOKEN is required}"
mkdir -p "$ROOT/releases" "$ROOT/manifests" "$ROOT/backups"
exec 9>"$ROOT/activate.lock"
flock -x 9

current() { [[ -L "$ROOT/current" ]] && readlink -f "$ROOT/current" || true; }
previous() { [[ -L "$ROOT/previous" ]] && readlink -f "$ROOT/previous" || true; }
write_state() {
  local action=$1 backup=${2:-} tmp="$ROOT/activation-state.json.tmp"
  CURRENT="$(current)" PREVIOUS="$(previous)" ACTION="$action" STATE_ROOT="$STATE_ROOT" BACKUP="$backup" \
    python3 - "$tmp" <<'PY'
import json, os, sys, time
with open(sys.argv[1], "w", encoding="utf-8") as out:
    json.dump({"version": 1, "action": os.environ["ACTION"],
               "current": os.environ["CURRENT"], "previous": os.environ["PREVIOUS"],
               "shared_state": os.environ["STATE_ROOT"],
               "db_backup": os.environ["BACKUP"] or None,
               "updated_at": time.time()}, out)
    out.write("\n")
PY
  mv -Tf "$tmp" "$ROOT/activation-state.json"
}
status() {
  CURRENT="$(current)" PREVIOUS="$(previous)" STATE="$ROOT/activation-state.json" DB="$STATE_ROOT/worker.sqlite" \
    python3 - <<'PY'
import json, os
state = {}
try:
    with open(os.environ["STATE"], encoding="utf-8") as source: state = json.load(source)
except FileNotFoundError: pass
print(json.dumps({"current": os.environ["CURRENT"] or None,
                  "previous": os.environ["PREVIOUS"] or None,
                  "worker_db": os.environ["DB"], "state": state}))
PY
}

if [[ "${1:-}" == "--status" ]]; then status; exit 0; fi
if [[ "${1:-}" == "--rollback" ]]; then
  [[ -L "$ROOT/previous" ]] || { echo "no previous H3 worker release" >&2; exit 1; }
  target=$(previous)
  action=rollback
else
  [[ $# -eq 1 ]] || { echo "usage: $0 <release>|--rollback|--status" >&2; exit 2; }
  target=$(readlink -f "$ROOT/releases/$1")
  [[ "$target" == "$ROOT/releases/"* && -f "$target/scripts/minimax_h3_worker/worker.py" ]] || {
    echo "invalid H3 worker release" >&2; exit 1;
  }
  action=activate
fi

release_id=$(basename "$target")
manifest="$ROOT/manifests/$release_id.sha256"
[[ -s "$manifest" ]] || { echo "missing H3 worker release manifest: $manifest" >&2; exit 1; }
(cd "$target" && sha256sum -c "$manifest" >/dev/null) || {
  echo "H3 worker release manifest verification failed" >&2; exit 1;
}

db="$STATE_ROOT/worker.sqlite"
backup=""
compat="$ROOT/backups/.compat-${release_id}-$$.sqlite"
cleanup_compat() { rm -f "$compat" "$compat-wal" "$compat-shm"; }
cleanup_compat
trap cleanup_compat EXIT
if [[ -f "$db" ]]; then
  backup="$ROOT/backups/worker-$(date -u +%Y%m%dT%H%M%S-%N).sqlite"
  SOURCE_DB="$db" TARGET_DB="$backup" python3 - <<'PY'
import os, sqlite3
source = sqlite3.connect(f"file:{os.environ['SOURCE_DB']}?mode=ro", uri=True)
target = sqlite3.connect(os.environ["TARGET_DB"])
with target: source.backup(target)
target.close(); source.close()
PY
  BACKUP="$backup" python3 - <<'PY'
import os, sqlite3
db = sqlite3.connect(f"file:{os.environ['BACKUP']}?mode=ro", uri=True)
try:
    if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise SystemExit("H3 worker backup integrity check failed")
finally: db.close()
PY
  cp "$backup" "$compat"
fi
CANDIDATE="$target/scripts/minimax_h3_worker/worker.py" COMPAT_DB="$compat" PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'
import importlib.util, os, sqlite3
from pathlib import Path
spec = importlib.util.spec_from_file_location("h3_candidate_worker", os.environ["CANDIDATE"])
if spec is None or spec.loader is None: raise SystemExit("cannot load H3 candidate worker")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
store = module.Store(Path(os.environ["COMPAT_DB"]))
store.db.close()
db = sqlite3.connect(f"file:{os.environ['COMPAT_DB']}?mode=ro", uri=True)
try:
    if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise SystemExit("H3 candidate database compatibility check failed")
finally: db.close()
PY
cleanup_compat
trap - EXIT

old=$(current)
old_previous=$(previous)
if [[ -n "$old" ]]; then
  ln -sfn "$old" "$ROOT/previous.new"
  mv -Tf "$ROOT/previous.new" "$ROOT/previous"
fi
ln -sfn "$target" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"

wait_healthy_release() {
  local expected=$1 health actual
  for _ in $(seq 1 "${H3_WORKER_HEALTH_ATTEMPTS:-60}"); do
    if "$SYSTEMCTL" is-active --quiet "$SERVICE"; then
      health=$(curl --noproxy '*' -fsS -H "Authorization: Bearer $H3_WORKER_TOKEN" "$HEALTH_URL" || true)
      actual=$(HEALTH="$health" python3 - <<'PY'
import json, os
try: print(json.loads(os.environ["HEALTH"]).get("release", ""))
except Exception: print("")
PY
)
      [[ "$actual" == "$expected" ]] && return 0
    fi
    sleep 1
  done
  return 1
}

expected_release="$release_id"
if ! "$SYSTEMCTL" restart "$SERVICE" || ! wait_healthy_release "$expected_release"; then
  if [[ -n "$old" ]]; then
    ln -sfn "$old" "$ROOT/current.new"
    mv -Tf "$ROOT/current.new" "$ROOT/current"
    old_release=$(basename "$old")
    "$SYSTEMCTL" restart "$SERVICE" || true
    if ! wait_healthy_release "$old_release"; then
      echo "H3 worker activation failed; previous release did not recover" >&2
    fi
  fi
  if [[ -n "$old_previous" ]]; then
    ln -sfn "$old_previous" "$ROOT/previous.new"
    mv -Tf "$ROOT/previous.new" "$ROOT/previous"
  else
    rm -f "$ROOT/previous"
  fi
  write_state "${action}_reverted" "$backup"
  echo "H3 worker activation failed and previous release was restored" >&2
  exit 1
fi
write_state "$action" "$backup"
basename "$target"
