/**
 * A spawn right after its turn's project read must not ask the master again:
 * a master that stalls on that second read used to hold the first turn for
 * 2 x 5 s before the prompt was built.
 * Run: npx tsx --test packages/gateway/src/__tests__/promptSpawnProjectRead.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

process.env.OPENCLAUDE_HOME = await mkdtemp(join(tmpdir(), 'oc-spawn-projread-'))
process.env.OC_PROJECT_CONTEXT = '1'
delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR

const { PROJECT_CONTEXT_PATH } = await import('@openclaude/protocol')

const projectReads: string[] = []
const stalled: ServerResponse[] = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://master.test')
  if (url.pathname !== PROJECT_CONTEXT_PATH) {
    res.writeHead(404).end()
    return
  }
  projectReads.push(url.search)
  if (projectReads.length > 1) {
    stalled.push(res) // accepted, never answered: the master stall seen in production
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      userId: 'c:3',
      chatProjectId: 'proj-spawn',
      boardProjectId: null,
      name: '远端首轮',
      instructions: 'SPAWN-READ-SENTINEL',
      pinnedAssets: [],
      assetsRevision: 0,
    }),
  )
})

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'container-token'
})
after(async () => {
  for (const res of stalled) res.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('spawn-time project context', () => {
  it('builds the prompt from the turn read while the master stalls', async () => {
    const { resolveTurnProjectContext } = await import('../projectContextRuntime.js')
    const { buildPromptContext } = await import('../promptSlots.js')
    const sessionId = 'web-spawn-projread'

    const turnRead = await resolveTurnProjectContext({ sessionId })
    assert.equal(turnRead?.unavailable, undefined)
    assert.equal(projectReads.length, 1)

    const startedAt = performance.now()
    const built = await buildPromptContext({ agentId: 'main', sessionId })
    const elapsedMs = performance.now() - startedAt

    assert.equal(projectReads.length, 1, 'the spawn asked the master again')
    assert.ok(elapsedMs < 4_000, `prompt build waited ${Math.round(elapsedMs)} ms`)
    assert.ok(built.content.includes('SPAWN-READ-SENTINEL'), 'project instructions missing from the prompt')
  })
})
