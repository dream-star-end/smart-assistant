import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  boxCcControlSummary,
  boxCcLaunchExec,
  boxCcWriteExec,
  cursorBoxCcEnabled,
  cursorBoxCcSelectionEligible,
  encodeExecRequest,
  parseExecFrames,
  remoteClaudeArgs,
  stripBoxCcParentAuth,
  writeBoxCcControlFile,
  type BoxCcControl,
} from '../engine/cursorBoxCc.js'
import { runBoxCcBridge } from '../engine/cursorBoxCcBridge.js'
import { cursorVariantFor } from '../engine/cursorRoutingAdapter.js'
import {
  cursorSandBoxCcResumeInnerId,
  CURSOR_SAND_BOX_CC_RESUME_PREFIX,
} from '../engine/cursorAdapter.js'
import { probeResumeArtifact } from '../engine/resumeArtifacts.js'
import type { CursorCredentialSelection } from '../engine/cursorCredentialSelection.js'
import type { CursorSandBoxPolicy } from '../engine/cursorSandBox.js'

const machine = 'abcdefghijklmnopqrstuvwxyz'
const selection: CursorCredentialSelection = {
  slot: 20,
  keyName: 'api-key.20',
  sandEnabled: true,
  poolGeneration: 'legacy',
  accountId: '329601097',
  keyFingerprint: '0123456789abcdef',
  credentialKind: 'session',
  machineId: machine,
}
const apiKeySelection: CursorCredentialSelection = {
  ...selection,
  credentialKind: 'api_key',
  machineId: null,
}

function token(sub = 'account-a'): string {
  return `x.${Buffer.from(JSON.stringify({ type: 'session', sub, exp: 2_000_000_000 })).toString('base64url')}.y`
}

test('box Claude is an account-pool session transport, not a second account system', () => {
  const env = { OC_CURSOR_SAND_BOX_CC: '1', OC_CURSOR_SAND_OFFICIAL_CC: '1' }
  assert.equal(cursorBoxCcEnabled(env), true)
  assert.equal(cursorBoxCcSelectionEligible(selection), true)
  assert.equal(cursorBoxCcSelectionEligible(apiKeySelection), false)
  assert.equal(cursorVariantFor('cursor-opus-5-max-fast', selection, { kind: 'local' }, env), 'sand-box-cc')
  assert.equal(cursorVariantFor('cursor-opus-5-max-fast', apiKeySelection, { kind: 'local' }, env), 'sand-official-cc')
  assert.equal(cursorVariantFor('cursor-opus-5-max-fast', selection, { kind: 'local' }, {}), 'sand-ccb')
  assert.equal(
    cursorVariantFor('cursor-opus-5-max-fast', selection, { kind: 'remote', hostId: 'h', hostMeta: {} as never }, env),
    'sand-ccb',
  )
  assert.equal(cursorVariantFor('cursor-auto', selection, { kind: 'local' }, env), 'native')
})

test('remote argv keeps model and resume and drops container paths', () => {
  const args = remoteClaudeArgs([
    '-p',
    '--model', 'claude-opus-4-8',
    '--settings', '/home/agent/.claude/settings.json',
    '--mcp-config', '/tmp/mcp.json',
    '--add-dir', '/home/agent/work',
    '--append-system-prompt-file', '/tmp/persona.md',
    '--resume', '3bdc1a6e-63e3-4a3b-a29f-9aeb4e08c1cd',
    '--permission-mode', 'bypassPermissions',
  ])
  assert.deepEqual(args, [
    '-p',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--model', 'claude-opus-4-8',
    '--resume', '3bdc1a6e-63e3-4a3b-a29f-9aeb4e08c1cd',
    '--permission-mode', 'bypassPermissions',
    '--dangerously-skip-permissions',
  ])
})

test('parent Anthropic route is stripped before the bridge starts', () => {
  const next = stripBoxCcParentAuth({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/route/' + 'a'.repeat(64),
    ANTHROPIC_AUTH_TOKEN: 'cursor-sand-loopback',
    ANTHROPIC_API_KEY: 'sk-test',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    PATH: '/usr/bin',
  }, '/tmp/control.json')
  assert.equal(next.ANTHROPIC_BASE_URL, undefined)
  assert.equal(next.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(next.ANTHROPIC_API_KEY, undefined)
  assert.equal(next.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.equal(next.PATH, '/usr/bin')
  assert.equal(next.OC_BOX_CC_CONTROL, '/tmp/control.json')
})

test('exec frames survive a split chunk and the user line stays out of argv', () => {
  const frame = encodeExecRequest({
    command: 'sh',
    args: ['-c', 'true'],
    cwd: '/workspace',
    environment: {},
  })
  // reuse the envelope layout: flags + length + json stdout event
  const event = Buffer.from(JSON.stringify({ stdoutEvent: { data: '{"type":"result"}\n' } }))
  const packed = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Uint8Array.of((event.length >>> 24) & 255, (event.length >>> 16) & 255, (event.length >>> 8) & 255, event.length & 255)),
    event,
  ])
  const split = parseExecFrames(packed.subarray(0, 3))
  assert.equal(split.events.length, 0)
  const rest = parseExecFrames(Buffer.concat([split.rest, packed.subarray(3)]))
  assert.equal(rest.events[0]?.kind, 'stdout')
  assert.match(rest.events[0]?.data ?? '', /"type":"result"/)
  assert.ok(frame.length > 5)

  const control: BoxCcControl = {
    execUrl: 'https://box.cursorvm.com/agent.v1.ControlService/Exec',
    execToken: 'local',
    networkToken: 'net',
    remoteClaude: '/home/box/.local/bin/claude',
    fifo: '/tmp/oc-box-cc-abcdef.fifo',
    cwd: '/workspace',
  }
  const line = '{"type":"user","message":{"role":"user","content":"hello"}}\n'
  const write = boxCcWriteExec(control, line.trimEnd())
  assert.equal(write.args.join(' ').includes('hello'), false)
  assert.equal(write.environment.OC_BOX_CC_LINE, line)
  const launch = boxCcLaunchExec(control, remoteClaudeArgs(['--model', 'claude-opus-4-8']))
  assert.equal(launch.environment.ANTHROPIC_API_KEY, undefined)
  assert.equal(launch.args.includes('/home/box/.local/bin/claude'), true)
  assert.equal(boxCcControlSummary(control).execHost, 'box.cursorvm.com')
})

test('resume id for a box transcript does not require a local JSONL', () => {
  const id = `${CURSOR_SAND_BOX_CC_RESUME_PREFIX}3bdc1a6e-63e3-4a3b-a29f-9aeb4e08c1cd`
  assert.equal(cursorSandBoxCcResumeInnerId(id), '3bdc1a6e-63e3-4a3b-a29f-9aeb4e08c1cd')
  assert.equal(cursorSandBoxCcResumeInnerId(`${CURSOR_SAND_BOX_CC_RESUME_PREFIX}../../x`), undefined)
  const probe = probeResumeArtifact('cursor', id, { claudeConfigDir: '/no/such/dir' })
  assert.equal(probe.exists, true)
  assert.equal(probe.path, undefined)
})

test('control file is private and the bridge copies one stdin line to stdout', async () => {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const policy: CursorSandBoxPolicy = {
    version: 1,
    accounts: [{
      accountId: selection.accountId,
      subjectHash: hash('account-a'),
      machineHash: hash(machine),
    }],
  }
  const previousNoProxy = process.env.NO_PROXY
  process.env.NO_PROXY = '127.0.0.1,localhost'
  const dir = mkdtempSync(join(tmpdir(), 'oc-box-cc-'))
  const lines: string[] = []
  let longRes: ServerResponse | null = null
  const queued: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const body = JSON.parse(raw.subarray(5).toString('utf8')) as {
        command: string
        args: string[]
        environment: Record<string, string>
      }
      assert.equal(req.headers.authorization, 'Bearer local')
      assert.equal(req.headers['x-anyrun-network-token'], 'net-token')
      if (body.command === 'python3') {
        lines.push(body.environment.OC_BOX_CC_LINE)
        assert.equal(body.args.join(' ').includes('hello-from-web'), false)
        res.writeHead(200, { 'content-type': 'application/connect+json' })
        res.end(frame({ exitEvent: { exitCode: 0 } }))
        const stdout = frame({ stdoutEvent: { data: '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n' } })
        const done = frame({ exitEvent: { exitCode: 0 } })
        if (longRes) {
          longRes.write(stdout)
          longRes.end(done)
        } else queued.push(body.environment.OC_BOX_CC_LINE)
      } else {
        assert.equal(body.args.includes('/home/box/.local/bin/claude'), true)
        assert.equal(body.environment.ANTHROPIC_BASE_URL, undefined)
        longRes = res
        res.writeHead(200, { 'content-type': 'application/connect+json' })
        if (queued.length > 0) {
          res.write(frame({ stdoutEvent: { data: '{"type":"assistant"}\n' } }))
          res.end(frame({ exitEvent: { exitCode: 0 } }))
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const execUrl = `https://box.cursorvm.com/agent.v1.ControlService/Exec`
  try {
    const path = await writeBoxCcControlFile({
      selection,
      sessionKey: 'agent:main:web:box',
      dir,
      readPolicy: () => policy,
      readToken: () => Buffer.from(token()),
      fetchImpl: async (url, init) => {
        assert.equal(init.redirect, 'error')
        const name = String(url).endsWith('GetSandBoxRunState') ? 'state' : 'ensure'
        if (name === 'state') return new Response(JSON.stringify({ state: 'SAND_BOX_RUN_STATE_RUNNING' }))
        return new Response(JSON.stringify({
          gatewayUrl: 'https://box.cursorvm.com/prefix',
          gatewayToken: 'GATE',
          networkToken: 'net-token',
          execDaemonUrl: 'https://box.cursorvm.com/exec',
          execDaemonAuthToken: 'local',
        }))
      },
    })
    const info = statSync(path)
    assert.equal(info.mode & 0o777, 0o600)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as BoxCcControl
    assert.equal(new URL(stored.execUrl).hostname, 'box.cursorvm.com')
    assert.match(stored.execUrl, /ControlService\/Exec$/)
    stored.execUrl = `http://127.0.0.1:${address.port}/agent.v1.ControlService/Exec`
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let out = ''
    stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    const code = runBoxCcBridge({
      control: stored,
      args: ['--model', 'claude-opus-4-8', '--settings', '/container/settings.json'],
      stdin,
      stdout,
      stderr,
      fetchImpl: async (url, init) => {
        const response = await fetch(String(url), init)
        return response
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    stdin.write('{"type":"user","hello-from-web":true}\n')
    assert.equal(await code, 0)
    assert.match(out, /assistant/)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /hello-from-web/)
    assert.equal(execUrl.startsWith('https://'), true)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
    if (previousNoProxy === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = previousNoProxy
  }
})

function frame(body: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(body))
  const out = Buffer.alloc(5 + payload.length)
  out[0] = 0
  out.writeUInt32BE(payload.length, 1)
  payload.copy(out, 5)
  return out
}
