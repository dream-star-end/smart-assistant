import type { QueuedCommand } from '../types/textInputTypes.js'
import { taskIdFromQueuedCommand } from './messageQueueManager.js'
import { emitTaskNotificationDeliveredSdk } from './sdkEventQueue.js'

/**
 * Mid-turn drain actually consumed these queue items. Emit an immediate
 * stdout ack so the gateway will not origin-inject the same taskId.
 */
export function ackMidTurnDeliveredTaskNotifications(
  commands: readonly QueuedCommand[],
): string[] {
  const delivered: string[] = []
  for (const cmd of commands) {
    if (cmd.mode !== 'task-notification') continue
    const taskId = taskIdFromQueuedCommand(cmd)
    if (!taskId) continue
    emitTaskNotificationDeliveredSdk(taskId)
    delivered.push(taskId)
  }
  return delivered
}
