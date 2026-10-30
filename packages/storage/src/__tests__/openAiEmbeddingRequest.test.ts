import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { OpenAIEmbeddingProvider } from '../embedding.js'

describe('OpenAIEmbeddingProvider request', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  it('posts text-embedding-3-large at 1024 dims in batches of 2 via mock fetch', async () => {
    const seen: Array<{ url: string; model: string; dimensions: number; input: string[]; auth: string }> = []
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string
        dimensions: number
        input: string[]
      }
      const headers = new Headers(init?.headers)
      seen.push({
        url: String(url),
        model: body.model,
        dimensions: body.dimensions,
        input: body.input,
        auth: headers.get('authorization') ?? '',
      })
      const data = body.input.map((_, index) => ({
        index,
        embedding: Array(body.dimensions).fill(0.01),
      }))
      return new Response(
        JSON.stringify({ data, usage: { prompt_tokens: 1, total_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    const key = 'sk-test-not-a-real-key-9876'
    const provider = new OpenAIEmbeddingProvider({
      apiKey: key,
      model: 'text-embedding-3-large',
      dimensions: 1024,
      baseUrl: 'https://api.openai.com/v1',
      batchSize: 2,
      timeoutMs: 1000,
    })
    const vecs = await provider.embed(['one', 'two', 'three'])
    assert.equal(vecs.length, 3)
    assert.equal(vecs[0]?.length, 1024)
    assert.equal(seen.length, 2)
    assert.deepEqual(
      seen.map((call) => call.url),
      ['https://api.openai.com/v1/embeddings', 'https://api.openai.com/v1/embeddings'],
    )
    assert.deepEqual(
      seen.map((call) => call.model),
      ['text-embedding-3-large', 'text-embedding-3-large'],
    )
    assert.deepEqual(
      seen.map((call) => call.dimensions),
      [1024, 1024],
    )
    assert.deepEqual(seen[0]?.input, ['one', 'two'])
    assert.deepEqual(seen[1]?.input, ['three'])
    assert.equal(seen[0]?.auth, `Bearer ${key}`)
    assert.equal(seen.every((call) => call.url.startsWith('https://api.openai.com/')), true)
  })
})
