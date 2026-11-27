/**
 * OCV5-890 Layer 3 — ExecEnvLeaseManager: in-place execution environment anchoring
 * across brain switches (3-step quiesce -> exportAttachmentDigest -> rebindBrain)
 * and incarnation CAS protection during container rebuilds.
 *
 * Architecture invariants:
 * - R3-env / R3-crypto / R3-net / R3-special-case: zero violations.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  ExecEnvAttachmentDigest,
  ExecEnvChannelKind,
  ExecEnvHostKind,
  ExecEnvLease,
  ManagedJobSummary,
} from '@openclaude/protocol'
import { remoteCanonicalSha256 } from '@openclaude/protocol'
import type { ExecEnvJobRegistry } from './jobRegistry.js'

export type ExecEnvLeaseState = 'active' | 'quiescing' | 'closed'

export type ExecEnvLeaseErrorCode =
  | 'EXEC_LEASE_NOT_FOUND'
  | 'EXEC_LEASE_CLOSED'
  | 'EXEC_LEASE_EXPIRED'
  | 'EXEC_LEASE_QUIESCING'
  | 'EXEC_LEASE_DUPLICATE'
  | 'EXEC_FENCING_TOKEN_STALE'
  | 'EXEC_FENCING_TOKEN_REUSED'
  | 'EXEC_BRAIN_GEN_NOT_MONOTONIC'
  | 'EXEC_INCARNATION_EPOCH_STALE'

export class ExecEnvLeaseError extends Error {
  readonly code: ExecEnvLeaseErrorCode

  constructor(code: ExecEnvLeaseErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ExecEnvLeaseError'
    this.code = code
  }
}

export interface ExecEnvLeaseRecord extends ExecEnvLease {
  readonly execEnvId: string
  readonly incarnationId: string
  readonly workspaceEpoch: number
  readonly brainGen: number
  readonly fencingToken: string
  readonly ttlMs: number
  readonly state: ExecEnvLeaseState
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly quiesceFenceGen: number
}

export interface IssueExecEnvLeaseInput {
  readonly leaseId?: string
  readonly execEnvId: string
  readonly incarnationId: string
  readonly tenantId?: string
  readonly sessionKey: string
  readonly hostKind?: ExecEnvHostKind
  readonly placementEpoch?: number
  readonly workspaceEpoch?: number
  readonly brainGen?: number
  readonly fencingToken?: string
  readonly ttlMs?: number
}

export interface ExecEnvPreviewPort {
  readonly port: number
  readonly protocol?: 'http' | 'https' | 'tcp'
  readonly label?: string
  readonly url?: string
}

export interface ExecEnvLiveBrowserSnapshot {
  readonly active: boolean
  readonly url?: string
  readonly title?: string
  readonly tabCount?: number
  readonly viewport?: { readonly width: number; readonly height: number }
}

export interface ExecEnvRepoBinding {
  readonly repoUrl?: string
  readonly branch?: string
  readonly headSha?: string
  readonly dirty?: boolean
}

export interface ExecEnvRuntimeAttachmentDigest extends ExecEnvAttachmentDigest {
  readonly execEnvId: string
  readonly incarnationId: string
  readonly sessionKey: string
  readonly workspaceEpoch: number
  readonly brainGen: number
  readonly activeJobs: readonly ManagedJobSummary[]
  readonly previewPorts: readonly ExecEnvPreviewPort[]
  readonly liveBrowser: ExecEnvLiveBrowserSnapshot | null
  readonly workspaceCwd: string
  readonly repoBinding: ExecEnvRepoBinding | null
  readonly swarmHeadSeq: number
  readonly digestSha256: string
}

type MaybeProvider<T> = T | (() => T | Promise<T>)

export interface AttachmentDigestSnapshotProviders {
  readonly jobRegistry?: Pick<ExecEnvJobRegistry, 'listJobs'>
  readonly listActiveJobs?: (
    leaseId: string,
    sessionKey: string,
  ) => readonly ManagedJobSummary[] | Promise<readonly ManagedJobSummary[]>
  readonly previewPorts?: MaybeProvider<readonly ExecEnvPreviewPort[]>
  readonly liveBrowser?: MaybeProvider<ExecEnvLiveBrowserSnapshot | null>
  readonly workspaceCwd?: MaybeProvider<string>
  readonly repoBinding?: MaybeProvider<ExecEnvRepoBinding | null>
  readonly swarmHeadSeq?: MaybeProvider<number>
  readonly channelKind?: ExecEnvChannelKind
  readonly workspaceTreeSha256?: MaybeProvider<string>
  readonly policyDigest?: MaybeProvider<string>
  readonly toolCatalogSha256?: MaybeProvider<string>
}

export interface RebindBrainResult {
  readonly lease: ExecEnvLeaseRecord
  readonly digest: ExecEnvRuntimeAttachmentDigest
}

export interface ExecEnvIncarnationRecord {
  readonly execEnvId: string
  readonly incarnationId: string
  readonly ownerEpoch: number
  readonly registeredAtMs: number
}

export interface ExecEnvLeaseManagerOptions {
  readonly defaultTtlMs?: number
  readonly clock?: () => number
}

interface MutableLeaseEntry {
  lease: ExecEnvLeaseRecord
  readonly revokedTokens: Set<string>
  lastDigest: ExecEnvRuntimeAttachmentDigest | null
}

const DEFAULT_LEASE_TTL_MS = 15 * 60_000
const ZERO_SHA256 = '0'.repeat(64)

async function resolveProvider<T>(provider: MaybeProvider<T> | undefined, fallback: T): Promise<T> {
  if (provider === undefined) return fallback
  if (typeof provider === 'function') {
    return await (provider as () => T | Promise<T>)()
  }
  return provider
}

export class ExecEnvLeaseManager {
  private readonly defaultTtlMs: number
  private readonly clock: () => number
  private readonly leases = new Map<string, MutableLeaseEntry>()
  private readonly incarnations = new Map<string, ExecEnvIncarnationRecord>()

  constructor(opts: ExecEnvLeaseManagerOptions = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.clock = opts.clock ?? (() => Date.now())
  }

  issueLease(input: IssueExecEnvLeaseInput): ExecEnvLeaseRecord {
    const nowMs = this.clock()
    const leaseId = input.leaseId ?? `lease_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    if (this.leases.has(leaseId)) {
      throw new ExecEnvLeaseError('EXEC_LEASE_DUPLICATE', `Lease ${leaseId} already exists`)
    }
    const ttlMs = Math.max(1, Math.floor(input.ttlMs ?? this.defaultTtlMs))
    const brainGen = input.brainGen ?? 1
    if (!Number.isSafeInteger(brainGen) || brainGen < 1) {
      throw new ExecEnvLeaseError(
        'EXEC_BRAIN_GEN_NOT_MONOTONIC',
        `Initial brainGen must be a positive safe integer, got ${String(brainGen)}`,
      )
    }
    const fencingToken = input.fencingToken ?? `ft_${randomBytes(16).toString('hex')}`
    const workspaceEpoch = input.workspaceEpoch ?? 1
    const placementEpoch = input.placementEpoch ?? workspaceEpoch
    const expiresAtMs = nowMs + ttlMs

    const record: ExecEnvLeaseRecord = Object.freeze({
      leaseId,
      execEnvId: input.execEnvId,
      envId: input.execEnvId,
      incarnationId: input.incarnationId,
      tenantId: input.tenantId ?? 'default',
      sessionKey: input.sessionKey,
      hostKind: input.hostKind ?? 'local-docker',
      placementEpoch,
      workspaceEpoch,
      brainGen,
      fencingToken,
      ttlMs,
      state: 'active',
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      issuedAtMs: nowMs,
      expiresAtMs,
      quiesceFenceGen: 0,
    })

    this.leases.set(leaseId, {
      lease: record,
      revokedTokens: new Set(),
      lastDigest: null,
    })
    return record
  }

  getLease(leaseId: string): ExecEnvLeaseRecord | null {
    return this.leases.get(leaseId)?.lease ?? null
  }

  renewLease(leaseId: string, extendMs?: number): ExecEnvLeaseRecord {
    const entry = this.requireEntry(leaseId)
    const nowMs = this.clock()
    if (entry.lease.state === 'closed') {
      throw new ExecEnvLeaseError('EXEC_LEASE_CLOSED', `Lease ${leaseId} is closed`)
    }
    if (nowMs > entry.lease.expiresAtMs) {
      throw new ExecEnvLeaseError('EXEC_LEASE_EXPIRED', `Lease ${leaseId} expired`)
    }
    const delta = Math.max(1, Math.floor(extendMs ?? entry.lease.ttlMs))
    const nextExpiresAtMs = Math.max(nowMs, entry.lease.expiresAtMs) + delta
    entry.lease = Object.freeze({
      ...entry.lease,
      expiresAtMs: nextExpiresAtMs,
      expiresAt: new Date(nextExpiresAtMs).toISOString(),
    })
    return entry.lease
  }

  closeLease(leaseId: string): ExecEnvLeaseRecord {
    const entry = this.requireEntry(leaseId)
    entry.revokedTokens.add(entry.lease.fencingToken)
    entry.lease = Object.freeze({
      ...entry.lease,
      state: 'closed',
    })
    return entry.lease
  }

  /**
   * Validates lease liveness, active state, fencingToken equality, and monotonic brainGen.
   * Throws `EXEC_FENCING_TOKEN_STALE` on token mismatch, revoked token, or `brainGen < currentBrainGen`.
   */
  validateFencingToken(
    leaseId: string,
    fencingToken: string,
    brainGen?: number,
  ): ExecEnvLeaseRecord {
    const entry = this.requireEntry(leaseId)
    const lease = entry.lease
    const nowMs = this.clock()

    if (lease.state === 'closed') {
      throw new ExecEnvLeaseError('EXEC_LEASE_CLOSED', `Lease ${leaseId} is closed`)
    }
    if (nowMs > lease.expiresAtMs) {
      throw new ExecEnvLeaseError('EXEC_LEASE_EXPIRED', `Lease ${leaseId} expired`)
    }
    if (
      !fencingToken ||
      entry.revokedTokens.has(fencingToken) ||
      fencingToken !== lease.fencingToken ||
      (brainGen !== undefined && brainGen < lease.brainGen)
    ) {
      throw new ExecEnvLeaseError(
        'EXEC_FENCING_TOKEN_STALE',
        `Stale fencing token or brainGen for lease ${leaseId} (current brainGen=${lease.brainGen})`,
      )
    }
    if (lease.state === 'quiescing') {
      throw new ExecEnvLeaseError(
        'EXEC_LEASE_QUIESCING',
        `Lease ${leaseId} is quiescing for brain handoff`,
      )
    }
    return lease
  }

  /**
   * Step 1 of 3-step brain handoff: mark lease `quiescing`, reject new writes from the outgoing
   * brain, and increment the internal quiesce fence counter.
   */
  quiesceBrain(leaseId: string): ExecEnvLeaseRecord {
    const entry = this.requireEntry(leaseId)
    const nowMs = this.clock()
    if (entry.lease.state === 'closed') {
      throw new ExecEnvLeaseError('EXEC_LEASE_CLOSED', `Lease ${leaseId} is closed`)
    }
    if (nowMs > entry.lease.expiresAtMs) {
      throw new ExecEnvLeaseError('EXEC_LEASE_EXPIRED', `Lease ${leaseId} expired`)
    }
    entry.lease = Object.freeze({
      ...entry.lease,
      state: 'quiescing',
      quiesceFenceGen: entry.lease.quiesceFenceGen + 1,
    })
    return entry.lease
  }

  /**
   * Step 2 of 3-step brain handoff: collect active jobs, preview ports, live browser,
   * workspace cwd, repo binding, and swarm head sequence into a signed attachment digest.
   */
  async exportAttachmentDigest(
    leaseId: string,
    snapshotProviders: AttachmentDigestSnapshotProviders = {},
  ): Promise<ExecEnvRuntimeAttachmentDigest> {
    const entry = this.requireEntry(leaseId)
    const lease = entry.lease
    if (lease.state === 'closed') {
      throw new ExecEnvLeaseError('EXEC_LEASE_CLOSED', `Lease ${leaseId} is closed`)
    }

    const activeJobs = snapshotProviders.listActiveJobs
      ? await snapshotProviders.listActiveJobs(lease.leaseId, lease.sessionKey)
      : snapshotProviders.jobRegistry
        ? await snapshotProviders.jobRegistry.listJobs({
            leaseId: lease.leaseId,
            sessionKey: lease.sessionKey,
          })
        : []

    const previewPorts = await resolveProvider(snapshotProviders.previewPorts, [])
    const liveBrowser = await resolveProvider(snapshotProviders.liveBrowser, null)
    const workspaceCwd = await resolveProvider(snapshotProviders.workspaceCwd, '/workspace')
    const repoBinding = await resolveProvider(snapshotProviders.repoBinding, null)
    const swarmHeadSeq = await resolveProvider(snapshotProviders.swarmHeadSeq, 0)
    const workspaceTreeSha256 = await resolveProvider(
      snapshotProviders.workspaceTreeSha256,
      ZERO_SHA256,
    )
    const policyDigest = await resolveProvider(snapshotProviders.policyDigest, ZERO_SHA256)
    const toolCatalogSha256 = await resolveProvider(
      snapshotProviders.toolCatalogSha256,
      ZERO_SHA256,
    )
    const channelKind: ExecEnvChannelKind = snapshotProviders.channelKind ?? 'ws_tunnel'
    const attachedAt = new Date(this.clock()).toISOString()

    const body = {
      leaseId: lease.leaseId,
      execEnvId: lease.execEnvId,
      incarnationId: lease.incarnationId,
      sessionKey: lease.sessionKey,
      workspaceEpoch: lease.workspaceEpoch,
      brainGen: lease.brainGen,
      channelKind,
      workspaceTreeSha256,
      policyDigest,
      toolCatalogSha256,
      activeJobs: activeJobs.map((j) => ({
        jobId: j.jobId,
        leaseId: j.leaseId,
        lifecycleClass: j.lifecycleClass,
        state: j.state,
        ...(j.label === undefined ? {} : { label: j.label }),
        startedAt: j.startedAt,
        ...(j.finishedAt === undefined ? {} : { finishedAt: j.finishedAt }),
      })),
      previewPorts: [...previewPorts],
      liveBrowser,
      workspaceCwd,
      repoBinding,
      swarmHeadSeq,
      attachedAt,
    }

    const digestSha256 = remoteCanonicalSha256(body)
    const digest: ExecEnvRuntimeAttachmentDigest = Object.freeze({
      ...body,
      activeJobs: Object.freeze([...activeJobs]),
      previewPorts: Object.freeze([...previewPorts]),
      digestSha256,
    })

    entry.lastDigest = digest
    return digest
  }

  /**
   * Step 3 of 3-step brain handoff: atomically advance `brainGen` (strictly monotonic),
   * install a fresh `fencingToken`, revoke the previous `fencingToken`, and return `{ lease, digest }`.
   */
  async rebindBrain(
    leaseId: string,
    nextBrainGen: number,
    nextFencingToken: string,
    snapshotProviders?: AttachmentDigestSnapshotProviders,
  ): Promise<RebindBrainResult> {
    const entry = this.requireEntry(leaseId)
    const current = entry.lease
    const nowMs = this.clock()

    if (current.state === 'closed') {
      throw new ExecEnvLeaseError('EXEC_LEASE_CLOSED', `Lease ${leaseId} is closed`)
    }
    if (nowMs > current.expiresAtMs) {
      throw new ExecEnvLeaseError('EXEC_LEASE_EXPIRED', `Lease ${leaseId} expired`)
    }
    if (!Number.isSafeInteger(nextBrainGen) || nextBrainGen <= current.brainGen) {
      throw new ExecEnvLeaseError(
        'EXEC_BRAIN_GEN_NOT_MONOTONIC',
        `nextBrainGen (${String(nextBrainGen)}) must be strictly greater than current (${current.brainGen})`,
      )
    }
    if (
      typeof nextFencingToken !== 'string' ||
      nextFencingToken.trim().length === 0 ||
      nextFencingToken === current.fencingToken ||
      entry.revokedTokens.has(nextFencingToken)
    ) {
      throw new ExecEnvLeaseError(
        'EXEC_FENCING_TOKEN_REUSED',
        `nextFencingToken must be a fresh unused token for lease ${leaseId}`,
      )
    }

    // Atomic flip: revoke old token and activate new brain generation.
    entry.revokedTokens.add(current.fencingToken)
    entry.lease = Object.freeze({
      ...current,
      brainGen: nextBrainGen,
      fencingToken: nextFencingToken,
      state: 'active',
    })

    const digest = snapshotProviders
      ? await this.exportAttachmentDigest(leaseId, snapshotProviders)
      : entry.lastDigest
        ? Object.freeze({
            ...entry.lastDigest,
            brainGen: nextBrainGen,
            digestSha256: createHash('sha256')
              .update(`${entry.lastDigest.digestSha256}:rebind:${nextBrainGen}`, 'utf8')
              .digest('hex'),
          })
        : await this.exportAttachmentDigest(leaseId)

    entry.lastDigest = digest
    return {
      lease: entry.lease,
      digest,
    }
  }

  /**
   * Container rebuild incarnation CAS registration.
   * Rejects stale `ownerEpoch` registrations so a delayed old container cannot overwrite a new incarnation.
   */
  registerIncarnation(
    execEnvId: string,
    incarnationId: string,
    ownerEpoch: number,
  ): ExecEnvIncarnationRecord {
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 0) {
      throw new ExecEnvLeaseError(
        'EXEC_INCARNATION_EPOCH_STALE',
        `Invalid ownerEpoch ${String(ownerEpoch)} for ${execEnvId}`,
      )
    }
    const existing = this.incarnations.get(execEnvId)
    if (existing) {
      if (ownerEpoch < existing.ownerEpoch) {
        throw new ExecEnvLeaseError(
          'EXEC_INCARNATION_EPOCH_STALE',
          `Stale ownerEpoch ${ownerEpoch} < current ${existing.ownerEpoch} for ${execEnvId}`,
        )
      }
      if (ownerEpoch === existing.ownerEpoch && existing.incarnationId !== incarnationId) {
        throw new ExecEnvLeaseError(
          'EXEC_INCARNATION_EPOCH_STALE',
          `Conflicting incarnationId ${incarnationId} for same ownerEpoch ${ownerEpoch} on ${execEnvId}`,
        )
      }
    }
    const record: ExecEnvIncarnationRecord = Object.freeze({
      execEnvId,
      incarnationId,
      ownerEpoch,
      registeredAtMs: this.clock(),
    })
    this.incarnations.set(execEnvId, record)
    return record
  }

  /**
   * CAS unregister: refuses to remove the active incarnation route if a late teardown from an
   * older `ownerEpoch` or different `incarnationId` arrives after a rebuild.
   */
  unregisterIncarnation(
    execEnvId: string,
    incarnationId: string,
    ownerEpoch: number,
  ): { readonly removed: boolean; readonly reason?: 'not_found' | 'stale_owner_epoch' | 'incarnation_mismatch' } {
    const existing = this.incarnations.get(execEnvId)
    if (!existing) return { removed: false, reason: 'not_found' }
    if (ownerEpoch < existing.ownerEpoch) {
      return { removed: false, reason: 'stale_owner_epoch' }
    }
    if (existing.incarnationId !== incarnationId || existing.ownerEpoch !== ownerEpoch) {
      return { removed: false, reason: 'incarnation_mismatch' }
    }
    this.incarnations.delete(execEnvId)
    return { removed: true }
  }

  getIncarnation(execEnvId: string): ExecEnvIncarnationRecord | null {
    return this.incarnations.get(execEnvId) ?? null
  }

  private requireEntry(leaseId: string): MutableLeaseEntry {
    const entry = this.leases.get(leaseId)
    if (!entry) {
      throw new ExecEnvLeaseError('EXEC_LEASE_NOT_FOUND', `Lease ${leaseId} not found`)
    }
    return entry
  }
}
