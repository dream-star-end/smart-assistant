// SkillStore — overlayed skill library.
//
// Layers (read priority high→low; name-dedup, higher layer wins):
//   1. platform-baseline  (ro)  — /run/oc/claude-config/skills (v3 ro mount)
//   2. agent-seed         (ro)  — ~/.openclaude/agents/<id>/seed-skills/   (platform per-agent seed)
//   3. shared             (rw)  — ~/.openclaude/skills/                    (user-level, ALL agents; single write source)
//   4. legacy             (ro)  — ~/.openclaude/agents/<id>/skills/        (old per-agent user skills; migration-only)
//
// Each skill is a directory:
//   <root>/<skill-name>/
//     SKILL.md   — YAML frontmatter + markdown instructions
//     references/ — optional sub-docs (tier-3 progressive disclosure)
//     templates/  — optional output templates
//
// Write source: when `sharedDir` is provided, all writes (save/history/restore)
// go to the shared root and the per-agent dir is read-only legacy. When it is
// NOT provided (personal/local single-root callers), writes fall back to the
// per-agent dir (legacy two-layer behavior: baseline + per-agent userRoot).
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

import { randomUUID } from 'node:crypto'
import { type Dirent, type Stats, existsSync, realpathSync, statSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
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

export type SkillSource = 'user' | 'platform'

/** Precise overlay layer a skill was resolved from. ('hub' = ClawHub-installed; not wired into the runtime overlay yet.) */
export type SkillLayer = 'platform' | 'agent-seed' | 'shared' | 'legacy' | 'hub'

export interface SkillMetadata extends SkillFrontmatter {
  path: string // absolute dir path
  source: SkillSource // 'user' = self-authored; 'platform' = platform baseline/seed (ro)
  layer: SkillLayer // precise overlay layer
  writable: boolean // true iff editable/deletable through THIS store (shared, or legacy write-fallback)
}

export interface SkillContent extends SkillMetadata {
  body: string // the markdown after frontmatter
  rawContent: string // full SKILL.md
}

export interface SkillSearchResult extends SkillMetadata {
  score: number
  matched: string[]
}

function normalizeSearchText(s: string): string {
  return s.trim().toLocaleLowerCase()
}

function compactSearchText(s: string): string {
  return normalizeSearchText(s).replace(/[^\p{L}\p{N}]+/gu, '')
}

function searchTokens(query: string): string[] {
  return [
    ...new Set(
      normalizeSearchText(query)
        .split(/[^\p{L}\p{N}-]+/u)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ]
}

function boundedSearchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 5
  return Math.min(Math.max(Math.floor(limit as number), 1), 25)
}

/**
 * Deterministic local search over already-visible skill metadata.
 *
 * This deliberately searches only metadata (name / description / tags /
 * related_skills), never SKILL.md bodies. It is meant for tier-1 discovery:
 * find candidate skills cheaply, then use `skill_view(name)` for full
 * instructions when a candidate looks relevant.
 */
export function searchSkillMetadata(
  skillList: SkillMetadata[],
  query: string,
  limit?: number,
): SkillSearchResult[] {
  const q = normalizeSearchText(query)
  if (!q) return []

  const tokens = searchTokens(q)
  if (tokens.length === 0) return []

  const compactQuery = compactSearchText(q)
  const maxResults = boundedSearchLimit(limit)
  const results: SkillSearchResult[] = []

  for (const skill of skillList) {
    const name = normalizeSearchText(skill.name)
    const description = normalizeSearchText(skill.description)
    const tags = (skill.tags ?? []).map(normalizeSearchText)
    const related = (skill.related_skills ?? []).map(normalizeSearchText)
    const matched = new Set<string>()
    let score = 0

    if (name === q) {
      score += 100
      matched.add('name:exact')
    } else if (name.includes(q)) {
      score += 70
      matched.add('name')
    }
    if (compactQuery && compactSearchText(name) === compactQuery) {
      score += 85
      matched.add('name:compact')
    }
    if (description.includes(q)) {
      score += 45
      matched.add('description')
    }
    if (tags.includes(q)) {
      score += 55
      matched.add('tags:exact')
    } else if (tags.some((tag) => tag.includes(q))) {
      score += 35
      matched.add('tags')
    }
    if (related.includes(q)) {
      score += 35
      matched.add('related_skills:exact')
    } else if (related.some((r) => r.includes(q))) {
      score += 20
      matched.add('related_skills')
    }

    for (const token of tokens) {
      if (token === q) continue
      if (name === token) {
        score += 60
        matched.add(`name:${token}`)
      } else if (name.includes(token)) {
        score += 30
        matched.add(`name:${token}`)
      }
      if (description.includes(token)) {
        score += 12
        matched.add(`description:${token}`)
      }
      if (tags.includes(token)) {
        score += 28
        matched.add(`tags:${token}`)
      } else if (tags.some((tag) => tag.includes(token))) {
        score += 14
        matched.add(`tags:${token}`)
      }
      if (related.includes(token)) {
        score += 18
        matched.add(`related_skills:${token}`)
      } else if (related.some((r) => r.includes(token))) {
        score += 9
        matched.add(`related_skills:${token}`)
      }
    }

    if (score > 0) {
      results.push({
        ...skill,
        score,
        matched: [...matched].sort(),
      })
    }
  }

  return results
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, maxResults)
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
    const patch = Number.parseInt(parts[2], 10)
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

export interface SkillStoreOptions {
  /**
   * Optional read-only platform baseline skills directory. When set, entries here
   * win on read paths and are rejected on write paths (save with colliding name).
   * Must be an absolute, existing directory. Constructor throws on invalid input;
   * resolvers (e.g. mcp-memory) should catch + warn + retry with undefined.
   */
  baselineDir?: string
  /**
   * Optional read-only per-agent platform seed directory
   * (~/.openclaude/agents/<id>/seed-skills). Like baseline, wins over user layers
   * and is reserved on write. Unlike baseline, a missing dir is tolerated (→ null):
   * not every agent has seeds. Must be absolute when provided. Ignored in
   * aggregateLegacy (user-level) mode.
   */
  agentSeedDir?: string
  /**
   * Optional user-level shared skills root (~/.openclaude/skills). When set this
   * becomes the single authoritative WRITE source (visible to all of a user's
   * agents) and the per-agent dir degrades to a read-only legacy layer. May not
   * exist yet — it is created safely on first write. Must be absolute AND resolve
   * within paths.home (guards against widening the write surface).
   */
  sharedDir?: string
  /**
   * User-level aggregation mode (for the agentId-less `/api/skills` surface).
   * When true, the legacy layer aggregates ALL agents' `agents/<id>/skills` dirs and
   * the per-agent agent-seed layer is NOT loaded. Requires sharedDir.
   */
  aggregateLegacy?: boolean
}

export class SkillStore {
  private readonly agentId: string
  /** Absolute, realpath-resolved baseline root (platform ro), or null. */
  private readonly baselineRoot: string | null
  /** Absolute, realpath-resolved per-agent seed root (platform ro), or null. */
  private readonly agentSeedRoot: string | null
  /** Absolute (lexically resolved) shared root, or null. May not exist yet. */
  private readonly sharedRoot: string | null
  /** Aggregate all agents' legacy dirs on read (user-level surface). */
  private readonly aggregateLegacy: boolean
  /** Absolute write target: shared (when sharedRoot set) else per-agent legacy dir. */
  private readonly writeRoot: string

  constructor(agentId: string, opts: SkillStoreOptions = {}) {
    if (!agentId || !VALID_AGENT_ID_RE.test(agentId)) {
      throw new Error(`invalid agentId: ${agentId}`)
    }
    this.agentId = agentId

    // --- baseline (ro, must exist when provided) ---
    this.baselineRoot =
      opts.baselineDir != null ? resolveExistingDir(opts.baselineDir, 'baselineDir') : null

    // --- agent-seed (ro, missing tolerated; not loaded in aggregate mode) ---
    if (opts.agentSeedDir != null && !opts.aggregateLegacy) {
      if (!isAbsolute(opts.agentSeedDir)) {
        throw new Error(`agentSeedDir must be an absolute path: ${opts.agentSeedDir}`)
      }
      this.agentSeedRoot = existsSync(opts.agentSeedDir)
        ? resolveExistingDir(opts.agentSeedDir, 'agentSeedDir')
        : null
    } else {
      this.agentSeedRoot = null
    }

    // --- shared (rw, may not exist yet; must resolve within HOME) ---
    if (opts.sharedDir != null) {
      const sd = opts.sharedDir
      if (!isAbsolute(sd)) {
        throw new Error(`sharedDir must be an absolute path: ${sd}`)
      }
      // Resolve through symlinks when the dir exists, so a symlinked shared root
      // cannot escape home and have read paths scan outside it. When absent, use a
      // lexical resolve (ensureWriteRoot re-validates via realpath on first write).
      const resolved = existsSync(sd) ? realpathSync(sd) : resolve(sd)
      const homeResolved = existsSync(paths.home) ? realpathSync(paths.home) : resolve(paths.home)
      if (resolved !== homeResolved && !resolved.startsWith(homeResolved + sep)) {
        throw new Error(`sharedDir must resolve within home (${paths.home}): ${sd}`)
      }
      this.sharedRoot = resolved
    } else {
      this.sharedRoot = null
    }

    this.aggregateLegacy = Boolean(opts.aggregateLegacy)
    if (this.aggregateLegacy && !this.sharedRoot) {
      throw new Error('aggregateLegacy requires sharedDir')
    }

    // Write target: shared if available, else the per-agent legacy dir (back-compat).
    this.writeRoot = this.sharedRoot ?? paths.agentSkillsDir(agentId)
  }

  /** Legacy (read-only) roots: per-agent dir, or every agent's dir in aggregate mode. */
  private async legacyRoots(): Promise<string[]> {
    if (!this.aggregateLegacy) {
      return [paths.agentSkillsDir(this.agentId)]
    }
    const agentsDir = paths.agentsDir
    if (!existsSync(agentsDir)) return []
    let entries: Dirent[]
    try {
      entries = await readdir(agentsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const roots: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!VALID_AGENT_ID_RE.test(entry.name)) continue
      roots.push(paths.agentSkillsDir(entry.name))
    }
    return roots
  }

  async list(): Promise<SkillMetadata[]> {
    const result: SkillMetadata[] = []
    const seen = new Set<string>()
    const push = (items: SkillMetadata[]) => {
      for (const item of items) {
        if (seen.has(item.name)) continue
        seen.add(item.name)
        result.push(item)
      }
    }
    // 1) platform baseline (highest priority)
    if (this.baselineRoot) {
      push(await this.scanRoot(this.baselineRoot, 'platform', 'platform', false))
    }
    // 2) per-agent platform seed
    if (this.agentSeedRoot) {
      push(await this.scanRoot(this.agentSeedRoot, 'platform', 'agent-seed', false))
    }
    // 3) shared (user-level write source)
    if (this.sharedRoot) {
      push(await this.scanRoot(this.sharedRoot, 'user', 'shared', true))
    }
    // 4) legacy per-agent (read-only; write-fallback when no sharedRoot)
    const legacyWritable = this.sharedRoot == null
    for (const legacyRoot of await this.legacyRoots()) {
      push(await this.scanRoot(legacyRoot, 'user', 'legacy', legacyWritable))
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async scanRoot(
    rootDir: string,
    source: SkillSource,
    layer: SkillLayer,
    writable: boolean,
  ): Promise<SkillMetadata[]> {
    if (!existsSync(rootDir)) return []
    let entries: Dirent[]
    try {
      entries = await readdir(rootDir, { withFileTypes: true })
    } catch {
      return []
    }
    const result: SkillMetadata[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const skillMd = join(rootDir, entry.name, 'SKILL.md')
      try {
        const raw = await this.safeReadFile(skillMd, rootDir)
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
          path: join(rootDir, entry.name),
          source,
          layer,
          writable,
        })
      } catch {}
    }
    return result
  }

  /**
   * Resolve a path and verify it is a regular file contained within `rootDir`.
   * `rootDir` is an explicit parameter so the same primitive guards every layer's
   * reads without conflating their boundaries.
   */
  private async safeReadFile(filePath: string, rootDir: string): Promise<string | null> {
    if (!existsSync(filePath)) return null
    const fileStat = await lstat(filePath)
    if (!fileStat.isFile()) return null
    const realFile = await realpath(filePath)
    const realRoot = await realpath(rootDir)
    if (!realFile.startsWith(realRoot + sep)) return null
    return await readFile(realFile, 'utf-8')
  }

  /** True iff `rootDir` has a readable SKILL.md for `name` (via realpath containment). */
  private async rootHas(rootDir: string | null, name: string): Promise<boolean> {
    if (!rootDir) return false
    const v = validateSkillName(name)
    if (!v.ok) return false
    if (!existsSync(rootDir)) return false
    const skillMd = join(rootDir, name, 'SKILL.md')
    const raw = await this.safeReadFile(skillMd, rootDir)
    return raw !== null
  }

  /**
   * True iff ANY agent has a platform seed named `name` (agents/<id>/seed-skills/<name>).
   * Used to reserve seed names against shared-library writes regardless of which
   * agent (or the agentId-less user-level store) is performing the save.
   */
  private async anyAgentSeedHas(name: string): Promise<boolean> {
    if (!validateSkillName(name).ok) return false
    const agentsDir = paths.agentsDir
    if (!existsSync(agentsDir)) return false
    let entries: Dirent[]
    try {
      entries = await readdir(agentsDir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!VALID_AGENT_ID_RE.test(entry.name)) continue
      if (await this.rootHas(paths.agentSeedSkillsDir(entry.name), name)) return true
    }
    return false
  }

  async view(name: string, subfile?: string): Promise<SkillContent | string | null> {
    const v = validateSkillName(name)
    if (!v.ok) return null
    // Read priority: baseline > agent-seed > shared > legacy.
    if (await this.rootHas(this.baselineRoot, name)) {
      return this.viewFromRoot(
        name,
        subfile,
        this.baselineRoot as string,
        'platform',
        'platform',
        false,
      )
    }
    if (await this.rootHas(this.agentSeedRoot, name)) {
      return this.viewFromRoot(
        name,
        subfile,
        this.agentSeedRoot as string,
        'platform',
        'agent-seed',
        false,
      )
    }
    if (await this.rootHas(this.sharedRoot, name)) {
      return this.viewFromRoot(name, subfile, this.sharedRoot as string, 'user', 'shared', true)
    }
    const legacyWritable = this.sharedRoot == null
    for (const legacyRoot of await this.legacyRoots()) {
      if (await this.rootHas(legacyRoot, name)) {
        return this.viewFromRoot(name, subfile, legacyRoot, 'user', 'legacy', legacyWritable)
      }
    }
    return null
  }

  private async viewFromRoot(
    name: string,
    subfile: string | undefined,
    rootDir: string,
    source: SkillSource,
    layer: SkillLayer,
    writable: boolean,
  ): Promise<SkillContent | string | null> {
    if (subfile) {
      const base = resolve(join(rootDir, name))
      const lexicalPath = resolve(base, subfile)
      if (!lexicalPath.startsWith(base + sep)) return null // path traversal guard
      return await this.safeReadFile(lexicalPath, rootDir)
    }
    const skillMd = join(rootDir, name, 'SKILL.md')
    const raw = await this.safeReadFile(skillMd, rootDir)
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
      path: join(rootDir, name),
      body,
      rawContent: raw,
      source,
      layer,
      writable,
    }
  }

  /** Ensure the write root exists; create it safely and verify it stays within HOME. */
  private async ensureWriteRoot(): Promise<{ ok: boolean; error?: string }> {
    await mkdir(this.writeRoot, { recursive: true })
    const realWrite = await realpath(this.writeRoot)
    const realHome = await realpath(paths.home)
    if (realWrite !== realHome && !realWrite.startsWith(realHome + sep)) {
      return { ok: false, error: 'write root resolves outside home' }
    }
    return { ok: true }
  }

  async save(meta: SkillFrontmatter, body: string): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(meta.name)
    if (!v.ok) return { ok: false, error: v.error }
    // Reserved-name guards: platform layers are authoritative; users must pick a
    // different name (otherwise their write would be shadowed and invisible).
    if (await this.rootHas(this.baselineRoot, meta.name)) {
      return {
        ok: false,
        error: `name '${meta.name}' reserved for platform baseline skill — choose a different name`,
      }
    }
    if (await this.rootHas(this.agentSeedRoot, meta.name)) {
      return {
        ok: false,
        error: `name '${meta.name}' reserved for platform agent-seed skill — choose a different name`,
      }
    }
    // Writes to the shared (all-agents) library must also avoid ANY agent's seed
    // name — otherwise the shared skill would be shadowed (agent-seed > shared) and
    // invisible for that agent. This covers the agentId-less /api/skills path (whose
    // store has no agentSeedRoot) and per-agent stores writing to shared alike.
    if (this.sharedRoot && (await this.anyAgentSeedHas(meta.name))) {
      return {
        ok: false,
        error: `name '${meta.name}' reserved for a platform agent-seed skill — choose a different name`,
      }
    }
    if (!meta.description || meta.description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      return { ok: false, error: `description required, max ${MAX_SKILL_DESCRIPTION_LENGTH} chars` }
    }
    if (meta.version && !isValidVersion(meta.version)) {
      return { ok: false, error: 'invalid version format (expected N.N.N)' }
    }

    const ensured = await this.ensureWriteRoot()
    if (!ensured.ok) return ensured

    const skillDir = join(this.writeRoot, meta.name)
    const skillMd = join(skillDir, 'SKILL.md')
    const now = new Date().toISOString()
    const isNew = !existsSync(skillMd)

    // Snapshot old version before overwriting
    let prevVersion = '1.0.0'
    if (!isNew) {
      const oldRaw = await this.safeReadFile(skillMd, this.writeRoot)
      if (!oldRaw) return { ok: false, error: 'failed to read existing skill for snapshot' }
      const { meta: oldMeta } = parseFrontmatter(oldRaw)
      prevVersion = oldMeta.version && isValidVersion(oldMeta.version) ? oldMeta.version : '1.0.0'
      // Save snapshot to history/<version>.md — write via resolved path
      const historyDir = join(skillDir, 'history')
      await mkdir(historyDir, { recursive: true })
      const realHistoryDir = await realpath(historyDir)
      const realRoot0 = await realpath(this.writeRoot)
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
      const tmpSnap = join(realHistoryDir, `.${prevVersion}.md.tmp-${randomUUID()}`)
      try {
        await writeFile(tmpSnap, oldRaw)
        await rename(tmpSnap, snapshotPath)
      } catch (err) {
        await rm(tmpSnap, { force: true }).catch(() => {})
        throw err
      }
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
    // Verify write target resolves within the write root (guards symlinked skill dirs)
    const realTarget = await realpath(skillDir)
    const realRoot = await realpath(this.writeRoot)
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
    // Atomic write: write a sibling temp then rename, so concurrent readers never
    // observe a half-written SKILL.md (and a crash mid-write leaves the old file).
    const tmpMd = join(realTarget, `.SKILL.md.tmp-${randomUUID()}`)
    try {
      await writeFile(tmpMd, content)
      await rename(tmpMd, realSkillMd)
    } catch (err) {
      await rm(tmpMd, { force: true }).catch(() => {})
      throw err
    }
    return { ok: true }
  }

  /** List version history for a skill (from the write root). */
  async history(name: string): Promise<Array<{ version: string; timestamp: string }>> {
    const v = validateSkillName(name)
    if (!v.ok) return []
    const historyDir = join(this.writeRoot, name, 'history')
    if (!existsSync(historyDir)) return []
    const realHistory = await realpath(historyDir)
    const realRoot = await realpath(this.writeRoot)
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
      } catch {}
    }
    return result.sort((a, b) => compareSemver(b.version, a.version))
  }

  /** Restore a specific version from history. Creates a new version, does not reuse old number. */
  async restore(name: string, version: string): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(name)
    if (!v.ok) return { ok: false, error: v.error }
    if (!isValidVersion(version))
      return { ok: false, error: 'invalid version format (expected N.N.N)' }
    const historyFile = join(this.writeRoot, name, 'history', `${version}.md`)
    const raw = await this.safeReadFile(historyFile, this.writeRoot)
    if (!raw) return { ok: false, error: `version ${version} not found` }
    const { meta, body } = parseFrontmatter(raw)
    if (!meta.name || !meta.description) return { ok: false, error: 'invalid skill content' }
    // Strip version so save() will auto-bump from current version
    const { version: _discarded, ...metaWithoutVersion } = meta as SkillFrontmatter & {
      version?: string
    }
    return this.save(metaWithoutVersion as SkillFrontmatter, body)
  }

  /**
   * Remove same-named legacy residue across ALL agents' `agents/<id>/skills/<name>`.
   * Only used in shared-write mode. NEVER touches seed-skills/baseline/shared.
   * Returns the number of legacy dirs removed.
   */
  private async cleanLegacyResidue(name: string): Promise<number> {
    const v = validateSkillName(name)
    if (!v.ok) return 0
    const agentsDir = paths.agentsDir
    if (!existsSync(agentsDir)) return 0
    let entries: Dirent[]
    try {
      entries = await readdir(agentsDir, { withFileTypes: true })
    } catch {
      return 0
    }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!VALID_AGENT_ID_RE.test(entry.name)) continue
      const legacyRoot = paths.agentSkillsDir(entry.name) // .../skills (NOT seed-skills)
      const dir = join(legacyRoot, name)
      if (!existsSync(dir)) continue
      try {
        const st = await lstat(dir)
        if (st.isSymbolicLink()) continue // never follow/delete through a symlink
        const realDir = await realpath(dir)
        const realRoot = await realpath(legacyRoot)
        if (!realDir.startsWith(realRoot + sep)) continue
        await rm(realDir, { recursive: true, force: true })
        removed++
      } catch {}
    }
    return removed
  }

  /**
   * Delete semantics:
   *  Shared-write mode (sharedRoot set):
   *    - remove the shared copy (if present) AND clean same-named legacy residue
   *      across all agents, so no other agent re-surfaces it.
   *    - baseline / agent-seed names cannot be deleted.
   *  Legacy fallback mode (no sharedRoot):
   *    - user has it + baseline has it  → remove user shadow; baseline remains
   *    - user has it + baseline absent  → standard user delete
   *    - user absent + baseline has it  → reject
   *    - user absent + baseline absent  → skill not found
   */
  async delete(name: string): Promise<{ ok: boolean; error?: string; note?: string }> {
    const v = validateSkillName(name)
    if (!v.ok) return { ok: false, error: v.error }

    const baselineExists = await this.rootHas(this.baselineRoot, name)
    const seedExists = await this.rootHas(this.agentSeedRoot, name)

    const dir = join(this.writeRoot, name)
    const writeExists = existsSync(dir)

    if (writeExists) {
      const realDir = await realpath(dir)
      const realRoot = await realpath(this.writeRoot)
      if (!realDir.startsWith(realRoot + sep)) {
        return { ok: false, error: 'skill directory resolves outside skills root' }
      }
      await rm(realDir, { recursive: true, force: true })
    }

    // Shared mode: always sweep legacy residue across all agents.
    let legacyRemoved = 0
    if (this.sharedRoot) {
      legacyRemoved = await this.cleanLegacyResidue(name)
    }

    if (!writeExists && legacyRemoved === 0) {
      if (baselineExists || seedExists) {
        return { ok: false, error: `cannot delete platform skill '${name}'` }
      }
      return { ok: false, error: 'skill not found' }
    }

    if (baselineExists || seedExists) {
      return { ok: true, note: `removed user copy; platform skill '${name}' remains` }
    }
    if (this.sharedRoot && !writeExists && legacyRemoved > 0) {
      return { ok: true, note: 'removed legacy residue' }
    }
    return { ok: true }
  }
}

/** Validate + realpath-resolve a directory that MUST already exist. */
function resolveExistingDir(dir: string, label: string): string {
  if (!isAbsolute(dir)) {
    throw new Error(`${label} must be an absolute path: ${dir}`)
  }
  let st: Stats
  try {
    st = statSync(dir)
  } catch (err: any) {
    throw new Error(`${label} stat failed: ${err?.message ?? err}`)
  }
  if (!st.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dir}`)
  }
  try {
    return realpathSync(dir)
  } catch (err: any) {
    throw new Error(`${label} realpath failed: ${err?.message ?? err}`)
  }
}

/**
 * Resolve the platform baseline skills dir from the environment.
 * Only the explicit `OPENCLAUDE_BASELINE_SKILLS_DIR` env is honored — we
 * deliberately avoid fallbacks like `${CLAUDE_CONFIG_DIR}/skills` because that
 * env is common in personal/local setups where the dir holds user-writable
 * skills (not a platform baseline); treating those as read-only would break
 * existing workflows.
 */
export function resolveBaselineSkillsDirFromEnv(): string | undefined {
  const raw = process.env.OPENCLAUDE_BASELINE_SKILLS_DIR
  if (!raw || raw.trim() === '') return undefined
  return raw.trim()
}

/**
 * Standard per-agent runtime overlay store (single source of overlay wiring,
 * reused by gateway prompt slots, the skill API, and the mcp-memory tools):
 *   baseline(ro,env) > agent-seed(ro) > shared(rw, all of a user's agents) > legacy(per-agent).
 * Writes go to the shared root. Falls back step-wise if a dir is invalid so the
 * agent stays functional rather than crashing.
 */
export function buildAgentSkillStore(agentId: string): SkillStore {
  const baselineDir = resolveBaselineSkillsDirFromEnv()
  const sharedDir = paths.sharedSkillsDir
  const agentSeedDir = paths.agentSeedSkillsDir(agentId)
  try {
    return new SkillStore(agentId, { baselineDir, sharedDir, agentSeedDir })
  } catch {
    try {
      return new SkillStore(agentId, { sharedDir, agentSeedDir })
    } catch {
      return new SkillStore(agentId)
    }
  }
}

/**
 * User-level store for the agentId-less surface (`/api/skills`):
 *   baseline(ro,env) > shared(rw) > aggregated legacy(all agents). No agent-seed
 *   (seeds are per-agent platform skills, surfaced only in that agent's context).
 * `agentId` is used only for validation/placeholder.
 */
export function buildUserSkillStore(agentId = 'main'): SkillStore {
  const baselineDir = resolveBaselineSkillsDirFromEnv()
  const sharedDir = paths.sharedSkillsDir
  try {
    return new SkillStore(agentId, { baselineDir, sharedDir, aggregateLegacy: true })
  } catch {
    try {
      return new SkillStore(agentId, { sharedDir, aggregateLegacy: true })
    } catch {
      return new SkillStore(agentId)
    }
  }
}

/**
 * True iff `name` is reserved by a PLATFORM skill — the env baseline OR ANY agent's
 * read-only seed. This is the authoritative reserved-name predicate that
 * `SkillStore.save()` enforces on the write path; expose it so callers (e.g. skill
 * training's `skill_propose`) can reject a proposal up front regardless of which
 * agent's overlay they can see, instead of only failing at merge time.
 */
export async function isPlatformReservedSkillName(name: string): Promise<boolean> {
  if (!validateSkillName(name).ok) return false
  const baselineDir = resolveBaselineSkillsDirFromEnv()
  if (baselineDir && existsSync(join(baselineDir, name, 'SKILL.md'))) return true
  const agentsDir = paths.agentsDir
  if (!existsSync(agentsDir)) return false
  let entries: Dirent[]
  try {
    entries = await readdir(agentsDir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!VALID_AGENT_ID_RE.test(entry.name)) continue
    if (existsSync(join(paths.agentSeedSkillsDir(entry.name), name, 'SKILL.md'))) return true
  }
  return false
}
