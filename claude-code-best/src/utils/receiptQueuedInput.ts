import type { QueuedCommand } from '../types/textInputTypes.js'
import type { UserMessage } from '../types/message.js'
import { createUserMessage } from './messages.js'
import { createDeferredReceiptInput } from './receiptInputAdmission.js'

type PendingReceiptInputs = Readonly<{
  resolvers: readonly (() => Promise<UserMessage>)[]
  keepOrdinary: boolean
}>
const pending = new WeakMap<QueuedCommand, PendingReceiptInputs>()
const neutral = '后台子任务已结束，结果交付由持久收据协调。'

/** Only internal, authenticated shell enrollment can attach a resolver. Neither
 * queue logs nor reconstructed command objects contain result bytes/authority. */
export function createQueuedReceiptInput(resolve: () => Promise<UserMessage>): QueuedCommand {
  const command: QueuedCommand = { value: neutral, mode: 'task-notification', priority: 'next' }
  pending.set(command, Object.freeze({ resolvers: Object.freeze([resolve]), keepOrdinary: false }))
  return command
}

/** One original shell notification plus independent, lazy receipt inputs. The
 * public queue/log value has no receipt bytes, nonce or admission authority. */
export function createQueuedReceiptInputs(
  resolvers: readonly (() => Promise<UserMessage>)[],
  ordinary: QueuedCommand,
): QueuedCommand {
  if (!resolvers.length || resolvers.length > 64) throw new Error('invalid queued receipt count')
  const command: QueuedCommand = { ...ordinary, priority: 'next' }
  pending.set(command, Object.freeze({ resolvers: Object.freeze([...resolvers]), keepOrdinary: true }))
  return command
}

/** Take once. Resolve/ingest only at query's actual input boundary, one at a
 * time; a strict write failure must escape and stop all later receipts. */
export function takeQueuedReceiptInputs(command: QueuedCommand): {
  keepOrdinary: boolean; messages: UserMessage[]
} | undefined {
  const entry = pending.get(command)
  pending.delete(command)
  return entry && { keepOrdinary: entry.keepOrdinary,
    messages: entry.resolvers.map(resolve => createDeferredReceiptInput(resolve)) }
}

/** The existing queue makes exactly one shallow copy on enqueue. */
export function transferQueuedReceiptInput(source: QueuedCommand, target: QueuedCommand): void {
  const resolve = pending.get(source)
  if (resolve) {
    pending.delete(source)
    pending.set(target, resolve)
  }
}

export function hasQueuedReceiptInput(command: QueuedCommand): boolean {
  return pending.has(command)
}

export async function resolveQueuedReceiptInput(command: QueuedCommand): Promise<UserMessage> {
  const entry = pending.get(command)
  pending.delete(command)
  if (entry && (entry.keepOrdinary || entry.resolvers.length !== 1)) {
    throw new Error('compound receipt requires batch input admission')
  }
  // A stopped/expired parent leaves delivery to the existing durable recovery
  // path. Never reconstruct a second tool_result for the background placeholder.
  try { if (entry) return await entry.resolvers[0]!() } catch { /* no original bytes admitted */ }
  return createUserMessage({ content: neutral })
}
