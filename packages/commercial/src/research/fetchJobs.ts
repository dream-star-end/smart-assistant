/**
 * research_task durable job handler(R5 Phase A 批量全文下载)。
 *
 * 这是 dormant scheduler(index.ts startResearchJobScheduler)的第一个真实
 * handler:fetch-batch 路由 createJob(kind=research_task, payload.mode='fetch'),
 * 本 handler 逐条下载+入库,每条完成后落 pdf_ingested 相位 checkpoint(单条
 * 增量,行小可累积);中断 → recoverStale 标 interrupted → 同 requestId 重提
 * 由 requeueInterruptedJob 重新入队 → handler 从 checkpoint 增量续跑,跳过
 * 已完成的记录。
 *
 * 容错语义(设计 §4.1):单条下载失败结构化进结果,不 fail 整批;blob/ingest
 * 的系统性异常(DB/IO)由 fetchRecordIntoLibrary 上抛 → failJob。
 * 配置在跑动中翻转(fetch.enabled=false)→ failJob(fail-loud,不静默空跑)。
 */

import { readFile } from 'node:fs/promises'
import type { ResearchConfigPublic } from '../admin/researchConfig.js'
import { getResearchConfigPublic } from '../admin/researchConfig.js'
import type { FetchFulltextConfig, FetchRecordInput } from './fetchFulltext.js'
import { type FetchRecordOutcome, fetchRecordIntoLibrary } from './researchHandlers.js'
import { defaultBlobDir, writeBlobBytesDefault } from './researchProxy.js'
import type { JobHandler, JobHandlerCtx, JobHandlerMap } from './scheduler.js'
import {
  type CheckpointRow,
  type FetchAttemptRowInput,
  listCheckpoints,
  recordFetchAttempt,
  getBlob as storeGetBlob,
  putBlob as storePutBlob,
  putDocument as storePutDocument,
} from './store.js'
import { isResearchWorkspaceEnabled } from './workspaceFlag.js'

export interface FetchBatchPayload {
  mode: 'fetch'
  records: FetchRecordInput[]
  /** 提交时已解析的课题 id(可选;membership 挂载目标)。 */
  projectId?: string
}

export interface FetchBatchResult {
  records: FetchRecordOutcome[]
  fetched: number
  needsOcr: number
  failed: number
}

export interface FetchJobHandlerDeps {
  readConfig?: () => Promise<ResearchConfigPublic>
  /** 覆盖单条编排(测试注入);缺省真实 fetchRecordIntoLibrary + 真实 store。 */
  fetchOne?: (
    input: Parameters<typeof fetchRecordIntoLibrary>[0],
    cfg: Parameters<typeof fetchRecordIntoLibrary>[1],
    deps: Partial<Parameters<typeof fetchRecordIntoLibrary>[2]> &
      Pick<Parameters<typeof fetchRecordIntoLibrary>[2], 'http'>,
  ) => Promise<FetchRecordOutcome>
  listCheckpoints?: (jobId: string) => Promise<CheckpointRow[]>
  /** 指标行写入(测试注入);缺省真实 recordFetchAttempt。 */
  recordAttempt?: (row: FetchAttemptRowInput) => Promise<void>
}

/** 从相位 checkpoint 恢复 pdf_ingested 已完成的单条结果(增量行,按序拼接)。 */
export function resumeOutcomes(checkpoints: CheckpointRow[]): FetchRecordOutcome[] {
  const out: FetchRecordOutcome[] = []
  for (const c of checkpoints) {
    if (c.phase !== 'pdf_ingested' || c.status !== 'pending') continue
    const o = c.output as { outcome?: FetchRecordOutcome } | null
    if (o && typeof o === 'object' && o.outcome && typeof o.outcome.id === 'string') {
      out.push(o.outcome)
    }
  }
  return out
}

export async function runFetchBatchJob(
  job: Parameters<JobHandler>[0],
  ctx: JobHandlerCtx,
  deps: FetchJobHandlerDeps = {},
): Promise<FetchBatchResult> {
  const payload = job.payload as Partial<FetchBatchPayload> | null
  if (!payload || payload.mode !== 'fetch' || !Array.isArray(payload.records)) {
    throw new Error("research_task: unsupported payload (expected mode:'fetch' with records[])")
  }
  const records = payload.records.filter(
    (r): r is FetchRecordInput => !!r && typeof r.id === 'string' && r.id.trim().length > 0,
  )

  await ctx.setPhase('pdf_ingested')

  const readConfig = deps.readConfig ?? getResearchConfigPublic
  const cfg = await readConfig()
  if (!cfg.enabled || cfg.config.fetch?.enabled !== true) {
    throw new Error('fulltext fetch disabled (research_config fetch.enabled=false)')
  }

  // resume:已完成(非 failed)的记录跳过
  const listCp = deps.listCheckpoints ?? listCheckpoints
  const prior = resumeOutcomes(await listCp(String(job.id)))
  const doneIds = new Set(prior.filter((r) => r.status !== 'failed').map((r) => r.id))

  const cfgFetch: FetchFulltextConfig = {
    unpaywallEmail: cfg.config.fetch?.unpaywallEmail ?? cfg.config.litSources.unpaywallEmail,
    proxyUrl: cfg.config.fetch?.proxyUrl,
  }

  // membership(可选;fail-soft 在编排器内)
  let addMembership:
    | ((userId: string, docId: string, projectId: string) => Promise<void>)
    | undefined
  if (payload.projectId && isResearchWorkspaceEnabled()) {
    const lib = await import('./library.js')
    addMembership = (uid, docId, pid) => lib.addMembership(uid, docId, pid)
  }

  const fetchOne =
    deps.fetchOne ??
    ((input, cfg2, d) =>
      fetchRecordIntoLibrary(input, cfg2, {
        ...d,
        putBlob: (p) => storePutBlob(p),
        getBlob: async (uid, bid) => {
          const b = await storeGetBlob(uid, bid)
          return b ? { storagePath: b.storagePath, mime: b.mime } : null
        },
        putDocument: (uid, doc) => storePutDocument({ userId: uid, doc }),
        readBlobBytes: (p) => readFile(p),
        writeBlobBytes: writeBlobBytesDefault,
        blobDir: defaultBlobDir(),
        recordAttempt: deps.recordAttempt ?? recordFetchAttempt,
      }))

  const results: FetchRecordOutcome[] = [...prior]
  for (const rec of records) {
    if (doneIds.has(rec.id)) continue
    const outcome = await fetchOne(
      {
        userId: Number(job.userId),
        record: rec,
        projectId: payload.projectId,
        ingest: true,
        engine: cfg.config.ingest.engine,
      },
      cfgFetch,
      {
        http: { fetchImpl: fetch },
        addMembership,
      },
    )
    results.push(outcome)
    // 相位 checkpoint:单条增量(行小;中断后从这些行恢复)
    await ctx.checkpoint('pdf_ingested', 'pending', { outcome })
  }

  const summary: FetchBatchResult = {
    records: results,
    fetched: results.filter((r) => r.status === 'fetched').length,
    needsOcr: results.filter((r) => r.status === 'needs_ocr').length,
    failed: results.filter((r) => r.status === 'failed').length,
  }
  await ctx.checkpoint('pdf_ingested', 'completed', summary)
  return summary
}

/** 注册进 startResearchJobScheduler 的 handler map(kind=research_task)。 */
export function makeResearchFetchJobHandlers(deps: FetchJobHandlerDeps = {}): JobHandlerMap {
  return {
    research_task: (job, ctx) => runFetchBatchJob(job, ctx, deps),
  }
}
