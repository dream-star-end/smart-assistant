import { DELEGATE_TRACE_PATH } from '@openclaude/protocol'
import { request } from 'undici'

export type DelegateTraceInput = {
  sessionKey: string
  agentId: string
  delegateRunId: string
  parentTraceId?: string
  model?: string
}

/** No automatic retry: a lost response is explicitly unbound, never a guessed canonical. */
export async function mintDelegateTrace(
  input: DelegateTraceInput,
  deps: { env?: NodeJS.ProcessEnv; fetcher?: typeof request } = {},
): Promise<{ traceId: string; parentTraceId?: string } | null> {
  const env = deps.env ?? process.env
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim().replace(/\/+$/, '')
  const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !bearer) return null
  const response = await (deps.fetcher ?? request)(`${base}${DELEGATE_TRACE_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(3_000),
    headersTimeout: 3_000,
    bodyTimeout: 3_000,
  })
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const raw of response.body) {
    const chunk = Buffer.from(raw)
    bytes += chunk.length
    if (bytes > 8_192) {
      response.body.destroy()
      throw new Error('DELEGATE_TRACE_RESPONSE_SIZE')
    }
    chunks.push(chunk)
  }
  if (response.statusCode !== 200) throw new Error('DELEGATE_TRACE_UNAVAILABLE')
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!/^[0-9a-f]{32}$/.test(result.traceId) || result.parentTraceId !== input.parentTraceId) {
    throw new Error('DELEGATE_TRACE_INVALID_RESPONSE')
  }
  return { traceId: result.traceId, parentTraceId: input.parentTraceId }
}

// Pre-spawn trace waits must be stoppable without consuming capacity-queue slots.
const traceWaits = new WeakMap<object, Map<string, () => void>>()
export function registerDelegateTraceWait(host: object, sessionKey: string) {
  let aborted = false
  let waits = traceWaits.get(host)
  if (!waits) {
    waits = new Map()
    traceWaits.set(host, waits)
  }
  const abort = () => {
    aborted = true
  }
  waits.set(sessionKey, abort)
  return {
    isAborted: () => aborted,
    close: () => {
      if (waits.get(sessionKey) === abort) waits.delete(sessionKey)
    },
  }
}
export function cancelDelegateTraceWait(host: object, sessionKey: string): boolean {
  return captureDelegateTraceCancel(host,sessionKey)()
}
/** An awaited Stop retries this original waiter, never a replacement at its key. */
export function captureDelegateTraceCancel(host:object,sessionKey:string):()=>boolean {
  const abort = traceWaits.get(host)?.get(sessionKey)
  return ()=>{
    if (!abort) return false
    abort()
    return true
  }
}
