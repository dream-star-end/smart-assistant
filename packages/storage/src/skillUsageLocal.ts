/**
 * Local Skill Usage Ledger & Cold/Hot Tiering
 *
 * Persists lightweight local usage counters in SQLite (`skill_usage_local`)
 * so skill ranking and lifecycle hygiene work identically in personal/offline
 * mode and commercial containers without depending on master telemetry.
 */

import { getSessionsDb } from './sessions/sqliteHandle.js'

export interface LocalSkillUsageRecord {
  slug: string
  layer: string
  useCount: number
  searchHitCount: number
  lastUsedAt: number | null
  lastSearchHitAt: number | null
}

export type SkillActivityTier = 'hot' | 'warm' | 'cold'

export interface ClassifySkillTierOptions {
  priority?: number
  nowMs?: number
  coldDays?: number
  mtimeMs?: number | null
}

export interface SkillUsageDbLike {
  exec(sql: string): unknown
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number }
  }
  transaction<T>(fn: () => T): () => T
}

export const SKILL_USAGE_LOCAL_DDL = `
CREATE TABLE IF NOT EXISTS skill_usage_local (
  slug TEXT NOT NULL,
  layer TEXT NOT NULL DEFAULT 'user',
  use_count INTEGER NOT NULL DEFAULT 0,
  search_hit_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  last_search_hit_at INTEGER,
  PRIMARY KEY (slug, layer)
);
`

const DAY_MS = 86_400_000
const DEFAULT_COLD_DAYS = 60
const DEFAULT_HOT_DAYS = 30
const PINNED_PRIORITY_THRESHOLD = 60

const ensuredDbs = new WeakSet<object>()

export function ensureSkillUsageLocalTable(db: SkillUsageDbLike): void {
  if (ensuredDbs.has(db as object)) return
  db.exec(SKILL_USAGE_LOCAL_DDL)
  ensuredDbs.add(db as object)
}

async function resolveDb(db?: SkillUsageDbLike): Promise<SkillUsageDbLike> {
  const handle = db ?? (await getSessionsDb())
  ensureSkillUsageLocalTable(handle)
  return handle
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase()
}

function normalizeLayer(layer?: string): string {
  const trimmed = (layer ?? 'user').trim().toLowerCase()
  return trimmed || 'user'
}

/**
 * Record a local `skill_view` hit (upsert). Never throws on empty slug.
 */
export async function recordLocalSkillView(
  slug: string,
  layer = 'user',
  opts?: { db?: SkillUsageDbLike; nowMs?: number },
): Promise<void> {
  const cleanSlug = normalizeSlug(slug)
  if (!cleanSlug) return
  const db = await resolveDb(opts?.db)
  const now = opts?.nowMs ?? Date.now()
  const cleanLayer = normalizeLayer(layer)
  db.prepare(`
    INSERT INTO skill_usage_local (slug, layer, use_count, search_hit_count, last_used_at, last_search_hit_at)
    VALUES (?, ?, 1, 0, ?, NULL)
    ON CONFLICT(slug, layer) DO UPDATE SET
      use_count = skill_usage_local.use_count + 1,
      last_used_at = CASE
        WHEN skill_usage_local.last_used_at IS NULL OR excluded.last_used_at > skill_usage_local.last_used_at
        THEN excluded.last_used_at
        ELSE skill_usage_local.last_used_at
      END
  `).run(cleanSlug, cleanLayer, now)
}

/**
 * Record local `skill_search` hits for one or more returned skill slugs.
 */
export async function recordLocalSkillSearchHits(
  slugs: readonly string[],
  layer = 'user',
  opts?: { db?: SkillUsageDbLike; nowMs?: number },
): Promise<void> {
  const unique = [...new Set(slugs.map(normalizeSlug).filter(Boolean))]
  if (unique.length === 0) return
  const db = await resolveDb(opts?.db)
  const now = opts?.nowMs ?? Date.now()
  const cleanLayer = normalizeLayer(layer)
  const stmt = db.prepare(`
    INSERT INTO skill_usage_local (slug, layer, use_count, search_hit_count, last_used_at, last_search_hit_at)
    VALUES (?, ?, 0, 1, NULL, ?)
    ON CONFLICT(slug, layer) DO UPDATE SET
      search_hit_count = skill_usage_local.search_hit_count + 1,
      last_search_hit_at = CASE
        WHEN skill_usage_local.last_search_hit_at IS NULL OR excluded.last_search_hit_at > skill_usage_local.last_search_hit_at
        THEN excluded.last_search_hit_at
        ELSE skill_usage_local.last_search_hit_at
      END
  `)
  const tx = db.transaction(() => {
    for (const slug of unique) {
      stmt.run(slug, cleanLayer, now)
    }
  })
  tx()
}

/**
 * Load all local skill usage records indexed by slug.
 * If the same slug appears across multiple layers, counts are summed and the
 * most recent timestamps are retained so lookups by `skill.name` stay exact.
 */
export async function getLocalSkillUsageMap(
  opts?: { db?: SkillUsageDbLike; layer?: string },
): Promise<Map<string, LocalSkillUsageRecord>> {
  const map = new Map<string, LocalSkillUsageRecord>()
  const db = await resolveDb(opts?.db)
  const rows = (
    opts?.layer
      ? db
          .prepare(
            `SELECT slug, layer, use_count, search_hit_count, last_used_at, last_search_hit_at
             FROM skill_usage_local
             WHERE layer = ?`,
          )
          .all(normalizeLayer(opts.layer))
      : db
          .prepare(
            `SELECT slug, layer, use_count, search_hit_count, last_used_at, last_search_hit_at
             FROM skill_usage_local`,
          )
          .all()
  ) as Array<{
    slug: string
    layer: string
    use_count: number
    search_hit_count: number
    last_used_at: number | null
    last_search_hit_at: number | null
  }>

  for (const row of rows) {
    const slug = normalizeSlug(row.slug)
    if (!slug) continue
    const useCount = Number.isFinite(row.use_count) ? Math.max(0, Number(row.use_count)) : 0
    const searchHitCount = Number.isFinite(row.search_hit_count)
      ? Math.max(0, Number(row.search_hit_count))
      : 0
    const lastUsedAt =
      typeof row.last_used_at === 'number' && Number.isFinite(row.last_used_at)
        ? row.last_used_at
        : null
    const lastSearchHitAt =
      typeof row.last_search_hit_at === 'number' && Number.isFinite(row.last_search_hit_at)
        ? row.last_search_hit_at
        : null
    const prev = map.get(slug)
    if (!prev) {
      map.set(slug, {
        slug,
        layer: row.layer || 'user',
        useCount,
        searchHitCount,
        lastUsedAt,
        lastSearchHitAt,
      })
    } else {
      const mergedLastUsed =
        prev.lastUsedAt === null
          ? lastUsedAt
          : lastUsedAt === null
            ? prev.lastUsedAt
            : Math.max(prev.lastUsedAt, lastUsedAt)
      const mergedLastSearch =
        prev.lastSearchHitAt === null
          ? lastSearchHitAt
          : lastSearchHitAt === null
            ? prev.lastSearchHitAt
            : Math.max(prev.lastSearchHitAt, lastSearchHitAt)
      map.set(slug, {
        slug,
        layer: prev.layer === 'user' || row.layer !== 'user' ? prev.layer : 'user',
        useCount: prev.useCount + useCount,
        searchHitCount: prev.searchHitCount + searchHitCount,
        lastUsedAt: mergedLastUsed,
        lastSearchHitAt: mergedLastSearch,
      })
    }
  }
  return map
}

/**
 * Classify a skill into hot / warm / cold activity tier:
 * - priority >= 60 OR viewed within 30 days → 'hot'
 * - viewed within coldDays (default 60d) OR search-hit within coldDays → 'warm'
 * - never used AND mtimeMs provided AND age <= coldDays → 'warm' (grace period for new skills)
 * - otherwise (>coldDays without use, or never used & older than coldDays / unknown mtime) → 'cold'
 */
export function classifySkillTier(
  usage: LocalSkillUsageRecord | null | undefined,
  options: ClassifySkillTierOptions = {},
): SkillActivityTier {
  if (typeof options.priority === 'number' && options.priority >= PINNED_PRIORITY_THRESHOLD) {
    return 'hot'
  }
  const nowMs = options.nowMs ?? Date.now()
  const coldDays = Math.max(1, Math.floor(options.coldDays ?? DEFAULT_COLD_DAYS))
  const hotDays = Math.min(DEFAULT_HOT_DAYS, coldDays)
  const hotWindowMs = hotDays * DAY_MS
  const coldWindowMs = coldDays * DAY_MS

  if (usage && usage.useCount > 0 && usage.lastUsedAt !== null) {
    const ageMs = nowMs - usage.lastUsedAt
    if (ageMs <= hotWindowMs) return 'hot'
    if (ageMs <= coldWindowMs) return 'warm'
  }

  if (usage && usage.searchHitCount > 0 && usage.lastSearchHitAt !== null) {
    const searchAgeMs = nowMs - usage.lastSearchHitAt
    if (searchAgeMs <= coldWindowMs) return 'warm'
  }

  if (usage && usage.useCount > 0 && usage.lastUsedAt === null) {
    return 'warm'
  }

  const neverUsed = !usage || (usage.useCount === 0 && usage.searchHitCount === 0)
  if (neverUsed && typeof options.mtimeMs === 'number' && Number.isFinite(options.mtimeMs)) {
    return nowMs - options.mtimeMs > coldWindowMs ? 'cold' : 'warm'
  }

  return 'cold'
}
