// OCV5-550: the gateway logger is a thin wrapper over @openclaude/kernel. Same signature and
// stdout/stderr split as before; credentials and free text are now redacted, payload keys are not.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { createLogger, gatewayLogLevel } from '../logger.js'

const FAKE_SK = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE0123456789'

describe('gateway logger (kernel wrapper)', () => {
  const out: string[] = []
  const err: string[] = []
  const orig = { out: process.stdout.write, err: process.stderr.write }
  beforeEach(() => {
    out.length = 0
    err.length = 0
    process.stdout.write = ((s: string) => {
      out.push(String(s))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((s: string) => {
      err.push(String(s))
      return true
    }) as typeof process.stderr.write
    gatewayLogLevel.set('debug')
  })
  afterEach(() => {
    process.stdout.write = orig.out
    process.stderr.write = orig.err
    gatewayLogLevel.set('info')
  })
  const lines = (a: string[]) =>
    a
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

  test('one JSON line per call; info/debug → stdout, warn/error → stderr; base context kept', () => {
    const log = createLogger({ module: 'm', agentId: 'a1' })
    log.info('hello', { traceId: 't1', sessionKey: 'agent:main:x', n: 1 })
    log.debug('dbg')
    log.warn('careful')
    log.error('bad')
    const [a, b] = lines(out)
    assert.equal(a.msg, 'hello')
    assert.equal(a.level, 'info')
    assert.equal(a.module, 'm')
    assert.equal(a.agentId, 'a1')
    assert.equal(a.traceId, 't1')
    assert.equal(a.sessionKey, 'agent:main:x')
    assert.equal(a.n, 1)
    assert.equal(typeof a.ts, 'string')
    assert.equal(b.level, 'debug')
    assert.deepEqual(
      lines(err).map((l) => l.level),
      ['warn', 'error'],
    )
  })

  test('credentials and free text are redacted; payload keys (gateway diagnostics) are kept', () => {
    const log = createLogger({ module: 'm' })
    log.info(`auth with ${FAKE_SK}`, {
      authorization: 'Bearer abcdefgh12345678',
      containerToken: 'ct-secret',
      url: 'https://u:pw123456@host/x?token=zzz999',
      user: 'bob@example.com',
      body: 'diagnostic body',
      text: 'tool output',
    })
    const [a] = lines(out)
    const raw = out.join('')
    for (const leaked of [
      FAKE_SK,
      'abcdefgh12345678',
      'ct-secret',
      'pw123456',
      'zzz999',
      'bob@example.com',
    ])
      assert.ok(!raw.includes(leaked), `${leaked} leaked`)
    assert.equal(a.body, 'diagnostic body')
    assert.equal(a.text, 'tool output')
  })

  test('(msg, ctx, err): Error → error/stack (+errorCode, cause); a plain value is kept, redacted', () => {
    const log = createLogger({ module: 'm' })
    const e = Object.assign(new Error('connect failed for bob@example.com'), {
      code: 'ECONNREFUSED',
    })
    log.error('boom', { op: 'x' }, e)
    log.warn('odd', undefined, { reason: 'busy', password: 'p' })
    log.warn('str', undefined, 'plain string')
    const [a, b, c] = lines(err)
    assert.equal(a.error, 'connect failed for <email>')
    assert.equal(a.errorCode, 'ECONNREFUSED')
    assert.match(a.stack, /connect failed for <email>/)
    assert.equal(a.op, 'x')
    assert.deepEqual(b.error, { reason: 'busy', password: '<redacted>' })
    assert.equal(c.error, 'plain string')
  })

  test('the level is shared and can change while running', () => {
    const log = createLogger({ module: 'm' })
    gatewayLogLevel.set('warn')
    log.info('dropped')
    log.warn('kept')
    gatewayLogLevel.set('info')
    log.info('now kept')
    assert.deepEqual(
      lines(out).map((l) => l.msg),
      ['now kept'],
    )
    assert.deepEqual(
      lines(err).map((l) => l.msg),
      ['kept'],
    )
  })
})
