/**
 * A failed master read must not turn a project chat into an unbound one.
 * Run: npx tsx --test packages/gateway/src/__tests__/projectContextRuntime.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

process.env.OPENCLAUDE_HOME = await mkdtemp(join(tmpdir(), 'oc-projctx-rt-'))

const { _resetProjectMembershipCacheForTest, resolveTurnProjectContext } = await import(
  '../projectContextRuntime.js'
)
const { resolveChatRunWorkspace } = await import('../projectWorkspace.js')

const ENV = {
  OC_PROJECT_CONTEXT: '1',
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.test',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
} as NodeJS.ProcessEnv

type Reply = { status: number; body: unknown } | 'timeout' | 'network'

function fetcherFrom(replies: Reply[]) {
  const calls: string[] = []
  const fetcher = (async (url: string, init: { signal: AbortSignal }) => {
    calls.push(url)
    const next = replies.shift() ?? 'network'
    if (next === 'timeout') {
      await new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      )
    }
    if (next === 'network') throw new Error('ECONNREFUSED')
    const reply = next as { status: number; body: unknown }
    return {
      statusCode: reply.status,
      body: { text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) },
    }
  }) as unknown as typeof import('undici').request
  return { fetcher, calls }
}

const UNBOUND_BODY = {
  userId: 'c:3',
  chatProjectId: null,
  boardProjectId: null,
  name: null,
  instructions: null,
  pinnedAssets: [],
  assetsRevision: 0,
}
const PROJECT_BODY = { ...UNBOUND_BODY, chatProjectId: 'proj-1', name: '论文综述', instructions: '用学术中文' }

describe('project context read failure', () => {
  beforeEach(() => _resetProjectMembershipCacheForTest())

  it('retries once and uses the second answer', async () => {
    const { fetcher, calls } = fetcherFrom([{ status: 502, body: 'bad gateway' }, { status: 200, body: PROJECT_BODY }])
    const got = await resolveTurnProjectContext({ sessionId: 's-retry', env: ENV, fetcher })
    assert.equal(calls.length, 2)
    assert.equal(got?.unavailable, undefined)
    assert.equal(got?.instructions, '用学术中文')
  })

  it('a session in a project is held when the master stays unreachable', async () => {
    const ok = fetcherFrom([{ status: 200, body: PROJECT_BODY }])
    await resolveTurnProjectContext({ sessionId: 's-proj', env: ENV, fetcher: ok.fetcher })
    const down = fetcherFrom(['network', 'network'])
    const got = await resolveTurnProjectContext({ sessionId: 's-proj', env: ENV, fetcher: down.fetcher })
    assert.equal(got?.unavailable, 'network')
    assert.equal(got?.bound, false)
    assert.equal(got?.instructions, null)
  })

  it('a session never seen before is held too, since it may be in a project', async () => {
    const { fetcher } = fetcherFrom(['timeout', 'timeout'])
    const got = await resolveTurnProjectContext({ sessionId: 's-new', env: ENV, fetcher, timeoutMs: 20 })
    assert.equal(got?.unavailable, 'timeout')
  })

  it('a session known to be outside every project keeps running as before', async () => {
    const ok = fetcherFrom([{ status: 200, body: UNBOUND_BODY }])
    const before = await resolveTurnProjectContext({ sessionId: 's-plain', env: ENV, fetcher: ok.fetcher })
    assert.equal(before?.bound, false)
    const down = fetcherFrom([{ status: 500, body: '' }, { status: 500, body: '' }])
    const after = await resolveTurnProjectContext({ sessionId: 's-plain', env: ENV, fetcher: down.fetcher })
    assert.deepEqual(after, before)
    assert.equal(after?.unavailable, undefined)
  })

  it('a malformed body counts as a failure, not as "no project"', async () => {
    const { fetcher } = fetcherFrom([{ status: 200, body: 'not json' }, { status: 200, body: '[]' }])
    const got = await resolveTurnProjectContext({ sessionId: 's-bad', env: ENV, fetcher })
    assert.equal(got?.unavailable, 'bad_response')
  })

  it('resolveChatRunWorkspace passes the hold to the caller instead of a default cwd', async () => {
    // resolveChatRunWorkspace has no fetcher seam; it reads the same cache, so
    // prime it through the runtime and then point the env at a closed port.
    const env = { ...ENV, OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:9' } as NodeJS.ProcessEnv
    const ws = await resolveChatRunWorkspace({ sessionId: 's-ws', env })
    assert.equal(ws.unavailable, 'network')
    assert.equal(ws.workspaceCwd, undefined)
    assert.equal(ws.projectId, null)
  })

  it('flag off never consults the master', async () => {
    const { fetcher, calls } = fetcherFrom([])
    const got = await resolveTurnProjectContext({
      sessionId: 's-off',
      env: { ...ENV, OC_PROJECT_CONTEXT: '0' } as NodeJS.ProcessEnv,
      fetcher,
    })
    assert.equal(got, null)
    assert.equal(calls.length, 0)
  })
})
