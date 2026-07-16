import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Pool, QueryResult, QueryResultRow } from 'pg'

import {
  KnowledgePlanetDockerService,
  KnowledgePlanetRuntimeError,
  type KnowledgePlanetLoginWorkerHandle,
} from './knowledgePlanet.js'
import {
  KnowledgePlanetSetupError,
  KnowledgePlanetSetupManager,
} from './knowledgePlanetSetup.js'

function result<Row extends QueryResultRow>(rows: Row[] = []): QueryResult<Row> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows }
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve!: () => void
  let reject!: () => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = () => no(new Error('worker failed'))
  })
  return { promise, resolve, reject }
}

describe('Knowledge Planet managed setup', () => {
  test('maps global worker saturation to a stable setup capacity error', async () => {
    const service = {
      async startLogin() {
        throw new KnowledgePlanetRuntimeError('CAPACITY_EXCEEDED')
      },
      async closeAndDrain() {},
    } as unknown as KnowledgePlanetDockerService
    const pool = {
      async query<Row extends QueryResultRow>(): Promise<QueryResult<Row>> {
        return result<Row>()
      },
    } as unknown as Pool
    const manager = new KnowledgePlanetSetupManager(service, {
      pool,
      loadEntitledVersion: async () => 41,
      resolvePins: async () => [],
    })
    await assert.rejects(
      manager.start(7, true),
      (error: unknown) =>
        error instanceof KnowledgePlanetSetupError && error.code === 'CAPACITY_EXCEEDED',
    )
  })

  test('coalesces concurrent starts and lets a refreshed browser recover the same setup', async () => {
    const workerDone = deferred()
    let starts = 0
    const service = {
      async startLogin(args: { sessionId: string }) {
        starts++
        return {
          sessionId: args.sessionId,
          done: workerDone.promise,
          stop: async () => workerDone.reject(),
        }
      },
      async closeAndDrain() {},
    } as unknown as KnowledgePlanetDockerService
    const pool = {
      async query<Row extends QueryResultRow>(): Promise<QueryResult<Row>> {
        return result<Row>()
      },
    } as unknown as Pool
    const manager = new KnowledgePlanetSetupManager(service, {
      pool,
      loadEntitledVersion: async () => 41,
      resolvePins: async () => [],
    })
    const [first, concurrent] = await Promise.all([manager.start(7, true), manager.start(7, true)])
    const recovered = await manager.start(7, true)
    assert.equal(starts, 1)
    assert.equal(concurrent.sessionId, first.sessionId)
    assert.equal(recovered.sessionId, first.sessionId)
    assert.equal(recovered.status, 'waiting_for_scan')
  })

  test('stores an account only after authenticated worker cleanup completes', async () => {
    const workerDone = deferred()
    let callbacks:
      | {
          onQr: (png: Buffer) => void
          onAuthenticated: (state: unknown) => void
          onFailed: (code: string) => void
        }
      | undefined
    const service = {
      async startLogin(args: typeof callbacks & { sessionId: string }) {
        callbacks = args
        return {
          sessionId: args.sessionId,
          done: workerDone.promise,
          stop: async () => workerDone.reject(),
        } satisfies KnowledgePlanetLoginWorkerHandle
      },
      async closeAndDrain() {},
    } as unknown as KnowledgePlanetDockerService
    const pool = {
      async query<Row extends QueryResultRow>(): Promise<QueryResult<Row>> {
        return result<Row>()
      },
    } as unknown as Pool
    let accountCreates = 0
    const manager = new KnowledgePlanetSetupManager(service, {
      pool,
      loadEntitledVersion: async () => 41,
      resolvePins: async () => [],
      createAccount: async () => {
        accountCreates++
        return { id: '91' }
      },
    })
    const started = await manager.start(7, true)
    assert.equal(started.status, 'waiting_for_scan')
    callbacks!.onAuthenticated({ cookies: [], origins: [] })
    assert.equal((await manager.status(7, started.sessionId)).status, 'finalizing')
    assert.equal(accountCreates, 0)
    workerDone.resolve()
    for (let i = 0; i < 20 && accountCreates === 0; i++)
      await new Promise((resolveWait) => setTimeout(resolveWait, 1))
    assert.equal(accountCreates, 1)
    const active = await manager.status(7, started.sessionId)
    assert.equal(active.status, 'active')
    assert.equal(active.accountId, '91')
  })

  test('cancel wins the terminal CAS and authenticated state is discarded', async () => {
    const workerDone = deferred()
    let onAuthenticated: ((state: unknown) => void) | undefined
    let stopCalls = 0
    const service = {
      async startLogin(args: {
        sessionId: string
        onAuthenticated: (state: unknown) => void
      }) {
        onAuthenticated = args.onAuthenticated
        return {
          sessionId: args.sessionId,
          done: workerDone.promise,
          stop: async () => {
            stopCalls++
            workerDone.reject()
          },
        }
      },
      async closeAndDrain() {},
    } as unknown as KnowledgePlanetDockerService
    const pool = {
      async query<Row extends QueryResultRow>(): Promise<QueryResult<Row>> {
        return result<Row>()
      },
    } as unknown as Pool
    let accountCreates = 0
    const manager = new KnowledgePlanetSetupManager(service, {
      pool,
      loadEntitledVersion: async () => 41,
      resolvePins: async () => [],
      createAccount: async () => {
        accountCreates++
        return { id: '91' }
      },
    })
    const started = await manager.start(7, true)
    assert.equal((await manager.cancel(7, started.sessionId)).status, 'cancelled')
    onAuthenticated!({ cookies: [], origins: [] })
    await new Promise((resolveWait) => setTimeout(resolveWait, 1))
    assert.equal(stopCalls, 1)
    assert.equal(accountCreates, 0)
    assert.equal((await manager.status(7, started.sessionId)).status, 'cancelled')
  })
})
