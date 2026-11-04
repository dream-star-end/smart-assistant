/** Read-only, launch-bound fallback for the pinned Antigravity 1.4.0 CLI.
 * Lifecycle eligibility (SUCCESS + actual close/exit 0, no cancel/error/text) belongs
 * to the adapter. This module never starts a process, executes tools, or persists text.
 */
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import protobuf from 'protobufjs'
import { antigravityNativeSchema } from './antigravityNativeSchema.js'

export const ANTIGRAVITY_NATIVE_CLI_SHA256 = '60e72242f07c131f75afcd9a9e425d6ee097a1a1b3190ea98ae78fa4180bbfa8'
export interface AntigravityNativeDependencies {
  /** Explicit test seam for fakeCLI fixtures; never selected by an environment variable. */
  verifyBinary?: (cliPath: string, expectedSha256: string) => Promise<boolean>
}
export interface AntigravityNativePrepareInput {
  cliPath: string
  conversationsDir: string
  requestedResumeId?: string
  message: { content: string }
}
export interface AntigravityNativeBinding {
  /** Inclusive pre-spawn MAX(idx). null means no trustworthy stdout watermark. */
  readonly baseline: number | null
  readonly binaryVerified: boolean
  readonly reason?: string
}
export type AntigravityNativeRecovery =
  | { ok: true; text: string; stepIndex: number; hash: string }
  | { ok: false; reason: string }

type Identity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint }
const identity = (s: Identity) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(':')
const binaryCache = new Map<string, { identity: string; verified: boolean }>()
const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')
const validId = (id: unknown): id is string => typeof id === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)

/** Async streaming hash, bound to both open-file and path stat identities. */
export async function verifyAntigravityNativeBinary(cliPath: string, expectedSha256 = ANTIGRAVITY_NATIVE_CLI_SHA256): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const resolved = await realpath(cliPath)
    handle = await open(resolved, 'r')
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) return false
    const key = identity(before)
    const cached = binaryCache.get(resolved)
    let verified: boolean
    if (cached?.identity === key && expectedSha256 === ANTIGRAVITY_NATIVE_CLI_SHA256) {
      verified = cached.verified
    } else {
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      verified = hash.digest('hex') === expectedSha256
    }
    if (identity(await handle.stat({ bigint: true })) !== key
      || await realpath(cliPath) !== resolved
      || identity(await stat(resolved, { bigint: true })) !== key) return false
    if (expectedSha256 === ANTIGRAVITY_NATIVE_CLI_SHA256) {
      if (binaryCache.size >= 32) binaryCache.clear()
      binaryCache.set(resolved, { identity: key, verified })
    }
    return verified
  } catch { return false } finally { await handle?.close().catch(() => {}) }
}

interface Launch {
  cliPath: string
  directory: string
  requestedResumeId?: string
  inputHash: string
  verifier: NonNullable<AntigravityNativeDependencies['verifyBinary']>
  existingFiles: Set<string>
  preparedAt: number
  databaseIdentity?: string
  baselineHash?: string
}
const launches = new WeakMap<AntigravityNativeBinding, Launch>()
const fileIdentity = (s: Stats) => `${s.dev}:${s.ino}`
interface Row { idx: number; step_type: number; status: number; step_format: number; step_payload: Buffer; metadata: Buffer | null }
const rowHash = (r: Row) => sha256(Buffer.concat([
  Buffer.from(JSON.stringify([r.idx, r.step_type, r.status, r.step_format])), r.step_payload, r.metadata ?? Buffer.alloc(0),
]))

function readOnly<T>(directory: string, id: string, read: (db: Database.Database, file: Stats) => T): T {
  const filename = path.join(directory, `${id}.db`)
  const before = lstatSync(filename)
  if (!before.isFile() || realpathSync(filename) !== filename) throw new Error('unsafe-database-path')
  const db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    db.pragma('query_only = ON')
    return db.transaction(() => {
      const result = read(db, before)
      if (fileIdentity(lstatSync(filename)) !== fileIdentity(before)) throw new Error('database-replaced')
      return result
    })()
  } finally { db.close() }
}
const rowColumns = 'idx, step_type, status, step_format, step_payload, metadata'

export async function prepareAntigravityNativeTrajectory(
  input: AntigravityNativePrepareInput,
  deps: AntigravityNativeDependencies = {},
): Promise<AntigravityNativeBinding> {
  let baseline: number | null = null
  let binaryVerified = false
  try {
    const verifier = deps.verifyBinary ?? verifyAntigravityNativeBinary
    // A verifier failure must not prevent an otherwise safe stdout watermark read.
    try { binaryVerified = await verifier(input.cliPath, ANTIGRAVITY_NATIVE_CLI_SHA256) } catch { /* fail closed */ }
    let directory: string
    let existingFiles: string[]
    try {
      directory = await realpath(input.conversationsDir)
      existingFiles = await readdir(directory)
    } catch (error) {
      if (input.requestedResumeId !== undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // No writes during prepare: resolve missing fresh directories via their nearest
      // existing ancestor. Recovery still checks the canonical path and file birthtime.
      const missing: string[] = []
      let ancestor = path.resolve(input.conversationsDir)
      for (;;) {
        try { directory = path.join(await realpath(ancestor), ...missing); break } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw cause
          missing.unshift(path.basename(ancestor))
          ancestor = path.dirname(ancestor)
        }
      }
      existingFiles = []
    }
    const launch: Launch = {
      cliPath: input.cliPath, directory, requestedResumeId: input.requestedResumeId,
      inputHash: sha256(Buffer.from(input.message.content, 'utf8')), verifier,
      preparedAt: Date.now(), existingFiles: new Set(existingFiles),
    }
    if (input.requestedResumeId !== undefined) {
      if (!validId(input.requestedResumeId)) throw new Error('invalid-conversation-id')
      readOnly(directory, input.requestedResumeId, (db, file) => {
        const value = (db.prepare('SELECT MAX(idx) AS baseline FROM steps').get() as { baseline: unknown }).baseline
        if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0)) throw new Error('invalid-baseline')
        baseline = value === null ? -1 : value as number
        launch.databaseIdentity = fileIdentity(file)
        if (baseline >= 0) {
          // An unsupported schema can still expose MAX(idx) for stdout filtering.
          try {
            const row = db.prepare(`SELECT ${rowColumns} FROM steps WHERE idx = ?`).get(baseline) as Row
            launch.baselineHash = rowHash(row)
          } catch { /* recovery requires this anchor; watermark does not */ }
        }
      })
    } else baseline = -1
    const reason = !binaryVerified ? 'binary-unverified'
      : baseline !== null && baseline >= 0 && !launch.baselineHash ? 'unsupported-baseline-schema' : undefined
    const binding = Object.freeze({ baseline, binaryVerified, ...(reason ? { reason } : {}) })
    launches.set(binding, launch)
    return binding
  } catch {
    return Object.freeze({ baseline, binaryVerified, reason: 'prepare-unavailable' })
  }
}

// protobufjs normally skips unknown fields and accepts unknown enum numbers. Validate
// the wire against the descriptor projection first, then use its standard decoder.
const root = protobuf.Root.fromJSON(antigravityNativeSchema).resolveAll()
const stepType = root.lookupType('gemini_coder_Step')
const metadataType = root.lookupType('exa_cortex_pb_CortexStepMetadata')
const utf8 = new TextDecoder('utf-8', { fatal: true })
const scalarWire: Record<string, number> = {
  double: 1, float: 5, int64: 0, uint64: 0, int32: 0, fixed64: 1, fixed32: 5,
  bool: 0, string: 2, bytes: 2, uint32: 0, sfixed32: 5, sfixed64: 1, sint32: 0, sint64: 0,
}
// Reader.int32/uint32 intentionally truncate and skip the high five varint bytes.
// Use uint64 plus explicit termination/width guards so corrupt DONE/field/length
// varints cannot alias legitimate low bits before the standard message decoder.
// Require shortest encoding too: 32-bit readers skip ten bytes for an overlong
// small integer, which would otherwise desynchronize them from the strict scan.
function wireInteger(reader: protobuf.Reader): bigint {
  const start = reader.pos
  const value = reader.uint64()
  const count = reader.pos - start
  const last = reader.buf[reader.pos - 1]
  if (reader.pos > reader.len || count > 10 || last >= 128 || (count > 1 && last === 0) || (count === 10 && last > 1)) {
    throw new Error('invalid-varint')
  }
  return BigInt(value.toString())
}
function wireUint32(reader: protobuf.Reader): number {
  const value = wireInteger(reader)
  if (value > 0xffffffffn) throw new Error('uint32-overflow')
  return Number(value)
}
function wireBytes(reader: protobuf.Reader): Uint8Array {
  const length = wireUint32(reader)
  const start = reader.pos
  reader.skip(length) // bounds checked by protobufjs
  return reader.buf.subarray(start, reader.pos)
}
function validateWire(bytes: Uint8Array, type: protobuf.Type, depth = 0): void {
  if (depth > 48) throw new Error('protobuf-depth')
  const reader = protobuf.Reader.create(bytes)
  const seen = new Set<number>()
  while (reader.pos < reader.len) {
    const tag = wireUint32(reader)
    const id = tag >>> 3
    const wire = tag & 7
    const field = type.fieldsById[id]
    if (!field || (!field.repeated && seen.has(id))) throw new Error('unknown-or-duplicate-field')
    seen.add(id)
    const nested = field.resolvedType
    const expected = nested instanceof protobuf.Type ? 2 : nested instanceof protobuf.Enum ? 0 : scalarWire[field.type]
    const packed = field.repeated && wire === 2 && expected !== 2
    if (wire !== expected && !packed) throw new Error('protobuf-wire-mismatch')
    const readScalar = (r: protobuf.Reader) => {
      if (nested instanceof protobuf.Enum) {
        const raw = wireInteger(r)
        const value = BigInt.asIntN(32, raw)
        if (BigInt.asUintN(64, value) !== raw || !Object.values(nested.values).includes(Number(value))) throw new Error('unknown-enum')
      } else if (field.type === 'bool') {
        if (wireInteger(r) > 1n) throw new Error('invalid-bool')
      } else if (expected === 0) {
        const value = wireInteger(r)
        if ((field.type === 'uint32' || field.type === 'sint32') && value > 0xffffffffn) throw new Error('uint32-overflow')
        if (field.type === 'int32' && BigInt.asUintN(64, BigInt.asIntN(32, value)) !== value) throw new Error('int32-overflow')
      } else r.skipType(expected)
    }
    if (packed) {
      const packedReader = protobuf.Reader.create(wireBytes(reader))
      while (packedReader.pos < packedReader.len) readScalar(packedReader)
      if (packedReader.pos !== packedReader.len) throw new Error('truncated-packed')
    } else if (expected === 2) {
      const value = wireBytes(reader)
      if (nested instanceof protobuf.Type) validateWire(value, nested, depth + 1)
      else if (field.type === 'string') utf8.decode(value)
    } else readScalar(reader)
    if (reader.pos > reader.len) throw new Error('truncated-protobuf')
  }
}
interface ToolCall { id?: string }
interface Metadata { tool_call?: ToolCall; modified_tool_call?: ToolCall }
interface Step {
  type: number; status: number; metadata?: Metadata
  user_input?: { user_response?: string }
  planner_response?: { response?: string; modified_response?: string; stop_reason?: number; tool_calls?: ToolCall[] }
  generic?: unknown
}
function decode<T>(bytes: Buffer, type: protobuf.Type): T {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) throw new Error('invalid-payload')
  validateWire(bytes, type)
  return type.toObject(type.decode(bytes), { longs: String }) as T
}
const fail = (reason: string): AntigravityNativeRecovery => ({ ok: false, reason })

export async function recoverAntigravityNativeTrajectory(
  binding: AntigravityNativeBinding,
  initId: string | undefined,
  resultId: string | undefined,
): Promise<AntigravityNativeRecovery> {
  try {
    const launch = launches.get(binding)
    if (!launch || binding.baseline === null) return fail('baseline-unknown')
    if (!binding.binaryVerified || binding.reason) return fail(binding.reason ?? 'binary-unverified')
    if (!validId(initId) || initId !== resultId
      || (launch.requestedResumeId !== undefined && launch.requestedResumeId !== initId)) return fail('conversation-mismatch')
    if (!await launch.verifier(launch.cliPath, ANTIGRAVITY_NATIVE_CLI_SHA256)) return fail('binary-unverified')
    if (!launch.requestedResumeId && launch.existingFiles.has(`${initId}.db`)) return fail('preexisting-conversation')
    return readOnly(launch.directory, initId, (db, file) => {
      if (launch.requestedResumeId) {
        if (fileIdentity(file) !== launch.databaseIdentity) return fail('database-replaced')
        if (binding.baseline! >= 0) {
          const anchor = db.prepare(`SELECT ${rowColumns} FROM steps WHERE idx = ?`).get(binding.baseline) as Row | undefined
          if (!anchor || rowHash(anchor) !== launch.baselineHash) return fail('baseline-changed')
        }
      } else if (!Number.isFinite(file.birthtimeMs) || file.birthtimeMs < launch.preparedAt) return fail('prelaunch-database')
      const meta = db.prepare('SELECT cascade_id FROM trajectory_meta').all() as { cascade_id: string }[]
      if (meta.length !== 1 || meta[0].cascade_id !== initId) return fail('database-conversation-mismatch')
      const count = (db.prepare('SELECT COUNT(*) AS n FROM steps WHERE idx > ?').get(binding.baseline) as { n: number }).n
      if (count < 2 || count > 10000) return fail('invalid-step-count')
      const rows = db.prepare(`SELECT ${rowColumns} FROM steps WHERE idx > ? ORDER BY idx`).all(binding.baseline) as Row[]
      const steps: Step[] = []
      const pending = new Set<string>()
      const seenToolIds = new Set<string>()
      let previous = binding.baseline!
      for (const row of rows) {
        if (!Number.isSafeInteger(row.idx) || row.idx !== previous + 1 || row.step_format !== 0) return fail('unsupported-step-layout')
        previous = row.idx
        const step = decode<Step>(row.step_payload, stepType)
        if (step.type !== row.step_type || step.status !== row.status) return fail('sql-payload-mismatch')
        if (![14, 15, 132].includes(step.type)) return fail('unsupported-step-type')
        if (step.type === 132 ? ![3, 7].includes(step.status) : step.status !== 3) return fail('unfinished-step')
        if ((step.type === 14) !== !!step.user_input || (step.type === 15) !== !!step.planner_response
          || (step.type === 132) !== !!step.generic) return fail('conflicting-step-payload')
        const metadata = row.metadata ? decode<Metadata>(row.metadata, metadataType) : step.metadata
        const payloadTool = step.metadata?.tool_call?.id
        const sqlTool = metadata?.tool_call?.id
        if (payloadTool && sqlTool && payloadTool !== sqlTool) return fail('tool-identity-conflict')
        if (step.type === 132) {
          const toolId = sqlTool ?? payloadTool
          if (!toolId || !pending.delete(toolId)) return fail('unmatched-tool-result')
          if (metadata?.modified_tool_call?.id && metadata.modified_tool_call.id !== toolId) return fail('tool-identity-conflict')
        }
        if (step.planner_response) {
          const calls = step.planner_response.tool_calls ?? []
          if (calls.length && ![2, 10].includes(step.planner_response.stop_reason ?? -1)) return fail('invalid-tool-stop')
          if (!calls.length && step.planner_response.stop_reason !== 2) return fail('abnormal-stop')
          for (const call of calls) {
            if (!call.id || seenToolIds.has(call.id)) return fail('invalid-tool-call')
            seenToolIds.add(call.id)
            pending.add(call.id)
          }
        }
        steps.push(step)
      }
      const users = steps.filter(step => step.type === 14)
      if (users.length !== 1 || steps[0].type !== 14) return fail('input-boundary-mismatch')
      const content = users[0].user_input?.user_response
      if (typeof content !== 'string' || sha256(Buffer.from(content, 'utf8')) !== launch.inputHash) return fail('input-hash-mismatch')
      if (pending.size) return fail('unfinished-tool')
      const final = steps.at(-1)!
      if (final.type !== 15 || final.status !== 3) return fail('missing-final')
      const response = final.planner_response!
      if (response.stop_reason !== 2 || response.tool_calls?.length) return fail('nonterminal-final')
      const original = response.response ?? ''
      const modified = response.modified_response ?? ''
      if (original && modified && original !== modified) return fail('conflicting-answer')
      const text = modified || original
      if (!text.trim()) return fail('empty-answer')
      return { ok: true, text, stepIndex: rows.at(-1)!.idx, hash: sha256(Buffer.from(text, 'utf8')) }
    })
  } catch { return fail('native-read-failed') }
}
