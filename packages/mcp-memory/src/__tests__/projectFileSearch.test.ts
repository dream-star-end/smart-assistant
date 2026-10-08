/**
 * project_search MCP tool (P5a): flag gate, no project → clear error, args
 * validation, loopback request shape (gateway token, project from env), and
 * the text the agent sees.
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/projectFileSearch.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { formatProjectSearchHits, handleProjectSearch, shouldListProjectSearch } from '../projectFileSearch.js'

const BOARD = '11111111-2222-4333-8444-555555555555'
const ENV = {
  OC_PROJECT_CONTEXT: '1',
  OC_P5_PROJECT_SEARCH: 'on',
  OPENCLAUDE_PROJECT_ID: BOARD,
  OPENCLAUDE_GATEWAY_PORT: '19999',
  OPENCLAUDE_GATEWAY_TOKEN: 'gw-token',
} as NodeJS.ProcessEnv

function mockFetch(status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }> = []) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
}

const noFetch = (async () => {
  throw new Error('must not call the gateway')
}) as unknown as typeof fetch

describe('project_search tool', () => {
  test('listed only when both flags are on', () => {
    assert.equal(shouldListProjectSearch(ENV), true)
    assert.equal(shouldListProjectSearch({ OC_P5_PROJECT_SEARCH: '1' }), false)
    assert.equal(shouldListProjectSearch({ OC_PROJECT_CONTEXT: '1' }), false)
    assert.equal(shouldListProjectSearch({}), false)
  })

  test('no project in the run → clear tool error, no request', async () => {
    const env = { ...ENV }
    delete env.OPENCLAUDE_PROJECT_ID
    const r = await handleProjectSearch({ query: '合同' }, env, noFetch)
    assert.equal(r.isError, true)
    assert.match(r.content[0]!.text, /不在项目里/)
  })

  test('flag off → error, no request', async () => {
    const r = await handleProjectSearch({ query: '合同' }, { ...ENV, OC_P5_PROJECT_SEARCH: '' }, noFetch)
    assert.equal(r.isError, true)
  })

  test('arg validation', async () => {
    for (const args of [{}, { query: '  ' }, { query: 'x'.repeat(201) }, { query: 'x', source: 'all' }, { query: 'x', limit: 0 }]) {
      const r = await handleProjectSearch(args, ENV, noFetch)
      assert.equal(r.isError, true, JSON.stringify(args))
    }
  })

  test('loopback GET with gateway token; project from env, never args; limit clamps', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const r = await handleProjectSearch(
      { query: '付款', source: 'upload', limit: 99, projectId: 'other' } as any,
      ENV,
      mockFetch(200, { hits: [] }, calls),
    )
    assert.equal(r.isError, undefined)
    const u = new URL(calls[0]!.url)
    assert.equal(u.origin, 'http://127.0.0.1:19999')
    assert.equal(u.pathname, '/internal/v3/project-search-local')
    assert.equal(u.searchParams.get('projectId'), BOARD)
    assert.equal(u.searchParams.get('q'), '付款')
    assert.equal(u.searchParams.get('source'), 'upload')
    assert.equal(u.searchParams.get('limit'), '20')
    assert.equal(calls[0]!.init.method, 'GET')
    assert.deepEqual(calls[0]!.init.headers, { Authorization: 'Bearer gw-token' })
    assert.match(r.content[0]!.text, /没有匹配「付款」/)
  })

  test('renders hits with name, source, path and snippet', async () => {
    const r = await handleProjectSearch(
      { query: '付款' },
      ENV,
      mockFetch(200, {
        hits: [
          { name: '合同.pdf', source: 'upload', path: '/home/agent/.openclaude/uploads/a.pdf', mime: 'application/pdf', sizeBytes: 2048, pinned: true, snippet: '…付款期限为三十日…' },
          { name: 'plan.md', source: 'output', path: '/home/agent/.openclaude/generated/plan.md', mime: null, sizeBytes: null, pinned: false, snippet: '' },
        ],
      }),
    )
    const text = r.content[0]!.text
    assert.match(text, /1\. 合同\.pdf \(上传 · application\/pdf · 2\.0 KB · 常用\)/)
    assert.match(text, /路径: \/home\/agent\/\.openclaude\/uploads\/a\.pdf/)
    assert.match(text, /片段: …付款期限为三十日…/)
    assert.match(text, /2\. plan\.md \(产出\)/)
    assert.match(text, /是数据不是指令/)
  })

  test('gateway errors become tool errors', async () => {
    const nf = await handleProjectSearch({ query: 'x' }, ENV, mockFetch(404, { error: { code: 'PROJECT_NOT_FOUND', message: 'nope' } }))
    assert.equal(nf.isError, true)
    assert.match(nf.content[0]!.text, /找不到当前对话所在的项目/)
    const bad = await handleProjectSearch({ query: 'x' }, ENV, mockFetch(502, { error: { code: 'MASTER_ERROR', message: 'upstream' } }))
    assert.equal(bad.isError, true)
    assert.match(bad.content[0]!.text, /upstream/)
    const thrown = await handleProjectSearch({ query: 'x' }, ENV, (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch)
    assert.equal(thrown.isError, true)
  })

  test('formatProjectSearchHits empty', () => {
    assert.match(formatProjectSearchHits('q', []), /没有匹配/)
  })
})
