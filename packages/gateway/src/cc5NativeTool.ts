/** Closed tools for the one supervisor-bound personal chat. No execution or I/O here. */
import { createHash } from 'node:crypto'
import type { Cc5ToolRequest } from './cc5FixedTool.js'

export const CC5_NATIVE_TOOLS = ['mcp__ocbridge__Read', 'mcp__ocbridge__Edit', 'mcp__ocbridge__Bash'] as const
/** Single tool-result bound for both wire ends. Must equal the execution-side
 * MCP host (`claude-code-best/src/entrypoints/cc5ToolHost.ts` MAX_RESULT_BYTES)
 * and the container client (`scripts/agent-remote/cc5-fixed-mcp.py` MAX_RESULT).
 * A result one end admits must never be rejected by the other. */
export const CC5_TOOL_RESULT_MAX_BYTES = 128 * 1024
/** A journaled receipt carries one result plus bounded request identifiers. */
export const CC5_TOOL_RECEIPT_MAX_BYTES = CC5_TOOL_RESULT_MAX_BYTES * 2
export interface Cc5ToolResult {
  content: Array<Record<string, unknown> & { type: string }>
  isError: boolean
}
export interface Cc5ToolReceipt {
  version: 2
  scopeHash: string
  commandId: string
  dockerId: string
  containerDbId: string
  operationId: string
  nativeSessionId: string
  toolUseId: string
  rpcId: string | number
  name: string
  inputSha256: string
  result: Cc5ToolResult
  completedAt: number
}
export interface Cc5ToolAdmission {
  turnKey: string
  authorityTurnId: string
  connectionChallenge: string
  securityEpoch: number
}
function requireInput(value: unknown): asserts value {
  if (!value) throw new Error('CC5_NATIVE_TOOL_INPUT_INVALID')
}
function safeText(value: unknown, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) &&
    Buffer.byteLength(value) <= 65536 &&
    ![...value].some((char) => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff })
}
export function validateCc5NativeToolInput(name: string, args: unknown): void {
  requireInput(CC5_NATIVE_TOOLS.some((tool) => tool === name) && args && typeof args === 'object' && !Array.isArray(args))
  const input = args as Record<string, unknown>
  const tool = name.slice('mcp__ocbridge__'.length)
  const allowed = tool === 'Read' ? ['file_path', 'offset', 'limit']
    : tool === 'Edit' ? ['file_path', 'old_string', 'new_string', 'replace_all'] : ['command', 'description', 'timeout']
  requireInput(Object.keys(input).every((key) => allowed.includes(key)))
  if (tool === 'Bash') {
    requireInput(safeText(input.command))
    if (input.description !== undefined) requireInput(safeText(input.description, true))
    if (input.timeout !== undefined) requireInput(Number.isSafeInteger(input.timeout) && (input.timeout as number) >= 1 && (input.timeout as number) <= 30000)
  } else {
    requireInput(safeText(input.file_path))
    if (tool === 'Read') {
      for (const key of ['offset', 'limit']) if (input[key] !== undefined) requireInput(Number.isSafeInteger(input[key]) && (input[key] as number) >= 1)
    } else {
      requireInput(safeText(input.old_string, true) && safeText(input.new_string, true))
      if (input.replace_all !== undefined) requireInput(typeof input.replace_all === 'boolean')
    }
  }
  // Shared with Python: shallow closed schemas, safe integers, sorted keys, UTF-8 strings.
  requireInput(Buffer.byteLength(JSON.stringify(input)) <= 98304)
}
export function cc5ToolInputSha256(args: unknown): string {
  requireInput(args && typeof args === 'object' && !Array.isArray(args))
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(
    Object.entries(args).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ))).digest('hex')
}
export function cc5ToolScopeHash(request: Cc5ToolRequest, admission: Cc5ToolAdmission): string {
  return createHash('sha256').update(JSON.stringify([
    request.uid, request.containerDbId, request.dockerId, request.operationId, request.sessionKey,
    request.turnKey, request.nativeSessionId, request.toolUseId, request.rpcId, request.name,
    cc5ToolInputSha256(request.arguments), admission.authorityTurnId,
    admission.connectionChallenge, admission.securityEpoch,
  ])).digest('hex')
}
/** Python's canonical(json) form: sorted keys, compact separators, raw UTF-8. */
function cc5CanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]))
  })
}
export function cc5ToolResultBytes(value: unknown): number {
  return Buffer.byteLength(cc5CanonicalJson(value), 'utf8')
}
function cc5Base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding)
}
/** The wire image carries its base64 payload in `data`; tolerate a nested
 * Anthropic-style `source.data` so a shape change cannot turn an image into a
 * text passthrough. */
function cc5ImageData(block: Record<string, unknown>): string | undefined {
  if (block.type !== 'image') return undefined
  if (typeof block.data === 'string') return block.data
  const source = block.source as { data?: unknown } | undefined
  return typeof source?.data === 'string' ? source.data : undefined
}
function cc5OmittedImage(bytes: number): string {
  return `[image omitted: original ${bytes} bytes, too large to transfer; read a smaller region or downscale]`
}
/** Back a byte cut off to a complete UTF-8 character boundary. */
function cc5Utf8Boundary(bytes: Buffer, length: number): number {
  let end = Math.min(length, bytes.length)
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return end
}
/** Keep the head of an oversized tool result and tell the model how many bytes
 * the tool produced. Text and images degrade independently: text is cut at a
 * character boundary, and an oversized image block becomes a placeholder
 * instead of being serialized into the text stream as base64. Malformed shapes
 * are returned untouched so the strict assertion below still rejects them. */
export function boundCc5ToolResult(result: Cc5ToolResult): Cc5ToolResult
export function boundCc5ToolResult(result: unknown): unknown
export function boundCc5ToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const value = result as Partial<Cc5ToolResult>
  if (!Array.isArray(value.content)) return result
  const originalBytes = cc5ToolResultBytes(result)
  if (originalBytes <= CC5_TOOL_RESULT_MAX_BYTES) return result
  const isError = value.isError as boolean
  const note = `\n\n[cc5 tool result truncated: original ${originalBytes} bytes]`
  const content = value.content as Array<Record<string, unknown>>
  // Text and image blocks degrade independently: a large image must never be
  // serialized into the text stream as base64 garbage.
  const bounded = content.map((block) => {
    const data = cc5ImageData(block)
    return data === undefined ? block : { type: 'text', text: cc5OmittedImage(cc5Base64Bytes(data)) }
  })
  const withNote = bounded.map((block) => ({ ...block }))
  let lastText = -1
  for (let index = withNote.length - 1; index >= 0; index--) {
    if (withNote[index].type === 'text' && typeof withNote[index].text === 'string') { lastText = index; break }
  }
  if (lastText >= 0) withNote[lastText] = { ...withNote[lastText], text: `${withNote[lastText].text as string}${note}` }
  else withNote.push({ type: 'text', text: note.trimStart() })
  if (cc5ToolResultBytes({ content: withNote, isError }) <= CC5_TOOL_RESULT_MAX_BYTES)
    return { content: withNote, isError }
  // The text itself is over budget: keep its head plus the note, as before.
  const head = bounded.map((block) => typeof block.text === 'string' ? block.text : JSON.stringify(block)).join('\n\n')
  const bytes = Buffer.from(head, 'utf8')
  const truncate = (length: number): Cc5ToolResult => ({
    content: [{ type: 'text', text: `${bytes.subarray(0, cc5Utf8Boundary(bytes, length)).toString('utf8')}${note}` }],
    isError,
  })
  let low = 0
  let high = bytes.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (cc5ToolResultBytes(truncate(middle)) <= CC5_TOOL_RESULT_MAX_BYTES) low = middle
    else high = middle - 1
  }
  return truncate(low)
}
export function assertCc5ToolResult(value: unknown): asserts value is Cc5ToolResult {
  const result = value as Cc5ToolResult | undefined
  requireInput(result && typeof result === 'object' && typeof result.isError === 'boolean' && Array.isArray(result.content) &&
    result.content.every((block) => block && typeof block === 'object' && !Array.isArray(block) && typeof block.type === 'string') &&
    cc5ToolResultBytes(result) <= CC5_TOOL_RESULT_MAX_BYTES)
}
