import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  Agent as HttpAgent,
  type RequestListener,
  type RequestOptions,
  createServer,
  globalAgent,
  request as httpRequest,
} from 'node:http'
import type { Socket } from 'node:net'
import test from 'node:test'
import sharp from 'sharp'
import type { DnsResolver } from '../../connectors/outboundPolicy.js'
import { normalizeHttpsOrigin } from '../../connectors/outboundPolicy.js'
import { type CaptchaImage, type CaptchaReader, LiteratureCaptchaSolver } from './captcha.js'
import {
  openLiteratureCredentials,
  parseLiteratureCredentials,
  sealLiteratureCredentials,
} from './credentials.js'
import { LiteratureError } from './errors.js'
import {
  LiteratureLoginManager,
  type LiteratureLoginOptions,
  type LiteratureLoginSession,
  type LoginOutcome,
  type OperationSolverFactory,
} from './login.js'
import { LITERATURE_SITE, literatureUrl, pinLiteratureRequest } from './policy.js'
import { LiteratureHttpTransport, literatureSocketOptions } from './transport.js'

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
async function httpFixture(handler: RequestListener) {
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
  assert.equal(f.options[0]!.agent.options.keepAlive, false)
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
