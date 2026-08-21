/**
 * 0242 ZCode platform capability versioning.
 *
 * Run through the commercial test mutex only.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0242_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const forwardPath = path.resolve(here, '../db/migrations/0242_zcode_platform_capabilities.sql')
const rollbackPath = path.resolve(
  here,
  '../db/manual/0242_zcode_platform_capabilities_rollback.sql',
)

async function active() {
  const r = await query<{
    entry_id: string
    engine: string
    provider_id: string
    lock_version: number
    supported: string[]
    active_pricing: string
  }>(
    `SELECT c.entry_id::text,c.engine,c.provider_id,c.lock_version,
            c.capability_profile #> '{reasoning,supported}' AS supported,
            (SELECT count(*)::text FROM model_pricing p
              WHERE p.model_id=c.model_id AND p.enabled IS TRUE) AS active_pricing
       FROM model_catalog c
      WHERE c.model_id='glm-5.3-zai' AND c.state='active'`,
  )
  return r.rows[0]
}

describe('0242_zcode_platform_capabilities', () => {
  test('versions zcode to no effort knob and guarded rollback versions it back', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0242')
    const ccb = await active()
    assert.equal(ccb?.engine, 'ccb')
    await query(
      `SELECT fn_model_switch_version(
         'glm-5.3-zai','zcode','zcode','glm-5.3',1000000,
         (SELECT capability_profile FROM model_catalog
           WHERE model_id='glm-5.3-zai' AND state='active'),
         1,NULL,$1
       )`,
      [ccb!.lock_version],
    )
    const zcodeBefore = await active()
    assert.deepEqual(zcodeBefore?.supported, ['high', 'max'])

    await query(await readFile(forwardPath, 'utf8'))
    const forward = await active()
    assert.equal(forward?.engine, 'zcode')
    assert.equal(forward?.provider_id, 'zcode')
    assert.deepEqual(forward?.supported, [])
    assert.equal(forward?.active_pricing, '1')
    assert.notEqual(forward?.entry_id, zcodeBefore?.entry_id)

    await query('BEGIN')
    try {
      await query(`SET LOCAL openclaude.expected_lock_version='${forward!.lock_version}'`)
      await query(await readFile(rollbackPath, 'utf8'))
      const rolled = await active()
      assert.equal(rolled?.engine, 'zcode')
      assert.deepEqual(rolled?.supported, ['high', 'max'])
      assert.equal(rolled?.active_pricing, '1')
      assert.notEqual(rolled?.entry_id, forward?.entry_id)
      await query('COMMIT')
    } catch (err) {
      await query('ROLLBACK')
      throw err
    }

    await assert.rejects(async () => {
      await query('BEGIN')
      try {
        await query(`SET LOCAL openclaude.expected_lock_version='0'`)
        await query(await readFile(rollbackPath, 'utf8'))
      } finally {
        await query('ROLLBACK')
      }
    }, /rollback precondition failed/)
  })
})
