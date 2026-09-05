/**
 * research_task job handler 单测(R5 Phase A):批量逐条容错、相位 checkpoint
 * 续跑(跳过已完成)、配置关闭 fail-loud、非法 payload 拒绝。
 * deps 全注入,无 PG。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ResearchConfigPublic } from '../admin/researchConfig.js'
import { DEFAULT_RESEARCH_CONFIG } from '../admin/researchConfig.js'
import {
  type FetchJobHandlerDeps,
  makeResearchFetchJobHandlers,
  resumeOutcomes,
  runFetchBatchJob,
} from '../research/fetchJobs.js'
import type { FetchRecordOutcome } from '../research/researchHandlers.js'
import type { JobHandlerCtx } from '../research/scheduler.js'
import type { CheckpointRow } from '../research/store.js'

function fetchEnabledCfg(enabled = true): () => Promise<ResearchConfigPublic> {
  return async () => ({
    enabled: true,
    config: { ...DEFAULT_RESEARCH_CONFIG, fetch: { enabled } },
  })
}

function fakeJob(payload: unknown): Parameters<typeof runFetchBatchJob>[0] {
  return {
    id: '101',
    requestId: 'req-1',
    userId: '42',
    runtimeChannel: 'v5',
    kind: 'research_task',
    status: 'running',
    phase: null,
    payload,
    result: null,
    error: null,
    attempts: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function fakeCtx(): {
  ctx: JobHandlerCtx
  phases: string[]
  checkpoints: Array<{
    phase: string
    status: 'pending' | 'completed' | 'failed'
    output?: unknown
  }>
} {
  const phases: string[] = []
  const checkpoints: Array<{
    phase: string
    status: 'pending' | 'completed' | 'failed'
    output?: unknown
  }> = []
  const ctx: JobHandlerCtx = {
    setPhase: async (p) => {
      phases.push(p)
    },
    checkpoint: async (phase, status, output) => {
      checkpoints.push({ phase, status, output })
    },
  }
  return { ctx, phases, checkpoints }
}

function outcome(id: string, status: FetchRecordOutcome['status'] = 'fetched'): FetchRecordOutcome {
  return { id, status, attempts: [] }
}

describe('runFetchBatchJob', () => {
  it('逐条执行 + 每条落 pending checkpoint + 末尾 completed summary', async () => {
    const calls: string[] = []
    const { ctx, checkpoints } = fakeCtx()
    const deps: FetchJobHandlerDeps = {
      readConfig: fetchEnabledCfg(),
      listCheckpoints: async () => [],
      fetchOne: async (input) => {
        calls.push(input.record.id)
        return outcome(input.record.id)
      },
    }
    const result = await runFetchBatchJob(
      fakeJob({ mode: 'fetch', records: [{ id: 'a' }, { id: 'b' }] }),
      ctx,
      deps,
    )
    assert.deepEqual(calls, ['a', 'b'])
    assert.equal(result.fetched, 2)
    assert.equal(result.records.length, 2)
    // 每条一个 pending checkpoint + 最后 completed
    assert.equal(checkpoints.filter((c) => c.status === 'pending').length, 2)
    const done = checkpoints.find((c) => c.status === 'completed')
    assert.ok(done)
    assert.equal(done?.phase, 'pdf_ingested')
  })

  it('单条 failed 不拖垮整批(summary.failed 计数)', async () => {
    const { ctx } = fakeCtx()
    const deps: FetchJobHandlerDeps = {
      readConfig: fetchEnabledCfg(),
      listCheckpoints: async () => [],
      fetchOne: async (input) =>
        input.record.id === 'a'
          ? { id: 'a', status: 'fetched', attempts: [] }
          : { id: 'b', status: 'failed', reason: 'paywalled', attempts: [] },
    }
    const result = await runFetchBatchJob(
      fakeJob({ mode: 'fetch', records: [{ id: 'a' }, { id: 'b' }] }),
      ctx,
      deps,
    )
    assert.equal(result.fetched, 1)
    assert.equal(result.failed, 1)
  })

  it('相位续跑:已完成记录跳过,只补跑未完成', async () => {
    const calls: string[] = []
    const prior: CheckpointRow[] = [
      {
        phase: 'pdf_ingested',
        status: 'pending',
        output: { outcome: outcome('a') },
        error: null,
        createdAt: new Date(),
      },
    ]
    const { ctx } = fakeCtx()
    const deps: FetchJobHandlerDeps = {
      readConfig: fetchEnabledCfg(),
      listCheckpoints: async () => prior,
      fetchOne: async (input) => {
        calls.push(input.record.id)
        return outcome(input.record.id)
      },
    }
    const result = await runFetchBatchJob(
      fakeJob({ mode: 'fetch', records: [{ id: 'a' }, { id: 'b' }] }),
      ctx,
      deps,
    )
    assert.deepEqual(calls, ['b'], '已完成的 a 从 checkpoint 恢复,不重跑')
    assert.equal(result.records.length, 2)
    assert.equal(result.fetched, 2)
  })

  it('续跑只跳过成功/needs_ocr,failed 的记录重试', async () => {
    const calls: string[] = []
    const prior: CheckpointRow[] = [
      {
        phase: 'pdf_ingested',
        status: 'pending',
        output: { outcome: { id: 'a', status: 'failed', reason: 'timeout', attempts: [] } },
        error: null,
        createdAt: new Date(),
      },
    ]
    const { ctx } = fakeCtx()
    const deps: FetchJobHandlerDeps = {
      readConfig: fetchEnabledCfg(),
      listCheckpoints: async () => prior,
      fetchOne: async (input) => {
        calls.push(input.record.id)
        return outcome(input.record.id)
      },
    }
    await runFetchBatchJob(fakeJob({ mode: 'fetch', records: [{ id: 'a' }] }), ctx, deps)
    assert.deepEqual(calls, ['a'])
  })

  it('failed→requeue→成功 续跑后 records 无重复 id,summary 不计入陈旧 failed(auditor B1)', async () => {
    // 第 1 轮:a failed、b fetched;第 2 轮(本轮)a 重跑成功。checkpoint 表 append-only,
    // 两轮各留一行;若第 1 轮之前还有一次中断,a 会有多条 failed 旧行。
    const cp = (o: FetchRecordOutcome): CheckpointRow => ({
      phase: 'pdf_ingested',
      status: 'pending',
      output: { outcome: o },
      error: null,
      createdAt: new Date(),
    })
    const prior: CheckpointRow[] = [
      cp({ id: 'a', status: 'failed', reason: 'timeout', attempts: [] }),
      cp(outcome('b')),
      cp({ id: 'a', status: 'failed', reason: 'fetch_error_5xx', attempts: [] }),
    ]
    const { ctx } = fakeCtx()
    const deps: FetchJobHandlerDeps = {
      readConfig: fetchEnabledCfg(),
      listCheckpoints: async () => prior,
      fetchOne: async (input) => outcome(input.record.id),
    }
    const summary = await runFetchBatchJob(
      fakeJob({ mode: 'fetch', records: [{ id: 'a' }, { id: 'b' }] }),
      ctx,
      deps,
    )
    const ids = summary.records.map((r) => r.id).sort()
    assert.deepEqual(ids, ['a', 'b'])
    assert.equal(summary.records.find((r) => r.id === 'a')?.status, 'fetched')
    assert.equal(summary.fetched, 2)
    assert.equal(summary.failed, 0)
  })

  it('续跑 keep-last:prior=[a failed, a fetched] → a 视为已完成不重跑,仅单条 fetched(auditor S1)', async () => {
    const cp = (o: FetchRecordOutcome): CheckpointRow => ({
      phase: 'pdf_ingested',
      status: 'pending',
      output: { outcome: o },
      error: null,
      createdAt: new Date(),
    })
    const prior: CheckpointRow[] = [
      cp({ id: 'a', status: 'failed', reason: 'timeout', attempts: [] }),
      cp(outcome('a')),
    ]
    const calls: string[] = []
    const { ctx } = fakeCtx()
    const deps: FetchJobHandlerDeps = {
      readConfig: fetchEnabledCfg(),
      listCheckpoints: async () => prior,
      fetchOne: async (input) => {
        calls.push(input.record.id)
        return outcome(input.record.id)
      },
    }
    const summary = await runFetchBatchJob(
      fakeJob({ mode: 'fetch', records: [{ id: 'a' }] }),
      ctx,
      deps,
    )
    assert.deepEqual(calls, [])
    assert.equal(summary.records.length, 1)
    assert.equal(summary.records[0].status, 'fetched')
    assert.equal(summary.failed, 0)
  })

  it('配置中途关闭 → fail-loud 抛错(failJob)', async () => {
    const { ctx } = fakeCtx()
    const deps: FetchJobHandlerDeps = {
      readConfig: fetchEnabledCfg(false),
      listCheckpoints: async () => [],
      fetchOne: async () => {
        throw new Error('should not be called')
      },
    }
    await assert.rejects(
      runFetchBatchJob(fakeJob({ mode: 'fetch', records: [{ id: 'a' }] }), ctx, deps),
      /fetch\.enabled/,
    )
  })

  it('非法 payload(mode 缺失/records 非数组)→ 拒绝', async () => {
    const { ctx } = fakeCtx()
    const deps: FetchJobHandlerDeps = {
      readConfig: fetchEnabledCfg(),
      listCheckpoints: async () => [],
    }
    await assert.rejects(
      runFetchBatchJob(fakeJob({ mode: 'ingest' }), ctx, deps),
      /unsupported payload/,
    )
    await assert.rejects(
      runFetchBatchJob(fakeJob({ mode: 'fetch' }), ctx, deps),
      /unsupported payload/,
    )
    await assert.rejects(runFetchBatchJob(fakeJob(null), ctx, deps), /unsupported payload/)
  })

  it('makeResearchFetchJobHandlers 注册 research_task', () => {
    const handlers = makeResearchFetchJobHandlers({
      readConfig: fetchEnabledCfg(),
      listCheckpoints: async () => [],
    })
    assert.equal(typeof handlers.research_task, 'function')
  })
})

describe('resumeOutcomes', () => {
  it('只收集 pdf_ingested + pending 的单条 outcome 行,保持顺序', () => {
    const rows: CheckpointRow[] = [
      {
        phase: 'pdf_ingested',
        status: 'completed',
        output: { records: [] },
        error: null,
        createdAt: new Date(),
      },
      {
        phase: 'pdf_ingested',
        status: 'pending',
        output: { outcome: outcome('a') },
        error: null,
        createdAt: new Date(),
      },
      {
        phase: 'quote_indexed',
        status: 'pending',
        output: { outcome: outcome('z') },
        error: null,
        createdAt: new Date(),
      },
      {
        phase: 'pdf_ingested',
        status: 'pending',
        output: { outcome: 'b' },
        error: null,
        createdAt: new Date(),
      },
      {
        phase: 'pdf_ingested',
        status: 'failed',
        output: { outcome: outcome('c') },
        error: 'x',
        createdAt: new Date(),
      },
    ]
    const out = resumeOutcomes(rows)
    assert.deepEqual(
      out.map((o) => o.id),
      ['a'],
    )
  })
})
