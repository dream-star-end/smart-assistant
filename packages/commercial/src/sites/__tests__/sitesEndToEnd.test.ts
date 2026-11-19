import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { type ContainerIdentityRepo, hashSecret } from '../../auth/containerIdentity.js'
import { signAccess } from '../../auth/jwt.js'
import type { RequestContext } from '../../http/handlers.js'
import { createHttpSitesEdgeClient, type SitesEdgeClient } from '../edgeClient.js'
import { runSiteApiWorker } from '../edgeApiRunner.js'
import { createSitesEdgeServer } from '../edgeServer.js'
import { dispatchSitesBrowserRoute } from '../browserHttp.js'
import { makeSitesInternalHandler } from '../internalHttp.js'
import type {
  CommitPublishInput,
  DeleteReservation,
  MetaUpdateReservation,
  PublishReservation,
  PublishReservationInput,
  SitesRepo,
  StoredSiteCollaboratorRow,
  StoredSiteEnvVarRow,
  StoredSiteInviteRow,
} from '../repo.js'
import { SitesService } from '../service.js'
import {
  SitesError,
  type SiteAccessRole,
  type SiteCollaboratorRole,
  type SiteVisibility,
  type UserSiteRow,
  customDomainTxtValueFor,
  decodeSiteBundle,
  encodeSiteBundle,
} from '../types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OC_SITE_PY = resolve(
  HERE,
  '../../../agent-sandbox/platform-runtime/bin/oc-site.py',
)
const EDGE_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'

function createInMemorySitesRepo(repoOpts?: { idPrefix?: string; initialRev?: number }): SitesRepo & {
  expireLease(slug: string): void
  simulateLegacyMasterPublish(
    slug: string,
    patch: { hasServerApi: boolean; contentSha256?: string },
  ): UserSiteRow
} {
  const bySlug = new Map<string, UserSiteRow>()
  const claims = new Map<string, { siteId: string; claimKind: 'active' | 'rename_target' }>()
  const leases = new Map<string, { leaseId: string; leaseUntil: number; expectedRev: number }>()
  const targetRevs = new Map<string, number>()
  const envStore = new Map<string, Map<string, StoredSiteEnvVarRow>>()
  const collabStore = new Map<string, Map<number, StoredSiteCollaboratorRow>>()
  const inviteStore = new Map<string, { row: StoredSiteInviteRow; tokenHash: string }>()
  const usersById = new Map<
    number,
    { id: number; email: string; displayName: string; emailVerified: boolean }
  >([
    [1, { id: 1, email: 'owner@example.com', displayName: 'Owner One', emailVerified: true }],
    [2, { id: 2, email: 'editor@example.com', displayName: 'Editor Two', emailVerified: true }],
    [3, { id: 3, email: 'viewer@example.com', displayName: 'Viewer Three', emailVerified: true }],
    [4, { id: 4, email: 'unverified@example.com', displayName: 'Unverified Four', emailVerified: false }],
  ])
  let revCounter = repoOpts?.initialRev ?? 0
  let idSeq = 0
  const idPrefix = repoOpts?.idPrefix ?? '00000000'
  const LEASE_TTL_MS = 60_000

  function isLeaseActive(siteId: string): boolean {
    const l = leases.get(siteId)
    return Boolean(l && l.leaseUntil > Date.now())
  }

  function decorateRow(row: UserSiteRow, actorUserId: number): UserSiteRow {
    const owner = usersById.get(row.userId)
    const collabs = collabStore.get(row.id)
    const role: SiteAccessRole =
      row.userId === actorUserId ? 'owner' : (collabs?.get(actorUserId)?.role ?? 'owner')
    return {
      ...row,
      accessRole: role,
      ownerEmail: owner?.email ?? null,
      ownerDisplayName: owner?.displayName ?? null,
      collaboratorCount: collabs?.size ?? 0,
    }
  }

  return {
    expireLease(slug: string) {
      const row = bySlug.get(slug)
      if (row) leases.delete(row.id)
    },
    simulateLegacyMasterPublish(
      slug: string,
      patch: { hasServerApi: boolean; contentSha256?: string },
    ): UserSiteRow {
      const row = bySlug.get(slug)
      if (!row) throw new Error(`missing site ${slug}`)
      revCounter += 1
      const updated: UserSiteRow = {
        ...row,
        edgeRevision: Math.max(row.edgeRevision + 1, revCounter),
        hasServerApi: patch.hasServerApi,
        contentSha256: patch.contentSha256 ?? row.contentSha256,
        updatedAt: new Date(),
      }
      bySlug.set(slug, updated)
      return updated
    },
    async listByUser(userId) {
      return [...bySlug.values()]
        .filter((r) => r.edgeRevision > 0 && (r.userId === userId || Boolean(collabStore.get(r.id)?.has(userId))))
        .map((r) => decorateRow(r, userId))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    },
    async getByUserAndSlug(userId, slug) {
      const row = bySlug.get(slug)
      if (!row || row.edgeRevision <= 0) return null
      if (row.userId !== userId && !collabStore.get(row.id)?.has(userId)) return null
      return decorateRow(row, userId)
    },
    async listUnleasedPendingByUser(userId) {
      const now = Date.now()
      return [...bySlug.values()]
        .filter((r) => {
          const lease = leases.get(r.id)
          const pendingRev = targetRevs.get(r.id) ?? 0
          const hasAccess = r.userId === userId || Boolean(collabStore.get(r.id)?.has(userId))
          return (
            hasAccess &&
            (!lease || lease.leaseUntil <= now) &&
            (r.edgeRevision === 0 ||
              pendingRev > r.edgeRevision ||
              Boolean(r.opKind) ||
              (r.previewAclTargetVersion ?? 1) > (r.previewAclVersion ?? 1))
          )
        })
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    },
    async tryClaimReconcileLease(siteId, userId) {
      const cur = [...bySlug.values()].find((r) => r.id === siteId && r.userId === userId)
      if (!cur) return null
      if (isLeaseActive(cur.id)) return null
      const pendingRev = targetRevs.get(cur.id) ?? 0
      if (
        cur.edgeRevision > 0 &&
        pendingRev <= cur.edgeRevision &&
        !cur.opKind &&
        (cur.previewAclTargetVersion ?? 1) <= (cur.previewAclVersion ?? 1)
      ) {
        return null
      }
      const leaseId = randomUUID()
      leases.set(cur.id, {
        leaseId,
        leaseUntil: Date.now() + LEASE_TTL_MS,
        expectedRev: cur.edgeRevision,
      })
      return { row: cur, leaseId }
    },
    async reconcileFromEdge(input) {
      const cur = [...bySlug.values()].find((r) => r.id === input.siteId && r.userId === input.userId)
      if (!cur) return null
      const lease = leases.get(cur.id)
      if (lease?.leaseId !== input.leaseId || cur.edgeRevision > input.edgeRevision) return null
      const now = new Date()
      const updated: UserSiteRow = {
        ...cur,
        title: input.title,
        visibility: input.visibility,
        passwordSalt: input.passwordSalt,
        passwordHash: input.passwordHash,
        spaMode: input.spaMode,
        customDomain: input.customDomain !== undefined ? input.customDomain : cur.customDomain,
        customDomainVerified:
          input.customDomain !== undefined
            ? Boolean(input.customDomain && input.customDomainVerified)
            : cur.customDomainVerified,
        hasServerApi: input.hasServerApi,
        serverApiSha256: !input.hasServerApi
          ? ''
          : cur.opKind === 'publish' && cur.opServerApiSha256 != null
            ? cur.opServerApiSha256
            : (cur.serverApiSha256 ?? ''),
        opServerApiSha256: null,
        previewAclVersion: Math.max(cur.previewAclVersion ?? 1, input.previewAclVersion ?? 1),
        previewAclTargetVersion: Math.max(
          cur.previewAclTargetVersion ?? 1,
          cur.previewAclVersion ?? 1,
          input.previewAclVersion ?? 1,
        ),
        envDigest: input.envDigest ?? cur.envDigest,
        opKind: null,
        opRenameToSlug: null,
        opEnvDigest: null,
        fileCount: input.fileCount,
        sizeBytes: input.sizeBytes,
        contentSha256: input.contentSha256,
        edgeRevision: Math.max(cur.edgeRevision, input.edgeRevision),
        updatedAt: now,
        lastPublishedAt: cur.edgeRevision === 0 ? now : cur.lastPublishedAt,
      }
      bySlug.set(cur.slug, updated)
      leases.delete(cur.id)
      targetRevs.delete(cur.id)
      return updated
    },
    async beginPublishReservation(input: PublishReservationInput): Promise<PublishReservation> {
      const claim = claims.get(input.slug)
      if (claim && claim.claimKind === 'rename_target') {
        const owner = [...bySlug.values()].find((r) => r.id === claim.siteId)
        if (owner && owner.userId !== input.userId) {
          throw new SitesError('SLUG_TAKEN', `子域名 "${input.slug}" 已被占用`, 409)
        }
        throw new SitesError('SLUG_BUSY', `子域名 "${input.slug}" 正在迁移中`, 409, true)
      }
      const existing = bySlug.get(input.slug)
      const leaseId = randomUUID()
      const leaseUntil = Date.now() + LEASE_TTL_MS
      const hasExpectedBase = Boolean(
        input.expectedSiteId ||
          input.expectedBaseRevision !== undefined ||
          input.expectedBaseContentSha256,
      )
      if (existing) {
        let accessRole: SiteAccessRole = 'owner'
        if (existing.userId !== input.userId) {
          const collab = collabStore.get(existing.id)?.get(input.userId)
          if (!collab || existing.edgeRevision <= 0) {
            throw new SitesError('SLUG_TAKEN', `子域名 "${input.slug}" 已被占用`, 409)
          }
          if (collab.role !== 'editor') {
            throw new SitesError('FORBIDDEN', '你对该站点只有只读权限，无法发布更新', 403)
          }
          accessRole = 'editor'
        }
        if (isLeaseActive(existing.id)) {
          throw new SitesError(
            'SLUG_BUSY',
            `站点 "${input.slug}" 正在进行另一项发布或变更，请稍后重试`,
            409,
            true,
          )
        }
        if (input.expectedSiteId && existing.id !== input.expectedSiteId) {
          throw new SitesError('STALE_REVISION', '子域名已指向其他站点，拒绝覆盖', 409)
        }
        if (accessRole !== 'owner' && input.forceOverwrite) {
          throw new SitesError('FORBIDDEN', '仅站点所有者可执行强制覆盖发布', 403)
        }
        if (
          accessRole === 'editor' &&
          (input.hasServerApi || existing.hasServerApi || Boolean(existing.serverApiSha256))
        ) {
          const approvedSha = existing.serverApiSha256 ?? ''
          const incomingSha = input.hasServerApi ? (input.serverApiSha256 ?? '') : ''
          const matchesApproved = existing.hasServerApi
            ? input.hasServerApi && Boolean(approvedSha) && incomingSha === approvedSha
            : !input.hasServerApi && approvedSha === '' && incomingSha === ''
          if (!matchesApproved) {
            throw new SitesError(
              'FORBIDDEN',
              '仅站点所有者可新增、修改或移除服务端 /api/* 代码',
              403,
            )
          }
        }
        if (existing.edgeRevision > 0) {
          const hasCollaborators = (collabStore.get(existing.id)?.size ?? 0) > 0
          const requiresBaseline =
            accessRole === 'editor' ||
            (accessRole === 'owner' && hasCollaborators && !input.forceOverwrite)
          if (
            requiresBaseline &&
            input.expectedBaseRevision === undefined &&
            !input.expectedBaseContentSha256
          ) {
            throw new SitesError('STALE_REVISION', '协同发布必须提供拉取基线版本', 409)
          }
          if (
            input.expectedBaseRevision !== undefined &&
            existing.edgeRevision !== input.expectedBaseRevision
          ) {
            throw new SitesError('STALE_REVISION', '远端站点已更新，请先拉取合并后再发布', 409)
          }
          if (
            input.expectedBaseContentSha256 &&
            existing.contentSha256 !== input.expectedBaseContentSha256
          ) {
            throw new SitesError('STALE_REVISION', '远端站点内容已变化，请先拉取合并后再发布', 409)
          }
        }
        revCounter += 1
        bySlug.set(input.slug, {
          ...existing,
          opKind: 'publish',
          opRenameToSlug: null,
          opEnvDigest: null,
          opServerApiSha256:
            accessRole === 'owner' ? (input.hasServerApi ? (input.serverApiSha256 ?? '') : '') : null,
        })
        claims.set(input.slug, { siteId: existing.id, claimKind: 'active' })
        leases.set(existing.id, { leaseId, leaseUntil, expectedRev: existing.edgeRevision })
        targetRevs.set(existing.id, revCounter)
        return {
          siteId: existing.id,
          ownerUserId: existing.userId,
          accessRole,
          leaseId,
          isNewPlaceholder: existing.edgeRevision === 0,
          edgeRevision: revCounter,
          baseRevision: existing.edgeRevision,
          existing: existing.edgeRevision > 0 ? decorateRow(existing, input.userId) : null,
        }
      }
      if (hasExpectedBase) {
        throw new SitesError('STALE_REVISION', '基线站点已不存在或已被重命名，拒绝自动新建站点', 409)
      }
      const count = [...bySlug.values()].filter((r) => r.userId === input.userId).length
      if (count >= input.maxPerUser) {
        throw new SitesError('QUOTA_EXCEEDED', '站点配额已满', 429)
      }
      revCounter += 1
      idSeq += 1
      const now = new Date()
      const row: UserSiteRow = {
        id: `${idPrefix}-0000-4000-8000-${String(idSeq).padStart(12, '0')}`,
        slug: input.slug,
        userId: input.userId,
        title: input.title,
        visibility: input.visibility,
        passwordSalt: input.passwordSalt,
        passwordHash: input.passwordHash,
        spaMode: input.spaMode,
        customDomain: null,
        customDomainVerified: false,
        customDomainToken: null,
        originSessionId: input.originSessionId ?? null,
        hasServerApi: input.hasServerApi,
        serverApiSha256: input.serverApiSha256 ?? '',
        opServerApiSha256: input.hasServerApi ? (input.serverApiSha256 ?? '') : '',
        previewAclVersion: 1,
        previewAclTargetVersion: 1,
        envDigest: '',
        opKind: 'publish',
        opRenameToSlug: null,
        opEnvDigest: null,
        fileCount: 0,
        sizeBytes: 0,
        contentSha256: '',
        edgeRevision: 0,
        createdAt: now,
        updatedAt: now,
        lastPublishedAt: now,
      }
      bySlug.set(input.slug, row)
      claims.set(input.slug, { siteId: row.id, claimKind: 'active' })
      leases.set(row.id, { leaseId, leaseUntil, expectedRev: 0 })
      targetRevs.set(row.id, revCounter)
      return {
        siteId: row.id,
        ownerUserId: input.userId,
        accessRole: 'owner',
        leaseId,
        isNewPlaceholder: true,
        edgeRevision: revCounter,
        baseRevision: 0,
        existing: null,
      }
    },
    async commitPublish(input: CommitPublishInput): Promise<UserSiteRow> {
      const cur = [...bySlug.values()].find((r) => r.id === input.siteId && r.userId === input.userId)
      if (!cur) throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
      if (cur.edgeRevision < input.edgeRevision) {
        const now = new Date()
        const updated: UserSiteRow = {
          ...cur,
          title: input.title,
          visibility: input.visibility,
          passwordSalt: input.passwordSalt,
          passwordHash: input.passwordHash,
          spaMode: input.spaMode,
          originSessionId: input.originSessionId ?? cur.originSessionId,
          hasServerApi: input.hasServerApi,
          serverApiSha256:
            input.serverApiSha256 !== undefined ? input.serverApiSha256 : (cur.serverApiSha256 ?? ''),
          opServerApiSha256: null,
          previewAclVersion: Math.max(cur.previewAclVersion ?? 1, input.previewAclVersion ?? 1),
          previewAclTargetVersion: Math.max(
            cur.previewAclTargetVersion ?? 1,
            cur.previewAclVersion ?? 1,
            input.previewAclVersion ?? 1,
          ),
          envDigest: input.envDigest ?? cur.envDigest,
          opKind: input.markEnvPending ? 'env' : null,
          opRenameToSlug: null,
          opEnvDigest: input.markEnvPending ? (input.pendingEnvDigest ?? null) : null,
          fileCount: input.fileCount,
          sizeBytes: input.sizeBytes,
          contentSha256: input.contentSha256,
          edgeRevision: input.edgeRevision,
          updatedAt: now,
          lastPublishedAt: now,
        }
        bySlug.set(cur.slug, updated)
        if (leases.get(cur.id)?.leaseId === input.leaseId) leases.delete(cur.id)
        if (input.markEnvPending) targetRevs.set(cur.id, input.edgeRevision)
        else if ((targetRevs.get(cur.id) ?? 0) <= input.edgeRevision) targetRevs.delete(cur.id)
        return updated
      }
      if (cur.edgeRevision === input.edgeRevision) return cur
      throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
    },
    async abortPublishPlaceholder(siteId, userId, leaseId) {
      for (const [slug, r] of bySlug) {
        const lease = leases.get(r.id)
        if (
          r.id === siteId &&
          r.userId === userId &&
          r.edgeRevision === 0 &&
          lease?.leaseId === leaseId
        ) {
          bySlug.delete(slug)
          claims.delete(slug)
          leases.delete(r.id)
          targetRevs.delete(r.id)
        }
      }
    },
    async releaseLease(siteId, userId, leaseId, clearTarget = true) {
      const r = [...bySlug.values()].find((row) => row.id === siteId && row.userId === userId)
      if (!r) return
      const lease = leases.get(r.id)
      if (lease?.leaseId === leaseId) {
        leases.delete(r.id)
        if (clearTarget) {
          targetRevs.delete(r.id)
          bySlug.set(r.slug, { ...r, opKind: null, opRenameToSlug: null, opEnvDigest: null })
        }
      }
    },
    async prepareMetaUpdate(
      userId,
      slug,
      opKind = 'meta',
      pendingEnvDigest = null,
      checkDomain = null,
      allowEditor = false,
    ): Promise<MetaUpdateReservation> {
      const row = bySlug.get(slug)
      if (!row || row.edgeRevision <= 0) {
        throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
      }
      const collab = collabStore.get(row.id)?.get(userId)
      const role: SiteAccessRole | null =
        row.userId === userId ? 'owner' : (collab?.role ?? null)
      if (!role) {
        throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
      }
      if (role !== 'owner' && !(allowEditor && role === 'editor')) {
        throw new SitesError('FORBIDDEN', '仅站点所有者或具编辑权限的协作者可执行此操作', 403)
      }
      if (isLeaseActive(row.id)) {
        throw new SitesError('SLUG_BUSY', `站点 "${slug}" 正在处理另一项变更`, 409, true)
      }
      if (checkDomain) {
        for (const other of bySlug.values()) {
          if (other.id !== row.id && other.customDomain === checkDomain && other.customDomainVerified) {
            throw new SitesError('DOMAIN_TAKEN', '该自定义域名已被其他站点绑定', 409)
          }
        }
      }
      revCounter += 1
      const leaseId = randomUUID()
      const marked: UserSiteRow = {
        ...decorateRow(row, userId),
        opKind,
        opRenameToSlug: null,
        opEnvDigest: pendingEnvDigest,
      }
      bySlug.set(slug, marked)
      leases.set(row.id, { leaseId, leaseUntil: Date.now() + LEASE_TTL_MS, expectedRev: row.edgeRevision })
      targetRevs.set(row.id, revCounter)
      return { site: marked, leaseId, nextRevision: revCounter }
    },
    async commitMetaUpdate(input): Promise<UserSiteRow> {
      const cur = [...bySlug.values()].find((r) => r.id === input.siteId && r.userId === input.userId)
      if (!cur) throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
      if (input.customDomain) {
        for (const other of bySlug.values()) {
          if (
            other.id !== cur.id &&
            other.customDomain === input.customDomain &&
            other.customDomainVerified
          ) {
            throw new SitesError('DOMAIN_TAKEN', '该自定义域名已被其他站点绑定', 409)
          }
        }
      }
      if (cur.edgeRevision < input.edgeRevision) {
        const updated: UserSiteRow = {
          ...cur,
          title: input.title,
          visibility: input.visibility,
          passwordSalt: input.passwordSalt,
          passwordHash: input.passwordHash,
          spaMode: input.spaMode,
          customDomain: input.customDomain,
          customDomainVerified: input.customDomainVerified,
          customDomainToken: input.customDomainToken,
          envDigest: input.envDigest ?? cur.envDigest,
          previewAclVersion:
            input.previewAclVersion !== undefined
              ? Math.max(cur.previewAclVersion ?? 1, input.previewAclVersion)
              : (cur.previewAclVersion ?? 1),
          previewAclTargetVersion:
            input.previewAclVersion !== undefined
              ? Math.max(cur.previewAclTargetVersion ?? 1, cur.previewAclVersion ?? 1, input.previewAclVersion)
              : (cur.previewAclTargetVersion ?? 1),
          opKind: null,
          opRenameToSlug: null,
          opEnvDigest: null,
          edgeRevision: input.edgeRevision,
          updatedAt: new Date(),
        }
        bySlug.set(cur.slug, updated)
        if (leases.get(cur.id)?.leaseId === input.leaseId) leases.delete(cur.id)
        if ((targetRevs.get(cur.id) ?? 0) <= input.edgeRevision) targetRevs.delete(cur.id)
        return updated
      }
      if (cur.edgeRevision === input.edgeRevision) return cur
      throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
    },
    async prepareRename(userId, oldSlug, newSlug): Promise<MetaUpdateReservation> {
      const row = bySlug.get(oldSlug)
      if (!row || row.userId !== userId || row.edgeRevision <= 0) {
        throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${oldSlug}"`, 404)
      }
      if (isLeaseActive(row.id)) {
        throw new SitesError('SLUG_BUSY', `站点 "${oldSlug}" 正在处理另一项变更`, 409, true)
      }
      if (bySlug.has(newSlug) || claims.has(newSlug)) {
        throw new SitesError('SLUG_TAKEN', `子域名 "${newSlug}" 已被占用`, 409)
      }
      revCounter += 1
      const leaseId = randomUUID()
      claims.set(newSlug, { siteId: row.id, claimKind: 'rename_target' })
      const marked: UserSiteRow = { ...row, opKind: 'rename', opRenameToSlug: newSlug, opEnvDigest: null }
      bySlug.set(oldSlug, marked)
      leases.set(row.id, { leaseId, leaseUntil: Date.now() + LEASE_TTL_MS, expectedRev: row.edgeRevision })
      targetRevs.set(row.id, revCounter)
      return { site: marked, leaseId, nextRevision: revCounter }
    },
    async commitRename(input): Promise<UserSiteRow> {
      const cur = [...bySlug.values()].find((r) => r.id === input.siteId && r.userId === input.userId)
      if (!cur) throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
      if (cur.slug !== input.newSlug && bySlug.has(input.newSlug)) {
        throw new SitesError('SLUG_TAKEN', `子域名 "${input.newSlug}" 已被占用`, 409)
      }
      if (cur.edgeRevision < input.edgeRevision) {
        bySlug.delete(cur.slug)
        claims.delete(cur.slug)
        const updated: UserSiteRow = {
          ...cur,
          slug: input.newSlug,
          opKind: null,
          opRenameToSlug: null,
          opEnvDigest: null,
          edgeRevision: input.edgeRevision,
          updatedAt: new Date(),
        }
        bySlug.set(input.newSlug, updated)
        claims.set(input.newSlug, { siteId: cur.id, claimKind: 'active' })
        if (leases.get(cur.id)?.leaseId === input.leaseId) leases.delete(cur.id)
        if ((targetRevs.get(cur.id) ?? 0) <= input.edgeRevision) targetRevs.delete(cur.id)
        return updated
      }
      if (cur.edgeRevision === input.edgeRevision && cur.slug === input.newSlug) {
        claims.set(input.newSlug, { siteId: cur.id, claimKind: 'active' })
        return cur
      }
      throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
    },
    async abortRenameReservation(siteId, userId, leaseId, newSlug, clearTarget = true) {
      const c = claims.get(newSlug)
      if (c && c.siteId === siteId && c.claimKind === 'rename_target') {
        claims.delete(newSlug)
      }
      const r = [...bySlug.values()].find((row) => row.id === siteId && row.userId === userId)
      if (!r) return
      if (leases.get(r.id)?.leaseId === leaseId) {
        leases.delete(r.id)
        if (clearTarget) {
          targetRevs.delete(r.id)
          bySlug.set(r.slug, { ...r, opKind: null, opRenameToSlug: null, opEnvDigest: null })
        }
      }
    },
    async prepareDelete(userId, slug): Promise<DeleteReservation> {
      const row = bySlug.get(slug)
      if (!row || row.userId !== userId || row.edgeRevision <= 0) {
        throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
      }
      if (isLeaseActive(row.id)) {
        throw new SitesError('SLUG_BUSY', `站点 "${slug}" 正在处理另一项变更`, 409, true)
      }
      revCounter += 1
      const leaseId = randomUUID()
      const marked: UserSiteRow = { ...row, opKind: 'delete', opRenameToSlug: null, opEnvDigest: null }
      bySlug.set(slug, marked)
      leases.set(row.id, { leaseId, leaseUntil: Date.now() + LEASE_TTL_MS, expectedRev: row.edgeRevision })
      targetRevs.set(row.id, revCounter)
      return { site: marked, leaseId, deleteRevision: revCounter }
    },
    async commitDelete(siteId, userId, _leaseId, deleteRevision) {
      for (const [slug, r] of bySlug) {
        if (r.id === siteId && r.userId === userId && r.edgeRevision < deleteRevision) {
          bySlug.delete(slug)
          claims.delete(slug)
          leases.delete(r.id)
          targetRevs.delete(r.id)
          envStore.delete(r.id)
        }
      }
    },
    async listSiteEnvRows(siteId, userId) {
      const site = [...bySlug.values()].find((r) => r.id === siteId && r.userId === userId)
      if (!site) return []
      const map = envStore.get(siteId)
      if (!map) return []
      return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    },
    async upsertSiteEnvRow(input) {
      const site = [...bySlug.values()].find(
        (r) => r.id === input.siteId && r.userId === input.userId && r.edgeRevision > 0,
      )
      if (!site) throw new SitesError('SITE_NOT_FOUND', '未找到对应站点', 404)
      let map = envStore.get(input.siteId)
      if (!map) {
        map = new Map()
        envStore.set(input.siteId, map)
      }
      const otherCount = [...map.keys()].filter((k) => k !== input.key).length
      if (otherCount >= input.maxEnvVars) {
        throw new SitesError('QUOTA_EXCEEDED', `每个站点最多配置 ${input.maxEnvVars} 个环境变量`, 429)
      }
      const saved: StoredSiteEnvVarRow = {
        siteId: input.siteId,
        key: input.key,
        isSecret: input.isSecret,
        plainValue: input.plainValue,
        ciphertext: input.ciphertext,
        nonce: input.nonce,
        updatedAt: new Date(),
      }
      map.set(input.key, saved)
      return saved
    },
    async deleteSiteEnvRow(siteId, userId, key) {
      const site = [...bySlug.values()].find((r) => r.id === siteId && r.userId === userId)
      if (!site) return false
      return envStore.get(siteId)?.delete(key) ?? false
    },
    async listCollaborators(siteId) {
      return [...(collabStore.get(siteId)?.values() ?? [])]
    },
    async upsertCollaboratorByEmail(input) {
      const site = [...bySlug.values()].find(
        (r) => r.id === input.siteId && r.userId === input.ownerUserId && r.edgeRevision > 0,
      )
      if (!site) throw new SitesError('SITE_NOT_FOUND', '未找到对应站点', 404)
      const target = [...usersById.values()].find(
        (u) => u.email.toLowerCase() === input.email.toLowerCase(),
      )
      if (!target) throw new SitesError('USER_NOT_FOUND', `未找到注册邮箱为 ${input.email} 的站内用户`, 404)
      if (!target.emailVerified) {
        throw new SitesError('INVALID_INPUT', '该账号尚未完成邮箱验证，无法按邮箱直接授权', 400)
      }
      if (target.id === input.ownerUserId) {
        throw new SitesError('INVALID_INPUT', '不能将站点所有者自己添加为协作者', 400)
      }
      let map = collabStore.get(input.siteId)
      if (!map) {
        map = new Map()
        collabStore.set(input.siteId, map)
      }
      if (!map.has(target.id) && map.size >= input.maxCollaborators) {
        throw new SitesError('QUOTA_EXCEEDED', '协作者人数已达上限', 429)
      }
      const now = new Date()
      const existing = map.get(target.id)
      const saved: StoredSiteCollaboratorRow = {
        siteId: input.siteId,
        userId: target.id,
        email: target.email,
        displayName: target.displayName,
        role: input.role,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      map.set(target.id, saved)
      if (existing?.role === 'editor' && input.role === 'viewer') {
        const nextTarget = Math.max(site.previewAclTargetVersion ?? 1, site.previewAclVersion ?? 1) + 1
        bySlug.set(site.slug, { ...site, previewAclTargetVersion: nextTarget })
      }
      return saved
    },
    async updateCollaboratorRole(input) {
      const site = [...bySlug.values()].find((r) => r.id === input.siteId && r.userId === input.ownerUserId)
      const map = collabStore.get(input.siteId)
      const cur = map?.get(input.targetUserId)
      if (!cur) throw new SitesError('USER_NOT_FOUND', '未找到该协作者', 404)
      const updated = { ...cur, role: input.role, updatedAt: new Date() }
      map!.set(input.targetUserId, updated)
      if (site && cur.role === 'editor' && input.role === 'viewer') {
        const nextTarget = Math.max(site.previewAclTargetVersion ?? 1, site.previewAclVersion ?? 1) + 1
        bySlug.set(site.slug, { ...site, previewAclTargetVersion: nextTarget })
      }
      return updated
    },
    async removeCollaborator(input) {
      const removed = collabStore.get(input.siteId)?.delete(input.targetUserId) ?? false
      if (removed) {
        const site = [...bySlug.values()].find((r) => r.id === input.siteId && r.userId === input.ownerUserId)
        if (site) {
          const nextTarget = Math.max(site.previewAclTargetVersion ?? 1, site.previewAclVersion ?? 1) + 1
          bySlug.set(site.slug, { ...site, previewAclTargetVersion: nextTarget })
        }
      }
      return removed
    },
    async leaveSiteCollaborator(siteId, actorUserId) {
      const left = collabStore.get(siteId)?.delete(actorUserId) ?? false
      if (left) {
        const site = [...bySlug.values()].find((r) => r.id === siteId)
        if (site) {
          const nextTarget = Math.max(site.previewAclTargetVersion ?? 1, site.previewAclVersion ?? 1) + 1
          bySlug.set(site.slug, { ...site, previewAclTargetVersion: nextTarget })
        }
      }
      return left
    },
    async listActiveInvites(siteId, ownerUserId) {
      const site = [...bySlug.values()].find((r) => r.id === siteId && r.userId === ownerUserId)
      if (!site) return []
      const now = Date.now()
      return [...inviteStore.values()]
        .map((x) => x.row)
        .filter(
          (i) =>
            i.siteId === siteId &&
            !i.revokedAt &&
            (!i.expiresAt || i.expiresAt.getTime() > now) &&
            (i.maxUses === null || i.useCount < i.maxUses),
        )
    },
    async createInvite(input) {
      const row: StoredSiteInviteRow = {
        id: randomUUID(),
        siteId: input.siteId,
        role: input.role,
        maxUses: input.maxUses,
        useCount: 0,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: new Date(),
      }
      inviteStore.set(row.id, { row, tokenHash: input.tokenHash })
      return row
    },
    async revokeInvite(input) {
      const entry = inviteStore.get(input.inviteId)
      if (!entry || entry.row.siteId !== input.siteId || entry.row.revokedAt) return false
      entry.row = { ...entry.row, revokedAt: new Date() }
      return true
    },
    async lookupInviteByTokenHash(tokenHash, actorUserId) {
      const entry = [...inviteStore.values()].find((x) => x.tokenHash === tokenHash)
      if (!entry) return null
      const inv = entry.row
      if (inv.revokedAt) return null
      if (inv.expiresAt && inv.expiresAt.getTime() <= Date.now()) return null
      if (inv.maxUses !== null && inv.useCount >= inv.maxUses) return null
      const site = [...bySlug.values()].find((r) => r.id === inv.siteId && r.edgeRevision > 0)
      if (!site) return null
      const owner = usersById.get(site.userId)
      const alreadyRole: SiteAccessRole | null =
        site.userId === actorUserId
          ? 'owner'
          : (collabStore.get(site.id)?.get(actorUserId)?.role ?? null)
      return {
        invite: inv,
        site: decorateRow(site, actorUserId),
        ownerEmail: owner?.email ?? null,
        ownerDisplayName: owner?.displayName ?? null,
        alreadyRole,
      }
    },
    async acceptInviteByTokenHash(tokenHash, actorUserId, maxCollaborators) {
      const entry = [...inviteStore.values()].find((x) => x.tokenHash === tokenHash)
      if (!entry || entry.row.revokedAt) {
        throw new SitesError('INVITE_INVALID', '邀请链接无效或已被撤销', 404)
      }
      const inv = entry.row
      if (inv.expiresAt && inv.expiresAt.getTime() <= Date.now()) {
        throw new SitesError('INVITE_INVALID', '邀请链接已过期', 410)
      }
      if (inv.maxUses !== null && inv.useCount >= inv.maxUses) {
        throw new SitesError('INVITE_INVALID', '邀请链接使用次数已达上限', 410)
      }
      const site = [...bySlug.values()].find((r) => r.id === inv.siteId && r.edgeRevision > 0)
      if (!site) throw new SitesError('SITE_NOT_FOUND', '对应站点已不存在', 404)
      if (site.userId === actorUserId) {
        return { site: decorateRow(site, actorUserId), role: 'owner' as SiteAccessRole, alreadyMember: true }
      }
      let map = collabStore.get(site.id)
      if (!map) {
        map = new Map()
        collabStore.set(site.id, map)
      }
      const existing = map.get(actorUserId)
      if (existing && (existing.role === 'editor' || (existing.role === 'viewer' && inv.role === 'viewer'))) {
        return { site: decorateRow(site, actorUserId), role: existing.role, alreadyMember: true }
      }
      if (!existing && map.size >= maxCollaborators) {
        throw new SitesError('QUOTA_EXCEEDED', '协作者人数已达上限', 429)
      }
      const u = usersById.get(actorUserId) ?? {
        id: actorUserId,
        email: `u${actorUserId}@example.com`,
        displayName: `User ${actorUserId}`,
      }
      const now = new Date()
      map.set(actorUserId, {
        siteId: site.id,
        userId: actorUserId,
        email: u.email,
        displayName: u.displayName,
        role: inv.role as SiteCollaboratorRole,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      entry.row = { ...inv, useCount: inv.useCount + 1 }
      return { site: decorateRow(site, actorUserId), role: inv.role, alreadyMember: false }
    },
  }
}

function edgeHttpRequest(opts: {
  port: number
  method?: string
  path: string
  host?: string
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    if (opts.host) headers.Host = opts.host
    if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body))
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', rejectPromise)
      },
    )
    req.on('error', rejectPromise)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

function runPythonCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('python3', [OC_SITE_PY, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += String(c)))
    child.stderr.on('data', (c) => (stderr += String(c)))
    child.on('error', rejectPromise)
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

describe('sites hosting end-to-end (edge + master + oc-site CLI)', () => {
  let workDir = ''
  let edgePort = 0
  let masterPort = 0
  let closeEdge: () => Promise<void>
  let closeMaster: () => Promise<void>
  let edgeClient: ReturnType<typeof createHttpSitesEdgeClient>
  let user1Jwt = ''
  let user2Jwt = ''

  const SECRET_1 = '1111111111111111111111111111111111111111111111111111111111111111'
  const SECRET_2 = '2222222222222222222222222222222222222222222222222222222222222222'
  const TOKEN_1 = `oc-v3.101.${SECRET_1}`
  const TOKEN_2 = `oc-v3.202.${SECRET_2}`

  const tokenToUser = new Map<string, number>([
    [TOKEN_1, 1],
    [TOKEN_2, 2],
  ])

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'oc-sites-e2e-'))
    const edgeData = join(workDir, 'edge-data')
    const edge = createSitesEdgeServer({
      bind: '127.0.0.1',
      port: 0,
      dataRoot: edgeData,
      baseDomain: 'congjianai.com',
      secret: EDGE_SECRET,
      maxSiteBytes: 1024 * 1024,
    })
    const edgeAddr = await edge.listen()
    edgePort = edgeAddr.port
    closeEdge = edge.close

    edgeClient = createHttpSitesEdgeClient({
      baseUrl: `http://127.0.0.1:${edgePort}`,
      secret: EDGE_SECRET,
    })

    const repo = createInMemorySitesRepo()
    const service = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 2,
      maxSiteBytes: 1024 * 1024,
      edgeSecret: EDGE_SECRET,
      repo,
      edge: edgeClient,
    })

    // verifyContainerIdentity checks SHA-256 of secret bytes against secret_hash.
    const realIdentityRepo: ContainerIdentityRepo = {
      async findActiveByHostAndBoundIp(hostUuid: string, boundIp: string) {
        if (boundIp === '10.0.0.1') {
          return {
            id: 101,
            user_id: 1,
            host_uuid: hostUuid,
            bound_ip: boundIp,
            secret_hash: hashSecret(SECRET_1),
          }
        }
        if (boundIp === '10.0.0.2') {
          return {
            id: 202,
            user_id: 2,
            host_uuid: hostUuid,
            bound_ip: boundIp,
            secret_hash: hashSecret(SECRET_2),
          }
        }
        return null
      },
    }

    const internalHandler = makeSitesInternalHandler({
      identityRepo: realIdentityRepo,
      sites: service,
    })

    const masterServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const pathname = (req.url ?? '/').split('?')[0]!
        if (pathname.startsWith('/internal/v3/sites/')) {
          const authHdr = req.headers.authorization ?? ''
          const tok = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : ''
          const uid = tokenToUser.get(tok) ?? 0
          await internalHandler(req, res, {
            hostUuid: 'test-host',
            boundIp: uid === 2 ? '10.0.0.2' : '10.0.0.1',
          })
          return
        }
        if (pathname === '/api/sites' || pathname.startsWith('/api/sites/')) {
          const ctx = {
            requestId: 'req-test',
            clientIp: '127.0.0.1',
            authBoundIp: '127.0.0.1',
            userAgent: 'test',
            log: { info() {}, warn() {}, error() {}, child() { return this } },
          } as unknown as RequestContext
          await dispatchSitesBrowserRoute(req, res, ctx, {
            jwtSecret: JWT_SECRET,
            sites: service,
          })
          return
        }
        res.statusCode = 404
        res.end('not found')
      })().catch((err) => {
        if (res.headersSent) return
        const e = err as { status?: number; code?: string; message?: string }
        res.statusCode = e.status ?? 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { code: e.code ?? 'ERR', message: e.message ?? 'err' } }))
      })
    })

    await new Promise<void>((resolveListen) => {
      masterServer.listen(0, '127.0.0.1', () => {
        const addr = masterServer.address() as { port: number }
        masterPort = addr.port
        resolveListen()
      })
    })
    closeMaster = () =>
      new Promise<void>((resolveClose, rejectClose) =>
        masterServer.close((err) => (err ? rejectClose(err) : resolveClose())),
      )

    user1Jwt = (await signAccess({ sub: '1', role: 'user' }, JWT_SECRET)).token
    user2Jwt = (await signAccess({ sub: '2', role: 'user' }, JWT_SECRET)).token
  })

  after(async () => {
    await closeMaster?.()
    await closeEdge?.()
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  test('bundle security rejects .env* and path traversal', () => {
    assert.throws(
      () =>
        encodeSiteBundle([
          { path: 'index.html', content: Buffer.from('<h1>ok</h1>') },
          { path: '.env.local', content: Buffer.from('SECRET=1') },
        ]),
      (e: unknown) => e instanceof SitesError && e.code === 'INVALID_BUNDLE',
    )
    assert.throws(
      () =>
        encodeSiteBundle([
          { path: 'index.html', content: Buffer.from('<h1>ok</h1>') },
          { path: '../escape.txt', content: Buffer.from('x') },
        ]),
      (e: unknown) => e instanceof SitesError && e.code === 'INVALID_BUNDLE',
    )
    const valid = encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>hi</h1>') }])
    const decoded = decodeSiteBundle(valid.gzipped)
    assert.equal(decoded.fileCount, 1)
    assert.equal(decoded.files[0]?.path, 'index.html')
  })

  test('oc-site CLI publishes dist, skips .env, serves SPA routes + immutable assets + tls-ask', async () => {
    const distDir = join(workDir, 'my-dist')
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body>APP_V1</body></html>')
    writeFileSync(join(distDir, 'assets', 'app.deadbeef.js'), 'console.log(1);')
    writeFileSync(join(distDir, '.env'), 'SUPABASE_SERVICE_ROLE=super-secret')
    writeFileSync(join(distDir, 'dump.xyz'), 'binarydata')

    const pubRes = await runPythonCli(
      ['publish', distDir, '--slug', 'demo-app', '--title', '测试应用'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      },
    )
    assert.equal(pubRes.code, 0, pubRes.stderr)
    assert.match(pubRes.stderr, /skipped secret env file: \.env/)
    const parsed = JSON.parse(pubRes.stdout)
    assert.equal(parsed.site.slug, 'demo-app')
    assert.equal(parsed.site.url, 'https://demo-app.congjianai.com')
    assert.equal(parsed.site.fileCount, 3)

    // tls-ask: allowed for published public site, 404 for unknown / reserved
    const tlsOk = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=demo-app.congjianai.com`)
    assert.equal(tlsOk.status, 200)
    const tlsReserved = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=www.congjianai.com`)
    assert.equal(tlsReserved.status, 404)
    const tlsMissing = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=missing.congjianai.com`)
    assert.equal(tlsMissing.status, 404)

    // Serve root HTML (no-cache) & deep SPA route fallback & verify .env did not upload
    const home = await edgeHttpRequest({ port: edgePort, path: '/', host: 'demo-app.congjianai.com' })
    assert.equal(home.status, 200)
    assert.equal(home.headers['cache-control'], 'no-cache')
    assert.equal(home.headers['x-content-type-options'], 'nosniff')
    assert.match(home.text, /APP_V1/)

    const spaRoute = await edgeHttpRequest({
      port: edgePort,
      path: '/dashboard/users',
      host: 'demo-app.congjianai.com',
    })
    assert.equal(spaRoute.status, 200)
    assert.match(spaRoute.text, /APP_V1/)

    const asset = await edgeHttpRequest({
      port: edgePort,
      path: '/assets/app.deadbeef.js',
      host: 'demo-app.congjianai.com',
    })
    assert.equal(asset.status, 200)
    assert.match(String(asset.headers['cache-control'] ?? ''), /immutable/)

    const envReq = await edgeHttpRequest({
      port: edgePort,
      path: '/.env',
      host: 'demo-app.congjianai.com',
    })
    assert.equal(envReq.status, 404)

    const unknownExt = await edgeHttpRequest({
      port: edgePort,
      path: '/dump.xyz',
      host: 'demo-app.congjianai.com',
    })
    assert.equal(unknownExt.status, 200)
    assert.equal(unknownExt.headers['content-disposition'], 'attachment')
  })

  test('enforces slug reservation, cross-user SLUG_TAKEN (409), password gate, and browser API management', async () => {
    const singleHtml = join(workDir, 'single.html')
    writeFileSync(singleHtml, '<h1>SECRET_CONTENT</h1>')

    // User 2 cannot steal user 1's slug "demo-app"
    const stealRes = await runPythonCli(
      ['publish', singleHtml, '--slug', 'demo-app'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_2,
      },
    )
    assert.equal(stealRes.code, 1)
    assert.match(stealRes.stderr, /SLUG_TAKEN/)

    // Reserved slug rejected
    const reservedRes = await runPythonCli(
      ['publish', singleHtml, '--slug', 'api'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      },
    )
    assert.equal(reservedRes.code, 1)
    assert.match(reservedRes.stderr, /RESERVED_SLUG/)

    // User 1 publishes a second password-protected site
    const pwPub = await runPythonCli(
      ['publish', singleHtml, '--slug', 'vip-notes', '--visibility', 'password', '--password', 'pass1234'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      },
    )
    assert.equal(pwPub.code, 0, pwPub.stderr)

    // Unauthenticated request gets 401 unlock form
    const locked = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'vip-notes.congjianai.com',
    })
    assert.equal(locked.status, 401)
    assert.doesNotMatch(locked.text, /SECRET_CONTENT/)

    // Wrong password rejected
    const wrongUnlock = await edgeHttpRequest({
      port: edgePort,
      method: 'POST',
      path: '/__oc_site_unlock',
      host: 'vip-notes.congjianai.com',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong&redirect=%2F',
    })
    assert.equal(wrongUnlock.status, 401)

    // Right password sets cookie and unlocks
    const okUnlock = await edgeHttpRequest({
      port: edgePort,
      method: 'POST',
      path: '/__oc_site_unlock',
      host: 'vip-notes.congjianai.com',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=pass1234&redirect=%2F',
    })
    assert.equal(okUnlock.status, 303)
    const rawSetCookie = okUnlock.headers['set-cookie']
    const setCookie = Array.isArray(rawSetCookie) ? (rawSetCookie[0] ?? '') : (rawSetCookie ?? '')
    assert.match(setCookie, /oc_site_auth=/)
    const cookiePair = setCookie.split(';')[0]!

    const unlocked = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'vip-notes.congjianai.com',
      headers: { Cookie: cookiePair },
    })
    assert.equal(unlocked.status, 200)
    assert.match(unlocked.text, /SECRET_CONTENT/)

    // User 2 cannot access or mutate user 1's site via browser API
    const u2Patch = await fetch(`http://127.0.0.1:${masterPort}/api/sites/vip-notes`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user2Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    })
    assert.equal(u2Patch.status, 404)

    // User 1 rotates password via browser PATCH -> invalidates old cookie!
    const u1Patch = await fetch(`http://127.0.0.1:${masterPort}/api/sites/vip-notes`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'newpass999', spaMode: false }),
    })
    assert.equal(u1Patch.status, 200)

    const staleCookieCheck = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'vip-notes.congjianai.com',
      headers: { Cookie: cookiePair },
    })
    assert.equal(staleCookieCheck.status, 401)

    // User 1 quota (maxPerUser=2) blocks 3rd site
    const quotaFail = await runPythonCli(
      ['publish', singleHtml, '--slug', 'third-site'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      },
    )
    assert.equal(quotaFail.code, 1)
    assert.match(quotaFail.stderr, /QUOTA_EXCEEDED/)

    // Stale revision directly sent to edge is rejected (409 STALE_REVISION)
    await assert.rejects(
      () =>
        edgeClient.updateMeta({
          slug: 'vip-notes',
          revision: 1,
          meta: {
            title: 'stale',
            visibility: 'public',
            passwordSalt: null,
            passwordHash: null,
            spaMode: true,
          },
        }),
      (e: unknown) => e instanceof SitesError && e.code === 'STALE_REVISION',
    )

    // User 1 pauses vip-notes -> tls-ask returns 404 and serving returns 404
    const pauseRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/vip-notes`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'disabled' }),
    })
    assert.equal(pauseRes.status, 200)
    const tlsPaused = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=vip-notes.congjianai.com`)
    assert.equal(tlsPaused.status, 404)

    // Delete via browser API removes site & writes tombstone
    const delRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/vip-notes`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user1Jwt}` },
    })
    assert.equal(delRes.status, 200)

    const afterDel = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'vip-notes.congjianai.com',
    })
    assert.equal(afterDel.status, 404)

    // Re-creating the previously deleted slug succeeds cleanly with monotonic revision
    const repubRes = await runPythonCli(
      ['publish', singleHtml, '--slug', 'vip-notes', '--visibility', 'public'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      },
    )
    assert.equal(repubRes.code, 0, repubRes.stderr)
    const repubLive = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'vip-notes.congjianai.com',
    })
    assert.equal(repubLive.status, 200)
  })
})

describe('sites concurrency, lease fencing, cache isolation, and rate limit (B1-B6)', () => {
  let workDir = ''
  let edgePort = 0
  let closeEdge: () => Promise<void>
  let rawEdge: SitesEdgeClient

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'oc-sites-hardening-'))
    const edge = createSitesEdgeServer({
      bind: '127.0.0.1',
      port: 0,
      dataRoot: join(workDir, 'edge-data'),
      baseDomain: 'congjianai.com',
      secret: EDGE_SECRET,
      maxSiteBytes: 1024 * 1024,
    })
    const addr = await edge.listen()
    edgePort = addr.port
    closeEdge = edge.close
    rawEdge = createHttpSitesEdgeClient({
      baseUrl: `http://127.0.0.1:${edgePort}`,
      secret: EDGE_SECRET,
    })
  })

  after(async () => {
    await closeEdge?.()
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  function buildStaticBundle(extra: Array<{ path: string; content: Buffer }> = []): Buffer {
    return encodeSiteBundle([
      { path: 'index.html', content: Buffer.from('<h1>PROTECTED_APP</h1>', 'utf8') },
      ...extra,
    ]).gzipped
  }

  test('B1: concurrent updateSite(visibility=password) + updateSite(title) preserves password protection and rejects stale cross-instance race', async () => {
    const repo = createInMemorySitesRepo()
    let slowFirstPatch = true
    const delayedEdge: SitesEdgeClient = {
      ...rawEdge,
      async updateMeta(args) {
        if (slowFirstPatch) {
          slowFirstPatch = false
          await delay(40)
        }
        return rawEdge.updateMeta(args)
      },
    }
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: delayedEdge,
    })

    await svc.publishSite(1, {
      slug: 'race-b1',
      title: 'initial',
      visibility: 'public',
      gzippedBundle: buildStaticBundle(),
    })

    await Promise.all([
      svc.updateSite(1, 'race-b1', { visibility: 'password', password: 'pw-strong-1' }),
      svc.updateSite(1, 'race-b1', { title: 'renamed-after-pw' }),
    ])

    const finalSite = await svc.getSite(1, 'race-b1')
    assert.equal(finalSite.visibility, 'password')
    assert.equal(finalSite.title, 'renamed-after-pw')

    // Edge must now reject unauthenticated access
    const edgeCheck = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'race-b1.congjianai.com',
    })
    assert.equal(edgeCheck.status, 401)

    // Cross-instance race (no shared in-process mutex): second caller sees SLUG_BUSY and Edge rejects mismatched expectedBaseRevision
    let releaseFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let allowFinish!: () => void
    const gateFinish = new Promise<void>((resolve) => {
      allowFinish = resolve
    })

    const svcA = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: {
        ...rawEdge,
        async updateMeta(args) {
          releaseFirst()
          await gateFinish
          return rawEdge.updateMeta(args)
        },
      },
    })
    const svcB = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: rawEdge,
    })

    const pA = svcA.updateSite(1, 'race-b1', { title: 'from-A' })
    await firstEntered
    await assert.rejects(
      () => svcB.updateSite(1, 'race-b1', { visibility: 'public' }),
      (err: unknown) => err instanceof SitesError && err.code === 'SLUG_BUSY',
    )
    allowFinish()
    const resA = await pA
    assert.equal(resA.visibility, 'password')
    assert.equal(resA.title, 'from-A')

    // Direct Edge PATCH with stale expectedBaseRevision is rejected with STALE_REVISION (409)
    await assert.rejects(
      () =>
        rawEdge.updateMeta({
          slug: 'race-b1',
          revision: resA.edgeRevision + 50,
          meta: {
            title: 'stale-cas',
            visibility: 'public',
            passwordSalt: null,
            passwordHash: null,
            spaMode: true,
            expectedBaseRevision: resA.edgeRevision - 1,
          },
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'STALE_REVISION',
    )
  })

  test('B2: delayed deleteSite vs publishSite lease fencing prevents deleting a newer revision', async () => {
    const repo = createInMemorySitesRepo()
    let onEdgeDeleteCalled!: () => void
    const deleteEntered = new Promise<void>((resolve) => {
      onEdgeDeleteCalled = resolve
    })
    let finishEdgeDelete!: () => void
    const releaseEdgeDelete = new Promise<void>((resolve) => {
      finishEdgeDelete = resolve
    })

    const svcSlowDel = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: {
        ...rawEdge,
        async deleteSite(args) {
          onEdgeDeleteCalled()
          await releaseEdgeDelete
          return rawEdge.deleteSite(args)
        },
      },
    })
    const svcFast = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: rawEdge,
    })

    const initial = await svcFast.publishSite(1, {
      slug: 'race-b2',
      gzippedBundle: buildStaticBundle(),
    })

    const delPromise = svcSlowDel.deleteSite(1, 'race-b2')
    await deleteEntered

    // While delete holds lease, concurrent publish fails cleanly with SLUG_BUSY
    await assert.rejects(
      () =>
        svcFast.publishSite(1, {
          slug: 'race-b2',
          gzippedBundle: buildStaticBundle(),
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'SLUG_BUSY',
    )

    // Even if lease expires in DB and a newer publish commits before commitDelete executes,
    // both DB fencing (edge_revision < deleteRevision) and Edge STALE_REVISION block the old delete.
    const newer = await rawEdge.pushBundle({
      slug: 'race-b2',
      revision: initial.edgeRevision + 100,
      gzippedBundle: buildStaticBundle(),
      meta: {
        title: 'newer-rev',
        visibility: 'public',
        passwordSalt: null,
        passwordHash: null,
        spaMode: true,
        expectedBaseRevision: initial.edgeRevision,
      },
    })
    assert.ok(newer)

    finishEdgeDelete()
    await assert.rejects(
      () => delPromise,
      (err: unknown) => err instanceof SitesError && err.code === 'STALE_REVISION',
    )
    const status = await rawEdge.getSiteStatus({ slug: 'race-b2' })
    assert.equal(status.exists, true)
    assert.equal(status.revision, initial.edgeRevision + 100)

    // Direct repo commitDelete with old deleteRevision cannot delete a row whose edgeRevision is newer
    repo.expireLease('race-b2')
    const resNew = await svcFast.publishSite(1, {
      slug: 'race-b2-fence',
      gzippedBundle: buildStaticBundle(),
    })
    await repo.commitDelete(resNew.id, 1, 'non-matching-lease', resNew.edgeRevision - 1)
    const stillThere = await svcFast.getSite(1, 'race-b2-fence')
    assert.equal(stillThere.slug, 'race-b2-fence')
  })

  test('B3: concurrent first-time publishes lock slug and ambiguous EDGE_UNAVAILABLE reconciles via getSiteStatus', async () => {
    const repo = createInMemorySitesRepo()
    let dropResponseAfterCommit = true
    let dropPatchAfterCommit = false
    let failBeforeEdge = false
    let failStatusOnce = false

    const flakeyEdge: SitesEdgeClient = {
      ...rawEdge,
      async pushBundle(args) {
        if (failBeforeEdge) {
          throw new SitesError('EDGE_UNAVAILABLE', 'connect ECONNREFUSED', 502, true)
        }
        const res = await rawEdge.pushBundle(args)
        if (dropResponseAfterCommit) {
          dropResponseAfterCommit = false
          throw new SitesError('EDGE_UNAVAILABLE', 'socket hang up after write', 502, true)
        }
        return res
      },
      async updateMeta(args) {
        await rawEdge.updateMeta(args)
        if (dropPatchAfterCommit) {
          dropPatchAfterCommit = false
          throw new SitesError('EDGE_UNAVAILABLE', 'patch ack lost', 502, true)
        }
      },
      async getSiteStatus(args) {
        if (failStatusOnce) {
          failStatusOnce = false
          throw new SitesError('EDGE_UNAVAILABLE', 'status probe timeout', 502, true)
        }
        return rawEdge.getSiteStatus(args)
      },
    }

    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: flakeyEdge,
    })

    // Ambiguous timeout AFTER Edge applied revision -> getSiteStatus sees committed rev and reconciles DB
    const recovered = await svc.publishSite(1, {
      slug: 'race-b3-recover',
      gzippedBundle: buildStaticBundle(),
    })
    assert.equal(recovered.slug, 'race-b3-recover')
    const listed = await svc.listSummary(1)
    assert.equal(listed.sites.some((s) => s.slug === 'race-b3-recover'), true)

    // Double fault: pushBundle commits on Edge, throws EDGE_UNAVAILABLE, AND immediate getSiteStatus probe throws once.
    // Placeholder stays retained until next listSummary/retry reconciles it instead of leaving an orphan or wedging at CAS.
    dropResponseAfterCommit = true
    failStatusOnce = true
    await assert.rejects(
      () =>
        svc.publishSite(1, {
          slug: 'race-b3-double-fault',
          title: 'double-fault-title',
          gzippedBundle: buildStaticBundle(),
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE',
    )
    const afterRecoverList = await svc.listSummary(1)
    assert.equal(afterRecoverList.sites.some((s) => s.slug === 'race-b3-double-fault'), true)
    const retriedExplicit = await svc.publishSite(1, {
      slug: 'race-b3-double-fault',
      title: 'double-fault-updated',
      gzippedBundle: buildStaticBundle(),
    })
    assert.equal(retriedExplicit.title, 'double-fault-updated')

    // Existing-site overwrite publishSite double fault -> recovers cleanly and allows subsequent password PATCH
    dropResponseAfterCommit = true
    failStatusOnce = true
    await assert.rejects(
      () =>
        svc.publishSite(1, {
          slug: 'race-b3-double-fault',
          title: 'existing-overwrite-fault',
          gzippedBundle: buildStaticBundle(),
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE',
    )
    const afterExistingPw = await svc.updateSite(1, 'race-b3-double-fault', {
      visibility: 'password',
      password: 'after-overwrite-99',
    })
    assert.equal(afterExistingPw.title, 'existing-overwrite-fault')
    assert.equal(afterExistingPw.visibility, 'password')

    // Existing-site updateSite PATCH double fault -> recovers cleanly and allows subsequent overwrite publishSite
    dropPatchAfterCommit = true
    failStatusOnce = true
    await assert.rejects(
      () =>
        svc.updateSite(1, 'race-b3-double-fault', {
          title: 'patched-under-fault',
          visibility: 'disabled',
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE',
    )
    const afterPatchRecoverPub = await svc.publishSite(1, {
      slug: 'race-b3-double-fault',
      visibility: 'public',
      gzippedBundle: buildStaticBundle(),
    })
    assert.equal(afterPatchRecoverPub.title, 'patched-under-fault')
    assert.equal(afterPatchRecoverPub.visibility, 'public')
    const edgeStatusFinal = await rawEdge.getSiteStatus({ slug: 'race-b3-double-fault' })
    assert.equal(edgeStatusFinal.revision, afterPatchRecoverPub.edgeRevision)

    // Failure BEFORE Edge wrote anything -> getSiteStatus sees !exists -> aborts placeholder so retry succeeds cleanly
    failBeforeEdge = true
    await assert.rejects(
      () =>
        svc.publishSite(1, {
          slug: 'race-b3-abort',
          gzippedBundle: buildStaticBundle(),
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE',
    )
    failBeforeEdge = false
    const retried = await svc.publishSite(1, {
      slug: 'race-b3-abort',
      gzippedBundle: buildStaticBundle(),
    })
    assert.equal(retried.slug, 'race-b3-abort')

    // Concurrent first-time publish from two separate instances for same slug -> one wins, other gets SLUG_BUSY
    let slowStarted!: () => void
    const waited = new Promise<void>((resolve) => {
      slowStarted = resolve
    })
    let allowSlow!: () => void
    const releaseSlow = new Promise<void>((resolve) => {
      allowSlow = resolve
    })
    const svcSlow = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: {
        ...rawEdge,
        async pushBundle(args) {
          slowStarted()
          await releaseSlow
          return rawEdge.pushBundle(args)
        },
      },
    })
    const svcOther = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: rawEdge,
    })

    const pWin = svcSlow.publishSite(1, {
      slug: 'race-b3-same-slug',
      gzippedBundle: buildStaticBundle(),
    })
    await waited
    await assert.rejects(
      () =>
        svcOther.publishSite(1, {
          slug: 'race-b3-same-slug',
          gzippedBundle: buildStaticBundle(),
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'SLUG_BUSY',
    )
    allowSlow()
    const win = await pWin
    assert.equal(win.slug, 'race-b3-same-slug')
  })

  test('B4: password-protected assets disable shared caching and conditional 304 revalidation', async () => {
    const repo = createInMemorySitesRepo()
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: rawEdge,
    })

    const bundle = buildStaticBundle([
      { path: 'assets/secret.deadbeef.js', content: Buffer.from('console.log("top-secret");', 'utf8') },
      { path: 'assets/private.json', content: Buffer.from('{"secret":true}', 'utf8') },
    ])

    await svc.publishSite(1, {
      slug: 'cache-b4-pw',
      visibility: 'password',
      password: 'vault-pass-1',
      gzippedBundle: bundle,
    })
    await svc.publishSite(1, {
      slug: 'cache-b4-pub',
      visibility: 'public',
      gzippedBundle: bundle,
    })

    // Protected unauthenticated request -> 401 + private, no-store + Vary: Cookie
    const unauthAsset = await edgeHttpRequest({
      port: edgePort,
      path: '/assets/secret.deadbeef.js',
      host: 'cache-b4-pw.congjianai.com',
    })
    assert.equal(unauthAsset.status, 401)
    assert.equal(unauthAsset.headers['cache-control'], 'private, no-store')
    assert.equal(unauthAsset.headers.vary, 'Cookie')

    // Unlock protected site
    const unlock = await edgeHttpRequest({
      port: edgePort,
      method: 'POST',
      path: '/__oc_site_unlock',
      host: 'cache-b4-pw.congjianai.com',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=vault-pass-1&redirect=%2F',
    })
    assert.equal(unlock.status, 303)
    const setCookie = Array.isArray(unlock.headers['set-cookie'])
      ? (unlock.headers['set-cookie'][0] ?? '')
      : (unlock.headers['set-cookie'] ?? '')
    const cookiePair = setCookie.split(';')[0]!

    // Authenticated hashed JS asset must NEVER be public immutable
    const authJs = await edgeHttpRequest({
      port: edgePort,
      path: '/assets/secret.deadbeef.js',
      host: 'cache-b4-pw.congjianai.com',
      headers: { Cookie: cookiePair },
    })
    assert.equal(authJs.status, 200)
    assert.equal(authJs.headers['cache-control'], 'private, no-store')
    assert.equal(authJs.headers.pragma, 'no-cache')
    assert.equal(authJs.headers.vary, 'Cookie')
    assert.equal(authJs.headers.etag, undefined)

    // Authenticated JSON + If-None-Match must NOT return 304
    const authJson = await edgeHttpRequest({
      port: edgePort,
      path: '/assets/private.json',
      host: 'cache-b4-pw.congjianai.com',
      headers: { Cookie: cookiePair, 'If-None-Match': '"anything"' },
    })
    assert.equal(authJson.status, 200)
    assert.equal(authJson.headers['cache-control'], 'private, no-store')
    assert.equal(authJson.headers.vary, 'Cookie')

    // Public site hashed JS keeps long immutable cache + ETag + 304 support
    const pubJs = await edgeHttpRequest({
      port: edgePort,
      path: '/assets/secret.deadbeef.js',
      host: 'cache-b4-pub.congjianai.com',
    })
    assert.equal(pubJs.status, 200)
    assert.equal(pubJs.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.ok(typeof pubJs.headers.etag === 'string' && pubJs.headers.etag.length > 0)
  })

  test('B5: concurrent publishes of distinct new slugs count in-flight leases toward maxPerUser quota', async () => {
    const repo = createInMemorySitesRepo()
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 2,
      repo,
      edge: {
        ...rawEdge,
        async pushBundle(args) {
          await delay(30)
          return rawEdge.pushBundle(args)
        },
      },
    })

    // Consume 1 of 2 quota slots
    await svc.publishSite(1, { slug: 'quota-existing', gzippedBundle: buildStaticBundle() })

    // Fire 2 distinct new slugs concurrently while maxPerUser is 2 -> only 1 can succeed
    const results = await Promise.allSettled([
      svc.publishSite(1, { slug: 'quota-new-a', gzippedBundle: buildStaticBundle() }),
      svc.publishSite(1, { slug: 'quota-new-b', gzippedBundle: buildStaticBundle() }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0]!.reason instanceof SitesError)
    assert.equal(rejected[0]!.reason.code, 'QUOTA_EXCEEDED')

    const summary = await svc.listSummary(1)
    assert.equal(summary.sites.length, 2)
  })

  test('B6: 15 simultaneous unlock attempts enforce atomic rate limit at 10 attempts (429)', async () => {
    const repo = createInMemorySitesRepo()
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: rawEdge,
    })

    await svc.publishSite(1, {
      slug: 'rate-b6-pw',
      visibility: 'password',
      password: 'correct-horse-battery',
      gzippedBundle: buildStaticBundle(),
    })

    const responses = await Promise.all(
      Array.from({ length: 15 }, () =>
        edgeHttpRequest({
          port: edgePort,
          method: 'POST',
          path: '/__oc_site_unlock',
          host: 'rate-b6-pw.congjianai.com',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Real-IP': '203.0.113.77',
          },
          body: 'password=wrong-guess&redirect=%2F',
        }),
      ),
    )

    const counts = responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1
      return acc
    }, {})

    assert.equal(counts[401], 10)
    assert.equal(counts[429], 5)
    for (const r of responses.filter((x) => x.status === 429)) {
      assert.equal(r.headers['cache-control'], 'private, no-store')
      assert.equal(r.headers.vary, 'Cookie')
    }
  })
})

describe('fullstack sites: /api/* worker, SQLite, encrypted env, analytics, rename, custom domain', () => {
  let workDir = ''
  let edgePort = 0
  let masterPort = 0
  let closeEdge: () => Promise<void>
  let closeMaster: () => Promise<void>
  let user1Jwt = ''
  let user2Jwt = ''

  const SECRET_1 = '3333333333333333333333333333333333333333333333333333333333333333'
  const TOKEN_1 = `oc-v3.301.${SECRET_1}`

  const txtRecords = new Map<string, string[][]>()
  let edgeDataRoot = ''
  let serviceRef: SitesService
  let edgeClientRef: SitesEdgeClient

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'oc-sites-fullstack-'))
    edgeDataRoot = join(workDir, 'edge-data')
    const edge = createSitesEdgeServer({
      bind: '127.0.0.1',
      port: 0,
      dataRoot: edgeDataRoot,
      baseDomain: 'congjianai.com',
      secret: EDGE_SECRET,
      maxSiteBytes: 2 * 1024 * 1024,
    })
    const edgeAddr = await edge.listen()
    edgePort = edgeAddr.port
    closeEdge = edge.close

    const edgeClient = createHttpSitesEdgeClient({
      baseUrl: `http://127.0.0.1:${edgePort}`,
      secret: EDGE_SECRET,
    })
    edgeClientRef = edgeClient
    const repo = createInMemorySitesRepo()
    const service = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      maxSiteBytes: 2 * 1024 * 1024,
      edgeSecret: EDGE_SECRET,
      repo,
      edge: edgeClient,
      resolveTxt: async (host) => txtRecords.get(host) ?? [],
    })
    serviceRef = service

    const identityRepo: ContainerIdentityRepo = {
      async findActiveByHostAndBoundIp(hostUuid: string, boundIp: string) {
        if (boundIp === '10.0.0.1') {
          return {
            id: 301,
            user_id: 1,
            host_uuid: hostUuid,
            bound_ip: boundIp,
            secret_hash: hashSecret(SECRET_1),
          }
        }
        return null
      },
    }
    const internalHandler = makeSitesInternalHandler({ identityRepo, sites: service })

    const masterServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const pathname = (req.url ?? '/').split('?')[0]!
        if (pathname.startsWith('/internal/v3/sites/')) {
          await internalHandler(req, res, { hostUuid: 'test-host', boundIp: '10.0.0.1' })
          return
        }
        if (pathname === '/api/sites' || pathname.startsWith('/api/sites/')) {
          const ctx = {
            requestId: 'req-fs-test',
            clientIp: '127.0.0.1',
            authBoundIp: '127.0.0.1',
            userAgent: 'test',
            log: { info() {}, warn() {}, error() {}, child() { return this } },
          } as unknown as RequestContext
          await dispatchSitesBrowserRoute(req, res, ctx, {
            jwtSecret: JWT_SECRET,
            sites: service,
          })
          return
        }
        res.statusCode = 404
        res.end('not found')
      })().catch((err) => {
        if (res.headersSent) return
        const e = err as { status?: number; code?: string; message?: string }
        res.statusCode = e.status ?? 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { code: e.code ?? 'ERR', message: e.message ?? 'err' } }))
      })
    })
    await new Promise<void>((done) => {
      masterServer.listen(0, '127.0.0.1', () => {
        masterPort = (masterServer.address() as { port: number }).port
        done()
      })
    })
    closeMaster = () =>
      new Promise<void>((done, fail) => masterServer.close((e) => (e ? fail(e) : done())))

    user1Jwt = (await signAccess({ sub: '1', role: 'user' }, JWT_SECRET)).token
    user2Jwt = (await signAccess({ sub: '2', role: 'user' }, JWT_SECRET)).token
  })

  after(async () => {
    await closeMaster?.()
    await closeEdge?.()
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  test('publishes /api/* worker + auto-packs server/api.mjs, executes SQLite & encrypted env, blocks SSRF, tracks analytics, renames slug, binds custom domain', async () => {
    const appDir = join(workDir, 'fullstack-dist')
    mkdirSync(join(appDir, 'server'), { recursive: true })
    writeFileSync(join(appDir, 'index.html'), '<!doctype html><html><body><h1>FS_APP</h1></body></html>')
    writeFileSync(
      join(appDir, 'server', 'api.mjs'),
      `export default async function handler(req, ctx) {
  ctx.db.run('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, mode TEXT NOT NULL)')
  if (req.pathname === '/api/notes' && req.method === 'POST') {
    const data = req.json() || {}
    ctx.db.run('INSERT INTO notes (body, mode) VALUES (?, ?)', [String(data.body || ''), String(ctx.env.APP_MODE || '')])
    const cnt = ctx.db.get('SELECT COUNT(*) AS cnt FROM notes')
    return {
      status: 201,
      body: {
        ok: true,
        count: cnt.cnt,
        hasSecret: Boolean(ctx.env.DEEPSEEK_API_KEY),
        secretLen: (ctx.env.DEEPSEEK_API_KEY || '').length,
        slug: ctx.site.slug,
      },
    }
  }
  if (req.pathname === '/api/notes' && req.method === 'GET') {
    return {
      status: 200,
      body: {
        rows: ctx.db.all('SELECT id, body, mode FROM notes ORDER BY id ASC'),
        secretOk: ctx.env.DEEPSEEK_API_KEY === 'sk-top-secret-xyz',
        slug: ctx.site.slug,
      },
    }
  }
  if (req.pathname === '/api/ssrf') {
    try {
      await fetch('http://127.0.0.1:9/blocked')
      return { status: 200, body: { leaked: true } }
    } catch (err) {
      return { status: 403, body: { blocked: String(err.message || err) } }
    }
  }
  return { status: 404, body: { error: 'not found' } }
}
`,
    )

    const cliEnv = {
      OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
      OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:dm:fullstack-origin',
    }
    const pub = await runPythonCli(['publish', appDir, '--slug', 'fs-blog', '--title', 'Fullstack Blog'], cliEnv)
    assert.equal(pub.code, 0, pub.stderr)
    const pubJson = JSON.parse(pub.stdout)
    assert.equal(pubJson.site.hasServerApi, true)
    assert.equal(pubJson.site.originSessionId, 'agent:main:webchat:dm:fullstack-origin')

    // Raw server files must NEVER be served publicly
    const rawServerFetch = await edgeHttpRequest({
      port: edgePort,
      path: '/__oc_server/api.mjs',
      host: 'fs-blog.congjianai.com',
    })
    assert.equal(rawServerFetch.status, 404)
    const autoPackedSourceFetch = await edgeHttpRequest({
      port: edgePort,
      path: '/server/api.mjs',
      host: 'fs-blog.congjianai.com',
    })
    assert.doesNotMatch(autoPackedSourceFetch.text, /DEEPSEEK_API_KEY/)

    // Set secret & non-secret env vars (CLI + browser API)
    const setSecret = await runPythonCli(
      ['env-set', 'fs-blog', 'DEEPSEEK_API_KEY', 'sk-top-secret-xyz', '--secret'],
      cliEnv,
    )
    assert.equal(setSecret.code, 0, setSecret.stderr)
    const setPlain = await fetch(`http://127.0.0.1:${masterPort}/api/sites/fs-blog/env`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'APP_MODE', value: 'production', isSecret: false }),
    })
    assert.equal(setPlain.status, 200)

    // GET /api/sites/:slug masks secret values
    const detailRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/fs-blog`, {
      headers: { Authorization: `Bearer ${user1Jwt}` },
    })
    assert.equal(detailRes.status, 200)
    const detail = (await detailRes.json()) as {
      site: { slug: string; hasServerApi: boolean }
      envVars: Array<{ key: string; value: string | null; isSecret: boolean }>
    }
    assert.equal(detail.envVars.find((v) => v.key === 'DEEPSEEK_API_KEY')?.value, null)
    assert.equal(detail.envVars.find((v) => v.key === 'DEEPSEEK_API_KEY')?.isSecret, true)
    assert.equal(detail.envVars.find((v) => v.key === 'APP_MODE')?.value, 'production')

    // Execute /api/notes POST & GET -> proves decrypted ctx.env + persistent SQLite DB
    const apiPost = await edgeHttpRequest({
      port: edgePort,
      method: 'POST',
      path: '/api/notes',
      host: 'fs-blog.congjianai.com',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.10' },
      body: JSON.stringify({ body: 'hello-sqlite' }),
    })
    assert.equal(apiPost.status, 201, apiPost.text)
    const apiPostJson = JSON.parse(apiPost.text)
    assert.equal(apiPostJson.count, 1)
    assert.equal(apiPostJson.hasSecret, true)
    assert.equal(apiPostJson.secretLen, 'sk-top-secret-xyz'.length)

    // SSRF inside worker fetch() must be blocked
    const ssrfRes = await edgeHttpRequest({
      port: edgePort,
      path: '/api/ssrf',
      host: 'fs-blog.congjianai.com',
    })
    assert.equal(ssrfRes.status, 403, ssrfRes.text)
    assert.match(ssrfRes.text, /SSRF_BLOCKED/)

    // Visit HTML page from two visitors to accumulate analytics
    const visit1 = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'fs-blog.congjianai.com',
      headers: { 'X-Real-IP': '198.51.100.11', 'User-Agent': 'BrowserA' },
    })
    assert.equal(visit1.status, 200)
    const visit2 = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'fs-blog.congjianai.com',
      headers: { 'X-Real-IP': '198.51.100.12', 'User-Agent': 'BrowserB' },
    })
    assert.equal(visit2.status, 200)

    // SQLite DB inspector endpoint & CLI
    const dbRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/fs-blog/db?table=notes`, {
      headers: { Authorization: `Bearer ${user1Jwt}` },
    })
    assert.equal(dbRes.status, 200)
    const dbJson = (await dbRes.json()) as {
      db: {
        connected: boolean
        tables: Array<{ name: string; rowCount: number }>
        rows: Array<{ body: string; mode: string }>
      }
    }
    assert.equal(dbJson.db.connected, true)
    assert.deepEqual(dbJson.db.tables, [{ name: 'notes', rowCount: 1 }])
    assert.equal(dbJson.db.rows[0]?.body, 'hello-sqlite')
    assert.equal(dbJson.db.rows[0]?.mode, 'production')

    const cliSql = await runPythonCli(
      ['db-sql', 'fs-blog', 'SELECT body FROM notes WHERE id = ?', '--param', '1'],
      cliEnv,
    )
    assert.equal(cliSql.code, 0, cliSql.stderr)
    assert.match(cliSql.stdout, /hello-sqlite/)

    // Traffic analytics endpoint & CLI
    const anaRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/fs-blog/analytics?days=7`, {
      headers: { Authorization: `Bearer ${user1Jwt}` },
    })
    assert.equal(anaRes.status, 200)
    const anaJson = (await anaRes.json()) as {
      analytics: { totals: { uniqueVisitors: number; requests: number; pageViews: number }; series: unknown[] }
    }
    assert.ok(anaJson.analytics.totals.pageViews >= 2)
    assert.ok(anaJson.analytics.totals.requests >= 4)
    assert.ok(anaJson.analytics.totals.uniqueVisitors >= 3)
    assert.equal(anaJson.analytics.series.length, 7)

    // Cross-user browser access to analytics/db is forbidden (404)
    const u2Ana = await fetch(`http://127.0.0.1:${masterPort}/api/sites/fs-blog/analytics`, {
      headers: { Authorization: `Bearer ${user2Jwt}` },
    })
    assert.equal(u2Ana.status, 404)

    // Bind custom domain -> denied BEFORE TXT verification; allowed AFTER verify-domain; revoked on clear
    const bindRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/fs-blog`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customDomain: 'app.mybrand.com' }),
    })
    const bindText = await bindRes.text()
    assert.equal(bindRes.status, 200, bindText)
    const pendingBind = JSON.parse(bindText) as {
      site: {
        customDomainStatus: string
        customDomainTxtName: string
        customDomainTxtValue: string
      }
    }
    assert.equal(pendingBind.site.customDomainStatus, 'pending')
    const preVerifyTls = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=app.mybrand.com`)
    assert.equal(preVerifyTls.status, 404)
    const preVerifyHtml = await edgeHttpRequest({ port: edgePort, path: '/', host: 'app.mybrand.com' })
    assert.equal(preVerifyHtml.status, 404)

    txtRecords.set(pendingBind.site.customDomainTxtName, [[pendingBind.site.customDomainTxtValue]])
    const verifyRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/fs-blog/verify-domain`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user1Jwt}` },
    })
    const verifyText = await verifyRes.text()
    assert.equal(verifyRes.status, 200, verifyText)
    const verifyJson = JSON.parse(verifyText) as { site: { customDomainStatus: string } }
    assert.equal(verifyJson.site.customDomainStatus, 'verified')

    const customTls = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=app.mybrand.com`)
    assert.equal(customTls.status, 200)
    const customHtml = await edgeHttpRequest({ port: edgePort, path: '/', host: 'app.mybrand.com' })
    assert.equal(customHtml.status, 200)
    assert.match(customHtml.text, /FS_APP/)

    // Second site cannot steal bound custom domain (409 DOMAIN_TAKEN)
    await runPythonCli(['publish', join(appDir, 'index.html'), '--slug', 'other-site'], cliEnv)
    const stealDom = await fetch(`http://127.0.0.1:${masterPort}/api/sites/other-site`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customDomain: 'app.mybrand.com' }),
    })
    assert.equal(stealDom.status, 409)

    // Rename slug -> old slug returns 404, new slug keeps SQLite + re-sealed ctx.env + custom domain!
    const renRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/fs-blog/rename`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ newSlug: 'fs-blog-v2' }),
    })
    const renText = await renRes.text()
    assert.equal(renRes.status, 200, renText)
    const renJson = JSON.parse(renText) as { site: { slug: string; customDomain: string | null } }
    assert.equal(renJson.site.slug, 'fs-blog-v2')
    assert.equal(renJson.site.customDomain, 'app.mybrand.com')

    const oldLive = await edgeHttpRequest({ port: edgePort, path: '/', host: 'fs-blog.congjianai.com' })
    assert.equal(oldLive.status, 404)

    const newApi = await edgeHttpRequest({
      port: edgePort,
      path: '/api/notes',
      host: 'fs-blog-v2.congjianai.com',
    })
    assert.equal(newApi.status, 200, newApi.text)
    const newApiJson = JSON.parse(newApi.text)
    assert.equal(newApiJson.secretOk, true)
    assert.equal(newApiJson.slug, 'fs-blog-v2')
    assert.equal(newApiJson.rows.length, 1)
    assert.equal(newApiJson.rows[0].body, 'hello-sqlite')

    // Password protection gates /api/* as well (401 JSON)
    const lockRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/fs-blog-v2`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'password', password: 'pw-9876' }),
    })
    assert.equal(lockRes.status, 200)
    const lockedApi = await edgeHttpRequest({
      port: edgePort,
      path: '/api/notes',
      host: 'fs-blog-v2.congjianai.com',
    })
    assert.equal(lockedApi.status, 401)
    assert.match(lockedApi.text, /UNAUTHORIZED/)

    // Unbinding custom domain immediately revokes routing & tls-ask
    const clearDomRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/fs-blog-v2`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customDomain: null }),
    })
    assert.equal(clearDomRes.status, 200)
    const revokedTls = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=app.mybrand.com`)
    assert.equal(revokedTls.status, 404)
  })

  test('T2 security audit hardening: bwrap OS sandbox, redirect auth strip/block, --api manifest exclusion, v1 fullstack reject, 16KiB secret & DB safety', async () => {
    const cliEnv = {
      OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
      OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:dm:audit-hardening',
    }

    // Redirect target server to test cross-origin redirect block with credentials
    const redirServer = createServer((req, res) => {
      if (req.url === '/redir') {
        res.statusCode = 302
        res.setHeader('Location', `http://localhost:${(redirServer.address() as { port: number }).port}/target`)
        res.end()
        return
      }
      res.statusCode = 200
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null }))
    })
    await new Promise<void>((done) => redirServer.listen(0, '127.0.0.1', () => done()))
    const redirPort = (redirServer.address() as { port: number }).port

    try {
      const hardDir = join(workDir, 'hardened-dist')
      mkdirSync(hardDir, { recursive: true })
      writeFileSync(join(hardDir, 'index.html'), '<h1>HARDENED</h1>')
      // Explicit --api file placed INSIDE the publish directory (P1 #5)!
      writeFileSync(
        join(hardDir, 'handler.mjs'),
        `import fs from 'node:fs'
import net from 'node:net'
export default async function handler(req, ctx) {
  if (req.pathname === '/api/escape') {
    let etcBlocked = false
    try { fs.readFileSync('/etc/passwd', 'utf8'); } catch { etcBlocked = true }
    const netBlocked = await new Promise((resolve) => {
      const s = net.connect(80, '1.1.1.1');
      s.on('error', (e) => resolve(e.code || 'ERR'));
      s.on('connect', () => { s.destroy(); resolve('OPEN'); });
    });
    return { status: 200, body: { etcBlocked, netBlocked, bigSecretLen: (ctx.env.BIG_KEY || '').length } }
  }
  if (req.pathname === '/api/redir-auth') {
    try {
      await fetch('http://127.0.0.1:${redirPort}/redir', { headers: { Authorization: 'Bearer secret-tok' } })
      return { status: 200, body: { leaked: true } }
    } catch (e) {
      return { status: 403, body: { blocked: String(e.message || e) } }
    }
  }
  return { status: 200, body: { ok: true } }
}
`,
      )

      const pub = await runPythonCli(
        ['publish', hardDir, '--api', join(hardDir, 'handler.mjs'), '--slug', 'hardened-app'],
        cliEnv,
      )
      assert.equal(pub.code, 0, pub.stderr)

      // P1 #5: explicit handler.mjs inside dist MUST NOT be downloadable as static file
      const staticLeak = await edgeHttpRequest({
        port: edgePort,
        path: '/handler.mjs',
        host: 'hardened-app.congjianai.com',
      })
      assert.notEqual(staticLeak.status, 200)
      assert.doesNotMatch(staticLeak.text, /readFileSync/)

      // P1 #6: OCSB2 / server API bundle MUST be rejected on /__oc_sites_edge/v1/
      const v2Bundle = encodeSiteBundle([
        { path: 'index.html', content: Buffer.from('<h1>V2</h1>') },
        { path: '__oc_server/api.mjs', content: Buffer.from('export default () => ({ ok: true })') },
      ]).gzipped
      await assert.rejects(
        () =>
          edgeClientRef.pushBundle({
            slug: 'hardened-app',
            revision: 999999,
            gzippedBundle: v2Bundle,
            hasServerApi: false, // force v1 endpoint
            meta: {
              title: 'bad',
              visibility: 'public',
              passwordSalt: null,
              passwordHash: null,
              spaMode: true,
            },
          }),
        (err: unknown) => err instanceof SitesError && err.status === 400,
      )

      // P1 #11: Valid 16 KiB secret env var works cleanly via body transport (no 16 KiB header overflow)
      const bigVal = 'k'.repeat(16 * 1024)
      const setBig = await fetch(`http://127.0.0.1:${masterPort}/api/sites/hardened-app/env`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'BIG_KEY', value: bigVal, isSecret: true }),
      })
      assert.equal(setBig.status, 200, await setBig.text())

      // P0 #1: bwrap OS sandbox blocks /etc/passwd and direct sockets while delivering 16 KiB secret
      const escRes = await edgeHttpRequest({
        port: edgePort,
        path: '/api/escape',
        host: 'hardened-app.congjianai.com',
      })
      assert.equal(escRes.status, 200, escRes.text)
      const escJson = JSON.parse(escRes.text) as {
        etcBlocked: boolean
        netBlocked: string
        bigSecretLen: number
      }
      assert.equal(escJson.etcBlocked, true)
      assert.equal(escJson.netBlocked, 'ENETUNREACH')
      assert.equal(escJson.bigSecretLen, 16 * 1024)

      // P1 #4: cross-origin redirect with Authorization header blocked by trusted parent proxy
      const redirEntryDir = join(workDir, 'redir-site-srv')
      mkdirSync(redirEntryDir, { recursive: true })
      const redirEntryPath = join(redirEntryDir, 'api.mjs')
      writeFileSync(
        redirEntryPath,
        `export default async function handler() {
  try {
    await fetch('http://127.0.0.1:${redirPort}/redir', { headers: { Authorization: 'Bearer secret-tok' } });
    return { status: 200, body: { leaked: true } };
  } catch (e) {
    return { status: 403, body: { blocked: String(e.message || e) } };
  }
}
`,
      )
      const redirRes = await runSiteApiWorker({
        slug: 'redir-unit',
        siteDir: join(workDir, 'redir-site'),
        entryFilePath: redirEntryPath,
        revision: 1,
        method: 'GET',
        url: '/api/redir-auth',
        pathname: '/api/redir-auth',
        query: {},
        headers: {},
        body: Buffer.alloc(0),
        env: {},
        allowPrivateFetchForTest: true,
      })
      assert.equal(redirRes.status, 403, redirRes.body.toString('utf8'))
      assert.match(redirRes.body.toString('utf8'), /CROSS_ORIGIN_REDIRECT_BLOCKED/)

      // P1 #14 & P1 #15: VACUUM main INTO rejected; large cells > 32 KiB produce valid truncated JSON
      await assert.rejects(
        () =>
          serviceRef.executeDbSql(1, 'hardened-app', {
            sql: "VACUUM main INTO '/tmp/evil-copy.db'",
          }),
        (err: unknown) => err instanceof SitesError && err.status === 400,
      )
      await serviceRef.executeDbSql(1, 'hardened-app', {
        sql: 'CREATE TABLE big_rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)',
      })
      for (let i = 0; i < 30; i += 1) {
        await serviceRef.executeDbSql(1, 'hardened-app', {
          sql: 'INSERT INTO big_rows (body) VALUES (?)',
          params: [`row-${i}-${'x'.repeat(3000)}`],
        })
      }
      const bigInspect = await serviceRef.inspectDb(1, 'hardened-app', { table: 'big_rows', limit: 100 })
      assert.equal(bigInspect.tables[0]?.name, 'big_rows')
      assert.equal(bigInspect.rows.length, 30)

      // P1 #12: Stale/mismatched siteId on edge DB/analytics returns 409 STALE_REVISION
      await assert.rejects(
        () =>
          edgeClientRef.inspectDb({
            slug: 'hardened-app',
            siteId: '00000000-0000-4000-8000-999999999999',
            expectedRevision: 1,
          }),
        (err: unknown) => err instanceof SitesError && err.code === 'STALE_REVISION',
      )

      // P1 #9: Corrupt env.enc aborts rename BEFORE moving site directory!
      writeFileSync(join(edgeDataRoot, 'sites', 'hardened-app', 'env.enc'), 'corrupted-ciphertext')
      await assert.rejects(
        () => serviceRef.renameSite(1, 'hardened-app', 'hardened-app-v2'),
        (err: unknown) => err instanceof SitesError && err.status >= 400,
      )
      const stillAlive = await edgeHttpRequest({
        port: edgePort,
        path: '/',
        host: 'hardened-app.congjianai.com',
      })
      assert.equal(stillAlive.status, 200)
    } finally {
      await new Promise<void>((done) => redirServer.close(() => done()))
    }
  })

  test('Round-2 hardening: 4MiB IPC frame, custom-header cross-origin redirect block, env-unset reconciliation, verifyCustomDomain TOCTOU guard, and publish needsEnvSync fail-loud', async () => {
    // 1. P1 #11/#12: Full 4 MiB response (> 5.5 MiB base64 IPC frame + looped writeSync) succeeds cleanly
    const bigEntryDir = join(workDir, 'r2-big-srv')
    const bigSiteDir = join(workDir, 'r2-big-site')
    mkdirSync(bigEntryDir, { recursive: true })
    mkdirSync(join(bigSiteDir, 'data'), { recursive: true })
    const bigEntryPath = join(bigEntryDir, 'api.mjs')
    writeFileSync(
      bigEntryPath,
      `export default async function handler() {
  return {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(4 * 1024 * 1024, 0x61),
  };
}
`,
    )
    const bigRes = await runSiteApiWorker({
      slug: 'r2-big-unit',
      siteDir: bigSiteDir,
      entryFilePath: bigEntryPath,
      revision: 1,
      method: 'GET',
      url: '/api/big',
      pathname: '/api/big',
      query: {},
      headers: {},
      body: Buffer.alloc(0),
      env: {},
    })
    assert.equal(bigRes.status, 200, bigRes.body.toString('utf8').slice(0, 300))
    assert.equal(bigRes.body.length, 4 * 1024 * 1024)

    // 2. P1 #7: Cross-origin redirect with custom X-Service-Token header is blocked
    const customHdrRedirServer = createServer((req, res) => {
      if (req.url === '/redir') {
        res.statusCode = 302
        res.setHeader('Location', 'http://127.0.0.2:9/never')
        res.end()
        return
      }
      res.statusCode = 200
      res.end('ok')
    })
    await new Promise<void>((done) => customHdrRedirServer.listen(0, '127.0.0.1', () => done()))
    const customRedirPort = (customHdrRedirServer.address() as { port: number }).port
    try {
      const customRedirEntryDir = join(workDir, 'r2-redir-srv')
      const customRedirSiteDir = join(workDir, 'r2-redir-site')
      mkdirSync(customRedirEntryDir, { recursive: true })
      mkdirSync(join(customRedirSiteDir, 'data'), { recursive: true })
      const customRedirEntryPath = join(customRedirEntryDir, 'api.mjs')
      writeFileSync(
        customRedirEntryPath,
        `export default async function handler() {
  try {
    await fetch('http://127.0.0.1:${customRedirPort}/redir', {
      headers: { 'X-Service-Token': 'svc-secret' },
    });
    return { status: 200, body: { leaked: true } };
  } catch (e) {
    return { status: 403, body: { blocked: String(e.message || e) } };
  }
}
`,
      )
      const customRedirRes = await runSiteApiWorker({
        slug: 'r2-redir-unit',
        siteDir: customRedirSiteDir,
        entryFilePath: customRedirEntryPath,
        revision: 1,
        method: 'GET',
        url: '/api/redir-custom',
        pathname: '/api/redir-custom',
        query: {},
        headers: {},
        body: Buffer.alloc(0),
        env: {},
        allowPrivateFetchForTest: true,
      })
      assert.equal(customRedirRes.status, 403, customRedirRes.body.toString('utf8'))
      assert.match(customRedirRes.body.toString('utf8'), /CROSS_ORIGIN_REDIRECT_BLOCKED/)
    } finally {
      await new Promise<void>((done) => customHdrRedirServer.close(() => done()))
    }

    // 3. P1 #1: verifyCustomDomain rejects 409 STALE_REVISION if domain mutates after TXT check before lock
    const toctouRepo = createInMemorySitesRepo()
    let resolveTxtHook: (() => Promise<void>) | null = null
    const toctouService = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      maxSiteBytes: 2 * 1024 * 1024,
      edgeSecret: EDGE_SECRET,
      repo: toctouRepo,
      edge: edgeClientRef,
      resolveTxt: async (host) => {
        if (resolveTxtHook) await resolveTxtHook()
        return txtRecords.get(host) ?? []
      },
    })
    await toctouService.publishSite(1, {
      slug: 'r2-domain-toctou',
      title: 'Domain TOCTOU',
      gzippedBundle: encodeSiteBundle([
        { path: 'index.html', content: Buffer.from('<h1>TOCTOU</h1>') },
      ]).gzipped,
    })
    await toctouService.updateSite(1, 'r2-domain-toctou', { customDomain: 'domain-a.example.com' })
    const preToctou = await toctouRepo.getByUserAndSlug(1, 'r2-domain-toctou')
    assert.ok(preToctou?.customDomainToken)
    txtRecords.set('_oc-site-verify.domain-a.example.com', [
      [customDomainTxtValueFor(preToctou.id, preToctou.customDomainToken)],
    ])
    resolveTxtHook = async () => {
      resolveTxtHook = null
      const prep = await toctouRepo.prepareMetaUpdate(1, 'r2-domain-toctou', 'meta')
      await toctouRepo.commitMetaUpdate({
        siteId: prep.site.id,
        userId: 1,
        leaseId: prep.leaseId,
        title: prep.site.title,
        visibility: prep.site.visibility,
        passwordSalt: prep.site.passwordSalt,
        passwordHash: prep.site.passwordHash,
        spaMode: prep.site.spaMode,
        customDomain: 'domain-b.example.com',
        customDomainVerified: false,
        customDomainToken: 'tok-b-changed',
        edgeRevision: prep.nextRevision,
      })
    }
    await assert.rejects(
      () => toctouService.verifyCustomDomain(1, 'r2-domain-toctou'),
      (err: unknown) => err instanceof SitesError && err.code === 'STALE_REVISION' && err.status === 409,
    )
    const afterToctou = await toctouRepo.getByUserAndSlug(1, 'r2-domain-toctou')
    assert.equal(afterToctou?.customDomain, 'domain-b.example.com')
    assert.equal(afterToctou?.customDomainVerified, false)
    const tlsA = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=domain-a.example.com`)
    assert.equal(tlsA.status, 404)
    const tlsB = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=domain-b.example.com`)
    assert.equal(tlsB.status, 404)

    // 4 & 5. P1 #2 (deleteEnvVar EDGE_UNAVAILABLE + old rev probe keeps opKind='env') & P1 #9 (needsEnvSync fail loud)
    let failNextUpdateMeta = false
    let failNextSyncEnv = false
    const faultEdge: SitesEdgeClient = {
      pushBundle: (a) => edgeClientRef.pushBundle(a),
      updateMeta: async (a) => {
        if (failNextUpdateMeta) {
          failNextUpdateMeta = false
          throw new SitesError('EDGE_UNAVAILABLE', 'simulated patch drop', 502, true)
        }
        return edgeClientRef.updateMeta(a)
      },
      syncEnv: async (a) => {
        if (failNextSyncEnv) {
          failNextSyncEnv = false
          throw new SitesError('EDGE_UNAVAILABLE', 'simulated syncEnv failure', 502, true)
        }
        return edgeClientRef.syncEnv!(a)
      },
      deleteSite: (a) => edgeClientRef.deleteSite(a),
      renameSite: (a) => edgeClientRef.renameSite(a),
      getAnalytics: (a) => edgeClientRef.getAnalytics(a),
      inspectDb: (a) => edgeClientRef.inspectDb(a),
      executeDbSql: (a) => edgeClientRef.executeDbSql(a),
      getSiteStatus: (a) => edgeClientRef.getSiteStatus(a),
    }
    const r2Repo = createInMemorySitesRepo()
    const r2Service = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      maxSiteBytes: 2 * 1024 * 1024,
      edgeSecret: EDGE_SECRET,
      repo: r2Repo,
      edge: faultEdge,
      resolveTxt: async () => [],
    })
    const checkBundle = encodeSiteBundle([
      { path: 'index.html', content: Buffer.from('<h1>R2 Env Check</h1>') },
      {
        path: '__oc_server/api.mjs',
        content: Buffer.from(
          `export default async function handler(req, ctx) {
  return {
    status: 200,
    body: {
      hasRevoked: Boolean(ctx.env.REVOKED_KEY),
      hasSync: Boolean(ctx.env.SYNC_KEY),
    },
  };
}
`,
        ),
      },
    ]).gzipped

    await r2Service.publishSite(1, {
      slug: 'r2-env-revoke',
      title: 'R2 Env Revoke',
      gzippedBundle: checkBundle,
    })
    await r2Service.setEnvVar(1, 'r2-env-revoke', {
      key: 'REVOKED_KEY',
      value: 'secret-1',
      isSecret: true,
    })
    const beforeRevoke = await edgeHttpRequest({
      port: edgePort,
      path: '/api/check',
      host: 'r2-env-revoke.congjianai.com',
    })
    assert.equal(beforeRevoke.status, 200)
    assert.deepEqual(JSON.parse(beforeRevoke.text), { hasRevoked: true, hasSync: false })

    failNextUpdateMeta = true
    await assert.rejects(
      () => r2Service.deleteEnvVar(1, 'r2-env-revoke', 'REVOKED_KEY'),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE',
    )
    const pendingRow = await r2Repo.getByUserAndSlug(1, 'r2-env-revoke')
    assert.equal(pendingRow?.opKind, 'env')

    const listedEnv = await r2Service.listEnvVars(1, 'r2-env-revoke')
    assert.equal(listedEnv.length, 0)
    const healedRow = await r2Repo.getByUserAndSlug(1, 'r2-env-revoke')
    assert.equal(healedRow?.opKind, null)
    const afterRevoke = await edgeHttpRequest({
      port: edgePort,
      path: '/api/check',
      host: 'r2-env-revoke.congjianai.com',
    })
    assert.equal(afterRevoke.status, 200)
    assert.deepEqual(JSON.parse(afterRevoke.text), { hasRevoked: false, hasSync: false })

    // P1 #9: publishSite fails loud with 502 EDGE_UNAVAILABLE if needsEnvSync fails, and auto-heals on read
    await r2Service.setEnvVar(1, 'r2-env-revoke', {
      key: 'SYNC_KEY',
      value: 'sync-v1',
      isSecret: true,
    })
    rmSync(join(edgeDataRoot, 'sites', 'r2-env-revoke', 'env.enc'), { force: true })
    failNextSyncEnv = true
    await assert.rejects(
      () =>
        r2Service.publishSite(1, {
          slug: 'r2-env-revoke',
          title: 'R2 Env Sync Fail Loud',
          gzippedBundle: checkBundle,
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE' && err.status === 502,
    )
    const pendingSyncRow = await r2Repo.getByUserAndSlug(1, 'r2-env-revoke')
    assert.equal(pendingSyncRow?.opKind, 'env')

    await r2Service.listSummary(1)
    const syncedRow = await r2Repo.getByUserAndSlug(1, 'r2-env-revoke')
    assert.equal(syncedRow?.opKind, null)
    const afterSync = await edgeHttpRequest({
      port: edgePort,
      path: '/api/check',
      host: 'r2-env-revoke.congjianai.com',
    })
    assert.equal(afterSync.status, 200)
    assert.deepEqual(JSON.parse(afterSync.text), { hasRevoked: false, hasSync: true })
  })

  test('collaborative sharing (email + invite links + permissions + oc-site pull/publish) & live-edit preview bridge', async () => {
    const collabDir = mkdtempSync(join(tmpdir(), 'oc-sites-collab-e2e-'))
    const edgeDataDir = join(collabDir, 'edge-data')
    const edgeSrv = createSitesEdgeServer({
      bind: '127.0.0.1',
      port: 0,
      dataRoot: edgeDataDir,
      baseDomain: 'congjianai.com',
      secret: EDGE_SECRET,
      maxSiteBytes: 2 * 1024 * 1024,
      allowPrivateFetchForTest: true,
    })
    const { port: cEdgePort } = await edgeSrv.listen()
    const cEdgeClient = createHttpSitesEdgeClient({
      baseUrl: `http://127.0.0.1:${cEdgePort}`,
      secret: EDGE_SECRET,
    })
    const cRepo = createInMemorySitesRepo()
    const cService = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      maxSiteBytes: 2 * 1024 * 1024,
      edgeSecret: EDGE_SECRET,
      repo: cRepo,
      edge: cEdgeClient,
      resolveTxt: async () => [],
    })

    const sec1 = 'a1'.repeat(32)
    const sec2 = 'b2'.repeat(32)
    const sec3 = 'c3'.repeat(32)
    const tok1 = `oc-v3.101.${sec1}`
    const tok2 = `oc-v3.202.${sec2}`
    const tok3 = `oc-v3.303.${sec3}`
    const h1 = hashSecret(sec1)
    const h2 = hashSecret(sec2)
    const h3 = hashSecret(sec3)
    const idRepo: ContainerIdentityRepo = {
      async findActiveByHostAndBoundIp(hostUuid: string, boundIp: string) {
        if (boundIp === '10.0.0.1') {
          return { id: 101, user_id: 1, host_uuid: hostUuid, bound_ip: boundIp, secret_hash: h1 }
        }
        if (boundIp === '10.0.0.2') {
          return { id: 202, user_id: 2, host_uuid: hostUuid, bound_ip: boundIp, secret_hash: h2 }
        }
        if (boundIp === '10.0.0.3') {
          return { id: 303, user_id: 3, host_uuid: hostUuid, bound_ip: boundIp, secret_hash: h3 }
        }
        return null
      },
    }
    const internalHandler = makeSitesInternalHandler({ identityRepo: idRepo, sites: cService })
    const masterSrv = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        if (pathname.startsWith('/internal/v3/sites/')) {
          const auth = req.headers.authorization ?? ''
          const hostUuid = auth.includes(tok1) ? 'h1' : auth.includes(tok2) ? 'h2' : 'h3'
          const boundIp = hostUuid === 'h1' ? '10.0.0.1' : hostUuid === 'h2' ? '10.0.0.2' : '10.0.0.3'
          await internalHandler(req, res, { hostUuid, boundIp })
          return
        }
        if (
          pathname === '/api/sites' ||
          pathname.startsWith('/api/sites/') ||
          pathname.startsWith('/api/site-invites/')
        ) {
          await dispatchSitesBrowserRoute(
            req,
            res,
            { requestId: 'req-collab', ip: '127.0.0.1' } as unknown as RequestContext,
            {
              jwtSecret: JWT_SECRET,
              sites: cService,
              verifyEmailUrlBase: 'https://app.congjianai.com',
            },
          )
          return
        }
        res.statusCode = 404
        res.end('not found')
      })().catch((err: unknown) => {
        const e = err as { status?: number; code?: string; message?: string }
        res.statusCode = e.status ?? 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { code: e.code ?? 'INTERNAL', message: e.message ?? 'err' } }))
      })
    })
    await new Promise<void>((r) => masterSrv.listen(0, '127.0.0.1', () => r()))
    const mPort = (masterSrv.address() as { port: number }).port

    const runCli = (token: string, args: string[], extraEnv?: Record<string, string>) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise) => {
        const child = spawn('python3', [OC_SITE_PY, ...args], {
          env: {
            ...process.env,
            OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${mPort}`,
            OPENCLAUDE_V3_CONTAINER_TOKEN: token,
            ...(extraEnv ?? {}),
          },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => (stdout += String(d)))
        child.stderr.on('data', (d) => (stderr += String(d)))
        child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }))
      })

    try {
      const jwt1 = (await signAccess({ sub: '1', role: 'user' }, JWT_SECRET)).token
      const jwt2 = (await signAccess({ sub: '2', role: 'user' }, JWT_SECRET)).token
      const jwt3 = (await signAccess({ sub: '3', role: 'user' }, JWT_SECRET)).token

      // 1) Owner (uid 1) publishes a fullstack password-protected site + secret env var + pending custom domain
      const srcDir = join(collabDir, 'src-v1')
      mkdirSync(join(srcDir, 'server'), { recursive: true })
      writeFileSync(join(srcDir, 'index.html'), '<!doctype html><html><body><h1 id="hero">Hello v1</h1></body></html>')
      writeFileSync(
        join(srcDir, 'server', 'api.mjs'),
        `export default async function handler(ctx) {
  return ctx.json({
    ver: 'v1',
    hasKey: Boolean(ctx.env.OWNER_SECRET),
    cookieHeader: ctx.req.headers.cookie || '',
  })
}
`,
      )
      const pub1 = await runCli(
        tok1,
        ['publish', srcDir, '--slug', 'team-portal', '--title', 'Team Portal', '--visibility', 'password', '--password', 'pass1234'],
        { OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:dm:owner-sess' },
      )
      assert.equal(pub1.code, 0, pub1.stderr)

      // P1 #8: Existing slug "invites" must still be publishable and accessible without colliding with /api/site-invites/*
      const invSlugDir = join(collabDir, 'slug-invites')
      mkdirSync(invSlugDir, { recursive: true })
      writeFileSync(join(invSlugDir, 'index.html'), '<h1>Legacy invites slug</h1>')
      const pubInvSlug = await runCli(tok1, ['publish', invSlugDir, '--slug', 'invites', '--title', 'Invites Site'])
      assert.equal(pubInvSlug.code, 0, pubInvSlug.stderr)
      const invSlugDetail = await fetch(`http://127.0.0.1:${mPort}/api/sites/invites`, {
        headers: { Authorization: `Bearer ${jwt1}` },
      })
      assert.equal(invSlugDetail.status, 200)

      await cService.updateSite(1, 'team-portal', { customDomain: 'portal.custom.example' })

      const envSetRes = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/env`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${jwt1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'OWNER_SECRET', value: 'top-secret-value', isSecret: true }),
      })
      assert.equal(envSetRes.status, 200)

      // P1 #6: Email direct add rejects unverified user accounts
      const addUnverifiedRes = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/collaborators`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'unverified@example.com', role: 'editor' }),
      })
      assert.equal(addUnverifiedRes.status, 400)

      // 2) Owner invites User 2 as editor by verified email
      const addEditorRes = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/collaborators`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'editor@example.com', role: 'editor' }),
      })
      assert.equal(addEditorRes.status, 200)
      const addEditorBody = (await addEditorRes.json()) as { collaborators: Array<{ email: string; role: string }> }
      assert.equal(addEditorBody.collaborators.length, 1)
      assert.equal(addEditorBody.collaborators[0]?.role, 'editor')

      // 3) Owner creates single-use viewer invite link; User 3 previews & accepts it at /api/site-invites/*; second accept fails
      const createInvRes = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/invites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'viewer', expiresInHours: 24, maxUses: 1 }),
      })
      assert.equal(createInvRes.status, 200)
      const createdInv = (await createInvRes.json()) as { token: string; invite: { id: string } }
      assert.ok(createdInv.token.length >= 20)

      const previewInvRes = await fetch(
        `http://127.0.0.1:${mPort}/api/site-invites/${encodeURIComponent(createdInv.token)}`,
        { headers: { Authorization: `Bearer ${jwt3}` } },
      )
      assert.equal(previewInvRes.status, 200)
      const previewInvBody = (await previewInvRes.json()) as { invite: { site: { slug: string }; role: string } }
      assert.equal(previewInvBody.invite.site.slug, 'team-portal')
      assert.equal(previewInvBody.invite.role, 'viewer')

      const acceptRes = await fetch(
        `http://127.0.0.1:${mPort}/api/site-invites/${encodeURIComponent(createdInv.token)}/accept`,
        { method: 'POST', headers: { Authorization: `Bearer ${jwt3}`, 'Content-Type': 'application/json' }, body: '{}' },
      )
      assert.equal(acceptRes.status, 200)
      const acceptBody = (await acceptRes.json()) as { site: { slug: string; accessRole: string }; alreadyMember: boolean }
      assert.equal(acceptBody.site.accessRole, 'viewer')
      assert.equal(acceptBody.alreadyMember, false)

      // Single-use invite is now exhausted for new users
      const previewExhausted = await fetch(
        `http://127.0.0.1:${mPort}/api/site-invites/${encodeURIComponent(createdInv.token)}`,
        { headers: { Authorization: `Bearer ${jwt2}` } },
      )
      assert.equal(previewExhausted.status, 404)

      // 4) Permission boundaries + P1 #5 DTO sanitization:
      // Owner sees originSessionId + customDomainTxtValue; Editor & Viewer receive null!
      const ownerDetail = await cService.getSite(1, 'team-portal')
      assert.equal(ownerDetail.originSessionId, 'agent:main:webchat:dm:owner-sess')
      assert.ok(ownerDetail.customDomainTxtValue)

      const u2Detail = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal`, {
        headers: { Authorization: `Bearer ${jwt2}` },
      })
      assert.equal(u2Detail.status, 200)
      const u2DetailJson = (await u2Detail.json()) as {
        site: {
          accessRole: string
          originSessionId: string | null
          customDomainTxtName: string | null
          customDomainTxtValue: string | null
        }
        envVars: unknown[]
      }
      assert.equal(u2DetailJson.site.accessRole, 'editor')
      assert.equal(u2DetailJson.site.originSessionId, null)
      assert.equal(u2DetailJson.site.customDomainTxtName, null)
      assert.equal(u2DetailJson.site.customDomainTxtValue, null)
      assert.deepEqual(u2DetailJson.envVars, [])

      const u2TitlePatch = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Team Portal Edited', spaMode: false }),
      })
      assert.equal(u2TitlePatch.status, 200)

      for (const forbiddenReq of [
        fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ visibility: 'public' }),
        }),
        fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/rename`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ newSlug: 'hijacked-slug' }),
        }),
        fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/env`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'X', value: '1', isSecret: false }),
        }),
        fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${jwt2}` },
        }),
        fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/collaborators`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'viewer@example.com', role: 'editor' }),
        }),
      ]) {
        assert.equal((await forbiddenReq).status, 403)
      }

      // Viewer (uid 3) can view analytics/detail (sanitized), CANNOT update title, pull, publish, or start live-edit preview
      const u3Ana = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/analytics?days=7`, {
        headers: { Authorization: `Bearer ${jwt3}` },
      })
      assert.equal(u3Ana.status, 200)
      const u3Preview = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/preview-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt3}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      assert.equal(u3Preview.status, 403)
      const u3Pull = await runCli(tok3, ['pull', 'team-portal', join(collabDir, 'u3-pull')])
      assert.equal(u3Pull.code, 1)

      // 5) P0 #1 + P1 #7: Collaborative oc-site pull -> optimistic concurrency & server/api.mjs secret protection
      const pullDir = join(collabDir, 'u2-pull-a')
      const pullDirStale = join(collabDir, 'u2-pull-b')
      const pullRes = await runCli(tok2, ['pull', 'team-portal', pullDir])
      assert.equal(pullRes.code, 0, pullRes.stderr)
      const pullResB = await runCli(tok2, ['pull', 'team-portal', pullDirStale])
      assert.equal(pullResB.code, 0, pullResB.stderr)
      const pullJson = JSON.parse(pullRes.stdout) as {
        ok: boolean
        hasServerApi: boolean
        fileCount: number
        contentSha256: string
      }
      assert.equal(pullJson.ok, true)
      assert.equal(pullJson.hasServerApi, true)
      assert.match(pullJson.contentSha256, /^[a-f0-9]{64}$/)
      assert.ok(readFileSync(join(pullDir, 'index.html'), 'utf8').includes('Hello v1'))
      assert.ok(readFileSync(join(pullDir, 'server', 'api.mjs'), 'utf8').includes('OWNER_SECRET'))

      // P0 #1: Editor attempting to modify server/api.mjs (e.g. to exfiltrate ctx.env.OWNER_SECRET) MUST be rejected 403!
      const origApiMjs = readFileSync(join(pullDir, 'server', 'api.mjs'), 'utf8')
      writeFileSync(
        join(pullDir, 'server', 'api.mjs'),
        'export default async function handler(ctx) { return ctx.json({ leaked: ctx.env.OWNER_SECRET }) }\n',
      )
      const pubExfil = await runCli(tok2, ['publish', pullDir, '--slug', 'team-portal'])
      assert.equal(pubExfil.code, 1)
      assert.ok(pubExfil.stderr.includes('FORBIDDEN'), pubExfil.stderr)

      // Restore owner-approved server/api.mjs and modify ONLY index.html -> editor publish SUCCEEDS!
      writeFileSync(join(pullDir, 'server', 'api.mjs'), origApiMjs)
      writeFileSync(join(pullDir, 'index.html'), '<!doctype html><html><body><h1 id="hero">Hello v2 by editor</h1></body></html>')
      const pub2 = await runCli(tok2, ['publish', pullDir, '--slug', 'team-portal'], {
        OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:dm:editor-sess',
      })
      assert.equal(pub2.code, 0, pub2.stderr)

      // P1 #7: Stale workspace (pulled before pub2) MUST fail with 409 STALE_REVISION rather than silently clobbering!
      writeFileSync(join(pullDirStale, 'index.html'), '<!doctype html><html><body><h1>Stale overwrite attempt</h1></body></html>')
      const pubStale = await runCli(tok2, ['publish', pullDirStale, '--slug', 'team-portal'])
      assert.equal(pubStale.code, 1)
      assert.ok(pubStale.stderr.includes('STALE_REVISION'), pubStale.stderr)

      // Owner's originSessionId is preserved (not clobbered by editor's session)
      const ownerAfter = await cService.getSite(1, 'team-portal')
      assert.equal(ownerAfter.originSessionId, 'agent:main:webchat:dm:owner-sess')

      // 6) Live-Edit Preview Session (P1 #4 one-time boot code + clean URL + cookie stripping + no analytics pollution)
      const publicBlocked = await edgeHttpRequest({
        port: cEdgePort,
        path: '/',
        host: 'team-portal.congjianai.com',
      })
      assert.equal(publicBlocked.status, 401)
      assert.equal(publicBlocked.text.includes('__oc_site_preview_bridge.js'), false)

      const previewRes = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/preview-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      assert.equal(previewRes.status, 200)
      const { preview } = (await previewRes.json()) as {
        preview: { bootstrapUrl: string; siteOrigin: string }
      }
      assert.equal(preview.siteOrigin, 'https://team-portal.congjianai.com')
      const bootUrl = new URL(preview.bootstrapUrl)
      assert.ok(bootUrl.searchParams.get('code'), 'bootstrap URL must use one-time ?code=')
      assert.equal(bootUrl.searchParams.get('token'), null)

      const bootResp = await edgeHttpRequest({
        port: cEdgePort,
        path: `${bootUrl.pathname}${bootUrl.search}`,
        host: 'team-portal.congjianai.com',
      })
      assert.equal(bootResp.status, 302)
      assert.equal(bootResp.headers.location, '/')
      assert.equal(bootResp.headers['content-security-policy'], 'frame-ancestors https://app.congjianai.com')
      const setCookie = Array.isArray(bootResp.headers['set-cookie'])
        ? bootResp.headers['set-cookie'][0]!
        : String(bootResp.headers['set-cookie'] ?? '')
      assert.ok(setCookie.includes('__oc_site_preview='))
      assert.ok(setCookie.includes('HttpOnly'))
      const previewCookie = setCookie.split(';')[0]!

      // P1 #4: One-time boot code cannot be replayed!
      const bootReplay = await edgeHttpRequest({
        port: cEdgePort,
        path: `${bootUrl.pathname}${bootUrl.search}`,
        host: 'team-portal.congjianai.com',
      })
      assert.equal(bootReplay.status, 401)

      // Fetch HTML with preview cookie -> unlocked, shows v2 content, injects clean /__oc_site_preview_bridge.js (no ?t=)!
      const previewHtml = await edgeHttpRequest({
        port: cEdgePort,
        path: '/',
        host: 'team-portal.congjianai.com',
        headers: { Cookie: previewCookie },
      })
      assert.equal(previewHtml.status, 200)
      assert.ok(previewHtml.text.includes('Hello v2 by editor'))
      assert.ok(previewHtml.text.includes('src="/__oc_site_preview_bridge.js"'))
      assert.equal(previewHtml.text.includes('__oc_site_preview_bridge.js?'), false)
      assert.equal(previewHtml.headers['content-security-policy'], 'frame-ancestors https://app.congjianai.com')

      // P1 #4: /api/status receives user app cookies but NEVER platform preview/auth cookies!
      const previewApi = await edgeHttpRequest({
        port: cEdgePort,
        path: '/api/status',
        host: 'team-portal.congjianai.com',
        headers: { Cookie: `${previewCookie}; oc_site_auth=secret-site-auth; app_session=keepme` },
      })
      assert.equal(previewApi.status, 200)
      const apiJson = JSON.parse(previewApi.text) as {
        ver: string
        hasKey: boolean
        cookieHeader: string
      }
      assert.equal(apiJson.ver, 'v1')
      assert.equal(apiJson.hasKey, true)
      assert.equal(apiJson.cookieHeader.includes('__oc_site_preview'), false)
      assert.equal(apiJson.cookieHeader.includes('oc_site_auth'), false)
      assert.ok(apiJson.cookieHeader.includes('app_session=keepme'))

      // Fetch bridge script with preview cookie -> served with strict parentOrigin
      const bridgeRes = await edgeHttpRequest({
        port: cEdgePort,
        path: '/__oc_site_preview_bridge.js',
        host: 'team-portal.congjianai.com',
        headers: { Cookie: previewCookie },
      })
      assert.equal(bridgeRes.status, 200)
      assert.ok(bridgeRes.text.includes('oc-site-preview-v1'))
      assert.ok(bridgeRes.text.includes('https://app.congjianai.com'))

      // Bridge script without preview cookie -> 404 (invisible to public)
      const bridgeUnauth = await edgeHttpRequest({
        port: cEdgePort,
        path: '/__oc_site_preview_bridge.js',
        host: 'team-portal.congjianai.com',
      })
      assert.equal(bridgeUnauth.status, 404)

      // Preview traffic must NOT pollute analytics
      const anaAfterPreview = await cService.getAnalytics(1, 'team-portal', 7)
      assert.equal(anaAfterPreview.totals.requests, 0)

      // Disabled site is still previewable by owner/editor with preview cookie, while public gets 404
      await cService.updateSite(1, 'team-portal', { visibility: 'disabled' })
      const disabledPublic = await edgeHttpRequest({
        port: cEdgePort,
        path: '/',
        host: 'team-portal.congjianai.com',
      })
      assert.equal(disabledPublic.status, 404)
      const disabledPreview = await edgeHttpRequest({
        port: cEdgePort,
        path: '/',
        host: 'team-portal.congjianai.com',
        headers: { Cookie: previewCookie },
      })
      assert.equal(disabledPreview.status, 200)
      assert.ok(disabledPreview.text.includes('Hello v2 by editor'))

      // 7) P1 #3: Downgrading editor -> viewer OR removing editor immediately revokes ALREADY-ISSUED Edge preview cookie!
      const downgradeRes = await fetch(
        `http://127.0.0.1:${mPort}/api/sites/team-portal/collaborators/2`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${jwt1}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'viewer' }),
        },
      )
      assert.equal(downgradeRes.status, 200)
      const revokedPageAfterDowngrade = await edgeHttpRequest({
        port: cEdgePort,
        path: '/',
        host: 'team-portal.congjianai.com',
        headers: { Cookie: previewCookie },
      })
      assert.equal(revokedPageAfterDowngrade.status, 404)
      const revokedBridgeAfterDowngrade = await edgeHttpRequest({
        port: cEdgePort,
        path: '/__oc_site_preview_bridge.js',
        host: 'team-portal.congjianai.com',
        headers: { Cookie: previewCookie },
      })
      assert.equal(revokedBridgeAfterDowngrade.status, 404)

      // Re-promote editor, mint a fresh preview cookie, then remove editor -> immediately revoked again!
      const rePromote = await fetch(
        `http://127.0.0.1:${mPort}/api/sites/team-portal/collaborators/2`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${jwt1}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'editor' }),
        },
      )
      assert.equal(rePromote.status, 200)
      const previewRes2 = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/preview-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      assert.equal(previewRes2.status, 200)
      const bootUrl2 = new URL(((await previewRes2.json()) as { preview: { bootstrapUrl: string } }).preview.bootstrapUrl)
      const bootResp2 = await edgeHttpRequest({
        port: cEdgePort,
        path: `${bootUrl2.pathname}${bootUrl2.search}`,
        host: 'team-portal.congjianai.com',
      })
      assert.equal(bootResp2.status, 302)
      const setCookie2 = Array.isArray(bootResp2.headers['set-cookie'])
        ? bootResp2.headers['set-cookie'][0]!
        : String(bootResp2.headers['set-cookie'] ?? '')
      const previewCookie2 = setCookie2.split(';')[0]!
      const previewOk2 = await edgeHttpRequest({
        port: cEdgePort,
        path: '/',
        host: 'team-portal.congjianai.com',
        headers: { Cookie: previewCookie2 },
      })
      assert.equal(previewOk2.status, 200)

      // Collaborator leaves & owner removes editor -> access & preview cookie revoked immediately
      const leaveRes = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/leave`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt3}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      assert.equal(leaveRes.status, 200)
      const u3AfterLeave = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal`, {
        headers: { Authorization: `Bearer ${jwt3}` },
      })
      assert.equal(u3AfterLeave.status, 404)

      const removeEditorRes = await fetch(
        `http://127.0.0.1:${mPort}/api/sites/team-portal/collaborators/2`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${jwt1}` } },
      )
      assert.equal(removeEditorRes.status, 200)
      const u2AfterRemove = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal`, {
        headers: { Authorization: `Bearer ${jwt2}` },
      })
      assert.equal(u2AfterRemove.status, 404)
      const revokedPageAfterRemove = await edgeHttpRequest({
        port: cEdgePort,
        path: '/',
        host: 'team-portal.congjianai.com',
        headers: { Cookie: previewCookie2 },
      })
      assert.equal(revokedPageAfterRemove.status, 404)

      // 8) Round-2 P1 #3: Email upsert downgrading editor -> viewer ALSO immediately revokes Edge preview cookie!
      const reAddEditor = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/collaborators`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'editor@example.com', role: 'editor' }),
      })
      assert.equal(reAddEditor.status, 200)
      const previewRes3 = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/preview-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      assert.equal(previewRes3.status, 200)
      const bootUrl3 = new URL(((await previewRes3.json()) as { preview: { bootstrapUrl: string } }).preview.bootstrapUrl)
      const bootResp3 = await edgeHttpRequest({
        port: cEdgePort,
        path: `${bootUrl3.pathname}${bootUrl3.search}`,
        host: 'team-portal.congjianai.com',
      })
      assert.equal(bootResp3.status, 302)
      const setCookie3 = Array.isArray(bootResp3.headers['set-cookie'])
        ? bootResp3.headers['set-cookie'][0]!
        : String(bootResp3.headers['set-cookie'] ?? '')
      const previewCookie3 = setCookie3.split(';')[0]!
      const previewOk3 = await edgeHttpRequest({
        port: cEdgePort,
        path: '/',
        host: 'team-portal.congjianai.com',
        headers: { Cookie: previewCookie3 },
      })
      assert.equal(previewOk3.status, 200)

      const emailDowngradeRes = await fetch(`http://127.0.0.1:${mPort}/api/sites/team-portal/collaborators`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'editor@example.com', role: 'viewer' }),
      })
      assert.equal(emailDowngradeRes.status, 200)
      const revokedAfterEmailDowngrade = await edgeHttpRequest({
        port: cEdgePort,
        path: '/',
        host: 'team-portal.congjianai.com',
        headers: { Cookie: previewCookie3 },
      })
      assert.equal(revokedAfterEmailDowngrade.status, 404)

      // 9) Round-2 P1 #7: Symlink .oc-site-state.json refuses overwrite on pull --force, AND baseline publish after delete fails 409 (never recreates public site!)
      const symTarget = join(collabDir, 'victim.txt')
      writeFileSync(symTarget, 'ORIGINAL_VICTIM')
      const symPullDir = join(collabDir, 'sym-pull')
      mkdirSync(symPullDir, { recursive: true })
      symlinkSync(symTarget, join(symPullDir, '.oc-site-state.json'))
      const symPull = await runCli(tok1, ['pull', 'team-portal', symPullDir, '--force'])
      assert.equal(symPull.code, 1)
      assert.equal(readFileSync(symTarget, 'utf8'), 'ORIGINAL_VICTIM')

      // Owner deletes team-portal; editor (or owner) attempting publish from pulled dir with baseline MUST fail 409 STALE_REVISION!
      await cService.deleteSite(1, 'team-portal')
      const pubAfterDelete = await runCli(tok2, ['publish', pullDir, '--slug', 'team-portal'])
      assert.equal(pubAfterDelete.code, 1)
      assert.ok(pubAfterDelete.stderr.includes('STALE_REVISION'), pubAfterDelete.stderr)
      assert.equal(await cRepo.getByUserAndSlug(2, 'team-portal'), null)
    } finally {
      await new Promise<void>((r) => masterSrv.close(() => r()))
      await edgeSrv.close()
      rmSync(collabDir, { recursive: true, force: true })
    }
  })

  test('shared edge enforces cross-instance siteId ownership, tombstone lineage, and lost-ACK UUID match', async () => {
    const selfhostRepo = createInMemorySitesRepo({ idPrefix: 'aaaaaaaa', initialRev: 0 })
    const commercialRepo = createInMemorySitesRepo({ idPrefix: 'bbbbbbbb', initialRev: 100_000 })
    const selfhostSvc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 10,
      edgeSecret: EDGE_SECRET,
      repo: selfhostRepo,
      edge: edgeClientRef,
    })
    const commercialSvc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 10,
      edgeSecret: EDGE_SECRET,
      repo: commercialRepo,
      edge: edgeClientRef,
    })

    // 1. Live slug owned by Instance A cannot be overwritten by Instance B even with higher rev (100001 > 1)
    const liveA = await selfhostSvc.publishSite(1, {
      slug: 'shared-live-slug',
      title: 'Instance A Live',
      gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>INSTANCE_A</h1>') }]).gzipped,
    })
    assert.equal(liveA.edgeRevision, 1)
    await assert.rejects(
      () =>
        commercialSvc.publishSite(2, {
          slug: 'shared-live-slug',
          title: 'Instance B Steal Attempt',
          gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>HIJACK</h1>') }]).gzipped,
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'SLUG_TAKEN' && err.status === 409,
    )
    const servedA = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'shared-live-slug.congjianai.com',
    })
    assert.equal(servedA.status, 200)
    assert.match(servedA.text, /INSTANCE_A/)

    // 2. High tombstone (rev=100002) from Instance B does NOT block Instance A (rev=2) on a vacant slug,
    //    while delayed replays for Instance B's retired siteId are still rejected even after A deletes too!
    const createdB = await commercialSvc.publishSite(2, {
      slug: 'shared-reused-slug',
      gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>B1</h1>') }]).gzipped,
    })
    assert.equal(createdB.edgeRevision, 100_002)
    await commercialSvc.deleteSite(2, 'shared-reused-slug')

    const reusedByA = await selfhostSvc.publishSite(1, {
      slug: 'shared-reused-slug',
      gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>A_REUSED</h1>') }]).gzipped,
    })
    assert.equal(reusedByA.edgeRevision, 2)
    const servedReusedA = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'shared-reused-slug.congjianai.com',
    })
    assert.equal(servedReusedA.status, 200)
    assert.match(servedReusedA.text, /A_REUSED/)

    await selfhostSvc.deleteSite(1, 'shared-reused-slug')
    await assert.rejects(
      () =>
        edgeClientRef.pushBundle({
          slug: 'shared-reused-slug',
          revision: 100_001,
          gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>STALE_B</h1>') }]).gzipped,
          meta: {
            siteId: createdB.id,
            title: 'stale-b',
            visibility: 'public',
            passwordSalt: null,
            passwordHash: null,
            spaMode: true,
          },
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'STALE_REVISION',
    )

    // 3. Lost-ACK probe: EDGE_UNAVAILABLE where edge has same numeric revision for a different siteId must NOT commit
    const mismatchRepo = createInMemorySitesRepo({ idPrefix: 'cccccccc', initialRev: 0 })
    const mismatchSvc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 10,
      edgeSecret: EDGE_SECRET,
      repo: mismatchRepo,
      edge: {
        ...edgeClientRef,
        async pushBundle() {
          throw new SitesError('EDGE_UNAVAILABLE', 'simulated network drop', 502, true)
        },
        async getSiteStatus() {
          return {
            exists: true,
            revision: 1,
            tombstoneRevision: 0,
            meta: {
              siteId: '99999999-0000-4000-8000-000000000001',
              title: 'Foreign Site',
              visibility: 'public',
              passwordSalt: null,
              passwordHash: null,
              spaMode: true,
              customDomain: null,
              hasServerApi: false,
              fileCount: 1,
              sizeBytes: 16,
              contentSha256: 'deadbeef'.repeat(8),
            },
          }
        },
      },
    })
    await assert.rejects(
      () =>
        mismatchSvc.publishSite(3, {
          slug: 'shared-live-slug',
          gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>FOREIGN</h1>') }]).gzipped,
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'SLUG_TAKEN',
    )
    assert.equal(await mismatchRepo.getByUserAndSlug(3, 'shared-live-slug'), null)
  })

  test('shared edge: purges old tenant SQLite/env before reuse, reconciles lost-ACK delete after foreign reuse, and preserves retired history across rename', async () => {
    const repoA = createInMemorySitesRepo({ idPrefix: '11111111', initialRev: 0 })
    const repoB = createInMemorySitesRepo({ idPrefix: '22222222', initialRev: 50_000 })
    const svcA = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 1,
      edgeSecret: EDGE_SECRET,
      repo: repoA,
      edge: edgeClientRef,
    })
    const svcB = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 2,
      edgeSecret: EDGE_SECRET,
      repo: repoB,
      edge: edgeClientRef,
    })

    // 1. Orphaned data/site.db + env.enc on edge (simulating interrupted delete before cleanup) MUST be purged for new UUID owner
    const tenantOld = await svcA.publishSite(1, {
      slug: 'shared-data-isolation',
      gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>OLD_TENANT</h1>') }]).gzipped,
    })
    await svcA.executeDbSql(1, 'shared-data-isolation', {
      sql: 'CREATE TABLE secret_notes (note TEXT)',
    })
    await svcA.executeDbSql(1, 'shared-data-isolation', {
      sql: 'INSERT INTO secret_notes VALUES (?)',
      params: ['tenant-a-confidential'],
    })
    const leakedDir = join(workDir, 'edge-data', 'sites', 'shared-data-isolation')
    writeFileSync(
      join(leakedDir, 'tombstone.json'),
      JSON.stringify({
        revision: tenantOld.edgeRevision + 1,
        deletedAt: new Date().toISOString(),
        siteId: tenantOld.id,
        op: 'delete',
      }),
    )
    // Stale delete still works cleanly via idempotent tombstone cleanup
    await svcA.deleteSite(1, 'shared-data-isolation')
    // Inject leftover SQLite/env right before new owner publishes on vacant slug (worst-case crash race)
    mkdirSync(join(leakedDir, 'data'), { recursive: true })
    writeFileSync(join(leakedDir, 'data', 'site.db'), Buffer.from('corrupt-leftover-sqlite-bytes'))
    writeFileSync(join(leakedDir, 'env.enc'), 'leftover-cipher')

    await svcB.publishSite(2, {
      slug: 'shared-data-isolation',
      gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>NEW_TENANT_B</h1>') }]).gzipped,
    })
    const dbNewOwner = await svcB.inspectDb(2, 'shared-data-isolation', { limit: 20 })
    assert.deepEqual(dbNewOwner.tables, [], 'new UUID owner must start with an empty database')
    await svcB.deleteSite(2, 'shared-data-isolation')

    // 2. Lost-ACK delete on Instance A followed by Instance B reusing the same slug still frees A's row and quota=1
    await svcA.publishSite(1, {
      slug: 'shared-lost-delete',
      gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>A_TO_DELETE</h1>') }]).gzipped,
    })
    const dropOnceSvcA = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 1,
      edgeSecret: EDGE_SECRET,
      repo: repoA,
      edge: {
        ...edgeClientRef,
        async deleteSite(args) {
          await edgeClientRef.deleteSite(args)
          throw new SitesError('EDGE_UNAVAILABLE', 'drop delete ACK after edge committed', 502, true)
        },
        async getSiteStatus() {
          throw new SitesError('EDGE_UNAVAILABLE', 'immediate probe also failed', 502, true)
        },
      },
    })
    await assert.rejects(
      () => dropOnceSvcA.deleteSite(1, 'shared-lost-delete'),
      (e: unknown) => e instanceof SitesError && e.code === 'EDGE_UNAVAILABLE',
    )
    // Instance B immediately claims the deleted slug BEFORE Instance A reconciles
    await svcB.publishSite(2, {
      slug: 'shared-lost-delete',
      gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>B_CLAIMED</h1>') }]).gzipped,
    })
    repoA.expireLease('shared-lost-delete')
    // Next read / publish on Instance A must reconcile A's pending delete via retired receipt & free maxPerUser=1 quota
    const listAfterLostDelete = await svcA.listSummary(1)
    assert.equal(listAfterLostDelete.sites.length, 0)
    const freshAfterQuotaFreed = await svcA.publishSite(1, {
      slug: 'shared-fresh-quota',
      gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>FRESH</h1>') }]).gzipped,
    })
    assert.equal(freshAfterQuotaFreed.slug, 'shared-fresh-quota')
    // Instance B's site stays intact
    const bServed = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'shared-lost-delete.congjianai.com',
    })
    assert.equal(bServed.status, 200)
    assert.match(bServed.text, /B_CLAIMED/)

    // 3. Rename must preserve both destination's and source's slug-anchored retired records
    const priorDst = await svcB.publishSite(2, {
      slug: 'shared-rename-dst',
      gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>PRIOR_DST</h1>') }]).gzipped,
    })
    await svcB.deleteSite(2, 'shared-rename-dst')
    const movedSite = await svcA.renameSite(1, 'shared-fresh-quota', 'shared-rename-dst')
    await svcA.renameSite(1, 'shared-rename-dst', 'shared-rename-dst2')
    // Stale replay for priorDst at shared-rename-dst must STILL be rejected after rename!
    await assert.rejects(
      () =>
        edgeClientRef.pushBundle({
          slug: 'shared-rename-dst',
          revision: priorDst.edgeRevision - 1,
          gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>STALE_DST</h1>') }]).gzipped,
          meta: {
            siteId: priorDst.id,
            title: 'stale-dst',
            visibility: 'public',
            passwordSalt: null,
            passwordHash: null,
            spaMode: true,
          },
        }),
      (e: unknown) => e instanceof SitesError && e.code === 'STALE_REVISION',
    )
    // And stale replay for movedSite at original slug shared-fresh-quota must STILL be rejected after dst -> dst2!
    await assert.rejects(
      () =>
        edgeClientRef.pushBundle({
          slug: 'shared-fresh-quota',
          revision: movedSite.edgeRevision - 1,
          gzippedBundle: encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>STALE_SRC</h1>') }]).gzipped,
          meta: {
            siteId: movedSite.id,
            title: 'stale-src',
            visibility: 'public',
            passwordSalt: null,
            passwordHash: null,
            spaMode: true,
          },
        }),
      (e: unknown) => e instanceof SitesError && e.code === 'STALE_REVISION',
    )
    await svcA.deleteSite(1, 'shared-rename-dst2')
    await svcB.deleteSite(2, 'shared-lost-delete')
  })

  test('audit B3/B4/B6 hardening: handler alias isolation, owner stale-baseline protection, and legacy-writer rollback guard', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'oc-sites-audit-hardening-'))
    const edgeDataDir = join(workDir, 'edge-data')
    const edgeSrv = createSitesEdgeServer({
      bind: '127.0.0.1',
      port: 0,
      dataRoot: edgeDataDir,
      baseDomain: 'congjianai.com',
      secret: EDGE_SECRET,
      maxSiteBytes: 2 * 1024 * 1024,
    })
    const { port: edgePort } = await edgeSrv.listen()
    const edgeClient = createHttpSitesEdgeClient({
      baseUrl: `http://127.0.0.1:${edgePort}`,
      secret: EDGE_SECRET,
    })
    const repo = createInMemorySitesRepo()
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 10,
      maxSiteBytes: 2 * 1024 * 1024,
      edgeSecret: EDGE_SECRET,
      repo,
      edge: edgeClient,
      resolveTxt: async () => [],
    })

    const sec1 = 'd1'.repeat(32)
    const sec2 = 'e2'.repeat(32)
    const tok1 = `oc-v3.401.${sec1}`
    const tok2 = `oc-v3.402.${sec2}`
    const h1 = hashSecret(sec1)
    const h2 = hashSecret(sec2)
    const idRepo: ContainerIdentityRepo = {
      async findActiveByHostAndBoundIp(hostUuid: string, boundIp: string) {
        if (boundIp === '10.0.1.1') {
          return { id: 401, user_id: 1, host_uuid: hostUuid, bound_ip: boundIp, secret_hash: h1 }
        }
        if (boundIp === '10.0.1.2') {
          return { id: 402, user_id: 2, host_uuid: hostUuid, bound_ip: boundIp, secret_hash: h2 }
        }
        return null
      },
    }
    const internalHandler = makeSitesInternalHandler({ identityRepo: idRepo, sites: svc })
    const masterSrv = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        if (pathname.startsWith('/internal/v3/sites/')) {
          const auth = req.headers.authorization ?? ''
          const boundIp = auth.includes(tok1) ? '10.0.1.1' : '10.0.1.2'
          await internalHandler(req, res, { hostUuid: 'h-audit', boundIp })
          return
        }
        res.statusCode = 404
        res.end('not found')
      })().catch((err: unknown) => {
        const e = err as { status?: number; code?: string; message?: string }
        res.statusCode = e.status ?? 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { code: e.code ?? 'INTERNAL', message: e.message ?? 'err' } }))
      })
    })
    await new Promise<void>((r) => masterSrv.listen(0, '127.0.0.1', () => r()))
    const mPort = (masterSrv.address() as { port: number }).port

    const runCli = (token: string, args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise) => {
        const child = spawn('python3', [OC_SITE_PY, ...args], {
          env: {
            ...process.env,
            OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${mPort}`,
            OPENCLAUDE_V3_CONTAINER_TOKEN: token,
          },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => (stdout += String(d)))
        child.stderr.on('data', (d) => (stderr += String(d)))
        child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }))
      })

    try {
      // B3: Raw static server/api.mjs and api/index.mjs are rejected at encoder & decoder boundaries
      assert.throws(
        () =>
          encodeSiteBundle([
            { path: 'index.html', content: Buffer.from('<h1>Hi</h1>') },
            { path: 'server/api.mjs', content: Buffer.from('export default () => ({ ok: 1 })') },
          ]),
        (e: unknown) => e instanceof SitesError && e.code === 'INVALID_BUNDLE',
      )
      const spoofRawBody = Buffer.concat([
        Buffer.from('OCSB1\n', 'ascii'),
        (() => {
          const fakeCode = Buffer.from('export default () => ({ ok: 1 })')
          const html = Buffer.from('<h1>Hi</h1>')
          const manifest = Buffer.from(
            JSON.stringify([
              {
                path: 'api/index.mjs',
                size: fakeCode.length,
                sha256: createHash('sha256').update(fakeCode).digest('hex'),
              },
              {
                path: 'index.html',
                size: html.length,
                sha256: createHash('sha256').update(html).digest('hex'),
              },
            ]),
          )
          const len = Buffer.allocUnsafe(4)
          len.writeUInt32BE(manifest.length, 0)
          return Buffer.concat([len, manifest, fakeCode, html])
        })(),
      ])
      const gzippedSpoof = gzipSync(spoofRawBody)
      assert.throws(
        () => decodeSiteBundle(gzippedSpoof),
        (e: unknown) => e instanceof SitesError && e.code === 'INVALID_BUNDLE',
      )

      // B3 CLI: conflicting multiple handler aliases fail closed instead of silently picking one
      const conflictDir = join(workDir, 'conflict-handlers')
      mkdirSync(join(conflictDir, 'server'), { recursive: true })
      mkdirSync(join(conflictDir, 'api'), { recursive: true })
      writeFileSync(join(conflictDir, 'index.html'), '<h1>Conflict</h1>')
      writeFileSync(join(conflictDir, 'server', 'api.mjs'), 'export default () => ({ s: 1 })')
      writeFileSync(join(conflictDir, 'api', 'index.mjs'), 'export default () => ({ s: 2 })')
      const pubConflict = await runCli(tok1, ['publish', conflictDir, '--slug', 'conflict-api-site'])
      assert.equal(pubConflict.code, 1)
      assert.match(pubConflict.stderr, /conflicting server api handler sources/)

      // B3 R2: case-approximate single-source file (e.g. Server/api.mjs in a legacy static dir) must fail closed and NEVER elevate into a backend handler
      const legacyStaticDir = join(workDir, 'legacy-static')
      mkdirSync(legacyStaticDir, { recursive: true })
      writeFileSync(join(legacyStaticDir, 'index.html'), '<h1>LEGACY_STATIC_V1</h1>')
      const pubLegacyV1 = await runCli(tok1, [
        'publish',
        legacyStaticDir,
        '--slug',
        'legacy-static-site',
        '--no-spa',
      ])
      assert.equal(pubLegacyV1.code, 0, pubLegacyV1.stderr)
      assert.equal(JSON.parse(pubLegacyV1.stdout).site.hasServerApi, false)
      mkdirSync(join(legacyStaticDir, 'Server'), { recursive: true })
      writeFileSync(
        join(legacyStaticDir, 'Server', 'api.mjs'),
        'export default async function(ctx) { return ctx.json({ leaked: true }) }',
      )
      const pubLegacyCaseApprox = await runCli(tok1, ['publish', legacyStaticDir, '--slug', 'legacy-static-site', '--no-spa'])
      assert.equal(pubLegacyCaseApprox.code, 1)
      assert.match(pubLegacyCaseApprox.stderr, /casing is ambiguous/)
      const legacyLiveRoot = await edgeHttpRequest({
        port: edgePort,
        path: '/',
        host: 'legacy-static-site.congjianai.com',
      })
      assert.equal(legacyLiveRoot.status, 200)
      assert.match(legacyLiveRoot.text, /LEGACY_STATIC_V1/)
      const legacyLiveApi = await edgeHttpRequest({
        port: edgePort,
        path: '/api/ping',
        host: 'legacy-static-site.congjianai.com',
      })
      assert.equal(legacyLiveApi.status, 404)
      assert.equal(legacyLiveApi.text.includes('leaked'), false)
      assert.equal((await svc.getSite(1, 'legacy-static-site')).hasServerApi, false)

      // B4 + B3 roundtrip: owner first publish saves .oc-site-state.json; editor edits; owner stale directory is blocked!
      const ownerOrigDir = join(workDir, 'owner-orig')
      mkdirSync(join(ownerOrigDir, 'server'), { recursive: true })
      writeFileSync(join(ownerOrigDir, 'index.html'), '<h1>OWNER_V1</h1>')
      writeFileSync(
        join(ownerOrigDir, 'server', 'api.mjs'),
        'export default async function handler() { return { status: 200, body: { h: "OWNER_A" } } }\n',
      )
      const pubOwner1 = await runCli(tok1, ['publish', ownerOrigDir, '--slug', 'audit-collab-site'])
      assert.equal(pubOwner1.code, 0, pubOwner1.stderr)
      const stateAfterPub1 = JSON.parse(readFileSync(join(ownerOrigDir, '.oc-site-state.json'), 'utf8')) as {
        slug: string
        edgeRevision: number
      }
      assert.equal(stateAfterPub1.slug, 'audit-collab-site')
      assert.ok(stateAfterPub1.edgeRevision >= 1)

      await svc.addCollaboratorByEmail(1, 'audit-collab-site', { email: 'editor@example.com', role: 'editor' })
      const editorDir = join(workDir, 'editor-work')
      const pullEd = await runCli(tok2, ['pull', 'audit-collab-site', editorDir])
      assert.equal(pullEd.code, 0, pullEd.stderr)
      writeFileSync(join(editorDir, 'index.html'), '<h1>EDITOR_LIVE_B</h1>')
      const pubEd = await runCli(tok2, ['publish', editorDir, '--slug', 'audit-collab-site'])
      assert.equal(pubEd.code, 0, pubEd.stderr)

      // Owner publishing again from stale original dir fails 409 STALE_REVISION -> editor content B preserved!
      writeFileSync(join(ownerOrigDir, 'index.html'), '<h1>OWNER_STALE_OVERWRITE</h1>')
      const pubOwnerStale = await runCli(tok1, ['publish', ownerOrigDir, '--slug', 'audit-collab-site'])
      assert.equal(pubOwnerStale.code, 1)
      assert.ok(pubOwnerStale.stderr.includes('STALE_REVISION'), pubOwnerStale.stderr)

      // Owner removing .oc-site-state.json without --force STILL fails 409 on collaborated site
      rmSync(join(ownerOrigDir, '.oc-site-state.json'))
      const pubOwnerNoState = await runCli(tok1, ['publish', ownerOrigDir, '--slug', 'audit-collab-site'])
      assert.equal(pubOwnerNoState.code, 1)
      assert.ok(pubOwnerNoState.stderr.includes('STALE_REVISION'), pubOwnerNoState.stderr)

      // Editor passing --force is rejected 403 FORBIDDEN; live site STILL shows EDITOR_LIVE_B!
      const pubEdForce = await runCli(tok2, ['publish', editorDir, '--slug', 'audit-collab-site', '--force'])
      assert.equal(pubEdForce.code, 1)
      assert.ok(pubEdForce.stderr.includes('FORBIDDEN'), pubEdForce.stderr)

      const liveBeforeForce = await edgeHttpRequest({
        port: edgePort,
        path: '/',
        host: 'audit-collab-site.congjianai.com',
      })
      assert.equal(liveBeforeForce.status, 200)
      assert.match(liveBeforeForce.text, /EDITOR_LIVE_B/)

      // Owner pulls latest, updates only frontend, republishes -> handler remains OWNER_A with identical SHA
      const ownerPulledDir = join(workDir, 'owner-pulled')
      const pullOw = await runCli(tok1, ['pull', 'audit-collab-site', ownerPulledDir])
      assert.equal(pullOw.code, 0, pullOw.stderr)
      writeFileSync(join(ownerPulledDir, 'index.html'), '<h1>OWNER_MERGED_V3</h1>')
      const pubOwMerged = await runCli(tok1, ['publish', ownerPulledDir, '--slug', 'audit-collab-site'])
      assert.equal(pubOwMerged.code, 0, pubOwMerged.stderr)
      const apiAfterOw = await edgeHttpRequest({
        port: edgePort,
        path: '/api/ping',
        host: 'audit-collab-site.congjianai.com',
      })
      assert.equal(apiAfterOw.status, 200)
      assert.deepEqual(JSON.parse(apiAfterOw.text), { h: 'OWNER_A' })

      // Owner --force intentionally overwrites from un-baselined dir when explicitly requested
      writeFileSync(join(ownerOrigDir, 'index.html'), '<h1>OWNER_FORCE_FINAL</h1>')
      const pubOwForce = await runCli(tok1, ['publish', ownerOrigDir, '--slug', 'audit-collab-site', '--force'])
      assert.equal(pubOwForce.code, 0, pubOwForce.stderr)
      const liveAfterForce = await edgeHttpRequest({
        port: edgePort,
        path: '/',
        host: 'audit-collab-site.congjianai.com',
      })
      assert.match(liveAfterForce.text, /OWNER_FORCE_FINAL/)

      // B6: Legacy master rollback overwrite of __oc_server/api.mjs -> editor cannot revert to stale A OR run unconfirmed B until owner re-publishes
      const handlerACode = 'export default async function handler() { return { status: 200, body: { h: "A" } } }\n'
      const handlerBCode = 'export default async function handler() { return { status: 200, body: { h: "B" } } }\n'
      const b6Init = await svc.publishSite(1, {
        slug: 'b6-rollback-site',
        gzippedBundle: encodeSiteBundle([
          { path: 'index.html', content: Buffer.from('<h1>B6_A</h1>') },
          { path: '__oc_server/api.mjs', content: Buffer.from(handlerACode) },
        ]).gzipped,
      })
      await svc.addCollaboratorByEmail(1, 'b6-rollback-site', { email: 'editor@example.com', role: 'editor' })

      // Simulate legacy master rollback publishing handler B directly to Edge + PG without updating serverApiSha256 (still sha(A))
      const bundleB = encodeSiteBundle([
        { path: 'index.html', content: Buffer.from('<h1>B6_LEGACY_B</h1>') },
        { path: '__oc_server/api.mjs', content: Buffer.from(handlerBCode) },
      ])
      const alignedLegacy = repo.simulateLegacyMasterPublish('b6-rollback-site', {
        hasServerApi: true,
        contentSha256: bundleB.contentSha256,
      })
      await edgeClient.pushBundle({
        slug: 'b6-rollback-site',
        revision: alignedLegacy.edgeRevision,
        gzippedBundle: bundleB.gzipped,
        hasServerApi: true,
        meta: {
          siteId: b6Init.id,
          title: 'b6-rollback-site',
          visibility: 'public',
          passwordSalt: null,
          passwordHash: null,
          spaMode: true,
          hasServerApi: true,
          contentSha256: bundleB.contentSha256,
        },
      })

      // Editor trying to restore old A using current Edge/PG base MUST be rejected 403! Edge MUST keep B!
      await assert.rejects(
        () =>
          svc.publishSite(2, {
            slug: 'b6-rollback-site',
            expectedSiteId: alignedLegacy.id,
            expectedBaseRevision: alignedLegacy.edgeRevision,
            expectedBaseContentSha256: alignedLegacy.contentSha256,
            gzippedBundle: encodeSiteBundle([
              { path: 'index.html', content: Buffer.from('<h1>EDITOR_REVERT_TO_A</h1>') },
              { path: '__oc_server/api.mjs', content: Buffer.from(handlerACode) },
            ]).gzipped,
          }),
        (e: unknown) => e instanceof SitesError && e.code === 'FORBIDDEN' && e.status === 403,
      )
      // Editor carrying new handler B before owner re-confirms on new master MUST ALSO fail closed 403!
      await assert.rejects(
        () =>
          svc.publishSite(2, {
            slug: 'b6-rollback-site',
            expectedSiteId: alignedLegacy.id,
            expectedBaseRevision: alignedLegacy.edgeRevision,
            expectedBaseContentSha256: alignedLegacy.contentSha256,
            gzippedBundle: encodeSiteBundle([
              { path: 'index.html', content: Buffer.from('<h1>EDITOR_WITH_UNCONFIRMED_B</h1>') },
              { path: '__oc_server/api.mjs', content: Buffer.from(handlerBCode) },
            ]).gzipped,
          }),
        (e: unknown) => e instanceof SitesError && e.code === 'FORBIDDEN' && e.status === 403,
      )
      // Handler B stays live on Edge untouched
      const apiB = await edgeHttpRequest({
        port: edgePort,
        path: '/api/ping',
        host: 'b6-rollback-site.congjianai.com',
      })
      assert.deepEqual(JSON.parse(apiB.text), { h: 'B' })

      // After owner re-publishes B on new master, editor static update keeping B succeeds!
      const ownerReconfirm = await svc.publishSite(1, {
        slug: 'b6-rollback-site',
        expectedBaseRevision: alignedLegacy.edgeRevision,
        gzippedBundle: bundleB.gzipped,
      })
      const editorAfterReconfirm = await svc.publishSite(2, {
        slug: 'b6-rollback-site',
        expectedSiteId: ownerReconfirm.id,
        expectedBaseRevision: ownerReconfirm.edgeRevision,
        expectedBaseContentSha256: ownerReconfirm.contentSha256,
        gzippedBundle: encodeSiteBundle([
          { path: 'index.html', content: Buffer.from('<h1>EDITOR_AFTER_OWNER_CONFIRM</h1>') },
          { path: '__oc_server/api.mjs', content: Buffer.from(handlerBCode) },
        ]).gzipped,
      })
      assert.equal(editorAfterReconfirm.accessRole, 'editor')
    } finally {
      await new Promise<void>((r) => masterSrv.close(() => r()))
      await edgeSrv.close()
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
