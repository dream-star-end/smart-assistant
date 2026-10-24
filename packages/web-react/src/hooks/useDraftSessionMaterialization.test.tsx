import { useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { Session } from '../lib/types'
import type { UseChatSocket } from './useChatSocket'
import { useSessionEngineOptions } from './useSessionEngineOptions'
import { useDraftSessionMaterialization } from './useDraftSessionMaterialization'
import { accountDraftKey, readDraft, writeDraft, NEW_COMPOSER_DRAFT_KEY } from '../lib/composerDraft'
import { readSessionEffort } from '../lib/sessionEffort'
afterEach(() => { cleanup(); localStorage.clear() })
test('Goal/GitHub identity promotion preserves an explicit draft effort through activeId hydration', () => {
  const ensureSession = vi.fn()
  const setSessionModel = vi.fn()
  const id = 'draft_promotion_123'
  writeDraft(accountDraftKey(NEW_COMPOSER_DRAFT_KEY, '42'), '未发送的普通草稿')
  const { result } = renderHook(() => {
    const [activeId, setActiveId] = useState<string | undefined>()
    const [sessions, setSessions] = useState<Session[]>([])
    const sockRef = useRef<Pick<UseChatSocket, 'ensureSession' | 'setSessionModel'> | null>({ ensureSession, setSessionModel })
    const options = useSessionEngineOptions(activeId)
    const materialize = useDraftSessionMaterialization({
      demo: false, userId: '42', activeId, draftSessionId: id, stopPreparing: () => {},
      agentId: 'main', modelId: 'gpt-6.1-sol', ...options,
      sockRef, setSessions, setActiveId,
    })
    return { activeId, sessions, materialize, ...options }
  })
  expect(ensureSession).not.toHaveBeenCalled()
  act(() => result.current.setSessionEffort('high'))
  act(() => { expect(result.current.materialize()).toBe(id) })
  expect(result.current.activeId).toBe(id)
  expect(result.current.sessionEffort).toBe('high')
  expect(readSessionEffort(id)).toBe('high')
  expect(result.current.sessions.map(s => s.id)).toEqual([id])
  expect(readDraft(accountDraftKey(id, '42'))).toBe('未发送的普通草稿')
  expect(ensureSession).toHaveBeenCalledTimes(1)
  act(() => { expect(result.current.materialize()).toBe(id) })
  expect(ensureSession).toHaveBeenCalledTimes(1)
})
