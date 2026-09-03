/**
 * 0257 Cursor account-session credential columns on claude_accounts.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0257.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('cursor_session_0257_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0257_cursor_session_credential.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

const MACHINE_ID = 'abcdefghijklmnopqrstuvwxyz'

type InsertOpts = {
  label: string
  provider?: string
  sand?: boolean | null
  kind?: 'api_key' | 'session' | string
  machineId?: string | null
  authId?: string | null
}

/** Minimal claude_accounts row; 0257 columns are only written when explicitly provided. */
async function insertAccount(opts: InsertOpts): Promise<{ kind: string; machine_id: string | null; auth_id: string | null }> {
  const cols = ['provider', 'label', 'plan', 'oauth_token_enc', 'oauth_nonce', 'runtime_channel', 'persona', 'cursor_sand_enabled']
  const vals: string[] = [
    `'${opts.provider ?? 'cursor'}'`,
    `'${opts.label}'`,
    `'max'`,
    `decode('00','hex')`,
    `decode('000000000000000000000000','hex')`,
    `'v5'`,
    `'{}'::jsonb`,
    opts.sand === undefined || opts.sand === null ? 'NULL' : opts.sand ? 'TRUE' : 'FALSE',
  ]
  if (opts.kind !== undefined) {
    cols.push('cursor_credential_kind')
    vals.push(`'${opts.kind}'`)
  }
  if (opts.machineId !== undefined) {
    cols.push('cursor_machine_id')
    vals.push(opts.machineId === null ? 'NULL' : `'${opts.machineId}'`)
  }
  if (opts.authId !== undefined) {
    cols.push('cursor_auth_id')
    vals.push(opts.authId === null ? 'NULL' : `'${opts.authId}'`)
  }
  const r = await query<{ kind: string; machine_id: string | null; auth_id: string | null }>(
    `INSERT INTO claude_accounts(${cols.join(', ')}) VALUES (${vals.join(', ')})
     RETURNING cursor_credential_kind AS kind, cursor_machine_id AS machine_id, cursor_auth_id AS auth_id`,
  )
  return r.rows[0]!
}

async function constraintNames(): Promise<string[]> {
  const r = await query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'claude_accounts'::regclass
        AND conname LIKE 'claude_accounts_cursor_%'
      ORDER BY conname`,
  )
  return r.rows.map((row) => row.conname)
}

describe('0257_cursor_session_credential', () => {
  test('adds kind/machine id/auth id columns with api_key default and shape CHECKs', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0257')

    // Pre-image: a Sand api-key row created before the migration.
    await query(
      `INSERT INTO claude_accounts(provider, label, plan, oauth_token_enc, oauth_nonce, runtime_channel, persona, cursor_sand_enabled)
       VALUES ('cursor', 'pre-0257-sand', 'max', decode('00','hex'), decode('000000000000000000000000','hex'), 'v5', '{}'::jsonb, TRUE)`,
    )

    const sql = await readFile(migrationPath, 'utf8')
    await query(sql)

    const cols = await query<{ column_name: string; column_default: string | null; is_nullable: string; data_type: string }>(
      `SELECT column_name, column_default, is_nullable, data_type
         FROM information_schema.columns
        WHERE table_name = 'claude_accounts'
          AND column_name IN ('cursor_credential_kind', 'cursor_machine_id', 'cursor_auth_id')
        ORDER BY column_name`,
    )
    assert.deepEqual(
      cols.rows.map((c) => c.column_name),
      ['cursor_auth_id', 'cursor_credential_kind', 'cursor_machine_id'],
    )
    const kind = cols.rows.find((c) => c.column_name === 'cursor_credential_kind')!
    assert.equal(kind.is_nullable, 'NO')
    assert.equal(kind.data_type, 'text')
    assert.match(kind.column_default ?? '', /api_key/)
    for (const name of ['cursor_machine_id', 'cursor_auth_id']) {
      const c = cols.rows.find((row) => row.column_name === name)!
      assert.equal(c.is_nullable, 'YES', name)
      assert.equal(c.column_default, null, name)
    }

    // Existing rows are backfilled by the default and pass the shape check.
    const pre = await query<{ kind: string; machine_id: string | null }>(
      `SELECT cursor_credential_kind AS kind, cursor_machine_id AS machine_id
         FROM claude_accounts WHERE label = 'pre-0257-sand'`,
    )
    assert.deepEqual(pre.rows[0], { kind: 'api_key', machine_id: null })

    assert.deepEqual(await constraintNames(), [
      'claude_accounts_cursor_credential_kind_check',
      'claude_accounts_cursor_session_shape_check',
    ])

    // Default path: a new cursor row without 0257 columns is an api_key row.
    assert.deepEqual(await insertAccount({ label: 'default-kind', sand: true }), {
      kind: 'api_key',
      machine_id: null,
      auth_id: null,
    })

    // Valid session row.
    assert.deepEqual(
      await insertAccount({ label: 'session-ok', sand: true, kind: 'session', machineId: MACHINE_ID, authId: 'auth0|user_01' }),
      { kind: 'session', machine_id: MACHINE_ID, auth_id: 'auth0|user_01' },
    )
    // authId is optional for session rows.
    assert.equal(
      (await insertAccount({ label: 'session-no-auth', sand: true, kind: 'session', machineId: MACHINE_ID })).auth_id,
      null,
    )

    // Closed enum.
    await assert.rejects(
      insertAccount({ label: 'bogus-kind', sand: true, kind: 'bogus' }),
      /claude_accounts_cursor_credential_kind_check/,
    )
    // Session rows must carry a machine id ...
    await assert.rejects(
      insertAccount({ label: 'session-no-machine', sand: true, kind: 'session' }),
      /claude_accounts_cursor_session_shape_check/,
    )
    await assert.rejects(
      insertAccount({ label: 'session-empty-machine', sand: true, kind: 'session', machineId: '' }),
      /claude_accounts_cursor_session_shape_check/,
    )
    // ... be Sand-enabled ...
    await assert.rejects(
      insertAccount({ label: 'session-no-sand', sand: false, kind: 'session', machineId: MACHINE_ID }),
      /claude_accounts_cursor_session_shape_check/,
    )
    await assert.rejects(
      insertAccount({ label: 'session-null-sand', sand: null, kind: 'session', machineId: MACHINE_ID }),
      /claude_accounts_cursor_session_shape_check/,
    )
    // ... and live on provider=cursor only.
    await assert.rejects(
      insertAccount({ label: 'session-claude', provider: 'claude', sand: true, kind: 'session', machineId: MACHINE_ID }),
      /claude_accounts_cursor_session_shape_check/,
    )
    // API-key rows never carry session-only metadata.
    await assert.rejects(
      insertAccount({ label: 'apikey-machine', sand: true, kind: 'api_key', machineId: MACHINE_ID }),
      /claude_accounts_cursor_session_shape_check/,
    )
    await assert.rejects(
      insertAccount({ label: 'apikey-auth', sand: true, kind: 'api_key', authId: 'auth0|user_01' }),
      /claude_accounts_cursor_session_shape_check/,
    )
    // Flipping Sand off on a session row is refused at the DB layer too.
    await assert.rejects(
      query(`UPDATE claude_accounts SET cursor_sand_enabled = FALSE WHERE label = 'session-ok'`),
      /claude_accounts_cursor_session_shape_check/,
    )

    // Replay is idempotent: no duplicate constraints, rows untouched.
    await query(sql)
    assert.deepEqual(await constraintNames(), [
      'claude_accounts_cursor_credential_kind_check',
      'claude_accounts_cursor_session_shape_check',
    ])
    const after = await query<{ kind: string; machine_id: string | null }>(
      `SELECT cursor_credential_kind AS kind, cursor_machine_id AS machine_id
         FROM claude_accounts WHERE label = 'session-ok'`,
    )
    assert.deepEqual(after.rows[0], { kind: 'session', machine_id: MACHINE_ID })

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { requiredMigrations: string[] }
    assert.ok(metadata.requiredMigrations.includes('0257_cursor_session_credential'))
  })
})
