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
//   - max entries (default 2000)
//   - max wall-clock age in ms (default 10 min)
//   - max cumulative serialized bytes (default 5 MB)
// Whichever fires first evicts the oldest entry.

export interface RingConfig {
  maxEntries: number
  maxAgeMs: number
  maxBytes: number
}

export const DEFAULT_RING_CONFIG: RingConfig = {
  maxEntries: 2000,
  maxAgeMs: 10 * 60_000,
  maxBytes: 5 * 1024 * 1024,
}

interface RingEntry {
  seq: number
  ts: number
  data: string
  bytes: number
}

interface SessionRing {
  frames: RingEntry[]
  totalBytes: number
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
  store(sessionKey: string, seq: number, now: number, data: string): EvictionStats {
    let ring = this.rings.get(sessionKey)
    if (!ring) {
      ring = { frames: [], totalBytes: 0 }
      this.rings.set(sessionKey, ring)
    }
    const bytes = Buffer.byteLength(data, 'utf8')
    ring.frames.push({ seq, ts: now, data, bytes })
    ring.totalBytes += bytes
    return this.prune(ring, now)
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
    const evicted: EvictionStats = ring ? this.prune(ring, now) : { entries: 0, age: 0, bytes: 0 }
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
    const earliest = ring.frames[0].seq
    if (earliest > fromSeq + 1) {
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
  }

  /** Cause-aware eviction: each dropped frame is attributed to exactly one
   *  bound. Order is `entries → bytes → age`: if multiple bounds are
   *  exceeded, the entry counts toward whichever is checked first. This
   *  prevents one frame from being counted under two causes (which would
   *  double-count in metrics) while still trimming the ring to satisfy all
   *  bounds. Returns the per-cause counts so callers can feed Prometheus.
   */
  private prune(ring: SessionRing, now: number): EvictionStats {
    const stats: EvictionStats = { entries: 0, age: 0, bytes: 0 }
    const cutoff = now - this.config.maxAgeMs
    while (ring.frames.length > 0) {
      let cause: keyof EvictionStats | null = null
      if (ring.frames.length > this.config.maxEntries) cause = 'entries'
      else if (ring.totalBytes > this.config.maxBytes) cause = 'bytes'
      else if (ring.frames[0].ts < cutoff) cause = 'age'
      if (!cause) break
      const dropped = ring.frames.shift()
      if (dropped) ring.totalBytes -= dropped.bytes
      stats[cause]++
    }
    return stats
  }
}
