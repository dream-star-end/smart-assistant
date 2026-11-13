import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { App } from './App'
import { setAuthHint } from './lib/authHint'
import { parseProjectPath, parseSessionPath } from './hooks/useAppRoute'
import { loadBeforeAll } from './test/moduleLoad'

// sec-authrefresh (PR #1288) independent frontend checks. Claude reviewer, 2026-10-30.
// Fake fixtures only. Mirrors the PR's own App.test.tsx deep-link case.
loadBeforeAll(() => Promise.all([import('./components/Landing'), import('./components/AuthGate')]))

type FetchMock = ReturnType<typeof vi.fn>
function okJson(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body }
}
function errJson(status: number, body: unknown) {
  return { ok: false, status, headers: { get: () => null }, json: async () => body }
}
const PUBLIC_CONFIG = okJson({
  turnstile_site_key: '', turnstile_bypass: true, require_email_verified: false,
  feature_remote_ssh: false, feature_image2: false, allow_registration: true,
})
const LOGIN_B = okJson({
  user: { id: 'u2', email: 'b@c.com', email_verified: true, role: 'user', display_name: 'Bob', avatar_url: null, credits: '300', created_at: '2026-01-01T00:00:00.000Z' },
  access_token: 'tok-b', access_exp: 1234, refresh_exp: 5678, remember: false,
})
const MODELS = { models: [{ id: 'glm-5.2', display_name: 'GLM-5.2', supported_efforts: ['high', 'max'] }] }
const AGENT_READY = { runtime_ready: true, subscription: null, container: null }
const INTERNAL = /INVALID_REFRESH|refresh token invalid|REFRESH_RACE|theft|401/

function expiryFetch(): FetchMock {
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/auth/refresh')) return errJson(401, { error: { code: 'INVALID_REFRESH', message: 'refresh token invalid or expired' } })
    if (u.includes('/api/auth/login')) return LOGIN_B
    if (u.includes('/api/auth/logout')) return okJson({ revoked: true })
    if (u.includes('/api/public/config')) return PUBLIC_CONFIG
    if (u.includes('/api/public/models')) return okJson(MODELS)
    if (u.includes('/api/chat-projects')) return okJson({ projects: [{ id: 'p1', name: '论文综述', sortOrder: 0, createdAt: 1, updatedAt: 1, sessionCount: 0 }] })
    if (u.includes('/api/agent/status')) return okJson(AGENT_READY)
    if (u.includes('/api/me/preferences')) return okJson({ prefs: {} })
    if (u.includes('/api/me')) return okJson({ user: { id: 'u2', email: 'b@c.com', role: 'user', display_name: 'Bob', credits: '300' } })
    return okJson({})
  }) as unknown as FetchMock
}

async function submitLogin() {
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'b@c.com' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } })
  const submit = screen.getByRole('button', { name: '登录' })
  await waitFor(() => expect(submit).not.toBeDisabled())
  await act(async () => { fireEvent.click(submit) })
}

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState({}, '', '/')
})

describe('SEC-FE deep-link parsers only accept same-site structured paths', () => {
  const hostile = [
    '//evil.example', '//evil.example/p/p1', '/\\evil.example', '/%5Cevil.example', '/%2F%2Fevil.example',
    '/p//evil.example', '/p/https://evil.example', '/p/https:%2F%2Fevil.example', '/p/%2F%2Fevil.example',
    '/p/%5Cevil.example', '/p/\\evil.example', '/p/p1/../../evil', '/p/p1/%2e%2e/evil', '/p/p1/overview',
    '/p/p1/', '/p/javascript:alert(1)', '/s//evil.example', '/s/https:evil.example', '/s/%2F%2Fevil',
    '/s/..%2F..%2Fevil', '/s/a b', 'https://evil.example/p/p1', `/p/${'a'.repeat(65)}`,
  ]
  for (const p of hostile) {
    test(`rejects ${JSON.stringify(p)}`, () => {
      expect(parseProjectPath(p)).toBeNull()
      expect(parseSessionPath(p)).toBeNull()
    })
  }
  test('accepts the legitimate shapes', () => {
    expect(parseProjectPath('/p/p1')).toEqual({ projectId: 'p1', tab: 'overview' })
    expect(parseProjectPath('/p/local-proj-1_x/files')).toEqual({ projectId: 'local-proj-1_x', tab: 'files' })
    expect(parseSessionPath('/s/abc_-1')).toBe('abc_-1')
  })
})

describe('SEC-FE expiry prompt / logout / redirect behaviour in App', () => {
  test('expiry at /p/p1 with hostile ?next=/redirect= query: prompt, no internal code, back to /p/p1 on the same origin', async () => {
    const origin = window.location.origin
    window.history.replaceState({}, '', '/p/p1?next=https%3A%2F%2Fevil.example&redirect=//evil.example&returnTo=/\\evil.example')
    vi.stubGlobal('fetch', expiryFetch() as unknown as typeof fetch)
    setAuthHint()
    render(<App />)
    expect(await screen.findByText('登录已过期，请重新登录')).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toMatch(INTERNAL)
    await submitLogin()
    expect(await screen.findByTestId('project-home')).toBeInTheDocument()
    expect(window.location.origin).toBe(origin)
    expect(window.location.pathname).toBe('/p/p1')
    expect(window.location.href).not.toContain('evil.example/')
  }, 30000)

  for (const hostilePath of ['//evil.example/p/p1', '/\\evil.example', '/%2F%2Fevil.example']) {
    test(`expiry at hostile path ${JSON.stringify(hostilePath)}: login stays on this origin`, async () => {
      const origin = window.location.origin
      // Same-origin absolute URL so the hostile string lands in pathname (a bare '//x' would
      // be cross-origin and History API throws, which is itself the browser's guard).
      window.history.replaceState({}, '', `${origin}${hostilePath}`)
      expect(window.location.origin).toBe(origin)
      vi.stubGlobal('fetch', expiryFetch() as unknown as typeof fetch)
      setAuthHint()
      render(<App />)
      expect(await screen.findByText('登录已过期，请重新登录')).toBeInTheDocument()
      await submitLogin()
      await waitFor(() => expect(screen.queryByLabelText('密码')).not.toBeInTheDocument())
      expect(window.location.origin).toBe(origin)
      expect(screen.queryByTestId('project-home')).not.toBeInTheDocument()
    }, 30000)
  }

  test('anonymous visitor (no hint) is not told their login expired', async () => {
    window.history.replaceState({}, '', '/p/p1')
    vi.stubGlobal('fetch', expiryFetch() as unknown as typeof fetch)
    render(<App />)
    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument()
    expect(screen.queryByText('登录已过期，请重新登录')).not.toBeInTheDocument()
  }, 30000)

  test('explicit logout after login shows no expiry prompt and clears the hint', async () => {
    const fetchMock = expiryFetch()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '登录' }))
    await screen.findByLabelText('邮箱')
    await submitLogin()
    await waitFor(() => expect(screen.getByRole('button', { name: '账号菜单' })).toBeInTheDocument())
    fireEvent.pointerDown(screen.getByRole('button', { name: '账号菜单' }), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '退出登录' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument())
    expect(screen.queryByText('登录已过期，请重新登录')).not.toBeInTheDocument()
    expect(localStorage.getItem('oc_auth_hint')).toBeNull()
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/auth/logout'))).toBe(true))
  }, 30000)
})
