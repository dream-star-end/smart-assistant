/** OCV5-746: the container tool host must not gate the remote start, and a stale cached catalog
 *  must be replaced before any tool roundtrip is served. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { Cc5BridgeBinding } from '../cc5BridgePort.js'
import { runCc5StdioBridge } from '../cc5StdioBridge.js'
import { type Cc5HostTool, type Cc5ToolCatalog, compileCc5ToolCatalog } from '../cc5ToolCatalog.js'
import { cc5ToolCatalogCacheKey, readCc5ToolCatalogCache, removeCc5ToolCatalogCache,
  writeCc5ToolCatalogCache } from '../cc5ToolCatalogCache.js'

const TOOLS: Record<string, Cc5HostTool[]> = {
  first: [
    { name: 'Read', description: 'Read a file.', inputSchema: { type: 'object', properties: {} } },
    { name: 'Bash', description: 'Run a command.', inputSchema: { type: 'object', properties: {} } },
  ],
  second: [
    { name: 'Read', description: 'Read a file.', inputSchema: { type: 'object', properties: {} } },
    { name: 'Bash', description: 'Run a command.', inputSchema: { type: 'object', properties: {} } },
    { name: 'local.echo', description: 'Echo.', inputSchema: { type: 'object', properties: {} } },
  ],
}
function catalog(name: keyof typeof TOOLS): Cc5ToolCatalog {
  return compileCc5ToolCatalog(TOOLS[name]!)
}
const binding: Cc5BridgeBinding = {
  version: 2,
  backendKind: 'cc5-interactive-v1',
  canonicalModel: 'box-claude-sonnet-5',
  sessionKey: 'agent:main:webchat:dm:cache_fixture',
  runId: randomUUID(),
  uid: '912',
  containerDbId: '91',
  dockerId: 'a'.repeat(64),
  operationId: randomUUID(),
  capability: 'b'.repeat(64),
  expiresAt: Date.now() + 120000,
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cc5-catalog-cache-'))
  chmodSync(root, 0o700)
  const executionRoot = join(root, 'native-tools')
  mkdirSync(executionRoot, { mode: 0o700 })
  const sessionDir = join(root, 'session')
  mkdirSync(sessionDir, { mode: 0o700 })
  const mcpConfigPath = join(sessionDir, 'mcp-config.json')
  const settingsPath = join(sessionDir, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ hooks: {} }), { mode: 0o600 })
  // Different per-session values, as every real start writes them.
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { memory: { command: 'node',
    args: ['/fixture/memory.cjs'], env: { OPENCLAUDE_SESSION_KEY: binding.sessionKey,
      OPENCLAUDE_GATEWAY_TOKEN: 'fixture-token' } } } }), { mode: 0o600 })
  return { root, executionRoot, sessionDir, mcpConfigPath, settingsPath,
    lane: { version: 1 as const, platformPrompt: 'fixture platform prompt',
      host: { cwd: root, mcpConfigPath, settingsPath, disallowedTools: ['SendMessage'] } },
    cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
type Recorder = { events: string[]; registers: Array<Record<string, unknown>>;
  refuseRelaunch: boolean; executed: string[] }
function controlServer(socketPath: string, recorder: Recorder) {
  const server = createServer((req, res) => {
    // The stream request is answered before (and while) its body keeps arriving.
    if (req.url === '/session/open') {
      recorder.events.push('open')
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
        const lines = body.split('\n')
        body = lines.pop() ?? ''
        for (const line of lines) {
          const envelope = JSON.parse(line) as { bytes?: string }
          const frame = Buffer.from(envelope.bytes ?? '', 'base64').toString('utf8')
          if (frame.includes('"type":"user"') && !recorder.events.includes('frame')) recorder.events.push('frame')
        }
      })
      res.writeHead(200, { 'content-type': 'text/plain', 'x-cc5-interactive-ready': '1',
        'x-cc5-stream-generation': '1', 'x-cc5-out-seq': '0' })
      res.flushHeaders()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const ok = (value: Record<string, unknown>) => res.end(JSON.stringify({ ok: true, ...value }))
      if (req.url === '/tool/register') {
        const relaunch = body.relaunch === true
        recorder.events.push(relaunch ? 'relaunch' : 'register')
        recorder.registers.push(body)
        if (relaunch && recorder.refuseRelaunch) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end('{"ok":false,"error":"CC5_RELAY_REJECTED"}')
          return
        }
        const profile = body.profile as { toolNames: Record<string, string> }
        ok({ lifecycleId: body.lifecycleId, toolNames: profile.toolNames })
        return
      }
      if (req.url === '/tool/stopped') {
        ok({ lifecycleId: body.lifecycleId, localStopped: true })
        return
      }
      if (req.url === '/stop') {
        ok({ remoteStopped: true })
        return
      }
      if (req.url === '/tool/next') {
        recorder.events.push('next')
        setTimeout(() => ok({ delivery: null }), 50)
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  return server
}
async function harness(options: { seed?: keyof typeof TOOLS; live: keyof typeof TOOLS;
  refuseRelaunch?: boolean } = { live: 'first' }) {
  const f = fixture()
  const socketPath = join(f.root, 'bridge.sock')
  const recorder: Recorder = { events: [], registers: [], refuseRelaunch: options.refuseRelaunch ?? false,
    executed: [] }
  const server = controlServer(socketPath, recorder)
  server.listen(socketPath)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const key = cc5ToolCatalogCacheKey(f.lane.host)
  assert.ok(key)
  if (options.seed) writeCc5ToolCatalogCache(f.executionRoot, key, catalog(options.seed))
  let releaseTools!: () => void
  const toolsGate = new Promise<void>((resolve) => {
    releaseTools = resolve
  })
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()
  const controller = new AbortController()
  const running = runCc5StdioBridge({
    binding,
    sessionKey: binding.sessionKey,
    stdin,
    stdout,
    socketPath,
    signal: controller.signal,
    tools: { keyring: new Map([['fixture', Buffer.alloc(32)]]), executionRoot: f.executionRoot, lane: f.lane,
      hostFactory: () => ({
        async tools() {
          await toolsGate
          recorder.events.push('tools')
          return TOOLS[options.live]
        },
        async execute(name: string) {
          recorder.executed.push(name)
          return { content: [{ type: 'text', text: 'fixture' }], isError: false }
        },
        async close() {},
      }) },
  })
  void running.catch(() => {})
  const sendUser = (text: string) =>
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`)
  return { f, key, recorder, releaseTools, controller, running, sendUser,
    async cleanup() {
      releaseTools()
      controller.abort()
      await running.catch(() => {})
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      f.cleanup()
    } }
}
async function until(predicate: () => boolean, events?: string[]): Promise<void> {
  const end = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < end, `bounded fixture condition: ${JSON.stringify(events)}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a verified cache entry registers the catalog before the host answers tools/list', async () => {
  const h = await harness({ seed: 'first', live: 'first' })
  try {
    // Registration and the remote stream both happen while the host is still booting.
    await until(() => h.recorder.events.includes('register'), h.recorder.events)
    await until(() => h.recorder.events.includes('open'), h.recorder.events)
    assert.deepEqual(h.recorder.events.slice(0, 2), ['register', 'open'])
    assert.equal(h.recorder.events.includes('tools'), false)
    const registered = h.recorder.registers[0]!.profile as { catalog: string; catalogSha256: string }
    assert.equal(registered.catalog, catalog('first').json)
    assert.equal(registered.catalogSha256, catalog('first').sha256)
    h.releaseTools()
    await until(() => h.recorder.events.includes('next'), h.recorder.events)
    // The first roundtrip is only served after the live catalog matched the registered one.
    assert.deepEqual(h.recorder.events.slice(0, 4), ['register', 'open', 'tools', 'next'])
    assert.equal(h.recorder.registers.length, 1)
    assert.deepEqual(readCc5ToolCatalogCache(h.f.executionRoot, h.key)?.sha256, catalog('first').sha256)
  } finally {
    await h.cleanup()
  }
})

test('without a cache entry registration still waits for the host, then stores the catalog', async () => {
  const h = await harness({ live: 'first' })
  try {
    h.releaseTools()
    await until(() => h.recorder.events.includes('next'), h.recorder.events)
    assert.deepEqual(h.recorder.events.slice(0, 2), ['tools', 'register'])
    assert.equal(readCc5ToolCatalogCache(h.f.executionRoot, h.key)?.sha256, catalog('first').sha256)
  } finally {
    await h.cleanup()
  }
})

test('a stale cache entry relaunches the remote with the live catalog before serving a tool', async () => {
  const h = await harness({ seed: 'first', live: 'second' })
  try {
    // The remote is already launched with the cached catalog when the host finally answers.
    await until(() => h.recorder.events.includes('open'), h.recorder.events)
    h.releaseTools()
    await until(() => h.recorder.events.includes('relaunch'), h.recorder.events)
    const replacement = h.recorder.registers[1]!
    assert.equal(replacement.replace, true)
    assert.equal(replacement.relaunch, true)
    const profile = replacement.profile as { catalog: string }
    assert.equal(profile.catalog, catalog('second').json)
    await until(() => h.recorder.events.includes('next'), h.recorder.events)
    // Nothing is served between the stale registration and its replacement.
    assert.deepEqual(h.recorder.events.slice(0, 5), ['register', 'open', 'tools', 'relaunch', 'next'])
    assert.equal(h.recorder.registers.length, 2)
    assert.deepEqual(h.recorder.executed, [])
    // The entry is repaired, not left to fail again on the next start.
    assert.equal(readCc5ToolCatalogCache(h.f.executionRoot, h.key)?.sha256, catalog('second').sha256)
  } finally {
    await h.cleanup()
  }
})

test('the user message waits for the catalog check, so a stale launch is replaced before it sees the turn', async () => {
  const h = await harness({ seed: 'first', live: 'second' })
  try {
    h.sendUser('hello')
    // The remote stream is ready, but the host has not answered: the user frame is held back.
    await until(() => h.recorder.events.includes('open'), h.recorder.events)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(h.recorder.events.includes('frame'), false)
    h.releaseTools()
    await until(() => h.recorder.events.includes('frame'), h.recorder.events)
    assert.ok(h.recorder.events.indexOf('relaunch') < h.recorder.events.indexOf('frame'), JSON.stringify(h.recorder.events))
  } finally {
    await h.cleanup()
  }
})

test('with a matching cache entry the user message goes out as soon as the host confirms it', async () => {
  const h = await harness({ seed: 'first', live: 'first' })
  try {
    h.sendUser('hello')
    await until(() => h.recorder.events.includes('open'), h.recorder.events)
    h.releaseTools()
    await until(() => h.recorder.events.includes('frame'), h.recorder.events)
    const order = h.recorder.events.filter((event) => event !== 'next')
    assert.deepEqual(order.slice(0, 4), ['register', 'open', 'tools', 'frame'])
  } finally {
    await h.cleanup()
  }
})

test('a refused relaunch ends the bridge without serving any tool', async () => {
  const h = await harness({ seed: 'first', live: 'second', refuseRelaunch: true })
  try {
    await until(() => h.recorder.events.includes('open'), h.recorder.events)
    h.releaseTools()
    await assert.rejects(h.running)
    assert.equal(h.recorder.events.includes('next'), false)
    assert.deepEqual(h.recorder.executed, [])
    // The stale entry is gone, so the next start boots the host instead of trusting it.
    assert.equal(readCc5ToolCatalogCache(h.f.executionRoot, h.key), undefined)
  } finally {
    await h.cleanup()
  }
})

test('cache keys survive per-session config values but not a changed catalog input', () => {
  const f = fixture()
  try {
    const base = cc5ToolCatalogCacheKey(f.lane.host)
    assert.ok(base)
    // Same tool sources in a new session dir with new secret values: same key.
    const other = { ...f.lane.host, mcpConfigPath: join(f.root, 'mcp-config.json'),
      settingsPath: join(f.root, 'settings.json') }
    writeFileSync(other.settingsPath, JSON.stringify({ hooks: {} }), { mode: 0o600 })
    writeFileSync(other.mcpConfigPath, JSON.stringify({ mcpServers: { memory: { command: 'node',
      args: ['/fixture/memory.cjs'], env: { OPENCLAUDE_SESSION_KEY: 'another-session',
        OPENCLAUDE_GATEWAY_TOKEN: 'another-token' } } } }), { mode: 0o600 })
    assert.equal(cc5ToolCatalogCacheKey(other), base)
    // A different tool source, cwd, settings or disallowed list must not reuse the entry.
    assert.notEqual(cc5ToolCatalogCacheKey({ ...other, cwd: join(f.root, 'elsewhere') }), base)
    assert.notEqual(cc5ToolCatalogCacheKey({ ...other, disallowedTools: [] }), base)
    writeFileSync(other.settingsPath, JSON.stringify({ hooks: { PreToolUse: [] } }), { mode: 0o600 })
    assert.notEqual(cc5ToolCatalogCacheKey(other), base)
    writeFileSync(other.mcpConfigPath, JSON.stringify({ mcpServers: { memory: { command: 'node',
      args: ['/fixture/memory.cjs'], env: { EXTRA_FLAG: '1' } } } }), { mode: 0o600 })
    assert.notEqual(cc5ToolCatalogCacheKey(other), base)
    // A missing input is never keyed rather than keyed without it.
    assert.equal(cc5ToolCatalogCacheKey({ ...other, settingsPath: join(f.root, 'gone.json') }), undefined)
    assert.equal(cc5ToolCatalogCacheKey({ ...other, mcpConfigPath: join(f.root, 'gone.json') }), undefined)
  } finally {
    f.cleanup()
  }
})

test('a cache entry is validated before use and can always be dropped', () => {
  const f = fixture()
  try {
    const key = cc5ToolCatalogCacheKey(f.lane.host)!
    writeCc5ToolCatalogCache(f.executionRoot, key, catalog('first'))
    assert.equal(readCc5ToolCatalogCache(f.executionRoot, key)?.json, catalog('first').json)
    const path = join(f.executionRoot, 'catalog-cache', `${key}.json`)
    // A catalog whose digest does not match the stored one is not a usable entry.
    const entry = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...entry, catalog: catalog('second').json }), { mode: 0o600 })
    assert.equal(readCc5ToolCatalogCache(f.executionRoot, key), undefined)
    writeCc5ToolCatalogCache(f.executionRoot, key, catalog('first'))
    chmodSync(path, 0o644)
    assert.equal(readCc5ToolCatalogCache(f.executionRoot, key), undefined)
    chmodSync(path, 0o600)
    assert.equal(readCc5ToolCatalogCache(f.executionRoot, key)?.sha256, catalog('first').sha256)
    removeCc5ToolCatalogCache(f.executionRoot, key)
    assert.equal(readCc5ToolCatalogCache(f.executionRoot, key), undefined)
  } finally {
    f.cleanup()
  }
})
