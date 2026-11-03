/** Closed tools for the one supervisor-bound personal chat. No execution or I/O here. */
import { createHash } from 'node:crypto'
import type { Cc5ToolRequest } from './cc5FixedTool.js'

export const CC5_NATIVE_TOOLS = ['mcp__ocbridge__Read', 'mcp__ocbridge__Edit', 'mcp__ocbridge__Bash'] as const
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
export function assertCc5ToolResult(value: unknown): asserts value is Cc5ToolResult {
  const result = value as Cc5ToolResult | undefined
  requireInput(result && typeof result === 'object' && typeof result.isError === 'boolean' && Array.isArray(result.content) &&
    result.content.every((block) => block && typeof block === 'object' && !Array.isArray(block) && typeof block.type === 'string') &&
    Buffer.byteLength(JSON.stringify(result)) <= 98304)
}
