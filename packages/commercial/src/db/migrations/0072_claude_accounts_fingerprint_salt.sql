-- 0072_claude_accounts_fingerprint_salt.sql
--
-- V3 envv2 Phase 3(2026-05-21)— 给每个 claude_accounts 行加 16-byte 随机
-- fingerprint_salt,供 v2 normalizer(externalEnvelopeV2.ts)派生 L0 stable
-- fingerprint。同 account 跨机器/项目/turn 永远算出同一 fingerprint,
-- Anthropic 反风控按 account 维度聚类时归并为同一虚拟"人"。
--
-- 见 docs/V3_CC_EXTERNAL_ENDPOINT_ENVV2_PLAN_2026-05-21.md §Phase 3 §3.2 +
-- §3 全局不变量 I6(同 account 跨 turn 跨机器跨项目 L0 fingerprint 必相同)。
--
-- Schema 约束:
--   - BYTEA 而非 TEXT/encode(hex):salt 不需要可读,raw 16 byte 比 32 hex 字符
--     省一半存储 + 算 hash 不用 decode
--   - DEFAULT gen_random_bytes(16):新 INSERT(包括 store.ts/createAccount)
--     自动拿合法值,不破坏现有 INSERT 兼容性
--   - NOT NULL + CHECK octet_length=16:运行时 invariant,salt 错长立刻 fail
--   - **不**加 UNIQUE:16 byte 碰撞概率 1/2^128 可忽略,UNIQUE 在 BYTEA 上索引
--     收益 ≤ 成本(任何写入都查重 + bloat)。salt 碰撞实际影响是两 account 在
--     L0 fingerprint 维度合并,反风控视为同一人 — 已有 64-byte device_id pin
--     在 account 维度做 1:1 锚定,fingerprint 维度的碰撞最多让两个 account 在
--     anti-abuse cluster 合并(不影响功能,只影响"分桶"粒度)
--
-- admin 永不暴露此列(不进 API/UI):salt 漂移等价 fingerprint 漂移,违反
-- invariant I6,所以必须只在 server 内部读、自动 DEFAULT 生成。
--
-- pgcrypto 依赖:gen_random_bytes 是 pgcrypto extension 提供。0067 已 CREATE
-- EXTENSION IF NOT EXISTS pgcrypto — 在这里重复声明保新环境部署正确性
-- (IF NOT EXISTS 幂等)。
--
-- 性能注意:`gen_random_bytes` 是 PG VOLATILE,理论上 ADD COLUMN DEFAULT 不会用
-- fast-default 优化 — 可能 rewrite 整张表给每行生成独立 16-byte。claude_accounts
-- 行数级别(预期 < 1e5),即便 rewrite 也是秒级,prod 不会触发明显锁等待。新机部署
-- /大表场景下若担心 lock 时长,可改两步:先 ADD COLUMN nullable + 后台 UPDATE batch
-- + ALTER NOT NULL。本表规模无此必要。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE claude_accounts
  ADD COLUMN fingerprint_salt BYTEA NOT NULL
    DEFAULT gen_random_bytes(16);

ALTER TABLE claude_accounts
  ADD CONSTRAINT claude_accounts_fingerprint_salt_len
    CHECK (octet_length(fingerprint_salt) = 16);

COMMENT ON COLUMN claude_accounts.fingerprint_salt IS
  'V3 envv2 Phase 3: account-level 16-byte secret salt 用于 v2 normalizer 派生 L0 stable fingerprint。'
  ' 同 account 跨机器/项目/turn 永远算出同一 fingerprint,Anthropic 反风控按 account 维度聚类时归并为同一虚拟人。'
  ' 永不暴露 admin API/UI — salt 漂移 = fingerprint 漂移,违反 invariant I6。';
