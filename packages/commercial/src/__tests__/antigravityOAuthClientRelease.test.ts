import assert from 'node:assert/strict'
/**
 * getFreshAntigravityAccessToken must never strand a pool client. Before the
 * fix it checked out a client and then loaded the KMS key outside the
 * try/finally: a key failure leaked the client and closePool() hung forever
 * (poolPolicy0306 integ timed out in its after hook through the admin quota read).
 */
import { describe, test } from 'node:test'
import type { Pool } from 'pg'
import { getFreshAntigravityAccessToken } from '../account-pool/antigravityOAuth.js'

function fakePool() {
  const state = { connects: 0, releases: 0, queries: [] as string[] }
  const pool = {
    async connect() {
      state.connects += 1
      return {
        async query(sql: string) {
          state.queries.push(sql)
          return { rows: [] }
        },
        release() {
          state.releases += 1
        },
      }
    },
  } as unknown as Pick<Pool, 'connect'>
  return { pool, state }
}

describe('getFreshAntigravityAccessToken client lifecycle', () => {
  test('a key load failure leaves no client checked out', async () => {
    const { pool, state } = fakePool()
    await assert.rejects(
      getFreshAntigravityAccessToken(1n, {
        clientSecret: 'secret',
        pool,
        keyFn: () => {
          throw new Error('KMS key missing')
        },
      }),
      /KMS key missing/,
    )
    assert.equal(state.connects - state.releases, 0, 'checked-out clients')
  })

  test('a missing account releases its client', async () => {
    const { pool, state } = fakePool()
    await assert.rejects(
      getFreshAntigravityAccessToken(2n, {
        clientSecret: 'secret',
        pool,
        keyFn: () => Buffer.alloc(32, 7),
      }),
      /ANTIGRAVITY_ACCOUNT_NOT_FOUND/,
    )
    assert.equal(state.connects, 1)
    assert.equal(state.releases, 1)
    assert.ok(state.queries.includes('ROLLBACK'))
  })
})
