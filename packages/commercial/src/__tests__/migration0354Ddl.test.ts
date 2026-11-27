import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseOrderDependency } from '../db/migrationOrder.js'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const commercialMigrationRelPath = 'packages/commercial/src/db/migrations/0350_commercial_three_layer_pool_unification.sql'
const selfhostMigrationRelPath = 'packages/commercial/src/db/migrations/0354_three_layer_pool_unification.sql'
const isCommercialMigration = existsSync(path.join(repo, commercialMigrationRelPath))
const migrationRelPath = isCommercialMigration ? commercialMigrationRelPath : selfhostMigrationRelPath
const expectedOrderDep = isCommercialMigration
  ? '0349_commercial_context_eval_observability'
  : '0353_context_eval_observability'
const migrationAbsPath = path.join(repo, migrationRelPath)

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
}

test('three_layer_pool_unification migration exists and declares expected order-dependency', () => {
  assert.equal(existsSync(migrationAbsPath), true, `missing migration file: ${migrationRelPath}`)
  const sql = readFileSync(migrationAbsPath, 'utf8')
  const firstLine = sql.split(/\r?\n/, 1)[0]?.trim()
  assert.equal(firstLine, `-- order-dependency: ${expectedOrderDep}`)

  const parsed = parseOrderDependency(sql)
  assert.equal(parsed.declared, true)
  assert.deepEqual(parsed.dependsOn, [expectedOrderDep])
})

test('0354 sets lock_timeout and defines all 6 three-layer pool tables with key constraints and indexes', () => {
  const sql = readFileSync(migrationAbsPath, 'utf8')
  const body = stripSqlComments(sql)

  assert.match(body, /SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'\s*;/i)

  const expectedTables = [
    'session_engine_pointers',
    'session_rolling_checkpoints',
    'session_placement_migrations',
    'artifact_blobs',
    'artifact_blob_uploads',
    'model_logical_pool_bindings',
  ]
  for (const table of expectedTables) {
    assert.match(
      body,
      new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, 'i'),
      `expected CREATE TABLE IF NOT EXISTS ${table}`,
    )
  }

  // Key constraints & indexes across the 6 tables
  assert.match(body, /PRIMARY\s+KEY\s*\(\s*user_id\s*,\s*session_key\s*\)/i)
  assert.match(
    body,
    /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_session_engine_pointers_pool_state\s+ON\s+session_engine_pointers\s*\(\s*pool_kind\s*,\s*migration_state\s*,\s*updated_at\s+DESC\s*\)/i,
  )

  assert.match(body, /PRIMARY\s+KEY\s*\(\s*user_id\s*,\s*session_key\s*,\s*checkpoint_generation\s*\)/i)
  assert.match(
    body,
    /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_session_rolling_checkpoints_pending\s+ON\s+session_rolling_checkpoints\s*\(\s*user_id\s*,\s*session_key\s*,\s*created_at\s+DESC\s*\)\s+WHERE\s+acked_at\s+IS\s+NULL/i,
  )

  assert.match(body, /CHECK\s*\(\s*to_epoch\s*=\s*from_epoch\s*\+\s*1\s*\)/i)
  assert.match(
    body,
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uidx_session_placement_migrations_inflight\s+ON\s+session_placement_migrations\s*\(\s*user_id\s*,\s*session_key\s*\)\s+WHERE\s+state\s*=\s*'migrating'/i,
  )
  assert.match(
    body,
    /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_session_placement_migrations_session\s+ON\s+session_placement_migrations\s*\(\s*user_id\s*,\s*session_key\s*,\s*created_at\s+DESC\s*\)/i,
  )

  assert.match(body, /sha256\s*~\s*'\^\[0-9a-f\]\{64\}\$'/i)
  assert.match(
    body,
    /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_artifact_blobs_tenant_sha\s+ON\s+artifact_blobs\s*\(\s*tenant_id\s*,\s*sha256\s*\)\s+WHERE\s+deleted_at\s+IS\s+NULL/i,
  )
  assert.match(
    body,
    /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_artifact_blobs_tenant_kind\s+ON\s+artifact_blobs\s*\(\s*tenant_id\s*,\s*kind\s*,\s*created_at\s+DESC\s*\)\s+WHERE\s+deleted_at\s+IS\s+NULL/i,
  )

  assert.match(body, /chunk_bytes\s+BETWEEN\s+65536\s+AND\s+16777216/i)
  assert.match(body, /chunk_count\s+BETWEEN\s+1\s+AND\s+4096/i)
  assert.match(
    body,
    /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_artifact_blob_uploads_tenant_status\s+ON\s+artifact_blob_uploads\s*\(\s*tenant_id\s*,\s*status\s*,\s*updated_at\s+DESC\s*\)/i,
  )

  assert.match(body, /UNIQUE\s*\(\s*logical_model_id\s*,\s*pool_kind\s*,\s*driver_id\s*\)/i)
  assert.match(
    body,
    /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_model_logical_pool_bindings_lookup\s+ON\s+model_logical_pool_bindings\s*\(\s*logical_model_id\s*,\s*enabled\s*,\s*priority\s+ASC\s*\)/i,
  )
})

test('0354 contains no destructive or non-additive DDL and passes migration safety gates', () => {
  const sql = readFileSync(migrationAbsPath, 'utf8')
  const body = stripSqlComments(sql)

  assert.doesNotMatch(body, /\bDROP\s+TABLE\b/i)
  assert.doesNotMatch(body, /\bTRUNCATE\b/i)
  assert.doesNotMatch(body, /\bALTER\s+TYPE\b/i)
  assert.doesNotMatch(body, /\bALTER\s+TABLE\b/i)
  assert.doesNotMatch(body, /\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i)
  assert.doesNotMatch(body, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/i)

  const ddlGate = spawnSync(
    'bash',
    ['-c', 'source scripts/lib/v5-migration-ddl.sh && sql_file_has_breaking_ddl "$1"', 'ddl', migrationRelPath],
    { cwd: repo, encoding: 'utf8' },
  )
  assert.equal(ddlGate.status, 1, `breaking DDL detected: ${ddlGate.stdout.trim()}`)
})
