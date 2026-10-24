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
  await expect(old.uploadImage(new Blob(['fixture']))).rejects.toThrow()
  await expect(old.submit({ title: '', summary: '', category: 'general', bodyMarkdown: '' })).rejects.toThrow()
  expect(() => old.openEditor({ title: '', summary: '', category: 'general', bodyMarkdown: '' })).toThrow()
  expect(input.openBlog).not.toHaveBeenCalled()
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
  expect(result.current.toolActions.communityBlog).toBeUndefined()
  expect(result.current.toolActions.connectorConfirm).toBeUndefined()
  expect(result.current.toolActions.taskApproval).toBeUndefined()
  rerender({ value: input })
  expect(await result.current.toolActions.communityBlog!.uploadImage(new Blob(['fixture']))).toEqual({ sha256: 'a'.repeat(64) })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
