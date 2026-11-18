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

  constructor(cfg: SitesServiceConfig) {
    this.enabled = cfg.enabled
    this.baseDomain = cfg.baseDomain
    this.maxPerUser = cfg.maxPerUser ?? DEFAULT_SITE_MAX_PER_USER
    this.maxSiteBytes = cfg.maxSiteBytes ?? DEFAULT_SITE_MAX_TOTAL_BYTES
    this.repo = cfg.repo
    this.edge = cfg.edge
  }

  private requireReady(): { repo: SitesRepo; edge: SitesEdgeClient } {
    if (!this.enabled || !this.repo || !this.edge) {
      throw new SitesError('SITES_DISABLED', '持久化站点托管功能尚未开启', 503)
    }
    return { repo: this.repo, edge: this.edge }
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

    const attemptPublish = async (slug: string): Promise<UserSiteRow> => {
      const existingBefore = await repo.getByUserAndSlug(userId, slug)
      const visibility: SiteVisibility =
        requestedVisibility ?? existingBefore?.visibility ?? 'public'
      const title =
        input.title !== undefined
          ? normalizeSiteTitle(input.title, slug)
          : existingBefore?.title || slug
      const spaMode =
        input.spaMode !== undefined
          ? Boolean(input.spaMode)
          : existingBefore?.spaMode ?? true

      let passwordSalt: string | null = null
      let passwordHash: string | null = null
      if (visibility === 'password') {
        if (input.password !== undefined) {
          const hashed = hashSitePassword(input.password)
          passwordSalt = hashed.salt
          passwordHash = hashed.hash
        } else if (
          existingBefore?.visibility === 'password' &&
          existingBefore.passwordSalt &&
          existingBefore.passwordHash
        ) {
          passwordSalt = existingBefore.passwordSalt
          passwordHash = existingBefore.passwordHash
        } else {
          throw new SitesError('PASSWORD_REQUIRED', '口令保护模式需要设置 4–128 位访问口令', 400)
        }
      }

      const reservation = await repo.beginPublishReservation({
        userId,
        slug,
        title,
        visibility,
        passwordSalt,
        passwordHash,
        spaMode,
        maxPerUser: this.maxPerUser,
      })

      // Recompute credentials against locked row if an update raced with initial lookup.
      const lockedExisting = reservation.existing
      let finalSalt = passwordSalt
      let finalHash = passwordHash
      let finalVisibility = visibility
      if (requestedVisibility === undefined && lockedExisting) {
        finalVisibility = lockedExisting.visibility
      }
      if (finalVisibility === 'password' && input.password === undefined) {
        if (lockedExisting?.passwordSalt && lockedExisting.passwordHash) {
          finalSalt = lockedExisting.passwordSalt
          finalHash = lockedExisting.passwordHash
        } else if (!finalSalt || !finalHash) {
          if (reservation.isNewPlaceholder) {
            await repo.abortPublishPlaceholder(reservation.siteId, userId)
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
          : lockedExisting?.title || title
      const finalSpa =
        input.spaMode !== undefined
          ? Boolean(input.spaMode)
          : lockedExisting?.spaMode ?? spaMode

      const meta: EdgeMetaEnvelope = {
        title: finalTitle,
        visibility: finalVisibility,
        passwordSalt: finalSalt,
        passwordHash: finalHash,
        spaMode: finalSpa,
        contentSha256: decoded.contentSha256,
      }

      try {
        await edge.pushBundle({
          slug,
          revision: reservation.edgeRevision,
          gzippedBundle: input.gzippedBundle,
          meta,
        })
      } catch (err) {
        if (reservation.isNewPlaceholder) {
          await repo.abortPublishPlaceholder(reservation.siteId, userId).catch(() => {})
        }
        throw err
      }

      return repo.commitPublish({
        siteId: reservation.siteId,
        userId,
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
    }

    if (explicitSlug) {
      const row = await attemptPublish(explicitSlug)
      return toUserSiteDto(row, this.baseDomain)
    }

    // Auto-generated slug: retry up to 3 times on unlikely collision.
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

    const { site, nextRevision } = await repo.prepareMetaUpdate(userId, slug)

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
        throw new SitesError('PASSWORD_REQUIRED', '切换到口令保护模式需要设置 4–128 位访问口令', 400)
      }
    }

    const meta: EdgeMetaEnvelope = {
      title: nextTitle,
      visibility: nextVisibility,
      passwordSalt: nextSalt,
      passwordHash: nextHash,
      spaMode: nextSpaMode,
      contentSha256: site.contentSha256,
    }

    await edge.updateMeta({ slug, revision: nextRevision, meta })

    const updated = await repo.commitMetaUpdate({
      siteId: site.id,
      userId,
      title: nextTitle,
      visibility: nextVisibility,
      passwordSalt: nextSalt,
      passwordHash: nextHash,
      spaMode: nextSpaMode,
      edgeRevision: nextRevision,
    })
    return toUserSiteDto(updated, this.baseDomain)
  }

  async deleteSite(userId: number, rawSlug: string): Promise<{ ok: true; slug: string }> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    const { site, deleteRevision } = await repo.prepareDelete(userId, slug)
    await edge.deleteSite({ slug, revision: deleteRevision })
    await repo.commitDelete(site.id, userId)
    return { ok: true, slug }
  }
}
