#!/usr/bin/env bash
# v5 监控告警最小集 —— 高频探活(roadmap P0.3)
#
# 干啥(简单粗暴,ops 极简,不引外部监控系统):
#   每 2 分钟(openclaude-v5-monitor.timer)跑一轮检查:
#     1. systemd:deploy_state 派生的 serving A/B master / openclaude-v5-egress 必须 active
#     2. HTTP 探活:全部 serving lane healthz("ok":true + channel=v5)、egress("role":"egress")、
#        公网 Caddy route；v3 已退役，只有 V5MON_CHECK_V3=1 才探测
#     3. 磁盘 / 与 /var 使用率 >85% 告警;内存 available <10% 告警
#     4. 容器池:运行中的 v5-ccb 必须全部带 managed/channel/uid 身份标签；容量由
#        上面的磁盘与 MemAvailable 检查负责。OC_RUNTIME_IMAGE 指向的镜像必须存在于
#        docker images(防 tag 漂移 → 起容器全挂)
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
# ── 自愈检测桥(bash⇄TS 契约,两侧改动必须同步)────────────────────
#   每轮 check 结束后额外把每项检查投影成 alert condition(检测状态单一权威):
#     SELECT write_alert_condition('ops.monitor:<check_name>','probe',<firing>,
#                                  '<level>','<snapshot>'::jsonb, now());
#   契约(对端 = packages/commercial/src/selfheal/conditionKeys.ts):
#     - condition key = `ops.monitor:<check_name>` ↔ conditionKeys.ts 的
#       opsMonitorKey(check);check 名(svc_v5/http_v5/…)即 key 后缀,改名两侧同步。
#     - level ∈ {info,warning,critical}(本脚本经 check_severity 只产出
#       warning|critical;info 保留给恢复语义,函数侧枚举三值)。
#     - snapshot = {"detail":<一句话>,"check":<check_name>}(jq 生成,JSON 转义安全)。
#   激活门 V5MON_CONDITIONS(默认关):非 '1' 时整段 condition 写入完全跳过。
#     读取顺序 = 进程环境变量直接覆盖(测试用)> ENV_FILE 里 V5MON_CONDITIONS=
#     (同 DATABASE_URL 手法;oneshot 每轮重读,改 env 即时生效,无需 reload)。
#   计划维护窗口内由 marker 精确列出的 check 与 V5MON_SKIP 静默项同样跳过
#   condition 写(普通部署默认 master 三项，--egress 可含 egress 两项)。
#   写入失败只 log 不阻断(绝不影响既有 outbox/inbox 告警流程)。
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
V5_B_HEALTH_URL="${V5MON_V5_B_URL:-http://127.0.0.1:18795/healthz}"
EGRESS_HEALTH_URL="${V5MON_EGRESS_URL:-http://172.31.0.1:18892/internal/v5/egress-health}"
V3_HEALTH_URL="${V5MON_V3_URL:-http://127.0.0.1:18789/healthz}"
PUBLIC_HEALTH_URL="${V5MON_PUBLIC_URL:-http://127.0.0.1/healthz}"
MAINTENANCE_FILE="${V5MON_MAINTENANCE_FILE:-/run/openclaude-v5/planned-maintenance.json}"
MAINTENANCE_LOCK="${V5MON_MAINTENANCE_LOCK:-/run/openclaude-v5/planned-maintenance.lock}"
CUTOVER_ROOT="${V5MON_CUTOVER_ROOT:-/var/lib/openclaude-v5/cutovers}"

# 统一告警管道(方案 §2.3-2):除站内信外,发告警时 psql 直插 admin_alert_outbox,
# master 挂掉也照落行,恢复后 dispatcher 补投企微。fan-out 判定复刻 enqueueAlert
# 的 TS 语义,单一 SQL 权威见 scripts/v5-alert-fanout.sql。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FANOUT_SQL="${V5MON_FANOUT_SQL:-$SCRIPT_DIR/v5-alert-fanout.sql}"
# fan-out 专用 DBURL(与 send_inbox 各自独立读,保持既有 inbox 路径行为不变)。
DBURL="$(grep '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
HOSTFQDN="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo unknown)"
# 自愈检测桥激活门(见文件头契约):进程 env 直接覆盖 > ENV_FILE;默认关。
if [ -z "${V5MON_CONDITIONS:-}" ]; then
  V5MON_CONDITIONS="$(grep '^V5MON_CONDITIONS=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
fi

DISK_MAX_PCT=85        # / 与 /var 使用率上限(%)
MEM_MIN_AVAIL_PCT=10   # MemAvailable/MemTotal 下限(%)
REALERT_SECS=21600     # 坏状态持续时的重复提醒间隔(6h)
CURL_TIMEOUT=5
DS_STEP_CANARY_READY="${DS_STEP_CANARY_READY:-10}"
MAIL_ERR_WINDOW_SECS="${V5MON_MAIL_ERR_WINDOW:-1800}"  # 邮件发送失败回看窗口(30min)
MAIL_LOG="${V5MON_MAIL_LOG:-/var/log/openclaude-v5.log}"
TURN_ERR_WINDOW_SECS="${V5MON_TURN_ERR_WINDOW:-600}"   # turn 失败回看窗口(10min)
TURN_ERR_MIN_USERS="${V5MON_TURN_ERR_MIN_USERS:-2}"    # 多用户阈:≥N 个用户同窗失败
TURN_ERR_MIN_EVENTS="${V5MON_TURN_ERR_MIN_EVENTS:-3}"  # 多用户阈:且总失败 ≥N 次
TURN_ERR_SOLO_EVENTS="${V5MON_TURN_ERR_SOLO:-8}"       # 单源阈:单窗总失败 ≥N 次
# KP 官方托管浏览器插件版本(= KNOWLEDGE_PLANET_PLUGIN_VERSION;插件 bump 版本时同步本值)。
KP_PLUGIN_VERSION="${V5MON_KP_VERSION:-1.5.0}"
# 客户端 4xx 风暴:同一 clientIp × route 在窗口内 >阈值 次 4xx。背景:2026-07-17 /api/media-signed
# 20min 内 410×381 无人告警。日志消费与 check_mail 同法(grep app 日志 + 解析 "ts")。
CLIENT_4XX_WINDOW_SECS="${V5MON_CLIENT_4XX_WINDOW:-600}"     # 回看窗(10min)
CLIENT_4XX_THRESHOLD="${V5MON_CLIENT_4XX_THRESHOLD:-50}"     # 同 client×route >N 次 4xx = 风暴
CLIENT_4XX_SCAN_LINES="${V5MON_CLIENT_4XX_SCAN_LINES:-8000}" # http_error 回看行数上限(bound 日志扫描)

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

check_public_route() {
  local body
  if ! body="$(curl -fsS --max-time "$CURL_TIMEOUT" -H 'Host: claudeai.chat' "$PUBLIC_HEALTH_URL" 2>&1)"; then
    record public_route bad "Caddy public route curl 失败:$(echo "$body" | head -c 120)"; return
  fi
  if echo "$body" | jq -e '.ok == true and .channel == "v5"' >/dev/null 2>&1; then
    record public_route ok "Caddy public route → v5 正常"
  else
    record public_route bad "Caddy public route 响应不是 v5/ok:$(echo "$body" | head -c 120)"
  fi
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
  local rows image managed channel uid n=0 invalid=0 detail=""
  if ! rows="$(docker ps --format '{{.Image}}|{{.Label "com.openclaude.v3.managed"}}|{{.Label "com.openclaude.runtime_channel"}}|{{.Label "com.openclaude.v3.uid"}}' 2>&1)"; then
    # docker 挂了 ≠ 容器数 0
    record pool bad "docker ps 失败:$(echo "$rows" | head -c 120)"; return
  fi
  while IFS='|' read -r image managed channel uid; do
    [[ "$image" == *v5-ccb* ]] || continue
    n=$((n+1))
    if [[ "$managed" != 1 || "$channel" != v5 || ! "$uid" =~ ^[1-9][0-9]*$ ]]; then
      invalid=$((invalid+1))
      detail+=" image=${image:-<empty>} managed=${managed:-<empty>} channel=${channel:-<empty>} uid=${uid:-<empty>};"
    fi
  done <<<"$rows"
  if [ "$invalid" -gt 0 ]; then
    record pool bad "${invalid}/${n} 个 v5-ccb 容器身份标签异常:${detail}"
  else
    record pool ok "v5-ccb managed 容器 ${n} 个(容量由 disk/mem 检查判定)"
  fi
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

check_mail() {
  # 邮件通道:master 日志 30min 窗口内出现 [mail-resend-error] → 告警。
  # 前缀契约 = packages/commercial/src/auth/mail.ts createResendMailer 失败日志,
  # 改前缀两侧必须同步。背景:07-07/07-11 两次 Resend 通道静默断数天,注册
  # 验证码全丢(register 吞错降级),无告警无人知 → 用日志留痕 + 本检查补盲区。
  # 日志按天轮转,跨轮转最多丢一次恢复沿,可接受。
  local recent n last ts_iso ep
  if [ ! -r "$MAIL_LOG" ]; then record mail ok "邮件通道:$MAIL_LOG 不可读(跳过)"; return; fi
  recent="$(grep -a '\[mail-resend-error\]' "$MAIL_LOG" 2>/dev/null | tail -20)"
  if [ -z "$recent" ]; then record mail ok "邮件通道:无失败记录"; return; fi
  n=0; last=""
  while IFS= read -r line; do
    ts_iso="$(printf '%s' "$line" | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p')"
    [ -n "$ts_iso" ] || continue
    ep="$(date -d "$ts_iso" +%s 2>/dev/null || echo 0)"
    if [ "$ep" -gt 0 ] && [ $((NOW - ep)) -le "$MAIL_ERR_WINDOW_SECS" ]; then n=$((n+1)); last="$line"; fi
  done <<EOF
$recent
EOF
  if [ "$n" -gt 0 ]; then
    record mail bad "邮件发送失败 ${n} 条(${MAIL_ERR_WINDOW_SECS}s 内,注册/找回密码受影响):$(printf '%s' "$last" | tail -c 200)"
  else
    record mail ok "邮件通道:窗口内无失败"
  fi
}

check_turn_failures() {
  # turn 失败率:product_friction_events 短窗内 stage=turn_error/outcome=failed
  # 聚合超阈值 → 告警。背景:2026-07-17 goal 功能致 codex 引擎无目标会话每轮必挂,
  # 健康端点全绿、无任何 turn 级监控,boss 比平台先发现 → 本检查补盲区。
  # outcome=failed 不含 recovered(用户重试成功即自愈,不算持续故障);
  # 阈值语义:多用户同窗失败 = 平台性故障;单用户刷高量 = 也值得看一眼。
  # 部署重启窗口的瞬时 turn 中断由 planned-maintenance marker 静默(deploy 侧
  # begin_planned_maintenance checks 列表含 turn_failures,两侧同步)。
  local row events users
  if [ -z "$DBURL" ]; then record turn_failures ok "turn 失败率:无 DATABASE_URL(跳过)"; return; fi
  if ! row="$(psql "$DBURL" -X -v ON_ERROR_STOP=1 -tA -F '|' -c \
      "SELECT count(*), count(DISTINCT user_id)
         FROM product_friction_events
        WHERE stage = 'turn_error' AND outcome = 'failed'
          AND updated_at > now() - make_interval(secs => ${TURN_ERR_WINDOW_SECS})" 2>&1)"; then
    record turn_failures bad "turn 失败率:psql 查询失败:$(echo "$row" | head -c 120)"; return
  fi
  IFS='|' read -r events users <<<"$row"
  [[ "$events" =~ ^[0-9]+$ && "$users" =~ ^[0-9]+$ ]] || {
    record turn_failures bad "turn 失败率:查询返回非法行:$(echo "$row" | head -c 120)"; return; }
  if { [ "$users" -ge "$TURN_ERR_MIN_USERS" ] && [ "$events" -ge "$TURN_ERR_MIN_EVENTS" ]; } \
     || [ "$events" -ge "$TURN_ERR_SOLO_EVENTS" ]; then
    record turn_failures bad "turn 失败 ${events} 次/${users} 个用户(${TURN_ERR_WINDOW_SECS}s 窗,阈值 ${TURN_ERR_MIN_USERS}用户×${TURN_ERR_MIN_EVENTS}次 或单源${TURN_ERR_SOLO_EVENTS}次)——聊天主链路可能故障"
  else
    record turn_failures ok "turn 失败率:${events} 次/${users} 用户(窗口内,未超阈)"
  fi
}

check_kp_plugin() {
  # KP 官方托管浏览器插件"休眠"探针:结构门等价于 seedKnowledgePlanetPlugin 运行时
  # findApprovedKnowledgePlanetPlugin(状态 active + 门未撤 + current_approved 指向已审批&验签&
  # 未吊销的当前版本)。任一不满足 = listing 对用户休眠(门被悄悄关闭/撤下/版本漂移/签名缺失),
  # 用户无法发布到知识星球却全链路健康端点全绿 → 本探针补盲区。仅只读 EXISTS。
  local serving
  if [ -z "$DBURL" ]; then record kp_plugin ok "KP 插件:无 DATABASE_URL(跳过)"; return; fi
  if ! serving="$(psql "$DBURL" -X -v ON_ERROR_STOP=1 -tA -c "
    SELECT EXISTS (
      SELECT 1
        FROM marketplace_skill_listings l
        JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
       WHERE l.slug = 'knowledge-planet'
         AND l.kind = 'connector'
         AND l.plugin_type = 'managed-browser'
         AND l.state = 'active'
         AND l.revoked_reason IS NULL
         AND v.version = '${KP_PLUGIN_VERSION}'
         AND v.status = 'approved'
         AND v.review_source = 'platform'
         AND v.security_review_state = 'security_approved'
         AND v.functional_verify_state = 'verified'
         AND v.exec_revoked_at IS NULL
         AND v.exec_contract_hash IS NOT NULL
         AND v.signature IS NOT NULL
         AND v.signature_scheme = 'plugin-v2')" 2>&1)"; then
    record kp_plugin bad "KP 插件:psql 查询失败:$(echo "$serving" | head -c 120)"; return
  fi
  case "$serving" in
    t) record kp_plugin ok "KP 官方插件:已审批且在服务(v${KP_PLUGIN_VERSION}/active/plugin-v2)" ;;
    f) record kp_plugin bad "KP 官方插件休眠:listing 未在服务(门关闭/撤下/无审批当前版本/版本漂移/签名或验证缺失)——用户无法发布到知识星球" ;;
    *) record kp_plugin bad "KP 插件:EXISTS 返回非法值:$(echo "$serving" | head -c 120)" ;;
  esac
}

check_client_4xx_storm() {
  # 客户端 4xx 重试风暴:同一 clientIp × route 在窗口内 >阈值 次 4xx。数据源 = 结构化 app 日志
  # (router.ts 每条 HttpError 打 {"msg":"http_error","status":4xx,"route":...,"clientIp":...,"ts":...})。
  # ts 是 ISO8601 UTC(Z),与 date -u 生成的截止串按**字典序**比较即等价于时间比较,免逐行 date -d。
  local cutoff_iso recent top
  if [ ! -r "$MAIL_LOG" ]; then record client_4xx_storm ok "4xx 风暴:$MAIL_LOG 不可读(跳过)"; return; fi
  cutoff_iso="$(date -u -d "@$((NOW - CLIENT_4XX_WINDOW_SECS))" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || echo '')"
  if [ -z "$cutoff_iso" ]; then record client_4xx_storm ok "4xx 风暴:无法计算窗口截止(跳过)"; return; fi
  recent="$(grep -a '"msg":"http_error"' "$MAIL_LOG" 2>/dev/null | tail -n "$CLIENT_4XX_SCAN_LINES")"
  if [ -z "$recent" ]; then record client_4xx_storm ok "4xx 风暴:窗口内无 http_error"; return; fi
  # awk 分组计数:窗口内 + 4xx,按 clientIp|route 聚合取最大值;超阈打印 "max\tkey\tstatus"。
  top="$(printf '%s\n' "$recent" | awk -v cutoff="$cutoff_iso" -v thr="$CLIENT_4XX_THRESHOLD" '
    {
      ts=""; st=""; rt=""; ip="";
      if (match($0, /"ts":"[^"]+"/))       { ts=substr($0, RSTART+6,  RLENGTH-7)  }
      if (match($0, /"status":[0-9]+/))    { st=substr($0, RSTART+9,  RLENGTH-9)  }
      if (match($0, /"route":"[^"]*"/))    { rt=substr($0, RSTART+9,  RLENGTH-10) }
      if (match($0, /"clientIp":"[^"]*"/)) { ip=substr($0, RSTART+12, RLENGTH-13) }
      if (ts == "" || ts < cutoff) next;
      if (st !~ /^4[0-9][0-9]$/) next;
      if (ip == "") ip="<unknown>"; if (rt == "") rt="<unknown>";
      key=ip "|" rt; c[key]++;
      if (c[key] > max) { max=c[key]; mk=key; mst=st }
    }
    END { if (max+0 >= thr+0) printf "%d\t%s\t%s", max, mk, mst }
  ')"
  if [ -n "$top" ]; then
    local n mk mst
    IFS=$'\t' read -r n mk mst <<<"$top"
    record client_4xx_storm bad "客户端 4xx 风暴:${mk%%|*} 对 ${mk#*|} 在 ${CLIENT_4XX_WINDOW_SECS}s 内 ${n} 次 4xx(样本 status=${mst},阈值 ${CLIENT_4XX_THRESHOLD})——签名过期/权限退化/路由异常无人知(2026-07-17 /api/media-signed 410×381 盲区)"
  else
    record client_4xx_storm ok "客户端 4xx 风暴:窗口内无单 client×route 超阈"
  fi
}

slot_unit() { case "$1" in A) echo openclaude-v5 ;; B) echo openclaude-v5-b ;; *) return 1 ;; esac; }
slot_health_url() { case "$1" in A) echo "$V5_HEALTH_URL" ;; B) echo "$V5_B_HEALTH_URL" ;; *) return 1 ;; esac; }

# deploy_state 是“此刻哪些 master 真正在服务”的唯一权威。监控不再固定盯 A lane：
# - stable / canary<READY:active；canary>=READY:active+candidate
# - finalizing<6:两者；>=6:candidate 已是唯一 serving lane
# - aborting<2:Caddy 尚未确认回旧，两者；>=2:active(old)唯一 serving lane
# PG/状态损坏时绝不猜 A：独立 deploy_state key 告警，generic v5 保留最后已知状态，
# candidate 记 not-serving；绝不把“状态不可读”冒充服务故障触发自动部署修复。
MON_PHASE=""; MON_STEP=""; MON_ACTIVE=""; MON_CANDIDATE=""; MON_STATE_UNAVAILABLE=0
load_serving_state() {
  local row
  [[ -n "$DBURL" ]] || { CHECK_DETAIL[deploy_state_error]="DATABASE_URL missing"; return 1; }
  if ! row="$(psql "$DBURL" -X -v ON_ERROR_STOP=1 -tA -F '|' -c \
      "SELECT phase,transition_step,active_slot,COALESCE(candidate_slot,'') FROM deploy_state WHERE singleton=true" 2>&1)"; then
    CHECK_DETAIL[deploy_state_error]="psql 失败:$(echo "$row" | head -c 120)"; return 1
  fi
  IFS='|' read -r MON_PHASE MON_STEP MON_ACTIVE MON_CANDIDATE extra <<<"$row"
  [[ -z "${extra:-}" && "$MON_PHASE" =~ ^(stable|canary|finalizing|aborting)$ &&
     "$MON_STEP" =~ ^[0-9]+$ && "$MON_ACTIVE" =~ ^[AB]$ &&
     ( -z "$MON_CANDIDATE" || "$MON_CANDIDATE" =~ ^[AB]$ ) &&
     ( -z "$MON_CANDIDATE" || "$MON_CANDIDATE" != "$MON_ACTIVE" ) ]] || {
    CHECK_DETAIL[deploy_state_error]="非法 deploy_state 行:$(echo "$row" | head -c 120)"; return 1; }
  if [[ "$MON_PHASE" == stable ]]; then
    [[ -z "$MON_CANDIDATE" ]] || { CHECK_DETAIL[deploy_state_error]="stable 却有 candidate=$MON_CANDIDATE"; return 1; }
  else
    [[ -n "$MON_CANDIDATE" ]] || { CHECK_DETAIL[deploy_state_error]="$MON_PHASE 缺 candidate"; return 1; }
  fi
}

check_serving_masters() {
  local primary secondary="" unit url
  if ! load_serving_state; then
    local detail="deploy_state 不可裁决:${CHECK_DETAIL[deploy_state_error]}"
    MON_STATE_UNAVAILABLE=1
    # 状态权威不可读 ≠ 已知 serving master 进程/HTTP 故障。用独立、无 auto-repair policy
    # 的 key 告警人工裁决；不要把 svc_v5/http_v5 写 firing 误触发 deploy_v5 自愈。
    record deploy_state bad "$detail"
    record svc_candidate_v5 ok "candidate not-serving(state unavailable)"
    record http_candidate_v5 ok "candidate not-serving(state unavailable)"
    return 0
  fi

  primary="$MON_ACTIVE"
  case "$MON_PHASE:$MON_STEP" in
    canary:*)
      (( MON_STEP >= DS_STEP_CANARY_READY )) && secondary="$MON_CANDIDATE" ;;
    finalizing:*)
      if (( MON_STEP >= 6 )); then primary="$MON_CANDIDATE"; else secondary="$MON_CANDIDATE"; fi ;;
    aborting:*)
      (( MON_STEP < 2 )) && secondary="$MON_CANDIDATE" ;;
  esac

  unit="$(slot_unit "$primary")"; url="$(slot_health_url "$primary")"
  check_service svc_v5 "$unit"
  CHECK_DETAIL[svc_v5]="serving slot=$primary phase=$MON_PHASE step=$MON_STEP; ${CHECK_DETAIL[svc_v5]}"
  check_http http_v5 "$url" '.ok == true and .channel == "v5"' "serving slot=$primary healthz"

  if [[ -n "$secondary" ]]; then
    unit="$(slot_unit "$secondary")"; url="$(slot_health_url "$secondary")"
    check_service svc_candidate_v5 "$unit"
    CHECK_DETAIL[svc_candidate_v5]="serving candidate=$secondary phase=$MON_PHASE step=$MON_STEP; ${CHECK_DETAIL[svc_candidate_v5]}"
    check_http http_candidate_v5 "$url" '.ok == true and .channel == "v5"' "serving candidate=$secondary healthz"
  else
    record svc_candidate_v5 ok "candidate not-serving(phase=$MON_PHASE step=$MON_STEP primary=$primary)"
    record http_candidate_v5 ok "candidate not-serving(phase=$MON_PHASE step=$MON_STEP primary=$primary)"
  fi
}

# 检查项 → 告警 severity(方案 §2.3-2):服务/HTTP/公网/池/镜像 = critical(聊天全挂),
# 磁盘/内存 = warning(容量预警,尚未致命)。未知项保守按 warning。
# mail = critical:注册/找回密码链路对新用户等同全挂,且历史上两次静默断数天。
check_severity() {
  case "$1" in
    deploy_state|svc_v5|svc_candidate_v5|svc_egress|http_v5|http_candidate_v5|http_egress|http_v3|public_route|pool|image|mail|turn_failures) echo critical ;;
    # KP 插件休眠 = 单功能降级(非全站故障);4xx 风暴 = 某客户端×路由静默退化。均按 warning。
    disk_root|disk_var|mem|kp_plugin|client_4xx_storm) echo warning ;;
    *) echo warning ;;
  esac
}

# fan-out 一个事件到 admin_alert_outbox(psql 直插共享 SQL 模板)。
# 失败只记日志,绝不 return 非 0 阻断后续检查项。--dry-run 只打印。
fanout_alert() { # <event_type> <severity> <dedupe_key> <title> <body> <payload_json>
  if [ "$DRY_RUN" = 1 ]; then log "FANOUT[dry] $1 sev=$2 dedupe=$3"; return 0; fi
  if [ -z "$DBURL" ]; then log "FANOUT-SKIP 读不到 DATABASE_URL($ENV_FILE) event=$1"; return 0; fi
  if [ ! -f "$FANOUT_SQL" ]; then log "FANOUT-SKIP 找不到 $FANOUT_SQL event=$1"; return 0; fi
  if psql "$DBURL" -q -v ON_ERROR_STOP=1 \
       -v event_type="$1" -v severity="$2" -v dedupe_key="$3" \
       -v title="$4" -v body="$5" -v payload="$6" \
       -f "$FANOUT_SQL" >/dev/null 2>&1; then
    log "FANOUT-OK $1 sev=$2"
  else
    log "FANOUT-FAIL $1 sev=$2(outbox 未落,inbox/日志仍有留痕)"
  fi
}

check_serving_masters
check_service svc_egress openclaude-v5-egress
check_http http_egress "$EGRESS_HEALTH_URL" '.ok == true and .role == "egress"'  "egress health"
check_public_route
if [[ "${V5MON_CHECK_V3:-0}" == 1 ]]; then
  check_http http_v3 "$V3_HEALTH_URL" '.ok == true' "v3 healthz(显式启用)"
fi
check_disk disk_root /
check_disk disk_var  /var
check_mem
check_pool
check_image
check_mail
check_turn_failures
check_kp_plugin
check_client_4xx_storm

# ───────────────────────────────────────────────
# 状态对比 → 事件(去重核心)
# ───────────────────────────────────────────────
OLD_STATE='{"checks":{}}'
[ -s "$STATE_FILE" ] && OLD_STATE="$(cat "$STATE_FILE" 2>/dev/null || echo '{"checks":{}}')"
echo "$OLD_STATE" | jq -e . >/dev/null 2>&1 || OLD_STATE='{"checks":{}}'   # 状态文件损坏 → 当首轮

SKIP=",${V5MON_SKIP:-},"
NEW_STATE='{"checks":{}}'
# deploy_state 本轮不可裁决时，generic serving 两项没有新证据：保留上轮最后已知状态，
# 既不误报 firing，也不把历史诊断抹掉。其余本轮实际检查仍按下方结果覆盖。
if [[ "$MON_STATE_UNAVAILABLE" == 1 ]]; then
  NEW_STATE="$(echo "$OLD_STATE" | jq '{checks: ((.checks // {}) | with_entries(select(.key == "svc_v5" or .key == "http_v5")))}')"
fi
EVENTS=()          # 本轮要进告警正文的行
HAS_BAD_EVENT=0    # 有新坏/持续坏提醒 → level=warning;纯恢复 → info
BAD_LIST=()        # 当前所有坏项(进日志摘要)

# Planned maintenance schema=1(offline cutover)固定压 master 三项；schema=2
# (deploy/dist/rollback)只压 writer 在 restart 前即时确认健康并写入 checks 的项。
# 两者都要求 root:root 0600、绑定本机、nonce 合法且未过期；schema=2 额外
# 限死 180s TTL/模式/scope/commit。任何解析、权限或字段问题都 fail-open。
MAINTENANCE_ACTIVE=0
MAINTENANCE_NONCE=""
MAINTENANCE_CHECKS=","
MARKER_PRESENT=0
MARKER_JSON=""
CUTOVER_MANIFEST_JSON=""
CUTOVER_MANIFEST_OWNER=""
CUTOVER_MANIFEST_MODE=""
# 与 deploy/cutover writer 共用锁，锁内一次复制不可变 JSON snapshot；后续所有校验和
# 字段提取只消费该 snapshot，避免“验证旧 marker、读取新 marker”的 TOCTOU。
maintenance_lock_dir="$(dirname "$MAINTENANCE_LOCK")"
if mkdir -p "$maintenance_lock_dir" 2>/dev/null && chmod 700 "$maintenance_lock_dir" 2>/dev/null &&
   touch "$MAINTENANCE_LOCK" 2>/dev/null && chmod 600 "$MAINTENANCE_LOCK" 2>/dev/null &&
   exec 7>"$MAINTENANCE_LOCK" && flock -n -s 7; then
  if [[ -f "$MAINTENANCE_FILE" ]]; then
    marker_owner="$(stat -c '%U:%G' "$MAINTENANCE_FILE" 2>/dev/null || true)"
    marker_mode="$(stat -c '%a' "$MAINTENANCE_FILE" 2>/dev/null || true)"
    MARKER_JSON="$(cat "$MAINTENANCE_FILE" 2>/dev/null || true)"
    MARKER_PRESENT=1
    snapshot_schema="$(jq -r '.schema // 0' <<<"$MARKER_JSON" 2>/dev/null || echo 0)"
    snapshot_nonce="$(jq -r '.nonce // empty' <<<"$MARKER_JSON" 2>/dev/null || true)"
    if [[ "$snapshot_schema" == 1 && "$snapshot_nonce" =~ ^[0-9a-f]{32}$ ]]; then
      cutover_manifest="$CUTOVER_ROOT/$snapshot_nonce/manifest.json"
      if [[ -f "$cutover_manifest" ]]; then
        CUTOVER_MANIFEST_OWNER="$(stat -c '%U:%G' "$cutover_manifest" 2>/dev/null || true)"
        CUTOVER_MANIFEST_MODE="$(stat -c '%a' "$cutover_manifest" 2>/dev/null || true)"
        CUTOVER_MANIFEST_JSON="$(cat "$cutover_manifest" 2>/dev/null || true)"
      fi
    fi
  fi
  flock -u 7
else
  log "WARN cannot snapshot maintenance marker under lock; fail-open to normal alerts"
fi
if [[ "$MARKER_PRESENT" == 1 ]]; then
  marker_schema="$(jq -r '.schema // 0' <<<"$MARKER_JSON" 2>/dev/null || echo 0)"
  if [[ "$marker_owner" == root:root && "$marker_mode" == 600 && "$marker_schema" == 1 &&
        "$CUTOVER_MANIFEST_OWNER" == root:root && "$CUTOVER_MANIFEST_MODE" == 600 ]] &&
     jq -e --arg host "$(hostname -f)" --argjson now "$NOW" '
       .schema == 1 and (.host | type) == "string" and .host == $host and
       (.nonce | type) == "string" and (.nonce | test("^[0-9a-f]{32}$")) and
       (.deadline | type) == "number" and (.deadline | floor) == .deadline and
       .deadline >= $now
     ' <<<"$MARKER_JSON" >/dev/null 2>&1 &&
     jq -e --arg host "$(hostname -f)" --arg nonce "$(jq -r '.nonce' <<<"$MARKER_JSON")" '
       .schema == 1 and .host == $host and .nonce == $nonce
     ' <<<"$CUTOVER_MANIFEST_JSON" >/dev/null 2>&1; then
    MAINTENANCE_ACTIVE=1
    MAINTENANCE_NONCE="$(jq -r '.nonce' <<<"$MARKER_JSON")"
    MAINTENANCE_CHECKS=",svc_v5,http_v5,public_route,"
    marker_deadline="$(jq -r '.deadline' <<<"$MARKER_JSON")"
    log "PLANNED maintenance schema=1 nonce=$MAINTENANCE_NONCE deadline=$marker_deadline checks=svc_v5,http_v5,public_route"
  elif [[ "$marker_owner" == root:root && "$marker_mode" == 600 && "$marker_schema" == 2 ]] &&
       jq -e --arg host "$(hostname -f)" --argjson now "$NOW" '
         .started_at as $started | .deadline as $deadline |
         .schema == 2 and .kind == "deploy" and
         (.host | type) == "string" and .host == $host and
         (.nonce | type) == "string" and (.nonce | test("^[0-9a-f]{32}$")) and
         (.mode | type) == "string" and (.mode == "deploy" or .mode == "dist" or .mode == "rollback") and
         (.target_commit | type) == "string" and (.target_commit | test("^[0-9a-f]{40}$")) and
         ($started | type) == "number" and ($started | floor) == $started and
         ($deadline | type) == "number" and ($deadline | floor) == $deadline and
         $started <= $now and $now <= $deadline and
         ($deadline - $started) >= 1 and ($deadline - $started) <= 180 and
         (.checks | type) == "array" and (.checks | length) > 0 and
         (.checks | unique | length) == (.checks | length) and
         all(.checks[];
           type == "string" and
           (. == "svc_v5" or . == "http_v5" or . == "public_route" or
            . == "svc_egress" or . == "http_egress"))
       ' <<<"$MARKER_JSON" >/dev/null 2>&1; then
    MAINTENANCE_ACTIVE=1
    MAINTENANCE_NONCE="$(jq -r '.nonce' <<<"$MARKER_JSON")"
    MAINTENANCE_CHECKS=",$(jq -r '.checks | join(",")' <<<"$MARKER_JSON"),"
    marker_deadline="$(jq -r '.deadline' <<<"$MARKER_JSON")"
    marker_deploy_mode="$(jq -r '.mode' <<<"$MARKER_JSON")"
    log "PLANNED maintenance schema=2 mode=$marker_deploy_mode nonce=$MAINTENANCE_NONCE deadline=$marker_deadline checks=${MAINTENANCE_CHECKS#,}"
  else
    log "WARN invalid/expired maintenance marker; fail-open to normal alerts"
  fi
fi

maintenance_suppresses() { # <check-name>
  [[ "$MAINTENANCE_ACTIVE" == 1 && "$MAINTENANCE_CHECKS" == *",$1,"* ]]
}

declare -A PLANNED_SUPPRESSED
PLANNED_LIST=()

for name in "${CHECK_NAMES[@]}"; do
  st="${CHECK_ST[$name]}"; detail="${CHECK_DETAIL[$name]}"
  case "$SKIP" in *",$name,"*) log "SKIP  $name(V5MON_SKIP)"; continue;; esac
  prev="$(echo "$OLD_STATE" | jq -r --arg k "$name" '.checks[$k].status // "ok"')"
  since="$(echo "$OLD_STATE" | jq -r --arg k "$name" '.checks[$k].since // 0')"
  last_alert="$(echo "$OLD_STATE" | jq -r --arg k "$name" '.checks[$k].last_alert // 0')"
  # 已有 bad 是部署前真实故障，marker 绝不能把它改写成 planned。schema=2 writer
  # 的即时健康快照是第一道门，这里用上一轮状态做第二道门。
  if maintenance_suppresses "$name" && [[ "$prev" != bad ]]; then
    log "PLANNED $name: $detail"
    PLANNED_SUPPRESSED["$name"]=1
    PLANNED_LIST+=("$name")
    NEW_STATE="$(echo "$NEW_STATE" | jq --arg k "$name" --arg nonce "$MAINTENANCE_NONCE" \
      '.checks[$k] = {status:"planned", since:0, last_alert:0, maintenance_nonce:$nonce}')"
    continue
  fi

  if [ "$st" = bad ]; then
    BAD_LIST+=("$name")
    if [ "$prev" != bad ]; then                       # 好 → 坏:立即告警
      since="$NOW"; last_alert="$NOW"
      EVENTS+=("❌ **$name** $detail"); HAS_BAD_EVENT=1
      sev="$(check_severity "$name")"
      fanout_alert "ops.monitor_check_failed" "$sev" \
        "ops.monitor_check_failed:${name}:${NOW}" \
        "[v5监控] ${name} 异常" \
        "❌ **${name}** ${detail}"$'\n\n'"(kl-mirror v5 高频探活,$(ts) 北京时间)" \
        "$(jq -nc --arg c "$name" --arg d "$detail" --arg s "$sev" --arg h "$HOSTFQDN" \
             '{source:"v5-monitor",check:$c,detail:$d,severity:$s,host:$h,kind:"failed"}')"
    elif [ $((NOW - last_alert)) -ge "$REALERT_SECS" ]; then   # 坏持续 ≥6h:重复提醒
      last_alert="$NOW"
      EVENTS+=("⏰ **$name** 仍异常(自 $(TZ=Asia/Shanghai date -d "@$since" '+%m-%d %H:%M') 起):$detail")
      HAS_BAD_EVENT=1
      sev="$(check_severity "$name")"
      fanout_alert "ops.monitor_check_failed" "$sev" \
        "ops.monitor_check_failed:${name}:${NOW}" \
        "[v5监控] ${name} 仍异常" \
        "⏰ **${name}** 仍异常(自 $(TZ=Asia/Shanghai date -d "@$since" '+%m-%d %H:%M') 起):${detail}" \
        "$(jq -nc --arg c "$name" --arg d "$detail" --arg s "$sev" --arg h "$HOSTFQDN" \
             '{source:"v5-monitor",check:$c,detail:$d,severity:$s,host:$h,kind:"realert"}')"
    fi
  else
    if [ "$prev" = bad ]; then                        # 坏 → 好:恢复告警
      EVENTS+=("✅ **$name** 已恢复(异常持续 $(( (NOW - since) / 60 )) 分钟):$detail")
      fanout_alert "ops.monitor_recovered" "info" \
        "ops.monitor_recovered:${name}:${NOW}" \
        "[v5监控] ${name} 已恢复" \
        "✅ **${name}** 已恢复(异常持续 $(( (NOW - since) / 60 )) 分钟):${detail}" \
        "$(jq -nc --arg c "$name" --arg d "$detail" --arg h "$HOSTFQDN" \
             '{source:"v5-monitor",check:$c,detail:$d,severity:"info",host:$h,kind:"recovered"}')"
    fi
    since=0; last_alert=0
  fi
  NEW_STATE="$(echo "$NEW_STATE" | jq --arg k "$name" --arg s "$st" \
    --argjson since "$since" --argjson la "$last_alert" \
    '.checks[$k] = {status:$s, since:$since, last_alert:$la}')"
done

# ───────────────────────────────────────────────
# 自愈检测桥:每项 check → write_alert_condition(契约见文件头)
# 每轮无论好坏都写(probe 语义:检测状态单一权威,恢复=firing false 由
# reconciler 自动 resolve incident)。单独 mktemp SQL 批量文件 + 一次 psql;
# 任何失败只 log,绝不影响既有 outbox/inbox/状态文件流程。
# ───────────────────────────────────────────────
write_conditions() {
  [ "${V5MON_CONDITIONS:-}" = 1 ] || return 0
  if [ -z "$DBURL" ]; then log "COND-SKIP 读不到 DATABASE_URL($ENV_FILE)"; return 0; fi
  local sqlf name st detail firing sev snap wrote
  sqlf="$(mktemp)" || { log "COND-FAIL mktemp 失败"; return 0; }
  wrote=0
  for name in "${CHECK_NAMES[@]}"; do
    # 与告警流程同一套静默语义:V5MON_SKIP 显式静默 / 本轮实际 planned 的项,
    # 都不投影 condition(部署窗口/静默不误开 incident)。
    case "$SKIP" in *",$name,"*) continue;; esac
    if [[ "${PLANNED_SUPPRESSED[$name]:-0}" == 1 ]]; then
      continue
    fi
    st="${CHECK_ST[$name]}"; detail="${CHECK_DETAIL[$name]}"
    firing=false; [ "$st" = bad ] && firing=true
    sev="$(check_severity "$name")"
    # 双层转义各管一层:jq --arg 负责 JSON 转义(引号/反斜杠),sed 把 SQL 单引号
    # 翻倍(标准字符串字面量转义)→ detail 任意内容安全。
    snap="$(jq -nc --arg d "$detail" --arg c "$name" '{detail:$d,check:$c}' | sed "s/'/''/g")"
    printf "SELECT write_alert_condition('ops.monitor:%s','probe',%s,'%s','%s'::jsonb, now());\n" \
      "$name" "$firing" "$sev" "$snap" >> "$sqlf"
    wrote=$((wrote+1))
  done
  if [ "$wrote" -eq 0 ]; then rm -f "$sqlf"; return 0; fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "── dry-run:将写入 conditions(V5MON_CONDITIONS=1)─────"
    cat "$sqlf"
    rm -f "$sqlf"
    return 0
  fi
  # ON_ERROR_STOP=0:单条失败不拖累其余 condition;连接级失败也只 log(|| true 语义)。
  if psql "$DBURL" -q -v ON_ERROR_STOP=0 -f "$sqlf" >/dev/null 2>&1; then
    log "COND-OK 写入 ${wrote} 项 condition"
  else
    log "COND-FAIL psql 批量写 condition 失败(${wrote} 项;告警主流程不受影响)"
  fi
  rm -f "$sqlf"
  return 0
}
write_conditions || true

# ───────────────────────────────────────────────
# 落日志(兜底通道:每轮一行摘要;有事件再展开)
# ───────────────────────────────────────────────
if [ "${#BAD_LIST[@]}" -gt 0 ]; then
  log "RUN bad=${#BAD_LIST[@]} [${BAD_LIST[*]}]"
  for name in "${BAD_LIST[@]}"; do log "  BAD $name: ${CHECK_DETAIL[$name]}"; done
elif [ "${#PLANNED_LIST[@]}" -gt 0 ]; then
  log "RUN planned=${#PLANNED_LIST[@]} [${PLANNED_LIST[*]}] nonce=$MAINTENANCE_NONCE"
else
  log "RUN ok(${#CHECK_NAMES[@]} 项全过)"
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
