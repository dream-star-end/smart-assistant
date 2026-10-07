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

const ZERO: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

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

  /** Durable rows become the `assistant` / `user` / `system` lines. */
  row(r: RowLike): string[] {
    const parent = this.parentOf(r.agentId)
    const m = r.message
    if (m.type === 'assistant' && r.door === 'response') {
      const step = this.steps.get(r.agentId ?? '')
      return [this.line({
        type: 'assistant',
        message: {
          id: step?.msgId ?? `msg_ocb_row_${r.uuid}`,
          type: 'message', role: 'assistant', model: step?.model ?? this.model,
          content: m.content, stop_reason: null, stop_sequence: null, usage: { ...ZERO },
        },
        parent_tool_use_id: parent,
        session_id: this.sessionId,
        uuid: r.uuid,
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
      usage: usageOf(e.usage),
      permission_denials: [],
      ...(aborted ? { terminal_reason: 'aborted_streaming' } : {}),
      ...(e.reason === 'error' ? { errors: [e.answer || 'turn ended on an API error'] } : {}),
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
