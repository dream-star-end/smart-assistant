import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import type { SdkWorkflowProgress } from '../types/tools.js'

type TaskStartedEvent = {
  type: 'system'
  subtype: 'task_started'
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  workflow_name?: string
  prompt?: string
}

type TaskProgressEvent = {
  type: 'system'
  subtype: 'task_progress'
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  // Delta batch of workflow state changes. Clients upsert by
  // `${type}:${index}` then group by phaseIndex to rebuild the phase tree,
  // same fold as collectFromEvents + groupByPhase in PhaseProgress.tsx.
  workflow_progress?: SdkWorkflowProgress[]
}

// Emitted when a foreground agent completes without being backgrounded.
// Drained by drainSdkEvents() directly into the output stream — does NOT
// go through the print.ts XML task_notification parser and does NOT trigger
// the LLM loop. Consumers (e.g. VS Code session.ts) use this to remove the
// task from the subagent panel.
type TaskNotificationSdkEvent = {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  output_file: string
  summary: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
}

// Mirrors notifySessionStateChanged. The CCR bridge already receives this
// via its own listener; SDK consumers (scmuxd, VS Code) need the same signal
// to know when the main turn's generator is idle vs actively producing.
// The 'idle' transition fires AFTER heldBackResult flushes and the bg-agent
// do-while loop exits — so SDK consumers can trust it as the authoritative
// "turn is over" signal even when result was withheld for background agents.
type SessionStateChangedEvent = {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
}

// Snapshot of the latest tail of a bash command's output, emitted on a polling
// cadence (~1 Hz, driven by TaskOutput's shared poller). `tail` is a tail-only
// snapshot in plain text — the consumer should REPLACE its prior tail buffer
// rather than append. `total_bytes` is the file size at the time of capture;
// `truncated_head` is true when output exceeded the tail window and the
// preceding content is not in `tail`.
//
// For background tasks the tool_use_id is the original BashTool toolUseId
// captured at spawn time; the gateway uses it (plus parent_tool_use_id for
// subagents) to route the frame back to the right UI card.
type BashOutputTailEvent = {
  type: 'system'
  subtype: 'bash_output_tail'
  tool_use_id: string
  parent_tool_use_id?: string
  task_id?: string
  tail: string
  total_bytes: number
  truncated_head: boolean
}

export type SdkEvent =
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationSdkEvent
  | SessionStateChangedEvent
  | BashOutputTailEvent

const MAX_QUEUE_SIZE = 1000
const queue: SdkEvent[] = []
let flushListener: ((events: SdkEvent[]) => void) | null = null

export function enqueueSdkEvent(event: SdkEvent): void {
  // SDK events are only consumed (drained) in headless/streaming mode.
  // In TUI mode they would accumulate up to the cap and never be read.
  if (!getIsNonInteractiveSession()) {
    return
  }
  // Push-mode: bypass the queue entirely so background-task ticks don't
  // wait for the next message in the main turn loop. The listener stamps
  // uuid+session_id and writes to the output stream immediately.
  if (flushListener) {
    flushListener([event])
    return
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
  }
  queue.push(event)
}

export function drainSdkEvents(): Array<
  SdkEvent & { uuid: UUID; session_id: string }
> {
  if (queue.length === 0) {
    return []
  }
  const events = queue.splice(0)
  return events.map(e => ({
    ...e,
    uuid: randomUUID(),
    session_id: getSessionId(),
  }))
}

/**
 * Register a listener that receives SDK events synchronously as they are
 * enqueued. While a listener is set, enqueueSdkEvent skips the in-memory
 * queue entirely — events flow straight to the listener. This is required
 * for background-task ticks (e.g. bash_output_tail) that must reach the
 * client even when the main turn loop is idle (no message → no drain).
 *
 * Returns a disposer; the caller MUST call it on shutdown to drop the
 * reference and resume queue mode for any subsequent (post-listener)
 * emissions.
 */
export function setFlushListener(
  listener: (events: SdkEvent[]) => void,
): () => void {
  flushListener = listener
  // Drain anything that was queued before the listener was attached so it
  // isn't lost when print.ts later switches over to drain-on-message.
  if (queue.length > 0) {
    const pending = queue.splice(0)
    listener(pending)
  }
  return () => {
    if (flushListener === listener) {
      flushListener = null
    }
  }
}

/**
 * Emit a task_notification SDK event for a task reaching a terminal state.
 *
 * registerTask() always emits task_started; this is the closing bookend.
 * Call this from any exit path that sets a task terminal WITHOUT going
 * through enqueuePendingNotification-with-<task-id> (print.ts parses that
 * XML into the same SDK event, so paths that do both would double-emit).
 * Paths that suppress the XML notification (notified:true pre-set, kill
 * paths, abort branches) must call this directly so SDK consumers
 * (Scuttle's bg-task dot, VS Code subagent panel) see the task close.
 */
export function emitTaskTerminatedSdk(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  opts?: {
    toolUseId?: string
    summary?: string
    outputFile?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  },
): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: opts?.toolUseId,
    status,
    output_file: opts?.outputFile ?? '',
    summary: opts?.summary ?? '',
    usage: opts?.usage,
  })
}

// The three payload fields of a bash_output_tail frame that define its
// content identity. Two frames with equal snapshots carry no new information
// for the consumer (which REPLACES its tail buffer wholesale).
export type BashTailSnapshot = {
  tail: string
  totalBytes: number
  truncatedHead: boolean
}

/**
 * Cheap, non-cryptographic fingerprint of a tail frame, used as the dedup key
 * so the store retains a short string per stream instead of the (potentially
 * multi-MB) tail text — which is what lets the cap below be generous.
 *
 * `totalBytes` and `truncatedHead` are kept verbatim (exact discriminators —
 * bash output is append-only, so totalBytes strictly grows on any new
 * content); only the large `tail` string is reduced, via two independent
 * 32-bit rolling hashes (FNV-1a + djb2) concatenated for ~64-bit width in fast
 * integer math (no BigInt, single pass). A dropped change would require
 * identical totalBytes AND truncatedHead AND a 64-bit hash clash on differing
 * tails — negligible for append-only output.
 */
export function bashTailFingerprint(next: BashTailSnapshot): string {
  const s = next.tail
  let h1 = 0x811c9dc5 // FNV-1a offset basis
  let h2 = 5381 // djb2
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) // FNV prime
    h2 = (Math.imul(h2, 33) + c) | 0
  }
  return `${next.totalBytes}|${next.truncatedHead ? 1 : 0}|${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`
}

// Per-tool_use_id last-emitted fingerprint, used to suppress unchanged frames.
// The tail poller ticks at ~1 Hz for the whole life of a (possibly
// backgrounded) bash command; when output stops growing, every tick would
// otherwise re-emit an identical frame — a production incident saw a silent
// background command flood one frame/sec for 13 minutes.
//
// Bounded FIFO keyed by first-seen order to keep the map from growing across a
// long session with many commands. Storing a cheap fingerprint (not the full
// snapshot) lets the cap be generous: within 1024 concurrently active streams
// there is no eviction and dedup is exact. Beyond 1024 simultaneously-live
// streams FIFO can cycle-evict (each re-emits on its next tick) — a rare
// pathological fan-out that the gateway's tail-collapse layer backstops. The
// fingerprint keeps the dedup lifecycle fully encapsulated in this single
// emitter with no cross-module teardown.
const BASH_TAIL_DEDUP_MAX = 1024
const bashTailDedupStore = new Map<string, string>()

/**
 * Dedup decision for a bash_output_tail frame. State-injection style (the
 * caller owns `store`) so it is unit-testable without module singletons.
 *
 * Returns true (emit) and records the fingerprint when `next` differs from the
 * last one recorded for `toolUseId` — including the first frame (no prior) and
 * any change to tail / totalBytes / truncatedHead. Returns false (skip) when
 * the fingerprint is identical to the last recorded one.
 *
 * When a new key pushes the store past `maxEntries`, the oldest first-seen
 * entry is evicted (FIFO). Updating an existing key never triggers eviction.
 */
export function dedupeBashOutputTail(
  store: Map<string, string>,
  toolUseId: string,
  next: BashTailSnapshot,
  maxEntries: number,
): boolean {
  const fingerprint = bashTailFingerprint(next)
  if (store.get(toolUseId) === fingerprint) {
    return false
  }
  // Map.set on an existing key preserves its insertion position, so first-seen
  // order (and therefore FIFO eviction order) is stable across updates.
  store.set(toolUseId, fingerprint)
  if (store.size > maxEntries) {
    const oldest = store.keys().next().value
    if (oldest !== undefined) {
      store.delete(oldest)
    }
  }
  return true
}

/**
 * Emit a snapshot of a bash command's tail output. Snapshot semantics:
 * the consumer (gateway → web) replaces its prior tail buffer with `tail`
 * rather than appending — the polling cadence is deliberately lossy on
 * the head when output exceeds the tail window, which is signalled by
 * `truncatedHead`.
 *
 * Unchanged-frame suppression: frames whose (tail, totalBytes, truncatedHead)
 * are identical to the previously emitted one for this toolUseId are dropped
 * here at the single emitter, covering both the foreground onProgress path and
 * the backgrounded keepalive (which reuses the same onProgress closure). Any
 * content change — including the first frame and a terminal frame carrying new
 * bytes / a changed truncated flag — still emits.
 */
export function emitBashOutputTail(
  toolUseId: string,
  tail: string,
  totalBytes: number,
  truncatedHead: boolean,
  opts?: { taskId?: string; parentToolUseId?: string },
): void {
  if (
    !dedupeBashOutputTail(
      bashTailDedupStore,
      toolUseId,
      { tail, totalBytes, truncatedHead },
      BASH_TAIL_DEDUP_MAX,
    )
  ) {
    return
  }
  enqueueSdkEvent({
    type: 'system',
    subtype: 'bash_output_tail',
    tool_use_id: toolUseId,
    parent_tool_use_id: opts?.parentToolUseId,
    task_id: opts?.taskId,
    tail,
    total_bytes: totalBytes,
    truncated_head: truncatedHead,
  })
}
