/**
 * Resume map: per-session native resume ids that survive gateway restarts
 * (`<OPENCLAUDE_HOME>/resume-map.json`). Extracted from SessionManager
 * (FINDINGS §7 step 1): this module owns the state, its persistence and the
 * history / rejected-id bookkeeping. Which id a turn actually resumes with
 * (artifact probes, live sessions) stays SessionManager's policy.
 *
 * The state used to be seven parallel Maps declared in two places of
 * sessionManager.ts; every removal had to touch all of them by hand. They are
 * still parallel Maps (same names, same on-disk format) but now have one owner,
 * one `forget`, and one entry serializer.
 */
import { existsSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'

import { RESUME_HISTORY_MAX } from './engine/resumeArtifacts.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'sessionManager' })

/** Provider name for CCB-backed runners (default). Used as the fallback
 *  tag when an on-disk resume-map entry omits `provider` (legacy format). */
export const CCB_PROVIDER_TAG = 'ccb'

/**
 * Version 1 means a CCB native session was created after provider-switch
 * history became model-window-bounded. Older native JSONL may contain one
 * immutable, oversized synthetic history prompt; resuming it makes every
 * later CCB auto-compaction replay the same rejected request. Such entries
 * must rebuild once from the exact finite PG history suffix instead.
 */
export const CCB_RESUME_HISTORY_CONTEXT_VERSION = 1

/** M1a:resume-map provider tag 的历史值归一。旧格式在 P1f 前写过
 *  'codex-native'(provider 语义);engine 维度泛化后统一为 engine id
 *  'codex',其余(含缺省)一律 'ccb'。加载与比较都过这一个函数,
 *  防新旧 tag 混用导致 resume 条目被误判跨底座。 */
export function normalizeEngineTag(tag: string | undefined): string {
  if (tag === 'codex-native' || tag === 'codex') return 'codex'
  if (tag === 'grok') return 'grok'
  if (tag === 'cursor') return 'cursor'
  if (tag === 'zcode') return 'zcode'
  if (tag === 'antigravity') return 'antigravity'
  return CCB_PROVIDER_TAG
}

/** On-disk entry shape (resume-map.json). */
export type ResumeEntry = {
  id: string
  ts: number
  lastCost?: number
  costImprecise?: boolean
  provider?: string
  historyContextVersion?: number
  /** Prior same-provider ids, newest first (durable-artifact fallback ladder). */
  history?: string[]
  /** `id` was promoted from `history`: it may predate the latest turns (OCV5-556). */
  promotedFromHistory?: true
}

/** What a live session contributes when the map is saved. */
export type LiveResumeHead = {
  ccbSessionId: string | null | undefined
  _lastCcbCumulativeCost: number
  costImprecise?: boolean
  providerTag?: string
}

export class ResumeStore {
  // Resume map: sessionKey → ccbSessionId (survives gateway restart)
  readonly ids = new Map<string, string>()
  // Parallel map: sessionKey → runner provider that produced the id.
  // Needed to keep codex thread_ids and CCB session_ids from being cross-fed
  // when the same sessionKey is later served by a different provider.
  // Legacy entries without explicit provider are treated as 'ccb' on load.
  readonly provider = new Map<string, string>()
  /** Parallel map: sessionKey → prior native ids for the SAME provider, newest
   *  first, bounded by RESUME_HISTORY_MAX. This is the fallback ladder for
   *  "the head id never produced a durable transcript" (CLI emitted session_id
   *  then died / container rebuilt mid-spawn). Persisted as `history` in
   *  resume-map.json. Cleared whenever the provider changes or the entry is
   *  intentionally reset (model switch, context_too_long, destroy). */
  readonly history = new Map<string, string[]>()
  /** sessionKey → native ids the ENGINE itself rejected at runtime for this
   *  session ("No conversation found with session ID", zcode `Session not
   *  found`). A non-empty file on disk is not proof the engine can load it
   *  (2026-09-07: transcript existed under another cwd's project dir), so the
   *  durable-artifact probe alone re-promoted the same dead id after every
   *  crash. Anything in this set is skipped by the history ladder for the
   *  rest of the gateway process; in-memory only — a restart re-arms the
   *  probe, and a fresh spawn either relocates the transcript or lands on a
   *  new id. */
  readonly rejected = new Map<string, Set<string>>()
  // Resume-map TTL: track when each entry was last updated
  readonly timestamps = new Map<string, number>()
  // Persisted cost-delta baseline for resumed CCB sessions. CCB's
  // restoreCostStateForSession sets STATE.totalCostUSD to this value on start,
  // so the gateway must seed the matching baseline before the first post-resume
  // `result` arrives (otherwise the parser would compute delta against 0 and
  // re-attribute the entire historical cumulative as this turn's cost).
  readonly lastCost = new Map<string, number>()
  readonly costImprecise = new Map<string, boolean>()
  /** sessionKey → head id the durable-artifact ladder promoted from history.
   *  Such a conversation can miss the turns that ran on the dead newer head,
   *  so master history after the agent's own last answer is not a complete
   *  delta for it (OCV5-556). Cleared when the engine mints a new id or the
   *  entry is forgotten. Persisted as `promotedFromHistory`. */
  readonly promotedFromHistory = new Map<string, string>()
  // Serialized write queue to prevent concurrent writeFile race conditions
  write: Promise<void> = Promise.resolve()

  // Mutable: tests (and only tests) point the store at a temp file.
  constructor(public path: string) {}

  /** Push `prev` onto the history ladder for `key` (dedup, newest first, bounded). */
  pushHistory(key: string, prev: string | undefined | null): void {
    if (!prev) return
    if (this.rejected.get(key)?.has(prev)) return
    const cur = this.history.get(key) ?? []
    const next = [prev, ...cur.filter((x) => x !== prev)].slice(0, RESUME_HISTORY_MAX)
    this.history.set(key, next)
  }

  /** Ids the engine named in its stale-resume error. CCB: `No conversation
   *  found with session ID: <uuid>`; zcode: `Session not found: sess_…`. The
   *  engine mints a NEW session id before it fails to load the old one, so
   *  `session.ccbSessionId` at detection time is the fresh id, not the refused
   *  one — the error text is the only authoritative source. */
  static extractRejectedIds(errorDetail: string | undefined): string[] {
    if (!errorDetail) return []
    const out = new Set<string>()
    const re =
      /(?:No conversation found with session ID|Session not found|Persisted child session not found):\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|sess_[A-Za-z0-9_-]{8,80})/g
    for (const m of errorDetail.matchAll(re)) {
      const id = m[1]
      if (id) out.add(id.toLowerCase())
    }
    return [...out]
  }

  /** Mark every resume-map id for `key` (head, history, live) whose engine-side
   *  inner id is one the engine just refused. Resume-map ids may carry a
   *  transport prefix (`sand-ccb:<uuid>`), so match on the trailing segment. */
  markRejectedFromError(
    key: string,
    errorDetail: string | undefined,
    liveId: string | null | undefined,
  ): string[] {
    const refused = ResumeStore.extractRejectedIds(errorDetail)
    if (refused.length === 0) return []
    const candidates = new Set<string>()
    const head = this.ids.get(key)
    if (head) candidates.add(head)
    for (const h of this.history.get(key) ?? []) candidates.add(h)
    if (liveId) candidates.add(liveId)
    const marked: string[] = []
    for (const cand of candidates) {
      const inner = cand.includes(':') ? cand.slice(cand.lastIndexOf(':') + 1) : cand
      if (refused.includes(inner.toLowerCase())) {
        this.markRejected(key, cand)
        marked.push(cand)
      }
    }
    return marked
  }

  /** Record that the engine refused to resume `id` for `key`. Bounded per key
   *  so a pathological session cannot grow the set without limit. */
  markRejected(key: string, id: string | undefined | null): void {
    if (!id) return
    const set = this.rejected.get(key) ?? new Set<string>()
    set.add(id)
    if (set.size > RESUME_HISTORY_MAX * 4) {
      const [oldest] = set
      if (oldest !== undefined) set.delete(oldest)
    }
    this.rejected.set(key, set)
    const hist = this.history.get(key)
    if (hist?.includes(id)) {
      const next = hist.filter((h) => h !== id)
      if (next.length > 0) this.history.set(key, next)
      else this.history.delete(key)
    }
  }

  /** Remove every resume-map projection for `key` (id, ts, provider, cost, history). */
  forget(key: string): void {
    this.ids.delete(key)
    this.timestamps.delete(key)
    this.provider.delete(key)
    this.lastCost.delete(key)
    this.costImprecise.delete(key)
    this.history.delete(key)
    this.promotedFromHistory.delete(key)
  }

  load(): void {
    // Try primary file first, fall back to backup if corrupted (atomic-write safety net)
    for (const path of [this.path, `${this.path}.bak`]) {
      try {
        if (!existsSync(path)) continue
        const data = JSON.parse(readFileSync(path, 'utf-8'))
        // Support both legacy format {key: sessionId} and new format
        // {key: {id, ts, lastCost?, provider?, historyContextVersion?}}
        // Missing `provider` → treated as CCB (the only provider before
        // codex-native landed), matching _resumeIdFor's fallback.
        for (const [key, val] of Object.entries(data)) {
          if (typeof val === 'string') {
            log.info('dropping CCB resume from obsolete history context contract', {
              sessionKey: key,
              historyContextVersion: null,
            })
          } else if (val && typeof val === 'object' && 'id' in (val as any)) {
            const prov = normalizeEngineTag(
              typeof (val as any).provider === 'string' && (val as any).provider
                ? (val as any).provider
                : undefined,
            )
            if (
              prov === CCB_PROVIDER_TAG &&
              (val as any).historyContextVersion !== CCB_RESUME_HISTORY_CONTEXT_VERSION
            ) {
              log.info('dropping CCB resume from obsolete history context contract', {
                sessionKey: key,
                historyContextVersion: (val as any).historyContextVersion ?? null,
              })
              continue
            }
            this.ids.set(key, (val as any).id)
            this.timestamps.set(key, (val as any).ts ?? Date.now())
            // Optional cost-delta baseline for the resumed CCB. If present,
            // CCB will restore STATE.totalCostUSD to this value and the
            // gateway needs the same baseline to compute correct per-turn
            // deltas on the first post-resume `result`.
            const lastCost = (val as any).lastCost
            if (typeof lastCost === 'number' && Number.isFinite(lastCost) && lastCost >= 0) {
              this.lastCost.set(key, lastCost)
            }
            if ((val as any).costImprecise === true) {
              this.costImprecise.set(key, true)
            }
            const history = (val as any).history
            if (Array.isArray(history)) {
              const cleaned = history
                .filter(
                  (h): h is string =>
                    typeof h === 'string' && h.length > 0 && h !== (val as any).id,
                )
                .slice(0, RESUME_HISTORY_MAX)
              if (cleaned.length > 0) this.history.set(key, cleaned)
            }
            if ((val as any).promotedFromHistory === true) {
              this.promotedFromHistory.set(key, (val as any).id)
            }
            // M1a:tag 归一为 engine id(历史 'codex-native' → 'codex')。
            this.provider.set(key, prov)
          }
        }
        return // Successfully parsed (even if empty — empty means all sessions were destroyed)
      } catch {
        log.warn('failed to load resume-map', { path })
      }
    }
  }

  /** Provider tag + history fields shared by stored and live entries. */
  private withProviderAndHistory(
    entry: ResumeEntry,
    key: string,
    prov: string,
    head: string,
  ): ResumeEntry {
    if (prov === CCB_PROVIDER_TAG) {
      entry.historyContextVersion = CCB_RESUME_HISTORY_CONTEXT_VERSION
    }
    // Only serialize provider when it differs from the implicit 'ccb' default.
    if (prov && prov !== CCB_PROVIDER_TAG) entry.provider = prov
    const hist = this.history.get(key)?.filter((h) => h !== head)
    if (hist && hist.length > 0) entry.history = hist.slice(0, RESUME_HISTORY_MAX)
    if (this.promotedFromHistory.get(key) === head) entry.promotedFromHistory = true
    return entry
  }

  /**
   * Build the file contents. Merge: start from the loaded resume-map (includes
   * sessions not yet re-activated), then overlay with live sessions (which may
   * have updated ccbSessionIds after resume). Live heads are also adopted into
   * the in-memory maps, exactly as the inline serializer did.
   */
  serialize(live: Iterable<[string, LiveResumeHead]>, now = Date.now()): string {
    const obj: Record<string, ResumeEntry> = {}
    for (const [key, val] of this.ids) {
      const entry: ResumeEntry = {
        id: val,
        ts: this.timestamps.get(key) ?? now,
      }
      const cached = this.lastCost.get(key)
      if (cached !== undefined && cached > 0) entry.lastCost = cached
      if (this.costImprecise.get(key) === true) entry.costImprecise = true
      obj[key] = this.withProviderAndHistory(
        entry,
        key,
        normalizeEngineTag(this.provider.get(key)),
        val,
      )
    }
    for (const [key, sess] of live) {
      if (sess.ccbSessionId) {
        const entry: ResumeEntry = {
          id: sess.ccbSessionId,
          ts: now,
        }
        if (sess._lastCcbCumulativeCost > 0) entry.lastCost = sess._lastCcbCumulativeCost
        if (sess.costImprecise === true) entry.costImprecise = true
        // Provider map wins when set. When a drop just cleared it, fall back
        // to the live engine so a Grok id is not rewritten as implicit ccb
        // (historyContextVersion only) and then refused on the next lookup.
        const prov = normalizeEngineTag(this.provider.get(key) ?? sess.providerTag)
        // Live session is authoritative for head. History is only ever fed by
        // the session_id handler (previous durable id) — never re-derived here,
        // so a promotion can't be undone by the serializer (review B2).
        obj[key] = this.withProviderAndHistory(entry, key, prov, sess.ccbSessionId)
        this.adoptLive(key, sess, now)
      }
    }
    return JSON.stringify(obj, null, 2)
  }

  /** Keep in-memory maps in sync with a live session's head (part of save). */
  private adoptLive(key: string, sess: LiveResumeHead, now: number): void {
    this.ids.set(key, sess.ccbSessionId as string)
    this.timestamps.set(key, now)
    this.lastCost.set(key, sess._lastCcbCumulativeCost)
    if (sess.costImprecise === true) this.costImprecise.set(key, true)
  }

  /** Queue an atomic write of `data` (tmp + rename, previous file kept as .bak). */
  persist(data: string): void {
    // Atomic write: write to .tmp, then rename (rename is atomic on Linux/ext4)
    const tmpPath = `${this.path}.tmp`
    const bakPath = `${this.path}.bak`
    this.write = this.write
      .then(async () => {
        await writeFile(tmpPath, data)
        // Backup current file before overwriting (fallback if crash during rename)
        try {
          if (existsSync(this.path)) {
            await rename(this.path, bakPath)
          }
        } catch {}
        await rename(tmpPath, this.path)
      })
      .catch((err) => log.error('resume-map write failed', {}, err))
  }

  /** Await any pending writes. Loops until the write promise stabilizes —
   *  handles late writes queued during await. */
  async flush(): Promise<void> {
    let prev: Promise<void> | null = null
    while (prev !== this.write) {
      prev = this.write
      await prev
    }
  }

  /**
   * Drop entries whose session is not live and whose last update is older than
   * `ttlMs`. ts=0 = unknown age (legacy entry whose file mtime could not be
   * stat'd on load): `now - 0` is huge, so it is pruned on the first sweep.
   * Returns what was pruned; the caller logs and saves.
   */
  prune(
    isLive: (key: string) => boolean,
    ttlMs: number,
    now = Date.now(),
  ): Array<{ key: string; ageMs: number | null }> {
    const pruned: Array<{ key: string; ageMs: number | null }> = []
    for (const [key] of this.ids) {
      if (isLive(key)) continue // live session — keep
      const ts = this.timestamps.get(key) ?? 0
      if (now - ts > ttlMs) {
        this.forget(key)
        pruned.push({ key, ageMs: ts === 0 ? null : now - ts })
      }
    }
    return pruned
  }
}
