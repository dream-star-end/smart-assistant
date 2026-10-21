import assert from 'node:assert/strict'
// OCV5-555: the commercial logger is a thin wrapper over @openclaude/kernel (one logger factory).
// logger.test.ts keeps the original contract; this file pins what the wrapper adds or must keep.
import { describe, test } from 'node:test'
import { SENSITIVE_KEYS, commercialLogLevel, createLogger } from '../logging/logger.js'

function capture(opts: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = []
  const logger = createLogger({
    ...opts,
    out: (l) => {
      lines.push(l)
    },
    now: () => 'T',
  })
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) }
}

describe('commercial logger (kernel wrapper)', () => {
  test('every SENSITIVE_KEYS key is redacted, also nested and in camelCase / kebab form', () => {
    const c = capture()
    const fields: Record<string, unknown> = {}
    for (const k of SENSITIVE_KEYS) fields[k] = `v-${k}`
    c.logger.info('x', {
      ...fields,
      nested: { ...fields },
      systemPrompt: 's',
      requestBody: 'b',
      'api-key': 'k',
    })
    const raw = c.lines.join('\n')
    for (const k of SENSITIVE_KEYS) assert.ok(!raw.includes(`v-${k}`), `${k} leaked`)
    const obj = c.parsed()[0]!
    assert.equal(obj.systemPrompt, '<redacted>')
    assert.equal(obj.requestBody, '<redacted>')
    assert.equal(obj['api-key'], '<redacted>')
  })
  test('Codex r1: mixed-case keys stay case-insensitive (passWord, toKen, ApI_kEy, BODY)', () => {
    const c = capture()
    c.logger.info('probe', {
      passWord: 's3cr3t-value',
      toKen: 'opaque-credential',
      ApI_kEy: 'k1',
      BODY: 'b1',
      SyStEm: 's1',
    })
    const raw = c.lines.join('\n')
    for (const leaked of ['s3cr3t-value', 'opaque-credential', 'k1', 'b1', 's1'])
      assert.ok(!raw.includes(leaked), leaked)
  })
  test('free text is scanned: e-mail, bearer tokens, URL credentials in msg and fields', () => {
    const c = capture()
    c.logger.warn('login failed for bob@example.com', {
      detail: 'Authorization: Bearer abcdefgh12345678 via postgres://u:pw123456@db/x',
    })
    const raw = c.lines.join('\n')
    for (const leaked of ['bob@example.com', 'abcdefgh12345678', 'pw123456'])
      assert.ok(!raw.includes(leaked), leaked)
  })
  test('an Error in fields keeps name/message/stack and gains code and cause', () => {
    const c = capture()
    const e = Object.assign(new Error('outer', { cause: new Error('inner') }), { code: 'E_X' })
    c.logger.error('bad', { err: e })
    const err = c.parsed()[0]!.err as Record<string, any>
    assert.equal(err.name, 'Error')
    assert.equal(err.message, 'outer')
    assert.equal(typeof err.stack, 'string')
    assert.equal(err.code, 'E_X')
    assert.equal(err.cause.message, 'inner')
  })
  test('loggers without an explicit level follow commercialLogLevel at runtime; explicit ones do not', () => {
    const shared = capture()
    const pinned = capture({ level: 'debug' })
    const before = commercialLogLevel.get()
    try {
      commercialLogLevel.set('error')
      shared.logger.warn('dropped')
      pinned.logger.debug('kept')
      commercialLogLevel.set('debug')
      shared.logger.debug('now kept')
    } finally {
      commercialLogLevel.set(before)
    }
    assert.deepEqual(
      shared.parsed().map((p) => p.msg),
      ['now kept'],
    )
    assert.deepEqual(
      pinned.parsed().map((p) => p.msg),
      ['kept'],
    )
  })
  test('ts/level/msg are the last keys of every line', () => {
    const c = capture({ base: { service: 's' } })
    c.logger.child({ uid: 1 }).info('m', { a: 1 })
    assert.deepEqual(Object.keys(c.parsed()[0]!).slice(-3), ['ts', 'level', 'msg'])
  })
})
