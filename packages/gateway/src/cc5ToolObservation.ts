/** Observe only original authenticated host frames; partial tool deltas cannot authorize effects. */
import { EventEmitter } from 'node:events'
import { CC5_BRIDGE_MAX_FRAME_BYTES } from './cc5BridgePort.js'
import { CC5_FIXED_TOOL_NAME, type Cc5ObservedTool, type Cc5ToolRequest } from './cc5FixedTool.js'
import { CC5_NATIVE_TOOLS, cc5ToolInputSha256, validateCc5NativeToolInput } from './cc5NativeTool.js'

function rejectObservation(): never {
  throw new Error('CC5_ORIGINAL_TOOL_OBSERVATION_INVALID')
}
export class Cc5ToolObservation {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly events = new EventEmitter()
  private buffer = ''
  private ended = false
  private nativeId: string | undefined
  private readonly actual = new Map<string, Readonly<Cc5ObservedTool>>()
  private readonly seen = new Set<string>()
  private active = true
  constructor(private readonly operationId: string, private readonly options: { legacyFixedTool?: boolean } = {}) {}
  beginTurn(): void {
    if (this.ended || this.buffer) rejectObservation()
    this.actual.clear()
    this.active = true
  }
  endTurn(): void { this.active = false }
  get toolUseIds(): readonly string[] { return [...this.actual.keys()] }
  private inputHash(name: string, input: unknown): string {
    if (this.options.legacyFixedTool && name === CC5_FIXED_TOOL_NAME) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 1 || (input as { operationId?: unknown }).operationId !== this.operationId) rejectObservation()
      return this.operationId
    }
    if (!(CC5_NATIVE_TOOLS as readonly string[]).includes(name)) rejectObservation()
    validateCc5NativeToolInput(name, input)
    return cc5ToolInputSha256(input)
  }
  ingest(bytes: Uint8Array): void {
    if (this.ended) rejectObservation()
    const previous = this.actual.size
    try {
      this.buffer += this.decoder.decode(bytes, { stream: true })
      if (Buffer.byteLength(this.buffer) > CC5_BRIDGE_MAX_FRAME_BYTES) rejectObservation()
      let split: number
      while ((split = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, split)
        this.buffer = this.buffer.slice(split + 1)
        if (line.trim()) this.observe(JSON.parse(line))
      }
    } catch (error) {
      this.ended = true
      this.actual.clear()
      this.events.emit('ended')
      throw error
    }
    // No waiter is released until all complete rows in this ingest have passed.
    if (this.actual.size !== previous) this.events.emit('complete')
  }
  finish(): void {
    this.ended = true
    try {
      const tail = this.decoder.decode()
      if ((this.buffer + tail).trim()) rejectObservation()
    } finally {
      this.events.emit('ended')
    }
  }

  private observe(frame: unknown): void {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) rejectObservation()
    const value = frame as {
      type?: string
      session_id?: string
      parent_tool_use_id?: unknown
      message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: unknown }> }
    }
    if (value.session_id !== undefined) {
      if (
        !/^[a-f0-9-]{36}$/i.test(value.session_id) ||
        (this.nativeId && this.nativeId !== value.session_id)
      )
        rejectObservation()
    }
    if (value.type !== 'assistant' || !Array.isArray(value.message?.content)) {
      if (value.session_id) this.nativeId = value.session_id
      return
    }
    for (const block of value.message.content) {
      if (block.type !== 'tool_use') continue
      if (
        value.parent_tool_use_id != null ||
        !value.session_id ||
        !block.id ||
        !this.active ||
        typeof block.name !== 'string' ||
        typeof block.id !== 'string' || block.id.length > 65536
      )
        rejectObservation()
      const inputHash = this.inputHash(block.name, block.input)
      const observed = {
        nativeSessionId: value.session_id,
        toolUseId: block.id,
        name: block.name,
        input: structuredClone(block.input),
      }
      const previous = this.actual.get(block.id)
      if (previous) {
        if (previous.nativeSessionId !== observed.nativeSessionId || previous.name !== observed.name ||
          this.inputHash(previous.name, previous.input) !== inputHash) rejectObservation()
      } else {
        if (this.seen.has(block.id) || this.seen.size >= 10000 || this.options.legacyFixedTool && this.actual.size) rejectObservation()
        this.seen.add(block.id)
        this.actual.set(block.id, Object.freeze(observed))
      }
    }
    if (value.session_id) this.nativeId = value.session_id
  }
  waitFor(
    request: Pick<Cc5ToolRequest, 'nativeSessionId' | 'toolUseId' | 'name' | 'arguments'>,
    signal?: AbortSignal,
    timeoutMs = 10000,
  ): Promise<Cc5ObservedTool> {
    const expected = structuredClone(request)
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        this.events.removeListener('complete', check)
        this.events.removeListener('ended', closed)
        signal?.removeEventListener('abort', closed)
      }
      const closed = (): void => {
        cleanup()
        reject(new Error('CC5_ORIGINAL_TOOL_NOT_OBSERVED'))
      }
      const check = (): void => {
        if (signal?.aborted || this.ended) {
          closed()
          return
        }
        const actual = this.actual.get(expected.toolUseId)
        if (!actual && !(this.options.legacyFixedTool && this.actual.size)) return
        cleanup()
        let matches = false
        try { matches = !!actual && expected.nativeSessionId === actual.nativeSessionId &&
          expected.name === actual.name && this.inputHash(expected.name, expected.arguments) === this.inputHash(actual.name, actual.input) }
        catch { /* Invalid arguments are never an observation. */ }
        if (!matches) {
          reject(new Error('CC5_ORIGINAL_TOOL_SCOPE_MISMATCH'))
        } else resolve(structuredClone(actual!))
      }
      this.events.on('complete', check)
      this.events.once('ended', closed)
      signal?.addEventListener('abort', closed, { once: true })
      const timer = setTimeout(closed, timeoutMs)
      check()
    })
  }
  get nativeSessionId(): string | undefined {
    return this.nativeId
  }
}
