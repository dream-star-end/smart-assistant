-- 0137 — selfheal 用户恢复通知:精确影响证据 + 冻结收件人 + 企业微信人工审批。
--
-- 默认 fail-closed:所有存量 policy 的 user_notice_enabled=false。只有真实失败证据、可信
-- 自动修复回执、fresh probe 恢复三者闭合后才可建 proposal；最终发送仍需绑定审批人同意。

-- 0136 是已发布的历史迁移，不能改写。部分环境曾按双重门启用 writer guard；
-- 当前回滚池仍含旧 writer，因此本迁移显式把所有环境收敛回“暂缓 guard”。真实 SQL
-- 保留在 db/deferred/selfheal_writer_guard.sql，未来双重门满足后以新的迁移版本重新启用。
DROP TRIGGER IF EXISTS trg_guard_alert_condition_write ON admin_alert_rule_state;
DROP FUNCTION IF EXISTS guard_alert_condition_write();
-- 0137 的最终 schema 明确“不启用 0136 guard”。若某环境曾按旧 runbook 跳过 0136
-- 而直接手工 apply 0137，也必须补齐 ledger，避免后续 verifyIntegrity 判为乱序迁移。
INSERT INTO schema_migrations(version) VALUES ('0136_selfheal_writer_guard')
ON CONFLICT (version) DO NOTHING;

ALTER TABLE incident_policies
  ADD COLUMN IF NOT EXISTS user_notice_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE selfheal_user_impact_evidence (
  id             BIGSERIAL PRIMARY KEY,
  incident_id    BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  policy_id      BIGINT NOT NULL REFERENCES incident_policies(id) ON DELETE RESTRICT,
  condition_key  TEXT NOT NULL,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id     TEXT NOT NULL,
  target         TEXT NOT NULL,
  failure_code   TEXT NOT NULL,
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (incident_id, user_id, request_id)
);
CREATE INDEX idx_selfheal_impact_incident_time
  ON selfheal_user_impact_evidence (incident_id, observed_at DESC);

CREATE TABLE selfheal_notice_approver_bindings (
  id             BIGSERIAL PRIMARY KEY,
  channel_id     BIGINT NOT NULL REFERENCES admin_alert_channels(id) ON DELETE CASCADE,
  chat_id        TEXT NOT NULL,
  chat_type      TEXT NOT NULL CHECK (chat_type IN ('single','group')),
  from_user_id   TEXT NOT NULL,
  binding_code   TEXT NOT NULL UNIQUE,
  active         BOOLEAN NOT NULL DEFAULT FALSE,
  bound_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, chat_id, from_user_id)
);
CREATE UNIQUE INDEX ux_selfheal_notice_one_active_approver
  ON selfheal_notice_approver_bindings ((1)) WHERE active;

CREATE TABLE selfheal_user_notice_proposals (
  id                 BIGSERIAL PRIMARY KEY,
  incident_id        BIGINT NOT NULL REFERENCES incidents(id) ON DELETE RESTRICT,
  incident_rev       BIGINT NOT NULL,
  repair_id          BIGINT NOT NULL REFERENCES codex_repairs(id) ON DELETE RESTRICT,
  policy_id          BIGINT NOT NULL REFERENCES incident_policies(id) ON DELETE RESTRICT,
  condition_key      TEXT NOT NULL,
  target             TEXT NOT NULL,
  short_code         TEXT NOT NULL UNIQUE,
  recipients_hash    TEXT NOT NULL,
  recipient_count    INTEGER NOT NULL CHECK (recipient_count > 0),
  title              TEXT NOT NULL,
  message            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','sending','rejected','expired','sent','skipped')),
  channel_id         BIGINT NOT NULL REFERENCES admin_alert_channels(id) ON DELETE RESTRICT,
  approver_binding_id BIGINT REFERENCES selfheal_notice_approver_bindings(id) ON DELETE RESTRICT,
  approval_req_id    TEXT,
  approval_notified_at TIMESTAMPTZ,
  approval_claimed_at TIMESTAMPTZ,
  decision_req_id    TEXT,
  expires_at         TIMESTAMPTZ NOT NULL,
  approved_at        TIMESTAMPTZ,
  send_by            TIMESTAMPTZ,
  sent_at            TIMESTAMPTZ,
  sent_recipient_count INTEGER,
  receipt_claimed_at TIMESTAMPTZ,
  receipt_notified_at TIMESTAMPTZ,
  decision_reason    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repair_id)
);
CREATE INDEX idx_selfheal_notice_pending
  ON selfheal_user_notice_proposals (status, expires_at, id);

CREATE TABLE selfheal_user_notice_recipients (
  proposal_id    BIGINT NOT NULL REFERENCES selfheal_user_notice_proposals(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evidence_id    BIGINT NOT NULL REFERENCES selfheal_user_impact_evidence(id) ON DELETE RESTRICT,
  sent_at        TIMESTAMPTZ,
  PRIMARY KEY (proposal_id, user_id)
);

CREATE TABLE selfheal_wecom_inbound_dedupe (
  channel_id     BIGINT NOT NULL REFERENCES admin_alert_channels(id) ON DELETE CASCADE,
  req_id         TEXT NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, req_id)
);
