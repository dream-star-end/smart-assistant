// OpenClaude — frontend turn-commit diagnostic trace.
//
// In-memory ring buffer of structured events along the WS-frame → IndexedDB →
// PUT /api/sessions chain. Flushed to /api/web-trace where the gateway writes
// the events to its pino log (no DB write). Purpose: diagnose the d1193355375
// "已读但无回复" class of bug where an assistant reply is delivered by gateway
// but never lands in client_sessions.messages.
//
// Design constraints (Codex-reviewed Plan):
//   • trace() must be no-side-effect & non-blocking on the main path.
//   • Ring is fixed-size (RING_MAX=200, ~40KB worst case).
//   • Default flush trigger is _doSave finally block (covers save chain).
//   • Backup flush after isFinal+1500ms catches "scheduleSave never fired"
//     fault paths. Empty-ring early-return avoids redundant POSTs.
//   • beforeunload sendBeacon is best-effort (cookie auth gives it a chance).
//   • Flush failure policy (per response class):
//       — 5xx / network error: requeue events (transient, next flush retries).
//       — 401 / 413 / other 4xx: discard (terminal — cookie expired / payload
//         oversized / malformed; retrying just wastes ring).
//       — sendBeacon refused: requeue (browser quota / huge body).
//     Failures are never retried inline so a hung /api/web-trace can't stall
//     the save path; the ring's RING_MAX cap defends against runaway requeue
//     during sustained outages.

import { state } from './state.js?v=f3cb894b'

const RING_MAX = 200
// Hard cap on body size per flush to stay well under reasonable POST limits.
const FLUSH_BATCH_MAX = 80

// Each entry = { t, ev, sess, ...extras }. Auto-incrementing _idx is added so
// flush can identify already-sent entries without relying on object identity
// after JSON round-trips (we don't actually round-trip — entries leave the ring
// once successfully sent — but _idx also serves as a stable debug correlator).
let _nextIdx = 1
const _ring = []
let _flushInFlight = false

/**
 * Push a structured event into the ring. Cheap synchronous op; never throws.
 *
 * Reserved field semantics:
 *   t    — Date.now()
 *   ev   — string tag (e.g. 'ws.frame.in')
 *   sess — session id (caller passes via data.sess; falls back to current)
 *
 * Any other keys in `data` are passed through. Caller should keep payload
 * compact (no message text, no large objects) — schema is best-effort.
 */
export function trace(ev, data) {
  try {
    const entry = {
      _idx: _nextIdx++,
      t: Date.now(),
      ev,
      sess: data?.sess ?? state.currentSessionId ?? null,
      ...data,
    }
    // Don't double-store sess; if data carried it we already spread it.
    _ring.push(entry)
    if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX)
  } catch {
    // Best-effort: never let tracing crash a caller.
  }
}

/**
 * Snapshot current ring (for console debugging). Returns a defensive copy.
 */
export function getTraceSnapshot() {
  return _ring.slice()
}

/**
 * Drain up to FLUSH_BATCH_MAX entries from the ring. If `sessId` is given,
 * we still drain all entries — the sessId hint only annotates which session
 * triggered the flush. (Cross-session events around the bug, like
 * sess.switch + ws.frame.in for a different session, must travel together
 * to preserve causality in the server log.)
 */
function _drain() {
  if (_ring.length === 0) return []
  const batch = _ring.splice(0, FLUSH_BATCH_MAX)
  return batch
}

// Return value: `true` if the post succeeded (or was terminal-discarded);
// `false` if the events were requeued for a later flush. Callers (flushTrace)
// use this to decide whether to self-schedule a follow-up flush — requeued
// events must NOT trigger immediate self-flush, otherwise a sustained 5xx /
// network outage would loop forever (Codex round-2 BLOCKING). Beacon path
// always reports success since sendBeacon is fire-and-forget: even when the
// browser refused (rare quota / huge body), we've already unshifted events
// back, and there's no async retry trigger inside beacon flow.
async function _postEvents(events, useBeacon) {
  if (events.length === 0) return true
  const body = JSON.stringify({ events })
  if (useBeacon && navigator.sendBeacon) {
    try {
      // Blob with type application/json so server's getContentType reads it
      // as JSON. sendBeacon ignores rejection; main thread won't block.
      const blob = new Blob([body], { type: 'application/json' })
      const ok = navigator.sendBeacon('/api/web-trace', blob)
      if (!ok) {
        // Browser refused queueing — put events back at front of ring so a
        // later flush can retry. (sendBeacon failure is rare but happens on
        // very large bodies or quota exhaustion.)
        _ring.unshift(...events)
      }
    } catch {
      _ring.unshift(...events)
    }
    return true
  }
  try {
    const res = await fetch('/api/web-trace', {
      method: 'POST',
      // No explicit Authorization header — gateway accepts HttpOnly oc_session
      // cookie set by /api/auth/session at login. keepalive lets the request
      // survive an in-flight navigation if the unload listener also queued
      // sendBeacon for the same events (idempotent on server side since we
      // only log, not dedupe).
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    })
    if (!res.ok) {
      // Codex SHOULD #2: split policy by status. 5xx is transient — requeue so
      // the next flush carries these events along with newer ones. 401/413/4xx
      // are terminal (cookie expired / payload too big / bad shape) and
      // retrying just wastes the ring. Capping ring growth still applies in
      // trace() so requeue can't OOM us during sustained 5xx.
      if (res.status >= 500) {
        _ring.unshift(...events)
        return false
      }
    }
    return true
  } catch {
    // Network failure (offline / DNS / TLS) — transient. Requeue so the next
    // external flush trigger picks them up. We do NOT signal success so
    // flushTrace's self-schedule won't re-enter immediately on the same
    // requeued batch (Codex round-2 BLOCKING — tight retry loop).
    _ring.unshift(...events)
    return false
  }
}

/**
 * Flush ring contents to /api/web-trace. No-op when ring empty. Concurrent
 * non-beacon calls collapse via _flushInFlight guard. Beacon calls bypass the
 * guard because sendBeacon is synchronous-queue and never overlaps the await
 * lifecycle.
 *
 * Codex SHOULD #3: events that arrive while a flush is in-flight (e.g. a 2nd
 * final lands during the first flush's POST) would otherwise sit in the ring
 * until the next external trigger. Re-check ring on finally and self-schedule
 * a follow-up flush so the diagnostician sees the complete event chain even
 * when bursts happen back-to-back.
 *
 * Options:
 *   sessId   — informational only (see _drain docstring). Currently unused
 *              in the payload but accepted for forward compatibility.
 *   beacon   — use navigator.sendBeacon (for beforeunload).
 */
export async function flushTrace(opts = {}) {
  if (_ring.length === 0) return
  if (_flushInFlight && !opts.beacon) return
  if (!opts.beacon) _flushInFlight = true
  let _postOk = false
  try {
    const events = _drain()
    if (events.length === 0) return
    _postOk = await _postEvents(events, !!opts.beacon)
  } finally {
    if (!opts.beacon) {
      _flushInFlight = false
      // Self-schedule ONLY when the just-completed post succeeded AND fresh
      // events accumulated in the ring mid-flight. If post failed (5xx /
      // network), the requeued batch is already in the ring; re-entering
      // would just retry the same events immediately, looping until the
      // endpoint recovers (Codex round-2 BLOCKING). Failed batches wait for
      // the next external trigger (next save / unload / etc.).
      if (_postOk && _ring.length > 0) {
        queueMicrotask(() => { void flushTrace() })
      }
    }
  }
}

// Console debug entry point — `window.__ocFlushTrace()` from devtools.
try {
  window.__ocFlushTrace = (opts) => flushTrace(opts)
  window.__ocTraceSnapshot = () => getTraceSnapshot()
} catch {
  // SSR / non-browser context — ignore.
}
