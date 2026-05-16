-- 0067_claude_accounts_pinned_user_id.sql
--
-- v3 commercial 反风控:把"上报给 Anthropic 网关的客户端 device_id"从"容器随机"
-- 锚定到"账号身份",根治"一 account_uuid 关联大量短命 device_id"的号商画像。
--
-- 背景:
--   CCB 通过 SDK metadata.user_id JSON 串上报 `{device_id, account_uuid, session_id, ...}`
--   到 api.anthropic.com/v1/messages(`metadata.user_id` 是 Anthropic SDK 标准字段,
--   随 POST body 直达网关日志)。device_id 来自容器内 `~/.claude.json` userID(每个
--   新容器一次 randomBytes(32) → 64 hex)。由于 v3 容器按需短命,Anthropic 网关层
--   看到一个固定 account_uuid 关联大量 device_id,典型号商指纹。
--
-- 修复:
--   给每个 claude_accounts 行分配稳定 pinned_user_id(64 字符小写 hex, 32 random bytes
--   编码),master `anthropicProxy.ts` 选号后在转发前重写 `body.metadata.user_id.device_id`
--   为该账号的 pinned_user_id。Anthropic 看到的画像变为
--   "account_uuid=X ↔ device_id=X.pinned_user_id" 1:1 永久绑定。
--
-- Schema 约束:
--   - DEFAULT encode(gen_random_bytes(32), 'hex'):新 INSERT(包括 store.ts/createAccount)
--     自动拿合法值,不破坏现有 INSERT 兼容性
--   - NOT NULL + CHECK ^[0-9a-f]{64}$:运行时 invariant
--   - UNIQUE:防止任何 backfill / default 碰撞造成跨账号身份混淆
--
-- pgcrypto 依赖:gen_random_bytes 需 pgcrypto extension。虽然仓内已有 gen_random_uuid()
-- 用法(0019 / 0028 / 0030)暗示其可用,但 PG13+ gen_random_uuid 可能由 pgcrypto 之外
-- 路径提供,gen_random_bytes 仍硬依赖 pgcrypto。显式 CREATE EXTENSION IF NOT EXISTS 保
-- 部署正确性(尤其新环境拉新库时)。
--
-- 上线 backfill 验证(staging smoke test):
--   SELECT count(*), count(pinned_user_id), count(DISTINCT pinned_user_id)
--   FROM claude_accounts;
--   三个数应相等。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE claude_accounts
  ADD COLUMN pinned_user_id TEXT
    DEFAULT encode(gen_random_bytes(32), 'hex');

UPDATE claude_accounts
  SET pinned_user_id = encode(gen_random_bytes(32), 'hex')
  WHERE pinned_user_id IS NULL;

ALTER TABLE claude_accounts
  ALTER COLUMN pinned_user_id SET NOT NULL,
  ADD CONSTRAINT claude_accounts_pinned_user_id_hex64
    CHECK (pinned_user_id ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX claude_accounts_pinned_user_id_uq
  ON claude_accounts(pinned_user_id);
