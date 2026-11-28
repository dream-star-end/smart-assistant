/**
 * Bounded incremental background-task lifecycle tracker for Antigravity CLI
 * transcripts (`<convId>/task-<N>`, OCV5-932).
 *
 * Pure L2 engine helper (zero upward imports, zero file cycles):
 *   - Shared by `antigravitySwarmTelemetry.ts` (byte-0 incremental scanner),
 *     `antigravitySwarmFormat.ts` (turn call reducer), and
 *     `antigravitySwarmWatcher.ts` (snapshot status resolution).
 *   - Uses cursor-based scanning over every `[Message]` segment in a
 *     `SYSTEM_MESSAGE` (no fixed 16-segment cap dropping later completions).
 *   - Never silently evicts a live task ID on capacity overflow: sets
 *     `overflowed = true` so callers preserve active status / suppress auto-kill
 *     until a server-restart notice resets all background tasks.
 */

const MAX_TRACKED_BG_TASKS = 64
const MAX_RETIRED_BG_TASKS = 256
const MAX_REVERIFY_TERMINAL_IDS = 4096
const BG_TASK_START_RE = /^\s*Tool is running as a background task with task id:\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,127})/im
const BG_TASK_DESC_RE = /^\s*Task Description:\s*(.+)$/im
const MANAGE_TASK_ID_RE = /^Task:\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,127})\b/i
const MANAGE_TASK_STATE_RE = /^Status:\s*(RUNNING|ACTIVE|PENDING|IN_PROGRESS|DONE|COMPLETED|FINISHED|FAILED|ERROR|KILLED|STOPPED|CANCELLED|CANCELED|EXITED)\b/im
const MANAGE_TASK_KILL_VERB_RE = /^(?:Killed|Stopped|Cancelled|Canceled)\s+(?:background\s+)?task(?:\s+id)?[:\s]+"?([A-Za-z0-9][A-Za-z0-9._/-]{0,127})"?/im
const MANAGE_TASK_KILL_SUBJ_RE = /^Task(?:\s+id)?[:\s]+"?([A-Za-z0-9][A-Za-z0-9._/-]{0,127})"?\s+(?:has\s+been\s+|was\s+)?(?:killed|stopped|cancelled|canceled|terminated)\b/im
const SERVER_RESTART_RE = /All your subagents and background tasks have been stopped due to server restart/i
const SYS_TASK_TERMINAL_RE = /\bTask\s+id\s+"?([A-Za-z0-9][A-Za-z0-9._/-]{0,127})"?\s+(?:finished|completed|failed|cancelled|canceled|stopped|killed|exited)\b/i
const SYS_STILL_RUNNING_RE = /\bBackground\s+command\s+is\s+still\s+running\b/i
const SYS_INLINE_TASK_ID_RE = /\btask\s+id[:\s]+"?([A-Za-z0-9][A-Za-z0-9._/-]{0,127})"?/i
const SYS_SENDER_RE = /\bsender=([^\s]+)/
const SYS_FIRST_LINE_TERMINAL_RE = /\b(?:finished|completed|failed|cancelled|canceled|stopped|killed|exited)\b/i
const TASK_ID_LIKE_RE = /(?:^|\/)task-\d+$/i
const RUNNING_TASK_STATUSES = new Set(['RUNNING', 'ACTIVE', 'PENDING', 'IN_PROGRESS'])
const MESSAGE_MARKER = '[Message]'

export interface TrackedBackgroundTask {
  readonly id: string
  readonly description?: string
}

export interface BackgroundTaskState {
  readonly active: ReadonlyMap<string, TrackedBackgroundTask>
  readonly retired: ReadonlySet<string>
  readonly overflowed: boolean
  readonly sawServerRestart: boolean
}

export interface MutableBackgroundTaskState {
  readonly active: Map<string, TrackedBackgroundTask>
  readonly retired: Set<string>
  overflowed: boolean
  sawServerRestart: boolean
}

export interface BackgroundTaskTelemetrySummary {
  readonly activeIds: readonly string[]
  readonly retiredIds: readonly string[]
  readonly overflowed: boolean
  readonly sawServerRestart: boolean
  readonly evidenceIncomplete?: boolean
}

export interface MergedBackgroundTaskState {
  readonly activeIds: ReadonlySet<string>
  readonly overflowed: boolean
  readonly incompleteEvidence: boolean
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function cleanBgTaskId(raw: string): string {
  return raw.replace(/[.,:;!?]+$/, '')
}

function addBoundedSet(set: Set<string>, id: string, limit: number): void {
  if (set.has(id)) return
  if (set.size >= limit) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(id)
}

function stripGenericTimestampHeaders(content: string): string {
  const lines = content.slice(0, 768).split(/\r?\n/)
  let idx = 0
  while (idx < lines.length && idx < 6) {
    const trimmed = lines[idx]!.trim()
    if (!trimmed || /^(?:Created At|Completed At):/i.test(trimmed)) idx += 1
    else break
  }
  return lines.slice(idx).join('\n').slice(0, 512)
}

export function createBackgroundTaskState(): MutableBackgroundTaskState {
  return {
    active: new Map<string, TrackedBackgroundTask>(),
    retired: new Set<string>(),
    overflowed: false,
    sawServerRestart: false,
  }
}

export function summarizeBackgroundTaskState(
  state: BackgroundTaskState,
  evidenceIncomplete?: boolean,
): BackgroundTaskTelemetrySummary {
  return {
    activeIds: [...state.active.keys()],
    retiredIds: [...state.retired],
    overflowed: state.overflowed,
    sawServerRestart: state.sawServerRestart,
    ...(evidenceIncomplete !== undefined ? { evidenceIncomplete } : {}),
  }
}

function markBgTaskRunning(state: MutableBackgroundTaskState, rawId: string, description?: string): void {
  const id = cleanBgTaskId(rawId)
  if (!id || state.retired.has(id)) return
  const prev = state.active.get(id)
  if (prev) {
    if (!prev.description && description) state.active.set(id, { id, description })
    return
  }
  if (state.active.size >= MAX_TRACKED_BG_TASKS) {
    // Preserve already-tracked live tasks instead of silently evicting them; flag overflow.
    state.overflowed = true
    return
  }
  state.active.set(id, description ? { id, description } : { id })
}

function retireBgTask(state: MutableBackgroundTaskState, rawId: string): void {
  const id = cleanBgTaskId(rawId)
  if (!id) return
  state.active.delete(id)
  addBoundedSet(state.retired, id, MAX_RETIRED_BG_TASKS)
}

function retireAllBgTasks(state: MutableBackgroundTaskState): void {
  for (const id of state.active.keys()) addBoundedSet(state.retired, id, MAX_RETIRED_BG_TASKS)
  state.active.clear()
  state.overflowed = false
  state.sawServerRestart = true
}

function isMessageMarkerAt(text: string, idx: number, end: number): boolean {
  const after = idx + MESSAGE_MARKER.length
  if (after >= end) return false
  const ch = text.charCodeAt(after)
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d
}

function findNextMessageMarker(text: string, from: number, end: number): number {
  let pos = from
  while (pos < end) {
    const found = text.indexOf(MESSAGE_MARKER, pos)
    if (found < 0 || found >= end) return -1
    if (isMessageMarkerAt(text, found, end)) return found
    pos = found + MESSAGE_MARKER.length
  }
  return -1
}

function forEachSystemMessageSegment(content: string, visit: (segmentHead: string) => void): void {
  if (!content) return
  const openTag = '<SYSTEM_MESSAGE>'
  const openIdx = content.indexOf(openTag)
  const start = openIdx >= 0 ? openIdx + openTag.length : 0
  const closeIdx = openIdx >= 0 ? content.indexOf('</SYSTEM_MESSAGE>', start) : -1
  const end = closeIdx >= 0 ? closeIdx : content.length
  let pos = start
  while (pos < end) {
    const next = findNextMessageMarker(content, pos + 1, end)
    const segEnd = next >= 0 ? next : end
    const head = content.slice(pos, Math.min(segEnd, pos + 512)).trim()
    if (head) visit(head)
    if (next < 0) break
    pos = next
  }
}

type BgStepEvent =
  | { readonly kind: 'restart' }
  | { readonly kind: 'start'; readonly id: string; readonly description?: string }
  | { readonly kind: 'retire'; readonly id: string }

function parseSystemSegmentEvent(segmentHead: string, activeIds?: { has(id: string): boolean }): BgStepEvent | null {
  const firstLine = segmentHead.split(/\r?\n/, 1)[0] ?? ''
  const sender = cleanBgTaskId(SYS_SENDER_RE.exec(firstLine)?.[1] ?? '')
  const contentIdx = firstLine.indexOf('content=')
  const bodyHead =
    contentIdx >= 0
      ? segmentHead.slice(contentIdx + 'content='.length, contentIdx + 'content='.length + 320)
      : segmentHead.slice(0, 320)
  const bodyFirstLine = bodyHead.split(/\r?\n/, 1)[0] ?? ''
  if (SERVER_RESTART_RE.test(bodyFirstLine)) return { kind: 'restart' }
  if (SYS_STILL_RUNNING_RE.test(bodyFirstLine)) {
    const inlineId = SYS_INLINE_TASK_ID_RE.exec(bodyFirstLine)?.[1]
    const taskId = inlineId || (TASK_ID_LIKE_RE.test(sender) || activeIds?.has(sender) ? sender : '')
    return taskId ? { kind: 'start', id: cleanBgTaskId(taskId) } : null
  }
  const termMatch = SYS_TASK_TERMINAL_RE.exec(bodyFirstLine)
  if (termMatch?.[1]) return { kind: 'retire', id: cleanBgTaskId(termMatch[1]) }
  if (sender && (TASK_ID_LIKE_RE.test(sender) || activeIds?.has(sender)) && SYS_FIRST_LINE_TERMINAL_RE.test(bodyFirstLine)) {
    return { kind: 'retire', id: sender }
  }
  return null
}

function parseGenericStepEvent(status: string, content: string): BgStepEvent | null {
  const head = stripGenericTimestampHeaders(content)
  if (status === 'RUNNING' || status === 'ACTIVE') {
    const startMatch = BG_TASK_START_RE.exec(head)
    if (!startMatch?.[1]) return null
    const description = BG_TASK_DESC_RE.exec(head)?.[1]?.trim()
    return { kind: 'start', id: cleanBgTaskId(startMatch[1]), ...(description ? { description } : {}) }
  }
  if (status !== 'DONE') return null
  const taskIdMatch = MANAGE_TASK_ID_RE.exec(head)
  const taskStateMatch = taskIdMatch ? MANAGE_TASK_STATE_RE.exec(head) : null
  if (taskIdMatch?.[1] && taskStateMatch?.[1]) {
    const id = cleanBgTaskId(taskIdMatch[1])
    return RUNNING_TASK_STATUSES.has(taskStateMatch[1].toUpperCase())
      ? { kind: 'start', id }
      : { kind: 'retire', id }
  }
  const killMatch = MANAGE_TASK_KILL_VERB_RE.exec(head) ?? MANAGE_TASK_KILL_SUBJ_RE.exec(head)
  return killMatch?.[1] ? { kind: 'retire', id: cleanBgTaskId(killMatch[1]) } : null
}

function extractBgStepEvents(step: Record<string, unknown>, activeIds?: { has(id: string): boolean }): BgStepEvent[] {
  const stepType = strOf(step.type).toUpperCase()
  const content = typeof step.content === 'string' ? step.content : ''
  if (!content) return []
  if (stepType === 'GENERIC') {
    const ev = parseGenericStepEvent(strOf(step.status).toUpperCase(), content)
    return ev ? [ev] : []
  }
  if (stepType !== 'SYSTEM_MESSAGE') return []
  const events: BgStepEvent[] = []
  forEachSystemMessageSegment(content, (head) => {
    const ev = parseSystemSegmentEvent(head, activeIds)
    if (ev) events.push(ev)
  })
  return events
}

export function applyTranscriptStepToBgTasks(
  state: MutableBackgroundTaskState,
  step: Record<string, unknown>,
): boolean {
  let sawRestart = false
  for (const ev of extractBgStepEvents(step, state.active)) {
    if (ev.kind === 'restart') {
      retireAllBgTasks(state)
      sawRestart = true
    } else if (ev.kind === 'start') {
      markBgTaskRunning(state, ev.id, ev.description)
    } else {
      retireBgTask(state, ev.id)
    }
  }
  return sawRestart
}

function applyReverseEvents(
  events: readonly BgStepEvent[],
  terminatedLater: Set<string>,
  live: Map<string, TrackedBackgroundTask>,
): 'ok' | 'restart' | 'limit' {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!
    if (ev.kind === 'restart') return 'restart'
    if (ev.kind === 'retire') {
      if (!terminatedLater.has(ev.id)) {
        if (terminatedLater.size >= MAX_REVERIFY_TERMINAL_IDS) return 'limit'
        terminatedLater.add(ev.id)
      }
    } else if (!terminatedLater.has(ev.id) && !live.has(ev.id) && live.size <= MAX_TRACKED_BG_TASKS) {
      live.set(ev.id, ev.description ? { id: ev.id, description: ev.description } : { id: ev.id })
    }
  }
  return 'ok'
}

function applyReconciledLiveTasks(
  state: MutableBackgroundTaskState,
  live: ReadonlyMap<string, TrackedBackgroundTask>,
): void {
  state.active.clear()
  let count = 0
  for (const [id, task] of live) {
    if (count >= MAX_TRACKED_BG_TASKS) break
    state.active.set(id, task)
    count += 1
  }
  state.overflowed = live.size > MAX_TRACKED_BG_TASKS
}

/**
 * Bounded reverse-pass verification triggered ONLY when capacity overflow occurred
 * and `active` drained to 0. Re-proves from the step sequence whether any overflowed
 * task remains alive since the last server restart (failing closed on truncation or limits).
 */
export function reconcileOverflowBgTasksFromSteps(
  state: MutableBackgroundTaskState,
  steps: readonly Record<string, unknown>[],
  opts?: { truncatedStart?: boolean },
): boolean {
  if (!state.overflowed || state.active.size > 0) return false
  const terminatedLater = new Set<string>()
  const live = new Map<string, TrackedBackgroundTask>()
  let hitRestart = false
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const res = applyReverseEvents(extractBgStepEvents(steps[i]!), terminatedLater, live)
    if (res === 'limit') return false
    if (res === 'restart') {
      hitRestart = true
      break
    }
  }
  if (!hitRestart && opts?.truncatedStart) return false
  applyReconciledLiveTasks(state, live)
  return true
}

/**
 * Bounded reverse-pass verification directly over a transcript JSONL slice
 * `[bgResetByteOffset .. byteOffset]` for `IncrementalTranscriptTelemetryCache`.
 */
export function reconcileOverflowBgTasksFromJsonlBuffer(
  state: MutableBackgroundTaskState,
  rawText: string,
  opts?: { truncatedStart?: boolean },
): boolean {
  if (!state.overflowed || state.active.size > 0) return false
  const lines = rawText.split('\n')
  const terminatedLater = new Set<string>()
  const live = new Map<string, TrackedBackgroundTask>()
  let hitRestart = false
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]!.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return false
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const res = applyReverseEvents(
      extractBgStepEvents(parsed as Record<string, unknown>),
      terminatedLater,
      live,
    )
    if (res === 'limit') return false
    if (res === 'restart') {
      hitRestart = true
      break
    }
  }
  if (!hitRestart && opts?.truncatedStart) return false
  applyReconciledLiveTasks(state, live)
  return true
}

export function analyzeBackgroundTasksInSteps(
  steps: readonly Record<string, unknown>[],
  opts?: { truncatedStart?: boolean },
): BackgroundTaskState {
  const state = createBackgroundTaskState()
  for (const step of steps) applyTranscriptStepToBgTasks(state, step)
  if (state.overflowed && state.active.size === 0) {
    reconcileOverflowBgTasksFromSteps(state, steps, opts)
  }
  return state
}

export function extractGenericBgTaskStartId(step: Record<string, unknown>): string | null {
  if (strOf(step.type).toUpperCase() !== 'GENERIC') return null
  const st = strOf(step.status).toUpperCase()
  if (st !== 'RUNNING' && st !== 'ACTIVE') return null
  const content = typeof step.content === 'string' ? step.content : ''
  if (!content) return null
  const m = BG_TASK_START_RE.exec(stripGenericTimestampHeaders(content))
  return m?.[1] ? cleanBgTaskId(m[1]) : null
}

/**
 * Reconcile byte-0 incremental telemetry background-task state with the bounded
 * transcript tail so tasks started before the 256 KiB tail window stay tracked
 * and completions in the tail immediately retire them.
 */
export function mergeBackgroundTaskStates(
  tail: BackgroundTaskState,
  inc: BackgroundTaskTelemetrySummary | undefined,
  opts?: { tailTruncated?: boolean },
): MergedBackgroundTaskState {
  if (!inc) {
    return {
      activeIds: new Set(tail.active.keys()),
      overflowed: tail.overflowed,
      incompleteEvidence: tail.overflowed || (!tail.sawServerRestart && opts?.tailTruncated === true),
    }
  }
  if (tail.sawServerRestart) {
    return {
      activeIds: new Set(tail.active.keys()),
      overflowed: tail.overflowed,
      incompleteEvidence: tail.overflowed || inc.evidenceIncomplete === true,
    }
  }
  const retired = new Set<string>(inc.retiredIds)
  for (const id of tail.retired) retired.add(id)
  const activeIds = new Set<string>()
  for (const id of inc.activeIds) {
    if (!retired.has(id)) activeIds.add(id)
  }
  for (const id of tail.active.keys()) {
    if (!retired.has(id)) activeIds.add(id)
  }
  const overflowed = inc.overflowed || tail.overflowed
  return {
    activeIds,
    overflowed,
    incompleteEvidence: overflowed || inc.evidenceIncomplete === true,
  }
}
