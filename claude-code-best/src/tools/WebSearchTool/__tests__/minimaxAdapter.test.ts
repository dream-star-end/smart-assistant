import { expect, mock, test } from 'bun:test'

const BASE = 'http://proxy.internal'
const TOKEN = 'container-tok'

// One shared mock whose behaviour each test drives via mutable impls — avoids
// bun mock.module + dynamic-import re-mock caching races. Each test sets impls
// and wiring inline (no beforeEach) for bulletproof isolation.
let postImpl: (...a: unknown[]) => Promise<unknown> = () => Promise.reject(new Error('unset'))
let getImpl: (...a: unknown[]) => Promise<unknown> = () => Promise.reject(new Error('unset'))
const post = mock((...a: unknown[]) => postImpl(...a))
const get = mock((...a: unknown[]) => getImpl(...a))
mock.module('axios', () => ({ default: { post, get, isCancel: () => false } }))
mock.module('../../../utils/http', () => ({ getWebFetchUserAgent: () => 'TestAgent/1.0' }))

const { MiniMaxSearchAdapter, minimaxSearchConfigured } = await import('../adapters/minimaxAdapter')

function wire(on: boolean) {
  if (on) {
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = BASE
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = TOKEN
  } else {
    delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  }
}

// The adapter talks to the MASTER proxy, whose trimOrganic already normalised
// MiniMax's `link` → `url`. So the mocked proxy response uses `url` (not `link`).
const MINIMAX_RESPONSE = {
  organic: [
    { title: '抖音起号技巧', url: 'https://www.toutiao.com/a/1', snippet: '1.定位...', date: '2026-01-01' },
    { title: '算法解析', url: 'https://blog.csdn.net/x', snippet: '完播率退出核心' },
    { title: 'no url', snippet: 'dropped' },
  ],
}
const BING_HTML = `<li class="b_algo"><h2><a href="https://fallback.com/a">Fallback</a></h2></li>`

test('minimaxSearchConfigured reflects both env vars', () => {
  wire(true)
  expect(minimaxSearchConfigured()).toBe(true)
  wire(false)
  expect(minimaxSearchConfigured()).toBe(false)
})

test('POSTs {q} to master proxy with bearer token, maps organic→SearchResult', async () => {
  wire(true)
  post.mockClear()
  postImpl = () => Promise.resolve({ data: MINIMAX_RESPONSE })
  const results = await new MiniMaxSearchAdapter().search('抖音运营', {})
  const [url, body, cfg] = post.mock.calls[0] as unknown as [
    string,
    { q: string },
    { headers: Record<string, string> },
  ]
  expect(url).toBe(`${BASE}/internal/v3/minimax-search`)
  expect(body).toEqual({ q: '抖音运营' })
  expect(cfg.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  expect(results).toEqual([
    // date present → prepended to snippet head so the model perceives recency.
    { title: '抖音起号技巧', url: 'https://www.toutiao.com/a/1', snippet: '(2026-01-01) 1.定位...' },
    { title: '算法解析', url: 'https://blog.csdn.net/x', snippet: '完播率退出核心' },
  ])
})

test('applies allowedDomains filtering', async () => {
  wire(true)
  postImpl = () => Promise.resolve({ data: MINIMAX_RESPONSE })
  const results = await new MiniMaxSearchAdapter().search('x', { allowedDomains: ['csdn.net'] })
  expect(results.map((r) => r.url)).toEqual(['https://blog.csdn.net/x'])
})

test('falls back to Bing when master proxy errors', async () => {
  wire(true)
  postImpl = () => Promise.reject(new Error('proxy down'))
  getImpl = () => Promise.resolve({ data: BING_HTML })
  const results = await new MiniMaxSearchAdapter().search('x', {})
  expect(results[0]?.url).toBe('https://fallback.com/a')
})

test('falls back to Bing (no POST) when not wired for MiniMax', async () => {
  wire(false)
  post.mockClear()
  getImpl = () => Promise.resolve({ data: BING_HTML })
  const results = await new MiniMaxSearchAdapter().search('x', {})
  expect(post).not.toHaveBeenCalled()
  expect(results[0]?.url).toBe('https://fallback.com/a')
})
