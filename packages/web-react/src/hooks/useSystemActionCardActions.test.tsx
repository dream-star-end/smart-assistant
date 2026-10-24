import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { IuiBlock } from '../components/iui/IuiBlock'
import { ToolCardActionsContext } from '../components/tool/context'
import { createMemoryAuthSession } from '../lib/authSession'
import * as intelligentUi from '../lib/intelligentUi'
import { useSystemActionCardActions } from './useSystemActionCardActions'
const id = 'b5be0795-e604-45ee-bd8b-a519324b5cf4'
const nonce = 'n'.repeat(43)
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
  function Harness() {
    const { systemActions } = useSystemActionCardActions(input)
    return <ToolCardActionsContext.Provider value={{ systemActions }}><IuiBlock code={JSON.stringify({ type: 'system_action', proposalId: id })} /></ToolCardActionsContext.Provider>
  }
  render(<Harness />)
  fireEvent.click(await screen.findByRole('button', { name: '查看并确认' }))
  await screen.findByRole('dialog')
  act(() => { auth.commitToken(0, 'fixture-access-b') })
  expect(auth.snapshot().epoch).toBe(0)
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/confirm'))).toBe(false)
})
it.each(['demo', 'signed-out'])('does not inject an approval provider for %s', mode => {
  const { input } = setup()
  const { result } = renderHook(() => useSystemActionCardActions({ ...input, demo: mode === 'demo', userId: mode === 'signed-out' ? undefined : input.userId }))
  expect(result.current.systemActions).toBeUndefined()
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
