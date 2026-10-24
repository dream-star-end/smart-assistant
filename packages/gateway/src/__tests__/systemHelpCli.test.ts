import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { handleSystemHelpLocal } from '../systemHelpHttp.js'
import { SystemHelpRelay, SYSTEM_HELP_LOCAL_PATH } from '../systemHelpRelay.js'
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../../commercial/agent-sandbox/platform-runtime/bin/oc-system.py')
async function fixture(t: import('node:test').TestContext) {
  const calls: Record<string, unknown>[] = []
  const proposalId = randomUUID()
  const relay = new SystemHelpRelay(async raw => {
    const body = raw as Record<string, unknown>; calls.push(body)
    if (body.kind === 'refresh') return { token: 'synthetic-short-context', expiresAt: Date.now() + 60000 }
    if (body.kind === 'prepare') return { id: proposalId, state: 'prepared', executor: 'master', operationId: body.operationId }
    if (body.kind === 'result') return { id: proposalId, state: 'prepared', result: null }
    if (body.kind === 'catalog') return { items: [{ id: 'fixture.read', effect: 'read' }], next: null }
    return { prefs: { intelligent_ui: true } }
  })
  const session = {}; const end = relay.begin(session, 'synthetic-bootstrap-context')
  const file = relay.contextFile('synthetic-session')
  let stop = relay.openAttempt(session, 'synthetic-session', () => true)
  const server = createServer((req, res) => { void handleSystemHelpLocal(req, res, relay) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const port = address.port
  const home = mkdtempSync(join(tmpdir(), 'oc-system-cli-proof-'))
  t.after(async () => { stop(); end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  async function run(args: string[], contextFile = file) {
    return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('python3', [cli, ...args], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home,
        OPENCLAUDE_SYSTEM_HELP_CONTEXT_FILE: contextFile, OPENCLAUDE_GATEWAY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk.toString() }); child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }))
    })
  }
  async function post(body: unknown, origin?: string) {
    return await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: SYSTEM_HELP_LOCAL_PATH, method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject); req.end(JSON.stringify(body))
    })
  }
  return { run, post, calls, proposalId, file, stop: () => stop(), next: () => { stop(); stop = relay.openAttempt(session, 'synthetic-session', () => true) } }
}
test('actual Python CLI loads skills offline and sends only scoped reads or frozen proposals through the loopback relay', async t => {
  const f = await fixture(t)
  const help = await f.run(['skill', 'preferences'], '/synthetic-missing-context')
  assert.equal(help.status, 0); assert.ok(help.stdout.includes('偏好')); assert.equal(f.calls.length, 0)
  const catalog = await f.run(['catalog'])
  assert.equal(catalog.status, 0); assert.equal(JSON.parse(catalog.stdout).items[0].id, 'fixture.read')
  const read = await f.run(['read', 'fixture.read', '--args', '{}'])
  assert.equal(read.status, 0); assert.deepEqual(JSON.parse(read.stdout), { prefs: { intelligent_ui: true } })
  const prepared = await f.run(['prepare', 'fixture.write', '--args', '{"enabled":false}', '--request-id', 'synthetic-original-request'])
  assert.equal(prepared.status, 0)
  assert.deepEqual(JSON.parse(prepared.stdout).reference, { type: 'system_action', proposalId: f.proposalId })
  assert.equal(JSON.parse(prepared.stdout).proposal.state, 'prepared')
  assert.equal(f.calls.find(x => x.kind === 'prepare')?.idempotencyKey, 'synthetic-original-request')
  const result = await f.run(['result', f.proposalId]); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).state, 'prepared')
  assert.equal((await f.run(['execute', f.proposalId])).status, 2)
  assert.equal((await f.run(['confirm', f.proposalId])).status, 2)
  for (const output of [catalog, read, prepared, result]) {
    assert.equal(output.stdout.includes('synthetic-bootstrap-context'), false)
    assert.equal(output.stdout.includes('synthetic-short-context'), false)
    assert.equal(output.stderr, '')
  }
})
test('warm attempts rewrite one context path; expired nonces, browser origins and actor overrides fail closed', async t => {
  const f = await fixture(t)
  const old = JSON.parse(readFileSync(f.file, 'utf8'))
  f.next()
  const fresh = JSON.parse(readFileSync(f.file, 'utf8'))
  assert.notEqual(fresh.nonce, old.nonce)
  assert.equal(await f.post({ nonce: old.nonce, context: old.context, command: { kind: 'catalog' } }), 403)
  assert.equal(await f.post({ nonce: fresh.nonce, context: fresh.context, command: { kind: 'catalog' } }, 'https://synthetic-browser.example'), 403)
  assert.equal(await f.post({ nonce: fresh.nonce, context: fresh.context, command: { kind: 'catalog', userId: '765' } }), 400)
  assert.equal((await f.run(['catalog'])).status, 0)
  f.stop()
  const stopped = await f.run(['catalog'])
  assert.equal(stopped.status, 1); assert.equal(stopped.stdout, '')
  assert.equal(stopped.stderr.includes('synthetic-bootstrap-context'), false)
})
