import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { addGrant, GrantInvalidInputError } from '../admin/modelGrants.js'
import { resetPool, setPoolOverride } from '../db/index.js'

test('retired cc5 model grants reject every UID before a transaction; normal models keep normal handling', async () => {
  const keys = ['OC_SELFHOST_CC5_T1555U_ENABLED', 'OC_SELFHOST_CC5_T1555U_TEST_UID'] as const
  const saved = keys.map(key => process.env[key])
  let connects = 0
  let queries = 0
  const sentinel = new Error('synthetic-connect-positive-control')
  const pool = { connect: async () => { connects++; throw sentinel },
    query: async () => { queries++; throw sentinel }, end: async () => {} } as unknown as Pool
  setPoolOverride(pool)
  try {
    process.env.OC_SELFHOST_CC5_T1555U_ENABLED = '0'
    process.env.OC_SELFHOST_CC5_T1555U_TEST_UID = '314159'
    await assert.rejects(addGrant(3, 'cc5-remote-t1555u', { adminId: 3 }),
      error => error instanceof GrantInvalidInputError && error.message === 'cc5_task_model_retired')
    assert.equal(connects, 0)
    assert.equal(queries, 0)
    await assert.rejects(addGrant(314159, 'cc5-remote-t1555u', { adminId: 3 }),
      error => error instanceof GrantInvalidInputError && error.message === 'cc5_task_model_retired')
    assert.equal(connects, 0)
    await assert.rejects(addGrant(3, 'glm-5.2', { adminId: 3 }), sentinel)
    assert.equal(connects, 1)
  } finally {
    await resetPool()
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  }
})
