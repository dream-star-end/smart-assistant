#!/usr/bin/env bash
set -eo pipefail
source /opt/dtk/env.sh
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORKTREE=${H3_SP_WORKTREE:-/root/private_data/minimax-h3-v5-worker}
MODEL_ROOT=${H3_SP_MODEL_ROOT:-/root/private_data/minimax-h3/ComfyUI}
STATE=${H3_SP_STATE_ROOT:-/root/minimax-h3-sp-runtime}
PYTHON=${H3_SP_PYTHON:-/root/minimax-h3-runtime/venv/bin/python}
mkdir -p "$STATE"/{logs,rank0,rank1}
cat > "$STATE/extra_model_paths.yaml" <<YAML
minimax_h3_shared:
  base_path: $MODEL_ROOT
  diffusion_models: models/diffusion_models
  text_encoders: models/text_encoders
  vae: models/vae
YAML

if [[ -f "$STATE/torchrun.pid" ]] && kill -0 "$(cat "$STATE/torchrun.pid")" 2>/dev/null; then
  echo "H3 sequence-parallel worker already running" >&2
  exit 1
fi
rm -f "$STATE/torchrun.pid"
export H3_SP_WORKTREE="$WORKTREE"
export H3_SP_STATE_ROOT="$STATE"
export H3_SP_MODEL_PATHS="$STATE/extra_model_paths.yaml"
export H3_SP_BASE_PORT=8290
export H3_SP_COLLECTIVE_TIMEOUT_SECONDS=120
export H3_SP_PROGRESS_DIR="$STATE/progress"
export MINIMAX_H3_SEQUENCE_PARALLEL=1
setsid "$PYTHON" -m torch.distributed.run --standalone --nproc_per_node=2   "$SCRIPT_DIR/run_rank.py"   >"$STATE/logs/torchrun.log" 2>&1 < /dev/null &
pid=$!
echo "$pid" > "$STATE/torchrun.pid"

for _ in $(seq 1 180); do
  ready=0
  for port in 8290 8291; do
    curl -fsS --max-time 2 "http://127.0.0.1:$port/system_stats" >/dev/null 2>&1 && ready=$((ready + 1))
  done
  if [[ "$ready" == 2 ]]; then
    grep "H3_SP_RANK_READY" "$STATE/logs/torchrun.log"
    echo "H3 sequence-parallel worker ready on 127.0.0.1:8290,8291"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    tail -200 "$STATE/logs/torchrun.log" >&2
    exit 1
  fi
  sleep 1
done
kill -TERM -- "-$pid" 2>/dev/null || true
echo "Timed out waiting for both H3 ranks" >&2
exit 1
