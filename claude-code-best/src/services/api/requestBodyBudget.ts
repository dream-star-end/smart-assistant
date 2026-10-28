import { createHash } from 'node:crypto'
import type { ContextObservation } from '../../../../packages/protocol/src/contextPressure.js'
import { contextBytePressure } from '../../../../packages/protocol/src/contextBytePressure.js'
import { writeContextReference } from '../../../../packages/gateway/src/engine/contextReference.js'

// Mirror the ordinary proxy envelope; the offline regression compares these
// with its authority. Box has its own transport/history owner and is bypassed.
export const CCB_REQUEST_BYTE_LIMITS = {
  body: 16 * 1024 * 1024,
  messages: 8 * 1024 * 1024,
  system: 2 * 1024 * 1024,
  tools: 2 * 1024 * 1024,
} as const
const OLD_ATTACHMENT_BYTES = 256 * 1024
const MAX_MESSAGES = 2000
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
type Json = Record<string, unknown>
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type Options = {
  cwd: string
  sessionId: string
  onEvent: (event: ContextObservation) => void
  signal?: AbortSignal | null
}

export class RequestBodyBudgetError extends Error {
  constructor() {
    super('request_too_large: request envelope cannot fit without losing active context')
  }
}

// Content keys include native session and workspace. Atomic content-addressed
// files survive process restart and avoid repeatedly copying the old history.
async function reference(opts: Options, content: string | Uint8Array, extension: string): Promise<string> {
  const key = createHash('sha256').update(opts.cwd).update('\0').update(opts.sessionId)
    .update('\0').update(extension).update('\0').update(content).digest('hex')
  return (await writeContextReference(opts.cwd, content, `content.${extension}`, key)).file
}

function refText(file: string, size: number, description: string): string {
  return `[Full ${description} preserved in workspace file ${JSON.stringify(file)} (${size} bytes). Use Read for images and paged Read for PDFs before relying on omitted details. This is a file reference, not a summary.]`
}

// Read paginates by lines, so an original long line or JSONL message may not
// fit even limit=1. Keep the raw original AND a lossless view of short JSON
// string fragments. Four lines are <=24.6KB even with worst-case escaping.
async function textReference(opts: Options, content: string, extension: string, description: string): Promise<string> {
  const file = await reference(opts, content, extension)
  const lines: string[] = []
  for (let offset = 0; offset < content.length; offset += 1024) {
    lines.push(JSON.stringify(content.slice(offset, offset + 1024)))
  }
  const pages = await reference(opts, lines.join('\n'), 'read-pages.jsonl')
  return `[Full ${description} preserved in workspace file ${JSON.stringify(file)} (${Buffer.byteLength(content)} bytes). Readable view: ${JSON.stringify(pages)}; ${lines.length} lines of JSON string fragments. Use Read on the view with offset=1, limit=4, then offset=5, limit=4, etc. JSON-decode each line and concatenate without separators to recover exact original text. Always set offset and limit; the raw file may contain oversized single lines. This is a lossless file reference, not a summary.]`
}

function countMedia(items: unknown[]): number {
  let count = 0
  for (const item of items) {
    if (!object(item)) continue
    if (item.type === 'image' || item.type === 'document') count++
    if (Array.isArray(item.content)) count += countMedia(item.content)
  }
  return count
}

/** Receives the SDK's final serialized body. It never mutates native history,
 * replays tools, starts another model call, or claims a file is a summary. */
export async function prepareCcbRequestBody(raw: string, opts: Options): Promise<string> {
  const body: Json = JSON.parse(raw)
  if (!Array.isArray(body.messages)) return raw
  const originalMessages = body.messages
  let messages = originalMessages as Json[]
  const beforeBytes = Buffer.byteLength(raw, 'utf8')
  let bodyBytes = beforeBytes
  let messageBytes = bytes(messages)
  let mediaCount = countMedia(messages)
  const fixedRatio = Math.max(
    body.system === undefined ? 0 : bytes(body.system) / CCB_REQUEST_BYTE_LIMITS.system,
    body.tools === undefined ? 0 : bytes(body.tools) / CCB_REQUEST_BYTE_LIMITS.tools,
  )
  const ratio = () => Math.max(bodyBytes / CCB_REQUEST_BYTE_LIMITS.body,
    messageBytes / CCB_REQUEST_BYTE_LIMITS.messages, fixedRatio)
  const pressure = contextBytePressure('claude-code', 'native_context', ratio())
  if (pressure) opts.onEvent(pressure)
  const fits = () => ratio() < 1 && messages.length <= MAX_MESSAGES && mediaCount <= 100
  opts.signal?.throwIfAborted()
  // Tool-less compact/auxiliary calls cannot resolve file references. Preserve
  // their original contents; an impossible envelope is rejected before fetch.
  const canRead = Array.isArray(body.tools) && body.tools.some(t => object(t) && t.name === 'Read')
  if (!canRead || fixedRatio >= 1) {
    if (!fits()) throw new RequestBodyBudgetError()
    return raw
  }

  let latestUser = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    const content = m.content
    if (typeof content === 'string' || (Array.isArray(content) &&
      !content.some(b => object(b) && b.type === 'tool_result'))) latestUser = i
  }
  type Candidate = { index: number; media: boolean; size: number; replace: () => Promise<void> }
  const candidates: Candidate[] = []
  const replaceText = (target: Json, field: string, index: number) => {
    const value = target[field]
    if (typeof value !== 'string' || Buffer.byteLength(value) < OLD_ATTACHMENT_BYTES) return
    candidates.push({ index, media: false, size: bytes(value), replace: async () => {
      target[field] = await textReference(opts, value, 'txt', 'text')
    } })
  }
  const visit = (blocks: unknown[], index: number) => {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (!object(block)) continue
      const source = block.source
      if ((block.type === 'image' || block.type === 'document') && object(source) &&
        source.type === 'base64' && typeof source.data === 'string') {
        const encoded = source.data
        const mime = source.media_type
        const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/jpeg' ? 'jpg' :
          mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'bin'
        const { source: _source, cache_control: _cache, ...metadata } = block
        candidates.push({ index, media: true, size: bytes(block), replace: async () => {
          const content = Buffer.from(encoded, 'base64')
          const file = await reference(opts, content, ext)
          blocks[i] = { type: 'text', text: `${refText(file, content.length, String(mime))}\nOriginal attachment metadata: ${JSON.stringify(metadata)}` }
        } })
      } else if (block.type === 'text') replaceText(block, 'text', index)
      else if (block.type === 'tool_result') {
        if (Array.isArray(block.content)) visit(block.content, index)
        else replaceText(block, 'content', index)
      }
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (Array.isArray(m.content)) visit(m.content, i)
    else replaceText(m, 'content', i)
  }
  let changed = false
  const apply = async (candidate: Candidate) => {
    opts.signal?.throwIfAborted()
    // Measure the affected message to include all JSON escaping/metadata.
    const before = bytes(messages[candidate.index])
    await candidate.replace()
    if (candidate.media) mediaCount--
    const delta = bytes(messages[candidate.index]) - before
    messageBytes += delta
    bodyBytes += delta
    changed = true
  }
  const used = new Set<Candidate>()
  // Large OLD media is referenced on every subsequent API request, even if
  // this particular body is small. Fresh media stays inline whenever it fits.
  for (const c of candidates) {
    if (c.media && c.index < latestUser && c.size >= OLD_ATTACHMENT_BYTES) {
      await apply(c)
      used.add(c)
    }
  }
  for (const c of candidates.filter(c => c.media)) {
    if (fits()) break
    if (!used.has(c)) { await apply(c); used.add(c) }
  }
  // Preserve exact original history in a file, cut only at a fresh user turn;
  // the active turn's tool_use/tool_result chain remains together and inline.
  if (!fits() && latestUser > 0) {
    // Use the original wire JSON, not the modified projection, as the archive.
    const history = (JSON.parse(raw) as { messages: Json[] }).messages.slice(0, latestUser)
    const content = history.map(m => JSON.stringify(m)).join('\n')
    const note = await textReference(opts, content, 'jsonl', 'earlier conversation (one original message per JSON line)')
    messages = [{ role: 'user', content: note }, ...messages.slice(latestUser)]
    body.messages = messages
    mediaCount = countMedia(messages)
    bodyBytes = bytes(body)
    messageBytes = bytes(messages)
    changed = true
  }
  // Single oversized current text/tool output can also be read in chunks.
  // Candidate targets still point into the retained current turn after archive.
  for (const c of candidates.filter(c => !c.media && c.index >= latestUser)) {
    if (fits()) break
    opts.signal?.throwIfAborted()
    await c.replace()
    bodyBytes = bytes(body)
    messageBytes = bytes(messages)
    changed = true
  }
  opts.signal?.throwIfAborted()
  if (!changed) {
    if (!fits()) throw new RequestBodyBudgetError()
    return raw
  }
  const result = JSON.stringify(body)
  bodyBytes = Buffer.byteLength(result, 'utf8')
  messageBytes = bytes(messages)
  mediaCount = countMedia(messages)
  if (!fits()) throw new RequestBodyBudgetError()
  opts.onEvent({ kind: 'context_compacted', compaction: {
    engine: 'claude-code', scope: 'native_context', strategy: 'file_reference',
    beforeBytes, afterBytes: bodyBytes, droppedEntries: 0,
  } })
  return result
}

/** The boundary is after SDK serialization, shared by stream, fallback and
 * summary requests. Box and non-message HTTP operations remain byte-identical. */
export function createCcbBudgetFetch(
  inner: Fetch,
  hooks: {
    enabled: () => boolean
    remoteOwnsHistory: (model: string) => boolean
    cwd: () => string
    sessionId: () => string
    onEvent: Options['onEvent']
  },
): Fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!hooks.enabled() || init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') return inner(input, init)
    const url = input instanceof Request ? input.url : String(input)
    if (!new URL(url).pathname.endsWith('/messages')) return inner(input, init)
    const parsed = JSON.parse(init.body) as Json
    if (typeof parsed.model !== 'string' || !Array.isArray(parsed.messages) || hooks.remoteOwnsHistory(parsed.model)) return inner(input, init)
    try {
      const body = await prepareCcbRequestBody(init.body, {
        cwd: hooks.cwd(), sessionId: hooks.sessionId(), onEvent: hooks.onEvent, signal: init.signal,
      })
      init.signal?.throwIfAborted()
      const headers = new Headers(init.headers)
      // A caller-provided Content-Length must describe the rewritten wire body.
      headers.delete('content-length')
      return inner(input, { ...init, headers, body })
    } catch (error) {
      if (!(error instanceof RequestBodyBudgetError)) throw error
      // Returning a local 413 keeps the SDK's normal request-too-large error
      // path; throwing inside fetch would disguise it as a connection error.
      return new Response(JSON.stringify({ type: 'error', error: {
        type: 'request_too_large', message: error.message,
      } }), { status: 413, headers: { 'content-type': 'application/json' } })
    }
  }
}
