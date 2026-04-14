/**
 * HubStore — manages ClawHub-installed skills.
 *
 * Hub skills live in a shared directory (~/.openclaude/hub/skills/<slug>/)
 * and are available to ALL agents (unlike per-agent skills in SkillStore).
 *
 * Lockfile: ~/.openclaude/hub/lock.json tracks installed slugs + versions.
 *
 * Install flow:
 *   1. hubDownload(slug, version) → zip Buffer
 *   2. Extract zip to hub/skills/<slug>/
 *   3. Parse SKILL.md, validate
 *   4. Update lockfile
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { paths } from './paths.js'
import { parseFrontmatter, type SkillFrontmatter, type SkillMetadata } from './skillStore.js'
import { hubDownload, hubSearch, hubDetail, type HubSearchResult, type HubSkillDetail } from './clawhubClient.js'

export { hubSearch, type HubSearchResult, type HubSkillDetail }

export interface HubLockEntry {
  version: string
  installedAt: string
  displayName?: string
  description?: string
}

export type HubLockfile = Record<string, HubLockEntry>

// ── Lockfile helpers ──

async function readLock(): Promise<HubLockfile> {
  if (!existsSync(paths.hubLockfile)) return {}
  try {
    const raw = await readFile(paths.hubLockfile, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function writeLock(lock: HubLockfile): Promise<void> {
  await mkdir(paths.hubDir, { recursive: true })
  await writeFile(paths.hubLockfile, JSON.stringify(lock, null, 2))
}

// ── Extract zip buffer to a directory ──

async function extractZip(zipBuf: Buffer, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  // Write to temp file, then use system `unzip`
  const tmpZip = join(tmpdir(), `clawhub-${randomUUID()}.zip`)
  await writeFile(tmpZip, zipBuf)
  try {
    execSync(`unzip -o -q "${tmpZip}" -d "${destDir}"`, {
      stdio: 'pipe',
      timeout: 30_000,
    })
  } finally {
    try {
      await rm(tmpZip, { force: true })
    } catch {}
  }
}

// ── HubStore class ──

export class HubStore {
  /**
   * Search ClawHub registry.
   */
  async search(query: string, limit = 10): Promise<HubSearchResult[]> {
    return hubSearch(query, limit)
  }

  /**
   * Get detail of a specific skill from the hub.
   */
  async detail(slug: string): Promise<HubSkillDetail> {
    return hubDetail(slug)
  }

  /**
   * Install a skill from ClawHub.
   * Downloads the zip, extracts to hub/skills/<slug>/, updates lockfile.
   */
  async install(
    slug: string,
    version?: string,
    force = false,
  ): Promise<{ ok: boolean; error?: string; path?: string }> {
    const lock = await readLock()
    if (lock[slug] && !force) {
      return {
        ok: false,
        error: `"${slug}" already installed (v${lock[slug].version}). Use force=true to reinstall.`,
      }
    }

    let zipBuf: Buffer
    try {
      zipBuf = await hubDownload(slug, version)
    } catch (err: any) {
      return { ok: false, error: `Download failed: ${err.message}` }
    }

    const destDir = paths.hubSkillDir(slug)
    // Remove existing dir if force-reinstalling
    if (existsSync(destDir)) {
      await rm(destDir, { recursive: true, force: true })
    }

    try {
      await extractZip(zipBuf, destDir)
    } catch (err: any) {
      return { ok: false, error: `Extract failed: ${err.message}` }
    }

    // The zip may contain files in a nested directory or directly.
    // If SKILL.md is not in destDir root but in a single subdirectory, flatten.
    if (!existsSync(paths.hubSkillMd(slug))) {
      const entries = await readdir(destDir, { withFileTypes: true })
      const dirs = entries.filter((e) => e.isDirectory())
      if (dirs.length === 1) {
        // Move contents up from the single nested dir
        const nested = join(destDir, dirs[0].name)
        const nestedEntries = await readdir(nested)
        for (const ne of nestedEntries) {
          const src = join(nested, ne)
          const dst = join(destDir, ne)
          execSync(`mv "${src}" "${dst}"`, { stdio: 'pipe' })
        }
        await rm(nested, { recursive: true, force: true })
      }
    }

    // Validate: SKILL.md must exist
    if (!existsSync(paths.hubSkillMd(slug))) {
      await rm(destDir, { recursive: true, force: true })
      return { ok: false, error: `Invalid skill: no SKILL.md found in package "${slug}"` }
    }

    // Read metadata from SKILL.md
    let displayName = slug
    let description = ''
    let installedVersion = version ?? 'latest'
    try {
      const raw = await readFile(paths.hubSkillMd(slug), 'utf-8')
      const { meta } = parseFrontmatter(raw)
      displayName = meta.name || slug
      description = meta.description || ''
      if (meta.version) installedVersion = meta.version
    } catch {}

    // Update lockfile
    lock[slug] = {
      version: installedVersion,
      installedAt: new Date().toISOString(),
      displayName,
      description,
    }
    await writeLock(lock)

    return { ok: true, path: destDir }
  }

  /**
   * Uninstall a hub skill.
   */
  async uninstall(slug: string): Promise<{ ok: boolean; error?: string }> {
    const lock = await readLock()
    if (!lock[slug]) return { ok: false, error: `"${slug}" is not installed` }
    const dir = paths.hubSkillDir(slug)
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true })
    }
    delete lock[slug]
    await writeLock(lock)
    return { ok: true }
  }

  /**
   * List all installed hub skills. Reads lockfile + SKILL.md metadata.
   */
  async installed(): Promise<Array<HubLockEntry & { slug: string }>> {
    const lock = await readLock()
    return Object.entries(lock).map(([slug, entry]) => ({ slug, ...entry }))
  }

  /**
   * List installed hub skills as SkillMetadata (compatible with SkillStore.list()).
   * This enables seamless injection into the prompt alongside local skills.
   */
  async listAsSkillMetadata(): Promise<SkillMetadata[]> {
    const lock = await readLock()
    const result: SkillMetadata[] = []
    for (const [slug, entry] of Object.entries(lock)) {
      const skillMd = paths.hubSkillMd(slug)
      if (!existsSync(skillMd)) continue
      try {
        const raw = await readFile(skillMd, 'utf-8')
        const { meta } = parseFrontmatter(raw)
        result.push({
          name: meta.name || slug,
          description: meta.description || entry.description || '',
          version: meta.version || entry.version,
          tags: Array.isArray(meta.tags) ? meta.tags : undefined,
          related_skills: Array.isArray(meta.related_skills) ? meta.related_skills : undefined,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
          path: paths.hubSkillDir(slug),
        })
      } catch {}
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * View a hub skill's SKILL.md content.
   */
  async view(slug: string): Promise<{ meta: Partial<SkillFrontmatter>; body: string } | null> {
    const skillMd = paths.hubSkillMd(slug)
    if (!existsSync(skillMd)) return null
    const raw = await readFile(skillMd, 'utf-8')
    return parseFrontmatter(raw)
  }

  /**
   * Update a skill to a new version (re-download + re-install).
   */
  async update(
    slug: string,
    version?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.install(slug, version, true)
  }

  /**
   * Get the lockfile content.
   */
  async getLock(): Promise<HubLockfile> {
    return readLock()
  }
}
