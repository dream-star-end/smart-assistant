-- 0013 把 agent_containers.secret_hash 由 TEXT 升到 BYTEA
--
-- 见 codex 审计 round 1 (FAIL #3) — 0012 不能改写,任何已 applied 0012 (TEXT 版)
-- 的环境如果让 0012 重新跑必然 NO-OP,导致 supervisor 写 BYTEA 时 PG 报类型不匹配。
-- 必须新增 migration 显式 ALTER 列类型。
--
-- 见 codex 审计 round 2 (WARN #1) — 防御历史 commit aa81527 上 0012 已被 applied
-- 为 BYTEA 的"中间坏状态"环境(0012 BYTEA 已落,0013 schema_migrations 未记)。
-- 这种环境再跑 0013 时,USING 表达式里 `~`/`length()` 是 TEXT 操作,在 BYTEA 列上
-- 会语法报错。所以 0013 改成"先看现状再决定"的 DO block:
--   - 当前 TEXT → 真做 ALTER + USING 转换
--   - 当前 BYTEA → 已经是目标态,跳过
--   - 其它 → 抛异常,不掩盖未知 schema 漂移
--
-- 行为:
--   - 已 applied 旧 0012 (TEXT) 的环境:0013 真做 ALTER COLUMN secret_hash TYPE BYTEA
--   - 全新环境:0012 先建 TEXT,0013 立刻升 BYTEA
--   - aa81527 era 上跑过 auto-migrate(0012 BYTEA 已落)的环境:0013 走 NO-OP 分支
--   - 已 applied 0013 的环境:schema_migrations 直接 skip(runner 级别,不进 SQL)
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

DO $$
DECLARE
  current_type text;
BEGIN
  SELECT data_type INTO current_type
    FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'agent_containers'
     AND column_name = 'secret_hash';

  IF current_type = 'text' THEN
    EXECUTE $sql$
      ALTER TABLE agent_containers
        ALTER COLUMN secret_hash TYPE BYTEA
        USING (
          CASE
            WHEN secret_hash IS NULL THEN NULL
            WHEN secret_hash ~ '^[0-9a-fA-F]+$' AND length(secret_hash) % 2 = 0
              THEN decode(secret_hash, 'hex')
            ELSE convert_to(secret_hash, 'UTF8')
          END
        )
    $sql$;
  ELSIF current_type = 'bytea' THEN
    -- aa81527 era 已 applied 0012-as-BYTEA,跳过
    NULL;
  ELSIF current_type IS NULL THEN
    -- 0012 未 applied(理论上 runner 严格按版本号顺序跑,不会走到这里)
    RAISE EXCEPTION
      '0013 prerequisite missing: agent_containers.secret_hash column not found';
  ELSE
    RAISE EXCEPTION
      '0013 found unexpected agent_containers.secret_hash type: %', current_type;
  END IF;
END $$;

COMMENT ON COLUMN agent_containers.secret_hash IS
  'V3 §3.2: SHA-256(secret_bytes) of the per-container long-lived secret (identity factor B). '
  '32-byte BYTEA after 0013 ALTER. Plain secret only ever lives in container env '
  '(ANTHROPIC_AUTH_TOKEN=oc-v3.<cid>.<secret>) and is timing-safe-compared by edge proxy.';
