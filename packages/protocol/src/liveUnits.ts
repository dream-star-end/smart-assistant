/**
 * In-flight live-journal tail-unit hydrate.
 *
 * Frames are incremental deltas. This module folds them into complete
 * renderable units (B2: never treat a raw tail page as a snapshot), then
 * shapes a first pack for the browser (K-window + byte budget are serving-only;
 * reduce state always keeps every child and full payloads).
 */

export const LIVE_UNITS_REDUCER_EPOCH = '2'
export const LIVE_UNITS_DEFAULT_N = 20
export const LIVE_UNITS_MAX_N = 80
export const LIVE_UNITS_DEFAULT_K = 20
export const LIVE_UNITS_BLOCK_PREVIEW_MAX = 64 * 1024
export const LIVE_UNITS_FIRST_PACK_MAX_BYTES = 512 * 1024
/** Hard cap for a single reduce pass. Exceeding this yields degraded=fallback
 * with no resume cursor (B1). Default 5s; 6.5k frames measured ~1s. */
export const LIVE_UNITS_REDUCE_DEADLINE_MS = 5_000
/**
 * Checkpoint stores the full fold (every child). Stub+payloadRef is only for
 * fields recoverable from a single frame (complete tool_result output / inputJson).
 * Cumulative thinking/text is stored in full. If the JSON still exceeds
 * LIVE_UNITS_CHECKPOINT_MAX_BYTES (UTF-8), skip the write (cache miss → live reduce).
 */
export const LIVE_UNITS_CHECKPOINT_PREVIEW_MAX = 256
export const LIVE_UNITS_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024

export type LiveUnitsDegraded = 'fallback'

export type LivePayloadRef = {
  recordId: string
  streamKey: string
  frameSeq: number
  sha256?: string
}

export type LiveChildBlock = {
  kind: string
  blockId?: string
  toolUseBlockId?: string
  toolName?: string
  text?: string
  inputPreview?: string
  inputJson?: unknown
  output?: string
  outputJson?: unknown
  preview?: string
  error?: boolean
  _completed?: boolean
  _partial?: boolean
  payloadRef?: LivePayloadRef
  [key: string]: unknown
}

export type LiveUnitKind = 'thinking' | 'text' | 'tool' | 'plan' | 'agent_group'

export type LiveUnit = {
  id: string
  kind: LiveUnitKind
  seqFirst: number
  seqLast: number
  recordIdFirst: string
  recordIdLast: string
  open: boolean
  clientMessageId: string | null
  sessionKey?: string
  /** Engine streaming identity (`block.messageId`). Hydration must reuse this. */
  messageId?: string
  text?: string
  toolName?: string
  blockId?: string
  inputJson?: unknown
  output?: string
  outputJson?: unknown
  preview?: string
  error?: boolean
  runId?: string
  agentId?: string
  goal?: string
  jobId?: string
  phase?: string
  completed?: boolean
  children?: LiveChildBlock[]
  nestedHasMoreBefore?: boolean
  nestedBeforeCursor?: string | null
  payloadRef?: LivePayloadRef
}

export type LiveFrameInput = {
  recordId: string
  streamKey: string
  clientMessageId: string | null
  payload: unknown
  payloadSha256?: string
}

export type LiveUnitState = {
  units: LiveUnit[]
  throughFrameSeq: number
  throughRecordId: string
  sessionKey?: string
  reducerEpoch: string
}

export type LiveUnitsResume = {
  sessionKey: string
  frameSeq: number
  recordId: string
}

export type LiveUnitsPage = {
  view: 'units'
  units: LiveUnit[]
  n: number
  hasMoreBefore: boolean
  beforeCursor: string | null
  streamClientMessageIds: string[]
  openDispatch: boolean
  hasTapeProjection: boolean
  tapeProjectionVersion: number
  reducerEpoch: string
  degraded: LiveUnitsDegraded | false
  resume?: LiveUnitsResume
  throughFrameSeq?: number
}

export type ReduceLiveFramesOptions = {
  deadlineMs?: number
  now?: () => number
}

export type ServeLiveUnitsOptions = {
  n?: number
  k?: number
  before?: string | null
  group?: string | null
  nestedBefore?: string | null
  maxBytes?: number
  previewMax?: number
}

type MutableChild = LiveChildBlock
type MutableUnit = LiveUnit & { children?: MutableChild[] }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function normalizeMcpServerName(raw: string): string {
  return raw.replace(/_/g, '-')
}

function parseMcpToolName(name?: string): { server: string; op: string } | null {
  if (!name || !name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const idx = rest.indexOf('__')
  if (idx < 0) return { server: normalizeMcpServerName(rest), op: '' }
  return { server: normalizeMcpServerName(rest.slice(0, idx)), op: rest.slice(idx + 2) }
}

function parseCodexTypeName(name?: string): string {
  if (!name) return ''
  if (name.startsWith('codex:') || name.startsWith('Codex:')) return name.slice(6)
  return ''
}

function goalKey(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim().slice(0, 1024)
}

/** Align with web reducer `parseDelegateToolInfo` (delegate_task + send_to_agent). */
function isDelegateGroupOp(op: string): boolean {
  return op === 'delegate_task' || op === 'send_to_agent'
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function mcpWrapperTexts(obj: Record<string, unknown>): string[] {
  const result = obj.result && typeof obj.result === 'object' && !Array.isArray(obj.result)
    ? (obj.result as Record<string, unknown>)
    : null
  const content = Array.isArray(result?.content) ? result.content : []
  return content
    .map((part) =>
      part && typeof part === 'object' ? str((part as Record<string, unknown>).text) : '',
    )
    .filter(Boolean)
}

function isRunningStatusPayload(raw: unknown): boolean {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : typeof raw === 'string'
        ? parseJsonRecord(raw.trim())
        : null
  if (!obj) return false
  if (obj.status === 'running') return true
  for (const text of mcpWrapperTexts(obj)) {
    const inner = parseJsonRecord(text)
    if (inner?.status === 'running') return true
  }
  return false
}

function runningToolJobId(block: Record<string, unknown>): string {
  for (const raw of [block.outputJson, block.output]) {
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : typeof raw === 'string' ? parseJsonRecord(raw.trim()) : null
    if (!obj) continue
    if (typeof obj.jobId === 'string') return obj.jobId
    for (const text of mcpWrapperTexts(obj)) {
      const inner = parseJsonRecord(text)
      if (typeof inner?.jobId === 'string') return inner.jobId
    }
  }
  return ''
}

function isRunningToolResult(block: Record<string, unknown>): boolean {
  return isRunningStatusPayload(block.outputJson) || isRunningStatusPayload(block.output)
}

function parseDelegateToolInfo(
  toolName: string,
  inputJson: unknown,
  inputPreview: string,
): { agentId: string; goalRaw: string } | null {
  const name = toolName || ''
  const input = parseJsonObject(inputJson) ?? parseJsonObject(inputPreview) ?? {}
  const fromArgs = (args: Record<string, unknown>) => ({
    agentId: str(args.agentId) || 'main',
    goalRaw: str(args.goal) || str(args.message),
  })
  const mcp = parseMcpToolName(name)
  if (mcp?.server === 'openclaude-memory' && isDelegateGroupOp(mcp.op)) return fromArgs(input)
  if (/(?:^|_)(delegate_task|send_to_agent)$/.test(name) && parseCodexTypeName(name) !== 'mcpToolCall') {
    return fromArgs(input)
  }
  if (parseCodexTypeName(name) !== 'mcpToolCall') return null
  const server = normalizeMcpServerName(str(input.server) || str(input.serverName))
  const op = str(input.tool) || str(input.toolName) || str(input.name)
  if (server !== 'openclaude-memory' || !isDelegateGroupOp(op)) return null
  const rawArgs = input.arguments ?? input.args ?? input.params
  return fromArgs(parseJsonObject(rawArgs) ?? {})
}

function bindDelegateRunToGroup(
  units: MutableUnit[],
  block: Record<string, unknown>,
  runId: string,
): MutableUnit | null {
  const jobId = str(block.jobId)
  if (jobId) {
    const exact = units.filter((u) => u.kind === 'agent_group' && !u.runId && u.jobId === jobId)
    if (exact.length === 1) {
      exact[0]!.runId = runId
      return exact[0]!
    }
  }
  const agentId = str(block.agentId)
  const goal = goalKey(str(block.goal))
  if (!agentId || !goal) return null
  const candidates = units.filter((u) =>
    u.kind === 'agent_group' &&
    !u.runId &&
    (u.agentId || '') === agentId &&
    goalKey(u.goal || '') === goal,
  )
  if (candidates.length !== 1) return null
  const unit = candidates[0]!
  unit.runId = runId
  return unit
}

function utf8Bytes(text: string): number {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8')
  return new TextEncoder().encode(text).length
}

function jsonSize(value: unknown): number {
  try {
    return utf8Bytes(JSON.stringify(value) ?? '')
  } catch {
    return 0
  }
}

function previewText(value: unknown, max: number): string {
  const raw = typeof value === 'string' ? value : (() => {
    try { return JSON.stringify(value) ?? '' } catch { return '' }
  })()
  if (raw.length <= max) return raw
  return raw.slice(0, max)
}

function frameMeta(frame: LiveFrameInput): {
  seq: number
  sessionKey?: string
  type: string
  blocks: Record<string, unknown>[]
  ref: LivePayloadRef
} {
  const payload = asRecord(frame.payload) ?? {}
  const seq = num(payload.frameSeq) ?? 0
  const blocksRaw = payload.blocks
  const blocks = Array.isArray(blocksRaw)
    ? blocksRaw.map((b) => asRecord(b) ?? {}).filter((b) => Object.keys(b).length > 0)
    : []
  return {
    seq,
    sessionKey: str(payload.sessionKey) || undefined,
    type: str(payload.type),
    blocks,
    ref: {
      recordId: frame.recordId,
      streamKey: frame.streamKey,
      frameSeq: seq,
      ...(frame.payloadSha256 ? { sha256: frame.payloadSha256 } : {}),
    },
  }
}

function unitId(kind: LiveUnitKind, key: string, seqFirst: number): string {
  return `${kind}:${seqFirst}:${key}`
}

function appendSubagentBlock(children: MutableChild[], block: Record<string, unknown>, ref: LivePayloadRef): void {
  const kind = str(block.kind) || 'text'
  const text = str(block.text)
  if (kind === 'text' || kind === 'thinking') {
    if (!text) return
    const last = children[children.length - 1]
    if (last && last.kind === kind) {
      last.text = (last.text || '') + text
      last.payloadRef = ref
    } else {
      children.push({ kind, text, payloadRef: ref })
    }
    return
  }
  if (kind === 'tool_use') {
    const blockId = str(block.blockId) || undefined
    const existing = blockId
      ? children.find((c) => c.kind === 'tool_use' && c.blockId === blockId)
      : undefined
    if (existing) {
      if (str(block.inputPreview)) existing.inputPreview = str(block.inputPreview)
      if (block.inputJson !== undefined && block.inputJson !== null) existing.inputJson = block.inputJson
      if (str(block.toolName)) existing.toolName = str(block.toolName)
      existing._partial = !!block.partial
      existing.payloadRef = ref
    } else {
      children.push({
        kind: 'tool_use',
        blockId,
        toolName: str(block.toolName) || 'unknown',
        inputPreview: str(block.inputPreview),
        inputJson: block.inputJson ?? null,
        _partial: !!block.partial,
        _completed: false,
        output: '',
        error: false,
        payloadRef: ref,
      })
    }
    return
  }
  if (kind === 'tool_result') {
    const toolUseId =
      str(block.toolUseBlockId) ||
      (str(block.blockId) ? str(block.blockId).replace(/:result$/, '') : '')
    const target = toolUseId
      ? children.find((c) => c.kind === 'tool_use' && c.blockId === toolUseId)
      : undefined
    const output = str(block.output) || str(block.preview)
    if (target) {
      target._completed = true
      target.output = output
      if (block.outputJson !== undefined) target.outputJson = block.outputJson
      target.error = !!block.isError
      target._partial = false
      target.payloadRef = ref
    } else {
      children.push({
        kind: 'tool_use',
        blockId: toolUseId || str(block.blockId) || undefined,
        toolName: str(block.toolName) || 'unknown',
        inputPreview: '',
        inputJson: null,
        _partial: false,
        _completed: true,
        output,
        ...(block.outputJson !== undefined ? { outputJson: block.outputJson } : {}),
        error: !!block.isError,
        payloadRef: ref,
      })
    }
    return
  }
  children.push({ ...block, kind, payloadRef: ref })
}

function applyDelegatePhase(unit: MutableUnit, block: Record<string, unknown>, ref: LivePayloadRef): void {
  const phase = str(block.phase)
  unit.phase = phase || unit.phase
  if (str(block.agentId)) unit.agentId = str(block.agentId)
  if (str(block.goal) && !unit.goal) unit.goal = str(block.goal)
  if (!unit.children) unit.children = []
  if (phase === 'done' || phase === 'error') {
    unit.completed = true
    unit.open = false
    const text = str(block.text)
    if (text && !unit.text) unit.text = text
    if (phase === 'error') unit.error = true
    unit.seqLast = ref.frameSeq
    unit.recordIdLast = ref.recordId
    return
  }
  const nested = asRecord(block.block)
  if (nested) {
    appendSubagentBlock(unit.children, nested, ref)
  } else {
    const text = str(block.text)
    if (phase === 'thinking' && text) appendSubagentBlock(unit.children, { kind: 'thinking', text }, ref)
    else if (phase === 'text' && text) appendSubagentBlock(unit.children, { kind: 'text', text }, ref)
    else if (text && phase !== 'start' && phase !== 'usage') {
      appendSubagentBlock(unit.children, { kind: 'text', text: `[${phase || 'progress'}] ${text}` }, ref)
    }
  }
  unit.open = !unit.completed
  unit.seqLast = ref.frameSeq
  unit.recordIdLast = ref.recordId
}

function seedReduceMaps(units: MutableUnit[]): {
  openThinking: Map<string, MutableUnit>
  tools: Map<string, MutableUnit>
  groups: Map<string, MutableUnit>
} {
  const openThinking = new Map<string, MutableUnit>()
  const tools = new Map<string, MutableUnit>()
  const groups = new Map<string, MutableUnit>()
  for (const unit of units) {
    if ((unit.kind === 'thinking' || unit.kind === 'text') && unit.open) {
      if (unit.messageId) openThinking.set(`${unit.kind}:${unit.messageId}`, unit)
      openThinking.set(`${unit.kind}:${unit.clientMessageId || 'default'}`, unit)
    }
    if ((unit.kind === 'tool' || unit.kind === 'agent_group') && unit.blockId) {
      tools.set(unit.blockId, unit)
    }
    if (unit.kind === 'agent_group' && unit.runId) groups.set(unit.runId, unit)
  }
  return { openThinking, tools, groups }
}

export function reduceLiveFrames(
  frames: LiveFrameInput[],
  opts: ReduceLiveFramesOptions = {},
): { ok: true; state: LiveUnitState } | { ok: false; degraded: LiveUnitsDegraded } {
  return reduceLiveFramesOnto({
    units: [],
    throughFrameSeq: 0,
    throughRecordId: '0',
    reducerEpoch: LIVE_UNITS_REDUCER_EPOCH,
  }, frames, opts)
}

function reduceLiveFramesOnto(
  seed: LiveUnitState,
  frames: LiveFrameInput[],
  opts: ReduceLiveFramesOptions = {},
): { ok: true; state: LiveUnitState } | { ok: false; degraded: LiveUnitsDegraded } {
  const deadlineMs = opts.deadlineMs ?? LIVE_UNITS_REDUCE_DEADLINE_MS
  const now = opts.now ?? Date.now
  const started = now()
  const units: MutableUnit[] = seed.units as MutableUnit[]
  const { openThinking, tools, groups } = seedReduceMaps(units)
  let throughFrameSeq = seed.throughFrameSeq
  let throughRecordId = seed.throughRecordId
  let sessionKey: string | undefined = seed.sessionKey

  for (let i = 0; i < frames.length; i++) {
    if (i > 0 && i % 250 === 0 && now() - started >= deadlineMs) {
      return { ok: false, degraded: 'fallback' }
    }
    const frame = frames[i]!
    const meta = frameMeta(frame)
    if (meta.seq > throughFrameSeq) throughFrameSeq = meta.seq
    throughRecordId = frame.recordId
    if (meta.sessionKey) sessionKey = meta.sessionKey
    if (meta.type !== 'outbound.message') continue
    const block = meta.blocks[0]
    if (!block) continue
    const kind = str(block.kind)
    const cmid = frame.clientMessageId

    if (kind === 'thinking' || kind === 'text') {
      const messageId = str(block.messageId) || undefined
      const key = `${kind}:${messageId || cmid || 'default'}`
      let unit = openThinking.get(key)
      const last = units[units.length - 1]
      if (!unit || unit !== last || unit.kind !== kind) {
        unit = {
          id: unitId(kind, key, meta.seq),
          kind,
          seqFirst: meta.seq,
          seqLast: meta.seq,
          recordIdFirst: frame.recordId,
          recordIdLast: frame.recordId,
          open: true,
          clientMessageId: cmid,
          sessionKey: meta.sessionKey,
          text: str(block.text),
          ...(messageId ? { messageId } : {}),
          payloadRef: meta.ref,
        }
        units.push(unit)
        openThinking.set(key, unit)
        if (cmid && messageId) openThinking.set(`${kind}:${cmid}`, unit)
      } else {
        unit.text = (unit.text || '') + str(block.text)
        unit.seqLast = meta.seq
        unit.recordIdLast = frame.recordId
        unit.payloadRef = meta.ref
        if (messageId && !unit.messageId) unit.messageId = messageId
      }
      continue
    }
    openThinking.clear()

    if (kind === 'tool_use') {
      const blockId = str(block.blockId) || `tool:${meta.seq}`
      const toolName = str(block.toolName) || 'unknown'
      const delegate = parseDelegateToolInfo(toolName, block.inputJson, str(block.inputPreview))
      if (delegate) {
        let unit = tools.get(blockId)
        if (!unit) {
          unit = {
            id: unitId('agent_group', blockId, meta.seq),
            kind: 'agent_group',
            seqFirst: meta.seq,
            seqLast: meta.seq,
            recordIdFirst: frame.recordId,
            recordIdLast: frame.recordId,
            open: true,
            clientMessageId: cmid,
            sessionKey: meta.sessionKey,
            blockId,
            toolName,
            agentId: delegate.agentId,
            goal: delegate.goalRaw,
            children: [],
            completed: false,
            payloadRef: meta.ref,
          }
          units.push(unit)
          tools.set(blockId, unit)
        } else {
          if (block.inputJson !== undefined && block.inputJson !== null) unit.inputJson = block.inputJson
          if (str(block.toolName)) unit.toolName = str(block.toolName)
          if (delegate.goalRaw && !unit.goal) unit.goal = delegate.goalRaw
          if (delegate.agentId && !unit.agentId) unit.agentId = delegate.agentId
          unit.seqLast = meta.seq
          unit.recordIdLast = frame.recordId
          unit.payloadRef = meta.ref
        }
        continue
      }
      let unit = tools.get(blockId)
      if (!unit) {
        unit = {
          id: unitId('tool', blockId, meta.seq),
          kind: 'tool',
          seqFirst: meta.seq,
          seqLast: meta.seq,
          recordIdFirst: frame.recordId,
          recordIdLast: frame.recordId,
          open: true,
          clientMessageId: cmid,
          sessionKey: meta.sessionKey,
          blockId,
          toolName,
          inputJson: block.inputJson ?? null,
          text: str(block.inputPreview),
          payloadRef: meta.ref,
        }
        units.push(unit)
        tools.set(blockId, unit)
      } else {
        if (block.inputJson !== undefined && block.inputJson !== null) unit.inputJson = block.inputJson
        if (str(block.toolName)) unit.toolName = str(block.toolName)
        unit.seqLast = meta.seq
        unit.recordIdLast = frame.recordId
        unit.payloadRef = meta.ref
      }
      continue
    }

    if (kind === 'tool_result') {
      const toolUseId =
        str(block.toolUseBlockId) ||
        (str(block.blockId) ? str(block.blockId).replace(/:result$/, '') : '') ||
        `tool:${meta.seq}`
      let unit = tools.get(toolUseId)
      if (!unit) {
        unit = {
          id: unitId('tool', toolUseId, meta.seq),
          kind: 'tool',
          seqFirst: meta.seq,
          seqLast: meta.seq,
          recordIdFirst: frame.recordId,
          recordIdLast: frame.recordId,
          open: false,
          clientMessageId: cmid,
          sessionKey: meta.sessionKey,
          blockId: toolUseId,
          toolName: str(block.toolName) || 'unknown',
          output: str(block.output) || str(block.preview),
          ...(block.outputJson !== undefined ? { outputJson: block.outputJson } : {}),
          error: !!block.isError,
          payloadRef: meta.ref,
        }
        units.push(unit)
        tools.set(toolUseId, unit)
      } else {
        unit.output = str(block.output) || str(block.preview) || unit.output
        if (block.outputJson !== undefined) unit.outputJson = block.outputJson
        unit.error = !!block.isError
        unit.seqLast = meta.seq
        unit.recordIdLast = frame.recordId
        unit.payloadRef = meta.ref
        if (unit.kind === 'agent_group' && isRunningToolResult(block)) {
          unit.open = true
          unit.completed = false
          const jobId = runningToolJobId(block)
          if (jobId) {
            unit.jobId = jobId
            const standaloneIndex = units.findIndex((candidate) =>
              candidate !== unit && candidate.kind === 'agent_group' &&
              candidate.jobId === jobId && typeof candidate.runId === 'string',
            )
            if (standaloneIndex >= 0) {
              const standalone = units[standaloneIndex]!
              unit.runId = standalone.runId
              unit.phase = standalone.phase
              unit.children = [...(standalone.children ?? []), ...(unit.children ?? [])]
              if (standalone.seqFirst < unit.seqFirst) {
                unit.seqFirst = standalone.seqFirst
                unit.recordIdFirst = standalone.recordIdFirst
              }
              groups.set(standalone.runId!, unit)
              units.splice(standaloneIndex, 1)
            }
          }
        } else {
          unit.open = false
          if (unit.kind === 'agent_group') unit.completed = true
        }
      }
      continue
    }

    if (kind === 'plan') {
      units.push({
        id: unitId('plan', str(block.blockId) || `plan:${meta.seq}`, meta.seq),
        kind: 'plan',
        seqFirst: meta.seq,
        seqLast: meta.seq,
        recordIdFirst: frame.recordId,
        recordIdLast: frame.recordId,
        open: false,
        clientMessageId: cmid,
        sessionKey: meta.sessionKey,
        text: str(block.text),
        payloadRef: meta.ref,
      })
      continue
    }

    if (kind === 'delegate_progress') {
      const runId = str(block.runId) || `run:${meta.seq}`
      let unit = groups.get(runId)
      if (!unit) {
        unit = bindDelegateRunToGroup(units, block, runId) ?? undefined
        if (unit) groups.set(runId, unit)
      }
      if (!unit) {
        unit = {
          id: unitId('agent_group', runId, meta.seq),
          kind: 'agent_group',
          seqFirst: meta.seq,
          seqLast: meta.seq,
          recordIdFirst: frame.recordId,
          recordIdLast: frame.recordId,
          open: true,
          clientMessageId: cmid,
          sessionKey: meta.sessionKey,
          runId,
          agentId: str(block.agentId),
          goal: str(block.goal),
          jobId: str(block.jobId) || undefined,
          phase: str(block.phase),
          children: [],
          completed: false,
        }
        units.push(unit)
        groups.set(runId, unit)
      }
      applyDelegatePhase(unit, block, meta.ref)
    }
  }

  if (now() - started >= deadlineMs) {
    return { ok: false, degraded: 'fallback' }
  }

  return {
    ok: true,
    state: {
      units,
      throughFrameSeq,
      throughRecordId,
      sessionKey,
      reducerEpoch: LIVE_UNITS_REDUCER_EPOCH,
    },
  }
}

function cloneUnit(unit: LiveUnit): LiveUnit {
  return {
    ...unit,
    children: unit.children?.map((child) => ({ ...child })),
  }
}

function parseBefore(cursor: string | null | undefined): number | null {
  if (!cursor) return null
  const match = /^u:(\d+)$/.exec(cursor)
  if (!match) return null
  return Number(match[1])
}

function fieldSize(unit: LiveUnit): number {
  return jsonSize(unit)
}

function truncateField(
  holder: { [key: string]: unknown },
  key: 'output' | 'outputJson' | 'inputJson' | 'text' | 'goal',
  previewMax: number,
): boolean {
  const value = holder[key]
  if (value === undefined || value === null) return false
  const size = jsonSize(value)
  if (size <= previewMax) return false
  holder.preview = previewText(value, previewMax)
  delete holder[key]
  return true
}

function applyPreviewToUnit(unit: LiveUnit, previewMax: number): boolean {
  let changed = false
  if (truncateField(unit as unknown as Record<string, unknown>, 'output', previewMax)) changed = true
  if (truncateField(unit as unknown as Record<string, unknown>, 'outputJson', previewMax)) changed = true
  if (truncateField(unit as unknown as Record<string, unknown>, 'inputJson', previewMax)) changed = true
  if (unit.kind !== 'thinking' && unit.kind !== 'text') {
    if (truncateField(unit as unknown as Record<string, unknown>, 'text', previewMax)) changed = true
  } else if ((unit.text || '').length > previewMax) {
    unit.preview = (unit.text || '').slice(0, previewMax)
    unit.text = (unit.text || '').slice(0, previewMax)
    changed = true
  }
  if (typeof unit.goal === 'string' && unit.goal.length > previewMax) {
    unit.goal = previewText(unit.goal, previewMax)
    changed = true
  }
  for (const child of unit.children ?? []) {
    if (truncateField(child as unknown as Record<string, unknown>, 'output', previewMax)) changed = true
    if (truncateField(child as unknown as Record<string, unknown>, 'outputJson', previewMax)) changed = true
    if (truncateField(child as unknown as Record<string, unknown>, 'inputJson', previewMax)) changed = true
  }
  return changed
}

/** Checkpoint stubs: single-source payloads only. Never truncate cumulative thinking/text. */
function applyCheckpointStubsToUnit(unit: LiveUnit, previewMax: number): void {
  if (unit.kind !== 'thinking' && unit.kind !== 'text') {
    truncateField(unit as unknown as Record<string, unknown>, 'output', previewMax)
    truncateField(unit as unknown as Record<string, unknown>, 'outputJson', previewMax)
    truncateField(unit as unknown as Record<string, unknown>, 'inputJson', previewMax)
    if (unit.kind === 'tool') {
      truncateField(unit as unknown as Record<string, unknown>, 'text', previewMax)
    }
  }
  for (const child of unit.children ?? []) {
    truncateField(child as unknown as Record<string, unknown>, 'output', previewMax)
    truncateField(child as unknown as Record<string, unknown>, 'outputJson', previewMax)
    truncateField(child as unknown as Record<string, unknown>, 'inputJson', previewMax)
  }
}

function selectFirstPack(units: LiveUnit[], n: number): { pack: LiveUnit[]; hasMoreBefore: boolean; beforeCursor: string | null } {
  const open = units.filter((u) => u.open && u.kind === 'agent_group')
  const tail = units.slice(Math.max(0, units.length - n))
  const seen = new Set<string>()
  const pack: LiveUnit[] = []
  for (const unit of [...tail, ...open]) {
    if (seen.has(unit.id)) continue
    seen.add(unit.id)
    pack.push(unit)
  }
  pack.sort((a, b) => a.seqFirst - b.seqFirst || a.id.localeCompare(b.id))
  // before 游标按 tail 窗口，不含被并入的更早 open 组卡，避免漏掉组卡与尾窗之间的单元。
  const tailMinSeq = tail[0]?.seqFirst
  const hasMoreBefore = typeof tailMinSeq === 'number' && units.some((u) => u.seqFirst < tailMinSeq)
  const beforeCursor = hasMoreBefore && typeof tailMinSeq === 'number' ? `u:${tailMinSeq}` : null
  return { pack, hasMoreBefore, beforeCursor }
}

function selectBeforePack(units: LiveUnit[], beforeSeq: number, n: number): {
  pack: LiveUnit[]
  hasMoreBefore: boolean
  beforeCursor: string | null
} {
  const older = units.filter((u) => u.seqFirst < beforeSeq && !(u.open && u.kind === 'agent_group'))
  const pack = older.slice(Math.max(0, older.length - n))
  const hasMoreBefore = older.length > pack.length
  const beforeCursor = hasMoreBefore && pack[0] ? `u:${pack[0].seqFirst}` : null
  return { pack, hasMoreBefore, beforeCursor }
}

function sliceGroupChildren(unit: LiveUnit, k: number): LiveUnit {
  const next = cloneUnit(unit)
  const children = next.children ?? []
  if (children.length <= k) {
    next.nestedHasMoreBefore = false
    next.nestedBeforeCursor = null
    return next
  }
  next.children = children.slice(children.length - k)
  next.nestedHasMoreBefore = true
  next.nestedBeforeCursor = `c:${children.length - k}`
  return next
}

function enforceBudget(pack: LiveUnit[], opts: {
  maxBytes: number
  previewMax: number
  k: number
  keepOpenChrome: boolean
}): { units: LiveUnit[]; droppedNonOpen: boolean; restMinSeq: number | null } {
  let k = opts.k
  let current = pack.map((u) => sliceGroupChildren(u, k))
  const over = () => jsonSize(current) > opts.maxBytes
  let droppedNonOpen = false

  const degradeLargestPayloads = (previewMax: number) => {
    let changed = false
    const scored = current
      .flatMap((unit, ui) => {
        const rows: Array<{ ui: number; ci: number | null; size: number }> = [
          { ui, ci: null, size: fieldSize(unit) },
        ]
        ;(unit.children ?? []).forEach((child, ci) => {
          rows.push({ ui, ci, size: jsonSize(child) })
        })
        return rows
      })
      .sort((a, b) => b.size - a.size)
    for (const row of scored) {
      if (!over()) break
      const unit = current[row.ui]!
      if (row.ci === null) {
        if (applyPreviewToUnit(unit, previewMax)) changed = true
      } else {
        const child = unit.children?.[row.ci]
        if (child) {
          const before = jsonSize(child)
          truncateField(child as unknown as Record<string, unknown>, 'output', previewMax)
          truncateField(child as unknown as Record<string, unknown>, 'outputJson', previewMax)
          truncateField(child as unknown as Record<string, unknown>, 'inputJson', previewMax)
          if (jsonSize(child) < before) changed = true
        }
      }
    }
    return changed
  }

  degradeLargestPayloads(opts.previewMax)
  while (over() && k > 1) {
    k = Math.max(1, Math.floor(k / 2))
    current = pack.map((u) => {
      const sliced = sliceGroupChildren(u, k)
      applyPreviewToUnit(sliced, opts.previewMax)
      return sliced
    })
  }
  if (over()) {
    const open = current.filter((u) => u.open && u.kind === 'agent_group')
    const rest = current.filter((u) => !(u.open && u.kind === 'agent_group'))
    while (over() && rest.length > 0) {
      rest.shift()
      droppedNonOpen = true
      current = [...rest, ...open].sort((a, b) => a.seqFirst - b.seqFirst || a.id.localeCompare(b.id))
    }
    if (over() && opts.keepOpenChrome) {
      current = open.map((u) => {
        const chrome = cloneUnit(u)
        chrome.children = []
        chrome.nestedHasMoreBefore = (u.children?.length ?? 0) > 0
        chrome.nestedBeforeCursor = u.nestedBeforeCursor ?? (chrome.nestedHasMoreBefore ? 'c:0' : null)
        applyPreviewToUnit(chrome, opts.previewMax)
        return chrome
      })
      let preview = opts.previewMax
      while (over() && preview > 256) {
        preview = Math.max(256, Math.floor(preview / 2))
        current = current.map((u) => {
          const copy = cloneUnit(u)
          applyPreviewToUnit(copy, preview)
          return copy
        })
      }
    }
  }
  const restNow = current.filter((u) => !(u.open && u.kind === 'agent_group'))
  const restMinSeq = restNow.length > 0 ? Math.min(...restNow.map((u) => u.seqFirst)) : null
  return { units: current, droppedNonOpen, restMinSeq }
}

export function serveLiveUnits(
  state: LiveUnitState,
  meta: {
    streamClientMessageIds: string[]
    openDispatch: boolean
    hasTapeProjection: boolean
    tapeProjectionVersion: number
  },
  opts: ServeLiveUnitsOptions = {},
): LiveUnitsPage {
  const n = Math.max(1, Math.min(LIVE_UNITS_MAX_N, opts.n ?? LIVE_UNITS_DEFAULT_N))
  const k = Math.max(1, Math.min(LIVE_UNITS_MAX_N, opts.k ?? LIVE_UNITS_DEFAULT_K))
  const maxBytes = opts.maxBytes ?? LIVE_UNITS_FIRST_PACK_MAX_BYTES
  const previewMax = opts.previewMax ?? LIVE_UNITS_BLOCK_PREVIEW_MAX
  const beforeSeq = parseBefore(opts.before)

  let selected: { pack: LiveUnit[]; hasMoreBefore: boolean; beforeCursor: string | null }
  if (opts.group) {
    const group = state.units.find((u) => u.kind === 'agent_group' && u.runId === opts.group)
    if (!group) {
      selected = { pack: [], hasMoreBefore: false, beforeCursor: null }
    } else {
      const children = group.children ?? []
      const nestedBefore = opts.nestedBefore && /^c:(\d+)$/.exec(opts.nestedBefore)
      const end = nestedBefore ? Number(nestedBefore[1]) : children.length
      const window = children.slice(Math.max(0, end - k), end)
      const pack = [{
        ...cloneUnit(group),
        children: window,
        nestedHasMoreBefore: end - k > 0,
        nestedBeforeCursor: end - k > 0 ? `c:${Math.max(0, end - k)}` : null,
      }]
      selected = { pack, hasMoreBefore: false, beforeCursor: null }
    }
  } else if (beforeSeq !== null) {
    selected = selectBeforePack(state.units, beforeSeq, n)
  } else {
    selected = selectFirstPack(state.units, n)
  }

  const unitBudget = Math.max(1024, maxBytes - 4096)
  const budgeted = opts.group
    ? {
      units: selected.pack.map((u) => {
        const copy = cloneUnit(u)
        applyPreviewToUnit(copy, previewMax)
        return copy
      }),
      droppedNonOpen: false,
      restMinSeq: null as number | null,
    }
    : enforceBudget(selected.pack, { maxBytes: unitBudget, previewMax, k, keepOpenChrome: true })

  let hasMoreBefore = selected.hasMoreBefore
  let beforeCursor = selected.beforeCursor
  if (budgeted.droppedNonOpen) {
    hasMoreBefore = true
    beforeCursor = budgeted.restMinSeq != null
      ? `u:${budgeted.restMinSeq}`
      : `u:${state.throughFrameSeq + 1}`
  }

  const resume: LiveUnitsResume | undefined = state.throughRecordId !== '0'
    ? {
      sessionKey: state.sessionKey || '',
      frameSeq: state.throughFrameSeq,
      recordId: state.throughRecordId,
    }
    : undefined

  const page: LiveUnitsPage = {
    view: 'units',
    units: budgeted.units,
    n,
    hasMoreBefore,
    beforeCursor,
    streamClientMessageIds: meta.streamClientMessageIds,
    openDispatch: meta.openDispatch,
    hasTapeProjection: meta.hasTapeProjection,
    tapeProjectionVersion: meta.tapeProjectionVersion,
    reducerEpoch: LIVE_UNITS_REDUCER_EPOCH,
    degraded: false,
    ...(resume ? { resume, throughFrameSeq: state.throughFrameSeq } : {}),
  }
  if (!opts.group && jsonSize(page) > maxBytes) {
    return fallbackLiveUnitsPage(meta)
  }
  return page
}

export function fallbackLiveUnitsPage(meta: {
  streamClientMessageIds: string[]
  openDispatch: boolean
  hasTapeProjection: boolean
  tapeProjectionVersion: number
}): LiveUnitsPage {
  return {
    view: 'units',
    units: [],
    n: LIVE_UNITS_DEFAULT_N,
    hasMoreBefore: false,
    beforeCursor: null,
    streamClientMessageIds: meta.streamClientMessageIds,
    openDispatch: meta.openDispatch,
    hasTapeProjection: meta.hasTapeProjection,
    tapeProjectionVersion: meta.tapeProjectionVersion,
    reducerEpoch: LIVE_UNITS_REDUCER_EPOCH,
    degraded: 'fallback',
  }
}

export function isLiveUnitsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OC_LIVE_FRAMES_UNITS
  if (raw === undefined || raw === '') return true
  return raw !== '0' && raw.toLowerCase() !== 'false'
}

export function continueReduceLiveFrames(
  state: LiveUnitState,
  frames: LiveFrameInput[],
  opts: ReduceLiveFramesOptions = {},
): { ok: true; state: LiveUnitState } | { ok: false; degraded: LiveUnitsDegraded } {
  return reduceLiveFramesOnto(cloneState(state), frames, opts)
}

function cloneState(state: LiveUnitState): LiveUnitState {
  return {
    units: state.units.map(cloneUnit),
    throughFrameSeq: state.throughFrameSeq,
    throughRecordId: state.throughRecordId,
    sessionKey: state.sessionKey,
    reducerEpoch: state.reducerEpoch,
  }
}

export function assembleLiveUnitsPage(
  frames: LiveFrameInput[],
  meta: {
    streamClientMessageIds: string[]
    openDispatch: boolean
    hasTapeProjection: boolean
    tapeProjectionVersion: number
  },
  opts: ReduceLiveFramesOptions & ServeLiveUnitsOptions = {},
  catchUpFrames: LiveFrameInput[] = [],
): LiveUnitsPage {
  const reduced = reduceLiveFrames(frames, opts)
  if (!reduced.ok) return fallbackLiveUnitsPage(meta)
  return assembleLiveUnitsFromState(reduced.state, meta, opts, catchUpFrames)
}

export function assembleLiveUnitsFromState(
  state: LiveUnitState,
  meta: {
    streamClientMessageIds: string[]
    openDispatch: boolean
    hasTapeProjection: boolean
    tapeProjectionVersion: number
  },
  opts: ReduceLiveFramesOptions & ServeLiveUnitsOptions = {},
  catchUpFrames: LiveFrameInput[] = [],
): LiveUnitsPage {
  if (catchUpFrames.length === 0) return serveLiveUnits(state, meta, opts)
  const continued = continueReduceLiveFrames(state, catchUpFrames, opts)
  if (!continued.ok) return fallbackLiveUnitsPage(meta)
  return serveLiveUnits(continued.state, meta, opts)
}

const UNIT_KINDS = new Set<LiveUnitKind>(['thinking', 'text', 'tool', 'plan', 'agent_group'])

/**
 * B2: keep every unit and every child. Serving-only K/N windows are NOT applied.
 * Single-source oversized fields become a short stub + payloadRef. Cumulative
 * thinking/text is stored in full. Returns null when UTF-8 JSON exceeds 8MB.
 */
export function foldLiveUnitStateForCheckpoint(
  state: LiveUnitState,
  opts: { previewMax?: number; maxBytes?: number } = {},
): { json: string; state: LiveUnitState } | null {
  const previewMax = opts.previewMax ?? LIVE_UNITS_CHECKPOINT_PREVIEW_MAX
  const maxBytes = opts.maxBytes ?? LIVE_UNITS_CHECKPOINT_MAX_BYTES
  const folded: LiveUnitState = {
    units: state.units.map((unit) => {
      const copy = cloneUnit(unit)
      applyCheckpointStubsToUnit(copy, previewMax)
      return copy
    }),
    throughFrameSeq: state.throughFrameSeq,
    throughRecordId: state.throughRecordId,
    sessionKey: state.sessionKey,
    reducerEpoch: state.reducerEpoch || LIVE_UNITS_REDUCER_EPOCH,
  }
  const json = JSON.stringify(folded)
  if (utf8Bytes(json) > maxBytes) return null
  return { json, state: folded }
}

export function parseLiveUnitCheckpoint(
  raw: unknown,
  expectedEpoch: string = LIVE_UNITS_REDUCER_EPOCH,
): LiveUnitState | null {
  if (raw == null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.reducerEpoch !== expectedEpoch) return null
  if (!Array.isArray(obj.units)) return null
  if (typeof obj.throughFrameSeq !== 'number' || !Number.isFinite(obj.throughFrameSeq)) return null
  if (typeof obj.throughRecordId !== 'string' || obj.throughRecordId.length === 0) return null
  const units: LiveUnit[] = []
  for (const item of obj.units) {
    if (!item || typeof item !== 'object') return null
    const unit = item as LiveUnit
    if (typeof unit.id !== 'string' || unit.id.length === 0) return null
    if (!UNIT_KINDS.has(unit.kind)) return null
    if (typeof unit.seqFirst !== 'number' || typeof unit.seqLast !== 'number') return null
    if (typeof unit.recordIdFirst !== 'string' || typeof unit.recordIdLast !== 'string') return null
    units.push({
      ...unit,
      children: Array.isArray(unit.children) ? unit.children.map((c) => ({ ...c })) : unit.children,
    })
  }
  return {
    units,
    throughFrameSeq: obj.throughFrameSeq,
    throughRecordId: obj.throughRecordId,
    sessionKey: typeof obj.sessionKey === 'string' ? obj.sessionKey : undefined,
    reducerEpoch: expectedEpoch,
  }
}

/** Resolve a truncated payload: live frame first, then tape by sha256 after prune. */
export type LiveOrTapePayloadSource = 'live' | 'tape'

export function choosePayloadRefSource(opts: {
  livePayload: unknown | null
  tapePayload: unknown | null
}): { source: LiveOrTapePayloadSource; payload: unknown } | null {
  if (opts.livePayload != null) return { source: 'live', payload: opts.livePayload }
  if (opts.tapePayload != null) return { source: 'tape', payload: opts.tapePayload }
  return null
}
