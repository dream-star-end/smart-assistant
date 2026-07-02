-- 0098_claude_accounts_runtime_channel.sql
-- M1b codex 复活 — codex 账号池权威按 runtime_channel 划分。
--
-- 背景(架构决策,2026-07-02):
--   v3 与 v5 是两个并行 master,共享同一张 claude_accounts。codex(auth.openai.com)
--   OAuth 的 refresh-token 是 family 语义:同一账号的同一条 refresh 链被两个进程
--   并发刷新会触发 family 吊销(个人版 Claude OAuth 双权威源 401 事故同型,见
--   fix/claude-oauth-single-authority)。因此 codex 账号行必须有唯一的 channel 归属,
--   v3/v5 各自只刷、只绑、只消费自己 channel 的行 —— 单账号单刷新权威。
--
-- 语义:
--   - 列名沿用仓内既有 channel 维度命名(agent_containers/research_jobs 同名列)。
--   - DEFAULT 'v3':存量行(全部由 v3 现网在用)一次性归 v3,v3 代码不读此列,
--     零行为变化;v5 现在还没有 codex 账号行 → v5 侧自然 fail-closed"账号池为空"。
--   - v5 的 codex 账号由 admin 后续显式以 runtime_channel='v5' 录入(或把某行显式
--     迁给 v5 —— 迁移即"换权威",必须整行迁,不允许两个 channel 同链共刷)。
--   - CHECK IN ('v3','v5') 与 0091 agent_containers 同款,防手工 SQL 写出第三种 channel。
--   - 消费点(v5 树):codexAccountActor 刷新枚举 / scheduler.pickCodexAccountForBindingInTx /
--     groups.hasActiveOfficialOAuthAccountInGroup(provider='codex')严格按
--     runtime_channel = getRuntimeChannel() 过滤,无回落。
--   - claude(anthropic)provider 行暂不按 channel 划分(现网 v3 共享池语义不动,
--     且 Claude 官方模型已全面下线);列是表级的,但 claude 选取路径不读它。
--
-- v3 现网零影响声明:纯加列 + DEFAULT 'v3' + 部分索引;v3 树代码不含本列的任何
-- 读写;不改任何既有行为。幂等:IF NOT EXISTS / pg_constraint 探测,可重复执行。

ALTER TABLE claude_accounts
  ADD COLUMN IF NOT EXISTS runtime_channel TEXT NOT NULL DEFAULT 'v3';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claude_accounts_runtime_channel_check'
  ) THEN
    ALTER TABLE claude_accounts
      ADD CONSTRAINT claude_accounts_runtime_channel_check
      CHECK (runtime_channel IN ('v3', 'v5'));
  END IF;
END $$;

-- codex 选取路径专用:WHERE provider='codex' AND runtime_channel=$ AND status='active'。
-- 部分索引只覆盖 codex 行(claude 行不进,不影响既有 idx_ca_provider_status 计划)。
CREATE INDEX IF NOT EXISTS idx_ca_codex_channel_status
  ON claude_accounts (runtime_channel, status)
  WHERE provider = 'codex';

COMMENT ON COLUMN claude_accounts.runtime_channel IS
  'codex 账号池 channel 归属(v3|v5):同一 codex OAuth 账号只允许一个 master 刷新/消费,'
  '防 refresh-token family 双刷吊销。claude provider 行暂不按此列分流(共享池语义)。';
