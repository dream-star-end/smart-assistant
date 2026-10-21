import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Pool, QueryResult, QueryResultRow } from 'pg'

import type { DnsResolver } from '../connectors/outboundPolicy.js'
import type { DouyinDockerService, DouyinLoginWorkerHandle } from './douyin.js'
import { DOUYIN_LOGIN_ORIGINS, DouyinRuntimeError } from './douyin.js'
import { DouyinSetupError, DouyinSetupManager, resolveDouyinLoginPins } from './douyinSetup.js'

function result<Row extends QueryResultRow>(rows: Row[] = []): QueryResult<Row> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows }
}

function deferred() {
  let resolve!: () => void
  let reject!: () => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = () => no(new Error('worker failed'))
  })
  return { promise, resolve, reject }
}

describe('Douyin managed setup', () => {
  test('retries transient login DNS failures without accepting an unsafe answer', async () => {
    let attempts = 0
    const resolver: DnsResolver = {
      resolve4: async () => {
        attempts++
        if (attempts === 1)
          throw Object.assign(new Error('temporary resolver failure'), { code: 'ETIMEOUT' })
        return ['93.184.216.34']
      },
      resolve6: async () => [],
    }
    assert.equal((await resolveDouyinLoginPins(resolver)).length, DOUYIN_LOGIN_ORIGINS.length)
    assert.equal(attempts, DOUYIN_LOGIN_ORIGINS.length + 1)

    const unsafe: DnsResolver = {
      resolve4: async () => ['127.0.0.1'],
      resolve6: async () => [],
    }
    await assert.rejects(
      resolveDouyinLoginPins(unsafe),
      (error: unknown) => error instanceof DouyinSetupError && error.code === 'UNAVAILABLE',
    )
  })

  test('requires explicit terms and maps worker saturation', async () => {
    const service = {
      async startLogin() {
        throw new DouyinRuntimeError('CAPACITY_EXCEEDED')
      },
      async closeAndDrain() {},
    } as unknown as DouyinDockerService
    const pool = {
      async query<Row extends QueryResultRow>() {
        return result<Row>()
      },
    } as unknown as Pool
    const manager = new DouyinSetupManager(service, {
      pool,
      loadEntitledVersion: async () => 41,
      resolvePins: async () => [],
    })
    await assert.rejects(
      manager.start(7, false),
      (error: unknown) => error instanceof DouyinSetupError && error.code === 'TERMS_REQUIRED',
    )
    await assert.rejects(
      manager.start(7, true),
      (error: unknown) => error instanceof DouyinSetupError && error.code === 'CAPACITY_EXCEEDED',
    )
  })

  test('stores validated state only after the isolated login worker exits', async () => {
    const done = deferred()
    let callbacks: { onAuthenticated: (state: unknown) => void } | undefined
    const service = {
      async startLogin(args: { sessionId: string; onAuthenticated: (state: unknown) => void }) {
        callbacks = args
        return {
          sessionId: args.sessionId,
          done: done.promise,
          stop: async () => done.reject(),
          command: async () => {},
        } satisfies DouyinLoginWorkerHandle
      },
      async closeAndDrain() {},
    } as unknown as DouyinDockerService
    const pool = {
      async query<Row extends QueryResultRow>() {
        return result<Row>()
      },
    } as unknown as Pool
    let creates = 0
    const manager = new DouyinSetupManager(service, {
      pool,
      loadEntitledVersion: async () => 41,
      resolvePins: async () => [],
      createAccount: async () => {
        creates++
        return { id: '91' }
      },
    })
    const setup = await manager.start(7, true)
    callbacks!.onAuthenticated({ cookies: [], origins: [] })
    assert.equal((await manager.status(7, setup.sessionId)).status, 'finalizing')
    assert.equal(creates, 0)
    done.resolve()
    for (let index = 0; index < 30; index += 1) {
      if ((await manager.status(7, setup.sessionId)).status === 'active') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 1))
    }
    assert.equal(creates, 1)
    assert.equal((await manager.status(7, setup.sessionId)).accountId, '91')
  })

  test('refreshes the requested account in place only after the login worker exits', async () => {
    const done = deferred()
    let callbacks: { onAuthenticated: (state: unknown) => void } | undefined
    const service = {
      async startLogin(args: { sessionId: string; onAuthenticated: (state: unknown) => void }) {
        callbacks = args
        return {
          sessionId: args.sessionId,
          done: done.promise,
          stop: async () => done.resolve(),
          command: async () => {},
        } satisfies DouyinLoginWorkerHandle
      },
      async closeAndDrain() {},
    } as unknown as DouyinDockerService
    const pool = {
      async query<Row extends QueryResultRow>() {
        return result<Row>([{ id: '91' }] as unknown as Row[])
      },
    } as unknown as Pool
    const refreshes: unknown[] = []
    const leaseCalls: unknown[] = []
    const manager = new DouyinSetupManager(service, {
      pool,
      redis: {
        async eval(...args) {
          leaseCalls.push(args)
          return 1
        },
      },
      loadEntitledVersion: async () => 41,
      resolvePins: async () => [],
      loadRelinkTarget: async (input) => {
        assert.deepEqual(input, { userId: 7, versionId: 41, accountId: '91' })
        return { accountId: '91', expectedAccountInstanceId: 'old-instance' }
      },
      bindRefreshedAccount: async (input) => {
        refreshes.push(input)
        return { id: '91' }
      },
      createAccount: async () => {
        throw new Error('relink must not create a second account')
      },
    })

    const setup = await manager.start(7, true, '91')
    callbacks!.onAuthenticated({ cookies: [], origins: [] })
    assert.equal((await manager.status(7, setup.sessionId)).status, 'finalizing')
    assert.equal(refreshes.length, 0)
    done.resolve()
    for (let index = 0; index < 30; index += 1) {
      if ((await manager.status(7, setup.sessionId)).status === 'active') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 1))
    }
    assert.equal(refreshes.length, 1)
    assert.equal(leaseCalls.length, 3)
    assert.deepEqual(refreshes[0], {
      userId: 7,
      versionId: 41,
      accountId: '91',
      expectedAccountInstanceId: 'old-instance',
      storageState: { cookies: [], origins: [] },
    })
    assert.equal((await manager.status(7, setup.sessionId)).accountId, '91')
  })

  test('cancelling an in-place relink leaves the existing account untouched', async () => {
    const done = deferred()
    let refreshes = 0
    const service = {
      async startLogin(args: { sessionId: string }) {
        return {
          sessionId: args.sessionId,
          done: done.promise,
          stop: async () => done.resolve(),
          command: async () => {},
        } satisfies DouyinLoginWorkerHandle
      },
      async closeAndDrain() {},
    } as unknown as DouyinDockerService
    const pool = {
      async query<Row extends QueryResultRow>() {
        return result<Row>([{ id: '91' }] as unknown as Row[])
      },
    } as unknown as Pool
    const manager = new DouyinSetupManager(service, {
      pool,
      loadEntitledVersion: async () => 41,
      resolvePins: async () => [],
      loadRelinkTarget: async () => ({
        accountId: '91',
        expectedAccountInstanceId: 'old-instance',
      }),
      bindRefreshedAccount: async () => {
        refreshes++
        return { id: '91' }
      },
    })

    const setup = await manager.start(7, true, '91')
    const cancelled = await manager.cancel(7, setup.sessionId)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.accountId, undefined)
    assert.equal(refreshes, 0)
  })

  test('a busy account lease fails relink before the account bind is touched', async () => {
    const done = deferred()
    let callbacks: { onAuthenticated: (state: unknown) => void } | undefined
    let binds = 0
    const service = {
      async startLogin(args: { sessionId: string; onAuthenticated: (state: unknown) => void }) {
        callbacks = args
        return {
          sessionId: args.sessionId,
          done: done.promise,
          stop: async () => done.resolve(),
          command: async () => {},
        } satisfies DouyinLoginWorkerHandle
      },
      async closeAndDrain() {},
    } as unknown as DouyinDockerService
    const pool = {
      async query<Row extends QueryResultRow>() {
        return result<Row>([{ id: '91' }] as unknown as Row[])
      },
    } as unknown as Pool
    const manager = new DouyinSetupManager(service, {
      pool,
      redis: { eval: async () => 0 },
      loadEntitledVersion: async () => 41,
      resolvePins: async () => [],
      loadRelinkTarget: async () => ({
        accountId: '91',
        expectedAccountInstanceId: 'old-instance',
      }),
      bindRefreshedAccount: async () => {
        binds++
        return { id: '91' }
      },
    })

    const setup = await manager.start(7, true, '91')
    callbacks!.onAuthenticated({ cookies: [], origins: [] })
    done.resolve()
    for (let index = 0; index < 30; index += 1) {
      if ((await manager.status(7, setup.sessionId)).status === 'failed') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 1))
    }
    assert.equal((await manager.status(7, setup.sessionId)).status, 'failed')
    assert.equal(binds, 0)
  })

  test('captures QR then expires a waiting session without creating an account', async () => {
    const done = deferred()
    let callbacks:
      | { onQr: (png: Buffer) => void; onAuthenticated: (state: unknown) => void }
      | undefined
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
    const service = {
      async startLogin(args: {
        sessionId: string
        onQr: (png: Buffer) => void
        onAuthenticated: (state: unknown) => void
        onStep?: (step: Record<string, unknown>) => void
      }) {
        callbacks = args
        return {
          sessionId: args.sessionId,
          done: done.promise,
          stop: async () => done.resolve(),
          command: async () => {},
        } satisfies DouyinLoginWorkerHandle
      },
      async closeAndDrain() {},
    } as unknown as DouyinDockerService
    const pool = {
      async query<Row extends QueryResultRow>() {
        return result<Row>()
      },
    } as unknown as Pool
    let now = 1_000
    let creates = 0
    const manager = new DouyinSetupManager(service, {
      pool,
      now: () => now,
      loadEntitledVersion: async () => 41,
      resolvePins: async () => [],
      createAccount: async () => {
        creates++
        return { id: '91' }
      },
    })
    const setup = await manager.start(7, true)
    assert.equal(setup.phase, 'generating_qr')
    callbacks!.onQr(png)
    const waiting = await manager.status(7, setup.sessionId)
    assert.equal(waiting.status, 'waiting_for_scan')
    assert.equal(waiting.phase, 'waiting_for_scan')
    assert.equal(waiting.qrReady, true)
    const served = await manager.qr(7, setup.sessionId)
    assert.deepEqual(served, png)
    // 抖音二维码约 1 分钟才出现，扫码后还要本人短信验证：整个扫码会话 8 分钟（4.3.C）。
    now = 1_000 + 7 * 60_000 + 30_000
    assert.equal((await manager.status(7, setup.sessionId)).status, 'waiting_for_scan')
    now = 1_000 + 8 * 60_000
    const expired = await manager.status(7, setup.sessionId)
    assert.equal(expired.status, 'expired')
    assert.equal(expired.phase, 'expired')
    assert.equal(creates, 0)
    await assert.rejects(
      manager.qr(7, setup.sessionId),
      (error: unknown) => error instanceof DouyinSetupError && error.code === 'QR_NOT_READY',
    )
  })

  test('stays waiting for the scan past the old 5-minute window (8-minute setup TTL with SMS)', async () => {
    const { manager } = smsHarness()
    const setup = await manager.start(7, true)
    assert.equal(Date.parse(setup.expiresAt) - Date.parse(setup.createdAt), 8 * 60_000)
  })
})

/** 本人短信验证（OCV5-553 4.3.C）：假 worker 记录 master 发来的每一条命令。 */
function smsHarness(opts: { quota?: Array<'ok' | 'limited' | 'unavailable'> } = {}) {
  const done = deferred()
  const commands: Array<Record<string, unknown>> = []
  let cb:
    | {
        onQr: (png: Buffer, expireAt: number) => void
        onAuthenticated: (state: unknown) => void
        onFailed: (code: string) => void
        onVerification: (kind: 'sms_available' | 'unsupported') => void
        onSmsSent: (resendAfterSec: number) => void
        onSmsRejected: () => void
        onSmsResendFailed: () => void
      }
    | undefined
  const service = {
    async startLogin(args: NonNullable<typeof cb> & { sessionId: string }) {
      cb = args
      return {
        sessionId: args.sessionId,
        done: done.promise,
        stop: async () => done.resolve(),
        command: async (value: Record<string, unknown>) => {
          commands.push({ ...value })
        },
      } as unknown as DouyinLoginWorkerHandle
    },
    async closeAndDrain() {},
  } as unknown as DouyinDockerService
  const pool = {
    async query<Row extends QueryResultRow>() {
      return result<Row>()
    },
  } as unknown as Pool
  let now = 1_000_000
  const quota = [...(opts.quota ?? [])]
  const quotaCalls: number[] = []
  const manager = new DouyinSetupManager(service, {
    pool,
    now: () => now,
    loadEntitledVersion: async () => 41,
    resolvePins: async () => [],
    createAccount: async () => ({ id: '91' }),
    smsQuota: async (userId) => {
      quotaCalls.push(userId)
      return quota.shift() ?? 'ok'
    },
  })
  return {
    manager,
    commands,
    quotaCalls,
    cb: () => cb!,
    advance: (ms: number) => {
      now += ms
    },
    done,
  }
}

const settle = () => new Promise((resolveWait) => setTimeout(resolveWait, 0))

describe('Douyin owner SMS verification (4.3.C)', () => {
  test('verification → rate-limit check → send_sms; the view shows countdowns, never the code', async () => {
    const h = smsHarness()
    const setup = await h.manager.start(7, true)
    h.cb().onQr(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 1_060_000)
    const waiting = await h.manager.status(7, setup.sessionId)
    assert.equal(waiting.qrExpireAt, new Date(1_060_000).toISOString())
    h.cb().onVerification('sms_available')
    await settle()
    assert.deepEqual(h.quotaCalls, [7])
    assert.deepEqual(h.commands, [{ cmd: 'send_sms' }])
    const sending = await h.manager.status(7, setup.sessionId)
    assert.equal(sending.status, 'waiting_for_sms')
    assert.equal(sending.phase, 'sms_required')
    assert.equal(sending.qrReady, false)
    assert.equal(sending.qrExpireAt, undefined)
    h.cb().onSmsSent(60)
    const sent = await h.manager.status(7, setup.sessionId)
    assert.equal(sent.phase, 'sms_sent')
    assert.deepEqual(sent.sms, {
      deadline: new Date(1_000_000 + 180_000).toISOString(),
      resendAfter: new Date(1_000_000 + 60_000).toISOString(),
      attemptsLeft: 3,
      sent: true,
      rejected: false,
    })
    const submitted = await h.manager.submitSms(7, setup.sessionId, '654321')
    assert.equal(submitted.phase, 'sms_verifying')
    assert.equal(submitted.sms?.attemptsLeft, 2)
    assert.deepEqual(h.commands.at(-1), { cmd: 'sms_code', code: '654321' })
    // 验证码不出现在任何视图里。
    assert.doesNotMatch(JSON.stringify(submitted), /654321/)
    assert.doesNotMatch(JSON.stringify(await h.manager.status(7, setup.sessionId)), /654321/)
  })

  test('a rejected code allows another try; after 3 wrong codes the login is aborted with a clear reason', async () => {
    const h = smsHarness()
    const setup = await h.manager.start(7, true)
    h.cb().onVerification('sms_available')
    await settle()
    h.cb().onSmsSent(60)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await h.manager.submitSms(7, setup.sessionId, `11111${attempt}`)
      h.cb().onSmsRejected()
      const view = await h.manager.status(7, setup.sessionId)
      if (attempt < 3) {
        assert.equal(view.phase, 'sms_sent')
        assert.equal(view.sms?.rejected, true)
        assert.equal(view.errorCode, 'SMS_REJECTED')
      }
    }
    assert.deepEqual(h.commands.at(-1), { cmd: 'abort' })
    await assert.rejects(
      h.manager.submitSms(7, setup.sessionId, '999999'),
      (e: unknown) => e instanceof DouyinSetupError && e.code === 'SMS_ATTEMPTS_EXCEEDED',
    )
    h.cb().onFailed('VERIFICATION_REQUIRED')
    const failed = await h.manager.status(7, setup.sessionId)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.errorCode, 'SMS_ATTEMPTS_EXCEEDED')
  })

  test('submit is refused outside the SMS step, with a malformed code, or after the 3-minute window', async () => {
    const h = smsHarness()
    const setup = await h.manager.start(7, true)
    await assert.rejects(
      h.manager.submitSms(7, setup.sessionId, '123456'),
      (e: unknown) => e instanceof DouyinSetupError && e.code === 'SMS_NOT_EXPECTED',
    )
    h.cb().onVerification('sms_available')
    await settle()
    // 还没确认发出：不能提交。
    await assert.rejects(
      h.manager.submitSms(7, setup.sessionId, '123456'),
      (e: unknown) => e instanceof DouyinSetupError && e.code === 'SMS_NOT_EXPECTED',
    )
    h.cb().onSmsSent(60)
    for (const bad of ['12a456', '123', '123456789', 123456, null])
      await assert.rejects(
        h.manager.submitSms(7, setup.sessionId, bad),
        (e: unknown) => e instanceof DouyinSetupError && e.code === 'SMS_INVALID',
        String(bad),
      )
    await assert.rejects(
      h.manager.submitSms(8, setup.sessionId, '123456'),
      (e: unknown) => e instanceof DouyinSetupError && e.code === 'SETUP_NOT_FOUND',
    )
    h.advance(180_000)
    const expired = await h.manager.status(7, setup.sessionId)
    assert.equal(expired.status, 'failed')
    assert.equal(expired.errorCode, 'SMS_EXPIRED')
    assert.ok(!h.commands.some((c) => c.cmd === 'sms_code'))
  })

  test('rate limited or unavailable quota → no SMS is sent and the login is aborted with that reason', async () => {
    for (const quota of ['limited', 'unavailable'] as const) {
      const h = smsHarness({ quota: [quota] })
      const setup = await h.manager.start(7, true)
      h.cb().onVerification('sms_available')
      await settle()
      assert.deepEqual(h.commands, [{ cmd: 'abort' }])
      h.cb().onFailed('VERIFICATION_REQUIRED')
      assert.equal(
        (await h.manager.status(7, setup.sessionId)).errorCode,
        quota === 'limited' ? 'SMS_RATE_LIMITED' : 'SMS_UNAVAILABLE',
      )
    }
  })

  test('unsupported verification (face / upstream SMS) → abort without spending SMS quota', async () => {
    const h = smsHarness()
    const setup = await h.manager.start(7, true)
    h.cb().onVerification('unsupported')
    await settle()
    assert.deepEqual(h.quotaCalls, [])
    assert.deepEqual(h.commands, [{ cmd: 'abort' }])
    h.cb().onFailed('VERIFICATION_REQUIRED')
    assert.equal((await h.manager.status(7, setup.sessionId)).errorCode, 'VERIFICATION_UNSUPPORTED')
  })

  test('resend waits for resendAfter and spends quota again; a limited resend keeps the session', async () => {
    const h = smsHarness({ quota: ['ok', 'limited', 'ok'] })
    const setup = await h.manager.start(7, true)
    h.cb().onVerification('sms_available')
    await settle()
    h.cb().onSmsSent(60)
    await assert.rejects(
      h.manager.resendSms(7, setup.sessionId),
      (e: unknown) => e instanceof DouyinSetupError && e.code === 'SMS_NOT_EXPECTED',
    )
    h.advance(60_000)
    await assert.rejects(
      h.manager.resendSms(7, setup.sessionId),
      (e: unknown) => e instanceof DouyinSetupError && e.code === 'SMS_RATE_LIMITED',
    )
    assert.equal((await h.manager.status(7, setup.sessionId)).status, 'waiting_for_sms')
    const resent = await h.manager.resendSms(7, setup.sessionId)
    assert.equal(resent.phase, 'sms_required')
    assert.deepEqual(h.commands.at(-1), { cmd: 'resend_sms' })
    assert.equal(h.quotaCalls.length, 3)
    h.cb().onSmsResendFailed()
    const after = await h.manager.status(7, setup.sessionId)
    assert.equal(after.phase, 'sms_sent')
    assert.equal(after.errorCode, 'SMS_RESEND_FAILED')
  })

  test('after a correct code the normal path takes over: authenticated → saved account', async () => {
    const h = smsHarness()
    const setup = await h.manager.start(7, true)
    h.cb().onVerification('sms_available')
    await settle()
    h.cb().onSmsSent(60)
    await h.manager.submitSms(7, setup.sessionId, '123456')
    h.cb().onAuthenticated({ cookies: [], origins: [] })
    assert.equal((await h.manager.status(7, setup.sessionId)).status, 'finalizing')
    h.done.resolve()
    for (let index = 0; index < 30; index += 1) {
      if ((await h.manager.status(7, setup.sessionId)).status === 'active') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 1))
    }
    const active = await h.manager.status(7, setup.sessionId)
    assert.equal(active.status, 'active')
    assert.equal(active.sms, undefined)
  })
})
