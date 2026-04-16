# 04 接口规范(API)

## 约定

- 基地址:`https://claudeai.chat`
- 所有 JSON 请求 Content-Type: `application/json`
- 所有响应体:
  ```json
  { "ok": true, "data": {...} }
  { "ok": false, "error": { "code": "ERR_CODE", "message": "human readable", "req_id": "..." } }
  ```
- 认证头:`Authorization: Bearer <access_token>`
- trace id:每个响应回写 `X-Request-Id`
- 时间统一 ISO 8601 UTC

## 错误码总表

| code | HTTP | 语义 |
|------|------|------|
| `ERR_VALIDATION` | 400 | 入参不合法 |
| `ERR_UNAUTHORIZED` | 401 | 未登录 / token 无效 |
| `ERR_FORBIDDEN` | 403 | 已登录但无权限 |
| `ERR_NOT_FOUND` | 404 | 资源不存在 |
| `ERR_CONFLICT` | 409 | 幂等冲突 |
| `ERR_RATE_LIMITED` | 429 | 被限流 |
| `ERR_INSUFFICIENT_CREDITS` | 402 | 积分不足 |
| `ERR_ACCOUNT_POOL_UNAVAILABLE` | 503 | 账号池全部不可用 |
| `ERR_AGENT_NOT_SUBSCRIBED` | 402 | 未开通 Agent |
| `ERR_AGENT_NOT_READY` | 503 | Agent 容器未就绪 |
| `ERR_INTERNAL` | 500 | 未分类错误 |

---

## 1. 认证 /api/auth/*

### POST `/api/auth/register`
```json
// req
{
  "email": "user@example.com",
  "password": "********",
  "turnstile_token": "..."
}
// res 200
{ "ok": true, "data": { "user_id": 42, "verify_email_sent": true } }
```
失败:`ERR_VALIDATION`(邮箱格式/弱密码)、`ERR_CONFLICT`(邮箱已注册)。

### POST `/api/auth/verify-email`
```json
// req
{ "token": "<from email>" }
// res 200
{ "ok": true, "data": { "verified": true } }
```

### POST `/api/auth/login`
```json
// req
{ "email": "...", "password": "...", "turnstile_token": "..." }
// res 200
{
  "ok": true,
  "data": {
    "access_token": "<jwt>",
    "refresh_token": "<opaque>",
    "access_expires_in": 900,
    "user": { "id": 42, "email": "...", "role": "user", "credits": 1000 }
  }
}
```

### POST `/api/auth/refresh`
```json
// req
{ "refresh_token": "..." }
// res 200
{ "ok": true, "data": { "access_token": "...", "access_expires_in": 900 } }
```

### POST `/api/auth/logout`
```json
// req
{ "refresh_token": "..." }
// res 200
{ "ok": true, "data": { "revoked": true } }
```

### POST `/api/auth/password/reset-request`
```json
// req
{ "email": "...", "turnstile_token": "..." }
// res 200 (无论邮箱是否存在都返回 200,防枚举)
{ "ok": true, "data": { "sent": true } }
```

### POST `/api/auth/password/reset-confirm`
```json
// req
{ "token": "<from email>", "new_password": "..." }
// res 200
{ "ok": true, "data": { "ok": true } }
```

---

## 2. 个人资料 /api/me

**所有 /api/me/* 需登录。**

### GET `/api/me`
```json
// res 200
{
  "ok": true,
  "data": {
    "id": 42, "email": "...", "email_verified": true,
    "display_name": "alice", "avatar_url": null,
    "role": "user", "credits": 1000,
    "status": "active",
    "created_at": "2026-04-17T02:00:00Z"
  }
}
```

### PATCH `/api/me`
```json
// req (任一字段可选)
{ "display_name": "bob", "avatar_url": null }
// res 200
{ "ok": true, "data": { ...user } }
```

### POST `/api/me/password`
```json
// req
{ "old_password": "...", "new_password": "..." }
// res 200 (成功会吊销所有其他 refresh token)
{ "ok": true, "data": { "updated": true, "other_sessions_revoked": 2 } }
```

### DELETE `/api/me`
```json
// req
{ "password": "..." }
// res 200 (软删除,进入 30d 冷却)
{ "ok": true, "data": { "status": "deleting", "hard_delete_at": "2026-05-17T02:00:00Z" } }
```

---

## 3. 计费 /api/billing/*

### GET `/api/billing/balance`
```json
// res 200
{ "ok": true, "data": { "credits": 1000, "credits_cents": 100000 } }
```

### GET `/api/billing/ledger?limit=50&before=<ledger_id>&reason=chat`
```json
// res 200
{
  "ok": true,
  "data": {
    "items": [
      { "id": 123, "delta": -50, "balance_after": 950, "reason": "chat",
        "ref_type": "usage", "ref_id": "999",
        "memo": "claude-sonnet-4-6 in=1k out=2k",
        "created_at": "..." }
    ],
    "has_more": true
  }
}
```

### GET `/api/billing/usage?limit=50&before=<id>`
返回 `usage_records`,字段含 input/output/cache_read/cache_write/price_snapshot/cost_credits。

---

## 4. 充值 /api/payment/*

### GET `/api/payment/plans`
```json
// res 200
{
  "ok": true,
  "data": {
    "plans": [
      { "code": "plan-10", "label": "¥10", "amount_cents": 1000, "credits": 1000 },
      ...
    ]
  }
}
```

### POST `/api/payment/hupi/create`
```json
// req
{ "plan_code": "plan-10" }
// res 200
{
  "ok": true,
  "data": {
    "order_no": "20260417-abcde",
    "qrcode_url": "https://...",
    "expires_at": "...",
    "amount_cents": 1000
  }
}
```

### POST `/api/payment/hupi/callback`
虎皮椒异步回调,**不需要认证**,但校验签名。
```
req (form-urlencoded, 虎皮椒格式):
  trade_order_id=20260417-abcde
  transaction_id=...
  total_fee=10.00
  status=OD
  hash=<md5>

res: 200 "success"(文本)
```
幂等:重复回调只处理一次。

### GET `/api/payment/orders/:order_no`
```json
{
  "ok": true,
  "data": {
    "order_no": "...", "status": "paid", "amount_cents": 1000,
    "credits": 1000, "created_at": "...", "paid_at": "..."
  }
}
```

---

## 5. Chat /api/chat & /ws/chat

### POST `/api/chat` (非流式,备用)
```json
// req
{
  "model": "claude-sonnet-4-6",
  "messages": [{ "role": "user", "content": "hi" }],
  "max_tokens": 2000,
  "temperature": 1.0
}
// res 200
{
  "ok": true,
  "data": {
    "id": "msg_...",
    "content": [{ "type": "text", "text": "..." }],
    "stop_reason": "end_turn",
    "usage": { "input_tokens": 10, "output_tokens": 20, "cache_read_tokens": 0, "cache_write_tokens": 0 },
    "cost_credits": 5
  }
}
```
积分不足 → 402 `ERR_INSUFFICIENT_CREDITS`,body 含 `required_credits` 和 `current_credits`。

### WS `/ws/chat`
客户端:
```
connect with ?token=<access_token>
→ send: { "type": "start", "model": "...", "messages": [...], "max_tokens": 2000 }
```
服务端帧:
```
{ "type": "delta", "text": "..." }
{ "type": "usage", "input_tokens": 10, "output_tokens": 20, ... }
{ "type": "debit", "cost_credits": 5, "balance_after": 995 }
{ "type": "done" }
{ "type": "error", "code": "ERR_...", "message": "..." }
```

---

## 6. Agent /api/agent/*

### GET `/api/agent/status`
```json
{
  "ok": true,
  "data": {
    "subscribed": true,
    "plan": "basic",
    "subscription_end_at": "2026-05-17T...",
    "container": {
      "status": "running",
      "docker_name": "agent-u42",
      "last_started_at": "..."
    },
    "usage_24h": { "cpu_avg": 0.05, "mem_avg_mb": 62 }
  }
}
```
未订阅:
```json
{ "ok": true, "data": { "subscribed": false, "plan_price_credits": 2900 } }
```

### POST `/api/agent/open`
```json
// req
{ "plan": "basic" }
// res 200
{
  "ok": true,
  "data": {
    "subscription_id": 7,
    "end_at": "2026-05-17T...",
    "container_status": "provisioning"
  }
}
```
扣积分;积分不足 → 402。同用户已有 active 订阅 → 409。

### POST `/api/agent/cancel`
取消自动续费,当前订阅期内仍可用。

### POST `/api/agent/restart`
重启 container(用户侧能用,排障用)。限频 1 次/5min。

### WS `/ws/agent`
连接用户专属 container(需已订阅 + container running)。
```
connect with ?token=<access_token>
→ bidirectional framing, frames 结构沿用 CCB stream-json 协议
```

---

## 7. 超管 /api/admin/*

**所有 /api/admin/* 需 role=admin。** 所有写操作自动写 `admin_audit`。

### GET `/api/admin/users?q=&status=&limit=&offset=`
### GET `/api/admin/users/:id`
### PATCH `/api/admin/users/:id`
```json
// req (任一)
{ "status": "banned", "role": "admin", "email_verified": true }
```

### POST `/api/admin/users/:id/credits`
```json
// req
{ "delta": 500, "memo": "customer support compensation" }
```

### GET `/api/admin/ledger?user_id=&reason=&limit=&before=`

### GET `/api/admin/accounts`
### POST `/api/admin/accounts`
```json
// req
{
  "label": "pro-boss-1",
  "plan": "pro",
  "oauth_token": "sk-ant-oat-...",
  "oauth_refresh_token": "...",
  "oauth_expires_at": "..."
}
```
**请求体中的明文 token 永不落 log**;服务端立即加密存库。

### PATCH `/api/admin/accounts/:id`
```json
// req
{ "status": "disabled" } | { "oauth_token": "new" } | { "health_score": 100 }
```

### DELETE `/api/admin/accounts/:id`

### GET `/api/admin/pricing`
### PATCH `/api/admin/pricing/:model_id`
```json
// req
{ "multiplier": 2.5, "enabled": true }
```

### GET `/api/admin/plans`
### PATCH `/api/admin/plans/:code`

### GET `/api/admin/agent-containers`
列出所有 agent container(包含状态、所属用户、资源占用近 24h)。

### POST `/api/admin/agent-containers/:id/restart` | `/stop` | `/remove`

### GET `/api/admin/metrics`
Prometheus 拉取用;admin 面板也从这里读。返回 text/plain。

### GET `/api/admin/audit?admin_id=&action=&limit=&before=`

---

## 8. 公共 /api/public/*

### GET `/api/public/models`
登录可选,返回启用的模型列表 + 计费估算提示。
```json
{
  "ok": true,
  "data": {
    "models": [
      { "id": "claude-sonnet-4-6", "display_name": "Sonnet 4.6",
        "input_per_ktok_credits": 0.06, "output_per_ktok_credits": 0.3 }
    ]
  }
}
```

### GET `/healthz`
进程/依赖健康:
```json
{ "ok": true, "data": { "db": "up", "redis": "up", "accounts_active": 3 } }
```

---

## 全局限流

| 路由 | 限制 |
|------|------|
| `/api/auth/login` | 同 IP 5 次/1min,同邮箱 10 次/15min |
| `/api/auth/register` | 同 IP 3 次/1h,同 Turnstile 强校验 |
| `/api/auth/password/reset-request` | 同 IP 3 次/1h |
| `/api/payment/hupi/create` | 同用户 10 次/1h |
| `/api/chat`, `/ws/chat` | 同用户 3 并发 |
| 其他 `/api/*`(登录后) | 60 req/min |
| 其他 `/api/*`(未登录) | 10 req/min |

Last updated: 2026-04-17
