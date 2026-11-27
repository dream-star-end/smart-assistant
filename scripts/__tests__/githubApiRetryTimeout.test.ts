/**
 * OCV5-918 Fix #3: Unit tests for idempotent GitHub API retry + 15s timeout
 * shared by `githubGetJsonObject` and `githubGetPaginatedList`.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  type FetchLike,
  githubGetJsonObject,
  githubGetPaginatedList,
} from '../lib/githubMergedPrEquivalence.js'

const TEST_URL = 'https://api.github.com/repos/owner/repo/commits/abc'
const TEST_TOKEN = 'ghp_test_token'

function okResp(body: unknown, headers: Record<string, string> = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body,
  }
}

function errResp(status: number, headers: Record<string, string> = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: false,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: async () => ({ message: `HTTP ${status}` }),
  }
}

describe('OCV5-918 Fix #3: GitHub API idempotent retry and timeout', () => {
  test('retries network errors and retryable HTTP statuses (408/429/502/503/504) with exponential backoff', async () => {
    for (const status of [408, 429, 502, 503, 504]) {
      let calls = 0
      const delays: number[] = []
      const fetchImpl: FetchLike = async () => {
        calls++
        if (calls <= 3) return errResp(status)
        return okResp({ sha: 'ok', status })
      }
      const res = await githubGetJsonObject<{ sha: string; status: number }>(
        TEST_URL,
        TEST_TOKEN,
        fetchImpl,
        {
          sleepImpl: async (ms) => {
            delays.push(ms)
          },
        },
      )
      assert.equal(res.ok, true)
      if (res.ok) {
        assert.deepEqual(res.data, { sha: 'ok', status })
      }
      assert.equal(calls, 4)
      assert.deepEqual(delays, [500, 1000, 2000])
    }

    // Network error retries and exhausts after 1 + 3 attempts
    let netCalls = 0
    const netDelays: number[] = []
    const failingNet: FetchLike = async () => {
      netCalls++
      throw new Error('ECONNRESET')
    }
    const netRes = await githubGetJsonObject(TEST_URL, TEST_TOKEN, failingNet, {
      sleepImpl: async (ms) => {
        netDelays.push(ms)
      },
    })
    assert.equal(netRes.ok, false)
    if (!netRes.ok) {
      assert.match(netRes.reason, /ECONNRESET/)
    }
    assert.equal(netCalls, 4)
    assert.deepEqual(netDelays, [500, 1000, 2000])
  })

  test('honors numeric Retry-After on HTTP 429 (clamped to 5000ms) and falls back on non-numeric', async () => {
    let calls = 0
    const delays: number[] = []
    const fetchImpl: FetchLike = async () => {
      calls++
      if (calls === 1) return errResp(429, { 'Retry-After': '2' })
      if (calls === 2) return errResp(429, { 'retry-after': '120' })
      if (calls === 3) return errResp(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })
      return okResp({ recovered: true })
    }
    const res = await githubGetJsonObject<{ recovered: boolean }>(TEST_URL, TEST_TOKEN, fetchImpl, {
      sleepImpl: async (ms) => {
        delays.push(ms)
      },
    })
    assert.equal(res.ok, true)
    assert.equal(calls, 4)
    // attempt 0 -> Retry-After 2s = 2000ms
    // attempt 1 -> Retry-After 120s clamped to 5000ms
    // attempt 2 -> non-numeric falls back to 500 * 2^2 = 2000ms
    assert.deepEqual(delays, [2000, 5000, 2000])
  })

  test('caps exponential backoff delay at 5000ms for high baseDelayMs/retries', async () => {
    let calls = 0
    const delays: number[] = []
    const fetchImpl: FetchLike = async () => {
      calls++
      if (calls <= 4) return errResp(503)
      return okResp({ ok: true })
    }
    const res = await githubGetJsonObject(TEST_URL, TEST_TOKEN, fetchImpl, {
      maxRetries: 4,
      baseDelayMs: 2000,
      sleepImpl: async (ms) => {
        delays.push(ms)
      },
    })
    assert.equal(res.ok, true)
    assert.deepEqual(delays, [2000, 4000, 5000, 5000])
  })

  test('fails fast with zero retries on non-retryable 4xx (400/401/403/404/422)', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      let calls = 0
      const delays: number[] = []
      const fetchImpl: FetchLike = async () => {
        calls++
        return errResp(status)
      }
      const objRes = await githubGetJsonObject(TEST_URL, TEST_TOKEN, fetchImpl, {
        sleepImpl: async (ms) => {
          delays.push(ms)
        },
      })
      assert.equal(objRes.ok, false)
      if (!objRes.ok) {
        assert.match(objRes.reason, new RegExp(`GitHub API HTTP ${status}`))
      }
      assert.equal(calls, 1)
      assert.deepEqual(delays, [])

      calls = 0
      const listRes = await githubGetPaginatedList(TEST_URL, TEST_TOKEN, fetchImpl, 5, {
        sleepImpl: async (ms) => {
          delays.push(ms)
        },
      })
      assert.equal(listRes.ok, false)
      if (!listRes.ok) {
        assert.match(listRes.reason, new RegExp(`GitHub API HTTP ${status}`))
      }
      assert.equal(calls, 1)
      assert.deepEqual(delays, [])
    }
  })

  test('aborts on timeout, retries, recovers or fails closed when exhausted', async () => {
    let abortedSignals = 0
    let calls = 0
    const fetchRecover: FetchLike = async (_url, init) => {
      calls++
      if (calls === 1) {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortedSignals++
            reject(new Error('AbortError: signal aborted'))
          })
        })
      }
      return okResp({ recoveredAfterTimeout: true })
    }
    const recRes = await githubGetJsonObject<{ recoveredAfterTimeout: boolean }>(
      TEST_URL,
      TEST_TOKEN,
      fetchRecover,
      {
        timeoutMs: 25,
        sleepImpl: async () => {},
      },
    )
    assert.equal(recRes.ok, true)
    assert.equal(calls, 2)
    assert.equal(abortedSignals, 1)

    // Exhausted timeouts fail closed after 4 attempts
    let exhaustCalls = 0
    let exhaustAborts = 0
    const fetchAlwaysHang: FetchLike = async (_url, init) => {
      exhaustCalls++
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          exhaustAborts++
          reject(new Error('AbortError'))
        })
      })
    }
    const failRes = await githubGetJsonObject(TEST_URL, TEST_TOKEN, fetchAlwaysHang, {
      timeoutMs: 15,
      maxRetries: 3,
      sleepImpl: async () => {},
    })
    assert.equal(failRes.ok, false)
    if (!failRes.ok) {
      assert.match(failRes.reason, /timeout/i)
    }
    assert.equal(exhaustCalls, 4)
    assert.equal(exhaustAborts, 4)
  })

  test('times out hanging fetch that ignores AbortSignal without leaking timers or unhandledRejections', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      let calls = 0
      const lateRejects: Array<() => void> = []
      const ignoreSignalFetch: FetchLike = () => {
        calls++
        return new Promise((_resolve, reject) => {
          // Intentionally ignore init.signal; reject later after timeout already settled
          lateRejects.push(() => reject(new Error('late rejection after timeout')))
        })
      }
      const start = Date.now()
      const res = await githubGetJsonObject(TEST_URL, TEST_TOKEN, ignoreSignalFetch, {
        timeoutMs: 20,
        maxRetries: 1,
        sleepImpl: async () => {},
      })
      const elapsed = Date.now() - start
      assert.equal(res.ok, false)
      assert.equal(calls, 2)
      assert.ok(elapsed < 1000, `expected prompt timeout, took ${elapsed}ms`)

      // Trigger late rejections from abandoned promises and confirm none escape unhandled
      for (const trigger of lateRejects) trigger()
      await new Promise((r) => setTimeout(r, 30))
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('retries resp.json() truncation/stream errors and resp.json() hangs', async () => {
    let calls = 0
    const fetchBrokenJson: FetchLike = async () => {
      calls++
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => {
            throw new SyntaxError('Unexpected end of JSON input')
          },
        }
      }
      if (calls === 2) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => new Promise(() => {}), // hangs past timeoutMs
        }
      }
      return okResp({ parsed: 'clean' }, { link: '<https://api.github.com/next>; rel="next"' })
    }
    const res = await githubGetJsonObject<{ parsed: string }>(TEST_URL, TEST_TOKEN, fetchBrokenJson, {
      timeoutMs: 20,
      sleepImpl: async () => {},
    })
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.deepEqual(res.data, { parsed: 'clean' })
      assert.equal(res.hasNextPage, true)
    }
    assert.equal(calls, 3)
  })

  test('githubGetPaginatedList retries page 2 jitter without duplicating page 1 items or breaking truncated', async () => {
    const page1Url = 'https://api.github.com/repos/o/r/pulls/1/files?per_page=2&page=1'
    const page2Url = 'https://api.github.com/repos/o/r/pulls/1/files?per_page=2&page=2'
    const page3Url = 'https://api.github.com/repos/o/r/pulls/1/files?per_page=2&page=3'
    const counts = new Map<string, number>()

    const fetchImpl: FetchLike = async (url) => {
      const n = (counts.get(url) ?? 0) + 1
      counts.set(url, n)
      if (url === page1Url) {
        return okResp([{ id: 1 }, { id: 2 }], { link: `<${page2Url}>; rel="next"` })
      }
      if (url === page2Url) {
        if (n === 1) return errResp(503)
        if (n === 2) throw new Error('socket hang up')
        return okResp([{ id: 3 }, { id: 4 }])
      }
      return errResp(404)
    }

    const res = await githubGetPaginatedList<{ id: number }>(page1Url, TEST_TOKEN, fetchImpl, 5, {
      sleepImpl: async () => {},
    })
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.deepEqual(res.items, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
      assert.equal(res.truncated, false)
    }
    assert.equal(counts.get(page1Url), 1)
    assert.equal(counts.get(page2Url), 3)

    // Verify truncated=true is preserved when maxPages is reached after retry on last allowed page
    let p2Attempts = 0
    const fetchTruncated: FetchLike = async (url) => {
      if (url === page1Url) return okResp([{ id: 1 }], { link: `<${page2Url}>; rel="next"` })
      if (url === page2Url) {
        p2Attempts++
        if (p2Attempts === 1) return errResp(502)
        return okResp([{ id: 2 }], { link: `<${page3Url}>; rel="next"` })
      }
      throw new Error(`unexpected fetch for ${url}`)
    }
    const truncRes = await githubGetPaginatedList<{ id: number }>(
      page1Url,
      TEST_TOKEN,
      fetchTruncated,
      2,
      { sleepImpl: async () => {} },
    )
    assert.equal(truncRes.ok, true)
    if (truncRes.ok) {
      assert.deepEqual(truncRes.items, [{ id: 1 }, { id: 2 }])
      assert.equal(truncRes.truncated, true)
    }
    assert.equal(p2Attempts, 2)
  })

  test('reads OC_GITHUB_API_RETRY_BASE_DELAY_MS env override with validation and option precedence', async () => {
    const prev = process.env.OC_GITHUB_API_RETRY_BASE_DELAY_MS
    try {
      process.env.OC_GITHUB_API_RETRY_BASE_DELAY_MS = '25'
      const delaysEnv: number[] = []
      let calls = 0
      const failTwice: FetchLike = async () => {
        calls++
        return calls <= 2 ? errResp(503) : okResp({ ok: 1 })
      }
      await githubGetJsonObject(TEST_URL, TEST_TOKEN, failTwice, {
        sleepImpl: async (ms) => {
          delaysEnv.push(ms)
        },
      })
      assert.deepEqual(delaysEnv, [25, 50])

      // Invalid env falls back to default 500ms
      process.env.OC_GITHUB_API_RETRY_BASE_DELAY_MS = '-10'
      const delaysInvalid: number[] = []
      calls = 0
      await githubGetJsonObject(TEST_URL, TEST_TOKEN, failTwice, {
        sleepImpl: async (ms) => {
          delaysInvalid.push(ms)
        },
      })
      assert.deepEqual(delaysInvalid, [500, 1000])

      // Explicit retryOpts.baseDelayMs overrides env
      process.env.OC_GITHUB_API_RETRY_BASE_DELAY_MS = '25'
      const delaysOverride: number[] = []
      calls = 0
      await githubGetJsonObject(TEST_URL, TEST_TOKEN, failTwice, {
        baseDelayMs: 100,
        sleepImpl: async (ms) => {
          delaysOverride.push(ms)
        },
      })
      assert.deepEqual(delaysOverride, [100, 200])
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'OC_GITHUB_API_RETRY_BASE_DELAY_MS')
      else process.env.OC_GITHUB_API_RETRY_BASE_DELAY_MS = prev
    }
  })

  test('cancels non-2xx response bodies on both retries and fail-fast without masking HTTP error', async () => {
    let retryCancels = 0
    let retryCalls = 0
    const retryFetch: FetchLike = async () => {
      retryCalls++
      if (retryCalls <= 2) {
        return {
          ...errResp(503),
          body: {
            cancel: async () => {
              retryCancels++
            },
          },
        }
      }
      return okResp({ recovered: true })
    }
    const okRes = await githubGetJsonObject<{ recovered: boolean }>(
      TEST_URL,
      TEST_TOKEN,
      retryFetch,
      { sleepImpl: async () => {} },
    )
    assert.equal(okRes.ok, true)
    assert.equal(retryCancels, 2)

    let failFastCancels = 0
    const failFastFetch: FetchLike = async () => ({
      ...errResp(404),
      body: {
        cancel: async () => {
          failFastCancels++
          throw new Error('stream already closed')
        },
      },
    })
    const errRes = await githubGetJsonObject(TEST_URL, TEST_TOKEN, failFastFetch, {
      sleepImpl: async () => {},
    })
    assert.equal(errRes.ok, false)
    if (!errRes.ok) {
      assert.match(errRes.reason, /GitHub API HTTP 404/)
    }
    assert.equal(failFastCancels, 1)
  })
})
