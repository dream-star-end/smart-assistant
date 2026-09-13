import type { QueuedCommand } from '../types/textInputTypes.js'
import type { UserMessage } from '../types/message.js'
import { createUserMessage } from './messages.js'

const pending = new WeakMap<QueuedCommand, () => Promise<UserMessage>>()
const neutral = '后台子任务已结束，结果交付由持久收据协调。'

/** Only internal, authenticated shell enrollment can attach a resolver. Neither
 * queue logs nor reconstructed command objects contain result bytes/authority. */
export function createQueuedReceiptInput(resolve: () => Promise<UserMessage>): QueuedCommand {
  const command: QueuedCommand = { value: neutral, mode: 'task-notification', priority: 'next' }
  pending.set(command, resolve)
  return command
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
  const resolve = pending.get(command)
  pending.delete(command)
  // A stopped/expired parent leaves delivery to the existing durable recovery
  // path. Never reconstruct a second tool_result for the background placeholder.
  try { if (resolve) return await resolve() } catch { /* no original bytes admitted */ }
  return createUserMessage({ content: neutral })
}
