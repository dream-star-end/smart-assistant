import { randomUUID } from 'node:crypto'

import type { Pool } from 'pg'

import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { resolvePinnedAddress } from '../connectors/outboundPolicy.js'
import { getPool } from '../db/index.js'
import {
  PluginAccountError,
  assertRuntimePluginInstallEntitlement,
  createManagedBrowserPluginAccount,
} from './accounts.js'
import type { ManagedBrowserPinnedOrigin } from './browserRuntime.js'
import type { ManagedBrowserPluginContractV1 } from './contracts.js'
import {
  KNOWLEDGE_PLANET_LOGIN_ORIGINS,
  KNOWLEDGE_PLANET_PLUGIN_SLUG,
  type KnowledgePlanetDockerService,
  type KnowledgePlanetLoginWorkerHandle,
  KnowledgePlanetRuntimeError,
  validateKnowledgePlanetAccountState,
} from './knowledgePlanet.js'
import { classifyKnowledgePlanetSetupPin } from './knowledgePlanetContract.js'
import { loadVerifiedRuntimePluginContract } from './review.js'

const SETUP_TTL_MS = 4 * 60_000
const TERMINAL_RETENTION_MS = 15 * 60_000

export class KnowledgePlanetSetupError extends Error {
  readonly code:
    | 'UNAVAILABLE'
    | 'NOT_INSTALLED'
    | 'SETUP_ACTIVE'
    | 'SETUP_NOT_FOUND'
    | 'QR_NOT_READY'
    | 'TERMS_REQUIRED'
    | 'ACCOUNT_ALREADY_EXISTS'
    | 'CAPACITY_EXCEEDED'
    | 'SETUP_FAILED'
    | 'CLOSING'

  constructor(code: KnowledgePlanetSetupError['code'], message: string = code) {
    super(message)
    this.name = 'KnowledgePlanetSetupError'
    this.code = code
  }
}

type PublicSetupStatus =
  | 'waiting_for_scan'
  | 'finalizing'
  | 'active'
  | 'cancelled'
  | 'expired'
  | 'failed'

type TerminalClaim = 'authenticated' | 'cancelled' | 'expired' | 'failed'

export type KnowledgePlanetSetupPhase =
  | 'generating_qr'
  | 'waiting_for_scan'
  | 'scan_confirmed'
  | 'saving'
  | 'active'
  | 'cancelled'
  | 'expired'
  | 'failed'

interface SetupSession {
  id: string
  userId: number
  versionId: number
  createdAt: number
  expiresAt: number
  status: PublicSetupStatus
  phase: KnowledgePlanetSetupPhase
  terminal: TerminalClaim | null
  qr: Buffer | null
  qrRevision: number
  stateBuffer: Buffer | null
  handle: KnowledgePlanetLoginWorkerHandle | null
  completion: Promise<void> | null
  accountId: string | null
  errorCode: string | null
  agentReady: boolean
}

export interface KnowledgePlanetSetupView {
  sessionId: string
  status: PublicSetupStatus
  phase: KnowledgePlanetSetupPhase
  qrReady: boolean
  qrRevision: number
  agentReady: boolean
  createdAt: string
  expiresAt: string
  accountId?: string
  errorCode?: string
}

function safeUserId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new KnowledgePlanetSetupError('SETUP_NOT_FOUND')
  return value
}

function wipe(buffer: Buffer | null): void {
  buffer?.fill(0)
}

function claim(session: SetupSession, terminal: TerminalClaim): boolean {
  if (session.terminal !== null) return false
  session.terminal = terminal
  return true
}

export async function resolveKnowledgePlanetLoginPins(
  resolver?: DnsResolver,
): Promise<ManagedBrowserPinnedOrigin[]> {
  const pins: ManagedBrowserPinnedOrigin[] = []
  for (const origin of KNOWLEDGE_PLANET_LOGIN_ORIGINS) {
    const url = new URL(origin)
    const pin = await resolvePinnedAddress(url.hostname, resolver).catch(() => null)
    if (!pin || pin.family !== 4)
      throw new KnowledgePlanetSetupError('UNAVAILABLE', 'Knowledge Planet login DNS is unsafe')
    pins.push({
      origin,
      hostname: url.hostname,
      port: 443,
      ip: pin.ip,
      family: 4,
    })
  }
  return pins
}

export class KnowledgePlanetSetupManager {
  private readonly pool: Pool
  private readonly sessions = new Map<string, SetupSession>()
  private readonly currentByUser = new Map<number, string>()
  private readonly startsByUser = new Map<number, Promise<KnowledgePlanetSetupView>>()
  private closing = false

  constructor(
    private readonly service: KnowledgePlanetDockerService,
    private readonly opts: {
      pool?: Pool
      resolver?: DnsResolver
      env?: NodeJS.ProcessEnv
      now?: () => number
      loadEntitledVersion?: (
        userId: number,
      ) => Promise<number | { versionId: number; agentReady: boolean }>
      isAgentReady?: (contract: ManagedBrowserPluginContractV1) => boolean
      createAccount?: (input: {
        userId: number
        versionId: number
        storageState: unknown
      }) => Promise<{ id: string }>
      resolvePins?: () => Promise<ManagedBrowserPinnedOrigin[]>
    } = {},
  ) {
    this.pool = opts.pool ?? getPool()
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private prune(): void {
    const threshold = this.now() - TERMINAL_RETENTION_MS
    for (const [id, session] of this.sessions) {
      if (
        session.createdAt >= threshold ||
        session.status === 'waiting_for_scan' ||
        session.status === 'finalizing'
      )
        continue
      wipe(session.qr)
      wipe(session.stateBuffer)
      this.sessions.delete(id)
      if (this.currentByUser.get(session.userId) === id) this.currentByUser.delete(session.userId)
    }
  }

  private async loadEntitledVersion(
    userId: number,
  ): Promise<{ versionId: number; agentReady: boolean }> {
    if (this.opts.loadEntitledVersion) {
      const loaded = await this.opts.loadEntitledVersion(userId)
      return typeof loaded === 'number' ? { versionId: loaded, agentReady: true } : loaded
    }
    const row = await this.pool.query<{ id: string }>(
      `SELECT v.id::text AS id
         FROM marketplace_installs i
         JOIN marketplace_skill_versions v
           ON v.id = i.version_id AND v.slug = i.slug AND v.artifact_hash = i.artifact_hash
         JOIN marketplace_skill_listings l ON l.slug = v.slug
        WHERE i.user_id = $1 AND i.slug = $2 AND i.uninstalled_at IS NULL
          AND l.kind = 'connector' AND l.plugin_type = 'managed-browser'
          AND l.state = 'active' AND l.current_approved_version_id = v.id
          AND v.status = 'approved' AND v.review_source = 'platform'
          AND v.security_review_state = 'security_approved'
          AND v.functional_verify_state = 'verified' AND v.exec_revoked_at IS NULL
        LIMIT 1`,
      [userId, KNOWLEDGE_PLANET_PLUGIN_SLUG],
    )
    const id = Number(row.rows[0]?.id)
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new KnowledgePlanetSetupError(
        'NOT_INSTALLED',
        'Knowledge Planet Plugin is not installed',
      )
    const verified = await loadVerifiedRuntimePluginContract(id, this.pool, { env: this.opts.env })
    if (verified.pluginType !== 'managed-browser' || verified.slug !== KNOWLEDGE_PLANET_PLUGIN_SLUG)
      throw new KnowledgePlanetSetupError('UNAVAILABLE', 'official Plugin trust pin mismatch')
    const setupPin = classifyKnowledgePlanetSetupPin({
      version: verified.contract.version,
      artifactHash: verified.artifactHash,
      execContractHash: verified.execContractHash,
    })
    if (!setupPin)
      throw new KnowledgePlanetSetupError('UNAVAILABLE', 'official Plugin trust pin mismatch')
    await assertRuntimePluginInstallEntitlement(userId, verified, this.pool, {
      requireCurrent: true,
    })
    return {
      versionId: id,
      agentReady: this.opts.isAgentReady?.(verified.contract) ?? setupPin === 'current',
    }
  }

  private sessionFor(userId: number, sessionId: string): SetupSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.userId !== userId)
      throw new KnowledgePlanetSetupError('SETUP_NOT_FOUND')
    return session
  }

  private view(session: SetupSession): KnowledgePlanetSetupView {
    return {
      sessionId: session.id,
      status: session.status,
      phase: session.phase,
      qrReady: session.status === 'waiting_for_scan' && session.qr !== null,
      qrRevision: session.qrRevision,
      agentReady: session.agentReady,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(session.accountId ? { accountId: session.accountId } : {}),
      ...(session.errorCode ? { errorCode: session.errorCode } : {}),
    }
  }

  private failSession(session: SetupSession, code = 'SETUP_FAILED'): void {
    wipe(session.qr)
    session.qr = null
    wipe(session.stateBuffer)
    session.stateBuffer = null
    session.status = 'failed'
    session.phase = 'failed'
    session.errorCode = code
  }

  async start(userIdInput: number, acceptTerms: boolean): Promise<KnowledgePlanetSetupView> {
    if (this.closing) throw new KnowledgePlanetSetupError('CLOSING')
    if (acceptTerms !== true) throw new KnowledgePlanetSetupError('TERMS_REQUIRED')
    const userId = safeUserId(userIdInput)
    const pending = this.startsByUser.get(userId)
    if (pending) return pending
    const started = this.startForUser(userId)
    this.startsByUser.set(userId, started)
    try {
      return await started
    } finally {
      if (this.startsByUser.get(userId) === started) this.startsByUser.delete(userId)
    }
  }

  private async startForUser(userId: number): Promise<KnowledgePlanetSetupView> {
    if (this.closing) throw new KnowledgePlanetSetupError('CLOSING')
    this.prune()
    const currentId = this.currentByUser.get(userId)
    let staleActive: SetupSession | null = null
    if (currentId) {
      const current = this.sessions.get(currentId)
      if (current) await this.expireIfNeeded(current)
      // Starting is idempotent for an in-flight setup. A refreshed browser can
      // recover the private session id instead of being locked out until TTL.
      if (current && ['waiting_for_scan', 'finalizing'].includes(current.status))
        return this.view(current)
      // A terminal setup is only a UI/history cache. The encrypted account row
      // remains authoritative: unlink may happen immediately after success, so
      // retaining an `active` session must never block re-authorization for the
      // remainder of the 15-minute setup TTL.
      if (current?.status === 'active') staleActive = current
    }
    const existing = await this.pool.query(
      `SELECT 1 FROM connections
        WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL
        LIMIT 1`,
      [userId, KNOWLEDGE_PLANET_PLUGIN_SLUG],
    )
    if ((existing.rowCount ?? 0) !== 0)
      throw new KnowledgePlanetSetupError('ACCOUNT_ALREADY_EXISTS')
    if (staleActive) {
      wipe(staleActive.qr)
      staleActive.qr = null
      wipe(staleActive.stateBuffer)
      staleActive.stateBuffer = null
      this.sessions.delete(staleActive.id)
      if (this.currentByUser.get(userId) === staleActive.id) this.currentByUser.delete(userId)
    }
    const entitled = await this.loadEntitledVersion(userId)
    const pins = this.opts.resolvePins
      ? await this.opts.resolvePins()
      : await resolveKnowledgePlanetLoginPins(this.opts.resolver)
    const now = this.now()
    const session: SetupSession = {
      id: randomUUID(),
      userId,
      versionId: entitled.versionId,
      createdAt: now,
      expiresAt: now + SETUP_TTL_MS,
      status: 'waiting_for_scan',
      phase: 'generating_qr',
      terminal: null,
      qr: null,
      qrRevision: 0,
      stateBuffer: null,
      handle: null,
      completion: null,
      accountId: null,
      errorCode: null,
      agentReady: entitled.agentReady,
    }
    this.sessions.set(session.id, session)
    this.currentByUser.set(userId, session.id)
    try {
      const handle = await this.service.startLogin({
        sessionId: session.id,
        pins,
        deadlineMs: session.expiresAt,
        onQr: (png) => {
          if (session.terminal !== null || session.status !== 'waiting_for_scan') return
          wipe(session.qr)
          session.qr = Buffer.from(png)
          session.qrRevision += 1
          session.phase = 'waiting_for_scan'
        },
        onAuthenticated: (state) => {
          if (!claim(session, 'authenticated')) return
          wipe(session.qr)
          session.qr = null
          try {
            const validated = validateKnowledgePlanetAccountState(state)
            session.stateBuffer = Buffer.from(JSON.stringify(validated), 'utf8')
            session.status = 'finalizing'
            session.phase = 'scan_confirmed'
          } catch {
            this.failSession(session)
          }
        },
        onFailed: (code) => {
          const terminal = code === 'LOGIN_EXPIRED' ? 'expired' : 'failed'
          if (!claim(session, terminal)) return
          wipe(session.qr)
          session.qr = null
          session.status = terminal === 'expired' ? 'expired' : 'failed'
          session.phase = terminal === 'expired' ? 'expired' : 'failed'
          session.errorCode = code
        },
      })
      session.handle = handle
      session.completion = handle.done
        .then(async () => {
          if (session.terminal !== 'authenticated' || session.status !== 'finalizing') return
          const stateBuffer = session.stateBuffer
          session.stateBuffer = null
          if (!stateBuffer) return this.failSession(session)
          try {
            session.phase = 'saving'
            const storageState = JSON.parse(stateBuffer.toString('utf8'))
            const account = this.opts.createAccount
              ? await this.opts.createAccount({
                  userId: session.userId,
                  versionId: session.versionId,
                  storageState,
                })
              : await createManagedBrowserPluginAccount({
                  userId: session.userId,
                  versionId: session.versionId,
                  displayName: '知识星球',
                  accountHint: '微信扫码账号',
                  storageState,
                  env: this.opts.env,
                  pool: this.pool,
                })
            session.accountId = account.id
            session.status = 'active'
            session.phase = 'active'
          } catch (error) {
            if (error instanceof PluginAccountError && error.code === 'ACCOUNT_ALREADY_EXISTS')
              this.failSession(session, 'ACCOUNT_ALREADY_EXISTS')
            else this.failSession(session)
          } finally {
            wipe(stateBuffer)
          }
        })
        .catch(() => {
          if (session.status === 'waiting_for_scan' || session.status === 'finalizing')
            this.failSession(session)
        })
      return this.view(session)
    } catch (error) {
      this.sessions.delete(session.id)
      this.currentByUser.delete(userId)
      wipe(session.qr)
      wipe(session.stateBuffer)
      if (error instanceof KnowledgePlanetRuntimeError && error.code === 'CAPACITY_EXCEEDED')
        throw new KnowledgePlanetSetupError(
          'CAPACITY_EXCEEDED',
          'Knowledge Planet setup capacity is full',
        )
      throw error
    }
  }

  private async expireIfNeeded(session: SetupSession): Promise<void> {
    if (session.status !== 'waiting_for_scan' || this.now() < session.expiresAt) return
    if (!claim(session, 'expired')) return
    session.status = 'expired'
    session.phase = 'expired'
    session.errorCode = 'LOGIN_EXPIRED'
    wipe(session.qr)
    session.qr = null
    await session.handle?.stop().catch(() => {})
  }

  async status(userIdInput: number, sessionId: string): Promise<KnowledgePlanetSetupView> {
    const session = this.sessionFor(safeUserId(userIdInput), sessionId)
    await this.expireIfNeeded(session)
    return this.view(session)
  }

  async qr(userIdInput: number, sessionId: string): Promise<Buffer> {
    const session = this.sessionFor(safeUserId(userIdInput), sessionId)
    await this.expireIfNeeded(session)
    if (session.status !== 'waiting_for_scan' || !session.qr)
      throw new KnowledgePlanetSetupError('QR_NOT_READY')
    return Buffer.from(session.qr)
  }

  async cancel(userIdInput: number, sessionId: string): Promise<KnowledgePlanetSetupView> {
    const session = this.sessionFor(safeUserId(userIdInput), sessionId)
    if (claim(session, 'cancelled')) {
      session.status = 'cancelled'
      session.phase = 'cancelled'
      wipe(session.qr)
      session.qr = null
      wipe(session.stateBuffer)
      session.stateBuffer = null
      await session.handle?.stop().catch(() => {})
    }
    return this.view(session)
  }

  async closeAndDrain(): Promise<void> {
    this.closing = true
    await Promise.all([...this.startsByUser.values()].map((started) => started.catch(() => {})))
    const stops: Promise<void>[] = []
    for (const session of this.sessions.values()) {
      if (claim(session, 'cancelled')) {
        session.status = 'cancelled'
        session.phase = 'cancelled'
        wipe(session.qr)
        session.qr = null
        wipe(session.stateBuffer)
        session.stateBuffer = null
        if (session.handle) stops.push(session.handle.stop().catch(() => {}))
      }
    }
    await Promise.all(stops)
    await Promise.all(
      [...this.sessions.values()]
        .map((session) => session.completion)
        .filter((completion): completion is Promise<void> => completion !== null)
        .map((completion) => completion.catch(() => {})),
    )
    await this.service.closeAndDrain()
  }
}
