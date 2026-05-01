-- 0052_egress_proxies.sql
-- egress_proxies — 可复用 egress proxy URL 池表。
--
-- 背景:
--   0010 给 claude_accounts 加 egress_proxy 列承接每账号 raw URL。随着账号数
--   增加 + 同一住宅 IP 复用多账号场景出现,raw URL 散落在每行难维护。本表
--   引入"代理池":admin 在池里登记 entry(label + URL),账号通过 0053 加的
--   egress_proxy_id 引用 entry,运行时 JOIN 解密拿 URL。
--
-- 加密设计:
--   url_enc + url_nonce — AES-256-GCM(crypto/aead.ts),与 oauth_token_enc
--   同模式;每行独立 12B nonce,绝不复用;UPDATE url 必须 regen nonce。
--   list 接口永不返还密文/明文,只返 masked host:port(避免 admin UI 不慎
--   截图泄漏密码)。
--
-- label UNIQUE:
--   admin UI 用 label 选代理,UNIQUE 防同名混淆。应用层 cap 长度 ≤120 字符
--   防 DoS。
--
-- status:
--   active  → list 默认可用,新建/编辑账号 dropdown 出现
--   disabled→ 池里保留,不出现在 dropdown,已绑账号继续工作直到管理员手动解绑
--
-- 与 claude_accounts.egress_proxy 文本列共存:
--   0053 加的 egress_proxy_id 优先;若 NULL 回落到 raw 文本(0010 列)。
--   迁移期 admin UI 互斥校验确保任一时刻只走一条路径。

CREATE TABLE egress_proxies (
  id          BIGSERIAL PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,
  url_enc     BYTEA NOT NULL,
  url_nonce   BYTEA NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'disabled')),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ep_status ON egress_proxies(status);

COMMENT ON TABLE egress_proxies IS
  'V3 egress proxy pool: reusable HTTP/SOCKS proxy URLs (encrypted). '
  'Referenced by claude_accounts.egress_proxy_id (0053).';

COMMENT ON COLUMN egress_proxies.url_enc IS
  'AES-256-GCM ciphertext of full proxy URL (e.g. http://user:pass@host:port). '
  'Per-row 12B nonce in url_nonce; nonce regenerated on every UPDATE.';
