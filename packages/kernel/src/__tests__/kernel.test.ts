// OCV5-548 (phase 3 plan v3.6 P1): kernel redact / errors / log / trace. Counter-examples use
// synthetic credentials, e-mail addresses, phone numbers, paths and nested causes (§7.8).
// Run: npm run test:kernel
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  AppError,
  type LogRecord,
  createLevelRef,
  createLogger,
  createRedactor,
  errorCode,
  isCredentialKey,
  parseLogLevel,
  redact,
  redactText,
} from '../index.js'
import { createNodeLogger, currentTrace, withTrace } from '../node.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ'
const FAKE_SK = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE0123456789'

function capture(opts: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const lines: LogRecord[] = []
  const log = createLogger({ sink: (r) => lines.push(r), now: () => 'T', ...opts })
  const json = () => lines.map((l) => JSON.parse(l.line))
  return { log, lines, json }
}

describe('redact', () => {
  test('credential keys: any case/kebab/camel form, suffixes; counters are not credentials', () => {
    for (const k of [
      'token',
      'accessToken',
      'Access-Token',
      'x-api-key',
      'apiKey',
      'Authorization',
      'set-cookie',
      'github_token',
      'db_password',
      'clientSecret',
      'containerToken',
      'passWord',
      'toKen',
      'PASSWORD',
      'ApI_kEy',
      'AuthoRization',
      'CooKie',
    ])
      assert.equal(isCredentialKey(k), true, k)
    for (const k of [
      'input_tokens',
      'max_tokens',
      'tokensEstimate',
      'sessionKey',
      'traceId',
      'keyCount',
      'secretLength_ms',
    ])
      assert.equal(isCredentialKey(k), false, k)
  })
  test('nested objects, arrays and Maps are walked; credentials replaced at any depth', () => {
    const out = redact({
      a: { b: [{ password: 'hunter2', ok: 1 }] },
      headers: new Map([['authorization', 'Bearer abcdefgh12345678']]),
      input_tokens: 42,
    }) as Record<string, any>
    assert.equal(out.a.b[0].password, '<redacted>')
    assert.equal(out.a.b[0].ok, 1)
    assert.equal(out.headers.authorization, '<redacted>')
    assert.equal(out.input_tokens, 42)
  })
  test('payload keys only under the payload policy', () => {
    const v = { body: 'user text', content: 'x', status: 200 }
    assert.deepEqual(redact(v), v)
    assert.deepEqual(createRedactor({ payload: true })(v), {
      body: '<redacted>',
      content: '<redacted>',
      status: 200,
    })
    assert.deepEqual(createRedactor({ extraKeys: ['Status'] })(v), { ...v, status: '<redacted>' })
  })
  test('free text: bearer, JWT, provider keys, URL userinfo, query secrets, key=value, e-mail, phone', () => {
    const s = redactText(
      [
        `Authorization: Bearer ${FAKE_SK}`,
        `jwt ${FAKE_JWT}`,
        'gh ghp_FAKEFAKEFAKEFAKEFAKEFAKE1234',
        'aws AKIAFAKEFAKEFAKEFAKE',
        'db postgres://app:s3cr3t-pass@10.0.0.5:5432/db',
        'cb https://x.test/cb?code=abc123&state=ok&access_token=zzz999',
        'cfg password=Sup3rSecret api_key: k-123456',
        'mail alice.example+tag@example.com',
        'cn 13812345678 intl +44 7700900123',
      ].join('\n'),
    )
    for (const leaked of [
      FAKE_SK,
      FAKE_JWT,
      'ghp_FAKE',
      'AKIAFAKE',
      's3cr3t-pass',
      'abc123',
      'zzz999',
      'Sup3rSecret',
      'k-123456',
      'alice.example',
      '13812345678',
      '7700900123',
    ])
      assert.ok(!s.includes(leaked), `${leaked} leaked: ${s}`)
    assert.match(s, /state=ok/)
    assert.match(s, /postgres:\/\/<redacted>@10\.0\.0\.5:5432\/db/)
  })
  test('Codex r1: quoted values with spaces and JSON text are redacted, also inside errors', () => {
    const { log, json } = capture()
    log.error('failed', undefined, new Error('password="correct horse battery staple"'))
    const line = JSON.stringify(json()[0])
    assert.ok(!line.includes('correct horse'), line)
    for (const t of [
      '{"password":"SyntheticPassword123"}',
      "cfg secret='two words here' next",
      'x-api-key: abc123 then',
      'access_token="t o k e n"',
    ]) {
      const out = redactText(t)
      for (const leaked of ['SyntheticPassword123', 'two words', 'abc123', 't o k e n'])
        assert.ok(!out.includes(leaked), `${t} → ${out}`)
    }
    assert.equal(redactText('{"password":"p4ss","n":1}'), '{"password":"<redacted>","n":1}')
  })
  test('Codex r1: a cut never breaks a credential apart (scan first, then sweep the cut end)', () => {
    const tail = ' postgres://app:SyntheticPassword123'
    for (const [pre, rest] of [
      ['x'.repeat(8192 - tail.length), '@db/x'], // the @ falls just past the cut
      ['x'.repeat(8180), ''], // cut inside the password itself
    ] as const) {
      const out = redactText(pre + tail + rest)
      assert.ok(!out.includes('SyntheticPassword'), 'password leaked at the cut')
    }
    for (const t of [
      `${'y'.repeat(8170)} password="open quote never closed`,
      `${'y'.repeat(8180)} Authorization: Bearer abcdefghijklmnop`,
      `${'y'.repeat(8185)} ${FAKE_JWT}`,
    ]) {
      const out = redactText(t)
      for (const leaked of ['open quote', 'abcdefghijkl', 'eyJzdWIi'])
        assert.ok(!out.includes(leaked), `${leaked} leaked at the cut`)
    }
    // an e-mail or phone number crossing the cut is still matched whole (scan margin)
    for (const [who, leaked] of [
      [' alice.secret@example.com tail', 'alice.secret'],
      [' 13812345678 tail', '1381234'],
    ] as const) {
      const at = 8192 - 8
      const out = redactText('w'.repeat(at) + who + 'w'.repeat(100))
      assert.ok(!out.includes(leaked), `${leaked} leaked at the cut`)
    }
    const huge = `${'z'.repeat(2_000_000)} password=late`
    assert.ok(redactText(huge).length < 8300, 'bounded output even when not fully scanned')
  })
  test('Codex r2: no catastrophic backtracking; cost is bounded whatever the input', () => {
    const log = createLogger({ sink: () => {} })
    for (const unit of [
      'a.',
      'a@',
      'x://',
      'a:b',
      'password="',
      'password=',
      'Bearer ',
      'eyJ.',
      '1',
      '+1',
      'a-',
    ])
      for (const len of [8000, 1 << 20]) {
        const input = unit.repeat(Math.ceil(len / unit.length))
        const t0 = performance.now()
        redactText(input)
        log.info(input, { v: input })
        const ms = performance.now() - t0
        assert.ok(ms < 1000, `${JSON.stringify(unit)} x ${len}: ${Math.round(ms)} ms`)
      }
  })
  test('Codex r3: long credential values and long JWTs before the cut are still redacted', () => {
    const lines: string[] = []
    const log = createLogger({ sink: (r) => lines.push(r.line) })
    log.info(JSON.stringify({ token: 'q'.repeat(1025) }))
    log.info(`password=${' '.repeat(9)}SyntheticPassword123`)
    log.info(`Authorization: Bearer ${'b'.repeat(5000)}`)
    log.info(`key sk-${'k'.repeat(600)} and https://u:${'p'.repeat(300)}@h/x`)
    log.info(`password="${'o'.repeat(2000)}`)
    log.info(`${'x'.repeat(7400)} eyJhbGciOiJIUzI1NiJ9.eyJ${'a'.repeat(2000)}.signature123`)
    log.info(`${'x'.repeat(7000)} key ghp_${'g'.repeat(3000)}`)
    const all = lines.join('\n')
    for (const leaked of [
      'qqqqqqqq',
      'SyntheticPassword',
      'bbbbbbbb',
      'kkkkkkkk',
      'pppppppp',
      'oooooooo',
      'eyJhbGci',
      'gggggggg',
    ])
      assert.ok(!all.includes(leaked), `${leaked} leaked`)
  })
  test('Codex c2r1: cookie headers to the end of the line; camel/kebab keys in serialized JSON', () => {
    for (const t of [
      'Cookie: theme=dark; oc_rt=SyntheticRefreshToken123',
      'set-cookie: sid=abc; Path=/; HttpOnly oc_rt=SyntheticRefreshToken123',
      JSON.stringify({ refreshToken: 'SyntheticRefreshToken123' }),
      JSON.stringify({ 'x-api-key': 'SyntheticRefreshToken123', nested: { dbPassword: 'x' } }),
      'clientSecret=SyntheticRefreshToken123 next',
      'containerToken: SyntheticRefreshToken123',
    ])
      assert.ok(!redactText(t).includes('SyntheticRefreshToken123'), t)
    assert.ok(!redactText('Cookie: theme=dark; oc_rt=x\nnext line').includes('oc_rt=x'))
    assert.match(redactText('Cookie: a=b\nnext line'), /\nnext line$/)
    for (const keep of [
      'max_tokens: 4096',
      'token_count=12',
      '{"tokensEstimate":5601,"input_tokens":3}',
      'secretLength_ms: 5',
      'cookies enabled: yes',
    ])
      assert.equal(redactText(keep), keep)
  })
  test('the walk has a total node budget', () => {
    const wide = Array.from({ length: 100 }, () => Array.from({ length: 100 }, (_, i) => i))
    const out = JSON.stringify(redact(wide))
    assert.match(out, /<truncated:nodes>/)
    assert.ok(out.length < 60_000)
  })
  test('free text leaves ids, hashes, epoch milliseconds, paths and versions alone', () => {
    const keep = [
      'trace 0a1b2c3d13812345678e9f0a1b2c3d4e', // hex trace id with an 11-digit run inside
      'ts 1761001234567',
      'id deadbeef13812345678', // digit run at the end of a hex id (lookbehind)
      'id 13812345678deadbeef', // digit run at the start of a hex id (lookahead)
      'path /opt/openclaude/releases/rel-756486234-20261020-234642/packages/gateway/src/index.ts',
      'sha 756486234a9a16772949c9ab8e1340130fb7c252',
      'node v20.20.2 load 14.67',
      'task-0123456789abcdef0123',
    ]
    for (const t of keep) assert.equal(redactText(t), t)
  })
  test('errors: message, stack and nested causes are scanned; code and details kept', () => {
    const root = new Error('connect to postgres://u:pw123456@db/x failed for bob@example.com')
    const err = new AppError('UPSTREAM_FAILED', `token=${FAKE_SK}`, {
      cause: root,
      details: { apiKey: 'k', attempt: 2 },
    })
    const out = redact({ err }) as Record<string, any>
    const text = JSON.stringify(out)
    for (const leaked of [FAKE_SK, 'pw123456', 'bob@example.com'])
      assert.ok(!text.includes(leaked), leaked)
    assert.equal(out.err.code, 'UPSTREAM_FAILED')
    assert.equal(out.err.details.apiKey, '<redacted>')
    assert.equal(out.err.details.attempt, 2)
    assert.equal(out.err.cause.name, 'Error')
  })
  test('bounded: cycles, depth, long strings, long arrays, many keys, BigInt, functions', () => {
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    assert.deepEqual(redact(cyc), { a: 1, self: '<cyclic>' })
    const shared = { x: 1 }
    assert.deepEqual(
      redact({ a: shared, b: shared }),
      { a: { x: 1 }, b: { x: 1 } },
      'shared is not a cycle',
    )
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 20; i++) deep = { d: deep }
    assert.match(JSON.stringify(redact(deep)), /<truncated:depth>/)
    assert.match(redact('x'.repeat(10_000)) as string, /…<truncated:10000>$/)
    assert.equal((redact(Array.from({ length: 150 }, (_, i) => i)) as unknown[]).length, 101)
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]))
    assert.equal(Object.keys(redact(many) as object).length, 201)
    assert.deepEqual(redact({ n: 10n, f: () => 1 }), { n: '10', f: '<function>' })
  })
})

describe('errors', () => {
  test('AppError: UPPER_SNAKE code, frozen details, cause; errorCode for any coded error', () => {
    const e = new AppError('SESSION_UNAVAILABLE', 'm', { details: { a: 1 }, cause: new Error('c') })
    assert.equal(e.code, 'SESSION_UNAVAILABLE')
    assert.equal(Object.isFrozen(e.details), true)
    assert.equal((e.cause as Error).message, 'c')
    assert.throws(() => new AppError('bad-code', 'm'), TypeError)
    assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' })), 'ENOENT')
    assert.equal(errorCode('nope'), undefined)
  })
})

describe('log', () => {
  test('one JSON line; reserved ts/level/msg cannot be forged; fields and bindings redacted', () => {
    const { log, json } = capture({ base: { service: 's', token: 't0' } })
    log
      .child({ requestId: 'r1', cookie: 'c' })
      .info(`hi ${FAKE_SK}`, { level: 'error', ts: 'x', msg: 'y', password: 'p', n: 1 })
    assert.deepEqual(json(), [
      {
        service: 's',
        token: '<redacted>',
        requestId: 'r1',
        cookie: '<redacted>',
        password: '<redacted>',
        n: 1,
        ts: 'T',
        level: 'info',
        msg: 'hi <redacted:key>',
      },
    ])
    assert.deepEqual(Object.keys(json()[0]).slice(-3), ['ts', 'level', 'msg'], 'written last')
  })
  test('gateway signature (msg, ctx, err) and commercial (msg, fields) are the same call', () => {
    const { log, json } = capture()
    log.warn(
      'boom',
      { module: 'm' },
      new AppError('X_FAILED', 'at bob@example.com', { cause: new Error('inner') }),
    )
    log.info('plain', { a: 1 })
    const [w, i] = json()
    assert.equal(w.error, 'at <email>')
    assert.equal(w.errorCode, 'X_FAILED')
    assert.equal(w.cause.message, 'inner')
    assert.equal(typeof w.stack, 'string')
    assert.deepEqual(i, { a: 1, ts: 'T', level: 'info', msg: 'plain' })
    log.error('obj', undefined, { reason: 'busy', token: 't' })
    assert.deepEqual(
      json()[2].error,
      { reason: 'busy', token: '<redacted>' },
      'a plain object is kept, redacted',
    )
    log.error('str', undefined, 'just a string')
    assert.equal(json()[3].error, 'just a string')
  })
  test('levels: filtered below the shared ref, changeable at runtime, parse is lenient', () => {
    const level = createLevelRef('warn')
    const { log, lines } = capture({ level })
    const child = log.child({ c: 1 })
    log.info('dropped')
    child.warn('kept')
    level.set('debug')
    child.debug('now kept')
    assert.deepEqual(
      lines.map((l) => l.level),
      ['warn', 'debug'],
    )
    assert.equal(log.isLevelEnabled('trace'), false)
    assert.throws(() => level.set('loud' as never), TypeError)
    assert.equal(parseLogLevel(' WARNING '), 'warn')
    assert.equal(parseLogLevel('nope', 'error'), 'error')
    assert.equal(parseLogLevel(undefined), 'info')
  })
  test('payload policy per logger: commercial-style logger redacts body, gateway-style keeps it', () => {
    const c = capture({ redact: { payload: true } })
    const g = capture()
    c.log.info('m', { body: 'user prompt', status: 1 })
    g.log.info('m', { body: 'diagnostic', status: 1 })
    assert.equal(c.json()[0].body, '<redacted>')
    assert.equal(g.json()[0].body, 'diagnostic')
  })
  test('a throwing sink or context never throws into the caller', () => {
    const log = createLogger({
      sink: () => {
        throw new Error('disk full')
      },
      context: () => {
        throw new Error('ctx')
      },
    })
    assert.doesNotThrow(() => log.error('x', { a: 1 }))
  })
})

describe('trace (kernel/node)', () => {
  test('withTrace nests and merges; the logger adds the current context, explicit fields win', async () => {
    const lines: LogRecord[] = []
    const log = createNodeLogger({ sink: (r) => lines.push(r), now: () => 'T' })
    await withTrace({ traceId: 'a'.repeat(32), sessionKey: 'agent:main:x' }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      await withTrace({ traceId: 'a'.repeat(32), dispatchId: 'd1', attempt: 2 }, async () => {
        assert.equal(currentTrace()?.sessionKey, 'agent:main:x')
        log.info('inside', { attempt: 3 })
      })
    })
    log.info('outside')
    const [a, b] = lines.map((l) => JSON.parse(l.line))
    assert.deepEqual(a, {
      traceId: 'a'.repeat(32),
      dispatchId: 'd1',
      attempt: 3,
      sessionKey: 'agent:main:x',
      ts: 'T',
      level: 'info',
      msg: 'inside',
    })
    assert.deepEqual(b, { ts: 'T', level: 'info', msg: 'outside' })
    assert.equal(currentTrace(), undefined)
  })
})

describe('layering', () => {
  test('the core entry and everything it imports use no node:* (only kernel/node may)', () => {
    const seen = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const text = readFileSync(path.join(SRC, file), 'utf8')
      for (const m of text.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[1]!
        assert.ok(!spec.startsWith('node:'), `${file} imports ${spec}`)
        assert.ok(spec.startsWith('./'), `${file} imports ${spec}: kernel core has no dependencies`)
        visit(spec.replace(/^\.\//, '').replace(/\.js$/, '.ts'))
      }
    }
    visit('index.ts')
    assert.deepEqual([...seen].sort(), ['errors.ts', 'index.ts', 'log.ts', 'redact.ts', 'trace.ts'])
    assert.deepEqual(
      readdirSync(SRC)
        .filter((f) => f.endsWith('.ts'))
        .sort(),
      ['errors.ts', 'index.ts', 'log.ts', 'node.ts', 'redact.ts', 'trace.ts'],
      'a new kernel file must be reachable from index.ts or node.ts and checked here',
    )
  })
})
