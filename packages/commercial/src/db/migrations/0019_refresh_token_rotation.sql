-- 0019_refresh_token_rotation.sql
--
-- 2026-04-21 安全审计 LOW — refresh token 轮换 + family + 盗用检测
--
-- 背景:
--   T-14 / 0001 的 refresh_tokens 一上线就被标了 "MVP 简化:不轮换"。同一
--   refresh raw token 30 天内可重复换 access,意味着:
--     - 任何一次 refresh 被中间人/XSS-precookie/服务端日志泄露,都可拿
--       30 天的 access 续命权
--     - 没有 "已盗用" 的检测信号:被偷的 token 用得跟正主一模一样
--
-- 行业标准做法(OAuth 2.1 §6 / IETF draft-ietf-oauth-security-topics):
--   1. refresh 必须每次轮换:旧 row revoked_at = NOW(),issue 新 row,把
--      新 raw 写回 cookie
--   2. 同一 "登录会话" 的 refresh 链共享 family_id;旧 → 新 的 rotation
--      链路靠 rotated_to_id 形成 audit chain
--   3. 盗用检测:如果客户端拿一张 已 revoked 但未自然过期 的 refresh 来
--      换,说明这张被 rotate 后又被复用 → 99% 是攻击者(正主已经拿到新的
--      refresh,不会回头用旧的)。立即把整个 family 全 revoke 掉,把攻击
--      者和正主都踢出去 — 再次登录即可,但这一刻起所有"在飞中的"被偷
--      token 全失效
--
-- 字段:
--   - family_id      UUID,同一登录会话的 refresh 链共享,rotation 不变
--                    历史行 backfill = gen_random_uuid() 各自独立(没办法
--                    回溯,等价于"每张老 token 自成一族")
--   - rotated_to_id  BIGINT 指向新 row(audit/forensics 用,运行时不依赖)
--   - revoked_reason TEXT 限定枚举:'logout' / 'rotated' / 'theft' /
--                    'password_reset' / 'admin'(用 CHECK 约束),NULL 允许
--                    (向后兼容 + 还没 revoke 的 active 行)
--
-- 索引:
--   - 已有 idx_rt_user 是 partial(WHERE revoked_at IS NULL),够 chat 热路径
--   - family_id 上加单独索引,theft 时一次性 mass revoke 一族
--
-- 兼容:
--   - 0001 的列全保留;只增量 ALTER TABLE 加列 + DEFAULT
--   - 应用代码升级前(login/refresh 旧逻辑还在)依然能跑:DEFAULT 给
--     family_id 自动填,新逻辑上线后开始按 family 写
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS family_id UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS rotated_to_id BIGINT NULL
    REFERENCES refresh_tokens(id) ON DELETE SET NULL;

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_revoked_reason_check'
  ) THEN
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT refresh_tokens_revoked_reason_check
      CHECK (
        revoked_reason IS NULL
        OR revoked_reason IN ('logout', 'rotated', 'theft', 'password_reset', 'admin')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family_id);
