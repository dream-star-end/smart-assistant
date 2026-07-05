-- 0104_usage_records_delegate_attribution.sql
-- delegate 子会话计费打标(成本可归因)
-- 依赖:0002(usage_records)
--
-- 背景:团队模式委派的子 agent(含 hidden-reviewer)每次 LLM 调用经容器 →
-- master 内部代理计费落 usage_records,但 session_id 是引擎内部 UUID,与客户端
-- 会话 id(web-*)无映射、mode 恒 'chat' —— 用量页呈现为无名 UUID 行,一次组队
-- 花了多少钱完全不可归因。
--
-- 本迁移:
--   1. mode CHECK 扩到 ('chat','agent','delegate')。'agent' 是 v3 legacy 值保留;
--      'delegate' 由 v5 anthropicProxy settle 路径写入(extractUsageAttribution →
--      settleUsageAndLedger),权威源 = gateway 对 delegate 子会话 CCB 注入的
--      CLAUDE_CODE_EXTRA_METADATA env(oc_mode / oc_parent_session_id /
--      oc_delegate_agent_id → metadata.user_id JSON)。
--   2. parent_session_id TEXT NULL:delegate 所属父**客户端**会话 id(web-*;
--      父会话不在容器内存时退化为容器内部 parentSessionKey,映射链见 gateway
--      server.ts handleDelegateTask 注入点注释)。
--   3. delegate_agent_id TEXT NULL:委派目标 agent id(hidden-reviewer 同样打标)。
--   4. partial 索引:按 (user_id, parent_session_id) 聚合"一次组队花了多少钱";
--      partial 谓词让索引不背 chat 存量(chat 行两列恒 NULL)。
--
-- 共享库影响面:纯加列(NULL 默认)+ CHECK 放宽,v3 的 INSERT 列清单显式、值恒
-- 'chat' → v3 读写零影响;v3 admin 聚合若按 mode 分桶只会多出 'delegate' 桶。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0103 惯例)。
-- ALTER TABLE ADD COLUMN(无默认值)与 CHECK 重建均为元数据级操作,不重写表;
-- CREATE INDEX 非 CONCURRENTLY(migration runner 在事务内执行),建索引期间短暂
-- 锁 usage_records 写入,该表行数量级下秒级完成。

ALTER TABLE usage_records DROP CONSTRAINT usage_records_mode_check;
ALTER TABLE usage_records ADD CONSTRAINT usage_records_mode_check
  CHECK (mode IN ('chat', 'agent', 'delegate'));

ALTER TABLE usage_records ADD COLUMN parent_session_id TEXT;
ALTER TABLE usage_records ADD COLUMN delegate_agent_id TEXT;

CREATE INDEX idx_ur_parent_session
  ON usage_records (user_id, parent_session_id)
  WHERE parent_session_id IS NOT NULL;
