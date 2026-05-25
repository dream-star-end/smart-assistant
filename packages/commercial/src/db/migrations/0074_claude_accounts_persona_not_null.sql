-- 0074_claude_accounts_persona_not_null.sql
--
-- v3 commercial 反关联指纹差异化 phase 2:0073 加了 nullable persona 列后,
-- 经由 scripts/backfill-account-persona.ts 给所有现有行写完 persona,在这里
-- 把 column 锁紧 NOT NULL 并加 schema 完整性 CHECK。
--
-- 上线前置条件(部署 SOP 必检):
--   1) 0073 已运行。
--   2) scripts/backfill-account-persona.ts 已运行,无失败。
--   3) staging 上验证:
--        SELECT count(*) - count(persona) FROM claude_accounts;  -- 必须 = 0
--   4) account-pool/persona.ts 的 generatePersona() 已 ship 到 master,
--      新建 account 流程已经会写 persona(否则 NOT NULL 会卡住 createAccount)。
--
-- CHECK 约束哲学:
--   只校验"必备 keys 存在 + 类型正确",不约束"具体取值"(取值池由 persona.ts
--   维护,演进会很频繁)。这样:
--     - schema drift 早暴露(漏 key 会被直接拒)。
--     - 取值池更新无需 migration。
--
-- 必备 keys(下面 ?& ARRAY 显式存在性校验 + 逐 key jsonb_typeof = 'string' 类型校验):
--   user_agent / x_stainless_arch / x_stainless_lang / x_stainless_os /
--   x_stainless_package_version / x_stainless_runtime /
--   x_stainless_runtime_version / x_stainless_retry_count /
--   accept_language
--
-- 实施(Codex Round 4 BLOCKER #1 修复):
--   早期实现仅靠 `jsonb_typeof(persona->'<key>') = 'string'` 链式 AND,在 PG
--   三值逻辑下会漏检"缺 key":
--     - persona->'absent_key' 返回 SQL NULL(而非 JSONB null)
--     - jsonb_typeof(NULL::jsonb) = NULL
--     - NULL = 'string' → NULL
--     - TRUE AND NULL = NULL
--     - CHECK 仅在表达式 = FALSE 时违反;NULL 视为"未违反" → 漏检
--   正确写法用 `persona ?& ARRAY[...]`(显式存在性,所有 key 都得出现,返回
--   严格 BOOLEAN),再叠加 jsonb_typeof = 'string' 做类型校验。
--   两道关之后,缺 key 在第一道直接 FALSE 触发 CHECK 违反。

ALTER TABLE claude_accounts
  ALTER COLUMN persona SET NOT NULL,
  ADD CONSTRAINT claude_accounts_persona_shape CHECK (
    jsonb_typeof(persona) = 'object'
    AND persona ?& ARRAY[
      'user_agent',
      'x_stainless_arch',
      'x_stainless_lang',
      'x_stainless_os',
      'x_stainless_package_version',
      'x_stainless_runtime',
      'x_stainless_runtime_version',
      'x_stainless_retry_count',
      'accept_language'
    ]
    AND jsonb_typeof(persona->'user_agent') = 'string'
    AND jsonb_typeof(persona->'x_stainless_arch') = 'string'
    AND jsonb_typeof(persona->'x_stainless_lang') = 'string'
    AND jsonb_typeof(persona->'x_stainless_os') = 'string'
    AND jsonb_typeof(persona->'x_stainless_package_version') = 'string'
    AND jsonb_typeof(persona->'x_stainless_runtime') = 'string'
    AND jsonb_typeof(persona->'x_stainless_runtime_version') = 'string'
    AND jsonb_typeof(persona->'x_stainless_retry_count') = 'string'
    AND jsonb_typeof(persona->'accept_language') = 'string'
  );
