import type { ShellCommand } from './ShellCommand.js'
import { createQueuedReceiptInput, createQueuedReceiptInputs } from './receiptQueuedInput.js'
import { createDeferredReceiptInput } from './receiptInputAdmission.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { receiptMcpTargetForSdk } from '../../../packages/gateway/src/receiptOwnerCapability.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildMcpToolName } from '../services/mcp/mcpStringUtils.js'
import { RECEIPT_MCP_META, RECEIPT_MCP_RESULT_META, RECEIPT_MCP_RESULTS_META } from '../../../packages/mcp-memory/src/receiptMcpTransport.js'
import { homedir } from 'node:os'
import type { AssistantMessage, UserMessage } from '../types/message.js'
import { getSessionId } from '../bootstrap/state.js'
import { RECEIPT_CAP_ENV, RECEIPT_REPORT_ENV, RECEIPT_CACHE_ENV, parseReceiptLocator, parseReceiptLocatorCollection, snapshotReceiptReport, type ReceiptLocator } from '../../../packages/mcp-memory/src/receiptCliTransport.js'
import { gatewayBaseUrl, gatewayDelegateHeaders, postJsonToGateway } from '../../../packages/mcp-memory/src/gatewayClient.js'

type ReceiptScope = {
  collection?: ReturnType<typeof parseReceiptLocatorCollection>
  toolUseId: string; toolName: string; capability: string; mcpToolName?: string
  env?: Readonly<Record<string, string>>
  backgrounded?: boolean
  backgroundNotification?: (ordinary?: QueuedCommand, preserveOrdinary?: boolean) => Promise<QueuedCommand | undefined>
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
/** Bash has not yielded a background placeholder: its real completion won the
 * handoff race. Restore the foreground canonical path before muting shell notify. */
export function markReceiptShellForegroundResult(shell: ShellCommand): void {
  const scope = shells.get(shell)
  if (scope) scope.backgrounded = false
}
export async function receiptShellNotification(shell: ShellCommand, ordinary?: QueuedCommand, preserveOrdinary = false): Promise<QueuedCommand | undefined> {
  const scope = shells.get(shell)
  if (!scope?.backgrounded) return undefined
  try { return await scope.backgroundNotification?.(ordinary, preserveOrdinary) }
  catch { return undefined } // Ordinary/rejected/unknown shells retain their failure notice.
}

const platformServer = 'openclaude-memory'
const mcpBatchName = buildMcpToolName(platformServer, 'delegate_tasks')
const mcpNames = ['delegate_task', 'delegate_wait', 'delegate_tasks'].map(name => buildMcpToolName(platformServer, name))
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
      const batch = (scope.mcpToolName ?? scope.toolName) === mcpBatchName
      if (batch) {
        if (meta?.[RECEIPT_MCP_RESULTS_META] === undefined && meta?.[RECEIPT_MCP_RESULT_META] === undefined) return
        if (scope.collection) throw new Error('duplicate MCP batch result capture')
        scope.collection = parseReceiptLocatorCollection(meta?.[RECEIPT_MCP_RESULTS_META])
        if (meta?.[RECEIPT_MCP_RESULT_META] !== undefined) scope.collection.invalid = true
        return
      }
      if (meta?.[RECEIPT_MCP_RESULTS_META] !== undefined) throw new Error('batch metadata on single receipt tool')
      if (meta?.[RECEIPT_MCP_RESULT_META] === undefined) return
      if (scope.candidate) throw new Error('multiple MCP results require composite admission')
      scope.candidate = parseReceiptLocator(meta[RECEIPT_MCP_RESULT_META])
    },
  }
}

export async function prepareReceiptToolInvocation(opts: {
  toolUseId: string; assistantMessage: AssistantMessage; agentId?: string
}): Promise<{ mode: 'replace' | 'append'; run<T>(fn: () => Promise<T>): Promise<T>;
  finish(): Promise<{ mode: 'replace' | 'append'; messages: UserMessage[] } | undefined> } | undefined> {
  // Staging wiring switch, NOT the gateway's v2 new-job admission. It remains
  // off until the full C0 caller/background/compatibility verification completes.
  if (process.env.OPENCLAUDE_RECEIPT_CALLER_V2 !== '1' || opts.agentId) return undefined
  const blocks = opts.assistantMessage.message.content
  const block = Array.isArray(blocks) ? blocks.filter(b => b.type === 'tool_use' && b.id === opts.toolUseId) : []
  if (block.length !== 1 || block[0]?.type !== 'tool_use') throw new Error('receipt invocation requires actual SDK tool')
  const toolName = block[0].name
  const mcpToolName = receiptMcpTargetForSdk(toolName, block[0].input)
  if (toolName !== 'Bash' && !mcpNames.includes(toolName) && !mcpToolName) return undefined
  const compound = toolName === 'Bash' || (mcpToolName ?? toolName) === mcpBatchName
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
    report = dir
    scope.env = Object.freeze({ [RECEIPT_CAP_ENV]: capability, [RECEIPT_REPORT_ENV]: report,
      [RECEIPT_CACHE_ENV]: join(home, 'receipt-locators') })
  }
  const readLocators = () => {
    if (scope.collection) return scope.collection
    if (!report) return { locators: scope.candidate ? [scope.candidate] : [], invalid: false }
    return snapshotReceiptReport(report)
  }
  const input = async (locator: ReceiptLocator, backgroundNotification = false, compoundText = false) => {
    const { openReceiptDelivery } = await import('./receiptSqlite.js')
    const { createHttpReceiptInput } = await import('./receiptHttpInput.js')
    return createHttpReceiptInput({ toolUseId: opts.toolUseId, assistantMessage: opts.assistantMessage,
      agentId: opts.agentId, locator, compoundText,
      openDelivery: () => openReceiptDelivery(process.env.OPENCLAUDE_DELEGATE_JOBS_DB?.trim() || join(home, 'delegate-jobs.db')),
      ...(backgroundNotification ? { backgroundNotification: true, capability } : {}) })
  }
  scope.backgroundNotification = async (ordinary, preserveOrdinary) => {
    const snapshot = readLocators()
    // Decide before filtering: one ready sibling must not turn a compound or
    // failed shell into the old single-receipt branch and hide its failure.
    const compound = snapshot.invalid || snapshot.locators.length > 1 || preserveOrdinary
    if (!snapshot.locators.length || (compound && !ordinary)) return undefined
    const candidates = await Promise.all(snapshot.locators.map(async locator => {
      try {
        const status = await postJsonToGateway(gatewayBaseUrl() + '/api/delegate/receipt-owner/status', {
          headers: gatewayDelegateHeaders(), body: JSON.stringify({ ...locator, capability }), timeoutMs: 5000,
        })
        return status.statusCode === 200 && JSON.parse(status.body).status === 'ready' ? locator : undefined
      } catch { return undefined }
    }))
    const ready = candidates.filter((locator): locator is ReceiptLocator => locator !== undefined)
    if (!scope.backgrounded || !ready.length) return undefined
    // Do not open a DB or fetch result bytes until the real query input boundary.
    return compound
      ? createQueuedReceiptInputs(ready.map(locator => () => input(locator, true)), ordinary!)
      : createQueuedReceiptInput(() => input(ready[0]!, true))
  }
  let finished: Promise<{ mode: 'replace' | 'append'; messages: UserMessage[] } | undefined> | undefined
  return {
    mode: compound ? 'append' : 'replace',
    run: fn => scopes.run(scope, fn),
    finish: () => finished ??= (async () => {
      if (scope.backgrounded) return undefined
      const { locators, invalid } = readLocators()
      if (!locators.length && !invalid) return undefined
      if (!compound) return { mode: 'replace' as const, messages: [await input(locators[0]!)] }
      const messages = locators.map(locator => createDeferredReceiptInput(() => input(locator, false, true)))
      if (invalid) messages.push(createDeferredReceiptInput(async () => { throw new Error('receipt candidate unavailable') }))
      return { mode: 'append' as const, messages }
    })(),
  }
}
