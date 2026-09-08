import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'ocv5-179-agent-writes-'))
process.env.OPENCLAUDE_HOME = home
const { Gateway } = await import('../server.js')
const { paths, writeAgentsConfig, readAgentsConfig } = await import('@openclaude/storage')
after(() => rm(home, { recursive: true, force: true }))

beforeEach(async () => {
  await mkdir(paths.agentDir('managed'), { recursive: true })
  await writeFile(paths.agentClaudeMd('managed'), 'authority persona')
  await writeAgentsConfig({ default: 'main', routes: [], agents: [
    { id: 'main', model: 'old-local' },
    { id: 'managed', source: 'marketplace', model: 'authority-model', persona: paths.agentClaudeMd('managed') },
  ] })
})

async function invoke(handler: string, method: string, id: string, body: unknown = {}) {
  const gateway = Object.create(Gateway.prototype) as any
  let reply: { status: number; body: any } | undefined
  gateway.deps = { config: { defaults: { model: 'default', permissionMode: 'default' } } }
  gateway.router = { reload() {} }
  gateway.readJsonBody = async () => body
  gateway.sendJson = (_res: unknown, status: number, body: unknown) => { reply = { status, body } }
  gateway.sendError = (_res: unknown, status: number, error: string) => { reply = { status, body: { error } } }
  await gateway[handler]({ method }, {}, id)
  assert.ok(reply)
  return reply
}

for (const [handler, method] of [['handleAgentItem', 'PUT'], ['handleAgentItem', 'DELETE'], ['handlePersona', 'PUT']]) {
  test(`managed ${handler} ${method} refuses projection writes even with forged source`, async () => {
    const before = await readFile(paths.agentsYaml, 'utf8')
    const reply = await invoke(handler, method, 'managed', { source: undefined, model: 'forged', text: 'forged' })
    assert.equal(reply.status, 409)
    assert.match(JSON.stringify(reply.body), /marketplace|市场/)
    assert.equal(await readFile(paths.agentsYaml, 'utf8'), before)
    assert.equal(await readFile(paths.agentClaudeMd('managed'), 'utf8'), 'authority persona')
  })
}

test('local main remains editable and body.source cannot claim marketplace ownership', async () => {
  assert.equal((await invoke('handleAgentItem', 'PUT', 'main', { model: 'new-local', source: 'marketplace' })).status, 200)
  const main = (await readAgentsConfig()).agents.find(a => a.id === 'main')!
  assert.equal(main.model, 'new-local')
  assert.equal(main.source, undefined)
  assert.equal((await invoke('handlePersona', 'PUT', 'main', { text: 'local persona' })).status, 200)
  assert.equal(await readFile(paths.agentClaudeMd('main'), 'utf8'), 'local persona')
  assert.equal((await invoke('handleAgentItem', 'DELETE', 'main')).status, 400)
})

test('sync paused after config read cannot roll back a concurrent successful local save', async () => {
  const fs = (await import('node:fs/promises')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const { syncMarketplaceHub, marketplaceArtifactHash } = await import('@openclaude/storage')
  const originalRead = fs.readFile
  const originalFetch = globalThis.fetch
  const oldBase = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  const oldToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://test.invalid'
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'test-only'
  const manifest = JSON.stringify({ model: 'new-authority', persona: 'new authority persona' })
  globalThis.fetch = async () => new Response(JSON.stringify({ skills: [], agents: [{
    slug: 'managed', rawManifest: manifest, artifactHash: marketplaceArtifactHash(manifest), version: '2',
  }] }))
  let entered!: () => void
  const atPersona = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let paused = false
  fs.readFile = (async (...args: any[]) => {
    if (!paused && args[0] === paths.agentClaudeMd('managed')) {
      paused = true
      entered()
      await barrier
    }
    return (originalRead as any)(...args)
  }) as typeof fs.readFile
  syncBuiltinESMExports()
  let sync: Promise<void> | undefined
  let save: ReturnType<typeof invoke> | undefined
  try {
    sync = syncMarketplaceHub({ force: true })
    await Promise.race([atPersona, new Promise((_, reject) => setTimeout(() => reject(new Error('sync barrier timeout')), 3000).unref())])
    save = invoke('handleAgentItem', 'PUT', 'main', { model: 'saved-during-sync' })
    // Old code saves now then loses it when sync resumes. Locked code waits.
    await Promise.race([save, new Promise(resolve => setTimeout(resolve, 100))])
    release()
    await sync
    assert.equal((await save).status, 200)
    const cfg = await readAgentsConfig()
    assert.equal(cfg.agents.find(a => a.id === 'main')?.model, 'saved-during-sync')
    assert.equal(cfg.agents.find(a => a.id === 'managed')?.model, 'new-authority')
  } finally {
    release()
    await Promise.allSettled([sync, save])
    fs.readFile = originalRead
    syncBuiltinESMExports()
    globalThis.fetch = originalFetch
    if (oldBase === undefined) delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    else process.env.OPENCLAUDE_V3_MASTER_BASE_URL = oldBase
    if (oldToken === undefined) delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = oldToken
  }
})
