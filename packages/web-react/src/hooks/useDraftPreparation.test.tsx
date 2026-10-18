import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../lib/authSession'
import { api } from '../lib/api'
import { useDraftPreparation } from './useDraftPreparation'
vi.mock('../lib/api', () => ({ api: { prepareWorkspace: vi.fn(() => Promise.resolve({ accepted: true })) } }))
const auth = createMemoryAuthSession(() => {})
auth.commitToken(auth.beginIdentity(), 'fixture-only')
const defaults = { auth, userId: '42', activeId: undefined as string | undefined, agentId: 'main',
  modelId: 'gpt-6.1-sol', effortLevel: 'high' as string | null, enabled: true }
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks() })
test('empty New rerenders preserve draft identity; submit retires pending work without materialization', () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { result, rerender } = renderHook(props => useDraftPreparation(props), { initialProps: defaults })
  const id = result.current.draftSessionId
  const first = vi.mocked(api.prepareWorkspace).mock.calls[0]
  expect(first[2]).toMatchObject({ sessionId: id, modelId: 'gpt-6.1-sol', effortLevel: 'high' })
  rerender({ ...defaults })
  expect(result.current.draftSessionId).toBe(id)
  expect(api.prepareWorkspace).toHaveBeenCalledTimes(1)
  act(() => result.current.stopPreparing())
  expect(first[1]?.aborted).toBe(true)
  expect(vi.mocked(api.prepareWorkspace).mock.calls.at(-1)?.[2]).toMatchObject({ sessionId: id, cancel: true })
  rerender({ ...defaults, activeId: id })
  rerender({ ...defaults })
  expect(result.current.draftSessionId).not.toBe(id)
})
test('model/effort change cancels old revision and hidden pages never refresh warm TTL', () => {
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { result, rerender } = renderHook(props => useDraftPreparation(props), { initialProps: defaults })
  const id = result.current.draftSessionId
  rerender({ ...defaults, modelId: 'gpt-6-luna', effortLevel: null })
  const calls = vi.mocked(api.prepareWorkspace).mock.calls
  expect(calls.map(c => c[2]?.revision)).toEqual([1, 2, 3])
  expect(calls[1][2]?.cancel).toBe(true)
  expect(calls[2][2]).toMatchObject({ sessionId: id, modelId: 'gpt-6-luna', effortLevel: null })
  visible.mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  const count = vi.mocked(api.prepareWorkspace).mock.calls.length
  visible.mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(api.prepareWorkspace).toHaveBeenCalledTimes(count)
})
test('hidden/anonymous/unsupported draft does not prepare; account and agent changes retire SID', () => {
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const { result, rerender } = renderHook(props => useDraftPreparation(props), { initialProps: defaults })
  expect(api.prepareWorkspace).not.toHaveBeenCalled()
  visible.mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(api.prepareWorkspace).toHaveBeenCalledTimes(1)
  const id = result.current.draftSessionId
  rerender({ ...defaults, enabled: false, agentId: 'writer' })
  expect(result.current.draftSessionId).not.toBe(id)
  const writer = result.current.draftSessionId
  rerender({ ...defaults, userId: '43', enabled: false })
  expect(result.current.draftSessionId).not.toBe(writer)
  expect(vi.mocked(api.prepareWorkspace).mock.calls.filter(c => !c[2]?.cancel)).toHaveLength(1)
})
test('StrictMode leaves one current non-aborted revision and failures never block send', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.mocked(api.prepareWorkspace).mockRejectedValueOnce(Error('offline'))
  const { result } = renderHook(() => useDraftPreparation(defaults),
    { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> })
  await act(async () => { await Promise.resolve() })
  const latest = vi.mocked(api.prepareWorkspace).mock.calls.filter(c => !c[2]?.cancel).at(-1)!
  expect(latest[1]?.aborted).toBe(false)
  expect(result.current.draftSessionId).toBe(latest[2]?.sessionId)
})
