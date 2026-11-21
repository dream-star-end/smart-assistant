/**
 * L2 Semantic Auto-Consolidation Engine (OCV5-841 Wave 2).
 *
 * Automatically merges duplicate/overlapping Core memories into concise evergreen notes
 * (via 100% reversible archive-first `applySemanticMemoryMerge`) and archives redundant
 * user skills using compact metadata only, enforcing:
 *  - B2: Shared-skill maintenance permission & agent visibility scope superset check.
 *  - B6: Explicit strict L2 JSON schemas (`L2_MEMORY_MERGE_SCHEMA` / `L2_SKILL_DEDUP_SCHEMA`);
 *        schema mismatches are recorded in `errors[]` (never silently treated as 0 hits).
 *  - B7: Real abortable timeouts (`AbortSignal`), stop-loop on timeout/abort, per-call
 *        authorization re-check (`isStillAuthorized`), and hard call cap (`MAX_L2_CALLS_PER_RUN = 4`).
 *  - B8: Pre-LLM source `sha256` binding (`expectedSourceShas`) and fresh disk re-verification
 *        of both kept & candidate skills immediately before `archiveUserSkill`.
 *  - B10: Full-content `scanMemoryContent` BEFORE sending any memory or skill to the LLM.
 *  - W1: Exact UTF-8 byte budgets (`MAX_CLUSTER_BYTES = 12_288`, `MAX_SKILL_METADATA_BYTES = 16_384`).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MEMORY_FILE_RE,
  type MemoryType,
  type SkillUsageDbLike,
  appendContextHygieneRun,
  applySemanticMemoryMerge,
  archiveUserSkill,
  classifySkillTier,
  getLocalSkillUsageMap,
  isSkillScopeSuperset,
  normalizeSkillPriority,
  parseFrontmatter,
  resolveEffectiveSkillAgentScope,
  scanMemoryContent,
  type SemanticArchiveSuperseded,
  type SemanticMemoryMergeGroup,
} from '@openclaude/storage'

export const MAX_CLUSTER_BYTES = 12_288
export const MAX_CLUSTER_CHARS = MAX_CLUSTER_BYTES
export const MAX_SKILL_METADATA_BYTES = 16_384
export const MAX_SKILL_METADATA_CHARS = MAX_SKILL_METADATA_BYTES
export const MAX_MERGED_CONTENT_CHARS = 8_000
export const MAX_L2_CALLS_PER_RUN = 4
export const SEMANTIC_DAILY_INTERVAL_MS = 24 * 60 * 60_000
export const SEMANTIC_MIN_DEBOUNCE_MS = 10 * 60_000
export const SEMANTIC_MEMORY_COUNT_TRIGGER = 25
export const SEMANTIC_SKILL_COUNT_TRIGGER = 35
export const SEMANTIC_NEW_MEMORY_TRIGGER = 5
export const SEMANTIC_LLM_TIMEOUT_MS = 45_000

const STATE_FILENAME = 'semantic-consolidation-state.json'
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ALLOWED_TYPES: ReadonlySet<MemoryType> = new Set(['user', 'feedback', 'project', 'reference'])

/** B6: Explicit CCB `--json-schema` for L2 Core memory cluster consolidation. */
export const L2_MEMORY_MERGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['merge_groups', 'archive_superseded'],
  properties: {
    merge_groups: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'targetSlug',
          'sourceSlugs',
          'mergedTitle',
          'mergedDescription',
          'mergedType',
          'mergedContent',
          'reason',
        ],
        properties: {
          targetSlug: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
          sourceSlugs: {
            type: 'array',
            minItems: 2,
            maxItems: 12,
            items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
          },
          mergedTitle: { type: 'string', minLength: 1, maxLength: 120 },
          mergedDescription: { type: 'string', minLength: 1, maxLength: 240 },
          mergedType: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
          mergedContent: { type: 'string', minLength: 1, maxLength: MAX_MERGED_CONTENT_CHARS },
          reason: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
    archive_superseded: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slug', 'reason'],
        properties: {
          slug: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
          reason: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  },
}

/** B6: Explicit CCB `--json-schema` for L2 metadata-only user skill deduplication. */
export const L2_SKILL_DEDUP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['duplicate_skills'],
  properties: {
    duplicate_skills: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['archiveName', 'keptName', 'reason'],
        properties: {
          archiveName: { type: 'string', minLength: 1, maxLength: 120 },
          keptName: { type: 'string', minLength: 1, maxLength: 120 },
          reason: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  },
}

export type SkillVisibilityScope = readonly string[] | 'all' | ReadonlySet<string>

export interface SemanticConsolidationState {
  schemaVersion: 1
  lastRunAtMs?: number
  lastMemoryCount?: number
  lastBatchId?: string
  lastSummary?: string
}

export interface CoreMemoryFileEntry {
  file: string
  slug: string
  type: MemoryType
  name: string
  description: string
  body: string
  rawContent: string
  sha256: string
  bytes: number
  chars: number
}

export interface CoreMemoryCluster {
  type: MemoryType
  files: CoreMemoryFileEntry[]
  totalBytes: number
  totalChars: number
}

export interface EligibleUserSkillMeta {
  name: string
  description: string
  tags: string[]
  bytes: number
  useCount30d: number
  tier: 'hot' | 'warm' | 'cold'
  priority: number
  layer: 'user'
  agentsScope: readonly string[]
}

export interface SemanticModelInvocation {
  attemptId: string
  agentId: string
  userId: string
  model: string
  prompt: string
  outputSchema: Record<string, unknown>
  signal: AbortSignal
}

export interface SemanticConsolidationOptions {
  agentId: string
  userId?: string
  agentDir: string
  skillsDir: string
  model?: string
  runModel: (input: SemanticModelInvocation) => Promise<string>
  /** B2: Explicit permission to maintain shared user skills (defaults to agentId === 'main'). */
  allowSharedSkillMaintenance?: boolean
  /** B7: Live authorization check executed before every LLM call. */
  isStillAuthorized?: () => Promise<boolean>
  /** B7: Hard cap on total LLM calls in a single run (defaults to MAX_L2_CALLS_PER_RUN = 4). */
  maxCallsPerRun?: number
  sessionsDb?: SkillUsageDbLike
  nowMs?: number
  force?: boolean
  timeoutMs?: number
  log?: (event: string, fields: Record<string, unknown>) => void
}

export interface SemanticConsolidationResult {
  ran: boolean
  skippedReason?: string
  batchId: string | null
  clustersEvaluated: number
  mergedMemoryGroups: number
  mergedMemorySources: number
  supersededMemoriesArchived: number
  duplicateSkillsArchived: number
  semanticSummary: string
  errors: string[]
}

/** Enabled by default; `OC_AUTO_SEMANTIC_CONSOLIDATE=off|0|false` acts as emergency bypass. */
export function isSemanticConsolidationEnabled(): boolean {
  const raw = process.env.OC_AUTO_SEMANTIC_CONSOLIDATE?.trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false') return false
  return true
}

export function parseSkillAgentsScope(raw: unknown): SkillVisibilityScope {
  if (raw === undefined || raw === null) return 'all'
  const list = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
    : typeof raw === 'string'
      ? raw.split(',').map((v) => v.trim()).filter(Boolean)
      : []
  if (list.length === 0 || list.includes('*')) return 'all'
  return new Set(list)
}

/** B2: True iff `keptScope` is visible to every agent that could see `candidateScope` (delegates to storage single-authority rule). */
export function isVisibilityScopeSuperset(
  keptScope: SkillVisibilityScope,
  candidateScope: SkillVisibilityScope,
): boolean {
  const toList = (scope: SkillVisibilityScope): string[] =>
    scope === 'all' ? ['*'] : Array.isArray(scope) ? [...scope] : [...scope]
  if (keptScope === 'all') return true
  if (candidateScope === 'all') return false
  return isSkillScopeSuperset(toList(keptScope), toList(candidateScope))
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function tokenizeLexical(text: string): Set<string> {
  const out = new Set<string>()
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) {
    out.add(m[0])
  }
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length - 1; i += 1) {
    out.add(cjk.slice(i, i + 2))
  }
  return out
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const tok of a) {
    if (b.has(tok)) inter += 1
  }
  const union = a.size + b.size - inter
  return union > 0 ? inter / union : 0
}

function parseSimpleFrontmatter(raw: string): {
  name: string
  description: string
  type: MemoryType
  body: string
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) {
    return { name: '', description: '', type: 'reference', body: raw.trim() }
  }
  const fm = m[1]!
  const body = m[2]!.trim()
  let name = ''
  let description = ''
  let type: MemoryType = 'reference'
  for (const line of fm.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    const key = kv[1]!.toLowerCase()
    const val = kv[2]!.trim().replace(/^["']|["']$/g, '')
    if (key === 'name') name = val
    else if (key === 'description') description = val
    else if (key === 'type' && ALLOWED_TYPES.has(val as MemoryType)) type = val as MemoryType
  }
  return { name, description, type, body }
}

/**
 * Read regular non-symlink `memory/*.md` files (never touches CLAUDE.md or user.md).
 * B10: Runs full-content `scanMemoryContent` before any file can enter an LLM prompt!
 */
export async function loadCoreMemoryFiles(agentDir: string): Promise<CoreMemoryFileEntry[]> {
  const memDir = join(agentDir, 'memory')
  let entries: string[]
  try {
    entries = await readdir(memDir)
  } catch {
    return []
  }
  const results: CoreMemoryFileEntry[] = []
  for (const file of entries.sort()) {
    if (!MEMORY_FILE_RE.test(file)) continue
    const fullPath = join(memDir, file)
    try {
      const st = await lstat(fullPath)
      if (st.isSymbolicLink() || !st.isFile()) continue
      const rawContent = await readFile(fullPath, 'utf8')
      // B10: Scan FULL file content before allowing it into L2 LLM prompt!
      if (!scanMemoryContent(rawContent).ok) continue
      const parsed = parseSimpleFrontmatter(rawContent)
      if (
        (parsed.name && !scanMemoryContent(parsed.name).ok) ||
        (parsed.description && !scanMemoryContent(parsed.description).ok)
      ) {
        continue
      }
      const slug = file.slice(0, -3)
      const docJsonBytes = Buffer.byteLength(
        JSON.stringify({
          slug,
          type: parsed.type,
          name: parsed.name || slug,
          description: parsed.description,
          body: parsed.body,
        }),
        'utf8',
      )
      results.push({
        file,
        slug,
        type: parsed.type,
        name: parsed.name || slug,
        description: parsed.description,
        body: parsed.body,
        rawContent,
        sha256: sha256Hex(rawContent),
        bytes: docJsonBytes,
        chars: rawContent.length,
      })
    } catch {
      /* skip unreadable file */
    }
  }
  return results
}

/**
 * Partition Core memories into compact same-type clusters (each <= 12,288 UTF-8 bytes, W1),
 * skipping single-file clusters.
 */
export function clusterMemoryFiles(
  files: readonly CoreMemoryFileEntry[],
  maxClusterBytes = MAX_CLUSTER_BYTES,
): CoreMemoryCluster[] {
  const byType = new Map<MemoryType, CoreMemoryFileEntry[]>()
  for (const f of files) {
    const list = byType.get(f.type) ?? []
    list.push(f)
    byType.set(f.type, list)
  }

  const clusters: CoreMemoryCluster[] = []
  for (const [type, group] of byType) {
    if (group.length < 2) continue
    const tokensBySlug = new Map<string, Set<string>>()
    for (const f of group) {
      tokensBySlug.set(
        f.slug,
        tokenizeLexical(`${f.slug} ${f.name} ${f.description} ${f.body.slice(0, 400)}`),
      )
    }
    const remaining = [...group]
    while (remaining.length >= 2) {
      const seed = remaining.shift()!
      if (seed.bytes + 2 > maxClusterBytes) continue
      const seedTokens = tokensBySlug.get(seed.slug)!
      remaining.sort((a, b) => {
        const simB = jaccardSimilarity(seedTokens, tokensBySlug.get(b.slug)!)
        const simA = jaccardSimilarity(seedTokens, tokensBySlug.get(a.slug)!)
        return simB - simA
      })
      const clusterFiles: CoreMemoryFileEntry[] = [seed]
      let totalBytes = seed.bytes + 2
      let totalChars = seed.chars
      const nextRemaining: CoreMemoryFileEntry[] = []
      for (const candidate of remaining) {
        if (totalBytes + candidate.bytes + 1 <= maxClusterBytes) {
          clusterFiles.push(candidate)
          totalBytes += candidate.bytes + 1
          totalChars += candidate.chars
        } else {
          nextRemaining.push(candidate)
        }
      }
      remaining.length = 0
      remaining.push(...nextRemaining)
      if (clusterFiles.length >= 2) {
        clusters.push({ type, files: clusterFiles, totalBytes, totalChars })
      }
    }
  }
  return clusters
}

async function readFreshSkillDiskState(
  skillsDir: string,
  name: string,
): Promise<{
  exists: boolean
  isUserLayer: boolean
  priority: number
  scope: string[]
  safe: boolean
  bytes: number
  description: string
  tags: string[]
} | null> {
  const skillDir = join(skillsDir, name)
  const skillMd = join(skillDir, 'SKILL.md')
  try {
    const dirStat = await lstat(skillDir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null
    const mdStat = await lstat(skillMd)
    if (mdStat.isSymbolicLink() || !mdStat.isFile()) return null
    const content = await readFile(skillMd, 'utf8')
    // B10: Full-content safety scan before reading metadata or sending to LLM!
    if (!scanMemoryContent(content).ok) {
      return { exists: true, isUserLayer: false, priority: 100, scope: [], safe: false, bytes: mdStat.size, description: '', tags: [] }
    }
    const { meta } = parseFrontmatter(content)
    const metaRec = meta as Record<string, unknown>
    const rawLayer = typeof metaRec.layer === 'string' ? metaRec.layer.trim().toLowerCase() : 'user'
    const isUserLayer = rawLayer !== 'platform' && rawLayer !== 'baseline' && rawLayer !== 'system'
    const priority = normalizeSkillPriority(metaRec.priority) ?? 50
    // B2: Reuse single-authority sidecar scope resolution aligned 1:1 with active SkillStore!
    const scope = await resolveEffectiveSkillAgentScope(skillDir)
    const description = (typeof metaRec.description === 'string' ? metaRec.description : '').slice(0, 240)
    const tags = Array.isArray(metaRec.tags)
      ? metaRec.tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
      : []
    const metaSafe =
      scanMemoryContent(name).ok &&
      (!description || scanMemoryContent(description).ok) &&
      tags.every((t) => scanMemoryContent(t).ok)
    return {
      exists: true,
      isUserLayer,
      priority,
      scope,
      safe: metaSafe,
      bytes: mdStat.size,
      description,
      tags,
    }
  } catch {
    return null
  }
}

/** Scan eligible user skills (strictly `layer === 'user'`, `priority < 60`, and passes B10 full scan). */
export async function loadEligibleUserSkillsMetadata(
  skillsDir: string,
  sessionsDb?: SkillUsageDbLike,
): Promise<EligibleUserSkillMeta[]> {
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return []
  }
  const usageMap = await getLocalSkillUsageMap(sessionsDb ? { db: sessionsDb } : undefined).catch(() => null)
  const out: EligibleUserSkillMeta[] = []
  for (const name of entries.sort()) {
    if (name.startsWith('.') || name === 'skills-archive') continue
    const fresh = await readFreshSkillDiskState(skillsDir, name)
    if (!fresh || !fresh.exists || !fresh.safe || !fresh.isUserLayer || fresh.priority >= 60) continue
    const usage = usageMap?.get(name.toLowerCase())
    const useCount30d = usage?.useCount ?? 0
    const tier = classifySkillTier(usage ?? null, { priority: fresh.priority })
    out.push({
      name,
      description: fresh.description,
      tags: fresh.tags,
      bytes: fresh.bytes,
      useCount30d,
      tier,
      priority: fresh.priority,
      layer: 'user',
      agentsScope: fresh.scope,
    })
  }
  return out
}

export function shouldRunSemanticConsolidation(params: {
  state: SemanticConsolidationState
  nowMs: number
  memoryCount: number
  eligibleSkillCount: number
  force?: boolean
}): { run: boolean; reason: string } {
  if (params.memoryCount < 2 && params.eligibleSkillCount < 2) {
    return { run: false, reason: 'insufficient_assets' }
  }
  if (params.force) return { run: true, reason: 'forced' }
  const lastRunAt = params.state.lastRunAtMs ?? 0
  const elapsed = params.nowMs - lastRunAt
  if (lastRunAt > 0 && elapsed < SEMANTIC_MIN_DEBOUNCE_MS) {
    return { run: false, reason: 'debounced' }
  }
  const newMemories = Math.max(0, params.memoryCount - (params.state.lastMemoryCount ?? 0))
  if (params.memoryCount >= SEMANTIC_MEMORY_COUNT_TRIGGER) {
    return { run: true, reason: 'memory_count_threshold' }
  }
  if (params.eligibleSkillCount >= SEMANTIC_SKILL_COUNT_TRIGGER) {
    return { run: true, reason: 'skill_count_threshold' }
  }
  if (newMemories >= SEMANTIC_NEW_MEMORY_TRIGGER) {
    return { run: true, reason: 'new_memories_threshold' }
  }
  if (lastRunAt === 0 || elapsed >= SEMANTIC_DAILY_INTERVAL_MS) {
    return { run: true, reason: 'daily_cadence' }
  }
  return { run: false, reason: 'interval_not_elapsed' }
}

async function readConsolidationState(agentDir: string): Promise<SemanticConsolidationState> {
  try {
    const raw = await readFile(join(agentDir, STATE_FILENAME), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SemanticConsolidationState>
    if (parsed && parsed.schemaVersion === 1) {
      return {
        schemaVersion: 1,
        ...(typeof parsed.lastRunAtMs === 'number' ? { lastRunAtMs: parsed.lastRunAtMs } : {}),
        ...(typeof parsed.lastMemoryCount === 'number' ? { lastMemoryCount: parsed.lastMemoryCount } : {}),
        ...(typeof parsed.lastBatchId === 'string' ? { lastBatchId: parsed.lastBatchId } : {}),
        ...(typeof parsed.lastSummary === 'string' ? { lastSummary: parsed.lastSummary } : {}),
      }
    }
  } catch {
    /* first run or corrupt state */
  }
  return { schemaVersion: 1 }
}

async function writeConsolidationState(
  agentDir: string,
  state: SemanticConsolidationState,
): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 })
  const target = join(agentDir, STATE_FILENAME)
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, target)
}

function parseModelJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(unfenced)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    const start = unfenced.indexOf('{')
    const end = unfenced.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(unfenced.slice(start, end + 1))
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null
      } catch {
        return null
      }
    }
    return null
  }
}

/**
 * B7: Abortable model invocation. On timeout, fires `AbortController.abort()` so the
 * underlying runner interrupts & destroys its paid child session, waits for cooperative
 * teardown settlement (bounded grace), and signals `timedOutOrAborted = true`.
 */
async function callModelWithAbortableTimeout(
  runModel: SemanticConsolidationOptions['runModel'],
  input: Omit<SemanticModelInvocation, 'signal'>,
  timeoutMs: number,
): Promise<{ ok: true; output: string } | { ok: false; timedOut: boolean; error: string }> {
  const ac = new AbortController()
  let timedOut = false
  const timeoutErr = new Error('SEMANTIC_CONSOLIDATOR_TIMEOUT')
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort(timeoutErr)
  }, timeoutMs)
  timer.unref?.()

  const runPromise = Promise.resolve().then(() => runModel({ ...input, signal: ac.signal }))
  // Observe any rejection immediately so abort-triggered rejects never surface as unhandledRejection.
  runPromise.catch(() => {})
  try {
    const output = await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener(
          'abort',
          () => {
            // Wait briefly for cooperative runModel cleanup (activeAfterReturn === 0) before rejecting.
            const grace = setTimeout(() => reject(timeoutErr), 50)
            grace.unref?.()
            const finishAbort = () => {
              clearTimeout(grace)
              reject(timeoutErr)
            }
            runPromise.then(finishAbort, finishAbort)
          },
          { once: true },
        )
      }),
    ])
    return { ok: true, output }
  } catch (err) {
    const isTimeout = timedOut || ac.signal.aborted
    const msg = isTimeout ? 'SEMANTIC_CONSOLIDATOR_TIMEOUT' : err instanceof Error ? err.message : String(err)
    return { ok: false, timedOut: isTimeout, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

function buildMemoryClusterPrompt(cluster: CoreMemoryCluster): string {
  const docs = cluster.files.map((f) => ({
    slug: f.slug,
    type: f.type,
    name: f.name,
    description: f.description,
    body: f.body,
  }))
  return [
    'You are a careful, high-precision long-term memory consolidator.',
    'Analyze the cluster of Core memory notes below (all same category).',
    'ONLY output high-confidence consolidations:',
    '1. `merge_groups`: Merge >=2 genuinely duplicate or heavily overlapping notes into 1 clean evergreen note, preserving ALL non-contradictory facts, dates, paths, and hard constraints. Never lose distinct details.',
    '2. `archive_superseded`: Archive a note ONLY if another note in this cluster explicitly supersedes/replaces it with newer state.',
    'If notes are distinct and non-redundant, return empty arrays `{"merge_groups":[],"archive_superseded":[]}`.',
    'Return STRICT JSON ONLY with schema:',
    '{"merge_groups":[{"targetSlug":"kebab-or-snake-slug","sourceSlugs":["slug1","slug2"],"mergedTitle":"...","mergedDescription":"...","mergedType":"user|feedback|project|reference","mergedContent":"markdown body <= 8000 chars","reason":"..."}],"archive_superseded":[{"slug":"...","reason":"..."}]}',
    '',
    'Cluster notes JSON:',
    JSON.stringify(docs),
  ].join('\n')
}

export function buildSkillDedupPrompt(skills: readonly EligibleUserSkillMeta[]): string {
  const payload: Array<Record<string, unknown>> = []
  let totalBytes = 2 // "[]"
  for (const s of skills) {
    const item = {
      name: s.name,
      description: s.description,
      tags: s.tags,
      bytes: s.bytes,
      useCount30d: s.useCount30d,
      tier: s.tier,
      agents: [...s.agentsScope],
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
    if (totalBytes + serializedBytes + 1 > MAX_SKILL_METADATA_BYTES) break
    payload.push(item)
    totalBytes += serializedBytes + 1
  }
  return [
    'You are a careful skill library deduplicator.',
    'Below is metadata ONLY for user-created skills (never platform or pinned skills).',
    'Identify ONLY high-confidence duplicate/redundant skills where an older or unused skill (`useCount30d: 0`) is clearly duplicated by a newer/more active skill whose `agents` scope covers all agents of the redundant skill.',
    'If unsure, return `{"duplicate_skills":[]}`.',
    'Return STRICT JSON ONLY with schema:',
    '{"duplicate_skills":[{"archiveName":"redundant-skill","keptName":"canonical-skill","reason":"..."}]}',
    '',
    'User skill metadata JSON:',
    JSON.stringify(payload),
  ].join('\n')
}

function validateMemoryClusterProposal(
  parsed: Record<string, unknown>,
  cluster: CoreMemoryCluster,
): {
  schemaValid: boolean
  mergeGroups: SemanticMemoryMergeGroup[]
  archiveSuperseded: SemanticArchiveSuperseded[]
} {
  // B6: Reject wrong-schema responses (e.g. legacy v1 { upserts, deletes, summary }) explicitly!
  if (!Array.isArray(parsed.merge_groups) || !Array.isArray(parsed.archive_superseded)) {
    return { schemaValid: false, mergeGroups: [], archiveSuperseded: [] }
  }
  const clusterBySlug = new Map(cluster.files.map((f) => [f.slug, f]))
  const claimed = new Set<string>()
  const mergeGroups: SemanticMemoryMergeGroup[] = []
  const archiveSuperseded: SemanticArchiveSuperseded[] = []

  for (const raw of parsed.merge_groups) {
    if (!raw || typeof raw !== 'object') continue
    const g = raw as Record<string, unknown>
    const targetSlug = typeof g.targetSlug === 'string' ? g.targetSlug.trim().replace(/\.md$/i, '') : ''
    const mergedTitle = typeof g.mergedTitle === 'string' ? g.mergedTitle.trim().slice(0, 120) : ''
    const mergedDescription =
      typeof g.mergedDescription === 'string' ? g.mergedDescription.trim().slice(0, 240) : ''
    const mergedType: MemoryType =
      typeof g.mergedType === 'string' && ALLOWED_TYPES.has(g.mergedType as MemoryType)
        ? (g.mergedType as MemoryType)
        : cluster.type
    const mergedContent = typeof g.mergedContent === 'string' ? g.mergedContent.trim() : ''
    const reason =
      typeof g.reason === 'string' && g.reason.trim()
        ? g.reason.trim().slice(0, 200)
        : 'semantic_auto_merge'
    const rawSources = Array.isArray(g.sourceSlugs)
      ? [
          ...new Set(
            g.sourceSlugs
              .filter((s): s is string => typeof s === 'string')
              .map((s) => s.trim().replace(/\.md$/i, ''))
              .filter(Boolean),
          ),
        ]
      : []

    if (!SLUG_RE.test(targetSlug)) continue
    if (rawSources.length < 2) continue
    if (!rawSources.every((s) => clusterBySlug.has(s) && !claimed.has(s))) continue
    if (!mergedTitle || !mergedContent || mergedContent.length > MAX_MERGED_CONTENT_CHARS) continue
    if (!scanMemoryContent(mergedContent).ok) continue

    // B8: Bind pre-LLM source sha256 versions so concurrent human edits abort the group safely.
    const expectedSourceShas: Record<string, string> = {}
    for (const s of rawSources) {
      claimed.add(s)
      expectedSourceShas[s] = clusterBySlug.get(s)!.sha256
    }
    mergeGroups.push({
      targetSlug,
      sourceSlugs: rawSources,
      mergedTitle,
      mergedDescription: mergedDescription || mergedTitle,
      mergedType,
      mergedContent,
      reason,
      expectedSourceShas,
    })
  }

  for (const raw of parsed.archive_superseded) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const slug = typeof item.slug === 'string' ? item.slug.trim().replace(/\.md$/i, '') : ''
    const reason =
      typeof item.reason === 'string' && item.reason.trim()
        ? item.reason.trim().slice(0, 200)
        : 'superseded_memory'
    if (!slug || !clusterBySlug.has(slug) || claimed.has(slug)) continue
    claimed.add(slug)
    archiveSuperseded.push({ slug, reason, expectedSha: clusterBySlug.get(slug)!.sha256 })
  }

  return { schemaValid: true, mergeGroups, archiveSuperseded }
}

function buildHumanSemanticSummary(counts: {
  mergedMemoryGroups: number
  mergedMemorySources: number
  supersededMemoriesArchived: number
  duplicateSkillsArchived: number
}): string {
  const parts: string[] = []
  if (counts.mergedMemoryGroups > 0) {
    parts.push(
      `自动合并 ${counts.mergedMemoryGroups} 组重复记忆（共 ${counts.mergedMemorySources} 条）`,
    )
  }
  if (counts.supersededMemoriesArchived > 0) {
    parts.push(`收纳 ${counts.supersededMemoriesArchived} 条已过时记忆`)
  }
  if (counts.duplicateSkillsArchived > 0) {
    parts.push(`收纳 ${counts.duplicateSkillsArchived} 个重复或久未使用的技能`)
  }
  if (parts.length === 0) return ''
  return `${parts.join('，')}，随时可在已收纳记录恢复`
}

/**
 * Run L2 semantic auto-consolidation (Core memory cluster merge + metadata-only skill dedup).
 * Enforces B2, B6, B7, B8, B10, and W1 invariants.
 */
export async function runSemanticConsolidation(
  opts: SemanticConsolidationOptions,
): Promise<SemanticConsolidationResult> {
  if (!isSemanticConsolidationEnabled()) {
    return {
      ran: false,
      skippedReason: 'disabled',
      batchId: null,
      clustersEvaluated: 0,
      mergedMemoryGroups: 0,
      mergedMemorySources: 0,
      supersededMemoriesArchived: 0,
      duplicateSkillsArchived: 0,
      semanticSummary: '',
      errors: [],
    }
  }

  const nowMs = opts.nowMs ?? Date.now()
  const timeoutMs = opts.timeoutMs ?? SEMANTIC_LLM_TIMEOUT_MS
  const maxCalls = Math.max(1, Math.min(opts.maxCallsPerRun ?? MAX_L2_CALLS_PER_RUN, 16))
  const model = opts.model ?? 'auto-dream-semantic'
  const userId = opts.userId ?? 'default'
  const allowSharedSkills = opts.allowSharedSkillMaintenance ?? opts.agentId === 'main'
  const state = await readConsolidationState(opts.agentDir)
  const memoryFiles = await loadCoreMemoryFiles(opts.agentDir)
  const eligibleSkills = allowSharedSkills
    ? await loadEligibleUserSkillsMetadata(opts.skillsDir, opts.sessionsDb)
    : []

  const gate = shouldRunSemanticConsolidation({
    state,
    nowMs,
    memoryCount: memoryFiles.length,
    eligibleSkillCount: eligibleSkills.length,
    force: opts.force,
  })
  if (!gate.run) {
    return {
      ran: false,
      skippedReason: gate.reason,
      batchId: null,
      clustersEvaluated: 0,
      mergedMemoryGroups: 0,
      mergedMemorySources: 0,
      supersededMemoriesArchived: 0,
      duplicateSkillsArchived: 0,
      semanticSummary: '',
      errors: [],
    }
  }

  const clusters = clusterMemoryFiles(memoryFiles)
  const batchId = `semantic-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  const errors: string[] = []
  let mergedMemoryGroups = 0
  let mergedMemorySources = 0
  let supersededMemoriesArchived = 0
  let duplicateSkillsArchived = 0
  let bytesFreed = 0
  let callsUsed = 0
  let clustersEvaluated = 0
  let stoppedEarly = false
  const archivedMemoryFiles: string[] = []
  const archivedSkillNames: string[] = []

  const checkAuthorized = async (): Promise<boolean> => {
    if (!opts.isStillAuthorized) return true
    try {
      const ok = await opts.isStillAuthorized()
      if (!ok) errors.push('authorization_revoked')
      return ok
    } catch {
      errors.push('authorization_check_failed')
      return false
    }
  }

  // Phase A: Cluster-by-cluster Core memory semantic merge (<=12 KiB UTF-8 per cluster)
  const allMergeGroups: SemanticMemoryMergeGroup[] = []
  const allSuperseded: SemanticArchiveSuperseded[] = []
  for (const cluster of clusters) {
    if (stoppedEarly || callsUsed >= maxCalls) break
    if (!(await checkAuthorized())) {
      stoppedEarly = true
      break
    }
    callsUsed += 1
    clustersEvaluated += 1
    const res = await callModelWithAbortableTimeout(
      opts.runModel,
      {
        attemptId: randomUUID(),
        agentId: opts.agentId,
        userId,
        model,
        prompt: buildMemoryClusterPrompt(cluster),
        outputSchema: L2_MEMORY_MERGE_SCHEMA,
      },
      timeoutMs,
    )
    if (!res.ok) {
      errors.push(`cluster_${cluster.type}_${res.error}`)
      // B7: Stop loop immediately on timeout/abort — never launch next cluster while prior may still settle.
      if (res.timedOut) {
        stoppedEarly = true
        break
      }
      continue
    }
    const parsed = parseModelJsonObject(res.output)
    if (!parsed) {
      errors.push(`cluster_${cluster.type}_invalid_json`)
      continue
    }
    const validated = validateMemoryClusterProposal(parsed, cluster)
    if (!validated.schemaValid) {
      errors.push(`cluster_${cluster.type}_schema_mismatch`)
      continue
    }
    allMergeGroups.push(...validated.mergeGroups)
    allSuperseded.push(...validated.archiveSuperseded)
  }

  if (allMergeGroups.length > 0 || allSuperseded.length > 0) {
    try {
      const mergeResult = await applySemanticMemoryMerge({
        agentDir: opts.agentDir,
        mergeGroups: allMergeGroups,
        archiveSuperseded: allSuperseded,
        batchId,
        actor: 'auto-dream-semantic',
      })
      mergedMemoryGroups = mergeResult.mergedGroups.length
      mergedMemorySources = mergeResult.mergedGroups.reduce(
        (sum, g) => sum + g.sourceFiles.length,
        0,
      )
      supersededMemoriesArchived = Math.max(
        0,
        allSuperseded.length - mergeResult.skippedSuperseded.length,
      )
      bytesFreed += Math.max(0, mergeResult.bytesSaved)
      for (const entry of mergeResult.archivedEntries) {
        archivedMemoryFiles.push(entry.file)
      }
    } catch (err) {
      errors.push(`apply_merge_${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Phase B: Metadata-only user skill semantic dedup (<=16 KiB UTF-8, B2 + B6 + B7 + B8)
  if (!stoppedEarly && allowSharedSkills && eligibleSkills.length >= 2 && callsUsed < maxCalls) {
    if (await checkAuthorized()) {
      callsUsed += 1
      const res = await callModelWithAbortableTimeout(
        opts.runModel,
        {
          attemptId: randomUUID(),
          agentId: opts.agentId,
          userId,
          model,
          prompt: buildSkillDedupPrompt(eligibleSkills),
          outputSchema: L2_SKILL_DEDUP_SCHEMA,
        },
        timeoutMs,
      )
      if (!res.ok) {
        errors.push(`skills_${res.error}`)
      } else {
        const parsed = parseModelJsonObject(res.output)
        if (!parsed) {
          errors.push('skills_invalid_json')
        } else if (!Array.isArray(parsed.duplicate_skills)) {
          errors.push('skills_schema_mismatch')
        } else {
          const eligibleNames = new Set(eligibleSkills.map((s) => s.name))
          const plannedArchive = new Set<string>()
          const keptNames = new Set<string>()
          const candidates: Array<{ archiveName: string; keptName: string; reason: string }> = []
          for (const item of parsed.duplicate_skills) {
            if (!item || typeof item !== 'object') continue
            const d = item as Record<string, unknown>
            const archiveName = typeof d.archiveName === 'string' ? d.archiveName.trim() : ''
            const keptName = typeof d.keptName === 'string' ? d.keptName.trim() : ''
            const reason =
              typeof d.reason === 'string' && d.reason.trim()
                ? d.reason.trim().slice(0, 200)
                : 'semantic_duplicate_skill'
            if (!archiveName || !keptName || archiveName === keptName) continue
            if (!eligibleNames.has(archiveName) || !eligibleNames.has(keptName)) continue
            if (plannedArchive.has(archiveName) || keptNames.has(archiveName) || plannedArchive.has(keptName)) {
              continue
            }
            plannedArchive.add(archiveName)
            keptNames.add(keptName)
            candidates.push({ archiveName, keptName, reason })
          }
          for (const cand of candidates) {
            // B8 + B2: Re-read BOTH kept and candidate skills fresh from disk immediately before archiving!
            const [freshKept, freshCand] = await Promise.all([
              readFreshSkillDiskState(opts.skillsDir, cand.keptName),
              readFreshSkillDiskState(opts.skillsDir, cand.archiveName),
            ])
            if (!freshKept?.exists || !freshCand?.exists) continue
            if (!freshCand.isUserLayer || freshCand.priority >= 60) continue
            // B2: Kept skill MUST be visible to every agent that could see the candidate skill!
            if (!isSkillScopeSuperset(freshKept.scope, freshCand.scope)) continue

            // B8: Bind priority, kept existence, and effective scope superset check INSIDE the archive lock!
            const archived = await archiveUserSkill(opts.skillsDir, cand.archiveName, {
              reason: `semantic_duplicate_skill:${cand.reason}`,
              batchId,
              actor: 'auto-dream-semantic',
              guard: {
                maxPriorityExclusive: 60,
                requireKeptSkillName: cand.keptName,
                checkScopeSuperset: true,
              },
            })
            if (archived.entry) {
              duplicateSkillsArchived += 1
              archivedSkillNames.push(cand.archiveName)
            }
          }
        }
      }
    }
  }

  const semanticSummary = buildHumanSemanticSummary({
    mergedMemoryGroups,
    mergedMemorySources,
    supersededMemoriesArchived,
    duplicateSkillsArchived,
  })
  const hasChanges = Boolean(semanticSummary)

  const postMemoryFiles = await loadCoreMemoryFiles(opts.agentDir).catch(() => memoryFiles)
  await writeConsolidationState(opts.agentDir, {
    schemaVersion: 1,
    lastRunAtMs: nowMs,
    lastMemoryCount: postMemoryFiles.length,
    ...(hasChanges ? { lastBatchId: batchId, lastSummary: semanticSummary } : {}),
  }).catch(() => {})

  if (hasChanges) {
    const isoNow = new Date(nowMs).toISOString()
    await appendContextHygieneRun(opts.agentDir, {
      runId: randomUUID(),
      batchId,
      agentId: opts.agentId,
      mode: 'auto',
      dryRun: false,
      startedAt: isoNow,
      finishedAt: new Date(Date.now()).toISOString(),
      expiredMemoriesArchived: supersededMemoriesArchived,
      coldSkillsArchived: duplicateSkillsArchived,
      skillHistoriesPruned: 0,
      archivalDecayed: 0,
      archivalCleaned: 0,
      bytesFreed,
      mergedMemoryGroups,
      mergedMemorySources,
      semanticSummary,
      archivedMemoryFiles,
      archivedSkillNames,
      errors,
    }).catch((err) => {
      errors.push(`append_hygiene_${err instanceof Error ? err.message : String(err)}`)
    })
  }

  opts.log?.('semantic_consolidation_finished', {
    agentId: opts.agentId,
    batchId: hasChanges ? batchId : null,
    clustersEvaluated,
    callsUsed,
    mergedMemoryGroups,
    mergedMemorySources,
    supersededMemoriesArchived,
    duplicateSkillsArchived,
    errorCount: errors.length,
  })

  return {
    ran: true,
    batchId: hasChanges ? batchId : null,
    clustersEvaluated,
    mergedMemoryGroups,
    mergedMemorySources,
    supersededMemoriesArchived,
    duplicateSkillsArchived,
    semanticSummary,
    errors,
  }
}

export async function clearSemanticConsolidationState(agentDir: string): Promise<void> {
  await rm(join(agentDir, STATE_FILENAME), { force: true }).catch(() => {})
}
