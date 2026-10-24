import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { SystemHelpRelay, SystemHelpRelayError, makeSystemHelpMasterClient } from '../systemHelpRelay.js'
function failure(code: string) { return (e: unknown) => e instanceof SystemHelpRelayError && e.code === code }
function binding(relay: SystemHelpRelay, session: object, key = 'synthetic-session', current = () => true) {
  const close = relay.openAttempt(session, key, current)
  const context = JSON.parse(readFileSync(relay.contextFile(key), 'utf8')) as { nonce: string; context: string }
  return { close, request: (command: unknown) => relay.request({ nonce: context.nonce, context: context.context, command }), context }
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
test('a stable context path refreshes per attempt; all model commands stay read/prepare/result only', async () => {
  let now = 1000000; const calls: Record<string, unknown>[] = []
  const relay = new SystemHelpRelay(async raw => { const body = raw as Record<string, unknown>; calls.push(body); return body.kind === 'refresh' ? { token: 'synthetic-short', expiresAt: now + 60000 } : { enabled: true } }, () => now)
  const session = {}; const end = relay.begin(session, 'synthetic-bootstrap')
  const path = relay.contextFile('synthetic-session')
  const first = binding(relay, session)
  assert.deepEqual(await first.request({ kind: 'read', operationId: 'fixture.read' }), { enabled: true })
  assert.equal(calls[0]?.kind, 'refresh'); assert.equal(calls[1]?.grant, 'synthetic-short')
  for (const kind of ['confirm', 'execute', 'deny', 'refresh']) await assert.rejects(first.request({ kind }), failure('INVALID_INPUT'))
  const second = binding(relay, session)
  assert.equal(relay.contextFile('synthetic-session'), path)
  assert.notEqual(first.context.nonce, second.context.nonce)
  first.close()
  await assert.rejects(first.request({ kind: 'catalog' }), failure('INVALID_CONTEXT'))
  await second.request({ kind: 'catalog' })
  assert.equal(calls.filter(x => x.kind === 'refresh').length, 1)
  now += 60000; await second.request({ kind: 'catalog' })
  assert.equal(calls.filter(x => x.kind === 'refresh').length, 2)
  end(); await assert.rejects(second.request({ kind: 'catalog' }), failure('INVALID_CONTEXT'))
})
test('late refresh and business results never revive a closed attempt; old cleanup cannot close its successor', async () => {
  const refresh = deferred<unknown>(); const business = deferred<unknown>(); let refreshes = 0
  const relay = new SystemHelpRelay(async raw => {
    if ((raw as { kind: string }).kind === 'refresh') { refreshes++; return refresh.promise }
    return business.promise
  }, () => 1000000)
  const session = {}; const end = relay.begin(session, 'synthetic-bootstrap')
  const first = binding(relay, session)
  const old = first.request({ kind: 'catalog' }); const oldRejected = assert.rejects(old, failure('INVALID_CONTEXT'))
  first.close()
  refresh.resolve({ token: 'synthetic-short', expiresAt: 1060000 }); await oldRejected
  const second = binding(relay, session)
  const pending = second.request({ kind: 'read', operationId: 'fixture.read' }); const pendingRejected = assert.rejects(pending, failure('INVALID_CONTEXT'))
  await Promise.resolve(); second.close(); business.resolve({ enabled: true }); await pendingRejected
  const third = binding(relay, session); first.close(); second.close()
  assert.deepEqual(await third.request({ kind: 'catalog' }), { enabled: true })
  assert.equal(refreshes, 1)
  const closeOldLogical = end
  relay.begin(session, 'synthetic-next-bootstrap')
  const fourth = binding(relay, session); closeOldLogical()
  assert.deepEqual(await fourth.request({ kind: 'catalog' }), { enabled: true })
})
test('current session/runner/turn fences reject before transport and shared refresh remains single flight', async () => {
  const refresh = deferred<unknown>(); let refreshes = 0; let current = true
  const relay = new SystemHelpRelay(async raw => {
    if ((raw as { kind: string }).kind === 'refresh') { refreshes++; return refresh.promise }
    return { visible: true }
  }, () => 1000000)
  const session = {}; relay.begin(session, 'synthetic-bootstrap')
  const active = binding(relay, session, 'synthetic-session', () => current)
  const a = active.request({ kind: 'catalog' }); const b = active.request({ kind: 'catalog' })
  assert.equal(refreshes, 1)
  refresh.resolve({ token: 'synthetic-short', expiresAt: 1060000 })
  assert.deepEqual(await a, { visible: true }); assert.deepEqual(await b, { visible: true })
  current = false
  await assert.rejects(active.request({ kind: 'catalog' }), failure('INVALID_CONTEXT'))
  assert.equal(refreshes, 1)
})
test('a late old-grant failure cannot discard the fresh successor grant and never retries a preparation', async () => {
  let now = 1000000; let refreshes = 0; let preparations = 0
  const oldEffect = deferred<unknown>()
  const relay = new SystemHelpRelay(async raw => {
    const body = raw as { kind: string; grant?: string }
    if (body.kind === 'refresh') return { token: `synthetic-${++refreshes}`, expiresAt: now + 60000 }
    if (body.kind === 'prepare') { preparations++; if (body.grant === 'synthetic-1') return oldEffect.promise }
    return { id: randomUUID(), state: 'prepared' }
  }, () => now)
  const session = {}; relay.begin(session, 'synthetic-bootstrap')
  const active = binding(relay, session)
  const old = active.request({ kind: 'prepare', operationId: 'fixture.write', idempotencyKey: 'synthetic-original' })
  const rejected = assert.rejects(old)
  await new Promise<void>(resolve => setImmediate(resolve))
  now += 60000
  await active.request({ kind: 'catalog' })
  oldEffect.reject(new SystemHelpRelayError('UPSTREAM_REJECTED')); await rejected
  await active.request({ kind: 'catalog' })
  assert.equal(refreshes, 2); assert.equal(preparations, 1)
})
test('master transport fixes its endpoint and identity, rejects redirects and size limits before I/O', async () => {
  let calls = 0
  const client = makeSystemHelpMasterClient({ OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:1234/ignored', OPENCLAUDE_V3_CONTAINER_TOKEN: 'synthetic-container-proof' }, async (url, init) => {
    calls++; assert.equal(url, 'http://127.0.0.1:1234/internal/v3/system-actions'); assert.equal(init?.redirect, 'error')
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer synthetic-container-proof')
    return new Response(JSON.stringify({ ok: true }))
  })!
  assert.deepEqual(await client({ kind: 'catalog' }), { ok: true })
  await assert.rejects(client({ args: 'a'.repeat(4 * 1024 * 1024) }), failure('INVALID_INPUT'))
  assert.equal(calls, 1)
  assert.equal(makeSystemHelpMasterClient({}), undefined)
  assert.equal(makeSystemHelpMasterClient({ OPENCLAUDE_V3_MASTER_BASE_URL: 'https://user:secret@invalid.example', OPENCLAUDE_V3_CONTAINER_TOKEN: 'synthetic' }), undefined)
  const oversized = makeSystemHelpMasterClient({ OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1', OPENCLAUDE_V3_CONTAINER_TOKEN: 'synthetic' }, async () => new Response('a'.repeat(4 * 1024 * 1024 + 1)))!
  await assert.rejects(oversized({ kind: 'catalog' }), failure('UNAVAILABLE'))
})
