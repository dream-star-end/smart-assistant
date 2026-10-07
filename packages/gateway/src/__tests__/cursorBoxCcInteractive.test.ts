/** Route B interactive runner (OC_BOX_INTERACTIVE): transport-only parity.
 *
 * - the runner stays `-p` unless explicitly enabled per model;
 * - the interactive argv keeps exactly the adapter-owned flags of `-p`;
 * - stream-json the oc-bridge mod produced from a real interactive CLI
 *   (fixtures recorded on the Box, CLI 2.1.292, P0 2026-10-07) parses in the
 *   unchanged CcbMessageParser to the same usage, result, abort and
 *   permission semantics the gateway relies on;
 * - the Box host speaks the Route B fifo/write/stop protocol (fake claude
 *   under tmux; skipped where tmux or python3 is missing).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/cursorBoxCcInteractive.test.ts */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CcbMessageParser, type SessionStreamEvent } from '../ccbMessageParser.js'
import { _isOfficialClaudeAbortResult, buildOfficialClaudeCliArgs } from '../subprocessRunner.js'
import {
  BOX_CC_STOP_SCRIPT,
  boxCcSpawnFifo,
  boxCcWriteExecs,
  remoteClaudeArgs,
  type BoxCcControl,
} from '../engine/cursorBoxCcExec.js'
import {
  BOX_CC_INTERACTIVE_LAUNCH_SCRIPT,
  boxBridgeModDigest,
  boxBridgeModRoot,
  boxCcInteractiveLaunchExec,
  boxCcRunnerFromEnv,
  loadBoxBridgeMod,
  remoteInteractiveClaudeArgs,
} from '../engine/cursorBoxCcInteractive.js'
import { interactiveCoolingDown, noteInteractiveFailure, runBoxCcBridge } from '../engine/cursorBoxCcBridge.js'
import { resolveBoxCcRunner, stripBoxCcParentAuth } from '../engine/cursorBoxCc.js'
import { boxClaudeRunner, CURSOR_ENGINE_MODELS } from '@openclaude/protocol'
import { PassThrough } from 'node:stream'
import { StreamJson, textOfUserContent } from '../../box-bridge-mod/oc-bridge/hooks/frames.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

test('runner: catalog row decides, OC_BOX_INTERACTIVE forces either side, the bridge reads the result', () => {
  const box = CURSOR_ENGINE_MODELS.filter((m: { id: string }) => m.id.startsWith('box-claude-'))
  assert.equal(box.length, 3)
  for (const m of box) {
    const row = boxClaudeRunner(m.id)
    assert.ok(row === 'p' || row === 'interactive', m.id)
    assert.equal(resolveBoxCcRunner(m.id, {}), row)
    assert.equal(resolveBoxCcRunner(m.id, { OC_BOX_INTERACTIVE: '0' }), 'p')
    assert.equal(resolveBoxCcRunner(m.id, { OC_BOX_INTERACTIVE: '1' }), 'interactive')
  }
  // Personal default: every box-claude row prefers the interactive runner.
  assert.deepEqual(box.map((m: { id: string }) => boxClaudeRunner(m.id)), ['interactive', 'interactive', 'interactive'])
  // Only box-claude rows carry a runner; anything else is -p.
  assert.equal(boxClaudeRunner('cursor-opus-5-high'), undefined)
  assert.equal(resolveBoxCcRunner('cursor-opus-5-high', {}), 'p')
  assert.equal(resolveBoxCcRunner(undefined, {}), 'p')
  const env = stripBoxCcParentAuth({ PATH: '/usr/bin', OC_BOX_INTERACTIVE: '1' }, '/tmp/c.json', 'box-claude-opus-5-5')
  assert.equal(env.OC_BOX_CC_RUNNER, 'interactive')
  assert.equal(stripBoxCcParentAuth({ PATH: '/usr/bin', OC_BOX_INTERACTIVE: '0' }, '/tmp/c.json', 'box-claude-opus-5-5').OC_BOX_CC_RUNNER, 'p')
  assert.equal(boxCcRunnerFromEnv({ OC_BOX_CC_RUNNER: 'interactive' }), 'interactive')
  assert.equal(boxCcRunnerFromEnv({ OC_BOX_CC_RUNNER: 'p' }), 'p')
  assert.equal(boxCcRunnerFromEnv({}), 'p')
})

test('cooldown marker: set by a fallback, honoured for OC_BOX_INTERACTIVE_COOLDOWN_SEC', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-cool-'))
  try {
    assert.equal(interactiveCoolingDown(dir, {}), false)
    noteInteractiveFailure(dir)
    assert.equal(interactiveCoolingDown(dir, {}), true)
    assert.equal(interactiveCoolingDown(dir, { OC_BOX_INTERACTIVE_COOLDOWN_SEC: '0' }), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('interactive argv keeps -p\'s adapter-owned flags and drops the stream-json ones', () => {
  const official = buildOfficialClaudeCliArgs({
    model: 'box-claude-opus-5-5',
    permissionMode: 'bypassPermissions',
    resumeSessionId: '7d0f2b1c-0000-4000-8000-000000000001',
    settingsFile: '/container/settings.json',
    mcpConfigFile: '/container/mcp.json',
    extraPromptFile: '/container/prompt.md',
    addDir: '/container/work',
  })
  const p = remoteClaudeArgs(official)
  const interactive = remoteInteractiveClaudeArgs(official)
  assert.deepEqual(interactive, [
    '--model', 'claude-opus-5-5',
    '--permission-mode', 'bypassPermissions',
    '--dangerously-skip-permissions',
    '--settings', '{"skipDangerousModePermissionPrompt":true}',
    '--resume', '7d0f2b1c-0000-4000-8000-000000000001',
  ])
  // Same model / resume / permission semantics as the -p launch.
  for (const flag of ['--model', '--resume', '--permission-mode']) {
    assert.equal(interactive[interactive.indexOf(flag) + 1], p[p.indexOf(flag) + 1], flag)
  }
  for (const gone of ['-p', '--input-format=stream-json', '--output-format=stream-json', '--include-partial-messages',
    '--verbose', '--permission-prompt-tool', '--add-dir', '--mcp-config', '--append-system-prompt-file']) {
    assert.ok(!interactive.includes(gone), gone)
  }
  // Non-bypass modes get no bypass setting.
  assert.deepEqual(remoteInteractiveClaudeArgs(['--model', 'box-claude-haiku-4-5', '--permission-mode', 'default']),
    ['--model', 'claude-haiku-4-5', '--permission-mode', 'default'])
})

test('mod bundle: digest matches the host\'s, launch env stays under the exec string limit', (t) => {
  const mod = loadBoxBridgeMod()
  assert.deepEqual(Object.keys(mod.files).sort(), [
    '.claude-plugin/plugin.json', 'hooks/frames.ts', 'hooks/hooks.json', 'hooks/register.ts',
  ])
  const raw: Record<string, Buffer> = {}
  for (const [rel, b64] of Object.entries(mod.files)) raw[rel] = Buffer.from(b64, 'base64')
  assert.equal(boxBridgeModDigest(raw), mod.sha256)
  const py = spawnSync('python3', ['-I', '-c', [
    'import base64,json,sys',
    'ns={}',
    'exec(compile(open(sys.argv[1]).read().split("\\nclass Host")[0],"host","exec"),ns)',
    'files={k:base64.b64decode(v) for k,v in json.loads(sys.stdin.read()).items()}',
    'print(ns["mod_digest"](files))',
  ].join('\n'), join(boxBridgeModRoot(), 'host.py')], { input: JSON.stringify(mod.files), encoding: 'utf8' })
  if (py.error) {
    t.skip('python3 missing')
    return
  }
  assert.equal(py.stdout.trim(), mod.sha256, py.stderr)

  const control: BoxCcControl = {
    execUrl: 'https://exec.example', execToken: 't', networkToken: 'n',
    remoteClaude: '/home/box/.local/bin/claude', fifo: '/tmp/oc-box-cc-0123456789abcdef.00112233.fifo', cwd: '/workspace',
  }
  const req = boxCcInteractiveLaunchExec(control, ['--model', 'claude-opus-5-5'], mod)
  assert.equal(req.command, 'sh')
  assert.equal(req.args[1], BOX_CC_INTERACTIVE_LAUNCH_SCRIPT)
  assert.deepEqual(req.args.slice(3), [control.fifo, control.remoteClaude, '--model', 'claude-opus-5-5'])
  assert.deepEqual(Object.keys(req.environment).sort(),
    ['HOME', 'LANG', 'OC_BOX_HOST_PY', 'OC_BOX_MOD_FILES', 'OC_BOX_MOD_SHA256', 'PATH'])
  for (const value of Object.values(req.environment)) assert.ok(Buffer.byteLength(value) < 128 * 1024)
})

// ---- recorded interactive output through the unchanged parser -------------

type Turn = { events: SessionStreamEvent[]; result: any; raw: any[] }

function replay(name: string): Turn[] {
  const lines = readFileSync(join(FIXTURES, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const turns: Turn[] = []
  let cur: Turn | null = null
  let parser: CcbMessageParser | null = null
  const totals = { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 }
  for (const msg of lines) {
    if (!parser) {
      const turn: Turn = { events: [], result: null, raw: [] }
      cur = turn
      parser = new CcbMessageParser({
        toolUseIdToName: new Map(),
        onEvent: (e: SessionStreamEvent) => turn.events.push(e),
        onFinish: (r: unknown) => { turn.result = r },
        sessionTotals: totals,
        costMode: 'external',
      } as any)
    }
    cur!.raw.push(msg)
    parser.parse(msg)
    if (msg.type === 'result') {
      turns.push(cur!)
      parser = null
    }
  }
  return turns
}

function stepUsageSum(raw: any[]): Record<string, number> {
  const sum: Record<string, number> = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for (const m of raw) {
    if (m.type === 'stream_event' && m.event.type === 'message_delta') {
      for (const k of Object.keys(sum)) sum[k]! += m.event.usage[k]
    }
  }
  return sum
}

test('recorded turns: text, tool use and billing usage parse as on Route B', () => {
  const [t1, t2] = replay('boxInteractive-turns.ndjson')
  assert.ok(t1 && t2)
  assert.equal(t1.result.assistantText, 'PONG')
  assert.equal(t1.result.isError, false)
  assert.equal(t1.result.stopReason, 'end_turn')
  assert.equal(t2.result.assistantText, 'oc-bridge-42')
  assert.ok(JSON.stringify(t2.events).includes('"Bash"'), 'tool_use surfaced')
  for (const t of [t1, t2]) {
    const final = t.raw.at(-1)
    // One message_delta usage per model request (the billing unit) adds up
    // to the turn's aggregate, the cross-check SCHEME §6.2 asked to verify.
    assert.deepEqual(stepUsageSum(t.raw), final.usage)
    assert.equal(t.result.inputTokens, final.usage.input_tokens)
    assert.equal(t.result.outputTokens, final.usage.output_tokens)
    assert.equal(t.result.cacheReadTokens, final.usage.cache_read_input_tokens)
    assert.equal(t.result.cacheCreationTokens, final.usage.cache_creation_input_tokens)
    assert.equal(t.result.cost, 0) // costMode external, as Route B
  }
  // Resume id: every line names the CLI session the gateway stores.
  const sid = t1.raw[0].session_id
  assert.match(sid, /^[0-9a-f-]{36}$/)
  assert.ok([...t1.raw, ...t2.raw].every((m) => m.type === 'control_response' || m.session_id === sid))
})

test('recorded abort: the result is the official-cc abort fingerprint the runner retires on', () => {
  const [t] = replay('boxInteractive-abort.ndjson')
  assert.ok(t)
  const final = t.raw.at(-1)
  assert.ok(_isOfficialClaudeAbortResult(final))
  assert.equal(t.result.isError, true)
  assert.ok(t.raw.some((m) => m.type === 'control_response' && m.response.subtype === 'success'))
})

test('recorded AskUserQuestion: surfaces as can_use_tool, as under -p --permission-prompt-tool stdio', () => {
  const [t] = replay('boxInteractive-ask.ndjson')
  assert.ok(t)
  const req = t.events.find((e: any) => e.kind === 'permission_request') as any
  assert.ok(req, 'permission_request event')
  assert.equal(req.request.toolName, 'AskUserQuestion')
  assert.equal(req.request.input.questions.length, 1)
  assert.equal(t.result.isError, false)
})

test('frames: chunk mapping, abort result and user text', () => {
  const sj = new StreamJson()
  sj.sessionId = 's1'
  sj.turnStart()
  const out = [
    ...sj.stepStart({ turnId: 't1', index: 0, model: 'claude-opus-5-5' }),
    ...sj.chunk(undefined, { kind: 'text', index: 0, text: 'he' }),
    ...sj.chunk(undefined, { kind: 'text', index: 0, text: 'llo' }),
    ...sj.chunk(undefined, { kind: 'tool', index: 1, id: 'toolu_1', name: 'Read' }),
    ...sj.chunk(undefined, { kind: 'input', index: 1, json: '{"file_path":' }),
    ...sj.stepEnd(undefined, { stopReason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }),
  ].map((l) => JSON.parse(l).event)
  assert.deepEqual(out.map((e) => e.type), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_stop', 'message_delta', 'message_stop',
  ])
  assert.equal(out[8].delta.stop_reason, 'tool_use')
  // Subagent steps stream nothing; their rows carry the parent tool_use id.
  assert.deepEqual(sj.stepStart({ turnId: 't1', index: 0, model: 'm', agentId: 'a1' }), [])
  sj.noteAgentCall('toolu_agent')
  const row = JSON.parse(sj.row({ door: 'response', uuid: 'u', agentId: 'a1', message: { type: 'assistant', role: 'assistant', content: [] } })[0]!)
  assert.equal(row.parent_tool_use_id, 'toolu_agent')
  // No turn usage from the engine (abort, API error): the steps' sum stands,
  // never zeros, so a paid step is not settled as free.
  const aborted = JSON.parse(sj.result({ reason: 'aborted', answer: '', durationMs: 5 }, 'tool_use'))
  assert.ok(_isOfficialClaudeAbortResult(aborted))
  assert.deepEqual(aborted.usage, { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })
  const errored = JSON.parse(sj.result({ reason: 'error', answer: 'overloaded', durationMs: 5 }, null))
  assert.equal(errored.is_error, true)
  assert.equal(errored.usage.output_tokens, 2)
  // Engine-reported turn usage wins when present; a new turn starts from zero.
  const reported = { input_tokens: 9, output_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 }
  assert.deepEqual(JSON.parse(sj.result({ reason: 'answer', answer: 'x', durationMs: 5, usage: reported }, 'end_turn')).usage, reported)
  sj.turnStart()
  assert.equal(JSON.parse(sj.result({ reason: 'aborted', answer: '', durationMs: 1 }, null)).usage.input_tokens, 0)
  assert.equal(textOfUserContent([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\n\nb')
  assert.equal(textOfUserContent('plain'), 'plain')
})

// ---- the Box host over the Route B fifo protocol ---------------------------

const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, socket, subprocess, sys
d = os.environ['OC_BRIDGE_DIR']
sock = d + '/bridge.sock'
if os.environ.get('OC_BRIDGE_PERMISSION_MODE') == 'never-ready':
    import time; time.sleep(60)
token = open(d + '/token').read().strip()
def call(method, path, body=b'', tok=None):
    s = socket.socket(socket.AF_UNIX)
    s.connect(sock)
    t = token if tok is None else tok
    s.sendall(b'%s %s HTTP/1.1\\r\\nHost: bridge\\r\\nx-oc-bridge-token: %s\\r\\nContent-Length: %d\\r\\n\\r\\n' % (method.encode(), path.encode(), t.encode(), len(body)) + body)
    data = b''
    while True:
        b = s.recv(65536)
        if not b:
            break
        data += b
    s.close()
    head, _, payload = data.partition(b'\\r\\n\\r\\n')
    return int(head.split()[1]), payload
call('POST', '/out', (json.dumps({'type': 'system', 'subtype': 'fake_init', 'argv': sys.argv, 'env': sorted(os.environ)}) + '\\n').encode())
call('POST', '/ready', b'{"plugins":["oc-bridge"]}')
tap = subprocess.Popen(['python3', d + '/tap.py', sock], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
tap.stdin.write(token.encode() + b'\\n'); tap.stdin.close()
for line in tap.stdout:
    msg = json.loads(line)
    if msg.get('type') == 'user' and msg['message']['content'][0].get('text') == 'FORGE':
        # A tool is claude's child: no token, then the stolen one; a second tap.
        forge = ("import socket,sys\\n"
                 "for tok in ('', sys.argv[2]):\\n"
                 "    s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])\\n"
                 "    b=b'{\\"type\\":\\"result\\",\\"forged\\":true}'\\n"
                 "    s.sendall(b'POST /out HTTP/1.1\\\\r\\\\nx-oc-bridge-token: %s\\\\r\\\\nContent-Length: %d\\\\r\\\\n\\\\r\\\\n' % (tok.encode(), len(b)) + b)\\n"
                 "    print(s.recv(100)[:12])\\n"
                 "s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.sendall(b'TAP %s\\\\n' % sys.argv[2].encode()); print(s.recv(10))\\n")
        r = subprocess.run(['python3', '-c', forge, sock, token], capture_output=True)
        call('POST', '/out', (json.dumps({'type': 'system', 'subtype': 'forge_done', 'out': r.stdout.decode(), 'token_file': os.path.exists(d + '/token')}) + '\\n').encode())
        continue
    if msg.get('type') == 'user' and msg['message']['content'][0].get('text') == 'ASK':
        status, payload = call('GET', '/decision?id=r1')
        while status == 204:
            status, payload = call('GET', '/decision?id=r1')
        call('POST', '/out', payload + b'\\n')
        continue
    call('POST', '/out', (json.dumps({'type': 'result', 'echo': msg}) + '\\n').encode())
`

function haveTools(): boolean {
  return spawnSync('tmux', ['-V']).status === 0 && spawnSync('python3', ['-V']).status === 0
}

function startHost(extraEnv: Record<string, string> = {}, permissionMode = 'bypassPermissions') {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-host-'))
  const fake = join(dir, 'claude')
  writeFileSync(fake, FAKE_CLAUDE)
  chmodSync(fake, 0o755)
  const base = `/tmp/oc-box-cc-${randomBytes(8).toString('hex')}.fifo`
  const fifo = boxCcSpawnFifo(base, randomBytes(4).toString('hex'))
  const control: BoxCcControl = {
    execUrl: 'https://exec.example', execToken: 't', networkToken: 'n', remoteClaude: fake, fifo, cwd: dir,
  }
  const req = boxCcInteractiveLaunchExec(control,
    remoteInteractiveClaudeArgs(['--model', 'box-claude-haiku-4-5', '--permission-mode', permissionMode]), loadBoxBridgeMod())
  const proc = spawn(req.command, req.args, { cwd: req.cwd, env: { ...req.environment, ...extraEnv } })
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
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)))
  const session = `oc-${fifo.slice('/tmp/oc-box-cc-'.length, -'.fifo'.length).replace('.', '-')}`
  return { dir, fifo, control, proc, lines, exited, session, stderr: () => stderr }
}

async function until<T>(fn: () => T | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}

function deliver(control: BoxCcControl, line: string, seq: number): void {
  for (const body of boxCcWriteExecs(control, line, seq)) {
    const r = spawnSync(body.command, body.args, { env: body.environment, cwd: control.cwd })
    assert.equal(r.status, 0, r.stderr?.toString())
  }
}

test('host: Route B write execs in, mod frames out, stop exec ends the tmux session', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) {
    t.skip('tmux/python3 missing')
    return
  }
  const h = startHost()
  try {
    const init = await until(() => h.lines.find((m) => m.subtype === 'fake_init'))
    // Fixed argv plus the pinned mod; scrubbed env (no exec payload, no config dir).
    const pluginDir = init.argv[init.argv.indexOf('--plugin-dir') + 1]
    assert.equal(pluginDir, `${h.fifo.slice(0, -'.fifo'.length)}.d/mod/oc-bridge`)
    assert.deepEqual(init.argv.slice(1, 5), ['--model', 'claude-haiku-4-5', '--permission-mode', 'bypassPermissions'])
    assert.deepEqual(init.env.filter((k: string) => !['PWD', 'SHLVL', '_'].includes(k)), [
      'DISABLE_AUTOUPDATER', 'HOME', 'LANG', 'OC_BRIDGE_DIR', 'OC_BRIDGE_PERMISSION_MODE', 'PATH', 'TERM',
    ])

    // ~1 MB line, multi-part write exec (the 128 KB lesson), byte-equal back.
    const text = `big:${'é漢x'.repeat(200_000)}`
    deliver(h.control, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`, 1)
    const echo1 = await until(() => h.lines.find((m) => m.type === 'result' && m.echo?.message?.content?.[0]?.text?.startsWith('big:')))
    assert.equal(echo1.echo.message.content[0].text, text)

    // Images become files the model reads (D8).
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    deliver(h.control, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [
      { type: 'text', text: 'see' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } })}\n`, 2)
    const echo2 = await until(() => h.lines.find((m) => m.type === 'result' && m.echo?.message?.content?.[0]?.text === 'see'))
    assert.match(echo2.echo.message.content[1].text, /^\[Attached image: \/tmp\/oc-box-cc-.*\.d\/attachments\/[0-9a-f]{24}\.png\]$/)

    // Tools are claude's children with the same uid: neither a request
    // without the token nor one with a stolen token, nor a second tap, gets in.
    deliver(h.control, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'FORGE' }] } })}\n`, 3)
    const forge = await until(() => h.lines.find((m) => m.subtype === 'forge_done'))
    assert.equal(forge.token_file, false, 'token file removed after first use')
    assert.equal(forge.out, "b'HTTP/1.1 403'\nb'HTTP/1.1 403'\nb''\n")
    assert.equal(h.lines.filter((m) => m.forged).length, 0)
    assert.match(h.stderr(), /BOX_BRIDGE_PEER_REFUSED http/)
    assert.match(h.stderr(), /BOX_BRIDGE_TAP_REFUSED second tap/)

    // A web decision reaches the mod's long-poll, never the tap.
    deliver(h.control, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ASK' }] } })}\n`, 4)
    await new Promise((r) => setTimeout(r, 300))
    deliver(h.control, `${JSON.stringify({ type: 'control_response', response: { request_id: 'r1', subtype: 'success', response: { behavior: 'allow' } } })}\n`, 5)
    const decided = await until(() => h.lines.find((m) => m.type === 'control_response'))
    assert.equal(decided.response.response.behavior, 'allow')
  } finally {
    spawnSync('sh', ['-c', BOX_CC_STOP_SCRIPT, 'sh', h.fifo])
    await Promise.race([h.exited, new Promise((r) => setTimeout(r, 10_000))])
    rmSync(h.dir, { recursive: true, force: true })
  }
  assert.notEqual(spawnSync('tmux', ['-L', 'oc-box', 'has-session', '-t', `=${h.session}`]).status, 0, 'tmux session ended')
  assert.ok(!existsSync(`${h.fifo.slice(0, -'.fifo'.length)}.d`), 'run dir removed')
  assert.ok(!existsSync(h.fifo), 'fifo removed')
})

test('host: no ready in time is BOX_INTERACTIVE_NOT_READY with nothing left behind', { timeout: 60_000 }, async (t) => {
  if (!haveTools()) {
    t.skip('tmux/python3 missing')
    return
  }
  const h = startHost({ OC_BOX_READY_MS: '1500' }, 'never-ready')
  const code = await h.exited
  rmSync(h.dir, { recursive: true, force: true })
  assert.equal(code, 1)
  assert.match(h.stderr(), /BOX_INTERACTIVE_NOT_READY timeout/)
  assert.equal(h.lines.length, 0)
  assert.notEqual(spawnSync('tmux', ['-L', 'oc-box', 'has-session', '-t', `=${h.session}`]).status, 0)
  assert.ok(!existsSync(h.fifo))
})

test('host: a mod that does not match its digest never launches', { timeout: 30_000 }, async (t) => {
  if (!haveTools()) {
    t.skip('tmux/python3 missing')
    return
  }
  const h = startHost({ OC_BOX_MOD_SHA256: '0'.repeat(64) })
  const code = await h.exited
  rmSync(h.dir, { recursive: true, force: true })
  assert.equal(code, 1)
  assert.match(h.stderr(), /BOX_INTERACTIVE_MOD_DIGEST_MISMATCH/)
  assert.notEqual(spawnSync('tmux', ['-L', 'oc-box', 'has-session', '-t', `=${h.session}`]).status, 0)
})

// ---- the bridge end to end: interactive, or -p when interactive cannot start

/** Runs each exec request on this machine and answers in the exec API's
 * Connect framing, the way the Box's exec daemon does. */
function localExec(): (url: string, init: RequestInit) => Promise<Response> {
  const frame = (body: unknown): Uint8Array => {
    const payload = Buffer.from(JSON.stringify(body))
    const out = Buffer.alloc(5 + payload.length)
    out.writeUInt32BE(payload.length, 1)
    payload.copy(out, 5)
    return out
  }
  return async (_url, init) => {
    const raw = Buffer.from(init.body as Uint8Array)
    const req = JSON.parse(raw.subarray(5).toString('utf8')) as { command: string; args: string[]; cwd: string; environment: Record<string, string> }
    const child = spawn(req.command, req.args, { cwd: req.cwd, env: req.environment, stdio: ['ignore', 'pipe', 'pipe'] })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true
        const push = (b: Uint8Array): void => { if (open) controller.enqueue(b) }
        child.stdout.on('data', (d: Buffer) => push(frame({ stdoutEvent: { data: d.toString('utf8') } })))
        child.stderr.on('data', (d: Buffer) => push(frame({ stderrEvent: { data: d.toString('utf8') } })))
        child.on('close', (code) => {
          push(frame(code ? { exitEvent: { exitCode: code } } : { exitEvent: {} }))
          if (open) { open = false; controller.close() }
        })
        init.signal?.addEventListener('abort', () => {
          if (open) { open = false; controller.error(new Error('aborted')) }
        })
      },
    })
    return new Response(body, { status: 200 })
  }
}

/** One fake `claude` for both runners. `-p`: echo each stdin line as a
 * result. Interactive (under the host): per the `mode` file beside it,
 * `exit` dies before ready, `ready` behaves like the mod. */
const FAKE_BOTH = `#!/usr/bin/python3
import json, os, socket, subprocess, sys
mode = open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'mode')).read().strip()
if '-p' in sys.argv:
    for line in sys.stdin:
        print(json.dumps({'type': 'result', 'runner': 'p', 'echo': json.loads(line)}), flush=True)
    sys.exit(0)
if mode == 'exit':
    sys.exit(3)
d = os.environ['OC_BRIDGE_DIR']
sock = d + '/bridge.sock'
token = open(d + '/token').read().strip()
def call(method, path, body=b''):
    s = socket.socket(socket.AF_UNIX)
    s.connect(sock)
    s.sendall(b'%s %s HTTP/1.1\\r\\nx-oc-bridge-token: %s\\r\\nContent-Length: %d\\r\\n\\r\\n' % (method.encode(), path.encode(), token.encode(), len(body)) + body)
    while s.recv(65536):
        pass
    s.close()
call('POST', '/ready', b'{"plugins":["oc-bridge"]}')
tap = subprocess.Popen(['python3', d + '/tap.py', sock], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
tap.stdin.write(token.encode() + b'\\n'); tap.stdin.close()
for line in tap.stdout:
    call('POST', '/out', (json.dumps({'type': 'result', 'runner': 'interactive', 'echo': json.loads(line)}) + '\\n').encode())
`

async function bridgeRun(mode: 'exit' | 'ready', opts: { cooled?: boolean; lines: number; mod?: ReturnType<typeof loadBoxBridgeMod> }) {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-bridge-'))
  const state = join(dir, 'state')
  const fake = join(dir, 'claude')
  writeFileSync(fake, FAKE_BOTH)
  chmodSync(fake, 0o755)
  writeFileSync(join(dir, 'mode'), mode)
  if (opts.cooled) noteInteractiveFailure(state)
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', (b: Buffer) => { out += b.toString('utf8') })
  stderr.on('data', (b: Buffer) => { err += b.toString('utf8') })
  const control: BoxCcControl = {
    execUrl: 'https://exec.example', execToken: 't', networkToken: 'n', remoteClaude: fake,
    fifo: `/tmp/oc-box-cc-${randomBytes(8).toString('hex')}.fifo`, cwd: dir,
  }
  const running = runBoxCcBridge({
    control,
    args: ['--model', 'box-claude-haiku-4-5', '--permission-mode', 'bypassPermissions'],
    stdin, stdout, stderr,
    fetchImpl: localExec(),
    runner: 'interactive',
    stateDir: state,
    env: {},
    ...(opts.mod ? { bridgeMod: opts.mod } : {}),
  })
  // The gateway writes the turn at once, before anything is ready.
  for (let i = 1; i <= opts.lines; i++) {
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `turn ${i}` }] } })}\n`)
  }
  const results = (): any[] => out.trim() ? out.trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.type === 'result') : []
  await until(() => (results().length >= opts.lines ? true : undefined), 40_000)
  stdin.end()
  const code = await running
  const cooled = interactiveCoolingDown(state, {})
  rmSync(dir, { recursive: true, force: true })
  return { code, results: results(), err, cooled, fifoBase: control.fifo }
}

function leftovers(fifoBase: string): string[] {
  const prefix = fifoBase.slice('/tmp/'.length, -'.fifo'.length)
  return readdirSync('/tmp').filter((n) => n.startsWith(prefix))
}

test('bridge: an interactive host that dies before ready hands the pending turns to -p, in order', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const r = await bridgeRun('exit', { lines: 2 })
  assert.equal(r.code, 0)
  assert.deepEqual(r.results.map((m) => [m.runner, m.echo.message.content[0].text]), [['p', 'turn 1'], ['p', 'turn 2']])
  assert.match(r.err, /BOX_INTERACTIVE_NOT_READY exited/)
  assert.match(r.err, /BOX_INTERACTIVE_FALLBACK not_ready/)
  assert.equal(r.cooled, true, 'cooldown marker written')
  assert.deepEqual(leftovers(r.fifoBase), [])
})

test('bridge: a ready interactive host serves the turn, no fallback', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const r = await bridgeRun('ready', { lines: 2 })
  assert.equal(r.code, 0)
  assert.deepEqual(r.results.map((m) => [m.runner, m.echo.message.content[0].text]), [['interactive', 'turn 1'], ['interactive', 'turn 2']])
  assert.doesNotMatch(r.err, /BOX_INTERACTIVE_FALLBACK/)
  assert.equal(r.cooled, false)
  assert.deepEqual(leftovers(r.fifoBase), [])
})

test('bridge: during cooldown, or with an unusable mod, the turn goes straight to -p', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const cooled = await bridgeRun('ready', { lines: 1, cooled: true })
  assert.deepEqual(cooled.results.map((m) => m.runner), ['p'])
  assert.match(cooled.err, /BOX_INTERACTIVE_FALLBACK cooldown/)
  const mod = { ...loadBoxBridgeMod(), hostPy: '#'.repeat(130 * 1024) }
  const bad = await bridgeRun('ready', { lines: 1, mod })
  assert.deepEqual(bad.results.map((m) => m.runner), ['p'])
  assert.match(bad.err, /BOX_INTERACTIVE_FALLBACK BOX_INTERACTIVE_MOD_TOO_LARGE/)
  assert.equal(bad.cooled, true)
})
