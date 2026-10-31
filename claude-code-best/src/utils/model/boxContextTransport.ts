import { createHash } from 'node:crypto'
import { clearTimeout as clearMemoTimer, setTimeout as setMemoTimer } from 'node:timers'
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk'
import { BOX_NATIVE_CONTEXT_MODELS } from './boxNativeRemoteContext.js'

// Requests admitted by the old 16 MiB envelope never need the new endpoint.
const START_BYTES = 16 * 1024 * 1024
const CHUNK_BYTES = 4 * 1024 * 1024
const MAX_CACHE = 16
const SNAPSHOT_MAX_UNITS = 20 * 1024 * 1024
const SNAPSHOT_MAX_MESSAGES = 4096
const SNAPSHOT_TTL_MS = 30_000
type MessageSnapshot = { messageBytes: number[]; suffixBytes: number[]; prefixDigests: string[] }
type SnapshotMemo = MessageSnapshot & {
  json: string; count: number; hash: ReturnType<typeof createHash>; createdAt: number
}
let snapshotMemo: SnapshotMemo | undefined
let snapshotTimer: ReturnType<typeof setMemoTimer> | undefined
const copySnapshot = (value: MessageSnapshot): MessageSnapshot => ({
  messageBytes: value.messageBytes.slice(), suffixBytes: value.suffixBytes.slice(),
  prefixDigests: value.prefixDigests.slice(),
})
function forgetSnapshot() {
  snapshotMemo = undefined
  if (snapshotTimer) clearMemoTimer(snapshotTimer)
  snapshotTimer = undefined
}

/** Input is this call's native JSON.stringify(messages), not arbitrary JSON.
 * Slice its exact canonical spans without decoding/re-encoding a large history;
 * array nulls and toJSON(key) are already reflected in these bytes. The wire
 * still carries the original message objects. */
export function boxContextMessageSnapshot(json: string, count: number): MessageSnapshot {
  const invalid = () => { throw new Error('完整资料传输校验未通过，文件和对话已保留。') }
  const now = performance.now()
  if (snapshotMemo && (now < snapshotMemo.createdAt || now - snapshotMemo.createdAt >= SNAPSHOT_TTL_MS)) forgetSnapshot()
  // Reuse pure derived bytes only after comparing this call's freshly produced
  // canonical JSON. Object identity never establishes an unchanged history.
  if (snapshotMemo && snapshotMemo.count === count && snapshotMemo.json === json) return copySnapshot(snapshotMemo)
  const prior = snapshotMemo && count > snapshotMemo.count && snapshotMemo.count > 0
    && json[snapshotMemo.json.length - 1] === ',' && json.startsWith(snapshotMemo.json.slice(0, -1))
    ? snapshotMemo : undefined
  if (json[0] !== '[' || json[json.length - 1] !== ']') invalid()
  const ends: number[] = []
  const tokens = /["\\[\]{},]/g
  let depth = prior ? 1 : 0
  let inString = false
  if (prior) tokens.lastIndex = prior.json.length
  for (let token = tokens.exec(json); token; token = tokens.exec(json)) {
    const char = token[0]
    if (inString) {
      if (char === '\\') tokens.lastIndex = token.index + 2
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '[' || char === '{') depth++
    else if (char === ']' || char === '}') {
      if (--depth < 0 || (depth === 0 && token.index !== json.length - 1)) invalid()
    } else if (char === ',' && depth === 1) ends.push(token.index)
  }
  if (inString || depth !== 0) invalid()
  if (json.length > 2) ends.push(json.length - 1)
  if (ends.length + (prior?.count ?? 0) !== count) {
    throw new Error('完整资料传输校验未通过，文件和对话已保留。')
  }
  const hash = prior ? prior.hash.copy() : createHash('sha256').update('[')
  const prefixDigests = prior ? prior.prefixDigests.slice() : [hash.copy().update(']').digest('hex')]
  const messageBytes: number[] = prior ? prior.messageBytes.slice() : []
  let start = prior ? prior.json.length : 1
  for (const end of ends) {
    if (end <= start) invalid()
    const encoded = json.slice(start, end)
    start = end + 1
    if (messageBytes.length) hash.update(',')
    hash.update(encoded)
    messageBytes.push(Buffer.byteLength(encoded, 'utf8'))
    prefixDigests.push(hash.copy().update(']').digest('hex'))
  }
  const suffixBytes = new Array<number>(count + 1)
  suffixBytes[count] = 2
  for (let index = count - 1; index >= 0; index--) {
    suffixBytes[index] = suffixBytes[index + 1]! + messageBytes[index]! + (index < count - 1 ? 1 : 0)
  }
  const value = { messageBytes, suffixBytes, prefixDigests }
  forgetSnapshot()
  // One entry, at most 40 MiB of UTF16 payload plus bounded derived arrays.
  // The SDK's independent reference cache still retains only small Ref records.
  if (json.length <= SNAPSHOT_MAX_UNITS && count <= SNAPSHOT_MAX_MESSAGES) {
    const memo = { ...copySnapshot(value), json, count, hash: hash.copy(), createdAt: now }
    snapshotMemo = memo
    snapshotTimer = setMemoTimer(() => {
      if (snapshotMemo === memo) forgetSnapshot()
    }, SNAPSHOT_TTL_MS)
    snapshotTimer.unref()
  }
  return value
}

type Params = {
  model: string
  messages: readonly unknown[]
  metadata?: unknown
  betas?: readonly string[]
  output_format?: unknown
  output_config?: unknown
}
type Wire<T> = T & { oc_context_transport?: { version: 1; reference: string } }
interface Client {
  baseURL: string
  post<R>(path: string, options: {
    body: unknown
    signal?: AbortSignal
    stream: false
    maxRetries: number
    timeout?: number
    headers?: Record<string, string>
  }): PromiseLike<R>
}
interface Ref {
  version: 1
  reference: string
  message_count: number
  messages_sha256: string
  expires_at: number
}
const refs = new Map<string, Ref>()

function cache(key: string, value: Ref) {
  refs.delete(key)
  refs.set(key, value)
  while (refs.size > MAX_CACHE) refs.delete(refs.keys().next().value!)
}

function referenceMiss(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { status?: unknown; error?: unknown }
  if (e.status !== 409 || !e.error || typeof e.error !== 'object') return false
  const raw = e.error as { code?: unknown; error?: { code?: unknown } }
  const code = raw.code ?? raw.error?.code
  return code === 'BOX_CONTEXT_REF_EXPIRED' || code === 'BOX_CONTEXT_REF_INVALID'
}

/** Match SDK beta.messages.create's wire body, without ever calling that paid
 * endpoint to stage data. The complete input params/transcript remain untouched. */
function stageBody<T extends Params>(params: T, messages: readonly unknown[], reference?: string) {
  const { betas: _betas, output_format: outputFormat, ...body } = params
  const oldConfig = body.output_config
  if (outputFormat && oldConfig && typeof oldConfig === 'object'
    && 'format' in oldConfig && oldConfig.format) {
    throw new Error('Both output_format and output_config.format were provided.')
  }
  return {
    ...body,
    ...(outputFormat !== undefined ? {
      output_config: { ...(oldConfig && typeof oldConfig === 'object' ? oldConfig : {}),
        format: outputFormat },
    } : {}),
    messages,
    stream: false,
    oc_context_transport: { version: 1, ...(reference ? { reference } : {}) },
  }
}

/** Only an explicit pre-dispatch missing-reference response is retried here.
 * A stream returned by send() has already started; its later errors are never
 * replayed by this function. */
export async function sendWithBoxContextTransport<T extends Params, R>(
  client: Client,
  params: T,
  signal: AbortSignal,
  send: (wire: Wire<T>, remainingTimeoutMs?: number) => PromiseLike<R>,
  options: { timeoutMs?: number } = {},
): Promise<R> {
  const started = performance.now()
  const stageDeadline = started + Math.min(120_000, options.timeoutMs ?? 120_000)
  const remaining = (deadline: number) => {
    const ms = Math.ceil(deadline - performance.now())
    if (ms <= 0) throw new APIConnectionTimeoutError()
    return ms
  }
  if (!BOX_NATIVE_CONTEXT_MODELS.includes(params.model)) return await send(params, options.timeoutMs)
  const fullMessages = JSON.stringify(params.messages)
  if (Buffer.byteLength(fullMessages, 'utf8') <= START_BYTES || params.messages.length < 2) {
    return await send(params, options.timeoutMs)
  }
  // Rebuilt on every call: in-place edits to old objects must invalidate refs.
  // An explicit reference repair can reuse this same invocation's snapshot.
  const snapshot = boxContextMessageSnapshot(fullMessages, params.messages.length)
  const key = JSON.stringify([client.baseURL, params.model, params.metadata ?? null])
  for (let repair = 0; ; repair++) {
    try {
      let ref = refs.get(key)
      const prefixEnd = params.messages.length - 1
      if (ref && (ref.expires_at <= Date.now()
        || ref.message_count > prefixEnd
        || snapshot.prefixDigests[ref.message_count] !== ref.messages_sha256)) {
        refs.delete(key)
        ref = undefined
      }
      let offset = ref?.message_count ?? 0
      const remainingBytes = snapshot.suffixBytes[offset]!
      // Reuse a previously complete prefix until the delta grows. Exact prefix
      // hashes deliberately miss if a caller changed any original byte.
      if (!ref || remainingBytes > CHUNK_BYTES) {
        while (offset < prefixEnd) {
          signal.throwIfAborted()
          let end = offset
          let bytes = 2
          while (end < prefixEnd) {
            const next = snapshot.messageBytes[end]! + 1
            if (end > offset && bytes + next > CHUNK_BYTES) break
            bytes += next
            end++
          }
          const expected = snapshot.prefixDigests[end]!
          const reply = await client.post<Ref>('/v1/messages/context', {
            body: stageBody(params, params.messages.slice(offset, end), ref?.reference),
            signal,
            stream: false,
            maxRetries: 0,
            timeout: remaining(stageDeadline),
            ...(params.betas?.length ? {
              headers: { 'anthropic-beta': params.betas.join(',') },
            } : {}),
          })
          if (reply.version !== 1 || !/^[a-f0-9]{64}$/.test(reply.reference)
            || reply.message_count !== end || reply.messages_sha256 !== expected
            || !Number.isSafeInteger(reply.expires_at) || reply.expires_at <= Date.now()) {
            throw new Error('完整资料传输校验未通过，文件和对话已保留。')
          }
          ref = reply
          cache(key, reply)
          offset = end
        }
      }
      if (!ref) throw new Error('完整资料暂未整理完成，文件和对话已保留。')
      signal.throwIfAborted()
      remaining(stageDeadline)
      return await send({
        ...params,
        messages: params.messages.slice(ref.message_count),
        oc_context_transport: { version: 1, reference: ref.reference },
      } as Wire<T>, options.timeoutMs === undefined
        ? undefined : remaining(started + options.timeoutMs))
    } catch (error) {
      if (repair === 0 && referenceMiss(error)) {
        refs.delete(key)
        continue
      }
      throw error
    }
  }
}
