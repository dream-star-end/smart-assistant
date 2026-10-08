/**
 * project_search gateway side (P5a): loopback + gateway token, flag gate,
 * no project → clear error, master forwarding, local fallback, hit shaping.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/projectSearchLocal.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ChatProjectRuntimeBind, ProjectAsset, SearchChatProjectAssetsOpts } from '@openclaude/storage'
import { matchBridgeApiAllowlist, matchCommercialContainerApiProxy } from '../bridgeApiAllowlist.js'
import {
  PROJECT_SEARCH_LOCAL_PATH,
  PROJECT_SEARCH_PATH,
  buildProjectSearchHits,
  handleProjectSearchLocal,
  projectSearchSnippet,
} from '../projectSearchLocal.js'

const BOARD = '11111111-2222-4333-8444-555555555555'
const ON = { OC_PROJECT_CONTEXT: '1', OC_P5_PROJECT_SEARCH: '1' } as NodeJS.ProcessEnv
const MASTER = { ...ON, OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master:18791/', OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.1.ab' }

function asset(over: Partial<ProjectAsset>): ProjectAsset {
  return {
    id: 'a1',
    projectId: 'chat-1',
    source: 'upload',
    sessionId: null,
    name: '合同.pdf',
    url: `/api/media/${'a'.repeat(64)}.pdf`,
    containerPath: null,
    mime: 'application/pdf',
    sizeBytes: 2048,
    digest: null,
    excerpt: '第一章 总则。付款期限为三十日,逾期按日计息。第二章 交付。',
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function url(params: Record<string, string>): string {
  return `${PROJECT_SEARCH_LOCAL_PATH}?${new URLSearchParams(params).toString()}`
}

const local = { method: 'GET', remoteAddress: '127.0.0.1', authorized: true }

function fakeFetcher(status: number, body: unknown, seen: string[] = [], headers: unknown[] = []) {
  return (async (u: string, opts: { headers: unknown }) => {
    seen.push(u)
    headers.push(opts.headers)
    return { statusCode: status, body: { text: async () => JSON.stringify(body) } }
  }) as any
}

describe('handleProjectSearchLocal', () => {
  test('non-loopback caller is refused even with the token', async () => {
    const r = await handleProjectSearchLocal(
      { ...local, remoteAddress: '172.17.0.1', url: url({ projectId: BOARD, q: 'x' }) },
      { env: ON },
    )
    assert.equal(r.status, 403)
  })

  test('missing/wrong gateway token → 401', async () => {
    const r = await handleProjectSearchLocal({ ...local, authorized: false, url: url({ projectId: BOARD, q: 'x' }) }, { env: ON })
    assert.equal(r.status, 401)
  })

  test('flag off (or project context off) → 404', async () => {
    for (const env of [{}, { OC_P5_PROJECT_SEARCH: '1' }, { OC_PROJECT_CONTEXT: '1' }]) {
      const r = await handleProjectSearchLocal({ ...local, url: url({ projectId: BOARD, q: 'x' }) }, { env: env as NodeJS.ProcessEnv })
      assert.equal(r.status, 404)
    }
  })

  test('no project in the run → NO_PROJECT', async () => {
    const r = await handleProjectSearchLocal({ ...local, url: url({ q: '付款' }) }, { env: ON })
    assert.equal(r.status, 400)
    assert.equal((r.body as any).error.code, 'NO_PROJECT')
  })

  test('bad input → 400', async () => {
    const cases: Array<Record<string, string>> = [
      { projectId: 'not-a-uuid', q: 'x' },
      { projectId: BOARD, q: '  ' },
      { projectId: BOARD, q: 'x'.repeat(201) },
      { projectId: BOARD, q: 'x', source: 'secret' },
    ]
    for (const p of cases) {
      const r = await handleProjectSearchLocal({ ...local, url: url(p) }, { env: ON })
      assert.equal(r.status, 400, JSON.stringify(p))
    }
    const post = await handleProjectSearchLocal({ ...local, method: 'POST', url: url({ projectId: BOARD, q: 'x' }) }, { env: ON })
    assert.equal(post.status, 405)
  })

  test('with a master: forwards board id + query with the container token, shapes hits', async () => {
    const seen: string[] = []
    const headers: unknown[] = []
    const r = await handleProjectSearchLocal(
      { ...local, url: url({ projectId: BOARD, q: '付款', source: 'upload', limit: '50' }) },
      { env: MASTER, fetcher: fakeFetcher(200, { chatProjectId: 'chat-1', assets: [asset({})] }, seen, headers) },
    )
    assert.equal(r.status, 200)
    const u = new URL(seen[0]!)
    assert.equal(u.pathname, PROJECT_SEARCH_PATH)
    assert.equal(u.searchParams.get('boardProjectId'), BOARD)
    assert.equal(u.searchParams.get('q'), '付款')
    assert.equal(u.searchParams.get('source'), 'upload')
    assert.equal(u.searchParams.get('limit'), '20', 'limit clamps to 20')
    assert.deepEqual(headers[0], { authorization: 'Bearer oc-v3.1.ab' })
    const hits = (r.body as any).hits
    assert.equal(hits.length, 1)
    assert.equal(hits[0].path, `/home/agent/.openclaude/uploads/${'a'.repeat(64)}.pdf`)
    assert.match(hits[0].snippet, /付款期限/)
  })

  test('master 404 (foreign / unknown board) → PROJECT_NOT_FOUND; master down → 502', async () => {
    const nf = await handleProjectSearchLocal(
      { ...local, url: url({ projectId: BOARD, q: 'x' }) },
      { env: MASTER, fetcher: fakeFetcher(404, { error: { code: 'PROJECT_NOT_FOUND' } }) },
    )
    assert.equal(nf.status, 404)
    assert.equal((nf.body as any).error.code, 'PROJECT_NOT_FOUND')
    const down = await handleProjectSearchLocal(
      { ...local, url: url({ projectId: BOARD, q: 'x' }) },
      { env: MASTER, fetcher: (async () => { throw new Error('ECONNREFUSED') }) as any },
    )
    assert.equal(down.status, 502)
  })

  test('no master: local backend, only the bound chat project, OC_USER_ID first then default', async () => {
    const calls: Array<{ userId: string; chatProjectId: string; opts: SearchChatProjectAssetsOpts }> = []
    const lookups: string[] = []
    const bind: ChatProjectRuntimeBind = { userId: 'default', chatProjectId: 'chat-9', boardProjectId: BOARD, name: 'P', instructions: null }
    const r = await handleProjectSearchLocal(
      { ...local, url: url({ projectId: BOARD, q: '交付', source: 'output' }) },
      {
        env: { ...ON, OC_USER_ID: 'u7' },
        getBindByBoardProjectId: async (userId) => {
          lookups.push(userId)
          return userId === 'default' ? bind : null
        },
        search: async (userId, chatProjectId, opts) => {
          calls.push({ userId, chatProjectId, opts })
          return [asset({ source: 'output', url: null, containerPath: '/home/agent/.openclaude/generated/plan.md', excerpt: '交付计划' })]
        },
      },
    )
    assert.equal(r.status, 200)
    assert.deepEqual(lookups, ['u7', 'default'])
    assert.deepEqual(calls, [{ userId: 'default', chatProjectId: 'chat-9', opts: { q: '交付', limit: 8, source: 'output' } }])
    assert.equal((r.body as any).hits[0].path, '/home/agent/.openclaude/generated/plan.md')

    const none = await handleProjectSearchLocal(
      { ...local, url: url({ projectId: BOARD, q: 'x' }) },
      { env: ON, getBindByBoardProjectId: async () => null, search: async () => { throw new Error('must not search') } },
    )
    assert.equal(none.status, 404)
  })
})

describe('hit shaping', () => {
  test('snippet centres on the first case-insensitive match and marks cuts', () => {
    const text = `${'a'.repeat(300)} Needle here ${'b'.repeat(300)}`
    const s = projectSearchSnippet(text, 'needle', 20)
    assert.match(s, /^….*Needle here.*…$/)
    assert.ok(s.length < 80)
  })

  test('name-only hit shows the opening; no excerpt → empty', () => {
    assert.equal(projectSearchSnippet('short text', 'zzz'), 'short text')
    assert.equal(projectSearchSnippet(null, 'x'), '')
  })

  test('control chars and line breaks collapse; uploads resolve to the uploads dir', () => {
    const [hit] = buildProjectSearchHits([asset({ name: 'a\u0007b\nc', excerpt: '付款\n\n期限' })], '付款')
    assert.equal(hit!.name, 'ab c')
    assert.equal(hit!.snippet, '付款 期限')
    assert.equal(hit!.path, `/home/agent/.openclaude/uploads/${'a'.repeat(64)}.pdf`)
  })
})

describe('reachability', () => {
  test('the loopback route is not on the browser / bridge proxy allowlists', () => {
    for (const m of ['GET', 'POST', 'HEAD']) {
      assert.equal(matchBridgeApiAllowlist(PROJECT_SEARCH_LOCAL_PATH, m), null)
      assert.equal(matchCommercialContainerApiProxy(PROJECT_SEARCH_LOCAL_PATH, m), null)
    }
  })
})
