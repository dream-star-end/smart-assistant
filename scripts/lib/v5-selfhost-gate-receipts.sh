#!/usr/bin/env bash
# Evidence only: a miss runs the original gate. Never inherit acceptance across invocations.
MASTER_GATE_RECEIPT_IDS=""
MASTER_GATE_RECEIPT_SHA=""

master_gate_receipt_reset() {
  MASTER_GATE_RECEIPT_IDS=""
  MASTER_GATE_RECEIPT_SHA=""
}

master_gate_receipt_prepare() { # <pinned staging> <exact sha>
  local staging="$1" sha="$2" receipt ids run
  master_gate_receipt_reset
  [[ "${OC_SELFHOST_GATE_RECEIPTS:-0}" == 1 ]] || return 0
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
