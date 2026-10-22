import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  type ClientRequest,
  Agent as HttpAgent,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from 'node:http'
import type { Socket } from 'node:net'
import test from 'node:test'
import sharp from 'sharp'
import { LiteratureError } from './errors.js'
import { JieyouHttpClient, parseJieyouLoginForm } from './jieyouHttpClient.js'
import { LiteratureHttpTransport } from './transport.js'

// Field values are deliberately synthetic: no original page value was archived.
const FORM = `<html><script>const inert='<form method="post">';</script>
<!-- <form>comment-only</form> -->
<form method="post" action="../doaction.php">
<input type="hidden" name="ecmsfrom" value="synthetic&amp;from">
<input type="hidden" name="enews" value="synthetic-login">
<input type="hidden" name="tobind" value="synthetic-bind">
<input type="text" name="username" id="password">
<input type="password" name="password" id="username">
<input type="text" name="key">
<input type="radio" name="lifetime" value="fixture-none">
<input type="radio" name="lifetime" value="fixture-month" checked>
<img src="../../ShowKey/?v=login">
<input type="submit" name="Submit" value="synthetic-submit">
</form></html>`
const credentials = {
  schemaVersion: 1,
  username: 'fixture+user',
  password: 'synthetic&+= 密码',
}
const signal = () => new AbortController().signal
const code = (expected: string) => (error: unknown) =>
  error instanceof LiteratureError && error.code === expected
const picture = sharp({
  create: { width: 47, height: 20, channels: 3, background: '#666666' },
})
  .png()
  .toBuffer()
type Handler = (request: IncomingMessage, response: ServerResponse) => void
async function fixture(
  handler?: Handler,
  timeoutMs = 1000,
  afterRequest?: (request: ClientRequest, options: RequestOptions) => void,
) {
  const paths: string[] = []
  const cookies: string[] = []
  const posted: string[] = []
  const requests: ClientRequest[] = []
  const sockets: Socket[] = []
  const server = createServer((req, res) => {
    paths.push(req.url!)
    cookies.push(req.headers.cookie ?? '')
    if (handler) return handler(req, res)
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (part: Buffer) => chunks.push(part))
      req.on('end', () => {
        posted.push(Buffer.concat(chunks).toString())
        res.writeHead(307, { location: '/e/member/doaction.php' })
        res.end()
      })
    } else if (req.url!.startsWith('/e/ShowKey/')) {
      void picture.then((png) => {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(png)
      })
    } else {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': [
          'session=synthetic-session; Path=/e/; HttpOnly',
          'secure=synthetic-secure; Path=/; Secure',
          'elsewhere=synthetic-else; Path=/else/',
          'expired=synthetic-expired; Path=/; Max-Age=0',
          'root=synthetic-root; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
        ],
      })
      res.end(FORM)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  const transport = new LiteratureHttpTransport({
    resolver: {
      resolve4: async () => ['93.184.216.34'],
      resolve6: async () => [],
    },
    timeoutMs,
    requestFactory: (options, callback) => {
      const request = httpRequest(
        { ...options, hostname: '127.0.0.1', port: address.port },
        callback,
      )
      requests.push(request)
      request.on('socket', (socket) => sockets.push(socket))
      afterRequest?.(request, options)
      return request
    },
  })
  const clients: JieyouHttpClient[] = []
  const createClient = (options: { initialState?: unknown } = {}) => {
    const client = new JieyouHttpClient(transport, options)
    clients.push(client)
    return client
  }
  return {
    client: createClient(),
    createClient,
    requests,
    sockets,
    transport,
    paths,
    cookies,
    posted,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test('parser uses form names and current values, ignores inert markup and decodes entities', () => {
  const form = parseJieyouLoginForm(FORM)
  assert.equal(form.action, 'http://www.jieyoutsg.com/e/member/doaction.php')
  assert.equal(form.captchaUrl, 'http://www.jieyoutsg.com/e/ShowKey/?v=login')
  assert.equal(form.hidden[0].value, 'synthetic&from')
  assert.deepEqual(form.lifetimes, [
    { value: 'fixture-none', checked: false },
    { value: 'fixture-month', checked: true },
  ])
  assert.equal(form.submitValue, 'synthetic-submit')
  assert(Object.isFrozen(form.hidden[0]))
  assert(Object.isFrozen(form.lifetimes))
})

test('parser rejects ambiguous, unrecognised and off-site login structures', () => {
  const invalid = [
    FORM.replace(
      '<input type="text" name="key">',
      '<input type="text" name="key"><input name="username">',
    ),
    FORM.replace('name="enews"', 'name="unexpected-secret-field"'),
    FORM.replace('value="fixture-month"', 'value="fixture-none"'),
    FORM.replace('type="password" name="password"', 'type="text" name="password"'),
    FORM.replace('<form method="post" action=', '<form method="get" action='),
    FORM.replace('../../ShowKey/?v=login', 'https://evil.test/e/ShowKey/?v=login'),
    FORM + FORM,
    `${FORM}<div>${'<span></span>'.repeat(20_001)}</div>`,
  ]
  for (const [index, html] of invalid.entries())
    assert.throws(
      () => parseJieyouLoginForm(html),
      code('RESPONSE_INVALID'),
      `invalid fixture ${index}`,
    )
  assert.throws(
    () =>
      parseJieyouLoginForm(
        FORM.replace('../doaction.php', 'http://evil.test/e/member/doaction.php'),
      ),
    code('OUTBOUND_BLOCKED'),
  )
})

test('same private jar reaches challenge; Secure/path/expired cookies never leak to HTTP', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  t.after(() => f.client.close())
  const first = await f.client.getChallenge(signal())
  const second = await f.client.getChallenge(signal())
  assert.notEqual(first.challengeId, second.challengeId)
  assert.notEqual(f.paths[1], f.paths[2])
  assert.equal(first.image.mediaType, 'image/png')
  assert.match(f.cookies[1], /session=synthetic-session/)
  assert.match(f.cookies[1], /root=synthetic-root/)
  assert(!/secure=|elsewhere=|expired=/.test(f.cookies[1]))
  await assert.rejects(
    f.client.submit(
      {
        challengeId: first.challengeId,
        credentials,
        answer: '1234',
        lifetime: 'fixture-none',
      },
      signal(),
    ),
    code('CHALLENGE_STALE'),
  )
})

test('one POST encodes credentials and live hidden values, consumes challenge and never follows 307', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  t.after(() => f.client.close())
  const challenge = await f.client.getChallenge(signal())
  const result = await f.client.submit(
    { ...challenge, credentials, answer: '1234', lifetime: 'fixture-none' },
    signal(),
  )
  assert.equal(result.response.status, 307)
  assert.equal(f.paths.length, 3)
  assert.equal(f.posted.length, 1)
  const fields = new URLSearchParams(f.posted[0])
  assert.equal(fields.get('username'), credentials.username)
  assert.equal(fields.get('password'), credentials.password)
  assert.equal(fields.get('ecmsfrom'), 'synthetic&from')
  assert.equal(fields.get('lifetime'), 'fixture-none')
  assert.equal(fields.get('Submit'), 'synthetic-submit')
  assert(!('authenticated' in result))
  await assert.rejects(
    f.client.submit(
      { ...challenge, credentials, answer: '1234', lifetime: 'fixture-none' },
      signal(),
    ),
    code('CHALLENGE_STALE'),
  )
  assert.equal(f.posted.length, 1)
  const snapshot = JSON.stringify(f.client.exportPrivateCookies())
  assert(!snapshot.includes(credentials.username))
  assert(!snapshot.includes(credentials.password))
})

test('invalid lifetime cannot silently choose a remembered site default', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  t.after(() => f.client.close())
  const challenge = await f.client.getChallenge(signal())
  await assert.rejects(
    f.client.submit({ ...challenge, credentials, answer: '1234', lifetime: '0' }, signal()),
    code('INVALID_INPUT'),
  )
  assert.equal(f.posted.length, 0)
  await f.client.submit(
    { ...challenge, credentials, answer: '1234', lifetime: 'fixture-none' },
    signal(),
  )
  assert.equal(f.posted.length, 1)
})

test('independent clients never share cookies even when their requests overlap', async (t) => {
  let logins = 0
  const observed: string[] = []
  const f = await fixture((req, res) => {
    if (req.url!.startsWith('/e/ShowKey/')) {
      observed.push(req.headers.cookie ?? '')
      void picture.then((png) => {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(png)
      })
    } else {
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': [`sid=fixture-${++logins}; Path=/`],
      })
      res.end(FORM)
    }
  })
  const second = f.createClient()
  t.after(() => f.close())
  t.after(() => Promise.all([f.client.close(), second.close()]))
  await Promise.all([f.client.getChallenge(signal()), second.getChallenge(signal())])
  assert.deepEqual(observed.sort(), ['sid=fixture-1', 'sid=fixture-2'])
})

test('GET follows safe redirects with fresh cookie selection and detects loops', async (t) => {
  const cookies: string[] = []
  const f = await fixture((req, res) => {
    cookies.push(req.headers.cookie ?? '')
    if (req.url === '/e/member/login/') {
      res.writeHead(302, {
        location: '/e/member/login/form',
        'set-cookie': ['hop=synthetic; Path=/e/'],
      })
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FORM)
    }
  })
  t.after(() => f.close())
  t.after(() => f.client.close())
  await f.client.loadLoginPage(signal())
  assert.deepEqual(cookies, ['', 'hop=synthetic'])
  const loop = await fixture((_req, res) => {
    res.writeHead(302, { location: '/e/member/login/' })
    res.end()
  })
  t.after(() => loop.close())
  t.after(() => loop.client.close())
  await assert.rejects(loop.client.loadLoginPage(signal()), code('OUTBOUND_BLOCKED'))
  assert.equal(loop.paths.length, 1)
})

test('blocked responses and cross-host redirects stop before more requests', async (t) => {
  for (const status of [403, 429, 302]) {
    const f = await fixture((_req, res) => {
      res.writeHead(status, status === 302 ? { location: 'http://evil.test/' } : {})
      res.end()
    })
    t.after(() => f.close())
    t.after(() => f.client.close())
    await assert.rejects(
      f.client.loadLoginPage(signal()),
      code(status === 302 ? 'OUTBOUND_BLOCKED' : 'UPSTREAM_BLOCKED'),
    )
    assert.equal(f.paths.length, 1)
  }
})

test('cookie count budget clears partial state instead of retaining an oversized jar', async (t) => {
  const f = await fixture((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': Array.from({ length: 65 }, (_, i) => `fixture${i}=x; Path=/`),
    })
    res.end(FORM)
  })
  t.after(() => f.close())
  t.after(() => f.client.close())
  await assert.rejects(f.client.loadLoginPage(signal()), code('RESPONSE_TOO_LARGE'))
  assert.equal(f.client.exportPrivateCookies().cookies.length, 0)
})

test('close cancels in-flight requests and concurrent operations cannot mix challenges', async (t) => {
  let received!: () => void
  const arrived = new Promise<void>((resolve) => {
    received = resolve
  })
  const f = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.write('<html>incomplete synthetic response')
    received()
  })
  t.after(() => f.close())
  t.after(() => f.client.close())
  const loading = f.client.loadLoginPage(signal())
  await arrived
  await assert.rejects(f.client.getChallenge(signal()), code('ACCOUNT_BUSY'))
  const rejected = assert.rejects(loading, code('CANCELLED'))
  const closing = f.client.close()
  assert.equal(f.client.close(), closing)
  await closing
  assert.equal(f.requests.length, 1)
  assert(f.requests.every((request) => request.closed))
  assert.equal(f.sockets.length, 1)
  assert(f.sockets.every((socket) => socket.closed))
  await rejected
  await assert.rejects(f.client.loadLoginPage(signal()), code('CANCELLED'))
  assert.throws(() => f.client.exportPrivateCookies(), code('CANCELLED'))
})

test('a timed-out POST is never replayed and its challenge remains consumed', async (t) => {
  let submits = 0
  const f = await fixture((req, res) => {
    if (req.method === 'POST') {
      submits++
      req.resume()
    } else if (req.url!.startsWith('/e/ShowKey/'))
      void picture.then((png) => {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(png)
      })
    else {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FORM)
    }
  }, 150)
  t.after(() => f.close())
  t.after(() => f.client.close())
  const challenge = await f.client.getChallenge(signal())
  const input = {
    ...challenge,
    credentials,
    answer: '1234',
    lifetime: 'fixture-none',
  }
  await assert.rejects(f.client.submit(input, signal()), code('SUBMISSION_UNCERTAIN'))
  await assert.rejects(f.client.submit(input, signal()), code('CHALLENGE_STALE'))
  assert.equal(submits, 1)
  assert(f.requests.every((request) => request.closed))
  assert(f.sockets.every((socket) => socket.closed))
})

test('legacy table form keeps its parser-associated controls after DOM tree repair', () => {
  const legacy = FORM.replace(
    '<form method="post" action=',
    '<table><form method="post" action=',
  ).replace('</form></html>', '</form></table></html>')
  const normal = parseJieyouLoginForm(FORM)
  assert.deepEqual(parseJieyouLoginForm(legacy), normal)
  const inert = legacy.replace(
    '<input type="text" name="key">',
    `<script>const inert = '</form><input name="username">';</script>
     <template><input name="username"><form method="post"></form></template>
     <input type="text" name="key">`,
  )
  assert.deepEqual(parseJieyouLoginForm(inert), normal)
})

test('a real closing form excludes later same-table controls from the login owner', () => {
  const legacy = FORM.replace('<form method="post" action=', '<table><form method="post" action=')
    .replace('<input type="text" name="key">', '')
    .replace('</form></html>', '</form><input type="text" name="key"></table></html>')
  assert.throws(() => parseJieyouLoginForm(legacy), code('RESPONSE_INVALID'))
})

test('explicit form-owner overrides are rejected instead of assigned to the parser pointer', () => {
  assert.throws(
    () => parseJieyouLoginForm(`${FORM}<input form="login" name="key">`),
    code('RESPONSE_INVALID'),
  )
  assert.throws(
    () =>
      parseJieyouLoginForm(
        FORM.replace('name="username" id=', 'name="username" form="another-form" id='),
      ),
    code('RESPONSE_INVALID'),
  )
})

test('restored HTTP state sends only the matching private cookies and remains client-local', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  t.after(() => f.client.close())
  await f.client.getChallenge(signal())
  const restored = f.createClient({
    initialState: f.client.exportPrivateCookies(),
  })
  t.after(() => restored.close())
  const start = f.cookies.length
  await restored.getChallenge(signal())
  assert(f.cookies[start].includes('session=synthetic-session'))
  assert(!f.cookies[start].includes('secure='))
  assert(!f.cookies[start].includes('elsewhere='))
  const separate = f.createClient()
  t.after(() => separate.close())
  const separateStart = f.cookies.length
  await separate.getChallenge(signal())
  assert.equal(f.cookies[separateStart], '')
})

test('successful hops complete only after native request and socket close, with distinct agents', async (t) => {
  const agents: HttpAgent[] = []
  const f = await fixture(undefined, 1000, (_request, options) => {
    assert(options.agent instanceof HttpAgent)
    agents.push(options.agent)
  })
  t.after(() => f.close())
  await f.client.getChallenge(signal())
  assert.equal(f.requests.length, 2)
  assert.equal(f.sockets.length, 2)
  assert(f.requests.every((request) => request.closed))
  assert(f.sockets.every((socket) => socket.closed))
  assert.notEqual(agents[0], agents[1])
  assert(agents.every((agent) => Reflect.get(agent, 'keepAlive') === false))
})

test('closing one client drains its socket without cancelling another on the same transport', async (t) => {
  let firstArrived!: () => void
  let secondArrived!: () => void
  const firstReceived = new Promise<void>((resolve) => {
    firstArrived = resolve
  })
  const secondReceived = new Promise<void>((resolve) => {
    secondArrived = resolve
  })
  let secondResponse!: ServerResponse
  let count = 0
  const f = await fixture((_req, res) => {
    if (++count === 1) firstArrived()
    else {
      secondResponse = res
      secondArrived()
    }
  })
  t.after(() => f.close())
  const second = f.createClient()
  const firstLoading = f.client.loadLoginPage(signal())
  const rejected = assert.rejects(firstLoading, code('CANCELLED'))
  await firstReceived
  const secondLoading = second.loadLoginPage(signal())
  await secondReceived
  await f.client.close()
  await rejected
  assert.equal(f.sockets.length, 2)
  assert.equal(f.sockets[0].closed, true)
  assert.equal(f.sockets[1].closed, false)
  secondResponse.writeHead(200, { 'content-type': 'text/html' })
  secondResponse.end(FORM)
  await secondLoading
  assert.equal(f.sockets[1].closed, true)
})

test('close during unresolved DNS prevents native requests even after a late answer', async (t) => {
  let resolveDns!: (addresses: string[]) => void
  let dnsStarted!: () => void
  const started = new Promise<void>((resolve) => {
    dnsStarted = resolve
  })
  const addresses = new Promise<string[]>((resolve) => {
    resolveDns = resolve
  })
  let requests = 0
  const client = new JieyouHttpClient(
    new LiteratureHttpTransport({
      resolver: {
        resolve4: () => {
          dnsStarted()
          return addresses
        },
        resolve6: async () => [],
      },
      requestFactory: () => {
        requests++
        throw new Error('must not dispatch')
      },
    }),
  )
  t.after(() => client.close())
  const loading = client.loadLoginPage(signal())
  const rejected = assert.rejects(loading, code('CANCELLED'))
  await started
  await client.close()
  await rejected
  resolveDns(['93.184.216.34'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests, 0)
})

test('cancellation before request socket assignment still waits for the created socket close', async (t) => {
  const controller = new AbortController()
  const created: Socket[] = []
  let assigned = 0
  const f = await fixture(undefined, 1000, (request, options) => {
    assert(options.agent instanceof HttpAgent)
    for (const group of Object.values(options.agent.sockets))
      for (const socket of group ?? []) created.push(socket)
    request.once('socket', () => {
      assigned++
    })
    controller.abort()
  })
  t.after(() => f.close())
  await assert.rejects(
    f.transport.request({
      url: 'http://www.jieyoutsg.com/e/member/login/',
      signal: controller.signal,
    }),
    code('CANCELLED'),
  )
  assert.equal(assigned, 0)
  assert.equal(created.length, 1)
  assert(created.every((socket) => socket.closed))
  assert(f.requests.every((request) => request.closed))
})

test('public-page stale foreign deletion leaves the client able to fetch a bound challenge', async () => {
  const f = await fixture((req, res) => {
    if (req.url!.startsWith('/e/ShowKey/')) {
      void picture.then((png) => {
        // Real ShowKey shape: host copies plus a live copy for another CMS domain.
        res.writeHead(200, {
          'content-type': 'image/png',
          'set-cookie': [
            'checkloginkey=synthetic-key; path=/',
            'checkloginkey=synthetic-key; path=/; domain=other-cms.invalid',
            'checkloginkey=synthetic-key; path=/',
          ],
        })
        res.end(png)
      })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': [
        'session=synthetic-session; Path=/; HttpOnly',
        'obsolete=deleted; Path=/; Max-Age=-1',
        'obsolete=deleted; Domain=stale.invalid; Path=/; Max-Age=-1',
        'obsolete=deleted; Path=/; Max-Age=-1',
      ],
    })
    res.end(FORM)
  })
  try {
    await f.client.loadLoginPage(signal())
    const challenge = await f.client.getChallenge(signal())
    assert(challenge.image.data.length > 0)
    assert.equal(f.paths.length, 2)
    assert.equal(f.cookies[1], 'session=synthetic-session')
    const state = f.client.exportPrivateCookies()
    assert.deepEqual(
      state.cookies.map((c) => [c.domain, c.name]).sort(),
      [
        ['www.jieyoutsg.com', 'checkloginkey'],
        ['www.jieyoutsg.com', 'session'],
      ],
    )
    assert.equal(f.posted.length, 0)
  } finally {
    await f.close()
  }
})
