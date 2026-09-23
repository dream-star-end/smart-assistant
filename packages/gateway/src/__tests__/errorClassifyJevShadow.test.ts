/**
 * OCV5-253 — Jev shadow stays off the turn path.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/errorClassifyJevShadow.test.ts
 */
import * as assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { classifyRunError } from '../errorClassify.js'
import {
  JEV_SHADOW_CONFIDENCE_MIN,
  JEV_SHADOW_FLAG,
  JEV_SHADOW_KEY,
  JEV_SHADOW_MAX_INFLIGHT,
  JEV_SHADOW_URL,
  type JevShadowRecord,
  buildJevShadowState,
  flushErrorClassifyJevShadowForTests,
  hashErrorText,
  resetErrorClassifyJevShadowForTests,
  setErrorClassifyJevShadowDepsForTests,
} from '../errorClassifyJevShadow.js'

const SENTINEL = 'SHADOW_SENTINEL_raw_error_must_not_be_logged'

function enable(key = 'test-key'): void {
  process.env[JEV_SHADOW_FLAG] = '1'
  process.env[JEV_SHADOW_KEY] = key
}

function okBody(choice: string, confidence: number) {
  return {
    answers: { code: { choice, confidence } },
    providerMetadata: {
      gateway: { routing: { modelAttempts: [{ providerAttempts: [{ startTime: 10, endTime: 180 }] }] } },
    },
  }
}

describe('errorClassify Jev shadow', () => {
  const prevFlag = process.env[JEV_SHADOW_FLAG]
  const prevKey = process.env[JEV_SHADOW_KEY]
  let logs: Array<{ msg: string; ctx: Record<string, unknown> }>
  let calls: Array<{ url: string; init: { headers: Record<string, string>; body: string; dispatcher: object } }>

  beforeEach(() => {
    resetErrorClassifyJevShadowForTests()
    delete process.env[JEV_SHADOW_FLAG]
    delete process.env[JEV_SHADOW_KEY]
    logs = []
    calls = []
  })

  afterEach(async () => {
    await flushErrorClassifyJevShadowForTests()
    resetErrorClassifyJevShadowForTests()
    if (prevFlag === undefined) delete process.env[JEV_SHADOW_FLAG]
    else process.env[JEV_SHADOW_FLAG] = prevFlag
    if (prevKey === undefined) delete process.env[JEV_SHADOW_KEY]
    else process.env[JEV_SHADOW_KEY] = prevKey
  })

  function installFetch(payload: unknown | (() => Promise<unknown>) = okBody('rate_limited', 0.95), status = 200) {
    setErrorClassifyJevShadowDepsForTests({
      logInfo: (msg, ctx) => logs.push({ msg, ctx }),
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        const body = typeof payload === 'function' ? await payload() : payload
        return { status, json: async () => body }
      },
    })
  }

  it('flag off: unknown classification makes no request and no shadow log', async () => {
    installFetch()
    const raw = `totally unrecognized ${SENTINEL}`
    const result = classifyRunError(raw)
    await flushErrorClassifyJevShadowForTests()
    assert.deepEqual(result, { code: 'unknown', message: '' })
    assert.equal(calls.length, 0)
    assert.equal(logs.length, 0)
  })

  it('flag on without a key: no request and no throw', async () => {
    process.env[JEV_SHADOW_FLAG] = '1'
    installFetch()
    assert.deepEqual(classifyRunError(`missing key ${SENTINEL}`), { code: 'unknown', message: '' })
    await flushErrorClassifyJevShadowForTests()
    assert.equal(calls.length, 0)
    assert.equal(logs.length, 0)
  })

  it('flag on with a key still returns the regex result unchanged', async () => {
    enable()
    installFetch(okBody('auth_error', 1))
    const unknown = classifyRunError(`unrecognized ${SENTINEL}`)
    const known = classifyRunError('API Error: 429 rate limited')
    await flushErrorClassifyJevShadowForTests()
    assert.deepEqual(unknown, { code: 'unknown', message: '' })
    assert.equal(known.code, 'rate_limited')
    assert.equal(calls.length, 1)
    const logged = JSON.stringify(logs)
    assert.equal(logged.includes(SENTINEL), false)
    assert.equal(logged.includes('test-key'), false)
    const record = logs[0]?.ctx as unknown as JevShadowRecord
    assert.equal(record.regexCode, 'unknown')
    assert.equal(record.jevCode, 'auth_error')
    assert.equal(record.confidence, 1)
    assert.equal(record.upstreamMs, 170)
    assert.equal(record.thresholdMet, true)
    assert.equal(record.textHash, hashErrorText(`unrecognized ${SENTINEL}`))
  })

  it('reads confidence from providerMetadata.typesafe when the answer omits it', async () => {
    enable()
    installFetch({
      answers: { code: { type: 'choice', choice: 'auth_error', probabilities: { auth_error: 0.99 } } },
      providerMetadata: { typesafe: { confidence: { code: 0.99 } } },
    })
    classifyRunError('metadata confidence only')
    await flushErrorClassifyJevShadowForTests()
    const record = logs[0]?.ctx as { confidence?: number; thresholdMet?: boolean; jevCode?: string }
    assert.equal(record.jevCode, 'auth_error')
    assert.equal(record.confidence, 0.99)
    assert.equal(record.thresholdMet, true)
  })

  it('confidence below 0.9 does not meet the adopt threshold', async () => {
    enable()
    installFetch(okBody('bad_request', JEV_SHADOW_CONFIDENCE_MIN - 0.01))
    classifyRunError('some unknown failure')
    await flushErrorClassifyJevShadowForTests()
    assert.equal((logs[0]?.ctx as { thresholdMet?: boolean }).thresholdMet, false)
  })

  it('high-confidence unknown is not an adoptable change', async () => {
    enable()
    installFetch(okBody('unknown', 0.99))
    classifyRunError('some unknown failure')
    await flushErrorClassifyJevShadowForTests()
    assert.equal((logs[0]?.ctx as { thresholdMet?: boolean }).thresholdMet, false)
    assert.equal((logs[0]?.ctx as { jevCode?: string }).jevCode, 'unknown')
  })

  it('known errors do not call Jev', async () => {
    enable()
    installFetch()
    assert.equal(classifyRunError('API error (status 404 Not Found): grok route expired').code, 'model_not_available')
    assert.equal(classifyRunError('Selected model is at capacity. Please try a different model.').code, 'model_not_available')
    assert.equal(classifyRunError('API Error: 503 MOONSHOT_NOT_CONFIGURED').code, 'model_not_available')
    assert.equal(classifyRunError('CURSOR_SAND_BOX_NOT_RUNNING').code, 'upstream_failed')
    await flushErrorClassifyJevShadowForTests()
    assert.equal(calls.length, 0)
  })

  it('request carries platform semantics and a direct dispatcher', async () => {
    enable()
    const agents: object[] = []
    setErrorClassifyJevShadowDepsForTests({
      logInfo: (msg, ctx) => logs.push({ msg, ctx }),
      undici: {
        Agent: class {
          constructor(opts?: { connections?: number }) {
            Object.assign(this, opts)
            agents.push(this)
          }
        },
        fetch: async (url, init) => {
          calls.push({ url, init })
          return { status: 200, json: async () => okBody('upstream_failed', 0.91) }
        },
      },
    })
    classifyRunError(`socket reset ${SENTINEL}`)
    await flushErrorClassifyJevShadowForTests()
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, JEV_SHADOW_URL)
    assert.equal(calls[0]?.init.dispatcher, agents[0])
    assert.equal((agents[0] as { connections?: number }).connections, JEV_SHADOW_MAX_INFLIGHT)
    const state = JSON.parse(calls[0]!.init.body).state as string
    assert.equal(state.includes('[non-retryable]'), true)
    assert.equal(state.includes('CURSOR_SAND_BOX_'), true)
    assert.equal(state.includes('INFERENCE_TICKET_REJECTED'), true)
    assert.equal(state.includes(SENTINEL), true)
    assert.equal(state, buildJevShadowState(`socket reset ${SENTINEL}`))
  })

  it('fetch failure and timeout do not change classification', async () => {
    enable()
    setErrorClassifyJevShadowDepsForTests({
      timeoutMs: 30,
      logInfo: (msg, ctx) => logs.push({ msg, ctx }),
      fetchImpl: async (_url, init) => {
        await new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('stall')), 1000)
          const fail = () => {
            clearTimeout(timer)
            reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
          }
          if (init.signal.aborted) fail()
          else init.signal.addEventListener('abort', fail, { once: true })
        })
        return { status: 200, json: async () => ({}) }
      },
    })
    assert.deepEqual(classifyRunError('hangs'), { code: 'unknown', message: '' })
    await flushErrorClassifyJevShadowForTests()
    assert.equal(logs[0]?.ctx.status, 'timeout')

    logs.length = 0
    setErrorClassifyJevShadowDepsForTests({
      logInfo: (msg, ctx) => logs.push({ msg, ctx }),
      fetchImpl: async () => {
        throw new Error('boom')
      },
    })
    assert.deepEqual(classifyRunError('garbage'), { code: 'unknown', message: '' })
    await flushErrorClassifyJevShadowForTests()
    assert.equal(logs[0]?.ctx.status, 'error')
    assert.equal(String(logs[0]?.ctx.errorName), 'Error')
  })

  it('non-200 and garbage JSON are swallowed', async () => {
    enable()
    installFetch({ nope: true }, 500)
    classifyRunError('provider said nothing useful')
    await flushErrorClassifyJevShadowForTests()
    assert.equal(logs[0]?.ctx.status, 'error')
    assert.equal(logs[0]?.ctx.httpStatus, 500)

    logs.length = 0
    setErrorClassifyJevShadowDepsForTests({
      logInfo: (msg, ctx) => logs.push({ msg, ctx }),
      fetchImpl: async () => ({
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      }),
    })
    classifyRunError(`still unknown ${SENTINEL}`)
    await flushErrorClassifyJevShadowForTests()
    assert.equal(logs[0]?.ctx.status, 'error')
    assert.equal(logs[0]?.ctx.errorName, 'SyntaxError')
    assert.equal(JSON.stringify(logs).includes(SENTINEL), false)
  })

  it('drops calls past the inflight cap', async () => {
    enable()
    let releaseGate: (value: void | PromiseLike<void>) => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    setErrorClassifyJevShadowDepsForTests({
      logInfo: (msg, ctx) => logs.push({ msg, ctx }),
      fetchImpl: async () => {
        await gate
        return { status: 200, json: async () => okBody('rate_limited', 0.95) }
      },
    })
    classifyRunError('unknown one')
    classifyRunError('unknown two')
    classifyRunError('unknown three')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const dropped = logs.filter((entry) => entry.ctx.status === 'dropped')
    assert.equal(dropped.length, 1)
    releaseGate()
    await flushErrorClassifyJevShadowForTests()
    assert.equal(logs.filter((entry) => entry.ctx.status === 'ok').length, 2)
  })
})
