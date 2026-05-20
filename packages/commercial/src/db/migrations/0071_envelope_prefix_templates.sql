-- 0071_envelope_prefix_templates.sql
--
-- V3 CC External Endpoint envv2 Phase 2(2026-05-21)
-- 见 docs/V3_CC_EXTERNAL_ENDPOINT_ENVV2_PLAN_2026-05-21.md §Phase 2
--
-- 把 packages/commercial/src/http/proxy/externalEnvelope.ts:76-87 三个硬编码的
-- CC sysprompt prefix(`CC_DEFAULT_PREFIX` / `CC_AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX` /
-- `CC_AGENT_SDK_PREFIX`)迁到 DB,变成运行时可调(无需 deploy commercial)。
--
-- 上线后 prod 行为完全等价:bootstrap 时 cache 加载这三行 active text,helper 还是
-- 走相同的 startsWith 检测 + prepend DEFAULT 注入,outbound 字面字节级与 Phase 0
-- baseline 锁的 8 个 invariant 一致。
--
-- 设计要点:
--   * variant CHECK 锁三个枚举值,与 externalEnvelope.ts:detectCcPrefix 数组顺序对齐
--     (0=default, 1=agent_sdk_claude_code_preset, 2=agent_sdk)
--   * active 列 + 部分 UNIQUE 索引:同时只有一行 active per variant,保留 inactive
--     历史用于将来回滚(Phase 2 PR 只支持 in-place text UPDATE,active 切换 PATCH
--     端点 Phase 3+ 再加 —— YAGNI)
--   * LISTEN/NOTIFY 与 model_pricing(0008)同型:trigger AFTER STATEMENT 发出
--     `envelope_prefix_templates_changed` 通知,所有连接此 DB 的进程 cache 收到后
--     reload。**不**解决跨 DB / cross-master 一致性(PG NOTIFY 仅同实例),KL hot
--     standby 通过 streaming replication 接管时 KL 进程会在升级后 cold-load。
--   * bootstrap 3 行字面 = externalEnvelope.ts:76-87 当前硬编码,Phase 0 baseline
--     不应触发漂移(Phase 5 删 v1 helper 时此表保留作为 v2 模板源)。

CREATE TABLE envelope_prefix_templates (
  id              SMALLSERIAL PRIMARY KEY,
  variant         TEXT NOT NULL CHECK (variant IN
                    ('default', 'agent_sdk_claude_code_preset', 'agent_sdk')),
  text            TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      BIGINT NULL  -- admin users.id;NULL = 来自 bootstrap seed
);

-- 每个 variant 同时只有一行 active(部分 UNIQUE);允许保留 inactive 历史
CREATE UNIQUE INDEX uq_envelope_prefix_active
  ON envelope_prefix_templates(variant)
  WHERE active = TRUE;

COMMENT ON TABLE envelope_prefix_templates IS
  'V3 envv2 Phase 2(2026-05-21):CC sysprompt prefix 模板。从 externalEnvelope.ts'
  ' 硬编码迁来,运行时可由 admin 修改。三个 variant 与 CCB getCLISyspromptPrefix()'
  ' 三种产出对齐:default(交互式)、agent_sdk_claude_code_preset、agent_sdk。';

COMMENT ON COLUMN envelope_prefix_templates.variant IS
  'CC prefix 变体枚举;新增变体需同步更新 externalEnvelope.ts:detectCcPrefix 顺序。';

COMMENT ON COLUMN envelope_prefix_templates.text IS
  '上游 Anthropic anti-abuse 反风控锚点字面;改字符串前确认 CCB 当前版本同型,'
  '否则会破坏"客户端 CC 形态"分桶导致整池 429。';

-- Bootstrap 三行 active = externalEnvelope.ts:76-87 字面,锁住 Phase 0 baseline 不漂移
INSERT INTO envelope_prefix_templates (variant, text) VALUES
  ('default',
   $$You are Claude Code, Anthropic's official CLI for Claude.$$),
  ('agent_sdk_claude_code_preset',
   $$You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.$$),
  ('agent_sdk',
   $$You are a Claude agent, built on Anthropic's Claude Agent SDK.$$);

-- LISTEN/NOTIFY for in-process cache invalidation(与 model_pricing 同型)
--
-- 整迁移文件的 DDL 是 CREATE,只跑一次;但测试 fixture 在 setup 前会 DROP TABLE
-- envelope_prefix_templates 然后 runMigrations() 重放全部 migration,trigger 会
-- 跟着 CASCADE DROP,但 FUNCTION 不被 DROP TABLE CASCADE 牵连(独立 schema 对象),
-- 重放时撞 "function already exists"。CREATE OR REPLACE FUNCTION 解决之。
-- TRIGGER 没有 CREATE OR REPLACE 语法 → 用 DROP IF EXISTS。
CREATE OR REPLACE FUNCTION envelope_prefix_templates_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('envelope_prefix_templates_changed', '');
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_envelope_prefix_templates_notify ON envelope_prefix_templates;
CREATE TRIGGER trg_envelope_prefix_templates_notify
  AFTER INSERT OR UPDATE OR DELETE ON envelope_prefix_templates
  FOR EACH STATEMENT EXECUTE FUNCTION envelope_prefix_templates_notify();
