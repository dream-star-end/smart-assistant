/** Per-request MCP channel. No global env mutation, arbitrary report path or ACK. */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ReceiptCliTransport, RECEIPT_CAP_ENV, RECEIPT_CACHE_ENV, RECEIPT_REPORT_ENV, type ReceiptLocator } from './receiptCliTransport.js'
import { runDelegateStartAndWait, type DelegateCliArgs } from './delegateStartCli.js'
import { runDelegateWaitLoop } from './delegateWaitCli.js'
import { resolveMcpDelegateWaitMs } from './delegateWaitMcp.js'
import { resolveCursorFastWaitMs } from './delegateCursorFastPath.js'
import { gatewayBaseUrl, gatewayDelegateHeaders, postJsonToGateway, DELEGATE_CONTEXT_HEADER } from './gatewayClient.js'

export const RECEIPT_MCP_META = 'openclaude/receipt-v2'
export const RECEIPT_MCP_RESULT_META = 'openclaude/receipt-locator'

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
    [RECEIPT_REPORT_ENV]: undefined, [RECEIPT_CACHE_ENV]: join(home, 'receipt-locators'),
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
      const locator = receipt.lookup(jobId)
      if (!locator) throw new Error('receipt locator unavailable; do not resubmit the job')
      return result(await runDelegateWaitLoop({ jobIds: [jobId],
        waitOnce: (_id, ms) => receipt.wait(locator, ms), pollWaitMs: 1000,
        foregroundBudgetMs: resolveMcpDelegateWaitMs(waitMs),
      }))
    },
  }
}
