import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync } from 'node:fs'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Cc5SshHost, defaultRemoteCcTarget, type Cc5SshSpawn, type RemoteCcTarget } from '../cc5SshHost.js'
import { cc5ToolInputSha256 } from '../cc5NativeTool.js'

// Ordinary Node children emulate SSH stdio only. No SSH/Claude/network model invocation occurs.
const FAKE = String.raw`
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const [role, raw] = process.argv.slice(1); const c = JSON.parse(raw);
if (role === 'tool-socket') {
  if (c.memoryRefused) { process.stderr.write((c.resourceCode || 'REMOTE_NODE_MEMORY_EXHAUSTED')+' activeSessions=2\n',()=>process.exit(126)); return; }
  if (c.socketExit) process.exit(21);
  if (c.badSocketFrame) process.stdout.write(JSON.stringify({version:2,kind:'not-socket-ready'})+'\n');
  setTimeout(() => {
    const row = JSON.stringify({version:2,kind:'socket-ready',runId:c.runId,
      operationId:c.operationId,pid:process.pid,startTicks:'12'})+'\n';
    process.stdout.write(row.slice(0,13)); process.stdout.write(row.slice(13));
  }, c.helperDelay || 0);
  let sent=0;
  function sendTool() {
    sent++;
    const names=['Read','Edit','Bash'];
    const inputs=[{file_path:'/fixture/file'},
      {file_path:'/fixture/file',old_string:'before',new_string:'after'},
      {command:'printf fixture'}];
    const args=inputs[(sent-1)%3];
    const inputSha256=createHash('sha256').update(JSON.stringify(Object.fromEntries(
      Object.entries(args).sort(([left],[right])=>left<right?-1:left>right?1:0)))).digest('hex');
    const body=Buffer.from(JSON.stringify({runId:c.runId,operationId:c.operationId,
      rpcId:18+sent,toolUseId:'toolu-real-stdio-fixture-'+sent,
      name:'mcp__ocbridge__'+names[(sent-1)%3],arguments:args,inputSha256}));
    process.stdout.write(JSON.stringify({version:2,kind:'tool-request',
      seq:c.repeatSequence&&sent>1?1:sent,body:body.toString('base64')})+'\n');
  }
  let buffer=''; process.stdin.on('data', b => {
    buffer+=b;
    for(let index=buffer.indexOf('\n');index>=0;index=buffer.indexOf('\n')) {
      const line=buffer.slice(0,index); buffer=buffer.slice(index+1);
      const response=JSON.parse(line);
      if(response.version!==2||response.kind!=='tool-response'||response.seq!==sent) process.exit(29);
      fs.appendFileSync(c.root+'/response',line+'\n');
      if(sent<(c.toolCount||1)) setTimeout(sendTool,5);
    }
  });
  process.stdin.on('end',()=>process.exit(0));
  if(c.tool) { const poll=setInterval(()=>{if(fs.existsSync(c.root+'/prompt')) {
    clearInterval(poll); sendTool();
  }},5); }
} else if(role === 'launch') {
  fs.writeFileSync(c.root+'/launched','once');
  // The controller's launch role writes the round's LIFECYCLE record before it execs host.py,
  // and only host.py prints READY. The independent stop proof reads exactly that record.
  fs.writeFileSync(c.root+'/LIFECYCLE.json','{}');
  process.stderr.write(c.notReady ? 'BOX_INTERACTIVE_NOT_READY\n  | PRIVATE_PANE_MUST_NEVER_ESCAPE\n' :
    'irrelevant private stderr\nBOX_INTERACTIVE_READY plugins=oc-bridge version=None\n');
  process.stdout.write(c.initial || '');
  process.stdin.on('data', b=>{
    fs.writeFileSync(c.root+'/prompt',b); process.stdout.write(c.answer || '');
    if(c.closeHost) process.exit(0);
  });
  process.stdin.on('end',()=>process.exit(0));
} else {
  process.stdin.resume(); process.stdin.on('end',()=>{
    if(c.failControl) process.exit(23);
    if(c.failProfile && role==='session-profile') process.exit(24);
    if(role==='prove-stopped') {
      // No round record, no independent proof: this is the controller's FileNotFoundError path.
      if(!fs.existsSync(c.root+'/LIFECYCLE.json')) {
        process.stderr.write('CC5_PREP_ERROR FileNotFoundError\\n'); process.exit(31);
      }
      if(c.badProof) console.log(JSON.stringify({remoteStopped:true,kind:'verified-task-runtime-absent',root:'/wrong'}));
      else console.log(JSON.stringify({remoteStopped:true,kind:'verified-task-runtime-absent',root:c.taskRoot}));
    } else if(role==='session-profile') {
      fs.writeFileSync(c.root+'/profile','installed');
      console.log(JSON.stringify({kind:'session-profile-installed',root:c.taskRoot}));
    } else if(role==='reset') {
      console.log(JSON.stringify({kind:'task-reset'}));
    } else if(role==='provision') {
      console.log(JSON.stringify({kind:'task-root-provisioned',root:c.taskRoot}));
    } else console.log(JSON.stringify({kind:'signalled-not-proof'}));
  });
}
`
function fixture(
  options: Record<string, unknown> = {},
  deadlines: Record<string, number> = {},
  targetOverride: Partial<RemoteCcTarget> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'cc5-ssh-'))
  chmodSync(root, 0o700)
  const key = join(root, 'dedicated-key')
  const known = join(root, 'known-hosts')
  writeFileSync(key, 'ordinary test metadata fixture, not an SSH key', { mode: 0o600 })
  writeFileSync(known, 'ordinary host metadata fixture', { mode: 0o600 })
  const controllerPath = join(root, 'controller.py')
  copyFileSync(
    fileURLToPath(
      new URL('../../../../scripts/agent-remote/cc5-host-controller.py', import.meta.url),
    ),
    controllerPath,
  )
  const target: RemoteCcTarget = {
    host: '136.86.172.84',
    port: 22,
    user: 'dedicated_cc5',
    keyPath: key,
    knownHostsPath: known,
    controllerSha256: createHash('sha256').update(readFileSync(controllerPath)).digest('hex'),
    taskRootPrefix: '/home/dedicated_cc5/oc-agentremote-',
    upstreamModel: 'claude-sonnet-5',
    ...targetOverride,
  }
  const config = {
    target,
    taskRoot: target.taskRootPrefix + '20261102t1400z-fixture',
    runId: randomUUID(),
    operationId: randomUUID(),
    controllerPath,
    // Short relative Unix path is only for this test; production config below remains absolute.
    toolSocketPath: join(root, 't.sock'),
  }
  // Linux sockaddr_un limit: use this worktree's private TMPDIR, shortened via /proc/self/cwd.
  // The full host path may exceed 100; preserve an absolute path through this process's cwd.
  config.toolSocketPath = `/proc/${process.pid}/cwd/${relative(process.cwd(), join(root, 't.sock'))}`
  assert.ok(Buffer.byteLength(config.toolSocketPath) <= 100)
  const argv: string[][] = []
  const roles: string[] = []
  const children: ReturnType<typeof spawn>[] = []
  const spawnFixture: Cc5SshSpawn = (args) => {
    const match = /'(tool-socket|launch|stop-socket|prove-stopped|stop|session-profile|reset|provision)' '([^']+)'(?: '--[a-z]+' '[^']+')*$/.exec(
      args.at(-1)!,
    )
    assert.ok(match)
    roles.push(match[1])
    argv.push(args)
    const child = spawn(
      process.execPath,
      ['-e', FAKE, match[1], JSON.stringify({ ...config, root, ...options })],
      { stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } },
    )
    children.push(child)
    return child
  }
  const host = new Cc5SshHost(config, {
    spawn: spawnFixture,
    startupMs: 4000,
    controlMs: 1000,
    toolMs: 1000,
    stopMs: 3000,
    ...deadlines,
  })
  let errors: Error[] = []
  let bytes = Buffer.alloc(0)
  let streams: ReturnType<Cc5SshHost['start']> | undefined
  return {
    root,
    host,
    roles,
    argv,
    config,
    /** A second transport for the same task root, as a stale-catalog replacement builds one. */
    next() {
      return new Cc5SshHost(config, { spawn: spawnFixture, startupMs: 4000, controlMs: 1000,
        toolMs: 1000, stopMs: 3000, ...deadlines })
    },
    start() {
      streams = host.start()
      streams.stdout.on('error', (e) => errors.push(e))
      streams.stdout.on('data', (b: Buffer) => {
        bytes = Buffer.concat([bytes, b])
      })
      return streams
    },
    get bytes() {
      return bytes
    },
    get errors() {
      return errors
    },
    async cleanup() {
      await host.stop().catch(() => {})
      await Promise.all(
        children.map((child) => {
          // A child killed by a signal has `exitCode === null`; waiting on its 'close' afterwards can
          // never settle. Settle on either event and only wait when the process is actually running.
          if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
          return new Promise<void>((resolve) => {
            child.once('close', () => resolve())
            child.once('exit', () => resolve())
            child.kill('SIGKILL')
          })
        }),
      )
      rmSync(root, { recursive: true, force: true })
      errors = []
    },
  }
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < end, 'bounded fixture condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('fixed SSH argv waits for helper READY and transports original bytes without stderr/pane exposure', async () => {
  const f = fixture({
    initial: '{"type":"system","session_id":"native"}\n',
    answer: '{"type":"assistant","text":"fixture response"}\n',
  })
  try {
    const streams = f.start()
    await streams.ready
    assert.deepEqual(f.roles.slice(0, 2), ['tool-socket', 'launch'])
    streams.stdin.write('original-user-frame\n')
    await until(() => f.bytes.includes('fixture response'))
    assert.equal(readFileSync(join(f.root, 'prompt'), 'utf8'), 'original-user-frame\n')
    assert.equal(
      f.bytes.toString(),
      '{"type":"system","session_id":"native"}\n{"type":"assistant","text":"fixture response"}\n',
    )
    for (const args of f.argv) {
      assert.equal(args.includes('-T'), true)
      assert.equal(
        args.includes('-R') || args.includes('-L') || args.includes('-D') || args.includes('-t'),
        false,
      )
      assert.ok(args.includes('StrictHostKeyChecking=yes') && args.includes('IdentityAgent=none'))
      assert.ok(args.includes(f.config.target.keyPath))
    }
    assert.deepEqual(await f.host.stop(), { remoteStopped: true })
    assert.deepEqual(f.roles.slice(2), ['stop', 'stop-socket', 'prove-stopped'])
    assert.equal(f.errors.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('a fresh lane installs the profile before the tool socket and launch waits for it', async () => {
  // 300 ms helper delay: socket-ready is still outstanding when the launch is requested.
  const f = fixture({ helperDelay: 300 })
  try {
    // The controller's tool-socket role validates the lane profile, so a fresh root has none
    // to open the socket against: the profile install must complete first.
    await f.host.configure(Buffer.from('{"version":1,"synthetic":"profile"}'))
    assert.equal(readFileSync(join(f.root, 'profile'), 'utf8'), 'installed')
    assert.deepEqual(f.roles, ['session-profile'])
    const prepare = f.host.prepare()
    assert.deepEqual(f.roles, ['session-profile', 'tool-socket'])
    const streams = f.start()
    // Socket-ready is still outstanding, so no launch may have been requested yet.
    assert.deepEqual(f.roles, ['session-profile', 'tool-socket'])
    await prepare
    await streams.ready
    assert.deepEqual(f.roles, ['session-profile', 'tool-socket', 'launch'])
    assert.deepEqual(await f.host.stop(), { remoteStopped: true })
  } finally {
    await f.cleanup()
  }
})

test('a replacement lane rotates through the tool socket before installing the new profile', async () => {
  const f = fixture({ helperDelay: 50 })
  const replacement = f.next()
  try {
    // An already-launched round keeps its LIFECYCLE record: only tool-socket's rotate proves
    // the old round gone and clears it, and only then does session-profile accept a new one.
    const prepare = replacement.prepare()
    assert.deepEqual(f.roles, ['tool-socket'])
    await prepare
    await replacement.configure(Buffer.from('{"version":1,"synthetic":"replacement"}'))
    assert.deepEqual(f.roles, ['tool-socket', 'session-profile'])
    const streams = replacement.start()
    await streams.ready
    assert.deepEqual(f.roles, ['tool-socket', 'session-profile', 'launch'])
    assert.deepEqual(await replacement.stop(), { remoteStopped: true })
  } finally {
    await f.cleanup()
  }
})

test('a failed profile install never launches the remote', async () => {
  const f = fixture({ failProfile: true }, { stopMs: 300 })
  try {
    await assert.rejects(f.host.configure(Buffer.from('{"version":1}')))
    await f.host.stop().catch(() => {})
    assert.equal(f.roles.includes('launch'), false)
    assert.equal(f.roles.filter((role) => role === 'session-profile').length, 1)
  } finally {
    await f.cleanup()
  }
})

test('a preparation failure before start() rejects prepare() without an uncaught stream error or a launch', async (t) => {
  const cases: Array<[string, Record<string, unknown>, Record<string, number>]> = [
    ['tool socket exit', { socketExit: true }, { stopMs: 1000 }],
    ['bad socket READY', { badSocketFrame: true }, { stopMs: 1000 }],
    ['startup timeout', { helperDelay: 5000 }, { startupMs: 100, stopMs: 1000 }],
  ]
  for (const [label, options, deadlines] of cases) {
    await t.test(label, async () => {
      const uncaught: Error[] = []
      const observe = (error: Error): void => {
        uncaught.push(error)
      }
      process.on('uncaughtException', observe)
      const f = fixture(options, deadlines)
      try {
        await assert.rejects(f.host.prepare(), /CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN/)
        // A failed preparation must not be followed by a late launch.
        assert.throws(() => f.host.start(), /CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN/)
        await f.host.stop().catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.deepEqual(uncaught.map((error) => error.message), [])
        assert.equal(f.roles.filter((role) => role === 'launch').length, 0)
        // The failure path still requires the independent proof and tears both channels down;
        // without a lifecycle record the node cannot give one, so the stop stays unknown.
        assert.ok(f.roles.includes('stop') && f.roles.includes('prove-stopped'))
      } finally {
        process.removeListener('uncaughtException', observe)
        await f.cleanup()
      }
    })
  }
})

test('three sequential tool RPCs cross the v2 MCP channel with exact input hashes and increasing sequences', async () => {
  const f = fixture({ tool: true, toolCount: 3 })
  let requests = 0
  const received: Array<Record<string, unknown>> = []
  const receipt = Buffer.from('{"ok":true,"receipt":"actual-unix-fixture"}')
  const server = createServer((req, res) => {
    requests++
    assert.equal(req.url, '/roundtrip')
    const chunks: Buffer[] = []
    req.on('data', (b: Buffer) => chunks.push(b))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(Object.keys(body).sort().join(','), 'arguments,inputSha256,name,operationId,rpcId,runId,toolUseId')
      assert.equal(body.operationId, f.config.operationId)
      assert.equal(body.runId, f.config.runId)
      assert.equal(body.inputSha256, cc5ToolInputSha256(body.arguments))
      received.push(body)
      res.end(receipt)
    })
  })
  try {
    server.listen(f.config.toolSocketPath)
    await once(server, 'listening')
    const streams = f.start()
    await streams.ready
    streams.stdin.write('one user frame\n')
    await until(() => existsSync(join(f.root, 'response')) &&
      readFileSync(join(f.root, 'response'), 'utf8').trim().split('\n').length === 3)
    const frames = readFileSync(join(f.root, 'response'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(frames.map((frame) => frame.seq), [1, 2, 3])
    for (const frame of frames) {
      assert.equal(frame.version, 2)
      assert.equal(frame.kind, 'tool-response')
      assert.equal(frame.status, 200)
      assert.deepEqual(Buffer.from(frame.body, 'base64'), receipt)
    }
    assert.equal(requests, 3)
    assert.deepEqual(received.map((body) => body.name), ['mcp__ocbridge__Read', 'mcp__ocbridge__Edit', 'mcp__ocbridge__Bash'])
    assert.deepEqual(received.map((body) => body.toolUseId), [1, 2, 3].map((index) => `toolu-real-stdio-fixture-${index}`))
    assert.deepEqual(received.map((body) => body.rpcId), [19, 20, 21])
    await f.host.stop()
  } finally {
    server.closeAllConnections()
    server.close()
    await f.cleanup()
  }
})

test('a repeated MCP transport sequence fails before a second Unix delivery', async () => {
  const f = fixture({ tool: true, toolCount: 2, repeatSequence: true })
  let requests = 0
  const server = createServer((_req, res) => {
    requests++
    res.end('{"ok":true,"receipt":"first-only"}')
  })
  try {
    server.listen(f.config.toolSocketPath)
    await once(server, 'listening')
    const streams = f.start()
    await streams.ready
    streams.stdin.write('one user frame\n')
    await until(() => f.errors.length > 0)
    assert.equal(requests, 1)
    assert.equal(readFileSync(join(f.root, 'response'), 'utf8').trim().split('\n').length, 1)
    assert.ok(f.errors.every((error) => error.message === 'CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN'))
    await f.host.stop()
    assert.equal(f.roles.filter((role) => role === 'launch').length, 1)
  } finally {
    server.closeAllConnections()
    server.close()
    await f.cleanup()
  }
})

test('cancellation before helper READY cannot dispatch a late TUI launch', async () => {
  const f = fixture({ helperDelay: 300 }, { stopMs: 300 })
  try {
    const streams = f.start()
    void streams.ready.catch(() => {})
    await until(() => f.roles.includes('tool-socket'))
    // The round never launched, so the node has no lifecycle record to prove absence from:
    // cancellation reports the remote stop unproven instead of claiming it.
    await assert.rejects(f.host.stop(), /CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN/)
    await assert.rejects(streams.ready, /CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN/)
    assert.equal(f.roles.filter((role) => role === 'launch').length, 0)
    assert.equal(existsSync(join(f.root, 'prompt')), false)
  } finally {
    await f.cleanup()
  }
})

test('local SSH exit and wrong/failed independent proof never report remoteStopped', async (t) => {
  for (const options of [{ failControl: true }, { badProof: true }])
    await t.test(JSON.stringify(options), async () => {
      const f = fixture(options, { stopMs: 3000, controlMs: 1000 })
      try {
        const streams = f.start()
        await streams.ready
        await assert.rejects(f.host.stop(), /CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN/)
        assert.equal(f.roles.filter((role) => role === 'launch').length, 1)
        assert.ok(f.roles.includes('prove-stopped'))
      } finally {
        await f.cleanup()
      }
    })
})

test('NOT_READY pane is discarded and startup error is a fixed label', async () => {
  const f = fixture({ notReady: true }, { stopMs: 300 })
  try {
    const streams = f.start()
    await assert.rejects(streams.ready, /^Error: CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN$/)
    await until(() => f.errors.length > 0)
    assert.equal(f.bytes.includes('PRIVATE_PANE'), false)
    assert.ok(f.errors.every((error) => error.message === 'CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN'))
  } finally {
    await f.cleanup()
  }
})

test('target host/user/port/key/model reach the real ssh argv and remote command', async () => {
  const f = fixture(
    { answer: '{"type":"assistant","text":"fixture response"}\n' },
    {},
    {
      host: 'node-7.pool.example',
      port: 2222,
      user: 'acct_user',
      upstreamModel: 'claude-opus-5',
      profileDir: 'acct-2',
      taskRootPrefix: '/home/acct_user/oc-agentremote-',
    },
  )
  try {
    const streams = f.start()
    await streams.ready
    const launch = f.argv.find((_args, index) => f.roles[index] === 'launch')!
    const remote = launch.at(-1)!
    assert.deepEqual(launch.slice(launch.indexOf('-p'), launch.indexOf('-p') + 2), ['-p', '2222'])
    assert.deepEqual(launch.slice(launch.indexOf('-l'), launch.indexOf('-l') + 2), ['-l', 'acct_user'])
    assert.deepEqual(launch.slice(launch.indexOf('-i'), launch.indexOf('-i') + 2), ['-i', f.config.target.keyPath])
    assert.ok(launch.includes(`UserKnownHostsFile=${f.config.target.knownHostsPath}`))
    assert.equal(launch.at(-2), 'node-7.pool.example')
    assert.ok(remote.endsWith("'launch' '" + f.config.taskRoot + "' '--model' 'claude-opus-5' '--profile' 'acct-2'"))
    // Only the launch role carries the model; the helper/control roles stay model-free.
    for (const args of f.argv.filter((_args, index) => f.roles[index] !== 'launch'))
      assert.equal(args.at(-1)!.includes('--model'), false)
    await f.host.stop()
  } finally {
    await f.cleanup()
  }
})

test('a controller whose bytes do not match the target digest is refused before any ssh spawn', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc5-digest-'))
  chmodSync(root, 0o700)
  const controllerPath = join(root, 'controller.py')
  copyFileSync(
    fileURLToPath(
      new URL('../../../../scripts/agent-remote/cc5-host-controller.py', import.meta.url),
    ),
    controllerPath,
  )
  const keyPath = join(root, 'id_ed25519')
  const knownHostsPath = join(root, 'known_hosts')
  writeFileSync(keyPath, 'fixture', { mode: 0o600 })
  writeFileSync(knownHostsPath, 'fixture', { mode: 0o600 })
  const spawned: string[][] = []
  try {
    assert.throws(
      () =>
        new Cc5SshHost(
          {
            target: {
              host: '136.86.172.84',
              port: 22,
              user: 'box',
              keyPath,
              knownHostsPath,
              controllerSha256: '0'.repeat(64),
              taskRootPrefix: '/home/box/oc-agentremote-',
              upstreamModel: 'claude-sonnet-5',
            },
            taskRoot: '/home/box/oc-agentremote-20261102t1400z-fixture',
            operationId: randomUUID(),
            runId: randomUUID(),
            controllerPath,
            toolSocketPath: `/proc/${process.pid}/cwd/${relative(process.cwd(), join(root, 't.sock'))}`,
          },
          {
            spawn: (args) => {
              spawned.push(args)
              throw new Error('must not spawn')
            },
          },
        ),
      /CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN/,
    )
    assert.equal(spawned.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the default target equals the single host this lane ran on before pool data existed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc5-default-'))
  const controllerPath = join(root, 'controller.py')
  copyFileSync(
    fileURLToPath(
      new URL('../../../../scripts/agent-remote/cc5-host-controller.py', import.meta.url),
    ),
    controllerPath,
  )
  const keyPath = join(root, 'id_ed25519')
  const knownHostsPath = join(root, 'known_hosts')
  writeFileSync(keyPath, 'fixture', { mode: 0o600 })
  writeFileSync(knownHostsPath, 'fixture', { mode: 0o600 })
  try {
    const target = defaultRemoteCcTarget({ user: 'box', keyPath, knownHostsPath, controllerPath })
    assert.equal(target.host, '136.86.172.84')
    assert.equal(target.port, 22)
    assert.equal(target.user, 'box')
    assert.equal(target.upstreamModel, 'claude-sonnet-5')
    assert.equal(target.taskRootPrefix, '/home/box/oc-agentremote-')
    assert.equal(
      target.controllerSha256,
      createHash('sha256').update(readFileSync(controllerPath)).digest('hex'),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unanswered tool request has a bounded deadline, aborts local Unix delivery and never retries', async () => {
  const f = fixture({ tool: true }, { toolMs: 100 })
  let requests = 0
  let disconnected = false
  const server = createServer((_req, res) => {
    requests++
    res.on('close', () => {
      disconnected = true
    })
  })
  try {
    server.listen(f.config.toolSocketPath)
    await once(server, 'listening')
    const streams = f.start()
    await streams.ready
    streams.stdin.write('one user frame\n')
    await until(() => f.errors.length > 0 && disconnected)
    assert.equal(requests, 1)
    await f.host.stop()
    assert.equal(existsSync(join(f.root, 'response')), false)
    assert.equal(f.roles.filter((role) => role === 'launch').length, 1)
  } finally {
    server.closeAllConnections()
    server.close()
    await f.cleanup()
  }
})

test('pinned node memory refusal preserves Chinese cause/count and never launches a native worker', async () => {
  const f=fixture({memoryRefused:true},{stopMs:1000})
  try {
    await assert.rejects(f.host.prepare(),(error:any)=>error.code==='REMOTE_NODE_MEMORY_EXHAUSTED' &&
      error.activeSessions===2 && error.message.includes('远端节点内存不足'))
    assert.equal(f.roles.includes('launch'),false)
  } finally { await f.cleanup() }
})


test('tasks refusal keeps the exact cause across SSH stderr and does not start a worker', async () => {
  const f=fixture({memoryRefused:true,resourceCode:'REMOTE_NODE_TASKS_EXHAUSTED'},{stopMs:1000})
  try {
    await assert.rejects(f.host.prepare(),(error:any)=>error.code==='REMOTE_NODE_TASKS_EXHAUSTED' &&
      error.activeSessions===2 && error.message.includes('进程/线程额度不足') && !error.message.includes('内存不足'))
    assert.equal(f.roles.includes('launch'),false)
  } finally { await f.cleanup() }
})


test('R1 failed stop proof can be independently retried without reopening execution', async () => {
  const options = { failControl: true }
  const f = fixture(options, { stopMs: 3000, controlMs: 1000 })
  try {
    await f.start().ready
    await assert.rejects(f.host.stop(), /CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN/)
    const calls = f.roles.length
    options.failControl = false
    assert.deepEqual(await f.host.stop(), { remoteStopped: true })
    assert.ok(f.roles.slice(calls).includes('prove-stopped'))
    assert.throws(() => f.host.start(), /CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN/)
    assert.equal(f.roles.filter(role => role === 'launch').length, 1)
  } finally {
    options.failControl = false
    await f.cleanup()
  }
})
