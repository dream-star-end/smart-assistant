import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

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

const {
  enqueue,
  enqueuePendingNotification,
  getCommandsByMaxPriority,
  remove: removeFromQueue,
  resetCommandQueue,
  selectMidTurnDrainCommands,
  taskIdFromQueuedCommand,
} = await import('../messageQueueManager.js')
const { ackMidTurnDeliveredTaskNotifications } = await import('../taskNotificationAck.js')

beforeEach(() => {
  resetCommandQueue()
})

afterEach(() => {
  resetCommandQueue()
})

describe('selectMidTurnDrainCommands task-notification insurance', () => {
  test('includes later task-notification without Sleep and clears the queue', () => {
    enqueuePendingNotification({
      value:
        '<task-notification>\n<task-id>agt-drain-1</task-id>\n<summary>done</summary>\n</task-notification>',
      mode: 'task-notification',
    })
    enqueue({
      value: 'user later prompt',
      mode: 'prompt',
      priority: 'later',
    } as any)

    const selected = selectMidTurnDrainCommands({
      sleepRan: false,
      isMainThread: true,
    })
    expect(selected).toHaveLength(1)
    expect(selected[0]!.mode).toBe('task-notification')
    expect(String(selected[0]!.value)).toContain('<task-notification>')
    expect(String(selected[0]!.value)).toContain('<task-id>agt-drain-1</task-id>')

    removeFromQueue(selected)
    expect(getCommandsByMaxPriority('later').filter((c: any) => c.mode === 'task-notification')).toHaveLength(0)
    expect(getCommandsByMaxPriority('later').some((c: any) => c.value === 'user later prompt')).toBe(true)
  })

  test('main thread ignores agent-scoped task-notifications', () => {
    enqueuePendingNotification({
      value: '<task-notification><task-id>agt-sub</task-id></task-notification>',
      mode: 'task-notification',
      agentId: 'sub-1' as any,
    } as any)

    expect(
      selectMidTurnDrainCommands({ sleepRan: false, isMainThread: true }),
    ).toHaveLength(0)
    expect(
      selectMidTurnDrainCommands({
        sleepRan: false,
        isMainThread: false,
        currentAgentId: 'sub-1',
      }),
    ).toHaveLength(1)
  })

  test('without Sleep, later prompts stay queued', () => {
    enqueue({ value: 'later only', mode: 'prompt', priority: 'later' } as any)
    expect(
      selectMidTurnDrainCommands({ sleepRan: false, isMainThread: true }),
    ).toHaveLength(0)
    expect(
      selectMidTurnDrainCommands({ sleepRan: true, isMainThread: true }),
    ).toHaveLength(1)
  })
})


describe('mid-turn consume emits delivered ack (blocker 2 counterpart)', () => {
  test('after select+remove, ack uses the queued taskId', () => {
    enqueuePendingNotification({
      value: '<task-notification><task-id>agt-drain-ack</task-id></task-notification>',
      mode: 'task-notification',
      taskId: 'agt-drain-ack',
    } as any)
    const selected = selectMidTurnDrainCommands({
      sleepRan: false,
      isMainThread: true,
    })
    expect(selected).toHaveLength(1)
    expect(taskIdFromQueuedCommand(selected[0]!)).toBe('agt-drain-ack')
    removeFromQueue(selected)
    const delivered = ackMidTurnDeliveredTaskNotifications(selected)
    expect(delivered).toEqual(['agt-drain-ack'])
  })
})
