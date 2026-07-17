-- 0161_selfheal_release_requests — 批1b:放行→部署 durable async 账本(v5 侧权威)
--
-- RFC-v5-selfheal-batch1b §2:放行不再同步等个人版部署(部署会重启 master,同步
-- handler 很可能在写审计前被自己杀掉)。改为:admin 放行事务内锁 repair + 结构化校验
-- pending_release + 插入唯一 release request + 永久审计 + 202 返回 releaseRequestId;
-- 交付/回调各自异步驱动。
--
-- 关系化唯一活跃请求(ux_selfheal_release_active)**废除** 旧 detail.release_claimed
-- 第二权威:同一 repair 至多一条 queued/accepted/deploying 请求,由 DB 约束保证,
-- 不再靠 JSONB 字段 CAS(第二权威源必然漂移)。
--
-- selfheal_release_fuse:全局 Tier2 部署熔断(deploy_unknown 拉闸,人工清)。单例行
-- (id=1),PG/SQLite 双侧同构,人工 clear 走带审计的双侧收敛协议。

CREATE TABLE IF NOT EXISTS selfheal_release_requests (
  id BIGSERIAL PRIMARY KEY,
  release_request_id TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  repair_id BIGINT NOT NULL REFERENCES codex_repairs(id) ON DELETE CASCADE,
  incident_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','accepted','deploying','deployed','deploy_failed','deploy_unknown','manual_required','cancelled')),
  requested_by TEXT NOT NULL,
  approved_sha TEXT NOT NULL CHECK (approved_sha ~ '^[0-9a-f]{40}$'),
  base_sha TEXT CHECK (base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}$'),
  deploy_plan_hash TEXT,
  manifest_hash TEXT,
  plan_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  next_delivery_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);
-- 唯一活跃请求(关系约束,废除 detail.release_claimed 第二权威)
CREATE UNIQUE INDEX IF NOT EXISTS ux_selfheal_release_active
  ON selfheal_release_requests(repair_id)
  WHERE status IN ('queued','accepted','deploying');
CREATE INDEX IF NOT EXISTS idx_selfheal_release_due
  ON selfheal_release_requests(next_delivery_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS selfheal_release_fuse (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  engaged BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT,
  release_request_id TEXT,
  engaged_at TIMESTAMPTZ,
  engaged_by TEXT,
  cleared_at TIMESTAMPTZ,
  cleared_by TEXT,
  personal_ack_at TIMESTAMPTZ
);
INSERT INTO selfheal_release_fuse (id, engaged) VALUES (1, FALSE) ON CONFLICT DO NOTHING;
