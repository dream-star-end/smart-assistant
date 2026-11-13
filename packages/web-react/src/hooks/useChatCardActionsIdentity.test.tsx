import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryAuthSession } from '../lib/authSession'
import { captureIdentityAttempt, resolveIdentity } from '../lib/resolvedIdentity'
import { useChatCardActions, type ChatCardActionsInput } from './useChatCardActions'
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
function setup() {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const input = {
    authRef: { current: auth }, identity: resolveIdentity(captureIdentityAttempt(auth, 'alice-a'), 'alice'),
    demo: false, communityBlogEnabled: true, chat: {}, agent: { id: 'fixture' },
    openManage: vi.fn(), openBlog: vi.fn(), openPane: vi.fn(), openSettings: vi.fn(),
    setCollapsed: vi.fn(), setBoardOpen: vi.fn(),
  } as unknown as ChatCardActionsInput
  return { auth, input }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('an old Alice card cannot start uploading or publishing after Bob signs in', async () => {
  const { auth, input } = setup()
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useChatCardActions(input))
  const old = result.current.toolActions.communityBlog!
  // A prior image read/compression can retain these exact callbacks across an await.
  await Promise.resolve()
  auth.commitToken(auth.beginIdentity(), 'bob-b')
  await expect(old.uploadImage!(new Blob(['fixture']))).rejects.toThrow()
  await expect(old.submit!({ title: '', summary: '', category: 'general', bodyMarkdown: '' })).rejects.toThrow()
  old.openEditor({ title: '', summary: '', category: 'general', bodyMarkdown: '' })
  expect(input.openBlog).toHaveBeenCalledWith({ kind: 'editor', seed: { title: '', summary: '', category: 'general', bodyMarkdown: '' } })
  expect(fetcher).not.toHaveBeenCalled()
})
it('same-epoch refresh and auth-object replacement revoke old connector/task callbacks', async () => {
  const { auth, input } = setup()
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useChatCardActions(input))
  const old = result.current.toolActions
  auth.commitToken(0, 'alice-b')
  await expect(old.connectorConfirm!.decide('fixture', 'approve')).rejects.toThrow()
  if (old.taskApproval) await expect(old.taskApproval.approve('fixture', 3)).rejects.toThrow()
  input.authRef.current = createMemoryAuthSession(() => {}, 'alice-a')
  await expect(old.connectorConfirm!.getDetail('fixture')).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})
it('an unresolved displayed user never receives business callbacks and a current binding still works', async () => {
  const { input } = setup()
  const fetcher = vi.fn<typeof fetch>(async () => reply({ image: { sha256: 'a'.repeat(64) } }))
  vi.stubGlobal('fetch', fetcher)
  const { result, rerender } = renderHook(({ value }) => useChatCardActions(value), { initialProps: { value: { ...input, identity: null } as ChatCardActionsInput } })
  expect(result.current.toolActions.communityBlog?.submit).toBeUndefined()
  expect(result.current.toolActions.communityBlog?.uploadImage).toBeUndefined()
  expect(result.current.toolActions.communityBlog?.precheck).toBeUndefined()
  result.current.toolActions.communityBlog!.openMine()
  result.current.toolActions.communityBlog!.openPost('fixture')
  result.current.toolActions.communityBlog!.openEditor({ title: '', summary: '', category: 'general', bodyMarkdown: '' })
  expect(result.current.toolActions.communityBlog!.postUrl('fixture')).toContain('fixture')
  expect(input.openBlog).toHaveBeenCalledTimes(3)
  expect(result.current.toolActions.connectorConfirm).toBeUndefined()
  expect(result.current.toolActions.taskApproval).toBeUndefined()
  rerender({ value: input })
  expect(await result.current.toolActions.communityBlog!.uploadImage!(new Blob(['fixture']))).toEqual({ sha256: 'a'.repeat(64) })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('the card callback freezes a draft before its own lazy IO module await', async () => {
  const { input } = setup()
  const fetcher = vi.fn<typeof fetch>(async () => reply({ tutorial: { id: 'fixture', status: 'pending' } }))
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useChatCardActions(input))
  const draft = { title: 'Frozen title', summary: 'fixture', category: 'general' as const, bodyMarkdown: 'fixture' }
  const pending = result.current.toolActions.communityBlog!.submit!(draft)
  draft.title = 'Late mutation'
  await pending
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).title).toBe('Frozen title')
})

it('a successful card POST remains successful when token rotation happens while reading its receipt', async () => {
  const { auth, input } = setup()
  const response = reply({})
  vi.spyOn(response, 'json').mockImplementation(async () => {
    auth.commitToken(0, 'alice-b')
    return { tutorial: { id: 'committed-fixture', status: 'pending' } }
  })
  const fetcher = vi.fn<typeof fetch>(async () => response)
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useChatCardActions(input))
  const actions = result.current.toolActions.communityBlog!
  expect(await actions.submit!({ title: 'Fixture', summary: 'Fixture', category: 'general', bodyMarkdown: 'Fixture' })).toEqual({ id: 'committed-fixture', status: 'pending' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  await expect(actions.submit!({ title: 'Again', summary: 'Fixture', category: 'general', bodyMarkdown: 'Fixture' })).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

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
