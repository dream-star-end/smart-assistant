-- 0013 把 agent_containers.secret_hash 由 TEXT 升到 BYTEA
--
-- 见 codex 审计 round 1 (FAIL #3) — 0012 不能改写,任何已 applied 0012 (TEXT 版)
-- 的环境如果让 0012 重新跑必然 NO-OP,导致 supervisor 写 BYTEA 时 PG 报类型不匹配。
-- 必须新增 migration 显式 ALTER 列类型。
--
-- 行为:
--   - 已 applied 旧 0012 (TEXT) 的环境:0013 真做 ALTER COLUMN secret_hash TYPE BYTEA
--   - 全新环境:0012 先建 TEXT,0013 立刻升 BYTEA
--   - 已 applied 0013 的环境:schema_migrations 直接 skip
--
-- 数据兼容:
--   - MVP 阶段 staging 上 secret_hash 列实际未被任何生产代码写过(supervisor 3C 是
--     新功能,需要 0013 之后才能跑 provision),所以 USING 子句永远作用于空集。
--   - 严谨写 USING decode(secret_hash, 'hex') 兜住"将来真有 hex 字符串数据"的边角:
--     supervisor.hashSecretToBuffer 写的就是 32-byte SHA-256 buffer,落 TEXT 列的话
--     pg 会用 \x... bytea 字面量再 cast,USING decode-hex 是反向解。但既然实际为空,
--     这步是纯防御。
--
-- 注:NULL 值在 ALTER TYPE 下会保留为 NULL(USING 作用于非 NULL 行)。

ALTER TABLE agent_containers
  ALTER COLUMN secret_hash TYPE BYTEA
  USING (
    CASE
      WHEN secret_hash IS NULL THEN NULL
      WHEN secret_hash ~ '^[0-9a-fA-F]+$' AND length(secret_hash) % 2 = 0
        THEN decode(secret_hash, 'hex')
      ELSE convert_to(secret_hash, 'UTF8')
    END
  );

COMMENT ON COLUMN agent_containers.secret_hash IS
  'V3 §3.2: SHA-256(secret_bytes) of the per-container long-lived secret (identity factor B). '
  '32-byte BYTEA after 0013 ALTER. Plain secret only ever lives in container env '
  '(ANTHROPIC_AUTH_TOKEN=oc-v3.<cid>.<secret>) and is timing-safe-compared by edge proxy.';
