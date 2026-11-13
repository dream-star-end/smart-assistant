/** Dedicated help authentication: bootstrap can only refresh; short grants only read/prepare. */
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto'
export const SYSTEM_HELP_GRANT_TTL_MS = 60_000
export const SYSTEM_HELP_BOOTSTRAP_TTL_MS = 13 * 60 * 60 * 1000
const DOMAIN = 'openclaude.system-help.v1.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export interface SystemHelpIdentityScope {
  uid: string
  containerId: string
  sessionId: string
  agentId: string
  dispatchId: string
  attemptNo: number
  ownerId: string
  dispatchLeaseEpoch: string
}
export interface SystemHelpScope extends SystemHelpIdentityScope { securityEpoch: string }
interface HelpStamp { version: 1; purpose: 'system-help'; audience: 'master-system-actions'; nonce: string; issuedAt: number; expiresAt: number }
export interface SystemHelpBootstrap extends SystemHelpIdentityScope, HelpStamp { scope: 'bootstrap_refresh' }
export interface SystemHelpGrant extends SystemHelpScope, HelpStamp { scope: 'read_prepare' }
export class SystemHelpGrantError extends Error {
  constructor(readonly code: 'INVALID_CONTEXT' | 'CONTEXT_EXPIRED' | 'UNAVAILABLE') { super(code) }
}
function decimal(value: unknown): value is string { return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) }
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    ![...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
}
function validIdentity(s: SystemHelpIdentityScope): boolean {
  return decimal(s.uid) && decimal(s.containerId) && text(s.sessionId, 256) && text(s.agentId, 64) && typeof s.dispatchId === 'string' && UUID.test(s.dispatchId) &&
    Number.isSafeInteger(s.attemptNo) && s.attemptNo >= 1 && text(s.ownerId, 200) && decimal(s.dispatchLeaseEpoch)
}
const BASE_KEYS = ['version','purpose','audience','scope','nonce','issuedAt','expiresAt','uid','containerId','sessionId','agentId','dispatchId','attemptNo','ownerId','dispatchLeaseEpoch']
export class SystemHelpGrantSigner {
  readonly #key: Buffer
  #closed = false
  constructor(masterLedgerKey: Buffer, private readonly now: () => number = Date.now) {
    if (!Buffer.isBuffer(masterLedgerKey) || masterLedgerKey.length !== 32) throw new SystemHelpGrantError('INVALID_CONTEXT')
    this.#key = Buffer.from(hkdfSync('sha256', masterLedgerKey, Buffer.alloc(0), Buffer.from(DOMAIN), 32))
  }
  private mac(body: string): Buffer { return createHmac('sha256', this.#key).update(DOMAIN).update(body).digest() }
  private stamp(ttl: number): HelpStamp {
    if (this.#closed) throw new SystemHelpGrantError('UNAVAILABLE')
    const issuedAt = this.now()
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new SystemHelpGrantError('INVALID_CONTEXT')
    return { version: 1, purpose: 'system-help', audience: 'master-system-actions', nonce: randomUUID(), issuedAt, expiresAt: issuedAt + ttl }
  }
  private identity(input: SystemHelpIdentityScope): SystemHelpIdentityScope {
    if (!validIdentity(input)) throw new SystemHelpGrantError('INVALID_CONTEXT')
    // Explicit fields never carry cached role, business operation or browser approval material.
    return { uid: input.uid, containerId: input.containerId, sessionId: input.sessionId, agentId: input.agentId,
      dispatchId: input.dispatchId, attemptNo: input.attemptNo, ownerId: input.ownerId, dispatchLeaseEpoch: input.dispatchLeaseEpoch }
  }
  private sign(payload: SystemHelpBootstrap | SystemHelpGrant): { token: string; expiresAt: number } {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return { token: `${body}.${this.mac(body).toString('base64url')}`, expiresAt: payload.expiresAt }
  }
  /** Issued only alongside the original server-admitted frame; never from a caller's current-owner lookup. */
  issueBootstrap(input: SystemHelpIdentityScope): { token: string; expiresAt: number } {
    return this.sign({ ...this.identity(input), ...this.stamp(SYSTEM_HELP_BOOTSTRAP_TTL_MS), scope: 'bootstrap_refresh' })
  }
  issue(input: SystemHelpScope): { token: string; expiresAt: number } {
    if (typeof input.securityEpoch !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(input.securityEpoch)) throw new SystemHelpGrantError('INVALID_CONTEXT')
    return this.sign({ ...this.identity(input), ...this.stamp(SYSTEM_HELP_GRANT_TTL_MS), scope: 'read_prepare', securityEpoch: input.securityEpoch })
  }
  private parse(token: string, expectedScope: 'bootstrap_refresh' | 'read_prepare'): SystemHelpBootstrap | SystemHelpGrant {
    if (this.#closed) throw new SystemHelpGrantError('UNAVAILABLE')
    if (typeof token !== 'string' || token.length > 4096) throw new SystemHelpGrantError('INVALID_CONTEXT')
    const parts = token.split('.')
    const body = parts[0]
    const signature = parts[1]
    if (parts.length !== 2 || !body || !/^[A-Za-z0-9_-]+$/.test(body) || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new SystemHelpGrantError('INVALID_CONTEXT')
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== 32 || actual.toString('base64url') !== signature || !timingSafeEqual(this.mac(body), actual)) throw new SystemHelpGrantError('INVALID_CONTEXT')
    let raw: unknown
    try { raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { throw new SystemHelpGrantError('INVALID_CONTEXT') }
    const keys = expectedScope === 'read_prepare' ? [...BASE_KEYS, 'securityEpoch'] : BASE_KEYS
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== [...keys].sort().join(',')) throw new SystemHelpGrantError('INVALID_CONTEXT')
    const grant = raw as SystemHelpBootstrap | SystemHelpGrant
    const ttl = expectedScope === 'read_prepare' ? SYSTEM_HELP_GRANT_TTL_MS : SYSTEM_HELP_BOOTSTRAP_TTL_MS
    const now = this.now()
    if (grant.version !== 1 || grant.purpose !== 'system-help' || grant.audience !== 'master-system-actions' || grant.scope !== expectedScope || typeof grant.nonce !== 'string' || !UUID.test(grant.nonce) || !validIdentity(grant) ||
        !Number.isSafeInteger(grant.issuedAt) || grant.issuedAt < 0 || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt - grant.issuedAt !== ttl || grant.issuedAt > now) throw new SystemHelpGrantError('INVALID_CONTEXT')
    if (grant.scope === 'read_prepare' && (typeof grant.securityEpoch !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(grant.securityEpoch))) throw new SystemHelpGrantError('INVALID_CONTEXT')
    if (grant.expiresAt <= now) throw new SystemHelpGrantError('CONTEXT_EXPIRED')
    return grant
  }
  /** Refresh authentication only. Caller must recheck its ORIGINAL owner/epoch and active durable scope. */
  verifyBootstrap(token: string): SystemHelpBootstrap { return this.parse(token, 'bootstrap_refresh') as SystemHelpBootstrap }
  /** Authentication only. PG must still match all scope fields, current account role/status and security epoch. */
  verify(token: string): SystemHelpGrant { return this.parse(token, 'read_prepare') as SystemHelpGrant }
  close(): void { this.#closed = true; this.#key.fill(0) }
}
