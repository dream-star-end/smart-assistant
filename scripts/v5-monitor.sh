#!/usr/bin/env bash
# v5 监控告警最小集 —— 高频探活(roadmap P0.3)
#
# 干啥(简单粗暴,ops 极简,不引外部监控系统):
#   每 2 分钟(openclaude-v5-monitor.timer)跑一轮 10 项检查:
#     1. systemd:openclaude-v5 / openclaude-v5-egress 必须 active
#     2. HTTP 探活:v5 healthz("ok":true + channel=v5)、egress("role":"egress")、
#        v3 healthz(同机共库,v3 挂了同样要报)
#     3. 磁盘 / 与 /var 使用率 >85% 告警;内存 available <10% 告警
#     4. 容器池:v5-ccb 容器数 >20 告警(异常暴涨);OC_RUNTIME_IMAGE 指向的镜像
#        必须存在于 docker images(防 tag 漂移 → 起容器全挂)
#   告警去重:状态文件记录每项上次状态,只在翻转(好→坏 / 坏→好=恢复)时发告警,
#   坏状态持续时每 6 小时重复提醒一次。
#
# 告警通道:
#   1. 首选:站内信 —— psql INSERT inbox_messages 单发给 boss(audience='user')
#   2. 兜底:/var/log/openclaude-v5-monitor.log 全量记录(带时间戳,发信失败也有痕)
#
# 用法:
#   bash scripts/v5-monitor.sh              # 正常跑(timer 调用)
#   bash scripts/v5-monitor.sh --dry-run    # 只打印,不写状态、不发站内信
#   V5MON_SKIP=http_v3,pool bash ...        # 静默指定检查项(逗号分隔,见文档)
#
# 详见 docs/V5_MONITORING.md(安装 / 阈值调整 / 静默)。

set -uo pipefail

# ───────────────────────────────────────────────
# 常量(env 可覆盖 —— 仅为本机 mock 测试留口,线上一律用默认值)
# ───────────────────────────────────────────────
# BOSS_UID:告警收件人 = users.id=1(1193355375@qq.com,role=admin,全库最早注册
# 2026-04-20;与 inbox/onboarding.ts resolveSystemAdminId "取最小 admin id" 同一语义)。
# created_by 也用它(inbox_messages.created_by NOT NULL FK users,admin 自发自收)。
BOSS_UID="${V5MON_BOSS_UID:-1}"

ENV_FILE="${V5MON_ENV_FILE:-/etc/openclaude/commercial-v5.env}"
STATE_FILE="${V5MON_STATE_FILE:-/var/lib/openclaude-v5/monitor-state.json}"
LOG_FILE="${V5MON_LOG_FILE:-/var/log/openclaude-v5-monitor.log}"
MEMINFO="${V5MON_MEMINFO:-/proc/meminfo}"

V5_HEALTH_URL="${V5MON_V5_URL:-http://127.0.0.1:18790/healthz}"
EGRESS_HEALTH_URL="${V5MON_EGRESS_URL:-http://172.31.0.1:18892/internal/v5/egress-health}"
V3_HEALTH_URL="${V5MON_V3_URL:-http://127.0.0.1:18789/healthz}"

DISK_MAX_PCT=85        # / 与 /var 使用率上限(%)
MEM_MIN_AVAIL_PCT=10   # MemAvailable/MemTotal 下限(%)
POOL_MAX=20            # v5-ccb 容器数上限(线上稳态 ~1-5,>20 = 回收失灵/被刷)
REALERT_SECS=21600     # 坏状态持续时的重复提醒间隔(6h)
CURL_TIMEOUT=5

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

NOW="$(date +%s)"
ts() { TZ=Asia/Shanghai date '+%F %T'; }   # 告警/日志统一北京时间
# 兜底通道:全量落 /var/log/openclaude-v5-monitor.log;--dry-run 只打印不落盘
log() { if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] $*"; else echo "$(ts) $*" >> "$LOG_FILE"; fi; }

# ───────────────────────────────────────────────
# 检查项(每项:CHECK_ST[name]=ok|bad,CHECK_DETAIL[name]=一句话)
# ───────────────────────────────────────────────
declare -A CHECK_ST CHECK_DETAIL
CHECK_NAMES=()

record() { # record <name> <ok|bad> <detail>
  CHECK_NAMES+=("$1"); CHECK_ST["$1"]="$2"; CHECK_DETAIL["$1"]="$3"
}

check_service() { # <name> <unit>
  local out
  out="$(systemctl is-active "$2" 2>&1)"
  if [ "$out" = "active" ]; then record "$1" ok "$2 active"
  else record "$1" bad "$2 状态=$out(systemctl is-active)"; fi
}

check_http() { # <name> <url> <jq 断言> <人话>
  local body
  if ! body="$(curl -fsS --max-time "$CURL_TIMEOUT" "$2" 2>&1)"; then
    record "$1" bad "$4 curl 失败:$(echo "$body" | head -c 120)"; return
  fi
  if echo "$body" | jq -e "$3" >/dev/null 2>&1; then record "$1" ok "$4 正常"
  else record "$1" bad "$4 响应形状不对:$(echo "$body" | head -c 120)"; fi
}

check_disk() { # <name> <mount>
  local pct
  pct="$(df --output=pcent "$2" 2>/dev/null | tail -1 | tr -dc '0-9')"
  if [ -z "$pct" ]; then record "$1" bad "df $2 取数失败"
  elif [ "$pct" -gt "$DISK_MAX_PCT" ]; then record "$1" bad "$2 磁盘使用率 ${pct}%(阈值 ${DISK_MAX_PCT}%)"
  else record "$1" ok "$2 磁盘 ${pct}%"; fi
}

check_mem() {
  local pct
  pct="$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if(t>0) printf "%d", a*100/t}' "$MEMINFO" 2>/dev/null)"
  if [ -z "$pct" ]; then record mem bad "读 $MEMINFO 失败"
  elif [ "$pct" -lt "$MEM_MIN_AVAIL_PCT" ]; then record mem bad "内存 available 仅 ${pct}%(阈值 ${MEM_MIN_AVAIL_PCT}%)"
  else record mem ok "内存 available ${pct}%"; fi
}

check_pool() {
  local imgs n
  if ! imgs="$(docker ps --format '{{.Image}}' 2>&1)"; then   # docker 挂了 ≠ 容器数 0
    record pool bad "docker ps 失败:$(echo "$imgs" | head -c 120)"; return
  fi
  n="$(echo "$imgs" | grep -c 'v5-ccb' || true)"
  if [ "$n" -gt "$POOL_MAX" ]; then record pool bad "v5-ccb 容器数 ${n}(阈值 ${POOL_MAX})"
  else record pool ok "v5-ccb 容器数 ${n}"; fi
}

check_image() {
  local tag
  tag="$(grep '^OC_RUNTIME_IMAGE=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ -z "$tag" ]; then record image bad "$ENV_FILE 里没有 OC_RUNTIME_IMAGE"; return; fi
  if docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -Fxq "$tag"; then
    record image ok "运行镜像 $tag 存在"
  else
    record image bad "OC_RUNTIME_IMAGE=$tag 不在 docker images 里(tag 漂移,起新容器会挂)"
  fi
}

check_service svc_v5     openclaude-v5
check_service svc_egress openclaude-v5-egress
check_http http_v5     "$V5_HEALTH_URL"     '.ok == true and .channel == "v5"'   "v5 healthz"
check_http http_egress "$EGRESS_HEALTH_URL" '.ok == true and .role == "egress"'  "egress health"
check_http http_v3     "$V3_HEALTH_URL"     '.ok == true'                        "v3 healthz(同机共库)"
check_disk disk_root /
check_disk disk_var  /var
check_mem
check_pool
check_image

# ───────────────────────────────────────────────
# 状态对比 → 事件(去重核心)
# ───────────────────────────────────────────────
OLD_STATE='{"checks":{}}'
[ -s "$STATE_FILE" ] && OLD_STATE="$(cat "$STATE_FILE" 2>/dev/null || echo '{"checks":{}}')"
echo "$OLD_STATE" | jq -e . >/dev/null 2>&1 || OLD_STATE='{"checks":{}}'   # 状态文件损坏 → 当首轮

SKIP=",${V5MON_SKIP:-},"
NEW_STATE='{"checks":{}}'
EVENTS=()          # 本轮要进告警正文的行
HAS_BAD_EVENT=0    # 有新坏/持续坏提醒 → level=warning;纯恢复 → info
BAD_LIST=()        # 当前所有坏项(进日志摘要)

for name in "${CHECK_NAMES[@]}"; do
  st="${CHECK_ST[$name]}"; detail="${CHECK_DETAIL[$name]}"
  case "$SKIP" in *",$name,"*) log "SKIP  $name(V5MON_SKIP)"; continue;; esac
  prev="$(echo "$OLD_STATE" | jq -r --arg k "$name" '.checks[$k].status // "ok"')"
  since="$(echo "$OLD_STATE" | jq -r --arg k "$name" '.checks[$k].since // 0')"
  last_alert="$(echo "$OLD_STATE" | jq -r --arg k "$name" '.checks[$k].last_alert // 0')"

  if [ "$st" = bad ]; then
    BAD_LIST+=("$name")
    if [ "$prev" != bad ]; then                       # 好 → 坏:立即告警
      since="$NOW"; last_alert="$NOW"
      EVENTS+=("❌ **$name** $detail"); HAS_BAD_EVENT=1
    elif [ $((NOW - last_alert)) -ge "$REALERT_SECS" ]; then   # 坏持续 ≥6h:重复提醒
      last_alert="$NOW"
      EVENTS+=("⏰ **$name** 仍异常(自 $(TZ=Asia/Shanghai date -d "@$since" '+%m-%d %H:%M') 起):$detail")
      HAS_BAD_EVENT=1
    fi
  else
    if [ "$prev" = bad ]; then                        # 坏 → 好:恢复告警
      EVENTS+=("✅ **$name** 已恢复(异常持续 $(( (NOW - since) / 60 )) 分钟):$detail")
    fi
    since=0; last_alert=0
  fi
  NEW_STATE="$(echo "$NEW_STATE" | jq --arg k "$name" --arg s "$st" \
    --argjson since "$since" --argjson la "$last_alert" \
    '.checks[$k] = {status:$s, since:$since, last_alert:$la}')"
done

# ───────────────────────────────────────────────
# 落日志(兜底通道:每轮一行摘要;有事件再展开)
# ───────────────────────────────────────────────
if [ "${#BAD_LIST[@]}" -gt 0 ]; then
  log "RUN bad=${#BAD_LIST[@]} [${BAD_LIST[*]}]"
  for name in "${BAD_LIST[@]}"; do log "  BAD $name: ${CHECK_DETAIL[$name]}"; done
else
  log "RUN ok(10 项全过)"
fi

# ───────────────────────────────────────────────
# 发站内信(仅有事件时;--dry-run 只打印)
# ───────────────────────────────────────────────
send_inbox() { # <level> <title> <body>
  local dburl
  dburl="$(grep '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  if [ -z "$dburl" ]; then log "ALERT-FAIL 读不到 DATABASE_URL($ENV_FILE)"; return 1; fi
  if psql "$dburl" -q -v ON_ERROR_STOP=1 \
      -v lvl="$1" -v title="$2" -v body="$3" -v uid="$BOSS_UID" <<'SQL'
INSERT INTO inbox_messages (audience, user_id, title, body_md, level, created_by)
VALUES ('user', :'uid'::bigint, :'title', :'body', :'lvl', :'uid'::bigint);
SQL
  then log "ALERT-SENT [$1] $2"
  else log "ALERT-FAIL 站内信 INSERT 失败(正文已在本日志留痕)[$1] $2"; fi
}

if [ "${#EVENTS[@]}" -gt 0 ]; then
  if [ "$HAS_BAD_EVENT" = 1 ]; then
    LEVEL=warning; TITLE="[v5监控] 异常 ${#BAD_LIST[@]} 项:${BAD_LIST[*]}"
  else
    LEVEL=info; TITLE="[v5监控] 恢复通知"
  fi
  # title ≤200 字符 / body ≤16384 字符(inbox_messages CHECK);head -c 按字节截可能
  # 切半 CJK 产生非法 UTF-8(PG 会拒),iconv -c 丢掉尾部残字节兜底
  TITLE="$(echo "$TITLE" | head -c 190 | iconv -f UTF-8 -t UTF-8 -c)"
  BODY="$(ts) 北京时间,kl-mirror v5 监控:"$'\n\n'
  for e in "${EVENTS[@]}"; do BODY+="- $e"$'\n'; done
  BODY+=$'\n'"(好→坏立即告警;坏持续每 6h 提醒;坏→好发恢复。详见 docs/V5_MONITORING.md)"
  BODY="$(echo "$BODY" | head -c 16000 | iconv -f UTF-8 -t UTF-8 -c)"
  for e in "${EVENTS[@]}"; do log "  EVENT $e"; done
  if [ "$DRY_RUN" = 1 ]; then
    echo "── dry-run:将发送站内信 ─────────────"
    echo "level: $LEVEL"; echo "title: $TITLE"; echo "$BODY"
  else
    send_inbox "$LEVEL" "$TITLE" "$BODY"
  fi
fi

# ───────────────────────────────────────────────
# 写状态(原子;--dry-run 不写)
# ───────────────────────────────────────────────
if [ "$DRY_RUN" = 1 ]; then
  echo "── dry-run:检查结果(状态未写入)─────"
  for name in "${CHECK_NAMES[@]}"; do printf '%-12s %-4s %s\n' "$name" "${CHECK_ST[$name]}" "${CHECK_DETAIL[$name]}"; done
else
  mkdir -p "$(dirname "$STATE_FILE")"
  echo "$NEW_STATE" | jq . > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi
exit 0
