#!/usr/bin/env bash
# v5-baseline-evals-weekly.sh — baseline 技能评测的周期回归管道(systemd timer 入口)。
#
# 每周对全部带 evals 的平台 baseline 技能跑一轮 with/without 评测(canary 账号,
# 平台自担成本,锁 deepseek-v4-pro),结果 JSONL 落 /var/lib/openclaude-v5/baseline-evals/,
# 并与上一轮对比:
#   - 运行失败 / FETCH FAILED / verdict"反而更差" → warning 告警(经 admin_alert_outbox,
#     判定单一 SQL 权威 = scripts/v5-alert-fanout.sql,与 v5-monitor.sh 同一管道);
#   - 任一技能 with 臂通过率较上一轮下降 > 10 个百分点 → warning 告警;
#   - 正常完成 → info 摘要(站内信留痕,不进企微)。
# 与部署解耦:不阻断发版;模型/镜像升级后想立即验证,手动跑
#   run-baseline-skill-evals.sh 即可(用法见该脚本头注释)。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${OC_EVAL_ENV_FILE:-/etc/openclaude/commercial-v5.env}"
FANOUT_SQL="${OC_EVAL_FANOUT_SQL:-$SCRIPT_DIR/v5-alert-fanout.sql}"
HIST_DIR="${OC_EVAL_HIST_DIR:-/var/lib/openclaude-v5/baseline-evals}"
CANARY_PW_FILE="${OC_EVAL_CANARY_PW_FILE:-/root/.secrets/v5-canary.password}"
LOCK_FILE="/var/lock/oc-v5-baseline-evals.lock"
DROP_ALERT_PP="${OC_EVAL_DROP_ALERT_PP:-10}"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

DBURL="$(grep '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"

# 告警管道:与 v5-monitor.sh 的 fanout_alert 同构(psql 直插共享 SQL 模板)。
# 失败只记日志绝不阻断 —— 回归结果本身还有 JSONL + journal 留痕。
# ⚠️ shell fanout 路径没有 TS enqueueAlert 的"零通道→inbox 兜底":info 级匹配不到
# 任何通道(企微 severity_min=warning)会静默零投递,所以站内信必须由 inbox_notice
# 直插(对齐 v5-daily-check.sh 日报惯例,uid=1)。
fanout_alert() { # <event_type> <severity> <dedupe_key> <title> <body> <payload_json>
  if [ -z "$DBURL" ]; then log "FANOUT-SKIP no DATABASE_URL event=$1"; return 0; fi
  if [ ! -f "$FANOUT_SQL" ]; then log "FANOUT-SKIP no $FANOUT_SQL event=$1"; return 0; fi
  if psql "$DBURL" -q -v ON_ERROR_STOP=1 \
       -v event_type="$1" -v severity="$2" -v dedupe_key="$3" \
       -v title="$4" -v body="$5" -v payload="$6" \
       -f "$FANOUT_SQL" >/dev/null 2>&1; then
    log "FANOUT-OK $1 sev=$2"
  else
    log "FANOUT-FAIL $1 sev=$2"
  fi
}

BOSS_UID="${OC_EVAL_BOSS_UID:-1}"
inbox_notice() { # <level info|warning> <title> <body>
  if [ -z "$DBURL" ]; then log "INBOX-SKIP no DATABASE_URL"; return 0; fi
  if psql "$DBURL" -q -v ON_ERROR_STOP=1 \
       -v lvl="$1" -v title="$2" -v body="$3" -v uid="$BOSS_UID" <<'SQL' >/dev/null 2>&1
INSERT INTO inbox_messages (audience, user_id, title, body_md, level, created_by)
VALUES ('user', :'uid'::bigint, :'title', :'body', :'lvl', :'uid'::bigint);
SQL
  then log "INBOX-OK $2"; else log "INBOX-FAIL $2"; fi
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "另一轮 baseline 评测仍在运行(锁被占),本轮跳过"
  exit 0
fi

if [ ! -r "$CANARY_PW_FILE" ]; then
  fanout_alert baseline_evals warning "baseline-evals:cred" \
    "baseline 评测:canary 凭据缺失" \
    "读不到 $CANARY_PW_FILE,周期回归无法运行。重置 canary(uid=247)密码并写入该文件。" '{}'
  inbox_notice warning "baseline 评测:canary 凭据缺失" \
    "读不到 $CANARY_PW_FILE,周期回归无法运行。重置 canary(uid=247)密码并写入该文件。"
  exit 1
fi

mkdir -p "$HIST_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS_FILE="$HIST_DIR/run-$STAMP.jsonl"
PREV_FILE="$(ls -1 "$HIST_DIR"/run-*.jsonl 2>/dev/null | sort | tail -1 || true)"

log "开始周期回归 → $RESULTS_FILE(上一轮:${PREV_FILE:-无})"
OC_EVAL_RESULTS_FILE="$RESULTS_FILE" \
  EMAIL="${OC_EVAL_CANARY_EMAIL:-v5-canary@claudeai.chat}" \
  PASSWORD="$(cat "$CANARY_PW_FILE")" \
  bash "$SCRIPT_DIR/run-baseline-skill-evals.sh" > "$HIST_DIR/run-$STAMP.log" 2>&1
run_rc=$?
touch "$RESULTS_FILE"   # 整轮零产出时也要有空文件:汇总按"空=异常"告警而不是脚本自身炸掉

# 历史保留:近 12 轮(约一季度),旧的清掉。(无匹配时 ls 非零,别让它掀翻汇总路径)
{ ls -1 "$HIST_DIR"/run-*.jsonl 2>/dev/null || true; } | sort | head -n -12 | xargs -r rm -f --
{ ls -1 "$HIST_DIR"/run-*.log 2>/dev/null || true; } | sort | head -n -12 | xargs -r rm -f --

# 汇总 + 与上一轮对比(python 做数值,shell 只搬运)。
summary="$(python3 - "$RESULTS_FILE" "${PREV_FILE:-}" "$DROP_ALERT_PP" <<'PY'
import json, sys

def load(path):
    out = {}
    if not path:
        return out
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                out[r.get('skill', '?')] = r
    except FileNotFoundError:
        pass
    return out

cur, prev = load(sys.argv[1]), load(sys.argv[2] if len(sys.argv) > 2 else '')
drop_pp = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0
problems, lines = [], []
for skill, r in sorted(cur.items()):
    st = r.get('status')
    b = r.get('benchmark') or {}
    pr = b.get('passRate') or {}
    w = pr.get('with')
    wo = pr.get('without')
    fmt = lambda x: f"{round(x * 100)}%" if isinstance(x, (int, float)) else '-'
    lines.append(f"- {skill}: {fmt(wo)}→{fmt(w)} [{st}] {b.get('verdict', '')}")
    if st != 'done':
        problems.append(f"{skill}: 运行未完成(status={st})")
        continue
    if isinstance(w, (int, float)) and isinstance(wo, (int, float)) and w < wo:
        problems.append(f"{skill}: 有技能反而更差({fmt(wo)}→{fmt(w)})")
    pw = ((prev.get(skill) or {}).get('benchmark') or {}).get('passRate', {}).get('with')
    if isinstance(w, (int, float)) and isinstance(pw, (int, float)) and (pw - w) * 100 > drop_pp:
        problems.append(f"{skill}: with 臂较上一轮下降 {round((pw - w) * 100)}pp({fmt(pw)}→{fmt(w)})")
if not cur:
    problems.append('结果文件为空(整轮评测未产出任何记录)')
print(json.dumps({'problems': problems, 'report': '\n'.join(lines)}, ensure_ascii=False))
PY
)"

problems_n="$(echo "$summary" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["problems"]))')"
report="$(echo "$summary" | python3 -c 'import sys,json;print(json.load(sys.stdin)["report"])')"
problems_txt="$(echo "$summary" | python3 -c 'import sys,json;print("\n".join(json.load(sys.stdin)["problems"]))')"

if [ "$run_rc" -ne 0 ] || [ "$problems_n" -gt 0 ]; then
  body="$problems_txt

完整结果:kl-mirror $RESULTS_FILE
$report"
  fanout_alert baseline_evals warning "baseline-evals:$STAMP" \
    "baseline 技能评测回归异常($problems_n 项)" "$body" \
    "{\"rc\":$run_rc,\"problems\":$problems_n}"
  inbox_notice warning "baseline 技能评测回归异常($problems_n 项)" "$body"
  log "回归异常 rc=$run_rc problems=$problems_n"
  # 告警已自行送达 → 单元按"完成职责"退 0;非零留给"没能自行报告"的崩溃/超时,
  # 那才轮到 OnFailure=alert-fail 兜底,避免同一事件双告警。
  exit 0
fi

inbox_notice info "baseline 技能评测周报:全部正常" "$report

结果:kl-mirror $RESULTS_FILE"
log "回归完成,全部正常"
exit 0
