#!/bin/bash
# Foreground supervisor. The V5 host SSH tunnel owns this process; disconnect
# terminates all model children, and systemd reconnect restarts the release.
set -euo pipefail

: "${OC_OCR_ROOT:?}"
: "${OC_OCR_WORKER_TOKEN:?}"
: "${OC_OCR_CARDS:?comma-separated physical card ids}"
: "${OC_OCR_PP_PYTHON:?}"
: "${OC_OCR_VL_PYTHON:?}"
: "${OC_OCR_DET_MODEL:?}"
: "${OC_OCR_REC_MODEL:?}"
: "${OC_OCR_VL_MODEL:?}"
: "${OC_OCR_PROBE_IMAGE:?}"

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export OC_OCR_WORKER_RELEASE="$(basename "$HERE")"
ROOT="$OC_OCR_ROOT"
DTK_ENV="${OC_OCR_DTK_ENV:-/opt/dtk/env.sh}"
mkdir -p "$ROOT/jobs" "$ROOT/ready" "$ROOT/run" "$ROOT/log"
rm -f "$ROOT/ready"/* "$ROOT/run"/*.sock "$ROOT/run/pipeline-contract.json"
printf '%s\n' "$$" >"$ROOT/run/supervisor.pid.tmp"
mv -Tf "$ROOT/run/supervisor.pid.tmp" "$ROOT/run/supervisor.pid"
printf '%s\n' "$OC_OCR_WORKER_RELEASE" >"$ROOT/run/supervisor.release"

PIDS=()
cleanup() {
  trap - EXIT INT TERM HUP
  kill "${PIDS[@]}" 2>/dev/null || true
  wait "${PIDS[@]}" 2>/dev/null || true
  rm -f "$ROOT/ready"/* "$ROOT/run"/*.sock
  rm -f "$ROOT/run/supervisor.pid" "$ROOT/run/supervisor.release" "$ROOT/run/pipeline-contract.json"
}
trap cleanup EXIT INT TERM HUP

# The API is the single pipeline-identity authority. Start it first, then bind
# every card runner to the exact release + model-manifest digest it published;
# this prevents page checkpoints from crossing a release/model change.
"$OC_OCR_PP_PYTHON" "$HERE/server.py" --root "$ROOT" --listen 127.0.0.1 --port "${OC_OCR_WORKER_PORT:-18960}" --cards "$OC_OCR_CARDS" >>"$ROOT/log/server.log" 2>&1 & PIDS+=("$!")
for _ in $(seq 1 60); do
  [[ -s "$ROOT/run/pipeline-contract.json" ]] && break
  kill -0 "${PIDS[0]}" 2>/dev/null || { echo "ocr-worker: API exited before publishing pipeline identity" >&2; exit 1; }
  sleep 0.5
done
[[ -s "$ROOT/run/pipeline-contract.json" ]] || { echo "ocr-worker: pipeline identity timed out" >&2; exit 1; }
read -r pipeline_release OC_OCR_PIPELINE_DIGEST < <(
  python3 - "$ROOT/run/pipeline-contract.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
print(value.get("release", ""), value.get("pipeline_digest", ""))
PY
)
[[ "$pipeline_release" == "$OC_OCR_WORKER_RELEASE" && "$OC_OCR_PIPELINE_DIGEST" =~ ^[0-9a-f]{64}$ ]] || {
  echo "ocr-worker: invalid pipeline identity" >&2; exit 1;
}
export OC_OCR_PIPELINE_DIGEST

# SCNet closes remote commands that produce no application output even while
# OpenSSH ServerAlive packets are flowing. Keep the SSH channel active; if the
# channel disappears, printf gets EPIPE, this child exits, and wait -n drives
# the same cleanup path as a model/server failure.
(
  while sleep "${OC_OCR_SSH_HEARTBEAT_SECONDS:-5}"; do
    printf 'OCR_HEARTBEAT\n'
  done
) & PIDS+=("$!")

IFS=',' read -r -a CARDS <<<"$OC_OCR_CARDS"
for card in "${CARDS[@]}"; do
  (
    set +u; source "$DTK_ENV" >/dev/null 2>&1; set -u
    export HIP_VISIBLE_DEVICES="$card" CUDA_VISIBLE_DEVICES="$card" TOKENIZERS_PARALLELISM=false
    export OC_OCR_VL_PROBE_IMAGE="$OC_OCR_PROBE_IMAGE"
    exec "$OC_OCR_VL_PYTHON" "$HERE/vl_runner.py" --socket "$ROOT/run/vl-$card.sock" --ready "$ROOT/ready/vl-$card" --model "$OC_OCR_VL_MODEL"
  ) >>"$ROOT/log/vl-$card.log" 2>&1 & PIDS+=("$!")
done

for card in "${CARDS[@]}"; do
  (
    set +u; source "$DTK_ENV" >/dev/null 2>&1; set -u
    export HIP_VISIBLE_DEVICES="$card" CUDA_VISIBLE_DEVICES="$card" TOKENIZERS_PARALLELISM=false
    export OMP_NUM_THREADS="${OC_OCR_CPU_THREADS:-30}" MKL_NUM_THREADS="${OC_OCR_CPU_THREADS:-30}" OPENBLAS_NUM_THREADS="${OC_OCR_CPU_THREADS:-30}"
    exec "$OC_OCR_PP_PYTHON" "$HERE/pp_runner.py" --db "$ROOT/jobs.sqlite3" --jobs-dir "$ROOT/jobs" --card "$card" --ready "$ROOT/ready/pp-$card" --vl-socket "$ROOT/run/vl-$card.sock" --det-model "$OC_OCR_DET_MODEL" --rec-model "$OC_OCR_REC_MODEL" --rasterizer "$HERE/rasterize.py" --probe-image "$OC_OCR_PROBE_IMAGE" --raster-workers "${OC_OCR_RASTER_WORKERS:-6}"
  ) >>"$ROOT/log/pp-$card.log" 2>&1 & PIDS+=("$!")
done

wait -n "${PIDS[@]}"
echo "ocr-worker: a child exited; stopping release" >&2
exit 1
