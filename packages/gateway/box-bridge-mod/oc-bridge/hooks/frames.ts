/** Pure mapping from Mods hook payloads to the stream-json lines that
 * `claude -p --output-format=stream-json --include-partial-messages --verbose`
 * prints, i.e. what the gateway's ccbMessageParser already consumes on
 * Route B. No engine calls here, so the gateway's node tests import it too. */

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model?: string
}

export type StepChunk =
  | { kind: 'text'; index: number; text: string }
  | { kind: 'thinking'; index: number; text: string }
  | { kind: 'tool'; index: number; id: string; name: string }
  | { kind: 'input'; index: number; json: string }
  | { kind: 'stop'; stopReason: string | null; usage: Usage | null }
  | { kind: 'engine' }
  | { kind: string; [k: string]: unknown }

export type StepResultLike = {
  stopReason: string | null
  usage: Usage | null
}

export type RowLike = {
  door: string
  uuid: string
  agentId?: string
  /** session.append's `origin`: who caused the row (`{ kind: 'model', model }` on a response row). */
  origin?: { kind: string; model?: string }
  message: {
    type: 'user' | 'assistant' | 'attachment' | 'system'
    name?: string
    role?: 'user' | 'assistant'
    isMeta?: true
    content: unknown
  }
}

export type TurnCompleteLike = {
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  answer: string
  durationMs: number
  usage?: Usage
  agentId?: string
}

type Step = { msgId: string; model: string; open: Map<number, string> }

/** The block print mode has open: text/thinking stream, a tool_use is held until its row. */
type PrintBlock = { index: number; type: 'text' | 'thinking' | 'tool_use'; id?: string; name?: string
  held: Record<string, unknown>[] }

/** One main-loop step in print mode (OCV5-378): everything `-p` prints for it, collected until
 * its usage is known. */
export type PrintStep = {
  turnId: string
  index: number
  model: string
  chunks: StepChunk[]
  /** The step's response rows (session.append door `response`), in append order. */
  rows: RowLike[]
}

const ZERO: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** The CLI's stand-in for a response no request produced (an API error: a lost login, a usage limit, a
 * 4xx/5xx) comes in as a response row whose origin is model `<synthetic>` (CLI 2.1.312, 2026-10-29).
 * `-p` prints that record as model `<synthetic>` with `is_api_error_message`, and the hosts key on exactly
 * that (the Box model route's refusal and login health, Route B's login rotation). Printed under the
 * step's model it read as an answer without a stop reason. */
function isApiErrorRow(r: RowLike): boolean {
  return r.door === 'response' && r.origin?.kind === 'model' && r.origin.model === '<synthetic>'
}

function usageOf(u: Usage | null | undefined): Usage {
  if (!u) return { ...ZERO }
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
}

/** Text a plugin prompt can carry: text blocks joined, anything else
 * already turned into a file reference by the Box host. */
export function textOfUserContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n\n')
}

export class StreamJson {
  sessionId = ''
  model = ''
  cwd = ''
  version = ''
  permissionMode = 'default'
  plugins: string[] = []
  private uuidSeq = 0
  private steps = new Map<string, Step>()
  private mainSteps = 0
  /** Main-loop step usage this turn: the result's usage when the engine
   * reports none for the turn (an abort, an API error), so no paid step is
   * ever settled as free. */
  private turnUsage: Usage = { ...ZERO }
  /** subagent id -> the Agent tool_use id that started it */
  private parents = new Map<string, string>()
  private pendingAgentCalls: string[] = []

  private uuid(): string {
    this.uuidSeq += 1
    return `ocb-${this.sessionId.slice(0, 8)}-${Date.now().toString(36)}-${this.uuidSeq}`
  }

  private line(obj: Record<string, unknown>): string {
    return JSON.stringify(obj)
  }

  /** The main loop started an Agent call; the next unseen subagent is its. */
  noteAgentCall(toolUseId: string): void {
    this.pendingAgentCalls.push(toolUseId)
  }

  parentOf(agentId: string | undefined): string | null {
    if (!agentId) return null
    let parent = this.parents.get(agentId)
    if (!parent) {
      parent = this.pendingAgentCalls.shift()
      if (!parent) return null
      this.parents.set(agentId, parent)
    }
    return parent
  }

  init(): string {
    return this.line({
      type: 'system',
      subtype: 'init',
      cwd: this.cwd,
      session_id: this.sessionId,
      tools: [],
      mcp_servers: [],
      model: this.model,
      permissionMode: this.permissionMode,
      slash_commands: [],
      apiKeySource: 'none',
      claude_code_version: this.version,
      output_style: 'default',
      agents: [],
      skills: [],
      plugins: this.plugins.map((name) => ({ name })),
      oc_runner: 'interactive',
      uuid: this.uuid(),
    })
  }

  turnStart(): void {
    this.mainSteps = 0
    this.turnUsage = { ...ZERO }
  }

  private event(event: Record<string, unknown>, parent: string | null): string {
    return this.line({ type: 'stream_event', event, session_id: this.sessionId, parent_tool_use_id: parent, uuid: this.uuid() })
  }

  stepStart(input: { turnId: string; index: number; model: string; agentId?: string }): string[] {
    const key = input.agentId ?? ''
    const msgId = `msg_ocb_${input.turnId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}_${key ? `${key.slice(0, 8)}_` : ''}${input.index}`
    this.steps.set(key, { msgId, model: input.model, open: new Map() })
    if (!input.agentId) this.mainSteps += 1
    // Subagent steps stream nothing in -p either: only their rows, by parent.
    if (input.agentId) return []
    return [this.event({
      type: 'message_start',
      message: {
        id: msgId, type: 'message', role: 'assistant', model: input.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { ...ZERO },
      },
    }, null)]
  }

  chunk(agentId: string | undefined, c: StepChunk): string[] {
    if (agentId) return []
    const step = this.steps.get('')
    if (!step) return []
    const out: string[] = []
    const open = (index: number, block: Record<string, unknown>): void => {
      if (step.open.has(index)) return
      step.open.set(index, String(block.type))
      out.push(this.event({ type: 'content_block_start', index, content_block: block }, null))
    }
    switch (c.kind) {
      case 'text': {
        const t = c as { index: number; text: string }
        open(t.index, { type: 'text', text: '' })
        out.push(this.event({ type: 'content_block_delta', index: t.index, delta: { type: 'text_delta', text: t.text } }, null))
        break
      }
      case 'thinking': {
        const t = c as { index: number; text: string }
        open(t.index, { type: 'thinking', thinking: '', signature: '' })
        out.push(this.event({ type: 'content_block_delta', index: t.index, delta: { type: 'thinking_delta', thinking: t.text } }, null))
        break
      }
      case 'tool': {
        const t = c as { index: number; id: string; name: string }
        open(t.index, { type: 'tool_use', id: t.id, name: t.name, input: {} })
        break
      }
      case 'input': {
        const t = c as { index: number; json: string }
        out.push(this.event({ type: 'content_block_delta', index: t.index, delta: { type: 'input_json_delta', partial_json: t.json } }, null))
        break
      }
      default:
        break
    }
    return out
  }

  stepEnd(agentId: string | undefined, res: StepResultLike | undefined): string[] {
    const key = agentId ?? ''
    // Kept until the next step: the response's rows may land after its stop.
    const step = this.steps.get(key)
    if (agentId || !step) return []
    const used = usageOf(res?.usage)
    for (const k of Object.keys(used) as (keyof Usage)[]) {
      if (k !== 'model') (this.turnUsage[k] as number) += used[k] as number
    }
    const out: string[] = []
    for (const index of [...step.open.keys()].sort((a, b) => a - b)) {
      out.push(this.event({ type: 'content_block_stop', index }, null))
    }
    out.push(this.event({
      type: 'message_delta',
      delta: { stop_reason: res?.stopReason ?? null, stop_sequence: null },
      usage: usageOf(res?.usage),
    }, null))
    out.push(this.event({ type: 'message_stop' }, null))
    return out
  }

  /** Print mode (OCV5-378, the Box model route's `claude -p` contract), streamed as the step runs:
   * - `message_start` goes out when the step starts, so the client knows the model is working (its
   *   "engine starting" phase ends and an open thinking block reads as "thinking") exactly as on -p;
   * - text and thinking stream live; a block closes when its stored row arrives (the row carries the
   *   thinking signature and is the `assistant` line -p prints before `content_block_stop`); a later
   *   block's chunks wait until then, so the order is -p's order;
   * - a tool_use block is held until its row (its `content_block_start` carries the row's fields);
   * - the usage is known only at the stop chunk: `message_start` carries zero usage and `message_delta`
   *   the step's real usage (the Box model route's decoders read an all-zero start as "usage at stop"). */
  printStart(step: { turnId: string; index: number; model: string }): string[] {
    const msgId = `msg_ocb_${step.turnId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}_${step.index}`
    this.steps.set('', { msgId, model: step.model, open: new Map() })
    this.mainSteps += 1
    this.printing = { msgId, model: step.model, current: null, queue: [] }
    return [this.event({
      type: 'message_start',
      message: { id: msgId, type: 'message', role: 'assistant', model: step.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { ...ZERO } },
    }, null)]
  }

  printChunk(c: StepChunk): string[] {
    const st = this.printing
    if (!st) return []
    if (st.queue.length > 0) {
      st.queue.push(c)
      return []
    }
    return this.printChunkNow(c)
  }

  private printChunkNow(c: StepChunk): string[] {
    const st = this.printing!
    const index = (c as { index?: unknown }).index
    if (typeof index !== 'number') return []
    const cur = st.current
    if (cur && cur.index !== index) {
      st.queue.push(c)
      return []
    }
    const out: string[] = []
    if (!cur) {
      if (c.kind === 'text') {
        st.current = { index, type: 'text', held: [] }
        out.push(this.event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, null))
      } else if (c.kind === 'thinking') {
        st.current = { index, type: 'thinking', held: [] }
        out.push(this.event({ type: 'content_block_start', index,
          content_block: { type: 'thinking', thinking: '', signature: '' } }, null))
      } else if (c.kind === 'tool') {
        const t = c as { id: string; name: string }
        st.current = { index, type: 'tool_use', id: t.id, name: t.name, held: [] }
        return out
      } else {
        return out
      }
    }
    const open = st.current!
    const text = (c as { text?: unknown }).text
    if (c.kind === 'text' && open.type === 'text' && typeof text === 'string') {
      out.push(this.event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, null))
    } else if (c.kind === 'thinking' && open.type === 'thinking' && typeof text === 'string') {
      out.push(this.event({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } }, null))
    } else if (c.kind === 'input' && open.type === 'tool_use') {
      open.held.push({ type: 'input_json_delta', partial_json: (c as { json: string }).json })
    }
    return out
  }

  /** A stored response row of the step: it closes the open block it belongs to. */
  printRow(r: RowLike): string[] {
    const st = this.printing
    const content = Array.isArray(r.message.content) ? r.message.content as Record<string, unknown>[] : []
    const first = content[0]
    if (!st) return [this.assistantLine(r, this.steps.get('')?.msgId ?? `msg_ocb_row_${r.uuid}`, this.model)]
    const cur = st.current
    if (!cur || !first || first.type !== cur.type || (cur.type === 'tool_use' && first.id !== cur.id)) {
      return [this.assistantLine(r, st.msgId, st.model)]
    }
    return [...this.closeBlock(cur, r, first), ...this.drain()]
  }

  /** The step's stop: close what is still open, then the real usage. */
  printStop(stop: StepResultLike): string[] {
    const st = this.printing
    if (!st) return []
    const out: string[] = []
    for (let guard = 0; guard < 256 && (st.current || st.queue.length > 0); guard++) {
      if (st.current) out.push(...this.closeBlock(st.current, null, null))
      out.push(...this.drain())
    }
    const used = usageOf(stop.usage)
    for (const k of Object.keys(used) as (keyof Usage)[]) {
      if (k !== 'model') (this.turnUsage[k] as number) += used[k] as number
    }
    out.push(this.event({
      type: 'message_delta',
      delta: { stop_reason: stop.stopReason ?? null, stop_sequence: null },
      usage: { input_tokens: used.input_tokens, cache_creation_input_tokens: used.cache_creation_input_tokens,
        cache_read_input_tokens: used.cache_read_input_tokens, output_tokens: used.output_tokens },
    }, null))
    out.push(this.event({ type: 'message_stop' }, null))
    this.printing = null
    return out
  }

  /** A whole step at once (chunks, then rows, then the stop): the same lines as streaming it. */
  printStep(step: PrintStep, stop: StepResultLike): string[] {
    const out = this.printStart(step)
    for (const c of step.chunks) out.push(...this.printChunk(c))
    for (const r of step.rows) out.push(...this.printRow(r))
    out.push(...this.printStop(stop))
    return out
  }

  private printing: { msgId: string; model: string; queue: StepChunk[]; current: PrintBlock | null } | null = null

  private closeBlock(cur: PrintBlock, r: RowLike | null, first: Record<string, unknown> | null): string[] {
    const st = this.printing!
    const out: string[] = []
    const index = cur.index
    if (cur.type === 'tool_use') {
      // Opens as the CLI stored it (e.g. `caller`), with the input still to stream.
      const opened = first ? { ...first, input: {} } : { type: 'tool_use', id: cur.id, name: cur.name, input: {} }
      out.push(this.event({ type: 'content_block_start', index, content_block: opened }, null))
      for (const delta of cur.held) out.push(this.event({ type: 'content_block_delta', index, delta }, null))
    }
    if (r && first) {
      if (cur.type === 'thinking' && typeof first.signature === 'string' && first.signature) {
        out.push(this.event({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: first.signature } }, null))
      }
      out.push(this.assistantLine(r, st.msgId, st.model))
    }
    out.push(this.event({ type: 'content_block_stop', index }, null))
    st.current = null
    return out
  }

  private drain(): string[] {
    const st = this.printing!
    const out: string[] = []
    while (st.queue.length > 0 && !(st.current && st.queue[0] && (st.queue[0] as { index?: unknown }).index !== st.current.index)) {
      out.push(...this.printChunkNow(st.queue.shift()!))
    }
    return out
  }

  private assistantLine(r: RowLike, msgId: string, model: string): string {
    const apiError = isApiErrorRow(r)
    return this.line({
      type: 'assistant',
      message: { id: msgId, type: 'message', role: 'assistant', model: apiError ? '<synthetic>' : model,
        content: r.message.content, stop_reason: null, stop_sequence: null, usage: { ...ZERO } },
      parent_tool_use_id: null, session_id: this.sessionId, uuid: r.uuid,
      ...(apiError ? { is_api_error_message: true } : {}),
    })
  }

  /** Print mode's init line: what `-p` reports for the session's tools and MCP servers
   * (the host derives both from the launch argv). */
  printInit(tools: string[], mcpServers: { name: string; status: string }[]): string {
    const line = JSON.parse(this.init()) as Record<string, unknown>
    line.tools = tools
    line.mcp_servers = mcpServers
    return JSON.stringify(line)
  }

  /** Durable rows become the `assistant` / `user` / `system` lines. */
  row(r: RowLike): string[] {
    const parent = this.parentOf(r.agentId)
    const m = r.message
    if (m.type === 'assistant' && r.door === 'response') {
      const step = this.steps.get(r.agentId ?? '')
      const apiError = isApiErrorRow(r)
      return [this.line({
        type: 'assistant',
        message: {
          id: step?.msgId ?? `msg_ocb_row_${r.uuid}`,
          type: 'message', role: 'assistant', model: apiError ? '<synthetic>' : step?.model ?? this.model,
          content: m.content, stop_reason: null, stop_sequence: null, usage: { ...ZERO },
        },
        parent_tool_use_id: parent,
        session_id: this.sessionId,
        uuid: r.uuid,
        ...(apiError ? { is_api_error_message: true } : {}),
      })]
    }
    if (m.type === 'user' && (r.door === 'tool-result' || r.door === 'tool-message')) {
      return [this.line({
        type: 'user',
        message: { role: 'user', content: m.content },
        parent_tool_use_id: parent,
        session_id: this.sessionId,
        uuid: r.uuid,
        ...(m.isMeta ? { isMeta: true } : {}),
      })]
    }
    if (m.type === 'system' && m.name === 'compact_boundary') {
      return [this.line({
        type: 'system', subtype: 'compact_boundary', session_id: this.sessionId, uuid: r.uuid,
        compact_metadata: { trigger: 'auto', pre_tokens: 0 },
      })]
    }
    return []
  }

  result(e: TurnCompleteLike, lastStopReason: string | null): string {
    const aborted = e.reason === 'aborted'
    const isError = aborted || e.reason === 'error'
    return this.line({
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      is_error: isError,
      duration_ms: e.durationMs,
      duration_api_ms: 0,
      num_turns: this.mainSteps,
      result: e.answer,
      stop_reason: aborted ? null : lastStopReason,
      session_id: this.sessionId,
      total_cost_usd: 0,
      usage: e.usage ? usageOf(e.usage) : { ...this.turnUsage },
      permission_denials: [],
      ...(aborted ? { terminal_reason: 'aborted_streaming' } : {}),
      ...(e.reason === 'error' ? { errors: [e.answer || 'turn ended on an API error'] } : {}),
      uuid: this.uuid(),
    })
  }

  /** The login's plan windows after a turn, as `-p` reports them (`rate_limit_event`), so the
   * route's login health reads interactive and `-p` turns alike. `windows` is
   * `$.session.usage().rateLimits`: [{ kind, percentUsed, resetsAt (ISO) }]. A window at
   * 100% or more is a rejection; the binding window gives the reset. Null when nothing usable. */
  rateLimits(windows: unknown): string | null {
    if (!Array.isArray(windows)) return null
    const unified: Record<string, { utilization: number; resetsAt: number }> = {}
    let top: { kind: string; utilization: number; resetsAt: number } | null = null
    for (const w of windows) {
      const kind = (w as { kind?: unknown })?.kind
      const pct = (w as { percentUsed?: unknown })?.percentUsed
      const at = Date.parse(String((w as { resetsAt?: unknown })?.resetsAt ?? ''))
      if (typeof kind !== 'string' || !/^[a-z0-9_]{1,40}$/.test(kind)) continue
      if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || !Number.isFinite(at)) continue
      const window = { utilization: pct / 100, resetsAt: Math.floor(at / 1000) }
      unified[kind] = window
      if (!top || window.utilization > top.utilization) top = { kind, ...window }
    }
    if (!top) return null
    return this.line({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: top.utilization >= 1 ? 'rejected' : 'allowed',
        resetsAt: top.resetsAt,
        rateLimitType: top.kind,
        utilization: top.utilization,
        unifiedWindows: unified,
      },
      session_id: this.sessionId,
      uuid: this.uuid(),
    })
  }

  canUseTool(requestId: string, tool: string, input: unknown, toolUseId: string | undefined): string {
    return this.line({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: tool, input: input ?? {}, tool_use_id: toolUseId, permission_suggestions: [] },
    })
  }

  controlSuccess(requestId: string): string {
    return this.line({ type: 'control_response', response: { subtype: 'success', request_id: requestId } })
  }

  controlError(requestId: string, error: string): string {
    return this.line({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })
  }
}
