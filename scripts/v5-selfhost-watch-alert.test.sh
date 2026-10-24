#!/usr/bin/env bash
# OCV5-410 看护告警行为测试。curl / psql 用 PATH 替身,所有路径在临时目录,不连网、不写库、不碰宿主。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALERT="${ALERT_BIN_UNDER_TEST:-$DIR/v5-selfhost-watch-alert.sh}"
WATCH="${WATCH_BIN:-$DIR/v5-selfhost-watch.sh}"
for b in "$ALERT" "$WATCH"; do
  case "$(readlink -f "$b")" in /opt/openclaude/v5-selfhost-watch/*) echo "REFUSE: 不测已安装副本" >&2; exit 2 ;; esac
done

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

BASE="$(mktemp -d /tmp/v5-watch-alert.XXXXXX)"
# 失败路径可能留下仍在睡的 psql 替身;收尾一并清掉。
trap 'pkill -f "$BASE/" 2>/dev/null || true; rm -rf "$BASE"' EXIT
KEY="k3y-$(date +%s%N)-secret"
# 库卡住的替身睡这么久。A18/A19 的时间上限按它推出(超时坏了就会等满它),
# 不按空闲机器上的正常耗时推:门禁和运行时构建并跑时同样的拍会慢好几倍(OCV5-436)。
STALL_SEC=120

setup() {
  C="$BASE/$1"
  mkdir -p "$C/bin" "$C/etc" "$C/state" "$C/live/scripts"
  export TRACE="$C/trace" PSQL_IN="$C/psql.in" CURL_CONF="$C/curl.conf" PSQL_ENV="$C/psql.env" \
    CURL_RC=0 CURL_RESP='{"errcode":0}' PSQL_RC=0 PSQL_SLEEP=0
  : >"$TRACE"
  cat >"$C/bin/curl" <<'S'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$TRACE"
body_stdin=0
while (($#)); do
  [[ "$1" == -K ]] && cat "$2" >>"$CURL_CONF"
  [[ "$1" == --data-binary && "${2:-}" == @- ]] && body_stdin=1
  shift
done
if ((body_stdin)); then cat >/dev/null; fi
[[ "${CURL_RC:-0}" == 0 ]] || exit "$CURL_RC"
printf '%s' "${CURL_RESP:-}"
S
  cat >"$C/bin/psql" <<'S'
#!/usr/bin/env bash
printf 'psql %s\n' "$*" >>"$TRACE"
printf 'host=%s port=%s user=%s db=%s password=%s\n' "${PGHOST:-}" "${PGPORT:-}" "${PGUSER:-}" "${PGDATABASE:-}" \
  "$([[ "${PGPASSWORD:-}" == "${EXPECT_PGPASS:-}" ]] && echo match || echo mismatch)" >>"$PSQL_ENV"
cat >"$PSQL_IN"
sleep "${PSQL_SLEEP:-0}"
exit "${PSQL_RC:-0}"
S
  chmod 0755 "$C/bin/curl" "$C/bin/psql"
  export PATH="$C/bin:/usr/bin:/bin"
  export WATCH_ALERT_CONF="$C/etc/alert.env" WATCH_ALERT_DB_ENV="$C/etc/db.env" WATCH_ALERT_STATE_DIR="$C/state"
  export WATCH_LOG="$C/watch.log" WATCH_LIVE="$C/live" WATCH_ALERT_WECOM_URL="http://127.0.0.1:9/wecom"
  unset WATCH_ALERT_MODE WATCH_ALERT_INBOX_UID || true
  # 口令含 %40(→@)、字面 +、字面反斜杠:与 libpq 的解析一致才算对(review r2)。
  printf '%s\n' 'DATABASE_URL=postgres://fixture_user:fix%40p+w\x41@127.0.0.1:9/fixture_db?sslmode=disable' >"$WATCH_ALERT_DB_ENV"
  export EXPECT_PGPASS='fix@p+w\x41'
  printf -- '-- fanout fixture\nSELECT 1;\n' >"$C/live/scripts/v5-alert-fanout.sql"
}
conf() { printf '%s\n' "$@" >"$WATCH_ALERT_CONF"; chmod 0600 "$WATCH_ALERT_CONF"; }
send() { set +e; OUT="$(bash "$ALERT" "$@" 2>&1 </dev/null)"; EC=$?; set -e; }
nfiles() { { find "$1" -maxdepth 1 -name '*.json' 2>/dev/null || true; } | wc -l; }
secret_leaked() { grep -rqF "$KEY" "$WATCH_LOG" "$C/state" 2>/dev/null; }
# argv 里不能出现企微 key、库连接串或口令(review r1:ps 可见)。
argv_leaked() { grep -qF -e "$KEY" -e 'postgres://' -e 'fix@p+w' -e 'fix%40p+w' "$TRACE"; }

# A1 默认 dry:不调 curl / psql,只落演练 JSON(0600)与日志。
setup a1
send --event tier1_rolled_back --severity critical --message "回切了"
f="$(find "$C/state/alert-dry" -name '*.json' | head -n1)"
if [[ "$EC" == 0 && ! -s "$TRACE" && -n "$f" && "$(stat -c %a "$f")" == 600 && "$(stat -c %a "$C/state")" == 700 ]] \
  && [[ "$(jq -r '.dry, .event, .severity, .would.wecom, .would.inbox_uid' "$f" | tr '\n' ' ')" == "true tier1_rolled_back critical not-configured 3 " ]] \
  && grep -q 'watch-alert CRITICAL event=tier1_rolled_back mode=dry' "$WATCH_LOG"; then
  ok "A1 default dry: no network/db, dry record 0600"
else bad "A1 ec=$EC trace=$(cat "$TRACE") out=$OUT"; fi

# A2 dry + key:只记指纹,key 不进日志 / 演练记录。
setup a2; conf "WATCH_ALERT_WECOM_KEY=$KEY"
send --event fail_loud --severity critical --message x
fp="$(printf '%s' "$KEY" | sha256sum | cut -c1-8)"
if [[ "$EC" == 0 && ! -s "$TRACE" ]] && jq -e --arg w "key:$fp" '.would.wecom==$w' "$C"/state/alert-dry/*.json >/dev/null && ! secret_leaked; then
  ok "A2 dry with key records fingerprint only"
else bad "A2 ec=$EC"; fi

# A3 配置文件权限不是 600:不用其中的 key。
setup a3; conf "WATCH_ALERT_WECOM_KEY=$KEY" "WATCH_ALERT_MODE=live"; chmod 0644 "$WATCH_ALERT_CONF"
send --event fail_loud --severity critical --message x
if [[ "$EC" == 0 ]] && ! grep -q '^curl' "$TRACE" && grep -q '权限 644' "$WATCH_LOG" && ! secret_leaked; then
  ok "A3 world-readable config key is ignored"
else bad "A3 trace=$(cat "$TRACE")"; fi

# A4 off:只写日志。
setup a4; conf "WATCH_ALERT_MODE=off"
send --event fail_loud --severity critical --message x
if [[ "$EC" == 0 && ! -s "$TRACE" && "$(nfiles "$C/state/alert-dry")" == 0 && "$(nfiles "$C/state/alert-spool")" == 0 ]] && grep -q 'mode=off' "$WATCH_LOG"; then
  ok "A4 off only logs"
else bad "A4"; fi

# A5 live 两通道都成功:无 spool;站内信给 uid 3、带 fanout;key 不进日志。
setup a5; conf "WATCH_ALERT_MODE=live" "WATCH_ALERT_WECOM_KEY=$KEY"
send --event rollback_failed --severity critical --message "两级兜底仍红"
queued="$(nfiles "$C/state/alert-spool")"; calls_before="$(wc -l <"$TRACE")"
send --flush
if [[ "$EC" == 0 && "$queued" == 1 && "$calls_before" == 0 && "$(nfiles "$C/state/alert-spool")" == 0 ]] \
  && grep -qF "?key=$KEY" "$CURL_CONF" && grep -q '^psql ' "$TRACE" && ! argv_leaked \
  && grep -q 'host=127.0.0.1 port=9 user=fixture_user db=fixture_db password=match' "$PSQL_ENV" \
  && grep -q -- '-v uid=3 ' "$TRACE" && grep -q "selfhost-watch:rollback_failed" "$TRACE" && grep -q '\\i .*v5-alert-fanout.sql' "$PSQL_IN" \
  && grep -q "INSERT INTO inbox_messages" "$PSQL_IN" && [[ "$(grep -c 'SENT channel=' "$WATCH_LOG")" == 2 ]] && ! secret_leaked; then
  ok "A5 live enqueues first, flush sends wecom + inbox(uid 3)+outbox; secrets never in argv/log"
else bad "A5 trace=$(cut -c1-120 "$TRACE" | tr '\n' ' ') log=$(tr '\n' ' ' <"$WATCH_LOG" | cut -c1-200)"; fi

# A6 live,企微失败:落 spool(pending=wecom);恢复后 --flush 送达并清掉。
setup a6; conf "WATCH_ALERT_MODE=live" "WATCH_ALERT_WECOM_KEY=$KEY"
export CURL_RC=7
send --event tier2_restored --severity critical --message x
s="$(find "$C/state/alert-spool" -maxdepth 1 -name '*.json' | head -n1)"
p0="$(jq -c '[.pending, .attempts]' "$s" 2>/dev/null || echo none)"
send --flush
p1="$(jq -c '[.pending, .attempts]' "$s" 2>/dev/null || echo none)"
send --flush
p2="$(jq -c '[.pending, .attempts]' "$s" 2>/dev/null || echo none)"
export CURL_RC=0
send --flush
if [[ "$p0" == '[["wecom","db"],0]' && "$p1" == '[["wecom"],1]' && "$p2" == '[["wecom"],2]' \
  && "$(nfiles "$C/state/alert-spool")" == 0 && "$(stat -c %a "$C/state/alert-spool")" == 700 ]] && ! secret_leaked; then
  ok "A6 failed wecom spools, flush retries and clears"
else bad "A6 p0=$p0 p1=$p1 p2=$p2 left=$(nfiles "$C/state/alert-spool")"; fi

# A7 live,企微回 errcode≠0 也算失败;库失败独立入 pending。
setup a7; conf "WATCH_ALERT_MODE=live" "WATCH_ALERT_WECOM_KEY=$KEY"
export CURL_RESP='{"errcode":93000,"errmsg":"invalid webhook url"}' PSQL_RC=2
send --event fail_loud --severity critical --message x
send --flush
s="$(find "$C/state/alert-spool" -maxdepth 1 -name '*.json' | head -n1)"
if [[ "$EC" == 0 && "$(jq -c .pending "$s" 2>/dev/null)" == '["wecom","db"]' ]]; then ok "A7 errcode!=0 and db failure both pending"; else bad "A7 $(cat "$s" 2>/dev/null)"; fi

# A8 超过重投上限:转 dead,不再重投。
export WATCH_ALERT_MAX_ATTEMPTS=2
send --flush; send --flush
if [[ "$(nfiles "$C/state/alert-spool")" == 0 && "$(nfiles "$C/state/alert-spool/dead")" == 1 ]] && grep -q 'DEAD id=' "$WATCH_LOG"; then
  ok "A8 exhausted retries move to dead"
else bad "A8 spool=$(nfiles "$C/state/alert-spool") dead=$(nfiles "$C/state/alert-spool/dead")"; fi
unset WATCH_ALERT_MAX_ATTEMPTS; export CURL_RESP='{"errcode":0}' PSQL_RC=0

# A9 live 未配置任何通道:SKIP 不入 spool。
setup a9; conf "WATCH_ALERT_MODE=live"; rm -f "$WATCH_ALERT_DB_ENV"
send --event fail_loud --severity critical --message x
send --flush
if [[ "$EC" == 0 && "$(nfiles "$C/state/alert-spool")" == 0 && "$(grep -c 'SKIP channel=' "$WATCH_LOG")" == 2 ]]; then ok "A9 unconfigured channels skip, no spool"; else bad "A9"; fi

# A10 旧接口:systemd OnFailure 传单元名。
setup a10
send openclaude-v5-selfhost-watch.service
if [[ "$EC" == 0 ]] && jq -e '.event=="watch_unit_failed" and .severity=="critical" and (.message|test("openclaude-v5-selfhost-watch.service"))' "$C"/state/alert-dry/*.json >/dev/null; then
  ok "A10 legacy positional unit maps to watch_unit_failed"
else bad "A10 $OUT"; fi

# A11 参数错误:退出 2,不写记录。
setup a11
send --event x --severity bogus --message m; e1=$EC
send --event x --severity info; e2=$EC
send; e3=$EC
send --status; st="$OUT"
if [[ "$e1" == 2 && "$e2" == 2 && "$e3" == 2 && "$(nfiles "$C/state/alert-dry")" == 0 && "$st" == mode=dry* ]]; then ok "A11 usage errors exit 2; --status works"; else bad "A11 $e1 $e2 $e3 $st"; fi

# A12 收件人可配,但非数字回落 3,不会落到 uid 1。
setup a12; conf "WATCH_ALERT_MODE=live" "WATCH_ALERT_INBOX_UID=abc"
send --event fail_loud --severity critical --message x
send --flush
if grep -q -- '-v uid=3 ' "$TRACE" && ! grep -q -- '-v uid=1 ' "$TRACE"; then ok "A12 invalid inbox uid falls back to 3"; else bad "A12 $(cat "$TRACE")"; fi

# A18 库卡住:入队立即返回;flush 受逐通道超时与总预算约束,记录留在 spool 待下一拍。
setup a18; conf "WATCH_ALERT_MODE=live" "WATCH_ALERT_WECOM_KEY=$KEY"
export PSQL_SLEEP=$STALL_SEC WATCH_ALERT_DB_TIMEOUT_SEC=2 WATCH_ALERT_FLUSH_BUDGET_SEC=1
send --event rollback_start --severity critical --message x
send --event tier1_skipped --severity warning --message y
enq_net="$(grep -cE '^(psql|curl) ' "$TRACE" || true)"
# Keep the first delivery inside the one-second budget; only the next record
# observes time spent in the blocked DB. Real channel timeout/elapsed assertions stay.
export WATCH_ALERT_TEST_CLOCK_BASE="$(/usr/bin/date +%s)" WATCH_ALERT_TEST_CLOCK_COUNTER="$C/clock-count"
printf '0' >"$WATCH_ALERT_TEST_CLOCK_COUNTER"
cat >"$C/bin/date" <<'CLOCK'
#!/usr/bin/env bash
if [[ "$#" == 1 && "$1" == +%s ]]; then
  n="$(cat "$WATCH_ALERT_TEST_CLOCK_COUNTER")"; n=$((n+1))
  printf '%s' "$n" >"$WATCH_ALERT_TEST_CLOCK_COUNTER"
  if ((n <= 2)); then printf '%s\n' "$WATCH_ALERT_TEST_CLOCK_BASE"; else printf '%s\n' "$((WATCH_ALERT_TEST_CLOCK_BASE+2))"; fi
else exec /usr/bin/date "$@"; fi
CLOCK
chmod 0755 "$C/bin/date"
t0=$SECONDS; send --flush; t_flush=$((SECONDS - t0))
left="$({ cat "$C"/state/alert-spool/*.json 2>/dev/null || true; } | jq -sc 'map(.pending) | sort')"
# 入队不碰网络和库;flush 远早于替身睡醒就返回,说明是自己的超时/预算截断的。
if [[ "$enq_net" == 0 && "$t_flush" -lt $((STALL_SEC / 2)) && "$(nfiles "$C/state/alert-spool")" == 2 && "$left" == *'["db"]'* ]] && grep -q 'FLUSH 预算' "$WATCH_LOG"; then
  ok "A18 blocked db: enqueue offline, flush bounded (${t_flush}s), records kept"
else bad "A18 enq_net=$enq_net flush=${t_flush}s left=$left"; fi
unset WATCH_ALERT_DB_TIMEOUT_SEC WATCH_ALERT_FLUSH_BUDGET_SEC; export PSQL_SLEEP=0

# ── 接入看护 ─────────────────────────────────────────────────────────────
wsetup() {
  setup "$1"
  export WATCH_ALERT_BIN="$ALERT" WATCH_RUN_DIR="$C/run" WATCH_STATUS="$C/run/watch-status" WATCH_NOTIFY_STATE="$C/run/notify"
  export WATCH_DISARM="$C/inst/watch-disarmed" WATCH_MANUAL_RECOVERY="$C/rel/.manual-recovery-required" WATCH_MAINT="$C/run/maint"
  export WATCH_GRACE="$C/run/grace" WATCH_LOCK="$C/run/deploy.lock" WATCH_FAIL_COUNT="$C/run/fail-count"
  export WATCH_RELEASES_ROOT="$C/rel" WATCH_RESTORE=/bin/false WATCH_BACKUP_CURRENT="$C/backup" WATCH_INSTALLED_BIN="$C/inst/watch.sh"
  export WATCH_DRY=0 WATCH_SKIP_ACTIONS=1 WATCH_FAIL_THRESHOLD=2 WATCH_NOTIFY_COOLDOWN_SEC=86400 WATCH_REARM_INTERVAL_SEC=0
  export WATCH_STUB_UNIT_MASTER=active WATCH_STUB_UNIT_EGRESS=active WATCH_STUB_MASTER=ok WATCH_STUB_EGRESS=ok
  export WATCH_STUB_MASTER_BODY='{"ok":true,"deps":{"pg":"ok"}}' WATCH_STUB_PG=ok WATCH_STUB_REDIS=ok WATCH_STUB_DOCKER=ok
  # OCV5-444 host_checks: stub the disk and point at a missing backup status, like every other host probe here.
  export WATCH_STUB_DISK_AVAIL_BYTES=$((100 * 1024 * 1024 * 1024)) WATCH_PG_BACKUP_STATUS="$C/no-pg-backup-status.json"
  unset WATCH_STUB_FAIL_LOUD || true
  mkdir -p "$C/run" "$C/inst" "$C/rel"
  cp -- "$WATCH" "$WATCH_INSTALLED_BIN"
}
tick() { set +e; bash "$WATCH" --once >/dev/null 2>&1 </dev/null; TEC=$?; set -e; }
events() { { jq -r .event "$C"/state/alert-dry/*.json 2>/dev/null || true; } | sort | tr '\n' ' '; }

# A13 停用期间变红 → disarmed_red(warning);转绿 → recovered(info)。
wsetup a13; printf 'reason=deps-pg\n' >"$WATCH_DISARM"
export WATCH_STUB_MASTER=down; tick; t1=$TEC
export WATCH_STUB_MASTER=ok; tick; t2=$TEC
if [[ "$t1" == 0 && "$t2" == 0 && "$(events)" == "disarmed_red recovered " ]]; then ok "A13 disarmed red then recovery alert"; else bad "A13 $t1 $t2 [$(events)]"; fi

# A14 FAIL-LOUD → fail_loud;武装后达到阈值 → rollback_start。
wsetup a14; export WATCH_STUB_MASTER=down WATCH_STUB_FAIL_LOUD=schema; tick
ev14="$(events)"
wsetup a14b; export WATCH_STUB_MASTER=down; tick; tick
ev14b="$(events)"
if [[ "$ev14" == "fail_loud " && "$ev14b" == "rollback_failed rollback_start tier1_skipped " ]]; then ok "A14 fail_loud and rollback_start alerts"; else bad "A14 [$ev14] [$ev14b]"; fi
export WATCH_STUB_MASTER=ok

# A15 告警脚本出错不改变看护退出码与判定。
wsetup a15; printf '#!/bin/sh\nexit 9\n' >"$C/bad-alert"; chmod 0755 "$C/bad-alert"; export WATCH_ALERT_BIN="$C/bad-alert"
printf 'reason=deps-pg\n' >"$WATCH_DISARM"; export WATCH_STUB_MASTER=down; tick
if [[ "$TEC" == 0 ]] && grep -q 'WARN 告警脚本返回非 0 event=disarmed_red' "$WATCH_LOG" && grep -q '^health=red' "$WATCH_STATUS"; then
  ok "A15 failing alert script does not change watch outcome"
else bad "A15 ec=$TEC"; fi
export WATCH_STUB_MASTER=ok

# A16 --rearm 成功 → rearmed(info);被拒 → rearm_refused(warning)。
wsetup a16; printf 'reason=deps-pg\n' >"$WATCH_DISARM"
export WATCH_STUB_MASTER=down; set +e; bash "$WATCH" --rearm >/dev/null 2>&1 </dev/null; set -e
export WATCH_STUB_MASTER=ok; set +e; bash "$WATCH" --rearm >/dev/null 2>&1 </dev/null; r=$?; set -e
if [[ "$r" == 0 && "$(events)" == *rearm_refused* && "$(events)" == *rearmed* ]]; then ok "A16 rearm refused/ok alerts"; else bad "A16 r=$r [$(events)]"; fi

# A17 未接入告警(无 WATCH_ALERT_BIN、安装目录无 alert.sh):看护不调用告警,行为不变。
wsetup a17; unset WATCH_ALERT_BIN; printf 'reason=deps-pg\n' >"$WATCH_DISARM"; export WATCH_STUB_MASTER=down; tick
if [[ "$TEC" == 0 && "$(nfiles "$C/state/alert-dry")" == 0 ]] && ! grep -q 'watch-alert' "$WATCH_LOG"; then ok "A17 no alert script → no alert calls"; else bad "A17"; fi
export WATCH_STUB_MASTER=ok

# A19 live 且库卡住:看护仍按时走完两级兜底、写停用标记,告警留在 spool(review r1)。
wsetup a19; conf "WATCH_ALERT_MODE=live" "WATCH_ALERT_WECOM_KEY=$KEY"
# 告警脚本套一层记录:每次调用都要自己返回(有 end 行)。被看护外层 timeout 杀掉就没有 end 行。
cat >"$C/alert-shim" <<S
#!/usr/bin/env bash
printf 'start %s\n' "\$1" >>"$C/alert-calls"
bash "$ALERT" "\$@"; rc=\$?
printf 'end %s rc=%s\n' "\$1" "\$rc" >>"$C/alert-calls"
exit "\$rc"
S
chmod 0755 "$C/alert-shim"; export WATCH_ALERT_BIN="$C/alert-shim"
export PSQL_SLEEP=$STALL_SEC WATCH_ALERT_DB_TIMEOUT_SEC=2 WATCH_ALERT_FLUSH_BUDGET_SEC=3 WATCH_STUB_MASTER=down
t0=$SECONDS; tick; e1=$TEC; tick; e2=$TEC; dt=$((SECONDS - t0))
starts="$(grep -c '^start ' "$C/alert-calls" 2>/dev/null || true)"
ends="$(grep -c '^end .* rc=0$' "$C/alert-calls" 2>/dev/null || true)"
if [[ "$e2" == 1 && -e "$WATCH_DISARM" && "$starts" -ge 2 && "$ends" == "$starts" && "$dt" -lt "$STALL_SEC" ]] \
  && grep -q '两级兜底仍红' "$WATCH_LOG" && [[ "$(nfiles "$C/state/alert-spool")" -ge 1 ]] && ! argv_leaked; then
  ok "A19 blocked alert db cannot stall the watch (${dt}s, ${ends}/${starts} alert calls self-bounded, disarm written, alerts spooled)"
else bad "A19 e1=$e1 e2=$e2 dt=${dt}s calls=${ends}/${starts} disarm=$([[ -e "$WATCH_DISARM" ]] && echo y || echo n) spool=$(nfiles "$C/state/alert-spool")"; fi
unset WATCH_ALERT_BIN
unset WATCH_ALERT_DB_TIMEOUT_SEC WATCH_ALERT_FLUSH_BUDGET_SEC; export PSQL_SLEEP=0 WATCH_STUB_MASTER=ok

echo "ALERT_CASES pass=$pass fail=$fail"
(( fail == 0 )) && echo ALERT_TEST_ALL_PASS
(( fail == 0 ))
