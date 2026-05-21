-- 0070_claude_accounts_account_uuid.sql
--
-- v3 commercial Phase 6:把 metadata.user_id.account_uuid 从 HMAC 派生占位
-- 升级为 OAuth account 在 Anthropic 端的真 UUID,与 0067 device_id pin 配套
-- 形成 "device_id ↔ account_uuid" 1:1 永久双绑定。
--
-- 背景:
--   Phase 5 builder 在 pickUpstream 之前跑(input token 估算锁),不知道哪个
--   OAuth account 会被选中 → account_uuid 用 HMAC(secret, "account_uuid:"+userId)
--   占位。CCB 容器路径走 /api/oauth/profile 拿 profile.account.uuid 写本地
--   ~/.claude.json,但 master 后续 pickUpstream 可能换号 → 容器写的 uuid 跟
--   实际跑的 OAuth account 真 uuid 也可能不一致。
--
-- 修复:
--   给每个 claude_accounts 行存 account_uuid(真值,从 Anthropic profile 取),
--   master applyUpstreamAuth 选号后用 pick.account_uuid 重写 metadata.user_id
--   ,跨容器/外接两条路径强统一。
--
-- Schema 设计:
--   - 类型 uuid(PG 原生 16-byte UUID,canonical format 入库出库 36 hex with dash)
--   - 初始 NULL — 允许现存账号渐进回填(backfill-account-uuid.ts),不阻塞 deploy
--   - UNIQUE WHERE NOT NULL — 同 uuid 出现两次必是脏数据
--   - **不**设 NOT NULL — 兼容渐进回填 + 兼容非 claude provider(codex 等没 uuid)
--   - 长期约束(provider='claude' OR account_uuid IS NULL)留 Phase 6.5 cleanup
--
-- 回填脚本:scripts/backfill-account-uuid.ts(provider='claude' AND status='active'
-- AND account_uuid IS NULL,1 req/3s,走账号 egress dispatcher)。
--
-- fail_closed 稳态下 scheduler 用 CTE 过滤掉 NULL 候选,池空 throw
-- AccountPoolUnavailableError("no_uuid"),复用现有 503 POOL_UNAVAILABLE 契约。

-- 幂等 DDL(Codex round 1 MAJOR 2):migrate.ts 框架本身用 schema_migrations 防重跑,
-- 但运维手动 psql 重放 / partial 回滚后再跑等场景下,IF NOT EXISTS 让本文件
-- 不会因"列已存在 / 索引已存在"而 fatal,容错更高。partial unique index 仍
-- 正确允许多 NULL 共存(回填期),禁止重复非 NULL UUID。
ALTER TABLE claude_accounts
  ADD COLUMN IF NOT EXISTS account_uuid uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ca_account_uuid_uq
  ON claude_accounts(account_uuid)
  WHERE account_uuid IS NOT NULL;
