#!/usr/bin/env bash
# selfheal-release-lane — TRUSTED (TCB) production deploy lane for automated code
# self-heal. Spawned by the personal-edition release worker as:
#   systemd-run --scope --unit=<scope> --collect bash ops/selfheal-release-lane.sh <argsFile>
#
# CONTRACT (batch1b §8.1):
#   stdout carries ONLY newline-delimited JSON events — a `checkpoint` line
#   (deploy_effect_applied) and a final `receipt` line. EVERYTHING ELSE (every
#   diagnostic) goes to stderr. The worker reads stdout line-by-line and persists
#   the checkpoint the instant it appears (durable, set-once) so a crash after
#   deploy-effect but before receipt can recover by "retry push only", never by
#   re-running the deploy.
#
# TRUST / SAFETY:
#   - Local deploy lock (/var/lock/oc-v5-deploy.lock) is taken BEFORE any canonical
#     mutation and inherited into deploy-v5.sh via OC_V5_DEPLOY_LOCK_FD (no
#     forgeable boolean env). Lock order is fixed: local deploy lock first, the
#     remote production-mutation lease is taken by deploy-v5.sh itself.
#   - Pre-deploy checks are fail-closed: any refusal emits outcome=manual and NOTHING
#     is deployed (the worker maps manual → manual_required).
#   - The proof step is ALWAYS run (regardless of deploy exit code) via a separate
#     trusted, read-only prover; its verdict decides the receipt outcome.
#
# Only two knobs exist for testability, both default to the exact production values:
#   OC_SELFHEAL_PROOF_CMD  — prover command (default: npx tsx <repo>/ops/selfheal-release-proof.ts)
#   OC_V5_DEPLOY_LOCK      — deploy lock path (default: /var/lock/oc-v5-deploy.lock)
set -euo pipefail

# ── derive repo root from the script's own location (ops/ is one level down) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PERSONAL_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── config (deploy-v5.sh-compatible defaults) ────────────────────────────────
KL_HOST="${KL_HOST:-kl-mirror}"
V5_ENV="${OC_SELFHEAL_V5_ENV:-}"
RELEASES_ROOT="${OC_SELFHEAL_V5_RELEASES_ROOT:-/opt/openclaude/openclaude-v5-releases}"
DEPLOY_LOCK="${OC_V5_DEPLOY_LOCK:-/var/lock/oc-v5-deploy.lock}"
PROOF_CMD="${OC_SELFHEAL_PROOF_CMD:-npx tsx ${PERSONAL_REPO}/ops/selfheal-release-proof.ts}"

log() { printf '[lane] %s\n' "$*" >&2; }
emit_json() { printf '%s\n' "$1"; }

# ── argsFile ─────────────────────────────────────────────────────────────────
ARGS_FILE="${1:-}"
if [ -z "$ARGS_FILE" ] || [ ! -f "$ARGS_FILE" ]; then
  log "argsFile missing or not a file: '${ARGS_FILE:-<none>}'"
  # No rrid/sha available → emit a bare fail-closed manual receipt.
  emit_json "$(jq -nc '{evt:"receipt",rrid:"",sha:"",planHash:"",manifestHash:"",candidateRef:"",outcome:"manual",reason:"bad_args_file",proofs:{},canonicalPush:"pending",exit:78}')"
  exit 0
fi

rrid="$(jq -r '.rrid // ""' "$ARGS_FILE")"
repairId="$(jq -r '.repairId // ""' "$ARGS_FILE")"
canonicalRepo="$(jq -r '.canonicalRepo // ""' "$ARGS_FILE")"
canonicalBranch="$(jq -r '.canonicalBranch // ""' "$ARGS_FILE")"
baseSha="$(jq -r '.baseSha // ""' "$ARGS_FILE")"
sha="$(jq -r '.sha // ""' "$ARGS_FILE")"
candidateRef="$(jq -r '.candidateRef // ""' "$ARGS_FILE")"
manifestHash="$(jq -r '.manifestHash // ""' "$ARGS_FILE")"
planHash="$(jq -r '.planHash // ""' "$ARGS_FILE")"
mapfile -t deployArgs < <(jq -r '.deployArgs[]? // empty' "$ARGS_FILE")
mapfile -t requiredAxes < <(jq -r '.requiredAxes[]? // empty' "$ARGS_FILE")

# ── receipt / manual helpers (JSON built with jq -nc for safety) ─────────────
# emit_receipt <outcome> <reason|__null__> <canonicalPush> <exitInt> <facesJson>
emit_receipt() {
  local outcome="$1" reason="$2" cpush="$3" exitc="$4" faces="$5" receipt
  if [ "$reason" = "__null__" ]; then
    receipt="$(jq -nc \
      --arg rrid "$rrid" --arg sha "$sha" --arg planHash "$planHash" \
      --arg manifestHash "$manifestHash" --arg candidateRef "$candidateRef" --arg outcome "$outcome" \
      --arg cpush "$cpush" --argjson exit "$exitc" --argjson proofs "$faces" \
      '{evt:"receipt",rrid:$rrid,sha:$sha,planHash:$planHash,manifestHash:$manifestHash,candidateRef:$candidateRef,outcome:$outcome,reason:null,proofs:$proofs,canonicalPush:$cpush,exit:$exit}')"
  else
    receipt="$(jq -nc \
      --arg rrid "$rrid" --arg sha "$sha" --arg planHash "$planHash" \
      --arg manifestHash "$manifestHash" --arg candidateRef "$candidateRef" --arg outcome "$outcome" --arg reason "$reason" \
      --arg cpush "$cpush" --argjson exit "$exitc" --argjson proofs "$faces" \
      '{evt:"receipt",rrid:$rrid,sha:$sha,planHash:$planHash,manifestHash:$manifestHash,candidateRef:$candidateRef,outcome:$outcome,reason:$reason,proofs:$proofs,canonicalPush:$cpush,exit:$exit}')"
  fi
  emit_json "$receipt"
}

# emit_manual <reason> — pre-deploy refusal: NOTHING was deployed. exit 78 sentinel.
emit_manual() {
  log "manual: $1"
  emit_receipt "manual" "$1" "pending" 78 "{}"
  exit 0
}

# ── validate essential args ──────────────────────────────────────────────────
for pair in rrid:"$rrid" canonicalRepo:"$canonicalRepo" canonicalBranch:"$canonicalBranch" \
            baseSha:"$baseSha" sha:"$sha" candidateRef:"$candidateRef"; do
  name="${pair%%:*}" val="${pair#*:}"
  if [ -z "$val" ]; then
    log "argsFile missing field: $name"
    emit_manual "bad_args_file"
  fi
done

# ══ STEP 1 — acquire local deploy lock BEFORE any canonical mutation ══════════
# Fixed, well-known fd 200 so deploy-v5.sh inherits it by number (OC_V5_DEPLOY_LOCK_FD).
log "acquiring deploy lock: $DEPLOY_LOCK"
if ! exec 200>"$DEPLOY_LOCK" 2>/dev/null; then
  log "cannot open deploy lock file"
  emit_manual "deploy_lock_unavailable"
fi
if ! flock -w 900 200; then
  # Nothing deployed yet → this is a no-op/manual, not deploy_unknown.
  emit_manual "deploy_lock_timeout"
fi
log "deploy lock held (fd 200)"

# ══ STEP 2 — in-lock, fail-closed pre-deploy checks ══════════════════════════
# worktree clean
if ! porcelain="$(git -C "$canonicalRepo" status --porcelain 2>&1)"; then
  log "git status failed: $porcelain"
  emit_manual "worktree_status_failed"
fi
[ -z "$porcelain" ] || { log "worktree dirty:"$'\n'"$porcelain"; emit_manual "worktree_dirty"; }

# fetch origin (diagnostics → stderr)
if ! git -C "$canonicalRepo" fetch origin 1>&2; then
  emit_manual "fetch_failed"
fi

# local HEAD == origin HEAD == baseSha
head_sha="$(git -C "$canonicalRepo" rev-parse HEAD 2>/dev/null || true)"
origin_sha="$(git -C "$canonicalRepo" rev-parse "origin/${canonicalBranch}" 2>/dev/null || true)"
if [ "$head_sha" != "$baseSha" ] || [ "$origin_sha" != "$baseSha" ]; then
  log "canonical advanced: head=$head_sha origin=$origin_sha base=$baseSha"
  emit_manual "canonical_advanced"
fi

# remote deploy_state stable + candidate empty (READ-ONLY single SELECT)
ds_sql="SELECT phase ||'|'|| active_slot ||'|'|| coalesce(candidate_slot,'') ||'|'|| coalesce(active_release,'') ||'|'|| coalesce(candidate_release,'') FROM deploy_state ORDER BY generation DESC LIMIT 1;"
ds_row="$(ssh "$KL_HOST" "set -a; . '${V5_ENV}' 2>/dev/null; psql \"\$DATABASE_URL\" -X -v ON_ERROR_STOP=1 -tAq -c \"${ds_sql}\"" 2>/dev/null | head -n1 || true)"
IFS='|' read -r ds_phase _ds_aslot ds_cslot _ds_arel ds_crel <<<"${ds_row}"
if [ "$ds_phase" != "stable" ] || [ -n "$ds_cslot" ] || [ -n "$ds_crel" ]; then
  log "deploy_state not stable / candidate set: '$ds_row'"
  emit_manual "deploy_state_not_stable"
fi

# remote recovery marker present → refuse
if ssh "$KL_HOST" "test -e '${RELEASES_ROOT}/.manual-recovery-required'" >/dev/null 2>&1; then
  log "remote recovery marker present"
  emit_manual "recovery_marker_present"
fi

# axis pre-gate (§F4): every deploy axis this plan requires must be ENABLED on the
# remote BEFORE we merge/push anything. runtime-release → OC_RUNTIME_RELEASE
# non-empty in V5_ENV; platform-bundle → OC_PLATFORM_BUNDLE non-empty (mirrors
# deploy-v5.sh's own enablement probe exactly). Not enabled / unknown axis →
# manual (reason=axis_not_enabled); nothing has been deployed at this point.
for axis in ${requiredAxes[@]+"${requiredAxes[@]}"}; do
  case "$axis" in
    runtime-release) axis_key="OC_RUNTIME_RELEASE" ;;
    platform-bundle) axis_key="OC_PLATFORM_BUNDLE" ;;
    *) log "unknown required axis: $axis"; emit_manual "axis_not_enabled" ;;
  esac
  axis_val="$(ssh "$KL_HOST" "test -r '${V5_ENV}' && grep -E '^[[:space:]]*${axis_key}=' '${V5_ENV}' 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]'" 2>/dev/null || true)"
  if [ -z "$axis_val" ]; then
    log "required axis '$axis' ($axis_key) not enabled on remote"
    emit_manual "axis_not_enabled"
  fi
  log "required axis '$axis' enabled ($axis_key set)"
done

# ══ STEP 3 — fast-forward merge candidate sha into local canonical ═══════════
if ! git -C "$canonicalRepo" merge --ff-only "$sha" 1>&2; then
  emit_manual "ff_merge_failed"
fi
merged_head="$(git -C "$canonicalRepo" rev-parse HEAD 2>/dev/null || true)"
[ "$merged_head" = "$sha" ] || { log "head after merge=$merged_head != sha=$sha"; emit_manual "head_not_sha"; }

# ══ STEP 4 — push candidate ref (NO force) + exact readback ══════════════════
# From here until the deploy spawns, an abort must UNDO the local ff-merge (reset
# back to baseSha — worktree was verified clean and we hold the deploy lock, and
# nothing has been deployed). Otherwise local canonical is left advanced past
# origin and every retry of the same request dies on `canonical_advanced`.
undo_merge_and_manual() { # <reason>
  if ! git -C "$canonicalRepo" reset --hard "$baseSha" 1>&2; then
    # Reset failed: local canonical is in an advanced state a human must inspect.
    log "reset --hard $baseSha FAILED after '$1' — local canonical left at $sha"
    emit_manual "$1_and_reset_failed"
  fi
  emit_manual "$1"
}
if ! git -C "$canonicalRepo" push origin "${sha}:${candidateRef}" 1>&2; then
  undo_merge_and_manual "candidate_push_failed"
fi
readback="$(git -C "$canonicalRepo" ls-remote origin "$candidateRef" 2>/dev/null | awk 'NR==1{print $1}' || true)"
[ "$readback" = "$sha" ] || { log "candidate readback=$readback != sha=$sha"; undo_merge_and_manual "candidate_readback_mismatch"; }

# ══ STEP 5 — run the real deploy (relax set -e ONLY around it) ════════════════
log "invoking deploy: $canonicalRepo/scripts/deploy-v5.sh ${deployArgs[*]:-}"
set +e
(
  cd "$canonicalRepo" \
  && OC_V5_DEPLOY_LOCK_FD=200 bash "$canonicalRepo/scripts/deploy-v5.sh" ${deployArgs[@]+"${deployArgs[@]}"}
) 1>&2
deploy_exit=$?
set -e
log "deploy exit=$deploy_exit"

# ══ STEP 6 — ALWAYS run per-surface proof (read-only), regardless of exit ════
log "running proof: $PROOF_CMD $ARGS_FILE"
set +e
proof_json="$($PROOF_CMD "$ARGS_FILE")"
proof_rc=$?
set -e
log "proof rc=$proof_rc json=${proof_json:-<empty>}"

verdict="$(printf '%s' "$proof_json" | jq -r '.verdict // empty' 2>/dev/null || true)"
faces_json="$(printf '%s' "$proof_json" | jq -c '.faces // {}' 2>/dev/null || echo '{}')"
case "$verdict" in
  deployed | deploy_failed | deploy_unknown) : ;;
  *) verdict="deploy_unknown"; faces_json='{}' ;;
esac

# ══ STEP 7 — emit checkpoint (if deployed) then final receipt ════════════════
case "$verdict" in
  deployed)
    checkpoint="$(jq -nc \
      --arg rrid "$rrid" --arg sha "$sha" --arg planHash "$planHash" \
      --arg manifestHash "$manifestHash" --arg candidateRef "$candidateRef" \
      --argjson proofs "$faces_json" \
      '{evt:"checkpoint",kind:"deploy_effect_applied",rrid:$rrid,sha:$sha,planHash:$planHash,manifestHash:$manifestHash,candidateRef:$candidateRef,proofs:$proofs}')"
    emit_json "$checkpoint"
    # Fast-forward the canonical branch. Push failure NEVER rolls back the deploy;
    # it only downgrades canonicalPush to `pending` (worker retries the push).
    if git -C "$canonicalRepo" push origin "${sha}:refs/heads/${canonicalBranch}" 1>&2; then
      canonicalPush="pushed"
    else
      log "canonical push failed → pending (deploy stays applied)"
      canonicalPush="pending"
    fi
    emit_receipt "deployed" "__null__" "$canonicalPush" "$deploy_exit" "$faces_json"
    ;;
  deploy_failed)
    # §F3: deploy is confirmed not-applied / fully rolled back. STEP 3 advanced
    # local canonical to $sha while origin canonical was NEVER advanced (only the
    # deployed branch pushes it), so local MUST be reset back to $baseSha or every
    # retry dies on canonical_advanced. The candidate ref stays (harmless).
    freason="proof_not_applied"
    if git -C "$canonicalRepo" reset --hard "$baseSha" 1>&2; then
      log "deploy_failed: reset local canonical → $baseSha"
    else
      printf '[lane] WARNING: RESET --hard %s FAILED AFTER deploy_failed — LOCAL CANONICAL LEFT AT %s; MANUAL REALIGNMENT REQUIRED BEFORE ANY DEPLOY\n' "$baseSha" "$sha" >&2
      freason="proof_not_applied_reset_failed"
    fi
    emit_receipt "deploy_failed" "$freason" "failed" "$deploy_exit" "$faces_json"
    ;;
  *)
    # §F3: deploy_unknown — the effect MAY already be live, so a reset here could
    # split source from production. Do NOT reset; leave local canonical at $sha
    # and warn loudly. A human must adjudicate (/version + deploy_state) before
    # ANY further deploy.
    printf '[lane] WARNING: deploy_unknown — LOCAL CANONICAL STOPPED AT CANDIDATE SHA %s; HUMAN ADJUDICATION REQUIRED, DO NOT run any manual deploy before it\n' "$sha" >&2
    emit_receipt "deploy_unknown" "proof_indeterminate_local_canonical_at_candidate" "pending" "$deploy_exit" "$faces_json"
    ;;
esac

exit 0
