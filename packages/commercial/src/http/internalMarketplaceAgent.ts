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
  marketplaceConnectorsEnabled,
  publishSkillVersion,
  recordUninstall,
  resolveCallerOrgId,
} from '../marketplace/marketplaceDb.js'
import {
  HumanMetaError,
  humanMetaScanBody,
  parseHumanMeta,
} from '../marketplace/marketplaceMeta.js'
import { listMarketBrowseCatalog } from '../marketplace/platformPresets.js'
import { prepareConnectorPublish } from '../marketplace/publishConnectorPipeline.js'
import {
  PUBLISH_MAX_REQUEST_BYTES,
  prepareSkillPublish,
} from '../marketplace/publishSkillPipeline.js'
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

// 默认上限保留历史 +4096 松弛(兼容既有 op 行为);发布 op 显式传
// PUBLISH_MAX_REQUEST_BYTES 时为精确硬上限,与浏览器发布路径一致。
async function readBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY + 4096,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    total += (c as Buffer).length
    if (total > maxBytes) throw new Error('body too large')
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
      // org 可见性收口:容器 AI 市场操作与容器所属用户同口径可见 org-private 技能
      // (公开 ∪ 本 org 私有)。无 org 归属 → 仅公开(null 天然 fail-closed)。
      const callerOrgId = await resolveCallerOrgId(userId)
      // ── read-only ──
      if (req.method === 'GET' && op === 'search') {
        const kindParam = url.searchParams.get('kind')
        if (
          kindParam !== null &&
          kindParam !== 'skill' &&
          kindParam !== 'agent' &&
          kindParam !== 'connector'
        ) {
          send(res, 200, { results: [] }, requestId)
          return
        }
        // 无 kind → 默认 'skill';agent/connector 都是 v5-only。
        const kind = kindParam === 'agent' || kindParam === 'connector' ? kindParam : 'skill'
        if (
          (kind === 'agent' && !marketplaceAgentsEnabled()) ||
          (kind === 'connector' && !marketplaceConnectorsEnabled())
        ) {
          send(res, 200, { results: [] }, requestId)
          return
        }
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 200)
        const limit = Math.min(
          Math.max(Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1),
          50,
        )
        // 平台预设 agent 不在市场搜索里露出(与浏览器 /api/marketplace/search 同一权威)。
        // callerOrgId 收口 org 可见性:org-private 技能只对本 org 成员搜出。
        const catalog = await listMarketBrowseCatalog(kind, callerOrgId)
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
            results: filtered.slice(0, limit).map((c) => ({
              slug: c.slug,
              kind: c.kind,
              name: c.name,
              description: c.description,
              tags: c.tags,
              // 人向导购字段:容器 AI 据 category/useCases 解释「为什么适配你的需求」。
              category: c.category,
              useCases: c.useCases,
              // 真实使用信号:容器 AI 据 30 天使用/评分反馈解释「为什么推荐(多少人在用/口碑)」。
              // rating 样本不足时服务端已置 null,AI 不应据 null 编造好评率。
              usage30d: c.usage30d,
              users30d: c.users30d,
              rating: c.rating,
            })),
          },
          requestId,
        )
        return
      }
      if (req.method === 'GET' && op === 'detail') {
        const slug = url.searchParams.get('slug') ?? ''
        if (!SLUG_RE.test(slug)) return send(res, 400, { error: { code: 'BAD_SLUG' } }, requestId)
        // org 可见性收口:org-private listing 对非本 org 容器视同不存在(404)。
        const detail = await getListingDetail(slug, callerOrgId)
        // agent 类仅 v5 露出:v3 渠道视同不存在(防 slug→detail→versionId 旁路装坏 agent)。
        if (
          !detail ||
          (detail.kind === 'agent' && !marketplaceAgentsEnabled()) ||
          (detail.kind === 'connector' && !marketplaceConnectorsEnabled())
        )
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
        const installed = await listInstalled(userId)
        send(
          res,
          200,
          {
            installed: marketplaceConnectorsEnabled()
              ? installed
              : installed.filter((item) => item.kind !== 'connector'),
          },
          requestId,
        )
        return
      }

      // ── mutations (own user only) ──
      if (req.method === 'POST' && op === 'install') {
        const body = await readBody(req)
        const slug = asStr(body.slug, 64)
        if (!slug || !SLUG_RE.test(slug))
          return send(res, 400, { error: { code: 'BAD_SLUG' } }, requestId)
        // org 可见性收口:org-private 技能仅本 org 容器可见/可装(非成员 → detail null → 404)。
        const detail = await getListingDetail(slug, callerOrgId)
        if (
          !detail ||
          (detail.kind === 'agent' && !marketplaceAgentsEnabled()) ||
          (detail.kind === 'connector' && !marketplaceConnectorsEnabled())
        )
          return send(
            res,
            404,
            { error: { code: 'NOT_INSTALLABLE', message: '未上架或不存在' } },
            requestId,
          )
        const v = await installApprovedVersion({
          userId,
          versionId: detail.versionId,
          callerOrgId,
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
            const versions = await getApprovedSkillVersions(depSlugs, callerOrgId)
            for (const depVid of versions.values()) {
              try {
                await installApprovedVersion({
                  userId,
                  versionId: depVid,
                  callerOrgId,
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
        if (!marketplaceConnectorsEnabled()) {
          const installed = await listInstalled(userId)
          if (installed.some((item) => item.slug === slug && item.kind === 'connector'))
            return send(res, 404, { error: { code: 'NOT_INSTALLABLE' } }, requestId)
        }
        send(res, 200, { ok: await recordUninstall(userId, slug) }, requestId)
        return
      }
      if (req.method === 'POST' && op === 'publish') {
        await handlePublish(req, res, requestId, userId, callerOrgId, deps)
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
      // 人向元数据校验失败(缺 category/useCases 等)→ 400,与浏览器路由同规则。
      if (err instanceof HumanMetaError) {
        send(res, 400, { error: { code: err.code, message: err.message } }, requestId)
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

/** Publish a skill, agent or connector on the user's behalf → PENDING + static scan. */
async function handlePublish(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  userId: number,
  callerOrgId: string | null,
  deps: MarketplaceAgentDeps,
): Promise<void> {
  // 发布是唯一携带 bundle(正文 + 附属文件)的 op,读取上限随发布管线放大;
  // 其余 op 维持默认 64KB。
  const body = await readBody(req, PUBLISH_MAX_REQUEST_BYTES)
  const kind = body.kind
  if (kind !== 'skill' && kind !== 'agent' && kind !== 'connector')
    return send(
      res,
      400,
      { error: { code: 'BAD_KIND', message: 'kind must be skill|agent|connector' } },
      requestId,
    )
  // 可见范围(企业版 P3.1):visibility='org' 要求容器用户是 org active 成员 → listing.org_id=其 org。
  const orgId = body.visibility === 'org' ? callerOrgId : null
  if (body.visibility === 'org' && !orgId)
    return send(
      res,
      403,
      { error: { code: 'NOT_ORG_MEMBER', message: '仅组织成员可发布「仅本组织」可见的技能' } },
      requestId,
    )

  if (kind === 'connector') {
    if (!marketplaceConnectorsEnabled())
      return send(res, 404, { error: { code: 'NOT_FOUND' } }, requestId)
    const prepared = prepareConnectorPublish(body)
    if (!prepared.ok)
      return send(
        res,
        prepared.status,
        {
          error: { code: prepared.code, message: prepared.message },
          ...(prepared.riskFlags ? { riskFlags: prepared.riskFlags } : {}),
        },
        requestId,
      )
    const { versionId } = await publishSkillVersion({
      slug: prepared.slug,
      ownerUserId: userId,
      version: prepared.version,
      name: prepared.name,
      description: prepared.description,
      tags: prepared.tags,
      rawSkillMd: null,
      rawArtifact: prepared.rawArtifact,
      manifest: {
        connector: true,
        proposedSecurityDecision: prepared.proposedSecurityDecision,
      },
      kind: 'connector',
      artifactHash: prepared.artifactHash,
      embeddingHash: prepared.embeddingHash,
      riskFlags: prepared.riskFlags,
      policyVersion: prepared.policyVersion,
      submittedBy: userId,
      orgId,
      category: prepared.humanMeta.category,
      useCases: prepared.humanMeta.useCases,
      outcomeExamples: prepared.humanMeta.outcomeExamples,
      humanMd: prepared.humanMeta.humanMd,
    })
    send(
      res,
      200,
      {
        ok: true,
        versionId,
        status: 'pending',
        riskFlags: prepared.riskFlags,
        note: '已提交 AI 自动审核；不确定或高风险项会转人工复核。',
      },
      requestId,
    )
    return
  }

  const slug = asStr(body.slug, 64)
  if (!slug || !SLUG_RE.test(slug))
    return send(res, 400, { error: { code: 'BAD_SLUG' } }, requestId)

  if (kind === 'skill') {
    // 内容校验/扫描/规范化走与浏览器发布路由同一条权威管线 —— 容器路径由此获得
    // bundle(references/assets/evals/scripts)、benchmark 与逐附属文件扫描。
    // (历史:两条路径各写一套已漂移,容器内只能发单文件技能。)
    const prepared = prepareSkillPublish(body)
    if (!prepared.ok)
      return send(
        res,
        prepared.status,
        {
          error: { code: prepared.code, message: prepared.message },
          ...(prepared.errors ? { errors: prepared.errors } : {}),
          ...(prepared.riskFlags ? { riskFlags: prepared.riskFlags } : {}),
        },
        requestId,
      )
    const { versionId } = await publishSkillVersion({
      slug: prepared.slug,
      ownerUserId: userId,
      version: prepared.version,
      name: prepared.name,
      description: prepared.description,
      tags: prepared.tags,
      rawSkillMd: prepared.rawSkillMd,
      artifactHash: prepared.artifactHash,
      embeddingHash: prepared.embeddingHash,
      riskFlags: prepared.riskFlags,
      policyVersion: prepared.policyVersion,
      submittedBy: userId,
      kind: 'skill',
      rawBundle: prepared.rawBundle,
      benchmark: prepared.benchmark,
      orgId,
      category: prepared.humanMeta.category,
      useCases: prepared.humanMeta.useCases,
      outcomeExamples: prepared.humanMeta.outcomeExamples,
      humanMd: prepared.humanMeta.humanMd,
    })
    send(
      res,
      200,
      {
        ok: true,
        versionId,
        status: 'pending',
        // 含 scripts 危险模式 warning flag —— 发布者(容器内 AI)与审核者看同一份。
        riskFlags: prepared.riskFlags,
        note: '已提交,平台审核通过后才会上架。',
      },
      requestId,
    )
    return
  }

  // ── agent 分支(字段权威 = validateAgentManifest,维持既有校验序) ──
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
  asTags(body.tags) // 早期 400 门(bad tag → 外层 catch);manifest 校验才是 tags 权威
  // 人向商品层元数据(必填 category/useCases;单一校验权威)→ HumanMetaError 由外层 catch 映射 400。
  const humanMeta = parseHumanMeta(body)
  // 商品页文案与正文同规则扫描,防注入/密钥进商品页。
  const metaScan = scanSkillArtifact({
    name,
    description: '',
    tags: [],
    body: humanMetaScanBody(humanMeta),
  })
  if (metaScan.blocked)
    return send(
      res,
      422,
      {
        error: { code: 'SCAN_BLOCKED', message: '商品页文案被静态扫描拦截' },
        riskFlags: metaScan.flags,
      },
      requestId,
    )

  let allowedModels: Set<string>
  try {
    if (!deps.listPublicModels) throw new Error('no pricing')
    allowedModels = new Set(deps.listPublicModels().map((m) => m.id))
  } catch {
    return send(
      res,
      503,
      { error: { code: 'PRICING_UNAVAILABLE', message: '模型目录暂不可用' } },
      requestId,
    )
  }
  const manifestInput: Record<string, unknown> = { ...body }
  // category/useCases/outcomeExamples/humanMd/visibility 是发布级字段,不进 manifest —— 与
  // kind/slug 一样在严格 allowlist 校验前 delete,否则会被拒为「未知字段」。
  for (const k of [
    'kind',
    'slug',
    'category',
    'useCases',
    'outcomeExamples',
    'humanMd',
    'visibility',
  ])
    delete manifestInput[k]
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
    const found = await getApprovedSkillVersions(manifest.skillDeps, orgId)
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
      use_cases: humanMeta.useCases,
    }),
    riskFlags: scan.flags,
    policyVersion: scan.policyVersion,
    submittedBy: userId,
    orgId,
    category: humanMeta.category,
    useCases: humanMeta.useCases,
    outcomeExamples: humanMeta.outcomeExamples,
    humanMd: humanMeta.humanMd,
  })
  send(
    res,
    200,
    { ok: true, versionId, status: 'pending', note: '已提交,平台审核通过后才会上架。' },
    requestId,
  )
}
