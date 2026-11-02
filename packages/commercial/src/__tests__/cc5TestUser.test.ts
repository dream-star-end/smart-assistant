import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { CC5_TEST_ACCOUNT_EMAIL } from '../admin/cc5TestUser.js'
import { signAccess } from '../auth/jwt.js'
import { verifyPassword } from '../auth/passwords.js'
import { register } from '../auth/register.js'
import { resetPool, setPoolOverride } from '../db/index.js'
import type { FlavorIdentity } from '../flavor/assertFlavor.js'
import { handleAdminCreateCc5TestUser } from '../http/admin/cc5TestUser.js'
import { type CommercialHttpDeps, type RequestContext, handleRegister } from '../http/handlers.js'
import { HttpError } from '../http/util.js'

const SECRET = 'synthetic-admin-test-signing-secret-only-cc5-t1555u'
const FLAG = 'OC_SELFHOST_CC5_T1555U_ADMIN_CREATE_ENABLED'
const identity = () => ({ status: 'ok', flavor: 'selfhost' }) as FlavorIdentity
class Req extends Readable {
  url = '/api/admin/users/cc5-test-t1555u'
  method = 'POST'
  headers: Record<string, string>
  socket = { remoteAddress: '127.0.0.1' }
  constructor(body: unknown, authorization?: string) {
    super()
    const bytes = Buffer.from(JSON.stringify(body))
    this.headers = {
      'content-type': 'application/json',
      'content-length': String(bytes.length),
      ...(authorization ? { authorization } : {}),
    }
    this.push(bytes)
    this.push(null)
  }
}
class Res {
  statusCode = 0
  headers: Record<string, unknown> = {}
  bytes: Buffer[] = []
  setHeader(name: string, value: unknown) {
    this.headers[name.toLowerCase()] = value
  }
  writeHead(status: number, headers?: Record<string, unknown>) {
    this.statusCode = status
    Object.assign(this.headers, headers)
  }
  end(value?: string | Buffer) {
    if (value) this.bytes.push(Buffer.from(value))
  }
  json() {
    return JSON.parse(Buffer.concat(this.bytes).toString('utf8'))
  }
}
interface User {
  id: string
  email: string
  hash: string
}
function poolFixture(options: { role?: string; status?: string; auditFails?: boolean } = {}) {
  const committed = {
    users: [] as User[],
    verifications: [] as unknown[][],
    audits: [] as unknown[][],
  }
  const statements: string[] = []
  const claimed = new Set<string>()
  let releases = 0
  let connects = 0
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      statements.push(sql.trim().split(/\s+/).slice(0, 5).join(' '))
      if (/SELECT role, status FROM users/.test(sql))
        return {
          rows: [{ role: options.role ?? 'admin', status: options.status ?? 'active' }],
          rowCount: 1,
        }
      if (/FROM system_settings/.test(sql))
        return {
          rows: [
            {
              key: params[0],
              value: params[0] === 'allow_registration' ? false : [],
              description: null,
              updated_at: new Date(0),
              updated_by: null,
            },
          ],
          rowCount: 1,
        }
      // Existing audit failure policy may enqueue its fixed security alert outside the rolled-back business tx.
      if (/INSERT INTO .*alert/i.test(sql)) return { rows: [{ id: '1' }], rowCount: 1 }
      throw new Error('unexpected pool query in isolated account fixture')
    },
    async connect() {
      connects++
      const pending = {
        users: [] as User[],
        verifications: [] as unknown[][],
        audits: [] as unknown[][],
      }
      return {
        async query(sql: string, params: unknown[] = []) {
          statements.push(sql.trim().split(/\s+/).slice(0, 5).join(' '))
          if (sql === 'BEGIN') return { rows: [], rowCount: 0 }
          if (sql === 'ROLLBACK') {
            for (const user of pending.users) claimed.delete(user.email)
            return { rows: [], rowCount: 0 }
          }
          if (sql === 'COMMIT') {
            committed.users.push(...pending.users)
            committed.verifications.push(...pending.verifications)
            committed.audits.push(...pending.audits)
            return { rows: [], rowCount: 0 }
          }
          if (/INSERT INTO users\(/.test(sql)) {
            const email = String(params[0])
            if (claimed.has(email))
              throw Object.assign(new Error('synthetic email unique conflict'), { code: '23505' })
            claimed.add(email)
            const id = String(1000 + committed.users.length)
            pending.users.push({ id, email, hash: String(params[1]) })
            return { rows: [{ id }], rowCount: 1 }
          }
          if (/INSERT INTO email_verifications\(/.test(sql)) {
            pending.verifications.push(params)
            return { rows: [], rowCount: 1 }
          }
          if (/INSERT INTO admin_audit\(/.test(sql)) {
            if (options.auditFails) throw new Error('synthetic audit failure')
            pending.audits.push(params)
            return { rows: [{ id: '99' }], rowCount: 1 }
          }
          throw new Error('unexpected transactional query in isolated account fixture')
        },
        release() {
          releases++
        },
      }
    },
    async end() {},
  }
  return {
    pool: pool as unknown as Pool,
    committed,
    statements,
    get connects() {
      return connects
    },
    get releases() {
      return releases
    },
  }
}
const ctx = {
  requestId: 'fixture-request',
  clientIp: '127.0.0.1',
  userAgent: 'task-only-unit-fixture',
} as RequestContext
async function setup(options: Parameters<typeof poolFixture>[0] = {}) {
  await resetPool()
  const f = poolFixture(options)
  setPoolOverride(f.pool)
  const oldFlag = process.env[FLAG]
  const oldChannel = process.env.OC_RUNTIME_CHANNEL
  process.env[FLAG] = '1'
  process.env.OC_RUNTIME_CHANNEL = 'v5'
  let sideEffects = 0
  const trap = () => {
    sideEffects++
    throw new Error('forbidden account side effect')
  }
  const deps = {
    jwtSecret: SECRET,
    mailer: { send: trap },
    prewarmContainerForUser: trap,
    redis: new Proxy({}, { get: trap }),
  } as unknown as CommercialHttpDeps
  const { token } = await signAccess({ sub: '7', role: 'admin' }, SECRET)
  return {
    ...f,
    f,
    deps,
    token,
    get sideEffects() {
      return sideEffects
    },
    async call(body: unknown, auth: string | null = token, probe = identity) {
      const req = new Req(body, auth ? `Bearer ${auth}` : undefined)
      const res = new Res()
      await handleAdminCreateCc5TestUser(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        ctx,
        deps,
        probe,
      )
      return res
    },
    async cleanup() {
      if (oldFlag === undefined) Reflect.deleteProperty(process.env, FLAG)
      else process.env[FLAG] = oldFlag
      if (oldChannel === undefined) Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')
      else process.env.OC_RUNTIME_CHANNEL = oldChannel
      await resetPool()
    },
  }
}
function status(expected: number) {
  return (e: unknown) => e instanceof HttpError && e.status === expected
}

test('OFF, wrong channel and unverified flavor perform no account transaction', async () => {
  const f = await setup()
  const password = randomBytes(24).toString('base64url')
  try {
    Reflect.deleteProperty(process.env, FLAG)
    await assert.rejects(f.call({ password }), status(404))
    process.env[FLAG] = '1'
    process.env.OC_RUNTIME_CHANNEL = 'v3'
    await assert.rejects(f.call({ password }), status(404))
    process.env.OC_RUNTIME_CHANNEL = 'v5'
    await assert.rejects(
      f.call({ password }, f.token, () => ({ status: 'skipped', reason: 'no-manifest' })),
      status(404),
    )
    assert.equal(f.f.connects, 0)
    assert.equal(f.sideEffects, 0)
  } finally {
    await f.cleanup()
  }
})
test('missing/user/revoked/banned administrator cannot create an account', async () => {
  for (const options of [{}, { role: 'user' }, { status: 'banned' }]) {
    const f = await setup(options)
    try {
      if (Object.keys(options).length === 0) {
        await assert.rejects(f.call({ password: 'ignored' }, null), status(401))
        const user = await signAccess({ sub: '8', role: 'user' }, SECRET)
        await assert.rejects(f.call({ password: 'ignored' }, user.token), status(403))
      } else await assert.rejects(f.call({ password: 'ignored' }), status(403))
      assert.equal(f.f.connects, 0)
    } finally {
      await f.cleanup()
    }
  }
})
test('only a valid password is accepted; email/role/verified/credits/identity overrides are rejected before writes', async () => {
  const f = await setup()
  const password = randomBytes(24).toString('base64url')
  try {
    for (const body of [
      { password: 'short' },
      { password, email: CC5_TEST_ACCOUNT_EMAIL },
      { password, role: 'admin' },
      { password, email_verified: true },
      { password, credits: 100 },
      { password, identity: 'selfhost' },
    ]) {
      await assert.rejects(f.call(body), status(400))
    }
    assert.equal(f.f.connects, 0)
    assert.equal(f.sideEffects, 0)
  } finally {
    await f.cleanup()
  }
})
test('fixed account, one verification and redacted-by-construction audit commit together without mail/session/prewarm', async () => {
  const f = await setup()
  const password = randomBytes(24).toString('base64url')
  try {
    const res = await f.call({ password })
    assert.equal(res.statusCode, 201)
    assert.deepEqual(res.json(), {
      user_id: '1000',
      email_verified: false,
      verify_email_sent: false,
      prewarmed: false,
    })
    assert.equal(f.committed.users.length, 1)
    assert.equal(f.committed.verifications.length, 1)
    assert.equal(f.committed.audits.length, 1)
    const user = f.committed.users[0]
    assert.equal(user.email, CC5_TEST_ACCOUNT_EMAIL)
    assert.equal(await verifyPassword(password, user.hash), true)
    const audit = f.committed.audits[0]
    assert.equal(audit[1], 'user.create')
    assert.equal(audit[2], 'user:1000')
    assert.deepEqual(JSON.parse(String(audit[4])), {
      task: 'AGENT-REMOTE-T1555U',
      email: CC5_TEST_ACCOUNT_EMAIL,
      role: 'user',
      email_verified: false,
      mail_suppressed: true,
      prewarm: false,
    })
    const publicBytes = JSON.stringify({ response: res.json(), audit })
    assert.equal(
      publicBytes.includes(password) ||
        publicBytes.includes(user.hash) ||
        publicBytes.includes(String(f.committed.verifications[0][1])),
      false,
    )
    assert.equal(res.headers['set-cookie'], undefined)
    assert.equal(f.sideEffects, 0)
    assert.equal(f.f.releases, 1)
  } finally {
    await f.cleanup()
  }
})
test('duplicate request never adopts the old account, resets its password or writes another verification/audit', async () => {
  const f = await setup()
  try {
    const first = randomBytes(24).toString('base64url')
    await f.call({ password: first })
    const before = f.committed.users[0].hash
    await assert.rejects(f.call({ password: randomBytes(24).toString('base64url') }), status(409))
    assert.equal(f.committed.users.length, 1)
    assert.equal(f.committed.verifications.length, 1)
    assert.equal(f.committed.audits.length, 1)
    assert.equal(f.committed.users[0].hash === before, true)
    assert.equal(f.sideEffects, 0)
  } finally {
    await f.cleanup()
  }
})
test('audit failure rolls back the same user/verification transaction and returns no sensitive error', async () => {
  const f = await setup({ auditFails: true })
  try {
    await assert.rejects(f.call({ password: randomBytes(24).toString('base64url') }), status(500))
    assert.equal(
      f.committed.users.length + f.committed.verifications.length + f.committed.audits.length,
      0,
    )
    assert.ok(f.statements.includes('ROLLBACK'))
    assert.equal(f.statements.includes('COMMIT'), false)
    assert.equal(f.sideEffects, 0)
    assert.equal(f.f.releases, 1)
  } finally {
    await f.cleanup()
  }
})
test('public registration remains closed even with the task admin flag enabled', async () => {
  const f = await setup()
  try {
    const req = new Req({ password: randomBytes(24).toString('base64url') })
    await assert.rejects(
      handleRegister(
        req as unknown as IncomingMessage,
        new Res() as unknown as ServerResponse,
        ctx,
        f.deps,
      ),
      status(403),
    )
    assert.equal(f.f.connects, 0)
    assert.equal(f.sideEffects, 0)
  } finally {
    await f.cleanup()
  }
})
test('ordinary registration still uses the shared core and its existing Turnstile/mail behavior', async () => {
  const f = await setup()
  const password = randomBytes(24).toString('base64url')
  let sent = 0
  try {
    const result = await register(
      {
        email: 'ordinary-registration-fixture@example.invalid',
        password,
        turnstile_token: 'fixture-only',
      },
      {
        mailer: {
          async send() {
            sent++
          },
        },
        turnstileEnforce: false,
        turnstileBypass: true,
      },
    )
    assert.equal(result.verify_email_sent, true)
    assert.equal(sent, 1)
    assert.equal(f.committed.users.length, 1)
    assert.equal(f.committed.verifications.length, 1)
    assert.equal(f.committed.audits.length, 0)
    assert.equal(await verifyPassword(password, f.committed.users[0].hash), true)
  } finally {
    await f.cleanup()
  }
})
