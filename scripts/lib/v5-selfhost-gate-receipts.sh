#!/usr/bin/env bash
# Evidence only: a miss runs the original gate. Never inherit acceptance across invocations.
MASTER_GATE_RECEIPT_IDS=""
MASTER_GATE_RECEIPT_SHA=""
MASTER_LOCAL_GATE_CACHE_READY=0
MASTER_LOCAL_GATE_PLAN_FILE=""
MASTER_LOCAL_GATE_SHA=""

master_gate_receipt_reset() {
  MASTER_GATE_RECEIPT_IDS=""
  MASTER_GATE_RECEIPT_SHA=""
  MASTER_LOCAL_GATE_CACHE_READY=0
  MASTER_LOCAL_GATE_PLAN_FILE=""
  MASTER_LOCAL_GATE_SHA=""
}

master_local_gate_helper_path() {
  local src="${BASH_SOURCE[0]:-}" dir=""
  if [[ -n "$src" && -f "$(dirname -- "$src")/v5-selfhost-local-gate-cache.py" ]]; then
    dir="$(cd "$(dirname -- "$src")" && pwd)"
    printf '%s/v5-selfhost-local-gate-cache.py' "$dir"
    return 0
  fi
  if [[ -n "${SCRIPT_DIR:-}" && -f "$SCRIPT_DIR/lib/v5-selfhost-local-gate-cache.py" ]]; then
    printf '%s/lib/v5-selfhost-local-gate-cache.py' "$SCRIPT_DIR"
    return 0
  fi
  return 1
}

master_local_gate_id_for_job() { # <C.* job id> -> manifest gate id
  case "${1:-}" in
    C.session-rootfix) printf 'session-unavailable-rootfix' ;;
    C.watch-gate)      printf 'watch-gate' ;;
    C.cursor-sand)     printf 'cursor-sand-inference' ;;
    C.delegate-billing) printf 'delegate-billing-requestid' ;;
    C.callback-ws)     printf 'callback-payload-hash' ;;
    C.cron-submit)     printf 'cron-submit-boundary' ;;
    C.prompt-privacy)  printf 'prompt-privacy-lifecycle' ;;
    C.session-boundary) printf 'session-workspace-boundary' ;;
    C.system-approval) printf 'system-approval-fencing' ;;
    C.system-executor) printf 'system-executor-fencing' ;;
    C.host-log-policy) printf 'host-log-policy' ;;
    C.model-policy)    printf 'model-policy-recovery' ;;
    C.codex-chatgpt-ws) printf 'codex-chatgpt-ws' ;;
    C.platform-tool-proofs) printf 'platform-tool-proofs' ;;
    C.terminal-unproven) printf 'terminal-unproven' ;;
    C.upload-retention) printf 'upload-retention-http' ;;
    C.architecture)    printf 'architecture' ;;
    *) return 1 ;;
  esac
}

master_local_gate_prepare() { # <pinned staging> <exact sha>
  local _staging="$1" sha="$2" helper cache_dir plan_file node_ver py_ver bun_bin="" bun_ver="" bun_id="" stats
  MASTER_LOCAL_GATE_CACHE_READY=0
  MASTER_LOCAL_GATE_PLAN_FILE=""
  MASTER_LOCAL_GATE_SHA=""
  [[ "${OC_V5_LOCAL_GATE_CACHE:-1}" == 1 ]] || return 0
  [[ "${DRY:-0}" != 1 ]] || return 0
  # Never read or write persistent receipts when node_modules came from a mutable worktree.
  [[ "${OC_V5_ALLOW_WORKTREE_DONOR:-0}" != 1 ]] || {
    mlog "  local gate cache disabled (OC_V5_ALLOW_WORKTREE_DONOR=1)"
    return 0
  }
  [[ -n "${REPO_ROOT:-}" && -n "${MASTER_GATE_TMPDIR:-}" && -d "$MASTER_GATE_TMPDIR" ]] || return 0
  helper="$(master_local_gate_helper_path)" || return 0
  git -C "$REPO_ROOT" cat-file -e "${sha}^{commit}" 2>/dev/null || return 0
  node_ver="$(node --version 2>/dev/null)" || return 0
  py_ver="$(python3 --version 2>/dev/null)" || return 0
  # Match scripts/check-v5-codex-late-stop-proof.sh exact Bun selector: PATH first, then $HOME/.bun/bin/bun.
  bun_bin="$(command -v bun 2>/dev/null || true)"
  if [[ -z "$bun_bin" && -n "${HOME:-}" ]]; then bun_bin="$HOME/.bun/bin/bun"; fi
  if [[ -n "$bun_bin" && -x "$bun_bin" ]] && bun_ver="$("$bun_bin" --version 2>/dev/null)" && [[ -n "$bun_ver" ]]; then
    bun_id="$(readlink -f -- "$bun_bin" 2>/dev/null || printf '%s' "$bun_bin"):$bun_ver"
  fi
  cache_dir="${OC_V5_LOCAL_GATE_CACHE_DIR:-/var/lib/openclaude-v5-selfhost/gate-receipts}"
  plan_file="$MASTER_GATE_TMPDIR/local-gate-plan.json"
  if stats="$(PYTHONDONTWRITEBYTECODE=1 python3 "$helper" plan \
      "$cache_dir" "$REPO_ROOT" "$sha" "$plan_file" "$node_ver" "$py_ver" \
      "${RUNTIME_IMAGE:-}" "$bun_id" "${OC_V5_FORCE_LOCAL_GATES:-0}")"; then
    MASTER_LOCAL_GATE_CACHE_READY=1
    MASTER_LOCAL_GATE_PLAN_FILE="$plan_file"
    MASTER_LOCAL_GATE_SHA="$sha"
    mlog "  local gate input-digest cache ready ($stats hits @ ${sha:0:12})"
    tsum_note localGateCache.hits "$stats" 2>/dev/null || :
  else
    mlog "  local gate input-digest cache unavailable → running all local gates"
    tsum_note localGateCache.status unavailable 2>/dev/null || :
  fi
  return 0
}

master_gate_receipt_prepare() { # <pinned staging> <exact sha>
  local staging="$1" sha="$2" receipt ids run
  master_gate_receipt_reset
  if [[ "${OC_SELFHOST_GATE_RECEIPTS:-0}" == 1 ]]; then
    # The node process makes bounded sequential gh calls. timeout also caps the complete lookup.
    # No background workers, persistent cache, lock acquisition or writes outside private TMPDIR.
    if receipt="$(cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" timeout -k 2s 100s \
        node --import tsx scripts/v5-selfhost-gate-receipts.ts fetch "$staging" "$sha" "$MASTER_GATE_TMPDIR")" \
      && ids="$(jq -er '.gates | select(length > 0) | .[]' <<< "$receipt")" \
      && run="$(jq -er '"\(.runId)/\(.runAttempt)"' <<< "$receipt")"; then
      MASTER_GATE_RECEIPT_IDS="$ids"
      MASTER_GATE_RECEIPT_SHA="$sha"
      mlog "  gate receipt verified for $sha (run $run)"
      tsum_note gateReceipt.run "$run" 2>/dev/null || :
    else
      mlog "  gate receipt miss → original local gates"
      tsum_note gateReceipt.result local-fallback 2>/dev/null || :
    fi
  fi
  master_local_gate_prepare "$staging" "$sha"
  return 0
}

master_gate_receipt_has() { # <gate id> <this build sha>
  if [[ -n "$MASTER_GATE_RECEIPT_SHA" && "$MASTER_GATE_RECEIPT_SHA" == "$2" \
      && $'\n'"$MASTER_GATE_RECEIPT_IDS"$'\n' == *$'\n'"$1"$'\n'* ]]; then
    mlog "  $1: verified merge-queue receipt @ $2"
    tsum_note "gateEvidence.$1" merge-queue-receipt 2>/dev/null || :
    return 0
  fi
  tsum_note "gateEvidence.$1" local 2>/dev/null || :
  return 1
}

master_local_gate_has() { # <gate id> <this build sha> [arch restore path]
  local gate_id="$1" sha="$2" arch_out="${3:-}" helper ref=""
  [[ "${MASTER_LOCAL_GATE_CACHE_READY:-0}" == 1 && "${MASTER_LOCAL_GATE_SHA:-}" == "$sha" \
    && -n "${MASTER_LOCAL_GATE_PLAN_FILE:-}" ]] || return 1
  helper="$(master_local_gate_helper_path)" || return 1
  local -a extra=()
  if [[ -n "$arch_out" ]]; then extra+=("$arch_out"); fi
  if ref="$(PYTHONDONTWRITEBYTECODE=1 python3 "$helper" has "$MASTER_LOCAL_GATE_PLAN_FILE" "$sha" "$gate_id" "${extra[@]}")"; then
    mlog "  [$gate_id] reuse verified local input receipt ($ref)"
    tsum_note "gateEvidence.$gate_id" local-input-receipt 2>/dev/null || :
    return 0
  fi
  tsum_note "gateEvidence.$gate_id" local 2>/dev/null || :
  return 1
}

master_local_gate_has_job() { # <C.* job id> <this build sha>
  local job_id="$1" sha="$2" gate_id="" arch_out=""
  [[ "${MASTER_LOCAL_GATE_CACHE_READY:-0}" == 1 ]] || return 1
  gate_id="$(master_local_gate_id_for_job "$job_id")" || return 1
  if [[ "$gate_id" == architecture && -n "${MASTER_GATE_TMPDIR:-}" ]]; then
    arch_out="$MASTER_GATE_TMPDIR/C.architecture/architecture.json"
  fi
  master_local_gate_has "$gate_id" "$sha" "$arch_out"
}

master_local_gate_record() { # <gate id> <this build sha> [arch report path]
  local gate_id="$1" sha="$2" arch_in="${3:-}" helper
  [[ "${MASTER_LOCAL_GATE_CACHE_READY:-0}" == 1 && "${MASTER_LOCAL_GATE_SHA:-}" == "$sha" \
    && -n "${MASTER_LOCAL_GATE_PLAN_FILE:-}" ]] || return 0
  helper="$(master_local_gate_helper_path)" || return 0
  local -a extra=()
  if [[ -n "$arch_in" ]]; then extra+=("$arch_in"); fi
  PYTHONDONTWRITEBYTECODE=1 python3 "$helper" record "$MASTER_LOCAL_GATE_PLAN_FILE" "$sha" "$gate_id" "${extra[@]}" \
    || mlog "  ⚠ [$gate_id] local gate receipt write skipped"
  return 0
}

master_local_gate_record_job() { # <C.* job id> <this build sha>
  local job_id="$1" sha="$2" gate_id="" arch_in=""
  [[ "${MASTER_LOCAL_GATE_CACHE_READY:-0}" == 1 && -n "$sha" ]] || return 0
  gate_id="$(master_local_gate_id_for_job "$job_id")" || return 0
  if [[ "$gate_id" == architecture && -n "${MASTER_GATE_TMPDIR:-}" ]]; then
    arch_in="$MASTER_GATE_TMPDIR/C.architecture/architecture.json"
  fi
  master_local_gate_record "$gate_id" "$sha" "$arch_in"
}
