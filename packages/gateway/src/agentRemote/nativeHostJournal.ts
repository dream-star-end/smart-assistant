/** Supervisor-only consumption ledger. Never mount this database or its parent
 * into the tool container. This class is not an authentication or exec endpoint:
 * scopes/grants come from the authenticated control transport, and executor
 * completion facts come from the supervisor. Hashes detect inconsistency, not
 * identity. Container-supplied JSON cannot select these trusted arguments.
 */
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
  agentRemoteContentHash,
  remoteCanonical,
  requireRemote,
  validateRemote,
} from '@openclaude/protocol/agentRemote'
import {
  NativeBodySchema,
  type NativeFrame,
  NativeReceiptBodySchema,
  type NativeScope,
  NativeScopeSchema,
  nativeExecutionHash,
  nativeOperationKey,
  verifyNativeBodySemantics,
  verifyNativeFrame,
  verifyNativeJson,
} from '@openclaude/protocol/agentRemoteNative'
import { type Static, Type } from '@sinclair/typebox'
import Database from 'better-sqlite3'
import {
  type NativeIntent,
  NativeIntentSchema,
  type NativeJournalEvent,
  NativeJournalEventSchema,
  type NativeJournalRecord,
  nativeJournalEventHash,
  nativeOperationEventKindAllowed,
  nativeReceiptHash,
  verifyNativeJournalRecord,
} from './nativeJournal.js'

const closed = { additionalProperties: false }
const id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_.:-]+$' })
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' })
const IdentitySchema = Type.Object(
  {
    ledgerId: id,
    principalId: id,
    environmentId: id,
    environmentGeneration: positive,
    environmentIncarnation: id,
  },
  closed,
)
export type NativeHostIdentity = Static<typeof IdentitySchema>
const EvidenceReferenceSchema = Type.Object(
  {
    nativeSessionId: NativeScopeSchema.properties.nativeSessionId,
    operationId: id,
    payloadHash: digest,
  },
  closed,
)
export type NativeHostEvidenceReference = Static<typeof EvidenceReferenceSchema>
const phases = [
  'accepted',
  'pipeline-started',
  'effective-input',
  'call-started',
  'unknown',
  'completed',
  'failed',
  'cancelled',
] as const
const RecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    request: NativeIntentSchema,
    sourceScope: NativeScopeSchema,
    executor: Type.Object({ hostInstanceId: id, ledgerId: id, grantId: id }, closed),
    phase: Type.Union(phases.map((value) => Type.Literal(value))),
    cancelRequested: Type.Boolean(),
    effectiveInput: Type.Optional(Type.Object({ sha256: digest, policyRevision: integer }, closed)),
    receipt: Type.Optional(Type.Object({ body: NativeReceiptBodySchema, sha256: digest }, closed)),
    eventCount: integer,
    createdAtMs: integer,
    updatedAtMs: integer,
  },
  closed,
)
export type NativeHostRecord = Static<typeof RecordSchema>
const FenceSchema = Type.Object(
  {
    scope: NativeScopeSchema,
    expiresAtMs: positive,
    contextRevision: positive,
    manifestRevision: digest,
  },
  closed,
)
type Fence = Static<typeof FenceSchema>
export interface NativeHostOperationHandle {
  readonly nativeHostOperation: unique symbol
}
export interface NativeHostPipelinePermit {
  readonly nativeHostPipeline: unique symbol
}
export type NativeHostPipelineAdmission =
  | { kind: 'start'; permit: NativeHostPipelinePermit; record: NativeHostRecord }
  | { kind: 'evidence'; record: NativeHostRecord }
export type NativeHostCallAdmission =
  | { kind: 'call'; sha256: string }
  | { kind: 'evidence'; record: NativeHostRecord }
type FinalReceipt = Omit<Extract<NativeFrame['body'], { kind: 'native.receipt' }>, 'status'> & {
  status: 'completed' | 'failed' | 'cancelled'
}
const APPLICATION_ID = 0x414e4831
const terminal = (record: NativeHostRecord) =>
  ['completed', 'failed', 'cancelled'].includes(record.phase)
const equal = (a: unknown, b: unknown) => remoteCanonical(a) === remoteCanonical(b)
const logicalSession = (scope: NativeScope) =>
  remoteCanonical([scope.binding.principalId, scope.binding.sessionId])
const resource = (scope: NativeScope) =>
  remoteCanonical([scope.binding.principalId, scope.binding.sessionId, scope.nativeSessionId])

/** Identity is pinned by supervisor registry, including when opening an existing
 * ledger. initialize is only for a newly registered ledger, never recovery from
 * a missing file. Multiple connections serialize through BEGIN IMMEDIATE; only
 * one accepted->pipeline transition can issue a fresh in-process permit.
 */
export class SqliteNativeHostJournal {
  private readonly database: Database.Database
  private readonly identity: NativeHostIdentity
  private closed = false
  private readonly hostInstanceId: string
  private readonly clock: () => number
  private readonly verifyCancellationExit: ((record: NativeHostRecord) => boolean) | undefined
  private readonly handles = new WeakMap<object, { key: string; hash: string }>()
  private readonly permits = new WeakMap<object, { key: string; hash: string }>()
  constructor(options: {
    filename: string
    identity: NativeHostIdentity
    hostInstanceId: string
    initialize?: boolean
    clock?: () => number
    /** Privileged supervisor observation, never a boolean from container JSON.
     * Until real stop/resource evidence exists, leave undefined: started work
     * cannot be declared cancelled merely because AbortSignal/stdio closed. */
    verifyCancellationExit?: (record: NativeHostRecord) => boolean
  }) {
    validateRemote<NativeHostIdentity>(IdentitySchema, options.identity)
    validateRemote<string>(id, options.hostInstanceId)
    this.identity = structuredClone(options.identity)
    this.hostInstanceId = options.hostInstanceId
    this.clock = options.clock ?? Date.now
    this.verifyCancellationExit = options.verifyCancellationExit
    requireRemote(isAbsolute(options.filename), 'host-state-path-absolute')
    const parent = dirname(options.filename)
    const created = mkdirSync(parent, { recursive: true, mode: 0o700 })
    const syncDirectory = (path: string) => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
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
      !lstatSync(parent).isSymbolicLink() &&
        realpathSync(parent) === parent &&
        (lstatSync(parent).mode & 0o077) === 0,
      'host-state-directory-private',
    )
    let newFile = false
    try {
      requireRemote(Boolean(options.initialize), 'host-ledger-missing')
      const fd = openSync(
        options.filename,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      syncDirectory(parent)
      newFile = true
    } catch (error) {
      // Missing existing ledgers must not be recreated. Check existence without
      // suppressing a permission/symlink error or treating it as a fresh ledger.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (options.initialize) throw error
        try {
          lstatSync(options.filename)
        } catch {
          throw error
        }
      }
    }
    const stat = lstatSync(options.filename)
    requireRemote(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0,
      'host-state-file-private',
    )
    this.database = new Database(options.filename, { timeout: 5000 })
    try {
      const version = this.database.pragma('user_version', { simple: true })
      const application = this.database.pragma('application_id', { simple: true })
      requireRemote(
        (newFile && version === 0 && application === 0) ||
          (version === 1 && application === APPLICATION_ID),
        'host-state-format',
      )
      if (!newFile) {
        const metadata = this.database
          .prepare('SELECT payload FROM native_host_identity WHERE singleton=1')
          .get() as { payload: string } | undefined
        requireRemote(
          metadata && equal(JSON.parse(metadata.payload), this.identity),
          'host-ledger-identity',
        )
      }
      if (!newFile) {
        const tables = this.database
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
        const expectedTables = [
          'native_host_identity',
          'native_host_sessions',
          'native_host_fences',
          'native_host_operations',
          'native_host_events',
          'native_host_cancels',
        ].sort()
        const columns = this.database
          .prepare('PRAGMA table_info(native_host_operations)')
          .all() as { name: string }[]
        requireRemote(
          equal(tables.map((row) => row.name).sort(), expectedTables) &&
            equal(
              columns.map((row) => row.name),
              ['operation_key', 'resource_key', 'session_key', 'phase', 'payload', 'sha256'],
            ),
          'host-state-shape',
        )
      }
      this.database.pragma('journal_mode = WAL')
      this.database.pragma('synchronous = FULL')
      this.database.pragma('foreign_keys = ON')
      this.database
        .transaction(() => {
          if (newFile) {
            this.database.exec(`CREATE TABLE native_host_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL CHECK(json_valid(payload)));
            CREATE TABLE native_host_sessions(session_key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)), sha256 TEXT NOT NULL);
            CREATE TABLE native_host_fences(resource_key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)), sha256 TEXT NOT NULL);
            CREATE TABLE native_host_operations(operation_key TEXT PRIMARY KEY, resource_key TEXT NOT NULL, session_key TEXT NOT NULL, phase TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), sha256 TEXT NOT NULL);
            CREATE INDEX native_host_operations_resource ON native_host_operations(resource_key, phase);
            CREATE INDEX native_host_operations_session ON native_host_operations(session_key, phase);
            CREATE TABLE native_host_events(operation_key TEXT NOT NULL REFERENCES native_host_operations(operation_key), sequence INTEGER NOT NULL CHECK(sequence>0), payload TEXT NOT NULL CHECK(json_valid(payload)), sha256 TEXT NOT NULL, PRIMARY KEY(operation_key, sequence));
            CREATE TABLE native_host_cancels(operation_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL);`)
            this.database
              .prepare('INSERT INTO native_host_identity VALUES(1,?)')
              .run(remoteCanonical(this.identity))
            this.database.pragma(`application_id = ${APPLICATION_ID}`)
            this.database.pragma('user_version = 1')
          }
        })
        .immediate()
    } catch (error) {
      this.database.close()
      throw error
    }
  }
  private now(): number {
    const now = this.clock()
    requireRemote(Number.isSafeInteger(now) && now >= 0, 'host-clock')
    return now
  }
  private transaction<T>(run: () => T): T {
    requireRemote(!this.closed, 'host-ledger-closed')
    return this.database.transaction(run).immediate()
  }
  private scopeIdentity(scope: NativeScope): void {
    validateRemote<NativeScope>(NativeScopeSchema, scope)
    const i = this.identity
    const b = scope.binding
    requireRemote(
      b.principalId === i.principalId &&
        b.environmentId === i.environmentId &&
        b.environmentGeneration === i.environmentGeneration &&
        scope.environmentIncarnation === i.environmentIncarnation &&
        scope.lease.ownerInstanceId === b.workerInstanceId,
      'host-environment-identity',
    )
  }
  private sessionWatermark(scope: NativeScope): NativeScope | undefined {
    const stored = this.database
      .prepare('SELECT payload,sha256 FROM native_host_sessions WHERE session_key=?')
      .get(logicalSession(scope)) as { payload: string; sha256: string } | undefined
    if (!stored) return undefined
    requireRemote(
      agentRemoteContentHash(stored.payload) === stored.sha256,
      'host-session-fence-corrupt',
    )
    const watermark: unknown = JSON.parse(stored.payload)
    validateRemote<NativeScope>(NativeScopeSchema, watermark)
    this.scopeIdentity(watermark)
    requireRemote(logicalSession(watermark) === logicalSession(scope), 'host-session-fence-corrupt')
    return watermark
  }
  private fence(scope: NativeScope, live = true, localOperation = false): Fence {
    this.scopeIdentity(scope)
    const session = this.sessionWatermark(scope)
    requireRemote(
      session && equal(session.binding, scope.binding) && equal(session.lease, scope.lease),
      'host-session-fence',
    )
    const stored = this.database
      .prepare('SELECT payload,sha256 FROM native_host_fences WHERE resource_key=?')
      .get(resource(scope)) as { payload: string; sha256: string } | undefined
    requireRemote(
      stored && agentRemoteContentHash(stored.payload) === stored.sha256,
      'host-fence-missing-or-corrupt',
    )
    const fence: unknown = JSON.parse(stored.payload)
    validateRemote<Fence>(FenceSchema, fence)
    requireRemote(
      localOperation
        ? equal(fence.scope.binding, scope.binding) && equal(fence.scope.lease, scope.lease)
        : equal(fence.scope, scope),
      'host-fence-mismatch',
    )
    if (live) requireRemote(fence.expiresAtMs > this.now(), 'host-lease-expired')
    return fence
  }
  installFence(
    scope: NativeScope,
    expiresAtMs: number,
    contextRevision: number,
    manifestRevision: string,
  ): void {
    scope = structuredClone(scope)
    this.transaction(() => {
      this.scopeIdentity(scope)
      const next: Fence = { scope, expiresAtMs, contextRevision, manifestRevision }
      validateRemote<Fence>(FenceSchema, next)
      requireRemote(expiresAtMs > this.now(), 'host-lease-expired')
      // Lease ownership belongs to the logical session, not a native UUID.
      // A reset/fork cannot leave an older UUID holding a usable old epoch.
      const session = this.sessionWatermark(scope)
      if (session) {
        requireRemote(scope.lease.epoch >= session.lease.epoch, 'host-old-epoch')
        requireRemote(
          scope.binding.bindingRevision >= session.binding.bindingRevision,
          'host-old-binding',
        )
        if (scope.lease.epoch === session.lease.epoch)
          requireRemote(
            equal(scope.binding, session.binding) && equal(scope.lease, session.lease),
            'host-epoch-owner-conflict',
          )
      }
      const stored = this.database
        .prepare('SELECT payload,sha256 FROM native_host_fences WHERE resource_key=?')
        .get(resource(scope)) as { payload: string; sha256: string } | undefined
      if (stored) {
        requireRemote(
          agentRemoteContentHash(stored.payload) === stored.sha256,
          'host-fence-corrupt',
        )
        const old: Fence = JSON.parse(stored.payload)
        validateRemote<Fence>(FenceSchema, old)
        requireRemote(scope.lease.epoch >= old.scope.lease.epoch, 'host-old-epoch')
        if (scope.lease.epoch === old.scope.lease.epoch)
          requireRemote(
            equal(scope.binding, old.scope.binding) && equal(scope.lease, old.scope.lease),
            'host-epoch-owner-conflict',
          )
        requireRemote(
          scope.binding.bindingRevision >= old.scope.binding.bindingRevision,
          'host-old-binding',
        )
        if (equal(scope.binding, old.scope.binding))
          requireRemote(contextRevision >= old.contextRevision, 'host-old-context')
      }
      // Installing a new watermark fences future calls, but does not prove the
      // previous executor stopped. Keep its running pipelines unresolved.
      const running = this.database
        .prepare(
          "SELECT operation_key FROM native_host_operations WHERE session_key=? AND phase IN ('pipeline-started','effective-input','call-started')",
        )
        .all(logicalSession(scope)) as { operation_key: string }[]
      for (const item of running) {
        const row = this.load(item.operation_key)
        if (
          row.sourceScope.lease.epoch < scope.lease.epoch ||
          (resource(row.sourceScope) === resource(scope) &&
            (row.request.body.contextRevision !== contextRevision ||
              row.request.body.manifestRevision !== manifestRevision))
        ) {
          row.phase = 'unknown'
          this.save(row)
        }
      }
      const watermarkPayload = remoteCanonical(scope)
      this.database
        .prepare(
          'INSERT INTO native_host_sessions VALUES(?,?,?) ON CONFLICT(session_key) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256',
        )
        .run(logicalSession(scope), watermarkPayload, agentRemoteContentHash(watermarkPayload))
      const payload = remoteCanonical(next)
      this.database
        .prepare(
          'INSERT INTO native_host_fences VALUES(?,?,?) ON CONFLICT(resource_key) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256',
        )
        .run(resource(scope), payload, agentRemoteContentHash(payload))
    })
  }
  private load(key: string, hash?: string): NativeHostRecord {
    const stored = this.database
      .prepare(
        'SELECT payload,sha256,phase,resource_key,session_key FROM native_host_operations WHERE operation_key=?',
      )
      .get(key) as
      | {
          payload: string
          sha256: string
          phase: string
          resource_key: string
          session_key: string
        }
      | undefined
    requireRemote(
      stored && agentRemoteContentHash(stored.payload) === stored.sha256,
      'host-operation-missing-or-corrupt',
    )
    const record: unknown = JSON.parse(stored.payload)
    validateRemote<NativeHostRecord>(RecordSchema, record)
    const { payloadHash, ...body } = record.request.body
    requireRemote(
      record.phase === stored.phase &&
        stored.resource_key === resource(record.sourceScope) &&
        stored.session_key === logicalSession(record.sourceScope) &&
        nativeOperationKey(record.request, record.request.operationId) === key &&
        nativeExecutionHash(record.request, record.request.operationId, body) === payloadHash &&
        (!hash || hash === payloadHash),
      'host-record-mismatch',
    )
    this.scopeIdentity(record.sourceScope)
    requireRemote(
      equal(record.request.binding, record.sourceScope.binding) &&
        record.request.nativeSessionId === record.sourceScope.nativeSessionId &&
        record.request.environmentIncarnation === record.sourceScope.environmentIncarnation &&
        record.executor.ledgerId === this.identity.ledgerId &&
        record.updatedAtMs >= record.createdAtMs,
      'host-record-identity',
    )
    requireRemote(terminal(record) === Boolean(record.receipt), 'host-record-terminal')
    if (record.receipt)
      requireRemote(
        record.receipt.body.status === record.phase &&
          record.receipt.body.payloadHash === payloadHash &&
          record.receipt.sha256 === nativeReceiptHash(payloadHash, record.receipt.body) &&
          record.eventCount > 0,
        'host-record-receipt',
      )
    if (['effective-input', 'call-started'].includes(record.phase))
      requireRemote(record.effectiveInput, 'host-record-input')
    return record
  }
  private save(record: NativeHostRecord): void {
    const now = this.now()
    requireRemote(now >= record.updatedAtMs, 'host-clock-regressed')
    record.updatedAtMs = now
    validateRemote<NativeHostRecord>(RecordSchema, record)
    requireRemote(record.updatedAtMs >= record.createdAtMs, 'host-clock-regressed')
    const payload = remoteCanonical(record)
    this.database
      .prepare(
        'INSERT INTO native_host_operations VALUES(?,?,?,?,?,?) ON CONFLICT(operation_key) DO UPDATE SET phase=excluded.phase,payload=excluded.payload,sha256=excluded.sha256',
      )
      .run(
        nativeOperationKey(record.request, record.request.operationId),
        resource(record.sourceScope),
        logicalSession(record.sourceScope),
        record.phase,
        payload,
        agentRemoteContentHash(payload),
      )
  }
  private locate(handle: object, pipeline = false): NativeHostRecord {
    const info = (pipeline ? this.permits : this.handles).get(handle)
    requireRemote(info, 'host-local-permit')
    return this.load(info.key, info.hash)
  }
  private executable(record: NativeHostRecord): void {
    const fence = this.fence(record.sourceScope, true, true)
    requireRemote(
      record.executor.hostInstanceId === this.hostInstanceId &&
        record.executor.ledgerId === this.identity.ledgerId &&
        record.phase !== 'unknown' &&
        !record.cancelRequested &&
        !terminal(record) &&
        record.request.body.deadlineAtMs > this.now() &&
        record.request.body.contextRevision === fence.contextRevision &&
        record.request.body.manifestRevision === fence.manifestRevision,
      'host-not-startable',
    )
  }
  accept(
    expected: NativeScope,
    controlGrant: NativeJournalRecord,
    frame: unknown,
  ): { record: NativeHostRecord; operation: NativeHostOperationHandle } {
    expected = structuredClone(expected)
    controlGrant = structuredClone(controlGrant)
    verifyNativeFrame(frame, expected, 'worker')
    requireRemote(frame.body.kind === 'native.execute', 'host-execution-kind')
    verifyNativeJournalRecord(controlGrant)
    const request: NativeIntent = {
      binding: expected.binding,
      nativeSessionId: expected.nativeSessionId,
      environmentIncarnation: expected.environmentIncarnation,
      operationId: frame.operationId,
      body: frame.body,
    }
    const key = nativeOperationKey(expected, frame.operationId)
    const record = this.transaction(() => {
      this.fence(expected, false)
      requireRemote(
        equal(request, controlGrant.request) &&
          equal(controlGrant.claim, expected.lease) &&
          controlGrant.dispatch?.hostInstanceId === this.hostInstanceId &&
          controlGrant.dispatch.ledgerId === this.identity.ledgerId &&
          ['dispatched', 'started'].includes(controlGrant.state) &&
          !controlGrant.cancelRequested &&
          !controlGrant.receipt,
        'host-unverified-grant',
      )
      const exists = this.database
        .prepare('SELECT 1 FROM native_host_operations WHERE operation_key=?')
        .get(key)
      if (exists) {
        const old = this.load(key, request.body.payloadHash)
        requireRemote(
          equal(old.request, request) && equal(old.executor, controlGrant.dispatch),
          'host-operation-conflict',
        )
        return old
      }
      this.fence(expected)
      requireRemote(request.body.deadlineAtMs > this.now(), 'host-deadline')
      const unresolved = this.database
        .prepare(
          "SELECT operation_key FROM native_host_operations WHERE session_key=? AND phase IN ('pipeline-started','effective-input','call-started','unknown')",
        )
        .all(logicalSession(expected)) as { operation_key: string }[]
      for (const item of unresolved) {
        const other = this.load(item.operation_key)
        requireRemote(
          other.phase !== 'unknown' &&
            other.executor.hostInstanceId === this.hostInstanceId &&
            equal(other.sourceScope.lease, expected.lease),
          'host-unresolved-execution',
        )
      }
      const count = this.database
        .prepare('SELECT count(*) AS count FROM native_host_operations')
        .get() as { count: number }
      requireRemote(count.count < 10000, 'host-journal-capacity')
      const row: NativeHostRecord = {
        version: 1,
        request,
        sourceScope: expected,
        executor: controlGrant.dispatch!,
        phase: 'accepted',
        cancelRequested: false,
        eventCount: 0,
        createdAtMs: this.now(),
        updatedAtMs: this.now(),
      }
      const cancelled = this.database
        .prepare('SELECT payload_hash FROM native_host_cancels WHERE operation_key=?')
        .get(key) as { payload_hash: string } | undefined
      if (cancelled) {
        requireRemote(cancelled.payload_hash === request.body.payloadHash, 'host-cancel-conflict')
        row.cancelRequested = true
      }
      this.save(row)
      if (row.cancelRequested)
        this.finalize(row, {
          kind: 'native.receipt',
          payloadHash: request.body.payloadHash,
          status: 'cancelled',
          code: 'not-started',
        })
      return row
    })
    const operation = Object.freeze({}) as NativeHostOperationHandle
    this.handles.set(operation, { key, hash: record.request.body.payloadHash })
    return { record: structuredClone(record), operation }
  }
  /** Commit before validation/permission/command hooks, not just tool.call. */
  beginPipeline(operation: NativeHostOperationHandle): NativeHostPipelineAdmission {
    return this.transaction(() => {
      const row = this.locate(operation)
      if (row.phase !== 'accepted') return { kind: 'evidence', record: structuredClone(row) }
      this.executable(row)
      row.phase = 'pipeline-started'
      this.save(row)
      const permit = Object.freeze({}) as NativeHostPipelinePermit
      this.permits.set(permit, {
        key: nativeOperationKey(row.request, row.request.operationId),
        hash: row.request.body.payloadHash,
      })
      return { kind: 'start', permit, record: structuredClone(row) }
    })
  }
  commitEffectiveInput(
    permit: NativeHostPipelinePermit,
    input: unknown,
    policyRevision: number,
  ): { sha256: string; policyRevision: number } {
    verifyNativeJson(input)
    const effective = { sha256: agentRemoteContentHash(remoteCanonical(input)), policyRevision }
    validateRemote(Type.Object({ sha256: digest, policyRevision: integer }, closed), effective)
    return this.transaction(() => {
      const row = this.locate(permit, true)
      this.executable(row)
      if (row.effectiveInput) {
        requireRemote(equal(row.effectiveInput, effective), 'host-effective-input-conflict')
        return structuredClone(row.effectiveInput)
      }
      requireRemote(row.phase === 'pipeline-started', 'host-pipeline-phase')
      row.effectiveInput = effective
      row.phase = 'effective-input'
      this.save(row)
      return structuredClone(effective)
    })
  }
  beginCanonicalCall(
    permit: NativeHostPipelinePermit,
    input: unknown,
    policyRevision: number,
  ): NativeHostCallAdmission {
    verifyNativeJson(input)
    const effective = { sha256: agentRemoteContentHash(remoteCanonical(input)), policyRevision }
    return this.transaction(() => {
      const row = this.locate(permit, true)
      if (row.phase !== 'effective-input') return { kind: 'evidence', record: structuredClone(row) }
      this.executable(row)
      requireRemote(equal(row.effectiveInput, effective), 'host-effective-input-conflict')
      row.phase = 'call-started'
      this.save(row)
      return { kind: 'call', sha256: effective.sha256 }
    })
  }
  private append(row: NativeHostRecord, body: NativeFrame['body']): NativeJournalEvent {
    // Ordinary events cannot consume the slot needed for a durable final receipt.
    requireRemote(
      !row.receipt && row.eventCount < (body.kind === 'native.receipt' ? 10000 : 9999),
      'host-event-sealed-or-capacity',
    )
    verifyNativeJson(body)
    validateRemote(NativeBodySchema, body)
    requireRemote(nativeOperationEventKindAllowed(body.kind), 'host-operation-event-kind')
    verifyNativeBodySemantics(row.request, row.request.operationId, 'execution', body)
    const event: NativeJournalEvent = {
      sequence: row.eventCount + 1,
      sender: 'execution',
      producerInstanceId: row.executor.hostInstanceId,
      ledgerId: row.executor.ledgerId,
      epoch: row.sourceScope.lease.epoch,
      body,
      sha256: '',
    }
    event.sha256 = nativeJournalEventHash(row.request.body.payloadHash, event)
    const payload = remoteCanonical(event)
    this.database
      .prepare('INSERT INTO native_host_events VALUES(?,?,?,?)')
      .run(
        nativeOperationKey(row.request, row.request.operationId),
        event.sequence,
        payload,
        agentRemoteContentHash(payload),
      )
    row.eventCount = event.sequence
    return event
  }
  appendExecutionEvent(
    permit: NativeHostPipelinePermit,
    body: NativeFrame['body'],
  ): NativeJournalEvent {
    requireRemote(body.kind !== 'native.receipt', 'host-use-finalize')
    return this.transaction(() => {
      const row = this.locate(permit, true)
      // A callback requests new permission/model work; it is not a passive late
      // observation. Revoked/cancelled pipelines cannot initiate another one.
      if (body.kind === 'native.callback') this.executable(row)
      const event = this.append(row, body)
      this.save(row)
      return structuredClone(event)
    })
  }
  private finalize(row: NativeHostRecord, receipt: FinalReceipt): void {
    validateRemote(NativeReceiptBodySchema, receipt)
    requireRemote(
      receipt.payloadHash === row.request.body.payloadHash &&
        ['completed', 'failed', 'cancelled'].includes(receipt.status),
      'host-receipt-mismatch',
    )
    if (row.receipt) {
      requireRemote(equal(row.receipt.body, receipt), 'host-receipt-conflict')
      return
    }
    this.append(row, receipt)
    row.receipt = {
      body: receipt,
      sha256: nativeReceiptHash(row.request.body.payloadHash, receipt),
    }
    row.phase = receipt.status
    this.save(row)
  }
  finish(permit: NativeHostPipelinePermit, receipt: FinalReceipt): NativeHostRecord {
    receipt = structuredClone(receipt)
    return this.transaction(() => {
      const row = this.locate(permit, true)
      if (receipt.status === 'cancelled' && !row.receipt)
        requireRemote(
          this.verifyCancellationExit?.(structuredClone(row)) === true,
          'host-cancel-exit-unproven',
        )
      this.finalize(row, receipt)
      return structuredClone(row)
    })
  }
  requestCancel(expected: NativeScope, frame: unknown): NativeHostRecord | undefined {
    expected = structuredClone(expected)
    verifyNativeFrame(frame, expected, 'worker')
    requireRemote(frame.body.kind === 'native.cancel', 'host-cancel-kind')
    const key = nativeOperationKey(expected, frame.operationId)
    const hash = frame.body.payloadHash
    return this.transaction(() => {
      this.fence(expected)
      const tombstone = this.database
        .prepare('SELECT payload_hash FROM native_host_cancels WHERE operation_key=?')
        .get(key) as { payload_hash: string } | undefined
      requireRemote(!tombstone || tombstone.payload_hash === hash, 'host-cancel-conflict')
      if (!tombstone) {
        const count = this.database
          .prepare('SELECT count(*) AS count FROM native_host_cancels')
          .get() as { count: number }
        requireRemote(count.count < 10000, 'host-cancel-capacity')
      }
      this.database
        .prepare(
          'INSERT INTO native_host_cancels VALUES(?,?) ON CONFLICT(operation_key) DO NOTHING',
        )
        .run(key, hash)
      if (
        !this.database
          .prepare('SELECT 1 FROM native_host_operations WHERE operation_key=?')
          .get(key)
      )
        return undefined
      const row = this.load(key, hash)
      if (!terminal(row)) {
        row.cancelRequested = true
        if (row.phase === 'accepted')
          this.finalize(row, {
            kind: 'native.receipt',
            payloadHash: hash,
            status: 'cancelled',
            code: 'not-started',
          })
        else this.save(row)
      }
      return structuredClone(row)
    })
  }
  /** Lost communication/executor observations never imply effects did not run.
   * accepted rows remain startable only under their still-current live fence. */
  markExecutorUnknown(hostInstanceId: string): number {
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          "SELECT operation_key FROM native_host_operations WHERE phase IN ('pipeline-started','effective-input','call-started')",
        )
        .all() as { operation_key: string }[]
      let changed = 0
      for (const key of rows) {
        const row = this.load(key.operation_key)
        if (row.executor.hostInstanceId !== hostInstanceId) continue
        row.phase = 'unknown'
        this.save(row)
        changed++
      }
      return changed
    })
  }
  query(expected: NativeScope, operationId: string, payloadHash: string): NativeHostRecord {
    return this.queryHistory(expected, {
      nativeSessionId: expected.nativeSessionId,
      operationId,
      payloadHash,
    })
  }
  /** Current authenticated session authority may inspect its old native UUIDs;
   * this never installs/reactivates an execution fence for the historical UUID. */
  queryHistory(authority: NativeScope, target: NativeHostEvidenceReference): NativeHostRecord {
    verifyNativeJson(target)
    validateRemote<NativeHostEvidenceReference>(EvidenceReferenceSchema, target)
    return this.transaction(() => {
      this.fence(authority, false)
      return structuredClone(
        this.load(
          nativeOperationKey(
            { ...authority, nativeSessionId: target.nativeSessionId },
            target.operationId,
          ),
          target.payloadHash,
        ),
      )
    })
  }
  replayEvents(
    expected: NativeScope,
    operationId: string,
    payloadHash: string,
    afterSequence: number,
    limit = 100,
  ): NativeJournalEvent[] {
    return this.replayHistoryEvents(
      expected,
      { nativeSessionId: expected.nativeSessionId, operationId, payloadHash },
      afterSequence,
      limit,
    )
  }
  replayHistoryEvents(
    authority: NativeScope,
    target: NativeHostEvidenceReference,
    afterSequence: number,
    limit = 100,
  ): NativeJournalEvent[] {
    verifyNativeJson(target)
    validateRemote<NativeHostEvidenceReference>(EvidenceReferenceSchema, target)
    const { operationId, payloadHash } = target
    requireRemote(
      Number.isSafeInteger(afterSequence) &&
        afterSequence >= 0 &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 100,
      'host-event-cursor',
    )
    return this.transaction(() => {
      this.fence(authority, false)
      const key = nativeOperationKey(
        { ...authority, nativeSessionId: target.nativeSessionId },
        operationId,
      )
      const row = this.load(key, payloadHash)
      requireRemote(afterSequence <= row.eventCount, 'host-event-cursor')
      const stored = this.database
        .prepare(
          'SELECT sequence,payload,sha256 FROM native_host_events WHERE operation_key=? AND sequence>? ORDER BY sequence LIMIT ?',
        )
        .all(key, afterSequence, limit) as { sequence: number; payload: string; sha256: string }[]
      let expectedSequence = afterSequence + 1
      const result = stored.map((item) => {
        requireRemote(
          item.sequence === expectedSequence++ &&
            agentRemoteContentHash(item.payload) === item.sha256,
          'host-event-corrupt',
        )
        const event: unknown = JSON.parse(item.payload)
        validateRemote<NativeJournalEvent>(NativeJournalEventSchema, event)
        requireRemote(
          event.sender === 'execution' &&
            event.sequence === item.sequence &&
            event.producerInstanceId === row.executor.hostInstanceId &&
            event.ledgerId === row.executor.ledgerId &&
            event.epoch === row.sourceScope.lease.epoch &&
            event.sha256 === nativeJournalEventHash(payloadHash, event),
          'host-event-corrupt',
        )
        requireRemote(nativeOperationEventKindAllowed(event.body.kind), 'host-operation-event-kind')
        verifyNativeBodySemantics(row.request, operationId, event.sender, event.body)
        return event
      })
      requireRemote(
        result.length === Math.min(limit, row.eventCount - afterSequence),
        'host-event-prefix-missing',
      )
      return result
    })
  }
  close(): void {
    if (!this.closed) {
      this.database.close()
      this.closed = true
    }
  }
}
