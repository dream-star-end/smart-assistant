import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0149_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0149_audit_hardening.sql')

let pool: Pool
let sql = ''
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
  pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path=${SCHEMA}` })
  sql = await readFile(MIGRATION, 'utf8')

  await pool.query(`
    CREATE TABLE agent_audit (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, session_id TEXT NOT NULL,
      tool TEXT NOT NULL, input_meta JSONB NOT NULL DEFAULT '{}', input_hash TEXT,
      output_hash TEXT, duration_ms INTEGER, success BOOLEAN NOT NULL, error_msg TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE admin_audit (
      id BIGSERIAL PRIMARY KEY, admin_id BIGINT NOT NULL, action TEXT NOT NULL,
      target TEXT, before JSONB, after JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE RULE aa_admin_no_update AS ON UPDATE TO admin_audit DO INSTEAD NOTHING;
    CREATE RULE aa_admin_no_delete AS ON DELETE TO admin_audit DO INSTEAD NOTHING;
    CREATE TABLE compute_hosts (id UUID PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE compute_host_audit (
      id BIGSERIAL PRIMARY KEY, host_id UUID, operation TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}', ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
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

describe('0149_audit_hardening', () => {
  maybe('sanitizes previews and deletes only the exact synthetic row', async () => {
    await pool.query(`
      INSERT INTO agent_audit(
        id,user_id,session_id,tool,input_meta,input_hash,output_hash,duration_ms,success,error_msg,created_at
      ) VALUES
      (1,1,'smoke-session','SmokeFailTool',
       '{"event_id":"smoke-toolfail-20260704T035926Z-17624","input_preview":"synthetic"}',
       '3f48d11458e37cd22c904295e44cb2e10fec3d19095046a0c9197efb3c5286c7',
       '5a7b95680e4927822f251565ff1da4ea64c62a49f19a0177984ceeb5a741f17d',
       7,false,'failed',TIMESTAMPTZ '2026-07-04 03:59:27.74854+00'),
      (2,2,'real-session','SmokeFailTool','{"event_id":"real","input_preview":"email=x@example.com"}',
       NULL,NULL,9,false,'command not found',NOW()),
      (3,2,'enoent-session','Glob','{"event_id":"enoent","input_preview":"/private/path"}',
       NULL,NULL,10,false,'spawn /vendor/rg ENOENT',NOW());
    `)
    await pool.query(sql)
    await pool.query(`
      INSERT INTO agent_audit(
        id,user_id,session_id,tool,input_meta,duration_ms,success,error_msg
      ) VALUES (
        4,2,'rolling-v1','Bash',
        '{"event_id":"rolling","input_preview":"token=secret","error_class":"private free form"}',
        11,false,'request timed out after 30s'
      )
    `)

    const rows = await pool.query<{
      id: string
      input_meta: Record<string, unknown>
      error_msg: string | null
    }>('SELECT id::text,input_meta,error_msg FROM agent_audit ORDER BY id')
    assert.deepEqual(
      rows.rows.map((row) => row.id),
      ['2', '3', '4'],
    )
    assert.equal(rows.rows[0].input_meta.error_class, 'command_not_found')
    assert.equal(rows.rows[1].input_meta.error_class, 'file_not_found')
    assert.equal(rows.rows[2].input_meta.error_class, 'timeout')
    for (const row of rows.rows) {
      assert.equal('input_preview' in row.input_meta, false)
      assert.equal(row.error_msg, null)
    }
  })

  maybe('normalizes narrow admin formats and restores append-only rules', async () => {
    await pool.query(`
      INSERT INTO admin_audit(admin_id,action,target,before,after) VALUES
        (1,'feedback.ack','9','{"status":"open"}','{"status":"acked"}'),
        (1,'feedback.ack','feedback:10','{"status":"open"}','{"status":"acked"}'),
        (1,'compute_host.remove','compute_host:x',NULL,NULL);
    `)
    await pool.query(sql)
    const rows = await pool.query<{ action: string; target: string; after: unknown }>(
      'SELECT action,target,after FROM admin_audit ORDER BY id',
    )
    assert.equal(rows.rows[0].target, 'feedback:9')
    assert.equal(rows.rows[1].target, 'feedback:10')
    assert.deepEqual(rows.rows[2].after, { removed: true })

    await pool.query("UPDATE admin_audit SET target='tampered' WHERE id=1")
    const protectedRow = await pool.query('SELECT target FROM admin_audit WHERE id=1')
    assert.equal(protectedRow.rows[0].target, 'feedback:9')
  })

  maybe('removes only contiguous duplicate self init rows and pool.init.done', async () => {
    const self = '00000000-0000-0000-0000-000000000001'
    const other = '00000000-0000-0000-0000-000000000002'
    await pool.query("INSERT INTO compute_hosts(id,name) VALUES ($1,'self'),($2,'other')", [
      self,
      other,
    ])
    await pool.query(
      `
      INSERT INTO compute_host_audit(host_id,operation,detail,ts) VALUES
        ($1,'image.loaded','{"source":"pool.init.self","imageId":"sha256:a"}','2026-01-01 00:00:01+00'),
        ($1,'image.loaded','{"source":"pool.init.self","imageId":"sha256:a"}','2026-01-01 00:00:02+00'),
        ($1,'image.loaded','{"source":"distribute","imageId":"sha256:a"}','2026-01-01 00:00:03+00'),
        ($1,'image.loaded','{"source":"pool.init.self","imageId":"sha256:a"}','2026-01-01 00:00:04+00'),
        ($1,'image.loaded','{"source":"pool.init.self","imageId":"sha256:b"}','2026-01-01 00:00:05+00'),
        ($1,'image.loaded','{"source":"pool.init.self","imageId":"sha256:b"}','2026-01-01 00:00:06+00'),
        (NULL,'pool.init.done','{}','2026-01-01 00:00:07+00'),
        ($2,'image.loaded','{"source":"pool.init.self","imageId":"sha256:z"}','2026-01-01 00:00:08+00'),
        ($2,'image.loaded','{"source":"pool.init.self","imageId":"sha256:z"}','2026-01-01 00:00:09+00')
    `,
      [self, other],
    )
    await pool.query(sql)

    const selfRows = await pool.query<{ source: string; image: string }>(
      `SELECT detail->>'source' AS source,detail->>'imageId' AS image
         FROM compute_host_audit WHERE host_id=$1 ORDER BY ts,id`,
      [self],
    )
    assert.deepEqual(selfRows.rows, [
      { source: 'pool.init.self', image: 'sha256:a' },
      { source: 'distribute', image: 'sha256:a' },
      { source: 'pool.init.self', image: 'sha256:a' },
      { source: 'pool.init.self', image: 'sha256:b' },
    ])
    const counts = await pool.query<{ done: string; other: string }>(
      `SELECT COUNT(*) FILTER (WHERE operation='pool.init.done')::text AS done,
              COUNT(*) FILTER (WHERE host_id=$1)::text AS other
         FROM compute_host_audit`,
      [other],
    )
    assert.deepEqual(counts.rows[0], { done: '0', other: '2' })
  })

  maybe('is idempotent on a second application', async () => {
    await pool.query(sql)
  })
})
