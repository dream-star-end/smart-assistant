// Skill job retention selector (pure, unit-tested) — the shared eviction policy for
// the three skill job registries (eval / eval-gen / train). See docs/audit/msc-skills.md · S-02.
//
// Problem: the registries are in-process Maps and their on-disk run files
// (skill-evals/, skill-drafts/) were never GC'd, so memory + disk grew unbounded on a
// long-lived gateway (daily auto-regression the worst offender). This module decides
// WHICH terminal runs to evict; each store wires it to drop the Map entry + rm the file.
//
// Hard rules (boss/指挥官 pre-approved):
//   - NEVER evict a non-terminal run (queued/running/grading, or a train run at
//     diff_ready whose drafts are paid-for and awaiting the user). Callers mark those
//     `evictable:false`.
//   - Keep the newest `keepPerSkill` terminal runs per skill regardless of age (recent
//     history stays visible).
//   - Beyond that: evict terminal runs older than `retentionMs`; then, if still over
//     `maxEntries` total, evict the oldest unprotected terminal runs until under cap.

export interface RetentionEntry {
  id: string
  /** Grouping key for the per-skill keep-floor (skill name, or a stable placeholder). */
  skillKey: string
  /** When the run reached a terminal state (ms epoch); fallbacks allowed by caller. */
  finishedAt: number
  /** False = protected (active / diff_ready): never evicted, but still counts toward maxEntries. */
  evictable: boolean
}

export interface RetentionConfig {
  now: number
  /** Terminal runs older than this are eligible for eviction (unless within the keep-floor). */
  retentionMs: number
  /** Newest-N terminal runs per skill are protected from age eviction. */
  keepPerSkill: number
  /** Total in-memory cap; over it, evict oldest unprotected terminal runs. */
  maxEntries: number
}

/**
 * Decide which run ids to evict. Pure: no I/O, deterministic given inputs. Returns a
 * Set of ids the caller should drop (from memory + disk). Never includes a
 * non-evictable id.
 */
export function selectRunsToEvict(
  entries: readonly RetentionEntry[],
  cfg: RetentionConfig,
): Set<string> {
  const keepPerSkill = Math.max(0, Math.floor(cfg.keepPerSkill))
  const maxEntries = Math.max(0, Math.floor(cfg.maxEntries))
  const retentionMs = Math.max(0, cfg.retentionMs)
  const evict = new Set<string>()

  const evictable = entries.filter((e) => e.evictable)

  // Per-skill newest-N protection (by finishedAt desc; id as deterministic tiebreak).
  const protectedIds = new Set<string>()
  const bySkill = new Map<string, RetentionEntry[]>()
  for (const e of evictable) {
    const list = bySkill.get(e.skillKey)
    if (list) list.push(e)
    else bySkill.set(e.skillKey, [e])
  }
  for (const list of bySkill.values()) {
    list.sort((a, b) => b.finishedAt - a.finishedAt || (a.id < b.id ? 1 : -1))
    for (const e of list.slice(0, keepPerSkill)) protectedIds.add(e.id)
  }

  // 1) Age eviction: terminal, past retention, not in the per-skill keep-floor.
  for (const e of evictable) {
    if (protectedIds.has(e.id)) continue
    if (cfg.now - e.finishedAt > retentionMs) evict.add(e.id)
  }

  // 2) Cap eviction: if still over maxEntries, drop oldest unprotected terminal runs.
  let remaining = entries.length - evict.size
  if (remaining > maxEntries) {
    const candidates = evictable
      .filter((e) => !evict.has(e.id) && !protectedIds.has(e.id))
      .sort((a, b) => a.finishedAt - b.finishedAt || (a.id < b.id ? -1 : 1))
    for (const e of candidates) {
      if (remaining <= maxEntries) break
      evict.add(e.id)
      remaining--
    }
  }

  return evict
}

/** Default retention knobs; env overrides via readSkillRunRetentionEnv (OPENCLAUDE_* naming). */
export const SKILL_RUN_RETENTION_DEFAULTS = {
  retentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  keepPerSkill: 20,
  maxEntries: 500,
} as const

/** Default janitor sweep interval (server.ts timer). */
export const SKILL_RUN_JANITOR_DEFAULT_MS = 6 * 60 * 60 * 1000 // 6h

export interface SkillRunRetentionEnv {
  retentionMs: number
  keepPerSkill: number
  maxEntries: number
  janitorMs: number
}

function posInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw.trim())
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/**
 * Retention/janitor config from env (all optional; sane defaults). Naming aligns with
 * the repo's OPENCLAUDE_* convention:
 *   OPENCLAUDE_SKILL_RUN_RETENTION_MS / _KEEP_PER_SKILL / _MAX_ENTRIES / _JANITOR_MS
 */
export function readSkillRunRetentionEnv(
  env: NodeJS.ProcessEnv = process.env,
): SkillRunRetentionEnv {
  return {
    retentionMs: posInt(
      env.OPENCLAUDE_SKILL_RUN_RETENTION_MS,
      SKILL_RUN_RETENTION_DEFAULTS.retentionMs,
    ),
    keepPerSkill: posInt(
      env.OPENCLAUDE_SKILL_RUN_KEEP_PER_SKILL,
      SKILL_RUN_RETENTION_DEFAULTS.keepPerSkill,
    ),
    maxEntries: posInt(
      env.OPENCLAUDE_SKILL_RUN_MAX_ENTRIES,
      SKILL_RUN_RETENTION_DEFAULTS.maxEntries,
    ),
    janitorMs: Math.max(
      60_000,
      posInt(env.OPENCLAUDE_SKILL_RUN_JANITOR_MS, SKILL_RUN_JANITOR_DEFAULT_MS),
    ),
  }
}
