# shellcheck shell=bash
# S2: one automatic retry per actual target SHA, independent of worker restarts.
train_retry_classify() {
  python3 "$SCRIPT_DIR/lib/v5-selfhost-train-retry.py" "$LEASE_DB" "$1"
}

train_retry_alert_sql() { # train reason; durable station queue and normal ride callback
  local rid uid tk tt body
  rid="$(lease_sql "SELECT id FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride' ORDER BY seq DESC LIMIT 1;")" || return 1
  uid=3; tk=log; tt=-
  if [[ -n "$rid" ]]; then
    uid="$(lease_field "$rid" owner_uid)" || return 1
    IFS=$'\t' read -r tk tt < <(lease_callback_target "$rid")
  fi
  [[ "$uid" =~ ^[1-9][0-9]*$ ]] || uid=3
  body="🚨 train $1 自动重试已停车。原因: $2。相同 SHA 的自动预算不会重置；请读列车日志，修复后推新 tip 或明确重新登记。"
  printf "INSERT OR IGNORE INTO train_retry_alert(train_id,owner_uid,reason,created_at) VALUES('%s','%s','%s','%s');\n" \
    "$(lease_q "$1")" "$uid" "$(lease_q "$2")" "$(lease_now)"
  lease_outbox_sql "train:$1:retry-stopped" "${rid:-$1}" train_alert "$tk" "$tt" "$body"
}

train_retry_reconcile() {
  local rows id st reason logf sql
  rows="$(lease_sql -separator $'\t' "SELECT t.id,t.status,r.reason,COALESCE(t.log_path,'') FROM train_auto_retry r JOIN train t ON t.id=r.retry_train_id WHERE r.result='running' AND t.status IN ('committed','failed','recovery_required');")" || return 1
  while IFS=$'\t' read -r id st reason logf; do
    [[ -n "$id" ]] || continue
    sql=""; [[ "$st" == committed ]] || sql="$(train_retry_alert_sql "$id" "retry failed: $reason ($st)")" || return 1
    lease_tx <<SQL || return 1
.bail on
BEGIN IMMEDIATE;
$(lease_event_sql "$id" train-auto-retry-result "$ACTOR" "reason=$reason result=$st")
UPDATE train_auto_retry SET result='$st',finished_at='$(lease_now)' WHERE retry_train_id='$id' AND result='running';
$sql
COMMIT;
SQL
    wlog "train $id automatic retry reason=$reason result=$st"
    [[ -z "$logf" ]] || printf '\n[lease-worker] automatic retry reason=%s result=%s\n' "$reason" "$st" >>"$logf"
  done <<<"$rows"
}

deliver_train_retry_alerts() {
  local rows id uid reason thread body rc
  local -a pg=(sudo -n -u postgres psql)
  # Same test-injection convention as the worker's deploy/task executables.
  [[ -z "${OC_V5_LEASE_RETRY_PSQL_BIN:-}" ]] || pg=("$OC_V5_LEASE_RETRY_PSQL_BIN")
  rows="$(lease_sql -separator $'\t' "SELECT train_id,owner_uid,reason FROM train_retry_alert WHERE delivered_at IS NULL ORDER BY created_at LIMIT 5;")" || return 1
  while IFS=$'\t' read -r id uid reason; do
    [[ -n "$id" && "$uid" =~ ^[1-9][0-9]*$ ]] || continue
    thread="selfhost-train-retry:${id,,}:$uid"
    body="列车 $id 的自动重试已停车。$reason。相同 SHA 最多自动重试一次；请读列车日志，修复后推新 tip 或明确重新登记。"
    rc=0
    timeout 10 "${pg[@]}" -X -q -d openclaude_v5_selfhost -v ON_ERROR_STOP=1 \
      -v uid="$uid" -v thread="$thread" -v body="$body" \
      -v title="[selfhost] 列车自动重试已停车 $id" >/dev/null 2>&1 <<'SQL' || rc=$?
BEGIN;
INSERT INTO inbox_messages(audience,user_id,title,body_md,level,created_by,category,thread_key,source_type)
SELECT 'user',:'uid'::bigint,left(:'title',200),left(:'body',16000),'warning',:'uid'::bigint,
       'operations',:'thread','selfhost-train-retry'
WHERE NOT EXISTS(SELECT 1 FROM inbox_messages WHERE user_id=:'uid'::bigint AND thread_key=:'thread');
COMMIT;
SQL
    if [[ "$rc" == 0 ]]; then
      lease_sql "UPDATE train_retry_alert SET attempts=attempts+1,delivered_at='$(lease_now)',last_error=NULL WHERE train_id='$(lease_q "$id")';" || return 1
      wlog "train $id retry stop delivered to inbox uid=$uid"
    else
      lease_sql "UPDATE train_retry_alert SET attempts=attempts+1,last_error='psql exit $rc' WHERE train_id='$(lease_q "$id")';" || return 1
      wlog "train $id retry stop inbox pending (psql exit $rc)"
    fi
  done <<<"$rows"
}
