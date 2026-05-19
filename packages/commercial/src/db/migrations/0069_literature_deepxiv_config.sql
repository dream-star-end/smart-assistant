-- 0069 文献检索(DeepXiv)平台级配置
--
-- 目的:为容器内 LLM 提供"文献检索"能力(POST /v3/literature/search),
--       由 master 持有 DeepXiv API token + 配额开关,容器只走 mTLS 内部
--       proxy,token 永远不进容器 env。
--
-- 设计:
--   - 单行表(id=1),admin UI 改 → 下次 prompt 重建时自然吃到新值
--     (容器 spawn / system prompt 重新生成是天然的热重载点,不需要 LISTEN/NOTIFY;
--      proxy 路径每次请求实时 DB 读,无 cache)
--   - token 走 **AEAD (AES-256-GCM)** 与 claude_accounts.oauth_token_enc 同模式:
--     `token_ct` = ciphertext+tag,`token_nonce` = 12 字节随机,KMS key 同 src/crypto/keys.ts
--     防 DB 备份泄露(threat model:DB-only leak,机器 root 同时拿到 KMS key 才能解)
--   - daily_cap 整数,UTC 自然日,Redis 计数(不存 DB,这里只持久化配额上限)
--   - default_size / timeout_sec 给 proxy 用,避免硬编码
--
-- 不做 LISTEN/NOTIFY 的理由:promptSlot/proxy 都是 per-request 直接读 DB,
-- 不持进程内 cache;沿用 0008_pricing_notify 那套 listener 模式会顺带继承它
-- 的已知技术债(listener 死了无重连静默漂移),收益(单行表延迟更新)远小于代价。

CREATE TABLE IF NOT EXISTS literature_deepxiv_config (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled     BOOLEAN  NOT NULL DEFAULT FALSE,
  base_url    TEXT     NOT NULL DEFAULT 'https://data.rag.ac.cn',
  token_ct    BYTEA,            -- AES-256-GCM ciphertext || tag(NULL = 未配 token)
  token_nonce BYTEA,            -- 12 字节 nonce;与 token_ct 同时 NULL 或同时非 NULL
  daily_cap   INTEGER  NOT NULL DEFAULT 10000 CHECK (daily_cap > 0 AND daily_cap <= 1000000),
  default_size INTEGER NOT NULL DEFAULT 10    CHECK (default_size > 0 AND default_size <= 100),
  timeout_sec INTEGER  NOT NULL DEFAULT 20    CHECK (timeout_sec >= 3 AND timeout_sec <= 120),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  CONSTRAINT chk_token_pair CHECK (
    (token_ct IS NULL AND token_nonce IS NULL) OR
    (token_ct IS NOT NULL AND token_nonce IS NOT NULL)
  )
);

INSERT INTO literature_deepxiv_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
