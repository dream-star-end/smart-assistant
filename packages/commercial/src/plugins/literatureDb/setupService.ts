/** Private account authorization. Credentials never enter the public operation view. */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { getPool } from '../../db/index.js'
import { type PluginLeaseRedis, acquirePluginAccountLease } from '../accountLease.js'
import {
  LITERATURE_SESSION_MAX_MS,
  assertRuntimePluginInstallEntitlement,
  bindManagedBrowserPluginAccount,
  decryptLiteratureHttpAccountEnvelope,
  decryptLiteratureHttpAccountInstanceId,
  getPluginAccount,
} from '../accounts.js'
import { loadVerifiedRuntimePluginContract } from '../review.js'
import { isLiteratureHttpIdentity } from './builtinContract.js'
import { type CaptchaReader, LiteratureCaptchaSolver } from './captcha.js'
import { type LiteratureCredentials, parseLiteratureCredentials } from './credentials.js'
import { LiteratureError } from './errors.js'
import {
  LiteratureLoginManager,
  type LiteratureLoginOptions,
  type LiteratureLoginSession,
  type LiteratureLoginView,
} from './login.js'
import { LITERATURE_SITE } from './policy.js'

type Verified = Extract<
  Awaited<ReturnType<typeof loadVerifiedRuntimePluginContract>>,
  { pluginType: 'managed-browser' }
>
export class LiteratureSetupError extends Error {
  constructor(
    readonly code:
      | 'UNAVAILABLE'
      | 'NOT_INSTALLED'
      | 'TERMS_REQUIRED'
      | 'ACCOUNT_ALREADY_EXISTS'
      | 'ACCOUNT_STALE',
  ) {
    super(code)
    this.name = 'LiteratureSetupError'
  }
}
export interface LiteratureSetupView extends Omit<LiteratureLoginView, 'errorCode'> {
  errorCode?: string
  accountId?: string
  agentReady: boolean
}
interface PrivateOperation {
  userId: number
  versionId: number
  createdAt: number
  credentials: Buffer | null
  target?: { accountId: string; instanceId: string; replacementId: string }
  saved?: { id: string; accountInstanceId: string }
  verifiedAt?: number
}
export interface LiteratureSetupOptions {
  pool?: Pool
  redis?: PluginLeaseRedis
  env?: NodeJS.ProcessEnv
  /** Server-owned factory only. It must establish positive upstream identity. */
  createSession?: (input: {
    credentials: LiteratureCredentials
    signal: AbortSignal
  }) => Promise<LiteratureLoginSession>
  readers?: (input: { userId: number; operationId: string }) => readonly CaptchaReader[]
  loginOptions?: LiteratureLoginOptions
  isAgentReady?: () => boolean
}
const pending = (view: LiteratureLoginView) =>
  view.status === 'running' || view.status === 'manual_required'
function wipe(op: PrivateOperation): void {
  op.credentials?.fill(0)
  op.credentials = null
}
export class LiteratureSetupService {
  private readonly pool: Pool
  private readonly manager: LiteratureLoginManager
  private readonly operations = new Map<string, PrivateOperation>()
  private closing = false
  constructor(private readonly options: LiteratureSetupOptions = {}) {
    this.pool = options.pool ?? getPool()
    this.manager = new LiteratureLoginManager(
      ({ owner, operationId }) => {
        const op = this.owned(owner.userId, operationId)
        const readers = (this.options.readers?.({ userId: op.userId, operationId }) ?? []).map(
          (reader) => ({
            ...reader,
            recognize: async (input: Parameters<CaptchaReader['recognize']>[0]) => {
              await this.revalidate(op)
              return reader.recognize(input)
            },
          }),
        )
        return new LiteratureCaptchaSolver(readers)
      },
      { capacity: 1, ...options.loginOptions },
    )
  }
  private owned(userId: number, id: string): PrivateOperation {
    const op = this.operations.get(id)
    if (!op || op.userId !== userId) throw new LiteratureError('NOT_FOUND')
    return op
  }
  private async trusted(userId: number): Promise<Verified> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT v.id::text AS id FROM marketplace_installs i
       JOIN marketplace_skill_versions v ON v.id=i.version_id AND v.slug=i.slug AND v.artifact_hash=i.artifact_hash
       JOIN marketplace_skill_listings l ON l.slug=v.slug
       WHERE i.user_id=$1 AND i.slug='literature-db' AND i.uninstalled_at IS NULL
         AND l.kind='connector' AND l.plugin_type='managed-browser' AND l.state='active'
         AND l.current_approved_version_id=v.id AND v.status='approved' AND v.review_source='platform'
         AND v.security_review_state='security_approved' AND v.functional_verify_state='verified'
         AND v.exec_revoked_at IS NULL LIMIT 1`,
      [userId],
    )
    const id = Number(result.rows[0]?.id)
    if (!Number.isSafeInteger(id) || id < 1) throw new LiteratureSetupError('NOT_INSTALLED')
    const verified = await loadVerifiedRuntimePluginContract(id, this.pool, {
      env: this.options.env,
    })
    if (verified.pluginType !== 'managed-browser' || !isLiteratureHttpIdentity(verified))
      throw new LiteratureSetupError('UNAVAILABLE')
    await assertRuntimePluginInstallEntitlement(userId, verified, this.pool, {
      requireCurrent: true,
    })
    return verified
  }
  private async revalidate(op: PrivateOperation): Promise<Verified> {
    const verified = await this.trusted(op.userId)
    if (verified.versionId !== op.versionId) throw new LiteratureSetupError('ACCOUNT_STALE')
    return verified
  }
  /** Called before reading a start request body. */
  async assertAvailable(userId: number): Promise<void> {
    if (this.closing || !this.options.createSession) throw new LiteratureSetupError('UNAVAILABLE')
    await this.trusted(userId)
  }
  async capability(userId: number) {
    await this.trusted(userId)
    return {
      available: !this.closing && Boolean(this.options.createSession),
      reasonCode: this.closing || !this.options.createSession ? 'UNAVAILABLE' : null,
      maxAutomaticSubmissions: this.options.loginOptions?.maxAutomaticSubmissions ?? 4,
      maxStartsPerHour: this.options.loginOptions?.maxStartsPerHour ?? 6,
      operationTtlMs: this.options.loginOptions?.operationTtlMs ?? 300_000,
    }
  }
  private async target(userId: number, accountId: string, verified: Verified): Promise<string> {
    const row = await getPluginAccount(accountId, userId, this.pool, { includeError: true })
    if (!row || row.provider !== verified.slug) throw new LiteratureError('NOT_FOUND')
    if (
      row.connector_version_id !== String(verified.versionId) ||
      row.spec_hash.toString('hex') !== verified.artifactHash ||
      row.exec_contract_hash.toString('hex') !== verified.execContractHash ||
      row.auth_contract_version !== verified.contract.account.contractVersion
    )
      throw new LiteratureSetupError('ACCOUNT_STALE')
    return decryptLiteratureHttpAccountInstanceId(row, verified.contract, this.options.env)
  }
  async start(
    userId: number,
    input: { username: string; password: string; acceptTerms: boolean; accountId?: string },
  ): Promise<LiteratureSetupView> {
    await this.assertAvailable(userId)
    if (input.acceptTerms !== true) throw new LiteratureSetupError('TERMS_REQUIRED')
    if (input.accountId !== undefined && !/^[1-9][0-9]{0,18}$/.test(input.accountId))
      throw new LiteratureError('INVALID_INPUT')
    const verified = await this.trusted(userId)
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM connections WHERE user_id=$1 AND provider='literature-db' AND revoked_at IS NULL LIMIT 1`,
      [userId],
    )
    if (input.accountId ? existing.rows[0]?.id !== input.accountId : Boolean(existing.rows[0]))
      throw new LiteratureSetupError(input.accountId ? 'ACCOUNT_STALE' : 'ACCOUNT_ALREADY_EXISTS')
    const target = input.accountId
      ? {
          accountId: input.accountId,
          instanceId: await this.target(userId, input.accountId, verified),
          replacementId: randomUUID(),
        }
      : undefined
    // Manager retains terminal views for two minutes. No secret is retained in them.
    for (const [id, old] of this.operations) {
      try {
        if (!pending(this.manager.status(old.userId, id)) && Date.now() - old.createdAt > 720_000)
          this.operations.delete(id)
      } catch {
        wipe(old)
        this.operations.delete(id)
      }
    }
    const credentials = parseLiteratureCredentials({
      schemaVersion: 1,
      username: input.username,
      password: input.password,
    })
    const op: PrivateOperation = {
      userId,
      versionId: verified.versionId,
      createdAt: Date.now(),
      credentials: Buffer.from(JSON.stringify(credentials)),
      target,
    }
    try {
      const view = this.manager.start(
        { kind: 'setup', userId, site: LITERATURE_SITE },
        async (signal) => {
          signal.addEventListener('abort', () => wipe(op), { once: true })
          if (signal.aborted || !op.credentials) throw new LiteratureError('CANCELLED')
          await this.revalidate(op)
          if (signal.aborted || !op.credentials) throw new LiteratureError('CANCELLED')
          const session = await this.options.createSession!({
            credentials: parseLiteratureCredentials(JSON.parse(op.credentials.toString('utf8'))),
            signal,
          })
          return {
            challenge: async (s) => {
              await this.revalidate(op)
              return session.challenge(s)
            },
            submit: async (answer, s) => {
              await this.revalidate(op)
              return session.submit(answer, s)
            },
            probe: async (s) => {
              await this.revalidate(op)
              return session.probe(s)
            },
            snapshot: async (s) => {
              await this.revalidate(op)
              const state = await session.snapshot(s)
              op.verifiedAt = Date.now()
              return state
            },
            close: () => session.close(),
          }
        },
        async (storageState, context) => {
          if (!context.isCurrent() || !op.credentials || op.verifiedAt === undefined)
            throw new LiteratureError('CANCELLED')
          await this.revalidate(op)
          const save = async () => {
            await this.revalidate(op)
            if (!context.isCurrent() || !op.credentials) throw new LiteratureError('CANCELLED')
            op.saved = await bindManagedBrowserPluginAccount({
              userId,
              versionId: op.versionId,
              storageState,
              displayName: '文献数据库',
              existing: op.target ? 'replace' : 'reject',
              expectedExistingAccountInstanceId: op.target?.instanceId,
              replacementAccountInstanceId: op.target?.replacementId,
              literatureSession: {
                sessionVerifiedAt: op.verifiedAt!,
                sessionExpiresAt: op.verifiedAt! + LITERATURE_SESSION_MAX_MS,
              },
              literatureCredentials: {
                action: 'set',
                credentials: parseLiteratureCredentials(
                  JSON.parse(op.credentials.toString('utf8')),
                ),
              },
              env: this.options.env,
              pool: this.pool,
            })
          }
          if (!op.target) await save()
          else {
            const lease = await acquirePluginAccountLease(this.options.redis, op.target.accountId, {
              hardTimeoutMs: 30_000,
            })
            try {
              const current = await this.revalidate(op)
              if (
                (await this.target(userId, op.target.accountId, current)) !== op.target.instanceId
              )
                throw new LiteratureSetupError('ACCOUNT_STALE')
              await lease.assertHeld()
              await save()
              if (op.saved?.id !== op.target.accountId)
                throw new LiteratureSetupError('ACCOUNT_STALE')
            } finally {
              await lease.release()
            }
          }
        },
      )
      this.operations.set(view.operationId, op)
      void this.manager
        .settled(userId, view.operationId)
        .then((result) => {
          if (!pending(result)) wipe(op)
        })
        .catch(() => wipe(op))
      return { ...view, agentReady: false }
    } catch (error) {
      wipe(op)
      throw error
    }
  }
  private async authorize(userId: number, id: string): Promise<PrivateOperation> {
    const op = this.owned(userId, id)
    try {
      await this.revalidate(op)
    } catch (error) {
      await this.manager.cancel(userId, id)
      wipe(op)
      throw error
    }
    return op
  }
  async status(userId: number, id: string): Promise<LiteratureSetupView> {
    const op = await this.authorize(userId, id)
    const view = this.manager.status(userId, id)
    if (!pending(view)) wipe(op)
    if (view.status === 'authenticated' && op.saved) {
      const verified = await this.revalidate(op)
      const row = await getPluginAccount(op.saved.id, userId, this.pool)
      if (
        !row ||
        decryptLiteratureHttpAccountEnvelope(row, verified.contract, this.options.env)
          .accountInstanceId !== op.saved.accountInstanceId
      )
        return { ...view, status: 'failed', errorCode: 'ACCOUNT_STALE', agentReady: false }
      return { ...view, accountId: op.saved.id, agentReady: this.options.isAgentReady?.() === true }
    }
    return { ...view, agentReady: false }
  }
  async image(userId: number, id: string, challengeId: string) {
    await this.authorize(userId, id)
    return this.manager.image(userId, id, challengeId)
  }
  async answer(
    userId: number,
    id: string,
    challengeId: string,
    answer: string,
  ): Promise<LiteratureSetupView> {
    await this.authorize(userId, id)
    // Consume synchronously; observe the complete promise, returning only a safe polling view.
    const work = this.manager.answer(userId, id, challengeId, answer)
    void work
      .then((view) => {
        if (!pending(view)) wipe(this.owned(userId, id))
      })
      .catch(() => {})
    return { ...this.manager.status(userId, id), agentReady: false }
  }
  async cancel(userId: number, id: string): Promise<LiteratureSetupView> {
    const op = this.owned(userId, id)
    const view = await this.manager.cancel(userId, id)
    wipe(op)
    if (view.status === 'authenticated') {
      try {
        return await this.status(userId, id)
      } catch {
        return { ...view, status: 'failed', errorCode: 'ACCOUNT_STALE', agentReady: false }
      }
    }
    return {
      ...view,
      agentReady: false,
    }
  }
  async close(): Promise<void> {
    this.closing = true
    try {
      await this.manager.close()
    } finally {
      for (const op of this.operations.values()) wipe(op)
    }
  }
}
