# 03 数据模型(DATA MODEL)

本文件定义商业化模块的全部 PostgreSQL 表。所有 DDL 以迁移文件形式放入 `packages/commercial/src/db/migrations/`,命名规则 `NNNN_description.sql`(NNNN 递增 4 位)。

## 约定

- 所有表:`id BIGSERIAL PRIMARY KEY`,`created_at TIMESTAMPTZ DEFAULT NOW()`,`updated_at TIMESTAMPTZ DEFAULT NOW()`
- 金额字段统一用 `BIGINT`,单位 = **分**(credits 也按最小单位存,即 1 积分 = 100 cents,避免浮点)
- 所有外键 `ON DELETE RESTRICT`,强制业务层显式处理
- 时区统一 UTC

## 1. users — 用户表

```sql
CREATE TABLE users (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash   TEXT NOT NULL,                    -- argon2id
  display_name    TEXT,
  avatar_url      TEXT,
  role            TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user','admin')),
  credits         BIGINT NOT NULL DEFAULT 0,        -- 单位:分
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','banned','deleting','deleted')),
  deleted_at      TIMESTAMPTZ,                      -- 软删除时间
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_status ON users(status) WHERE status != 'deleted';
CREATE INDEX idx_users_deleted_at ON users(deleted_at) WHERE deleted_at IS NOT NULL;
```

## 2. email_verifications — 邮箱验证 / 密码重置令牌

```sql
CREATE TABLE email_verifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,                         -- sha256 of the raw token
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,                           -- 使用后置为 now
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ev_user ON email_verifications(user_id, purpose);
CREATE INDEX idx_ev_token ON email_verifications(token_hash);
```

## 3. refresh_tokens — JWT Refresh Token

```sql
CREATE TABLE refresh_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,                   -- sha256
  user_agent TEXT,
  ip         INET,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rt_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
```

## 4. model_pricing — 模型单价与倍率

```sql
CREATE TABLE model_pricing (
  model_id              TEXT PRIMARY KEY,              -- e.g. 'claude-sonnet-4-6'
  display_name          TEXT NOT NULL,
  input_per_mtok        BIGINT NOT NULL,               -- 每 1M token,单位:分
  output_per_mtok       BIGINT NOT NULL,
  cache_read_per_mtok   BIGINT NOT NULL,
  cache_write_per_mtok  BIGINT NOT NULL,
  multiplier            NUMERIC(6,3) NOT NULL DEFAULT 2.0, -- 倍率
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order            INTEGER NOT NULL DEFAULT 100,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by            BIGINT REFERENCES users(id)
);
```

**初始种子**(见迁移 `0002_seed_pricing.sql`):
| model_id | input | output | cache_r | cache_w | mul |
|----------|-------|--------|---------|---------|-----|
| claude-sonnet-4-6 | 300 | 1500 | 30 | 375 | 2.0 |
| claude-opus-4-7   | 1500| 7500 | 150| 1875 | 2.0 |

(分 / MTok,上面是官网 USD × 汇率 7.2 × 100 的约算,实际部署前 boss 核对)

## 5. credit_ledger — 积分流水(append-only)

```sql
CREATE TABLE credit_ledger (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  delta          BIGINT NOT NULL,                    -- 正=入账,负=扣费
  balance_after  BIGINT NOT NULL,                    -- 扣减后的余额快照
  reason         TEXT NOT NULL
                 CHECK (reason IN (
                   'topup','chat','agent_chat','agent_subscription',
                   'refund','admin_adjust','promotion'
                 )),
  ref_type       TEXT,                               -- e.g. 'order','usage','agent_sub'
  ref_id         TEXT,                               -- 对应业务表 id
  memo           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cl_user_time ON credit_ledger(user_id, created_at DESC);
CREATE INDEX idx_cl_reason ON credit_ledger(reason, created_at DESC);

-- 禁止 UPDATE 和 DELETE(append-only)
CREATE RULE cl_no_update AS ON UPDATE TO credit_ledger DO INSTEAD NOTHING;
CREATE RULE cl_no_delete AS ON DELETE TO credit_ledger DO INSTEAD NOTHING;
```

## 6. usage_records — LLM 用量明细

```sql
CREATE TABLE usage_records (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id),
  session_id          TEXT,                          -- chat 或 agent 会话 id
  mode                TEXT NOT NULL CHECK (mode IN ('chat','agent')),
  account_id          BIGINT REFERENCES claude_accounts(id), -- 路由到的账号
  model               TEXT NOT NULL,
  input_tokens        BIGINT NOT NULL DEFAULT 0,
  output_tokens       BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens  BIGINT NOT NULL DEFAULT 0,
  price_snapshot      JSONB NOT NULL,                -- 计费时刻的价格 + 倍率
  cost_credits        BIGINT NOT NULL,               -- 扣了多少积分(单位:分)
  ledger_id           BIGINT REFERENCES credit_ledger(id),
  request_id          TEXT NOT NULL,                 -- trace id
  status              TEXT NOT NULL CHECK (status IN ('success','billing_failed','error')),
  error_msg           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ur_user_time ON usage_records(user_id, created_at DESC);
CREATE INDEX idx_ur_account ON usage_records(account_id, created_at DESC);
CREATE INDEX idx_ur_req ON usage_records(request_id);
```

## 7. claude_accounts — 账号池

```sql
CREATE TABLE claude_accounts (
  id                  BIGSERIAL PRIMARY KEY,
  label               TEXT NOT NULL,                 -- 超管可读标签,e.g. 'pro-boss-1'
  plan                TEXT NOT NULL CHECK (plan IN ('pro','max','team')),
  oauth_token_enc     BYTEA NOT NULL,                -- AES-256-GCM 密文
  oauth_nonce         BYTEA NOT NULL,                -- GCM nonce(12 bytes)
  oauth_refresh_enc   BYTEA,                         -- refresh token 密文(可空)
  oauth_refresh_nonce BYTEA,
  oauth_expires_at    TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','cooldown','disabled','banned')),
  health_score        INTEGER NOT NULL DEFAULT 100,  -- 0-100
  cooldown_until      TIMESTAMPTZ,
  last_used_at        TIMESTAMPTZ,
  last_error          TEXT,
  success_count       BIGINT NOT NULL DEFAULT 0,
  fail_count          BIGINT NOT NULL DEFAULT 0,
  quota_remaining     INTEGER,                       -- 估算剩余额度(optional)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ca_schedulable
  ON claude_accounts(health_score DESC)
  WHERE status = 'active';
```

## 8. orders — 订单表(充值)

```sql
CREATE TABLE orders (
  id             BIGSERIAL PRIMARY KEY,
  order_no       TEXT NOT NULL UNIQUE,               -- 本地订单号 YYYYMMDD-UUID
  user_id        BIGINT NOT NULL REFERENCES users(id),
  provider       TEXT NOT NULL CHECK (provider IN ('hupijiao')),
  provider_order TEXT,                               -- 第三方订单号
  amount_cents   BIGINT NOT NULL,                    -- 用户支付金额(分,人民币)
  credits        BIGINT NOT NULL,                    -- 对应到账积分(分)
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','paid','expired','refunded','canceled')),
  paid_at        TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL,               -- pending 超时时间
  callback_payload JSONB,                            -- 回调原文留证
  ledger_id      BIGINT REFERENCES credit_ledger(id),
  refunded_ledger_id BIGINT REFERENCES credit_ledger(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders(status, expires_at) WHERE status = 'pending';
```

## 9. topup_plans — 充值套餐(可管理)

```sql
CREATE TABLE topup_plans (
  id           BIGSERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,                 -- e.g. 'plan-10'
  label        TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  credits      BIGINT NOT NULL,                      -- 到账积分(含赠送)
  sort_order   INTEGER NOT NULL DEFAULT 100,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**初始种子**:
| code | amount_cents | credits | label |
|------|-------------:|--------:|-------|
| plan-10   | 1000   | 1000    | ¥10 → 10 积分 |
| plan-50   | 5000   | 5500    | ¥50 → 55 积分(赠10%) |
| plan-200  | 20000  | 24000   | ¥200 → 240 积分(赠20%) |
| plan-1000 | 100000 | 130000  | ¥1000 → 1300 积分(赠30%) |

## 10. agent_subscriptions — Agent 订阅

```sql
CREATE TABLE agent_subscriptions (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan           TEXT NOT NULL CHECK (plan IN ('basic')),   -- 后续加档
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','expired','canceled','suspended')),
  start_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_at         TIMESTAMPTZ NOT NULL,
  auto_renew     BOOLEAN NOT NULL DEFAULT FALSE,
  last_renewed_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 每用户只能有一个 active 订阅
CREATE UNIQUE INDEX idx_as_one_active_per_user
  ON agent_subscriptions(user_id) WHERE status = 'active';

CREATE INDEX idx_as_end_at ON agent_subscriptions(end_at) WHERE status = 'active';
```

## 11. agent_containers — Agent 容器实例

```sql
CREATE TABLE agent_containers (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  subscription_id BIGINT NOT NULL REFERENCES agent_subscriptions(id),
  docker_id       TEXT,                              -- docker container id
  docker_name     TEXT NOT NULL,                     -- 'agent-u{uid}'
  workspace_volume TEXT NOT NULL,                    -- 'agent-u{uid}-workspace'
  home_volume     TEXT NOT NULL,
  image           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'provisioning'
                  CHECK (status IN (
                    'provisioning','running','stopped','removed','error'
                  )),
  last_started_at TIMESTAMPTZ,
  last_stopped_at TIMESTAMPTZ,
  volume_gc_at    TIMESTAMPTZ,                       -- volume 将被清理的时间
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## 12. agent_audit — Agent 工具调用审计

```sql
CREATE TABLE agent_audit (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  session_id  TEXT NOT NULL,
  tool        TEXT NOT NULL,                          -- 'bash','file','web',...
  input_meta  JSONB NOT NULL,                         -- 工具参数元数据(脱敏)
  input_hash  TEXT,                                   -- sha256 原参数(可追查)
  output_hash TEXT,
  duration_ms INTEGER,
  success     BOOLEAN NOT NULL,
  error_msg   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_aa_user_time ON agent_audit(user_id, created_at DESC);
CREATE INDEX idx_aa_tool ON agent_audit(tool, created_at DESC);
```

## 13. admin_audit — 超管操作审计

```sql
CREATE TABLE admin_audit (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   BIGINT NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,                           -- e.g. 'user.ban','pricing.update'
  target     TEXT,                                    -- e.g. 'user:42','account:7'
  before     JSONB,
  after      JSONB,
  ip         INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_aa_admin_time ON admin_audit(admin_id, created_at DESC);
CREATE INDEX idx_aa_action_time ON admin_audit(action, created_at DESC);

CREATE RULE aa_no_update AS ON UPDATE TO admin_audit DO INSTEAD NOTHING;
CREATE RULE aa_no_delete AS ON DELETE TO admin_audit DO INSTEAD NOTHING;
```

## 14. rate_limit_events — 限流事件(反滥用审计,保留 30 天)

```sql
CREATE TABLE rate_limit_events (
  id         BIGSERIAL PRIMARY KEY,
  scope      TEXT NOT NULL,                           -- 'login','register','chat'
  key        TEXT NOT NULL,                           -- 'ip:1.2.3.4' or 'user:42'
  blocked    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rle_time ON rate_limit_events(created_at);
-- 表体量会很大,定期 DELETE WHERE created_at < NOW() - INTERVAL '30 days'
```

## 迁移管理

- 文件:`packages/commercial/src/db/migrations/NNNN_*.sql`
- 版本表:
  ```sql
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```
- 启动时:`migrate.ts` 按文件名顺序执行未记录的迁移,每个迁移一个事务,失败回滚
- **回滚**:不自动回滚;需要时手写 `NNNN_rollback.sql` 人工执行

## 迁移文件清单(顺序)

```
0001_init_users_auth.sql              -- users / email_verifications / refresh_tokens
0002_init_billing.sql                 -- model_pricing / credit_ledger / usage_records
0003_init_payment.sql                 -- orders / topup_plans
0004_init_account_pool.sql            -- claude_accounts
0005_init_agent.sql                   -- agent_subscriptions / agent_containers / agent_audit
0006_init_audit.sql                   -- admin_audit / rate_limit_events
0007_seed_pricing.sql                 -- 默认 model_pricing 两条 + topup_plans 四条
```

Last updated: 2026-04-17
