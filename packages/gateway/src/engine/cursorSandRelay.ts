/**
 * Cursor Sand inference relay.
 *
 * CCB remains the local agent/tool loop. Its Anthropic Messages calls are
 * translated to Cursor's real Sand surface:
 *   POST https://api2.cursor.sh/aiserver.v1.InferenceService/Stream
 *   x-cursor-client-type: sand
 *
 * The relay is loopback-only and route-token scoped. Cursor credentials are
 * read from the root-owned account mount for each auth cache generation and
 * never enter argv, logs, or the child environment.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import * as protobuf from 'protobufjs'
import { cursorModelById } from '@openclaude/protocol'
import { createLogger } from '../logger.js'

const log = createLogger({ module: 'cursorSandRelay' })
const DEFAULT_UPSTREAM = 'https://api2.cursor.sh'
const DEFAULT_CLIENT_VERSION = 'cli-2026.08.11-e8db854'
const MAX_BODY_BYTES = 16 * 1024 * 1024
const PING_MS = 5_000
const toolSchemaValidator = new Ajv2020({ strict: false, allErrors: false, validateFormats: false })

type JsonObject = Record<string, unknown>

interface AnthropicTool {
  name?: unknown
  description?: unknown
  input_schema?: unknown
}

interface AnthropicMessage {
  role?: unknown
  content?: unknown
}

interface AnthropicMessagesBody extends JsonObject {
  model?: unknown
  max_tokens?: unknown
  temperature?: unknown
  top_p?: unknown
  stop_sequences?: unknown
  stream?: unknown
  system?: unknown
  messages?: unknown
  tools?: unknown
}

interface RelayDeps {
  fetchImpl?: typeof fetch
  readApiKey?: () => Buffer
  upstreamBaseUrl?: string
  clientVersion?: string
  now?: () => number
  onRequestForTest?: (body: AnthropicMessagesBody) => void
  onRawTextForTest?: (text: string, attempt: number) => void
}

interface RelayAuthCache {
  fingerprint: string
  accessToken: string
  expiresAt: number
}

interface ToolStreamState {
  index: number
  id: string
  name: string
  args: string
  opened: boolean
  closed: boolean
}

interface StreamState {
  nextIndex: number
  textIndex: number | null
  thinkingIndex: number | null
  tools: Map<number, ToolStreamState>
  inputTokens: number
  outputTokens: number
  text: string
  thinking: string
  failed: boolean
  recoveredToolCount: number
}

let protocolTypes: { request: protobuf.Type; response: protobuf.Type } | null = null

function resolveProtocolPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(moduleDir, 'cursorSandInference.proto'),
    resolve(moduleDir, '../../src/engine/cursorSandInference.proto'),
    resolve(process.cwd(), 'packages/gateway/src/engine/cursorSandInference.proto'),
  ]
  const hit = candidates.find((candidate) => existsSync(candidate))
  if (!hit) throw new Error('CURSOR_SAND_PROTOCOL_UNAVAILABLE')
  return hit
}

function getProtocolTypes(): { request: protobuf.Type; response: protobuf.Type } {
  if (protocolTypes) return protocolTypes
  const root = protobuf.loadSync(resolveProtocolPath())
  protocolTypes = {
    request: root.lookupType('aiserver.v1.InferenceStreamRequest'),
    response: root.lookupType('aiserver.v1.InferenceStreamResponse'),
  }
  return protocolTypes
}

function trimSecretBuffer(raw: Buffer): Buffer {
  let end = raw.length
  while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end--
  const out = Buffer.from(raw.subarray(0, end))
  raw.fill(0)
  if (out.length === 0 || out.includes(0x0a) || out.includes(0x0d)) {
    out.fill(0)
    throw new Error('CURSOR_SAND_CREDENTIAL_MALFORMED')
  }
  return out
}

export function readPrimaryCursorApiKey(): Buffer {
  const result = spawnSync(
    '/usr/bin/sudo',
    ['-n', '/bin/cat', '/run/oc/cursor-auth/api-key'],
    {
      encoding: null,
      maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error('CURSOR_SAND_CREDENTIAL_UNAVAILABLE')
  }
  return trimSecretBuffer(Buffer.from(result.stdout))
}

function decodeJwtExpiry(token: string, fallback: number): number {
  try {
    const part = token.split('.')[1]
    if (!part) return fallback
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof json.exp === 'number' && Number.isFinite(json.exp)
      ? json.exp * 1000
      : fallback
  } catch {
    return fallback
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const record = block as JsonObject
      if ((record.type === 'text' || record.type === 'thinking') && typeof record.text === 'string') {
        return record.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function contentParts(content: unknown): JsonObject[] {
  if (!Array.isArray(content)) return []
  const parts: JsonObject[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as JsonObject
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ text: { text: block.text } })
      continue
    }
    if (block.type === 'image' && block.source && typeof block.source === 'object') {
      const source = block.source as JsonObject
      if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
        parts.push({ image: { data: source.data, mimeType: source.media_type } })
      }
      continue
    }
    if (block.type === 'document' && block.source && typeof block.source === 'object') {
      const source = block.source as JsonObject
      if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
        parts.push({ file: { data: source.data, mediaType: source.media_type, filename: String(block.title ?? 'document') } })
      }
    }
  }
  return parts
}

function assistantHistoryText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const chunks: string[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as JsonObject
    if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text)
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      chunks.push(`<thinking>${block.thinking}</thinking>`)
    }
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      chunks.push(`<tool_use name=${JSON.stringify(block.name)}>${JSON.stringify(block.input ?? {})}</tool_use>`)
    }
  }
  return chunks.join('\n')
}

function userHistoryText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const chunks: string[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as JsonObject
    if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text)
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      chunks.push(
        `<tool_result id=${JSON.stringify(block.tool_use_id)} error=${block.is_error === true ? 'true' : 'false'}>`
        + `${contentText(block.content)}</tool_result>`,
      )
    }
  }
  return chunks.join('\n')
}

function toolProtocolPrompt(tools: unknown): string {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const definitions = tools.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const tool = raw as AnthropicTool
    if (typeof tool.name !== 'string' || !tool.name) return []
    return [{
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      input_schema: tool.input_schema ?? { type: 'object', properties: {} },
    }]
  })
  if (definitions.length === 0) return ''
  return [
    'You have access to the tools listed below.',
    'CRITICAL TOOL PROTOCOL: when a tool is needed, your ENTIRE response must be only one or more control blocks in this exact form with valid JSON and no Markdown fence:',
    '<tool_use name="TOOL_NAME">{"argument":"value"}</tool_use>',
    'Do not add prose before or after a tool block. Do not emit bare JSON, tool_call:, input:, result, or a fabricated tool result.',
    'Use only listed tool names. After emitting a tool call, stop and wait for its real <tool_result>.',
    `TOOLS=${JSON.stringify(definitions)}`,
  ].join('\n')
}

function systemMessages(system: unknown, tools: unknown): JsonObject[] {
  const text = [contentText(system), toolProtocolPrompt(tools)].filter(Boolean).join('\n\n')
  return text ? [{ role: 4, text }] : []
}

function translateMessages(messages: unknown): JsonObject[] {
  if (!Array.isArray(messages)) return []
  const out: JsonObject[] = []
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as AnthropicMessage
    if (message.role === 'assistant') {
      const text = assistantHistoryText(message.content)
      if (text) out.push({ role: 2, text })
      continue
    }
    if (message.role !== 'user') continue
    const text = userHistoryText(message.content)
    const parts = contentParts(message.content)
    const hasMedia = parts.some((part) => 'image' in part || 'file' in part)
    if (hasMedia) {
      if (text) parts.unshift({ text: { text } })
      out.push({ role: 1, parts: { parts } })
    } else if (text) out.push({ role: 1, text })
  }
  return out
}

export function encodeCursorSandRequest(body: AnthropicMessagesBody): {
  bytes: Uint8Array
  upstreamModel: string
  invocationId: string
} {
  if (typeof body.model !== 'string' || !body.model) throw new Error('CURSOR_SAND_MODEL_REQUIRED')
  const model = cursorModelById(body.model)
  if (!model?.upstreamModel || !model.upstreamModel.startsWith('claude-fable-5')) {
    throw new Error(`CURSOR_SAND_MODEL_NOT_SUPPORTED:${body.model}`)
  }
  const invocationId = randomUUID()
  const messages = [...systemMessages(body.system, body.tools), ...translateMessages(body.messages)]
  if (messages.length === 0) throw new Error('CURSOR_SAND_MESSAGES_REQUIRED')
  const requestedModel: JsonObject = {
    modelId: model.upstreamModel,
    builtInModel: true,
  }
  const { request } = getProtocolTypes()
  const payload = request.encode(request.fromObject({
    messages,
    tools: [],
    modelConfig: {
      maxTokens: typeof body.max_tokens === 'number' ? Math.max(1, Math.floor(body.max_tokens)) : 4096,
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(typeof body.top_p === 'number' ? { topP: body.top_p } : {}),
      ...(Array.isArray(body.stop_sequences) ? { stopSequences: body.stop_sequences.filter((x): x is string => typeof x === 'string') } : {}),
    },
    modelId: model.upstreamModel,
    requestedModel,
    invocationId,
    conversationId: randomUUID(),
  })).finish()
  return { bytes: payload, upstreamModel: model.upstreamModel, invocationId }
}

function connectEnvelope(payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.byteLength)
  out[0] = 0
  out.writeUInt32BE(payload.byteLength, 1)
  Buffer.from(payload).copy(out, 5)
  return out
}

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

async function emitSse(res: ServerResponse, event: string, data: unknown): Promise<void> {
  if (res.destroyed || res.writableEnded) throw new Error('CURSOR_SAND_DOWNSTREAM_CLOSED')
  if (!res.write(sseChunk(event, data))) await once(res, 'drain')
}

async function startBlock(res: ServerResponse, index: number, contentBlock: JsonObject): Promise<void> {
  await emitSse(res, 'content_block_start', { type: 'content_block_start', index, content_block: contentBlock })
}

async function stopBlock(res: ServerResponse, index: number): Promise<void> {
  await emitSse(res, 'content_block_stop', { type: 'content_block_stop', index })
}

function decodeFrame(bytes: Buffer): JsonObject {
  const { response } = getProtocolTypes()
  return response.toObject(response.decode(bytes), {
    defaults: false,
    longs: String,
    oneofs: true,
  }) as JsonObject
}

function errorMessage(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as JsonObject
    const message = typeof record.message === 'string' ? record.message : 'Cursor Sand inference failed'
    const prefix = typeof record.code === 'string' && record.code
      ? record.code
      : typeof record.errorType === 'number' && record.errorType > 0
        ? `error_type_${record.errorType}`
        : ''
    return prefix ? `${prefix}: ${message}` : message
  }
  return 'Cursor Sand inference failed'
}

function parseEndTrailer(bytes: Buffer): string | null {
  if (bytes.length === 0) return null
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as JsonObject
    const error = parsed.error
    if (!error || typeof error !== 'object') return null
    return typeof (error as JsonObject).message === 'string'
      ? (error as JsonObject).message as string
      : 'Cursor Sand transport error'
  } catch {
    return 'Cursor Sand transport trailer was malformed'
  }
}

interface RecoveredXmlTool {
  id: string
  name: string
  input: JsonObject
}

export interface ToolRecoveryDefinition {
  name: string
  inputSchema: JsonObject
}

function advertisedTools(tools: unknown): ToolRecoveryDefinition[] {
  if (!Array.isArray(tools)) return []
  return tools.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const record = raw as JsonObject
    const name = record.name
    if (typeof name !== 'string' || !name) return []
    const inputSchema = record.input_schema && typeof record.input_schema === 'object' && !Array.isArray(record.input_schema)
      ? record.input_schema as JsonObject
      : {}
    return [{ name, inputSchema }]
  })
}

function schemaMatchesInput(schema: JsonObject, input: JsonObject): boolean {
  if (Object.keys(schema).length === 0) return false
  try {
    return toolSchemaValidator.validate(schema, input) === true
  } catch {
    return false
  }
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

export function recoverXmlToolCalls(
  text: string,
  allowedTools: readonly ToolRecoveryDefinition[],
): { text: string; tools: RecoveredXmlTool[] } {
  const definitions = [...allowedTools]
  const allowed = new Map(definitions.map((tool) => [tool.name.toLowerCase(), tool.name]))
  const schemas = new Map(definitions.map((tool) => [tool.name.toLowerCase(), tool.inputSchema]))
  const tools: RecoveredXmlTool[] = []
  const pattern = /<tool_(use|call)\b([^>]*)>([\s\S]*?)<\/tool_\1>/gi
  const trimmed = text.trim()
  const matches = [...trimmed.matchAll(pattern)]
  let cursor = 0
  const xmlOnly = matches.length > 0 && matches.every((match) => {
    const index = match.index ?? 0
    const gapIsWhitespace = trimmed.slice(cursor, index).trim() === ''
    cursor = index + match[0].length
    return gapIsWhitespace
  }) && trimmed.slice(cursor).trim() === ''
  let visible = xmlOnly ? trimmed.replace(pattern, (_full, _kind: string, attrs: string, body: string) => {
    const nameMatch = /\bname\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs)
    let name = nameMatch?.[1] ?? nameMatch?.[2] ?? ''
    let input: unknown = {}
    try {
      const parsed = body.trim() ? JSON.parse(body.trim()) as unknown : {}
      if (!name && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as JsonObject
        if (typeof record.name === 'string') name = record.name
        input = record.arguments ?? record.input ?? {}
      } else {
        input = parsed
      }
    } catch {
      return ''
    }
    const canonical = allowed.get(name.toLowerCase())
    if (!canonical) return ''
    const object = input && typeof input === 'object' && !Array.isArray(input)
      ? input as JsonObject
      : {}
    const schema = schemas.get(name.toLowerCase())
    if (!schema || !schemaMatchesInput(schema, object)) return ''
    tools.push({ id: `toolu_${randomBytes(16).toString('hex')}`, name: canonical, input: object })
    return ''
  }) : text
  // Fable occasionally emits the same control in a compact single-line form
  // despite the XML instruction. Accept only a bounded JSON object on one
  // line, validate the advertised name, and discard all speculative text after
  // the call (models sometimes hallucinate a tool result before the real host
  // has executed anything).
  const compact = /^\s*tool_call:\s*(\{[^\n]*\})\s*$/i.exec(visible)
  if (compact) {
    try {
      const parsed = JSON.parse(compact[1]) as JsonObject
      const rawName = typeof parsed.name === 'string' ? parsed.name : ''
      const canonical = allowed.get(rawName.toLowerCase())
      const rawInput = parsed.arguments ?? parsed.input ?? {}
      const schema = schemas.get(rawName.toLowerCase())
      if (
        canonical
        && schema
        && rawInput
        && typeof rawInput === 'object'
        && !Array.isArray(rawInput)
        && schemaMatchesInput(schema, rawInput as JsonObject)
      ) {
        tools.push({
          id: `toolu_${randomBytes(16).toString('hex')}`,
          name: canonical,
          input: rawInput as JsonObject,
        })
        visible = ''
      }
    } catch {
      // Invalid compact control stays ordinary text; never invent a tool call.
    }
  }
  if (tools.length === 0) {
    const colon = /^\s*:\s*([A-Za-z0-9_.:-]+)\s*\ninput:\s*(\{[\s\S]*\})\s*$/i.exec(visible)
    if (colon) {
      try {
        const canonical = allowed.get(colon[1].toLowerCase())
        const input = JSON.parse(colon[2]) as unknown
        const schema = schemas.get(colon[1].toLowerCase())
        if (
          canonical
          && schema
          && input
          && typeof input === 'object'
          && !Array.isArray(input)
          && schemaMatchesInput(schema, input as JsonObject)
        ) {
          tools.push({
            id: `toolu_${randomBytes(16).toString('hex')}`,
            name: canonical,
            input: input as JsonObject,
          })
          visible = ''
        }
      } catch {
        // Invalid colon control stays ordinary text.
      }
    }
  }
  if (tools.length === 0) {
    const object = firstJsonObject(visible)
    if (object && visible.trim() === object) {
      try {
        const input = JSON.parse(object) as unknown
        if (input && typeof input === 'object' && !Array.isArray(input)) {
          const matches = definitions.filter((tool) => schemaMatchesInput(tool.inputSchema, input as JsonObject))
          if (matches.length === 1) {
            tools.push({
              id: `toolu_${randomBytes(16).toString('hex')}`,
              name: matches[0].name,
              input: input as JsonObject,
            })
            visible = ''
          }
        }
      } catch {
        // Bare malformed/ambiguous JSON remains text.
      }
    }
  }
  return { text: visible.trim(), tools }
}

function looksLikeInvalidToolIntent(
  text: string,
  allowedTools: readonly ToolRecoveryDefinition[],
): boolean {
  const trimmed = text.trim()
  // Correction is reserved for a whole-response control attempt. Prose that
  // merely documents an XML/tool_call example must remain ordinary text.
  if (/^<tool_(?:use|call)\b/i.test(trimmed)) return true
  if (/^tool_call\s*:/i.test(trimmed)) return true
  if (/^:\s*[A-Za-z0-9_.:-]+\s*\ninput:/i.test(trimmed)) return true
  const object = firstJsonObject(trimmed)
  if (!object || object !== trimmed) return false
  try {
    const parsed = JSON.parse(object) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    return allowedTools.filter((tool) => schemaMatchesInput(tool.inputSchema, parsed as JsonObject)).length === 1
  } catch {
    return false
  }
}

function correctedToolBody(body: AnthropicMessagesBody, invalidResponse: string): AnthropicMessagesBody {
  const messages = Array.isArray(body.messages) ? [...body.messages] : []
  messages.push({ role: 'assistant', content: invalidResponse })
  messages.push({
    role: 'user',
    content:
      'FORMAT ERROR: your previous response attempted a tool call but was not executable. '
      + 'Return your ENTIRE response as exactly one <tool_use name="TOOL_NAME">{"argument":"value"}</tool_use> block. '
      + 'No prose, no Markdown, no bare JSON, and do not invent a tool result.',
  })
  return { ...body, messages }
}

export class CursorSandRelay {
  private readonly deps: Required<Pick<RelayDeps, 'fetchImpl' | 'readApiKey' | 'upstreamBaseUrl' | 'clientVersion' | 'now'>>
  private readonly routeToken = randomBytes(32).toString('hex')
  private server: Server | null = null
  private origin: string | null = null
  private authCache: RelayAuthCache | null = null
  private readonly activeRequests = new Set<AbortController>()
  private readonly onRequestForTest?: (body: AnthropicMessagesBody) => void
  private readonly onRawTextForTest?: (text: string, attempt: number) => void

  constructor(deps: RelayDeps = {}) {
    this.deps = {
      fetchImpl: deps.fetchImpl ?? fetch,
      readApiKey: deps.readApiKey ?? readPrimaryCursorApiKey,
      upstreamBaseUrl: (deps.upstreamBaseUrl ?? DEFAULT_UPSTREAM).replace(/\/+$/, ''),
      clientVersion: deps.clientVersion ?? DEFAULT_CLIENT_VERSION,
      now: deps.now ?? Date.now,
    }
    this.onRequestForTest = deps.onRequestForTest
    this.onRawTextForTest = deps.onRawTextForTest
  }

  async start(): Promise<string> {
    if (this.origin) return `${this.origin}/route/${this.routeToken}`
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(async (error: unknown) => {
        log.warn('cursor sand relay request failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        if (!res.headersSent) {
          res.statusCode = 502
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Cursor Sand inference failed' } }))
        } else {
          if (!res.destroyed && !res.writableEnded) {
            await emitSse(res, 'error', { type: 'error', error: { type: 'api_error', message: 'Cursor Sand inference failed' } })
            res.end()
          }
        }
      })
    })
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolvePromise())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('CURSOR_SAND_RELAY_BIND_FAILED')
    }
    this.server = server
    this.origin = `http://127.0.0.1:${address.port}`
    return `${this.origin}/route/${this.routeToken}`
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.origin = null
    this.authCache = null
    for (const controller of this.activeRequests) controller.abort()
    this.activeRequests.clear()
    if (!server) return
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  private routeMatches(pathname: string): boolean {
    const prefix = `/route/${this.routeToken}`
    if (!pathname.startsWith('/route/')) return false
    const got = pathname.slice('/route/'.length).split('/')[0] ?? ''
    const expected = this.routeToken
    const a = Buffer.from(got)
    const b = Buffer.from(expected)
    const tokenMatches = a.length === b.length && timingSafeEqual(a, b)
    return tokenMatches && (pathname === `${prefix}/v1/messages` || pathname === `${prefix}/v1/messages/count_tokens`)
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.length
      if (total > MAX_BODY_BYTES) throw new Error('CURSOR_SAND_BODY_TOO_LARGE')
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, total)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'POST' || !this.routeMatches(url.pathname)) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const raw = await this.readBody(req)
    let body: AnthropicMessagesBody
    try {
      body = JSON.parse(raw.toString('utf8')) as AnthropicMessagesBody
    } catch {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } }))
      return
    }
    if (url.pathname.endsWith('/count_tokens')) {
      const estimate = Math.max(1, Math.ceil(raw.length / 4))
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ input_tokens: estimate }))
      return
    }
    const controller = new AbortController()
    this.activeRequests.add(controller)
    const abort = (): void => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      await this.handleMessages(body, res, controller.signal)
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
      this.activeRequests.delete(controller)
    }
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    const key = this.deps.readApiKey()
    try {
      const fingerprint = createHash('sha256').update(key).digest('hex')
      const now = this.deps.now()
      if (
        this.authCache
        && this.authCache.fingerprint === fingerprint
        && this.authCache.expiresAt > now + 60_000
      ) return this.authCache.accessToken
      const response = await this.deps.fetchImpl(`${this.deps.upstreamBaseUrl}/auth/exchange_user_api_key`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.toString('utf8')}`,
          'content-type': 'application/json',
        },
        body: '{}',
        signal,
      })
      if (!response.ok) throw new Error(`CURSOR_SAND_AUTH_HTTP_${response.status}`)
      const auth = await response.json() as JsonObject
      const accessToken = typeof auth.accessToken === 'string'
        ? auth.accessToken
        : typeof auth.access_token === 'string'
          ? auth.access_token
          : null
      if (!accessToken) throw new Error('CURSOR_SAND_AUTH_TOKEN_MISSING')
      this.authCache = {
        fingerprint,
        accessToken,
        expiresAt: decodeJwtExpiry(accessToken, now + 5 * 60_000),
      }
      return accessToken
    } finally {
      key.fill(0)
    }
  }

  private async openInference(
    body: AnthropicMessagesBody,
    signal: AbortSignal,
  ): Promise<{ response: Response; upstreamModel: string }> {
    const { bytes, upstreamModel, invocationId } = encodeCursorSandRequest(body)
    const token = await this.accessToken(signal)
    const response = await this.deps.fetchImpl(
      `${this.deps.upstreamBaseUrl}/aiserver.v1.InferenceService/Stream`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/connect+proto',
          'connect-protocol-version': '1',
          'x-cursor-client-type': 'sand',
          'x-cursor-client-version': this.deps.clientVersion,
          'x-ghost-mode': 'true',
          'x-request-id': invocationId,
          'x-session-id': randomUUID(),
        },
        body: new Uint8Array(connectEnvelope(bytes)),
        signal,
      },
    )
    return { response, upstreamModel }
  }

  private async handleMessages(
    body: AnthropicMessagesBody,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    this.onRequestForTest?.(structuredClone(body))
    const opened = await this.openInference(body, signal)
    const upstream = opened.response
    if (!upstream.ok || !upstream.body) {
      res.statusCode = upstream.status || 502
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Cursor Sand HTTP ${upstream.status}` } }))
      return
    }
    if (body.stream === false) {
      await this.pipeNonStreaming(upstream, opened.upstreamModel, advertisedTools(body.tools), res)
      return
    }
    await this.pipeStreaming(
      upstream,
      opened.upstreamModel,
      advertisedTools(body.tools),
      res,
      async (invalidResponse) => {
        const retry = await this.openInference(correctedToolBody(body, invalidResponse), signal)
        if (!retry.response.ok || !retry.response.body) {
          throw new Error(`CURSOR_SAND_RETRY_HTTP_${retry.response.status}`)
        }
        return retry.response
      },
    )
  }

  private initialState(): StreamState {
    return {
      nextIndex: 0,
      textIndex: null,
      thinkingIndex: null,
      tools: new Map(),
      inputTokens: 0,
      outputTokens: 0,
      text: '',
      thinking: '',
      failed: false,
      recoveredToolCount: 0,
    }
  }

  private applyFrame(
    state: StreamState,
    frame: JsonObject,
    handlers: {
      text(text: string): void
      thinking(text: string, signature: string): void
      tool(part: JsonObject): void
      error(message: string): void
    },
  ): void {
    const kind = typeof frame.response === 'string' ? frame.response : ''
    const value = kind && frame[kind] && typeof frame[kind] === 'object'
      ? frame[kind] as JsonObject
      : {}
    if (kind === 'textPart') {
      const text = typeof value.text === 'string' ? value.text : ''
      state.text += text
      if (text) handlers.text(text)
      return
    }
    if (kind === 'thinkingPart') {
      const text = typeof value.text === 'string' ? value.text : ''
      const signature = typeof value.signature === 'string' ? value.signature : ''
      state.thinking += text
      if (text || signature) handlers.thinking(text, signature)
      return
    }
    if (kind === 'toolCallPart') {
      handlers.tool(value)
      return
    }
    if (kind === 'usage') {
      if (typeof value.promptTokens === 'number') state.inputTokens = value.promptTokens
      if (typeof value.completionTokens === 'number') state.outputTokens = value.completionTokens
      return
    }
    if (kind === 'extendedUsage') {
      if (typeof value.inputTokens === 'number') state.inputTokens = value.inputTokens
      if (typeof value.outputTokens === 'number') state.outputTokens = value.outputTokens
      return
    }
    if (kind === 'error') {
      state.failed = true
      handlers.error(errorMessage(value))
    }
  }

  private async consumeFrames(
    response: Response,
    onFrame: (frame: JsonObject) => void,
    onEndError: (message: string) => void,
  ): Promise<void> {
    const reader = response.body!.getReader()
    let buffer = Buffer.alloc(0)
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer = Buffer.concat([buffer, Buffer.from(value)])
        while (buffer.length >= 5) {
          const flags = buffer[0]
          const length = buffer.readUInt32BE(1)
          if (buffer.length < 5 + length) break
          const payload = buffer.subarray(5, 5 + length)
          buffer = buffer.subarray(5 + length)
          if ((flags & 0x02) !== 0) {
            const error = parseEndTrailer(payload)
            if (error) onEndError(error)
          } else {
            onFrame(decodeFrame(payload))
          }
        }
      }
      if (buffer.length !== 0) throw new Error('CURSOR_SAND_TRUNCATED_FRAME')
    } finally {
      await reader.cancel().catch(() => {})
    }
  }

  private async collectInference(upstream: Response): Promise<{
    state: StreamState
    thinkingSignature: string
    streamError: string | null
  }> {
    const state = this.initialState()
    let thinkingSignature = ''
    let streamError: string | null = null
    await this.consumeFrames(
      upstream,
      (frame) => this.applyFrame(state, frame, {
        text: () => {},
        thinking: (_text, signature) => {
          if (signature) thinkingSignature = signature
        },
        tool: (part) => {
          const toolIndex = typeof part.toolIndex === 'number' ? part.toolIndex : state.tools.size
          let tool = state.tools.get(toolIndex)
          if (!tool) {
            tool = {
              index: -1,
              id: typeof part.toolCallId === 'string' && part.toolCallId
                ? part.toolCallId
                : `toolu_${randomBytes(12).toString('hex')}`,
              name: typeof part.toolName === 'string' ? part.toolName : '',
              args: '', opened: false, closed: false,
            }
            state.tools.set(toolIndex, tool)
          }
          if (typeof part.args === 'string') tool.args += part.args
          if (part.isComplete === true) tool.closed = true
        },
        error: (message) => {
          streamError ??= message
          state.failed = true
        },
      }),
      (message) => {
        streamError ??= message
        state.failed = true
      },
    )
    return { state, thinkingSignature, streamError }
  }

  private async pipeStreaming(
    upstream: Response,
    model: string,
    allowedTools: readonly ToolRecoveryDefinition[],
    res: ServerResponse,
    retryInvalidTool: (invalidResponse: string) => Promise<Response>,
  ): Promise<void> {
    let state = this.initialState()
    const messageId = `msg_${randomBytes(16).toString('hex')}`
    let streamError: string | null = null
    let thinkingSignature = ''
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-cache, no-transform')
    res.setHeader('connection', 'keep-alive')
    const ping = setInterval(() => {
      if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) {
        res.write(sseChunk('ping', { type: 'ping' }))
      }
    }, PING_MS)
    ping.unref()
    try {
      let collected = await this.collectInference(upstream)
      this.onRawTextForTest?.(collected.state.text, 1)
      state = collected.state
      streamError = collected.streamError
      thinkingSignature = collected.thinkingSignature
      let recovered = recoverXmlToolCalls(state.text, allowedTools)
      if (
        allowedTools.length > 0
        && state.tools.size === 0
        && recovered.tools.length === 0
        && looksLikeInvalidToolIntent(state.text, allowedTools)
      ) {
        const firstInput = state.inputTokens
        const firstOutput = state.outputTokens
        const retry = await retryInvalidTool(state.text)
        collected = await this.collectInference(retry)
        this.onRawTextForTest?.(collected.state.text, 2)
        state = collected.state
        state.inputTokens += firstInput
        state.outputTokens += firstOutput
        streamError = collected.streamError
        thinkingSignature = collected.thinkingSignature
        recovered = recoverXmlToolCalls(state.text, allowedTools)
        if (
          !state.failed
          && state.tools.size === 0
          && recovered.tools.length === 0
          && looksLikeInvalidToolIntent(state.text, allowedTools)
        ) {
          state.failed = true
          streamError = 'Cursor Sand tool protocol remained invalid after one correction'
        }
      }
      if (state.failed || streamError) {
        await emitSse(res, 'error', {
          type: 'error',
          error: { type: 'api_error', message: streamError ?? 'Cursor Sand inference failed' },
        })
        return
      }

      await emitSse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: state.inputTokens, output_tokens: 0 },
        },
      })

      if (state.thinking) {
        const index = state.nextIndex++
        await startBlock(res, index, { type: 'thinking', thinking: '', signature: '' })
        await emitSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: state.thinking },
        })
        if (thinkingSignature) {
          await emitSse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'signature_delta', signature: thinkingSignature },
          })
        }
        await stopBlock(res, index)
      }

      const visibleText = allowedTools.length > 0 ? recovered.text : state.text
      if (visibleText) {
        const index = state.nextIndex++
        await startBlock(res, index, { type: 'text', text: '' })
        await emitSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: visibleText },
        })
        await stopBlock(res, index)
      }

      for (const tool of state.tools.values()) {
        const index = state.nextIndex++
        await startBlock(res, index, { type: 'tool_use', id: tool.id, name: tool.name, input: {} })
        await emitSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: tool.args || '{}' },
        })
        await stopBlock(res, index)
      }
      for (const tool of recovered.tools) {
        const index = state.nextIndex++
        await startBlock(res, index, { type: 'tool_use', id: tool.id, name: tool.name, input: {} })
        await emitSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) },
        })
        await stopBlock(res, index)
        state.recoveredToolCount++
      }

      await emitSse(res, 'message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: state.tools.size + state.recoveredToolCount > 0 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { input_tokens: state.inputTokens, output_tokens: state.outputTokens },
      })
      await emitSse(res, 'message_stop', { type: 'message_stop' })
    } finally {
      clearInterval(ping)
      if (!res.writableEnded) res.end()
    }
  }

  private async pipeNonStreaming(
    upstream: Response,
    model: string,
    allowedTools: readonly ToolRecoveryDefinition[],
    res: ServerResponse,
  ): Promise<void> {
    const state = this.initialState()
    const tools = new Map<number, ToolStreamState>()
    let error: string | null = null
    await this.consumeFrames(
      upstream,
      (frame) => this.applyFrame(state, frame, {
        text: () => {},
        thinking: () => {},
        tool: (part) => {
          const index = typeof part.toolIndex === 'number' ? part.toolIndex : tools.size
          const current = tools.get(index) ?? {
            index,
            id: typeof part.toolCallId === 'string' ? part.toolCallId : `toolu_${randomBytes(12).toString('hex')}`,
            name: typeof part.toolName === 'string' ? part.toolName : '',
            args: '', opened: true, closed: false,
          }
          if (typeof part.args === 'string') current.args += part.args
          current.closed = part.isComplete === true
          tools.set(index, current)
        },
        error: (message) => { error = message },
      }),
      (message) => { error = message },
    )
    if (error) {
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: error } }))
      return
    }
    const content: JsonObject[] = []
    const recovered = recoverXmlToolCalls(state.text, allowedTools)
    if (state.thinking) content.push({ type: 'thinking', thinking: state.thinking, signature: '' })
    if (recovered.text) content.push({ type: 'text', text: recovered.text })
    for (const tool of [...tools.values()].sort((a, b) => a.index - b.index)) {
      let input: unknown = {}
      try { input = tool.args ? JSON.parse(tool.args) : {} } catch { input = {} }
      content.push({ type: 'tool_use', id: tool.id, name: tool.name, input })
    }
    for (const tool of recovered.tools) {
      content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input })
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: `msg_${randomBytes(16).toString('hex')}`,
      type: 'message', role: 'assistant', model,
      content,
      stop_reason: tools.size + recovered.tools.length > 0 ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: state.inputTokens, output_tokens: state.outputTokens },
    }))
  }
}
