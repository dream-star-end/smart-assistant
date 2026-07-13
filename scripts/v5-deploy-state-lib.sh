# shellcheck shell=bash
# shellcheck disable=SC2034
# v5-deploy-state-lib.sh — deploy_state 单一权威访问层(RFC-v5-dual-master-cohort §3)。
# 注:上面 SC2034 整体关闭——DS_STEP_*/DS_ROW_FIELDS/DS_* 是本库对外的"公共状态词汇表",
#     由 ds_load 经 `read` 填充、被 source 本库的脚本(deploy-v5.sh / caddy / smoke)跨文件消费;
#     静态分析(工具)看不到跨 source 边界的消费点,若不关闭会满屏"appears unused"误报。
#
# 【为什么是一个库】RFC R1 核心裁决:流量角色 / VIP 18894 所有者 / leader 所有者 / systemd
# slot 必须收敛到**同一个 PG 部署状态机**,禁止三个独立竞态"通常一致"。为此 deploy 面的两个
# 消费者——Caddy 生成器(v5-caddy-apply.sh 读 active/candidate/phase/step)与 deploy lane
# (deploy-v5.sh 起手 CAS phase、逐步 CAS transition_step)——必须共用**同一份** 读 / CAS /
# journal / lane_hash 实现,任何一处写第二套定义都会让"四角色派生自同一权威源"这一不变量破裂。
#
# 本库不含任何生产副作用编排(那在 deploy-v5.sh);只提供纯粹的状态访问原语。
#
# 【本地 / 远端双模式】DS_MODE:
#   remote(缺省):ssh $KL_HOST → source $V5_ENV → psql "$DATABASE_URL"(与既有部署守卫同法)
#   local        :直接 psql "$DS_DATABASE_URL"(供 octest 本地 PG 冒烟真跑 CAS/恢复矩阵)
# 两模式跑**同一** SQL 文本 → 冒烟覆盖的就是生产会跑的语句。

set -o pipefail

# ── transition_step 语义常量(数值单调,便于 `< READY` 比较;RFC §3/§8)──
# canary 阶段:0=起手预留(准备期,对流量不可见)…READY=matcher 可见阈值。
# finalizing 阶段:1..7 直接用 §D5 七步序数字。aborting:0=起手,1..4 按 §D5 abort 序。
DS_STEP_INIT=0
DS_STEP_CANARY_READY=10   # canary transition_step >= 此值 → Caddy 才生成 candidate matcher

# ── psql 执行原语:读 SQL(stdin)→ 回传 -tA 结果 ──
# 用 stdin 传 SQL(而非 -c '<sql>')彻底规避 ssh 双层引号地狱:ssh 会把本地 stdin 透传给远端
# psql 的 stdin。fail-closed:ON_ERROR_STOP=1;调用方用 `if`/命令替换捕获退出码。
ds_exec() {  # stdin=SQL;stdout=结果
  local sql; sql="$(cat)"
  case "${DS_MODE:-remote}" in
    local)
      psql "$DS_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq <<<"$sql"
      ;;
    remote)
      ssh "${KL_HOST:?KL_HOST 未设}" "set -a; . '${V5_ENV:?V5_ENV 未设}' 2>/dev/null; psql \"\$DATABASE_URL\" -X -v ON_ERROR_STOP=1 -tAq" <<<"$sql"
      ;;
    *) echo "ds_exec: 未知 DS_MODE='$DS_MODE'" >&2; return 2 ;;
  esac
}

# SQL 字面量转义(单引号翻倍)。operation_id/action/release 名等均脚本内生成,无用户输入,
# 但仍统一走转义,杜绝将来复用时的注入面。
ds_lit() { local s="$1"; printf "%s" "${s//\'/\'\'}"; }

# 传统 deploy/dist/rollback 在 stable 态更新 release 血缘时使用的唯一 SQL 生成器。
# 空串代表 SQL NULL（0135 初始 seed 的 active_release 正是 NULL）；非空 release 路径统一转义。
ds_sql_nullable() {  # $1=value
  if [[ -z "$1" ]]; then printf 'NULL'; else printf "'%s'" "$(ds_lit "$1")"; fi
}

ds_stable_release_commit_sql() {  # $1=expect_lv $2=slot $3=expected_active $4=target
  local expect="$1" slot target old_sql target_sql
  slot="$(ds_lit "$2")"; old_sql="$(ds_sql_nullable "$3")"; target_sql="$(ds_sql_nullable "$4")"
  cat <<SQL
UPDATE deploy_state
   SET previous_active_release = active_release,
       active_release          = $target_sql,
       lock_version            = lock_version + 1,
       updated_at              = now()
 WHERE singleton = true
   AND lock_version = $expect
   AND phase = 'stable'
   AND candidate_slot IS NULL
   AND candidate_release IS NULL
   AND active_slot = '$slot'
   AND active_release IS NOT DISTINCT FROM $old_sql
RETURNING lock_version;
SQL
}

ds_stable_release_revert_sql() {  # $1=expect_lv $2=slot $3=current $4=restore_active $5=restore_previous
  local expect="$1" slot current_sql active_sql previous_sql
  slot="$(ds_lit "$2")"; current_sql="$(ds_sql_nullable "$3")"
  active_sql="$(ds_sql_nullable "$4")"; previous_sql="$(ds_sql_nullable "$5")"
  cat <<SQL
UPDATE deploy_state
   SET active_release          = $active_sql,
       previous_active_release = $previous_sql,
       lock_version            = lock_version + 1,
       updated_at              = now()
 WHERE singleton = true
   AND lock_version = $expect
   AND phase = 'stable'
   AND candidate_slot IS NULL
   AND candidate_release IS NULL
   AND active_slot = '$slot'
   AND active_release IS NOT DISTINCT FROM $current_sql
RETURNING lock_version;
SQL
}

# release CAS 的三态回读。expect_lv 是提交前 lock_version：
#   applied  = commit 已生效且尚未补偿(lock=expect+1,target/previous=旧 active)
#   original = commit 明确未生效(lock=expect,原 active/previous)
#   reverted = commit 曾生效但已补偿(lock=expect+2,原 active/previous)
#   unknown  = phase/candidate/slot/release/lock 任一不吻合，禁止猜测后继续改运行面。
ds_stable_release_status_sql() {  # $1=expect_lv $2=slot $3=old_active $4=old_previous $5=target
  local expect="$1" slot old_active_sql old_previous_sql target_sql
  slot="$(ds_lit "$2")"; old_active_sql="$(ds_sql_nullable "$3")"
  old_previous_sql="$(ds_sql_nullable "$4")"; target_sql="$(ds_sql_nullable "$5")"
  cat <<SQL
SELECT CASE
  WHEN phase = 'stable'
   AND candidate_slot IS NULL AND candidate_release IS NULL
   AND active_slot = '$slot'
   AND lock_version = $((expect + 1))
   AND active_release IS NOT DISTINCT FROM $target_sql
   AND previous_active_release IS NOT DISTINCT FROM $old_active_sql
    THEN 'applied'
  WHEN phase = 'stable'
   AND candidate_slot IS NULL AND candidate_release IS NULL
   AND active_slot = '$slot'
   AND lock_version = $expect
   AND active_release IS NOT DISTINCT FROM $old_active_sql
   AND previous_active_release IS NOT DISTINCT FROM $old_previous_sql
    THEN 'original'
  WHEN phase = 'stable'
   AND candidate_slot IS NULL AND candidate_release IS NULL
   AND active_slot = '$slot'
   AND lock_version = $((expect + 2))
   AND active_release IS NOT DISTINCT FROM $old_active_sql
   AND previous_active_release IS NOT DISTINCT FROM $old_previous_sql
    THEN 'reverted'
  ELSE 'unknown'
END
FROM deploy_state
WHERE singleton = true;
SQL
}

ds_stable_release_commit() {  # 参数同 ds_stable_release_commit_sql；成功 stdout=新 lock_version
  ds_exec <<<"$(ds_stable_release_commit_sql "$@")"
}

ds_stable_release_revert() {  # 参数同 ds_stable_release_revert_sql；成功 stdout=新 lock_version
  ds_exec <<<"$(ds_stable_release_revert_sql "$@")"
}

# ── 读:回传 singleton 关键列(| 分隔,顺序固定;NULL→空串)──
# 顺序:generation|phase|active_slot|candidate_slot|active_release|candidate_release|
#       desired_leader_slot|desired_control_slot|cohort_percent|cohort_salt|
#       transition_step|operation_id|lock_version|previous_active_release
# (previous_active_release 追加在末尾:BLOCKER 4 rollback 权威目标,老消费点位置不受影响)
DS_ROW_FIELDS="generation phase active_slot candidate_slot active_release candidate_release desired_leader_slot desired_control_slot cohort_percent cohort_salt transition_step operation_id lock_version previous_active_release"
ds_read_row() {
  ds_exec <<'SQL'
SELECT generation
     ||'|'|| phase
     ||'|'|| active_slot
     ||'|'|| coalesce(candidate_slot,'')
     ||'|'|| coalesce(active_release,'')
     ||'|'|| coalesce(candidate_release,'')
     ||'|'|| coalesce(desired_leader_slot,'')
     ||'|'|| coalesce(desired_control_slot,'')
     ||'|'|| cohort_percent
     ||'|'|| coalesce(cohort_salt,'')
     ||'|'|| transition_step
     ||'|'|| coalesce(operation_id,'')
     ||'|'|| lock_version
     ||'|'|| coalesce(previous_active_release,'')
FROM deploy_state
ORDER BY generation DESC
LIMIT 1;
SQL
}

# 把 ds_read_row 的一行拆进全局 DS_* 变量(调用方读 $DS_phase 等)。
ds_load() {
  local row; row="$(ds_read_row)" || return 1
  [[ -n "$row" ]] || { echo "ds_load: deploy_state 无行(未 seed?)" >&2; return 1; }
  IFS='|' read -r DS_generation DS_phase DS_active_slot DS_candidate_slot \
    DS_active_release DS_candidate_release DS_desired_leader_slot DS_desired_control_slot \
    DS_cohort_percent DS_cohort_salt DS_transition_step DS_operation_id DS_lock_version \
    DS_previous_active_release <<<"$row"
}

# ── CAS 写(+ 可选 journal,原子同事务)──
#     UPDATE ... SET <set-clause>, lock_version+1 WHERE lock_version=$expect RETURNING lock_version
# 成功回传新 lock_version(stdout);CAS 落空(并发已推进)回传空串且 rc=0(调用方判空→重读恢复)。
# set-clause 由调用方以合法 SQL 片段传入(如 "phase='canary', transition_step=0")。
#
# 【MAJOR 1:CAS 与 journal 必须同一事务】给了 op/step/action 时用**数据修改 CTE 单语句**
# (upd → j),PostgreSQL 保证 WITH 内所有子句同快照原子提交:CAS 命中才产生 upd 行,journal 的
# `INSERT ... SELECT FROM upd` 才落一行;CAS 落空 upd 为空 → 不插 journal、SELECT 回空。这样彻底消
# 除"状态已推进但 journal 半条/无"的崩溃诊断误导(旧实现两次 psql = 两事务,中途崩溃即撕裂)。
ds_cas() {  # $1=expect_lock_version  $2=set_clause  [$3=op $4=step $5=action]
  local expect="$1" set_clause="$2" op="${3:-}" step="${4:-}" action="${5:-}"
  if [[ -n "$op" && -n "$step" ]]; then
    local op_lit action_lit
    op_lit="$(ds_lit "$op")"; action_lit="$(ds_lit "$action")"
    ds_exec <<SQL
WITH upd AS (
  UPDATE deploy_state
     SET $set_clause,
         lock_version = lock_version + 1,
         updated_at   = now()
   WHERE lock_version = $expect
  RETURNING lock_version
), j AS (
  INSERT INTO deploy_state_journal (operation_id, step, action)
  SELECT '$op_lit', $step, '$action_lit' FROM upd
  RETURNING 1
)
SELECT lock_version FROM upd;
SQL
    return
  fi
  ds_exec <<SQL
UPDATE deploy_state
   SET $set_clause,
       lock_version = lock_version + 1,
       updated_at   = now()
 WHERE lock_version = $expect
RETURNING lock_version;
SQL
}

# journal:每个外部效果完成即记一条{operation_id, step, action, at}(RFC §3 R2-B1)。
ds_journal() {  # $1=operation_id $2=step $3=action
  local op step action
  op="$(ds_lit "$1")"; step="$2"; action="$(ds_lit "$3")"
  ds_exec <<SQL >/dev/null
INSERT INTO deploy_state_journal (operation_id, step, action)
VALUES ('$op', $step, '$action');
SQL
}

# ── lane_hash(RFC D1「钉死单一实现」)──
# sha256(salt+':'+uid) 前 8 hex → uint32 无符号 → mod 100。TS(evaluateLane)/SQL(admin 聚合)/
# 本脚本三处必须同定义;此处是 shell 侧权威副本,穷举测试三处一致。
ds_lane_hash() {  # $1=salt $2=uid → 0..99
  local h; h="$(printf '%s:%s' "$1" "$2" | sha256sum | cut -c1-8)"
  echo $(( 16#$h % 100 ))
}

# 本地冒烟建表:与 Agent A 的 0135_deploy_state.sql **逐列逐约束对齐**(singleton PK、
# lock_version DEFAULT 1 CHECK≥1、generation CHECK≥1、cohort_salt DEFAULT ''、active_release/
# previous_active_release seed=NULL,与 0135 一致——MINOR:seed 对齐,冒烟打在真实形态的表上)。生产绝不调用——
# 仅 DS_MODE=local 的冒烟自建 scratch schema 时用,保证冒烟 CAS 打在真实形态的表上。
ds_bootstrap_local_schema() {
  [[ "${DS_MODE:-remote}" == "local" ]] || { echo "ds_bootstrap_local_schema 仅限 DS_MODE=local" >&2; return 2; }
  ds_exec <<'SQL' >/dev/null
CREATE TABLE IF NOT EXISTS deploy_state (
  singleton            BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  generation           BIGINT   NOT NULL CHECK (generation >= 1),
  phase                TEXT     NOT NULL CHECK (phase IN ('stable','canary','finalizing','aborting')),
  active_slot          TEXT     NOT NULL CHECK (active_slot IN ('A','B')),
  candidate_slot       TEXT              CHECK (candidate_slot IS NULL OR candidate_slot IN ('A','B')),
  active_release       TEXT,
  candidate_release    TEXT,
  previous_active_release TEXT,
  desired_leader_slot  TEXT     NOT NULL CHECK (desired_leader_slot IN ('A','B')),
  desired_control_slot TEXT     NOT NULL CHECK (desired_control_slot IN ('A','B')),
  cohort_percent       SMALLINT NOT NULL DEFAULT 0 CHECK (cohort_percent BETWEEN 0 AND 100),
  cohort_salt          TEXT     NOT NULL DEFAULT '',
  cohort_allowlist     BIGINT[] NOT NULL DEFAULT '{}',
  lock_version         BIGINT   NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
  transition_step      SMALLINT NOT NULL DEFAULT 0,
  operation_id         TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS deploy_state_journal (
  id           BIGSERIAL   PRIMARY KEY,
  operation_id TEXT        NOT NULL,
  step         SMALLINT    NOT NULL,
  action       TEXT        NOT NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deploy_journal_op ON deploy_state_journal(operation_id, id);
-- seed singleton(基建版初态=现状:A 全 desired,无 candidate,generation=1,lock_version=1)
-- active_release/previous_active_release=NULL(与 0135 seed 一致,MINOR:局部 smoke 与迁移对齐;
-- 传统 deploy 的 ds_commit_active_release 成功后才校准成真实 rel 路径)。
INSERT INTO deploy_state (singleton, generation, phase, active_slot, candidate_slot,
                          active_release, previous_active_release, desired_leader_slot, desired_control_slot,
                          cohort_percent, cohort_salt, cohort_allowlist, lock_version, transition_step)
VALUES (true, 1, 'stable', 'A', NULL,
        NULL, NULL, 'A', 'A',
        0, '', '{}', 1, 0)
ON CONFLICT (singleton) DO NOTHING;
SQL
}
