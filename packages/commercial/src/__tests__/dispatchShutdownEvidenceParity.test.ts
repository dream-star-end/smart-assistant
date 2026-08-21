/**
 * 0239 dispatch 级停机证据:迁移存在、requiredMigrations 登记、store 写入面存在。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/dispatchShutdownEvidenceParity.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const migration = join(here, '../db/migrations/0239_turn_dispatch_shutdown_ctx.sql')
const storeSrc = readFileSync(join(here, '../dispatch/turnDispatchStore.ts'), 'utf8')
const reconcilerSrc = readFileSync(join(here, '../dispatch/turnDispatchReconciler.ts'), 'utf8')
const backendSrc = readFileSync(join(here, '../db/pgSessionsBackend.ts'), 'utf8')
const metadata = JSON.parse(
  readFileSync(join(here, '../../../../deploy/v5/release-metadata.json'), 'utf8'),
) as { requiredMigrations: string[] }

describe('0239 turn_dispatches.shutdown_ctx', () => {
  test('迁移加列并登记 requiredMigrations', () => {
    assert.equal(existsSync(migration), true)
    const sql = readFileSync(migration, 'utf8')
    assert.match(sql, /ALTER TABLE turn_dispatches/)
    assert.match(sql, /shutdown_ctx jsonb/)
    assert.ok(metadata.requiredMigrations.includes('0239_turn_dispatch_shutdown_ctx'))
  })

  test('store 写证据、reconciler 用 SERVICE_RESTART、converge 透传 failureCode', () => {
    assert.match(storeSrc, /markOpenDispatchShutdownEvidence/)
    assert.match(storeSrc, /status IN \('admitted','accepted','rejecting'\)/)
    assert.match(reconcilerSrc, /failureCode: 'SERVICE_RESTART'/)
    assert.match(reconcilerSrc, /expireAdmittedLeasesOnShutdown/)
    assert.match(reconcilerSrc, /status = 'admitted'/)
    assert.match(backendSrc, /failureCode\?: string \| null/)
    assert.match(backendSrc, /failure_code IN \('RESULT_RECOVERY_PENDING','SERVICE_RESTART'\)/)
  })
})
