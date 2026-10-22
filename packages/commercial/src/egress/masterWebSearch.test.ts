/**
 * Egress → master WebSearch proxy client (OpenCode Go bridge server-side search).
 *
 * Run: npx tsx --test packages/commercial/src/egress/masterWebSearch.test.ts
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'

import { GROK_SEARCH_PATH, MINIMAX_SEARCH_PATH } from '@openclaude/protocol'

import { WebSearchError } from '../http/proxy/webSearchServerTool.js'
import {
  MASTER_WEB_SEARCH_PATHS,
  type SearchRequestFn,
  hitsFromSearchResponse,
  makeMasterWebSearch,
} from './masterWebSearch.js'

const spec = {
  name: 'web_search',
  query: 'fable 5.5',
  allowedDomains: [],
  blockedDomains: [],
}
const ctx = {
  authorization: 'Bearer oc-v3.7.secret',
  hostUuid: 'host-1',
  boundIp: '172.31.0.9',
}

describe('master search client', () => {
  test('posts the query with the caller identity and the original container IP', async () => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(Buffer.from(c)))
      req.on('end', () => {
        assert.equal(req.url, MINIMAX_SEARCH_PATH)
        assert.equal(req.headers.authorization, ctx.authorization)
        assert.equal(req.headers['x-v5-egress-peer-ip'], ctx.boundIp)
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { q: spec.query })
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            organic: [
              { title: 'Docs', url: 'https://example.com/doc', date: '2026-10-01' },
              { title: '', url: 'not-a-url' },
            ],
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const search = makeMasterWebSearch({ controlBaseUrl: `http://127.0.0.1:${port}` })
      assert.deepEqual(await search(spec, ctx), [
        { title: 'Docs', url: 'https://example.com/doc', pageAge: '2026-10-01' },
      ])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('MiniMax failure falls back to Grok; both failing surfaces the last error', async () => {
    const seen: string[] = []
    const requestFn: SearchRequestFn = async (url) => {
      seen.push(url)
      if (url.endsWith(MINIMAX_SEARCH_PATH)) return { status: 502, text: '' }
      return {
        status: 200,
        text: JSON.stringify({ organic: [{ title: 'G', url: 'https://g.test' }] }),
      }
    }
    const search = makeMasterWebSearch({ controlBaseUrl: 'http://master:1234', requestFn })
    assert.deepEqual(await search(spec, ctx), [
      { title: 'G', url: 'https://g.test', pageAge: null },
    ])
    assert.deepEqual(seen, [
      `http://master:1234${MINIMAX_SEARCH_PATH}`,
      `http://master:1234${GROK_SEARCH_PATH}`,
    ])
    assert.deepEqual(MASTER_WEB_SEARCH_PATHS, [MINIMAX_SEARCH_PATH, GROK_SEARCH_PATH])

    const failing = makeMasterWebSearch({
      controlBaseUrl: 'http://master:1234',
      requestFn: async () => ({ status: 429, text: '' }),
    })
    await assert.rejects(
      failing(spec, ctx),
      (error: unknown) =>
        error instanceof WebSearchError &&
        error.code === 'too_many_requests' &&
        /rate limited/.test(error.message),
    )
  })

  test('an empty organic array is a real no-results answer, malformed JSON is a failure', async () => {
    assert.deepEqual(hitsFromSearchResponse(JSON.stringify({ organic: [] })), [])
    assert.throws(() => hitsFromSearchResponse('not-json'), /invalid JSON/)
    assert.throws(() => hitsFromSearchResponse(JSON.stringify({})), /no organic results/)
  })

  test('refuses to call the proxy without container authentication', async () => {
    let called = false
    const search = makeMasterWebSearch({
      controlBaseUrl: 'http://master:1234',
      requestFn: async () => {
        called = true
        return { status: 200, text: JSON.stringify({ organic: [] }) }
      },
    })
    await assert.rejects(
      search(spec, { ...ctx, authorization: undefined }),
      /container authentication/,
    )
    assert.equal(called, false)
  })
})
