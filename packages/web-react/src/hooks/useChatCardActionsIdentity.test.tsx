import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryAuthSession } from '../lib/authSession'
import { useChatCardActions, type ChatCardActionsInput } from './useChatCardActions'
function setup() {
  const input = {
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    demo: false, communityBlogEnabled: true, chat: {}, agent: { id: 'fixture' },
    openManage: vi.fn(), openBlog: vi.fn(), openPane: vi.fn(), openSettings: vi.fn(),
    setCollapsed: vi.fn(), setBoardOpen: vi.fn(),
  } as unknown as ChatCardActionsInput
  return { input }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('confirmed Stop checks live identity before feedback and passes the frozen target to the socket', () => {
  const { input } = setup()
  const session = { _activeClientMessageId: 'turn-a' }
  const stop = vi.fn()
  input.activeId = 's1'
  input.chat = { isSending: () => true, getSession: () => session, getMessages: () => [], stop } as unknown as ChatCardActionsInput['chat']
  input.stoppedTurnRef = { current: false }
  input.sendImplicitRatingRef = { current: vi.fn() }
  input.setChatError = vi.fn()
  const { result } = renderHook(() => useChatCardActions(input))
  const action = result.current.stopTurnIfCurrent
  // The socket changes before scheduleNotify causes any React rerender.
  session._activeClientMessageId = 'turn-b'
  action('turn-a')
  expect(stop).not.toHaveBeenCalled()
  expect(input.setChatError).not.toHaveBeenCalled()
  expect(input.stoppedTurnRef.current).toBe(false)
  action('turn-b')
  expect(stop).toHaveBeenCalledWith('s1', 'turn-b')
})
