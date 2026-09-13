import type { ReceiptDeliveryCoordinator, TrustedReceiptBinding } from '../../../packages/storage/src/receiptDeliveryCoordinator.js'
import type { UserMessage } from '../types/message.js'
import { bindReceiptInput } from './receiptInputAdmission.js'
export { openReceiptDelivery } from './receiptSqlite.js'

/**
 * Internal adapter, NOT a wire/authentication entry point. Call only after
 * trusted transport has bound the immutable job, result digest and native tool.
 * Parent-owner verification must come from that transport, never model output.
 */
export function bindCoordinatedReceiptInput(
  message: UserMessage,
  delivery: ReceiptDeliveryCoordinator,
  binding: TrustedReceiptBinding,
  parent: Readonly<{
    epoch: string
    isCurrentOwner: () => Promise<boolean>
  }>,
): void {
  const content = message.message.content
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    content[0]?.type !== 'tool_result' ||
    content[0].tool_use_id !== binding.nativeToolUseId
  ) throw new Error('receipt input must match exactly one bound native tool result')
  const identity = Object.freeze({ ...binding })
  const epoch = parent.epoch
  const isCurrentOwner = parent.isCurrentOwner
  bindReceiptInput(message, {
    marker: {
      jobId: identity.jobId,
      generation: identity.generation,
      resultDigest: identity.resultDigest,
    },
    ingest: (proof, write, oracle) => delivery.ingest(
      identity,
      { parentOwnerEpoch: epoch, proof, isCurrentParentOwner: isCurrentOwner },
      write,
      oracle,
    ),
  })
}
