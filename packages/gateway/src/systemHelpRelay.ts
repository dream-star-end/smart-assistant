import { SYSTEM_ACTIONS_INTERNAL_PATH } from '@openclaude/protocol'
/** Logical-turn help relay: opaque bootstrap only, never a master signing key or browser approval. */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
export const SYSTEM_HELP_LOCAL_PATH = '/api/internal/system-help'
export { SYSTEM_HELP_CAPABILITY, SYSTEM_HELP_BOOTSTRAP_FIELD } from '@openclaude/protocol'
const opaque = z.string().min(1).max(4096)
const operationId = z.string().regex(/^[a-z][a-z0-9.-]{1,99}$/)
export const systemHelpCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('catalog'), after: z.string().max(100).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  z.object({ kind: z.literal('read'), operationId, args: z.unknown().optional() }).strict(),
  z.object({ kind: z.literal('prepare'), operationId, args: z.unknown().optional(), idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/) }).strict(),
  z.object({ kind: z.literal('result'), proposalId: z.string().uuid() }).strict(),
])
const requestSchema = z.object({ nonce: z.string().uuid(), context: opaque, command: systemHelpCommand }).strict()
export class SystemHelpRelayError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'INVALID_CONTEXT' | 'INVALID_INPUT' | 'UPSTREAM_REJECTED') { super(code) }
}
interface Grant { token: string; expiresAt: number }
interface Logical { bootstrap: string; closed: boolean; grant?: Grant; refreshing?: Promise<Grant> }
interface Binding { logical: Logical; session: object; nonce: string; current(): boolean; closed: boolean }
export class SystemHelpRelay {
  readonly #logical = new WeakMap<object, Logical>()
  readonly #active = new Map<string, Binding>()
  readonly #bySession = new WeakMap<object, Binding>()
  readonly #files = new Map<string, string>()
  #directory?: string
  constructor(readonly post: (body: unknown) => Promise<unknown>, readonly now: () => number = Date.now) {}
  contextFile(sessionKey: string): string {
    let path = this.#files.get(sessionKey)
    if (!path) {
      this.#directory ??= mkdtempSync(join(tmpdir(), 'oc-system-help-'))
      path = join(this.#directory, `${randomUUID()}.json`)
      this.#files.set(sessionKey, path)
      this.#write(path, { version: 1, available: false })
    }
    return path
  }
  #write(path: string, value: unknown): void {
    const temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  }
  begin(session: object, bootstrap: string | undefined): () => void {
    this.endAttempt(session)
    const previous = this.#logical.get(session)
    if (previous) previous.closed = true
    this.#logical.delete(session)
    if (!opaque.safeParse(bootstrap).success) return () => {}
    const logical: Logical = { bootstrap: bootstrap!, closed: false }
    this.#logical.set(session, logical)
    return () => {
      logical.closed = true
      const active = this.#bySession.get(session)
      if (active?.logical === logical) this.#close(active)
      if (this.#logical.get(session) === logical) this.#logical.delete(session)
    }
  }
  openAttempt(session: object, sessionKey: string, current: () => boolean): () => void {
    this.endAttempt(session)
    const logical = this.#logical.get(session)
    const file = this.contextFile(sessionKey)
    if (!logical || logical.closed) { this.#write(file, { version: 1, available: false }); return () => {} }
    const binding: Binding = { logical, session, current, nonce: randomUUID(), closed: false }
    this.#active.set(binding.nonce, binding)
    this.#bySession.set(session, binding)
    try { this.#write(file, { version: 1, context: logical.bootstrap, nonce: binding.nonce }) }
    catch { this.#close(binding); throw new SystemHelpRelayError('UNAVAILABLE') }
    return () => this.#close(binding)
  }
  endAttempt(session: object): void {
    const binding = this.#bySession.get(session)
    if (binding) this.#close(binding)
  }
  #close(binding: Binding): void {
    binding.closed = true
    if (this.#active.get(binding.nonce) === binding) this.#active.delete(binding.nonce)
    if (this.#bySession.get(binding.session) === binding) this.#bySession.delete(binding.session)
  }
  #assertCurrent(binding: Binding): void {
    let current = false
    try { current = binding.current() } catch { /* a removed session is never authority */ }
    if (binding.closed || binding.logical.closed || !current || this.#active.get(binding.nonce) !== binding || this.#bySession.get(binding.session) !== binding) throw new SystemHelpRelayError('INVALID_CONTEXT')
  }
  async #grant(binding: Binding): Promise<Grant> {
    const logical = binding.logical
    if (logical.grant && logical.grant.expiresAt > this.now() + 5000) return logical.grant
    logical.refreshing ??= (async () => {
      const raw = await this.post({ kind: 'refresh', bootstrap: logical.bootstrap })
      const result = z.object({ token: opaque, expiresAt: z.number().int() }).strict().safeParse(raw)
      if (!result.success || result.data.expiresAt <= this.now() || result.data.expiresAt > this.now() + 65000 || logical.closed) throw new SystemHelpRelayError('INVALID_CONTEXT')
      logical.grant = result.data
      return result.data
    })()
    const refreshing = logical.refreshing
    try { return await refreshing } finally { if (logical.refreshing === refreshing) logical.refreshing = undefined }
  }
  async request(raw: unknown): Promise<unknown> {
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success) throw new SystemHelpRelayError('INVALID_INPUT')
    const input = parsed.data
    const binding = this.#active.get(input.nonce)
    if (!binding) throw new SystemHelpRelayError('INVALID_CONTEXT')
    const supplied = Buffer.from(input.context); const expected = Buffer.from(binding.logical.bootstrap)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new SystemHelpRelayError('INVALID_CONTEXT')
    this.#assertCurrent(binding)
    const grant = await this.#grant(binding)
    this.#assertCurrent(binding)
    let result: unknown
    try { result = await this.post({ ...input.command, grant: grant.token }) }
    catch (e) { if (binding.logical.grant === grant) binding.logical.grant = undefined; throw e }
    this.#assertCurrent(binding)
    return result
  }
}
const relays = new WeakMap<object, SystemHelpRelay>()
export function getSystemHelpRelay(owner: object): SystemHelpRelay | undefined { return relays.get(owner) }
export function setSystemHelpRelay(owner: object, relay: SystemHelpRelay): void { relays.set(owner, relay) }
export function systemHelpContextFile(owner: object, sessionKey: string): string | undefined {
  try { return relays.get(owner)?.contextFile(sessionKey) } catch { return undefined }
}
/** Testable fixed-endpoint transport. No caller URL, approval command, bearer forwarding or automatic retry. */
export function makeSystemHelpMasterClient(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): ((command: unknown) => Promise<unknown>) | undefined {
  const token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  if (!base || !token) return undefined
  let endpoint: string
  try {
    const url = new URL(base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined
    endpoint = new URL(SYSTEM_ACTIONS_INTERNAL_PATH, url).toString()
  } catch { return undefined }
  return async command => {
    let body: string
    try { body = JSON.stringify(command) } catch { throw new SystemHelpRelayError('INVALID_INPUT') }
    if (typeof body !== 'string' || Buffer.byteLength(body) > 4 * 1024 * 1024) throw new SystemHelpRelayError('INVALID_INPUT')
    let response: Response
    try { response = await fetcher(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15000), redirect: 'error' }) }
    catch { throw new SystemHelpRelayError('UNAVAILABLE') }
    if (!response.ok) { await response.body?.cancel(); throw new SystemHelpRelayError('UPSTREAM_REJECTED') }
    if (!response.body) throw new SystemHelpRelayError('UNAVAILABLE')
    const chunks: Uint8Array[] = []; let size = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break
        size += part.value.byteLength
        if (size > 4 * 1024 * 1024) throw new SystemHelpRelayError('UNAVAILABLE')
        chunks.push(part.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch { try { await reader.cancel() } catch {} ; throw new SystemHelpRelayError('UNAVAILABLE') }
    finally { reader.releaseLock() }
  }
}
export function installSystemHelpRelay(owner: object, env: NodeJS.ProcessEnv = process.env): void {
  const post = makeSystemHelpMasterClient(env)
  if (post) setSystemHelpRelay(owner, new SystemHelpRelay(post))
}
