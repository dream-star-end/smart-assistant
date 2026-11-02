import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { GO_CACHE_MODEL, assessGoCache, goCachePrompts } from './user-contract-go-cache.mjs'
import { authorizeContractModelSwitch } from './user-contract-switch-cost.mjs'
import { tapResult } from './user-contract.mjs'

// Execute the real CLI body with an isolated global scope. Every I/O dependency is a fixture:
// no credential file, HTTP listener, WebSocket connection, or provider request is used.
const entry = readFileSync(new URL('../v5-go-cache-contract.mjs', import.meta.url), 'utf8')
const source = entry
  .replace(/^#![^\n]*\n/, '')
  .replace(/^import [^\n]*\n/gm, '')

async function runClient({ mode = 'risk', failure, cacheRead = 64700 } = {}) {
  const state = { calls: [], frames: [], sockets: 0, output: [], peer: null, exitCode: undefined }
  const quoted = new Map()
  const confirmed = new Map()
  const processFixture = {
    env: { V5_E2E_BASE: 'https://fixture.invalid', V5_CANARY_PASSWORD_FILE: '/offline/canary.password' },
    get exitCode() { return state.exitCode },
    set exitCode(value) { state.exitCode = value },
    exit() { throw new Error('unexpected hard timeout') },
  }
  const response = value => ({ ok: true, json: async () => value })
  const fetchFixture = async (url, init) => {
    const path = new URL(url).pathname
    const body = init.body ? JSON.parse(init.body) : undefined
    state.calls.push({ path, method: init.method ?? 'GET', body })
    if (path === '/api/auth/login') {
      assert.equal(body.password, 'fixture-password')
      return response({ access_token: 'fixture-access-token' })
    }
    assert.equal(init.headers.authorization, 'Bearer fixture-access-token')
    if (path === '/api/public/models') return response({ models: [{ id: GO_CACHE_MODEL }] })
    if (path.startsWith('/api/sessions/') && init.method === 'PUT') {
      state.peer = path.split('/').at(-1)
      assert.equal(body.modelId, GO_CACHE_MODEL)
      return response({})
    }
    if (path === `/api/me/sessions/${state.peer}/model-switch-estimate`) {
      assert.equal(init.method, 'POST')
      assert.equal(body.targetModel, GO_CACHE_MODEL)
      assert.equal(body.agentId, 'main')
      assert.equal(body.mediaCount, 0)
      if (failure === 'api') return { ok: false, status: 409 }
      const quote = {
        requestId: body.requestId, targetModel: body.targetModel, mode,
        requiresConfirmation: mode === 'risk', canConfirm: failure !== 'balance',
        expiresAt: Date.now() + 60_000,
      }
      if (body.quoteToken !== undefined) {
        assert.equal(body.quoteToken, `fixture-quote:${body.requestId}`)
        const { quoteToken, ...original } = body
        assert.deepEqual(original, quoted.get(body.requestId))
        confirmed.set(body.requestId, original)
        return response({ ...quote, requestId: failure === 'mismatch' ? 'other' : body.requestId,
          requiresConfirmation: false, consent: `fixture-consent:${body.requestId}` })
      }
      quoted.set(body.requestId, body)
      return response({ ...quote, ...(mode === 'risk' ? { quoteToken: `fixture-quote:${body.requestId}` } : {}) })
    }
    if (path === '/api/me/usage') return response({ sessions: { rows: [{
      session_id: state.peer, requests: 3, input_tokens: 60,
      cache_read_tokens: cacheRead, cache_write_tokens: 32300,
    }] } })
    throw new Error(`unexpected fixture endpoint ${path}`)
  }
  class WebSocketFixture extends EventEmitter {
    constructor(url, protocols) {
      super()
      state.sockets++
      assert.equal(url, 'wss://fixture.invalid/ws/user-chat-bridge')
      assert.deepEqual(Array.from(protocols), ['bearer', 'fixture-access-token'])
      queueMicrotask(() => this.emit('open'))
    }
    send(raw) {
      const frame = JSON.parse(raw)
      state.frames.push(frame)
      const request = quoted.get(frame.clientMessageId)
      const approved = mode !== 'risk' || (confirmed.has(frame.clientMessageId) &&
        frame.modelSwitchConsent === `fixture-consent:${frame.clientMessageId}`)
      if (!request || !approved) {
        this.emit('message', JSON.stringify({ type: 'outbound.error', peer: frame.peer,
          clientMessageId: frame.clientMessageId, code: 'MODEL_SWITCH_CONFIRMATION_REQUIRED' }))
        return
      }
      assert.equal(frame.peer.id, state.peer)
      assert.equal(frame.model, request.targetModel)
      assert.equal(frame.agentId, request.agentId)
      assert.equal(frame.content.text, request.text)
      assert.equal(request.mediaCount, 0)
      if (mode !== 'risk') assert.equal(frame.modelSwitchConsent, undefined)
      this.emit('message', JSON.stringify({ type: 'outbound.message', peer: frame.peer,
        clientMessageId: frame.clientMessageId, isFinal: true }))
    }
    close() {}
  }
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    process: processFixture, URL, Date, JSON, Buffer, WebSocket: WebSocketFixture,
    fetch: fetchFixture, AbortSignal: { timeout: () => undefined },
    randomBytes: () => Buffer.from('012345abcdef', 'hex'), performance: { now: () => 1 },
    readFileSync: path => { assert.equal(path, '/offline/canary.password'); return 'fixture-password' },
    setTimeout: () => ({}), clearTimeout: () => {},
    console: { log: line => state.output.push(line) },
    GO_CACHE_MODEL, assessGoCache, goCachePrompts, tapResult,
    // A missing real import must not be concealed by injecting a free global into the CLI.
    ...(/^import \{ authorizeContractModelSwitch \} from ['"]\.\/lib\/user-contract-switch-cost\.mjs['"]$/m.test(entry)
      ? { authorizeContractModelSwitch } : {}),
  }, { timeout: 1000 })
  return state
}

test('G1 obtains a fresh API quote and confirmation bound to each of its three fixed-model turns', async () => {
  const state = await runClient()
  assert.equal(state.exitCode, undefined, state.output.join('\n'))
  assert.equal(state.frames.length, 3)
  assert.equal(new Set(state.frames.map(frame => frame.clientMessageId)).size, 3)
  assert.equal(state.calls.filter(call => call.path.endsWith('/model-switch-estimate')).length, 6)
  assert.match(state.output.join('\n'), /ok 1.*G1/)
  assert.match(state.output.join('\n'), /requests=3.*cache_read=64700/)
})

test('G1 stops before opening the chat socket on denied, failed or mismatched authorization', async () => {
  for (const [failure, expectedCalls] of [['balance', 1], ['api', 1], ['mismatch', 2]]) {
    const state = await runClient({ failure })
    assert.equal(state.exitCode, 1)
    assert.equal(state.sockets, 0, `${failure}: chat was opened before valid consent`)
    assert.equal(state.calls.filter(call => call.path.endsWith('/model-switch-estimate')).length, expectedCalls)
    assert.equal(state.calls.filter(call => call.path === '/api/me/usage').length, 0)
  }
})

test('G1 keeps exempt quotes unconfirmed and retains the cache proof after authorized chat', async () => {
  for (const mode of ['exempt', 'estimate']) {
    const exempt = await runClient({ mode })
    assert.equal(exempt.exitCode, undefined, exempt.output.join('\n'))
    assert.equal(exempt.frames.length, 3)
    assert.equal(exempt.calls.filter(call => call.path.endsWith('/model-switch-estimate')).length, 3)
    assert.ok(exempt.frames.every(frame => frame.modelSwitchConsent === undefined))
  }
  const brokenCache = await runClient({ cacheRead: 0 })
  assert.equal(brokenCache.exitCode, 1)
  assert.equal(brokenCache.frames.length, 3)
  assert.match(brokenCache.output.join('\n'), /cache read ratio 0 < 0\.5/)
})
