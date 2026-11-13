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
    // 抖音二维码约 1 分钟才出现，扫码窗口是 5 分钟（比微博 / B 站多 1 分钟）。
    now = 1_000 + 4 * 60_000 + 30_000
    assert.equal((await manager.status(7, setup.sessionId)).status, 'waiting_for_scan')
    now = 1_000 + 5 * 60_000
    const expired = await manager.status(7, setup.sessionId)
    assert.equal(expired.status, 'expired')
    assert.equal(expired.phase, 'expired')
    assert.equal(creates, 0)
    await assert.rejects(
      manager.qr(7, setup.sessionId),
      (error: unknown) => error instanceof DouyinSetupError && error.code === 'QR_NOT_READY',
    )
  })
})
