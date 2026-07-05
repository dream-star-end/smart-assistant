-- 0103_agent_audit_event_id_index.sql
-- 工具失败遥测 dedupe 索引(/internal/v3/agent-audit/tool-failure)
-- 依赖:0005(agent_audit)
--
-- internalToolFailureAudit.insertToolFailureAudit 每次落库前按
--   WHERE user_id=$1 AND input_meta->>'event_id'=$2
-- 查重;agent_audit 无对应索引 → 表增长后每条上报都退化为顺序扫描。
--
-- partial 谓词用 IS NOT NULL 而非 `input_meta ? 'event_id'`:planner 能从查询里
-- `input_meta->>'event_id' = $2`(严格算子)推导出 IS NOT NULL 从而命中本索引;
-- `?` 算子谓词推不出来,索引会被绕过。只有遥测行携带 event_id → partial 让索引
-- 不背历史 agent_audit 存量(既有工具审计行全部落在索引之外)。
--
-- 运维注:非 CONCURRENTLY(migration runner 在事务内执行),建索引期间短暂锁
-- agent_audit 写入;v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0102 惯例)。
CREATE INDEX IF NOT EXISTS idx_aa_agent_event_id
  ON agent_audit (user_id, (input_meta->>'event_id'))
  WHERE (input_meta->>'event_id') IS NOT NULL;
