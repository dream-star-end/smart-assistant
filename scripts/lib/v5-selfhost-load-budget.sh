# shellcheck shell=bash
# Private invocation state: never inherit a different train's exclusion identity.
MASTER_GATE_LOAD_BUDGET_HELPER="$(dirname "${BASH_SOURCE[0]}")/v5-selfhost-load-budget.py"
MASTER_GATE_LOAD_BUDGET_DIR=""
MASTER_GATE_LOAD_BUDGET_PID=""
MASTER_GATE_LOAD_BUDGET_START=""
MASTER_GATE_LOAD_BUDGET_ROOT=""
MASTER_GATE_LOAD_BUDGET_ROOT_START=""
MASTER_GATE_LOAD_BUDGET_BOOT=""
MASTER_GATE_LOAD_BUDGET_STARTED=0
MASTER_GATE_ADMISSION_BUDGET=0

master_gate_load_budget_start() {
  [[ "$MASTER_GATE_LOAD_BUDGET_STARTED" == 0 ]] || return 0
  MASTER_GATE_LOAD_BUDGET_STARTED=1
  MASTER_GATE_LOAD_BUDGET_ROOT="$$"
  if ! read -r MASTER_GATE_LOAD_BUDGET_ROOT_START MASTER_GATE_LOAD_BUDGET_BOOT < <(
    python3 "$MASTER_GATE_LOAD_BUDGET_HELPER" identity --proc "$MASTER_GATE_PROC_ROOT" --root-pid "$$"
  ); then return 0; fi
  MASTER_GATE_LOAD_BUDGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oc-selfhost-load.XXXXXX")" || return 0
  python3 "$MASTER_GATE_LOAD_BUDGET_HELPER" run --proc "$MASTER_GATE_PROC_ROOT" \
    --root-pid "$MASTER_GATE_LOAD_BUDGET_ROOT" --root-start "$MASTER_GATE_LOAD_BUDGET_ROOT_START" \
    --boot "$MASTER_GATE_LOAD_BUDGET_BOOT" --loadavg "$MASTER_GATE_LOADAVG" \
    --state "$MASTER_GATE_LOAD_BUDGET_DIR/snapshot.json" >/dev/null 2>&1 </dev/null &
  MASTER_GATE_LOAD_BUDGET_PID=$!
  # Bash can reap async children early; cleanup revalidates this kernel identity.
  read -r MASTER_GATE_LOAD_BUDGET_START _ < <(
    python3 "$MASTER_GATE_LOAD_BUDGET_HELPER" identity --proc "$MASTER_GATE_PROC_ROOT" \
      --root-pid "$MASTER_GATE_LOAD_BUDGET_PID"
  ) || MASTER_GATE_LOAD_BUDGET_START=""
  return 0
}

master_gate_admission_load1() { # <validated raw host load>; no evidence means no credit
  local raw="$1"
  python3 "$MASTER_GATE_LOAD_BUDGET_HELPER" read --proc "$MASTER_GATE_PROC_ROOT" \
    --root-pid "$MASTER_GATE_LOAD_BUDGET_ROOT" --root-start "$MASTER_GATE_LOAD_BUDGET_ROOT_START" \
    --boot "$MASTER_GATE_LOAD_BUDGET_BOOT" --state "$MASTER_GATE_LOAD_BUDGET_DIR/snapshot.json" \
    --raw "$raw" 2>/dev/null || printf '%s' "$raw"
}

master_gate_load_budget_stop() {
  local dir="$MASTER_GATE_LOAD_BUDGET_DIR"
  if [[ -n "$MASTER_GATE_LOAD_BUDGET_PID" && -n "$MASTER_GATE_LOAD_BUDGET_START" ]] && \
    python3 "$MASTER_GATE_LOAD_BUDGET_HELPER" alive --proc "$MASTER_GATE_PROC_ROOT" \
      --root-pid "$MASTER_GATE_LOAD_BUDGET_PID" --root-start "$MASTER_GATE_LOAD_BUDGET_START" \
      --boot "$MASTER_GATE_LOAD_BUDGET_BOOT" 2>/dev/null; then
    kill -TERM "$MASTER_GATE_LOAD_BUDGET_PID" 2>/dev/null || :
    wait "$MASTER_GATE_LOAD_BUDGET_PID" 2>/dev/null || :
  # Unknown/live identity is never signalled or waited: root loss ends the sampler.
  elif [[ -n "$MASTER_GATE_LOAD_BUDGET_PID" ]] && ! kill -0 "$MASTER_GATE_LOAD_BUDGET_PID" 2>/dev/null; then
    wait "$MASTER_GATE_LOAD_BUDGET_PID" 2>/dev/null || :
  fi
  if [[ -n "$dir" ]]; then
    rm -f -- "$dir/snapshot.json" "$dir/snapshot.tmp"
    rmdir -- "$dir" 2>/dev/null || :
  fi
  MASTER_GATE_LOAD_BUDGET_DIR=""
  MASTER_GATE_LOAD_BUDGET_PID=""
  return 0
}
