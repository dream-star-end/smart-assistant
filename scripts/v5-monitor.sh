#!/usr/bin/env bash
# v5 监控告警最小集 —— 高频探活(roadmap P0.3)
#
# 干啥(简单粗暴,ops 极简,不引外部监控系统):
#   每 2 分钟(openclaude-v5-monitor.timer)跑一轮检查:
#     1. systemd:deploy_state 派生的 serving A/B master / openclaude-v5-egress 必须 active
#     2. HTTP 探活:全部 serving lane healthz("ok":true + channel=v5)、egress("role":"egress")、
#        公网 Caddy route（v3 已于 2026-07-08 彻底下线，不再有任何 v3 探测项）
#     3. 磁盘 / 与 /var 使用率 >85% 告警;内存 available <10% 告警
#     4. 容器池:运行中的 v5-ccb 必须全部带 managed/channel/uid 身份标签；容量由
#        上面的磁盘与 MemAvailable 检查负责。OC_RUNTIME_IMAGE 指向的镜像必须存在于
#        docker images(防 tag 漂移 → 起容器全挂)
#     5. 宿主结构面(2026-07-26 审计补的三项,见 docs/V5_MONITORING.md):
#        failed_units(任何 systemd 单元 failed —— 整类替代"逐个单元配 OnFailure")、
#        backup_fresh(本地每日备份新鲜度;kl-hk 异地容灾退役后这是唯一数据保护)、
#        mem_oversubscribe(容器 memory limit 合计 / 物理内存 超售倍数)
#     6. 合成旅程/表面探针结果(2026-07-26 批7):probe_turn / probe_e2e / probe_spa /
#        probe_version / probe_channels。探针本体是独立 timer(scripts/v5-probe-run.sh),
#        本脚本**只读**它们写的 $PROBE_DIR/<probe>.json,把 fail / 结果陈旧 / "一直跳过"
#        三种情形接进下面同一套去重+重提+恢复+condition 管道 —— 探针侧绝不另起第二条
#        通知通道(去重、静默、维护窗口这些语义只允许有一份权威)。
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
#   bash scripts/v5-monitor.sh --migrate-obsolete-pool-state
#                                             # 官方安装器专用:仅迁移已确认废弃的 pool 误报状态
#   V5MON_SKIP=pool,image bash ...          # 静默指定检查项(逗号分隔,见文档)
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
# 本地备份根目录(openclaude-v5-backup.service 每日 20:00 UTC 在此建当日子目录)。
# kl-hk 异地容灾 2026-07-26 退役后,这里是**唯一**数据保护面,见 check_backup_fresh。
BACKUP_DIR="${V5MON_BACKUP_DIR:-/var/backups/openclaude-v5}"

V5_HEALTH_URL="${V5MON_V5_URL:-http://127.0.0.1:18790/healthz}"
V5_B_HEALTH_URL="${V5MON_V5_B_URL:-http://127.0.0.1:18795/healthz}"
EGRESS_HEALTH_URL="${V5MON_EGRESS_URL:-http://172.31.0.1:18892/internal/v5/egress-health}"
PUBLIC_HEALTH_URL="${V5MON_PUBLIC_URL:-http://127.0.0.1/healthz}"
MAINTENANCE_FILE="${V5MON_MAINTENANCE_FILE:-/run/openclaude-v5/planned-maintenance.json}"
MAINTENANCE_LOCK="${V5MON_MAINTENANCE_LOCK:-/run/openclaude-v5/planned-maintenance.lock}"
# 门禁豁免债务目录(deploy-v5.sh 的 GATE_WAIVER_DIR 单一权威路径;两侧改动必须同步)。
GATE_WAIVER_DIR="${V5MON_GATE_WAIVER_DIR:-/opt/openclaude/openclaude-v5-releases/.gate-waivers}"
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
BACKUP_MAX_AGE_HOURS=30  # 本地备份最新子目录允许的最大 mtime 年龄(h;备份每日 20:00 UTC,留 6h 余量)
MEM_OVERSUB_MAX_RATIO=1.5  # 容器 memory limit 合计 / 物理内存 的上限倍数
REALERT_SECS=21600     # 坏状态持续时的重复提醒间隔(6h)
CURL_TIMEOUT=5
DS_STEP_CANARY_READY="${DS_STEP_CANARY_READY:-10}"
MAIL_ERR_WINDOW_SECS="${V5MON_MAIL_ERR_WINDOW:-1800}"  # 邮件发送失败回看窗口(30min)
# ── master 日志 lane(2026-07-26 P0:日志类探针的权威源不对称)────────────────
# 背景:mail / client_4xx_storm 两项此前硬编码 A 槽日志 /var/log/openclaude-v5.log,
# 而 openclaude-v5-b.service 明确 `append:/var/log/openclaude-v5-b.log`(实测两文件
# 并存,-b 有 43MB)。check_serving_masters 早就按 deploy_state 派生 serving slot,
# **但日志路径没跟着派生** → 蓝绿切到 B 之后这两项读的是闲置槽的静默旧日志 → 恒判 ok。
# 这两项恰恰是为两起最痛的静默事故补的盲区(Resend 断 24h、/api/media-signed 410×381),
# 等于回归修复本身在一半发布形态下失效。
#
# 收口方式:日志消费统一走 master_log_lanes() —— 取**全部**存在且可读的 master lane
# (A/B),不猜单一路径。三条理由:
#   ① canary step≥10 / finalizing step<6 / aborting step<2 三个窗口里 A、B **同时**
#      在服务真实流量,只读"primary"会漏掉另一条 lane 上的真实失败;
#   ② 两项判据都带时间窗过滤(30min / 10min),闲置槽的陈旧行天然落在窗外 → 读它无害
#      (闲置槽的 unit 已 stop,不再产生新行);
#   ③ 不依赖 deploy_state 可裁决 —— 少一个"状态不可读就瞎了"的失败模式。
# 同时保留硬不变量:若 deploy_state 已裁出 primary slot,而**该 slot 的日志不可读**,
# 判 bad(这正是本次事故的反向守卫:读到的只有闲置槽 = 判定不可信,不许冒充 ok)。
MASTER_LOG_A="${V5MON_MASTER_LOG_A:-${V5MON_MAIL_LOG:-/var/log/openclaude-v5.log}}"
MASTER_LOG_B="${V5MON_MASTER_LOG_B:-/var/log/openclaude-v5-b.log}"
TURN_ERR_WINDOW_SECS="${V5MON_TURN_ERR_WINDOW:-600}"   # turn 失败回看窗口(10min)
TURN_ERR_RATE_PCT="${V5MON_TURN_ERR_RATE_PCT:-20}"     # 非取消终态错误率阈值(%)
TURN_ERR_RATE_MIN_TOTAL="${V5MON_TURN_ERR_RATE_MIN_TOTAL:-10}"  # 最小非取消终态样本
# KP 官方托管浏览器插件版本(= KNOWLEDGE_PLANET_PLUGIN_VERSION;插件 bump 版本时同步本值)。
KP_PLUGIN_VERSION="${V5MON_KP_VERSION:-1.5.0}"
# 客户端 4xx 风暴:同一 clientIp × route 在窗口内 >阈值 次 4xx。背景:2026-07-17 /api/media-signed
# 20min 内 410×381 无人告警。日志消费与 check_mail 同法(grep app 日志 + 解析 "ts")。
CLIENT_4XX_WINDOW_SECS="${V5MON_CLIENT_4XX_WINDOW:-600}"     # 回看窗(10min)
CLIENT_4XX_THRESHOLD="${V5MON_CLIENT_4XX_THRESHOLD:-50}"     # 同 client×route >N 次 4xx = 风暴
CLIENT_4XX_SCAN_LINES="${V5MON_CLIENT_4XX_SCAN_LINES:-8000}" # http_error 回看行数上限(bound 日志扫描)

DRY_RUN=0
MIGRATE_OBSOLETE_POOL_STATE=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  --migrate-obsolete-pool-state) MIGRATE_OBSOLETE_POOL_STATE=1 ;;
  *) echo "未知参数:${1:-}" >&2; exit 2 ;;
esac

NOW="$(date +%s)"
ts() { TZ=Asia/Shanghai date '+%F %T'; }   # 告警/日志统一北京时间
# 兜底通道:全量落 /var/log/openclaude-v5-monitor.log;--dry-run 只打印不落盘
log() {
  if [[ "$MIGRATE_OBSOLETE_POOL_STATE" == 1 ]]; then return 0
  elif [[ "$DRY_RUN" == 1 ]]; then echo "[dry-run] $*"
  else echo "$(ts) $*" >> "$LOG_FILE"
  fi
}

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

# master 日志 lane 解析(见 MASTER_LOG_A/B 处的长注释)。
# 打印每行 "<slot> <path>",只含**存在且可读**的 lane;一个都没有 = 数据源缺失。
master_log_lanes() {
  local slot path
  for slot in A B; do
    case "$slot" in A) path="$MASTER_LOG_A" ;; B) path="$MASTER_LOG_B" ;; esac
    [ -n "$path" ] && [ -r "$path" ] && printf '%s %s\n' "$slot" "$path"
  done
}

# 日志类探针的共同前置:解析 lane 并落 LOG_LANE_PATHS/LOG_LANE_NOTE,或给出 bad 理由。
# 返回 1 = 数据源不可信,调用方必须 record bad(绝不 record ok —— "真的没问题"与
# "我根本没看"必须区分,这是 2026-07-26 审计点名的三处 `record ... ok "(跳过)"`)。
LOG_LANE_PATHS=(); LOG_LANE_NOTE=""; LOG_LANE_ERROR=""
resolve_log_lanes() {
  local lanes slot path
  LOG_LANE_PATHS=(); LOG_LANE_NOTE=""; LOG_LANE_ERROR=""
  lanes="$(master_log_lanes)"
  if [ -z "$lanes" ]; then
    LOG_LANE_ERROR="没有任何可读的 master 日志(A=$MASTER_LOG_A B=$MASTER_LOG_B)—— 数据源缺失,无法判定"
    return 1
  fi
  while read -r slot path; do
    [ -n "$path" ] || continue
    LOG_LANE_PATHS+=("$path")
    LOG_LANE_NOTE+="${LOG_LANE_NOTE:+,}$slot"
  done <<EOF
$lanes
EOF
  # 硬不变量:deploy_state 已裁出 serving primary 时,该 slot 的日志必须真的读到了。
  # 否则说明我们读的只是闲置槽 → 判定不可信(= 2026-07-26 事故的反向守卫)。
  if [ -n "$MON_PRIMARY_SLOT" ] && [[ ",$LOG_LANE_NOTE," != *",$MON_PRIMARY_SLOT,"* ]]; then
    LOG_LANE_ERROR="serving slot=$MON_PRIMARY_SLOT 的 master 日志不可读(只读到 lane=$LOG_LANE_NOTE)—— 读的是闲置槽,判定不可信"
    return 1
  fi
  LOG_LANE_NOTE="lane=$LOG_LANE_NOTE${MON_PRIMARY_SLOT:+ serving=$MON_PRIMARY_SLOT}"
}

# 逐 lane 施加 tail 上限后再拼接。**不能**对拼接流施加 tail:行数多的那条 lane 会把
# 另一条 lane 的近期行整体挤出窗口(实测闲置 B 槽日志 43MB),那就从"没看"变成了
# "看了却没看见" —— 同一类失效换了个面。窗口过滤在下游按行内 ts 做,顺序无关。
grep_lanes_tail() { # <grep-pattern> <tail-n>
  local f hits
  for f in "${LOG_LANE_PATHS[@]}"; do
    hits="$(grep -a -h -e "$1" "$f" 2>/dev/null | tail -n "$2")"
    [ -n "$hits" ] && printf '%s\n' "$hits"
  done
}

check_mail() {
  # 邮件通道:master 日志 30min 窗口内出现 [mail-resend-error] → 告警。
  # 前缀契约 = packages/commercial/src/auth/mail.ts createResendMailer 失败日志,
  # 改前缀两侧必须同步。背景:07-07/07-11 两次 Resend 通道静默断数天,注册
  # 验证码全丢(register 吞错降级),无告警无人知 → 用日志留痕 + 本检查补盲区。
  # 日志按天轮转,跨轮转最多丢一次恢复沿,可接受。
  local recent n last ts_iso ep
  if ! resolve_log_lanes; then record mail bad "邮件通道:${LOG_LANE_ERROR}"; return; fi
  recent="$(grep_lanes_tail '\[mail-resend-error\]' 20)"
  if [ -z "$recent" ]; then record mail ok "邮件通道:无失败记录(${LOG_LANE_NOTE})"; return; fi
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
    record mail bad "邮件发送失败 ${n} 条(${MAIL_ERR_WINDOW_SECS}s 内,注册/找回密码受影响;${LOG_LANE_NOTE}):$(printf '%s' "$last" | tail -c 200)"
  else
    record mail ok "邮件通道:窗口内无失败(${LOG_LANE_NOTE})"
  fi
}

TURN_WINDOW_LOADED=0
TURN_WINDOW_ERROR=""
TURN_WINDOW_SAMPLES=""
TURN_WINDOW_FAILURES=""
TURN_WINDOW_CANCELLATIONS=""
TURN_WINDOW_FRICTIONS=""

load_turn_window_stats() {
  # request_finalize_journal 的 committed/aborted 终态是请求事实源；usage_records
  # 只按 journal.usage_id 补充结算结果。分类语义与 admin/modelOps.ts 保持一致，
  # 用户主动取消单列且不进入故障率分母。turn 主告警和 friction 管道元监控
  # 必须消费同一条 classified 查询，避免分母/窗口/分类各自漂移。
  local row
  [[ "$TURN_WINDOW_LOADED" == 1 ]] && return 0
  [[ "$TURN_WINDOW_LOADED" == -1 ]] && return 1
  if [ -z "$DBURL" ]; then
    TURN_WINDOW_ERROR="$ENV_FILE 里读不到 DATABASE_URL"
    TURN_WINDOW_LOADED=-1
    return 1
  fi
  if ! row="$(psql "$DBURL" -X -v ON_ERROR_STOP=1 -tA -F '|' -c "
    WITH classified AS (
      SELECT CASE
        WHEN (rfj.state='aborted'
               AND rfj.failure_code IN ('CLIENT_ABORT','USER_CANCELLED'))
          OR (rfj.state='committed'
               AND ur.price_snapshot->>'codex_terminal_code'='USER_CANCELLED')
          THEN 'cancelled'
        WHEN rfj.state='committed'
          AND ur.id IS NOT NULL
          AND ur.status='success'
          AND COALESCE(ur.output_tokens,0)>0
          AND COALESCE(ur.price_snapshot->>'codex_status','success')<>'error'
          AND COALESCE(ur.price_snapshot->>'waived','')<>'no_output'
          THEN 'success'
        ELSE 'failure'
      END AS terminal_outcome
      FROM request_finalize_journal rfj
      LEFT JOIN usage_records ur ON ur.id=rfj.usage_id
      WHERE rfj.updated_at > now() - make_interval(secs => ${TURN_ERR_WINDOW_SECS})
        AND rfj.state IN ('committed','aborted')
    ),
    terminal_counts AS (
      SELECT count(*) FILTER (WHERE terminal_outcome IN ('success','failure')) AS samples,
             count(*) FILTER (WHERE terminal_outcome='failure') AS failures,
             count(*) FILTER (WHERE terminal_outcome='cancelled') AS cancellations
      FROM classified
    )
    SELECT samples,failures,cancellations,
           (SELECT count(*) FROM product_friction_events
             WHERE updated_at > now() - make_interval(secs => ${TURN_ERR_WINDOW_SECS})
               AND stage='turn_error' AND outcome='failed') AS frictions
    FROM terminal_counts" 2>&1)"; then
    TURN_WINDOW_ERROR="psql 查询失败:$(echo "$row" | head -c 120)"
    TURN_WINDOW_LOADED=-1
    return 1
  fi
  IFS='|' read -r TURN_WINDOW_SAMPLES TURN_WINDOW_FAILURES \
    TURN_WINDOW_CANCELLATIONS TURN_WINDOW_FRICTIONS <<<"$row"
  if [[ ! "$TURN_WINDOW_SAMPLES" =~ ^[0-9]+$ ||
        ! "$TURN_WINDOW_FAILURES" =~ ^[0-9]+$ ||
        ! "$TURN_WINDOW_CANCELLATIONS" =~ ^[0-9]+$ ||
        ! "$TURN_WINDOW_FRICTIONS" =~ ^[0-9]+$ ]]; then
    TURN_WINDOW_ERROR="查询返回非法行:$(echo "$row" | head -c 120)"
    TURN_WINDOW_LOADED=-1
    return 1
  fi
  TURN_WINDOW_LOADED=1
}

check_turn_failures() {
  # 部署重启窗口由 planned-maintenance marker 静默；除此之外数据源不可读
  # 必须判 bad，绝不能把“没查到”伪装成“没有故障”。
  local pct
  if ! load_turn_window_stats; then
    record turn_failures bad "turn 失败率:${TURN_WINDOW_ERROR} —— 未做任何判定"
    return
  fi
  if [ "$TURN_WINDOW_SAMPLES" -lt "$TURN_ERR_RATE_MIN_TOTAL" ]; then
    record turn_failures ok "turn 失败率:非取消终态 ${TURN_WINDOW_SAMPLES} 轮(<${TURN_ERR_RATE_MIN_TOTAL},样本不足不判),用户取消 ${TURN_WINDOW_CANCELLATIONS}"
    return
  fi
  pct=$(( TURN_WINDOW_FAILURES * 100 / TURN_WINDOW_SAMPLES ))
  if [ "$pct" -ge "$TURN_ERR_RATE_PCT" ]; then
    record turn_failures bad "turn 错误率 ${pct}%(${TURN_WINDOW_FAILURES}/${TURN_WINDOW_SAMPLES},用户取消 ${TURN_WINDOW_CANCELLATIONS},${TURN_ERR_WINDOW_SECS}s 窗,阈值 ${TURN_ERR_RATE_PCT}%)——聊天主链路可能故障"
  else
    record turn_failures ok "turn 错误率 ${pct}%(${TURN_WINDOW_FAILURES}/${TURN_WINDOW_SAMPLES},用户取消 ${TURN_WINDOW_CANCELLATIONS},窗口内未超阈)"
  fi
}

check_friction_pipeline() {
  # 有服务端权威失败却没有任何客户端 turn_error，是上报链路或落库约束
  # 断裂的直接症状。它是 warning，不替代上面的主链路 critical 判定。
  if ! load_turn_window_stats; then
    record friction_pipeline bad "遥测管道:${TURN_WINDOW_ERROR} —— 未做任何判定"
    return
  fi
  if [ "$TURN_WINDOW_FAILURES" -gt 0 ] && [ "$TURN_WINDOW_FRICTIONS" -eq 0 ]; then
    record friction_pipeline bad "遥测管道疑似断裂:窗内服务端失败 ${TURN_WINDOW_FAILURES} 次,product_friction_events 却零条 failed turn_error —— 查 client_friction_persist_failed 的 errorCode/errorConstraint"
  else
    record friction_pipeline ok "遥测管道:服务端失败 ${TURN_WINDOW_FAILURES} / friction failed turn_error ${TURN_WINDOW_FRICTIONS}(窗口内)"
  fi
}

check_kp_plugin() {
  # KP 官方托管浏览器插件"休眠"探针:结构门等价于 seedKnowledgePlanetPlugin 运行时
  # findApprovedKnowledgePlanetPlugin(状态 active + 门未撤 + current_approved 指向已审批&验签&
  # 未吊销的当前版本)。任一不满足 = listing 对用户休眠(门被悄悄关闭/撤下/版本漂移/签名缺失),
  # 用户无法发布到知识星球却全链路健康端点全绿 → 本探针补盲区。仅只读 EXISTS。
  local serving
  if [ -z "$DBURL" ]; then record kp_plugin bad "KP 插件:$ENV_FILE 里读不到 DATABASE_URL —— 未做任何判定"; return; fi
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

check_gate_waivers() {
  # 门禁豁免债务探针(2026-07-26 出口矩阵整改):部署门被 env 显式豁免时,deploy-v5.sh
  # 会在 GATE_WAIVER_DIR 落一个持久 marker。此前这类豁免只在部署输出里 echo 一行就消失,
  # 事后无人知道「上线的这个版本其实没跑过真 turn / 没跑过 E2E 旅程 / 没过计费守恒门」。
  # 本探针让它常驻可见:有未偿还债务 = 现网 active 版本存在未验证面,须尽快补跑门销账。
  local open_keys count
  if [ ! -d "$GATE_WAIVER_DIR" ]; then
    record gate_waivers ok "门禁豁免债务:无(目录不存在)"; return
  fi
  if ! open_keys="$(ls -1 "$GATE_WAIVER_DIR" 2>&1)"; then
    record gate_waivers bad "门禁豁免债务:读 $GATE_WAIVER_DIR 失败:$(echo "$open_keys" | head -c 120)"; return
  fi
  open_keys="$(echo "$open_keys" | tr '\n' ' ' | sed 's/ *$//')"
  if [ -z "$open_keys" ]; then
    record gate_waivers ok "门禁豁免债务:无未偿还项"; return
  fi
  count="$(echo "$open_keys" | wc -w | tr -d ' ')"
  record gate_waivers bad "门禁豁免债务未偿还 ${count} 项:${open_keys} —— 现网 active 版本有未验证的门禁面(真 turn/E2E 旅程/计费守恒等),且下一次普通发布已被阻断;补跑对应门即自动销账"
}

check_client_4xx_storm() {
  # 客户端 4xx 重试风暴:同一 clientIp × route 在窗口内 >阈值 次 4xx。数据源 = 结构化 app 日志
  # (router.ts 每条 HttpError 打 {"msg":"http_error","status":4xx,"route":...,"clientIp":...,"ts":...})。
  # ts 是 ISO8601 UTC(Z),与 date -u 生成的截止串按**字典序**比较即等价于时间比较,免逐行 date -d。
  local cutoff_iso recent top
  if ! resolve_log_lanes; then record client_4xx_storm bad "4xx 风暴:${LOG_LANE_ERROR}"; return; fi
  cutoff_iso="$(date -u -d "@$((NOW - CLIENT_4XX_WINDOW_SECS))" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || echo '')"
  if [ -z "$cutoff_iso" ]; then record client_4xx_storm bad "4xx 风暴:无法计算窗口截止(date 不可用)—— 未做任何判定"; return; fi
  recent="$(grep_lanes_tail '"msg":"http_error"' "$CLIENT_4XX_SCAN_LINES")"
  if [ -z "$recent" ]; then record client_4xx_storm ok "4xx 风暴:窗口内无 http_error(${LOG_LANE_NOTE})"; return; fi
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
    record client_4xx_storm ok "客户端 4xx 风暴:窗口内无单 client×route 超阈(${LOG_LANE_NOTE})"
  fi
}

check_ci_base_red() {
  # canonical 分支 CI 变红(2026-07-26 关掉分支保护 strict 后的配套告警)。
  #
  # 背景:strict=true 要求"分支必须与 base 同步才能合",在多会话并行开发下会让每合
  # 一个 PR 其余全部作废重跑(实测一个 PR 为此白跑 4 轮 CI)。关掉它换来吞吐,代价是
  # 失去"合并前必须与 base 同步"这层保护 —— 两个 PR 各自绿、合起来红的**语义冲突**
  # 会直接进 base。v5-ci.yml 本来就有 push 触发,会在 base 上重跑一轮,缺的只是
  # "跑红了有人知道"这个出口。这项探针就是那个出口。
  #
  # 仓库是 public,GitHub REST 匿名可读(实测 kl-mirror 直连 200),不需要 token。
  # severity=warning:base 红不等于线上挂(线上跑的是已部署 release),但它意味着
  # **下一次发布的源是坏的**,必须在发布前被看见。
  local api out rc conclusion status sha
  api="https://api.github.com/repos/${V5MON_CI_REPO:-dream-star-end/smart-assistant}/actions/runs"
  api="${api}?branch=$(printf '%s' "${V5MON_CI_BRANCH:-feat/v5-aurora-rewrite}" | sed 's|/|%2F|g')&event=push&per_page=1"
  out="$(curl -s -m "${V5MON_CI_TIMEOUT:-15}" -H 'Accept: application/vnd.github+json' "$api" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
    # 取不到 ≠ 没问题。数据源不可用必须自己发声,不能复用 ok(这正是 mail/4xx 探针
    # "日志不可读就 record ok" 的老毛病,别再犯一次)。
    record ci_base_red bad "canonical CI 状态取不到(curl rc=$rc):$(printf '%s' "$out" | head -c 120)"
    return
  fi
  conclusion="$(printf '%s' "$out" | jq -r '.workflow_runs[0].conclusion // ""' 2>/dev/null)"
  status="$(printf '%s' "$out" | jq -r '.workflow_runs[0].status // ""' 2>/dev/null)"
  sha="$(printf '%s' "$out" | jq -r '.workflow_runs[0].head_sha // ""' 2>/dev/null | cut -c1-8)"
  if [ -z "$status" ]; then
    record ci_base_red bad "canonical CI 响应无法解析(jq 取不到 status)"; return
  fi
  if [ "$status" != "completed" ]; then
    record ci_base_red ok "canonical CI 运行中(sha=$sha status=$status)"; return
  fi
  case "$conclusion" in
    success|skipped|neutral)
      record ci_base_red ok "canonical CI 绿(sha=$sha conclusion=$conclusion)" ;;
    "")
      record ci_base_red bad "canonical CI 已结束但无 conclusion(sha=$sha)——状态不可判" ;;
    *)
      record ci_base_red bad "canonical CI 红(sha=$sha conclusion=$conclusion)——base 上的下一次发布源是坏的;strict 已关,语义冲突只能靠这条探针发现" ;;
  esac
}

check_failed_units() {
  # systemd 单元静默失败(整类根治,不是单点补丁)。背景:2026-07-26 审计发现异地容灾
  # v5-dr-sync.service / v5-dr-volumes.service 连败 43 小时无人知晓,根因是这两个单元的
  # `OnFailure=` 是空的(openclaude-v5-backup.service 配了,它们漏了)。逐个单元补
  # OnFailure 只能救已知的那几个,下一个新单元照样漏 —— 所以这里直接把"本机存在任何
  # failed 单元"变成一项探针:新单元零配置自动纳入监控,单元级 OnFailure 退化为加速通道。
  # severity=warning:失败单元 ≠ 全站故障,但必须可见。
  local out rc units n extra
  out="$(systemctl list-units --state=failed --no-legend --no-pager 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    # systemctl 自身不可用(systemd 不在跑/被限权)也是 bad —— 不能静默当"没有失败单元"
    record failed_units bad "systemctl list-units --state=failed 调用失败(rc=$rc):$(echo "$out" | head -c 120)"; return
  fi
  # 输出形如 `● foo.service loaded failed failed Description`(首列是状态圆点,可能缺省)。
  # 严格按"单元名形状"取值:形状不符的行不当作单元名(否则 systemctl 输出变体会天天误报);
  # systemctl 真挂掉的场景已由上面的 rc 分支 fail-loud 覆盖。
  units="$(printf '%s\n' "$out" | awk \
    -v re='^[A-Za-z0-9@:._-]+[.](service|socket|target|timer|path|mount|automount|swap|slice|scope|device)$' '
    NF == 0 { next }
    { u = $1; if (u !~ re) u = $2 }        # 首列是圆点时单元名在第二列(圆点是多字节,不按字符判)
    u ~ re { print u }
  ')"
  n="$(printf '%s' "$units" | grep -c . || true)"
  if [ "${n:-0}" -eq 0 ]; then
    record failed_units ok "systemd 无 failed 单元"
  else
    extra=""; [ "$n" -gt 5 ] && extra=" 等 ${n} 个"
    record failed_units bad "systemd failed 单元 ${n} 个:$(printf '%s' "$units" | head -5 | tr '\n' ' ' | sed 's/ *$//')${extra}(先 journalctl -u <unit> 看根因,再 systemctl reset-failed)"
  fi
}

check_backup_fresh() {
  # 本地备份新鲜度。背景:kl-hk 异地容灾 2026-07-26 退役(单元已归档、复制槽 v5_hk_dr 已 drop),
  # 现在 $BACKUP_DIR 下的每日备份是**唯一**数据保护面 —— 它自己静默停摆就等于零保护,
  # 所以按 critical 报。判据 = 最新子目录 mtime 年龄 ≤ BACKUP_MAX_AGE_HOURS(备份每日
  # 20:00 UTC 跑,30h 阈值容忍一次延迟但抓得住"连续两天没跑")。目录不存在/读不到同样 bad。
  local latest mtime name age_h dr_note
  dr_note="当前无异地容灾(kl-hk 已于 2026-07-26 退役),本地备份是唯一数据保护"
  if [ ! -d "$BACKUP_DIR" ] || [ ! -r "$BACKUP_DIR" ]; then
    record backup_fresh bad "备份目录 $BACKUP_DIR 不存在或不可读 —— ${dr_note}"; return
  fi
  latest="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1)"
  if [ -z "$latest" ]; then
    record backup_fresh bad "备份目录 $BACKUP_DIR 下没有任何备份子目录 —— ${dr_note}"; return
  fi
  mtime="${latest%% *}"; mtime="${mtime%%.*}"; name="$(basename "${latest#* }")"
  if ! [[ "$mtime" =~ ^[0-9]+$ ]]; then
    record backup_fresh bad "备份目录 $BACKUP_DIR 取 mtime 失败:$(echo "$latest" | head -c 120) —— ${dr_note}"; return
  fi
  age_h=$(( (NOW - mtime) / 3600 ))
  if [ "$age_h" -gt "$BACKUP_MAX_AGE_HOURS" ]; then
    record backup_fresh bad "最新备份 ${name} 已 ${age_h}h 未更新(阈值 ${BACKUP_MAX_AGE_HOURS}h,备份每日 20:00 UTC)—— ${dr_note}"
  else
    record backup_fresh ok "最新备份 ${name}(${age_h}h 前;阈值 ${BACKUP_MAX_AGE_HOURS}h)"
  fi
}

check_mem_oversubscribe() {
  # 容器内存超售。背景:2026-07-26 审计实测 24 个容器 × 4GiB limit = 96GiB vs 物理 31GB
  # (5 倍超售)且宿主无 swap —— 平时容器中位只用 236MB 看不出问题,一旦几个容器同时吃满
  # limit 就是宿主级 OOM(内核直接 kill,不挑对象)。check_mem 只看"此刻 available",
  # 看不见这种**结构性**风险,所以单开一项:合计 limit / 物理内存 > 阈值即 bad。
  # limit=0(未设)的容器不计入合计,但同样能吃满物理内存 —— detail 里点名提示。
  # severity=warning:是容量结构预警,不是当下故障。
  local ids limits total mem_kb swap_kb mem_bytes zero_n ratio swap_state
  if ! ids="$(docker ps -q 2>&1)"; then
    record mem_oversubscribe bad "docker ps 失败:$(echo "$ids" | head -c 120)"; return
  fi
  mem_kb="$(awk '/^MemTotal:/{print $2; exit}' "$MEMINFO" 2>/dev/null)"
  swap_kb="$(awk '/^SwapTotal:/{print $2; exit}' "$MEMINFO" 2>/dev/null)"
  if ! [[ "${mem_kb:-}" =~ ^[0-9]+$ ]] || [ "$mem_kb" -le 0 ]; then
    record mem_oversubscribe bad "读 $MEMINFO MemTotal 失败"; return
  fi
  mem_bytes=$(( mem_kb * 1024 ))
  swap_state="无"
  [[ "${swap_kb:-0}" =~ ^[0-9]+$ ]] && [ "${swap_kb:-0}" -gt 0 ] && swap_state="有($(( swap_kb / 1024 ))MiB)"
  if [ -z "$ids" ]; then
    record mem_oversubscribe ok "无运行中容器(limit 合计 0 / 物理 $(awk -v b="$mem_bytes" 'BEGIN{printf "%.1f", b/1073741824}') GiB,swap=${swap_state})"; return
  fi
  # 一次 inspect 传全部容器 ID(严禁在循环里逐个调:24 个容器 = 24 次 docker API 往返,
  # 每 2 分钟一轮的探针不能这么花)。$ids 故意不加引号 —— 需要按行拆成多个参数。
  # shellcheck disable=SC2086
  if ! limits="$(docker inspect --format '{{.HostConfig.Memory}}' $ids 2>&1)"; then
    record mem_oversubscribe bad "docker inspect 取 HostConfig.Memory 失败:$(echo "$limits" | head -c 120)"; return
  fi
  total="$(printf '%s\n' "$limits" | awk '/^[0-9]+$/{s+=$1} END{printf "%.0f", s+0}')"
  zero_n="$(printf '%s\n' "$limits" | awk '/^0$/{n++} END{printf "%d", n+0}')"
  ratio="$(awk -v a="$total" -v b="$mem_bytes" 'BEGIN{printf "%.1f", (b>0 ? a/b : 0)}')"
  local detail
  detail="容器 limit 合计 $(awk -v b="$total" 'BEGIN{printf "%.1f", b/1073741824}') GiB / 物理 $(awk -v b="$mem_bytes" 'BEGIN{printf "%.1f", b/1073741824}') GiB = ${ratio} 倍,swap=${swap_state}"
  [ "${zero_n:-0}" -gt 0 ] && detail="${detail};另有 ${zero_n} 个容器未设 limit(不计入合计但可吃满物理内存)"
  if awk -v a="$total" -v b="$mem_bytes" -v t="$MEM_OVERSUB_MAX_RATIO" 'BEGIN{exit !(b > 0 && a / b > t)}'; then
    record mem_oversubscribe bad "内存超售:${detail}(阈值 ${MEM_OVERSUB_MAX_RATIO} 倍)——并发峰值会触发宿主级 OOM"
  else
    record mem_oversubscribe ok "内存超售:${detail}(阈值 ${MEM_OVERSUB_MAX_RATIO} 倍)"
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
# 本轮裁定出的主 serving slot(A|B;'' = deploy_state 不可裁决)。日志类探针拿它做
# "serving lane 的日志必须真的被读到"这条硬不变量,见 resolve_log_lanes。
MON_PRIMARY_SLOT=""
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
  # 同一份派生结果同时喂给日志类探针(单一权威:serving lane 只在这里裁定一次)。
  MON_PRIMARY_SLOT="$primary"

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
    # backup_fresh = critical:kl-hk 异地容灾 2026-07-26 退役后,本地每日备份是唯一数据
    # 保护面,它停摆 = 数据零保护(且和 mail 一样属于"静默数天才被发现"的历史故障形态)。
    # http_v3 已随 v3 通道彻底下线(2026-07-08)从名单摘除,不再占 critical 位。
    deploy_state|svc_v5|svc_candidate_v5|svc_egress|http_v5|http_candidate_v5|http_egress|public_route|pool|image|mail|turn_failures|backup_fresh) echo critical ;;
    # KP 插件休眠 = 单功能降级(非全站故障);4xx 风暴 = 某客户端×路由静默退化;
    # failed_units = 有单元挂了但不一定影响服务面;mem_oversubscribe = 容量结构预警;
    # 门禁豁免债务 = 已上线版本有未验证面 + 下次发布被阻断,不是全站故障但必须常驻可见。均按 warning。
    disk_root|disk_var|mem|kp_plugin|client_4xx_storm|failed_units|mem_oversubscribe|gate_waivers|ci_base_red|friction_pipeline) echo warning ;;
    *) echo warning ;;
  esac
}

# fan-out 一个事件到 admin_alert_outbox(psql 直插共享 SQL 模板)。
# 失败只记日志,绝不 return 非 0 阻断后续检查项。--dry-run 只打印。
#
# 投递结果如实回报(2026-07-26 P0):共享 SQL 末尾打印 `fanout targets=N inserted=N
# suppressed=N`,本函数据此区分三种结局 —— 此前无论落 0 行还是 N 行都打印 FANOUT-OK,
# 于是 severity=info 的事件(唯一通道 severity_min='warning' → 恒零通道)在推送侧
# 蒸发了整整一个建库周期而日志显示"成功"。targets=0 现在打 FANOUT-ZERO。
fanout_alert() { # <event_type> <severity> <dedupe_key> <title> <body> <payload_json>
  FANOUT_LAST_TARGETS=""   # 调用方可读:''=未执行/不可判,数字=本次匹配到的通道数
  if [ "$DRY_RUN" = 1 ]; then log "FANOUT[dry] $1 sev=$2 dedupe=$3"; return 0; fi
  if [ -z "$DBURL" ]; then log "FANOUT-SKIP 读不到 DATABASE_URL($ENV_FILE) event=$1"; return 0; fi
  if [ ! -f "$FANOUT_SQL" ]; then log "FANOUT-SKIP 找不到 $FANOUT_SQL event=$1"; return 0; fi
  local out targets inserted
  # -tAq:只要那一行结果(无表头/无对齐/无 INSERT 命令标签)。2>&1 让失败原因进 out。
  if ! out="$(psql "$DBURL" -tAq -v ON_ERROR_STOP=1 \
       -v event_type="$1" -v severity="$2" -v dedupe_key="$3" \
       -v title="$4" -v body="$5" -v payload="$6" \
       -f "$FANOUT_SQL" 2>&1)"; then
    log "FANOUT-FAIL $1 sev=$2(outbox 未落,inbox/日志仍有留痕):$(printf '%s' "$out" | tr '\n' ' ' | head -c 160)"
    return 0
  fi
  targets="$(printf '%s' "$out" | sed -n 's/.*fanout targets=\([0-9]\{1,\}\).*/\1/p' | head -1)"
  inserted="$(printf '%s' "$out" | sed -n 's/.*inserted=\([0-9]\{1,\}\).*/\1/p' | head -1)"
  FANOUT_LAST_TARGETS="$targets"
  if [ -z "$targets" ]; then
    # 模板被改/输出形状变了:不能猜成功(那正是本次要根治的"谎报 OK")。
    log "FANOUT-UNKNOWN $1 sev=$2 —— 共享 SQL 未回报投递计数(模板被改?):$(printf '%s' "$out" | tr '\n' ' ' | head -c 160)"
  elif [ "$targets" = 0 ]; then
    log "FANOUT-ZERO $1 sev=$2 —— 零通道订阅(severity 门槛/enabled/activation_status),推送侧收不到;站内信仍有留痕"
  elif [ "${inserted:-0}" = 0 ]; then
    log "FANOUT-DEDUP $1 sev=$2 targets=$targets(全部命中幂等去重,未新建行)"
  else
    log "FANOUT-OK $1 sev=$2 targets=$targets inserted=$inserted"
  fi
}

check_serving_masters
check_service svc_egress openclaude-v5-egress
check_http http_egress "$EGRESS_HEALTH_URL" '.ok == true and .role == "egress"'  "egress health"
check_public_route
check_disk disk_root /
check_disk disk_var  /var
check_mem
check_pool
check_image
check_mail
check_turn_failures
check_friction_pipeline
check_kp_plugin
check_gate_waivers
check_client_4xx_storm
check_ci_base_red
check_failed_units
check_backup_fresh
check_mem_oversubscribe

# ───────────────────────────────────────────────
# 状态对比 → 事件(去重核心)
# ───────────────────────────────────────────────
OLD_STATE='{"checks":{}}'
[ -s "$STATE_FILE" ] && OLD_STATE="$(cat "$STATE_FILE" 2>/dev/null || echo '{"checks":{}}')"
echo "$OLD_STATE" | jq -e . >/dev/null 2>&1 || OLD_STATE='{"checks":{}}'   # 状态文件损坏 → 当首轮

# 官方 host-monitor 安装器的一次性精确迁移。旧 pool 计数阈值曾把健康容器池记成 bad；
# 新语义已改为身份标签 + 磁盘/内存容量。该模式只接受“历史唯一 bad=pool 且本轮所有检查
# 都 ok”，并从同一轮不可变 CHECK_ST 快照直接改状态。它在任何 fanout/condition/inbox
# 分支之前退出，因此不能被当作通用告警静默开关，也不会吞掉并发出现的真实异常。
if [[ "$MIGRATE_OBSOLETE_POOL_STATE" == 1 ]]; then
  current_bad=()
  for name in "${CHECK_NAMES[@]}"; do
    [[ "${CHECK_ST[$name]}" == ok ]] || current_bad+=("$name")
  done
  mapfile -t old_bad < <(jq -r '.checks // {} | to_entries[] | select(.value.status == "bad") | .key' <<<"$OLD_STATE" | sort)
  if [[ "${#current_bad[@]}" != 0 || "${#old_bad[@]}" != 1 || "${old_bad[0]:-}" != pool ]]; then
    printf '拒绝迁移 obsolete pool state:current_bad=[%s] old_bad=[%s]\n' \
      "${current_bad[*]:-}" "${old_bad[*]:-}" >&2
    exit 3
  fi
  mkdir -p "$(dirname "$STATE_FILE")"
  migrated_state="$(jq '.checks.pool = {status:"ok", since:0, last_alert:0}' <<<"$OLD_STATE")"
  state_tmp="$(mktemp "${STATE_FILE}.tmp.XXXXXX")"
  if [[ -f "$STATE_FILE" ]]; then
    chown --reference="$STATE_FILE" "$state_tmp"
    chmod --reference="$STATE_FILE" "$state_tmp"
  else
    chmod 0600 "$state_tmp"
  fi
  printf '%s\n' "$migrated_state" | jq . > "$state_tmp"
  mv "$state_tmp" "$STATE_FILE"
  echo "$(ts) MIGRATION obsolete pool count-threshold state bad→ok (no alert side effects)" >> "$LOG_FILE"
  exit 0
fi

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
    sev="$(check_severity "$name")"
    NEW_STATE="$(echo "$NEW_STATE" | jq --arg k "$name" --arg nonce "$MAINTENANCE_NONCE" \
      --arg severity "$sev" \
      '.checks[$k] = {status:"planned", since:0, last_alert:0, maintenance_nonce:$nonce, severity:$severity}')"
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
      # severity = **被解决的那个告警**的 severity(不是 info)。
      # 2026-07-26 P0:恢复通知此前恒发 info,而线上唯一可投递通道 severity_min='warning'
      # → rank(info)=0 >= 1 恒假 → `ops.monitor_recovered` 建库至今 0 行:值班看到红色
      # 永远等不到绿色。severity 描述的是"这条告警有多重要",而恢复通知属于同一条告警的
      # 收尾(Alertmanager 的 resolved 通知同样沿用原告警的路由标签),因此必须跟随
      # check_severity;区分 firing/resolved 靠 event_type 与 payload.kind,不靠降级 severity。
      sev="$(check_severity "$name")"
      fanout_alert "ops.monitor_recovered" "$sev" \
        "ops.monitor_recovered:${name}:${NOW}" \
        "[v5监控] ${name} 已恢复" \
        "✅ **${name}** 已恢复(异常持续 $(( (NOW - since) / 60 )) 分钟):${detail}" \
        "$(jq -nc --arg c "$name" --arg d "$detail" --arg s "$sev" --arg h "$HOSTFQDN" \
             '{source:"v5-monitor",check:$c,detail:$d,severity:$s,host:$h,kind:"recovered"}')"
    fi
    since=0; last_alert=0
  fi
  sev="$(check_severity "$name")"
  NEW_STATE="$(echo "$NEW_STATE" | jq --arg k "$name" --arg s "$st" --arg severity "$sev" \
    --argjson since "$since" --argjson la "$last_alert" \
    '.checks[$k] = {status:$s, since:$since, last_alert:$la, severity:$severity}')"
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
  for name in "${CHECK_NAMES[@]}"; do
    printf '%-12s %-4s %s [severity=%s]\n' \
      "$name" "${CHECK_ST[$name]}" "${CHECK_DETAIL[$name]}" "$(check_severity "$name")"
  done
else
  mkdir -p "$(dirname "$STATE_FILE")"
  echo "$NEW_STATE" | jq . > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi
exit 0
