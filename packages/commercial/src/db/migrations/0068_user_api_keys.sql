-- 0068 user_api_keys
--
-- V3 CC 外接 plan §3.2.1(2026-05-18,docs/V3_CC_EXTERNAL_ENDPOINT_PLAN_2026-05-18.md)。
-- 用户级 API key:本地 Claude Code 配 URL + Bearer 直接调 v3 后端,无需容器栈。
--
-- 设计要点:
--   - hash-only 存储:服务端永不持明文 secret(同容器 Bearer 模型)。
--     key_hash = SHA-256(Buffer.from(secretHex, "hex")) → 32 字节 raw bytea;
--     必须跟 auth/containerIdentity.ts:111 hashSecret 长出同型行为
--     (hash 输入是 raw 字节,**不是** UTF-8 hex 字符串)。
--   - key_prefix 8 字符 lowercase base36([0-9a-z])。
--     用途:O(1) 查表索引 + 展示前缀(用户面板/log 标识同一 key)。
--     熵 36^8 ≈ 2.82e12,单用户预期 < 10 个 key,碰撞概率工程上为零;
--     UNIQUE 约束 + 创建时 ≤ 3 次重试兜底(plan §4 invariant #3)。
--   - 撤销:revoked_at 软删除(保留审计;plan §4 invariant #2 立即生效)。
--   - label CHECK:1..80 chars after btrim,DB 层强制有意义命名。
--     API/repo 层 trim 后早 fail,DB CHECK 是 belt-and-suspenders。
--
-- 关联表:
--   - users:ON DELETE CASCADE,用户被删 → 所属 key 一并清(无 orphan、无审计意义)。
--
-- 索引选择:
--   - PK(id):自然全局唯一。
--   - UNIQUE(key_prefix):承担"按 prefix O(1) 查表"主路径,无需额外索引。
--   - PARTIAL INDEX(user_id) WHERE revoked_at IS NULL:管理面
--     GET /api/me/api-keys 只列 active key,partial index 小于 user_id 全列。
--   - 不加 (user_id, id) / (user_id, created_at) — 单用户 key 量极小(预期 < 10),
--     管理面顺序扫描已足够。
--   - 不加 key_hash 索引 — 永远先按 prefix 拿到唯一 row 再 timing-safe 比对,
--     不存在按 hash 反查场景。
--
-- 不在此 migration 做(plan §8 划走):
--   - api_key_id 进 journal / ctx —— MVP 按 uid 计费,未来 per-key cap 才扩 ctx。
--   - IP allowlist / expires_at / rotate —— 后续迭代。

CREATE TABLE user_api_keys (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  key_prefix      TEXT NOT NULL,
  key_hash        BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  UNIQUE (key_prefix),
  CHECK (length(btrim(label)) BETWEEN 1 AND 80)
);

CREATE INDEX idx_uak_user_active ON user_api_keys(user_id) WHERE revoked_at IS NULL;
