/**
 * 科研 durable job / 证据权威 / 产物 — 持久层 store。
 *
 * 设计权威:docs/research-agent/IMPLEMENTATION_PLAN.md §2。
 * 全部走 db/queries.ts 的 query()/tx() 参数化查询(05-SECURITY §8)。
 *
 * 关键不变量:
 *   - claimNextJob 用 advisory lock + FOR UPDATE SKIP LOCKED,多 worker 并发安全。
 *   - complete/fail/recoverStale 带 status guard,防滚动重启 / stale cleanup 后
 *     旧进程长尾写回污染(同 inbox/email.ts 的 mark* guard 套路)。
 *   - research_documents 是证据权威源:putDocument 存 master 铸造的权威 spans,
 *     getSpan 供 oc-cite check 回查取 canonical quote 文本(主键含 user_id,tenant 隔离)。
 *   - 保留策略:blob 暂存默认 30 天 TTL(putBlob COALESCE 兜底),artifacts 记录
 *     180 天;gcExpiredBlobs/gcOldArtifacts 由 scheduler 每日 tick 清(见 scheduler.ts)。
 */

import { unlink } from "node:fs/promises";
import type { PoolClient } from "pg";
import type {
  NormalizedDocument,
  ResearchArtifactKind,
  ResearchJobKind,
  ResearchJobStatus,
  ResearchPhase,
  Span,
} from "@openclaude/protocol/research";
import { query, tx } from "../db/queries.js";
import { getRuntimeChannel } from "../runtimeChannel.js";

// advisory lock key — 'OCRS'(OpenClaude ReSearch),双 int4 防超 JS Number.MAX_SAFE_INTEGER
const LOCK_KEY_HI = 0x4f_43_52_53;
const LOCK_KEY_LO = 0x4a_4f_42_53; // 'JOBS'

const ERROR_MAX = 2000;

function clipError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > ERROR_MAX ? msg.slice(0, ERROR_MAX) : msg;
}

// ─── job ─────────────────────────────────────────────────────────────

export interface ResearchJobRow {
  id: string;
  requestId: string;
  userId: string;
  runtimeChannel: string;
  kind: ResearchJobKind;
  status: ResearchJobStatus;
  phase: ResearchPhase | null;
  payload: unknown;
  result: unknown;
  error: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

interface JobDbRow {
  id: string;
  request_id: string;
  user_id: string;
  runtime_channel: string;
  kind: ResearchJobKind;
  status: ResearchJobStatus;
  phase: ResearchPhase | null;
  payload: unknown;
  result: unknown;
  error: string | null;
  attempts: number;
  created_at: Date;
  updated_at: Date;
}

function mapJob(r: JobDbRow): ResearchJobRow {
  return {
    id: r.id,
    requestId: r.request_id,
    userId: r.user_id,
    runtimeChannel: r.runtime_channel,
    kind: r.kind,
    status: r.status,
    phase: r.phase,
    payload: r.payload,
    result: r.result,
    error: r.error,
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const JOB_COLS = `id::text, request_id, user_id::text, runtime_channel, kind, status,
  phase, payload, result, error, attempts, created_at, updated_at`;

export interface CreateJobInput {
  userId: bigint | number | string;
  requestId: string;
  kind: ResearchJobKind;
  runtimeChannel?: string;
  payload?: Record<string, unknown>;
}

/**
 * 创建 job(幂等:同 user 同 request_id 已存在则返回既有行,不重复入队)。
 */
export async function createJob(input: CreateJobInput): Promise<ResearchJobRow> {
  const res = await query<JobDbRow>(
    `INSERT INTO research_jobs (request_id, user_id, runtime_channel, kind, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (user_id, request_id) DO NOTHING
     RETURNING ${JOB_COLS}`,
    [
      input.requestId,
      String(input.userId),
      // 归属默认=本实例 channel(getRuntimeChannel),绝不静默落 'v3' —— 否则 v5 实例
      // 创建的 job 会被 v3 scheduler 抢跑(跨轨执行)。显式传入仍可覆盖(测试注入)。
      input.runtimeChannel ?? getRuntimeChannel(),
      input.kind,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  if (res.rows.length > 0) return mapJob(res.rows[0]);
  // 冲突 → 读回既有
  const existing = await getJob(input.userId, input.requestId);
  if (!existing) throw new Error("createJob: conflict but row not found");
  return existing;
}

export async function getJob(
  userId: bigint | number | string,
  requestId: string,
): Promise<ResearchJobRow | null> {
  const res = await query<JobDbRow>(
    `SELECT ${JOB_COLS} FROM research_jobs WHERE user_id = $1 AND request_id = $2`,
    [String(userId), requestId],
  );
  return res.rows[0] ? mapJob(res.rows[0]) : null;
}

export async function getJobById(id: bigint | number | string): Promise<ResearchJobRow | null> {
  const res = await query<JobDbRow>(
    `SELECT ${JOB_COLS} FROM research_jobs WHERE id = $1`,
    [String(id)],
  );
  return res.rows[0] ? mapJob(res.rows[0]) : null;
}

/**
 * 原子领取下一批 queued job:advisory lock(防多进程 picker 重叠)+
 * SELECT FOR UPDATE SKIP LOCKED → UPDATE 成 running/locked_at=NOW/attempts++。
 * 出 tx 后这批已是 running,其它 worker 不会再碰。拿不到 advisory lock → 返 []。
 */
export async function claimNextJob(batchSize: number): Promise<ResearchJobRow[]> {
  const limit = Math.max(1, batchSize);
  return tx(async (client: PoolClient) => {
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS ok",
      [LOCK_KEY_HI, LOCK_KEY_LO],
    );
    if (!lock.rows[0]?.ok) return [];
    // channel 过滤:全库统一纪律(对照 v3idleSweep/v3orphanReconcile),本实例只认领
    // 自己 channel 的 job —— 此前是全库唯一漏 channel 的认领查询,科研 agent 接线后
    // 会让 v3 scheduler 抢跑 v5 任务。
    const sel = await client.query<{ id: string }>(
      `SELECT id::text AS id
         FROM research_jobs
        WHERE status = 'queued'
          AND runtime_channel = $2
        ORDER BY id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit, getRuntimeChannel()],
    );
    if (sel.rows.length === 0) return [];
    const ids = sel.rows.map((r) => r.id);
    const upd = await client.query<JobDbRow>(
      `UPDATE research_jobs
          SET status = 'running',
              locked_at = NOW(),
              attempts = attempts + 1,
              updated_at = NOW()
        WHERE id = ANY($1::bigint[])
        RETURNING ${JOB_COLS}`,
      [ids],
    );
    return upd.rows.map(mapJob);
  });
}

/** 更新 job 当前相位(进度展示用)。 */
export async function transitionPhase(
  jobId: bigint | number | string,
  phase: ResearchPhase,
): Promise<void> {
  await query(
    `UPDATE research_jobs SET phase = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'running'`,
    [String(jobId), phase],
  );
}

/**
 * 落相位 checkpoint(多小时任务恢复用)。
 *
 * status guard:仅当 job 仍 status='running' 才写 —— 防 recoverStale 把崩溃 worker
 * 的 job 标 interrupted 后,旧进程的长尾 checkpoint 写回污染相位历史(同
 * completeJob/failJob 的 guard 语义)。返 true=本进程成功写入。
 */
export async function recordCheckpoint(
  jobId: bigint | number | string,
  phase: ResearchPhase,
  status: "pending" | "completed" | "failed",
  output?: unknown,
  error?: string,
): Promise<boolean> {
  // SELECT ... FROM research_jobs ... FOR UPDATE 锁住 job 行:若 recoverStale 正并发
  // 把本 job 改 interrupted,FOR UPDATE 会等其提交后用 EvalPlanQual 重检 status,
  // 不再匹配 'running' → 产 0 行 → 不插。避免 WHERE EXISTS(不锁)的 TOCTOU 窗口。
  const r = await query(
    `INSERT INTO research_phase_checkpoints (job_id, phase, status, output, error)
     SELECT id, $2, $3, $4::jsonb, $5
       FROM research_jobs
      WHERE id = $1 AND status = 'running'
      FOR UPDATE`,
    [
      String(jobId),
      phase,
      status,
      output === undefined ? null : JSON.stringify(output),
      error ?? null,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface CheckpointRow {
  phase: ResearchPhase;
  status: "pending" | "completed" | "failed";
  output: unknown;
  error: string | null;
  createdAt: Date;
}

/** 读 job 已完成的相位(供 resume / poll completedPhases)。 */
export async function listCheckpoints(
  jobId: bigint | number | string,
): Promise<CheckpointRow[]> {
  const res = await query<{
    phase: ResearchPhase;
    status: "pending" | "completed" | "failed";
    output: unknown;
    error: string | null;
    created_at: Date;
  }>(
    `SELECT phase, status, output, error, created_at
       FROM research_phase_checkpoints
      WHERE job_id = $1
      ORDER BY id ASC`,
    [String(jobId)],
  );
  return res.rows.map((r) => ({
    phase: r.phase,
    status: r.status,
    output: r.output,
    error: r.error,
    createdAt: r.created_at,
  }));
}

/** 完成 job(status guard='running' 防 stale cleanup 后长尾写回)。返 true=本进程更新成功。 */
export async function completeJob(
  jobId: bigint | number | string,
  result: unknown,
): Promise<boolean> {
  const r = await query(
    `UPDATE research_jobs
        SET status = 'completed', result = $2::jsonb, locked_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'running'`,
    [String(jobId), JSON.stringify(result ?? null)],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 失败 job(不自动重试;status guard='running')。返 true=本进程更新成功。 */
export async function failJob(
  jobId: bigint | number | string,
  err: unknown,
): Promise<boolean> {
  const r = await query(
    `UPDATE research_jobs
        SET status = 'failed', error = $2, locked_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'running'`,
    [String(jobId), clipError(err)],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * 启动时一次性把崩前留下的 running 且 locked_at<NOW-staleMs 的 job 标 interrupted
 * (不重发,避免双跑副作用)。返回受影响行数。
 */
export async function recoverStale(staleMs: number): Promise<number> {
  const r = await query(
    `UPDATE research_jobs
        SET status = 'interrupted', locked_at = NULL, updated_at = NOW(),
            error = COALESCE(error, 'worker crash / restart before completion')
      WHERE status = 'running'
        AND runtime_channel = $2
        AND locked_at < NOW() - ($1 || ' milliseconds')::interval`,
    [staleMs, getRuntimeChannel()],
  );
  return r.rowCount ?? 0;
}

// ─── 证据权威:documents ───────────────────────────────────────────────

export interface PutDocumentInput {
  userId: bigint | number | string;
  doc: NormalizedDocument;
}

/** 存 master 铸造的权威归一文档(证据权威源)。幂等:同 (user,docId) 覆盖。 */
export async function putDocument(input: PutDocumentInput): Promise<void> {
  const d = input.doc;
  await query(
    `INSERT INTO research_documents
       (doc_id, user_id, content_sha256, source_blob_id, lang, title, normalized_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (user_id, doc_id) DO UPDATE
       SET content_sha256 = EXCLUDED.content_sha256,
           source_blob_id = EXCLUDED.source_blob_id,
           lang = EXCLUDED.lang,
           title = EXCLUDED.title,
           normalized_json = EXCLUDED.normalized_json`,
    [
      d.docId,
      String(input.userId),
      d.contentSha256,
      d.sourceBlobId ?? null,
      d.lang,
      d.title ?? null,
      JSON.stringify(d),
    ],
  );
}

/** 读权威归一文档(tenant 隔离:必须带 userId)。 */
export async function getDocument(
  userId: bigint | number | string,
  docId: string,
): Promise<NormalizedDocument | null> {
  const r = await query<{ normalized_json: NormalizedDocument }>(
    "SELECT normalized_json FROM research_documents WHERE user_id = $1 AND doc_id = $2",
    [String(userId), docId],
  );
  return r.rows[0]?.normalized_json ?? null;
}

/**
 * 取权威 span(oc-cite check 回查用)。返回 master 铸造的 span;调用方据此
 * 校验 quote 的 [charStart,charEnd] range 并取 canonical 子串。
 */
export async function getSpan(
  userId: bigint | number | string,
  docId: string,
  spanId: string,
): Promise<Span | null> {
  const doc = await getDocument(userId, docId);
  if (!doc) return null;
  return doc.spans.find((s) => s.spanId === spanId) ?? null;
}

// ─── 产物 artifacts ───────────────────────────────────────────────────

export interface RegisterArtifactInput {
  jobId?: bigint | number | string | null;
  userId: bigint | number | string;
  kind: ResearchArtifactKind;
  storagePath: string;
  mime?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface ArtifactRow {
  id: string;
  kind: ResearchArtifactKind;
  storagePath: string;
  mime: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: Date;
}

export async function registerArtifact(input: RegisterArtifactInput): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO research_artifacts (job_id, user_id, kind, storage_path, mime, size_bytes, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id::text AS id`,
    [
      input.jobId == null ? null : String(input.jobId),
      String(input.userId),
      input.kind,
      input.storagePath,
      input.mime ?? null,
      input.sizeBytes ?? null,
      input.sha256 ?? null,
    ],
  );
  return r.rows[0].id;
}

/** 列产物(tenant 隔离)。可按 jobId 过滤。 */
export async function listArtifacts(
  userId: bigint | number | string,
  jobId?: bigint | number | string,
): Promise<ArtifactRow[]> {
  const r =
    jobId === undefined
      ? await query<ArtifactDbRow>(
          `SELECT id::text, kind, storage_path, mime, size_bytes, sha256, created_at
             FROM research_artifacts WHERE user_id = $1 ORDER BY id DESC`,
          [String(userId)],
        )
      : await query<ArtifactDbRow>(
          `SELECT id::text, kind, storage_path, mime, size_bytes, sha256, created_at
             FROM research_artifacts WHERE user_id = $1 AND job_id = $2 ORDER BY id DESC`,
          [String(userId), String(jobId)],
        );
  return r.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    storagePath: row.storage_path,
    mime: row.mime,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: row.sha256,
    createdAt: row.created_at,
  }));
}

interface ArtifactDbRow {
  id: string;
  kind: ResearchArtifactKind;
  storage_path: string;
  mime: string | null;
  size_bytes: string | number | null;
  sha256: string | null;
  created_at: Date;
}

// ─── 暂存输入 blobs ───────────────────────────────────────────────────

/** 新写入 blob 的默认 TTL(天)。blob 只是 ingest 原始字节暂存;文档权威 spans
 *  已落 research_documents(source_blob_id 列级 ON DELETE SET NULL),过期删 blob
 *  不影响证据权威。 */
export const BLOB_DEFAULT_TTL_DAYS = 30;

export interface PutBlobInput {
  blobId: string;
  userId: bigint | number | string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
  mime?: string;
  /** 过期时间;**未传/null 时 SQL 侧默认 NOW()+30 天**(见 BLOB_DEFAULT_TTL_DAYS)。 */
  expiresAt?: Date | null;
}

export async function putBlob(input: PutBlobInput): Promise<void> {
  await query(
    `INSERT INTO research_blobs (blob_id, user_id, sha256, size_bytes, storage_path, mime, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6,
             COALESCE($7, NOW() + make_interval(days => ${BLOB_DEFAULT_TTL_DAYS})))`,
    [
      input.blobId,
      String(input.userId),
      input.sha256,
      input.sizeBytes,
      input.storagePath,
      input.mime ?? null,
      input.expiresAt ?? null,
    ],
  );
}

export interface BlobRow {
  blobId: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
  mime: string | null;
}

/** 读 blob(tenant 隔离:必须带 userId,防跨用户读字节)。 */
export async function getBlob(
  userId: bigint | number | string,
  blobId: string,
): Promise<BlobRow | null> {
  const r = await query<{
    blob_id: string;
    sha256: string;
    size_bytes: string | number;
    storage_path: string;
    mime: string | null;
  }>(
    `SELECT blob_id, sha256, size_bytes, storage_path, mime
       FROM research_blobs WHERE user_id = $1 AND blob_id = $2`,
    [String(userId), blobId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    blobId: row.blob_id,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    storagePath: row.storage_path,
    mime: row.mime,
  };
}

// ─── 保留策略 GC(scheduler 每日 tick 调;见 research/scheduler.ts) ────

export interface GcDeps {
  /** 磁盘文件删除(测试注入)。默认 fs.unlink。 */
  unlinkImpl?: (p: string) => Promise<void>;
  /** 非 ENOENT 的文件删除失败上报(不阻断行删)。默认 console.warn。 */
  onWarn?: (msg: string) => void;
}

function defaultGcWarn(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[research/store] ${msg}`);
}

/**
 * 删过期 blob(expires_at < NOW):**先删磁盘文件再删行**;文件删失败(含跨实例
 * 路径不存在的 ENOENT)不阻断行删,只 warn —— blob 是暂存字节,行是权威索引,
 * 宁可留孤儿文件(下轮/人工可清)也不留悬空行。
 * research_documents.source_blob_id 由列级 ON DELETE SET NULL 自动置空。
 * 返回删除的行数。
 */
export async function gcExpiredBlobs(deps: GcDeps = {}): Promise<number> {
  const unlinkImpl = deps.unlinkImpl ?? ((p: string) => unlink(p));
  const onWarn = deps.onWarn ?? defaultGcWarn;
  const sel = await query<{ user_id: string; blob_id: string; storage_path: string }>(
    `SELECT user_id::text AS user_id, blob_id, storage_path
       FROM research_blobs
      WHERE expires_at IS NOT NULL AND expires_at < NOW()`,
  );
  if (sel.rows.length === 0) return 0;
  for (const row of sel.rows) {
    try {
      await unlinkImpl(row.storage_path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
        onWarn(`gcExpiredBlobs: unlink ${row.storage_path} failed: ${clipError(err)}`);
      }
    }
  }
  // 只删本轮 SELECT 到的行(不用 expires_at<NOW 重删):SELECT→DELETE 窗口内新过期的
  // 行留给下轮,保证"删行前一定尝试过删文件"的顺序不变量。
  const del = await query(
    `DELETE FROM research_blobs b
      USING unnest($1::bigint[], $2::text[]) AS t(uid, bid)
      WHERE b.user_id = t.uid AND b.blob_id = t.bid`,
    [sel.rows.map((r) => r.user_id), sel.rows.map((r) => r.blob_id)],
  );
  return del.rowCount ?? 0;
}

/** 产物索引保留天数:storage_path 指向用户容器卷,容器/卷回收后记录悬空;
 *  签名下载链接也早已失效 → 半年后只清**记录**(master 摸不到卷文件,不做文件级 GC)。 */
export const ARTIFACT_RETENTION_DAYS = 180;

/** 删超保留期的 research_artifacts 行(仅记录级 GC,见 ARTIFACT_RETENTION_DAYS)。返回删除行数。 */
export async function gcOldArtifacts(retentionDays = ARTIFACT_RETENTION_DAYS): Promise<number> {
  const days = Math.max(1, Math.floor(retentionDays));
  const r = await query(
    `DELETE FROM research_artifacts
      WHERE created_at < NOW() - make_interval(days => $1::int)`,
    [days],
  );
  return r.rowCount ?? 0;
}

export const _internal = { LOCK_KEY_HI, LOCK_KEY_LO } as const;
