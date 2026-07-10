/**
 * User- and admin-facing HTTP handlers for the skill marketplace.
 *
 * Registered in http/router.ts. User routes use requireAuth (browser JWT);
 * admin routes use requireAdminVerifyDb. Install (P2.2) is deliberately a
 * browser-only interactive route — agent containers must NOT be able to call
 * it (enforced by router.ts's agent-bypass guard + no user JWT in containers).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { marketplaceArtifactHash, skillContentHash } from '@openclaude/storage'

import { requireAdminVerifyDb } from '../admin/requireAdmin.js'
import { requireAuth } from '../http/auth.js'
import { HttpError, readJsonBody, sendJson } from '../http/util.js'
import {
  MarketplaceError,
  getApprovedSkillVersions,
  getInstallableVersionTarget,
  getListingDetail,
  installApprovedVersion,
  marketplaceAgentsEnabled,
  listActiveInstalledAgents,
  listInstalled,
  listMyPublishes,
  listPendingVersions,
  listRecentAiReviews,
  listPlatformPresetAgents,
  ownerUnlistListing,
  publishSkillVersion,
  recordUninstall,
  resolveCallerOrgId,
  reviewVersion,
  reviewVersions,
  revokeListing,
  updateInstalledAgentScope,
  withdrawPublishVersion,
} from './marketplaceDb.js'
import {
  VETTED_AGENT_TOOLSETS,
  canonicalizeAgentManifest,
  validateAgentManifest,
} from './agentManifest.js'
import {
  canonicalBundleJson,
  scanScriptContent,
  validateBenchmark,
  validateBundleFiles,
} from './bundle.js'
import { HumanMetaError, type HumanMeta, humanMetaScanBody, parseHumanMeta } from './marketplaceMeta.js'
import { platformPresetAgentSlugs } from './platformPresets.js'
import { scanSkillArtifact } from './skillScanner.js'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/
const MAX_BODY = 64 * 1024
// tags become a YAML inline-array in the canonical SKILL.md ([a, b]); reject any
// character that could break/inject that array (comma/bracket/quote/angle/newline).
const TAG_SAFE_RE = /^[^,[\]"'<>\r\n]{1,64}$/

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

function asTags(v: unknown): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw new HttpError(400, 'BAD_REQUEST', 'tags must be an array')
  const out: string[] = []
  for (const t of v) {
    if (typeof t !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'tag must be a string')
    const tag = t.trim()
    if (!tag) continue
    if (!TAG_SAFE_RE.test(tag)) throw new HttpError(400, 'BAD_REQUEST', 'tag 含非法字符')
    out.push(tag)
  }
  return out.slice(0, 16)
}

function asAgentIds(v: unknown, fallback: string[] = ['main']): string[] {
  const raw = v === undefined ? fallback : v
  if (!Array.isArray(raw)) throw new HttpError(400, 'BAD_AGENT_SCOPE', 'agentIds must be an array')
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') throw new HttpError(400, 'BAD_AGENT_SCOPE', 'agentIds must be strings')
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
  const body = (await readJsonBody(req)) as Record<string, unknown>
  const slug = asStr(body.slug, 'slug', 64)
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'BAD_SLUG', 'slug 须为小写字母数字连字符(2-64)')
  const version = asStr(body.version, 'version', 16)
  if (!VERSION_RE.test(version)) throw new HttpError(400, 'BAD_VERSION', 'version 须为 N.N.N')
  const name = asStr(body.name, 'name', 64)
  const description = asStr(body.description, 'description', 1024)
  const skillBody = asStr(body.body, 'body', MAX_BODY)
  const tags = asTags(body.tags)
  // 人向商品层元数据(必填 category/useCases;单一校验权威 parseHumanMeta)→ 校验失败 400。
  const humanMeta = parseHumanMetaOr400(body)

  // 附属文件(references/assets/evals;scripts 暂拒)+ 发布者自报评测摘要。
  const bundleV = validateBundleFiles(
    Array.isArray(body.files) ? (body.files as Array<{ path?: unknown; content?: unknown }>) : undefined,
  )
  if (!bundleV.ok) {
    sendJson(res, 422, {
      error: { code: 'BAD_BUNDLE', message: '附属文件不合法,请按提示修正' },
      errors: bundleV.errors,
    })
    return
  }
  const benchV = validateBenchmark(body.benchmark)
  if (!benchV.ok) {
    sendJson(res, 422, { error: { code: 'BAD_BENCHMARK', message: benchV.error } })
    return
  }

  const scan = scanSkillArtifact({ name, description, tags, body: skillBody })
  if (scan.blocked) {
    sendJson(res, 422, {
      error: { code: 'SCAN_BLOCKED', message: '发布被静态安全扫描拦截,请修正后重试' },
      riskFlags: scan.flags,
    })
    return
  }
  // 人向商品页文案(用例/效果/富介绍)与正文同规则扫描,防注入/密钥进商品页。
  if (humanMetaScanBlocked(res, name, humanMeta)) return
  // 逐附属文件走同一静态扫描(密钥/注入/内网地址等对文本文件同样适用);
  // scripts/ 额外过危险模式扫描:毁灭性/远程管道执行直接拦,可疑模式作为
  // warning flag 随版本入库(审核页可见,人审判断)。
  const scriptFlags: ReturnType<typeof scanScriptContent> = []
  if (bundleV.bundle) {
    for (const [path, content] of Object.entries(bundleV.bundle)) {
      const fscan = scanSkillArtifact({ name: slug, description: path, tags: [], body: content })
      if (fscan.blocked) {
        sendJson(res, 422, {
          error: { code: 'SCAN_BLOCKED', message: `附属文件 ${path} 被安全扫描拦截` },
          riskFlags: fscan.flags,
        })
        return
      }
      if (path.startsWith('scripts/')) {
        const sflags = scanScriptContent(path, content)
        const blocked = sflags.filter((f) => f.block)
        if (blocked.length > 0) {
          sendJson(res, 422, {
            error: { code: 'SCAN_BLOCKED', message: `脚本 ${path} 命中危险模式,发布被拦截` },
            riskFlags: sflags,
          })
          return
        }
        scriptFlags.push(...sflags)
      }
    }
  }

  // Reconstruct a canonical SKILL.md so the stored artifact == what installs.
  // The frontmatter `name` is the slug (NOT the display name): the runtime skill
  // overlay keys a skill by its frontmatter name AND resolves view() by the dir
  // name, and the hub writes each skill into a dir named after the slug. Using
  // the slug here keeps name===dir, so the installed skill is both listed and
  // viewable. The human-friendly `name` lives in the DB for the storefront only.
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

  const orgId = await resolvePublishOrgId(uid(user), body.visibility)
  try {
    const { versionId } = await publishSkillVersion({
      slug,
      ownerUserId: uid(user),
      version,
      name,
      description,
      tags,
      rawSkillMd,
      artifactHash: marketplaceArtifactHash(rawSkillMd),
      embeddingHash: skillContentHash({ name, description, tags, use_cases: humanMeta.useCases }),
      riskFlags: [...scan.flags, ...scriptFlags],
      policyVersion: scan.policyVersion,
      submittedBy: uid(user),
      rawBundle: bundleV.bundle,
      benchmark: benchV.benchmark,
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
      // 含 scripts 危险模式的 warning flag —— 发布者与审核者看到同一份提示。
      riskFlags: [...scan.flags, ...scriptFlags],
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
  // category/useCases/outcomeExamples/humanMd 同理:发布级 storefront 元数据,不进 manifest。
  for (const k of ['slug', 'category', 'useCases', 'outcomeExamples', 'humanMd']) delete manifestInput[k]
  const result = validateAgentManifest(manifestInput, {
    vettedToolsets: VETTED_AGENT_TOOLSETS,
    allowedModels,
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

  // every skillDep must resolve to an approved, active marketplace skill visible to the
  // publisher(公开 ∪ 本 org 私有);org-private 依赖对非本 org 发布者不解析 → 判未上架。
  if (manifest.skillDeps.length > 0) {
    const found = await getApprovedSkillVersions(manifest.skillDeps, orgId)
    const missing = manifest.skillDeps.filter((s) => !found.has(s))
    if (missing.length > 0) {
      sendJson(res, 422, {
        error: {
          code: 'UNAPPROVED_SKILLDEP',
          message: `依赖技能未上架或未批准：${missing.join(', ')}`,
        },
      })
      return
    }
  }

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
  const toRow = (a: { slug: string; version: string; rawManifest: string }, preset: boolean) => {
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
      ...(preset ? { preset: true } : {}),
    }
  }
  const agents = [
    ...presets.map((p) => toRow(p, true)),
    ...installed.filter((a) => !presetSet.has(a.slug)).map((a) => toRow(a, false)),
  ]
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
    if (!target) throw new MarketplaceError('NOT_INSTALLABLE', 'skill 不可安装(未上架/已下架/非当前版本)')
    const selectedAgentIds =
      target.kind === 'skill' ? await validateAssignableAgentScope(userId, body.agentIds) : undefined
    const v = await installApprovedVersion({
      userId,
      versionId,
      callerOrgId,
      ...(selectedAgentIds ? { agentIds: selectedAgentIds, scopeMode: 'replace' as const } : {}),
    })

    // Installing an agent pulls in its (already-approved) skill dependencies so the
    // agent works out of the box. Best-effort + idempotent: a dep already installed
    // is re-pinned to its current approved version; a failure on one dep never fails
    // the agent install.
    let installedDeps = 0
    const detail = await getListingDetail(v.slug, callerOrgId)
    if (detail?.kind === 'agent') {
      const deps2 = Array.isArray((detail.manifest as { skillDeps?: unknown })?.skillDeps)
        ? ((detail.manifest as { skillDeps: unknown[] }).skillDeps.filter(
            (s) => typeof s === 'string',
          ) as string[])
        : []
      if (deps2.length > 0) {
        const versions = await getApprovedSkillVersions(deps2, callerOrgId)
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
            /* skip a single failing dep; agent install already recorded */
          }
        }
      }
    }

    sendJson(res, 200, {
      ok: true,
      slug: v.slug,
      version: v.version,
      installedDeps,
      note:
        detail?.kind === 'agent'
          ? `已安装,将在你的下一次会话中可选用${installedDeps ? `（含 ${installedDeps} 个依赖技能）` : ''}。`
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
  sendJson(res, 200, { installed: rows })
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
  sendJson(res, 200, { publishes: await listMyPublishes(uid(user)) })
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
  // 平台预设标记(加法字段):前端据此显示「开箱即用」而非安装按钮。
  const preset = detail.kind === 'agent' && (await platformPresetAgentSlugs()).includes(slug)
  sendJson(res, 200, { detail: preset ? { ...detail, preset: true } : detail })
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
  const ok = await recordUninstall(uid(user), slug)
  sendJson(res, 200, { ok })
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
    await reviewVersion({
      versionId: id,
      reviewerUserId: uid(admin),
      approve: decision === 'approve',
      note,
      // This route is already protected by requireAdminVerifyDb. Admins are allowed
      // to approve/reject their own marketplace submissions so platform-owned
      // skills can be published without a second admin account.
      allowSelfReview: true,
    })
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
  const results = await reviewVersions({
    versionIds,
    reviewerUserId: uid(admin),
    approve: decision === 'approve',
    note,
    // Same policy as the single admin review route: this route is admin-only,
    // so platform-owned submissions can be reviewed without a second admin.
    allowSelfReview: true,
  })
  const failed = results.filter((r) => !r.ok).length
  sendJson(res, 200, {
    ok: failed === 0,
    reviewed: results.length - failed,
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
  await requireAdminVerifyDb(req, deps.jwtSecret)
  const m = (req.url ?? '').match(/\/api\/admin\/marketplace\/([a-z0-9][a-z0-9-]{1,63})\/revoke/)
  const slug = m?.[1]
  if (!slug) throw new HttpError(400, 'BAD_SLUG', 'invalid slug')
  const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : 'revoked by admin'
  const affectedUserIds = await revokeListing(slug, reason)
  sendJson(res, 200, { ok: true, affectedInstalls: affectedUserIds.length, affectedUserIds })
}
