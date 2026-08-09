#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Pool } from 'pg'
import { createPgClientSessionsSchema } from '../packages/storage/src/pgClientSessionsBackend.js'

type Mode = 'prepare' | 'finalize' | 'verify' | 'rollback-to-sqlite' | 'authority-state'

function usage(): never {
  console.error(
    'usage: migrate-personal-sessions-pg.ts --prepare|--finalize|--verify|--rollback-to-sqlite|--authority-state [--sqlite PATH] [--service UNIT]',
  )
  process.exit(2)
}

const argv = process.argv.slice(2)
const modeArg = argv.find((arg) =>
  ['--prepare', '--finalize', '--verify', '--rollback-to-sqlite', '--authority-state'].includes(
    arg,
  ),
)
const mode = modeArg?.slice(2) as Mode | undefined
if (
  !mode ||
  !['prepare', 'finalize', 'verify', 'rollback-to-sqlite', 'authority-state'].includes(mode)
) {
  usage()
}
function value(flag: string, fallback: string): string {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const sqlitePath = value(
  '--sqlite',
  join(process.env.OPENCLAUDE_HOME || join(homedir(), '.openclaude'), 'sessions.db'),
)
const service = value('--service', process.env.OPENCLAUDE_PROD_SERVICE || 'openclaude.service')
const connectionString = process.env.OPENCLAUDE_SESSIONS_DATABASE_URL
if (!connectionString) throw new Error('OPENCLAUDE_SESSIONS_DATABASE_URL is required')
const pool = new Pool({ connectionString })

function requireServiceInactive(): void {
  const fields = execFileSync(
    'systemctl',
    [
      'show',
      service,
      '-p',
      'LoadState',
      '-p',
      'ActiveState',
      '-p',
      'SubState',
      '-p',
      'Result',
      '-p',
      'ExecMainStatus',
    ],
    { encoding: 'utf8' },
  )
  const state = Object.fromEntries(
    fields
      .trim()
      .split('\n')
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  )
  if (
    state.LoadState !== 'loaded' ||
    state.ActiveState !== 'inactive' ||
    state.SubState !== 'dead' ||
    state.Result !== 'success' ||
    state.ExecMainStatus !== '0'
  ) {
    throw new Error(`${service} has no clean write barrier: ${JSON.stringify(state)}`)
  }
}

async function mutationCount(): Promise<number> {
  const result = await pool.query(
    'SELECT mutation_count FROM client_sessions_authority WHERE singleton = TRUE',
  )
  if (result.rowCount !== 1) throw new Error('client_sessions_authority row missing')
  return Number(result.rows[0].mutation_count)
}

function sqliteHasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

function sqliteColumns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name),
  )
}

async function importSqliteToPg(db: Database.Database, replace: boolean): Promise<void> {
  const sessionColumns = sqliteColumns(db, 'client_sessions')
  const tapeTurnExpr = sessionColumns.has('tape_turn_count')
    ? 'tape_turn_count'
    : `(SELECT COUNT(DISTINCT turn_key) FROM client_session_tape t
        WHERE t.session_id=client_sessions.id AND t.user_id=client_sessions.user_id)`
  const lastTapeExpr = sessionColumns.has('last_tape_seq')
    ? 'last_tape_seq'
    : `(SELECT COALESCE(MAX(tape_seq),0) FROM client_session_tape t
        WHERE t.session_id=client_sessions.id AND t.user_id=client_sessions.user_id)`
  const deletedExpr = sessionColumns.has('deleted_at') ? 'deleted_at' : 'NULL'
  const sessions = db
    .prepare(
      `SELECT id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,
              ${tapeTurnExpr} AS tape_turn_count, ${lastTapeExpr} AS last_tape_seq,
              updated_at, ${deletedExpr} AS deleted_at
       FROM client_sessions ORDER BY id`,
    )
    .all() as any[]
  const tapes = sqliteHasTable(db, 'client_session_tape')
    ? (db
        .prepare(
          `SELECT session_id,user_id,tape_seq,turn_key,direction,ts,frame_json
           FROM client_session_tape ORDER BY session_id,user_id,tape_seq`,
        )
        .all() as any[])
    : []
  const turns = sqliteHasTable(db, 'client_session_turns')
    ? (db
        .prepare(
          `SELECT session_id,user_id,client_message_id,state,started_at,finished_at
           FROM client_session_turns ORDER BY session_id,user_id,client_message_id`,
        )
        .all() as any[])
    : []

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (replace) {
      await client.query(
        'TRUNCATE client_session_tape_payload_parts, client_session_tape, client_session_turns, client_session_tombstones, client_sessions',
      )
    }
    for (const row of sessions) {
      await client.query(
        `INSERT INTO client_sessions
           (id,user_id,agent_id,title,pinned,created_at,last_at,messages_json,message_count,
            tape_turn_count,last_tape_seq,updated_at,deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT(id) DO UPDATE SET
           user_id=excluded.user_id,agent_id=excluded.agent_id,title=excluded.title,
           pinned=excluded.pinned,created_at=excluded.created_at,last_at=excluded.last_at,
           messages_json=excluded.messages_json,message_count=excluded.message_count,
           tape_turn_count=excluded.tape_turn_count,last_tape_seq=excluded.last_tape_seq,
           updated_at=excluded.updated_at,deleted_at=excluded.deleted_at`,
        [
          row.id,
          row.user_id,
          row.agent_id,
          row.title,
          !!row.pinned,
          row.created_at,
          row.last_at,
          row.messages,
          row.message_count,
          row.tape_turn_count,
          row.last_tape_seq,
          row.updated_at,
          row.deleted_at,
        ],
      )
      if (row.deleted_at !== null) {
        await client.query(
          `INSERT INTO client_session_tombstones(session_id,user_id,deleted_at,last_tape_seq)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT(session_id,user_id) DO UPDATE SET
             deleted_at=excluded.deleted_at,last_tape_seq=excluded.last_tape_seq`,
          [row.id, row.user_id, row.deleted_at, row.last_tape_seq],
        )
        await client.query('DELETE FROM client_session_tape WHERE session_id=$1 AND user_id=$2', [
          row.id,
          row.user_id,
        ])
      }
    }
    const BATCH = 1000
    for (let offset = 0; offset < tapes.length; offset += BATCH) {
      const batch = tapes.slice(offset, offset + BATCH)
      const sessionIds: string[] = []
      const userIds: string[] = []
      const seqs: number[] = []
      const turnKeys: string[] = []
      const directions: string[] = []
      const timestamps: number[] = []
      const frames: string[] = []
      const byteLengths: number[] = []
      const hashes: string[] = []
      for (const row of batch) {
        sessionIds.push(row.session_id)
        userIds.push(row.user_id)
        seqs.push(row.tape_seq)
        turnKeys.push(row.turn_key)
        directions.push(row.direction)
        timestamps.push(row.ts)
        frames.push(row.frame_json)
        byteLengths.push(Buffer.byteLength(row.frame_json))
        hashes.push(createHash('sha256').update(row.frame_json).digest('hex'))
      }
      await client.query(
        `INSERT INTO client_session_tape
           (session_id,user_id,tape_seq,turn_key,direction,ts,frame_json,frame_bytes,frame_sha256)
         SELECT * FROM UNNEST(
           $1::text[],$2::text[],$3::bigint[],$4::text[],$5::text[],$6::bigint[],
           $7::text[],$8::bigint[],$9::text[])
         ON CONFLICT(session_id,user_id,tape_seq) DO UPDATE SET
           turn_key=excluded.turn_key,direction=excluded.direction,ts=excluded.ts,
           frame_json=excluded.frame_json,frame_bytes=excluded.frame_bytes,
           frame_sha256=excluded.frame_sha256`,
        [sessionIds, userIds, seqs, turnKeys, directions, timestamps, frames, byteLengths, hashes],
      )
    }
    for (const row of turns) {
      await client.query(
        `INSERT INTO client_session_turns
           (session_id,user_id,client_message_id,state,started_at,finished_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT(session_id,user_id,client_message_id) DO UPDATE SET
           state=excluded.state,started_at=excluded.started_at,finished_at=excluded.finished_at`,
        [
          row.session_id,
          row.user_id,
          row.client_message_id,
          row.state,
          row.started_at,
          row.finished_at,
        ],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

function sqliteTapeDigest(db: Database.Database): string {
  const hash = createHash('sha256')
  if (!sqliteHasTable(db, 'client_session_tape')) return hash.digest('hex')
  const rows = db
    .prepare(
      `SELECT session_id,user_id,tape_seq,frame_json FROM client_session_tape
       ORDER BY session_id,user_id,tape_seq`,
    )
    .iterate() as Iterable<any>
  for (const row of rows) {
    hash.update(`${row.session_id}\0${row.user_id}\0${row.tape_seq}\0`)
    hash.update(row.frame_json)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function pgTapeDigest(): Promise<string> {
  const hash = createHash('sha256')
  const BATCH = 5000
  for (let offset = 0; ; offset += BATCH) {
    const result = await pool.query(
      `SELECT session_id,user_id,tape_seq,frame_json FROM client_session_tape
       ORDER BY session_id,user_id,tape_seq LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    )
    for (const row of result.rows) {
      hash.update(`${row.session_id}\0${row.user_id}\0${row.tape_seq}\0`)
      hash.update(row.frame_json)
      hash.update('\0')
    }
    if (result.rows.length < BATCH) break
  }
  return hash.digest('hex')
}

function sqliteSessionsDigest(db: Database.Database): string {
  const columns = sqliteColumns(db, 'client_sessions')
  const tapeTurn = columns.has('tape_turn_count')
    ? 'tape_turn_count'
    : `(SELECT COUNT(DISTINCT turn_key) FROM client_session_tape t
        WHERE t.session_id=client_sessions.id AND t.user_id=client_sessions.user_id)
       AS tape_turn_count`
  const lastTape = columns.has('last_tape_seq')
    ? 'last_tape_seq'
    : `(SELECT COALESCE(MAX(tape_seq),0) FROM client_session_tape t
        WHERE t.session_id=client_sessions.id AND t.user_id=client_sessions.user_id)
       AS last_tape_seq`
  const deleted = columns.has('deleted_at') ? 'deleted_at' : 'NULL AS deleted_at'
  const rows = db
    .prepare(
      `SELECT id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,
              ${tapeTurn},${lastTape},updated_at,${deleted}
       FROM client_sessions ORDER BY id`,
    )
    .iterate() as Iterable<any>
  const hash = createHash('sha256')
  for (const row of rows) {
    hash.update(
      JSON.stringify([
        row.id,
        row.user_id,
        row.agent_id,
        row.title,
        !!row.pinned,
        Number(row.created_at),
        Number(row.last_at),
        row.messages,
        Number(row.message_count),
        Number(row.tape_turn_count),
        Number(row.last_tape_seq),
        Number(row.updated_at),
        row.deleted_at === null ? null : Number(row.deleted_at),
      ]),
    )
  }
  return hash.digest('hex')
}

async function pgSessionsDigest(): Promise<string> {
  const result = await pool.query(
    `SELECT id,user_id,agent_id,title,pinned,created_at,last_at,messages_json,message_count,
            tape_turn_count,last_tape_seq,updated_at,deleted_at
     FROM client_sessions ORDER BY id`,
  )
  const hash = createHash('sha256')
  for (const row of result.rows) {
    hash.update(
      JSON.stringify([
        row.id,
        row.user_id,
        row.agent_id,
        row.title,
        !!row.pinned,
        Number(row.created_at),
        Number(row.last_at),
        row.messages_json,
        Number(row.message_count),
        Number(row.tape_turn_count),
        Number(row.last_tape_seq),
        Number(row.updated_at),
        row.deleted_at === null ? null : Number(row.deleted_at),
      ]),
    )
  }
  return hash.digest('hex')
}

async function verify(db: Database.Database): Promise<void> {
  const sqliteSessions = db.prepare('SELECT COUNT(*) AS n FROM client_sessions').get() as any
  const sqliteTape = sqliteHasTable(db, 'client_session_tape')
    ? (db.prepare('SELECT COUNT(*) AS n FROM client_session_tape').get() as any)
    : { n: 0 }
  const sqliteTurns = sqliteHasTable(db, 'client_session_turns')
    ? (db.prepare('SELECT COUNT(*) AS n FROM client_session_turns').get() as any)
    : { n: 0 }
  const pgCounts = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM client_sessions) AS sessions,
       (SELECT COUNT(*) FROM client_session_tape) AS tape,
       (SELECT COUNT(*) FROM client_session_turns) AS turns`,
  )
  const counts = pgCounts.rows[0]
  if (
    Number(sqliteSessions.n) !== Number(counts.sessions) ||
    Number(sqliteTape.n) !== Number(counts.tape) ||
    Number(sqliteTurns.n) !== Number(counts.turns)
  ) {
    throw new Error(
      `count mismatch sqlite=${sqliteSessions.n}/${sqliteTape.n}/${sqliteTurns.n} pg=${counts.sessions}/${counts.tape}/${counts.turns}`,
    )
  }
  const [sqliteSha, pgSha, sqliteSessionSha, pgSessionSha] = await Promise.all([
    Promise.resolve(sqliteTapeDigest(db)),
    pgTapeDigest(),
    Promise.resolve(sqliteSessionsDigest(db)),
    pgSessionsDigest(),
  ])
  if (sqliteSha !== pgSha) throw new Error(`raw tape SHA mismatch sqlite=${sqliteSha} pg=${pgSha}`)
  if (sqliteSessionSha !== pgSessionSha) {
    throw new Error(
      `session metadata/messages SHA mismatch sqlite=${sqliteSessionSha} pg=${pgSessionSha}`,
    )
  }

  const sqliteDeleted = sqliteColumns(db, 'client_sessions').has('deleted_at')
    ? (
        db
          .prepare('SELECT COUNT(*) AS n FROM client_sessions WHERE deleted_at IS NOT NULL')
          .get() as any
      ).n
    : 0
  const pgDeleted = (await pool.query('SELECT COUNT(*) AS n FROM client_session_tombstones'))
    .rows[0].n
  if (Number(sqliteDeleted) !== Number(pgDeleted)) {
    throw new Error(`tombstone mismatch sqlite=${sqliteDeleted} pg=${pgDeleted}`)
  }
  console.log(
    JSON.stringify({
      ok: true,
      sessions: Number(counts.sessions),
      tape: Number(counts.tape),
      turns: Number(counts.turns),
      tombstones: Number(pgDeleted),
      tapeSha256: pgSha,
      sessionsSha256: pgSessionSha,
    }),
  )
}

async function rollbackToSqlite(db: Database.Database): Promise<void> {
  const backup = `${sqlitePath}.pre-pg-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`
  db.pragma('wal_checkpoint(TRUNCATE)')
  copyFileSync(sqlitePath, backup)
  const sessions = (await pool.query('SELECT * FROM client_sessions ORDER BY id')).rows
  const tapes = (
    await pool.query(
      `SELECT session_id,user_id,tape_seq,turn_key,direction,ts,frame_json
       FROM client_session_tape ORDER BY session_id,user_id,tape_seq`,
    )
  ).rows
  const turns = (
    await pool.query(
      `SELECT session_id,user_id,client_message_id,state,started_at,finished_at
       FROM client_session_turns`,
    )
  ).rows
  const apply = db.transaction(() => {
    db.exec(
      'DELETE FROM client_session_tape; DELETE FROM client_session_turns; DELETE FROM client_sessions;',
    )
    const insertSession = db.prepare(
      `INSERT INTO client_sessions
       (id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,
        tape_turn_count,last_tape_seq,updated_at,deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (const row of sessions) {
      insertSession.run(
        row.id,
        row.user_id,
        row.agent_id,
        row.title,
        row.pinned ? 1 : 0,
        Number(row.created_at),
        Number(row.last_at),
        row.messages_json,
        row.message_count,
        row.tape_turn_count,
        Number(row.last_tape_seq),
        Number(row.updated_at),
        row.deleted_at === null ? null : Number(row.deleted_at),
      )
    }
    const insertTape = db.prepare(
      `INSERT INTO client_session_tape
       (session_id,user_id,tape_seq,turn_key,direction,ts,frame_json) VALUES (?,?,?,?,?,?,?)`,
    )
    for (const row of tapes) {
      insertTape.run(
        row.session_id,
        row.user_id,
        Number(row.tape_seq),
        row.turn_key,
        row.direction,
        Number(row.ts),
        row.frame_json,
      )
    }
    const insertTurn = db.prepare(
      `INSERT INTO client_session_turns
       (session_id,user_id,client_message_id,state,started_at,finished_at) VALUES (?,?,?,?,?,?)`,
    )
    for (const row of turns) {
      insertTurn.run(
        row.session_id,
        row.user_id,
        row.client_message_id,
        row.state,
        Number(row.started_at),
        row.finished_at === null ? null : Number(row.finished_at),
      )
    }
  })
  apply.immediate()
  await verify(db)
  console.log(JSON.stringify({ rollbackBackup: backup }))
}

try {
  if (mode === 'authority-state') {
    console.log(JSON.stringify({ mutationCount: await mutationCount() }))
  } else {
    if (!existsSync(sqlitePath)) throw new Error(`SQLite source not found: ${sqlitePath}`)
    const db = new Database(sqlitePath)
    try {
      if (mode === 'prepare') {
        await createPgClientSessionsSchema(pool)
        if ((await mutationCount()) !== 0) {
          throw new Error(
            'PostgreSQL authority already contains runtime mutations; refusing import',
          )
        }
        await importSqliteToPg(db, true)
        await verify(db)
      } else if (mode === 'finalize') {
        requireServiceInactive()
        if ((await mutationCount()) !== 0) {
          throw new Error(
            'PostgreSQL authority already contains runtime mutations; refusing finalize',
          )
        }
        await importSqliteToPg(db, true)
        await verify(db)
      } else if (mode === 'verify') {
        await verify(db)
      } else {
        requireServiceInactive()
        await rollbackToSqlite(db)
      }
    } finally {
      db.close()
    }
  }
} finally {
  await pool.end()
}
