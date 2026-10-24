/** Master-private durable action ledger. No implicit HOME, PG, network, or database at module import. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import Database from 'better-sqlite3'
import type {
  SystemActionDetail, SystemActionExecutor, SystemActionPreview,
  SystemActionResult, SystemActionState, SystemActionSummary,
} from '@openclaude/protocol'

const TERMINAL = "'succeeded','failed','denied','expired','unknown'"
const MAX_BYTES = 4 * 1024 * 1024 // Security/storage bound; large content must use an immutable artifact reference.
export class SystemActionError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'EXPIRED' | 'INVALID_PROOF' | 'INVALID_INPUT' | 'RECONCILIATION_REQUIRED') {
    super(code)
    this.name = 'SystemActionError'
  }
}
export interface PrepareSystemAction {
  userId: string
  sessionId: string
  agentId: string
  operationId: string
  /** Fixed registry label, not a user resource name. */
  operationTitle: string
  operationVersion: number
  executor: SystemActionExecutor
  resourceKey: string
  idempotencyKey: string
  /** Stable original request digest, independent of the current resource snapshot. */
  requestHash?: string
  args: unknown
  preview: SystemActionPreview
  quoteHash?: string
  expectedVersion?: string
  ttlMs?: number
}
export interface SystemActionExecution {
  id: string
  userId: string
  executorId: string
  operationId: string
  operationVersion: number
  sessionId: string
  agentId: string
  executionNonce: string
  /** Immutable request and frozen-input digests, never an execution grant. */
  requestHash: string | null
  inputHash: string
  args: unknown
  preview: SystemActionPreview
  quoteHash: string | null
  expectedVersion: string | null
}
export type SystemActionReceiptBinding = Pick<SystemActionExecution,
  'id' | 'userId' | 'sessionId' | 'agentId' | 'operationId' | 'operationVersion' | 'requestHash' | 'inputHash'>
interface Row {
  id: string; user_id: string; session_id: string; agent_id: string
  operation_id: string; operation_version: number; executor: SystemActionExecutor
  resource_key: string; idempotency_key: string; request_hash: string | null; input_hash: string; preview_hash: string
  title: string; state: SystemActionState; created_at: number; updated_at: number; expires_at: number
  sealed: string | null; quote_hash: string | null; expected_version: string | null
  device_id: string | null; approval_hash: string | null; grant_hash: string | null
  execution_hash: string | null; executor_id: string | null; result_json: string | null
}
interface Sealed { args: unknown; preview: SystemActionPreview }
function digest(s: string): string { return createHash('sha256').update(s).digest('hex') }
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new SystemActionError('INVALID_INPUT')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const v = value as Record<string, unknown>
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k], depth + 1)}`).join(',')}}`
  }
  throw new SystemActionError('INVALID_INPUT')
}
function hasControl(value: string, allowWhitespace = false): boolean {
  return [...value].some(ch => {
    const n = ch.charCodeAt(0)
    return n === 127 || (n < 32 && !(allowWhitespace && (n === 9 || n === 10 || n === 13)))
  })
}
function required(value: string, max = 512): void {
  if (typeof value !== 'string' || !value || value.length > max || hasControl(value)) throw new SystemActionError('INVALID_INPUT')
}
function sameHash(a: string | null, b: string): boolean {
  return Boolean(typeof b === 'string' && b.length <= 128 && a && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(digest(b), 'hex')))
}
function content(value: string, max: number): void {
  if (typeof value !== 'string' || value.length > max || hasControl(value, true)) throw new SystemActionError('INVALID_INPUT')
}
function validatePreview(p: SystemActionPreview): void {
  if (!p || typeof p !== 'object') throw new SystemActionError('INVALID_INPUT')
  required(p.title, 200); content(p.description, 4000); required(p.scope, 2000)
  if (typeof p.destructive !== 'boolean' || !Array.isArray(p.before) || !Array.isArray(p.after) || !Array.isArray(p.consequences)) throw new SystemActionError('INVALID_INPUT')
  for (const row of [...p.before, ...p.after]) { required(row.label, 500); content(row.value, 20000) }
  for (const text of p.consequences) required(text, 4000)
  if (!p.price || !['none', 'fixed', 'usage'].includes(p.price.kind)) throw new SystemActionError('INVALID_INPUT')
  required(p.price.label, 2000)
  if (p.price.kind === 'fixed' && (!/^\d{1,24}$/.test(p.price.amountFen ?? '') || !['CNY', 'credits'].includes(p.price.unit ?? ''))) throw new SystemActionError('INVALID_INPUT')
  if (p.price.kind === 'usage' && !p.price.rates?.length) throw new SystemActionError('INVALID_INPUT')
  for (const row of p.price.rates ?? []) { required(row.label, 500); content(row.value, 4000) }
  if (p.price.note !== undefined) content(p.price.note, 4000)
}

function validatedResult(result: SystemActionResult): SystemActionResult {
  required(result.summary, 4000)
  const safeResult: SystemActionResult = { summary: result.summary, completion: result.completion }
  if (result.code !== undefined) { required(result.code, 200); safeResult.code = result.code }
  if (result.effectReference !== undefined) { required(result.effectReference, 512); safeResult.effectReference = result.effectReference }
  if (!['done','accepted','awaiting_user'].includes(result.completion)) throw new SystemActionError('INVALID_INPUT')
  return safeResult
}

export class SystemActionStore {
  private readonly db: Database.Database
  private readonly key: Buffer
  private readonly now: () => number
  constructor(options: { dbPath: string; key: Buffer; now?: () => number; busyTimeoutMs?: number }) {
    if (!isAbsolute(options.dbPath) || (!Buffer.isBuffer(options.key) || options.key.length !== 32)) throw new SystemActionError('INVALID_INPUT')
    const dir = dirname(options.dbPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new SystemActionError('INVALID_INPUT')
    if (existsSync(options.dbPath) && (!lstatSync(options.dbPath).isFile() || lstatSync(options.dbPath).isSymbolicLink())) throw new SystemActionError('INVALID_INPUT')
    this.key = Buffer.from(options.key)
    this.now = options.now ?? Date.now
    this.db = new Database(options.dbPath)
    try {
      chmodSync(options.dbPath, 0o600)
      this.db.pragma(`busy_timeout = ${Math.max(1, Math.floor(options.busyTimeoutMs ?? 10000))}`)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = FULL')
      this.db.pragma('secure_delete = ON')
      this.db.transaction(() => {
        const version = this.db.pragma('user_version', { simple: true }) as number
      if (![0, 1, 2].includes(version)) throw new Error('Unsupported system action ledger version')
      this.db.exec(`CREATE TABLE IF NOT EXISTS system_actions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, operation_version INTEGER NOT NULL, executor TEXT NOT NULL,
        resource_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT, input_hash TEXT NOT NULL, preview_hash TEXT NOT NULL,
        title TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','approved_waiting_browser','executing',${TERMINAL})),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        sealed TEXT, quote_hash TEXT, expected_version TEXT, device_id TEXT, approval_hash TEXT,
        grant_hash TEXT, execution_hash TEXT, executor_id TEXT, result_json TEXT,
        UNIQUE(user_id,idempotency_key),
        CHECK(executor IN ('master','control','browser')),
        CHECK(state NOT IN (${TERMINAL}) OR (sealed IS NULL AND approval_hash IS NULL AND grant_hash IS NULL AND execution_hash IS NULL))
      );
      CREATE INDEX IF NOT EXISTS system_actions_actor_state ON system_actions(user_id,state,updated_at);
      CREATE INDEX IF NOT EXISTS system_actions_expiry ON system_actions(state,expires_at);
      CREATE INDEX IF NOT EXISTS system_actions_executor ON system_actions(executor_id,state);`)
      const columns = this.db.pragma('table_info(system_actions)') as { name: string }[]
      if (!columns.some(column => column.name === 'request_hash')) {
        // v0 may be a v1 table whose old process stopped before setting user_version.
        if (version === 2) throw new Error('Invalid system action ledger schema')
        this.db.exec('ALTER TABLE system_actions ADD COLUMN request_hash TEXT')
      }
      this.db.pragma('user_version = 2')
      }).immediate()
      for (const suffix of ['-wal', '-shm']) if (existsSync(options.dbPath + suffix)) chmodSync(options.dbPath + suffix, 0o600)
    } catch (e) { this.db.close(); this.key.fill(0); throw e }
  }
  private row(userId: string, id: string): Row {
    const r = this.db.prepare('SELECT * FROM system_actions WHERE id=? AND user_id=?').get(id, userId) as Row | undefined
    if (!r) throw new SystemActionError('NOT_FOUND')
    return r
  }
  private aad(r: Pick<Row, 'id' | 'user_id' | 'input_hash'>): Buffer { return Buffer.from(`${r.id}:${r.user_id}:${r.input_hash}`) }
  private seal(value: Sealed, r: Pick<Row, 'id' | 'user_id' | 'input_hash'>): string {
    const plain = canonical(value)
    if (Buffer.byteLength(plain) > MAX_BYTES) throw new SystemActionError('INVALID_INPUT')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(this.aad(r))
    const out = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), out.toString('base64url')].join('.')
  }
  private open(r: Row): Sealed {
    if (!r.sealed) throw new SystemActionError('CONFLICT')
    const [version, iv, tag, bytes] = r.sealed.split('.')
    if (version !== 'v1' || !iv || !tag || !bytes) throw new Error('Invalid sealed action')
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    cipher.setAAD(this.aad(r)); cipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(bytes, 'base64url')), cipher.final()]).toString('utf8')) as Sealed
  }
  private summary(r: Row): SystemActionSummary {
    return { id: r.id, operationId: r.operation_id, title: r.title, state: r.state, executor: r.executor,
      createdAt: r.created_at, expiresAt: r.expires_at, updatedAt: r.updated_at,
      result: r.result_json ? JSON.parse(r.result_json) as SystemActionResult : null }
  }
  private clearTerminal(id: string, userId: string, state: SystemActionState, result: SystemActionResult | null): void {
    this.db.prepare(`UPDATE system_actions SET state=?,sealed=NULL,approval_hash=NULL,grant_hash=NULL,execution_hash=NULL,
      result_json=?,updated_at=? WHERE id=? AND user_id=?`).run(state, result ? canonical(result) : null, this.now(), id, userId)
  }
  expire(): number {
    return this.db.prepare(`UPDATE system_actions SET state='expired',sealed=NULL,approval_hash=NULL,grant_hash=NULL,execution_hash=NULL,updated_at=?
      WHERE state IN ('prepared','approved_waiting_browser') AND expires_at<=?`).run(this.now(), this.now()).changes
  }
  /** Owner-scoped replay before recomputing a business preview. Does not authorize a new write. */
  replayPrepared(userId: string, idempotencyKey: string, requestHash: string): SystemActionSummary | null {
    required(userId); required(idempotencyKey)
    if (!/^[a-f0-9]{64}$/.test(requestHash)) throw new SystemActionError('INVALID_INPUT')
    this.expire()
    const existing = this.db.prepare('SELECT * FROM system_actions WHERE user_id=? AND idempotency_key=?').get(userId, idempotencyKey) as Row | undefined
    if (!existing) return null
    if (existing.request_hash !== requestHash) throw new SystemActionError('CONFLICT')
    return this.summary(existing)
  }
  prepare(input: PrepareSystemAction): SystemActionSummary {
    for (const v of [input.userId, input.sessionId, input.agentId, input.operationId, input.operationTitle, input.resourceKey, input.idempotencyKey]) required(v)
    if (!/^[1-9]\d{0,18}$/.test(input.userId) || !Number.isSafeInteger(input.operationVersion) || input.operationVersion < 1 || !['master','control','browser'].includes(input.executor)) throw new SystemActionError('INVALID_INPUT')
    if (input.requestHash !== undefined && !/^[a-f0-9]{64}$/.test(input.requestHash)) throw new SystemActionError('INVALID_INPUT')
    validatePreview(input.preview)
    const body = { args: input.args, preview: input.preview }
    const inputHash = digest(canonical({ ...body, operationId: input.operationId, operationVersion: input.operationVersion,
      resourceKey: input.resourceKey, operationTitle: input.operationTitle, executor: input.executor, quoteHash: input.quoteHash ?? null, expectedVersion: input.expectedVersion ?? null,
      sessionId: input.sessionId, agentId: input.agentId }))
    const previewHash = digest(canonical({ preview: input.preview, inputHash }))
    this.expire()
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM system_actions WHERE user_id=? AND idempotency_key=?').get(input.userId, input.idempotencyKey) as Row | undefined
      if (existing) {
        if (input.requestHash !== undefined ? existing.request_hash !== input.requestHash : existing.input_hash !== inputHash) throw new SystemActionError('CONFLICT')
        return this.summary(existing)
      }
      if (this.db.prepare("SELECT 1 FROM system_actions WHERE user_id=? AND resource_key=? AND state='unknown'").get(input.userId, digest(input.resourceKey))) throw new SystemActionError('RECONCILIATION_REQUIRED')
      const id = randomUUID()
      const now = this.now()
      const ttl = input.ttlMs ?? 300000
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 3600000) throw new SystemActionError('INVALID_INPUT')
      const sealed = this.seal(body, { id, user_id: input.userId, input_hash: inputHash })
      this.db.prepare(`INSERT INTO system_actions (id,user_id,session_id,agent_id,operation_id,operation_version,executor,
        resource_key,idempotency_key,request_hash,input_hash,preview_hash,title,state,created_at,updated_at,expires_at,sealed,quote_hash,expected_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?,?)`).run(id, input.userId, input.sessionId, input.agentId, input.operationId,
        input.operationVersion, input.executor, digest(input.resourceKey), input.idempotencyKey, input.requestHash ?? null, inputHash, previewHash, input.operationTitle,
        now, now, now + ttl, sealed, input.quoteHash ?? null, input.expectedVersion ?? null)
      return this.summary(this.row(input.userId, id))
    }).immediate()
  }
  get(userId: string, id: string): SystemActionSummary { this.expire(); return this.summary(this.row(userId, id)) }
  detail(userId: string, id: string): SystemActionDetail {
    this.expire(); const r = this.row(userId, id)
    return { ...this.summary(r), previewHash: r.preview_hash, preview: r.sealed ? this.open(r).preview : null }
  }
  issueChallenge(userId: string, id: string, deviceId: string, previewHash: string): string {
    required(deviceId, 128)
    this.expire()
    return this.db.transaction(() => {
      const r = this.row(userId, id)
      if (r.state === 'expired') throw new SystemActionError('EXPIRED')
      if (r.state !== 'prepared' || r.preview_hash !== previewHash) throw new SystemActionError('CONFLICT')
      const nonce = randomBytes(32).toString('base64url')
      this.db.prepare("UPDATE system_actions SET approval_hash=?,device_id=?,updated_at=? WHERE id=? AND user_id=? AND state='prepared'").run(digest(nonce), deviceId, this.now(), id, userId)
      return nonce
    }).immediate()
  }
  /** Checked under the IMMEDIATE write transaction, including proposals made before an unknown result. */
  private assertResourceAvailable(r: Row): void {
    const blocked = this.db.prepare("SELECT state FROM system_actions WHERE user_id=? AND resource_key=? AND id<>? AND state IN ('unknown','executing') ORDER BY CASE state WHEN 'unknown' THEN 0 ELSE 1 END LIMIT 1").get(r.user_id, r.resource_key, r.id) as { state: string } | undefined
    if (blocked) throw new SystemActionError(blocked.state === 'unknown' ? 'RECONCILIATION_REQUIRED' : 'CONFLICT')
  }
  private verifyPending(userId: string, id: string, proof: { nonce: string; previewHash: string; deviceId: string }): Row {
    required(proof.nonce, 128); required(proof.deviceId, 128); required(proof.previewHash, 128)
    const r = this.row(userId, id)
    if (r.state === 'expired') throw new SystemActionError('EXPIRED')
    if (r.state !== 'prepared') throw new SystemActionError('CONFLICT')
    this.assertResourceAvailable(r)
    if (r.preview_hash !== proof.previewHash || r.device_id !== proof.deviceId || !sameHash(r.approval_hash, proof.nonce)) throw new SystemActionError('INVALID_PROOF')
    return r
  }
  confirm(userId: string, id: string, proof: { nonce: string; previewHash: string; deviceId: string }, executorId: string): SystemActionExecution | { browserGrant: string; action: SystemActionSummary } {
    required(executorId, 128)
    this.expire()
    return this.db.transaction(() => {
      const r = this.verifyPending(userId, id, proof)
      const body = this.open(r)
      const nonce = randomBytes(32).toString('base64url')
      const browser = r.executor === 'browser'
      const changed = this.db.prepare(`UPDATE system_actions SET state=?,approval_hash=NULL,grant_hash=?,execution_hash=?,executor_id=?,updated_at=?
        WHERE id=? AND user_id=? AND state='prepared' AND approval_hash=? AND preview_hash=? AND expires_at>?`).run(
        browser ? 'approved_waiting_browser' : 'executing', browser ? digest(nonce) : null, browser ? null : digest(nonce),
        executorId, this.now(), id, userId, r.approval_hash, proof.previewHash, this.now()).changes
      if (changed !== 1) throw new SystemActionError('CONFLICT')
      if (browser) return { browserGrant: nonce, action: this.summary(this.row(userId, id)) }
      return { id, userId, executorId, operationId: r.operation_id, operationVersion: r.operation_version, sessionId: r.session_id, agentId: r.agent_id, executionNonce: nonce, requestHash: r.request_hash, inputHash: r.input_hash, args: body.args, preview: body.preview, quoteHash: r.quote_hash, expectedVersion: r.expected_version }
    }).immediate()
  }
  renewBrowserGrant(userId: string, id: string, deviceId: string): string {
    this.expire()
    return this.db.transaction(() => {
      const r = this.row(userId, id)
      if (r.state !== 'approved_waiting_browser' || r.device_id !== deviceId) throw new SystemActionError('CONFLICT')
      const nonce = randomBytes(32).toString('base64url')
      this.db.prepare("UPDATE system_actions SET grant_hash=?,updated_at=? WHERE id=? AND user_id=? AND state='approved_waiting_browser'").run(digest(nonce), this.now(), id, userId)
      return nonce
    }).immediate()
  }
  claimBrowser(userId: string, id: string, deviceId: string, grant: string, executorId: string): SystemActionExecution {
    required(executorId, 128)
    this.expire()
    return this.db.transaction(() => {
      const r = this.row(userId, id)
      if (r.state !== 'approved_waiting_browser') throw new SystemActionError('CONFLICT')
      this.assertResourceAvailable(r)
      if (r.device_id !== deviceId || !sameHash(r.grant_hash, grant)) throw new SystemActionError('INVALID_PROOF')
      const body = this.open(r)
      const nonce = randomBytes(32).toString('base64url')
      if (this.db.prepare("UPDATE system_actions SET state='executing',grant_hash=NULL,execution_hash=?,executor_id=?,updated_at=? WHERE id=? AND user_id=? AND state='approved_waiting_browser' AND grant_hash=? AND expires_at>?").run(digest(nonce), executorId, this.now(), id, userId, r.grant_hash, this.now()).changes !== 1) throw new SystemActionError('CONFLICT')
      return { id, userId, executorId, operationId: r.operation_id, operationVersion: r.operation_version, sessionId: r.session_id, agentId: r.agent_id, executionNonce: nonce, requestHash: r.request_hash, inputHash: r.input_hash, args: body.args, preview: body.preview, quoteHash: r.quote_hash, expectedVersion: r.expected_version }
    }).immediate()
  }
  deny(userId: string, id: string): SystemActionSummary {
    this.expire()
    return this.db.transaction(() => {
      const r = this.row(userId, id)
      if (!['prepared','approved_waiting_browser'].includes(r.state)) throw new SystemActionError('CONFLICT')
      this.clearTerminal(id, userId, 'denied', null)
      return this.summary(this.row(userId, id))
    }).immediate()
  }
  finish(handle: Pick<SystemActionExecution, 'id' | 'userId' | 'executorId' | 'executionNonce'>, state: 'succeeded' | 'failed' | 'unknown', result: SystemActionResult): SystemActionSummary {
    if (!['succeeded','failed','unknown'].includes(state)) throw new SystemActionError('INVALID_INPUT')
    const safeResult = validatedResult(result)
    return this.db.transaction(() => {
      const r = this.row(handle.userId, handle.id)
      if (r.state !== 'executing' || r.executor_id !== handle.executorId || !sameHash(r.execution_hash, handle.executionNonce)) throw new SystemActionError('INVALID_PROOF')
      this.clearTerminal(r.id, r.user_id, state, safeResult)
      return this.summary(this.row(r.user_id, r.id))
    }).immediate()
  }
  /** Host-only positive receipt binding. Unknown rows have already discarded executable arguments. */
  unknownReceiptBinding(userId: string, id: string): SystemActionReceiptBinding | null {
    const r = this.row(userId, id)
    if (r.state !== 'unknown' || !r.request_hash) return null
    return { id: r.id, userId: r.user_id, sessionId: r.session_id, agentId: r.agent_id,
      operationId: r.operation_id, operationVersion: r.operation_version, requestHash: r.request_hash, inputHash: r.input_hash }
  }
  /** Trusted receipt lookup only: no grant, rerun, current-value inference or live-executor takeover. */
  reconcileUnknownFromReceipt(binding: SystemActionReceiptBinding, result: SystemActionResult): SystemActionSummary {
    const safeResult = validatedResult(result)
    return this.db.transaction(() => {
      const r = this.row(binding.userId, binding.id)
      if (r.state !== 'unknown' || !r.request_hash || r.request_hash !== binding.requestHash || r.input_hash !== binding.inputHash
        || r.session_id !== binding.sessionId || r.agent_id !== binding.agentId || r.operation_id !== binding.operationId
        || r.operation_version !== binding.operationVersion) throw new SystemActionError('INVALID_PROOF')
      this.clearTerminal(r.id, r.user_id, 'succeeded', safeResult)
      return this.summary(this.row(r.user_id, r.id))
    }).immediate()
  }
  /** Trusted supervisor only, after proving this executor is gone. Never an agent/user API or constructor side effect. */
  markExecutorLost(executorId: string): number {
    const result = canonical({ summary: '执行结果待核对，请勿重复执行。', completion: 'accepted', code: 'EXECUTOR_LOST' })
    return this.db.prepare("UPDATE system_actions SET state='unknown',sealed=NULL,approval_hash=NULL,grant_hash=NULL,execution_hash=NULL,result_json=?,updated_at=? WHERE state='executing' AND executor_id=?").run(result, this.now(), executorId).changes
  }
  close(): void { try { this.db.close() } finally { this.key.fill(0) } }
}

/** Hash request data only, never desired resource versions, quotes or generated previews. */
export function systemActionRequestHash(value: unknown): string {
  const serialized = canonical(value)
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new SystemActionError('INVALID_INPUT')
  return digest(serialized)
}
