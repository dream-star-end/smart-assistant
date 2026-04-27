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

/**
 * Emit a snapshot of a bash command's tail output. Snapshot semantics:
 * the consumer (gateway → web) replaces its prior tail buffer with `tail`
 * rather than appending — the polling cadence is deliberately lossy on
 * the head when output exceeds the tail window, which is signalled by
 * `truncatedHead`.
 */
export function emitBashOutputTail(
  toolUseId: string,
  tail: string,
  totalBytes: number,
  truncatedHead: boolean,
  opts?: { taskId?: string; parentToolUseId?: string },
): void {
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
