import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError, AuthEpochStaleError, api } from '../api'
import { createMemoryAuthSession } from '../authSession'
import type { AuthSession } from '../types'
import { uploadChunkedFile } from './uploadChunkClient'

type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

/** Hand-driven XMLHttpRequest: the test decides when bytes leave and when the server answers. */
class FakeXhr {
  static all: FakeXhr[] = []
  method = ''
  url = ''
  withCredentials = false
  requestHeaders: Record<string, string> = {}
  body: Blob | null = null
  status = 0
  statusText = ''
  responseText = ''
  aborted = false
  private responseHeaders: Record<string, string> = {}
  upload: {
    onprogress: ((e: { loaded: number; total: number }) => void) | null
    onload: (() => void) | null
  } = { onprogress: null, onload: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() {
    FakeXhr.all.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name.toLowerCase()] = value
  }
  getAllResponseHeaders() {
    return Object.entries(this.responseHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n')
  }
  send(body: Blob) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  progress(loaded: number) {
    this.upload.onprogress?.({ loaded, total: this.body?.size ?? 0 })
  }
  respond(r: Reply) {
    this.upload.onload?.()
    this.status = r.status
    this.responseHeaders = { 'content-type': 'application/json', ...r.headers }
    this.responseText = r.body === undefined ? '' : JSON.stringify(r.body)
    this.onload?.()
  }
  fail() {
    this.onerror?.()
  }
}

function ok(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
}

const unexpectedFetch = vi.fn(async (url: string) => {
  throw new Error(`unexpected fetch ${url}`)
})

function session(token: string): AuthSession {
  return createMemoryAuthSession(() => {}, token)
}

function audio(): File {
  return new File(['x'.repeat(1000)], '录音.m4a', { type: 'audio/x-m4a' })
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 50 && !cond(); i++) {
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(0)
  }
  expect(cond()).toBe(true)
}

function recorder() {
  const seen: Array<[number, number]> = []
  return { seen, sent: () => seen.map(([s]) => s), onProgress: (s: number, t: number) => seen.push([s, t]) }
}

beforeEach(() => {
  FakeXhr.all = []
  unexpectedFetch.mockClear()
  vi.useFakeTimers()
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  vi.stubGlobal('fetch', unexpectedFetch)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('a single-request upload reports bytes as they leave, throttled, and keeps the request contract', async () => {
  const r = recorder()
  const pending = api.uploadFile(session('tok-progress'), audio(), { onProgress: r.onProgress })
  await until(() => FakeXhr.all.length === 1)
  const x = FakeXhr.all[0]!
  expect(x.method).toBe('POST')
  expect(x.url).toBe('/api/uploads')
  expect(x.withCredentials).toBe(true)
  expect(x.requestHeaders).toMatchObject({
    authorization: 'Bearer tok-progress',
    'content-type': 'audio/x-m4a',
    'x-filename': encodeURIComponent('录音.m4a'),
    accept: 'application/json',
  })
  x.progress(100) // same instant as the 0% start → throttled away
  vi.advanceTimersByTime(150)
  x.progress(250)
  vi.advanceTimersByTime(150)
  x.progress(600)
  vi.advanceTimersByTime(50)
  x.progress(700) // within 100ms of the last report → dropped
  x.progress(1000) // the last byte is always reported
  x.respond({ status: 200, body: { url: '/api/media/rec.m4a', size: 1000, mimeType: 'audio/x-m4a' } })
  await expect(pending).resolves.toMatchObject({ url: '/api/media/rec.m4a', size: 1000 })
  expect(r.seen).toEqual([
    [0, 1000],
    [250, 1000],
    [600, 1000],
    [1000, 1000],
  ])
  expect(unexpectedFetch).not.toHaveBeenCalled()
})

test('a 503 backoff waits Retry-After and restarts progress from zero on the retry', async () => {
  const r = recorder()
  const pending = api.uploadFile(session('tok-503'), audio(), { onProgress: r.onProgress })
  await until(() => FakeXhr.all.length === 1)
  FakeXhr.all[0]!.progress(1000)
  FakeXhr.all[0]!.respond({
    status: 503,
    headers: { 'retry-after': '2' },
    body: { error: { code: 'UNAVAILABLE', message: 'container not ready' } },
  })
  await vi.advanceTimersByTimeAsync(1999)
  expect(FakeXhr.all).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  await until(() => FakeXhr.all.length === 2)
  FakeXhr.all[1]!.progress(1000)
  FakeXhr.all[1]!.respond({ status: 200, body: { url: '/api/media/rec.m4a' } })
  await expect(pending).resolves.toMatchObject({ url: '/api/media/rec.m4a' })
  expect(r.sent()).toEqual([0, 1000, 0, 1000])
})

test('503 retries stay bounded and surface the server error', async () => {
  const pending = api.uploadFile(session('tok-503-max'), audio(), { maxRetries: 1, onProgress: () => {} })
  const expectation = expect(pending).rejects.toMatchObject({ status: 503, code: 'UNAVAILABLE' })
  for (let n = 1; n <= 2; n++) {
    await until(() => FakeXhr.all.length === n)
    FakeXhr.all[n - 1]!.respond({
      status: 503,
      headers: { 'retry-after': '1' },
      body: { error: { code: 'UNAVAILABLE', message: 'container not ready' } },
    })
    await vi.advanceTimersByTimeAsync(1000)
  }
  await expectation
  expect(FakeXhr.all).toHaveLength(2)
})

test('a non-503 failure throws the same ApiError immediately without retrying', async () => {
  const pending = api.uploadFile(session('tok-400'), audio(), { onProgress: () => {} })
  await until(() => FakeXhr.all.length === 1)
  FakeXhr.all[0]!.respond({
    status: 400,
    headers: { 'x-request-id': 'req-up-400' },
    body: { error: { code: 'VALIDATION', message: 'bad file' } },
  })
  const err = await pending.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ApiError)
  expect(err).toMatchObject({ status: 400, code: 'VALIDATION', requestId: 'req-up-400' })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(FakeXhr.all).toHaveLength(1)
})

test('a 401 refreshes once and replays the upload with the new token', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/auth/refresh')) {
      return ok({ access_token: 'tok-new', access_exp: 999, remember: true })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const r = recorder()
  const s = session('tok-old')
  const pending = api.uploadFile(s, audio(), { onProgress: r.onProgress })
  await until(() => FakeXhr.all.length === 1)
  FakeXhr.all[0]!.progress(1000)
  FakeXhr.all[0]!.respond({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'expired' } } })
  await until(() => FakeXhr.all.length === 2)
  expect(FakeXhr.all[0]!.requestHeaders.authorization).toBe('Bearer tok-old')
  expect(FakeXhr.all[1]!.requestHeaders.authorization).toBe('Bearer tok-new')
  FakeXhr.all[1]!.progress(1000)
  FakeXhr.all[1]!.respond({ status: 200, body: { url: '/api/media/rec.m4a' } })
  await expect(pending).resolves.toMatchObject({ url: '/api/media/rec.m4a' })
  expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual(['/api/auth/refresh'])
  expect(r.sent()).toEqual([0, 1000, 0, 1000])
})

test('an account switch while bytes are in flight discards the reply and never retries', async () => {
  const s = session('tok-switch')
  const pending = api.uploadFile(s, audio(), { onProgress: () => {} })
  const expectation = expect(pending).rejects.toBeInstanceOf(AuthEpochStaleError)
  await until(() => FakeXhr.all.length === 1)
  FakeXhr.all[0]!.progress(500)
  s.beginIdentity()
  FakeXhr.all[0]!.respond({ status: 200, body: { url: '/api/media/rec.m4a' } })
  await expectation
  await vi.advanceTimersByTimeAsync(20_000)
  expect(FakeXhr.all).toHaveLength(1)
})

test('aborting cancels the bytes in flight and rejects with AbortError', async () => {
  const controller = new AbortController()
  const pending = api.uploadFile(session('tok-abort'), audio(), { signal: controller.signal, onProgress: () => {} })
  await until(() => FakeXhr.all.length === 1)
  FakeXhr.all[0]!.progress(300)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(FakeXhr.all[0]!.aborted).toBe(true)
  expect(FakeXhr.all).toHaveLength(1)
})

test('a network failure rejects like fetch does and is not retried', async () => {
  const pending = api.uploadFile(session('tok-net'), audio(), { onProgress: () => {} })
  await until(() => FakeXhr.all.length === 1)
  FakeXhr.all[0]!.fail()
  await expect(pending).rejects.toBeInstanceOf(TypeError)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(FakeXhr.all).toHaveLength(1)
})

test('callers that do not ask for progress keep the fetch transport', async () => {
  const fetchMock = vi.fn(async () => ok({ url: '/api/media/plain.txt' }))
  vi.stubGlobal('fetch', fetchMock)
  const pending = api.uploadFile(session('tok-plain'), audio())
  await vi.dynamicImportSettled()
  await expect(pending).resolves.toMatchObject({ url: '/api/media/plain.txt' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(FakeXhr.all).toHaveLength(0)
})

test('chunked uploads report progress inside each chunk, cumulative over the file', async () => {
  const uploadId = 'u'.repeat(32)
  const C = 8 * 1024 * 1024 // smallest chunk size the protocol accepts
  const size = 2 * C + 1000
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url)
    if (u === '/api/uploads/init') return ok({ uploadId, chunkBytes: C, chunkCount: 3 })
    if (u === `/api/uploads/${uploadId}/complete`) return ok({ url: '/api/media/big.bin', size })
    throw new Error(`unexpected fetch ${u}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const uploadOnce = async (_a: AuthSession, _o: unknown, run: (t: string) => Promise<Response>) => {
    const res = await run('tok-chunk')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  }
  const r = recorder()
  const file = new File([new Uint8Array(size)], 'big-progress.bin')
  const pending = uploadChunkedFile(session('tok-chunk'), file, { onProgress: r.onProgress }, uploadOnce)

  await until(() => FakeXhr.all.length === 1)
  const c0 = FakeXhr.all[0]!
  expect(c0.method).toBe('PUT')
  expect(c0.url).toBe(`/api/uploads/${uploadId}/chunks/0`)
  expect(c0.body?.size).toBe(C)
  vi.advanceTimersByTime(150)
  c0.progress(C / 2)
  c0.progress(C)
  c0.respond({ status: 200, body: {} })

  await until(() => FakeXhr.all.length === 2)
  const c1 = FakeXhr.all[1]!
  vi.advanceTimersByTime(150)
  c1.progress(C / 4)
  c1.progress(C)
  c1.respond({ status: 200, body: {} })

  await until(() => FakeXhr.all.length === 3)
  const c2 = FakeXhr.all[2]!
  expect(c2.body?.size).toBe(1000)
  vi.advanceTimersByTime(150)
  c2.progress(500)
  c2.progress(1000)
  c2.respond({ status: 200, body: {} })

  await expect(pending).resolves.toMatchObject({ url: '/api/media/big.bin' })
  const sent = r.sent()
  // Positions reached while a chunk was still in flight, counted over the whole file.
  expect(sent).toEqual(expect.arrayContaining([C / 2, C + C / 4, 2 * C + 500]))
  for (let i = 1; i < sent.length; i++) expect(sent[i]).toBeGreaterThanOrEqual(sent[i - 1]!)
  expect(sent.at(-1)).toBe(size)
  expect(r.seen.every(([, t]) => t === size)).toBe(true)
})
