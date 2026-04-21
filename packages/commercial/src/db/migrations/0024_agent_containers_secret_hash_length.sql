-- 0024 agent_containers.secret_hash length CHECK (=32 bytes)
--
-- 2026-04-22 Codex R1 I7 follow-up — 0013 把 secret_hash 迁成 bytea,0023 加了
-- NOT NULL,但没有列长度约束。应用层 supervisor 写的是 SHA-256 (32 byte),
-- 边缘代理 verifyContainerIdentity 走 timingSafeEqual,两边长度不等会直接 false。
-- 但 schema 还是允许塞 0 字节或 64 字节(比如误把 hex 字符串当 bytea 插入,长度
-- 会变成 ASCII 64 → timing-safe 每次都返 false 但数据层不报错)。
--
-- 加 octet_length=32 约束:任何 SHA-256 之外长度的 bytea 都被 PG 拒掉,把"配
-- 置错误导致的 silent-auth-fail"变成"可见的 constraint violation"。
--
-- 0023 里填入的 deadbeef…ee11 占位是 16 字节 hex 字符串 decode 后 = 32 byte,符合约束,
-- 不会被这条 CHECK 拦住(我们验算过:decode('deadbeef'*8, 'hex') = 32 byte 输出)。
--
-- 幂等:IF NOT EXISTS 约束检查放到 DO block 里(PG 原生 CHECK 不支持 IF NOT EXISTS)。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'agent_containers'::regclass
       AND conname  = 'agent_containers_secret_hash_len32'
  ) THEN
    ALTER TABLE agent_containers
      ADD CONSTRAINT agent_containers_secret_hash_len32
      CHECK (octet_length(secret_hash) = 32) NOT VALID;
    -- NOT VALID:对已有行先不校验(它们要么是 supervisor 写的 32byte,要么是 0023
    -- 占位也是 32byte,理论上都通过;但这里走 NOT VALID 再 VALIDATE 是最稳路径,
    -- 避免迁移时遇上手工插入的脏数据直接阻塞上线)。
    ALTER TABLE agent_containers
      VALIDATE CONSTRAINT agent_containers_secret_hash_len32;
  END IF;
END$$;

COMMENT ON CONSTRAINT agent_containers_secret_hash_len32 ON agent_containers IS
  'V3 §3.2: secret_hash 必须是 SHA-256 输出 (32 byte). '
  'Schema 层拒掉长度不对的 bytea,防止应用 bug 静默写成空/hex 字符串后 edge-proxy '
  'verifyContainerIdentity 永远 false 的 silent-auth-fail 模式。';
