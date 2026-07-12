#!/usr/bin/env bash
# v5-deploy-state-smoke.sh — deploy_state CAS + 恢复矩阵**本地真 PG 冒烟**(不碰生产)。
#
# 两部分:
#  A) 库层真 CAS(DS_MODE=local,打本地 PG 专属 schema):seed 读 / 乐观锁 CAS 成功 / 陈旧 CAS 落空 /
#     journal / 完整 canary→promote→finalize 状态机走一遍(逐步 lock_version 单调+回读断言)/ lane_hash。
#  B) 恢复矩阵 dispatch(deploy-v5.sh --recover --dry-run,DRY_DS_* 注入各 (phase,step)):
#     断言 recover() 按 §8 路由到正确动作(dry 全程无 ssh/PG)。
#
# 用法:scripts/v5-deploy-state-smoke.sh
#   env DS_DATABASE_URL 覆盖本地 PG(默认 octest:postgres://test:test@127.0.0.1:55432/openclaude_test)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DS_MODE=local
export DS_DATABASE_URL="${DS_DATABASE_URL:-postgres://test:test@127.0.0.1:55432/openclaude_test}"
SCHEMA="p3_ds_smoke_$$"

# shellcheck source=scripts/v5-deploy-state-lib.sh
source "$SCRIPT_DIR/v5-deploy-state-lib.sh"

PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1" >&2; FAIL=$((FAIL+1)); }
eq()   { if [[ "$2" == "$3" ]]; then ok "$1 ($2)"; else bad "$1: 期望[$3] 实得[$2]"; fi; }
ne()   { if [[ "$2" != "$3" ]]; then ok "$1"; else bad "$1: 不应等于[$3]"; fi; }

cleanup() { psql "$DS_DATABASE_URL" -X -q -c "DROP SCHEMA IF EXISTS $SCHEMA CASCADE;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "══ deploy_state 冒烟(schema=$SCHEMA, db=$DS_DATABASE_URL)══"
# 建专属 schema(不设 search_path;CREATE SCHEMA 与 search_path 无关)
psql "$DS_DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA IF EXISTS $SCHEMA CASCADE; CREATE SCHEMA $SCHEMA;" \
  || { echo "✗ 无法建 schema(PG 不可达?)" >&2; exit 1; }
# 之后所有 psql 经 search_path 落到该 schema(lib 用未限定表名)
export PGOPTIONS="-c search_path=$SCHEMA,public"

echo "── A) 库层真 CAS ──"
ds_bootstrap_local_schema
# T1 seed 读(Agent A 0135:lock_version 从 1 起 CHECK≥1)
ds_load
eq "T1 seed generation" "$DS_generation" "1"
eq "T1 seed phase"      "$DS_phase"      "stable"
eq "T1 seed active"     "$DS_active_slot" "A"
eq "T1 seed lock_version" "$DS_lock_version" "1"

# T2 CAS 成功(lock_version 1→2)+ journal
newlv="$(ds_cas 1 "phase='canary', candidate_slot='B', transition_step=0, operation_id='op-smoke'")"
eq "T2 CAS 成功回传新 lock_version" "$newlv" "2"
ds_journal "op-smoke" 0 "canary-begin"
ds_load
eq "T2 回读 phase" "$DS_phase" "canary"
eq "T2 回读 candidate" "$DS_candidate_slot" "B"
eq "T2 回读 lock_version" "$DS_lock_version" "2"

# T3 陈旧 CAS 落空(用旧 lock_version=1,现已是 2 → 应返回空且状态不变)
lost="$(ds_cas 1 "cohort_percent=99")"
[[ -z "$lost" ]] && ok "T3 陈旧 CAS 返回严格空串(乐观锁生效)" || bad "T3 应返回空串,实得[$lost]"
ds_load
eq "T3 状态未被陈旧 CAS 改动(percent 仍 0)" "$DS_cohort_percent" "0"
eq "T3 lock_version 未变" "$DS_lock_version" "2"

# T4 完整状态机走一遍(canary READY → promote → finalize 七步)
cas_step() { # $1=set_clause ;逐步用当前 DS_lock_version 做 CAS,回读刷新
  local nlv; nlv="$(ds_cas "$DS_lock_version" "$1")"
  [[ -n "$nlv" ]] || { bad "T4 CAS 落空: $1"; return 1; }
  ds_load
}
cas_step "candidate_release='rel-cand', transition_step=1"                                   # canary step1
cas_step "transition_step=2"                                                                  # step2
cas_step "transition_step=3"                                                                  # step3
cas_step "transition_step=4"                                                                  # step4
cas_step "generation=generation+1, cohort_salt='s2', cohort_percent=0, transition_step=$DS_STEP_CANARY_READY"  # READY
eq "T4 canary READY generation" "$DS_generation" "2"
eq "T4 canary READY step" "$DS_transition_step" "10"
cas_step "cohort_percent=25"                                                                  # promote 25
cas_step "cohort_percent=50"                                                                  # promote 50
eq "T4 promote percent" "$DS_cohort_percent" "50"
# finalize 七步
cas_step "phase='finalizing', transition_step=0, operation_id='op-fin'"
cas_step "cohort_percent=100, transition_step=1"
cas_step "transition_step=2"
cas_step "transition_step=3"
cas_step "desired_leader_slot='B', desired_control_slot='B', transition_step=4"
cas_step "transition_step=5"
cas_step "transition_step=6"
cas_step "active_slot='B', active_release=candidate_release, candidate_slot=NULL, candidate_release=NULL, phase='stable', transition_step=0, cohort_percent=0"
eq "T4 finalize 终态 active_slot" "$DS_active_slot" "B"
eq "T4 finalize 终态 phase" "$DS_phase" "stable"
eq "T4 finalize 终态 candidate(NULL→空)" "$DS_candidate_slot" ""
eq "T4 finalize 终态 desired_leader" "$DS_desired_leader_slot" "B"
eq "T4 finalize active_release 翻转" "$DS_active_release" "rel-cand"
# lock_version 单调:seed 0 → 经 2(T2)+15(T4 步)... 只需断言 > 15
[[ "$DS_lock_version" -ge 16 ]] && ok "T4 lock_version 单调递增(=$DS_lock_version)" || bad "T4 lock_version 异常: $DS_lock_version"

# T5 journal 计数(op-fin 应有 0 条——我们只对 op-smoke journal 了一次;此处验 journal 表可写可读)
jc="$(ds_exec <<<"SELECT count(*) FROM deploy_state_journal WHERE operation_id='op-smoke';")"
eq "T5 journal(op-smoke)条数" "$jc" "1"

# T6 lane_hash:确定性 + 值域 + 跨盐变化 + 分布
h1="$(ds_lane_hash saltA 12345)"; h1b="$(ds_lane_hash saltA 12345)"
eq "T6 lane_hash 确定性" "$h1" "$h1b"
[[ "$h1" -ge 0 && "$h1" -le 99 ]] && ok "T6 lane_hash∈[0,99] (=$h1)" || bad "T6 lane_hash 越界: $h1"
h2="$(ds_lane_hash saltB 12345)"
ne "T6 换盐改变 hash(同 rollout 固定盐、跨 rollout 换盐)" "$h2" "$h1"
# 分布:5000 uid 落 <10% 的应≈500(±40%),证明 mod 均匀无系统性偏斜
under=0; for u in $(seq 1 2000); do [[ "$(ds_lane_hash distsalt "$u")" -lt 10 ]] && under=$((under+1)); done
[[ "$under" -ge 140 && "$under" -le 260 ]] && ok "T6 lane_hash 分布合理(<10% 命中 $under/2000≈200)" || bad "T6 分布偏斜: $under/2000"

echo "── B) 恢复矩阵 dispatch(deploy-v5.sh --recover --dry-run × 各 (phase,step))──"
recover_case() { # $1=phase $2=step $3=candidate $4=期望关键字
  local out
  out="$(ALLOW_ANY_BRANCH=1 DRY_DS_PHASE="$1" DRY_DS_STEP="$2" DRY_DS_CANDIDATE="$3" \
        bash "$SCRIPT_DIR/deploy-v5.sh" --recover --dry-run 2>&1 || true)"
  if grep -q -- "$4" <<<"$out"; then ok "recover ($1,step$2) → 命中「$4」"; else bad "recover ($1,step$2) 未命中「$4」;输出:$(echo "$out" | tail -2)"; fi
}
recover_case stable     0 ""  "无需恢复"
recover_case canary     5 B   "canary<READY"
recover_case canary    10 B   "canary≥READY"
recover_case finalizing 0 B   "finalizing 0-1"
recover_case finalizing 2 B   "finalizing 2-3"
recover_case finalizing 4 B   "finalizing 4-5"
recover_case finalizing 6 B   "finalizing 6"
recover_case aborting   2 B   "abort"

echo
echo "══ 冒烟结果:PASS=$PASS FAIL=$FAIL ══"
[[ "$FAIL" == 0 ]] || exit 1
