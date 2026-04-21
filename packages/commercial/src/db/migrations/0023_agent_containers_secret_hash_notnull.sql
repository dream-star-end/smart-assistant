-- 0023 agent_containers.secret_hash SET NOT NULL
--
-- 2026-04-21 安全审计 Medium#2 — 此前 secret_hash 列是 NULLABLE,边缘代理侧
-- verifyContainerIdentity 靠 `secret_hash IS NOT NULL` 隐式守护,但 schema 没
-- 强制约束。这意味着:
--   - 任何 DML / 人工 SQL 改动都可能误插入 NULL secret_hash 的 active 行;
--   - supervisor 代码若 future refactor 忘写 secret_hash,PG 不会拦;
--   - verifyContainerIdentity 逻辑同上 —— 依赖 app 代码做守护是脆弱契约。
--
-- 现实现(v3supervisor.ts:420)INSERT 必填 secret_hash($3::bytea,不会为 NULL),
-- 所以生产全量行都有值。但 v2 legacy 行(0012 之前的 old agent_containers 条目,
-- 0018 里已标 state='vanished')的 secret_hash 为 NULL —— 那些是旧数据,不会再被
-- 读。ALTER 前先 DELETE or null→empty-bytes 都不合适(secret_hash='' 会误匹配
-- 空 token)。最干净的做法:把残留 NULL 行标 state='vanished' + secret_hash 填
-- 一个固定"哨兵 bytea"(这里选 `deadbeefc0ffee11` 重复 4 次,直接 decode 16 进
-- 制,不走 SHA256 —— 只要是一个不会被任何真实 container secret 碰撞的 32-byte
-- 值即可),然后 SET NOT NULL。占位值永远不会被任何真实 container 算出,匹配必然失败。
--
-- 迁移顺序:
--   1. UPDATE 所有 secret_hash IS NULL 的行 → 占位 + state='vanished' + 打 audit 注释
--   2. ALTER COLUMN SET NOT NULL
--
-- 回滚:0024 DROP NOT NULL 即可。占位数据留着(它们是 vanished,不影响任何查询)。

-- Step 1: 把残留 NULL secret_hash 的行标 vanished + 填占位
UPDATE agent_containers
   SET secret_hash = decode('deadbeefc0ffee11deadbeefc0ffee11deadbeefc0ffee11deadbeefc0ffee11', 'hex'),
       state       = 'vanished',
       updated_at  = NOW()
 WHERE secret_hash IS NULL;

-- Step 2: 加 NOT NULL 约束
ALTER TABLE agent_containers
  ALTER COLUMN secret_hash SET NOT NULL;

COMMENT ON COLUMN agent_containers.secret_hash IS
  'V3 §3.2: SHA-256(secret_bytes) of the per-container long-lived secret (identity factor B). '
  '32-byte BYTEA (NOT NULL as of 0023). Plain secret only ever lives in container env '
  '(ANTHROPIC_AUTH_TOKEN=oc-v3.<cid>.<secret>) and is timing-safe-compared by edge proxy. '
  'Legacy v2 NULL rows were backfilled with `deadbeef…ee11` placeholder + state=vanished '
  'in 0023 so they never match any real container secret.';
