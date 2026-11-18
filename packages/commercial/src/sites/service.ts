import type { SitesEdgeClient } from './edgeClient.js'
import type { SitesRepo } from './repo.js'
import {
  DEFAULT_SITE_MAX_PER_USER,
  DEFAULT_SITE_MAX_TOTAL_BYTES,
  type EdgeMetaEnvelope,
  type SiteVisibility,
  SitesError,
  type UserSiteDto,
  type UserSiteRow,
  decodeSiteBundle,
  generateRandomSiteSlug,
  hashSitePassword,
  normalizeSiteTitle,
  parseSiteVisibility,
  toUserSiteDto,
  validateSitePasswordInput,
  validateSiteSlug,
} from './types.js'

export interface SitesServiceConfig {
  enabled: boolean
  baseDomain: string
  maxPerUser?: number
  maxSiteBytes?: number
  repo?: SitesRepo
  edge?: SitesEdgeClient
}

export interface PublishSiteInput {
  slug?: string
  title?: string
  visibility?: SiteVisibility
  password?: string
  spaMode?: boolean
  gzippedBundle: Buffer
}

export interface UpdateSiteInput {
  title?: string
  visibility?: SiteVisibility
  password?: string
  spaMode?: boolean
}

export interface SitesSummaryResponse {
  enabled: boolean
  baseDomain: string
  maxPerUser: number
  maxSiteBytes: number
  sites: UserSiteDto[]
}

export class SitesService {
  readonly enabled: boolean
  readonly baseDomain: string
  readonly maxPerUser: number
  readonly maxSiteBytes: number
  private readonly repo?: SitesRepo
  private readonly edge?: SitesEdgeClient
  private readonly slugLocks = new Map<string, Promise<void>>()

  constructor(cfg: SitesServiceConfig) {
    this.enabled = cfg.enabled
    this.baseDomain = cfg.baseDomain
    this.maxPerUser = cfg.maxPerUser ?? DEFAULT_SITE_MAX_PER_USER
    this.maxSiteBytes = cfg.maxSiteBytes ?? DEFAULT_SITE_MAX_TOTAL_BYTES
    this.repo = cfg.repo
    this.edge = cfg.edge
  }

  private async withSlugLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.slugLocks.get(slug) ?? Promise.resolve()
    let release!: () => void
    const cur = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prev.then(
      () => cur,
      () => cur,
    )
    this.slugLocks.set(slug, tail)
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.slugLocks.get(slug) === tail) {
        this.slugLocks.delete(slug)
      }
    }
  }

  private requireReady(): { repo: SitesRepo; edge: SitesEdgeClient } {
    if (!this.enabled || !this.repo || !this.edge) {
      throw new SitesError('SITES_DISABLED', '持久化站点托管功能尚未开启', 503)
    }
    return { repo: this.repo, edge: this.edge }
  }

  private async reconcilePendingByUser(userId: number): Promise<void> {
    if (!this.enabled || !this.repo || !this.edge) return
    const { repo, edge } = { repo: this.repo, edge: this.edge }
    const pending = await repo.listUnleasedPlaceholdersByUser(userId)
    if (pending.length === 0) return
    for (const row of pending) {
      await this.withSlugLock(row.slug, async () => {
        try {
          const status = await edge.getSiteStatus({ slug: row.slug })
          if (status.exists && status.revision > 0 && status.meta) {
            await repo.promoteUnleasedPlaceholder({
              siteId: row.id,
              userId,
              title: status.meta.title,
              visibility: status.meta.visibility,
              passwordSalt: status.meta.passwordSalt,
              passwordHash: status.meta.passwordHash,
              spaMode: status.meta.spaMode,
              fileCount: status.meta.fileCount,
              sizeBytes: status.meta.sizeBytes,
              contentSha256: status.meta.contentSha256,
              edgeRevision: status.revision,
            })
          } else if (!status.exists) {
            await repo.deleteUnleasedPlaceholder(row.id, userId)
          }
        } catch {
          // Edge still unreachable: retain unleased placeholder so quota and ownership remain reserved until next check.
        }
      })
    }
  }

  async listSummary(userId: number): Promise<SitesSummaryResponse> {
    if (!this.enabled || !this.repo) {
      return {
        enabled: false,
        baseDomain: this.baseDomain,
        maxPerUser: this.maxPerUser,
        maxSiteBytes: this.maxSiteBytes,
        sites: [],
      }
    }
    await this.reconcilePendingByUser(userId)
    const rows = await this.repo.listByUser(userId)
    return {
      enabled: true,
      baseDomain: this.baseDomain,
      maxPerUser: this.maxPerUser,
      maxSiteBytes: this.maxSiteBytes,
      sites: rows.map((r) => toUserSiteDto(r, this.baseDomain)),
    }
  }

  async getSite(userId: number, rawSlug: string): Promise<UserSiteDto> {
    const { repo } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    return toUserSiteDto(row, this.baseDomain)
  }

  async publishSite(userId: number, input: PublishSiteInput): Promise<UserSiteDto> {
    const { repo, edge } = this.requireReady()
    const decoded = decodeSiteBundle(input.gzippedBundle, this.maxSiteBytes)

    const requestedVisibility =
      input.visibility !== undefined ? parseSiteVisibility(input.visibility) : undefined
    if (input.password !== undefined) {
      validateSitePasswordInput(input.password)
    }

    const explicitSlug =
      input.slug !== undefined && input.slug.trim() !== '' ? validateSiteSlug(input.slug) : null

    await this.reconcilePendingByUser(userId)

    const attemptPublish = (slug: string): Promise<UserSiteRow> =>
      this.withSlugLock(slug, async () => {
        const preHint = await repo.getByUserAndSlug(userId, slug)
        const hintVisibility: SiteVisibility = requestedVisibility ?? preHint?.visibility ?? 'public'
        const hintTitle =
          input.title !== undefined
            ? normalizeSiteTitle(input.title, slug)
            : preHint?.title || slug
        const hintSpaMode =
          input.spaMode !== undefined ? Boolean(input.spaMode) : (preHint?.spaMode ?? true)

        let preSalt: string | null = null
        let preHash: string | null = null
        if (hintVisibility === 'password') {
          if (input.password !== undefined) {
            const hashed = hashSitePassword(input.password)
            preSalt = hashed.salt
            preHash = hashed.hash
          } else if (
            preHint?.visibility === 'password' &&
            preHint.passwordSalt &&
            preHint.passwordHash
          ) {
            preSalt = preHint.passwordSalt
            preHash = preHint.passwordHash
          } else {
            throw new SitesError('PASSWORD_REQUIRED', '口令保护模式需要设置 4–128 位访问口令', 400)
          }
        }

        const reservation = await repo.beginPublishReservation({
          userId,
          slug,
          title: hintTitle,
          visibility: hintVisibility,
          passwordSalt: preSalt,
          passwordHash: preHash,
          spaMode: hintSpaMode,
          maxPerUser: this.maxPerUser,
        })

        const lockedExisting = reservation.existing
        const finalVisibility: SiteVisibility =
          requestedVisibility ?? lockedExisting?.visibility ?? 'public'
        let finalSalt = preSalt
        let finalHash = preHash
        if (finalVisibility === 'password' && input.password === undefined) {
          if (lockedExisting?.passwordSalt && lockedExisting.passwordHash) {
            finalSalt = lockedExisting.passwordSalt
            finalHash = lockedExisting.passwordHash
          } else if (!finalSalt || !finalHash) {
            if (reservation.isNewPlaceholder) {
              await repo.abortPublishPlaceholder(reservation.siteId, userId, reservation.leaseId)
            } else {
              await repo.releaseLease(reservation.siteId, userId, reservation.leaseId)
            }
            throw new SitesError('PASSWORD_REQUIRED', '口令保护模式需要设置 4–128 位访问口令', 400)
          }
        } else if (finalVisibility !== 'password') {
          finalSalt = null
          finalHash = null
        }

        const finalTitle =
          input.title !== undefined
            ? normalizeSiteTitle(input.title, slug)
            : lockedExisting?.title || hintTitle
        const finalSpa =
          input.spaMode !== undefined
            ? Boolean(input.spaMode)
            : (lockedExisting?.spaMode ?? hintSpaMode)

        const meta: EdgeMetaEnvelope = {
          title: finalTitle,
          visibility: finalVisibility,
          passwordSalt: finalSalt,
          passwordHash: finalHash,
          spaMode: finalSpa,
          contentSha256: decoded.contentSha256,
          expectedBaseRevision: reservation.baseRevision,
        }

        let committedOnEdge = false
        try {
          await edge.pushBundle({
            slug,
            revision: reservation.edgeRevision,
            gzippedBundle: input.gzippedBundle,
            meta,
          })
          committedOnEdge = true
        } catch (err) {
          if (err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE') {
            // Transport drop/timeout has ambiguous outcome: probe Edge status before touching placeholder.
            try {
              const status = await edge.getSiteStatus({ slug })
              if (status.exists && status.revision === reservation.edgeRevision) {
                committedOnEdge = true
              } else if (status.revision < reservation.edgeRevision) {
                if (reservation.isNewPlaceholder) {
                  await repo
                    .abortPublishPlaceholder(reservation.siteId, userId, reservation.leaseId)
                    .catch(() => {})
                } else {
                  await repo.releaseLease(reservation.siteId, userId, reservation.leaseId).catch(() => {})
                }
              } else {
                await repo.releaseLease(reservation.siteId, userId, reservation.leaseId).catch(() => {})
              }
            } catch {
              // Edge unreachable even for probe: clear lease on existing site or keep unleased placeholder
              // owned by userId so another tenant cannot grab a potentially-live Edge slug (B3).
              await repo.releaseLease(reservation.siteId, userId, reservation.leaseId).catch(() => {})
            }
          } else {
            if (reservation.isNewPlaceholder && !(err instanceof SitesError && err.code === 'STALE_REVISION')) {
              await repo
                .abortPublishPlaceholder(reservation.siteId, userId, reservation.leaseId)
                .catch(() => {})
            } else {
              await repo.releaseLease(reservation.siteId, userId, reservation.leaseId).catch(() => {})
            }
          }
          if (!committedOnEdge) throw err
        }

        return repo.commitPublish({
          siteId: reservation.siteId,
          userId,
          leaseId: reservation.leaseId,
          title: finalTitle,
          visibility: finalVisibility,
          passwordSalt: finalSalt,
          passwordHash: finalHash,
          spaMode: finalSpa,
          fileCount: decoded.fileCount,
          sizeBytes: decoded.sizeBytes,
          contentSha256: decoded.contentSha256,
          edgeRevision: reservation.edgeRevision,
        })
      })

    if (explicitSlug) {
      const row = await attemptPublish(explicitSlug)
      return toUserSiteDto(row, this.baseDomain)
    }

    for (let i = 0; i < 3; i++) {
      const candidate = generateRandomSiteSlug()
      try {
        const row = await attemptPublish(candidate)
        return toUserSiteDto(row, this.baseDomain)
      } catch (err) {
        if (err instanceof SitesError && err.code === 'SLUG_TAKEN' && i < 2) continue
        throw err
      }
    }
    throw new SitesError('SLUG_TAKEN', '随机站点名冲突，请重试或手动指定 --slug', 409)
  }

  async updateSite(userId: number, rawSlug: string, patch: UpdateSiteInput): Promise<UserSiteDto> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    if (
      patch.title === undefined &&
      patch.visibility === undefined &&
      patch.password === undefined &&
      patch.spaMode === undefined
    ) {
      throw new SitesError('INVALID_INPUT', '没有需要更新的字段', 400)
    }
    if (patch.password !== undefined) {
      validateSitePasswordInput(patch.password)
    }
    const requestedVisibility =
      patch.visibility !== undefined ? parseSiteVisibility(patch.visibility) : undefined

    await this.reconcilePendingByUser(userId)

    const row = await this.withSlugLock(slug, async () => {
      const { site, leaseId, nextRevision } = await repo.prepareMetaUpdate(userId, slug)

      const nextVisibility: SiteVisibility = requestedVisibility ?? site.visibility
      const nextTitle =
        patch.title !== undefined ? normalizeSiteTitle(patch.title, slug) : site.title
      const nextSpaMode = patch.spaMode !== undefined ? Boolean(patch.spaMode) : site.spaMode

      let nextSalt: string | null = null
      let nextHash: string | null = null
      if (nextVisibility === 'password') {
        if (patch.password !== undefined) {
          const hashed = hashSitePassword(patch.password)
          nextSalt = hashed.salt
          nextHash = hashed.hash
        } else if (site.passwordSalt && site.passwordHash) {
          nextSalt = site.passwordSalt
          nextHash = site.passwordHash
        } else {
          await repo.releaseLease(site.id, userId, leaseId).catch(() => {})
          throw new SitesError(
            'PASSWORD_REQUIRED',
            '切换到口令保护模式需要设置 4–128 位访问口令',
            400,
          )
        }
      }

      const meta: EdgeMetaEnvelope = {
        title: nextTitle,
        visibility: nextVisibility,
        passwordSalt: nextSalt,
        passwordHash: nextHash,
        spaMode: nextSpaMode,
        contentSha256: site.contentSha256,
        expectedBaseRevision: site.edgeRevision,
      }

      let committedOnEdge = false
      try {
        await edge.updateMeta({ slug, revision: nextRevision, meta })
        committedOnEdge = true
      } catch (err) {
        if (err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE') {
          try {
            const status = await edge.getSiteStatus({ slug })
            if (status.exists && status.revision === nextRevision) {
              committedOnEdge = true
            }
          } catch {
            /* keep committedOnEdge=false and release lease */
          }
        }
        if (!committedOnEdge) {
          await repo.releaseLease(site.id, userId, leaseId).catch(() => {})
          throw err
        }
      }

      return repo.commitMetaUpdate({
        siteId: site.id,
        userId,
        leaseId,
        title: nextTitle,
        visibility: nextVisibility,
        passwordSalt: nextSalt,
        passwordHash: nextHash,
        spaMode: nextSpaMode,
        edgeRevision: nextRevision,
      })
    })
    return toUserSiteDto(row, this.baseDomain)
  }

  async deleteSite(userId: number, rawSlug: string): Promise<{ ok: true; slug: string }> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    await this.withSlugLock(slug, async () => {
      const { site, leaseId, deleteRevision } = await repo.prepareDelete(userId, slug)
      let deletedOnEdge = false
      try {
        await edge.deleteSite({ slug, revision: deleteRevision })
        deletedOnEdge = true
      } catch (err) {
        if (err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE') {
          try {
            const status = await edge.getSiteStatus({ slug })
            if (!status.exists && status.tombstoneRevision >= deleteRevision) {
              deletedOnEdge = true
            }
          } catch {
            /* keep deletedOnEdge=false and release lease */
          }
        }
        if (!deletedOnEdge) {
          await repo.releaseLease(site.id, userId, leaseId).catch(() => {})
          throw err
        }
      }
      await repo.commitDelete(site.id, userId, leaseId, deleteRevision)
    })
    return { ok: true, slug }
  }
}
