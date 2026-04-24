-- 0028 — 远程执行机 (Remote SSH Host) 元数据表
--
-- FEATURE_REMOTE_SSH (灰度 flag) 功能:用户在 claudeai.chat 上配置 SSH 主机后,
-- 切换执行环境到远程机。ccb 仍在容器里跑,Bash/Read/Write 等 tool 通过 gateway
-- 起的 SSH ControlMaster 到远端执行;远端"零安装"。
--
-- 密码 AEAD(AES-256-GCM)加密:password_nonce(12B) + password_ct(ct||tag)。
-- AAD = "remote-host-pw:" || user_id || ":" || host_id,绑定用户+主机上下文,
-- 防止跨用户/跨记录重放。
--
-- fingerprint 是 TOFU host key,语义严格:
--   - IS NULL:首次 test 成功时写入
--   - 非空:后续连接必须严格相等,不等视为拒绝连接 + 记 last_test_error
--   - 用户显式 POST /:id/reset-fingerprint 才允许重新 TOFU
--
-- 幂等:IF NOT EXISTS 全覆盖。

CREATE TABLE IF NOT EXISTS user_remote_hosts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 用户可见
  name            TEXT NOT NULL,
  host            TEXT NOT NULL,
  port            INT  NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  username        TEXT NOT NULL,
  remote_workdir  TEXT NOT NULL DEFAULT '~',

  -- 凭据(AEAD; AAD 绑定 user_id+host_id)
  password_nonce  BYTEA NOT NULL,
  password_ct     BYTEA NOT NULL,

  -- SSH host key TOFU
  fingerprint     TEXT,

  -- 探测 / 使用记录(test API 更新)
  last_test_ok    BOOLEAN,
  last_test_error TEXT,
  last_used_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 同一用户内名字唯一;不做全局唯一(不同用户可以都叫 "my-vps")
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_user_remote_hosts_user
  ON user_remote_hosts (user_id);
