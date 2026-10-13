#!/usr/bin/env bash
# selfhost 发布看护告警(OCV5-410)。安装为 /opt/openclaude/v5-selfhost-watch/alert.sh,
# 由部署在 committed 后与 watch.sh 一起原子同步。调用方:
#   watch.sh:   alert.sh --event E --severity critical|warning|info --message M [--live REL]
#   systemd:    alert.sh <failed-unit>      (OnFailure=…-watch-alert@%n,旧接口兼容)
#   watch.sh:   alert.sh --flush            (每拍重投补投队列)
#   人:         alert.sh --status
#
# 模式 WATCH_ALERT_MODE(告警配置文件或环境变量,默认 dry):
#   off  只写看护日志
#   dry  写看护日志 + 把「本会发出的告警」存成 JSON(alert-dry/),不连网、不写库
#   live 企微群机器人 webhook(带外,不依赖 master / PG)+ 站内信与 admin_alert_outbox(同一事务);
#        任一通道失败落 alert-spool/,下一拍 --flush 重投,有次数与时效上限,失败不静默也不阻塞看护。
# 密钥:企微 key 只从 root 0600 配置文件按 KEY=VALUE 解析(不 source),日志只记指纹,绝不打印。
# 退出码:0 已处理(含已落 spool);2 用法错误。投递失败不返回非 0,避免 OnFailure 递归。
set -uo pipefail

ALERT_CONF="${WATCH_ALERT_CONF:-/etc/openclaude/selfhost-watch-alert.env}"
ALERT_DB_ENV="${WATCH_ALERT_DB_ENV:-/etc/openclaude/commercial-v5-selfhost.env}"
ALERT_STATE_DIR="${WATCH_ALERT_STATE_DIR:-/var/lib/openclaude-v5-selfhost-watch}"
ALERT_LOG="${WATCH_LOG:-/var/log/openclaude-v5-selfhost-watch.log}"
ALERT_LIVE_LINK="${WATCH_LIVE:-/opt/openclaude/openclaude-v5-selfhost-live}"
ALERT_WECOM_URL="${WATCH_ALERT_WECOM_URL:-https://qyapi.weixin.qq.com/cgi-bin/webhook/send}"
ALERT_DRY_KEEP="${WATCH_ALERT_DRY_KEEP:-200}"
ALERT_MAX_ATTEMPTS="${WATCH_ALERT_MAX_ATTEMPTS:-50}"
ALERT_MAX_AGE_SEC="${WATCH_ALERT_MAX_AGE_SEC:-86400}"
ALERT_FLUSH_BATCH="${WATCH_ALERT_FLUSH_BATCH:-20}"
SPOOL="$ALERT_STATE_DIR/alert-spool"
DEAD="$ALERT_STATE_DIR/alert-spool/dead"
DRYDIR="$ALERT_STATE_DIR/alert-dry"

alog() {
  mkdir -p -- "$(dirname -- "$ALERT_LOG")" 2>/dev/null || true
  printf '%s watch-alert %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$ALERT_LOG" 2>/dev/null || true
}

# 只认 KEY=VALUE 行;不执行文件内容。
conf_get() { # <file> <key>
  local f="$1" k="$2"
  [[ -f "$f" && ! -L "$f" && -r "$f" ]] || return 1
  sed -n "s/^${k}=//p" "$f" | head -n1 | sed -e 's/^"//' -e 's/"$//'
}

resolve_config() {
  local m
  m="${WATCH_ALERT_MODE:-$(conf_get "$ALERT_CONF" WATCH_ALERT_MODE || true)}"
  case "$m" in
    off | dry | live) ALERT_MODE="$m" ;;
    '') ALERT_MODE=dry ;;
    *)
      alog "WARN 未知 WATCH_ALERT_MODE=$(printf '%s' "$m" | tr -cd 'A-Za-z0-9_-' | cut -c1-20),按 dry 处理"
      ALERT_MODE=dry
      ;;
  esac
  WECOM_KEY="$(conf_get "$ALERT_CONF" WATCH_ALERT_WECOM_KEY || true)"
  INBOX_UID="${WATCH_ALERT_INBOX_UID:-$(conf_get "$ALERT_CONF" WATCH_ALERT_INBOX_UID || true)}"
  [[ "$INBOX_UID" =~ ^[1-9][0-9]*$ ]] || INBOX_UID=3
  if [[ -n "$WECOM_KEY" ]]; then
    local perm
    perm="$(stat -c '%a' "$ALERT_CONF" 2>/dev/null || echo '?')"
    if [[ "$perm" != 600 && "$perm" != 400 ]]; then
      alog "WARN $ALERT_CONF 权限 $perm(应为 600),不使用其中的企微 key"
      WECOM_KEY=""
    fi
  fi
}

key_fp() { [[ -n "$WECOM_KEY" ]] && printf '%s' "$WECOM_KEY" | sha256sum | cut -c1-8 || echo none; }

with_lock() { # <cmd...>  同一时刻只有一个 alert.sh 改 spool / dry 目录
  mkdir -p -- "$ALERT_STATE_DIR" && chmod 0700 "$ALERT_STATE_DIR" 2>/dev/null || true
  (
    flock -w 10 9 || { alog "WARN 告警锁超时,本条只留日志"; exit 0; }
    "$@"
  ) 9>"$ALERT_STATE_DIR/.alert.lock"
}

severity_ok() { case "$1" in critical | warning | info) return 0 ;; *) return 1 ;; esac; }

make_record() { # <event> <severity> <message> <live>
  local host
  host="$(hostname 2>/dev/null || echo unknown)"
  jq -nc --arg id "$(date +%s%N)-$$-${RANDOM}" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg event "$1" --arg severity "$2" --arg message "$3" --arg live "$4" --arg host "$host" \
    '{id:$id, ts:$ts, event:$event, severity:$severity, host:$host, live:$live,
      title:("[selfhost 看护] " + ($severity|ascii_upcase) + " " + $event),
      message:$message, attempts:0, pending:[]}'
}

render_md() { # <record-json>
  jq -r '"**" + .title + "**\n\n" + .message + "\n\n- host: " + .host + "\n- live: " + .live + "\n- time: " + .ts + " (UTC)"' <<<"$1"
}

deliver_wecom() { # <record-json>  0 ok / 1 failed / 3 not configured
  local rec="$1" body resp
  [[ -n "$WECOM_KEY" ]] || return 3
  body="$(jq -nc --arg c "$(render_md "$rec")" '{msgtype:"markdown", markdown:{content:$c}}')"
  # URL 含 key:只传给 curl,不进日志、不进错误输出。
  resp="$(curl -fsS --max-time 5 -H 'Content-Type: application/json' -d "$body" \
    "${ALERT_WECOM_URL}?key=${WECOM_KEY}" 2>/dev/null)" || return 1
  [[ "$(jq -r '.errcode // -1' <<<"$resp" 2>/dev/null)" == 0 ]]
}

deliver_db() { # <record-json>  站内信 + admin_alert_outbox 同一事务。0 ok / 1 failed / 3 not configured
  local rec="$1" dburl level fanout
  dburl="$(conf_get "$ALERT_DB_ENV" DATABASE_URL || true)"
  [[ -n "$dburl" ]] || return 3
  level="$(jq -r 'if .severity=="info" then "info" else "warning" end' <<<"$rec")"
  fanout="$(readlink -f "$ALERT_LIVE_LINK" 2>/dev/null)/scripts/v5-alert-fanout.sql"
  {
    printf '%s\n' 'BEGIN;'
    printf '%s\n' "INSERT INTO inbox_messages (audience, user_id, title, body_md, level, created_by, category, thread_key, source_type)
VALUES ('user', :'uid'::bigint, left(:'title', 200), left(:'body', 16000), :'level', :'uid'::bigint, 'operations', left(:'thread', 160), 'selfhost-watch');"
    if [[ -f "$fanout" ]]; then printf '\\i %s\n' "$fanout"; fi
    printf '%s\n' 'COMMIT;'
  } | psql "$dburl" -X -q -v ON_ERROR_STOP=1 \
    -v uid="$INBOX_UID" -v level="$level" \
    -v title="$(jq -r .title <<<"$rec")" -v body="$(render_md "$rec")" \
    -v thread="selfhost-watch:$(jq -r '.event' <<<"$rec" | tr -cd 'a-z0-9_-')" \
    -v event_type="selfhost.watch.$(jq -r '.event' <<<"$rec" | tr -cd 'a-z0-9_-')" \
    -v severity="$(jq -r .severity <<<"$rec")" \
    -v dedupe_key="selfhost-watch:$(jq -r .id <<<"$rec")" \
    -v body_plain="$(jq -r .message <<<"$rec")" \
    -v payload="$(jq -c '{source:"selfhost-watch", event, severity, host, live}' <<<"$rec")" \
    >/dev/null 2>&1 || return 1
}

# 依次尝试 pending 里的通道;返回剩余未送达的通道 JSON 数组。
try_channels() { # <record-json> <channels-json-array>
  local rec="$1" left='[]' ch rc
  for ch in $(jq -r '.[]' <<<"$2"); do
    case "$ch" in
      wecom) deliver_wecom "$rec"; rc=$? ;;
      db) deliver_db "$rec"; rc=$? ;;
      *) rc=0 ;;
    esac
    case "$rc" in
      0) alog "SENT channel=$ch event=$(jq -r .event <<<"$rec") id=$(jq -r .id <<<"$rec")" ;;
      3) alog "SKIP channel=$ch 未配置 event=$(jq -r .event <<<"$rec")" ;;
      *) left="$(jq -c --arg c "$ch" '. + [$c]' <<<"$left")" ;;
    esac
  done
  printf '%s\n' "$left"
}

spool_write() { # <record-json>
  mkdir -p -- "$SPOOL" && chmod 0700 "$SPOOL" 2>/dev/null || true
  local f tmp
  f="$SPOOL/$(jq -r .id <<<"$1").json"
  tmp="$(mktemp "$SPOOL/.tmp.XXXXXX")" || return 1
  printf '%s\n' "$1" >"$tmp" && chmod 0600 "$tmp" && mv -T -- "$tmp" "$f"
}

do_send() { # <event> <severity> <message> <live>
  local rec left
  rec="$(make_record "$1" "$2" "$3" "$4")"
  alog "$(printf '%s' "$2" | tr a-z A-Z) event=$1 mode=$ALERT_MODE $(printf '%s' "$3" | tr '\n' ' ' | cut -c1-300)"
  case "$ALERT_MODE" in
    off) return 0 ;;
    dry)
      mkdir -p -- "$DRYDIR" && chmod 0700 "$DRYDIR" 2>/dev/null || true
      local tmp
      tmp="$(mktemp "$DRYDIR/.tmp.XXXXXX")" || return 0
      jq -c --arg fp "$(key_fp)" --arg uid "$INBOX_UID" \
        '. + {dry:true, would:{wecom:(if $fp=="none" then "not-configured" else "key:"+$fp end), inbox_uid:($uid|tonumber)}}' \
        <<<"$rec" >"$tmp" && chmod 0600 "$tmp" && mv -T -- "$tmp" "$DRYDIR/$(jq -r .id <<<"$rec").json"
      # 只保留最近 N 条演练记录。
      ls -1t "$DRYDIR"/*.json 2>/dev/null | tail -n +"$((ALERT_DRY_KEEP + 1))" | xargs -r rm -f --
      return 0
      ;;
  esac
  left="$(try_channels "$rec" '["wecom","db"]')"
  if [[ "$left" != '[]' ]]; then
    rec="$(jq -c --argjson p "$left" '.pending=$p | .attempts=1' <<<"$rec")"
    spool_write "$rec" && alog "SPOOL id=$(jq -r .id <<<"$rec") pending=$(jq -r '.pending|join(",")' <<<"$rec")"
  fi
}

do_flush() {
  [[ "$ALERT_MODE" == live ]] || return 0
  [[ -d "$SPOOL" ]] || return 0
  local f rec age left n=0 now
  now="$(date +%s)"
  for f in $(ls -1tr "$SPOOL"/*.json 2>/dev/null); do
    ((n >= ALERT_FLUSH_BATCH)) && break
    n=$((n + 1))
    rec="$(cat "$f" 2>/dev/null)" || continue
    age=$((now - $(stat -c %Y "$f")))
    if ((age > ALERT_MAX_AGE_SEC)) || (($(jq -r '.attempts // 0' <<<"$rec") >= ALERT_MAX_ATTEMPTS)); then
      mkdir -p -- "$DEAD" && mv -T -- "$f" "$DEAD/$(basename -- "$f")"
      alog "DEAD id=$(jq -r .id <<<"$rec") 超过重投上限,保留在 $DEAD"
      continue
    fi
    left="$(try_channels "$rec" "$(jq -c '.pending' <<<"$rec")")"
    if [[ "$left" == '[]' ]]; then
      rm -f -- "$f"
    else
      spool_write "$(jq -c --argjson p "$left" '.pending=$p | .attempts += 1' <<<"$rec")"
    fi
  done
}

do_status() {
  local pending dead dry
  pending="$(ls -1 "$SPOOL"/*.json 2>/dev/null | wc -l)"
  dead="$(ls -1 "$DEAD"/*.json 2>/dev/null | wc -l)"
  dry="$(ls -1 "$DRYDIR"/*.json 2>/dev/null | wc -l)"
  echo "mode=$ALERT_MODE wecom=$([[ -n "$WECOM_KEY" ]] && echo "key:$(key_fp)" || echo not-configured) inbox_uid=$INBOX_UID pending=$pending dead=$dead dry=$dry"
}

main() {
  local event="" severity="" message="" live=""
  resolve_config
  case "${1:-}" in
    --flush) with_lock do_flush; return 0 ;;
    --status) do_status; return 0 ;;
    --event)
      while (($#)); do
        case "$1" in
          --event) event="${2:-}"; shift 2 ;;
          --severity) severity="${2:-}"; shift 2 ;;
          --message) message="${2:-}"; shift 2 ;;
          --live) live="${2:-}"; shift 2 ;;
          *) echo "未知参数: $1" >&2; return 2 ;;
        esac
      done
      ;;
    '' | -*) echo "用法: alert.sh --event E --severity critical|warning|info --message M [--live REL] | --flush | --status | <failed-unit>" >&2; return 2 ;;
    *)
      # systemd OnFailure 旧接口:看护单元本身非 0 退出。
      event=watch_unit_failed
      severity=critical
      message="看护单元 $(printf '%s' "$1" | tr -cd 'A-Za-z0-9@._-') 非 0 退出。查: journalctl -u $(printf '%s' "$1" | tr -cd 'A-Za-z0-9@._-') -n 50"
      ;;
  esac
  event="$(printf '%s' "$event" | tr -cd 'a-z0-9_')"
  [[ -n "$event" && -n "$message" ]] && severity_ok "$severity" || { echo "缺 event/message 或 severity 非法" >&2; return 2; }
  [[ -n "$live" ]] || live="$(readlink -f "$ALERT_LIVE_LINK" 2>/dev/null || echo unknown)"
  with_lock do_send "$event" "$severity" "$message" "$live"
  return 0
}

main "$@"
