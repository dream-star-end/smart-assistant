/** Observe only original authenticated host frames; partial tool deltas cannot authorize effects. */
import { EventEmitter } from 'node:events'
import { CC5_BRIDGE_MAX_FRAME_BYTES } from './cc5BridgePort.js'
import { CC5_FIXED_TOOL_NAME, type Cc5ObservedTool, type Cc5ToolRequest } from './cc5FixedTool.js'

function rejectObservation(): never {
  throw new Error('CC5_ORIGINAL_TOOL_OBSERVATION_INVALID')
}
export class Cc5ToolObservation {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly events = new EventEmitter()
  private buffer = ''
  private ended = false
  private nativeId: string | undefined
  private actual: Readonly<Cc5ObservedTool> | undefined
  constructor(private readonly operationId: string) {}
  ingest(bytes: Uint8Array): void {
    if (this.ended) rejectObservation()
    this.buffer += this.decoder.decode(bytes, { stream: true })
    if (Buffer.byteLength(this.buffer) > CC5_BRIDGE_MAX_FRAME_BYTES) rejectObservation()
    let split: number
    while ((split = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, split)
      this.buffer = this.buffer.slice(split + 1)
      if (line.trim()) this.observe(JSON.parse(line))
    }
  }
  finish(): void {
    this.ended = true
    const tail = this.decoder.decode()
    if ((this.buffer + tail).trim()) rejectObservation()
    this.events.emit('ended')
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
      this.nativeId = value.session_id
    }
    if (value.type !== 'assistant' || !Array.isArray(value.message?.content)) return
    for (const block of value.message.content) {
      if (block.type !== 'tool_use') continue
      if (
        value.parent_tool_use_id != null ||
        !value.session_id ||
        !block.id ||
        block.name !== CC5_FIXED_TOOL_NAME ||
        typeof block.id !== 'string'
      )
        rejectObservation()
      const input = block.input as { operationId?: unknown } | null
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        input.operationId !== this.operationId
      )
        rejectObservation()
      const observed = {
        nativeSessionId: value.session_id,
        toolUseId: block.id,
        name: block.name,
        input: { operationId: this.operationId },
      }
      if (this.actual && JSON.stringify(this.actual) !== JSON.stringify(observed))
        rejectObservation()
      this.actual = Object.freeze(observed)
      this.events.emit('complete')
    }
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
        if (!this.actual) return
        cleanup()
        const args = expected.arguments as { operationId?: unknown } | null
        if (
          expected.nativeSessionId !== this.actual.nativeSessionId ||
          expected.toolUseId !== this.actual.toolUseId ||
          expected.name !== this.actual.name ||
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Object.keys(args).length !== 1 ||
          args.operationId !== this.operationId
        ) {
          reject(new Error('CC5_ORIGINAL_TOOL_SCOPE_MISMATCH'))
        } else resolve(structuredClone(this.actual))
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
