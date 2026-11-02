import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync } from 'node:fs'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Cc5SshHost, type Cc5SshSpawn } from '../cc5SshHost.js'

// Ordinary Node children emulate SSH stdio only. No SSH/Claude/network model invocation occurs.
const FAKE = String.raw`
const fs = require('node:fs');
const [role, raw] = process.argv.slice(1); const c = JSON.parse(raw);
if (role === 'tool-socket') {
  setTimeout(() => {
    const row = JSON.stringify({version:1,kind:'socket-ready',runId:c.runId,
      operationId:c.operationId,pid:process.pid,startTicks:'12'})+'\n';
    process.stdout.write(row.slice(0,13)); process.stdout.write(row.slice(13));
  }, c.helperDelay || 0);
  let buffer=''; process.stdin.on('data', b => { buffer+=b; if(buffer.includes('\n')) {
    fs.writeFileSync(c.root+'/response', buffer); }});
  process.stdin.on('end',()=>process.exit(0));
  if(c.tool) { const poll=setInterval(()=>{if(fs.existsSync(c.root+'/prompt')) {
    clearInterval(poll); const body=Buffer.from(JSON.stringify({runId:c.runId,
      operationId:c.operationId,rpcId:19,toolUseId:'toolu-real-stdio-fixture',
      name:'mcp__ocbridge__roundtrip',arguments:{operationId:c.operationId}}));
    process.stdout.write(JSON.stringify({version:1,kind:'tool-request',seq:1,body:body.toString('base64')})+'\n');
  }},5); }
} else if(role === 'launch') {
  fs.writeFileSync(c.root+'/launched','once');
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
    if(role==='prove-stopped') {
      if(c.badProof) console.log(JSON.stringify({remoteStopped:true,kind:'verified-task-runtime-absent',root:'/wrong'}));
      else console.log(JSON.stringify({remoteStopped:true,kind:'verified-task-runtime-absent',root:c.taskRoot}));
    } else console.log(JSON.stringify({kind:'signalled-not-proof'}));
  });
}
`
function fixture(options: Record<string, unknown> = {}, deadlines: Record<string, number> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cc5-ssh-'))
  chmodSync(root, 0o700)
  const key = join(root, 'dedicated-key')
  const known = join(root, 'known-hosts')
  writeFileSync(key, 'ordinary test metadata fixture, not an SSH key', { mode: 0o600 })
  writeFileSync(known, 'ordinary host metadata fixture', { mode: 0o600 })
  const config = {
    user: 'dedicated_cc5',
    taskRoot: '/home/box/oc-agentremote-t1555u-20261102t1400z-fixture',
    runId: randomUUID(),
    operationId: randomUUID(),
    privateKeyPath: key,
    knownHostsPath: known,
    controllerPath: join(root, 'controller.py'),
    // Short relative Unix path is only for this test; production config below remains absolute.
    toolSocketPath: join(root, 't.sock'),
  }
  copyFileSync(
    fileURLToPath(
      new URL('../../../../scripts/agent-remote/cc5-host-controller.py', import.meta.url),
    ),
    config.controllerPath,
  )
  // Linux sockaddr_un limit: use this worktree's private TMPDIR, shortened via /proc/self/cwd.
  // The full host path may exceed 100; preserve an absolute path through this process's cwd.
  config.toolSocketPath = `/proc/${process.pid}/cwd/${relative(process.cwd(), join(root, 't.sock'))}`
  assert.ok(Buffer.byteLength(config.toolSocketPath) <= 100)
  const argv: string[][] = []
  const roles: string[] = []
  const children: ReturnType<typeof spawn>[] = []
  const spawnFixture: Cc5SshSpawn = (args) => {
    const match = /'(tool-socket|launch|stop-socket|prove-stopped|stop)' '[^']+'$/.exec(
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
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null ? Promise.resolve() : once(child, 'close').catch(() => {}),
        ),
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
      assert.ok(args.includes(f.config.privateKeyPath))
    }
    assert.deepEqual(await f.host.stop(), { remoteStopped: true })
    assert.deepEqual(f.roles.slice(2), ['stop', 'stop-socket', 'prove-stopped'])
    assert.equal(f.errors.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('one actual Unix request/receipt crosses the MCP stdio channel once', async () => {
  const f = fixture({ tool: true })
  let requests = 0
  let received: Buffer | undefined
  const receipt = Buffer.from('{"ok":true,"receipt":"actual-unix-fixture"}')
  const server = createServer((req, res) => {
    requests++
    assert.equal(req.url, '/roundtrip')
    const chunks: Buffer[] = []
    req.on('data', (b: Buffer) => chunks.push(b))
    req.on('end', () => {
      received = Buffer.concat(chunks)
      res.end(receipt)
    })
  })
  try {
    server.listen(f.config.toolSocketPath)
    await once(server, 'listening')
    const streams = f.start()
    await streams.ready
    streams.stdin.write('one user frame\n')
    await until(() => existsSync(join(f.root, 'response')))
    const frame = JSON.parse(readFileSync(join(f.root, 'response'), 'utf8'))
    assert.equal(frame.seq, 1)
    assert.equal(frame.kind, 'tool-response')
    assert.equal(frame.status, 200)
    assert.deepEqual(Buffer.from(frame.body, 'base64'), receipt)
    assert.equal(requests, 1)
    assert.equal(JSON.parse(received!.toString()).toolUseId, 'toolu-real-stdio-fixture')
    assert.equal(JSON.parse(received!.toString()).rpcId, 19)
    await f.host.stop()
  } finally {
    server.closeAllConnections()
    server.close()
    await f.cleanup()
  }
})

test('cancellation before helper READY cannot dispatch a late TUI launch', async () => {
  const f = fixture({ helperDelay: 300 })
  try {
    const streams = f.start()
    void streams.ready.catch(() => {})
    await until(() => f.roles.includes('tool-socket'))
    await f.host.stop()
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
  const f = fixture({ notReady: true })
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
