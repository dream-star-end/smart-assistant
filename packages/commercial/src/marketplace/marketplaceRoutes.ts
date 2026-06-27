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
  getListingDetail,
  installApprovedVersion,
  listInstalled,
  listPendingVersions,
  publishSkillVersion,
  recordUninstall,
  reviewVersion,
  revokeListing,
} from './marketplaceDb.js'
import { scanSkillArtifact } from './skillScanner.js'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const MAX_BODY = 64 * 1024
// tags become a YAML inline-array in the canonical SKILL.md ([a, b]); reject any
// character that could break/inject that array (comma/bracket/quote/angle/newline).
const TAG_SAFE_RE = /^[^,[\]"'<>\r\n]{1,64}$/

function uid(user: { id: string }): number {
  const n = Number.parseInt(user.id, 10)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(401, 'UNAUTHORIZED', 'bad subject')
  return n
}

function asStr(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.length === 0)
    throw new HttpError(400, 'BAD_REQUEST', `${field} required`)
  if (v.length > max) throw new HttpError(400, 'BAD_REQUEST', `${field} too long`)
  return v
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
            e.code === 'KIND_MISMATCH'
          ? 409
          : e.code === 'VERSION_NOT_FOUND' || e.code === 'NOT_INSTALLABLE'
            ? 404
            : 400
    return new HttpError(status, e.code, e.message)
  }
  return e instanceof HttpError ? e : new HttpError(500, 'INTERNAL', 'marketplace error')
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

  const scan = scanSkillArtifact({ name, description, tags, body: skillBody })
  if (scan.blocked) {
    sendJson(res, 422, {
      error: { code: 'SCAN_BLOCKED', message: '发布被静态安全扫描拦截,请修正后重试' },
      riskFlags: scan.flags,
    })
    return
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
      embeddingHash: skillContentHash({ name, description, tags }),
      riskFlags: scan.flags,
      policyVersion: scan.policyVersion,
      submittedBy: uid(user),
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
    const v = await installApprovedVersion({ userId: uid(user), versionId })
    sendJson(res, 200, {
      ok: true,
      slug: v.slug,
      version: v.version,
      note: '已安装,将在你的下一次会话中对 AI 可用。',
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
  sendJson(res, 200, { installed: await listInstalled(uid(user)) })
}

// ── GET /api/marketplace/:slug ─────────────────────────────────────────────
// Full detail incl. the complete SKILL.md (the install-confirm dialog shows it).
export async function handleMarketplaceDetail(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { jwtSecret: string | Uint8Array },
): Promise<void> {
  await requireAuth(req, deps.jwtSecret)
  const slug = slugFromPrefix(req, '/api/marketplace/')
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'BAD_SLUG', 'invalid slug')
  const detail = await getListingDetail(slug)
  if (!detail) throw new HttpError(404, 'NOT_FOUND', 'skill 不存在或未上架')
  sendJson(res, 200, { detail })
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
  const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined
  try {
    await reviewVersion({
      versionId: id,
      reviewerUserId: uid(admin),
      approve: decision === 'approve',
      note,
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    throw mapMarketplaceError(e)
  }
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
