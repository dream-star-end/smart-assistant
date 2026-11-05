#!/usr/bin/env bash
# OCV5-732 / OCV5-735: Safe drain-gated container / egress reload for V5 self-host.
# Never restarts oc-v5-u<uid> while any session of that user still has an active
# turn_dispatches row (admitted / accepted / rejecting). Requires caller session ID
# for journalctl traceability and aborts on timeout instead of force-killing turns.
set -euo pipefail

UID_NUM=3
SESSION_ID="${OC_CALLER_SESSION:-}"
WAIT_PID=""
TIMEOUT_SEC=600
POLL_SEC=2
RESTART_EGRESS=""
DRY_RUN=0
SCHEDULE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --uid)
      UID_NUM="$2"
      shift 2
      ;;
    --session)
      SESSION_ID="$2"
      shift 2
      ;;
    --wait-pid)
      WAIT_PID="$2"
      shift 2
      ;;
    --timeout-sec)
      TIMEOUT_SEC="$2"
      shift 2
      ;;
    --poll-sec)
      POLL_SEC="$2"
      shift 2
      ;;
    --restart-egress)
      RESTART_EGRESS="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --schedule)
      SCHEDULE=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 64
      ;;
  esac
done

SESSION_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_.:-')
if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "unknown" ]; then
  echo "ERROR: --session <sessionId> (or OC_CALLER_SESSION) is required for traceability (OCV5-735)." >&2
  exit 64
fi

if ! printf '%s' "$UID_NUM" | grep -Eq '^[0-9]+$'; then
  echo "ERROR: invalid --uid '$UID_NUM'" >&2
  exit 64
fi

log_event() {
  logger -t oc-safe-container-reload -- "session=${SESSION_ID} uid=${UID_NUM} $*" </dev/null 2>/dev/null || true
}

if [ "$SCHEDULE" -eq 1 ]; then
  SHORT_SESS=$(printf '%s' "$SESSION_ID" | tail -c 16 | tr -cd 'A-Za-z0-9_-')
  UNIT_NAME="oc-v5-u${UID_NUM}-post-turn-reload-${SHORT_SESS}-$(date +%s)"
  ARGS=(--uid "$UID_NUM" --session "$SESSION_ID" --timeout-sec "$TIMEOUT_SEC" --poll-sec "$POLL_SEC")
  [ -n "$WAIT_PID" ] && ARGS+=(--wait-pid "$WAIT_PID")
  [ -n "$RESTART_EGRESS" ] && ARGS+=(--restart-egress "$RESTART_EGRESS")
  [ "$DRY_RUN" -eq 1 ] && ARGS+=(--dry-run)
  log_event "action=schedule unit=${UNIT_NAME} wait_pid=${WAIT_PID:-none}"
  exec systemd-run --unit="$UNIT_NAME" \
    --description="Safe post-turn reload for oc-v5-u${UID_NUM} (session ${SESSION_ID})" \
    "$0" "${ARGS[@]}"
fi

START_TS=$(date +%s)
log_event "action=start wait_pid=${WAIT_PID:-none} timeout_sec=${TIMEOUT_SEC} dry_run=${DRY_RUN}"

if [ -n "$WAIT_PID" ]; then
  while kill -0 "$WAIT_PID" 2>/dev/null; do
    NOW_TS=$(date +%s)
    if [ $((NOW_TS - START_TS)) -ge "$TIMEOUT_SEC" ]; then
      log_event "action=abort reason=wait_pid_timeout wait_pid=${WAIT_PID}"
      echo "ABORT: wait-pid ${WAIT_PID} still alive after ${TIMEOUT_SEC}s; refusing to restart oc-v5-u${UID_NUM}." >&2
      exit 75
    fi
    sleep "$POLL_SEC"
  done
fi

query_active_dispatches() {
  if [ -n "${OC_SAFE_RELOAD_ACTIVE_COUNT_CMD:-}" ]; then
    sh -c "$OC_SAFE_RELOAD_ACTIVE_COUNT_CMD"
    return
  fi
  su - postgres -c "psql -d openclaude_v5_selfhost -Atc \"SELECT COUNT(*)::int FROM turn_dispatches WHERE user_id = ${UID_NUM} AND status IN ('admitted', 'accepted', 'rejecting');\""
}

CONSECUTIVE_IDLE=0
while true; do
  ACTIVE_RAW=$(query_active_dispatches | tr -d '[:space:]')
  if ! printf '%s' "$ACTIVE_RAW" | grep -Eq '^[0-9]+$'; then
    log_event "action=abort reason=query_failed raw=${ACTIVE_RAW:-empty}"
    echo "ABORT: failed to query active turn_dispatches (got '${ACTIVE_RAW:-empty}')." >&2
    exit 75
  fi
  if [ "$ACTIVE_RAW" -eq 0 ]; then
    CONSECUTIVE_IDLE=$((CONSECUTIVE_IDLE + 1))
    if [ "$CONSECUTIVE_IDLE" -ge 2 ]; then
      break
    fi
  else
    CONSECUTIVE_IDLE=0
    log_event "action=waiting active_dispatches=${ACTIVE_RAW}"
  fi
  NOW_TS=$(date +%s)
  if [ $((NOW_TS - START_TS)) -ge "$TIMEOUT_SEC" ]; then
    log_event "action=abort reason=active_dispatches_timeout active_dispatches=${ACTIVE_RAW}"
    echo "ABORT: user ${UID_NUM} still has ${ACTIVE_RAW} active turn_dispatches after ${TIMEOUT_SEC}s; refusing to restart oc-v5-u${UID_NUM}." >&2
    exit 75
  fi
  sleep "$POLL_SEC"
done

log_event "action=restart container=oc-v5-u${UID_NUM} egress=${RESTART_EGRESS:-none} dry_run=${DRY_RUN}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY_RUN_OK session=${SESSION_ID} uid=${UID_NUM} container=oc-v5-u${UID_NUM}"
  exit 0
fi

docker restart "oc-v5-u${UID_NUM}"
if [ -n "$RESTART_EGRESS" ]; then
  systemctl restart "$RESTART_EGRESS"
fi
log_event "action=completed container=oc-v5-u${UID_NUM}"
