/**
 * 用户文献库(research/library.ts)集成测试(真 PG):
 *   - listLibraryDocuments:元数据投影(spanCount/createdAt)+ tenant 隔离 + 新入库在前。
 *   - deleteLibraryDocument:真删返回 true;跨租户/不存在返回 false。
 *   - uploadAndIngestDocument:research 未开启 → {disabled};开启后 txt 直传 →
 *     铸权威文档(与 oc-ingest 同一 ingestBlob 链)并可 list 到。
 *
 * pg 不可用时 skip(CI 必须有 PG → REQUIRE_TEST_DB=1)。
 */

// KMS key(测试固定 32B base64)— 必须在 import crypto 前设好。
process.env.OPENCLAUDE_KMS_KEY =
  process.env.OPENCLAUDE_KMS_KEY ?? Buffer.alloc(32, 7).toString('base64')
// blob 落盘走独立临时目录,避免污染系统默认路径。
process.env.OC_RESEARCH_BLOB_DIR = `/tmp/oc-research-lib-test-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { createPool, closePool, setPoolOverride, resetPool } from '../db/index.js'
import { query } from '../db/queries.js'
import { runMigrations } from '../db/migrate.js'
import { Readable } from 'node:stream'
import {
  addMembership,
  deleteLibraryDocument,
  ensureDefaultResearchProject,
  libraryListProjectIdFromUrl,
  listLibraryDocuments,
  listProjectDocIds,
  uploadAndIngestDocument,
} from '../research/library.js'
import { putDocument } from '../research/store.js'
import { DEFAULT_RESEARCH_CONFIG, patchResearchConfig } from '../admin/researchConfig.js'
import { hashSecret } from '../auth/containerIdentity.js'
import { makeResearchProxyHandler } from '../research/researchProxy.js'
import type { NormalizedDocument } from '@openclaude/protocol/research'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false
let userA = '0'
let userB = '0'

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* */
    }
    return false
  }
}

before(async () => {
  pgAvailable = await probePg()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await query('DROP SCHEMA public CASCADE')
  await query('CREATE SCHEMA public')
  await runMigrations()
})

after(async () => {
  if (pgAvailable) {
    try {
      await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    } catch {
      /* */
    }
    await closePool()
  }
})

beforeEach(async () => {
  if (!pgAvailable) return
  delete process.env.OC_RESEARCH_WORKSPACE
  await query(
    'TRUNCATE TABLE research_library_memberships, research_jobs, research_phase_checkpoints, research_documents, research_artifacts, research_blobs, chat_projects, users RESTART IDENTITY CASCADE',
  )
  await query('INSERT INTO research_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING')
  // 默认 enabled=false;单测各自按需 patch。
  await query('UPDATE research_config SET enabled = FALSE WHERE id = 1')
  const a = await query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ('a@test', 'x') RETURNING id::text AS id",
  )
  const b = await query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ('b@test', 'x') RETURNING id::text AS id",
  )
  userA = a.rows[0].id
  userB = b.rows[0].id
})

function skip(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}

function sampleDoc(docId: string, title = 'Paper'): NormalizedDocument {
  return {
    docId,
    contentSha256: `sha-${docId}`,
    lang: 'en',
    title,
    spans: [
      { spanId: 's1', sectionPath: ['1'], charStart: 0, charEnd: 20, text: 'Hello world example.' },
      { spanId: 's2', sectionPath: ['2'], charStart: 20, charEnd: 33, text: 'Second span.' },
    ],
    references: [],
  }
}

describe('research library: list/delete', () => {
  it('list:元数据投影 + tenant 隔离', async (t) => {
    if (skip(t)) return
    await putDocument({ userId: userA, doc: sampleDoc('doc1', 'First') })
    await putDocument({ userId: userA, doc: sampleDoc('doc2', 'Second') })
    await putDocument({ userId: userB, doc: sampleDoc('doc9', 'OtherTenant') })

    const docs = await listLibraryDocuments(userA)
    assert.equal(docs.length, 2)
    const ids = docs.map((d) => d.docId).sort()
    assert.deepEqual(ids, ['doc1', 'doc2'])
    const d1 = docs.find((d) => d.docId === 'doc1')
    assert.equal(d1?.title, 'First')
    assert.equal(d1?.lang, 'en')
    assert.equal(d1?.spanCount, 2)
    assert.ok(d1 && !Number.isNaN(Date.parse(d1.createdAt)))
    // 权威 span 文本绝不外泄到 list 投影
    assert.ok(!JSON.stringify(docs).includes('Hello world'))
  })

  it('delete:真删 true;跨租户/不存在 false', async (t) => {
    if (skip(t)) return
    await putDocument({ userId: userA, doc: sampleDoc('doc1') })
    assert.equal(await deleteLibraryDocument(userB, 'doc1'), false) // 跨租户删不掉
    assert.equal(await deleteLibraryDocument(userA, 'doc1'), true)
    assert.equal(await deleteLibraryDocument(userA, 'doc1'), false) // 已删
    assert.equal((await listLibraryDocuments(userA)).length, 0)
  })
})

describe('research library: upload+ingest', () => {
  it('research 未开启 → disabled(调用方 503)', async (t) => {
    if (skip(t)) return
    const r = await uploadAndIngestDocument(Number(userA), Buffer.from('hi'), 'text/plain', 'a.txt')
    assert.ok('disabled' in r && r.disabled)
  })

  it('开启后 txt 直传 → 铸权威文档 + list 可见', async (t) => {
    if (skip(t)) return
    await patchResearchConfig(
      { enabled: true, config: { ...DEFAULT_RESEARCH_CONFIG } },
      { adminId: userA },
    )
    const text = '# 标题\n\n这是一段用于入库的中文正文,足够长以形成有效 span。'
    const r = await uploadAndIngestDocument(
      Number(userA),
      Buffer.from(text, 'utf8'),
      'text/markdown',
      'note.md',
    )
    assert.ok(!('disabled' in r))
    assert.ok(r.ok, `ingest should succeed: ${JSON.stringify(r)}`)
    if (r.ok) {
      assert.ok(r.outline.docId)
      const docs = await listLibraryDocuments(userA)
      assert.equal(docs.length, 1)
      assert.equal(docs[0].docId, r.outline.docId)
      assert.ok(docs[0].spanCount >= 1)
    }
  })
})

async function insertChatProject(
  userId: string,
  id: string,
  name: string,
  isDefault = false,
): Promise<void> {
  await query(
    `INSERT INTO chat_projects
       (id, user_id, name, sort_order, created_at, updated_at, deleted_at, is_research_default)
     VALUES ($1, $2, $3, 0, 1, 1, NULL, $4)`,
    [id, userId, name, isDefault],
  )
}

describe('research library: membership / 默认课题', () => {
  it('同用户两课题隔离;跨租户不可见', async (t) => {
    if (skip(t)) return
    await putDocument({ userId: userA, doc: sampleDoc('doc1', 'A1') })
    await putDocument({ userId: userA, doc: sampleDoc('doc2', 'A2') })
    await putDocument({ userId: userB, doc: sampleDoc('doc1', 'B1') })
    await insertChatProject(userA, 'proj-a', '课题A')
    await insertChatProject(userA, 'proj-b', '课题B')
    await insertChatProject(userB, 'proj-x', '他人')
    await addMembership(userA, 'doc1', 'proj-a')
    await addMembership(userA, 'doc2', 'proj-b')
    await addMembership(userB, 'doc1', 'proj-x')

    const a1 = await listLibraryDocuments(userA, 'proj-a')
    assert.deepEqual(a1.map((d) => d.docId), ['doc1'])
    const a2 = await listLibraryDocuments(userA, 'proj-b')
    assert.deepEqual(a2.map((d) => d.docId), ['doc2'])
    assert.equal((await listLibraryDocuments(userB, 'proj-a')).length, 0)
    assert.equal((await listLibraryDocuments(userA, 'proj-x')).length, 0)
  })

  it('删文档级联 membership;删课题不删 document', async (t) => {
    if (skip(t)) return
    await putDocument({ userId: userA, doc: sampleDoc('doc1') })
    await insertChatProject(userA, 'proj-a', '课题A')
    await addMembership(userA, 'doc1', 'proj-a')
    assert.equal(await deleteLibraryDocument(userA, 'doc1'), true)
    const mem = await query(
      'SELECT 1 FROM research_library_memberships WHERE user_id = $1 AND doc_id = $2',
      [userA, 'doc1'],
    )
    assert.equal(mem.rowCount, 0)

    await putDocument({ userId: userA, doc: sampleDoc('doc2') })
    await addMembership(userA, 'doc2', 'proj-a')
    await query('UPDATE chat_projects SET deleted_at = 9 WHERE id = $1', ['proj-a'])
    assert.equal((await listLibraryDocuments(userA)).map((d) => d.docId).includes('doc2'), true)
  })

  it('默认课题懒创建一次;第二次 list 不新建;unique 冲突安全', async (t) => {
    if (skip(t)) return
    const id1 = await ensureDefaultResearchProject(userA)
    const id2 = await ensureDefaultResearchProject(userA)
    assert.equal(id1, id2)
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM chat_projects
        WHERE user_id = $1 AND is_research_default IS TRUE AND deleted_at IS NULL`,
      [userA],
    )
    assert.equal(Number(rows.rows[0].n), 1)

    const ids = await Promise.all([
      ensureDefaultResearchProject(userA),
      ensureDefaultResearchProject(userA),
      ensureDefaultResearchProject(userA),
    ])
    assert.ok(ids.every((id) => id === id1))
  })

  it('回填:3 篇无 membership → 进默认课题;已有 membership 不重复', async (t) => {
    if (skip(t)) return
    await putDocument({ userId: userA, doc: sampleDoc('d1') })
    await putDocument({ userId: userA, doc: sampleDoc('d2') })
    await putDocument({ userId: userA, doc: sampleDoc('d3') })
    await insertChatProject(userA, 'proj-other', '其他')
    await addMembership(userA, 'd3', 'proj-other')

    const defId = await ensureDefaultResearchProject(userA)
    const defDocs = await listLibraryDocuments(userA, defId)
    assert.deepEqual(defDocs.map((d) => d.docId).sort(), ['d1', 'd2'])
    const other = await listLibraryDocuments(userA, 'proj-other')
    assert.deepEqual(other.map((d) => d.docId), ['d3'])
    const memCount = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM research_library_memberships WHERE user_id = $1 AND doc_id = $2',
      [userA, 'd3'],
    )
    assert.equal(Number(memCount.rows[0].n), 1)
  })
})

describe('research library: GET ?projectId= helper', () => {
  it('flag 关忽略参数;开时读取 projectId', () => {
    assert.equal(libraryListProjectIdFromUrl('/api/me/research/library?projectId=abc', false), undefined)
    assert.equal(libraryListProjectIdFromUrl('/api/me/research/library?projectId=abc', true), 'abc')
    assert.equal(libraryListProjectIdFromUrl('/api/me/research/library', true), undefined)
  })
})

const SECRET = 'a1'.repeat(32)
const goodAuth = `Bearer oc-v3.7.${SECRET}`
const proxyCtx = { hostUuid: 'h1', boundIp: '10.0.0.1' }

function passingRepo(uid: number): any {
  return {
    findActiveByHostAndBoundIp: async () => ({
      id: 7,
      user_id: uid,
      bound_ip: '10.0.0.1',
      host_uuid: 'h1',
      secret_hash: hashSecret(SECRET),
    }),
  }
}

function makeReq(method: string, url: string, body?: unknown, contentType = 'application/json'): any {
  const payload =
    contentType === 'application/json'
      ? body === undefined
        ? ''
        : JSON.stringify(body)
      : typeof body === 'string'
        ? body
        : Buffer.isBuffer(body)
          ? body
          : ''
  const buf = typeof payload === 'string' ? Buffer.from(payload) : payload
  const r = Readable.from(buf.length ? [buf] : []) as any
  r.method = method
  r.url = url
  r.headers = { authorization: goodAuth, 'content-type': contentType }
  return r
}

function makeRes(): { res: any; captured: { statusCode: number; body: any } } {
  const captured = { statusCode: 0, body: undefined as any }
  const res: any = {
    headersSent: false,
    setHeader() {},
    writeHead(s: number) {
      captured.statusCode = s
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

describe('research library: proxy ingest/litrag 课题范围', () => {
  it('litrag 无 docs + 课题 3 篇 → 检索这 3 篇;60 篇 → 50 + truncated;flag 关 400', async (t) => {
    if (skip(t)) return
    await patchResearchConfig(
      { enabled: true, config: { ...DEFAULT_RESEARCH_CONFIG } },
      { adminId: userA },
    )
    const hOff = makeResearchProxyHandler({
      identityRepo: passingRepo(Number(userA)),
      readConfig: async () => ({ enabled: true, config: DEFAULT_RESEARCH_CONFIG }),
    })
    const off = makeRes()
    await hOff(makeReq('POST', '/v3/research/litrag/query', { query: 'hello' }), off.res, proxyCtx)
    assert.equal(off.captured.statusCode, 400)

    process.env.OC_RESEARCH_WORKSPACE = '1'
    const defId = await ensureDefaultResearchProject(userA)
    for (const id of ['p1', 'p2', 'p3']) {
      await putDocument({
        userId: userA,
        doc: sampleDoc(id, id),
      })
      await addMembership(userA, id, defId)
    }
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(Number(userA)),
      readConfig: async () => ({ enabled: true, config: DEFAULT_RESEARCH_CONFIG }),
    })
    const r3 = makeRes()
    await h(makeReq('POST', '/v3/research/litrag/query', { query: 'Hello world' }), r3.res, proxyCtx)
    assert.equal(r3.captured.statusCode, 200, JSON.stringify(r3.captured.body))
    assert.equal(r3.captured.body.docCount, 3)
    assert.equal(r3.captured.body.truncated, false)
    assert.ok(r3.captured.body.quotes.length >= 1)

    for (let i = 4; i <= 60; i++) {
      const id = `p${i}`
      await putDocument({ userId: userA, doc: sampleDoc(id, id) })
      await addMembership(userA, id, defId)
    }
    assert.equal((await listProjectDocIds(userA, defId, 100)).length, 60)
    const r60 = makeRes()
    await h(makeReq('POST', '/v3/research/litrag/query', { query: 'Hello' }), r60.res, proxyCtx)
    assert.equal(r60.captured.statusCode, 200)
    assert.equal(r60.captured.body.docCount, 50)
    assert.equal(r60.captured.body.truncated, true)
  })

  it('ingest 错误 projectId → 400 不写 document', async (t) => {
    if (skip(t)) return
    await patchResearchConfig(
      { enabled: true, config: { ...DEFAULT_RESEARCH_CONFIG } },
      { adminId: userA },
    )
    process.env.OC_RESEARCH_WORKSPACE = '1'
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(Number(userA)),
      readConfig: async () => ({ enabled: true, config: DEFAULT_RESEARCH_CONFIG }),
    })
    const md = '# Sky\n\nThe sky is blue because of Rayleigh scattering of sunlight.'
    const blobRes = makeRes()
    await h(makeReq('POST', '/v3/research/blob', md, 'text/markdown'), blobRes.res, proxyCtx)
    assert.equal(blobRes.captured.statusCode, 200)
    const blobId = blobRes.captured.body.blobId
    const bad = makeRes()
    await h(
      makeReq('POST', '/v3/research/ingest/parse', { blobId, filename: 'a.md', projectId: 'no-such' }),
      bad.res,
      proxyCtx,
    )
    assert.equal(bad.captured.statusCode, 400)
    assert.equal((await listLibraryDocuments(userA)).length, 0)

    const ok = makeRes()
    await h(
      makeReq('POST', '/v3/research/ingest/parse', { blobId, filename: 'a.md' }),
      ok.res,
      proxyCtx,
    )
    assert.equal(ok.captured.statusCode, 200, JSON.stringify(ok.captured.body))
    assert.ok(ok.captured.body.docId)
    assert.ok(ok.captured.body.projectId)
    const mem = await query(
      'SELECT 1 FROM research_library_memberships WHERE user_id = $1 AND doc_id = $2',
      [userA, ok.captured.body.docId],
    )
    assert.equal((mem.rowCount ?? 0) > 0, true)
  })
})
