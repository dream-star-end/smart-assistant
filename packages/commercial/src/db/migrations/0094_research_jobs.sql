-- 0094_research_jobs.sql
--
-- v5 科研 Agent 子系统 — durable job / 证据权威 / 产物 持久层。
-- 设计权威:docs/research-agent/IMPLEMENTATION_PLAN.md §2(经 Codex 终审)。
--
-- 核心契约:
--   - 证据权威 100% 由 master 从源字节铸造,权威 span 文本存 research_documents
--     (容器/LLM 无法发明或篡改 quote 文本)。
--   - research_jobs 是 durable queue;仅 master control-plane(runtimeChannel='v3')
--     的进程内 worker 消费(scheduler 受 controlPlaneEnabled 门控,v5 follower 不跑)。
--   - 不自动重试(同 inbox_email_jobs 语义):failed 永久停留;stale(running 且
--     locked_at < NOW()-N)启动时一次性标 interrupted,不重发。
--   - 多租户隔离:文件 hash 缓存只 tenant 内复用(research_documents / research_blobs
--     主键含 user_id),不跨用户默认复用(方案 §9 缓存隐私边界)。
--
-- job 状态机:
--   queued ──pick(locked_at=NOW)──▶ running ──ok──▶ completed
--                                          └─err─▶ failed
--                                          └─(crash + restart cleanup)─▶ interrupted

-- ── durable job 队列 ──────────────────────────────────────────────────
CREATE TABLE research_jobs (
  id             BIGSERIAL PRIMARY KEY,
  -- 容器侧幂等键(同 user 同 request_id 只一条 job);容器轮询/resume 用
  request_id     TEXT   NOT NULL,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 创建容器的 runtime channel(审计 / 隔离;不参与 worker 归属判定)
  runtime_channel TEXT  NOT NULL DEFAULT 'v3',
  kind           TEXT   NOT NULL,
                        -- ingest / index / cite_check / lit_search / render / research_task
  status         TEXT   NOT NULL DEFAULT 'queued',
                        -- queued / running / completed / failed / interrupted
  -- 当前相位(search_plan / metadata_results / pdf_ingested / quote_indexed /
  --           claims_extracted / citations_verified / report_rendered)
  phase          TEXT,
  payload        JSONB  NOT NULL DEFAULT '{}'::jsonb,
  result         JSONB,
  error          TEXT,
  attempts       INT    NOT NULL DEFAULT 0,
  -- worker pick 时填,完成/失败清空;重启时 stale(running 且 locked_at<NOW-N)→ interrupted
  locked_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, request_id),
  CHECK (kind IN ('ingest','index','cite_check','lit_search','render','research_task')),
  CHECK (status IN ('queued','running','completed','failed','interrupted'))
);

-- worker drain 主索引:status='queued' partial,picker 按 id 升序消费(FOR UPDATE SKIP LOCKED)
CREATE INDEX idx_research_jobs_queued
  ON research_jobs (id)
  WHERE status = 'queued';

-- 启动 stale 扫描:status='running' partial,按 locked_at 找进程崩前卡住的
CREATE INDEX idx_research_jobs_running_locked
  ON research_jobs (locked_at)
  WHERE status = 'running';

-- 容器按 user 查自己的 job(poll / 列表)
CREATE INDEX idx_research_jobs_by_user
  ON research_jobs (user_id, created_at DESC);

-- ── 相位 checkpoint(多小时任务可按相位恢复,中断不丢已完成相位) ────────
CREATE TABLE research_phase_checkpoints (
  id          BIGSERIAL PRIMARY KEY,
  job_id      BIGINT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  phase       TEXT   NOT NULL,
  status      TEXT   NOT NULL DEFAULT 'completed',
                     -- pending / completed / failed
  output      JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('pending','completed','failed'))
);

CREATE INDEX idx_research_phase_checkpoints_job
  ON research_phase_checkpoints (job_id, id);

-- ── master-owned 暂存输入字节(ingest 唯一输入路径;仅 master worker 读) ───
-- 主键含 user_id:blob 严格 tenant-scoped(不跨用户读字节;DB 级强制,非仅 API 过滤)。
CREATE TABLE research_blobs (
  blob_id       TEXT   NOT NULL,              -- 服务端生成(uuid)
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256        TEXT   NOT NULL,
  size_bytes    BIGINT NOT NULL,
  storage_path  TEXT   NOT NULL,              -- master-owned dir(OC_RESEARCH_BLOB_DIR)
  mime          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, blob_id)
);

CREATE INDEX idx_research_blobs_by_user
  ON research_blobs (user_id, created_at DESC);
CREATE INDEX idx_research_blobs_expires
  ON research_blobs (expires_at)
  WHERE expires_at IS NOT NULL;

-- ── 证据权威源:master 从源字节铸造的不可变归一文档 ──────────────────────
-- 权威 span 文本存 normalized_json;oc-cite check 回查这里取 canonical quote 文本。
-- 主键含 user_id:同一文献被两个用户上传 → 各存一行(tenant 隔离,不跨用户复用)。
-- source_blob_id 经 (user_id, source_blob_id) 复合 FK 强制"只能指向同租户 blob";
-- blob 过期 GC 删除时置 NULL(文档权威 spans 已落地,不依赖源字节)。
CREATE TABLE research_documents (
  doc_id          TEXT   NOT NULL,            -- = 内容派生 sha256(容器无法冒名)
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_sha256  TEXT   NOT NULL,
  source_blob_id  TEXT,
  lang            TEXT   NOT NULL DEFAULT 'other',
  title           TEXT,
  -- 权威 NormalizedDocument(spans[含 text] + references);证据权威源
  normalized_json JSONB  NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, doc_id),
  -- 同租户 FK:source_blob_id 只能指向本 user 的 blob(NULL 时 MATCH SIMPLE 不强制)。
  -- 列级 SET NULL(source_blob_id)(PG≥15):blob GC 删除时只置空 source_blob_id,
  -- **不**碰 NOT NULL 的 user_id(整复合 SET NULL 会违反 user_id NOT NULL)。文档权威
  -- spans 已落地,失去源字节指针不影响证据权威。
  FOREIGN KEY (user_id, source_blob_id)
    REFERENCES research_blobs (user_id, blob_id) ON DELETE SET NULL (source_blob_id),
  CHECK (lang IN ('zh','en','other'))
);

-- ── 产物索引(容器路径,经 /api/media-sign 签名交付 —— 单一 artifact 权威) ──
CREATE TABLE research_artifacts (
  id            BIGSERIAL PRIMARY KEY,
  job_id        BIGINT REFERENCES research_jobs(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT   NOT NULL,
                       -- report / slides / poster / bib / code / data / figure
  storage_path  TEXT   NOT NULL,             -- /home/agent/.openclaude/research/<request_id>/...
  mime          TEXT,
  size_bytes    BIGINT,
  sha256        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind IN ('report','slides','poster','bib','code','data','figure'))
);

CREATE INDEX idx_research_artifacts_job
  ON research_artifacts (job_id);
CREATE INDEX idx_research_artifacts_by_user
  ON research_artifacts (user_id, created_at DESC);

-- 回滚提示(项目无 down migration 传统,手动 rollback SQL):
--   DROP TABLE research_blobs, research_artifacts, research_documents,
--              research_phase_checkpoints, research_jobs;
