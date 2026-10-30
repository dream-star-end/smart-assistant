import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-doc-attachment-'))
process.env.OPENCLAUDE_HOME = home
for (const key of ['OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN']) {
  delete process.env[key]
}
const { Gateway, PerTurnDelegationGuard } = await import('../server.js')
const { paths } = await import('@openclaude/storage')
after(() => rmSync(home, { recursive: true, force: true }))

test('an unparsed legacy Word attachment tells the model to convert it automatically', async () => {
  const { mkdirSync } = await import('node:fs')
  const dir = join(paths.uploadsDir, 'legacy-doc')
  mkdirSync(dir, { recursive: true })
  const originalPath = join(dir, 'legacy.doc')
  writeFileSync(originalPath, Buffer.from('d0cf11e0a1b11ae1', 'hex'))
  const agent = { id: 'main', provider: 'anthropic', model: 'claude-sonnet-4-6' }
  const payloads: string[] = []
  const gateway = Object.create(Gateway.prototype) as any
  Object.assign(gateway, {
    _shuttingDown: false,
    clientsByPeer: new Map(),
    lastActiveChannel: new Map(),
    _seenIdempotencyKeys: new Map(),
    _hiddenDelegateGuard: new PerTurnDelegationGuard(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    rateLimiter: { check: () => true },
    router: { route: () => ({ sessionKey: 'agent:main:webchat:dm:legacy-doc', agent }) },
    deps: {
      config: {
        version: 1,
        provider: 'anthropic',
        gateway: { bind: '127.0.0.1', port: 18791, accessToken: 'fixture' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/fixture-ccb' },
        defaults: { model: 'claude-sonnet-4-6', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
      },
    },
    _getAgentsConfig: async () => ({ default: 'main', agents: [agent] }),
    _isIdempotencyDuplicate: () => false,
    _markIdempotencyKey() {},
    _runLog: { start: () => ({}), complete() {} },
    sessions: {
      getOrCreate: async () => ({
        agentId: 'main', currentTurnStatus: null, runner: { sendPermissionResponse() {} },
      }),
      submit: async (_session: unknown, payload: string) => { payloads.push(payload) },
      beginClientTurn() {},
      endClientTurn() {},
    },
    deliver() {},
  })
  await gateway.dispatchInbound({
    type: 'inbound.message', channel: 'webchat',
    peer: { id: 'legacy-doc', kind: 'dm' },
    content: {
      text: '请总结这份旧版 Word',
      media: [{ kind: 'file', url: '/api/media/legacy-doc/legacy.doc', mimeType: 'application/msword', filename: '旧版.doc' }],
    },
    _userId: '1',
  })
  assert.equal(payloads.length, 1)
  const payload = payloads[0]!
  assert.ok(payload.includes(originalPath))
  assert.match(payload, /请总结这份旧版 Word/)
  assert.match(payload, /libreoffice --headless --convert-to docx "<原文件>" --outdir \/tmp/)
  assert.match(payload, /再读取转换后的 \.docx/)
  assert.match(payload, /仅当文件本身损坏导致转换失败/)
  assert.doesNotMatch(payload, /请用户转存|重传/)
})
