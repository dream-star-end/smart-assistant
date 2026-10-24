import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SystemActionCardActions } from '../components/tool/context'
import { IuiBlock } from '../components/iui/IuiBlock'
import { ToolCardActionsContext } from '../components/tool/context'
import { createMemoryAuthSession } from '../lib/authSession'
import * as intelligentUi from '../lib/intelligentUi'
import { useSystemActionCardActions } from './useSystemActionCardActions'
const id = 'b5be0795-e604-45ee-bd8b-a519324b5cf4'
const nonce = 'A'.repeat(43)
function prepared() {
  return { id, operationId: 'preferences.update', title: '更改通知', state: 'prepared', executor: 'master',
    createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 60000, result: null, previewHash: 'a'.repeat(64),
    preview: { title: '更改通知', description: '后续通知', scope: '当前账号', before: [], after: [], consequences: [], price: { kind: 'none', label: '无费用' }, destructive: false } }
}
const succeeded = () => ({ ...prepared(), state: 'succeeded', preview: null, result: { summary: '已更新', completion: 'done' } })
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function setup() {
  const auth = createMemoryAuthSession(() => {}, 'fixture-access-a')
  return { auth, input: { authRef: { current: auth }, userId: '765', demo: false,
    applyPreferences: vi.fn(), setTheme: vi.fn(), onSyncError: vi.fn() } }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('a real native confirmation sheet closes on token refresh at the same identity epoch', async () => {
  const { auth, input } = setup()
  const fetcher = vi.fn<typeof fetch>(async url => reply(String(url).endsWith('/challenge') ? { detail: prepared(), nonce } : prepared()))
  vi.stubGlobal('fetch', fetcher)
  let beforeRefresh: SystemActionCardActions | undefined
  function Harness() {
    const { systemActions } = useSystemActionCardActions(input)
    beforeRefresh ??= systemActions
    return <ToolCardActionsContext.Provider value={{ systemActions }}><IuiBlock code={JSON.stringify({ type: 'system_action', proposalId: id })} /></ToolCardActionsContext.Provider>
  }
  render(<Harness />)
  fireEvent.click(await screen.findByRole('button', { name: '查看并确认' }))
  await screen.findByRole('dialog')
  act(() => { auth.commitToken(0, 'fixture-access-b') })
  expect(auth.snapshot().epoch).toBe(0)
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await expect(beforeRefresh!.confirm(id, { nonce, previewHash: 'a'.repeat(64) })).rejects.toThrow()
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/confirm'))).toBe(false)
})
it.each(['demo', 'signed-out'])('does not inject an approval provider for %s', mode => {
  const { input } = setup()
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useSystemActionCardActions({ ...input, demo: mode === 'demo', userId: mode === 'signed-out' ? undefined : input.userId }))
  expect(result.current.systemActions).toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
})
it('succeeded receipts read and apply preferences once without issuing a preference write', async () => {
  const { input } = setup()
  const applyIui = vi.spyOn(intelligentUi, 'applyIntelligentUiSnapshot').mockImplementation(() => {})
  const snap = { prefs: { theme: 'auto', default_model: 'fixture-model', notify_email: false } }
  const fetcher = vi.fn<typeof fetch>(async url => reply(String(url) === '/api/me/preferences' ? snap : succeeded()))
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useSystemActionCardActions(input))
  await act(async () => { await result.current.systemActions!.getDetail(id) })
  await waitFor(() => expect(result.current.preferencesRevision).toBe(1))
  expect(applyIui).toHaveBeenCalledExactlyOnceWith(snap)
  expect(input.applyPreferences).toHaveBeenCalledExactlyOnceWith(snap.prefs)
  expect(input.setTheme).toHaveBeenCalledExactlyOnceWith('system')
  await act(async () => { await result.current.systemActions!.getDetail(id) })
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/me/preferences')).toHaveLength(1)
  expect(fetcher.mock.calls.every(([, opts]) => opts?.method === 'GET')).toBe(true)
})
it('a late preference snapshot cannot apply after an identity boundary', async () => {
  const { auth, input } = setup()
  const applyIui = vi.spyOn(intelligentUi, 'applyIntelligentUiSnapshot').mockImplementation(() => {})
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  const fetcher = vi.fn<typeof fetch>(async url => String(url) === '/api/me/preferences' ? pending : reply(succeeded()))
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useSystemActionCardActions(input))
  await act(async () => { await result.current.systemActions!.getDetail(id) })
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/me/preferences')).toBe(true))
  await act(async () => { auth.beginIdentity(); release(reply({ prefs: { theme: 'dark' } })); await pending })
  expect(input.applyPreferences).not.toHaveBeenCalled()
  expect(input.setTheme).not.toHaveBeenCalled()
  expect(applyIui).not.toHaveBeenCalled()
  expect(input.onSyncError).not.toHaveBeenCalled()
  expect(result.current.preferencesRevision).toBe(0)
})
it('display read failures preserve success and a subsequent receipt can retry synchronization', async () => {
  const { input } = setup()
  vi.spyOn(intelligentUi, 'applyIntelligentUiSnapshot').mockImplementation(() => {})
  let failed = false
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => {
    if (String(url) !== '/api/me/preferences') return reply(succeeded())
    if (!failed) { failed = true; return reply({ error: { code: 'UNAVAILABLE', message: 'retry later' } }, 503) }
    return reply({ prefs: { theme: 'dark' } })
  }))
  const { result } = renderHook(() => useSystemActionCardActions(input))
  await act(async () => { expect((await result.current.systemActions!.getDetail(id)).state).toBe('succeeded') })
  await waitFor(() => expect(input.onSyncError).toHaveBeenCalledOnce())
  expect(result.current.preferencesRevision).toBe(0)
  await act(async () => { await result.current.systemActions!.getDetail(id) })
  await waitFor(() => expect(result.current.preferencesRevision).toBe(1))
  expect(input.setTheme).toHaveBeenCalledWith('dark')
})
it('unmount invalidates an outstanding display read even if the auth object remains alive', async () => {
  const { input } = setup()
  const applyIui = vi.spyOn(intelligentUi, 'applyIntelligentUiSnapshot').mockImplementation(() => {})
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  const fetcher = vi.fn<typeof fetch>(async url => String(url) === '/api/me/preferences' ? pending : reply(succeeded()))
  vi.stubGlobal('fetch', fetcher)
  const { result, unmount } = renderHook(() => useSystemActionCardActions(input))
  await act(async () => { await result.current.systemActions!.getDetail(id) })
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/me/preferences')).toBe(true))
  unmount()
  await act(async () => { release(reply({ prefs: { theme: 'dark' } })); await pending })
  expect(applyIui).not.toHaveBeenCalled()
  expect(input.applyPreferences).not.toHaveBeenCalled()
  expect(input.onSyncError).not.toHaveBeenCalled()
})
it('the native explicit confirm posts once and synchronizes the committed preference receipt', async () => {
  const { input } = setup()
  const applyIui = vi.spyOn(intelligentUi, 'applyIntelligentUiSnapshot').mockImplementation(() => {})
  let committed = false
  const fetcher = vi.fn<typeof fetch>(async (url, opts) => {
    const path = String(url)
    const method = opts?.method ?? 'GET'
    if (method === 'GET' && path === `/api/me/system-actions/${id}`) return reply(committed ? succeeded() : prepared())
    if (method === 'POST' && path === `/api/auth/system-actions/${id}/challenge`) return reply({ detail: prepared(), nonce })
    if (method === 'POST' && path === `/api/auth/system-actions/${id}/confirm`) {
      const proof = JSON.parse(String(opts?.body))
      expect(Object.keys(proof).sort()).toEqual(['deviceId', 'nonce', 'previewHash'])
      expect(proof.nonce).toBe(nonce)
      expect(proof.previewHash).toBe('a'.repeat(64))
      expect(proof.deviceId).toMatch(/^[0-9a-f-]{36}$/i)
      committed = true
      return reply(succeeded())
    }
    if (method === 'GET' && path === '/api/me/preferences') {
      expect(committed).toBe(true)
      return reply({ prefs: { theme: 'auto', notify_email: false } })
    }
    throw new Error('Unexpected system-action fixture request')
  })
  vi.stubGlobal('fetch', fetcher)
  function Harness() {
    const { systemActions, preferencesRevision } = useSystemActionCardActions(input)
    return <><output data-testid='preferences-revision'>{preferencesRevision}</output>
      <ToolCardActionsContext.Provider value={{ systemActions }}><IuiBlock code={JSON.stringify({ type: 'system_action', proposalId: id })} /></ToolCardActionsContext.Provider></>
  }
  render(<Harness />)
  fireEvent.click(await screen.findByRole('button', { name: '查看并确认' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认执行' }))
  await screen.findByText('已更新')
  await waitFor(() => expect(screen.getByTestId('preferences-revision')).toHaveTextContent('1'))
  expect(applyIui).toHaveBeenCalledOnce()
  expect(input.applyPreferences).toHaveBeenCalledExactlyOnceWith({ theme: 'auto', notify_email: false })
  expect(input.setTheme).toHaveBeenCalledExactlyOnceWith('system')
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/confirm'))).toHaveLength(1)
  expect(fetcher.mock.calls.some(([url, opts]) => String(url).includes('/refresh') || opts?.method === 'PATCH')).toBe(false)
})
it.each(['notifications.mark-read', 'notifications.read-all'])('synchronizes the native unread snapshot once for a succeeded %s receipt with GET only', async operationId => {
  const { input } = setup()
  const applyInboxUnreadCount = vi.fn()
  const receipt = { ...succeeded(), operationId }
  const fetcher = vi.fn<typeof fetch>(async url => reply(String(url) === '/api/me/messages/unread_count' ? { unread_count: 3 } : receipt))
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useSystemActionCardActions({ ...input, applyInboxUnreadCount }))
  await act(async () => { await result.current.systemActions!.getDetail(id) })
  await waitFor(() => expect(result.current.inboxRevision).toBe(1))
  expect(applyInboxUnreadCount).toHaveBeenCalledExactlyOnceWith(3)
  expect(input.applyPreferences).not.toHaveBeenCalled()
  expect(result.current.preferencesRevision).toBe(0)
  await act(async () => { await result.current.systemActions!.getDetail(id) })
  expect(applyInboxUnreadCount).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me/messages/unread_count')).toHaveLength(1)
  expect(fetcher.mock.calls.every(([, opts]) => (opts?.method ?? 'GET') === 'GET')).toBe(true)
})
it('a delayed unread snapshot cannot update another identity and a failed sync leaves the receipt successful', async () => {
  const { auth, input } = setup()
  const applyInboxUnreadCount = vi.fn()
  let resolveCount!: (response: Response) => void
  const count = new Promise<Response>(resolve => { resolveCount = resolve })
  const receipt = { ...succeeded(), operationId: 'notifications.read-all' }
  const fetcher = vi.fn<typeof fetch>(async url => String(url) === '/api/me/messages/unread_count' ? count : reply(receipt))
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useSystemActionCardActions({ ...input, applyInboxUnreadCount }))
  let actual: unknown
  await act(async () => { actual = await result.current.systemActions!.getDetail(id) })
  expect((actual as { state: string }).state).toBe('succeeded')
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url) === '/api/me/messages/unread_count')).toBe(true))
  act(() => { auth.beginIdentity(); resolveCount(reply({ unread_count: 99 })) })
  await act(async () => { await Promise.resolve() })
  expect(applyInboxUnreadCount).not.toHaveBeenCalled()
  expect(result.current.inboxRevision).toBe(0)
})

it('a succeeded metadata receipt reads its typed target and applies once without another write', async () => {
  const { input } = setup(); const applySessionMetadata = vi.fn()
  const metadata = { id: 'target-session', title: 'Approved', pinned: true, updatedAt: 3000 }
  const receipt = { ...succeeded(), operationId: 'sessions.metadata.update', result: { summary: 'Updated', completion: 'done', effectReference: 'session:target-session' } }
  const fetcher = vi.fn<typeof fetch>(async url => reply(String(url) === '/api/me/sessions/target-session/metadata' ? metadata : receipt))
  vi.stubGlobal('fetch',fetcher)
  const { result } = renderHook(() => useSystemActionCardActions({ ...input, applySessionMetadata }))
  await act(async () => { await result.current.systemActions!.getDetail(id) })
  await waitFor(() => expect(applySessionMetadata).toHaveBeenCalledExactlyOnceWith(metadata))
  await act(async () => { await result.current.systemActions!.getDetail(id) })
  expect(applySessionMetadata).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls.every(([,opts]) => (opts?.method ?? 'GET') === 'GET')).toBe(true)
})
it('a delayed metadata read cannot update another identity', async () => {
  const { auth, input } = setup(); const applySessionMetadata = vi.fn()
  let resolve!: (response: Response) => void
  const pending = new Promise<Response>(done => { resolve = done })
  const receipt = { ...succeeded(), operationId: 'sessions.metadata.update', result: { summary: 'Updated', completion: 'done', effectReference: 'session:target-session' } }
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/metadata') ? pending : reply(receipt))
  vi.stubGlobal('fetch',fetcher)
  const { result } = renderHook(() => useSystemActionCardActions({ ...input, applySessionMetadata }))
  await act(async () => { await result.current.systemActions!.getDetail(id) })
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/metadata'))).toBe(true))
  await act(async () => { auth.beginIdentity(); resolve(reply({ id: 'target-session', title: 'Must not apply', pinned: true, updatedAt: 3000 })) })
  expect(applySessionMetadata).not.toHaveBeenCalled()
})
it.each(['unavailable','wrong-target'])('metadata display %s preserves business success and applies no unverified snapshot', async failure => {
  const { input } = setup(); const applySessionMetadata = vi.fn()
  const receipt = { ...succeeded(), operationId: 'sessions.metadata.update', result: { summary: 'Updated', completion: 'done', effectReference: 'session:target-session' } }
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => String(url).endsWith('/metadata') ? failure === 'unavailable' ? reply({ error: 'unavailable' },503) : reply({ id: 'other-target', title: 'Wrong', pinned: true, updatedAt: 3000 }) : reply(receipt)))
  const { result } = renderHook(() => useSystemActionCardActions({ ...input, applySessionMetadata }))
  let actual: unknown
  await act(async () => { actual = await result.current.systemActions!.getDetail(id) })
  expect((actual as { state: string }).state).toBe('succeeded')
  await waitFor(() => expect(input.onSyncError).toHaveBeenCalledTimes(1))
  expect(applySessionMetadata).not.toHaveBeenCalled()
})

it('auth object replacement changes provider identity even at the same uid/epoch/generation and retires the old client', async () => {
  const { input } = setup()
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('stale provider must not request') })
  vi.stubGlobal('fetch',fetcher)
  const view = renderHook(() => useSystemActionCardActions(input))
  const old = view.result.current.systemActions!
  const snapshot = input.authRef.current.snapshot()
  input.authRef.current = createMemoryAuthSession(() => {}, snapshot.token)
  view.rerender()
  expect(view.result.current.systemActions!.identityKey).not.toBe(old.identityKey)
  await expect(old.getDetail(id)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
  const current = view.result.current.systemActions!.identityKey
  view.rerender()
  expect(view.result.current.systemActions!.identityKey).toBe(current)
})
