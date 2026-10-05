import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import {
  BOX_CC_STOP_SCRIPT,
  boxCcControlSummary,
  boxCcLaunchExec,
  boxCcSpawnFifo,
  boxCcStopExec,
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
  assert.equal(cursorVariantFor('box-claude-opus-5-5', selection, { kind: 'local' }, env), 'sand-box-cc')
  assert.equal(cursorVariantFor('cursor-opus-5-max-fast', selection, { kind: 'local' }, env), 'sand-official-cc')
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
    '--model', 'box-claude-opus-5-5',
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
    '--model', 'claude-opus-5-5',
    '--resume', '3bdc1a6e-63e3-4a3b-a29f-9aeb4e08c1cd',
    '--permission-mode', 'bypassPermissions',
    '--dangerously-skip-permissions',
  ])
})


test('legacy Cursor Sand slugs map to the box CLI ids', () => {
  const head = [
    '-p',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
  ]
  assert.deepEqual(remoteClaudeArgs(['--model', 'cursor-opus-5-high']), [...head, '--model', 'claude-opus-5-5'])
  assert.deepEqual(remoteClaudeArgs(['--model', 'cursor-fable-5.1-high']), [...head, '--model', 'claude-opus-5-5'])
  assert.deepEqual(remoteClaudeArgs(['--model', 'cursor-sonnet-5-high']), [...head, '--model', 'claude-sonnet-5'])
  assert.deepEqual(remoteClaudeArgs(['--model', 'cursor-haiku-4.5']), [...head, '--model', 'claude-haiku-4-5'])
  assert.deepEqual(remoteClaudeArgs(['--model', 'cursor-grok-4.7-high']), [...head, '--model', 'cursor-grok-4.7-high'])
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
  assert.match(String(launch.args[1]), /exec 3<>"\$fifo"/)
  assert.doesNotMatch(String(launch.args[1]), /exec "\$claude"/)
  assert.equal(boxCcSpawnFifo(control.fifo, '0123abcd'), '/tmp/oc-box-cc-abcdef.0123abcd.fifo')
  assert.throws(() => boxCcSpawnFifo(control.fifo, '../x'), /BOX_CC_FIFO_INVALID/)
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

// INC-20261005-BOX-CC-FOLLOWUP-TURN: closing stdin used to do nothing. The
// runner then SIGKILLed the bridge, the next turn was reported as a crash,
// and the box Claude stayed alive on the session.
async function bridgeAgainstFakeBox(remoteEndsOnStop: boolean): Promise<{
  code: number | 'pending'
  out: string
  launchFifo: string
  stopFifos: string[]
}> {
  const previousNoProxy = process.env.NO_PROXY
  process.env.NO_PROXY = '127.0.0.1,localhost'
  const launch: { res: ServerResponse | null } = { res: null }
  let launchFifo = ''
  const stopFifos: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).subarray(5).toString('utf8')) as {
        command: string
        args: string[]
        environment: Record<string, string>
      }
      res.writeHead(200, { 'content-type': 'application/connect+json' })
      if (body.command === 'python3') {
        res.end(frame({ exitEvent: {} }))
        launch.res?.write(frame({ stdoutEvent: { data: '{"type":"result","subtype":"success"}\n' } }))
      } else if (body.args[1] === BOX_CC_STOP_SCRIPT) {
        stopFifos.push(String(body.args[3]))
        res.end(frame({ exitEvent: {} }))
        if (remoteEndsOnStop) launch.res?.end(frame({ exitEvent: { exitCode: 143 } }))
      } else {
        launchFifo = String(body.args[3])
        launch.res = res
        res.flushHeaders()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let out = ''
  stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
  try {
    const running = runBoxCcBridge({
      control: {
        execUrl: `http://127.0.0.1:${address.port}/agent.v1.ControlService/Exec`,
        execToken: 'local',
        networkToken: 'net-token',
        remoteClaude: '/home/box/.local/bin/claude',
        fifo: '/tmp/oc-box-cc-0123456789abcdef.fifo',
        cwd: '/workspace',
      },
      args: ['--model', 'box-claude-haiku-4-5'],
      stdin,
      stdout,
      stderr: new PassThrough(),
    })
    stdin.write('{"type":"user","message":{"role":"user","content":"first"}}\n')
    for (let i = 0; i < 200 && !out.includes('"result"'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // The turn is over and the process is idle. Now the gateway retires it.
    stdin.end()
    const code = await Promise.race([
      running,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 2_000)),
    ])
    return { code, out, launchFifo, stopFifos }
  } finally {
    stdin.destroy()
    launch.res?.destroy()
    server.closeAllConnections()
    server.close()
    if (previousNoProxy === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = previousNoProxy
  }
}

test('closing stdin ends the box Claude and the bridge exits 0', async () => {
  const run = await bridgeAgainstFakeBox(true)
  assert.match(run.out, /"result"/)
  assert.equal(run.code, 0)
  assert.match(run.launchFifo, /^\/tmp\/oc-box-cc-0123456789abcdef\.[a-f0-9]{16}\.fifo$/)
  assert.deepEqual(run.stopFifos, [run.launchFifo])
})

test('closing stdin exits 0 even when the box never reports the exit', async () => {
  const run = await bridgeAgainstFakeBox(false)
  assert.equal(run.code, 0)
  assert.deepEqual(run.stopFifos, [run.launchFifo])
})

function stdinReaders(fifo: string): number[] {
  const pids: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (readlinkSync(`/proc/${entry}/fd/0`) === fifo) pids.push(Number(entry))
    } catch { /* gone, or not ours */ }
  }
  return pids
}

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

test('box scripts: stop ends the launched Claude, and a new launch retires the old one of the same session', {
  skip: process.platform !== 'linux',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-box-cc-scripts-'))
  const fakeClaude = join(dir, 'claude')
  // Stands in for `claude -p --input-format=stream-json`: reads stdin forever.
  writeFileSync(fakeClaude, '#!/bin/sh\nwhile IFS= read -r line; do printf "%s\\n" "$line"; done\n')
  chmodSync(fakeClaude, 0o755)
  const control = (session: string): BoxCcControl => ({
    execUrl: 'https://box.cursorvm.com/agent.v1.ControlService/Exec',
    execToken: 'local',
    networkToken: 'net',
    remoteClaude: fakeClaude,
    fifo: boxCcSpawnFifo(`/tmp/oc-box-cc-${session}.fifo`, randomBytes(8).toString('hex')),
    cwd: dir,
  })
  const children: ChildProcess[] = []
  const run = (request: { command: string; args: string[]; environment: Record<string, string> }): ChildProcess => {
    const child = spawn(request.command, request.args, {
      cwd: dir,
      env: { ...request.environment, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    children.push(child)
    return child
  }
  const exited = (child: ChildProcess): Promise<number | null> =>
    new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  const session = randomBytes(8).toString('hex')
  const other = randomBytes(8).toString('hex')
  const first = control(session)
  const second = control(session)
  const bystander = control(other)
  try {
    const firstLaunch = run(boxCcLaunchExec(first, []))
    const bystanderLaunch = run(boxCcLaunchExec(bystander, []))
    // dash counts twice (the launch shell holds the redirect too); bash once.
    const settled = async (fifo: string): Promise<number> => {
      await until(() => stdinReaders(fifo).length > 0)
      await new Promise((resolve) => setTimeout(resolve, 150))
      return stdinReaders(fifo).length
    }
    assert.ok(await settled(first.fifo) >= 1)
    const bystanders = await settled(bystander.fifo)
    assert.ok(bystanders >= 1)

    // The first bridge was killed without a stop. The session's next launch
    // must not leave two Claudes on one transcript.
    const firstGone = exited(firstLaunch)
    const secondLaunch = run(boxCcLaunchExec(second, []))
    assert.ok(await settled(second.fifo) >= 1)
    await firstGone
    assert.deepEqual(stdinReaders(first.fifo), [])
    assert.equal(existsSync(first.fifo), false)
    assert.equal(stdinReaders(bystander.fifo).length, bystanders, 'another session is not touched')

    let echoed = ''
    secondLaunch.stdout?.on('data', (chunk: Buffer) => { echoed += chunk.toString('utf8') })
    await exited(run(boxCcWriteExec(second, '{"type":"user"}')))
    assert.equal(await until(() => echoed.includes('{"type":"user"}')), true)

    const secondGone = exited(secondLaunch)
    assert.equal(await exited(run(boxCcStopExec(second))), 0)
    await secondGone
    assert.deepEqual(stdinReaders(second.fifo), [])
    assert.equal(existsSync(second.fifo), false)
    assert.equal(stdinReaders(bystander.fifo).length, bystanders)

    const bystanderGone = exited(bystanderLaunch)
    assert.equal(await exited(run(boxCcStopExec(bystander))), 0)
    await bystanderGone
  } finally {
    for (const child of children) child.kill('SIGKILL')
    for (const c of [first, second, bystander]) {
      for (const pid of stdinReaders(c.fifo)) {
        try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
      }
      rmSync(c.fifo, { force: true })
    }
    rmSync(dir, { recursive: true, force: true })
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
