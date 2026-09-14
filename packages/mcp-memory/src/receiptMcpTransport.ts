/** Per-request MCP channel. No global env mutation, arbitrary report path or ACK. */
import { MAX_FANOUT_TASKS, type FanoutTask } from './delegateFanout.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ReceiptCliTransport, RECEIPT_CAP_ENV, RECEIPT_CACHE_ENV, RECEIPT_REPORT_ENV, type ReceiptLocator } from './receiptCliTransport.js'
import { runDelegateStartAndWait, type DelegateCliArgs } from './delegateStartCli.js'
import { runDelegateWaitLoop } from './delegateWaitCli.js'
import { resolveMcpDelegateWaitMs } from './delegateWaitMcp.js'
import { resolveCursorFastWaitMs } from './delegateCursorFastPath.js'
import { gatewayBaseUrl, gatewayDelegateHeaders, postJsonToGateway, describeDelegateTransportError, DELEGATE_CONTEXT_HEADER } from './gatewayClient.js'

export const RECEIPT_MCP_META = 'openclaude/receipt-v2'
export const RECEIPT_MCP_RESULT_META = 'openclaude/receipt-locator'
export const RECEIPT_MCP_RESULTS_META = 'openclaude/receipt-locators'

export function createReceiptMcpTransport(meta?: Record<string, unknown>) {
  const value = meta?.[RECEIPT_MCP_META]
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Object.keys(value).join(',') !== 'capability' ||
      typeof (value as { capability?: unknown }).capability !== 'string' || !(value as { capability: string }).capability) {
    throw new Error('invalid MCP receipt metadata')
  }
  let candidate: ReceiptLocator | undefined
  const home = process.env.OPENCLAUDE_HOME?.trim() || join(homedir(), '.openclaude')
  const receipt = new ReceiptCliTransport({ ...process.env,
    [RECEIPT_CAP_ENV]: (value as { capability: string }).capability,
    [RECEIPT_REPORT_ENV]: undefined, [RECEIPT_CACHE_ENV]: join(home, 'receipt-candidates-v1'),
  }, locator => {
    if (candidate) throw new Error('multiple receipt results require composite admission')
    candidate = locator
  })
  const headers = Object.freeze(gatewayDelegateHeaders())
  const forbiddenLegacyWait = async (): Promise<never> => { throw new Error('receipt cannot use legacy consumption') }
  const result = (r: { exitCode: number; stdout: string; stderr: string }) => ({
    content: [{ type: 'text' as const, text: r.stdout || r.stderr }],
    ...(r.exitCode !== 0 ? { isError: true } : {}),
    ...(candidate ? { _meta: { [RECEIPT_MCP_RESULT_META]: candidate } } : {}),
  })
  return {
    async start(args: DelegateCliArgs) {
      return result(await runDelegateStartAndWait({ args, receipt,
        contextToken: headers[DELEGATE_CONTEXT_HEADER]!, pollWaitMs: 1000, foregroundBudgetMs: resolveCursorFastWaitMs(),
        start: (agent, body) => postJsonToGateway(`${gatewayBaseUrl()}/api/agents/${encodeURIComponent(agent)}/delegate`, { headers, body, timeoutMs: 15000 }),
        waitOnce: forbiddenLegacyWait,
      }))
    },
    async wait(jobId: string, waitMs: unknown) {
      const locator = await receipt.lookup(jobId).catch(() => undefined)
      return result(await runDelegateWaitLoop({ jobIds: [jobId],
        waitOnce: (_id, ms) => locator ? receipt.wait(locator, ms) : receipt.handoff(jobId), pollWaitMs: 1000,
        foregroundBudgetMs: resolveMcpDelegateWaitMs(waitMs),
      }))
    },
  }
}

/** index validates all tasks first. Every child has its own nonce/candidate;
 * only immutable per-request metadata is shared, never global environment. */
export async function startReceiptMcpBatch(tasks: FanoutTask[], meta: Record<string, unknown>) {
  if (tasks.length < 1 || tasks.length > MAX_FANOUT_TASKS) throw new Error('invalid receipt batch size')
  const children = tasks.map(() => {
    const child = createReceiptMcpTransport(meta)
    if (!child) throw new Error('receipt batch metadata required')
    return child
  })
  const items = await Promise.all(tasks.map(async (task, i) => {
    const label = task.agentId || 'main'
    try {
      const result = await children[i]!.start({ ...task, agentId: label })
      return { label, goal: task.goal, isError: result.isError === true,
        text: result.content.map(item => item.text).join('\n'),
        locator: result._meta?.[RECEIPT_MCP_RESULT_META] }
    } catch (error) {
      return { label, goal: task.goal, isError: true,
        text: `委派请求或等待失败: ${describeDelegateTransportError(error)}`, locator: undefined }
    }
  }))
  const errors = items.filter(item => item.isError).length
  const header = `批量委派 ${items.length} 项请求已返回，${errors} 项请求或等待异常。最终执行结论由各项持久结果单独交付。`
  const sections = items.map((item, i) =>
    `### ${i + 1}. ${item.isError ? '❌ 请求/等待异常' : '请求已返回'} ${item.label} — ${item.goal.slice(0, 60)}\n${item.text}`)
  // A partial child failure is NOT a top-level MCP error: the real client throws
  // before capture on isError. Preserve visible per-item errors and good metadata.
  return { content: [{ type: 'text' as const, text: [header, ...sections].join('\n\n') }],
    _meta: { [RECEIPT_MCP_RESULTS_META]: items.flatMap(item => item.locator ? [item.locator] : []) } }
}
