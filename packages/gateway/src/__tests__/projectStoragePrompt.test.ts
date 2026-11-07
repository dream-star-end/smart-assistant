/**
 * A read-only project dir must yield the turn's real prompt, with the same
 * instructions the resolver saw, all the way through buildPromptContext.
 * Real HTTP master, real directories and permissions, real file lock.
 * Run: npx tsx --test packages/gateway/src/__tests__/projectStoragePrompt.test.ts
 */
import * as assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'

process.env.OPENCLAUDE_HOME = await mkdtemp(join(tmpdir(), 'oc-projctx-prompt-'))
process.env.OC_PROJECT_CONTEXT = '1'
delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR

const { PROJECT_CONTEXT_PATH } = await import('@openclaude/protocol')
const { loadFrozenProjectContext, paths, writeProjectInstructions } = await import('@openclaude/storage')
const { _resetProjectContextCacheForTest, resolveTurnProjectContext } = await import('../projectContextRuntime.js')
const { resolveChatRunWorkspace } = await import('../projectWorkspace.js')
const { buildPromptContext } = await import('../promptSlots.js')

let master: Record<string, unknown> = {}
const server = createServer((req, res) => {
  if (req.url?.startsWith(`${PROJECT_CONTEXT_PATH}?`)) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(master))
  } else res.writeHead(404).end()
})

const locked: string[] = []
async function lockDir(dir: string, mode: number): Promise<void> {
  await chmod(dir, mode)
  locked.push(dir)
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'test-container-token'
})
after(async () => {
  for (const dir of locked) await chmod(dir, 0o700).catch(() => {})
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const asRoot = process.getuid?.() === 0

describe('read-only project dir through the prompt', { skip: asRoot ? 'permissions do not bind root' : false }, () => {
  beforeEach(() => _resetProjectContextCacheForTest())

  it('the prompt carries the local PROJECT.md and the fingerprint is unchanged', async () => {
    const id = randomUUID()
    assert.equal((await writeProjectInstructions(id, 'LOCAL-SENTINEL 只用中文', 0)).ok, true)
    master = { boardProjectId: id, chatProjectId: 'chat-a', name: '项目A', instructions: 'PG-STALE', pinnedAssets: [], assetsRevision: 0 }
    const writable = await resolveChatRunWorkspace({ sessionId: 'sess-a' })
    assert.equal(writable.bound, true)

    await lockDir(paths.projectDir(id), 0o555)
    _resetProjectContextCacheForTest()
    const ws = await resolveChatRunWorkspace({ sessionId: 'sess-a' })
    assert.equal(ws.unavailable, undefined)
    assert.equal(ws.bound, true)
    assert.equal(ws.contextFingerprint, writable.contextFingerprint)

    const prompt = await buildPromptContext({ agentId: 'main', sessionId: 'sess-a', projectId: id })
    assert.ok(prompt.content.includes('LOCAL-SENTINEL 只用中文'))
    assert.ok(!prompt.content.includes('PG-STALE'))
  })

  it('the prompt carries the seed that could not be written, with its digest', async () => {
    const id = randomUUID()
    await mkdir(paths.projectDir(id), { recursive: true })
    await lockDir(paths.projectDir(id), 0o555)
    master = { boardProjectId: id, chatProjectId: 'chat-b', name: '项目B', instructions: 'SEED-SENTINEL 用学术中文', pinnedAssets: [], assetsRevision: 0 }

    const ws = await resolveChatRunWorkspace({ sessionId: 'sess-b' })
    assert.equal(ws.unavailable, undefined)
    assert.equal(ws.bound, true)
    const prompt = await buildPromptContext({ agentId: 'main', sessionId: 'sess-b', projectId: id })
    assert.ok(prompt.content.includes('SEED-SENTINEL 用学术中文'))

    const resolved = await resolveTurnProjectContext({ sessionId: 'sess-b' })
    assert.equal(resolved?.unwrittenSeed, 'SEED-SENTINEL 用学术中文')
    const frozen = await loadFrozenProjectContext({ boardProjectId: id, unwrittenSeed: resolved!.unwrittenSeed })
    assert.equal(frozen.instructions, 'SEED-SENTINEL 用学术中文')
    assert.equal(frozen.projectMdSha256, createHash('sha256').update('SEED-SENTINEL 用学术中文').digest('hex'))
  })

  it('a held lock is not mistaken for a read-only dir', async () => {
    const id = randomUUID()
    assert.equal((await writeProjectInstructions(id, 'COMMITTED', 0)).ok, true)
    await writeFile(paths.projectLock(id), 'other-writer')
    master = { boardProjectId: id, chatProjectId: 'chat-c', name: '项目C', instructions: null, pinnedAssets: [], assetsRevision: 0 }
    await assert.rejects(resolveTurnProjectContext({ sessionId: 'sess-c' }), (err: Error) => !('code' in err) || (err as NodeJS.ErrnoException).code !== 'EACCES')
  })
})
