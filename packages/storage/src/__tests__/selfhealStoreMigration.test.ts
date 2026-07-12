import * as assert from 'node:assert/strict'
/**
 * Schema rebuild guard for selfheal.db (block C / design §A2): a DB created by
 * the pre-cancelling schema (status CHECK without 'cancelling') must be
 * transparently rebuilt on open, preserving all rows, and then accept the
 * 'cancelling' state. Separate test file on purpose — the old-schema DB must
 * exist BEFORE the store module is first imported (singleton per process).
 *
 * Run: npx tsx --test packages/storage/src/__tests__/selfhealStoreMigration.test.ts
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import Database from 'better-sqlite3'

const testHome = await mkdtemp(join(tmpdir(), 'oc-selfheal-mig-'))
process.env.OPENCLAUDE_HOME = testHome

// Pre-create the OLD schema (no 'cancelling' in the CHECK) + a legacy row.
{
  const db = new Database(join(testHome, 'selfheal.db'))
  db.exec(`
    CREATE TABLE selfheal_jobs (
      repair_id    TEXT PRIMARY KEY,
      incident_id  TEXT NOT NULL,
      attempt      INTEGER NOT NULL DEFAULT 0,
      payload_hash TEXT NOT NULL,
      capability   TEXT,
      status       TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','starting','running','succeeded','failed','cancelled')),
      lease_owner  TEXT,
      lease_until  INTEGER NOT NULL DEFAULT 0,
      session_key  TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_selfheal_jobs_status ON selfheal_jobs(status);
    CREATE INDEX idx_selfheal_jobs_lease ON selfheal_jobs(status, lease_until);
    INSERT INTO selfheal_jobs
      (repair_id, incident_id, attempt, payload_hash, capability, status, lease_owner, lease_until, session_key, created_at, updated_at)
    VALUES ('legacy-1', 'inc-legacy', 2, 'hash-legacy', 'cap-legacy', 'running', 'old-owner', 123, 'selfheal:legacy-1', 100, 200);
  `)
  db.close()
}

const { closeSelfhealDb, getJob, getSelfhealDb, setJobStatus } = await import('../selfhealStore.js')

after(async () => {
  await closeSelfhealDb()
})

describe('selfheal_jobs cancelling-CHECK rebuild guard', () => {
  it('rebuilds the old schema on open and preserves the legacy row verbatim', async () => {
    const job = await getJob('legacy-1')
    assert.ok(job)
    assert.equal(job?.status, 'running')
    assert.equal(job?.incidentId, 'inc-legacy')
    assert.equal(job?.attempt, 2)
    assert.equal(job?.payloadHash, 'hash-legacy')
    assert.equal(job?.capability, 'cap-legacy')
    assert.equal(job?.leaseOwner, 'old-owner')
    assert.equal(job?.leaseUntil, 123)
    assert.equal(job?.sessionKey, 'selfheal:legacy-1')
    assert.equal(job?.createdAt, 100)
    assert.equal(job?.updatedAt, 200)
    // The rebuild target carries the newer release_revoked fuse column too
    // (HIGH3) — legacy rows take the default (not revoked).
    assert.equal(job?.releaseRevoked, false)
  })

  it("the rebuilt CHECK accepts 'cancelling'", async () => {
    assert.equal(await setJobStatus('legacy-1', 'cancelling', ['running']), true)
    assert.equal((await getJob('legacy-1'))?.status, 'cancelling')
  })

  it('the rebuild is idempotent (sql now contains cancelling; indexes exist)', async () => {
    const db = await getSelfhealDb()
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'selfheal_jobs'")
      .get() as { sql: string }
    assert.ok(row.sql.includes("'cancelling'"))
    assert.ok(row.sql.includes('release_revoked'), 'rebuild target includes the fuse column')
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'selfheal_jobs'")
      .all() as { name: string }[]
    const names = indexes.map((i) => i.name)
    assert.ok(names.includes('idx_selfheal_jobs_status'))
    assert.ok(names.includes('idx_selfheal_jobs_lease'))
  })

  it('the new callback outbox table exists on an upgraded DB', async () => {
    const db = await getSelfhealDb()
    const t = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'selfheal_callback_outbox'",
      )
      .get() as { name: string } | undefined
    assert.equal(t?.name, 'selfheal_callback_outbox')
  })
})
