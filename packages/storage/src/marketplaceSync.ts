/**
 * Container-side marketplace hub reconciliation (pull model).
 *
 * Asks master which marketplace skills this user has installed (active,
 * non-revoked) and reconciles ~/.openclaude/hub/skills/ to match: write/refresh
 * the approved SKILL.md (atomic), and remove any hub skill that is no longer in
 * the list (uninstalled OR revoked = kill-switch).
 *
 * Same UID as the agent, no master-writes-volume. Fail-soft: any error leaves
 * the existing hub untouched. No-op outside v3 (no OPENCLAUDE_V3_MASTER_BASE_URL
 * / container token).
 *
 * Lives in @openclaude/storage so BOTH the mcp-memory startup hook AND the
 * gateway runner's pre-prompt step can call it — the latter awaits it before
 * building the skills slot so a freshly-installed skill is in the next session's
 * static prompt (not merely eventual / tool-visible).
 */
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { paths } from './paths.js'
import { marketplaceArtifactHash } from './skillEmbedding.js'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

interface SyncSkill {
  slug: string
  version: string
  rawSkillMd: string
  artifactHash: string
}

async function fetchInstalled(
  base: string,
  token: string,
  timeoutMs: number,
): Promise<SyncSkill[] | null> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(`${base.replace(/\/+$/, '')}/internal/v3/marketplace/sync`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: ctl.signal,
      })
      if (!res.ok) return null
      const data = (await res.json()) as { skills?: unknown }
      if (!Array.isArray(data.skills)) return null
      const out: SyncSkill[] = []
      for (const s of data.skills) {
        if (!s || typeof s !== 'object') continue
        const o = s as Record<string, unknown>
        if (
          typeof o.slug === 'string' &&
          SLUG_RE.test(o.slug) &&
          typeof o.rawSkillMd === 'string' &&
          typeof o.artifactHash === 'string' &&
          typeof o.version === 'string'
        ) {
          out.push({
            slug: o.slug,
            version: o.version,
            rawSkillMd: o.rawSkillMd,
            artifactHash: o.artifactHash,
          })
        }
      }
      return out
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null // fail-soft
  }
}

/**
 * Reconcile the hub/skills dir against the user's installed marketplace skills.
 *
 * `timeoutMs` bounds the master fetch — callers on a latency-sensitive path
 * (the runner's pre-prompt sync) pass a small value so a slow/unreachable master
 * never stalls a new session; the background mcp-memory startup hook uses the
 * default.
 */
export async function syncMarketplaceHub(opts?: { timeoutMs?: number }): Promise<void> {
  const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token) return // not a v3 commercial container → nothing to sync

  const installed = await fetchInstalled(base, token, opts?.timeoutMs ?? 8000)
  if (installed === null) return // fetch failed → leave hub as-is

  const skillsRoot = join(paths.hubDir, 'skills')
  try {
    await mkdir(skillsRoot, { recursive: true })
  } catch {
    return
  }

  // Independently re-verify the artifact hash here — do NOT trust master's
  // rawSkillMd blindly. The container recomputes sha256 with the one shared
  // normalization (marketplaceArtifactHash) and drops any skill whose content
  // doesn't match its pinned hash, so a tampered/diverged artifact is treated as
  // not-installed (and removed below if a stale copy exists on disk).
  const desired = new Map<string, SyncSkill>()
  for (const s of installed) {
    if (marketplaceArtifactHash(s.rawSkillMd) !== s.artifactHash) continue
    desired.set(s.slug, s)
  }

  // 1) write/refresh desired skills (atomic temp+rename)
  for (const s of desired.values()) {
    try {
      const skillDir = paths.hubSkillDir(s.slug)
      // Never write through a symlink: if the slug dir was replaced with one,
      // skip it (fail-soft) rather than letting a write escape the hub root.
      const st = await lstat(skillDir).catch(() => null)
      if (st?.isSymbolicLink()) continue
      const mdPath = paths.hubSkillMd(s.slug)
      const cur = await readFile(mdPath, 'utf8').catch(() => null)
      if (cur === s.rawSkillMd) continue // already in sync
      await mkdir(skillDir, { recursive: true })
      const tmp = `${mdPath}.tmp-${process.pid}`
      await writeFile(tmp, s.rawSkillMd, 'utf8')
      await rename(tmp, mdPath) // atomic on same fs
    } catch {
      /* skip this one; fail-soft */
    }
  }

  // 2) remove hub skills no longer installed (uninstalled / revoked)
  try {
    const existing = await readdir(skillsRoot, { withFileTypes: true })
    for (const e of existing) {
      if (!e.isDirectory()) continue
      if (!SLUG_RE.test(e.name)) continue // never touch anything that isn't a valid slug dir
      if (!desired.has(e.name)) {
        await rm(join(skillsRoot, e.name), { recursive: true, force: true }).catch(() => {})
      }
    }
  } catch {
    /* leave as-is */
  }
}
