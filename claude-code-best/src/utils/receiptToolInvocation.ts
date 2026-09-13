import type { ShellCommand } from './ShellCommand.js'
import { createQueuedReceiptInput } from './receiptQueuedInput.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { receiptMcpTargetForSdk } from '../../../packages/gateway/src/receiptOwnerCapability.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildMcpToolName } from '../services/mcp/mcpStringUtils.js'
import { RECEIPT_MCP_META, RECEIPT_MCP_RESULT_META } from '../../../packages/mcp-memory/src/receiptMcpTransport.js'
import { homedir } from 'node:os'
import type { AssistantMessage, UserMessage } from '../types/message.js'
import { getSessionId } from '../bootstrap/state.js'
import { RECEIPT_CAP_ENV, RECEIPT_REPORT_ENV, RECEIPT_CACHE_ENV, parseReceiptLocator, type ReceiptLocator } from '../../../packages/mcp-memory/src/receiptCliTransport.js'
import { gatewayBaseUrl, gatewayDelegateHeaders, postJsonToGateway } from '../../../packages/mcp-memory/src/gatewayClient.js'

type ReceiptScope = {
  toolUseId: string; toolName: string; capability: string; mcpToolName?: string
  env?: Readonly<Record<string, string>>
  backgrounded?: boolean
  backgroundNotification?: () => Promise<QueuedCommand | undefined>
  candidate?: ReceiptLocator
}
const scopes = new AsyncLocalStorage<ReceiptScope>()
// Actual ShellCommand identity, not stdout, arguments or an environment flag.
const shells = new WeakMap<ShellCommand, ReceiptScope>()
export function bindReceiptShellCommand(shell: ShellCommand): void {
  const scope = scopes.getStore()
  if (scope?.toolName === 'Bash') shells.set(shell, scope)
}
export function markReceiptShellBackground(shell: ShellCommand): void {
  const scope = shells.get(shell)
  if (scope) scope.backgrounded = true
}
export async function receiptShellNotification(shell: ShellCommand): Promise<QueuedCommand | undefined> {
  const scope = shells.get(shell)
  if (!scope?.backgrounded) return undefined
  try { return await scope.backgroundNotification?.() }
  catch { return undefined } // Ordinary/rejected/unknown shells retain their failure notice.
}

const platformServer = 'openclaude-memory'
const mcpNames = ['delegate_task', 'delegate_wait'].map(name => buildMcpToolName(platformServer, name))
/** Child shells inherit identity only inside their own actual native Bash call. */
export function receiptShellEnvironment(): Record<string, string | undefined> {
  return { [RECEIPT_CAP_ENV]: undefined, [RECEIPT_REPORT_ENV]: undefined, [RECEIPT_CACHE_ENV]: undefined, ...scopes.getStore()?.env }
}

/** Only the co-located, gateway-configured stdio server receives capabilities.
 * A same-named remote/SDK server or arbitrary local executable is not enrolled. */
export function receiptMcpRequest(serverName: string, toolName: string, toolUseId: string | undefined,
  config: { type?: string; command?: string; args?: string[]; env?: Record<string, string> }) {
  const scope = scopes.getStore()
  if (!scope || !mcpNames.includes(scope.mcpToolName ?? scope.toolName)) return undefined
  if (serverName !== platformServer || (scope.mcpToolName ?? scope.toolName) !== buildMcpToolName(serverName, toolName) || scope.toolUseId !== toolUseId) {
    throw new Error('receipt MCP actual tool mismatch')
  }
  const entry = (relative: string) => {
    try { return realpathSync(fileURLToPath(new URL(relative, import.meta.url))) } catch { return undefined }
  }
  const source = entry('../../../packages/mcp-memory/src/index.ts')
  const bundle = entry('../../../packages/mcp-memory/dist/oc-memory-mcp.cjs')
  let actual: string | undefined
  try { actual = realpathSync(config.args?.at(-1) || '') } catch { /* rejected below */ }
  const args = config.args || []
  const isSource = actual && actual === source && config.command === 'npx' && args.length === 2 && args[0] === 'tsx'
  const isBundle = actual && actual === bundle && config.command === '/usr/local/bin/node' && args.length === 1
  if ((config.type && config.type !== 'stdio') || (!isSource && !isBundle) ||
      !process.env.OPENCLAUDE_DELEGATE_CONTEXT_FILE || config.env?.OPENCLAUDE_DELEGATE_CONTEXT_FILE !== process.env.OPENCLAUDE_DELEGATE_CONTEXT_FILE) {
    throw new Error('receipt MCP requires built-in stdio transport')
  }
  return {
    meta: { [RECEIPT_MCP_META]: { capability: scope.capability }, 'claudecode/toolUseId': scope.toolUseId },
    capture(meta?: Record<string, unknown>) {
      if (meta?.[RECEIPT_MCP_RESULT_META] === undefined) return
      if (scope.candidate) throw new Error('multiple MCP results require composite admission')
      scope.candidate = parseReceiptLocator(meta[RECEIPT_MCP_RESULT_META])
    },
  }
}

export async function prepareReceiptToolInvocation(opts: {
  toolUseId: string; assistantMessage: AssistantMessage; agentId?: string
}): Promise<{ run<T>(fn: () => Promise<T>): Promise<T>; input(): Promise<UserMessage | undefined> } | undefined> {
  // Staging wiring switch, NOT the gateway's v2 new-job admission. It remains
  // off until the full C0 caller/background/compatibility verification completes.
  if (process.env.OPENCLAUDE_RECEIPT_CALLER_V2 !== '1' || opts.agentId) return undefined
  const blocks = opts.assistantMessage.message.content
  const block = Array.isArray(blocks) ? blocks.filter(b => b.type === 'tool_use' && b.id === opts.toolUseId) : []
  if (block.length !== 1 || block[0]?.type !== 'tool_use') throw new Error('receipt invocation requires actual SDK tool')
  const toolName = block[0].name
  const mcpToolName = receiptMcpTargetForSdk(toolName, block[0].input)
  if (toolName !== 'Bash' && !mcpNames.includes(toolName) && !mcpToolName) return undefined
  const nativeSessionId = getSessionId()
  const headers = gatewayDelegateHeaders()
  let response!: { statusCode: number; body: string }
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await postJsonToGateway(gatewayBaseUrl() + '/api/delegate/receipt-owner/issue', {
      headers, body: JSON.stringify({ toolUseId: opts.toolUseId }), timeoutMs: 5000,
    })
    if (response.statusCode !== 409 || attempt === 3) break
    await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
  }
  if (response.statusCode !== 200) throw new Error(`receipt invocation rejected (${response.statusCode})`)
  const { capability } = JSON.parse(response.body) as { capability?: string }
  if (typeof capability !== 'string') throw new Error('receipt invocation capability missing')
  // Authority is the authenticated HTTP response; decoding merely checks its
  // binding against the actual native process before passing it to a child.
  const claims = JSON.parse(Buffer.from(capability.split('.')[0]!, 'base64url').toString())
  if (claims.nativeSessionId !== nativeSessionId || getSessionId() !== nativeSessionId ||
      claims.consumerToolUseId !== opts.toolUseId || claims.toolName !== block[0].name || claims.receiptMcpTarget !== mcpToolName) throw new Error('receipt invocation native mismatch')
  const home = process.env.OPENCLAUDE_HOME?.trim() || join(homedir(), '.openclaude')
  const scope: ReceiptScope = { toolUseId: opts.toolUseId, toolName, capability, mcpToolName }
  let report: string | undefined
  if (toolName === 'Bash') {
    const root = join(home, 'receipt-invocations')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const dir = await mkdtemp(join(root, 'call-'))
    report = join(dir, 'locator.json')
    scope.env = Object.freeze({ [RECEIPT_CAP_ENV]: capability, [RECEIPT_REPORT_ENV]: report,
      [RECEIPT_CACHE_ENV]: join(home, 'receipt-locators') })
  }
  const readLocator = async () => {
    if (!report) return scope.candidate
    let raw: string
    try { raw = await readFile(report, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    return parseReceiptLocator(JSON.parse(raw))
  }
  const input = async (locator: ReceiptLocator, backgroundNotification = false) => {
    const { openReceiptDelivery } = await import('./receiptSqlite.js')
    const { createHttpReceiptInput } = await import('./receiptHttpInput.js')
    const delivery = await openReceiptDelivery(process.env.OPENCLAUDE_DELEGATE_JOBS_DB?.trim() || join(home, 'delegate-jobs.db'))
    try {
      return await createHttpReceiptInput({ ...opts, locator, delivery, releaseDelivery: () => delivery.close(),
        ...(backgroundNotification ? { backgroundNotification: true, capability } : {}) })
    } catch (error) { delivery.close(); throw error }
  }
  scope.backgroundNotification = async () => {
    const locator = await readLocator()
    if (!locator) return undefined
    const status = await postJsonToGateway(gatewayBaseUrl() + '/api/delegate/receipt-owner/status', {
      headers: gatewayDelegateHeaders(), body: JSON.stringify({ ...locator, capability }), timeoutMs: 5000,
    })
    if (status.statusCode !== 200 || JSON.parse(status.body).status !== 'ready') return undefined
    // Do not open a DB or fetch result bytes until the real query input boundary.
    return createQueuedReceiptInput(() => input(locator, true))
  }
  return {
    run: fn => scopes.run(scope, fn),
    input: async () => {
      if (scope.backgrounded) return undefined
      const locator = await readLocator()
      return locator ? input(locator) : undefined
    },
  }
}
