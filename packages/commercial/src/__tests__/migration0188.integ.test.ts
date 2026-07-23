import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

import {
  applyAutoDreamPreferenceAction,
  reportAutoDreamPlatformFindings,
} from '../autoDream/optimizerStore.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0188_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0188_auto_dream_optimizer.sql')

let pool: Pool
let pgAvailable = false

before(async () => {
  const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 })
  try {
    await probe.query('SELECT 1')
    pgAvailable = true
  } catch {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
  } finally {
    await probe.end().catch(() => undefined)
  }
  if (!pgAvailable) return
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.query(`CREATE SCHEMA ${SCHEMA}`)
  await admin.end()
  pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 4,
    options: `-c search_path=${SCHEMA}`,
  })
  await pool.query('CREATE TABLE users (id BIGINT PRIMARY KEY)')
  await pool.query(
    'CREATE TABLE system_settings (key TEXT PRIMARY KEY,value JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
  )
  await pool.query(
    'CREATE TABLE user_preferences (user_id BIGINT PRIMARY KEY REFERENCES users(id),prefs JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
  )
  await pool.query('INSERT INTO users(id) VALUES (1),(2)')
  await pool.query(
    "INSERT INTO system_settings(key,value) VALUES ('auto_dream_model','\"deepseek-v4-flash\"'::jsonb)",
  )
  await pool.query('INSERT INTO user_preferences(user_id,prefs) VALUES (1,\'{"theme":"dark"}\')')
  await pool.query(await readFile(MIGRATION, 'utf8'))
})

after(async () => {
  if (!pgAvailable) return
  await pool.end()
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.end()
})

function maybe(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    await fn()
  })
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('0188_auto_dream_optimizer', () => {
  maybe('pins the V2 model to Terra and applies a confirmed preference exactly once', async () => {
    const setting = await pool.query<{ value: string }>(
      "SELECT value #>> '{}' AS value FROM system_settings WHERE key='auto_dream_model'",
    )
    assert.equal(setting.rows[0]?.value, 'gpt-5.6-terra')

    const input = {
      userId: 1,
      proposalId: 'a'.repeat(32),
      targetId: 'preferences.theme',
      beforeFingerprint: hash(JSON.stringify('dark')),
      after: JSON.stringify('light'),
    }
    assert.deepEqual(await applyAutoDreamPreferenceAction(pool, input), {
      ok: true,
      result: 'setting applied',
    })
    assert.deepEqual(await applyAutoDreamPreferenceAction(pool, input), {
      ok: true,
      result: 'already applied',
    })
    const row = await pool.query<{ theme: string; receipts: string }>(
      `SELECT p.prefs->>'theme' AS theme,
              (SELECT COUNT(*)::text FROM auto_dream_action_receipts) AS receipts
         FROM user_preferences p WHERE p.user_id=1`,
    )
    assert.deepEqual(row.rows, [{ theme: 'light', receipts: '1' }])
  })

  maybe(
    'deduplicates retrying anonymous findings without inflating occurrence counts',
    async () => {
      const finding = {
        taxonomy: 'usability_friction',
        capabilityId: 'manage.skills',
        severity: 'medium' as const,
        title: '技能入口不明显',
        problem: '多次寻找技能设置',
        impact: '完成任务需要更多步骤',
        recommendation: '强化管理中心入口',
        signalCount: 3,
        evidenceHash: '',
      }
      finding.evidenceHash = hash(
        `${finding.taxonomy}\0${finding.capabilityId}\0${finding.title}\0${finding.problem}\0${finding.impact}\0${finding.recommendation}`,
      )
      const envelope = {
        subjectHash: 'b'.repeat(64),
        agentId: 'main',
        runId: '00000000-0000-4000-8000-000000000001',
        model: 'gpt-5.6-terra',
        findings: [finding],
      }
      await reportAutoDreamPlatformFindings(pool, envelope)
      await reportAutoDreamPlatformFindings(pool, envelope)
      await reportAutoDreamPlatformFindings(pool, {
        ...envelope,
        runId: '00000000-0000-4000-8000-000000000002',
      })
      const row = await pool.query<{
        occurrence_count: string
        affected_user_count: string
        occurrence_rows: string
      }>(
        `SELECT occurrence_count::text,affected_user_count::text,
              (SELECT COUNT(*)::text FROM auto_dream_platform_finding_occurrences) AS occurrence_rows
         FROM auto_dream_platform_findings`,
      )
      assert.deepEqual(row.rows, [
        { occurrence_count: '6', affected_user_count: '1', occurrence_rows: '2' },
      ])
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_name='auto_dream_platform_finding_occurrences'`,
      )
      assert.equal(
        columns.rows.some((column) => column.column_name === 'user_id'),
        false,
      )
      assert.equal(
        columns.rows.some((column) => column.column_name === 'subject_hash'),
        true,
      )
    },
  )
})
