/**
 * Outputs collected in the container are registered on the master (the
 * backend the UI reads), in the project frozen at turn start, and survive a
 * master outage through the local spool.
 * Run: npx tsx --test packages/gateway/src/__tests__/projectAssetOutputsMaster.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

process.env.OPENCLAUDE_HOME = await mkdtemp(join(tmpdir(), 'oc-outputs-master-'))

const { _resetOutputAssetSpoolThrottleForTest, collectSessionOutputAssets } = await import(
  '../projectAssetCollector.js'
)

const ENV = {
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.test/',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
} as NodeJS.ProcessEnv
const OUT = '/home/agent/.openclaude/generated/report.md'
const TEXT = `Saved the report to ${OUT}.`
const statFile = async () => ({ isFile: () => true, size: 42 })

type Reply = number | 'network'
function fetcherFrom(replies: Reply[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetcher = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) })
    const next = replies.shift() ?? 'network'
    if (next === 'network') throw new Error('ECONNREFUSED')
    return { statusCode: next, body: { text: async () => '{}' } }
  }) as unknown as typeof import('undici').request
  return { fetcher, calls }
}

let n = 0
function spool() {
  n += 1
  return join(process.env.OPENCLAUDE_HOME as string, `spool-${n}.jsonl`)
}
const noSleep = async () => {}

describe('container output assets → master', () => {
  beforeEach(() => _resetOutputAssetSpoolThrottleForTest())

  it('registers on the master with the project frozen at turn start', async () => {
    const { fetcher, calls } = fetcherFrom([200])
    await collectSessionOutputAssets({
      userId: 'default', sessionId: 's-1', assistantText: TEXT, chatProjectId: 'proj-a',
      env: ENV, fetcher, sleep: noSleep, statFile, spoolFile: spool(),
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'http://master.test/internal/v3/project-assets')
    assert.deepEqual(calls[0]?.body, {
      sessionId: 's-1',
      projectId: 'proj-a',
      items: [{ containerPath: OUT, name: 'report.md', mime: 'text/markdown', size: 42 }],
    })
  })

  it('an unresolved project is left for the master to infer; null is sent as ungrouped', async () => {
    const a = fetcherFrom([200])
    await collectSessionOutputAssets({ userId: 'default', sessionId: 's-1', assistantText: TEXT, env: ENV, fetcher: a.fetcher, sleep: noSleep, statFile, spoolFile: spool() })
    assert.equal(Object.hasOwn(a.calls[0]!.body, 'projectId'), false)
    const b = fetcherFrom([200])
    await collectSessionOutputAssets({ userId: 'default', sessionId: 's-1', assistantText: TEXT, chatProjectId: null, env: ENV, fetcher: b.fetcher, sleep: noSleep, statFile, spoolFile: spool() })
    assert.equal(b.calls[0]!.body.projectId, null)
  })

  it('retries a 5xx and stops at the first success', async () => {
    const { fetcher, calls } = fetcherFrom([502, 200])
    const file = spool()
    await collectSessionOutputAssets({ userId: 'default', sessionId: 's-1', assistantText: TEXT, env: ENV, fetcher, sleep: noSleep, statFile, spoolFile: file })
    assert.equal(calls.length, 2)
    await assert.rejects(readFile(file, 'utf8'))
  })

  it('a master outage spools the registration and the next collection sends it once', async () => {
    const file = spool()
    const down = fetcherFrom(['network', 'network', 'network'])
    await collectSessionOutputAssets({ userId: 'default', sessionId: 's-1', assistantText: TEXT, chatProjectId: 'proj-a', env: ENV, fetcher: down.fetcher, sleep: noSleep, statFile, spoolFile: file })
    const queued = (await readFile(file, 'utf8')).trim().split('\n')
    assert.equal(queued.length, 1)
    assert.equal(JSON.parse(queued[0]!).projectId, 'proj-a')

    _resetOutputAssetSpoolThrottleForTest()
    const up = fetcherFrom([200, 200])
    await collectSessionOutputAssets({ userId: 'default', sessionId: 's-2', assistantText: 'no files this turn', env: ENV, fetcher: up.fetcher, sleep: noSleep, statFile, spoolFile: file })
    assert.equal(up.calls.length, 1)
    assert.equal(up.calls[0]!.body.sessionId, 's-1')
    assert.equal(up.calls[0]!.body.projectId, 'proj-a')
    assert.equal((await readFile(file, 'utf8')).trim(), '')
  })

  it('a 4xx is final: not retried, not spooled', async () => {
    const file = spool()
    const { fetcher, calls } = fetcherFrom([400, 200])
    await collectSessionOutputAssets({ userId: 'default', sessionId: 's-1', assistantText: TEXT, env: ENV, fetcher, sleep: noSleep, statFile, spoolFile: file })
    assert.equal(calls.length, 1)
    await assert.rejects(readFile(file, 'utf8'))
  })

  it('a torn spool line is dropped, the rest still sent', async () => {
    const file = spool()
    await writeFile(file, `{"sessionId":"s-9","items":[{"containerPath":"${OUT}","name":"report.md"}]}\n{torn\n`)
    const up = fetcherFrom([200])
    await collectSessionOutputAssets({ userId: 'default', sessionId: 's-2', assistantText: '', env: ENV, fetcher: up.fetcher, sleep: noSleep, statFile, spoolFile: file })
    assert.equal(up.calls.length, 1)
    assert.equal(up.calls[0]!.body.sessionId, 's-9')
  })
})
