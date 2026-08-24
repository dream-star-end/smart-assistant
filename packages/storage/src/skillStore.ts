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

import { createHash, randomUUID } from 'node:crypto'
import { type Dir, type Dirent, type Stats, existsSync, realpathSync, statSync } from 'node:fs'
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { hashSkillTree, loadProjectSkillFileMap } from './projectSkillLedger.js'
import { paths } from './paths.js'

export const MAX_SKILL_NAME_LENGTH = 64
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024

export const SKILL_PRIORITY_MIN = -100
export const SKILL_PRIORITY_MAX = 100

/** frontmatter priority 归一化:非法/缺失 → undefined;数值钳制到 [-100,100] 整数。 */
export function normalizeSkillPriority(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : Number.NaN
  if (!Number.isFinite(n)) return undefined
  return Math.max(SKILL_PRIORITY_MIN, Math.min(SKILL_PRIORITY_MAX, Math.trunc(n)))
}

const VALID_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const VALID_VERSION_RE = /^\d+\.\d+\.\d+$/
const VALID_AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/
export const SKILL_AGENT_SCOPE_FILE = '.openclaude-agent-scope.json'

export interface SkillFrontmatter {
  name: string
  description: string
  version?: string
  tags?: string[]
  related_skills?: string[]
  created_at?: string
  updated_at?: string
  /**
   * 注入菜单排序提示(越大越靠前),仅影响系统提示 SKILLS slot 的展示顺序,
   * 不影响 skill_search/管理面板。范围钳制 [-100,100],缺省视为 0。
   */
  priority?: number
}

export type SkillSource = 'user' | 'platform'

/** Precise overlay layer a skill was resolved from. ('hub' = marketplace-installed, reconciled by syncMarketplaceHub into the read-only hub overlay; lowest precedence.) */
export type SkillLayer = 'platform' | 'agent-seed' | 'project' | 'shared' | 'legacy' | 'hub'

export interface SkillMetadata extends SkillFrontmatter {
  path: string // absolute dir path
  source: SkillSource // 'user' = self-authored; 'platform' = platform baseline/seed (ro)
  layer: SkillLayer // precise overlay layer
  writable: boolean // true iff editable/deletable through THIS store (shared, or legacy write-fallback)
  agentIds: string[] // agents this skill applies to; missing legacy/marketplace scope defaults are normalized
}

export interface SkillContent extends SkillMetadata {
  body: string // the markdown after frontmatter
  rawContent: string // full SKILL.md
  files?: string[] // relative paths of all files in the skill dir (a skill is a directory)
}

/**
 * Visibility scope for the read APIs (`list`/`view`).
 *
 * `includePlatform` defaults to true so the agent runtime keeps seeing platform
 * baseline/seed skills (it needs them to load skills at run time). User-facing
 * management surfaces (`/api/skills`, `/api/agents/:id/skills`) pass `false` so
 * platform-owned skills are never enumerated or read by end users — the
 * authoritative "platform skills are invisible to user management" rule lives
 * here in the store, not scattered across handlers or the frontend.
 */
export interface SkillViewOptions {
  includePlatform?: boolean
}

export type SkillScopeMode = 'runtime' | 'management'

export interface SkillSaveOptions {
  agentIds?: string[]
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

function defaultAgentScope(): string[] {
  return [resolveDefaultAgentId()]
}

export function normalizeSkillAgentScope(
  input: unknown,
  fallback: readonly string[] = defaultAgentScope(),
): string[] {
  const raw = Array.isArray(input) ? input : fallback
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || !VALID_AGENT_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  if (out.length > 0) return out
  if (raw !== fallback) return normalizeSkillAgentScope(fallback, defaultAgentScope())
  return defaultAgentScope()
}

export function validateSkillAgentScope(input: unknown): {
  ok: boolean
  agentIds?: string[]
  error?: string
} {
  if (!Array.isArray(input)) return { ok: false, error: 'agentIds must be an array' }
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of input) {
    if (typeof item !== 'string') return { ok: false, error: 'agentIds must be strings' }
    const id = item.trim()
    if (!id || !VALID_AGENT_ID_RE.test(id)) return { ok: false, error: `invalid agentId: ${id}` }
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  if (out.length === 0) return { ok: false, error: 'agentIds must not be empty' }
  return { ok: true, agentIds: out }
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
   * Marketplace-installed skills dir (read-only `hub` layer, e.g.
   * `~/.openclaude/hub/skills`). Lowest precedence; never shadows platform/user
   * skills. Missing tolerated. Reconciled by the container-side marketplace sync.
   */
  hubDir?: string
  /**
   * Optional per-project skill overlay (`~/.openclaude/projects/<id>/skills`).
   * Read-only for agents. Priority: after agent-seed, before shared. Missing
   * sidecar → visible to this store's agent (the current run). Never writes here.
   */
  projectDir?: string
  /**
   * Gateway-owned per-file hashes for the project overlay (ledger).
   * Runtime list/view only expose overlay skills whose whole tree matches.
   */
  projectSkillFiles?: ReadonlyMap<string, ReadonlyMap<string, string>>
  /**
   * Whether the shared root is writable through this store. Runtime stores for
   * non-default agents read assigned shared skills but still write new self-authored
   * skills into their private legacy dir.
   */
  sharedWritable?: boolean
  /**
   * Runtime mode filters shared/hub skills by `.openclaude-agent-scope.json`.
   * Management mode lists/views all user/hub skills so the UI can edit ownership.
   */
  scopeMode?: SkillScopeMode
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
  /** Absolute, realpath-resolved hub root (marketplace-installed skills, ro), or null. */
  private readonly hubRoot: string | null
  /** Absolute project overlay root, or null. */
  private readonly projectRoot: string | null
  /** name → relativePath → sha256 for project overlay (fail-closed when empty). */
  private readonly projectSkillFiles: ReadonlyMap<string, ReadonlyMap<string, string>> | null
  /** Aggregate all agents' legacy dirs on read (user-level surface). */
  private readonly aggregateLegacy: boolean
  /** True iff writes/deletes should target the shared root. */
  private readonly writesToShared: boolean
  /** Shared layer is editable from this store (management/default agent), or read-only (specialists). */
  private readonly sharedWritable: boolean
  /** Runtime filters shared/hub by agent scope; management sees all. */
  private readonly scopeMode: SkillScopeMode
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

    // --- project overlay (ro; missing tolerated; must stay under HOME/projects) ---
    if (opts.projectDir != null) {
      if (!isAbsolute(opts.projectDir)) {
        throw new Error(`projectDir must be an absolute path: ${opts.projectDir}`)
      }
      this.projectRoot = existsSync(opts.projectDir)
        ? resolveExistingDir(opts.projectDir, 'projectDir')
        : resolve(opts.projectDir)
      const homeResolved = existsSync(paths.home) ? realpathSync(paths.home) : resolve(paths.home)
      const projectsRoot = join(homeResolved, 'projects')
      const resolved = existsSync(this.projectRoot) ? realpathSync(this.projectRoot) : this.projectRoot
      if (resolved !== projectsRoot && !resolved.startsWith(projectsRoot + sep)) {
        throw new Error(`projectDir must resolve within ${projectsRoot}: ${opts.projectDir}`)
      }
      this.projectSkillFiles = opts.projectSkillFiles ?? null
    } else {
      this.projectRoot = null
      this.projectSkillFiles = null
    }

    // --- hub (ro marketplace-installed; missing tolerated; must resolve within HOME) ---
    if (opts.hubDir != null && existsSync(opts.hubDir)) {
      if (!isAbsolute(opts.hubDir)) {
        throw new Error(`hubDir must be an absolute path: ${opts.hubDir}`)
      }
      const resolved = realpathSync(opts.hubDir)
      const homeResolved = existsSync(paths.home) ? realpathSync(paths.home) : resolve(paths.home)
      if (resolved !== homeResolved && !resolved.startsWith(homeResolved + sep)) {
        throw new Error(`hubDir must resolve within home (${paths.home}): ${opts.hubDir}`)
      }
      this.hubRoot = resolved
    } else {
      this.hubRoot = null
    }

    this.aggregateLegacy = Boolean(opts.aggregateLegacy)
    if (this.aggregateLegacy && !this.sharedRoot) {
      throw new Error('aggregateLegacy requires sharedDir')
    }
    this.sharedWritable = opts.sharedWritable !== false
    this.scopeMode = opts.scopeMode ?? 'runtime'
    this.writesToShared = this.sharedRoot != null && this.sharedWritable

    // Write target: shared if available+writable, else per-agent legacy dir (back-compat).
    this.writeRoot = this.writesToShared ? (this.sharedRoot as string) : paths.agentSkillsDir(agentId)
  }

  /** Legacy roots: per-agent dir, or every agent's dir in aggregate mode. */
  private async legacyRoots(): Promise<Array<{ root: string; agentId: string }>> {
    if (!this.aggregateLegacy) {
      return [{ root: paths.agentSkillsDir(this.agentId), agentId: this.agentId }]
    }
    const agentsDir = paths.agentsDir
    if (!existsSync(agentsDir)) return []
    let entries: Dirent[]
    try {
      entries = await readdir(agentsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const roots: Array<{ root: string; agentId: string }> = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!VALID_AGENT_ID_RE.test(entry.name)) continue
      roots.push({ root: paths.agentSkillsDir(entry.name), agentId: entry.name })
    }
    // Deterministic order: readdir() order is filesystem-dependent, and in aggregate
    // mode a same-named skill can now exist under >1 agent (per-agent isolation). Sort
    // by agent id so the aggregate view (main / /api/skills) is stable across calls —
    // the name-dedup then always keeps the same representative rather than a random one.
    return roots.sort((a, b) => a.agentId.localeCompare(b.agentId))
  }

  async list(opts: SkillViewOptions = {}): Promise<SkillMetadata[]> {
    const includePlatform = opts.includePlatform !== false
    const result: SkillMetadata[] = []
    const seen = new Set<string>()
    const push = (items: SkillMetadata[]) => {
      for (const item of items) {
        if (seen.has(item.name)) continue
        seen.add(item.name)
        result.push(item)
      }
    }
    // 1) platform baseline (highest priority). Skipped entirely for user-management
    //    views so a platform skill never occupies a name slot there — a same-named
    //    user skill in a lower layer then surfaces normally (symmetric with view()).
    if (includePlatform && this.baselineRoot) {
      push(await this.scanRoot(this.baselineRoot, 'platform', 'platform', false))
    }
    // 2) per-agent platform seed (also platform-owned; hidden from user-management views)
    if (includePlatform && this.agentSeedRoot) {
      push(await this.scanRoot(this.agentSeedRoot, 'platform', 'agent-seed', false))
    }
    // 3) project overlay (run-scoped; does not mutate global agentIds)
    if (this.projectRoot) {
      push(await this.scanRoot(this.projectRoot, 'user', 'project', false))
    }
    // 4) shared (user-level write source)
    if (this.sharedRoot) {
      push(await this.scanRoot(this.sharedRoot, 'user', 'shared', this.sharedWritable))
    }
    // 4) legacy per-agent (read-only; write-fallback when no sharedRoot)
    const legacyWritable = !this.writesToShared
    for (const legacyRoot of await this.legacyRoots()) {
      push(
        await this.scanRoot(
          legacyRoot.root,
          'user',
          'legacy',
          legacyWritable && legacyRoot.agentId === this.agentId,
          legacyRoot.agentId,
        ),
      )
    }
    // 5) hub (marketplace-installed, ro; lowest precedence — never shadows the above)
    if (this.hubRoot) {
      push(await this.scanRoot(this.hubRoot, 'user', 'hub', false))
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async scanRoot(
    rootDir: string,
    source: SkillSource,
    layer: SkillLayer,
    writable: boolean,
    ownerAgentId?: string,
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
        if (layer === 'project' && !this.projectOverlayTreeOk(entry.name)) continue
        const { meta } = parseFrontmatter(raw)
        if (!meta.name || !meta.description) continue
        const agentIds = await this.agentScopeForLayer(rootDir, entry.name, layer, ownerAgentId)
        if (!this.scopeAllows(layer, agentIds)) continue
        result.push({
          name: meta.name,
          description: meta.description,
          version: meta.version,
          tags: Array.isArray(meta.tags) ? meta.tags : undefined,
          related_skills: Array.isArray(meta.related_skills) ? meta.related_skills : undefined,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
          priority: normalizeSkillPriority(meta.priority),
          path: join(rootDir, entry.name),
          source,
          layer,
          writable,
          agentIds,
        })
      } catch {}
    }
    return result
  }

  private async agentScopeForLayer(
    rootDir: string,
    name: string,
    layer: SkillLayer,
    ownerAgentId?: string,
  ): Promise<string[]> {
    if (layer === 'legacy' && ownerAgentId) return [ownerAgentId]
    if (layer === 'agent-seed') return [this.agentId]
    if (layer === 'project') {
      const raw = await this.safeReadFile(join(rootDir, name, SKILL_AGENT_SCOPE_FILE), rootDir)
      if (!raw) return [this.agentId]
      try {
        const parsed = JSON.parse(raw) as { agentIds?: unknown }
        return normalizeSkillAgentScope(parsed.agentIds, [this.agentId])
      } catch {
        return [this.agentId]
      }
    }
    if (layer === 'shared' || layer === 'hub') {
      const raw = await this.safeReadFile(join(rootDir, name, SKILL_AGENT_SCOPE_FILE), rootDir)
      if (!raw) return defaultAgentScope()
      try {
        const parsed = JSON.parse(raw) as { agentIds?: unknown }
        return normalizeSkillAgentScope(parsed.agentIds, defaultAgentScope())
      } catch {
        return defaultAgentScope()
      }
    }
    return defaultAgentScope()
  }

  private scopeAllows(layer: SkillLayer, agentIds: readonly string[]): boolean {
    if (this.scopeMode === 'management') return true
    if (layer === 'project') return agentIds.includes(this.agentId)
    if (layer !== 'shared' && layer !== 'hub') return true
    return agentIds.includes(this.agentId)
  }

  private projectOverlayTreeOk(name: string): boolean {
    if (!this.projectSkillFiles || this.projectSkillFiles.size === 0) return false
    const expected = this.projectSkillFiles.get(name)
    if (!expected || !this.projectRoot) return false
    const hashed = hashSkillTree(join(this.projectRoot, name))
    if (!hashed.ok) return false
    if (hashed.files.length !== expected.size) return false
    for (const f of hashed.files) {
      if (expected.get(f.relativePath) !== f.sha256) return false
    }
    return true
  }

  private projectOverlayFileOk(name: string, relativePath: string, raw: string | Buffer): boolean {
    if (!this.projectOverlayTreeOk(name)) return false
    const expected = this.projectSkillFiles?.get(name)?.get(relativePath)
    if (!expected) return false
    const actual = createHash('sha256').update(raw).digest('hex')
    return actual === expected
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

  private async scopedRootHas(
    rootDir: string | null,
    name: string,
    layer: SkillLayer,
    ownerAgentId?: string,
  ): Promise<boolean> {
    if (!(await this.rootHas(rootDir, name)) || !rootDir) return false
    const agentIds = await this.agentScopeForLayer(rootDir, name, layer, ownerAgentId)
    return this.scopeAllows(layer, agentIds)
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

  async view(
    name: string,
    subfile?: string,
    opts: SkillViewOptions = {},
  ): Promise<SkillContent | string | null> {
    const includePlatform = opts.includePlatform !== false
    const v = validateSkillName(name)
    if (!v.ok) return null
    // Read priority: baseline > agent-seed > shared > legacy.
    // User-management views skip the platform layers so a platform skill's name
    // resolves to null (→ 404) instead of leaking its body — symmetric with list().
    if (includePlatform && (await this.rootHas(this.baselineRoot, name))) {
      return this.viewFromRoot(
        name,
        subfile,
        this.baselineRoot as string,
        'platform',
        'platform',
        false,
      )
    }
    if (includePlatform && (await this.rootHas(this.agentSeedRoot, name))) {
      return this.viewFromRoot(
        name,
        subfile,
        this.agentSeedRoot as string,
        'platform',
        'agent-seed',
        false,
      )
    }
    if (await this.scopedRootHas(this.projectRoot, name, 'project')) {
      if (this.projectOverlayTreeOk(name)) {
        if (subfile) {
          const rel = subfile.split('\\').join('/').replace(/^\.\//, '')
          if (rel.includes('..') || !this.projectSkillFiles?.get(name)?.has(rel)) return null
          return this.safeReadFile(
            join(this.projectRoot as string, name, rel),
            this.projectRoot as string,
          )
        }
        return this.viewFromRoot(
          name,
          subfile,
          this.projectRoot as string,
          'user',
          'project',
          false,
        )
      }
    }
    if (await this.scopedRootHas(this.sharedRoot, name, 'shared')) {
      return this.viewFromRoot(
        name,
        subfile,
        this.sharedRoot as string,
        'user',
        'shared',
        this.sharedWritable,
      )
    }
    const legacyWritable = !this.writesToShared
    for (const legacyRoot of await this.legacyRoots()) {
      if (await this.scopedRootHas(legacyRoot.root, name, 'legacy', legacyRoot.agentId)) {
        return this.viewFromRoot(
          name,
          subfile,
          legacyRoot.root,
          'user',
          'legacy',
          legacyWritable && legacyRoot.agentId === this.agentId,
          legacyRoot.agentId,
        )
      }
    }
    // hub (marketplace-installed, ro) — lowest read priority
    if (await this.scopedRootHas(this.hubRoot, name, 'hub')) {
      return this.viewFromRoot(name, subfile, this.hubRoot as string, 'user', 'hub', false)
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
    ownerAgentId?: string,
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
    const files = await this.listSkillFiles(rootDir, name)
    const agentIds = await this.agentScopeForLayer(rootDir, name, layer, ownerAgentId)
    return {
      name: meta.name,
      description: meta.description,
      version: meta.version,
      tags: Array.isArray(meta.tags) ? meta.tags : undefined,
      related_skills: Array.isArray(meta.related_skills) ? meta.related_skills : undefined,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
      priority: normalizeSkillPriority(meta.priority),
      path: join(rootDir, name),
      body,
      rawContent: raw,
      source,
      layer,
      writable,
      agentIds,
      files,
    }
  }

  /**
   * List all regular files inside a skill's directory as relative POSIX paths
   * (e.g. ["SKILL.md", "scripts/run.sh"]). A skill is a directory, not just its
   * SKILL.md — this lets the UI surface its real file structure. Bounded by depth
   * and count, and realpath-contained so a symlinked entry can't escape the dir.
   */
  private async listSkillFiles(rootDir: string, name: string): Promise<string[]> {
    const base = join(rootDir, name)
    if (!existsSync(base)) return []
    let realBase: string
    try {
      realBase = await realpath(base)
    } catch {
      return []
    }
    const out: string[] = []
    const MAX = 200
    const contained = (real: string) => real === realBase || real.startsWith(realBase + sep)
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (depth > 6 || out.length >= MAX) return
      let dh: Dir
      try {
        dh = await opendir(dir)
      } catch {
        return
      }
      // Stream entries (opendir async iterator) rather than readdir-into-array, so a
      // pathologically huge directory can't blow up memory before the MAX cap is hit.
      // The iterator auto-closes the handle on break / normal completion.
      for await (const entry of dh) {
        if (out.length >= MAX) break
        if (entry.name.startsWith('.')) continue
        const childRel = rel ? `${rel}/${entry.name}` : entry.name
        const childAbs = join(dir, entry.name)
        try {
          // realpath-contain every entry (dir or file) before descending/listing,
          // so a symlinked entry can never walk or surface outside the skill dir.
          const real = await realpath(childAbs)
          if (!contained(real)) continue
          if (entry.isDirectory()) await walk(childAbs, childRel, depth + 1)
          else if (entry.isFile()) out.push(childRel)
        } catch {}
      }
    }
    await walk(base, '', 0)
    return out.sort()
  }

  /** Ensure the write root exists; create it safely and verify it stays within HOME. */
  private async ensureWriteRoot(): Promise<{ ok: boolean; error?: string }> {
    await mkdir(this.writeRoot, { recursive: true })
    const realWrite = await realpath(this.writeRoot)
    const realHome = await realpath(paths.home)
    if (realWrite !== realHome && !realWrite.startsWith(realHome + sep)) {
      return { ok: false, error: 'write root resolves outside home' }
    }
    // Per-agent write target (no shared library): skill isolation is enforced BY
    // directory, so the write root must resolve to exactly this agent's own
    // agents/<id>/skills with no symlink hop. Reject a pre-planted symlink that would
    // redirect a specialized agent's saves into another agent's dir or the shared
    // library (which would defeat the cross-agent isolation). Shared writeRoot is
    // validated within-home in the constructor and intentionally cross-agent.
    if (!this.writesToShared) {
      const expected = join(realHome, relative(paths.home, this.writeRoot))
      if (realWrite !== expected) {
        return { ok: false, error: 'per-agent skills root must not traverse a symlink' }
      }
    }
    return { ok: true }
  }

  private async writeAgentScope(
    rootDir: string,
    name: string,
    agentIds: readonly string[],
  ): Promise<{ ok: boolean; error?: string }> {
    const scopeCheck = validateSkillAgentScope(agentIds)
    if (!scopeCheck.ok || !scopeCheck.agentIds) return { ok: false, error: scopeCheck.error }
    const skillDir = join(rootDir, name)
    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      return { ok: false, error: 'skill not found' }
    }
    const realRoot = await realpath(rootDir)
    const realSkillDir = await realpath(skillDir)
    if (!realSkillDir.startsWith(realRoot + sep)) {
      return { ok: false, error: 'skill directory resolves outside skills root' }
    }
    const target = join(realSkillDir, SKILL_AGENT_SCOPE_FILE)
    if (existsSync(target)) {
      const st = await lstat(target)
      if (st.isSymbolicLink()) return { ok: false, error: 'scope sidecar is a symlink' }
    }
    const tmp = join(realSkillDir, `.${SKILL_AGENT_SCOPE_FILE}.tmp-${randomUUID()}`)
    try {
      await writeFile(
        tmp,
        `${JSON.stringify({ agentIds: scopeCheck.agentIds }, null, 2)}\n`,
        'utf8',
      )
      await rename(tmp, target)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
    return { ok: true }
  }

  async setAgentScope(
    name: string,
    agentIds: readonly string[],
  ): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(name)
    if (!v.ok) return { ok: false, error: v.error }
    const scopeCheck = validateSkillAgentScope(agentIds)
    if (!scopeCheck.ok || !scopeCheck.agentIds) return { ok: false, error: scopeCheck.error }
    if (!this.writesToShared || !this.sharedRoot) {
      return { ok: false, error: 'skill scope can only be edited for writable shared skills' }
    }
    if (!(await this.rootHas(this.sharedRoot, name))) {
      return { ok: false, error: 'skill not found in writable shared library' }
    }
    return this.writeAgentScope(this.sharedRoot, name, scopeCheck.agentIds)
  }

  async save(
    meta: SkillFrontmatter,
    body: string,
    options: SkillSaveOptions = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(meta.name)
    if (!v.ok) return { ok: false, error: v.error }
    let requestedAgentIds: string[] | undefined
    if (options.agentIds !== undefined) {
      const scopeCheck = validateSkillAgentScope(options.agentIds)
      if (!scopeCheck.ok || !scopeCheck.agentIds) return { ok: false, error: scopeCheck.error }
      requestedAgentIds = scopeCheck.agentIds
    }
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
    if (this.writesToShared && (await this.anyAgentSeedHas(meta.name))) {
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
    if (this.writesToShared) {
      const agentIds =
        requestedAgentIds ?? (await this.agentScopeForLayer(this.writeRoot, meta.name, 'shared'))
      const scopeWrite = await this.writeAgentScope(this.writeRoot, meta.name, agentIds)
      if (!scopeWrite.ok) return scopeWrite
    }
    return { ok: true }
  }

  /**
   * 写 skill 目录内的辅助文件(如 evals/evals.json、evals/last-run.json)。
   * 仅允许写 writeRoot 内**已存在**的技能(不隐式创建技能);relPath 由调用方
   * allowlist(gateway 只放行 evals/ 下固定文件名),这里做路径守卫:
   * 词法包含 + realpath 容器化 + 目标已存在时拒 symlink,原子写(tmp+rename)。
   */
  async saveAuxFile(
    name: string,
    relPath: string,
    content: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(name)
    if (!v.ok) return { ok: false, error: v.error }
    if (!/^[a-zA-Z0-9._/-]{1,128}$/.test(relPath) || relPath.includes('..') || relPath.startsWith('/')) {
      return { ok: false, error: 'invalid aux file path' }
    }
    const skillDir = join(this.writeRoot, name)
    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      return { ok: false, error: 'skill not found in writable library' }
    }
    const realRoot = await realpath(this.writeRoot)
    const realSkillDir = await realpath(skillDir)
    if (!realSkillDir.startsWith(realRoot + sep)) {
      return { ok: false, error: 'skill directory resolves outside skills root' }
    }
    const lexicalTarget = resolve(realSkillDir, relPath)
    if (!lexicalTarget.startsWith(realSkillDir + sep)) {
      return { ok: false, error: 'aux file resolves outside skill directory' }
    }
    const targetDir = resolve(lexicalTarget, '..')
    await mkdir(targetDir, { recursive: true })
    const realTargetDir = await realpath(targetDir)
    if (realTargetDir !== realSkillDir && !realTargetDir.startsWith(realSkillDir + sep)) {
      return { ok: false, error: 'aux directory resolves outside skill directory' }
    }
    const target = join(realTargetDir, lexicalTarget.slice(targetDir.length + 1) || relPath.split('/').pop() || '')
    if (existsSync(target)) {
      const st = await lstat(target)
      if (st.isSymbolicLink()) return { ok: false, error: 'aux file target is a symlink' }
    }
    const tmp = join(realTargetDir, `.aux.tmp-${randomUUID()}`)
    try {
      await writeFile(tmp, content)
      await rename(tmp, target)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
    return { ok: true }
  }

  /**
   * 删除 skill 目录内的辅助文件(编辑器用)。拒绝 SKILL.md / history/ 与目录穿越;
   * 与 saveAuxFile 同一容器化守卫。文件不存在视为成功(幂等)。
   */
  async deleteAuxFile(name: string, relPath: string): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(name)
    if (!v.ok) return { ok: false, error: v.error }
    if (!/^[a-zA-Z0-9._/-]{1,128}$/.test(relPath) || relPath.includes('..') || relPath.startsWith('/')) {
      return { ok: false, error: 'invalid aux file path' }
    }
    if (relPath === 'SKILL.md' || relPath.startsWith('history/')) {
      return { ok: false, error: 'SKILL.md/history 不可经辅助文件接口删除' }
    }
    const skillDir = join(this.writeRoot, name)
    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      return { ok: false, error: 'skill not found in writable library' }
    }
    const realRoot = await realpath(this.writeRoot)
    const realSkillDir = await realpath(skillDir)
    if (!realSkillDir.startsWith(realRoot + sep)) {
      return { ok: false, error: 'skill directory resolves outside skills root' }
    }
    const lexicalTarget = resolve(realSkillDir, relPath)
    if (!lexicalTarget.startsWith(realSkillDir + sep)) {
      return { ok: false, error: 'aux file resolves outside skill directory' }
    }
    if (!existsSync(lexicalTarget)) return { ok: true }
    const st = await lstat(lexicalTarget)
    if (st.isSymbolicLink()) return { ok: false, error: 'aux file target is a symlink' }
    if (!st.isFile()) return { ok: false, error: 'aux path is not a file' }
    await rm(lexicalTarget, { force: true })
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
    if (this.writesToShared) {
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
    if (this.writesToShared && !writeExists && legacyRemoved > 0) {
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
 * The default/generalist agent id — agents.yaml `default` (universally 'main' in
 * v5; users can't change it). Env override hook for a future non-'main' default.
 * Single authority for "which agent aggregates the whole skill library".
 */
export function resolveDefaultAgentId(): string {
  return process.env.OPENCLAUDE_DEFAULT_AGENT_ID?.trim() || 'main'
}

/**
 * Standard per-agent runtime overlay store (single source of overlay wiring,
 * reused by gateway prompt slots, the skill API, and the mcp-memory tools).
 *
 * Skill visibility is **agent-scoped**, with the DEFAULT/generalist agent as the
 * sole aggregator:
 *   - default agent (main): baseline(ro,env) > shared(rw, all agents) > aggregated
 *     legacy(EVERY agent's per-agent dir) > hub. Sees the whole user skill library —
 *     including skills authored under any other agent — and writes to shared.
 *   - any other (specialized) agent: baseline(ro,env) > agent-seed(ro) > its OWN
 *     per-agent dir (agents/<id>/skills, rw) > hub. **No shared layer**, so it only
 *     sees platform baseline + its own skills, never skills authored under other
 *     agents. Writes fall back to agents/<id>/skills (its private namespace).
 *
 * → each specialized assistant's self-authored skills are private to it, while the
 * generalist still aggregates everything (preserves the shared-library goal of the
 * leader/main seeing skills deposited by delegates). Falls back step-wise if a dir
 * is invalid so the agent stays functional rather than crashing.
 */
export function buildRunSkillStore(opts: {
  agentId: string
  projectId?: string | null
  projectSkillFiles?: ReadonlyMap<string, ReadonlyMap<string, string>>
}): SkillStore {
  const store = buildAgentSkillStore(opts.agentId)
  const projectId = typeof opts.projectId === 'string' ? opts.projectId.trim() : ''
  if (!projectId) return store
  const projectDir = paths.projectSkillsDir(projectId)
  const baselineDir = resolveBaselineSkillsDirFromEnv()
  const hubDir = join(paths.hubDir, 'skills')
  const agentSeedDir = paths.agentSeedSkillsDir(opts.agentId)
  const sharedDir = paths.sharedSkillsDir
  const isDefault = opts.agentId === resolveDefaultAgentId()
  const projectSkillFiles = opts.projectSkillFiles ?? loadProjectSkillFileMap(projectId)
  try {
    return new SkillStore(opts.agentId, {
      baselineDir: baselineDir ?? undefined,
      agentSeedDir: isDefault ? undefined : agentSeedDir,
      sharedDir,
      sharedWritable: isDefault,
      aggregateLegacy: isDefault,
      hubDir,
      projectDir,
      projectSkillFiles,
    })
  } catch {
    return store
  }
}

export function buildAgentSkillStore(agentId: string): SkillStore {
  const baselineDir = resolveBaselineSkillsDirFromEnv()
  const hubDir = join(paths.hubDir, 'skills')

  if (agentId === resolveDefaultAgentId()) {
    // Default/generalist agent → aggregate view (same wiring as buildUserSkillStore).
    const sharedDir = paths.sharedSkillsDir
    try {
      return new SkillStore(agentId, {
        baselineDir,
        sharedDir,
        aggregateLegacy: true,
        hubDir,
      })
    } catch {
      try {
        return new SkillStore(agentId, { sharedDir, aggregateLegacy: true, hubDir })
      } catch {
        return new SkillStore(agentId)
      }
    }
  }

  // Specialized agent → baseline + seed + assigned shared skills + its own
  // per-agent skills. Shared is read-only here; self-authored skill_save writes to
  // agents/<id>/skills and remains private unless the user later changes ownership.
  const agentSeedDir = paths.agentSeedSkillsDir(agentId)
  const sharedDir = paths.sharedSkillsDir
  try {
    return new SkillStore(agentId, {
      baselineDir,
      agentSeedDir,
      sharedDir,
      sharedWritable: false,
      hubDir,
    })
  } catch {
    try {
      return new SkillStore(agentId, {
        agentSeedDir,
        sharedDir,
        sharedWritable: false,
        hubDir,
      })
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
  const hubDir = join(paths.hubDir, 'skills')
  try {
    return new SkillStore(agentId, {
      baselineDir,
      sharedDir,
      aggregateLegacy: true,
      hubDir,
      scopeMode: 'management',
    })
  } catch {
    try {
      return new SkillStore(agentId, {
        sharedDir,
        aggregateLegacy: true,
        hubDir,
        scopeMode: 'management',
      })
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
