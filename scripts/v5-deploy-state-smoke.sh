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

# A2 原子 CTE:CAS 命中 → journal 恰一行;CAS 落空 → journal 零新增(MINOR:状态-审计原子,单语句 CTE)。
echo "── A2) 原子 CTE:CAS 命中 journal 恰一行 / 落空零行 ──"
ds_load
lv_cte="$DS_lock_version"
eq "T7 前置 op-cte journal=0" "$(ds_exec <<<"SELECT count(*) FROM deploy_state_journal WHERE operation_id='op-cte';")" "0"
hit="$(ds_cas "$lv_cte" "cohort_percent=7" "op-cte" 1 "cte-hit")"
[[ -n "$hit" ]] && ok "T7 CAS 命中回传新 lock_version($hit)" || bad "T7 CAS 命中应回传 lock_version"
eq "T7 命中 → journal 恰 1 行(CTE upd→j 同事务)" "$(ds_exec <<<"SELECT count(*) FROM deploy_state_journal WHERE operation_id='op-cte';")" "1"
# 复用已被消耗的 lv_cte(现已 +1)= 陈旧 → CAS 落空,upd 空 → journal 的 INSERT ... SELECT FROM upd 零行。
lost="$(ds_cas "$lv_cte" "cohort_percent=9" "op-cte" 2 "cte-miss")"
[[ -z "$lost" ]] && ok "T7 陈旧 CAS 落空回严格空串" || bad "T7 陈旧 CAS 应回空,实得[$lost]"
eq "T7 落空 → journal 仍 1 行(零新增,状态-审计原子)" "$(ds_exec <<<"SELECT count(*) FROM deploy_state_journal WHERE operation_id='op-cte';")" "1"

echo "── B) 恢复矩阵 dispatch(deploy-v5.sh --recover --dry-run × 各 (phase,step))──"
# MINOR:不吞退出码(&& rc=0 || rc=$?,非 `|| true`)+ 除路由提示外还断言**真实续作动作**($5:state 终态 CAS /
#        unit 操作),而非仅 grep 提示文字。dry 下 finalize/abort 前滚会跑到终态 commit,可断言其 CAS SET。
recover_case() { # $1=phase $2=step $3=candidate $4=路由提示关键字 [$5=续作终态动作关键字(state/unit)]
  local out rc
  out="$(ALLOW_ANY_BRANCH=1 DRY_DS_PHASE="$1" DRY_DS_STEP="$2" DRY_DS_CANDIDATE="$3" \
        bash "$SCRIPT_DIR/deploy-v5.sh" --recover --dry-run 2>&1)" && rc=0 || rc=$?
  [[ "$rc" == 0 ]] && ok "recover ($1,step$2) 退出码 0(不吞)" || bad "recover ($1,step$2) 退出码=$rc(应 0);尾:$(echo "$out" | tail -3)"
  if grep -q -- "$4" <<<"$out"; then ok "recover ($1,step$2) 路由命中「$4」"; else bad "recover ($1,step$2) 未命中「$4」;尾:$(echo "$out" | tail -3)"; fi
  if [[ -n "${5:-}" ]]; then
    if grep -q -- "$5" <<<"$out"; then ok "recover ($1,step$2) 续作终态动作命中「$5」"; else bad "recover ($1,step$2) 终态动作未命中「$5」;尾:$(echo "$out" | tail -4)"; fi
  fi
}
recover_case stable     0 ""  "无需恢复"
recover_case canary     5 B   "canary<READY"    "phase='stable'"        # 前滚清理 → 回 stable(state 终态)
recover_case canary    10 B   "canary≥READY"    "candidate(B)自检"     # 核验 candidate(unit 状态探活)
recover_case finalizing 0 B   "finalizing 0-1"  "active_slot='B'"       # 前滚 finalize → commit(state 翻转)
recover_case finalizing 2 B   "finalizing 2-3"  "active_slot='B'"
recover_case finalizing 4 B   "finalizing 4-5"  "active_slot='B'"
recover_case finalizing 6 B   "finalizing 6"    "active_slot='B'"
recover_case aborting   2 B   "abort"           "phase='stable'"        # abort 前滚 → commit stable

echo "── C) BLOCKER 4:A→B finalize 后 --rollback dry(断言操作 B slot symlink/unit + state active/previous 对调)──"
rb_out="$(ALLOW_ANY_BRANCH=1 DRY_DS_ACTIVE=B DRY_DS_PREV_RELEASE='/opt/openclaude/openclaude-v5-releases/rel-oldA' \
      bash "$SCRIPT_DIR/deploy-v5.sh" --rollback --dry-run 2>&1)" && rb_rc=0 || rb_rc=$?
[[ "$rb_rc" == 0 ]] && ok "C rollback dry 退出码 0" || bad "C rollback dry 退出码=$rb_rc;尾:$(echo "$rb_out" | tail -4)"
grep -q 'active lane: slot=B' <<<"$rb_out" && ok "C 解析 active slot=B" || bad "C 未解析 active=B;尾:$(echo "$rb_out" | tail -4)"
grep -q '/opt/openclaude/openclaude-v5-b' <<<"$rb_out" && ok "C 操作 B slot symlink(openclaude-v5-b)" || bad "C 未操作 B slot symlink"
grep -q 'openclaude-v5-b.service' <<<"$rb_out" && ok "C restart B slot unit(openclaude-v5-b.service)" || bad "C 未 restart B slot unit"
grep -q 'rel-oldA' <<<"$rb_out" && ok "C 回滚目标=deploy_state.previous_active_release(rel-oldA)" || bad "C 回滚目标未用 previous_active_release"
grep -q '严格 state CAS' <<<"$rb_out" && ok "C state 提交进入严格 CAS/补偿路径" || bad "C 未见严格 state CAS 路径"
grep -qF 'openclaude-v5.service' <<<"$rb_out" && bad "C 误操作 A slot unit openclaude-v5.service(应只碰 B)" || ok "C 未误碰 A slot unit(仅 B)"

echo "── D) 真 PG + fake SSH/systemd:传统激活副作用与补偿行为 ──"
# source 真实 deploy 编排函数但不 dispatch/抢锁；随后用 fake SSH 记录并模拟 symlink/unit。
set -- --dry-run
export V5_DEPLOY_SOURCE_ONLY=1
# shellcheck source=scripts/deploy-v5.sh
source "$SCRIPT_DIR/deploy-v5.sh"
unset V5_DEPLOY_SOURCE_ONLY
DRY=0
FAKE_EFFECT_LOG="/tmp/p3-effects-$$.log"; : > "$FAKE_EFFECT_LOG"
FAKE_CURRENT=""; FAKE_PREV_FILE=""; FAKE_ASSET_FAIL=0; FAKE_SMOKE_FAIL_ONCE=0
run() { :; }
assert_release_capability_for_sessions_pg() { :; }
sync_assets_to_pool() {
  echo "assets:$1" >> "$FAKE_EFFECT_LOG"
  [[ "$FAKE_ASSET_FAIL" == 0 ]]
}
smoke() {
  echo "smoke:$1" >> "$FAKE_EFFECT_LOG"
  if [[ "$FAKE_SMOKE_FAIL_ONCE" == 1 ]]; then FAKE_SMOKE_FAIL_ONCE=0; return 1; fi
  return 0
}
ssh() {
  local _host="$1" cmd="${2:-}" link_target
  echo "ssh:$cmd" >> "$FAKE_EFFECT_LOG"
  if [[ "$cmd" == *"cat '$RELEASES_ROOT/.prev-release'"* ]]; then printf '%s\n' "$FAKE_PREV_FILE"; return 0; fi
  if [[ "$cmd" == *"readlink -f"* ]]; then printf '%s\n' "$FAKE_CURRENT"; return 0; fi
  if [[ "$cmd" == *"ln -s '"* ]]; then
    link_target="${cmd#*ln -s \'}"; link_target="${link_target%%\'*}"; FAKE_CURRENT="$link_target"
  fi
  return 0
}
reset_traditional_state() { # $1=active $2=previous $3=lock
  ds_exec >/dev/null <<SQL
UPDATE deploy_state SET generation=3, phase='stable', active_slot='B', candidate_slot=NULL,
 active_release='$(ds_lit "$1")', candidate_release=NULL, previous_active_release='$(ds_lit "$2")',
 desired_leader_slot='B', desired_control_slot='B', cohort_percent=0, cohort_salt='',
 lock_version=$3, transition_step=0, operation_id=NULL, updated_at=now() WHERE singleton=true;
SQL
  ACTIVE_STATE_LOADED=0; ACTIVE_SLOT=A; ACTIVE_STATE_RELEASE=""; ACTIVE_STATE_PREVIOUS_RELEASE=""
}

# D1:PG 不可达必须在任何 fake effect 前失败。
saved_db="$DS_DATABASE_URL"; DS_DATABASE_URL="postgres://test:test@127.0.0.1:1/nope"; : > "$FAKE_EFFECT_LOG"; ACTIVE_STATE_LOADED=0
if load_active_lane_state_strict >/dev/null 2>&1; then bad "D1 PG 不可达不应解析 active lane"; else ok "D1 PG 不可达 fail-closed"; fi
eq "D1 PG 失败前零副作用" "$(wc -l < "$FAKE_EFFECT_LOG")" "0"
# release 删除型 GC 同样必须在 state 读取失败时整轮跳过，不能调用远端 rm。
if gc_releases >/dev/null 2>&1; then ok "D1 release GC 在 PG 故障时安全跳过"; else bad "D1 release GC PG 故障不应报删除失败"; fi
eq "D1 release GC PG 故障时远端零副作用" "$(wc -l < "$FAKE_EFFECT_LOG")" "0"
DS_DATABASE_URL="$saved_db"

# D2:active=B 成功路径，assets 必须先于 symlink，且只 restart B；DB 血缘原子对调。
reset_traditional_state "/rel/oldB" "/rel/oldA" 1; FAKE_CURRENT="/rel/oldB"; FAKE_PREV_FILE="/rel/file-prev"; : > "$FAKE_EFFECT_LOG"
assert_no_rollout_in_progress; resolve_active_lane
if activate_release "/rel/newB"; then ok "D2 active=B 激活成功"; else bad "D2 active=B 激活应成功"; fi
eq "D2 fake symlink 指向 newB" "$FAKE_CURRENT" "/rel/newB"
eq "D2 DB active_release=newB" "$(ds_exec <<<"SELECT active_release FROM deploy_state WHERE singleton=true")" "/rel/newB"
eq "D2 DB previous=oldB" "$(ds_exec <<<"SELECT previous_active_release FROM deploy_state WHERE singleton=true")" "/rel/oldB"
assets_line="$(grep -n '^assets:/rel/newB$' "$FAKE_EFFECT_LOG" | cut -d: -f1)"
flip_line="$(grep -n "ln -s '/rel/newB'" "$FAKE_EFFECT_LOG" | head -1 | cut -d: -f1)"
[[ -n "$assets_line" && -n "$flip_line" && "$assets_line" -lt "$flip_line" ]] && ok "D2 assets 先于 live 翻转" || bad "D2 assets/flip 顺序错误(assets=$assets_line flip=$flip_line)"
grep -q "systemctl restart 'openclaude-v5-b.service'" "$FAKE_EFFECT_LOG" && ok "D2 restart B unit" || bad "D2 未 restart B unit"
grep -q "systemctl restart 'openclaude-v5.service'" "$FAKE_EFFECT_LOG" && bad "D2 误 restart A unit" || ok "D2 未碰 A unit"

# D3:起手快照后 lock 被其它操作推进 → release CAS 落空且状态不再是 exact original。
# 此时不得猜测/盲回旧运行面；保持新运行面并进入人工恢复态。
reset_traditional_state "/rel/oldB" "/rel/oldA" 10; FAKE_CURRENT="/rel/oldB"; : > "$FAKE_EFFECT_LOG"
assert_no_rollout_in_progress; resolve_active_lane
ds_exec <<<"UPDATE deploy_state SET lock_version=lock_version+1 WHERE singleton=true" >/dev/null
if activate_release "/rel/racyB" >/dev/null 2>&1; then bad "D3 CAS 落空不应成功"; else ok "D3 CAS 落空返回失败"; fi
eq "D3 unknown 时保持新 symlink 不盲回" "$FAKE_CURRENT" "/rel/racyB"
eq "D3 DB active 仍 oldB" "$(ds_exec <<<"SELECT active_release FROM deploy_state WHERE singleton=true")" "/rel/oldB"
grep -q "ln -s '/rel/racyB'" "$FAKE_EFFECT_LOG" && ! grep -q "ln -s '/rel/oldB'" "$FAKE_EFFECT_LOG" \
  && ok "D3 unknown 阻止盲目运行面补偿" || bad "D3 不应回切 old"
grep -q "$DEPLOY_RECOVERY_MARKER" "$FAKE_EFFECT_LOG" && ok "D3 unknown 尝试落人工恢复标记" || bad "D3 缺人工恢复标记行为"

# D4:assets 预同步失败时，symlink/systemd 零副作用。
reset_traditional_state "/rel/oldB" "/rel/oldA" 20; FAKE_CURRENT="/rel/oldB"; : > "$FAKE_EFFECT_LOG"; FAKE_ASSET_FAIL=1
assert_no_rollout_in_progress; resolve_active_lane
if activate_release "/rel/no-assets" >/dev/null 2>&1; then bad "D4 assets 失败不应成功"; else ok "D4 assets 失败 fail-loud"; fi
FAKE_ASSET_FAIL=0
eq "D4 symlink 未动" "$FAKE_CURRENT" "/rel/oldB"
grep -q systemctl "$FAKE_EFFECT_LOG" && bad "D4 assets 失败后不应碰 systemd" || ok "D4 assets 失败后 systemd 零副作用"

# D5:hotcfg commit/revert 钩子打同一真 PG，验证 active=B + previous 精确恢复。
reset_traditional_state "/rel/oldB" "/rel/oldA" 30; assert_no_rollout_in_progress; resolve_active_lane
TEST_V5_ENV="/tmp/p3-v5-env-$$"; printf 'DATABASE_URL=%s\n' "$DS_DATABASE_URL" > "$TEST_V5_ENV"; V5_ENV="$TEST_V5_ENV"
build_hotcfg_state_hooks "/rel/hotB"
if eval "$HOTCFG_STATE_COMMIT_CMD"; then ok "D5 hotcfg state commit hook 命中"; else bad "D5 hotcfg commit hook 失败"; fi
eq "D5 commit active=hotB" "$(ds_exec <<<"SELECT active_release FROM deploy_state WHERE singleton=true")" "/rel/hotB"
if eval "$HOTCFG_STATE_REVERT_CMD"; then ok "D5 hotcfg state revert hook 命中"; else bad "D5 hotcfg revert hook 失败"; fi
eq "D5 revert active=oldB" "$(ds_exec <<<"SELECT active_release FROM deploy_state WHERE singleton=true")" "/rel/oldB"
eq "D5 revert previous=oldA" "$(ds_exec <<<"SELECT previous_active_release FROM deploy_state WHERE singleton=true")" "/rel/oldA"

# D6:真实 UPDATE 已提交、客户端却丢回执。fake psql 首次执行 UPDATE 后强制 rc=1；commit hook
# 必须靠 status 回读裁决 applied 并返回成功，随后 revert 仍能精确恢复。
reset_traditional_state "/rel/oldB" "/rel/oldA" 40; assert_no_rollout_in_progress; resolve_active_lane
build_hotcfg_state_hooks "/rel/lost-receipt"
REAL_PSQL="$(command -v psql)"; PSQL_WRAP="/tmp/p3-psql-wrap-$$"; mkdir -p "$PSQL_WRAP"
cat > "$PSQL_WRAP/psql" <<WRAP
#!/usr/bin/env bash
set -e
if [[ ! -e '$PSQL_WRAP/injected' && "\$*" == *'UPDATE deploy_state'* ]]; then
  '$REAL_PSQL' "\$@" >/dev/null
  : > '$PSQL_WRAP/injected'
  exit 1
fi
exec '$REAL_PSQL' "\$@"
WRAP
chmod +x "$PSQL_WRAP/psql"
if PATH="$PSQL_WRAP:$PATH" eval "$HOTCFG_STATE_COMMIT_CMD"; then ok "D6 post-commit 丢回执被回读裁决 applied"; else bad "D6 commit hook 应恢复 applied 回执"; fi
eq "D6 DB 已是 lost-receipt" "$(ds_exec <<<"SELECT active_release FROM deploy_state WHERE singleton=true")" "/rel/lost-receipt"
if eval "$HOTCFG_STATE_REVERT_CMD"; then ok "D6 lost-receipt 后 revert 收敛"; else bad "D6 revert 应成功"; fi
eq "D6 revert 后 active=oldB" "$(ds_exec <<<"SELECT active_release FROM deploy_state WHERE singleton=true")" "/rel/oldB"

# D7:非 hotcfg commit 已生效且首次回读失败；三次重试必须在第二次识别 applied、补偿并
# 确认 reverted，之后才允许调用方回切运行面。
reset_traditional_state "/rel/oldB" "/rel/oldA" 50; assert_no_rollout_in_progress; resolve_active_lane
ds_stable_release_commit 50 B "/rel/oldB" "/rel/nonhot-lost" >/dev/null
DS_EXEC_ORIG="$(declare -f ds_exec)"
eval "$(declare -f ds_exec | sed '1s/ds_exec/ds_exec_real/')"
DS_FAIL_MARK="/tmp/p3-ds-fail-once-$$"; rm -f "$DS_FAIL_MARK"
ds_exec() {
  if [[ ! -e "$DS_FAIL_MARK" ]]; then : > "$DS_FAIL_MARK"; return 1; fi
  ds_exec_real
}
if restore_release_state_if_committed "/rel/nonhot-lost" >/dev/null 2>&1; then ok "D7 首次回读失败后重试并确认补偿"; else bad "D7 应在后续回读收敛"; fi
eval "$DS_EXEC_ORIG"; unset -f ds_exec_real
rm -f "$DS_FAIL_MARK"
eq "D7 DB active 已恢复 oldB" "$(ds_exec <<<"SELECT active_release FROM deploy_state WHERE singleton=true")" "/rel/oldB"
eq "D7 DB previous 已恢复 oldA" "$(ds_exec <<<"SELECT previous_active_release FROM deploy_state WHERE singleton=true")" "/rel/oldA"

# D8:hotcfg history 落后于 P3 master 切换时，N=1 必须用 state.previous，保留当前 env tuple；
# A→B 与 B→A 两向都跑完整 rollback_runtime_tuple 编排到 saga 调用。
HOTCFG_LAST_MASTER=""; HOTCFG_CURRENT_IMAGE="img:LIVE"; HOTCFG_CURRENT_RELEASE="/runtime/LIVE"; HOTCFG_CAPTURE="/tmp/p3-hotcfg-capture-$$"
hotcfg_rmt() {
  local fn="$1"; shift
  case "$fn" in
    oc_hotcfg_history_last_committed)
      jq -cn --arg m "$HOTCFG_LAST_MASTER" '{image:"img:HIST",image_id:"id:HIST",release:"/runtime/HIST",bundle:"",masterRelease:$m}' ;;
    oc_hotcfg_env_tuple_json)
      jq -cn --arg i "$HOTCFG_CURRENT_IMAGE" --arg r "$HOTCFG_CURRENT_RELEASE" --arg m "$2" \
        '{image:$i,image_id:"id:LIVE",release:$r,bundle:"",masterRelease:$m}' ;;
    oc_hotcfg_activate_saga)
      printf '%s|%s|%s|%s\n' "${13}" "${5}" "${7}" "$ACTIVE_SLOT" > "$HOTCFG_CAPTURE" ;;
    *) return 1 ;;
  esac
}
V5_ENV="$TEST_V5_ENV"
# A(old) → B(new) finalize 后：history.last 仍 A；rollback target=A，tuple 保持 LIVE。
ACTIVE_SLOT=B; ACTIVE_SRC="$(slot_src B)"; ACTIVE_UNIT="$(slot_unit B)"; ACTIVE_PORT="$(slot_port B)"
ACTIVE_STATE_RELEASE="/rel/newB"; ACTIVE_STATE_PREVIOUS_RELEASE="/rel/oldA"; ACTIVE_STATE_LOCK_VERSION=60
FAKE_CURRENT="/rel/newB"; HOTCFG_LAST_MASTER="/rel/oldA"
if rollback_runtime_tuple 1; then ok "D8 A→B finalize 后 hotcfg rollback 编排成功"; else bad "D8 A→B rollback 不应多退"; fi
eq "D8 A→B target=state.previous A 且保留 live tuple" "$(cat "$HOTCFG_CAPTURE")" "/rel/oldA|img:LIVE|/runtime/LIVE|B"
# B(old) → A(new) finalize 后：history.last 可仍更老 A；rollback target=B，tuple 仍保持 LIVE。
ACTIVE_SLOT=A; ACTIVE_SRC="$(slot_src A)"; ACTIVE_UNIT="$(slot_unit A)"; ACTIVE_PORT="$(slot_port A)"
ACTIVE_STATE_RELEASE="/rel/newA"; ACTIVE_STATE_PREVIOUS_RELEASE="/rel/oldB"; ACTIVE_STATE_LOCK_VERSION=70
FAKE_CURRENT="/rel/newA"; HOTCFG_LAST_MASTER="/rel/olderA"
if rollback_runtime_tuple 1; then ok "D8 B→A finalize 后 hotcfg rollback 编排成功"; else bad "D8 B→A rollback 不应多退"; fi
eq "D8 B→A target=state.previous B 且保留 live tuple" "$(cat "$HOTCFG_CAPTURE")" "/rel/oldB|img:LIVE|/runtime/LIVE|A"

rm -rf "$PSQL_WRAP"; rm -f "$TEST_V5_ENV" "$FAKE_EFFECT_LOG" "$HOTCFG_CAPTURE"

echo "── E) 真 PG 恢复路径:journal 原基线 / 缺失基线 / step6 candidate 异常 ──"
# 外部效果全部换成可观测 fake；状态推进仍打本地真 PG。
sshk() { :; }; abort_continue() { :; }; caddy_render_reload() { :; }; smoke() { :; }; dist_handshake_smoke() { :; }
wait_for_slot_leadership() { return 0; }; vip_control_gate() { return 0; }
reset_finalize_state() { # $1=step $2=op
  ds_exec >/dev/null <<SQL
UPDATE deploy_state SET generation=4, phase='finalizing', active_slot='A', candidate_slot='B',
 active_release='/rel/oldA', candidate_release='/rel/newB', previous_active_release='/rel/older',
 desired_leader_slot='B', desired_control_slot='B', cohort_percent=100, cohort_salt='s',
 lock_version=100, transition_step=$1, operation_id='$(ds_lit "$2")', updated_at=now() WHERE singleton=true;
TRUNCATE deploy_state_journal;
SQL
}

# E1:step5 resume 必须恢复 step0 的旧 startId/计数，而非现场重 baseline。
reset_finalize_state 5 op-base
ds_exec >/dev/null <<'SQL'
INSERT INTO deploy_state_journal(operation_id,step,action)
VALUES('op-base',0,'finalize-begin egress-baseline={"startId":"orig-start","enq":"11","sent":"7","exp":"2","ovf":"1"}');
SQL
EGR_CAPTURE="/tmp/p3-egr-capture-$$"
egress_gate_conservation() { printf '%s|%s|%s|%s|%s' "$EGR_START_STARTID" "$EGR_START_ENQ" "$EGR_START_SENT" "$EGR_START_EXP" "$EGR_START_OVF" > "$EGR_CAPTURE"; return 1; }
if ( finalize >/dev/null 2>&1 ); then bad "E1 gate 故障应转 aborting"; else ok "E1 gate 故障返回非零"; fi
eq "E1 使用 journal 原基线" "$(cat "$EGR_CAPTURE")" "orig-start|11|7|2|1"
eq "E1 gate 失败真实终态=aborting" "$(ds_exec <<<"SELECT phase FROM deploy_state WHERE singleton=true")" "aborting"
rm -f "$EGR_CAPTURE"

# E2:step0 journal 缺失必须真实 CAS 到 aborting，不只打印提示。
reset_finalize_state 0 op-missing
if ( finalize >/dev/null 2>&1 ); then bad "E2 缺基线不应继续 finalize"; else ok "E2 缺基线 fail-closed"; fi
eq "E2 缺基线真实终态=aborting" "$(ds_exec <<<"SELECT phase FROM deploy_state WHERE singleton=true")" "aborting"

# E3:step6 candidate 异常不得提交 stable。
reset_finalize_state 6 op-step6
wait_for_slot_leadership() { return 1; }
if ( finalize >/dev/null 2>&1 ); then bad "E3 candidate 异常不应成功"; else ok "E3 candidate 异常返回失败"; fi
eq "E3 step6 异常真实终态=aborting" "$(ds_exec <<<"SELECT phase FROM deploy_state WHERE singleton=true")" "aborting"

echo
echo "══ 冒烟结果:PASS=$PASS FAIL=$FAIL ══"
[[ "$FAIL" == 0 ]] || exit 1
