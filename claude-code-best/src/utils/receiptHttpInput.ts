import { receiptMcpTargetForSdk } from '../../../packages/gateway/src/receiptOwnerCapability.js'
/** Native-only receipt consumer. Wire/stdout material is an untrusted locator;
 * result bytes, immutable creator and consumer come from authenticated HTTP.
 * Ordinary tools/CLI are NOT enrolled until the complete C0 registration. */
import { createHash } from 'node:crypto'
import type { ReceiptDeliveryCoordinator, TrustedReceiptBinding } from '../../../packages/storage/src/receiptDeliveryCoordinator.js'
import type { ReceiptOwnerClaims } from '../../../packages/gateway/src/receiptOwnerCapability.js'
import { gatewayBaseUrl, gatewayDelegateHeaders, postJsonToGateway, DELEGATE_CONTEXT_HEADER } from '../../../packages/mcp-memory/src/gatewayClient.js'
import { formatDelegateHttpResult } from '../../../packages/mcp-memory/src/delegateCursorFastPath.js'
import { getSessionId } from '../bootstrap/state.js'
import type { AssistantMessage, UserMessage } from '../types/message.js'
import { createUserMessage } from './messages.js'
import { bindReceiptInput } from './receiptInputAdmission.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export async function createHttpReceiptInput(opts: {
  locator: { jobId: string; generation: number; receiptNonce: string }
  toolUseId: string
  assistantMessage: AssistantMessage
  agentId?: string
  delivery?: ReceiptDeliveryCoordinator
  /** Native factory: acquire only inside ingest, after strict preparation. */
  openDelivery?: () => Promise<ReceiptDeliveryCoordinator>
  releaseDelivery?: () => void
  /** Internal actual ShellCommand enrollment only; never read from HTTP/body. */
  backgroundNotification?: boolean
  /** Internal compound Bash input; retains actual SDK consumer verification. */
  compoundText?: boolean
  capability?: string
}): Promise<UserMessage> {
  if (opts.agentId) throw new Error('receipt consumption requires the native main thread')
  const sourceId = opts.assistantMessage.uuid
  const nativeSessionId = getSessionId()
  const toolUseId = opts.toolUseId
  const content = opts.assistantMessage.message.content
  if (!Array.isArray(content)) throw new Error('receipt consumer must be an actual native tool')
  const tools = content.filter(b => b.type === 'tool_use' && b.id === toolUseId)
  if (tools.length !== 1 || tools[0]?.type !== 'tool_use') throw new Error('receipt consumer must be an actual native tool')
  const toolName = tools[0].name
  const locator = Object.freeze({ ...opts.locator })
  if ((!opts.delivery && !opts.openDelivery) || (opts.delivery && opts.openDelivery)) throw new Error('one receipt coordinator required')
  const headers = Object.freeze({ ...gatewayDelegateHeaders() })
  const base = `${gatewayBaseUrl()}/api/delegate/receipt-owner/`
  if (!headers[DELEGATE_CONTEXT_HEADER] || !headers.Authorization?.replace(/^Bearer\s*/, '')) {
    throw new Error('receipt HTTP credentials unavailable')
  }
  const post = async (action: string, body: unknown) => {
    for (let attempt = 0; ; attempt++) {
      const response = await postJsonToGateway(base + action, { headers, body: JSON.stringify(body), timeoutMs: 5000 })
      // SDK stdout registration and tool HTTP can briefly race. Retry only
      // unavailable ISSUE, same native identity, bounded; never rebind/fallback.
      if (action === 'issue' && response.statusCode === 409 && attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
        continue
      }
      if (response.statusCode !== 200) throw new Error(`receipt ${action} rejected (${response.statusCode})`)
      return JSON.parse(response.body)
    }
  }
  // No stdout parsing or caller-supplied epoch. Actual SDK ID is looked up by
  // the gateway, then checked again against this actual native session/tool.
  const issued = opts.backgroundNotification && opts.capability
    ? { capability: opts.capability } : await post('issue', { toolUseId })
  if (typeof issued.capability !== 'string') throw new Error('missing receipt consumer capability')
  const capability: string = issued.capability
  const offered = await post('input', { ...locator, capability })
  const consumer = offered.consumer as ReceiptOwnerClaims
  const rawBinding = offered.binding as TrustedReceiptBinding
  const resultJson: unknown = offered.resultJson
  if (!consumer || !rawBinding || consumer.nativeSessionId !== nativeSessionId || getSessionId() !== nativeSessionId ||
      consumer.consumerToolUseId !== toolUseId || consumer.toolName !== toolName || consumer.receiptMcpTarget !== receiptMcpTargetForSdk(toolName, tools[0].input) || !consumer.parentOwnerEpoch ||
      rawBinding.userId !== consumer.userId || rawBinding.parentSession !== consumer.sessionKey ||
      rawBinding.parentTurnKey !== consumer.turnKey || rawBinding.jobId !== locator.jobId || rawBinding.generation !== locator.generation ||
      rawBinding.receiptNonceHash !== hash(locator.receiptNonce) || typeof resultJson !== 'string' || hash(resultJson) !== rawBinding.resultDigest) {
    throw new Error('receipt input binding mismatch')
  }
  // Whitelist the immutable CREATE-time identity. Independent wait's tool ID
  // belongs only to the separate consumer, never replaces nativeToolUseId here.
  const binding: TrustedReceiptBinding = Object.freeze({ jobId: rawBinding.jobId, generation: rawBinding.generation,
    userId: rawBinding.userId, parentSession: rawBinding.parentSession, parentTurnKey: rawBinding.parentTurnKey,
    nativeToolUseId: rawBinding.nativeToolUseId, receiptNonceHash: rawBinding.receiptNonceHash, resultDigest: rawBinding.resultDigest })
  const epoch = consumer.parentOwnerEpoch
  const result = JSON.parse(resultJson)
  const text = formatDelegateHttpResult(result.httpStatus, result.body, binding.jobId).text
  const message = opts.backgroundNotification || opts.compoundText
    ? createUserMessage({ content: [{ type: 'text', text }] })
    : createUserMessage({ content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }], sourceToolAssistantUUID: sourceId })
  // Final canonical text is made here, not copied from arbitrary CLI stdout or
  // post-tool hooks. Prevent later mutation before the input admission boundary.
  if (Array.isArray(message.message.content)) {
    message.message.content.forEach(Object.freeze)
    Object.freeze(message.message.content)
  }
  Object.freeze(message.message)
  Object.freeze(message)
  bindReceiptInput(message, {
    marker: { jobId: binding.jobId, generation: binding.generation, resultDigest: binding.resultDigest },
    ingest: async (proof, write, oracle) => {
      if (proof.nativeSessionId !== nativeSessionId) throw new Error('receipt native proof session changed')
      const delivery = opts.delivery ?? await opts.openDelivery!()
      try { return await delivery.ingest(binding, { parentOwnerEpoch: epoch, proof, isCurrentParentOwner: async () => {
        if (getSessionId() !== nativeSessionId) return false
        const checked = await post('check', { capability })
        return getSessionId() === nativeSessionId && checked.ownerState === 'active'
      } }, write, oracle) }
      finally { if (opts.openDelivery) delivery.close(); else opts.releaseDelivery?.() }
    },
  })
  return message
}
