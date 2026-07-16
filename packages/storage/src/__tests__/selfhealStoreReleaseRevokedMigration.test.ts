import * as assert from 'node:assert/strict'
/**
 * ALTER-path schema guard for selfheal.db (HIGH3): a DB created AFTER the
 * cancelling rebuild but BEFORE the release_revoked fuse (current CHECK, no
 * fuse column) must transparently gain `release_revoked INTEGER NOT NULL
 * DEFAULT 0` on open, preserving all rows. Separate test file on purpose — the
 * pre-fuse DB must exist BEFORE the store module is first imported (singleton
 * per process); the sibling selfhealStoreMigration.test.ts covers the full
 * rebuild path where the old DB lacks BOTH 'cancelling' and the fuse.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/selfhealStoreReleaseRevokedMigration.test.ts
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import Database from 'better-sqlite3'

const testHome = await mkdtemp(join(tmpdir(), 'oc-selfheal-mig-rr-'))
process.env.OPENCLAUDE_HOME = testHome

// Pre-create the post-cancelling / pre-fuse schema + a row.
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
                     CHECK (status IN ('received','starting','running','cancelling','succeeded','failed','cancelled')),
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
    VALUES ('prefuse-1', 'inc-p', 1, 'hash-p', NULL, 'succeeded', NULL, 0, 'selfheal:prefuse-1', 100, 200);
  `)
  db.close()
}

const { closeSelfhealDb, getJob, getSelfhealDb, setJobReleaseRevoked } = await import(
  '../selfhealStore.js'
)

after(async () => {
  await closeSelfhealDb()
})

describe('selfheal_jobs release_revoked ALTER guard', () => {
  it('adds the fuse column on open, preserving the row (default = not revoked)', async () => {
    const job = await getJob('prefuse-1')
    assert.ok(job)
    assert.equal(job?.status, 'succeeded')
    assert.equal(job?.incidentId, 'inc-p')
    assert.equal(job?.releaseRevoked, false)
  })

  it("the cancelling rebuild guard did NOT run (table wasn't rebuilt needlessly)", async () => {
    const db = await getSelfhealDb()
    const cols = db.prepare('PRAGMA table_info(selfheal_jobs)').all() as { name: string }[]
    // ALTER appends: release_revoked then condition_key trail the table here,
    // unlike the canonical DDL order (…, condition_key, created_at,
    // updated_at) — proof the cheap ALTER path ran twice, not a rebuild.
    assert.deepEqual(
      cols.slice(-2).map((c) => c.name),
      ['release_revoked', 'condition_key'],
    )
  })

  it('the fuse is writable after the ALTER', async () => {
    assert.equal(await setJobReleaseRevoked('prefuse-1'), true)
    assert.equal((await getJob('prefuse-1'))?.releaseRevoked, true)
  })
})
