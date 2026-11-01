/** P2 single-control-node store. Local persistent disk only; not a business DB. */
import {
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import {
  BindingSchema,
  EnvironmentSchema,
  EventSchema,
  JobRefSchema,
  LeaseSchema,
  ReceiptSchema,
  RequestSchema,
  WorkerSchema,
  agentRemoteContentHash,
  agentRemoteOperationKey,
  remoteCanonical,
  requireRemote,
  validateRemote,
} from '@openclaude/protocol/agentRemote'
import { NativeCheckpointSchema } from '@openclaude/protocol/agentRemoteState'
import { Type } from '@sinclair/typebox'
import Database from 'better-sqlite3'
import type {
  AgentRemoteState,
  AgentRemoteStore,
  JournalRecord,
  JournalSelection,
} from './store.js'

const closed = { additionalProperties: false }
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const StateSchema = Type.Object(
  {
    workers: Type.Array(Type.Object({ ...WorkerSchema.properties, expiresAtMs: integer }, closed), {
      maxItems: 10000,
    }),
    environments: Type.Array(EnvironmentSchema, { maxItems: 10000 }),
    sessions: Type.Array(
      Type.Object(
        {
          binding: BindingSchema,
          epochWatermark: integer,
          lease: Type.Optional(
            Type.Object(
              { ...LeaseSchema.properties, expiresAtMs: integer, active: Type.Boolean() },
              closed,
            ),
          ),
          nativeCheckpoint: Type.Optional(NativeCheckpointSchema),
        },
        closed,
      ),
      { maxItems: 10000 },
    ),
    journal: Type.Array(
      Type.Object(
        {
          request: RequestSchema,
          claim: LeaseSchema,
          state: Type.Union(
            [
              'accepted',
              'dispatched',
              'started',
              'unknown',
              'completed',
              'failed',
              'cancelled',
            ].map((state) => Type.Literal(state)),
          ),
          cancelRequested: Type.Boolean(),
          events: Type.Array(EventSchema, { maxItems: 10000 }),
          receipt: Type.Optional(ReceiptSchema),
          job: Type.Optional(JobRefSchema),
          cursor: Type.Object({ stdout: integer, stderr: integer }, closed),
          createdAtMs: Type.Optional(integer),
          updatedAtMs: Type.Optional(integer),
        },
        closed,
      ),
      { maxItems: 10000 },
    ),
  },
  closed,
)
const APPLICATION_ID = 0x41524d31
const FORMAT_VERSION = 1
const MAX_STATE_BYTES = 64 * 1024 * 1024

function validateState(principalId: string, value: unknown): asserts value is AgentRemoteState {
  validateRemote<AgentRemoteState>(StateSchema, value)
  requireRemote(
    value.workers.every((row) => row.principalId === principalId) &&
      value.environments.every((row) => row.principalId === principalId) &&
      value.sessions.every((row) => row.binding.principalId === principalId) &&
      value.journal.every(
        (row) =>
          row.request.binding.principalId === principalId &&
          row.events.every((event) => event.binding.principalId === principalId),
      ),
    'stored-principal-mismatch',
  )
}
export class SqliteAgentRemoteStore implements AgentRemoteStore {
  readonly durability = 'durable' as const
  private readonly database: Database.Database
  private closed = false
  constructor(filename: string) {
    requireRemote(isAbsolute(filename), 'state-path-absolute')
    const parent = dirname(filename)
    const created = mkdirSync(parent, { recursive: true, mode: 0o700 })
    const syncDirectory = (path: string) => {
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    }
    if (created) {
      let current = parent
      while (true) {
        syncDirectory(current)
        if (current === dirname(created)) break
        current = dirname(current)
      }
    }
    requireRemote(
      !lstatSync(parent).isSymbolicLink() && realpathSync(parent) === parent,
      'state-path-symlink',
    )
    requireRemote((lstatSync(parent).mode & 0o077) === 0, 'state-directory-private')
    try {
      const descriptor = openSync(
        filename,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      syncDirectory(parent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = lstatSync(filename)
    requireRemote(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0,
      'state-file-private',
    )
    this.database = new Database(filename, { timeout: 5000 })
    try {
      // Reject an unrelated DB before changing its journal mode or creating WAL files.
      const initialVersion = this.database.pragma('user_version', { simple: true })
      const initialApplication = this.database.pragma('application_id', { simple: true })
      requireRemote(
        initialVersion === 0 || initialVersion === FORMAT_VERSION,
        'state-format-version',
      )
      requireRemote(
        (initialVersion === 0 && initialApplication === 0) ||
          (initialVersion === FORMAT_VERSION && initialApplication === APPLICATION_ID),
        'state-application-id',
      )
      if (initialVersion === 0) {
        const existing = this.database
          .prepare(
            "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .get() as { count: number }
        requireRemote(existing.count === 0, 'state-existing-database')
      }
      this.database.pragma('journal_mode = WAL')
      this.database.pragma('synchronous = FULL')
      this.database.pragma('foreign_keys = ON')
      this.database
        .transaction(() => {
          const version = this.database.pragma('user_version', { simple: true })
          const applicationId = this.database.pragma('application_id', { simple: true })
          requireRemote(version === 0 || version === FORMAT_VERSION, 'state-format-version')
          requireRemote(
            (version === 0 && applicationId === 0) ||
              (version === FORMAT_VERSION && applicationId === APPLICATION_ID),
            'state-application-id',
          )
          if (version === 0) {
            const existing = this.database
              .prepare(
                "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
              )
              .get() as { count: number }
            requireRemote(existing.count === 0, 'state-existing-database')
            this.database.exec(`CREATE TABLE agent_remote_principals (
            principal_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0),
            format_version INTEGER NOT NULL CHECK(format_version = 1),
            payload TEXT NOT NULL CHECK(json_valid(payload)), payload_sha256 TEXT NOT NULL
          );
          CREATE TABLE agent_remote_operations (
            principal_id TEXT NOT NULL REFERENCES agent_remote_principals(principal_id),
            operation_key TEXT NOT NULL, state TEXT NOT NULL,
            payload TEXT NOT NULL CHECK(json_valid(payload)), payload_sha256 TEXT NOT NULL,
            PRIMARY KEY(principal_id,operation_key)
          );
          CREATE INDEX agent_remote_active ON agent_remote_operations(principal_id)
            WHERE state IN ('accepted','dispatched','started','unknown');`)
            this.database.pragma(`user_version = ${FORMAT_VERSION}`)
            this.database.pragma(`application_id = ${APPLICATION_ID}`)
          }
        })
        .immediate()
    } catch (error) {
      this.database.close()
      throw error
    }
  }
  async transact<T>(
    principalId: string,
    change: (draft: AgentRemoteState) => T,
    journal: JournalSelection = 'all',
  ): Promise<T> {
    requireRemote(!this.closed, 'state-store-closed')
    requireRemote(/^[A-Za-z0-9_.:-]{1,160}$/.test(principalId), 'bad-principal')
    return this.database
      .transaction(() => {
        type Row = { payload: string; payload_sha256: string }
        const row = this.database
          .prepare(
            'SELECT revision, format_version, payload, payload_sha256 FROM agent_remote_principals WHERE principal_id = ?',
          )
          .get(principalId) as (Row & { revision: number; format_version: number }) | undefined
        let state: AgentRemoteState = { workers: [], environments: [], sessions: [], journal: [] }
        let revision = 0
        if (row) {
          requireRemote(
            row.format_version === FORMAT_VERSION &&
              row.payload_sha256 === agentRemoteContentHash(row.payload),
            'state-corrupt',
          )
          requireRemote(Number.isSafeInteger(row.revision) && row.revision > 0, 'state-revision')
          state = JSON.parse(row.payload)
          revision = row.revision
          requireRemote(
            Array.isArray(state.journal) && state.journal.length === 0,
            'state-format-version',
          )
        }
        const activeQuery =
          "SELECT operation_key,state,payload,payload_sha256 FROM agent_remote_operations WHERE principal_id=? AND state IN ('accepted','dispatched','started','unknown')"
        type OperationRow = Row & { operation_key: string; state: string }
        const operationRows = (
          journal === 'all'
            ? this.database.prepare(
                'SELECT operation_key,state,payload,payload_sha256 FROM agent_remote_operations WHERE principal_id=?',
              )
            : this.database.prepare(activeQuery)
        ).all(principalId) as OperationRow[]
        if (typeof journal === 'object') {
          const wanted = new Set([journal.operationKey, ...(journal.includeOperationKeys ?? [])])
          requireRemote(wanted.size <= 16, 'journal-selection-bound')
          const lookup = this.database.prepare(
            'SELECT operation_key,state,payload,payload_sha256 FROM agent_remote_operations WHERE principal_id=? AND operation_key=?',
          )
          for (const key of wanted) {
            if (operationRows.some((item) => item.operation_key === key)) continue
            const requested = lookup.get(principalId, key) as OperationRow | undefined
            if (requested) operationRows.push(requested)
          }
        }
        const previous = new Map<string, { record: JournalRecord; payload: string }>()
        for (const stored of operationRows) {
          requireRemote(
            stored.payload_sha256 === agentRemoteContentHash(stored.payload),
            'state-corrupt',
          )
          const record = JSON.parse(stored.payload) as JournalRecord
          requireRemote(
            stored.state === record.state &&
              stored.operation_key ===
                agentRemoteOperationKey(record.request.binding, record.request.operationId),
            'state-corrupt',
          )
          previous.set(stored.operation_key, {
            record: structuredClone(record),
            payload: stored.payload,
          })
          state.journal.push(record)
        }
        validateState(principalId, state)
        const draft = structuredClone(state)
        const result = change(draft)
        requireRemote(
          !(result && typeof (result as { then?: unknown }).then === 'function'),
          'async-transaction-callback',
        )
        validateState(principalId, draft)
        const metadata = remoteCanonical({ ...draft, journal: [] })
        requireRemote(Buffer.byteLength(metadata, 'utf8') <= MAX_STATE_BYTES, 'state-capacity')
        const writes: { key: string; record: JournalRecord; payload: string }[] = []
        const keys = new Set<string>()
        for (const record of draft.journal) {
          const key = agentRemoteOperationKey(record.request.binding, record.request.operationId)
          requireRemote(!keys.has(key), 'duplicate-stored-operation')
          keys.add(key)
          const old = previous.get(key)
          if (old)
            requireRemote(
              remoteCanonical(old.record.request) === remoteCanonical(record.request),
              'stored-request-mutation',
            )
          const payload = remoteCanonical(record)
          requireRemote(Buffer.byteLength(payload, 'utf8') <= MAX_STATE_BYTES, 'operation-capacity')
          if (old && ['completed', 'failed', 'cancelled'].includes(old.record.state))
            requireRemote(payload === old.payload, 'stored-terminal-mutation')
          if (!old || old.payload !== payload) writes.push({ key, record, payload })
        }
        requireRemote(
          [...previous.keys()].every((key) => keys.has(key)),
          'stored-operation-deletion',
        )
        if (!row || metadata !== row.payload || writes.length) {
          requireRemote(revision < Number.MAX_SAFE_INTEGER, 'state-revision-exhausted')
          this.database
            .prepare(`INSERT INTO agent_remote_principals(principal_id,revision,format_version,payload,payload_sha256)
          VALUES(?,?,?,?,?) ON CONFLICT(principal_id) DO UPDATE SET revision=excluded.revision,
          format_version=excluded.format_version,payload=excluded.payload,payload_sha256=excluded.payload_sha256`)
            .run(
              principalId,
              revision + 1,
              FORMAT_VERSION,
              metadata,
              agentRemoteContentHash(metadata),
            )
          for (const write of writes) {
            if (!previous.has(write.key)) {
              // A caller may only create a genuinely new key; selections never hide a duplicate.
              const existing = this.database
                .prepare(
                  'SELECT 1 FROM agent_remote_operations WHERE principal_id=? AND operation_key=?',
                )
                .get(principalId, write.key)
              requireRemote(!existing, 'journal-selection-missed-key')
            }
            this.database
              .prepare(`INSERT INTO agent_remote_operations(principal_id,operation_key,state,payload,payload_sha256)
            VALUES(?,?,?,?,?) ON CONFLICT(principal_id,operation_key) DO UPDATE SET state=excluded.state,
            payload=excluded.payload,payload_sha256=excluded.payload_sha256`)
              .run(
                principalId,
                write.key,
                write.record.state,
                write.payload,
                agentRemoteContentHash(write.payload),
              )
          }
        }
        return structuredClone(result)
      })
      .immediate()
  }
  /** Read-only retention proposal. Never deletes. Checkpointed sessions are
   * conservatively pinned until P3 can resolve narrower existing-authority refs.
   */
  async retentionCandidates(
    principalId: string,
    nowMs: number,
    afterOperationKey = '',
    limit = 100,
  ) {
    requireRemote(!this.closed, 'state-store-closed')
    requireRemote(/^[A-Za-z0-9_.:-]{1,160}$/.test(principalId), 'bad-principal')
    requireRemote(
      Number.isSafeInteger(nowMs) &&
        nowMs >= 0 &&
        Number.isInteger(limit) &&
        limit > 0 &&
        limit <= 1000,
      'retention-bound',
    )
    return this.database.transaction(() => {
      const metadata = this.database
        .prepare('SELECT payload,payload_sha256 FROM agent_remote_principals WHERE principal_id=?')
        .get(principalId) as { payload: string; payload_sha256: string } | undefined
      const pinned = new Set<string>()
      if (metadata) {
        requireRemote(
          agentRemoteContentHash(metadata.payload) === metadata.payload_sha256,
          'state-corrupt',
        )
        const state: unknown = JSON.parse(metadata.payload)
        validateState(principalId, state)
        for (const session of state.sessions)
          if (session.nativeCheckpoint) pinned.add(session.binding.sessionId)
      }
      const referenced = new Set<string>()
      const active = this.database
        .prepare(
          `SELECT payload,payload_sha256 FROM agent_remote_operations WHERE principal_id=?
         AND state IN ('accepted','dispatched','started','unknown')`,
        )
        .iterate(principalId)
      for (const raw of active) {
        const row = raw as { payload: string; payload_sha256: string }
        requireRemote(agentRemoteContentHash(row.payload) === row.payload_sha256, 'state-corrupt')
        const record = JSON.parse(row.payload) as JournalRecord
        validateState(principalId, {
          workers: [],
          environments: [],
          sessions: [],
          journal: [record],
        })
        if ('sourceOperationId' in record.request.command)
          referenced.add(
            agentRemoteOperationKey(
              record.request.binding,
              record.request.command.sourceOperationId,
            ),
          )
      }
      const rows = this.database
        .prepare(
          `SELECT operation_key,payload,payload_sha256 FROM agent_remote_operations
         WHERE principal_id=? AND operation_key>? AND state IN ('completed','failed','cancelled')
         ORDER BY operation_key LIMIT ?`,
        )
        .iterate(principalId, afterOperationKey, limit)
      const candidates: {
        operationKey: string
        sessionId: string
        operationId: string
        updatedAtMs: number
      }[] = []
      let scanned = 0
      let nextOperationKey = afterOperationKey
      for (const raw of rows) {
        const row = raw as { operation_key: string; payload: string; payload_sha256: string }
        scanned++
        nextOperationKey = row.operation_key
        requireRemote(agentRemoteContentHash(row.payload) === row.payload_sha256, 'state-corrupt')
        const record = JSON.parse(row.payload) as JournalRecord
        validateState(principalId, {
          workers: [],
          environments: [],
          sessions: [],
          journal: [record],
        })
        requireRemote(
          ['completed', 'failed', 'cancelled'].includes(record.state) &&
            agentRemoteOperationKey(record.request.binding, record.request.operationId) ===
              row.operation_key,
          'state-corrupt',
        )
        if (
          !referenced.has(row.operation_key) &&
          !pinned.has(record.request.binding.sessionId) &&
          record.updatedAtMs !== undefined &&
          record.updatedAtMs <= nowMs - 30 * 24 * 60 * 60 * 1000
        ) {
          candidates.push({
            operationKey: row.operation_key,
            sessionId: record.request.binding.sessionId,
            operationId: record.request.operationId,
            updatedAtMs: record.updatedAtMs,
          })
        }
      }
      return {
        candidates,
        nextOperationKey,
        hasMore: scanned === limit,
      }
    })()
  }
  close(): void {
    if (!this.closed) {
      this.closed = true
      this.database.close()
    }
  }
}
