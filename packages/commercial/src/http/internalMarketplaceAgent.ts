/**
 * /internal/v3/marketplace/agent/* — container-reachable marketplace ops for the
 * in-container AI (the `market` baseline skill / `oc-market` CLI calls these).
 *
 * Auth: verifyContainerIdentity (container token, same as the sync endpoint), so
 * every op is scoped to the CONTAINER'S OWN user — an agent can never touch
 * another user's installs/listings. Security envelope (boss-approved full access):
 *   - search / detail / installed : read-only over the APPROVED+ACTIVE catalog.
 *   - install                     : only an approved+active version (admin-vetted
 *                                   content), pinned; agents bring deps along.
 *   - uninstall                   : soft-uninstall of the user's own install.
 *   - publish                     : goes to PENDING (admin review before it ever
 *                                   goes live) + the same static scanner that
 *                                   blocks secrets/injection. So an agent can
 *                                   NEVER make content live or bypass review; the
 *                                   worst case is a queued, scanner-passed draft.
 *
 * This complements (does NOT replace) the browser-only /api/marketplace/* routes:
 * the browser path remains for humans (with the SKILL.md confirm dialog); this
 * path lets the AI act on the user's behalf within the same vetting guarantees.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { marketplaceArtifactHash, skillContentHash } from '@openclaude/storage'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import {
  VETTED_AGENT_TOOLSETS,
  canonicalizeAgentManifest,
  validateAgentManifest,
} from '../marketplace/agentManifest.js'
import {
  MarketplaceError,
  getApprovedSkillVersions,
  getListingDetail,
  installApprovedVersion,
  listInstalled,
  marketplaceAgentsEnabled,
  publishSkillVersion,
  recordUninstall,
} from '../marketplace/marketplaceDb.js'
import { listMarketBrowseCatalog } from '../marketplace/platformPresets.js'
import { scanSkillArtifact } from '../marketplace/skillScanner.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export const MARKETPLACE_AGENT_PREFIX = '/internal/v3/marketplace/agent/'

export interface MarketplaceAgentCtx {
  hostUuid: string
  boundIp: string
}
export type MarketplaceAgentHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: MarketplaceAgentCtx,
) => Promise<void>

export interface MarketplaceAgentDeps {
  identityRepo: ContainerIdentityRepo
  /** v5 public model ids (for agent-manifest model gating); fail-closed if absent. */
  listPublicModels?: () => Array<{ id: string }>
  logger?: Logger
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const MAX_BODY = 64 * 1024
// Identical to the browser publish route (marketplaceRoutes.ts): tags become a YAML
// inline array in the canonical SKILL.md; reject any char that could break/inject it.
const TAG_SAFE_RE = /^[^,[\]"'<>\r\n]{1,64}$/

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ ...(body as object), requestId }))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    total += (c as Buffer).length
    if (total > MAX_BODY + 4096) throw new Error('body too large')
    chunks.push(c as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('invalid JSON')
  }
}

function asStr(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
}
/** Same gate as the browser route: trim, reject YAML-unsafe chars (throws 'bad tag'). */
function asTags(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Error('bad tag')
  const out: string[] = []
  for (const t of v) {
    if (typeof t !== 'string') throw new Error('bad tag')
    const tag = t.trim()
    if (!tag) continue
    if (!TAG_SAFE_RE.test(tag)) throw new Error('bad tag')
    out.push(tag)
  }
  return out.slice(0, 16)
}

function statusForMarketplaceError(code: string): number {
  if (code === 'SLUG_OWNED_BY_OTHER') return 403
  if (
    code === 'DUPLICATE_VERSION' ||
    code === 'LISTING_REVOKED' ||
    code === 'KIND_MISMATCH' ||
    code === 'INSTALL_CONFLICT'
  )
    return 409
  if (code === 'NOT_INSTALLABLE' || code === 'VERSION_NOT_FOUND') return 404
  return 400
}

export function makeMarketplaceAgentHandler(deps: MarketplaceAgentDeps): MarketplaceAgentHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalMarketplaceAgent' })
  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        send(
          res,
          401,
          { error: { code: 'UNAUTHORIZED', message: 'identity verification failed' } },
          requestId,
        )
        return
      }
      throw err
    }
    const userId = identity.userId
    const url = new URL(req.url ?? '/', 'http://internal')
    const op = url.pathname.slice(MARKETPLACE_AGENT_PREFIX.length).replace(/\/+$/, '')

    try {
      // ── read-only ──
      if (req.method === 'GET' && op === 'search') {
        const kindParam = url.searchParams.get('kind')
        if (kindParam !== null && kindParam !== 'skill' && kindParam !== 'agent') {
          send(res, 200, { results: [] }, requestId)
          return
        }
        // 无 kind → 默认 'skill';agent 类仅 v5(v3 容器无对应能力,装了即坏)。
        const kind = kindParam === 'agent' ? 'agent' : 'skill'
        if (kind === 'agent' && !marketplaceAgentsEnabled()) {
          send(res, 200, { results: [] }, requestId)
          return
        }
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 200)
        const limit = Math.min(
          Math.max(Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1),
          50,
        )
        // 平台预设 agent 不在市场搜索里露出(与浏览器 /api/marketplace/search 同一权威)。
        const catalog = await listMarketBrowseCatalog(kind)
        const filtered = q
          ? catalog.filter(
              (c) =>
                c.name.toLowerCase().includes(q) ||
                c.description.toLowerCase().includes(q) ||
                c.tags.some((t) => t.toLowerCase().includes(q)),
            )
          : catalog
        send(
          res,
          200,
          {
            results: filtered
              .slice(0, limit)
              .map((c) => ({
                slug: c.slug,
                kind: c.kind,
                name: c.name,
                description: c.description,
                tags: c.tags,
              })),
          },
          requestId,
        )
        return
      }
      if (req.method === 'GET' && op === 'detail') {
        const slug = url.searchParams.get('slug') ?? ''
        if (!SLUG_RE.test(slug)) return send(res, 400, { error: { code: 'BAD_SLUG' } }, requestId)
        const detail = await getListingDetail(slug)
        // agent 类仅 v5 露出:v3 渠道视同不存在(防 slug→detail→versionId 旁路装坏 agent)。
        if (!detail || (detail.kind === 'agent' && !marketplaceAgentsEnabled()))
          return send(
            res,
            404,
            { error: { code: 'NOT_FOUND', message: '未上架或不存在' } },
            requestId,
          )
        send(res, 200, { detail }, requestId)
        return
      }
      if (req.method === 'GET' && op === 'installed') {
        send(res, 200, { installed: await listInstalled(userId) }, requestId)
        return
      }

      // ── mutations (own user only) ──
      if (req.method === 'POST' && op === 'install') {
        const body = await readBody(req)
        const slug = asStr(body.slug, 64)
        if (!slug || !SLUG_RE.test(slug))
          return send(res, 400, { error: { code: 'BAD_SLUG' } }, requestId)
        const detail = await getListingDetail(slug)
        if (!detail)
          return send(
            res,
            404,
            { error: { code: 'NOT_INSTALLABLE', message: '未上架或不存在' } },
            requestId,
          )
        const v = await installApprovedVersion({
          userId,
          versionId: detail.versionId,
          scopeMode: 'preserve',
        })
        let installedDeps = 0
        if (detail.kind === 'agent') {
          const depSlugs = Array.isArray((detail.manifest as { skillDeps?: unknown })?.skillDeps)
            ? ((detail.manifest as { skillDeps: unknown[] }).skillDeps.filter(
                (s) => typeof s === 'string',
              ) as string[])
            : []
          if (depSlugs.length > 0) {
            const versions = await getApprovedSkillVersions(depSlugs)
            for (const depVid of versions.values()) {
              try {
                await installApprovedVersion({
                  userId,
                  versionId: depVid,
                  agentIds: [v.slug],
                  scopeMode: 'merge',
                })
                installedDeps++
              } catch {
                /* skip a single failing dep */
              }
            }
          }
        }
        send(
          res,
          200,
          { ok: true, slug: v.slug, kind: detail.kind, version: v.version, installedDeps },
          requestId,
        )
        return
      }
      if (req.method === 'POST' && op === 'uninstall') {
        const body = await readBody(req)
        const slug = asStr(body.slug, 64)
        if (!slug || !SLUG_RE.test(slug))
          return send(res, 400, { error: { code: 'BAD_SLUG' } }, requestId)
        send(res, 200, { ok: await recordUninstall(userId, slug) }, requestId)
        return
      }
      if (req.method === 'POST' && op === 'publish') {
        await handlePublish(req, res, requestId, userId, deps)
        return
      }

      send(
        res,
        404,
        { error: { code: 'NOT_FOUND', message: 'unknown marketplace agent op' } },
        requestId,
      )
    } catch (err) {
      if (err instanceof MarketplaceError) {
        send(
          res,
          statusForMarketplaceError(err.code),
          { error: { code: err.code, message: err.message } },
          requestId,
        )
        return
      }
      const msg = err instanceof Error ? err.message : 'error'
      if (msg === 'invalid JSON' || msg === 'body too large') {
        send(res, 400, { error: { code: 'BAD_REQUEST', message: msg } }, requestId)
        return
      }
      if (msg === 'bad tag') {
        send(res, 400, { error: { code: 'BAD_TAG', message: 'tag 含非法字符' } }, requestId)
        return
      }
      log.child({ requestId, uid: userId }).error('marketplace_agent_failed', { err: err as Error })
      send(res, 500, { error: { code: 'INTERNAL', message: 'marketplace op failed' } }, requestId)
    }
  }
}

/** Publish a skill OR agent on the user's behalf → PENDING (admin review) + static scan. */
async function handlePublish(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  userId: number,
  deps: MarketplaceAgentDeps,
): Promise<void> {
  const body = await readBody(req)
  const kind = body.kind === 'agent' ? 'agent' : 'skill'
  const slug = asStr(body.slug, 64)
  if (!slug || !SLUG_RE.test(slug))
    return send(res, 400, { error: { code: 'BAD_SLUG' } }, requestId)
  const version = asStr(body.version, 16)
  if (!version || !VERSION_RE.test(version))
    return send(res, 400, { error: { code: 'BAD_VERSION' } }, requestId)
  const name = asStr(body.name, 64)
  const description = asStr(body.description, 1024)
  if (!name || !description)
    return send(
      res,
      400,
      { error: { code: 'BAD_REQUEST', message: 'name/description required' } },
      requestId,
    )
  const tags = asTags(body.tags)

  if (kind === 'skill') {
    const skillBody = asStr(body.body, MAX_BODY)
    if (!skillBody)
      return send(res, 400, { error: { code: 'BAD_REQUEST', message: 'body required' } }, requestId)
    const scan = scanSkillArtifact({ name, description, tags, body: skillBody })
    if (scan.blocked)
      return send(
        res,
        422,
        { error: { code: 'SCAN_BLOCKED', message: '被静态扫描拦截' }, riskFlags: scan.flags },
        requestId,
      )
    const fm = [
      '---',
      `name: ${slug}`,
      `description: ${JSON.stringify(description)}`,
      ...(tags.length ? [`tags: [${tags.join(', ')}]`] : []),
      `version: ${version}`,
      '---',
      '',
    ].join('\n')
    const rawSkillMd = `${fm + skillBody.replace(/\r\n/g, '\n').trimEnd()}\n`
    const { versionId } = await publishSkillVersion({
      slug,
      ownerUserId: userId,
      version,
      name,
      description,
      tags,
      rawSkillMd,
      artifactHash: marketplaceArtifactHash(rawSkillMd),
      embeddingHash: skillContentHash({ name, description, tags }),
      riskFlags: scan.flags,
      policyVersion: scan.policyVersion,
      submittedBy: userId,
      kind: 'skill',
    })
    send(
      res,
      200,
      { ok: true, versionId, status: 'pending', note: '已提交,平台审核通过后才会上架。' },
      requestId,
    )
    return
  }

  // agent
  const allowedModels = new Set<string>()
  try {
    if (!deps.listPublicModels) throw new Error('no pricing')
    const isV5 = (process.env.OC_RUNTIME_CHANNEL?.trim() || 'v3') === 'v5'
    for (const m of deps.listPublicModels())
      if (!isV5 || !m.id.toLowerCase().startsWith('gpt-')) allowedModels.add(m.id)
  } catch {
    return send(
      res,
      503,
      { error: { code: 'PRICING_UNAVAILABLE', message: '模型目录暂不可用' } },
      requestId,
    )
  }
  const manifestInput: Record<string, unknown> = { ...body }
  for (const k of ['kind', 'slug']) delete manifestInput[k]
  const result = validateAgentManifest(manifestInput, {
    vettedToolsets: VETTED_AGENT_TOOLSETS,
    allowedModels,
  })
  if (!result.ok)
    return send(
      res,
      422,
      { error: { code: 'INVALID_MANIFEST', message: '智能体配置不合法' }, errors: result.errors },
      requestId,
    )
  const manifest = result.manifest
  const scan = scanSkillArtifact({
    name: manifest.name,
    description: manifest.description,
    tags: manifest.tags,
    body: manifest.persona,
  })
  if (scan.blocked)
    return send(
      res,
      422,
      { error: { code: 'SCAN_BLOCKED', message: '被静态扫描拦截' }, riskFlags: scan.flags },
      requestId,
    )
  if (manifest.skillDeps.length > 0) {
    const found = await getApprovedSkillVersions(manifest.skillDeps)
    const missing = manifest.skillDeps.filter((s) => !found.has(s))
    if (missing.length > 0)
      return send(
        res,
        422,
        { error: { code: 'UNAPPROVED_SKILLDEP', message: `依赖技能未上架:${missing.join(', ')}` } },
        requestId,
      )
  }
  const rawArtifact = canonicalizeAgentManifest(manifest)
  const { versionId } = await publishSkillVersion({
    slug,
    ownerUserId: userId,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    tags: manifest.tags,
    rawSkillMd: null,
    rawArtifact,
    manifest,
    kind: 'agent',
    artifactHash: marketplaceArtifactHash(rawArtifact),
    embeddingHash: skillContentHash({
      name: manifest.name,
      description: manifest.description,
      tags: manifest.tags,
    }),
    riskFlags: scan.flags,
    policyVersion: scan.policyVersion,
    submittedBy: userId,
  })
  send(
    res,
    200,
    { ok: true, versionId, status: 'pending', note: '已提交,平台审核通过后才会上架。' },
    requestId,
  )
}
