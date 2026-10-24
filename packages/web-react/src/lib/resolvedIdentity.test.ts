import { afterEach, expect, it, vi } from 'vitest'
import { api } from './api'
import { createMemoryAuthSession } from './authSession'
import { assertResolvedIdentity, captureIdentityAttempt, identityIsCurrent, resolveIdentity, revokeResolvedIdentity, type ResolvedIdentity } from './resolvedIdentity'
import { taskboardApi } from './taskboard'
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const me = (id = 'alice') => ({ user: { id, role: 'user', email: `${id}@example.invalid` } })
const draft = { title: 'Fixture', summary: 'Fixture', category: 'general' as const, bodyMarkdown: 'Fixture' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('identity evidence never follows a different token, auth object or identity epoch', () => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const identity = resolveIdentity(captureIdentityAttempt(auth, 'alice-a'), 'alice')
  expect(identityIsCurrent(identity, auth, 'alice')).toBe(true)
  expect(JSON.stringify(identity)).not.toContain('alice-a')
  expect(identityIsCurrent(identity, createMemoryAuthSession(() => {}, 'alice-a'), 'alice')).toBe(false)
  auth.commitToken(0, 'alice-b')
  expect(identityIsCurrent(identity, auth, 'alice')).toBe(false)
  auth.commitToken(0, 'alice-a')
  expect(identityIsCurrent(identity, auth, 'alice')).toBe(false)
  const current = resolveIdentity(captureIdentityAttempt(auth, 'alice-a'), 'alice')
  revokeResolvedIdentity(current)
  expect(identityIsCurrent(current, auth)).toBe(false)
  auth.beginIdentity()
  expect(() => captureIdentityAttempt(auth, '')).toThrow()
})
it('a same-epoch token change during /me JSON parsing cannot mint a new binding', async () => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const body = deferred<unknown>()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: () => body.promise })))
  const onIdentity = vi.fn()
  const pending = api.getMe(auth, onIdentity)
  auth.commitToken(0, 'bob-b')
  body.resolve(me())
  await expect(pending).rejects.toThrow()
  expect(onIdentity).not.toHaveBeenCalled()
})
it('a 401 GET replay binds the /me user to the actual replay token', async () => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/api/auth/refresh') return reply({ access_token: 'alice-b', access_exp: 9999999999, remember: false })
    if (new Headers(init?.headers).get('Authorization') === 'Bearer alice-a') return reply({}, 401)
    return reply(me())
  })
  vi.stubGlobal('fetch', fetcher)
  let identity: ResolvedIdentity | null = null
  expect((await api.getMe(auth, value => { identity = value })).id).toBe('alice')
  expect(auth.snapshot()).toEqual({ token: 'alice-b', epoch: 0 })
  expect(identityIsCurrent(identity, auth, 'alice')).toBe(true)
  expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me')).toHaveLength(2)
})
it.each(['upload', 'submit', 'connector', 'task-approve', 'task-reject'])('a guarded %s cannot replay a business POST after refresh changes generation', async operation => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const identity = resolveIdentity(captureIdentityAttempt(auth, 'alice-a'), 'alice')
  const guard = { assertCurrent: () => assertResolvedIdentity(identity, auth) }
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/auth/refresh' ? reply({ access_token: 'alice-b', access_exp: 9999999999, remember: false }) : reply({}, 401))
  vi.stubGlobal('fetch', fetcher)
  const pending = operation === 'upload' ? api.uploadTutorialImage(auth, new Blob(['image']), guard)
    : operation === 'submit' ? api.submitCommunityTutorial(auth, draft, guard)
    : operation === 'connector' ? api.decideConnectorConfirmation(auth, 'fixture', 'approve', guard)
    : operation === 'task-approve' ? taskboardApi.approve(auth, 'fixture', 4, false, guard)
    : taskboardApi.reject(auth, 'fixture', 4, 'fixture', undefined, guard)
  await expect(pending).rejects.toThrow()
  expect(fetcher.mock.calls.filter(([url]) => String(url) !== '/api/auth/refresh')).toHaveLength(1)
  expect(auth.snapshot().token).toBe('alice-b')
})
it('a local cancellation signal reaches the actual POST and rejects before an aborted new request', async () => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const controller = new AbortController()
  const guard = { signal: controller.signal, assertCurrent: () => {} }
  const fetcher = vi.fn<typeof fetch>(async () => reply({ image: { sha256: 'a'.repeat(64) } }))
  vi.stubGlobal('fetch', fetcher)
  await api.uploadTutorialImage(auth, new Blob(['image']), guard)
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
  controller.abort()
  await expect(api.uploadTutorialImage(auth, new Blob(['image']), guard)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('an unguarded human API invocation cannot borrow a later login during chunk loading', async () => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const pending = api.submitCommunityTutorial(auth, draft)
  auth.commitToken(auth.beginIdentity(), 'bob-b')
  await expect(pending).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})
it('the fixed deferred draft API freezes its scalar payload before the chunk await', async () => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const fetcher = vi.fn<typeof fetch>(async () => reply({ tutorial: { id: 'fixture', status: 'pending', createdAt: 'fixture' } }))
  vi.stubGlobal('fetch', fetcher)
  const mutable = { ...draft, title: 'Frozen title' }
  const pending = api.submitCommunityTutorial(auth, mutable)
  mutable.title = 'Late mutation'
  await pending
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).title).toBe('Frozen title')
})

it('a nested skill-eval payload is captured before loading its fixed client', async () => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const fetcher = vi.fn<typeof fetch>(async () => reply({ ok: true }))
  vi.stubGlobal('fetch', fetcher)
  const evals = { version: 1 as const, cases: [{ id: 'fixture', prompt: 'Frozen prompt', assertions: ['Frozen assertion'] }] }
  const pending = api.putSkillEvals(auth, 'fixture', evals)
  evals.cases[0]!.prompt = 'Late prompt'
  evals.cases[0]!.assertions[0] = 'Late assertion'
  await pending
  const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
  expect(sent.evals.cases[0]).toEqual({ id: 'fixture', prompt: 'Frozen prompt', assertions: ['Frozen assertion'] })
})
it.each(['eval', 'train', 'comment'])('a default same-epoch %s call keeps normal token rotation during client loading', async operation => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const fetcher = vi.fn<typeof fetch>(async () => reply({ ok: true, runId: 'fixture-run' }))
  vi.stubGlobal('fetch', fetcher)
  const pending = operation === 'eval' ? api.startSkillEvalRun(auth, 'fixture')
    : operation === 'train' ? api.startSkillTrain(auth, 'fixture')
    : api.commentSkillDraft(auth, 'fixture-run', 'fixture', 'fixture')
  auth.commitToken(0, 'new-access-same-epoch')
  await expect(pending).resolves.toMatchObject({ ok: true })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer new-access-same-epoch')
})
it('a default human client preserves its existing successful 401 replay after dispatch', async () => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const fetcher = vi.fn<typeof fetch>(async (url, init) => String(url) === '/api/auth/refresh'
    ? reply({ access_token: 'alice-b', access_exp: 9999999999, remember: false })
    : new Headers(init?.headers).get('Authorization') === 'Bearer alice-a' ? reply({}, 401) : reply({ ok: true, runId: 'fixture-run' }))
  vi.stubGlobal('fetch', fetcher)
  expect(await api.startSkillTrain(auth, 'fixture')).toEqual({ ok: true, runId: 'fixture-run' })
  expect(fetcher.mock.calls.filter(([url]) => String(url) !== '/api/auth/refresh')).toHaveLength(2)
})
it('a deferred tutorial image remains a Blob and preserves its existing failure message', async () => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const fixture = new Blob(['fixture-image'])
  const fetcher = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200, blob: async () => fixture }) as Response)
  vi.stubGlobal('fetch', fetcher)
  const image = await api.fetchTutorialImage(auth, 'a'.repeat(64))
  expect(image).toBeInstanceOf(Blob)
  expect(image).toBe(fixture)
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(image)
  })
  expect(text).toBe('fixture-image')
  fetcher.mockResolvedValueOnce(reply({}, 403))
  await expect(api.fetchTutorialImage(auth, 'a'.repeat(64))).rejects.toThrow('读取图片失败（403）')
})

it('an unguarded read after lazy loading tolerates a same-epoch access-token rotation', async () => {
  const auth = createMemoryAuthSession(() => {}, 'alice-a')
  const fetcher = vi.fn<typeof fetch>(async () => reply({ runs: [] }))
  vi.stubGlobal('fetch', fetcher)
  const pending = api.listSkillTrainRuns(auth)
  auth.commitToken(0, 'alice-b')
  expect(await pending).toEqual([])
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer alice-b')
})
