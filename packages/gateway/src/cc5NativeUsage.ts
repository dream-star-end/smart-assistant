/** Parse only the pinned original host's NDJSON; assistant prose is never a usage source. */
import { createHash } from 'node:crypto'
import { BOX_API_MODELS, CC5_NATIVE_MODEL } from '@openclaude/protocol'
import { CC5_BRIDGE_MAX_FRAME_BYTES, type Cc5BridgeBinding, assertCc5BindingScope } from './cc5BridgePort.js'
import type { Cc5NativeTerminalReceipt } from './cc5Finance.js'

export interface Cc5NativeOutputFrame {
  readonly bytes: Buffer
  readonly receipt?: Cc5NativeTerminalReceipt
}
function requireUsage(value: unknown): asserts value {
  if (!value) throw new Error('CC5_NATIVE_USAGE_UNPROVEN')
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
export const CC5_NATIVE_UPSTREAM_MODEL = BOX_API_MODELS.find((row) => row.id === CC5_NATIVE_MODEL)!.upstreamModel

export class Cc5NativeUsageObserver {
  private buffer = Buffer.alloc(0)
  private nativeSessionId?: string
  private upstreamModel?: string
  private terminalSeen = false
  private failed = false
  private finished = false
  constructor(private readonly binding: Readonly<Cc5BridgeBinding>) {
    assertCc5BindingScope(binding)
  }
  ingest(chunk: Buffer): Cc5NativeOutputFrame[] {
    requireUsage(!this.failed && !this.finished)
    try {
      this.buffer = Buffer.concat([this.buffer, chunk])
      const frames: Cc5NativeOutputFrame[] = []
      let at: number
      while ((at = this.buffer.indexOf(10)) >= 0) {
        requireUsage(at <= CC5_BRIDGE_MAX_FRAME_BYTES)
        const bytes = Buffer.from(this.buffer.subarray(0, at + 1))
        this.buffer = this.buffer.subarray(at + 1)
        frames.push(this.observe(bytes))
      }
      requireUsage(this.buffer.length <= CC5_BRIDGE_MAX_FRAME_BYTES)
      return frames
    } catch (error) {
      this.failed = true
      throw error
    }
  }
  finish(): void {
    this.finished = true
    requireUsage(!this.failed && this.buffer.length === 0)
  }
  private observe(bytes: Buffer): Cc5NativeOutputFrame {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text.trim()) return { bytes }
    const row = JSON.parse(text)
    requireUsage(row && typeof row === 'object' && !Array.isArray(row))
    requireUsage(!this.terminalSeen || row.type === 'rate_limit_event')
    if (row.session_id !== undefined) {
      requireUsage(typeof row.session_id === 'string' && UUID.test(row.session_id) &&
        (!this.nativeSessionId || this.nativeSessionId === row.session_id))
      this.nativeSessionId = row.session_id
    }
    const model = row.type === 'assistant' ? row.message?.model
      : row.type === 'system' && row.subtype === 'init' ? row.model
      : row.type === 'stream_event' && row.event?.type === 'message_start'
        ? row.event.message?.model : undefined
    if (model !== undefined) {
      // Synthetic API-error rows carry no model evidence. A prior init/step still must pin it.
      if (model !== '<synthetic>') {
        requireUsage(model === CC5_NATIVE_UPSTREAM_MODEL &&
          (!this.upstreamModel || this.upstreamModel === model))
        this.upstreamModel = model
      }
    }
    if (row.type !== 'result') return { bytes }
    requireUsage(!this.terminalSeen && this.nativeSessionId && row.session_id === this.nativeSessionId &&
      this.upstreamModel === CC5_NATIVE_UPSTREAM_MODEL && typeof row.is_error === 'boolean' &&
      (row.is_error ? row.subtype === 'error_during_execution' : row.subtype === 'success') &&
      row.usage && typeof row.usage === 'object' && !Array.isArray(row.usage))
    const keys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const
    for (const key of keys) requireUsage(Number.isSafeInteger(row.usage[key]) && row.usage[key] >= 0)
    this.terminalSeen = true
    const receipt: Cc5NativeTerminalReceipt = Object.freeze({
      version: 1, backendKind: this.binding.backendKind,
      uid: this.binding.uid, containerDbId: this.binding.containerDbId, dockerId: this.binding.dockerId,
      operationId: this.binding.operationId, runId: this.binding.runId, sessionKey: this.binding.sessionKey,
      nativeSessionId: this.nativeSessionId, canonicalModel: this.binding.canonicalModel,
      upstreamModel: this.upstreamModel, status: row.is_error ? 'error' : 'success',
      resultSha256: createHash('sha256').update(bytes).digest('hex'),
      usage: Object.freeze({ inputTokens: row.usage.input_tokens, outputTokens: row.usage.output_tokens,
        cacheReadTokens: row.usage.cache_read_input_tokens, cacheWriteTokens: row.usage.cache_creation_input_tokens }),
    })
    return { bytes, receipt }
  }
}
