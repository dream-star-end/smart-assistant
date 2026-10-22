/**
 * Shared server-side WebSearch fulfillment for the Go chat/responses bridges.
 *
 * Run: npx tsx --test packages/commercial/src/http/proxy/webSearchServerTool.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  MAX_WEB_SEARCH_QUERY_CHARS,
  WebSearchError,
  type WebSearchHit,
  filterWebSearchHits,
  webSearchQuery,
  webSearchResultContent,
  webSearchToAnthropicEvents,
  webSearchToolSpec,
} from './webSearchServerTool.js'

type Obj = Record<string, unknown>

const searchTool = { type: 'web_search_20250305', name: 'web_search', max_uses: 8 }
const prompt = (query: string) => `Perform a web search for the query: ${query}`

function body(overrides: Obj = {}): Obj {
  return {
    model: 'muse-spark-1.3-go',
    messages: [{ role: 'user', content: prompt('fable 5.5') }],
    tools: [searchTool],
    ...overrides,
  }
}

describe('query extraction', () => {
  test('official side-request prompt wins even without the dedicated system prompt', () => {
    assert.equal(webSearchQuery(body()), 'fable 5.5')
    assert.equal(
      webSearchQuery({
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt('  spaced  ') }] }],
      }),
      'spaced',
    )
  })

  test('the dedicated system prompt covers wording drift, arbitrary chat is never searched', () => {
    assert.equal(
      webSearchQuery({
        system: 'You are an assistant for performing a web search tool use',
        messages: [{ role: 'user', content: 'fable 5.5 release date' }],
      }),
      'fable 5.5 release date',
    )
    assert.equal(
      webSearchQuery({ messages: [{ role: 'user', content: 'please summarize this repo' }] }),
      null,
    )
  })

  test('a side request is exactly one web_search tool, no function tools, with a query', () => {
    assert.deepEqual(webSearchToolSpec(body()), {
      name: 'web_search',
      query: 'fable 5.5',
      allowedDomains: [],
      blockedDomains: [],
    })
    assert.equal(
      webSearchToolSpec(
        body({
          tools: [searchTool, { name: 'Bash', input_schema: { type: 'object' } }],
        }),
      ),
      null,
    )
    assert.equal(
      webSearchToolSpec(body({ tools: [searchTool, { type: 'web_search_20250305', name: 'b' }] })),
      null,
    )
    assert.equal(webSearchToolSpec(body({ tools: [] })), null)
    assert.equal(
      webSearchToolSpec(body({ messages: [{ role: 'user', content: 'plain question' }] })),
      null,
    )
  })
})

describe('domain filtering', () => {
  const hits: WebSearchHit[] = [
    { title: 'a', url: 'https://example.com/a' },
    { title: 'b', url: 'https://docs.example.com/b' },
    { title: 'c', url: 'https://notexample.com/c' },
    { title: 'd', url: 'ftp://example.com/d' },
  ]

  test('allowed matches the host or a subdomain; blocked wins over allowed', () => {
    assert.deepEqual(
      filterWebSearchHits(hits, {
        allowedDomains: ['example.com'],
        blockedDomains: ['docs.example.com'],
      }).map((h) => h.url),
      ['https://example.com/a'],
    )
    assert.deepEqual(
      filterWebSearchHits(hits, { allowedDomains: [], blockedDomains: ['example.com'] }).map(
        (h) => h.url,
      ),
      ['https://notexample.com/c'],
    )
  })
})

describe('result protocol', () => {
  test('hits become web_search_result blocks with page age', async () => {
    const content = await webSearchResultContent(
      { name: 'web_search', query: 'q', allowedDomains: [], blockedDomains: [] },
      async () => [{ title: 'T', url: 'https://example.com', pageAge: '2026-10-01' }],
    )
    assert.deepEqual(content, [
      {
        type: 'web_search_result',
        title: 'T',
        url: 'https://example.com',
        encrypted_content: '',
        page_age: '2026-10-01',
      },
    ])
  })

  test('empty results stay empty; failures become an explicit error block', async () => {
    assert.deepEqual(
      await webSearchResultContent(
        { name: 'web_search', query: 'q', allowedDomains: [], blockedDomains: [] },
        async () => [],
      ),
      [],
    )
    assert.deepEqual(
      await webSearchResultContent(
        { name: 'web_search', query: 'q', allowedDomains: [], blockedDomains: [] },
        async () => {
          throw new WebSearchError('too_many_requests', 'slow down')
        },
      ),
      {
        type: 'web_search_tool_result_error',
        error_code: 'too_many_requests',
        error_message: 'slow down',
      },
    )
    assert.deepEqual(
      await webSearchResultContent(
        { name: 'web_search', query: 'q', allowedDomains: [], blockedDomains: [] },
        async () => {
          throw new Error('socket reset')
        },
      ),
      {
        type: 'web_search_tool_result_error',
        error_code: 'unavailable',
        error_message: 'socket reset',
      },
    )
  })

  test('an over-long query fails before any search call', async () => {
    let called = false
    const content = await webSearchResultContent(
      {
        name: 'web_search',
        query: 'x'.repeat(MAX_WEB_SEARCH_QUERY_CHARS + 1),
        allowedDomains: [],
        blockedDomains: [],
      },
      async () => {
        called = true
        return []
      },
    )
    assert.equal(called, false)
    assert.equal((content as Obj).error_code, 'query_too_long')
  })

  test('SSE carries server_tool_use then web_search_tool_result and ends the turn', async () => {
    const out: Obj[] = []
    const decoder = new TextDecoder()
    for await (const raw of webSearchToAnthropicEvents({
      model: 'muse-spark-1.3-go',
      spec: { name: 'web_search', query: 'fable 5.5', allowedDomains: [], blockedDomains: [] },
      search: async () => [{ title: 'T', url: 'https://example.com' }],
    })) {
      const line = decoder
        .decode(raw)
        .split('\n')
        .find((l) => l.startsWith('data: '))!
      out.push(JSON.parse(line.slice(6)) as Obj)
    }
    assert.deepEqual(
      out.map((e) => e.type),
      [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ],
    )
    assert.equal((out[1]!.content_block as Obj).type, 'server_tool_use')
    assert.equal((out[4]!.content_block as Obj).type, 'web_search_tool_result')
    assert.equal((out[6]!.delta as Obj).stop_reason, 'end_turn')
  })
})
