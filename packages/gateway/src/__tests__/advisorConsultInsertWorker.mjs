import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const { dbPath, record } = workerData
mkdirSync(dirname(dbPath), { recursive: true })
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
let reused = false
let consultId = record.consultId
try {
  db.prepare(
    `INSERT INTO advisor_consults (
      consult_id, invocation_id, user_id, session_key, client_session_id,
      origin_turn_key, origin_turn_index, config_version, evidence_version,
      advisor_model, question, concern, snapshot_json, job_id,
      billing_request_id, advice, state, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
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
    record.advice ?? null,
    record.state,
    record.createdAt,
    record.updatedAt,
  )
} catch {
  const row = db
    .prepare(
      `SELECT consult_id FROM advisor_consults
        WHERE user_id = ? AND origin_turn_key = ? AND invocation_id = ?`,
    )
    .get(record.userId, record.originTurnKey, record.invocationId)
  reused = true
  consultId = row?.consult_id ?? consultId
}
parentPort.postMessage({ reused, consultId })
db.close()
