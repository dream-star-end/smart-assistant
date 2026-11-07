/**
 * Project files the container cannot write (a root-owned project dir) used to
 * throw out of the turn-start read, so the turn was rejected as "not started"
 * with nothing pointing at the directory. Real directories, real permissions.
 * Run: npx tsx --test packages/gateway/src/__tests__/projectStorageUnwritable.test.ts
 */
import * as assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

process.env.OPENCLAUDE_HOME = await mkdtemp(join(tmpdir(), 'oc-projctx-perm-'))

const { _resetProjectContextCacheForTest, resolveTurnProjectContext } = await import('../projectContextRuntime.js')
const { resolveChatRunWorkspace } = await import('../projectWorkspace.js')
const { paths, writeProjectInstructions } = await import('@openclaude/storage')

const ENV = {
  OC_PROJECT_CONTEXT: '1',
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.test',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
} as NodeJS.ProcessEnv

function masterSays(body: Record<string, unknown>) {
  return (async () => ({
    statusCode: 200,
    body: { text: async () => JSON.stringify(body) },
  })) as unknown as typeof import('undici').request
}

const locked: string[] = []
async function lockDir(dir: string, mode: number): Promise<void> {
  await chmod(dir, mode)
  locked.push(dir)
}
after(async () => {
  for (const dir of locked) await chmod(dir, 0o700).catch(() => {})
})

const asRoot = process.getuid?.() === 0

describe('project files the container cannot write', { skip: asRoot ? 'permissions do not bind root' : false }, () => {
  beforeEach(() => _resetProjectContextCacheForTest())

  it('runs the turn with the local PROJECT.md when the dir is read-only', async () => {
    const id = randomUUID()
    const wrote = await writeProjectInstructions(id, '只用中文回答', 0)
    assert.equal(wrote.ok, true)
    await lockDir(paths.projectDir(id), 0o555)

    const fetcher = masterSays({ chatProjectId: null, boardProjectId: id, name: '论文', instructions: 'master text' })
    const got = await resolveTurnProjectContext({ boardProjectId: id, env: ENV, fetcher })
    assert.equal(got?.unavailable, undefined)
    assert.equal(got?.bound, true)
    assert.equal(got?.boardProjectId, id)
    assert.equal(got?.instructions, '只用中文回答')

    const ws = await resolveChatRunWorkspace({ boardProjectId: id, env: { ...ENV } })
    assert.equal(ws.unavailable, undefined)
    assert.equal(ws.bound, true)
    assert.equal(ws.projectId, id)
  })

  it('uses what the seed would have written when it cannot be written', async () => {
    const id = randomUUID()
    await mkdir(paths.projectDir(id), { recursive: true })
    await lockDir(paths.projectDir(id), 0o555)

    const fetcher = masterSays({ chatProjectId: null, boardProjectId: id, name: '论文', instructions: '  用学术中文  ' })
    const got = await resolveTurnProjectContext({ boardProjectId: id, env: ENV, fetcher })
    assert.equal(got?.unavailable, undefined)
    assert.equal(got?.bound, true)
    assert.equal(got?.instructions, '用学术中文')
    assert.deepEqual(await readdir(paths.projectDir(id)), [])
  })

  it('a deliberately cleared PROJECT.md is not refilled from the master', async () => {
    const id = randomUUID()
    const set = await writeProjectInstructions(id, 'first', 0)
    assert.equal(set.ok, true)
    const cleared = await writeProjectInstructions(id, null, 1)
    assert.equal(cleared.ok, true)
    await lockDir(paths.projectDir(id), 0o555)

    const fetcher = masterSays({ chatProjectId: null, boardProjectId: id, name: '论文', instructions: 'stale pg text' })
    const got = await resolveTurnProjectContext({ boardProjectId: id, env: ENV, fetcher })
    assert.equal(got?.unavailable, undefined)
    assert.equal(got?.instructions, null)
  })

  it('holds the turn with the errno when the dir cannot even be read', async () => {
    const id = randomUUID()
    const wrote = await writeProjectInstructions(id, '只用中文回答', 0)
    assert.equal(wrote.ok, true)
    await lockDir(paths.projectDir(id), 0o000)

    const fetcher = masterSays({ chatProjectId: null, boardProjectId: id, name: '论文', instructions: 'master text' })
    const got = await resolveTurnProjectContext({ boardProjectId: id, env: ENV, fetcher })
    assert.equal(got?.unavailable, 'project_storage_unavailable')
    assert.equal(got?.unavailableCode, 'EACCES')
    assert.equal(got?.instructions, null)

    const ws = await resolveChatRunWorkspace({ boardProjectId: id, env: { ...ENV } })
    assert.equal(ws.unavailable, 'project_storage_unavailable')
    assert.equal(ws.unavailableCode, 'EACCES')
  })
})
