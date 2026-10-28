import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getStaticProvider } from '@openclaude/protocol'
import { createOpenAIResponsesGoFetch } from '../../packages/commercial/src/http/proxy/openAiResponsesGoBridge.js'
import { diagnoseGoResponses } from '../v5-go-responses-diagnose.mjs'
import { GO_CACHE_MODEL } from '../lib/user-contract-go-cache.mjs'

type Obj = Record<string, any>
const sse = (events: Obj[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
const usage = { input_tokens: 31000, output_tokens: 1, input_tokens_details: { cached_tokens: 30000 } }
const completed = { type: 'response.completed', response: { status: 'completed', usage } }
const upstreamModel = getStaticProvider('opencodego').upstreamModelForRequest!(GO_CACHE_MODEL)

test('diagnostic uses existing model mapping, stable session and successful history, three requests only', async () => {
  const requests: Obj[] = []
  const summaries: Obj[] = []
  const ok = await diagnoseGoResponses({ key: 'PRIVATE_KEY', upstreamModel, bridgeFactory: createOpenAIResponsesGoFetch,
    signal: new AbortController().signal, emit: (s: Obj) => summaries.push(s),
    fetchImpl: async (url: string, init: RequestInit) => {
      requests.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
      return sse([{ type: 'response.output_text.delta', delta: String(requests.length) }, completed])
    },
  })
  assert.equal(ok, true)
  assert.equal(requests.length, 3)
  assert.equal(upstreamModel, 'muse-spark-1.3-contributor')
  assert.equal(new Set(requests.map((r) => r.headers.get('x-opencode-session'))).size, 1)
  assert(requests[0].headers.get('x-opencode-session'))
  for (const [i, request] of requests.entries()) {
    assert.equal(request.url, 'https://opencode.ai/inference/go/v1/responses')
    assert.equal(request.headers.get('authorization'), 'Bearer PRIVATE_KEY')
    assert.equal(request.body.model, upstreamModel)
    assert.equal(request.body.instructions, requests[0].body.instructions)
    assert.equal(request.body.max_output_tokens, 32000)
    assert.equal(request.body.input.length, 2 * i + 1)
    if (i > 0) assert.deepEqual(request.body.input.slice(0, 2 * i - 1), requests[i - 1].body.input)
  }
  assert.deepEqual(summaries.map((s) => s.bridge), ['completed', 'completed', 'completed'])
  assert(summaries.every((s) => s.upstream.ending === 'eof' && s.upstream.terminal.type === 'response.completed'))
  assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE|Reference row|G432-/)
})

test('missing terminal vs snapshot-only completion remain distinguishable; strict bridge failures are not retried', async () => {
  for (const snapshot of [false, true]) {
    let requests = 0
    const summaries: Obj[] = []
    const ok = await diagnoseGoResponses({ key: 'PRIVATE_KEY', upstreamModel, bridgeFactory: createOpenAIResponsesGoFetch,
      signal: new AbortController().signal, emit: (s: Obj) => summaries.push(s),
      fetchImpl: async () => {
        requests++
        if (requests < 3) return sse([{ type: 'response.output_text.delta', delta: '1' }, completed])
        return sse(snapshot ? [{ ...completed, response: { ...completed.response,
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'PRIVATE_SNAPSHOT' }] }],
        } }] : [{ type: 'response.created' }])
      },
    })
    assert.equal(ok, false)
    assert.equal(requests, 3)
    const failed = summaries.at(-1)!
    assert.equal(failed.reason, 'bridge_incomplete_response')
    assert.equal(failed.upstream.ending, 'eof')
    assert.equal(failed.upstream.textDeltaChars, 0)
    assert.equal(failed.upstream.terminal?.textChars ?? 0, snapshot ? 16 : 0)
    assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE/)
  }
})

test('HTTP error and local deadline stop at the first call without exposing errors or retries', async () => {
  for (const abort of [false, true]) {
    let requests = 0
    const summaries: Obj[] = []
    const controller = new AbortController()
    const ok = await diagnoseGoResponses({ key: 'PRIVATE_KEY', upstreamModel, bridgeFactory: createOpenAIResponsesGoFetch,
      signal: controller.signal, emit: (s: Obj) => summaries.push(s), fetchImpl: async () => {
        requests++
        if (abort) { controller.abort(); throw new Error('PRIVATE_ERROR') }
        return new Response(JSON.stringify({ error: { message: 'PRIVATE_ERROR' } }), { status: 400 })
      },
    })
    assert.equal(ok, false)
    assert.equal(requests, 1)
    assert.equal(summaries[0].reason, abort ? 'local_deadline_or_abort' : 'http_error')
    assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE/)
  }
})
