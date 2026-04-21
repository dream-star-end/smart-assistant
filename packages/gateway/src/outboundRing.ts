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

export type ReplayResult =
  | { ok: true; sent: RingEntry[]; to: number }
  | { ok: false; sent: never[]; to: number; reason: ReplayMissReason }

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
   * monotonic. Calls prune() after insertion.
   */
  store(sessionKey: string, seq: number, now: number, data: string): void {
    let ring = this.rings.get(sessionKey)
    if (!ring) {
      ring = { frames: [], totalBytes: 0 }
      this.rings.set(sessionKey, ring)
    }
    const bytes = Buffer.byteLength(data, 'utf8')
    ring.frames.push({ seq, ts: now, data, bytes })
    ring.totalBytes += bytes
    this.prune(ring, now)
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
    if (ring) this.prune(ring, now)
    if (fromSeq > currentLast) {
      // Client claims to have seen frames we don't know about. If we have
      // no ring for this sessionKey at all, assume the server restarted and
      // lost state — the client should do a REST force-sync to recover.
      // If we do have a ring but it ends earlier than fromSeq, the cursor
      // is bogus (different server instance / tampered storage).
      if (!ring || ring.frames.length === 0) {
        return { ok: false, sent: [], to: currentLast, reason: 'no_buffer' }
      }
      return { ok: false, sent: [], to: currentLast, reason: 'sequence_mismatch' }
    }
    if (fromSeq === currentLast) {
      return { ok: true, sent: [], to: currentLast }
    }
    if (!ring || ring.frames.length === 0) {
      return fromSeq > 0
        ? { ok: false, sent: [], to: currentLast, reason: 'no_buffer' }
        : { ok: true, sent: [], to: currentLast }
    }
    const earliest = ring.frames[0].seq
    if (earliest > fromSeq + 1) {
      return { ok: false, sent: [], to: currentLast, reason: 'buffer_miss' }
    }
    const frames = ring.frames.filter((f) => f.seq > fromSeq)
    return { ok: true, sent: frames, to: currentLast }
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

  /** Drop the ring (but keep lastSeq) for a session — used on session destroy. */
  clear(sessionKey: string): void {
    this.rings.delete(sessionKey)
    this.lastSeq.delete(sessionKey)
  }

  private prune(ring: SessionRing, now: number): void {
    const cutoff = now - this.config.maxAgeMs
    while (
      ring.frames.length > 0 &&
      (
        ring.frames.length > this.config.maxEntries ||
        ring.totalBytes > this.config.maxBytes ||
        ring.frames[0].ts < cutoff
      )
    ) {
      const dropped = ring.frames.shift()
      if (dropped) ring.totalBytes -= dropped.bytes
    }
  }
}
