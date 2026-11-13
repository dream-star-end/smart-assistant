import { expect, test, vi } from 'vitest'
import { ApiError } from '../api'
import { authorizeQueuedModelSwitch } from './modelSwitchCostDispatch'
import type { OfflineItem } from './socket'
import type { ChatSession } from './model'

function fixture() {
  const item = {
    sessId: 'own',
    msgId: 'm-kept',
    state: 'persisting',
    payload: {
      model: 'gpt-6-astra',
      content: { text: 'keep this message' },
    },
  } as OfflineItem
  const user = { id: item.msgId, role: 'user', status: 'queued', text: item.payload.content.text }
  const session = { id: item.sessId, messages: [user] } as ChatSession
  const queue = [item]
  const deps = {
    queue,
    slots: new Map([[item.sessId, item.msgId]]),
    sessions: new Map([[item.sessId, session]]),
    clear: vi.fn(() => {
      queue.splice(queue.indexOf(item), 1)
    }),
    notice: vi.fn(),
    persist: vi.fn(),
    notify: vi.fn(),
  }
  return { item, user, session, deps }
}

test.each([
  new TypeError('network'),
  new ApiError({ status: 503, code: 'MODEL_SWITCH_UNAVAILABLE', message: '暂不可用' }),
  new ApiError({ status: 409, code: 'MODEL_SWITCH_UNAVAILABLE', message: '暂不可用' }),
  new ApiError({ status: 502, message: 'upstream' }),
])(
  'transient cost failure keeps queued payload and permits a later authorized retry: %s',
  async (error) => {
    const f = fixture()
    const original = structuredClone(f.item.payload)
    expect(
      await authorizeQueuedModelSwitch(
        f.item,
        async () => {
          throw error
        },
        f.deps,
      ),
    ).toBe(false)
    expect(f.item.state).toBe('queued')
    expect(f.item.payload).toEqual(original)
    expect(f.deps.queue).toContain(f.item)
    expect(f.deps.slots.size).toBe(0)
    expect(f.session._dispatchPaused).not.toBe(true)
    expect(f.user.status).toBe('queued')
    expect(f.deps.clear).not.toHaveBeenCalled()
    expect(f.deps.notice).toHaveBeenCalledWith(
      'own',
      expect.stringContaining('费用信息暂不可用，消息已保留'),
    )
    f.item.state = 'persisting'
    f.deps.slots.set('own', 'm-kept')
    expect(
      await authorizeQueuedModelSwitch(
        f.item,
        async () => ({ requestId: 'm-kept', choice: true, consent: 'new-consent' }),
        f.deps,
      ),
    ).toBe(true)
    expect(f.item.payload.modelSwitchConsent).toBe('new-consent')
  },
)

test.each([
  ['MODEL_SWITCH_INSUFFICIENT_BALANCE', '余额不足'],
  ['MODEL_SWITCH_QUOTE_CHANGED', '报价已变化'],
  ['UNAUTHORIZED_MODEL', '没有模型权限'],
  ['MODEL_SWITCH_CONFIRMATION_REQUIRED', '费用需要确认'],
])(
  'business refusal %s keeps its own message and pauses for user action',
  async (code, message) => {
    const f = fixture()
    expect(
      await authorizeQueuedModelSwitch(
        f.item,
        async () => {
          throw new ApiError({ status: 409, code, message })
        },
        f.deps,
      ),
    ).toBe(false)
    expect(f.session._dispatchPaused).toBe(true)
    expect(f.session.messages[0]._errorCode).toBe(code)
    expect(f.session.messages[0]._errorDetail).toContain(message)
    expect(f.session.messages[0].text).toBe('keep this message')
    expect(f.deps.slots.size).toBe(0)
    expect(f.deps.clear).toHaveBeenCalledOnce()
  },
)

test('missing consent pauses with confirmation copy', async () => {
  const f = fixture()
  await authorizeQueuedModelSwitch(f.item, async () => null, f.deps)
  expect(f.session.messages[0]._errorCode).toBe('MODEL_SWITCH_CONFIRMATION_REQUIRED')
  expect(f.session._dispatchPaused).toBe(true)
})

test('a late refusal cannot mutate a queue cleared by identity change', async () => {
  const f = fixture()
  let reject!: (error: unknown) => void
  const pending = authorizeQueuedModelSwitch(
    f.item,
    () =>
      new Promise((_, no) => {
        reject = no
      }),
    f.deps,
  )
  f.deps.queue.length = 0
  f.deps.slots.clear()
  reject(
    new ApiError({ status: 409, code: 'MODEL_SWITCH_INSUFFICIENT_BALANCE', message: '余额不足' }),
  )
  await pending
  expect(f.deps.clear).not.toHaveBeenCalled()
  expect(f.deps.notice).not.toHaveBeenCalled()
  expect(f.session._dispatchPaused).not.toBe(true)
})
