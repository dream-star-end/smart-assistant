/**
 * R5 Phase A 路由单测(flag 默认关 404、flag 开 fetch/fetch-batch/job-status、
 * 256KB body 上限、research_config fetch 向后兼容)。身份/限流 fake 同
 * researchProxy.test.ts 模式,无 PG。
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'

process.env.OC_RESEARCH_WORKSPACE = undefined

import { Value } from '@sinclair/typebox/value'
import {
  DEFAULT_RESEARCH_CONFIG,
  ResearchConfigJson,
  type ResearchConfigPublic,
  validateResearchConfig,
} from '../admin/researchConfig.js'
import { hashSecret } from '../auth/containerIdentity.js'
import {
  type ResearchProxyHandlerCtx,
  makeResearchProxyHandler,
} from '../research/researchProxy.js'
import type { ResearchJobRow } from '../research/store.js'
import type { FetchAttemptRowInput } from '../research/store.js'

// ── fakes(同 researchProxy.test.ts) ─────────────────────────────────

const SECRET = 'a1'.repeat(32)
const goodAuth = `Bearer oc-v3.7.${SECRET}`

function passingRepo(): any {
  return {
    findActiveByHostAndBoundIp: async () => ({
      id: 7,
      user_id: 42,
      bound_ip: '10.0.0.1',
      host_uuid: 'h1',
      secret_hash: hashSecret(SECRET),
    }),
  }
}

const ctx: ResearchProxyHandlerCtx = { hostUuid: 'h1', boundIp: '10.0.0.1' }

function fetchCfg(enabled: boolean): () => Promise<ResearchConfigPublic> {
  return async () => ({
    enabled: true,
    config: { ...DEFAULT_RESEARCH_CONFIG, fetch: { enabled } },
  })
}

function makeReq(method: string, url: string, body?: unknown, auth = goodAuth): any {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const r = Readable.from(payload ? [Buffer.from(payload)] : []) as any
  r.method = method
  r.url = url
  r.headers = { authorization: auth }
  return r
}

function makeRes(): { res: any; captured: { statusCode: number; body: any } } {
  const captured = { statusCode: 0, body: undefined as any }
  const res: any = {
    headersSent: false,
    setHeader() {},
    writeHead(status: number, headers?: Record<string, string>) {
      captured.statusCode = status
      void headers
      res.headersSent = true
    },
    end(s?: string) {
      if (s) {
        try {
          captured.body = JSON.parse(s)
        } catch {
          captured.body = s
        }
      }
      res.headersSent = true
    },
  }
  return { res, captured }
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 0x61)])

function pdfFetch(): typeof fetch {
  return (async () =>
    new Response(new Uint8Array(PDF), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })) as unknown as typeof fetch
}

function makeMemoryStore() {
  const attempts: FetchAttemptRowInput[] = []
  const docs: unknown[] = []
  return {
    attempts,
    docs,
    store: {
      putBlob: async () => {},
      getBlob: async (_u: number, blobId: string) => ({
        storagePath: `/tmp/x-${blobId}`,
        mime: 'application/pdf',
      }),
      putDocument: async (_u: number, doc: unknown) => {
        docs.push(doc)
      },
      getDocument: async () => null,
      readBlobBytes: async () => PDF,
      writeBlobBytes: async () => {},
      blobDir: '/tmp/test-blobs',
      recordFetchAttempt: async (row: FetchAttemptRowInput) => {
        attempts.push(row)
      },
    },
  }
}

function fakeJobRow(over: Partial<ResearchJobRow> = {}): ResearchJobRow {
  return {
    id: '55',
    requestId: 'req-1',
    userId: '42',
    runtimeChannel: 'v5',
    kind: 'research_task',
    status: 'queued',
    phase: null,
    payload: {},
    result: null,
    error: null,
    attempts: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

// ── flag gating ──────────────────────────────────────────────────────

describe('researchProxy fetch 路由: flag 默认关', () => {
  it('flag 关 → lit/fetch、lit/fetch-batch、job/status 全部 404 FETCH_DISABLED', async () => {
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: fetchCfg(false),
    })
    for (const path of [
      '/v3/research/lit/fetch',
      '/v3/research/lit/fetch-batch',
      '/v3/research/job/status',
    ]) {
      const { res, captured } = makeRes()
      await h(makeReq('POST', path, { records: [{ id: 'a' }], requestId: 'r' }), res, ctx)
      assert.equal(captured.statusCode, 404, path)
      assert.equal(captured.body.error.code, 'FETCH_DISABLED', path)
    }
  })

  it('DEFAULT_RESEARCH_CONFIG.fetch 默认关(现网行为字节不变)', () => {
    assert.deepEqual(DEFAULT_RESEARCH_CONFIG.fetch, { enabled: false })
  })
})

// ── lit/fetch 同步路由 ──────────────────────────────────────────────

describe('researchProxy lit/fetch(flag 开)', () => {
  it('单条 happy path:200 results[0].status=fetched,attempts 落行', async () => {
    const mem = makeMemoryStore()
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: fetchCfg(true),
      fetchImpl: pdfFetch(),
      store: mem.store,
      fetchExtract: {
        pdfImpl: async () => ({ text: 'y'.repeat(200), info: { Title: 'A paper' } }),
      },
    })
    const { res, captured } = makeRes()
    await h(
      makeReq('POST', '/v3/research/lit/fetch', {
        records: [{ id: 'arxiv:2301.01234', arxivId: '2301.01234' }],
      }),
      res,
      ctx,
    )
    assert.equal(captured.statusCode, 200)
    assert.equal(captured.body.results[0].status, 'fetched')
    assert.ok(captured.body.results[0].docId)
    assert.equal(mem.attempts.length, 1)
    assert.equal(mem.attempts[0].strategy, 'arxiv')
    assert.equal(mem.attempts[0].ok, true)
  })

  it('下载失败结构化透传(paywalled);>5 条裁剪到 5', async () => {
    const mem = makeMemoryStore()
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ is_oa: false, best_oa_location: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      // fetch.enabled=true 且配 unpaywallEmail(回落 litSources.unpaywallEmail)
      readConfig: async () => ({
        enabled: true,
        config: {
          ...DEFAULT_RESEARCH_CONFIG,
          litSources: {
            ...DEFAULT_RESEARCH_CONFIG.litSources,
            unpaywallEmail: 'research@example.org',
          },
          fetch: { enabled: true },
        },
      }),
      fetchImpl,
      store: mem.store,
    })
    const records = Array.from({ length: 7 }, (_, i) => ({
      id: `doi:10.1/x${i}`,
      doi: `10.1/x${i}`,
    }))
    const { res, captured } = makeRes()
    await h(makeReq('POST', '/v3/research/lit/fetch', { records }), res, ctx)
    assert.equal(captured.statusCode, 200)
    assert.equal(captured.body.results.length, 5)
    for (const r of captured.body.results) {
      assert.equal(r.status, 'failed')
      assert.equal(r.reason, 'paywalled')
    }
  })

  it('缺 records → 400;workspace 关时 projectId 被忽略', async () => {
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: fetchCfg(true),
      fetchImpl: pdfFetch(),
      store: makeMemoryStore().store,
    })
    let { res, captured } = makeRes()
    await h(makeReq('POST', '/v3/research/lit/fetch', {}), res, ctx)
    assert.equal(captured.statusCode, 400)
    ;({ res, captured } = makeRes())
    await h(
      makeReq('POST', '/v3/research/lit/fetch', {
        records: [{ id: 'arxiv:2301.01234', arxivId: '2301.01234' }],
        projectId: 'p1',
      }),
      res,
      ctx,
    )
    assert.equal(captured.statusCode, 200)
    assert.equal(captured.body.projectId, undefined, 'workspace flag 关 → projectId 忽略')
  })
})

// ── fetch-batch + job/status ────────────────────────────────────────

describe('researchProxy lit/fetch-batch + job/status(flag 开)', () => {
  function makeJobStore(over: Partial<{ existing: ResearchJobRow | null }> = {}) {
    const created: unknown[] = []
    let requeued = 0
    return {
      created,
      requeued: () => requeued,
      jobStore: {
        createJob: async (input: any) => {
          created.push(input)
          return over.existing ?? fakeJobRow({ requestId: input.requestId })
        },
        getJob: async (_u: number, rid: string) =>
          over.existing ??
          fakeJobRow({ requestId: rid, status: 'completed', result: { records: [] } }),
        listCheckpoints: async () => [
          {
            phase: 'pdf_ingested' as const,
            status: 'completed' as const,
            output: {},
            error: null,
            createdAt: new Date(),
          },
        ],
        requeueInterruptedJob: async (u: number, rid: string) => {
          requeued++
          return fakeJobRow({ userId: String(u), requestId: rid, status: 'queued' })
        },
      },
    }
  }

  it('新 job:kind=research_task、payload.mode=fetch、响应 queued', async () => {
    const js = makeJobStore()
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: fetchCfg(true),
      jobStore: js.jobStore,
    })
    const { res, captured } = makeRes()
    await h(
      makeReq('POST', '/v3/research/lit/fetch-batch', {
        records: [{ id: 'a', doi: '10.1/a' }],
        requestId: 'topic-slug-1',
      }),
      res,
      ctx,
    )
    assert.equal(captured.statusCode, 200)
    assert.equal(captured.body.job.status, 'queued')
    assert.equal(captured.body.job.kind, 'research_task')
    const input = js.created[0] as any
    assert.equal(input.kind, 'research_task')
    assert.equal(input.payload.mode, 'fetch')
    assert.equal(input.payload.records.length, 1)
  })

  it('同 requestId 重提且既有 job interrupted → requeue 后回 queued', async () => {
    const js = makeJobStore({ existing: fakeJobRow({ status: 'interrupted' }) })
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: fetchCfg(true),
      jobStore: js.jobStore,
    })
    const { res, captured } = makeRes()
    await h(
      makeReq('POST', '/v3/research/lit/fetch-batch', {
        records: [{ id: 'a' }],
        requestId: 'req-1',
      }),
      res,
      ctx,
    )
    assert.equal(captured.statusCode, 200)
    assert.equal(captured.body.job.status, 'queued')
    assert.equal(js.requeued(), 1)
  })

  it('校验:records 空/非法 requestId → 400;非法字符 requestId 拒', async () => {
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: fetchCfg(true),
      jobStore: makeJobStore().jobStore,
    })
    let { res, captured } = makeRes()
    await h(makeReq('POST', '/v3/research/lit/fetch-batch', { requestId: 'r1' }), res, ctx)
    assert.equal(captured.statusCode, 400)
    ;({ res, captured } = makeRes())
    await h(
      makeReq('POST', '/v3/research/lit/fetch-batch', {
        records: [{ id: 'a' }],
        requestId: 'bad id with spaces!',
      }),
      res,
      ctx,
    )
    assert.equal(captured.statusCode, 400)
  })

  it('body 上限:fetch-batch 放宽 256KB,普通路由仍 16KB', async () => {
    const js = makeJobStore()
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: fetchCfg(true),
      jobStore: js.jobStore,
    })
    // 60KB 合法 batch body(填充 title)→ 200
    const bigRecords = [{ id: 'a', title: 'x'.repeat(60 * 1024) }]
    const { res, captured } = makeRes()
    await h(
      makeReq('POST', '/v3/research/lit/fetch-batch', { records: bigRecords, requestId: 'big-1' }),
      res,
      ctx,
    )
    assert.equal(captured.statusCode, 200)

    // 60KB 打到普通路由(lit/search)→ 413
    const h2 = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: fetchCfg(true),
      jobStore: js.jobStore,
    })
    const { res: res2, captured: captured2 } = makeRes()
    await h2(
      makeReq('POST', '/v3/research/lit/search', { query: 'x'.repeat(20 * 1024) }),
      res2,
      ctx,
    )
    assert.equal(captured2.statusCode, 413)
  })

  it('job/status:ResearchJobView 形状(completedPhases 去重);不存在 → 404', async () => {
    const js = makeJobStore({
      existing: fakeJobRow({
        status: 'completed',
        phase: 'pdf_ingested',
        result: { records: [], fetched: 0, needsOcr: 0, failed: 0 },
      }),
    })
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: fetchCfg(true),
      jobStore: js.jobStore,
    })
    const { res, captured } = makeRes()
    await h(makeReq('POST', '/v3/research/job/status', { requestId: 'req-1' }), res, ctx)
    assert.equal(captured.statusCode, 200)
    assert.equal(captured.body.status, 'completed')
    assert.equal(captured.body.kind, 'research_task')
    assert.equal(captured.body.phase, 'pdf_ingested')
    assert.deepEqual(captured.body.completedPhases, ['pdf_ingested'])
    assert.ok(captured.body.result)

    const h2 = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: fetchCfg(true),
      jobStore: {
        ...js.jobStore,
        getJob: async () => null,
      },
    })
    const { res: res2, captured: captured2 } = makeRes()
    await h2(makeReq('POST', '/v3/research/job/status', { requestId: 'nope' }), res2, ctx)
    assert.equal(captured2.statusCode, 404)
  })
})

// ── research_config fetch 兼容(向后兼容 coerce 语义) ───────────────

describe('research_config fetch 配置兼容', () => {
  it('旧 payload(无 fetch 键)仍通过严格校验', () => {
    const { fetch: _omit, ...legacy } = JSON.parse(
      JSON.stringify(DEFAULT_RESEARCH_CONFIG),
    ) as Record<string, unknown>
    void _omit
    const v = validateResearchConfig(legacy)
    assert.equal(v.fetch, undefined)
  })

  it('fetch 未知字段被 additionalProperties:false 拒绝', () => {
    const bad = { ...DEFAULT_RESEARCH_CONFIG, fetch: { enabled: true, evil: 1 } }
    assert.throws(() => validateResearchConfig(bad), /invalid_research_config/)
  })

  it('DEFAULT 通过 schema 校验(coerce 后形态)', () => {
    assert.equal(Value.Check(ResearchConfigJson, DEFAULT_RESEARCH_CONFIG), true)
    const enabled = {
      ...DEFAULT_RESEARCH_CONFIG,
      fetch: { enabled: true, unpaywallEmail: 'a@b.c' },
    }
    assert.equal(Value.Check(ResearchConfigJson, enabled), true)
  })
})
