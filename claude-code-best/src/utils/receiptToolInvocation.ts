import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AssistantMessage, UserMessage } from '../types/message.js'
import { getSessionId } from '../bootstrap/state.js'
import { RECEIPT_CAP_ENV, RECEIPT_REPORT_ENV, RECEIPT_CACHE_ENV, parseReceiptLocator } from '../../../packages/mcp-memory/src/receiptCliTransport.js'
import { gatewayBaseUrl, gatewayDelegateHeaders, postJsonToGateway } from '../../../packages/mcp-memory/src/gatewayClient.js'

const scopes = new AsyncLocalStorage<Readonly<Record<string, string>>>()
/** Called only by the actual Shell spawn, never mutates process.env. Clear
 * inherited identity outside a native main-thread tool (including subagents). */
export function receiptShellEnvironment(): Record<string, string | undefined> {
  return { [RECEIPT_CAP_ENV]: undefined, [RECEIPT_REPORT_ENV]: undefined, [RECEIPT_CACHE_ENV]: undefined, ...scopes.getStore() }
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
  // MCP enrollment is a separate per-request meta transport, not process env.
  if (block[0].name !== 'Bash') return undefined
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
      claims.consumerToolUseId !== opts.toolUseId || claims.toolName !== block[0].name) throw new Error('receipt invocation native mismatch')
  const home = process.env.OPENCLAUDE_HOME?.trim() || join(homedir(), '.openclaude')
  const root = join(home, 'receipt-invocations')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(root, 'call-'))
  const report = join(dir, 'locator.json')
  const env = Object.freeze({ [RECEIPT_CAP_ENV]: capability, [RECEIPT_REPORT_ENV]: report,
    [RECEIPT_CACHE_ENV]: join(home, 'receipt-locators') })
  return {
    run: fn => scopes.run(env, fn),
    input: async () => {
      let raw: string
      try { raw = await readFile(report, 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
      const locator = parseReceiptLocator(JSON.parse(raw))
      const { openReceiptDelivery } = await import('./receiptSqlite.js')
      const { createHttpReceiptInput } = await import('./receiptHttpInput.js')
      const delivery = await openReceiptDelivery(process.env.OPENCLAUDE_DELEGATE_JOBS_DB?.trim() || join(home, 'delegate-jobs.db'))
      try {
        return await createHttpReceiptInput({ ...opts, locator, delivery, releaseDelivery: () => delivery.close() })
      } catch (error) { delivery.close(); throw error }
    },
  }
}
