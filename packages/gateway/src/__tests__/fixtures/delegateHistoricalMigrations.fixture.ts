/** Historical migration SQL snapshot from 4399b2459e13e02b59fdc9198201966e3729177d:delegateDurable.ts.
 * Apply the original complete 5..11 DDL prefix to an actual original-v4 DB.
 * This is an exact-shape fixture, not an old binary and not version-only spoofing.
 * Keep these SQL literals frozen; current product migration changes must not edit them.
 */
import Database from 'better-sqlite3'
const DDL_V5 = `
ALTER TABLE delegate_jobs ADD COLUMN failure_inbox_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (failure_inbox_enabled IN (0, 1));
CREATE TABLE delegate_failure_inbox (
  job_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL CHECK (length(user_id) > 0),
  parent_session TEXT NOT NULL CHECK (length(parent_session) > 0),
  child_session TEXT,
  summary_code TEXT NOT NULL,
  summary_text TEXT NOT NULL CHECK (length(summary_text) <= 256),
  failed_at INTEGER NOT NULL,
  ack_at INTEGER,
  PRIMARY KEY (job_id, generation)
);
CREATE INDEX idx_delegate_failure_unacked
  ON delegate_failure_inbox(user_id, failed_at DESC, job_id DESC, generation DESC)
  WHERE ack_at IS NULL;
`

const DDL_V6 = `
ALTER TABLE delegate_jobs ADD COLUMN delivery_receipt_context TEXT;
CREATE TABLE delegate_delivery_receipt (
  job_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  parent_session TEXT NOT NULL,
  parent_turn_key TEXT NOT NULL,
  native_tool_use_id TEXT NOT NULL,
  receipt_nonce_hash TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offered'
    CHECK(state IN ('offered','ingest_claimed','ingested','notify_pending','notify_claimed','notified')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(job_id, generation)
);
CREATE INDEX idx_delegate_receipt_pending ON delegate_delivery_receipt(parent_session, state, created_at);
`

const DDL_V7 = `
ALTER TABLE delegate_delivery_receipt ADD COLUMN owner_token TEXT;
ALTER TABLE delegate_delivery_receipt ADD COLUMN parent_owner_epoch TEXT;
ALTER TABLE delegate_delivery_receipt ADD COLUMN input_proof TEXT;
`

const DDL_V9 = `
CREATE TABLE delegate_retry_source (
  job_id TEXT NOT NULL, generation INTEGER NOT NULL, user_id TEXT NOT NULL,
  parent_client_session_id TEXT, parent_session TEXT, child_session TEXT, target_agent_id TEXT,
  metadata_json TEXT, created_at INTEGER NOT NULL, retired_at INTEGER,
  PRIMARY KEY(job_id,generation)
);
CREATE INDEX idx_delegate_retry_source_parent ON delegate_retry_source(user_id,parent_client_session_id)
  WHERE retired_at IS NULL;
CREATE TABLE delegate_retry_parent_fence (
  user_id TEXT NOT NULL, client_session_id TEXT NOT NULL, deleted_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,client_session_id)
);
CREATE TABLE delegate_retry_action (
  user_id TEXT NOT NULL, source_job_id TEXT NOT NULL, generation INTEGER NOT NULL,
  action_id TEXT NOT NULL, target_job_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, dispatched_at INTEGER, terminal_code TEXT,
  PRIMARY KEY(user_id,source_job_id,generation,action_id)
);
`

export function migrateOriginalV4Prefix(path: string, target: number): void {
  if (!Number.isSafeInteger(target) || target < 5 || target > 11) throw new Error('historical target must be 5..11')
  const db = new Database(path)
  db.function('oc_delegate_schema10', () => 10)
  try {
    db.transaction(() => {
      const current = Number(db.pragma('user_version', { simple: true }))
      if (current !== 4) throw new Error('requires actual original-v4 starting schema')
      if (current < 5 && target >= 5) db.exec(DDL_V5)
      if (current < 6 && target >= 6) db.exec(DDL_V6)
      if (current < 7 && target >= 7) db.exec(DDL_V7)
      if (current < 8 && target >= 8) db.exec(`CREATE INDEX idx_delegate_user_active ON delegate_jobs(callback_origin_user_id,state) WHERE retired_at IS NULL`)
      if (current < 9 && target >= 9) db.exec(DDL_V9)
      if (current < 10 && target >= 10) {
        db.exec(`ALTER TABLE delegate_retry_source ADD COLUMN storage_user_id TEXT;
          UPDATE delegate_retry_source SET storage_user_id=user_id;
          CREATE INDEX idx_delegate_retry_source_storage_parent
            ON delegate_retry_source(storage_user_id,parent_client_session_id) WHERE retired_at IS NULL;
          CREATE INDEX idx_delegate_retry_source_public ON delegate_retry_source(user_id,retired_at,job_id,generation);`)
        // This is a compatibility fence, not a credential. Do not remove it to
        // force a downgrade: old physical/public interpretation is incompatible.
        for (const table of ['delegate_jobs', 'delegate_retry_source', 'delegate_retry_action', 'delegate_retry_parent_fence', 'delegate_failure_inbox']) {
          for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`
            CREATE TRIGGER identity_v10_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
            BEGIN SELECT CASE WHEN oc_delegate_schema10() IS NOT 10
              THEN RAISE(ABORT,'delegate identity schema10 writer required') END; END;`)
        }
      }
      if (current < 11 && target >= 11) {
        // Bun's native SQLite has no UDF registration. These are precisely the
        // original receipt coordinator's jobs writes; its physical barrier,
        // binding and paired receipt/job CAS still enforce delivery ownership.
        // Identity/result/state/retirement and every other current column stay
        // fenced. Future column-adding migrations MUST rebuild this trigger.
        const bookkeeping = new Set(['callback', 'callback_state', 'callback_epoch',
          'notify_retry_at', 'notify_delivery_token', 'notify_claimed_until',
          'last_activity_at', 'updated_at', 'notify_attempt', 'notify_a_attempted_at'])
        const protectedColumns = (db.prepare('PRAGMA table_info(delegate_jobs)').all() as Array<{ name: string }>)
          .map(row => row.name).filter(name => !bookkeeping.has(name))
          .map(name => '"' + name.replaceAll('"', '""') + '"')
        db.exec(`DROP TRIGGER identity_v10_delegate_jobs_update;
          CREATE TRIGGER identity_v10_delegate_jobs_update BEFORE UPDATE OF ${protectedColumns.join(',')} ON delegate_jobs
          BEGIN SELECT CASE WHEN oc_delegate_schema10() IS NOT 10
            THEN RAISE(ABORT,'delegate identity schema10 writer required') END; END;`)
      }

      db.pragma(`user_version = ${target}`)
    }).immediate()
  } finally { db.close() }
}
