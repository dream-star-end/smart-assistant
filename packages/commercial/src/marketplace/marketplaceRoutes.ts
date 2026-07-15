/**
 * User- and admin-facing HTTP handlers for the skill marketplace.
 *
 * Registered in http/router.ts. User routes use requireAuth (browser JWT);
 * admin routes use requireAdminVerifyDb. Install (P2.2) is deliberately a
 * browser-only interactive route — agent containers must NOT be able to call
 * it (enforced by router.ts's agent-bypass guard + no user JWT in containers).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { marketplaceArtifactCompatibility } from '@openclaude/protocol'
import { marketplaceArtifactHash, skillContentHash } from '@openclaude/storage'
import { ConnectorSpecError } from '../connectors/spec/types.js'

import { writeAdminAuditBestEffort } from '../admin/audit.js'
import { requireAdminVerifyDb } from '../admin/requireAdmin.js'
import { requireAuth } from '../http/auth.js'
import { HttpError, clientIpOf, readJsonBody, sendJson, userAgentOf } from '../http/util.js'
import {
  VETTED_AGENT_TOOLSETS,
  canonicalizeAgentManifest,
  validateAgentManifest,
} from './agentManifest.js'
import {
  approveMarketplaceConnectorVersion,
  getMarketplaceArtifactKind,
  rejectMarketplaceConnectorVersion,
} from './connectorReview.js'
import {
  FEATURED_RANK_MAX,
  FEATURED_RANK_MIN,
  type AgentCapabilityReadiness,
  MarketplaceError,
  getAgentCapabilityReadiness,
  getAgentCapabilityReadinessMany,
  getInstallableVersionTarget,
  getListingDetail,
  installMarketplaceBundle,
  listActiveInstalledAgents,
  listInstalled,
  listMyPublishes,
  listPendingVersions,
  listPlatformPresetAgents,
  listRecentAiReviews,
  marketplaceAgentsEnabled,
  marketplaceConnectorsEnabled,
  ownerUnlistListing,
  publishSkillVersion,
  recordUninstall,
  resolveCallerOrgId,
  reviewVersion,
  type reviewVersions,
  revokeListing,
  setListingFeaturedRank,
  updateInstalledAgentScope,
  withdrawPublishVersion,
} from './marketplaceDb.js'
import {
  type HumanMeta,
  HumanMetaError,
  humanMetaScanBody,
  parseHumanMeta,
} from './marketplaceMeta.js'
import { platformPresetAgentSlugs } from './platformPresets.js'
import { prepareConnectorPublish } from './publishConnectorPipeline.js'
import { PUBLISH_MAX_REQUEST_BYTES, prepareSkillPublish } from './publishSkillPipeline.js'
import { scanSkillArtifact } from './skillScanner.js'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/

function uid(user: { id: string }): number {
  const n = Number.parseInt(user.id, 10)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(401, 'UNAUTHORIZED', 'bad subject')
  return n
}

/**
 * 解析发布可见范围(企业版 P3.1,方案 §3)。
 *   - visibility='org' → 要求发布者是某 org 的 active 成员,listing.org_id = 其 org。
 *   - 缺省 / 'public' / 其它 → 公开(返回 null)。
 * AI 审核链对 org-private 与公开一视同仁(照常跑)。
 */
async function resolvePublishOrgId(userId: number, visibility: unknown): Promise<string | null> {
  if (visibility !== 'org') return null
  const orgId = await resolveCallerOrgId(userId)
  if (!orgId) throw new HttpError(403, 'NOT_ORG_MEMBER', '仅组织成员可发布「仅本组织」可见的技能')
  return orgId
}

function asStr(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.length === 0)
    throw new HttpError(400, 'BAD_REQUEST', `${field} required`)
  if (v.length > max) throw new HttpError(400, 'BAD_REQUEST', `${field} too long`)
  return v
}

function rejectionNote(v: unknown): string {
  const note = typeof v === 'string' ? v.trim().slice(0, 2000) : ''
  if (!note) throw new HttpError(400, 'BAD_REQUEST', '拒绝时必须填写理由')
  return note
}

function asAgentIds(v: unknown, fallback: string[] = ['main']): string[] {
  const raw = v === undefined ? fallback : v
  if (!Array.isArray(raw)) throw new HttpError(400, 'BAD_AGENT_SCOPE', 'agentIds must be an array')
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string')
      throw new HttpError(400, 'BAD_AGENT_SCOPE', 'agentIds must be strings')
    const id = item.trim()
    if (!id || !AGENT_ID_RE.test(id))
      throw new HttpError(400, 'BAD_AGENT_SCOPE', `invalid agentId: ${id}`)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  if (out.length === 0) throw new HttpError(400, 'BAD_AGENT_SCOPE', '至少选择一个智能体')
  return out
}

async function assignableAgentIds(userId: number): Promise<Set<string>> {
  const presetSlugs = await platformPresetAgentSlugs()
  const [presets, installed] = await Promise.all([
    listPlatformPresetAgents(presetSlugs),
    listActiveInstalledAgents(userId),
  ])
  return new Set(['main', ...presets.map((a) => a.slug), ...installed.map((a) => a.slug)])
}

async function validateAssignableAgentScope(userId: number, input: unknown): Promise<string[]> {
  const agentIds = asAgentIds(input)
  const allowed = await assignableAgentIds(userId)
  const bad = agentIds.find((id) => !allowed.has(id))
  if (bad) throw new HttpError(400, 'BAD_AGENT_SCOPE', `不可分配给未启用智能体: ${bad}`)
  return agentIds
}

function slugFromPrefix(req: IncomingMessage, prefix: string): string {
  const path = (req.url ?? '').split('?')[0]
  const rest = decodeURIComponent(path.slice(prefix.length))
  return rest.split('/')[0] ?? ''
}

function mapMarketplaceError(e: unknown): HttpError {
  if (e instanceof ConnectorSpecError) {
    const status =
      e.code === 'REVIEWER_IS_AUTHOR' || e.code === 'REVIEWER_NOT_ADMIN'
        ? 403
        : e.code === 'CAS_CONFLICT' || e.code === 'INVALID_STATE' || e.code === 'NOT_DRAFT'
          ? 409
          : 422
    return new HttpError(status, e.code, e.code)
  }
  if (e instanceof MarketplaceError) {
    const status =
      e.code === 'SLUG_OWNED_BY_OTHER' || e.code === 'REVIEWER_IS_AUTHOR'
        ? 403
        : e.code === 'DUPLICATE_VERSION' ||
            e.code === 'LISTING_REVOKED' ||
            e.code === 'NOT_PENDING' ||
            e.code === 'KIND_MISMATCH' ||
            e.code === 'INSTALL_CONFLICT'
          ? 409
          : e.code === 'INVALID_CAPABILITY'
            ? 422
            : e.code === 'VERSION_NOT_FOUND' || e.code === 'NOT_INSTALLABLE'
              ? 404
              : 400
    return new HttpError(status, e.code, e.message)
  }
  return e instanceof HttpError ? e : new HttpError(500, 'INTERNAL', 'marketplace error')
}

/** 人向元数据校验(单一权威 parseHumanMeta),HumanMetaError → 400(带 code)。 */
function parseHumanMetaOr400(body: Record<string, unknown>): HumanMeta {
  try {
    return parseHumanMeta(body)
  } catch (e) {
    if (e instanceof HumanMetaError) throw new HttpError(400, e.code, e.message)
    throw e
  }
}

/**
 * 人向元数据(用例/效果示例/富介绍)拼接文本过与正文同一套静态扫描;blocked → 422 SCAN_BLOCKED
 * (riskFlags 带回),防密钥/注入进商品页。返回 true 表示已发送 422、调用方应 return。
 */
function humanMetaScanBlocked(res: ServerResponse, name: string, meta: HumanMeta): boolean {
  const scan = scanSkillArtifact({ name, description: '', tags: [], body: humanMetaScanBody(meta) })
  if (scan.blocked) {
    sendJson(res, 422, {
      error: { code: 'SCAN_BLOCKED', message: '商品页文案被静态安全扫描拦截,请修正后重试' },
      riskFlags: scan.flags,
    })
    return true
  }
  return false
}

// ── POST /api/marketplace/publish ──────────────────────────────────────────
// User publishes one of their own skills. Static scan gates it; high-severity
// findings (secrets / internal infra / html / non-plain metadata) block.
export async function handleMarketplacePublish(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  // 发布是唯一携带 bundle 的入口,body 上限放大到 PUBLISH_MAX_REQUEST_BYTES
  // (历史 bug:全局 64KB 默认让满额 bundle 在这里 413,能力被静默阉割)。
  const body = (await readJsonBody(req, PUBLISH_MAX_REQUEST_BYTES)) as Record<string, unknown>
  // 内容校验/扫描/规范化全部走单一权威管线(与容器内部代理同源)。
  const prepared = prepareSkillPublish(body)
  if (!prepared.ok) {
    if (prepared.status === 400) throw new HttpError(400, prepared.code, prepared.message)
    sendJson(res, 422, {
      error: { code: prepared.code, message: prepared.message },
      ...(prepared.errors ? { errors: prepared.errors } : {}),
      ...(prepared.riskFlags ? { riskFlags: prepared.riskFlags } : {}),
    })
    return
  }

  const orgId = await resolvePublishOrgId(uid(user), body.visibility)
  try {
    const { versionId } = await publishSkillVersion({
      slug: prepared.slug,
      ownerUserId: uid(user),
      version: prepared.version,
      name: prepared.name,
      description: prepared.description,
      tags: prepared.tags,
      rawSkillMd: prepared.rawSkillMd,
      artifactHash: prepared.artifactHash,
      embeddingHash: prepared.embeddingHash,
      riskFlags: prepared.riskFlags,
      policyVersion: prepared.policyVersion,
      submittedBy: uid(user),
      rawBundle: prepared.rawBundle,
      benchmark: prepared.benchmark,
      orgId,
      category: prepared.humanMeta.category,
      useCases: prepared.humanMeta.useCases,
      outcomeExamples: prepared.humanMeta.outcomeExamples,
      humanMd: prepared.humanMeta.humanMd,
    })
    sendJson(res, 200, {
      ok: true,
      versionId,
      status: 'pending',
      // 含 scripts 危险模式的 warning flag —— 发布者与审核者看到同一份提示。
      riskFlags: prepared.riskFlags,
      note: '已提交,平台审核通过后才会上架并对其他用户可见。',
    })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
}

// ── POST /api/marketplace/agent/publish ────────────────────────────────────
// Publish an AGENT artifact. Strict allowlist manifest (no self-MCP / fixed
// permissionMode / vetted toolsets / inline persona / approved skillDeps) +
// persona static scan. Owner- and kind-locked, pending review like skills.
export async function handleMarketplaceAgentPublish(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array; pricing?: { listPublic: () => Array<{ id: string }> } },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const body = (await readJsonBody(req)) as Record<string, unknown>
  const slug = asStr(body.slug, 'slug', 64)
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'BAD_SLUG', 'slug 须为小写字母数字连字符(2-64)')

  // Allowed models = current public model set. GPT-5.6 is a first-class v5
  // runtime model, so marketplace agents may select it like any other public model.
  // Fail-closed: if pricing isn't available we cannot enforce model∈public, so we
  // refuse to publish rather than accept an unvalidated model (matches
  // handleListPublicModels' 503). Pricing is initialized at startup in production.
  let publicModels: Array<{ id: string }>
  try {
    publicModels = deps.pricing?.listPublic() ?? []
    if (!deps.pricing) throw new Error('no pricing')
  } catch {
    throw new HttpError(503, 'PRICING_UNAVAILABLE', '模型目录暂不可用,请稍后重试')
  }
  const allowedModels = new Set(publicModels.map((m) => m.id))

  // 人向商品层元数据(必填 category/useCases)先校验 → 400;它们是**发布级**元数据,
  // 绝不进 agent manifest,故与 slug 一样在 validateAgentManifest 前从 manifestInput delete 掉,
  // 否则严格 allowlist 会拒「未知字段」。
  const humanMeta = parseHumanMetaOr400(body)

  const manifestInput: Record<string, unknown> = { ...body }
  // slug is the listing key, NOT a manifest field — remove the KEY (not just set
  // undefined) so the strict allowlist validator doesn't reject it as "未知字段".
  // category/useCases/outcomeExamples/humanMd/visibility 同理:发布级字段,不进 manifest。
  for (const k of ['slug', 'category', 'useCases', 'outcomeExamples', 'humanMd', 'visibility'])
    delete manifestInput[k]
  const result = validateAgentManifest(manifestInput, {
    vettedToolsets: VETTED_AGENT_TOOLSETS,
    allowedModels,
    artifactSlug: slug,
  })
  if (!result.ok) {
    sendJson(res, 422, {
      error: { code: 'INVALID_MANIFEST', message: '智能体配置不合法,请按提示修正' },
      errors: result.errors,
    })
    return
  }
  const manifest = result.manifest

  // persona goes through the same static scanner as a skill body (injection/secret/…)
  const scan = scanSkillArtifact({
    name: manifest.name,
    description: manifest.description,
    tags: manifest.tags,
    body: manifest.persona,
  })
  if (scan.blocked) {
    sendJson(res, 422, {
      error: { code: 'SCAN_BLOCKED', message: '发布被静态安全扫描拦截,请修正后重试' },
      riskFlags: scan.flags,
    })
    return
  }
  // 人向商品页文案与 persona 同规则扫描,防注入/密钥进商品页。
  if (humanMetaScanBlocked(res, manifest.name, humanMeta)) return

  const orgId = await resolvePublishOrgId(uid(user), body.visibility)

  const rawArtifact = canonicalizeAgentManifest(manifest)
  try {
    const { versionId } = await publishSkillVersion({
      slug,
      ownerUserId: uid(user),
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
      submittedBy: uid(user),
      orgId,
      category: humanMeta.category,
      useCases: humanMeta.useCases,
      outcomeExamples: humanMeta.outcomeExamples,
      humanMd: humanMeta.humanMd,
    })
    sendJson(res, 200, {
      ok: true,
      versionId,
      status: 'pending',
      riskFlags: scan.flags,
      note: '已提交,平台审核通过后才会上架并对其他用户可见。',
    })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
}

// ── POST /api/marketplace/connector/publish ────────────────────────────────
// ConnectorSpec 与 publisher-proposed SecurityDecision 都是不可信输入。发布时编译只负责
// 严格校验；真正可执行 contract 必须由 admin 在专用原子审核流中用“实际决定”重新编译并签名。
export async function handleMarketplaceConnectorPublish(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  if (!marketplaceConnectorsEnabled())
    throw new HttpError(404, 'NOT_FOUND', 'connector marketplace is not available')
  const user = await requireAuth(req, deps.jwtSecret)
  const body = (await readJsonBody(req, PUBLISH_MAX_REQUEST_BYTES)) as Record<string, unknown>
  const prepared = prepareConnectorPublish(body)
  if (!prepared.ok) {
    if (prepared.status === 400) throw new HttpError(400, prepared.code, prepared.message)
    sendJson(res, 422, {
      error: { code: prepared.code, message: prepared.message },
      ...(prepared.riskFlags ? { riskFlags: prepared.riskFlags } : {}),
    })
    return
  }
  const orgId = await resolvePublishOrgId(uid(user), body.visibility)
  try {
    const { versionId } = await publishSkillVersion({
      slug: prepared.slug,
      ownerUserId: uid(user),
      version: prepared.version,
      name: prepared.name,
      description: prepared.description,
      tags: prepared.tags,
      rawSkillMd: null,
      rawArtifact: prepared.rawArtifact,
      manifest: {
        connector: true,
        // 仅供 reviewer 起草，绝不是已批准事实；详情用户面只读签名 contract 投影。
        proposedSecurityDecision: prepared.proposedSecurityDecision,
      },
      kind: 'connector',
      artifactHash: prepared.artifactHash,
      embeddingHash: prepared.embeddingHash,
      riskFlags: prepared.riskFlags,
      policyVersion: prepared.policyVersion,
      submittedBy: uid(user),
      orgId,
      category: prepared.humanMeta.category,
      useCases: prepared.humanMeta.useCases,
      outcomeExamples: prepared.humanMeta.outcomeExamples,
      humanMd: prepared.humanMeta.humanMd,
    })
    sendJson(res, 200, {
      ok: true,
      versionId,
      status: 'pending',
      riskFlags: prepared.riskFlags,
      note: '已提交 AI 自动审核；不确定或高风险项会转交管理员复核。',
    })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
}

// ── GET /api/marketplace/my-agents ─────────────────────────────────────────
// Per-user agent list for the picker (B-positioning): the default 全能助手 plus
// the user's installed marketplace agents. Master-assembled from installs+manifest
// so the picker is correct immediately, independent of container sync timing.
// Named under /api/marketplace/* (NOT /api/agents — that is the container-proxied
// RCE-gated route) so it shares the browser-JWT, no-bridge-allowlist boundary.
export async function handleMarketplaceMyAgents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  // 预设(编程/办公/科研,current approved,evergreen)+ 用户已装;同 slug 预设优先
  // (预设不 pin 版本,平台改版全员生效),与容器 sync 的合并规则一致。
  const presetSlugs = await platformPresetAgentSlugs()
  const [presets, installed] = await Promise.all([
    listPlatformPresetAgents(presetSlugs),
    listActiveInstalledAgents(uid(user)),
  ])
  const presetSet = new Set(presets.map((p) => p.slug))
  const candidates = [
    ...presets.map((agent) => ({ agent, preset: true })),
    ...installed
      .filter((agent) => !presetSet.has(agent.slug))
      .map((agent) => ({ agent, preset: false })),
  ]
  const readiness = await getAgentCapabilityReadinessMany(
    uid(user),
    candidates.map(({ agent, preset }) => ({
      slug: agent.slug,
      versionId: agent.versionId,
      preset,
    })),
  )
  const toRow = (
    a: { slug: string; version: string; rawManifest: string },
    preset: boolean,
    capabilityReadiness: AgentCapabilityReadiness,
  ) => {
    let m: Record<string, unknown> = {}
    try {
      m = JSON.parse(a.rawManifest) as Record<string, unknown>
    } catch {
      /* corrupt manifest → minimal entry */
    }
    return {
      id: a.slug,
      slug: a.slug,
      name: (m.displayName as string) || (m.name as string) || a.slug,
      description: (m.description as string) ?? '',
      avatarEmoji: (m.avatarEmoji as string) ?? null,
      model: (m.model as string) ?? null,
      version: a.version,
      installed: true,
      capabilityReadiness,
      ...(preset ? { preset: true } : {}),
    }
  }
  const agents = candidates.map(({ agent, preset }, index) =>
    toRow(agent, preset, readiness[index]!),
  )
  sendJson(res, 200, {
    agents: [
      {
        id: 'main',
        slug: 'main',
        name: '全能助手',
        description: '通用全能智能体,内置工具齐全,可随时加装市场技能。',
        avatarEmoji: '✨',
        model: null,
        version: null,
        installed: true,
        isDefault: true,
        capabilityReadiness: {
          installed: true,
          ready: true,
          requirements: [],
          needsAuthorization: [],
        },
      },
      ...agents,
    ],
  })
}

// ── POST /api/marketplace/install ──────────────────────────────────────────
// Browser-only (the bridge allowlist excludes marketplace + containers have no
// user JWT). The user has already seen the full SKILL.md + risk flags in the
// confirm dialog. The version's approved/active/current validity is re-checked
// inside the same transaction as the insert (no TOCTOU vs a concurrent
// revoke/approve); the artifact is materialized container-side by the hub sync
// (pull model), so no master-writes-volume.
export async function handleMarketplaceInstall(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const body = (await readJsonBody(req)) as Record<string, unknown>
  const versionId = asStr(body.versionId, 'versionId', 32)
  if (!/^\d+$/.test(versionId)) throw new HttpError(400, 'BAD_ID', 'invalid versionId')
  try {
    const userId = uid(user)
    // org 可见性收口:org-private 版本仅本 org 成员可装(非成员 → target null → NOT_INSTALLABLE 404)。
    const callerOrgId = await resolveCallerOrgId(userId)
    const target = await getInstallableVersionTarget(versionId, callerOrgId)
    if (!target)
      throw new MarketplaceError('NOT_INSTALLABLE', 'skill 不可安装(未上架/已下架/非当前版本)')
    if (body.preserveManualScope !== undefined && typeof body.preserveManualScope !== 'boolean')
      throw new HttpError(400, 'BAD_AGENT_SCOPE', 'preserveManualScope must be boolean')
    if (body.manualAgentScope !== undefined && typeof body.manualAgentScope !== 'boolean')
      throw new HttpError(400, 'BAD_AGENT_SCOPE', 'manualAgentScope must be boolean')
    const preserveManualScope = body.preserveManualScope === true
    const manualAgentScope = body.manualAgentScope === true
    if (
      preserveManualScope &&
      (target.kind !== 'skill' || body.agentIds !== undefined || manualAgentScope)
    )
      throw new HttpError(
        400,
        'BAD_AGENT_SCOPE',
        'preserveManualScope is only valid for a Skill update without agentIds',
      )
    if (manualAgentScope && (target.kind !== 'skill' || body.agentIds === undefined))
      throw new HttpError(
        400,
        'BAD_AGENT_SCOPE',
        'manualAgentScope requires explicit Skill agentIds',
      )
    const selectedAgentIds =
      target.kind === 'skill' && body.agentIds !== undefined
        ? await validateAssignableAgentScope(userId, body.agentIds)
        : undefined
    const v = await installMarketplaceBundle({
      userId,
      versionId,
      callerOrgId,
      ...(target.kind === 'skill'
        ? preserveManualScope
          ? { scopeMode: 'preserve' as const }
          : manualAgentScope
            ? { agentIds: selectedAgentIds, scopeMode: 'replace' as const }
            : {
                ...(selectedAgentIds ? { agentIds: selectedAgentIds } : {}),
                // A stale frontend may send the old manual+dependency union. The
                // data layer removes dependency-owned IDs before writing provenance.
                scopeMode: 'legacy_union' as const,
              }
        : {}),
    })

    sendJson(res, 200, {
      ok: true,
      slug: v.slug,
      version: v.version,
      kind: v.kind,
      ...marketplaceArtifactCompatibility(v.kind),
      installedDeps: v.installedCapabilities.length,
      installedCapabilities: v.installedCapabilities,
      skippedOptional: v.skippedOptional,
      needsAuthorization: v.needsAuthorization,
      ready: v.ready,
      note:
        v.kind === 'agent'
          ? v.ready
            ? `智能体与 ${v.installedCapabilities.length} 项能力已原子安装。`
            : '智能体与能力已安装；完成必需插件的账号授权后即可使用。'
          : v.kind === 'connector'
            ? v.ready
              ? 'API 连接插件已安装并可使用。'
              : 'API 连接插件已安装；绑定应用账号后即可使用。'
            : '已安装,将在你的下一次会话中对 AI 可用。',
    })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
}

// ── GET /api/marketplace/installed ─────────────────────────────────────────
export async function handleMarketplaceInstalled(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  // 预设 slug 的历史安装行不展示:预设已平台化(恒在、evergreen、不可卸),
  // 在「已安装」里露出只会引导出没有意义的卸载/更新操作。
  const presetSet = new Set(await platformPresetAgentSlugs())
  const rows = (await listInstalled(uid(user))).filter((r) => !presetSet.has(r.slug))
  const agentRows = rows.filter((row) => row.kind === 'agent')
  const readinessRows = await getAgentCapabilityReadinessMany(
    uid(user),
    agentRows.map((row) => ({ slug: row.slug, versionId: row.versionId })),
  )
  const readiness = new Map(
    agentRows.map((row, index) => [row.slug, readinessRows[index]!] as const),
  )
  sendJson(res, 200, {
    installed: rows.map((row) => ({
      ...row,
      ...marketplaceArtifactCompatibility(row.kind),
      ...(row.kind === 'agent' ? { capabilityReadiness: readiness.get(row.slug) } : {}),
    })),
  })
}

// ── PATCH /api/marketplace/installed/:slug ────────────────────────────────
export async function handleMarketplaceInstalledScope(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = uid(user)
  const slug = slugFromPrefix(req, '/api/marketplace/installed/')
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'BAD_SLUG', 'invalid slug')
  const body = (await readJsonBody(req)) as Record<string, unknown>
  const agentIds = await validateAssignableAgentScope(userId, body.agentIds)
  try {
    const ok = await updateInstalledAgentScope(userId, slug, agentIds)
    if (!ok) throw new HttpError(404, 'NOT_FOUND', '未找到可修改归属的已安装技能')
    sendJson(res, 200, { ok: true, agentIds })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
}

// ── GET /api/marketplace/my-publishes ──────────────────────────────────────
// 发布者自己的提交记录(pending/approved/rejected + 审核理由),闭合「发布→审核结果」
// 反馈环。exact path,必须先于 /api/marketplace/ 的 detail prefix 匹配(matchRoute
// exact-first;且 'my-publishes' 本身匹配 SLUG_RE,靠 prefix 会被当 slug 吞掉)。
export async function handleMarketplaceMyPublishes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const publishes = await listMyPublishes(uid(user))
  sendJson(res, 200, {
    publishes: publishes.map((row) => ({
      ...row,
      ...marketplaceArtifactCompatibility(row.kind),
    })),
  })
}

// ── POST /api/marketplace/my-publishes/:id/withdraw ───────────────────────
// 发布者撤销尚未审核的投稿。保留版本行作为审计/反馈记录,状态转 rejected +
// review_note='作者撤销发布',让「我的发布」能闭合展示。
export async function handleMarketplaceWithdrawPublish(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const m = (req.url ?? '').match(/\/api\/marketplace\/my-publishes\/(\d+)\/withdraw(?:\?|$)/)
  const versionId = m?.[1]
  if (!versionId) throw new HttpError(400, 'BAD_ID', 'invalid version id')
  try {
    await withdrawPublishVersion(versionId, uid(user))
    sendJson(res, 200, { ok: true })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
}

// ── POST /api/marketplace/:slug/unlist ────────────────────────────────────
// 发布者自助下架自己的 active/current listing。与 admin revoke 不同:这不是
// kill-switch,未来新版本审核通过会把 unlisted 重新变 active;revoked 绝不复活。
export async function handleMarketplaceUnlist(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const m = (req.url ?? '').match(/\/api\/marketplace\/([a-z0-9][a-z0-9-]{1,63})\/unlist(?:\?|$)/)
  const slug = m?.[1]
  if (!slug) throw new HttpError(400, 'BAD_SLUG', 'invalid slug')
  const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : 'unlisted by owner'
  try {
    const affectedUserIds = await ownerUnlistListing(slug, uid(user), reason)
    sendJson(res, 200, { ok: true, affectedInstalls: affectedUserIds.length, affectedUserIds })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
}

// ── GET /api/marketplace/:slug ─────────────────────────────────────────────
// Full detail incl. the complete SKILL.md (the install-confirm dialog shows it).
export async function handleMarketplaceDetail(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const slug = slugFromPrefix(req, '/api/marketplace/')
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'BAD_SLUG', 'invalid slug')
  // org 可见性收口:org-private listing 对非本 org caller 视同不存在(404,不泄露存在性 oracle)。
  const callerOrgId = await resolveCallerOrgId(user.id)
  const detail = await getListingDetail(slug, callerOrgId)
  if (!detail) throw new HttpError(404, 'NOT_FOUND', 'skill 不存在或未上架')
  // agent 类仅 v5 露出:v3 渠道上视同不存在(防止据 slug 取 detail→versionId 旁路)。
  if (detail.kind === 'agent' && !marketplaceAgentsEnabled())
    throw new HttpError(404, 'NOT_FOUND', 'skill 不存在或未上架')
  if (detail.kind === 'connector' && !marketplaceConnectorsEnabled())
    throw new HttpError(404, 'NOT_FOUND', 'skill 不存在或未上架')
  // 平台预设标记(加法字段):前端据此显示「开箱即用」而非安装按钮。
  const preset = detail.kind === 'agent' && (await platformPresetAgentSlugs()).includes(slug)
  const publicDetail = { ...detail, ...marketplaceArtifactCompatibility(detail.kind) }
  const capabilityReadiness =
    detail.kind === 'agent'
      ? await getAgentCapabilityReadiness(uid(user), slug, detail.versionId, { preset })
      : null
  sendJson(res, 200, {
    detail: {
      ...publicDetail,
      ...(preset ? { preset: true } : {}),
      ...(capabilityReadiness ? { capabilityReadiness } : {}),
    },
  })
}

// ── DELETE /api/marketplace/installed/:slug ────────────────────────────────
export async function handleMarketplaceUninstall(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const slug = slugFromPrefix(req, '/api/marketplace/installed/')
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'BAD_SLUG', 'invalid slug')
  // 平台预设与全能助手同级,不可卸载(sync 侧也会恒下发,卸了只会状态漂移)。
  if ((await platformPresetAgentSlugs()).includes(slug))
    throw new HttpError(400, 'PRESET_AGENT', '平台预设智能体不可卸载')
  // P2.2 will also remove the on-disk hub copy; this records the soft-uninstall.
  try {
    const ok = await recordUninstall(uid(user), slug)
    sendJson(res, 200, { ok })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
}

// ── GET /api/admin/marketplace/pending ─────────────────────────────────────
export async function handleAdminMarketplacePending(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret)
  sendJson(res, 200, { pending: await listPendingVersions() })
}

// ── GET /api/admin/marketplace/ai-reviews ──────────────────────────────────
// AI 自动审批记录(review_source='ai',已 approved/rejected),供 admin 可见性 + 复核。
// escalate 项 status 仍 pending → 不在这里,而在 /pending 队列以「AI 意见」展示。
export async function handleAdminMarketplaceAiReviews(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret)
  sendJson(res, 200, { reviews: await listRecentAiReviews() })
}

// ── POST /api/admin/marketplace/:id/review ─────────────────────────────────
export async function handleAdminMarketplaceReview(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const versionId = slugFromPrefix(req, '/api/admin/marketplace/').replace(/\D.*$/, '')
  // path is /api/admin/marketplace/:id/review — extract the numeric id
  const m = (req.url ?? '').match(/\/api\/admin\/marketplace\/(\d+)\/review/)
  const id = m?.[1] ?? versionId
  if (!/^\d+$/.test(id)) throw new HttpError(400, 'BAD_ID', 'invalid version id')
  const body = (await readJsonBody(req)) as Record<string, unknown>
  const decision = body.decision
  if (decision !== 'approve' && decision !== 'reject')
    throw new HttpError(400, 'BAD_REQUEST', 'decision must be approve|reject')
  const note =
    decision === 'reject'
      ? rejectionNote(body.note)
      : typeof body.note === 'string'
        ? body.note.trim().slice(0, 2000) || undefined
        : undefined
  try {
    const kind = await getMarketplaceArtifactKind(id)
    if (kind === 'connector') {
      if (decision === 'approve') {
        const expectedSpecHash =
          typeof body.expectedSpecHash === 'string' ? body.expectedSpecHash.trim() : ''
        if (!/^[0-9a-f]{64}$/.test(expectedSpecHash))
          throw new HttpError(400, 'BAD_REQUEST', 'expectedSpecHash required')
        if (body.functionalVerified !== true)
          throw new HttpError(400, 'BAD_REQUEST', '必须确认已使用隔离账号完成功能验收')
        await approveMarketplaceConnectorVersion({
          versionId: id,
          reviewerUserId: uid(admin),
          securityDecision: body.securityDecision,
          expectedSpecHash,
          functionalVerified: true,
          note,
        })
      } else {
        await rejectMarketplaceConnectorVersion({
          versionId: id,
          reviewerUserId: uid(admin),
          note: note!,
        })
      }
    } else {
      await reviewVersion({
        versionId: id,
        reviewerUserId: uid(admin),
        approve: decision === 'approve',
        note,
        allowSelfReview: true,
      })
    }
    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: clientIpOf(req), userAgent: userAgentOf(req) },
      'marketplace.skill.review',
      `marketplace_version:${id}`,
      undefined,
      { decision, note: note ? note.slice(0, 200) : undefined, version_id: id },
    )
    sendJson(res, 200, { ok: true })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
}

// ── POST /api/admin/marketplace/review-batch ───────────────────────────────
export async function handleAdminMarketplaceReviewBatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const body = (await readJsonBody(req)) as Record<string, unknown>
  const decision = body.decision
  if (decision !== 'approve' && decision !== 'reject')
    throw new HttpError(400, 'BAD_REQUEST', 'decision must be approve|reject')
  if (!Array.isArray(body.versionIds))
    throw new HttpError(400, 'BAD_REQUEST', 'versionIds must be an array')
  if (body.versionIds.length === 0)
    throw new HttpError(400, 'BAD_REQUEST', 'versionIds must not be empty')
  if (body.versionIds.length > 100)
    throw new HttpError(400, 'BAD_REQUEST', '最多一次审核 100 个版本')

  const versionIds: string[] = []
  const seen = new Set<string>()
  for (const raw of body.versionIds) {
    const id =
      typeof raw === 'number' && Number.isInteger(raw)
        ? String(raw)
        : typeof raw === 'string'
          ? raw.trim()
          : ''
    if (!/^\d+$/.test(id)) throw new HttpError(400, 'BAD_ID', 'invalid version id')
    if (seen.has(id)) continue
    seen.add(id)
    versionIds.push(id)
  }
  if (versionIds.length === 0)
    throw new HttpError(400, 'BAD_REQUEST', 'versionIds must contain at least one id')

  const note =
    decision === 'reject'
      ? rejectionNote(body.note)
      : typeof body.note === 'string'
        ? body.note.trim().slice(0, 2000) || undefined
        : undefined
  const kinds = new Map<string, Awaited<ReturnType<typeof getMarketplaceArtifactKind>>>()
  for (const id of versionIds) kinds.set(id, await getMarketplaceArtifactKind(id))
  if (decision === 'approve' && [...kinds.values()].includes('connector'))
    throw new HttpError(
      400,
      'CONNECTOR_BATCH_APPROVE_FORBIDDEN',
      '连接器需逐个填写实际安全决策并确认功能验收',
    )
  const results = [] as Awaited<ReturnType<typeof reviewVersions>>
  for (const id of versionIds) {
    try {
      if (kinds.get(id) === 'connector') {
        await rejectMarketplaceConnectorVersion({
          versionId: id,
          reviewerUserId: uid(admin),
          note: note!,
        })
      } else {
        await reviewVersion({
          versionId: id,
          reviewerUserId: uid(admin),
          approve: decision === 'approve',
          note,
          allowSelfReview: true,
        })
      }
      results.push({ versionId: id, ok: true })
    } catch (e) {
      const mapped = mapMarketplaceError(e)
      results.push({
        versionId: id,
        ok: false,
        code: e instanceof MarketplaceError ? e.code : 'KIND_MISMATCH',
        message: mapped.message,
      })
    }
  }
  const failed = results.filter((r) => !r.ok).length
  const reviewed = results.length - failed
  // 一批一行:审计整批决定(decision + 提交的 version_ids + 成/败计数),不逐 version 展开。
  await writeAdminAuditBestEffort(
    { adminId: admin.id, ip: clientIpOf(req), userAgent: userAgentOf(req) },
    'marketplace.skill.review_batch',
    'marketplace_version:batch',
    undefined,
    { decision, version_ids: versionIds, reviewed, failed },
  )
  sendJson(res, 200, {
    ok: failed === 0,
    reviewed,
    failed,
    results,
  })
}

// ── POST /api/admin/marketplace/:slug/revoke ──────────────────────────────
// Kill-switch. Returns the affected installed user_ids (P2.3 notifies them).
export async function handleAdminMarketplaceRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const m = (req.url ?? '').match(/\/api\/admin\/marketplace\/([a-z0-9][a-z0-9-]{1,63})\/revoke/)
  const slug = m?.[1]
  if (!slug) throw new HttpError(400, 'BAD_SLUG', 'invalid slug')
  const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : 'revoked by admin'
  const affectedUserIds = await revokeListing(slug, reason)
  await writeAdminAuditBestEffort(
    { adminId: admin.id, ip: clientIpOf(req), userAgent: userAgentOf(req) },
    'marketplace.skill.revoke',
    `marketplace_listing:${slug}`,
    undefined,
    { reason, affected_installs: affectedUserIds.length },
  )
  sendJson(res, 200, { ok: true, affectedInstalls: affectedUserIds.length, affectedUserIds })
}

// ── POST /api/admin/marketplace/:slug/featured ─────────────────────────────
// 平台精选权重设置/取消(运维面)。body.featuredRank ∈ [1,9999] 的整数(越小越靠前)
// 或 null(取消精选)。目录排序服务端权威,写此值即调整市场卡片排序。
export async function handleAdminMarketplaceFeatured(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const m = (req.url ?? '').match(/\/api\/admin\/marketplace\/([a-z0-9][a-z0-9-]{1,63})\/featured/)
  const slug = m?.[1]
  if (!slug) throw new HttpError(400, 'BAD_SLUG', 'invalid slug')
  const body = (await readJsonBody(req)) as Record<string, unknown>
  const raw = body.featuredRank
  // null=取消精选;否则须为 [MIN,MAX] 的整数。校验失败给干净 400(DB 层另有兜底不变量)。
  let rank: number | null
  if (raw === null) {
    rank = null
  } else if (
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= FEATURED_RANK_MIN &&
    raw <= FEATURED_RANK_MAX
  ) {
    rank = raw
  } else {
    throw new HttpError(
      400,
      'BAD_REQUEST',
      `featuredRank 须为 ${FEATURED_RANK_MIN}..${FEATURED_RANK_MAX} 的整数或 null`,
    )
  }
  try {
    await setListingFeaturedRank(slug, rank)
    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: clientIpOf(req), userAgent: userAgentOf(req) },
      'marketplace.skill.featured',
      `marketplace_listing:${slug}`,
      undefined,
      { featured_rank: rank },
    )
    sendJson(res, 200, { ok: true, slug, featuredRank: rank })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
}
