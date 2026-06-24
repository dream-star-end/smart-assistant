/**
 * Container-side marketplace hub reconciliation (pull model).
 *
 * On mcp-memory startup we ask master which marketplace skills this user has
 * installed (active, non-revoked) and reconcile ~/.openclaude/hub/skills/ to
 * match: write/refresh the approved SKILL.md (atomic), and remove any hub skill
 * that is no longer in the list (uninstalled OR revoked = kill-switch).
 *
 * Same UID as the agent, no master-writes-volume. Fail-soft: any error leaves
 * the existing hub untouched and mcp-memory still starts. No-op outside v3
 * (no OPENCLAUDE_V3_MASTER_BASE_URL / container token).
 */
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { marketplaceArtifactHash, paths } from '@openclaude/storage'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

interface SyncSkill {
  slug: string
  version: string
  rawSkillMd: string
  artifactHash: string
}

async function fetchInstalled(base: string, token: string): Promise<SyncSkill[] | null> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 8000)
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

/** Reconcile the hub/skills dir against the user's installed marketplace skills. */
export async function syncMarketplaceHub(): Promise<void> {
  const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token) return // not a v3 commercial container → nothing to sync

  const installed = await fetchInstalled(base, token)
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
