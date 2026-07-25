import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

import {
  listAutoDreamPlatformFindings,
  reportAutoDreamPlatformFindings,
} from '../autoDream/optimizerStore.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0190_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION_0188 = path.resolve(here, '../db/migrations/0188_auto_dream_optimizer.sql')
const MIGRATION_0190 = path.resolve(here, '../db/migrations/0190_user_signal_quality.sql')
const PSEUDONYM_KEY = Buffer.alloc(32, 0x31)

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
  await pool.query(`
    CREATE TABLE users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL DEFAULT 'x',
      role TEXT NOT NULL DEFAULT 'user'
    );
    CREATE TABLE system_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE user_preferences (
      user_id BIGINT PRIMARY KEY REFERENCES users(id),
      prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE inbox_messages (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      level TEXT NOT NULL DEFAULT 'info',
      source_type TEXT,
      source_id BIGINT,
      source_phase TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE marketplace_installs (
      id BIGSERIAL PRIMARY KEY,
      uninstalled_at TIMESTAMPTZ
    );
    INSERT INTO system_settings(key,value)
      VALUES ('auto_dream_model','"deepseek-v4-flash"'::jsonb);
  `)
  await pool.query(await readFile(MIGRATION_0188, 'utf8'))
  await pool.query(`
    INSERT INTO users(email,role) VALUES
      ('member@example.com','user'),
      ('admin@example.com','admin'),
      ('v5-canary@claudeai.chat','user'),
      ('v5-evals@claudeai.chat','user');
    INSERT INTO inbox_messages(user_id,level,source_type,source_id,source_phase)
      VALUES (1,'notice','cron_delivery',1,'delivery-1');
    INSERT INTO marketplace_installs(uninstalled_at) VALUES (NOW());
    INSERT INTO auto_dream_platform_findings
      (fingerprint,taxonomy,capability_id,severity,title,problem,impact,recommendation,
       occurrence_count,affected_user_count,last_model,last_run_id)
    VALUES
      (
        repeat('a',64),'performance','routing.cache','medium','性能改进 · routing.cache',
        '聚合信号显示相关能力存在性能改进空间。','可能延长用户等待时间。',
        '结合匿名聚合信号审查 routing.cache，验证根因后规划最小充分改进。',
        1,1,'gpt-5.6-terra','00000000-0000-4000-8000-000000000001'
      );
    INSERT INTO auto_dream_platform_finding_occurrences
      (finding_id,subject_hash,run_id,agent_hash,signal_count,evidence_hash)
    VALUES
      (1,repeat('b',64),'00000000-0000-4000-8000-000000000001',
       repeat('c',64),1,repeat('d',64));
  `)
  await pool.query(await readFile(MIGRATION_0190, 'utf8'))
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

function finding(capabilityId: string) {
  const row = {
    taxonomy: 'usability_friction',
    capabilityId,
    severity: 'medium' as const,
    title: `易用性阻力 · ${capabilityId}`,
    problem: '聚合信号显示现有使用路径存在重复阻力。',
    impact: '可能增加完成任务的步骤。',
    recommendation: `结合匿名聚合信号审查 ${capabilityId}，验证根因后规划最小充分改进。`,
    signalCount: 3,
    evidenceHash: '',
  }
  row.evidenceHash = createHash('sha256')
    .update(
      `${row.taxonomy}\0${row.capabilityId}\0${row.title}\0${row.problem}\0${row.impact}\0${row.recommendation}`,
    )
    .digest('hex')
  return row
}

describe('0190_user_signal_quality', () => {
  maybe('backfills and continuously classifies production/admin/canary/e2e traffic', async () => {
    const rows = await pool.query<{ email: string; signal_traffic_class: string }>(
      'SELECT email,signal_traffic_class FROM users ORDER BY id',
    )
    assert.deepEqual(rows.rows, [
      { email: 'member@example.com', signal_traffic_class: 'production_user' },
      { email: 'admin@example.com', signal_traffic_class: 'internal_admin' },
      { email: 'v5-canary@claudeai.chat', signal_traffic_class: 'synthetic_canary' },
      { email: 'v5-evals@claudeai.chat', signal_traffic_class: 'e2e' },
    ])

    const inserted = await pool.query<{ id: string; signal_traffic_class: string }>(
      `INSERT INTO users(email,role)
       VALUES ('later-admin@example.com','admin')
       RETURNING id::text,signal_traffic_class`,
    )
    assert.equal(inserted.rows[0]?.signal_traffic_class, 'internal_admin')
    await pool.query("UPDATE users SET role='user' WHERE id=$1", [inserted.rows[0]?.id])
    assert.equal(
      (
        await pool.query<{ signal_traffic_class: string }>(
          'SELECT signal_traffic_class FROM users WHERE id=$1',
          [inserted.rows[0]?.id],
        )
      ).rows[0]?.signal_traffic_class,
      'production_user',
    )
  })

  maybe(
    'backfills Auto-Dream occurrence model/traffic and persists raw signals idempotently',
    async () => {
      const occurrence = await pool.query<{ model: string; traffic_class: string }>(
        'SELECT model,traffic_class FROM auto_dream_platform_finding_occurrences WHERE finding_id=1',
      )
      assert.deepEqual(occurrence.rows, [
        { model: 'gpt-5.6-terra', traffic_class: 'production_user' },
      ])
      await pool.query(
        `INSERT INTO auto_dream_platform_finding_occurrences
         (finding_id,subject_hash,run_id,agent_hash,signal_count,evidence_hash)
       VALUES
         (1,repeat('b',64),'00000000-0000-4000-8000-000000000003',
          repeat('1',64),1,repeat('2',64))`,
      )
      const legacyWrite = await pool.query<{ model: string; traffic_class: string }>(
        `SELECT model,traffic_class
         FROM auto_dream_platform_finding_occurrences
        WHERE run_id='00000000-0000-4000-8000-000000000003'`,
      )
      assert.deepEqual(legacyWrite.rows, [{ model: 'unknown', traffic_class: 'production_user' }])

      const underscoreRaw = finding('manage_skills')
      const hyphenRaw = finding('tool-market')
      const envelope = {
        subjectHash: 'e'.repeat(64),
        agentId: 'main',
        runId: '00000000-0000-4000-8000-000000000002',
        model: 'deepseek-v4-flash',
        findings: [],
        rawFindings: [underscoreRaw, hyphenRaw],
        trafficClass: 'production_user' as const,
        pseudonymKey: PSEUDONYM_KEY,
      }
      await reportAutoDreamPlatformFindings(pool, envelope)
      await reportAutoDreamPlatformFindings(pool, envelope)
      const stored = await pool.query<{
        count: string
        model: string
        traffic_class: string
        signal_count: number
      }>(
        `SELECT COUNT(*)::text AS count,MAX(model) AS model,
              MAX(traffic_class) AS traffic_class,MAX(signal_count)::int AS signal_count
         FROM auto_dream_platform_raw_signals`,
      )
      assert.deepEqual(stored.rows, [
        {
          count: '2',
          model: 'deepseek-v4-flash',
          traffic_class: 'production_user',
          signal_count: 3,
        },
      ])
      const capabilityIds = await pool.query<{ capability_id: string }>(
        'SELECT capability_id FROM auto_dream_platform_raw_signals ORDER BY capability_id',
      )
      assert.deepEqual(capabilityIds.rows, [
        { capability_id: 'manage_skills' },
        { capability_id: 'tool-market' },
      ])
    },
  )

  maybe(
    'filters themes by occurrence model/traffic and labels single-source evidence',
    async () => {
      const all = await listAutoDreamPlatformFindings(pool, {
        status: 'all',
        limit: 20,
        offset: 0,
        trafficClass: 'production_user',
        model: 'all',
      })
      assert.equal(all.total, 1)
      assert.equal(all.rows[0]?.run_count, '2')
      assert.equal(all.rows[0]?.evidence_confidence, 'single_source')

      const current = await listAutoDreamPlatformFindings(pool, {
        status: 'all',
        limit: 20,
        offset: 0,
        trafficClass: 'production_user',
        model: 'current',
      })
      assert.equal(current.model, 'gpt-5.6-terra')
      assert.equal(current.total, 1)

      const admin = await listAutoDreamPlatformFindings(pool, {
        status: 'all',
        limit: 20,
        offset: 0,
        trafficClass: 'internal_admin',
        model: 'all',
      })
      assert.equal(admin.total, 0)
    },
  )

  maybe('backfills inbox category/thread and adds optional uninstall attribution', async () => {
    const inbox = await pool.query<{
      category: string
      thread_key: string
    }>('SELECT category,thread_key FROM inbox_messages WHERE id=1')
    assert.deepEqual(inbox.rows, [{ category: 'automation', thread_key: 'cron:user:1' }])
    const install = await pool.query<{ uninstall_reason: string | null }>(
      'SELECT uninstall_reason FROM marketplace_installs WHERE id=1',
    )
    assert.deepEqual(install.rows, [{ uninstall_reason: null }])
  })
})
