#!/bin/bash
# Run on SCNet after a release directory has been copied completely.
# Usage: activate-release.sh <release>; rollback with --rollback; inspect with --status.
set -euo pipefail
ROOT=${OC_OCR_RELEASE_ROOT:-/opt/openclaude-ocr-worker}
STATE_ROOT=${OC_OCR_STATE_ROOT:-/root/private_data/openclaude-ocr-worker}
HEALTH_URL=${OC_OCR_HEALTH_URL:-http://127.0.0.1:18960/ready}
ENV_FILE=${OC_OCR_WORKER_ENV_FILE:-/root/.secrets/openclaude-ocr-worker.env}
mkdir -p "$ROOT" "$ROOT/backups" "$ROOT/manifests"
exec 9>"$ROOT/activate.lock"
flock -x 9

current() { [[ -L "$ROOT/current" ]] && readlink -f "$ROOT/current" || true; }
previous() { [[ -L "$ROOT/previous" ]] && readlink -f "$ROOT/previous" || true; }
write_state() {
  local action=$1 backup=${2:-} tmp="$ROOT/activation-state.json.tmp"
  CURRENT="$(current)" PREVIOUS="$(previous)" ACTION="$action" BACKUP="$backup" \
    python3 - "$tmp" <<'PY'
import json, os, sys, time
with open(sys.argv[1], "w", encoding="utf-8") as out:
    json.dump({"version": 1, "action": os.environ["ACTION"],
               "current": os.environ["CURRENT"], "previous": os.environ["PREVIOUS"],
               "db_backup": os.environ["BACKUP"] or None, "updated_at": time.time()}, out)
    out.write("\n")
PY
  mv -Tf "$tmp" "$ROOT/activation-state.json"
}
if [[ "${1:-}" == "--status" ]]; then
  CURRENT="$(current)" PREVIOUS="$(previous)" STATE="$ROOT/activation-state.json" \
    python3 - <<'PY'
import json, os
state = {}
try:
    with open(os.environ["STATE"], encoding="utf-8") as source: state = json.load(source)
except FileNotFoundError: pass
print(json.dumps({"current": os.environ["CURRENT"] or None,
                  "previous": os.environ["PREVIOUS"] or None, "state": state}))
PY
  exit 0
elif [[ "${1:-}" == "--rollback" ]]; then
  [[ -L "$ROOT/previous" ]] || { echo "no previous OCR worker release" >&2; exit 1; }
  target=$(readlink -f "$ROOT/previous")
  action=rollback
else
  [[ $# -eq 1 ]] || { echo "usage: $0 <release>|--rollback|--status" >&2; exit 2; }
  target=$(readlink -f "$ROOT/releases/$1")
  [[ "$target" == "$ROOT/releases/"* && -x "$target/run-supervisor.sh" ]] || { echo "invalid OCR worker release" >&2; exit 1; }
  action=activate
fi
release_id=$(basename "$target")
manifest="$ROOT/manifests/$release_id.sha256"
[[ -s "$manifest" ]] || { echo "missing OCR worker release manifest: $manifest" >&2; exit 1; }
(cd "$target" && sha256sum -c "$manifest" >/dev/null) || {
  echo "OCR worker release manifest verification failed" >&2; exit 1;
}
chmod -R a-w "$target"
old_current=$(current)
old_previous=$(previous)
backup=""
if [[ -f "$STATE_ROOT/jobs.sqlite3" ]]; then
  backup="$ROOT/backups/jobs-$(date -u +%Y%m%dT%H%M%S-%N).sqlite3"
  SOURCE_DB="$STATE_ROOT/jobs.sqlite3" TARGET_DB="$backup" python3 - <<'PY'
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
    result = db.execute("PRAGMA integrity_check").fetchone()
    if result != ("ok",): raise SystemExit("OCR backup integrity check failed")
finally: db.close()
PY
fi
if [[ -n "$old_current" ]]; then
  ln -sfn "$old_current" "$ROOT/previous.new"
  mv -Tf "$ROOT/previous.new" "$ROOT/previous"
fi
ln -sfn "$target" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"

supervisor_pid() {
  local pid_file="$STATE_ROOT/run/supervisor.pid" pid cmd
  [[ -r "$pid_file" ]] || return 1
  read -r pid <"$pid_file"
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/cmdline" ]] || return 1
  cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline")
  [[ "$cmd" == *"/run-supervisor.sh"* ]] || return 1
  printf '%s\n' "$pid"
}

if [[ -z "${OC_OCR_WORKER_TOKEN:-}" && -r "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
if [[ -z "${OC_OCR_WORKER_TOKEN:-}" ]]; then
  prior_pid=$(supervisor_pid || true)
  if [[ -n "$prior_pid" && -r "/proc/$prior_pid/environ" ]]; then
    OC_OCR_WORKER_TOKEN=$(tr '\0' '\n' <"/proc/$prior_pid/environ" | sed -n 's/^OC_OCR_WORKER_TOKEN=//p' | head -n1)
  fi
fi
: "${OC_OCR_WORKER_TOKEN:?OC_OCR_WORKER_TOKEN is required for readiness verification}"

restart_supervisor() {
  local pid
  pid=$(supervisor_pid || true)
  [[ -n "$pid" ]] || return 1
  kill -TERM "$pid"
}

wait_ready() {
  local expected=$1 body actual ready
  for _ in $(seq 1 "${OC_OCR_HEALTH_ATTEMPTS:-600}"); do
    body=$(curl --noproxy '*' -fsS --max-time 5 \
      -H "Authorization: Bearer $OC_OCR_WORKER_TOKEN" "$HEALTH_URL" || true)
    read -r actual ready < <(HEALTH="$body" python3 - <<'PY'
import json, os
try:
    value = json.loads(os.environ["HEALTH"])
    print(value.get("release", ""), "1" if value.get("ready") is True else "0")
except Exception: print("", "0")
PY
)
    [[ "$actual" == "$expected" && "$ready" == 1 ]] && return 0
    sleep 1
  done
  return 1
}

if ! restart_supervisor || ! wait_ready "$release_id"; then
  if [[ -n "$old_current" ]]; then
    ln -sfn "$old_current" "$ROOT/current.new"
    mv -Tf "$ROOT/current.new" "$ROOT/current"
    restart_supervisor || true
    wait_ready "$(basename "$old_current")" || true
  fi
  if [[ -n "$old_previous" ]]; then
    ln -sfn "$old_previous" "$ROOT/previous.new"
    mv -Tf "$ROOT/previous.new" "$ROOT/previous"
  else
    rm -f "$ROOT/previous"
  fi
  write_state "${action}_reverted" "$backup"
  echo "OCR worker activation failed and previous release was restored" >&2
  exit 1
fi
write_state "$action" "$backup"
printf '%s\n' "$(basename "$target")"
