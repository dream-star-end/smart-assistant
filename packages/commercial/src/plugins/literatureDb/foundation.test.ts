import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import {
  Agent as HttpAgent,
  type RequestListener,
  type RequestOptions,
  type ServerResponse,
  createServer,
  globalAgent,
  request as httpRequest,
} from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import test, { type TestContext } from 'node:test'
import sharp from 'sharp'
import type { DnsResolver } from '../../connectors/outboundPolicy.js'
import { normalizeHttpsOrigin } from '../../connectors/outboundPolicy.js'
import { type CaptchaImage, type CaptchaReader, LiteratureCaptchaSolver } from './captcha.js'
import {
  openLiteratureCredentials,
  parseLiteratureCredentials,
  parseSerializedLiteratureCredentials,
  sealLiteratureCredentials,
  serializeSealedLiteratureCredentials,
} from './credentials.js'
import { LiteratureError } from './errors.js'
import { type LocalCaptchaReaderOptions, createLocalCaptchaReader } from './localCaptchaReader.js'
import {
  LiteratureLoginManager,
  type LiteratureLoginOptions,
  type LiteratureLoginSession,
  type LoginOutcome,
  type OperationSolverFactory,
} from './login.js'
import { LITERATURE_SITE, literatureUrl, pinLiteratureRequest } from './policy.js'
import {
  LiteratureHttpTransport,
  type LiteratureTransportOptions,
  literatureSocketOptions,
} from './transport.js'

function createManager(solver: LiteratureCaptchaSolver, options?: LiteratureLoginOptions) {
  return new LiteratureLoginManager(() => solver, options)
}
const owner = { userId: 17, accountId: '42' }
const signal = () => new AbortController().signal
const resolver: DnsResolver = { resolve4: async () => ['93.184.216.34'], resolve6: async () => [] }
const env = { OPENCLAUDE_KMS_KEY: Buffer.alloc(32, 19).toString('base64') }
const credentials = {
  schemaVersion: 1,
  username: 'fixture-user',
  password: 'synthetic-fixture-password',
}
function code(expected: string) {
  return (error: unknown) => error instanceof LiteratureError && error.code === expected
}
async function image(): Promise<CaptchaImage> {
  return {
    mediaType: 'image/png',
    data: await sharp({ create: { width: 47, height: 20, channels: 3, background: '#666666' } })
      .png()
      .toBuffer(),
  }
}
function local(recognize: CaptchaReader['recognize'] = async () => '1234'): CaptchaReader {
  return { provider: 'local-ocr', model: 'ddddocr', usageApproved: true, recognize }
}
function cloud(recognize: CaptchaReader['recognize']): CaptchaReader {
  return { provider: 'anthropic', model: 'claude-fixture', usageApproved: true, recognize }
}
function fixture(pic: CaptchaImage, outcomes: LoginOutcome[] = ['authenticated']) {
  const calls = { challenges: 0, submits: [] as string[], closed: 0, persisted: 0, probes: 0 }
  const session: LiteratureLoginSession = {
    challenge: async () => {
      calls.challenges++
      return pic
    },
    submit: async (answer) => {
      calls.submits.push(answer)
      return outcomes.shift() ?? 'captcha_invalid'
    },
    probe: async () => {
      calls.probes++
      return false
    },
    snapshot: async () => ({ privateState: 'fixture-cookie' }),
    close: async () => {
      calls.closed++
    },
  }
  const persist = async (state: unknown) => {
    assert.deepEqual(state, { privateState: 'fixture-cookie' })
    calls.persisted++
  }
  return { session, calls, persist }
}
async function httpFixture(
  handler: RequestListener,
  settings: Pick<LiteratureTransportOptions, 'timeoutMs' | 'maxResponseBytes'> = {},
) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  const options: RequestOptions[] = []
  const sockets: Socket[] = []
  const transport = new LiteratureHttpTransport({
    resolver,
    timeoutMs: 1000,
    ...settings,
    requestFactory: (input, callback) => {
      options.push(input)
      // Only this test adapter changes the socket. Production policy has no allowPrivate flag.
      const request = httpRequest({ ...input, hostname: '127.0.0.1', port: address.port }, callback)
      request.once('socket', (socket) => sockets.push(socket))
      return request
    },
  })
  return {
    transport,
    options,
    sockets,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('HTTP exception is exact-site and does not relax shared HTTPS policy', async () => {
  assert.equal(literatureUrl(`${LITERATURE_SITE}/e/member/login/`).hostname, 'www.jieyoutsg.com')
  assert.equal(literatureUrl('https://www.jieyoutsg.com:443/').port, '')
  assert.throws(() => normalizeHttpsOrigin(LITERATURE_SITE))
  for (const url of [
    'http://jieyoutsg.com/',
    'http://x.jieyoutsg.com/',
    'http://www.jieyoutsg.com.evil.test/',
    'http://www.jieyoutsg.com:8080/',
    'http://user:pass@www.jieyoutsg.com/',
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'ws://www.jieyoutsg.com/',
    'http://www.jieyoutsg.com/#fragment',
    'http://www.jieyoutsg.com/\r\nCookie:injected',
  ]) {
    assert.throws(() => literatureUrl(url), code('OUTBOUND_BLOCKED'))
  }
  await assert.rejects(
    pinLiteratureRequest(LITERATURE_SITE, {
      resolve4: async () => ['93.184.216.34', '127.0.0.1'],
      resolve6: async () => [],
    }),
    code('OUTBOUND_BLOCKED'),
  )
  await assert.rejects(
    pinLiteratureRequest(LITERATURE_SITE, {
      resolve4: async () => ['93.184.216.34'],
      resolve6: async () => ['::1'],
    }),
    code('OUTBOUND_BLOCKED'),
  )
})

test('credential AEAD rejects cross-user/account/seed swaps and omits plaintext', () => {
  const sealed = sealLiteratureCredentials(credentials, owner, env)
  assert.deepEqual(openLiteratureCredentials(sealed, owner, env), credentials)
  assert(!sealed.ciphertext.includes(Buffer.from(credentials.password)))
  assert.notDeepEqual(sealed.nonce, sealLiteratureCredentials(credentials, owner, env).nonce)
  for (const scope of [
    { ...owner, userId: 18 },
    { ...owner, accountId: '43' },
  ])
    assert.throws(() => openLiteratureCredentials(sealed, scope, env), code('SECRET_INVALID'))
  assert.throws(
    () => openLiteratureCredentials({ ...sealed, aadSeed: 'invalid' }, owner, env),
    code('SECRET_INVALID'),
  )
  const corrupt = Buffer.from(sealed.ciphertext)
  corrupt[0] = corrupt[0]! ^ 1
  assert.throws(
    () => openLiteratureCredentials({ ...sealed, ciphertext: corrupt }, owner, env),
    code('SECRET_INVALID'),
  )
  assert.throws(
    () => parseLiteratureCredentials({ ...credentials, cookie: 'no' }),
    code('SECRET_INVALID'),
  )
  assert.throws(
    () => parseLiteratureCredentials({ ...credentials, password: 'secret\r\n' }),
    (error: unknown) => error instanceof Error && error.message === 'SECRET_INVALID',
  )
})

test('multimodal is preferred; only cropped normalized pixels and fixed prompt leave boundary', async () => {
  const log: string[] = []
  const solver = new LiteratureCaptchaSolver([
    local(async () => {
      log.push('local')
      return '9999'
    }),
    cloud(async (input) => {
      log.push('cloud')
      assert.equal(input.maxOutputTokens, 64)
      assert.deepEqual(Object.keys(input).sort(), ['image', 'maxOutputTokens', 'prompt', 'signal'])
      assert.equal(input.image.mediaType, 'image/png')
      return ' 1234 '
    }),
  ])
  assert.equal(
    await solver.solve(await image(), { cloudCalls: 0, maxCloudCalls: 2 }, signal()),
    '1234',
  )
  assert.deepEqual(log, ['cloud'])
})

test('OpenAI/aliases/unapproved routes never invoke a model; local fallback remains available', async () => {
  let cloudCalls = 0
  const forbidden = [
    {
      ...cloud(async () => {
        cloudCalls++
        return '1234'
      }),
      model: 'gpt-5',
    },
    {
      ...cloud(async () => {
        cloudCalls++
        return '1234'
      }),
      usageApproved: false,
    },
    {
      ...cloud(async () => {
        cloudCalls++
        return '1234'
      }),
      provider: 'openai' as CaptchaReader['provider'],
    },
  ]
  const solver = new LiteratureCaptchaSolver([...forbidden, local()])
  assert.equal(
    await solver.solve(await image(), { cloudCalls: 0, maxCloudCalls: 2 }, signal()),
    '1234',
  )
  assert.equal(cloudCalls, 0)
})

test('provider refusal does not rotate cloud providers or disguise purpose', async () => {
  let secondCloud = 0
  const solver = new LiteratureCaptchaSolver([
    cloud(async () => {
      throw new LiteratureError('MODEL_REFUSED')
    }),
    {
      provider: 'google',
      model: 'gemini-fixture',
      usageApproved: true,
      recognize: async () => {
        secondCloud++
        return '0000'
      },
    },
    local(),
  ])
  assert.equal(
    await solver.solve(await image(), { cloudCalls: 0, maxCloudCalls: 2 }, signal()),
    '1234',
  )
  assert.equal(secondCloud, 0)
})

test('model total-call budget, malformed answer and ignored cancellation are bounded', async () => {
  let calls = 0
  const solver = new LiteratureCaptchaSolver([
    cloud(async () => {
      calls++
      return '<script>secret</script>'
    }),
    local(),
  ])
  const budget = { cloudCalls: 0, maxCloudCalls: 2 }
  const pic = await image()
  for (let i = 0; i < 4; i++) assert.equal(await solver.solve(pic, budget, signal()), '1234')
  assert.equal(calls, 2)
  const slow = new LiteratureCaptchaSolver([cloud(() => new Promise(() => {})), local()], 5)
  assert.equal(await slow.solve(pic, { cloudCalls: 0, maxCloudCalls: 1 }, signal()), '1234')
  await assert.rejects(
    solver.solve({ data: Buffer.from('not-an-image'), mediaType: 'image/png' }, budget, signal()),
    code('INVALID_INPUT'),
  )
})

test('successful login persists private state once and closes before reporting success', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  t.after(() => manager.close())
  const f = fixture(await image())
  let release!: () => void
  f.session.close = async () => {
    f.calls.closed++
    await new Promise<void>((resolve) => {
      release = resolve
    })
  }
  const op = manager.start(owner, async () => f.session, f.persist)
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.status(owner.userId, op.operationId).status, 'running')
  assert.equal(f.calls.persisted, 0)
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('ACCOUNT_BUSY'))
  release()
  const done = await manager.settled(owner.userId, op.operationId)
  assert.equal(done.status, 'authenticated')
  assert.equal(f.calls.persisted, 1)
  assert.equal(f.calls.closed, 1)
  assert(!JSON.stringify(done).includes('fixture-cookie'))
})

test('four failed automatic submissions refresh challenges then allow one manual answer', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  t.after(() => manager.close())
  const f = fixture(await image(), [
    'captcha_invalid',
    'captcha_invalid',
    'captcha_invalid',
    'captcha_invalid',
    'authenticated',
  ])
  const op = manager.start(owner, async () => f.session, f.persist)
  const waiting = await manager.settled(owner.userId, op.operationId)
  assert.equal(waiting.status, 'manual_required')
  assert.equal(waiting.automaticSubmissions, 4)
  assert.equal(f.calls.challenges, 5)
  assert.equal(f.calls.closed, 0)
  assert.throws(() => manager.image(18, op.operationId, waiting.challengeId!), code('NOT_FOUND'))
  assert.throws(() => manager.image(17, op.operationId, 'old-challenge'), code('CHALLENGE_STALE'))
  const first = manager.answer(17, op.operationId, waiting.challengeId!, '5678')
  assert.throws(
    () => manager.answer(17, op.operationId, waiting.challengeId!, '5678'),
    code('CHALLENGE_STALE'),
  )
  assert.equal((await first).status, 'authenticated')
  assert.deepEqual(f.calls.submits, ['1234', '1234', '1234', '1234', '5678'])
  assert.equal(f.calls.persisted, 1)
})

test('wrong manual answer terminates and never prompts or submits again', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([]))
  t.after(() => manager.close())
  const f = fixture(await image(), ['captcha_invalid'])
  const op = manager.start(owner, async () => f.session, f.persist)
  const waiting = await manager.settled(17, op.operationId)
  assert.equal(
    (await manager.answer(17, op.operationId, waiting.challengeId!, '1234')).errorCode,
    'LOGIN_FAILED',
  )
  assert.equal(f.calls.submits.length, 1)
  assert.equal(f.calls.closed, 1)
})

for (const outcome of ['credentials_invalid', 'blocked'] as const) {
  test(`${outcome} stops automatic login after one submission`, async (t) => {
    const manager = createManager(new LiteratureCaptchaSolver([local()]))
    t.after(() => manager.close())
    const f = fixture(await image(), [outcome])
    const op = manager.start(owner, async () => f.session, f.persist)
    const done = await manager.settled(17, op.operationId)
    assert.equal(done.status, 'failed')
    assert.equal(f.calls.submits.length, 1)
    assert.equal(f.calls.closed, 1)
    assert.equal(f.calls.persisted, 0)
  })
}

test('unknown POST outcome probes once; never blindly repeats a possibly accepted login', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  t.after(() => manager.close())
  const f = fixture(await image(), ['unknown'])
  const op = manager.start(owner, async () => f.session, f.persist)
  assert.equal((await manager.settled(17, op.operationId)).errorCode, 'SUBMISSION_UNCERTAIN')
  assert.equal(f.calls.submits.length, 1)
  assert.equal(f.calls.probes, 1)
})

test('unknown accepted POST recovers via probe and persists only once', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  t.after(() => manager.close())
  const f = fixture(await image(), ['unknown'])
  f.session.probe = async () => true
  const op = manager.start(owner, async () => f.session, f.persist)
  assert.equal((await manager.settled(17, op.operationId)).status, 'authenticated')
  assert.equal(f.calls.submits.length, 1)
  assert.equal(f.calls.persisted, 1)
})

test('challenge expiry and per-account/global capacity are enforced', async (t) => {
  let clock = 1000
  const manager = createManager(new LiteratureCaptchaSolver([]), {
    capacity: 1,
    now: () => clock,
  })
  t.after(() => manager.close())
  const f = fixture(await image())
  const op = manager.start(owner, async () => f.session, f.persist)
  const waiting = await manager.settled(17, op.operationId)
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('ACCOUNT_BUSY'))
  assert.throws(
    () => manager.start({ ...owner, accountId: '43' }, async () => f.session, f.persist),
    code('CAPACITY'),
  )
  clock = waiting.challengeExpiresAt!
  assert.throws(
    () => manager.answer(17, op.operationId, waiting.challengeId!, '1234'),
    code('CHALLENGE_STALE'),
  )
  assert.equal(f.calls.submits.length, 0)
})

test('cancellation fences a late successful submission and releases only after cleanup', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  t.after(() => manager.close())
  const f = fixture(await image())
  let submit!: (value: LoginOutcome) => void
  f.session.submit = async () =>
    new Promise((resolve) => {
      submit = resolve
    })
  const op = manager.start(owner, async () => f.session, f.persist)
  while (!submit) await new Promise((resolve) => setImmediate(resolve))
  await manager.cancel(17, op.operationId)
  submit('authenticated')
  assert.equal((await manager.settled(17, op.operationId)).status, 'cancelled')
  assert.equal(f.calls.persisted, 0)
  assert.equal(f.calls.closed, 1)
})

test('cancelling a late opener keeps the account occupied until its handle is closed', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  t.after(() => manager.close())
  const f = fixture(await image())
  let opened!: (session: LiteratureLoginSession) => void
  const op = manager.start(
    owner,
    () =>
      new Promise((resolve) => {
        opened = resolve
      }),
    f.persist,
  )
  while (!opened) await new Promise((resolve) => setImmediate(resolve))
  const cancel = manager.cancel(17, op.operationId)
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('ACCOUNT_BUSY'))
  opened(f.session)
  await cancel
  assert.equal(f.calls.closed, 1)
  assert.equal(f.calls.persisted, 0)
})

test('automatic deadline preserves a live session for manual input', async (t) => {
  const pic = await image()
  const solver = new LiteratureCaptchaSolver([cloud(() => new Promise(() => {}))])
  const manager = createManager(solver, { autoBudgetMs: 5 })
  t.after(() => manager.close())
  const f = fixture(pic)
  const op = manager.start(owner, async () => f.session, f.persist)
  const waiting = await manager.settled(17, op.operationId)
  assert.equal(waiting.status, 'manual_required')
  assert.equal(f.calls.closed, 0)
  assert.equal(f.calls.submits.length, 0)
})

test('single-hop HTTP reaches the fixture with the original Host and preserves Set-Cookie arrays', async (t) => {
  const seen: string[] = []
  const f = await httpFixture((req, res) => {
    seen.push(req.headers.host ?? '')
    res.setHeader('Set-Cookie', ['a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'b=2'])
    res.end('fixture-page')
  })
  t.after(f.close)
  const r = await f.transport.request({
    url: `${LITERATURE_SITE}/e/member/login/`,
    signal: signal(),
  })
  assert.equal(r.body.toString(), 'fixture-page')
  assert.equal(f.sockets.length, 1)
  assert(f.sockets.every((socket) => socket.closed))
  assert.equal(r.headers['set-cookie']?.length, 2)
  assert.deepEqual(seen, ['www.jieyoutsg.com'])
  assert.equal(f.options[0]!.hostname, '93.184.216.34')
  assert(f.options[0]!.agent instanceof HttpAgent)
  assert.notEqual(f.options[0]!.agent, globalAgent)
  assert.equal(Reflect.get(f.options[0]!.agent, 'keepAlive'), false)
  const tls = literatureSocketOptions(
    literatureUrl('https://www.jieyoutsg.com/'),
    { ip: '93.184.216.34', family: 4 },
    'GET',
  )
  assert.equal(tls.servername, 'www.jieyoutsg.com')
  assert.equal(tls.rejectUnauthorized, true)
})

test('POST redirects are returned without replay and unsafe redirects are rejected', async (t) => {
  let received = 0
  const f = await httpFixture((req, res) => {
    received++
    req.resume()
    res.writeHead(307, { Location: '/next' })
    res.end()
  })
  t.after(f.close)
  const r = await f.transport.request({
    url: `${LITERATURE_SITE}/e/member/doaction.php`,
    method: 'POST',
    body: Buffer.from('username=synthetic&password=fixture'),
    signal: signal(),
  })
  assert.equal(r.redirect, `${LITERATURE_SITE}/next`)
  assert.equal(received, 1)
  const evil = await httpFixture((_req, res) => {
    res.writeHead(302, { Location: '//evil.test/' })
    res.end()
  })
  t.after(evil.close)
  await assert.rejects(
    evil.transport.request({ url: LITERATURE_SITE, signal: signal() }),
    code('OUTBOUND_BLOCKED'),
  )
  assert.equal(evil.sockets.length, 1)
  assert(evil.sockets.every((socket) => socket.closed))
})

test('transport rejects header injection and fails truncated or oversized bodies', async (t) => {
  const f = await httpFixture((_req, res) => {
    res.writeHead(200, { 'Content-Length': 100 })
    res.end('short')
  })
  t.after(f.close)
  await assert.rejects(
    f.transport.request({ url: LITERATURE_SITE, cookie: 'a=1\r\nInjected:true', signal: signal() }),
    code('INVALID_INPUT'),
  )
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(
    f.transport.request({
      url: LITERATURE_SITE,
      cookie: 'a=1\r\nInjected:true',
      signal: stopped.signal,
    }),
    code('INVALID_INPUT'),
  )
  assert.equal(f.options.length, 0)
  // A mismatched length response must not be accepted as a page.
  await assert.rejects(f.transport.request({ url: LITERATURE_SITE, signal: signal() }))
  assert.equal(f.sockets.length, 1)
  assert(f.sockets.every((socket) => socket.closed))
  const large = await httpFixture((_req, res) => {
    res.end(Buffer.alloc(1024 * 1024 + 1))
  })
  t.after(large.close)
  await assert.rejects(
    large.transport.request({ url: LITERATURE_SITE, signal: signal() }),
    code('RESPONSE_TOO_LARGE'),
  )
  assert.equal(large.sockets.length, 1)
  assert(large.sockets.every((socket) => socket.closed))
})

test('class-based inference adapters retain their method and receiver', async () => {
  class Reader implements CaptchaReader {
    provider = 'google' as const
    model = 'gemini-fixture'
    usageApproved = true
    calls = 0
    async recognize() {
      this.calls++
      return '1234'
    }
  }
  const reader = new Reader()
  assert.equal(
    await new LiteratureCaptchaSolver([reader]).solve(
      await image(),
      { cloudCalls: 0, maxCloudCalls: 1 },
      signal(),
    ),
    '1234',
  )
  assert.equal(reader.calls, 1)
})

test('cloud refusal is latched across every challenge in one login budget', async () => {
  let calls = 0
  const solver = new LiteratureCaptchaSolver([
    cloud(async () => {
      calls++
      throw new LiteratureError('MODEL_REFUSED')
    }),
    local(),
  ])
  const budget = { cloudCalls: 0, maxCloudCalls: 4 }
  const pic = await image()
  for (let i = 0; i < 4; i++) assert.equal(await solver.solve(pic, budget, signal()), '1234')
  assert.equal(calls, 1)
})

test('shutdown waits for cleanup which cancellation has already begun', async () => {
  const manager = createManager(new LiteratureCaptchaSolver([]))
  const f = fixture(await image())
  let release!: () => void
  f.session.close = async () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  const op = manager.start(owner, async () => f.session, f.persist)
  await manager.settled(17, op.operationId)
  const cancel = manager.cancel(17, op.operationId)
  let closed = false
  const closing = manager.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closed, false)
  release()
  await cancel
  await closing
  assert.equal(closed, true)
})

test('failed cleanup preserves account and capacity fencing and makes shutdown fail visibly', async () => {
  const manager = createManager(new LiteratureCaptchaSolver([]), { capacity: 1 })
  const f = fixture(await image())
  f.session.close = async () => {
    throw new Error('synthetic-private-worker-details')
  }
  const op = manager.start(owner, async () => f.session, f.persist)
  await manager.settled(17, op.operationId)
  assert.equal((await manager.cancel(17, op.operationId)).errorCode, 'CLEANUP_FAILED')
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('ACCOUNT_BUSY'))
  assert.throws(
    () => manager.start({ ...owner, accountId: '43' }, async () => f.session, f.persist),
    code('CAPACITY'),
  )
  await assert.rejects(manager.close(), code('CLEANUP_FAILED'))
  assert(!JSON.stringify(manager.status(17, op.operationId)).includes('synthetic-private'))
})

test('manual challenge never extends the absolute operation lifetime', async (t) => {
  let clock = 1000
  const manager = createManager(new LiteratureCaptchaSolver([]), {
    now: () => clock,
    operationTtlMs: 60000,
    manualTtlMs: 120000,
  })
  t.after(() => manager.close())
  const f = fixture(await image())
  const op = manager.start(owner, async () => f.session, f.persist)
  const waiting = await manager.settled(17, op.operationId)
  assert.equal(waiting.challengeExpiresAt, 61000)
  clock = 61001
  assert.throws(
    () => manager.answer(17, op.operationId, waiting.challengeId!, '1234'),
    code('CHALLENGE_STALE'),
  )
})

test('per-account hourly admission limits survive completed operations', async (t) => {
  let clock = 1000
  const manager = createManager(new LiteratureCaptchaSolver([local()]), {
    maxStartsPerHour: 2,
    now: () => clock,
  })
  t.after(() => manager.close())
  const pic = await image()
  for (let i = 0; i < 2; i++) {
    const f = fixture(pic)
    const op = manager.start(owner, async () => f.session, f.persist)
    assert.equal((await manager.settled(17, op.operationId)).status, 'authenticated')
  }
  const f = fixture(pic)
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('RATE_LIMITED'))
  clock += 3_600_001
  const next = manager.start(owner, async () => f.session, f.persist)
  assert.equal((await manager.settled(17, next.operationId)).status, 'authenticated')
})

test('pre-cancelled recognition consumes the already-started image rejection', async () => {
  const controller = new AbortController()
  controller.abort()
  const solver = new LiteratureCaptchaSolver([local()])
  await assert.rejects(
    solver.solve(
      { data: Buffer.from('bad image'), mediaType: 'image/png' },
      { cloudCalls: 0, maxCloudCalls: 0 },
      controller.signal,
    ),
    code('CANCELLED'),
  )
  // Node's test runner reports an orphan rejection on the next turn as a failure.
  await new Promise((resolve) => setImmediate(resolve))
})

test('a late opener with failed cleanup retains its account fence and fails shutdown', async () => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  const f = fixture(await image())
  let opened!: (session: LiteratureLoginSession) => void
  f.session.close = async () => {
    throw new Error('fixture-private-close-error')
  }
  const op = manager.start(
    owner,
    () =>
      new Promise((resolve) => {
        opened = resolve
      }),
    f.persist,
  )
  while (!opened) await new Promise((resolve) => setImmediate(resolve))
  const cancel = manager.cancel(17, op.operationId)
  opened(f.session)
  assert.equal((await cancel).errorCode, 'CLEANUP_FAILED')
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('ACCOUNT_BUSY'))
  await assert.rejects(manager.close(), code('CLEANUP_FAILED'))
  assert.equal(f.calls.persisted, 0)
})

test('first setup has its own tenant identity and passes no fictional account ID to persistence', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  t.after(() => manager.close())
  const pending = { userId: 17, kind: 'setup' as const, site: LITERATURE_SITE }
  const f = fixture(await image())
  let persisted = false
  const op = manager.start(
    pending,
    async () => f.session,
    async (_state, context) => {
      assert.equal(context.kind, 'setup')
      assert.equal(context.userId, 17)
      assert(!('accountId' in context))
      assert.equal(context.operationId, op.operationId)
      assert(context.isCurrent())
      persisted = true
    },
  )
  assert.throws(() => manager.status(18, op.operationId), code('NOT_FOUND'))
  assert.equal((await manager.settled(17, op.operationId)).status, 'authenticated')
  assert(persisted)
})

test('pending setup capacity and start quotas aggregate by tenant and site', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]), {
    maxStartsPerHour: 1,
  })
  t.after(() => manager.close())
  const pending = { userId: 17, kind: 'setup' as const, site: LITERATURE_SITE }
  const f = fixture(await image())
  const op = manager.start(pending, async () => f.session, f.persist)
  assert.throws(
    () => manager.start({ ...pending }, async () => f.session, f.persist),
    code('ACCOUNT_BUSY'),
  )
  const existing = fixture(await image())
  const parallel = manager.start(owner, async () => existing.session, existing.persist)
  assert.equal((await manager.settled(17, op.operationId)).status, 'authenticated')
  assert.equal((await manager.settled(17, parallel.operationId)).status, 'authenticated')
  assert.throws(
    () => manager.start({ ...pending }, async () => f.session, f.persist),
    code('RATE_LIMITED'),
  )
  const other = fixture(await image())
  const otherOp = manager.start(
    { ...pending, userId: 18 },
    async () => other.session,
    other.persist,
  )
  assert.equal((await manager.settled(18, otherOp.operationId)).status, 'authenticated')
})

test('setup owner cannot forge an account or choose another site or rate bucket', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  t.after(() => manager.close())
  const f = fixture(await image())
  for (const invalid of [
    { userId: 17, kind: 'setup', site: LITERATURE_SITE, accountId: '42' },
    { userId: 17, kind: 'setup', site: 'http://jieyoutsg.com' },
    { userId: 17, kind: 'setup', site: LITERATURE_SITE, setupId: 'arbitrary' },
    { userId: 17, accountId: '0' },
    { userId: 17, accountId: '42', kind: 'unknown' },
  ])
    assert.throws(
      () => manager.start(invalid as never, async () => f.session, f.persist),
      code('INVALID_INPUT'),
    )
  assert.equal(f.calls.challenges, 0)
})

test('solver factories receive immutable tenant and actual operation identity once per run', async (t) => {
  const contexts: Parameters<OperationSolverFactory>[0][] = []
  const manager = new LiteratureLoginManager((context) => {
    contexts.push(context)
    assert(Object.isFrozen(context))
    assert(Object.isFrozen(context.owner))
    assert.equal(Reflect.set(context.owner, 'userId', 999), false)
    return new LiteratureCaptchaSolver([
      local(async () => {
        await new Promise((resolve) => setImmediate(resolve))
        return '1234'
      }),
    ])
  })
  t.after(() => manager.close())
  const pic = await image()
  const a = fixture(pic)
  const b = fixture(pic)
  const first = manager.start(owner, async () => a.session, a.persist)
  const second = manager.start({ ...owner, userId: 18 }, async () => b.session, b.persist)
  assert.equal((await manager.settled(17, first.operationId)).status, 'authenticated')
  assert.equal((await manager.settled(18, second.operationId)).status, 'authenticated')
  assert.deepEqual(
    contexts.map((c) => [c.owner.userId, c.operationId]),
    [
      [17, first.operationId],
      [18, second.operationId],
    ],
  )
})

test('automatic retries reuse one operation solver and identity', async (t) => {
  let factories = 0
  const manager = new LiteratureLoginManager(() => {
    factories++
    return new LiteratureCaptchaSolver([local()])
  })
  t.after(() => manager.close())
  const f = fixture(await image(), ['captcha_invalid', 'authenticated'])
  const op = manager.start(owner, async () => f.session, f.persist)
  assert.equal((await manager.settled(17, op.operationId)).status, 'authenticated')
  assert.equal(factories, 1)
  assert.equal(f.calls.submits.length, 2)
})

test('busy, cancelled and rate-limited operations do not construct tenant readers', async (t) => {
  let factories = 0
  let opened = 0
  const manager = new LiteratureLoginManager(
    () => {
      factories++
      return new LiteratureCaptchaSolver([local()])
    },
    { maxStartsPerHour: 1 },
  )
  t.after(() => manager.close())
  const f = fixture(await image())
  const open = async () => {
    opened++
    return f.session
  }
  const op = manager.start(owner, open, f.persist)
  assert.throws(() => manager.start(owner, open, f.persist), code('ACCOUNT_BUSY'))
  await manager.cancel(17, op.operationId)
  assert.equal((await manager.settled(17, op.operationId)).status, 'cancelled')
  assert.throws(() => manager.start(owner, open, f.persist), code('RATE_LIMITED'))
  assert.equal(factories, 0)
  assert.equal(opened, 0)
})

test('solver factory failure releases capacity without opening a private session', async (t) => {
  let factories = 0
  let opened = 0
  const manager = new LiteratureLoginManager(
    () => {
      if (++factories === 1) throw new Error('synthetic factory failure')
      return new LiteratureCaptchaSolver([local()])
    },
    { capacity: 1 },
  )
  t.after(() => manager.close())
  const f = fixture(await image())
  const open = async () => {
    opened++
    return f.session
  }
  const failed = manager.start(owner, open, f.persist)
  assert.equal((await manager.settled(17, failed.operationId)).status, 'failed')
  assert.equal(opened, 0)
  const next = manager.start({ ...owner, accountId: '43' }, open, f.persist)
  assert.equal((await manager.settled(17, next.operationId)).status, 'authenticated')
  assert.equal(opened, 1)
})

test('absolute expiry before the factory microtask opens no reader or session', async (t) => {
  let now = 1000
  let factories = 0
  let opened = 0
  const manager = new LiteratureLoginManager(
    () => {
      factories++
      return new LiteratureCaptchaSolver([local()])
    },
    { now: () => now, operationTtlMs: 1000 },
  )
  t.after(() => manager.close())
  const f = fixture(await image())
  const op = manager.start(
    owner,
    async () => {
      opened++
      return f.session
    },
    f.persist,
  )
  now = 2001
  assert.equal((await manager.settled(17, op.operationId)).status, 'expired')
  assert.equal(factories, 0)
  assert.equal(opened, 0)
})

test('stored password seals require canonical bounded base64 and reject accessors or extra fields', () => {
  const seal = serializeSealedLiteratureCredentials({
    schemaVersion: 1,
    aadSeed: '00000000-0000-4000-8000-000000000001',
    ciphertext: Buffer.alloc(64, 7),
    nonce: Buffer.alloc(12, 2),
  })
  assert.deepEqual(parseSerializedLiteratureCredentials(seal), seal)
  let accessorRead = false
  const accessor = { ...seal }
  Object.defineProperty(accessor, 'ciphertext', {
    enumerable: true,
    get: () => {
      accessorRead = true
      return seal.ciphertext
    },
  })
  for (const invalid of [
    { ...seal, extra: true },
    { ...seal, schemaVersion: 2 },
    { ...seal, aadSeed: '00000000-0000-1000-8000-000000000001' },
    { ...seal, nonce: Buffer.alloc(11).toString('base64') },
    { ...seal, ciphertext: Buffer.alloc(16).toString('base64') },
    { ...seal, ciphertext: Buffer.alloc(8193).toString('base64') },
    { ...seal, ciphertext: `${seal.ciphertext}\n` },
    { ...seal, ciphertext: seal.ciphertext.replace(/=+$/, '') },
    Object.assign(Object.create(null), seal),
    accessor,
  ])
    assert.throws(() => parseSerializedLiteratureCredentials(invalid), code('SECRET_INVALID'))
  assert.equal(accessorRead, false)
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('cancellation during authenticated session drain never starts persistence', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  const f = fixture(await image())
  const closing = deferred()
  f.session.close = async () => {
    f.calls.closed++
    await closing.promise
  }
  t.after(async () => {
    closing.resolve()
    await manager.close()
  })
  const op = manager.start(owner, async () => f.session, f.persist)
  while (!f.calls.closed) await new Promise((resolve) => setImmediate(resolve))
  let cancelled = false
  const cancel = manager.cancel(owner.userId, op.operationId).then((view) => {
    cancelled = true
    return view
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancelled, false)
  assert.equal(f.calls.persisted, 0)
  closing.resolve()
  assert.equal((await cancel).status, 'cancelled')
  await manager.settled(owner.userId, op.operationId)
  assert.equal(f.calls.persisted, 0)
  assert.equal(f.calls.closed, 1)
})

test('absolute expiry reached during session drain prevents the save phase', async (t) => {
  let now = 1000
  const manager = createManager(new LiteratureCaptchaSolver([local()]), {
    now: () => now,
    operationTtlMs: 60_000,
  })
  const f = fixture(await image())
  const closing = deferred()
  f.session.close = async () => {
    f.calls.closed++
    await closing.promise
  }
  t.after(async () => {
    closing.resolve()
    await manager.close()
  })
  const op = manager.start(owner, async () => f.session, f.persist)
  while (!f.calls.closed) await new Promise((resolve) => setImmediate(resolve))
  now = 61_001
  closing.resolve()
  assert.equal((await manager.settled(owner.userId, op.operationId)).status, 'expired')
  assert.equal(f.calls.persisted, 0)
  assert.equal(f.calls.closed, 1)
})

test('authenticated cleanup failure holds capacity and never stores an account', async () => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]), { capacity: 1 })
  const f = fixture(await image())
  f.session.close = async () => {
    f.calls.closed++
    throw new Error('synthetic private close detail')
  }
  const op = manager.start(owner, async () => f.session, f.persist)
  assert.equal((await manager.settled(owner.userId, op.operationId)).errorCode, 'CLEANUP_FAILED')
  assert.equal(f.calls.persisted, 0)
  assert.equal(f.calls.closed, 1)
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('ACCOUNT_BUSY'))
  await assert.rejects(manager.close(), code('CLEANUP_FAILED'))
})

test('cancel and shutdown wait for an entered save and return its authenticated outcome', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]), { capacity: 1 })
  const f = fixture(await image())
  const begun = deferred()
  const saved = deferred()
  let saveSignal!: AbortSignal
  t.after(async () => {
    saved.resolve()
    await manager.close()
  })
  const op = manager.start(
    owner,
    async () => f.session,
    async (state, context) => {
      saveSignal = context.signal
      begun.resolve()
      await saved.promise
      await f.persist(state)
    },
  )
  await begun.promise
  assert.equal(f.calls.closed, 1)
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('ACCOUNT_BUSY'))
  assert.throws(
    () => manager.start({ ...owner, accountId: '43' }, async () => f.session, f.persist),
    code('CAPACITY'),
  )
  let cancelled = false
  let shutdown = false
  const cancel = manager.cancel(owner.userId, op.operationId).then((view) => {
    cancelled = true
    return view
  })
  const close = manager.close().then(() => {
    shutdown = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancelled, false)
  assert.equal(shutdown, false)
  assert.equal(saveSignal.aborted, false)
  assert.equal(manager.status(owner.userId, op.operationId).status, 'running')
  saved.resolve()
  assert.equal((await cancel).status, 'authenticated')
  await close
  assert.equal(f.calls.persisted, 1)
  assert.equal(f.calls.closed, 1)
})

test('operation expiry cannot abort an entered save or release its owner early', async (t) => {
  const f = fixture(await image())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const manager = createManager(new LiteratureCaptchaSolver([local()]), { operationTtlMs: 60_000 })
  const begun = deferred()
  const saved = deferred()
  let saveSignal!: AbortSignal
  t.after(async () => {
    saved.resolve()
    await manager.close()
  })
  const op = manager.start(
    owner,
    async () => f.session,
    async (state, context) => {
      saveSignal = context.signal
      begun.resolve()
      await saved.promise
      await f.persist(state)
    },
  )
  await begun.promise
  t.mock.timers.tick(60_001)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.status(owner.userId, op.operationId).status, 'running')
  assert.equal(saveSignal.aborted, false)
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('ACCOUNT_BUSY'))
  saved.resolve()
  assert.equal((await manager.settled(owner.userId, op.operationId)).status, 'authenticated')
  assert.equal(f.calls.persisted, 1)
  assert.equal(f.calls.closed, 1)
})

test('a save error after a possible commit is reported as uncertain instead of cancelled', async (t) => {
  const manager = createManager(new LiteratureCaptchaSolver([local()]))
  const f = fixture(await image())
  const begun = deferred()
  const acknowledged = deferred()
  t.after(async () => {
    acknowledged.resolve()
    await manager.close()
  })
  const op = manager.start(
    owner,
    async () => f.session,
    async (state) => {
      await f.persist(state)
      begun.resolve()
      await acknowledged.promise
      throw new Error('synthetic private database confirmation detail')
    },
  )
  await begun.promise
  let cancelled = false
  const cancel = manager.cancel(owner.userId, op.operationId).then((view) => {
    cancelled = true
    return view
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancelled, false)
  acknowledged.resolve()
  const result = await cancel
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'PERSISTENCE_UNCERTAIN')
  assert.equal(f.calls.persisted, 1)
  assert.equal(f.calls.closed, 1)
  assert(!JSON.stringify(result).includes('synthetic private'))
})

// A native chunked response; the producer also honours backpressure and client destruction.
function streamFixtureBody(response: ServerResponse, size: number) {
  const chunk = Buffer.alloc(64 * 1024, 0x61)
  let remaining = size
  const push = () => {
    while (remaining > 0 && !response.destroyed) {
      const part = chunk.subarray(0, Math.min(chunk.length, remaining))
      remaining -= part.length
      if (!response.write(part)) {
        response.once('drain', push)
        return
      }
    }
    if (!response.destroyed) response.end()
  }
  push()
}
function countingSink(options: { emitClose?: boolean } = {}) {
  let bytes = 0
  let writes = 0
  const sink = new Writable({
    ...options,
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      writes++
      callback()
    },
  })
  return { sink, bytes: () => bytes, writes: () => writes }
}
function streamGate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const immediate = () => new Promise<void>((resolve) => setImmediate(resolve))

test('streaming transfers 12MiB and the exact 25MiB boundary to closed private files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ocv5-524-stream-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const mib of [12, 25]) {
    const size = mib * 1024 * 1024
    const f = await httpFixture((_req, res) => streamFixtureBody(res, size), { timeoutMs: 5000 })
    t.after(f.close)
    const path = join(directory, `${mib}.partial`)
    const sink = createWriteStream(path, { flags: 'wx', mode: 0o600 })
    const r = await f.transport.requestToSink({ url: LITERATURE_SITE, signal: signal() }, sink)
    assert.equal(r.status, 200)
    assert.equal(r.bytes, size)
    assert.equal('body' in r, false)
    assert.equal(sink.closed, true)
    assert.equal(Reflect.get(sink, 'fd'), null)
    const file = await stat(path)
    assert.equal(file.size, size)
    assert.equal(file.mode & 0o777, 0o600)
    assert.equal(f.options.length, 1)
    assert(f.sockets.every((socket) => socket.closed))
  }
})

test('streaming enforces declared and actual chunked 25MiB limits before forwarding excess bytes', async (t) => {
  const maximum = 25 * 1024 * 1024
  for (const declared of [false, true]) {
    const f = await httpFixture(
      (_req, res) => {
        if (declared) {
          res.writeHead(200, { 'content-length': maximum + 1 })
          res.end('short')
        } else streamFixtureBody(res, maximum + 1)
      },
      { timeoutMs: 5000 },
    )
    t.after(f.close)
    const target = countingSink()
    await assert.rejects(
      f.transport.requestToSink({ url: LITERATURE_SITE, signal: signal() }, target.sink),
      code('RESPONSE_TOO_LARGE'),
    )
    assert(target.bytes() <= maximum)
    if (declared) assert.equal(target.bytes(), 0)
    else assert(target.bytes() > 0)
    assert.equal(target.sink.closed, true)
    assert(f.sockets.every((socket) => socket.closed))
  }
})

test('streaming does not raise the existing 8MiB buffer ceiling', async (t) => {
  const f = await httpFixture((_req, res) => streamFixtureBody(res, 12 * 1024 * 1024), {
    maxResponseBytes: 8 * 1024 * 1024,
    timeoutMs: 5000,
  })
  t.after(f.close)
  await assert.rejects(
    f.transport.request({ url: LITERATURE_SITE, signal: signal() }),
    code('RESPONSE_TOO_LARGE'),
  )
  assert(f.sockets.every((socket) => socket.closed))
})

test('a stalled Writable backpressures streaming instead of queueing the entire response', async (t) => {
  const size = 12 * 1024 * 1024
  const f = await httpFixture((_req, res) => streamFixtureBody(res, size), { timeoutMs: 5000 })
  t.after(f.close)
  const entered = streamGate()
  let first!: (error?: Error | null) => void
  let writes = 0
  let bytes = 0
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      writes++
      if (writes === 1) {
        first = callback
        entered.release()
      } else callback()
    },
  })
  let settled = false
  const reading = f.transport.requestToSink({ url: LITERATURE_SITE, signal: signal() }, sink)
  void reading.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await entered.promise
  try {
    for (let i = 0; i < 12; i++) await immediate()
    assert.equal(writes, 1)
    assert(sink.writableLength <= 128 * 1024)
    assert.equal(settled, false)
  } finally {
    first()
  }
  assert.equal((await reading).bytes, size)
  assert.equal(bytes, size)
  assert.equal(sink.closed, true)
  assert(f.sockets.every((socket) => socket.closed))
})

test('stream cancellation waits for in-flight sink I/O destruction and physical socket close', async (t) => {
  const f = await httpFixture((_req, res) => res.write('partial'))
  t.after(f.close)
  const entered = streamGate()
  const destroying = streamGate()
  let finishWrite!: (error?: Error | null) => void
  let finishDestroy!: (error?: Error | null) => void
  let writes = 0
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      writes++
      finishWrite = callback
      entered.release()
    },
    destroy(_error, callback) {
      // Like native file streams, this trusted sink drains its pending I/O before close.
      finishDestroy = callback
      destroying.release()
    },
  })
  const abort = new AbortController()
  let settled = false
  const reading = f.transport.requestToSink({ url: LITERATURE_SITE, signal: abort.signal }, sink)
  void reading.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await entered.promise
  abort.abort()
  await destroying.promise
  try {
    assert.equal(settled, false)
  } finally {
    finishWrite()
    finishDestroy()
  }
  await assert.rejects(reading, code('CANCELLED'))
  assert.equal(sink.closed, true)
  assert(f.sockets.every((socket) => socket.closed))
  await immediate()
  assert.equal(writes, 1)
})

test('stream deadlines include stalled bodies and never replay a timed-out POST', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const method of ['GET', 'POST'] as const) {
    let requests = 0
    const f = await httpFixture(
      (req, res) => {
        requests++
        req.resume()
        res.write('partial')
      },
      { timeoutMs: 30 },
    )
    t.after(f.close)
    const entered = streamGate()
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        entered.release()
        callback()
      },
    })
    const reading = f.transport.requestToSink(
      {
        url: LITERATURE_SITE,
        method,
        ...(method === 'POST' ? { body: Buffer.from('password=synthetic') } : {}),
        signal: signal(),
      },
      sink,
    )
    const rejected = assert.rejects(
      reading,
      code(method === 'POST' ? 'SUBMISSION_UNCERTAIN' : 'TIMEOUT'),
    )
    await entered.promise
    t.mock.timers.tick(30)
    await rejected
    assert.equal(requests, 1)
    assert.equal(sink.closed, true)
    assert(f.sockets.every((socket) => socket.closed))
  }
})

test('sink failure during DNS cancels the hop and consumes a late DNS answer', async () => {
  const resolving = streamGate()
  let answer!: (value: string[]) => void
  let requests = 0
  const transport = new LiteratureHttpTransport({
    resolver: {
      resolve4: () => {
        resolving.release()
        return new Promise((resolve) => {
          answer = resolve
        })
      },
      resolve6: async () => [],
    },
    requestFactory: () => {
      requests++
      throw new Error('must not connect')
    },
  })
  const target = countingSink()
  const reading = transport.requestToSink({ url: LITERATURE_SITE, signal: signal() }, target.sink)
  const rejected = assert.rejects(reading, code('RESPONSE_INVALID'))
  await resolving.promise
  target.sink.destroy(new Error('ENOSPC /synthetic/private/password'))
  await rejected
  answer(['93.184.216.34'])
  await immediate()
  assert.equal(requests, 0)
  assert.equal(target.sink.closed, true)
})

test('sink write failure and truncated responses close both sides with sanitised errors', async (t) => {
  for (const failure of ['disk', 'upstream']) {
    const f = await httpFixture((_req, res) => {
      if (failure === 'upstream') {
        res.writeHead(200, { 'content-length': 100 })
        res.end('short')
      } else res.end('synthetic-body')
    })
    t.after(f.close)
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback(failure === 'disk' ? new Error('ENOSPC /private/synthetic-secret') : undefined)
      },
    })
    await assert.rejects(
      f.transport.requestToSink(
        { url: LITERATURE_SITE, cookie: 'session=synthetic', signal: signal() },
        sink,
      ),
      (error: unknown) => error instanceof LiteratureError && error.message === 'RESPONSE_INVALID',
    )
    assert.equal(sink.closed, true)
    assert(f.sockets.every((socket) => socket.closed))
  }
})

test('streaming owns sink cleanup even before a valid request can start', async () => {
  let requests = 0
  const transport = new LiteratureHttpTransport({
    resolver,
    requestFactory: () => {
      requests++
      throw new Error('must not connect')
    },
  })
  const abort = new AbortController()
  abort.abort()
  for (const { input, expected } of [
    { input: { url: LITERATURE_SITE, signal: abort.signal }, expected: 'CANCELLED' },
    {
      input: { url: LITERATURE_SITE, cookie: 'bad\r\nheader', signal: signal() },
      expected: 'INVALID_INPUT',
    },
    { input: { url: 'http://evil.test/', signal: signal() }, expected: 'OUTBOUND_BLOCKED' },
    {
      input: { url: LITERATURE_SITE, cookie: 'bad\r\nheader', signal: abort.signal },
      expected: 'INVALID_INPUT',
    },
  ]) {
    const target = countingSink({ emitClose: false })
    await assert.rejects(transport.requestToSink(input, target.sink), code(expected))
    assert.equal(target.sink.closed, true)
    assert.equal(target.bytes(), 0)
  }
  assert.equal(requests, 0)
})

test('stream results preserve status without asserting PDF validity or following redirects', async (t) => {
  for (const kind of ['html', 'redirect', 'unsafe']) {
    let requests = 0
    const f = await httpFixture((req, res) => {
      requests++
      req.resume()
      res.writeHead(kind === 'html' ? 200 : 307, {
        ...(kind === 'html'
          ? { 'content-type': 'text/html' }
          : { location: kind === 'unsafe' ? '//evil.test/' : '/next' }),
      })
      res.end('<html>synthetic login page</html>')
    })
    t.after(f.close)
    const target = countingSink({ emitClose: false })
    const reading = f.transport.requestToSink(
      {
        url: LITERATURE_SITE,
        method: 'POST',
        body: Buffer.from('password=synthetic'),
        signal: signal(),
      },
      target.sink,
    )
    if (kind === 'unsafe') {
      await assert.rejects(reading, code('OUTBOUND_BLOCKED'))
      assert.equal(target.bytes(), 0)
    } else {
      const result = await reading
      assert.equal(result.status, kind === 'html' ? 200 : 307)
      assert.equal(result.bytes, target.bytes())
      assert.equal(result.redirect, kind === 'redirect' ? `${LITERATURE_SITE}/next` : undefined)
      assert.equal('artifactId' in result, false)
    }
    assert.equal(requests, 1)
    assert.equal(target.sink.closed, true)
    assert(f.sockets.every((socket) => socket.closed))
  }
})

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
function localProcessFixture(t: TestContext, source: string) {
  const ready = latch()
  let child: ChildProcess | undefined
  let closed = false
  let closePromise: Promise<void> | undefined
  const spawnProcess: NonNullable<LocalCaptchaReaderOptions['spawnProcess']> = (
    file,
    args,
    options,
  ) => {
    assert.equal(file, '/task-ocr-bundle/venv/bin/python')
    assert.deepEqual(args, ['-I', '-B', '/task-ocr-bundle/runner.py'])
    assert.deepEqual(Object.keys(options.env ?? {}).sort(), [
      'LANG',
      'MKL_NUM_THREADS',
      'OMP_NUM_THREADS',
      'OPENBLAS_NUM_THREADS',
      'PATH',
    ])
    assert.equal(options.shell, false)
    assert.equal(options.detached, true)
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore'])
    child = spawn(process.execPath, ['-e', source], options)
    closePromise = new Promise((resolve) =>
      child!.once('close', () => {
        closed = true
        resolve()
      }),
    )
    child.stdout!.once('data', () => ready.release())
    return child
  }
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closePromise
  })
  return { spawnProcess, ready: ready.promise, child: () => child!, closed: () => closed }
}
const fixturePixels = `
const input = [];
process.stdin.on('data', b => input.push(b));
process.stdin.on('end', () => {
  const png = Buffer.concat(input);
  if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) process.exit(2);
  if (process.env.G524_SYNTHETIC_SECRET) process.exit(3);
  BODY
});`
function workerSource(body: string) {
  return fixturePixels.replace('BODY', body)
}

test('local OCR success waits for physical close and preserves the shared worker slot', async (t) => {
  const f = localProcessFixture(
    t,
    workerSource(`
    process.on('SIGUSR2', () => process.exit(0));
    setInterval(() => {}, 1000);
    process.stderr.write('synthetic private diagnostic');
    process.stdout.write(JSON.stringify({v:1,answer:'AB12'}));
  `),
  )
  const reader = createLocalCaptchaReader({
    bundleRoot: '/task-ocr-bundle',
    spawnProcess: f.spawnProcess,
  })
  const pic = await image()
  let completed = false
  const result = reader
    .recognize({ image: pic, prompt: 'fixed', maxOutputTokens: 64, signal: signal() })
    .then((answer) => {
      completed = true
      return answer
    })
  await f.ready
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false)
  assert.equal(f.closed(), false)
  const other = createLocalCaptchaReader({
    bundleRoot: '/task-ocr-bundle',
    spawnProcess: f.spawnProcess,
  })
  await assert.rejects(
    other.recognize({ image: pic, prompt: 'fixed', maxOutputTokens: 64, signal: signal() }),
    code('CAPACITY'),
  )
  f.child().kill('SIGUSR2')
  assert.equal(await result, 'AB12')
  assert.equal(f.closed(), true)
})

test('local OCR rejects malformed or oversized private output and failed spawn without leaking it', async (t) => {
  const pic = await image()
  for (const output of [
    'private-invalid-output',
    '{"v":1,"answer":"1234","extra":true}',
    '{"v":1,"answer":" 12 "}',
    'x'.repeat(257),
  ]) {
    const f = localProcessFixture(
      t,
      workerSource(`process.stdout.write(${JSON.stringify(output)});`),
    )
    const reader = createLocalCaptchaReader({
      bundleRoot: '/task-ocr-bundle',
      spawnProcess: f.spawnProcess,
    })
    await assert.rejects(
      reader.recognize({ image: pic, prompt: 'fixed', maxOutputTokens: 64, signal: signal() }),
      code('MODEL_UNAVAILABLE'),
    )
    assert.equal(f.closed(), true)
  }
  const missing = createLocalCaptchaReader({ bundleRoot: '/g524-nonexistent-ocr-bundle' })
  await assert.rejects(
    missing.recognize({ image: pic, prompt: 'fixed', maxOutputTokens: 64, signal: signal() }),
    code('MODEL_UNAVAILABLE'),
  )
})

test('local OCR cancellation reaps a TERM-ignoring child before returning or freeing capacity', async (t) => {
  const f = localProcessFixture(
    t,
    workerSource(`
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    process.stdout.write(JSON.stringify({v:1,answer:'AB12'}));
  `),
  )
  const reader = createLocalCaptchaReader({
    bundleRoot: '/task-ocr-bundle',
    spawnProcess: f.spawnProcess,
  })
  const pic = await image()
  const controller = new AbortController()
  const work = reader.recognize({
    image: pic,
    prompt: 'fixed',
    maxOutputTokens: 64,
    signal: controller.signal,
  })
  const rejected = assert.rejects(work, code('CANCELLED'))
  await f.ready
  controller.abort()
  assert.equal(f.closed(), false)
  await assert.rejects(
    reader.recognize({ image: pic, prompt: 'fixed', maxOutputTokens: 64, signal: signal() }),
    code('CAPACITY'),
  )
  await rejected
  assert.equal(f.closed(), true)
  assert.equal(f.child().signalCode, 'SIGKILL')
  let spawned = false
  const never = createLocalCaptchaReader({
    bundleRoot: '/task-ocr-bundle',
    spawnProcess: () => {
      spawned = true
      throw new Error('private')
    },
  })
  await assert.rejects(
    never.recognize({
      image: pic,
      prompt: 'fixed',
      maxOutputTokens: 64,
      signal: controller.signal,
    }),
    code('CANCELLED'),
  )
  assert.equal(spawned, false)
})

test('local OCR wall timeout waits for its actual process close', async (t) => {
  const f = localProcessFixture(t, workerSource('setInterval(() => {}, 1000);'))
  const reader = createLocalCaptchaReader({
    bundleRoot: '/task-ocr-bundle',
    spawnProcess: f.spawnProcess,
    timeoutMs: 20,
  })
  await assert.rejects(
    reader.recognize({
      image: await image(),
      prompt: 'fixed',
      maxOutputTokens: 64,
      signal: signal(),
    }),
    code('TIMEOUT'),
  )
  assert.equal(f.closed(), true)
})

async function drainingLogin(t: TestContext, closeFails = false) {
  const entered = latch()
  const aborted = latch()
  const reap = latch()
  const f = fixture(await image())
  if (closeFails)
    f.session.close = async () => {
      f.calls.closed++
      throw new Error('private')
    }
  const reader: CaptchaReader = {
    ...local(async ({ signal }) => {
      entered.release()
      signal.addEventListener('abort', aborted.release, { once: true })
      await reap.promise
      throw new LiteratureError('CANCELLED')
    }),
    drainsOnAbort: true,
  }
  const manager = createManager(new LiteratureCaptchaSolver([reader]), { capacity: 1 })
  t.after(async () => {
    reap.release()
    await manager.close().catch(() => {})
  })
  const op = manager.start(owner, async () => f.session, f.persist)
  await entered.promise
  return { f, manager, op, aborted: aborted.promise, reap: reap.release }
}

test('login cancel keeps owner and capacity until the local solver actually drains', async (t) => {
  const f = await drainingLogin(t)
  let done = false
  const cancelling = f.manager.cancel(17, f.op.operationId).then((view) => {
    done = true
    return view
  })
  await f.aborted
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(done, false)
  assert.throws(
    () => f.manager.start(owner, async () => f.f.session, f.f.persist),
    code('ACCOUNT_BUSY'),
  )
  assert.throws(
    () => f.manager.start({ userId: 18, accountId: '43' }, async () => f.f.session, f.f.persist),
    code('CAPACITY'),
  )
  f.reap()
  assert.equal((await cancelling).status, 'cancelled')
  assert.equal(f.f.calls.submits.length, 0)
  assert.equal(f.f.calls.persisted, 0)
  assert.equal(f.f.calls.closed, 1)
})

test('login expiry keeps local solver cleanup in its owner barrier', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await drainingLogin(t)
  t.mock.timers.tick(300_000)
  await f.aborted
  assert.equal(f.manager.status(17, f.op.operationId).status, 'expired')
  assert.throws(
    () => f.manager.start(owner, async () => f.f.session, f.f.persist),
    code('ACCOUNT_BUSY'),
  )
  let done = false
  const closing = f.manager.close().then(() => {
    done = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(done, false)
  f.reap()
  await closing
  assert.equal(f.f.calls.submits.length, 0)
  assert.equal(f.f.calls.persisted, 0)
  assert.equal(f.f.calls.closed, 1)
})

test('login shutdown waits for local solver cleanup without late submission or save', async (t) => {
  const f = await drainingLogin(t)
  let done = false
  const closing = f.manager.close().then(() => {
    done = true
  })
  await f.aborted
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(done, false)
  f.reap()
  await closing
  assert.equal(f.manager.status(17, f.op.operationId).status, 'cancelled')
  assert.equal(f.f.calls.submits.length, 0)
  assert.equal(f.f.calls.persisted, 0)
  assert.equal(f.f.calls.closed, 1)
})

test('session cleanup failure still waits for the local solver and retains owner', async (t) => {
  const f = await drainingLogin(t, true)
  let done = false
  const cancelling = f.manager.cancel(17, f.op.operationId).then((view) => {
    done = true
    return view
  })
  await f.aborted
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(done, false)
  let retryDone = false
  const again = f.manager.cancel(17, f.op.operationId).then((view) => {
    retryDone = true
    return view
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(retryDone, false)
  f.reap()
  assert.equal((await cancelling).errorCode, 'CLEANUP_FAILED')
  assert.equal((await again).errorCode, 'CLEANUP_FAILED')
  assert.throws(
    () => f.manager.start(owner, async () => f.f.session, f.f.persist),
    code('ACCOUNT_BUSY'),
  )
  await assert.rejects(f.manager.close(), code('CLEANUP_FAILED'))
})

test('automatic budget cannot hide a local CLEANUP_FAILED or enter manual fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const entered = latch()
  const f = fixture(await image())
  const reader: CaptchaReader = {
    ...local(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          entered.release()
          signal.addEventListener('abort', () => reject(new LiteratureError('CLEANUP_FAILED')), {
            once: true,
          })
        }),
    ),
    drainsOnAbort: true,
  }
  const manager = createManager(new LiteratureCaptchaSolver([reader]), {
    autoBudgetMs: 5,
    capacity: 1,
  })
  const op = manager.start(owner, async () => f.session, f.persist)
  await entered.promise
  t.mock.timers.tick(5)
  const view = await manager.settled(17, op.operationId)
  assert.equal(view.status, 'failed')
  assert.equal(view.errorCode, 'CLEANUP_FAILED')
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('ACCOUNT_BUSY'))
  assert.throws(
    () => manager.start({ userId: 18, accountId: '43' }, async () => f.session, f.persist),
    code('CAPACITY'),
  )
  assert.equal(f.calls.challenges, 1)
  assert.equal(f.calls.submits.length, 0)
  assert.equal(f.calls.persisted, 0)
  await assert.rejects(manager.close(), code('CLEANUP_FAILED'))
})

test('local cleanup failure remains latched when cancellation follows the solver rejection', async (t) => {
  const entered = latch()
  let rejectReader!: (error: unknown) => void
  const f = fixture(await image())
  const reader: CaptchaReader = {
    ...local(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectReader = reject
          entered.release()
        }),
    ),
    drainsOnAbort: true,
  }
  const manager = createManager(new LiteratureCaptchaSolver([reader]), { capacity: 1 })
  t.after(async () => {
    await manager.close().catch(() => {})
  })
  const op = manager.start(owner, async () => f.session, f.persist)
  await entered.promise
  // Let all recognize/solve reactions attach, then reproduce the review interleaving.
  await new Promise((resolve) => setImmediate(resolve))
  rejectReader(new LiteratureError('CLEANUP_FAILED'))
  const cancelled = await new Promise<ReturnType<typeof manager.cancel>>((resolve) => {
    queueMicrotask(() =>
      queueMicrotask(() =>
        queueMicrotask(() => {
          resolve(manager.cancel(17, op.operationId))
        }),
      ),
    )
  })
  assert.equal(cancelled.status, 'failed')
  assert.equal(cancelled.errorCode, 'CLEANUP_FAILED')
  assert.throws(() => manager.start(owner, async () => f.session, f.persist), code('ACCOUNT_BUSY'))
  assert.throws(
    () => manager.start({ userId: 18, accountId: '43' }, async () => f.session, f.persist),
    code('CAPACITY'),
  )
  assert.equal(f.calls.submits.length, 0)
  assert.equal(f.calls.persisted, 0)
  assert.equal(f.calls.closed, 1)
  await assert.rejects(manager.close(), code('CLEANUP_FAILED'))
})
