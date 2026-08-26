import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const emitted: Array<{ subtype: string; task_id: string; delivered_by?: string }> = []

mock.module('src/utils/debug.ts', () => ({
  isDebugMode: () => false,
  debug: () => {},
}))
mock.module('src/utils/log.ts', () => ({
  logError: () => {},
  logForDebugging: () => {},
}))
mock.module('src/bootstrap/state.js', () => ({
  getSessionId: () => 'test-session',
  getIsNonInteractiveSession: () => true,
  getProjectRoot: () => '/tmp',
}))
mock.module('src/utils/sessionStorage.js', () => ({
  recordQueueOperation: () => {},
}))
mock.module('src/utils/messages.js', () => ({
  extractTextContent: (v: unknown) => (typeof v === 'string' ? v : ''),
}))
mock.module('figures', () => ({ default: {} }))
mock.module('src/constants/outputStyles.ts', () => ({
  getOutputStyle: () => 'default',
}))
mock.module('ignore', () => ({
  default: () => ({ add: () => {}, ignores: () => false }),
}))
mock.module('axios', () => ({
  default: { get: async () => ({ data: {} }), post: async () => ({ data: {} }) },
}))
mock.module('@anthropic-ai/sdk', () => ({ default: class {} }))
mock.module('src/utils/sdkEventQueue.js', () => ({
  emitTaskNotificationDeliveredSdk: (taskId: string) => {
    emitted.push({
      subtype: 'task_notification_delivered',
      task_id: taskId,
      delivered_by: 'ccb-mid-turn',
    })
  },
}))

const { ackMidTurnDeliveredTaskNotifications } = await import('../taskNotificationAck.js')

beforeEach(() => {
  emitted.length = 0
})

afterEach(() => {
  emitted.length = 0
})

describe('ackMidTurnDeliveredTaskNotifications', () => {
  test('acks only consumed task-notification items and uses queued taskId', () => {
    const delivered = ackMidTurnDeliveredTaskNotifications([
      { value: 'user text', mode: 'prompt' } as any,
      {
        value: '<task-notification><task-id>ignored-xml</task-id></task-notification>',
        mode: 'task-notification',
        taskId: 'agt-from-field',
      } as any,
    ])
    expect(delivered).toEqual(['agt-from-field'])
    expect(emitted).toEqual([
      {
        subtype: 'task_notification_delivered',
        task_id: 'agt-from-field',
        delivered_by: 'ccb-mid-turn',
      },
    ])
  })

  test('falls back to XML task-id when QueuedCommand.taskId is missing', () => {
    const delivered = ackMidTurnDeliveredTaskNotifications([
      {
        value: '<task-notification><task-id>agt-xml</task-id></task-notification>',
        mode: 'task-notification',
      } as any,
    ])
    expect(delivered).toEqual(['agt-xml'])
  })
})
