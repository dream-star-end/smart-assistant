/** OCV5-378: the oc-box host's print mode, the interactive runner of the Box model route
 * (box-claude-*). The route's supervisor runs it in place of `claude -p` with the same argv and
 * stdio; it drops the --print-only flags, passes only the run's CLI settings through, and ends,
 * as `-p` does, once every submitted message has its result. Fake claude under tmux (skipped where
 * tmux or python3 is missing).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/boxHostPrintMode.test.ts */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boxBridgeModRoot, loadBoxBridgeMod } from '../engine/cursorBoxCcInteractive.js'

const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, socket, subprocess, sys, time
d = os.environ['OC_BRIDGE_DIR']
sock = d + '/bridge.sock'
token = open(d + '/token').read().strip()
def call(method, path, body=b''):
    s = socket.socket(socket.AF_UNIX)
    s.connect(sock)
    s.sendall(b'%s %s HTTP/1.1\\r\\nHost: bridge\\r\\nx-oc-bridge-token: %s\\r\\nContent-Length: %d\\r\\n\\r\\n' % (method.encode(), path.encode(), token.encode(), len(body)) + body)
    data = b''
    while True:
        b = s.recv(65536)
        if not b:
            break
        data += b
    s.close()
# Real Claude Code takes seconds to load its plugins; the host reads claude.pid by polling and refuses
# a peer that calls before that read (BOX_BRIDGE_PEER_REFUSED), so a stand-in must not be faster.
time.sleep(0.5)
call('POST', '/out', (json.dumps({'type': 'system', 'subtype': 'fake_init', 'argv': sys.argv, 'env': dict(os.environ)}) + '\\n').encode())
call('POST', '/ready', b'{"plugins":["oc-bridge"]}')
tap = subprocess.Popen(['python3', d + '/tap.py', sock], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
tap.stdin.write(token.encode() + b'\\n'); tap.stdin.close()
for line in tap.stdout:
    msg = json.loads(line)
    content = msg['message']['content']
    if (content if isinstance(content, str) else content[0].get('text')) == 'HANG':
        time.sleep(120)
    call('POST', '/out', (json.dumps({'type': 'result', 'subtype': 'success', 'echo': msg}) + '\\n').encode())
time.sleep(120)
`

function haveTools(): boolean {
  return spawnSync('tmux', ['-V']).status === 0 && spawnSync('python3', ['-V']).status === 0
}

function oclSessions(): Set<string> {
  const r = spawnSync('tmux', ['-L', 'oc-box', 'ls', '-F', '#{session_name}'])
  return new Set(r.status === 0 ? r.stdout.toString().split('\n').filter((s) => s.startsWith('ocp-')) : [])
}

const user = (content: unknown) => `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
const MCP = JSON.stringify({ mcpServers: { ocbridge: { type: 'stdio', command: '/usr/bin/python3', args: ['-I', '/tmp/x.py'] } } })

function startPrintHost(input: string, opts: { env?: Record<string, string>; sessionId?: string; printFlags?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-print-'))
  const fake = join(dir, 'claude')
  writeFileSync(fake, FAKE_CLAUDE)
  chmodSync(fake, 0o755)
  const mod = loadBoxBridgeMod()
  const sessionId = opts.sessionId ?? randomUUID()
  // What the route's plan passes (boxTextPlan): the CLI argv without its --print-only flags.
  // `printFlags` passes them anyway (the host drops them).
  const argv = [fake, ...(opts.printFlags ? ['-p'] : []), '--model', 'claude-haiku-5-5',
    ...(opts.printFlags ? ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--include-partial-messages', '--verbose'] : []), '--tools', '',
    '--strict-mcp-config', '--mcp-config', MCP, '--allowedTools', 'mcp__ocbridge__Bash,mcp__ocbridge__Read',
    '--setting-sources', '', '--disable-slash-commands', ...(opts.printFlags ? ['--no-session-persistence'] : []),
    '--system-prompt-file', join(dir, 'system.txt'), '--session-id', sessionId]
  const before = oclSessions()
  const proc = spawn('python3', ['-I', join(boxBridgeModRoot(), 'host.py'), ...argv], {
    cwd: dir,
    env: { HOME: dir, PATH: process.env.PATH ?? '/usr/bin:/bin', OC_BOX_HOST_MODE: 'print',
      OC_BOX_MOD_FILES: JSON.stringify(mod.files), OC_BOX_MOD_SHA256: mod.sha256,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000', DISABLE_AUTO_COMPACT: '1', OC_UNRELATED_SECRET: 'never-passed',
      ...(opts.printFlags ? {} : { OC_BOX_NO_SESSION_PERSISTENCE: '1' }), ...opts.env },
  })
  const lines: any[] = []
  let stderr = ''
  let buf = ''
  proc.stdout.on('data', (b: Buffer) => {
    buf += b.toString('utf8')
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      lines.push(JSON.parse(buf.slice(0, nl)))
      buf = buf.slice(nl + 1)
    }
  })
  proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
  proc.stdin.end(input)
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)))
  return { dir, proc, lines, exited, sessionId, before, stderr: () => stderr }
}

for (const printFlags of [false, true]) test(`print host (${printFlags ? '-p flags passed' : 'plan argv'}): the session lines out, done after the last result`, { timeout: 60_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const sessionId = randomUUID()
  const h = startPrintHost(user([{ type: 'text', text: 'one' }]) + user('two'), { sessionId, printFlags })
  // The transcript a non-persistent run leaves behind (the CLI cannot be told so interactively).
  const project = join(h.dir, '.claude', 'projects', h.dir.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${sessionId}.jsonl`), '{}\n')
  try {
    assert.equal(await h.exited, 0, h.stderr())
    const init = h.lines.find((m) => m.subtype === 'fake_init')
    const argv: string[] = init.argv.slice(1)
    for (const gone of ['-p', '--input-format', '--output-format', '--include-partial-messages', '--verbose',
      '--no-session-persistence', 'stream-json']) assert.ok(!argv.includes(gone), gone)
    assert.deepEqual(argv.slice(0, 4), ['--model', 'claude-haiku-5-5', '--tools', ''])
    assert.equal(argv[argv.indexOf('--mcp-config') + 1], MCP)
    assert.equal(argv[argv.indexOf('--session-id') + 1], sessionId)
    assert.match(argv[argv.indexOf('--plugin-dir') + 1]!, /^\/tmp\/ocb-[0-9a-f]{16}\/mod\/oc-bridge$/)
    // The run's CLI settings pass; nothing else of the host's environment does.
    assert.equal(init.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '128000')
    assert.equal(init.env.DISABLE_AUTO_COMPACT, '1')
    assert.equal(init.env.OC_UNRELATED_SECRET, undefined)
    assert.equal(init.env.OC_BOX_MOD_FILES, undefined)
    assert.equal(init.env.OC_BRIDGE_MODE, 'print')
    assert.deepEqual(JSON.parse(init.env.OC_BRIDGE_INIT), { tools: ['mcp__ocbridge__Bash', 'mcp__ocbridge__Read'],
      mcp_servers: [{ name: 'ocbridge', status: 'connected', source: 'dynamic' }] })
    assert.equal(h.lines.filter((m) => m.type === 'result').length, 2)
    assert.ok(!existsSync(join(project, `${sessionId}.jsonl`)), 'non-persistent transcript removed')
    assert.deepEqual([...oclSessions()].filter((s) => !h.before.has(s)), [], 'tmux session ended')
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('print host: input that is not text, or no input at all, ends without a turn', { timeout: 60_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const image = user([{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }])
  for (const [input, why] of [[image, /BOX_INTERACTIVE_INPUT_LOST input_unsupported/], ['', /BOX_INTERACTIVE_NO_INPUT/]] as const) {
    const h = startPrintHost(input)
    try {
      assert.equal(await h.exited, 1)
      assert.match(h.stderr(), why)
      assert.equal(h.lines.filter((m) => m.type === 'result').length, 0)
    } finally { rmSync(h.dir, { recursive: true, force: true }) }
  }
})

test('print host: a login other than the default runs only after the Box check', { timeout: 30_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  for (const configDir of ['/tmp/not-a-login', '/home/box/.claude-Bad']) {
    const h = startPrintHost(user('x'), { env: { CLAUDE_CONFIG_DIR: configDir } })
    try {
      assert.equal(await h.exited, 1)
      assert.match(h.stderr(), /BOX_INTERACTIVE_NOT_READY profile_unsafe/)
      assert.equal(h.lines.length, 0)
    } finally { rmSync(h.dir, { recursive: true, force: true }) }
  }
})

test('print host: a host killed outright takes its session with it', { timeout: 60_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const h = startPrintHost(user('HANG'))
  try {
    const deadline = Date.now() + 20_000
    while (!h.lines.some((m) => m.subtype === 'fake_init') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    const mine = [...oclSessions()].filter((s) => !h.before.has(s))
    assert.equal(mine.length, 1, 'one session for the run')
    h.proc.kill('SIGKILL')
    await h.exited
    const gone = Date.now() + 10_000
    while (oclSessions().has(mine[0]!) && Date.now() < gone) await new Promise((r) => setTimeout(r, 200))
    assert.ok(!oclSessions().has(mine[0]!), 'watchdog ended the session')
  } finally { rmSync(h.dir, { recursive: true, force: true }) }
})
