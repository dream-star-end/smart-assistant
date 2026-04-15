// SkillStore — per-agent skill library. Each skill is a directory:
//   ~/.openclaude/agents/<agentId>/skills/<skill-name>/
//     SKILL.md   — YAML frontmatter + markdown instructions
//     references/ — optional sub-docs (tier-3 progressive disclosure)
//     templates/  — optional output templates
//
// Skill name constraints: a-z 0-9 hyphen only, max 64 chars.
// Frontmatter: name, description (max 1024), version, tags[], related_skills[].
//
// Progressive disclosure:
//   tier 1 — list (name + description) → always visible in system prompt
//   tier 2 — view(name) → full SKILL.md
//   tier 3 — view(name, subfile) → a referenced file
//
// Ported from NousResearch/hermes-agent tools/skills_tool.py.

import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { paths } from './paths.js'

export const MAX_SKILL_NAME_LENGTH = 64
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024

const VALID_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const VALID_VERSION_RE = /^\d+\.\d+\.\d+$/
const VALID_AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/

export interface SkillFrontmatter {
  name: string
  description: string
  version?: string
  tags?: string[]
  related_skills?: string[]
  created_at?: string
  updated_at?: string
}

export interface SkillMetadata extends SkillFrontmatter {
  path: string // absolute dir path
}

export interface SkillContent extends SkillMetadata {
  body: string // the markdown after frontmatter
  rawContent: string // full SKILL.md
}

export function validateSkillName(name: string): { ok: boolean; error?: string } {
  if (!name) return { ok: false, error: 'skill name required' }
  if (name.length > MAX_SKILL_NAME_LENGTH)
    return { ok: false, error: `name too long (max ${MAX_SKILL_NAME_LENGTH})` }
  if (!VALID_SKILL_NAME_RE.test(name))
    return { ok: false, error: 'name must be lowercase a-z 0-9 hyphens' }
  return { ok: true }
}

// Minimal YAML frontmatter parser — no external dep, handles the subset we care about
export function parseFrontmatter(raw: string): { meta: Partial<SkillFrontmatter>; body: string } {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!fmMatch) return { meta: {}, body: raw }
  const fmText = fmMatch[1]
  const body = fmMatch[2] ?? ''
  const meta: Record<string, any> = {}
  let currentArray: string[] | null = null
  let currentArrayKey: string | null = null
  for (const rawLine of fmText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) {
      currentArray = null
      currentArrayKey = null
      continue
    }
    // Array item: "  - foo"
    const arrItem = line.match(/^\s*-\s*(.+)$/)
    if (arrItem && currentArray) {
      currentArray.push(stripQuotes(arrItem[1]))
      continue
    }
    // Key: value
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (kv) {
      const key = kv[1]
      const rawVal = kv[2].trim()
      currentArray = null
      currentArrayKey = null
      if (!rawVal) {
        // next lines might be array
        currentArray = []
        currentArrayKey = key
        meta[key] = currentArray
        continue
      }
      // Inline array: [a, b, c]
      if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        meta[key] = rawVal
          .slice(1, -1)
          .split(',')
          .map((s) => stripQuotes(s.trim()))
          .filter(Boolean)
        continue
      }
      meta[key] = stripQuotes(rawVal)
    }
  }
  return { meta: meta as Partial<SkillFrontmatter>, body }
}

export function formatFrontmatter(meta: SkillFrontmatter): string {
  const lines = ['---']
  lines.push(`name: ${meta.name}`)
  lines.push(`description: ${JSON.stringify(meta.description)}`)
  if (meta.version) lines.push(`version: ${meta.version}`)
  if (meta.tags && meta.tags.length > 0) lines.push(`tags: [${meta.tags.join(', ')}]`)
  if (meta.related_skills && meta.related_skills.length > 0)
    lines.push(`related_skills: [${meta.related_skills.join(', ')}]`)
  if (meta.created_at) lines.push(`created_at: ${meta.created_at}`)
  if (meta.updated_at) lines.push(`updated_at: ${meta.updated_at}`)
  lines.push('---')
  return lines.join('\n')
}

function stripQuotes(s: string): string {
  s = s.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/** Bump the patch segment of a semver-like version string. */
function bumpPatch(version: string): string {
  const parts = version.split('.')
  if (parts.length === 3) {
    const patch = parseInt(parts[2], 10)
    return `${parts[0]}.${parts[1]}.${Number.isNaN(patch) ? 1 : patch + 1}`
  }
  return `${version}.1`
}

/** Returns true if version matches strict N.N.N numeric format. */
function isValidVersion(version: string): boolean {
  return VALID_VERSION_RE.test(version)
}

/** Compare two N.N.N version strings numerically. Returns negative if a < b, positive if a > b. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export class SkillStore {
  constructor(private agentId: string) {
    if (!agentId || !VALID_AGENT_ID_RE.test(agentId)) {
      throw new Error(`invalid agentId: ${agentId}`)
    }
  }

  async list(): Promise<SkillMetadata[]> {
    const dir = paths.agentSkillsDir(this.agentId)
    if (!existsSync(dir)) return []
    const entries = await readdir(dir, { withFileTypes: true })
    const result: SkillMetadata[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const skillMd = paths.agentSkillMd(this.agentId, entry.name)
      if (!existsSync(skillMd)) continue
      try {
        const raw = await this.safeReadFile(skillMd)
        if (!raw) continue
        const { meta } = parseFrontmatter(raw)
        if (!meta.name || !meta.description) continue
        result.push({
          name: meta.name,
          description: meta.description,
          version: meta.version,
          tags: Array.isArray(meta.tags) ? meta.tags : undefined,
          related_skills: Array.isArray(meta.related_skills) ? meta.related_skills : undefined,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
          path: paths.agentSkillDir(this.agentId, entry.name),
        })
      } catch {}
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Resolve a path and verify it is a regular file contained within the skills root. */
  private async safeReadFile(filePath: string): Promise<string | null> {
    if (!existsSync(filePath)) return null
    const fileStat = await lstat(filePath)
    if (!fileStat.isFile()) return null
    const realFile = await realpath(filePath)
    const realRoot = await realpath(paths.agentSkillsDir(this.agentId))
    if (!realFile.startsWith(realRoot + sep)) return null
    return await readFile(realFile, 'utf-8')
  }

  async view(name: string, subfile?: string): Promise<SkillContent | string | null> {
    const v = validateSkillName(name)
    if (!v.ok) return null
    if (subfile) {
      const base = resolve(paths.agentSkillDir(this.agentId, name))
      const lexicalPath = resolve(base, subfile)
      if (!lexicalPath.startsWith(base + sep)) return null // path traversal guard
      return await this.safeReadFile(lexicalPath)
    }
    const skillMd = paths.agentSkillMd(this.agentId, name)
    const raw = await this.safeReadFile(skillMd)
    if (!raw) return null
    const { meta, body } = parseFrontmatter(raw)
    if (!meta.name || !meta.description) return null
    return {
      name: meta.name,
      description: meta.description,
      version: meta.version,
      tags: Array.isArray(meta.tags) ? meta.tags : undefined,
      related_skills: Array.isArray(meta.related_skills) ? meta.related_skills : undefined,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
      path: paths.agentSkillDir(this.agentId, name),
      body,
      rawContent: raw,
    }
  }

  async save(meta: SkillFrontmatter, body: string): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(meta.name)
    if (!v.ok) return { ok: false, error: v.error }
    if (!meta.description || meta.description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      return { ok: false, error: `description required, max ${MAX_SKILL_DESCRIPTION_LENGTH} chars` }
    }
    if (meta.version && !isValidVersion(meta.version)) {
      return { ok: false, error: 'invalid version format (expected N.N.N)' }
    }
    const skillDir = paths.agentSkillDir(this.agentId, meta.name)
    const skillMd = paths.agentSkillMd(this.agentId, meta.name)
    const now = new Date().toISOString()
    const isNew = !existsSync(skillMd)

    // Snapshot old version before overwriting
    let prevVersion = '1.0.0'
    if (!isNew) {
      const oldRaw = await this.safeReadFile(skillMd)
      if (!oldRaw) return { ok: false, error: 'failed to read existing skill for snapshot' }
      const { meta: oldMeta } = parseFrontmatter(oldRaw)
      prevVersion = oldMeta.version && isValidVersion(oldMeta.version) ? oldMeta.version : '1.0.0'
      // Save snapshot to history/<version>.md — write via resolved path
      const historyDir = join(skillDir, 'history')
      await mkdir(historyDir, { recursive: true })
      const realHistoryDir = await realpath(historyDir)
      const realRoot0 = await realpath(paths.agentSkillsDir(this.agentId))
      if (!realHistoryDir.startsWith(realRoot0 + sep)) {
        return { ok: false, error: 'history directory resolves outside skills root' }
      }
      const snapshotPath = join(realHistoryDir, `${prevVersion}.md`)
      // Reject if snapshot target already exists as symlink
      if (existsSync(snapshotPath)) {
        const snStat = await lstat(snapshotPath)
        if (snStat.isSymbolicLink()) {
          return { ok: false, error: 'snapshot target is a symlink' }
        }
      }
      await writeFile(snapshotPath, oldRaw)
    }

    // Auto-bump patch version if caller didn't specify
    const nextVersion = meta.version ?? (isNew ? '1.0.0' : bumpPatch(prevVersion))

    const mergedMeta: SkillFrontmatter = {
      ...meta,
      version: nextVersion,
      created_at: meta.created_at ?? (isNew ? now : undefined),
      updated_at: now,
    }
    await mkdir(skillDir, { recursive: true })
    // Verify write target resolves within skills root (guards against symlinked skill dirs)
    const realTarget = await realpath(skillDir)
    const realRoot = await realpath(paths.agentSkillsDir(this.agentId))
    if (!realTarget.startsWith(realRoot + sep)) {
      return { ok: false, error: 'skill directory resolves outside skills root' }
    }
    // Write to resolved path; reject symlinked SKILL.md
    const realSkillMd = join(realTarget, 'SKILL.md')
    if (existsSync(realSkillMd)) {
      const mdStat = await lstat(realSkillMd)
      if (mdStat.isSymbolicLink()) {
        return { ok: false, error: 'SKILL.md is a symlink' }
      }
    }
    const content = `${formatFrontmatter(mergedMeta)}\n\n${body.trim()}\n`
    await writeFile(realSkillMd, content)
    return { ok: true }
  }

  /** List version history for a skill. */
  async history(name: string): Promise<Array<{ version: string; timestamp: string }>> {
    const v = validateSkillName(name)
    if (!v.ok) return []
    const historyDir = join(paths.agentSkillDir(this.agentId, name), 'history')
    if (!existsSync(historyDir)) return []
    const realHistory = await realpath(historyDir)
    const realRoot = await realpath(paths.agentSkillsDir(this.agentId))
    if (!realHistory.startsWith(realRoot + sep)) return []
    const entries = await readdir(historyDir)
    const result: Array<{ version: string; timestamp: string }> = []
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      const version = entry.slice(0, -3)
      if (!isValidVersion(version)) continue
      try {
        const s = await stat(join(historyDir, entry))
        result.push({ version, timestamp: s.mtime.toISOString() })
      } catch { continue }
    }
    return result.sort((a, b) => compareSemver(b.version, a.version))
  }

  /** Restore a specific version from history. Creates a new version, does not reuse old number. */
  async restore(name: string, version: string): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(name)
    if (!v.ok) return { ok: false, error: v.error }
    if (!isValidVersion(version)) return { ok: false, error: 'invalid version format (expected N.N.N)' }
    const historyFile = join(paths.agentSkillDir(this.agentId, name), 'history', `${version}.md`)
    const raw = await this.safeReadFile(historyFile)
    if (!raw) return { ok: false, error: `version ${version} not found` }
    const { meta, body } = parseFrontmatter(raw)
    if (!meta.name || !meta.description) return { ok: false, error: 'invalid skill content' }
    // Strip version so save() will auto-bump from current version
    const { version: _discarded, ...metaWithoutVersion } = meta as SkillFrontmatter & { version?: string }
    return this.save(metaWithoutVersion as SkillFrontmatter, body)
  }

  async delete(name: string): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(name)
    if (!v.ok) return { ok: false, error: v.error }
    const dir = paths.agentSkillDir(this.agentId, name)
    if (!existsSync(dir)) return { ok: false, error: 'skill not found' }
    const realDir = await realpath(dir)
    const realRoot = await realpath(paths.agentSkillsDir(this.agentId))
    if (!realDir.startsWith(realRoot + sep)) {
      return { ok: false, error: 'skill directory resolves outside skills root' }
    }
    await rm(realDir, { recursive: true, force: true })
    return { ok: true }
  }
}
