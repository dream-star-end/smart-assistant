// ── Phase 0.3: per-session outbound frame ring buffer ──
//
// Short-term replay cache for outbound.message frames. Backs the
// `autoResumeFromHello(lastFrameSeq)` cursor replay: when a web client
// reconnects, anything within the buffer window can be redelivered without
// hitting REST.
//
// Authoritative persistence still lives in Phase 0.1/0.2 (server-authored
// messages + msg-outbox). This ring is purely an optimisation: if it
// misses, we emit `outbound.resume_failed` and the client escalates to REST.
//
// Bounds per sessionKey:
//   - max entries (default 4000)
//   - max wall-clock age in ms (default 10 min)
//   - max cumulative serialized bytes (default 8 MB)
// Whichever fires first evicts an entry.
//
// ── 帧分级(team-durability 2026-07-07)──
// 帧分两级:`content`(正文/thinking/tool/final 等终态或 REST 权威内容)与
// `progress`(delegate_progress 进度行、turn_status sideband 等易失 UX 帧)。
// 团队模式 review/嵌套委派以 >15 帧/s 刷 progress 帧,2 分钟离线窗口即可冲穿
// 旧 2000 帧配额,把同窗口内的正文和 final 一起挤掉(resume buffer_miss,
// 2026-07-07 事故)。规则:
//   - entries/bytes 超限时**先淘汰最老的 progress 帧**,无 progress 可淘才动 content;
//   - 每个 ring 维护 `contentLossSeq` = 已被淘汰的 content 帧的最大 seq;
//   - 回放判据从"最老帧必须与游标连续"改为"游标 ≥ contentLossSeq":纯 progress
//     空洞可安全跳过(客户端 frameSeq 游标只单调去重、不要求连续),content 有损
//     才升级 buffer_miss → REST 全量重拉。

export type FrameClass = 'content' | 'progress'

export interface RingConfig {
  maxEntries: number
  maxAgeMs: number
  maxBytes: number
}

export const DEFAULT_RING_CONFIG: RingConfig = {
  maxEntries: 4000,
  maxAgeMs: 10 * 60_000,
  maxBytes: 8 * 1024 * 1024,
}

/** Per-session cap of terminal-fenced clientMessageIds. Oldest entry is dropped. */
export const FENCED_TURN_CAP = 16

interface RingEntry {
  seq: number
  ts: number
  data: string
  bytes: number
  cls: FrameClass
}

interface SessionRing {
  frames: RingEntry[]
  totalBytes: number
  /** 已被淘汰(entries/bytes/age 任一原因)的 content 帧的最大 seq;0=从未丢 content。
   *  SessionRing 结构体被 pruneAll 整体回收时它随之消失 —— 那时 peekReplay 走
   *  no_buffer 路径(fromSeq>0),同样升级 REST,判定不放松。 */
  contentLossSeq: number
}

interface ActiveTurnMarker {
  /** Persisted browser user-row id bound to the actual session-lock owner. */
  clientMessageId: string
  /** Last frame assigned before this turn acquired the lock. */
  baseSeq: number
}

export type ReplayMissReason = 'no_buffer' | 'buffer_miss' | 'sequence_mismatch'

/**
 * Counts of frames dropped by `prune()`, broken down by which bound forced
 * the eviction. Returned alongside `store()` / `peekReplay()` so the caller
 * can feed Prometheus counters without this module importing metrics.
 *
 * Cause classification rule: a single dropped entry is attributed to exactly
 * one cause — whichever bound is checked first in `prune()` (entries → bytes
 * → age). This avoids double-counting when multiple bounds are simultaneously
 * exceeded.
 */
export interface EvictionStats {
  entries: number
  age: number
  bytes: number
}

export type ReplayResult =
  | { ok: true; sent: RingEntry[]; to: number; evicted: EvictionStats }
  | { ok: false; sent: never[]; to: number; reason: ReplayMissReason; evicted: EvictionStats }

export class OutboundRingBuffer {
  private rings = new Map<string, SessionRing>()
  private lastSeq = new Map<string, number>()
  /** Separate from SessionRing so an active turn with no output allocates no
   * empty frame namespace. The marker exists only between the lock-owner
   * lifecycle callbacks and is cleared by end()/clear(). */
  private activeTurns = new Map<string, ActiveTurnMarker>()
  /** Terminal-fenced cmids. Independent of the active marker so a retry that
   * already moved the lock still cannot receive frames addressed to the old
   * dispatch. Insertion order is eviction order; cap is FENCED_TURN_CAP. */
  private fencedTurns = new Map<string, Set<string>>()

  constructor(private readonly config: RingConfig = DEFAULT_RING_CONFIG) {}

  /**
   * Allocate the next monotonic frameSeq for this sessionKey (1-based).
   * Separated from `store()` so the caller can bake the returned seq into
   * the JSON payload before serialising — the serialised string is then
   * what we actually send on the wire AND what we buffer.
   */
  nextSeq(sessionKey: string): number {
    const seq = (this.lastSeq.get(sessionKey) ?? 0) + 1
    this.lastSeq.set(sessionKey, seq)
    return seq
  }

  /**
   * Store the serialized frame for later replay. `seq` MUST have been
   * obtained from a prior `nextSeq(sessionKey)` call so the ring remains
   * monotonic. Calls prune() after insertion and returns the eviction
   * cause counts produced by that prune so the caller can feed metrics.
   */
  store(
    sessionKey: string,
    seq: number,
    now: number,
    data: string,
    cls: FrameClass = 'content',
  ): EvictionStats {
    let ring = this.rings.get(sessionKey)
    if (!ring) {
      // 重建 ring(pruneAll 曾整体回收 / 首帧)时,seq>1 说明此前有帧且已不可回放,
      // 水位线保守初始化为 seq-1 —— 否则"回收后重建"的 ring 会把重建前丢失的
      // content 帧误判为可跳过的 progress 空洞。
      ring = { frames: [], totalBytes: 0, contentLossSeq: Math.max(0, seq - 1) }
      this.rings.set(sessionKey, ring)
    }
    const bytes = Buffer.byteLength(data, 'utf8')
    ring.frames.push({ seq, ts: now, data, bytes, cls })
    ring.totalBytes += bytes
    return this.prune(sessionKey, ring, now)
  }

  /**
   * Idempotent store for callers that already own the frameSeq stamp upstream
   * (instead of allocating one via `nextSeq()`). Used by the v3 commercial
   * bridge: containers stamp `frameSeq` themselves, the bridge can only
   * observe and persist the stamped value — re-stamping would diverge from
   * what the client cursor expects.
   *
   * Idempotency: when multiple bridge instances share a process-singleton
   * ring (multi-tab fan-out, where the container broadcasts the same wire
   * frame down each open WS), they each call `storeStamped` with the same
   * `(sessionKey, seq)`. `seq <= prevLast` is treated as a duplicate write
   * and skipped — `lastSeq` is **not** demoted, the existing ring entry is
   * **not** replaced, and no eviction stats are produced.
   *
   * Container lifecycle reset is handled by the caller embedding a
   * lifecycle discriminator (e.g. containerId) into `sessionKey`, so a
   * post-restart frame seq=1 lands in a fresh namespace and never collides
   * with the previous container's seq=1. This keeps `storeStamped` purely
   * idempotent — no in-band reset detection.
   */
  storeStamped(
    sessionKey: string,
    seq: number,
    now: number,
    data: string,
    cls: FrameClass = 'content',
  ): EvictionStats {
    const prevLast = this.lastSeq.get(sessionKey) ?? 0
    if (seq <= prevLast) {
      // Multi-bridge duplicate or upstream-bug retransmit. Skip silently.
      return { entries: 0, age: 0, bytes: 0 }
    }
    this.lastSeq.set(sessionKey, seq)
    let ring = this.rings.get(sessionKey)
    if (!ring) {
      // 同 store():重建 ring 时水位线保守初始化为 seq-1(见 store 内注释)。
      ring = { frames: [], totalBytes: 0, contentLossSeq: Math.max(0, seq - 1) }
      this.rings.set(sessionKey, ring)
    }
    const bytes = Buffer.byteLength(data, 'utf8')
    ring.frames.push({ seq, ts: now, data, bytes, cls })
    ring.totalBytes += bytes
    return this.prune(sessionKey, ring, now)
  }

  /** Mark the turn that currently owns the per-session execution lock. */
  beginActiveTurn(sessionKey: string, clientMessageId: string): void {
    this.activeTurns.set(sessionKey, {
      clientMessageId,
      baseSeq: this.lastSeq.get(sessionKey) ?? 0,
    })
  }

  /** End exactly the marked turn, then immediately restore ordinary age
   * pruning now that the immutable terminal tape is authoritative.
   * The cmid is always fenced, even when the active marker has already
   * moved to a retry — otherwise late delegate_progress keeps growing the
   * terminated dispatch stream. */
  endActiveTurn(
    sessionKey: string,
    clientMessageId: string,
    now: number = Date.now(),
  ): EvictionStats {
    this.fenceTurn(sessionKey, clientMessageId)
    const marker = this.activeTurns.get(sessionKey)
    if (!marker || marker.clientMessageId !== clientMessageId) {
      return { entries: 0, age: 0, bytes: 0 }
    }
    this.activeTurns.delete(sessionKey)
    const ring = this.rings.get(sessionKey)
    if (!ring) return { entries: 0, age: 0, bytes: 0 }
    const evicted = this.prune(sessionKey, ring, now)
    if (ring.frames.length === 0) this.rings.delete(sessionKey)
    return evicted
  }

  isTurnFenced(sessionKey: string, clientMessageId: string): boolean {
    return this.fencedTurns.get(sessionKey)?.has(clientMessageId) === true
  }

  private fenceTurn(sessionKey: string, clientMessageId: string): void {
    if (!clientMessageId) return
    let set = this.fencedTurns.get(sessionKey)
    if (!set) {
      set = new Set()
      this.fencedTurns.set(sessionKey, set)
    }
    if (set.has(clientMessageId)) return
    set.add(clientMessageId)
    while (set.size > FENCED_TURN_CAP) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  /** Server-owned identity currently bound to the actual lock owner. */
  activeTurnClientMessageId(sessionKey: string): string | undefined {
    return this.activeTurns.get(sessionKey)?.clientMessageId
  }

  /** Replay the complete buffered slice of one exact active turn. Unlike
   * peekReplay(), this is the only safe cold-cursor path: it never includes
   * completed-turn frames before baseSeq, and any hard-cap content loss after
   * baseSeq converts the whole attempt to a miss. */
  peekActiveTurnReplay(
    sessionKey: string,
    clientMessageId: string,
    now: number = Date.now(),
  ): ReplayResult {
    const currentLast = this.lastSeq.get(sessionKey) ?? 0
    const marker = this.activeTurns.get(sessionKey)
    const ring = this.rings.get(sessionKey)
    const evicted: EvictionStats = ring
      ? this.prune(sessionKey, ring, now)
      : { entries: 0, age: 0, bytes: 0 }
    if (!marker || marker.clientMessageId !== clientMessageId) {
      return { ok: false, sent: [], to: currentLast, reason: 'no_buffer', evicted }
    }
    if (currentLast === marker.baseSeq) {
      return { ok: true, sent: [], to: currentLast, evicted }
    }
    if (!ring) {
      return { ok: false, sent: [], to: currentLast, reason: 'no_buffer', evicted }
    }
    if (ring.contentLossSeq > marker.baseSeq) {
      return { ok: false, sent: [], to: currentLast, reason: 'buffer_miss', evicted }
    }
    return {
      ok: true,
      sent: ring.frames.filter((frame) => frame.seq > marker.baseSeq),
      to: currentLast,
      evicted,
    }
  }

  /**
   * Compute replay decision for a client cursor. Does NOT actually call
   * ws.send — returns the frames to send (or a miss reason) so the caller
   * can wire it to whatever transport it owns.
   *
   * **Age-based prune on read**: `store()` prunes by `maxAgeMs` only when
   * new frames arrive. After an idle tail (turn finished, session quiescent)
   * nothing calls `store()`, so stale frames older than `maxAgeMs` stay in
   * the ring and would get replayed to a late-reconnecting client. That's
   * not just wasted bytes — the client's authoritative state has likely
   * moved on (REST sync, other tabs), and replaying a stale transcript
   * slice can resurrect deleted content or conflict with Phase 0.1 server-
   * authored merges. We prune again here so a long-idle session that wakes
   * up for a resume attempt either serves fresh frames or honestly reports
   * `buffer_miss`, forcing the client down the REST-authoritative path.
   */
  peekReplay(sessionKey: string, fromSeq: number, now: number = Date.now()): ReplayResult {
    const currentLast = this.lastSeq.get(sessionKey) ?? 0
    const ring = this.rings.get(sessionKey)
    const evicted: EvictionStats = ring
      ? this.prune(sessionKey, ring, now)
      : { entries: 0, age: 0, bytes: 0 }
    if (fromSeq > currentLast) {
      // Client claims to have seen frames we don't know about. If we have
      // no ring for this sessionKey at all, assume the server restarted and
      // lost state — the client should do a REST force-sync to recover.
      // If we do have a ring but it ends earlier than fromSeq, the cursor
      // is bogus (different server instance / tampered storage).
      if (!ring || ring.frames.length === 0) {
        return { ok: false, sent: [], to: currentLast, reason: 'no_buffer', evicted }
      }
      return { ok: false, sent: [], to: currentLast, reason: 'sequence_mismatch', evicted }
    }
    if (fromSeq === currentLast) {
      return { ok: true, sent: [], to: currentLast, evicted }
    }
    // P1-3: fromSeq=0 is NOT a valid resume cursor when the server has already
    // emitted frames (currentLast>0). It means the client has either lost its
    // cursor (cold tab / state reset / prior resume_failed) or was never party
    // to the frames in the ring (multi-tab: new tab opened after a turn another
    // tab processed). Ring-replaying in that state would re-deliver frames
    // whose assistant deltas the client may already have (restored from IDB,
    // or persisted by the other tab) — and since text blocks carry no blockId,
    // the client cannot dedupe them at the block level and silently appends a
    // duplicate assistant bubble.
    //
    // Honest signal: escalate to no_buffer so the client runs force-REST-sync
    // via handleResumeFailed. The Phase 0.1/0.2 durable tape is authoritative.
    //
    // Genuinely fresh sessions (never-run, never-emitted) pass the earlier
    // `fromSeq === currentLast` branch when both are 0 — so a new session
    // saying "I've seen nothing" still resolves to ok/[].
    if (fromSeq === 0 && currentLast > 0) {
      return { ok: false, sent: [], to: currentLast, reason: 'no_buffer', evicted }
    }
    if (!ring || ring.frames.length === 0) {
      // After the fromSeq=0+currentLast>0 guard above, any no-ring state here
      // means fromSeq>0: client held a cursor the server can no longer satisfy
      // (ring pruned by age/bytes/entries, or this gateway instance restarted
      // and never stored frames for this sessionKey). Escalate to no_buffer so
      // the client force-REST-syncs.
      if (fromSeq > 0) {
        return { ok: false, sent: [], to: currentLast, reason: 'no_buffer', evicted }
      }
      // Unreachable in the current flow — `fromSeq === currentLast === 0`
      // already returned ok/[] above, and fromSeq=0+currentLast>0 returned
      // no_buffer. Kept as a defensive total-cases guard in case future
      // edits reorder the branches.
      return { ok: true, sent: [], to: currentLast, evicted }
    }
    // 帧分级判据:游标之后只要丢过任何 content 帧就 miss(client 必须 REST 重拉);
    // 只丢过 progress 帧(contentLossSeq ≤ fromSeq)则照常回放 —— 留存帧之间的
    // seq 空洞全部是 progress 损耗,客户端游标单调去重、天然容忍空洞。
    if (ring.contentLossSeq > fromSeq) {
      return { ok: false, sent: [], to: currentLast, reason: 'buffer_miss', evicted }
    }
    const frames = ring.frames.filter((f) => f.seq > fromSeq)
    return { ok: true, sent: frames, to: currentLast, evicted }
  }

  /** Current last-assigned seq for a session, or 0 if none. */
  lastFrameSeq(sessionKey: string): number {
    return this.lastSeq.get(sessionKey) ?? 0
  }

  /** Number of frames currently buffered for a session (0 if none). */
  size(sessionKey: string): number {
    return this.rings.get(sessionKey)?.frames.length ?? 0
  }

  /** Total bytes buffered for a session. */
  bytes(sessionKey: string): number {
    return this.rings.get(sessionKey)?.totalBytes ?? 0
  }

  /** Sum of buffered bytes across every session ring. Cheap to compute on
   *  demand (linear in #sessions, not #frames) and used to refresh the
   *  `oc_outbound_ring_size_bytes` Prom gauge from server.ts. */
  totalBytes(): number {
    let n = 0
    for (const r of this.rings.values()) n += r.totalBytes
    return n
  }

  /** Drop the ring (but keep lastSeq) for a session — used on session destroy. */
  clear(sessionKey: string): void {
    this.rings.delete(sessionKey)
    this.lastSeq.delete(sessionKey)
    this.activeTurns.delete(sessionKey)
    this.fencedTurns.delete(sessionKey)
  }

  /**
   * Background sweep across every stored sessionKey: prune by all three bounds,
   * then drop ring entries that age out completely. Intended to be called by
   * a low-frequency timer (e.g. once per minute) in long-lived multi-tenant
   * gateways — without it, lazy on-touch pruning leaves stale namespaces from
   * old container lifecycles in memory indefinitely (v3 commercial bridge
   * stamps storeKey with `${uid}:${containerId}:...`; a recycled container
   * gets a fresh storeKey and the old one is never accessed again).
   *
   * `lastSeq` is intentionally retained even after `frames` empties: the
   * `peekReplay` no_buffer/sequence_mismatch contract distinguishes "session
   * never had frames" (lastSeq=0) from "session had frames, ring pruned"
   * (lastSeq>0). Dropping lastSeq would silently flip a real out-of-window
   * cursor into a fresh-session ok/[]. The lastSeq Map entry itself costs
   * <100 bytes and grows slowly relative to ring frame memory.
   */
  pruneAll(now: number): EvictionStats {
    const total: EvictionStats = { entries: 0, age: 0, bytes: 0 }
    for (const [key, ring] of this.rings) {
      const ev = this.prune(key, ring, now)
      total.entries += ev.entries
      total.age += ev.age
      total.bytes += ev.bytes
      if (ring.frames.length === 0 && !this.activeTurns.has(key)) {
        // Empty inactive ring: drop the SessionRing struct so the rings Map
        // doesn't grow without bound across container lifecycles. Keep an
        // active empty ring because contentLossSeq distinguishes safe loss of
        // progress-only frames from current-turn content lost to a hard cap.
        // lastSeq survives either way.
        this.rings.delete(key)
      }
    }
    return total
  }

  /** Cause-aware eviction: each dropped frame is attributed to exactly one
   *  bound. Order is `entries → bytes → age`: if multiple bounds are
   *  exceeded, the entry counts toward whichever is checked first. This
   *  prevents one frame from being counted under two causes (which would
   *  double-count in metrics) while still trimming the ring to satisfy all
   *  bounds. Returns the per-cause counts so callers can feed Prometheus.
   *
   *  帧分级淘汰:entries/bytes 压力下先淘最老的 progress 帧(mid-array splice,
   *  frames 保持 seq 有序;n≤maxEntries,线性扫描代价可忽略),无 progress 才淘
   *  frames[0]。hard-cap 淘汰仍 progress-first；age 在 active turn 期间会跳过
   *  当前轮 content 并扫描全数组，以便回收其后的过期 progress。任何 content
   *  帧被淘汰都推进 contentLossSeq 水位线。
   */
  private prune(sessionKey: string, ring: SessionRing, now: number): EvictionStats {
    const stats: EvictionStats = { entries: 0, age: 0, bytes: 0 }
    const cutoff = now - this.config.maxAgeMs
    const dropAt = (index: number): RingEntry | undefined => {
      const dropped = ring.frames.splice(index, 1)[0]
      if (dropped) {
        ring.totalBytes -= dropped.bytes
        if (dropped.cls === 'content' && dropped.seq > ring.contentLossSeq) {
          ring.contentLossSeq = dropped.seq
        }
      }
      return dropped
    }

    // Hard bounds remain absolute even for an active turn. Preserve the
    // existing progress-first policy, then drop oldest content only when no
    // progress frame remains.
    while (ring.frames.length > this.config.maxEntries || ring.totalBytes > this.config.maxBytes) {
      const cause: 'entries' | 'bytes' =
        ring.frames.length > this.config.maxEntries ? 'entries' : 'bytes'
      const progressIndex = ring.frames.findIndex((frame) => frame.cls === 'progress')
      dropAt(progressIndex >= 0 ? progressIndex : 0)
      stats[cause]++
    }

    // Age is selective while a turn is active: protect only current-turn
    // content. Scan the full array so an expired progress frame behind an
    // older protected content frame is still reclaimed.
    const active = this.activeTurns.get(sessionKey)
    for (let i = 0; i < ring.frames.length; ) {
      const frame = ring.frames[i]!
      const protectedCurrentContent =
        active !== undefined && frame.cls === 'content' && frame.seq > active.baseSeq
      if (frame.ts < cutoff && !protectedCurrentContent) {
        dropAt(i)
        stats.age++
        continue
      }
      i++
    }
    return stats
  }
}
