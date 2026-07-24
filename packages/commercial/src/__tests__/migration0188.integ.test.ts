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
const PSEUDONYM_KEY = Buffer.alloc(32, 0x7a)

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
        capabilityId: 'manage.skills.10',
        severity: 'medium' as const,
        title: '易用性阻力 · manage.skills.10',
        problem: '聚合信号显示现有使用路径存在重复阻力。',
        impact: '可能增加完成任务的步骤。',
        recommendation: '结合匿名聚合信号审查 manage.skills.10，验证根因后规划最小充分改进。',
        signalCount: 3,
        evidenceHash: '',
      }
      finding.evidenceHash = hash(
        `${finding.taxonomy}\0${finding.capabilityId}\0${finding.title}\0${finding.problem}\0${finding.impact}\0${finding.recommendation}`,
      )
      assert.match(finding.evidenceHash, /15497914566/)
      const envelope = {
        subjectHash: 'b'.repeat(64),
        agentId: 'main',
        runId: '00000000-0000-4000-8000-000000000001',
        model: 'gpt-5.6-terra',
        findings: [finding],
        pseudonymKey: PSEUDONYM_KEY,
      }
      await reportAutoDreamPlatformFindings(pool, envelope)
      await reportAutoDreamPlatformFindings(pool, envelope)
      await reportAutoDreamPlatformFindings(pool, {
        ...envelope,
        findings: [{ ...finding, signalCount: 9 }],
      })
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

  maybe('pseudonymizes sensitive and derived capability identifiers before storage', async () => {
    const sensitiveCapability = 'access_token.352'
    const sensitive = {
      taxonomy: 'privacy',
      capabilityId: sensitiveCapability,
      severity: 'high' as const,
      title: `隐私审查 · ${sensitiveCapability}`,
      problem: '平台能力标识需要匿名聚合',
      impact: '管理员需要安全地查看聚合信号',
      recommendation: `审查 ${sensitiveCapability} 对应的平台能力`,
      signalCount: 2,
      evidenceHash: '',
    }
    sensitive.evidenceHash = hash(
      `${sensitive.taxonomy}\0${sensitive.capabilityId}\0${sensitive.title}\0${sensitive.problem}\0${sensitive.impact}\0${sensitive.recommendation}`,
    )
    await reportAutoDreamPlatformFindings(pool, {
      subjectHash: 'c'.repeat(64),
      agentId: 'main',
      runId: '00000000-0000-4000-8000-000000000003',
      model: 'gpt-5.6-terra',
      findings: [sensitive],
      pseudonymKey: PSEUDONYM_KEY,
    })

    const derivedCapability = `auto_dream.routing.${'0a'.repeat(16)}`
    const derived = {
      taxonomy: 'reliability',
      capabilityId: derivedCapability,
      severity: 'medium' as const,
      title: `可靠性 · ${derivedCapability}`,
      problem: '匿名聚合信号显示该能力需要平台审查',
      impact: '用户需要更稳定的完成路径',
      recommendation: `审查 ${derivedCapability} 并验证根因`,
      signalCount: 4,
      evidenceHash: '',
    }
    derived.evidenceHash = hash(
      `${derived.taxonomy}\0${derived.capabilityId}\0${derived.title}\0${derived.problem}\0${derived.impact}\0${derived.recommendation}`,
    )
    const derivedEnvelope = {
      subjectHash: 'd'.repeat(64),
      agentId: 'main',
      runId: '00000000-0000-4000-8000-000000000004',
      model: 'gpt-5.6-terra',
      findings: [derived],
      pseudonymKey: PSEUDONYM_KEY,
    }
    await reportAutoDreamPlatformFindings(pool, derivedEnvelope)
    await reportAutoDreamPlatformFindings(pool, derivedEnvelope)

    const rows = await pool.query<{
      capability_id: string
      title: string
      recommendation: string
      evidence_hash: string
    }>(
      `SELECT f.capability_id,f.title,f.recommendation,o.evidence_hash
         FROM auto_dream_platform_findings f
         JOIN auto_dream_platform_finding_occurrences o ON o.finding_id=f.id
        WHERE f.taxonomy IN ('privacy','reliability')
        ORDER BY f.taxonomy`,
    )
    assert.equal(rows.rows.length, 2)
    const privacy = rows.rows.find((row) => row.capability_id.startsWith('auto_dream.finding.'))
    assert.ok(privacy)
    assert.match(privacy.capability_id, /^auto_dream\.finding\.[abcdefijmnqtuvwy]{32}$/)
    assert.equal(JSON.stringify(privacy).includes(sensitiveCapability), false)
    assert.equal(
      privacy?.evidence_hash,
      hash(
        `privacy\0${privacy.capability_id}\0${privacy.title}\0平台能力标识需要匿名聚合\0管理员需要安全地查看聚合信号\0${privacy.recommendation}`,
      ),
    )
    assert.notEqual(privacy?.evidence_hash, sensitive.evidenceHash)

    const routing = rows.rows.find((row) => row.capability_id.startsWith('auto_dream.routing.'))
    assert.ok(routing)
    assert.match(routing.capability_id, /^auto_dream\.routing\.[abcdefijmnqtuvwy]{32}$/)
    assert.equal(JSON.stringify(routing).includes(derivedCapability), false)
    assert.notEqual(routing?.evidence_hash, derived.evidenceHash)
  })

  maybe('rejects independent sensitive copy and mismatched finding hashes', async () => {
    const base = {
      taxonomy: 'documentation',
      capabilityId: 'manage.rules',
      severity: 'low' as const,
      title: '规则说明',
      problem: '联系 13812345678 获取帮助',
      impact: '说明不清晰',
      recommendation: '改进规则说明',
      signalCount: 1,
      evidenceHash: '',
    }
    base.evidenceHash = hash(
      `${base.taxonomy}\0${base.capabilityId}\0${base.title}\0${base.problem}\0${base.impact}\0${base.recommendation}`,
    )
    const envelope = {
      subjectHash: 'e'.repeat(64),
      agentId: 'main',
      runId: '00000000-0000-4000-8000-000000000005',
      model: 'gpt-5.6-terra',
      findings: [base],
      pseudonymKey: PSEUDONYM_KEY,
    }
    await assert.rejects(
      reportAutoDreamPlatformFindings(pool, envelope),
      /AUTO_DREAM_INVALID_FINDING_SENSITIVE/,
    )
    await assert.rejects(
      reportAutoDreamPlatformFindings(pool, {
        ...envelope,
        findings: [{ ...base, problem: '说明不清晰' }],
      }),
      /AUTO_DREAM_INVALID_FINDING_HASH/,
    )
  })
})
