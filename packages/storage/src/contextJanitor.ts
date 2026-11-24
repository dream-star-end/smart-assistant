/**
 * L1 Deterministic Context Health Report & Context Janitor
 *
 * Zero-LLM-cost hygiene engine that inspects resident context assets
 * (CLAUDE.md, user.md, MEMORY.md + memory/*.md, user skills + history/,
 * archival DB) and performs deterministic cleanup:
 *   1. Reversible archive of expired Core memories (`expires < today`)
 *   2. Archival decay & cleanup (wiring `memoryLifecycle.ts`, honoring optional
 *      exact `pruneArchivalIds` selection; `dryRun` performs ZERO DB mutations)
 *   3. Rolling prune of `skills/<name>/history/` to <= 5 versions (honoring
 *      optional exact `pruneSkillHistoryNames` selection)
 *   4. Optional reversible archive of cold user skills (>60d unused, never
 *      platform or priority>=60)
 *   5. Persist last 10 hygiene run receipts in `context-hygiene-history.json` (0600)
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  archiveMemoryFiles,
  archiveUserSkill,
  listArchivedMemories,
  listArchivedSkills,
} from './contextArchive.js'
import {
  createMemoryDirForAgentDir,
  MEMORY_SOFT_WARN_BYTES,
  MemoryBoundaryError,
} from './memoryDir.js'
import { cleanupArchival, decayAccess } from './memoryLifecycle.js'
import { acquireFileLock } from './memoryShared.js'
import { isMemoryExpired, memoryCalendarDate } from './memoryTtl.js'
import {
  MAX_SKILL_HISTORY_VERSIONS,
  normalizeSkillPriority,
  parseFrontmatter,
  pruneSkillHistoryDir,
  validateSkillName,
} from './skillStore.js'
import {
  classifySkillTier,
  getLocalSkillUsageMap,
  type LocalSkillUsageRecord,
  type SkillUsageDbLike,
} from './skillUsageLocal.js'

export interface ContextHealthSlot {
  id: 'claude_md' | 'user_md' | 'core_memory' | 'skills' | 'archival'
  label: string
  bytes: number
  softLimitBytes: number
  hardLimitBytes: number
  itemCount: number
  status: 'healthy' | 'warning' | 'critical'
  detail?: string
}

export type ContextSlimCandidateKind =
  | 'expired_memory'
  | 'oversized_memory'
  | 'cold_skill'
  | 'oversized_skill'
  | 'skill_history'
  | 'stale_archival'

export interface ContextSlimCandidate {
  id: string
  kind: ContextSlimCandidateKind
  target: string
  label: string
  bytes: number
  reason: string
  safeAutoArchive: boolean
  /** True iff action moves item into reversible archive box; false for permanent pruning/deletion. */
  reversible: boolean
  actionable: boolean
  meta?: Record<string, unknown>
}

export interface ContextHygieneRunRecord {
  runId: string
  batchId: string | null
  agentId: string
  mode: 'manual' | 'auto'
  dryRun: boolean
  startedAt: string
  finishedAt: string
  expiredMemoriesArchived: number
  coldSkillsArchived: number
  skillHistoriesPruned: number
  archivalDecayed: number
  archivalCleaned: number
  bytesFreed: number
  archivedMemoryFiles: string[]
  archivedSkillNames: string[]
  errors: string[]
  /** Number of semantic merge groups applied in an L2 consolidation run. */
  mergedMemoryGroups?: number
  /** Total source memory files consolidated across all semantic merge groups. */
  mergedMemorySources?: number
  /** Plain-language summary of what background auto-consolidation did. */
  semanticSummary?: string
  /** Whether MEMORY.md index was compacted (or would be compacted in dryRun). */
  memoryIndexCompacted?: boolean
  /** Bytes freed by compacting MEMORY.md index. */
  memoryIndexBytesSaved?: number
  /** Count of broken memory/*.md links removed from MEMORY.md. */
  memoryIndexBrokenLinksRemoved?: number
}

export interface ContextHealthReport {
  agentId: string
  generatedAt: string
  status: 'healthy' | 'warning' | 'critical'
  totalBytes: number
  reclaimableBytes: number
  slots: ContextHealthSlot[]
  summary: {
    coreMemoryCount: number
    coreMemoryBytes: number
    coreMemoryIndexBytes: number
    expiredMemoryCount: number
    oversizedMemoryCount: number
    activeSkillCount: number
    activeSkillBytes: number
    coldSkillCount: number
    oversizedSkillCount: number
    skillHistoryCount: number
    skillHistoryBytes: number
    claudeMdBytes: number
    userMdBytes: number
    archivalCount: number
    archivalBytes: number
    staleArchivalCount: number
    archivedMemoryCount: number
    archivedSkillCount: number
  }
  slimCandidates: ContextSlimCandidate[]
  recentRuns: ContextHygieneRunRecord[]
}

export interface BuildContextHealthReportInput {
  agentId: string
  agentDir: string
  userProfilePath?: string
  skillsDir?: string
  sessionsDb?: SkillUsageDbLike
  coldSkillDays?: number
  today?: string
  nowMs?: number
}

export interface RunContextJanitorInput {
  agentId: string
  agentDir: string
  skillsDir?: string
  sessionsDb?: SkillUsageDbLike
  dryRun?: boolean
  mode?: 'manual' | 'auto'
  archiveExpiredMemories?: boolean
  archiveColdSkills?: boolean
  coldSkillDays?: number
  /** Cap cold skills archived in a single run (defaults to 10 in `auto` mode). */
  maxColdSkillsPerRun?: number
  pruneSkillHistory?: boolean
  /** When provided, ONLY prune history for these exact skill names (empty array = prune none). */
  pruneSkillHistoryNames?: readonly string[]
  maxSkillHistoryVersions?: number
  decayArchival?: boolean
  /** When provided, ONLY delete these exact archival IDs (empty array = delete none). */
  pruneArchivalIds?: readonly string[]
  /** Compact bloated/drifted MEMORY.md index during L1 hygiene (defaults to true). */
  compactMemoryIndex?: boolean
  /** Byte budget threshold for compacting MEMORY.md index (defaults to 6 KiB). */
  memoryIndexMaxBytes?: number
  today?: string
  nowMs?: number
}

const HISTORY_FILE = 'context-hygiene-history.json'
const MAX_HYGIENE_HISTORY = 10
const OVERSIZED_MEMORY_BYTES = 6 * 1024
const OVERSIZED_SKILL_BYTES = 12 * 1024
const CLAUDE_SOFT_BYTES = 4 * 1024
const CLAUDE_HARD_BYTES = 8 * 1024
const USER_SOFT_BYTES = 4 * 1024
const USER_HARD_BYTES = 8 * 1024
const MEMORY_INDEX_SOFT_BYTES = 12 * 1024
const MEMORY_INDEX_HARD_BYTES = 16 * 1024
const SKILLS_SOFT_BYTES = 512 * 1024
const SKILLS_HARD_BYTES = 1024 * 1024
const ARCHIVAL_SOFT_BYTES = 512 * 1024
const ARCHIVAL_HARD_BYTES = 2 * 1024 * 1024
const PINNED_PRIORITY_THRESHOLD = 60

function slotStatus(bytes: number, soft: number, hard: number): 'healthy' | 'warning' | 'critical' {
  if (bytes >= hard) return 'critical'
  if (bytes >= soft) return 'warning'
  return 'healthy'
}

function sqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

async function fileBytes(filePath?: string): Promise<number> {
  if (!filePath) return 0
  try {
    const st = await stat(filePath)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, filePath)
    await chmod(filePath, 0o600).catch(() => {})
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

function hasTable(db: SkillUsageDbLike, name: string): boolean {
  try {
    const row = db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) as { ok?: number } | undefined
    return row?.ok === 1
  } catch {
    return false
  }
}

async function readUsageMapReadonly(
  sessionsDb?: SkillUsageDbLike,
): Promise<Map<string, LocalSkillUsageRecord>> {
  try {
    if (sessionsDb) {
      if (!hasTable(sessionsDb, 'skill_usage_local')) return new Map()
      return await getLocalSkillUsageMap({ db: sessionsDb })
    }
    return await getLocalSkillUsageMap()
  } catch {
    return new Map()
  }
}

interface ScannedSkillInfo {
  name: string
  skillMdBytes: number
  mtimeMs: number
  priority?: number
  description: string
  historyCount: number
  historyBytes: number
  excessHistoryCount: number
  excessHistoryBytes: number
}

async function scanUserSkills(
  skillsDir: string | undefined,
  maxHistoryVersions = MAX_SKILL_HISTORY_VERSIONS,
): Promise<ScannedSkillInfo[]> {
  if (!skillsDir || !existsSync(skillsDir)) return []
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ScannedSkillInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !validateSkillName(entry.name).ok) {
      continue
    }
    const skillDir = join(skillsDir, entry.name)
    const skillMdPath = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    try {
      const st = await stat(skillMdPath)
      const raw = await readFile(skillMdPath, 'utf8')
      const { meta } = parseFrontmatter(raw)
      const historyDir = join(skillDir, 'history')
      let historyCount = 0
      let historyBytes = 0
      if (existsSync(historyDir)) {
        const hFiles = await readdir(historyDir).catch(() => [])
        for (const hf of hFiles) {
          if (!hf.endsWith('.md') || hf.startsWith('.')) continue
          try {
            const hst = await stat(join(historyDir, hf))
            if (hst.isFile()) {
              historyCount += 1
              historyBytes += hst.size
            }
          } catch {}
        }
      }
      const excess =
        historyCount > maxHistoryVersions
          ? await pruneSkillHistoryDir(historyDir, skillsDir, maxHistoryVersions, { dryRun: true })
          : { pruned: 0, bytesFreed: 0, prunedFiles: [] }

      out.push({
        name: entry.name,
        skillMdBytes: st.size,
        mtimeMs: st.mtimeMs,
        priority: normalizeSkillPriority(meta.priority),
        description: meta.description || '',
        historyCount,
        historyBytes,
        excessHistoryCount: excess.pruned,
        excessHistoryBytes: excess.bytesFreed,
      })
    } catch {
      // skip unreadable skill
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function readArchivalSummaryFromDb(
  db: SkillUsageDbLike,
  agentId: string,
  nowMs: number,
): { count: number; bytes: number; staleCount: number; cleanupBytes: number; staleIds: string[] } {
  try {
    const cols = db.prepare('PRAGMA table_info(archival)').all() as Array<{ name: string }>
    if (!cols.length) return { count: 0, bytes: 0, staleCount: 0, cleanupBytes: 0, staleIds: [] }
    const hasLifecycle = cols.some((c) => c.name === 'access_count')
    const cutoff60 = sqliteDatetime(nowMs - 60 * 86_400_000)
    if (hasLifecycle) {
      const row = db
        .prepare(
          `SELECT
             COUNT(*) AS cnt,
             COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS bytes,
             COALESCE(SUM(CASE WHEN access_count = 0 AND created_at < ? THEN 1 ELSE 0 END), 0) AS stale_cnt,
             COALESCE(SUM(CASE WHEN access_count = 0 AND created_at < ? THEN LENGTH(CAST(content AS BLOB)) ELSE 0 END), 0) AS stale_bytes
           FROM archival
           WHERE agent_id = ?`,
        )
        .get(cutoff60, cutoff60, agentId) as
        | { cnt: number; bytes: number; stale_cnt: number; stale_bytes: number }
        | undefined
      const idRows = db
        .prepare(
          `SELECT id FROM archival
           WHERE agent_id = ? AND access_count <= 0 AND created_at < ?
           ORDER BY access_count ASC, created_at ASC LIMIT 50`,
        )
        .all(agentId, cutoff60) as Array<{ id: string }>
      return {
        count: Number(row?.cnt ?? 0),
        bytes: Number(row?.bytes ?? 0),
        staleCount: Number(row?.stale_cnt ?? 0),
        cleanupBytes: Number(row?.stale_bytes ?? 0),
        staleIds: idRows.map((r) => r.id),
      }
    }
    const row = db
      .prepare(
        `SELECT
           COUNT(*) AS cnt,
           COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS bytes,
           COALESCE(SUM(CASE WHEN created_at < ? THEN 1 ELSE 0 END), 0) AS stale_cnt,
           COALESCE(SUM(CASE WHEN created_at < ? THEN LENGTH(CAST(content AS BLOB)) ELSE 0 END), 0) AS stale_bytes
         FROM archival WHERE agent_id = ?`,
      )
      .get(cutoff60, cutoff60, agentId) as
      | { cnt: number; bytes: number; stale_cnt: number; stale_bytes: number }
      | undefined
    const idRows = db
      .prepare(
        `SELECT id FROM archival WHERE agent_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT 50`,
      )
      .all(agentId, cutoff60) as Array<{ id: string }>
    return {
      count: Number(row?.cnt ?? 0),
      bytes: Number(row?.bytes ?? 0),
      staleCount: Number(row?.stale_cnt ?? 0),
      cleanupBytes: Number(row?.stale_bytes ?? 0),
      staleIds: idRows.map((r) => r.id),
    }
  } catch {
    return { count: 0, bytes: 0, staleCount: 0, cleanupBytes: 0, staleIds: [] }
  }
}

/**
 * Delete only the explicitly selected archival IDs for `agentId`.
 * Used by manual mode when `pruneArchivalIds` is provided: NEVER mutates schema
 * and NEVER decays or touches unselected rows.
 */
function deleteExplicitArchivalIdsOnDb(
  db: SkillUsageDbLike,
  agentId: string,
  pruneArchivalIds: readonly string[],
  dryRun: boolean,
): { decayed: number; cleaned: number; bytesFreed: number } {
  try {
    const cleanIds = [...new Set(pruneArchivalIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
    if (cleanIds.length === 0) return { decayed: 0, cleaned: 0, bytesFreed: 0 }
    const cols = db.prepare('PRAGMA table_info(archival)').all() as Array<{ name: string }>
    if (!cols.length) return { decayed: 0, cleaned: 0, bytesFreed: 0 }

    const placeholders = cleanIds.map(() => '?').join(',')
    const matched = db
      .prepare(
        `SELECT id, LENGTH(CAST(content AS BLOB)) AS bytes
         FROM archival
         WHERE agent_id = ? AND id IN (${placeholders})`,
      )
      .all(agentId, ...cleanIds) as Array<{ id: string; bytes: number }>
    if (matched.length === 0) return { decayed: 0, cleaned: 0, bytesFreed: 0 }

    const bytesFreed = matched.reduce((acc, row) => acc + Number(row.bytes ?? 0), 0)
    if (dryRun) {
      return { decayed: 0, cleaned: matched.length, bytesFreed }
    }
    const targetIds = matched.map((row) => row.id)
    const delPlaceholders = targetIds.map(() => '?').join(',')
    const delRes = db
      .prepare(`DELETE FROM archival WHERE agent_id = ? AND id IN (${delPlaceholders})`)
      .run(agentId, ...targetIds)
    return {
      decayed: 0,
      cleaned: Number(delRes.changes ?? 0),
      bytesFreed: delRes.changes > 0 ? bytesFreed : 0,
    }
  } catch {
    return { decayed: 0, cleaned: 0, bytesFreed: 0 }
  }
}

function runArchivalLifecycleOnDb(
  db: SkillUsageDbLike,
  agentId: string,
  nowMs: number,
  dryRun: boolean,
): { decayed: number; cleaned: number; bytesFreed: number } {
  try {
    const cols = db.prepare('PRAGMA table_info(archival)').all() as Array<{ name: string }>
    if (!cols.length) return { decayed: 0, cleaned: 0, bytesFreed: 0 }
    const hasAccessCount = cols.some((c) => c.name === 'access_count')
    const hasLastAccessed = cols.some((c) => c.name === 'last_accessed')
    const cutoff30 = sqliteDatetime(nowMs - 30 * 86_400_000)
    const cutoff60 = sqliteDatetime(nowMs - 60 * 86_400_000)

    if (dryRun) {
      // Strictly read-only: NEVER ALTER TABLE or mutate rows in dryRun.
      if (!hasAccessCount || !hasLastAccessed) {
        // Legacy table without lifecycle columns: default access_count=0, last_accessed=''
        const cleanRow = db
          .prepare(
            `SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS bytes
             FROM (
               SELECT content FROM archival
               WHERE agent_id = ? AND created_at < ?
               ORDER BY created_at ASC LIMIT 50
             )`,
          )
          .get(agentId, cutoff60) as { cnt: number; bytes: number } | undefined
        return {
          decayed: 0,
          cleaned: Number(cleanRow?.cnt ?? 0),
          bytesFreed: Number(cleanRow?.bytes ?? 0),
        }
      }

      const decRow = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM archival
           WHERE agent_id = ? AND access_count > 0 AND (last_accessed < ? OR last_accessed = '')`,
        )
        .get(agentId, cutoff30) as { cnt: number } | undefined
      const decayed = Number(decRow?.cnt ?? 0)

      // Simulate post-decay access_count so dryRun preview matches live execution identically.
      const cleanRow = db
        .prepare(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(bytes), 0) AS bytes
           FROM (
             SELECT LENGTH(CAST(content AS BLOB)) AS bytes,
                    CASE
                      WHEN access_count > 0 AND (last_accessed < ? OR last_accessed = '')
                      THEN MAX(0, access_count - 1)
                      ELSE access_count
                    END AS eff_access,
                    created_at
             FROM archival
             WHERE agent_id = ? AND created_at < ?
           )
           WHERE eff_access <= 0
           ORDER BY eff_access ASC, created_at ASC
           LIMIT 50`,
        )
        .get(cutoff30, agentId, cutoff60) as { cnt: number; bytes: number } | undefined
      return {
        decayed,
        cleaned: Number(cleanRow?.cnt ?? 0),
        bytesFreed: Number(cleanRow?.bytes ?? 0),
      }
    }

    // Live write path (auto mode only): ensure columns exist before updating.
    if (!hasAccessCount) {
      db.exec('ALTER TABLE archival ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0')
    }
    if (!hasLastAccessed) {
      db.exec("ALTER TABLE archival ADD COLUMN last_accessed TEXT DEFAULT ''")
    }

    const decRes = db
      .prepare(
        `UPDATE archival
         SET access_count = MAX(0, access_count - 1)
         WHERE agent_id = ? AND access_count > 0 AND (last_accessed < ? OR last_accessed = '')`,
      )
      .run(agentId, cutoff30)

    const candidates = db
      .prepare(
        `SELECT id, LENGTH(CAST(content AS BLOB)) AS bytes FROM archival
         WHERE agent_id = ? AND access_count <= 0 AND created_at < ?
         ORDER BY access_count ASC, created_at ASC LIMIT 50`,
      )
      .all(agentId, cutoff60) as Array<{ id: string; bytes: number }>

    if (candidates.length === 0) {
      return { decayed: Number(decRes.changes ?? 0), cleaned: 0, bytesFreed: 0 }
    }
    const ids = candidates.map((c) => c.id)
    const placeholders = ids.map(() => '?').join(',')
    const delRes = db
      .prepare(
        `DELETE FROM archival WHERE agent_id = ? AND id IN (${placeholders}) AND access_count <= 0 AND created_at < ?`,
      )
      .run(agentId, ...ids, cutoff60)
    const bytesFreed = candidates.reduce((acc, c) => acc + Number(c.bytes ?? 0), 0)
    return {
      decayed: Number(decRes.changes ?? 0),
      cleaned: Number(delRes.changes ?? 0),
      bytesFreed: delRes.changes > 0 ? bytesFreed : 0,
    }
  } catch {
    return { decayed: 0, cleaned: 0, bytesFreed: 0 }
  }
}

/**
 * List recent Context Hygiene run records persisted under `<agentDir>/context-hygiene-history.json`.
 */
export async function listContextHygieneHistory(
  agentDir: string,
  limit = MAX_HYGIENE_HISTORY,
): Promise<ContextHygieneRunRecord[]> {
  const historyPath = join(agentDir, HISTORY_FILE)
  try {
    const raw = await readFile(historyPath, 'utf8')
    const parsed = JSON.parse(raw) as { schemaVersion?: number; runs?: unknown }
    if (!parsed || !Array.isArray(parsed.runs)) return []
    const runs = parsed.runs.filter(
      (r): r is ContextHygieneRunRecord =>
        Boolean(r && typeof r === 'object' && typeof (r as ContextHygieneRunRecord).runId === 'string'),
    )
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)))
    return runs.slice(0, boundedLimit)
  } catch {
    return []
  }
}

async function appendContextHygieneHistory(
  agentDir: string,
  record: ContextHygieneRunRecord,
): Promise<void> {
  const existing = await listContextHygieneHistory(agentDir, MAX_HYGIENE_HISTORY)
  const next = [record, ...existing].slice(0, MAX_HYGIENE_HISTORY)
  await atomicWriteJson(join(agentDir, HISTORY_FILE), {
    schemaVersion: 1,
    runs: next,
  })
}

/**
 * Append a hygiene or L2 semantic consolidation run receipt to
 * `<agentDir>/context-hygiene-history.json` under the per-agent hygiene lock.
 */
export async function appendContextHygieneRun(
  agentDir: string,
  record: ContextHygieneRunRecord,
): Promise<void> {
  await mkdir(agentDir, { recursive: true })
  const release = await acquireFileLock(join(agentDir, '.context-hygiene.lock'))
  try {
    await appendContextHygieneHistory(agentDir, record)
  } finally {
    await release().catch(() => {})
  }
}

/**
 * Build a complete diagnostic health report of an agent's long-term context assets
 * and actionable slimming candidates. Pure read-only.
 */
export async function buildContextHealthReport(
  input: BuildContextHealthReportInput,
): Promise<ContextHealthReport> {
  const nowMs = input.nowMs ?? Date.now()
  const today = input.today ?? memoryCalendarDate(new Date(nowMs))
  const coldSkillDays = Math.max(1, Math.floor(input.coldSkillDays ?? 60))

  const soulBytes = await fileBytes(join(input.agentDir, 'SOUL.md'))
  const claudeFileBytes = await fileBytes(join(input.agentDir, 'CLAUDE.md'))
  const claudeMdBytes = soulBytes > 0 ? soulBytes : claudeFileBytes
  const userMdBytes = await fileBytes(input.userProfilePath)

  const memdir = createMemoryDirForAgentDir(input.agentDir, input.agentId)
  const coreMemoryIndexBytes = await fileBytes(memdir.indexPath())
  const memoryMetas = await memdir.listReadonly().catch(() => [])

  let coreMemoryBytes = 0
  let expiredMemoryCount = 0
  let oversizedMemoryCount = 0
  const slimCandidates: ContextSlimCandidate[] = []

  for (const meta of memoryMetas) {
    coreMemoryBytes += meta.size
    const expired = isMemoryExpired(meta.expires, today)
    if (expired) {
      expiredMemoryCount += 1
      slimCandidates.push({
        id: `expired_memory:${meta.file}`,
        kind: 'expired_memory',
        target: meta.file,
        label: meta.name || meta.file,
        bytes: meta.size,
        reason: `已过期（expires: ${meta.expires}）`,
        safeAutoArchive: true,
        reversible: true,
        actionable: true,
        meta: { file: meta.file, expires: meta.expires, type: meta.type },
      })
    } else if (meta.size > OVERSIZED_MEMORY_BYTES) {
      oversizedMemoryCount += 1
      slimCandidates.push({
        id: `oversized_memory:${meta.file}`,
        kind: 'oversized_memory',
        target: meta.file,
        label: meta.name || meta.file,
        bytes: meta.size,
        reason: `单条记忆过大（${(meta.size / 1024).toFixed(1)} KB > 6 KB），建议精简或拆分归档`,
        safeAutoArchive: false,
        reversible: true,
        actionable: true,
        meta: { file: meta.file, type: meta.type },
      })
    }
  }

  const usageMap = await readUsageMapReadonly(input.sessionsDb)

  const skills = await scanUserSkills(input.skillsDir, MAX_SKILL_HISTORY_VERSIONS)
  let activeSkillBytes = 0
  let coldSkillCount = 0
  let oversizedSkillCount = 0
  let skillHistoryCount = 0
  let skillHistoryBytes = 0

  for (const skill of skills) {
    activeSkillBytes += skill.skillMdBytes
    skillHistoryCount += skill.historyCount
    skillHistoryBytes += skill.historyBytes
    const usage = usageMap.get(skill.name)
    const tier = classifySkillTier(usage, {
      priority: skill.priority,
      nowMs,
      coldDays: coldSkillDays,
      mtimeMs: skill.mtimeMs,
    })
    if (tier === 'cold' && (skill.priority ?? 0) < PINNED_PRIORITY_THRESHOLD) {
      coldSkillCount += 1
      slimCandidates.push({
        id: `cold_skill:${skill.name}`,
        kind: 'cold_skill',
        target: skill.name,
        label: skill.name,
        bytes: skill.skillMdBytes,
        reason: `超过 ${coldSkillDays} 天未使用，可安全移入归档箱（随时可还原）`,
        safeAutoArchive: true,
        reversible: true,
        actionable: true,
        meta: {
          name: skill.name,
          lastUsedAt: usage?.lastUsedAt ?? null,
          useCount: usage?.useCount ?? 0,
        },
      })
    }
    if (skill.skillMdBytes > OVERSIZED_SKILL_BYTES) {
      oversizedSkillCount += 1
      slimCandidates.push({
        id: `oversized_skill:${skill.name}`,
        kind: 'oversized_skill',
        target: skill.name,
        label: skill.name,
        bytes: skill.skillMdBytes,
        reason: `SKILL.md 体积偏大（${(skill.skillMdBytes / 1024).toFixed(1)} KB > 12 KB），建议拆分细节至 references/`,
        safeAutoArchive: false,
        reversible: true,
        actionable: false,
        meta: { name: skill.name },
      })
    }
    if (skill.excessHistoryCount > 0) {
      slimCandidates.push({
        id: `skill_history:${skill.name}`,
        kind: 'skill_history',
        target: skill.name,
        label: `${skill.name} 历史快照`,
        bytes: skill.excessHistoryBytes,
        reason: `历史快照 ${skill.historyCount} 份，永久裁剪多余的 ${skill.excessHistoryCount} 份旧版本（不可撤销）`,
        safeAutoArchive: false,
        reversible: false,
        actionable: true,
        meta: {
          name: skill.name,
          historyCount: skill.historyCount,
          excessCount: skill.excessHistoryCount,
        },
      })
    }
  }

  let archivalStats = { count: 0, bytes: 0, staleCount: 0, cleanupBytes: 0, staleIds: [] as string[] }
  if (input.sessionsDb) {
    archivalStats = readArchivalSummaryFromDb(input.sessionsDb, input.agentId, nowMs)
  } else {
    try {
      const { getSessionsDb } = await import('./sessionsDb.js')
      archivalStats = readArchivalSummaryFromDb(await getSessionsDb(), input.agentId, nowMs)
    } catch {
      // fail-open
    }
  }
  if (archivalStats.staleCount > 0) {
    slimCandidates.push({
      id: `stale_archival:${input.agentId}`,
      kind: 'stale_archival',
      target: input.agentId,
      label: `过期低频归档记忆 (${archivalStats.staleCount} 条)`,
      bytes: archivalStats.cleanupBytes,
      reason: `${archivalStats.staleCount} 条 Archival 条目超过 60 天且零命中，永久清理后不可恢复`,
      safeAutoArchive: false,
      reversible: false,
      actionable: true,
      meta: { staleCount: archivalStats.staleCount, ids: archivalStats.staleIds },
    })
  }

  const archivedMemories = await listArchivedMemories(input.agentDir).catch(() => [])
  const archivedSkills = input.skillsDir
    ? await listArchivedSkills(input.skillsDir).catch(() => [])
    : []
  const recentRuns = await listContextHygieneHistory(input.agentDir, MAX_HYGIENE_HISTORY)

  const slots: ContextHealthSlot[] = [
    {
      id: 'claude_md',
      label: '人格与常驻规则 (CLAUDE.md)',
      bytes: claudeMdBytes,
      softLimitBytes: CLAUDE_SOFT_BYTES,
      hardLimitBytes: CLAUDE_HARD_BYTES,
      itemCount: claudeMdBytes > 0 ? 1 : 0,
      status: slotStatus(claudeMdBytes, CLAUDE_SOFT_BYTES, CLAUDE_HARD_BYTES),
    },
    {
      id: 'user_md',
      label: '用户画像 (user.md)',
      bytes: userMdBytes,
      softLimitBytes: USER_SOFT_BYTES,
      hardLimitBytes: USER_HARD_BYTES,
      itemCount: userMdBytes > 0 ? 1 : 0,
      status: slotStatus(userMdBytes, USER_SOFT_BYTES, USER_HARD_BYTES),
    },
    {
      id: 'core_memory',
      label: '核心记忆 (MEMORY.md + memory/)',
      bytes: coreMemoryIndexBytes + coreMemoryBytes,
      softLimitBytes: MEMORY_INDEX_SOFT_BYTES * 6,
      hardLimitBytes: MEMORY_INDEX_HARD_BYTES * 8,
      itemCount: memoryMetas.length,
      status:
        coreMemoryIndexBytes >= MEMORY_INDEX_HARD_BYTES || expiredMemoryCount >= 5
          ? 'critical'
          : coreMemoryIndexBytes >= MEMORY_INDEX_SOFT_BYTES || expiredMemoryCount > 0
            ? 'warning'
            : 'healthy',
      detail: `索引 ${(coreMemoryIndexBytes / 1024).toFixed(1)} KB · ${memoryMetas.length} 条`,
    },
    {
      id: 'skills',
      label: '用户技能库 (skills/)',
      bytes: activeSkillBytes + skillHistoryBytes,
      softLimitBytes: SKILLS_SOFT_BYTES,
      hardLimitBytes: SKILLS_HARD_BYTES,
      itemCount: skills.length,
      status:
        skills.length >= 100 || activeSkillBytes >= SKILLS_HARD_BYTES
          ? 'critical'
          : skills.length >= 60 || coldSkillCount > 0 || activeSkillBytes >= SKILLS_SOFT_BYTES
            ? 'warning'
            : 'healthy',
      detail: `${skills.length} 个活跃 · ${coldSkillCount} 个冷门`,
    },
    {
      id: 'archival',
      label: '深层归档记忆 (Archival)',
      bytes: archivalStats.bytes,
      softLimitBytes: ARCHIVAL_SOFT_BYTES,
      hardLimitBytes: ARCHIVAL_HARD_BYTES,
      itemCount: archivalStats.count,
      status: slotStatus(archivalStats.bytes, ARCHIVAL_SOFT_BYTES, ARCHIVAL_HARD_BYTES),
      detail: `${archivalStats.count} 条 · ${archivalStats.staleCount} 条待衰减`,
    },
  ]

  const totalBytes = slots.reduce((sum, s) => sum + s.bytes, 0)
  const reclaimableBytes = slimCandidates
    .filter((c) => c.safeAutoArchive || !c.reversible)
    .reduce((sum, c) => sum + c.bytes, 0)
  const overallStatus: 'healthy' | 'warning' | 'critical' = slots.some((s) => s.status === 'critical')
    ? 'critical'
    : slots.some((s) => s.status === 'warning') || slimCandidates.length > 0
      ? 'warning'
      : 'healthy'

  return {
    agentId: input.agentId,
    generatedAt: new Date(nowMs).toISOString(),
    status: overallStatus,
    totalBytes,
    reclaimableBytes,
    slots,
    summary: {
      coreMemoryCount: memoryMetas.length,
      coreMemoryBytes,
      coreMemoryIndexBytes,
      expiredMemoryCount,
      oversizedMemoryCount,
      activeSkillCount: skills.length,
      activeSkillBytes,
      coldSkillCount,
      oversizedSkillCount,
      skillHistoryCount,
      skillHistoryBytes,
      claudeMdBytes,
      userMdBytes,
      archivalCount: archivalStats.count,
      archivalBytes: archivalStats.bytes,
      staleArchivalCount: archivalStats.staleCount,
      archivedMemoryCount: archivedMemories.length,
      archivedSkillCount: archivedSkills.length,
    },
    slimCandidates,
    recentRuns,
  }
}

/**
 * Run L1 deterministic context hygiene (zero LLM calls).
 *
 * Exact-selection contract:
 * - When `pruneSkillHistoryNames` is provided, ONLY skills listed in that array
 *   are pruned (an empty array prunes none).
 * - When `pruneArchivalIds` is provided, ONLY those archival IDs are deleted
 *   (an empty array deletes none).
 * - When `dryRun: true`, ZERO files and ZERO database schema/rows are mutated.
 */
export async function runContextJanitor(
  input: RunContextJanitorInput,
): Promise<ContextHygieneRunRecord> {
  const nowMs = input.nowMs ?? Date.now()
  const today = input.today ?? memoryCalendarDate(new Date(nowMs))
  const mode: 'manual' | 'auto' = input.mode ?? 'manual'
  const dryRun = input.dryRun === true
  const archiveExpired = input.archiveExpiredMemories !== false
  const archiveCold = input.archiveColdSkills === true
  const coldSkillDays = Math.max(1, Math.floor(input.coldSkillDays ?? 60))
  const hasExplicitSkillHistoryNames = input.pruneSkillHistoryNames !== undefined
  const selectedSkillHistoryNames = hasExplicitSkillHistoryNames
    ? new Set(input.pruneSkillHistoryNames!.map((n) => String(n ?? '').trim()).filter(Boolean))
    : null
  const pruneHistory =
    input.pruneSkillHistory === false
      ? false
      : hasExplicitSkillHistoryNames
        ? selectedSkillHistoryNames!.size > 0
        : true
  const maxSkillHistoryVersions = Math.max(
    1,
    Math.floor(input.maxSkillHistoryVersions ?? MAX_SKILL_HISTORY_VERSIONS),
  )
  const runDecayArchival = input.decayArchival !== false
  const compactMemoryIndex = input.compactMemoryIndex !== false
  const memoryIndexMaxBytes = input.memoryIndexMaxBytes ?? MEMORY_SOFT_WARN_BYTES

  const runId = `hyg-${randomUUID().slice(0, 12)}`
  const batchId = `hygiene-${new Date(nowMs).toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`
  const startedAt = new Date(nowMs).toISOString()

  const execute = async (): Promise<ContextHygieneRunRecord> => {
    let expiredMemoriesArchived = 0
    let coldSkillsArchived = 0
    let skillHistoriesPruned = 0
    let archivalDecayed = 0
    let archivalCleaned = 0
    let bytesFreed = 0
    let memoryIndexCompacted = false
    let memoryIndexBytesSaved = 0
    let memoryIndexBrokenLinksRemoved = 0
    const archivedMemoryFiles: string[] = []
    const archivedSkillNames: string[] = []
    const errors: string[] = []

    // 1. Archive expired Core memories (expires < today)
    if (archiveExpired) {
      try {
        const memdir = createMemoryDirForAgentDir(input.agentDir, input.agentId)
        const metas = await memdir.listReadonly()
        const expired = metas.filter((m) => isMemoryExpired(m.expires, today))
        if (expired.length > 0) {
          if (dryRun) {
            expiredMemoriesArchived = expired.length
            bytesFreed += expired.reduce((acc, m) => acc + m.size, 0)
            archivedMemoryFiles.push(...expired.map((m) => m.file))
          } else {
            const res = await archiveMemoryFiles(
              input.agentDir,
              expired.map((m) => m.file),
              {
                reason: 'expired_ttl',
                actor: `context-janitor:${mode}`,
                batchId,
              },
            )
            expiredMemoriesArchived = res.archived.length
            bytesFreed += res.bytesSaved
            archivedMemoryFiles.push(...res.archived.map((e) => e.file))
          }
        }
      } catch (err) {
        errors.push(`expired_memories: ${(err as Error)?.message ?? String(err)}`)
      }
    }

    // 1b. Compact bloated/drifted MEMORY.md index (CAS-protected on live write, zero-write on dryRun)
    if (compactMemoryIndex) {
      try {
        const memdir = createMemoryDirForAgentDir(input.agentDir, input.agentId)
        const idxPath = memdir.indexPath()
        let idxStat: Awaited<ReturnType<typeof lstat>> | null = null
        try {
          idxStat = await lstat(idxPath)
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
        }
        if (idxStat) {
          if (idxStat.isSymbolicLink() || !idxStat.isFile()) {
            throw new MemoryBoundaryError('unsafe MEMORY.md (symlink or non-file)')
          }
          const idxBuf = await readFile(idxPath)
          const expectedIndexSha256 = createHash('sha256').update(idxBuf).digest('hex')
          const compactRes = await memdir.compactIndexIfNeeded({
            maxBytes: memoryIndexMaxBytes,
            expectedIndexSha256,
            dryRun,
          })
          if (compactRes.conflict) {
            errors.push('memory_index_compact: concurrent_modification_conflict')
          } else if (dryRun) {
            const wouldChange =
              compactRes.needed &&
              (compactRes.bytesSaved > 0 ||
                compactRes.brokenLinksRemoved > 0 ||
                compactRes.oversizedLinesCompacted > 0 ||
                compactRes.afterBytes !== compactRes.beforeBytes)
            memoryIndexCompacted = wouldChange
            memoryIndexBytesSaved = compactRes.bytesSaved
            memoryIndexBrokenLinksRemoved = compactRes.brokenLinksRemoved
            bytesFreed += compactRes.bytesSaved
          } else if (compactRes.compacted) {
            memoryIndexCompacted = true
            memoryIndexBytesSaved = compactRes.bytesSaved
            memoryIndexBrokenLinksRemoved = compactRes.brokenLinksRemoved
            bytesFreed += compactRes.bytesSaved
          }
        }
      } catch (err) {
        errors.push(`memory_index_compact: ${(err as Error)?.message ?? String(err)}`)
      }
    }

    // 2. Archival lifecycle / explicit deletion:
    //    - `mode === 'manual'`: NEVER run global decay or unguided deletion.
    //      Only delete explicit `pruneArchivalIds` when provided (non-empty).
    //    - `mode === 'auto'`: run policy decay + 60d cleanup (unless explicit IDs given).
    if (runDecayArchival) {
      try {
        const hasExplicitIds = input.pruneArchivalIds !== undefined
        if (hasExplicitIds) {
          if (input.pruneArchivalIds!.length > 0) {
            const db =
              input.sessionsDb ?? (await (await import('./sessionsDb.js')).getSessionsDb())
            const res = deleteExplicitArchivalIdsOnDb(
              db,
              input.agentId,
              input.pruneArchivalIds!,
              dryRun,
            )
            archivalDecayed = res.decayed
            archivalCleaned = res.cleaned
            bytesFreed += res.bytesFreed
          }
        } else if (mode === 'auto') {
          if (input.sessionsDb) {
            const res = runArchivalLifecycleOnDb(input.sessionsDb, input.agentId, nowMs, dryRun)
            archivalDecayed = res.decayed
            archivalCleaned = res.cleaned
            bytesFreed += res.bytesFreed
          } else if (dryRun) {
            const { getSessionsDb } = await import('./sessionsDb.js')
            const res = runArchivalLifecycleOnDb(await getSessionsDb(), input.agentId, nowMs, true)
            archivalDecayed = res.decayed
            archivalCleaned = res.cleaned
            bytesFreed += res.bytesFreed
          } else {
            archivalDecayed = await decayAccess({
              agentId: input.agentId,
              inactiveDays: 30,
              decayAmount: 1,
            })
            const cleaned = await cleanupArchival({
              agentId: input.agentId,
              minAccessCount: 0,
              minAgeDays: 60,
              maxDeletes: 50,
            })
            archivalCleaned = cleaned.deletedCount
            bytesFreed += cleaned.bytesFreed
          }
        }
      } catch (err) {
        errors.push(`archival_lifecycle: ${(err as Error)?.message ?? String(err)}`)
      }
    }

    // 3 & 4. Skill history pruning + optional cold skill archiving
    if (input.skillsDir && existsSync(input.skillsDir)) {
      const skills = await scanUserSkills(input.skillsDir, maxSkillHistoryVersions)

      if (pruneHistory) {
        for (const skill of skills) {
          if (selectedSkillHistoryNames && !selectedSkillHistoryNames.has(skill.name)) {
            continue
          }
          if (skill.excessHistoryCount <= 0) continue
          try {
            const res = await pruneSkillHistoryDir(
              join(input.skillsDir, skill.name, 'history'),
              input.skillsDir,
              maxSkillHistoryVersions,
              { dryRun },
            )
            skillHistoriesPruned += res.pruned
            bytesFreed += res.bytesFreed
          } catch (err) {
            errors.push(`skill_history(${skill.name}): ${(err as Error)?.message ?? String(err)}`)
          }
        }
      }

      if (archiveCold) {
        const usageMap = await readUsageMapReadonly(input.sessionsDb)
        const coldCap =
          input.maxColdSkillsPerRun !== undefined
            ? Math.max(0, Math.floor(input.maxColdSkillsPerRun))
            : mode === 'auto'
              ? 10
              : Number.POSITIVE_INFINITY
        const coldCandidates = skills
          .filter((skill) => {
            if ((skill.priority ?? 0) >= PINNED_PRIORITY_THRESHOLD) return false
            const usage = usageMap.get(skill.name)
            return (
              classifySkillTier(usage, {
                priority: skill.priority,
                nowMs,
                coldDays: coldSkillDays,
                mtimeMs: skill.mtimeMs,
              }) === 'cold'
            )
          })
          .sort((a, b) => {
            const aLast = usageMap.get(a.name)?.lastUsedAt ?? a.mtimeMs
            const bLast = usageMap.get(b.name)?.lastUsedAt ?? b.mtimeMs
            return aLast - bLast || a.name.localeCompare(b.name)
          })
          .slice(0, coldCap)

        for (const skill of coldCandidates) {
          try {
            if (dryRun) {
              coldSkillsArchived += 1
              bytesFreed += skill.skillMdBytes
              archivedSkillNames.push(skill.name)
            } else {
              const res = await archiveUserSkill(input.skillsDir, skill.name, {
                reason: `cold_skill_inactive_${coldSkillDays}d`,
                actor: `context-janitor:${mode}`,
                batchId,
              })
              if (res.entry) {
                coldSkillsArchived += 1
                bytesFreed += res.entry.bytes
                archivedSkillNames.push(res.entry.name)
              }
            }
          } catch (err) {
            errors.push(`cold_skill(${skill.name}): ${(err as Error)?.message ?? String(err)}`)
          }
        }
      }
    }

    const didArchive = expiredMemoriesArchived > 0 || coldSkillsArchived > 0
    const record: ContextHygieneRunRecord = {
      runId,
      batchId: didArchive ? batchId : null,
      agentId: input.agentId,
      mode,
      dryRun,
      startedAt,
      finishedAt: new Date(dryRun ? nowMs : Date.now()).toISOString(),
      expiredMemoriesArchived,
      coldSkillsArchived,
      skillHistoriesPruned,
      archivalDecayed,
      archivalCleaned,
      bytesFreed,
      archivedMemoryFiles,
      archivedSkillNames,
      errors,
      memoryIndexCompacted,
      memoryIndexBytesSaved,
      memoryIndexBrokenLinksRemoved,
    }

    if (!dryRun) {
      await appendContextHygieneHistory(input.agentDir, record)
    }
    return record
  }

  if (dryRun) {
    // Strictly zero disk mutations in dryRun (do not even create lockfiles).
    return await execute()
  }

  await mkdir(input.agentDir, { recursive: true })
  const release = await acquireFileLock(join(input.agentDir, '.context-hygiene.lock'))
  try {
    return await execute()
  } finally {
    await release().catch(() => {})
  }
}
