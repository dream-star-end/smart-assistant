/**
 * Immutable advisor consult records + snapshot JSON in one SQLite file.
 * CREATE IF NOT EXISTS only — does not touch delegate-jobs.db user_version.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

import Database from 'better-sqlite3'
import { paths } from '@openclaude/storage'

export type AdvisorConsultState =
  | 'accepted'
  | 'admission_attempt'
  | 'admission_unknown'
  | 'admitted'
  | 'spawned'
  | 'settled'
  | 'failed'
  | 'cancelled'

export type AdvisorConsultRecord = {
  consultId: string
  invocationId: string
  userId: string
  sessionKey: string
  clientSessionId: string
  originTurnKey: string
  originTurnIndex: number
  configVersion: string
  evidenceVersion: string
  advisorModel: string
  question: string
  concern: string
  snapshotJson: string
  jobId: string | null
  billingRequestId: string | null
  state: AdvisorConsultState
  createdAt: number
  updatedAt: number
}

const DDL = `
CREATE TABLE IF NOT EXISTS advisor_consults (
  consult_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  client_session_id TEXT NOT NULL,
  origin_turn_key TEXT NOT NULL,
  origin_turn_index INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  evidence_version TEXT NOT NULL,
  advisor_model TEXT NOT NULL,
  question TEXT NOT NULL,
  concern TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,
  job_id TEXT,
  billing_request_id TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_consults_invocation
  ON advisor_consults(user_id, origin_turn_key, invocation_id);
`

function rowToRecord(row: Record<string, unknown>): AdvisorConsultRecord {
  return {
    consultId: String(row.consult_id),
    invocationId: String(row.invocation_id),
    userId: String(row.user_id),
    sessionKey: String(row.session_key),
    clientSessionId: String(row.client_session_id),
    originTurnKey: String(row.origin_turn_key),
    originTurnIndex: Number(row.origin_turn_index),
    configVersion: String(row.config_version),
    evidenceVersion: String(row.evidence_version),
    advisorModel: String(row.advisor_model),
    question: String(row.question),
    concern: String(row.concern),
    snapshotJson: String(row.snapshot_json),
    jobId: row.job_id == null ? null : String(row.job_id),
    billingRequestId: row.billing_request_id == null ? null : String(row.billing_request_id),
    state: row.state as AdvisorConsultState,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function mintConsultId(now = Date.now()): string {
  return `advc-${now.toString(36)}-${randomBytes(6).toString('hex')}`
}

export function hashEvidence(snapshotJson: string): string {
  return createHash('sha256').update(snapshotJson).digest('hex')
}

export class AdvisorConsultStore {
  private readonly db: Database.Database

  constructor(dbPath = paths.advisorConsultsDb) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(DDL)
  }

  close(): void {
    this.db.close()
  }

  findByInvocation(input: {
    userId: string
    originTurnKey: string
    invocationId: string
  }): AdvisorConsultRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM advisor_consults
          WHERE user_id = ? AND origin_turn_key = ? AND invocation_id = ?`,
      )
      .get(input.userId, input.originTurnKey, input.invocationId) as
      | Record<string, unknown>
      | undefined
    return row ? rowToRecord(row) : undefined
  }

  /**
   * Insert consult + snapshot in one transaction. Unique invocation wins:
   * existing row is returned (caller must verify question/concern).
   */
  insertNew(record: AdvisorConsultRecord): { record: AdvisorConsultRecord; reused: boolean } {
    const existing = this.findByInvocation({
      userId: record.userId,
      originTurnKey: record.originTurnKey,
      invocationId: record.invocationId,
    })
    if (existing) return { record: existing, reused: true }
    try {
      const insert = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO advisor_consults (
              consult_id, invocation_id, user_id, session_key, client_session_id,
              origin_turn_key, origin_turn_index, config_version, evidence_version,
              advisor_model, question, concern, snapshot_json, job_id,
              billing_request_id, state, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            record.consultId,
            record.invocationId,
            record.userId,
            record.sessionKey,
            record.clientSessionId,
            record.originTurnKey,
            record.originTurnIndex,
            record.configVersion,
            record.evidenceVersion,
            record.advisorModel,
            record.question,
            record.concern,
            record.snapshotJson,
            record.jobId,
            record.billingRequestId,
            record.state,
            record.createdAt,
            record.updatedAt,
          )
        return this.findByInvocation(record)!
      })
      return { record: insert(), reused: false }
    } catch (err) {
      const reused = this.findByInvocation(record)
      if (reused) return { record: reused, reused: true }
      throw err
    }
  }

  update(consultId: string, patch: Partial<Pick<AdvisorConsultRecord, 'jobId' | 'billingRequestId' | 'state'>>): AdvisorConsultRecord {
    const current = this.db
      .prepare('SELECT * FROM advisor_consults WHERE consult_id = ?')
      .get(consultId) as Record<string, unknown> | undefined
    if (!current) throw new Error(`advisor consult not found: ${consultId}`)
    const next = {
      ...rowToRecord(current),
      ...patch,
      updatedAt: Date.now(),
    }
    this.db
      .prepare(
        `UPDATE advisor_consults
            SET job_id = ?, billing_request_id = ?, state = ?, updated_at = ?
          WHERE consult_id = ?`,
      )
      .run(next.jobId, next.billingRequestId, next.state, next.updatedAt, consultId)
    return next
  }
}
