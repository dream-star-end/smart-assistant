/** Route B interactive runner: transport-only parity, and no `-p` anywhere.
 *
 * - every Box turn runs the interactive session; a session that cannot come
 *   up fails the turn and nothing ever runs as `claude -p` (operator rule
 *   2026-10-11); the bridge launches under the Box login the master chose;
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
  boxCcInteractiveAbandonExec,
  boxCcInteractiveLaunchExec,
  boxCcRunnerFromEnv,
  loadBoxBridgeMod,
  remoteInteractiveClaudeArgs,
} from '../engine/cursorBoxCcInteractive.js'
import { BOX_TURN_UNAVAILABLE_TEXT, BoxLoginSignalTap, runBoxCcBridge, type BoxLoginPort } from '../engine/cursorBoxCcBridge.js'
import { BoxLoginUnavailableError } from '../engine/boxLoginClient.js'
import { stripBoxCcParentAuth } from '../engine/cursorBoxCc.js'
import { boxClaudeRunner, CURSOR_ENGINE_MODELS } from '@openclaude/protocol'
import { PassThrough } from 'node:stream'
import { StreamJson, textOfUserContent } from '../../box-bridge-mod/oc-bridge/hooks/frames.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

test('runner: every box-claude row is interactive; the bridge env always says so and keeps the login endpoint', () => {
  const box = CURSOR_ENGINE_MODELS.filter((m: { id: string }) => m.id.startsWith('box-claude-'))
  assert.equal(box.length, 4)
  assert.deepEqual(box.map((m: { id: string }) => boxClaudeRunner(m.id)), ['interactive', 'interactive', 'interactive', 'interactive'])
  const base = 'http://172.31.0.1:18892'
  const env = stripBoxCcParentAuth({ PATH: '/usr/bin', OC_BOX_INTERACTIVE: '0', ANTHROPIC_BASE_URL: base,
    OPENCLAUDE_V3_MASTER_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'x' }, '/tmp/c.json')
  assert.equal(env.OC_BOX_CC_RUNNER, 'interactive', 'no knob turns it into -p')
  assert.equal(env.OC_BOX_LOGIN_URL, base)
  assert.equal(env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
  // Not the master's internal route: no login endpoint (the bridge then runs the default login).
  assert.equal(stripBoxCcParentAuth({ ANTHROPIC_BASE_URL: 'https://api.example', OPENCLAUDE_V3_MASTER_BASE_URL: 'https://api.example' },
    '/tmp/c.json').OC_BOX_LOGIN_URL, undefined)
  assert.equal(stripBoxCcParentAuth({ OC_BOX_LOGIN_URL: 'http://172.31.0.1:1' }, '/tmp/c.json').OC_BOX_LOGIN_URL, undefined,
    'an inherited value is never trusted')
  assert.equal(boxCcRunnerFromEnv({ OC_BOX_CC_RUNNER: 'interactive' }), 'interactive')
  assert.equal(boxCcRunnerFromEnv({}), 'p')
})

test('launch: the default login launches exactly as before; another login reaches the host by name only', () => {
  const control: BoxCcControl = { execUrl: 'https://x', execToken: 't', networkToken: 'n', remoteClaude: '/c',
    fifo: '/tmp/oc-box-cc-0123456789abcdef.0a0b0c0d.fifo', cwd: '/workspace' }
  const mod = loadBoxBridgeMod()
  const plain = boxCcInteractiveLaunchExec(control, [], mod)
  assert.deepEqual(boxCcInteractiveLaunchExec(control, [], mod, 'default'), plain)
  assert.equal(plain.environment.OC_BOX_CLAUDE_PROFILE, undefined)
  assert.equal(boxCcInteractiveLaunchExec(control, [], mod, 'account2').environment.OC_BOX_CLAUDE_PROFILE, 'account2')
  for (const bad of ['Account2', '../x', '-x', 'a'.repeat(33), '']) {
    assert.throws(() => boxCcInteractiveLaunchExec(control, [], mod, bad), /BOX_INTERACTIVE_PROFILE_INVALID/, bad)
  }
})

test('signal tap: plan-window and notice lines per turn, rotation on a rejected window or a logged-out login', () => {
  const tap = new BoxLoginSignalTap()
  const rate = (status: string, utilization = 0.5) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status, utilization } })
  const result = JSON.stringify({ type: 'result', subtype: 'success' })
  const text = JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'rate_limit_event' }] } })
  // A line split across chunks is read whole; ordinary lines are not collected.
  const first = `${rate('allowed')}\n${text}\n${result}\n`
  assert.deepEqual(tap.push(first.slice(0, 10)), [])
  assert.deepEqual(tap.push(first.slice(10)), [{ rotate: null }])
  assert.deepEqual(tap.take(), [rate('allowed')])
  assert.deepEqual(tap.push(`${rate('rejected')}\n${result}\n`), [{ rotate: 'quota' }])
  assert.deepEqual(tap.take(), [rate('rejected')])
  const notLoggedIn = JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } })
  assert.deepEqual(tap.push(`${notLoggedIn}\n${result}\n`), [{ rotate: 'login' }])
  assert.deepEqual(tap.push(`${result}\n`), [{ rotate: null }], 'a reason belongs to its own turn')
  const loginExpired = JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Login expired · Please run /login' }] }, is_api_error_message: true })
  assert.deepEqual(tap.push(`${loginExpired}\n${result}\n`), [{ rotate: 'login' }], 'a login whose refresh failed (CLI 2.1.312)')
  tap.take()
  // Near the window: a hint to move before a refusal; a refusal in the same turn outranks it.
  assert.deepEqual(tap.push(`${rate('allowed', 0.985)}\n${result}\n`), [{ rotate: 'near_limit' }])
  assert.deepEqual(tap.push(`${rate('allowed', 0.99)}\n${rate('rejected', 1.0)}\n${result}\n`), [{ rotate: 'quota' }])
  const hit = JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 11:20pm" }] } })
  assert.deepEqual(tap.push(`${hit}\n${result}\n`), [{ rotate: 'quota' }], 'the CLI notice alone is enough')
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

test('frames: a turn\'s plan windows become the -p rate_limit_event the login health reads', () => {
  const sj = new StreamJson()
  sj.sessionId = 's1'
  const line = sj.rateLimits([
    { kind: 'five_hour', percentUsed: 37, resetsAt: '2026-10-11T15:50:00.000Z' },
    { kind: 'seven_day', percentUsed: 39, resetsAt: '2026-10-13T20:00:00.000Z' },
  ])
  const event = JSON.parse(line!)
  assert.equal(event.type, 'rate_limit_event')
  assert.equal(event.session_id, 's1')
  assert.deepEqual({ ...event.rate_limit_info }, {
    status: 'allowed', resetsAt: Date.parse('2026-10-13T20:00:00.000Z') / 1000, rateLimitType: 'seven_day', utilization: 0.39,
    unifiedWindows: {
      five_hour: { utilization: 0.37, resetsAt: Date.parse('2026-10-11T15:50:00.000Z') / 1000 },
      seven_day: { utilization: 0.39, resetsAt: Date.parse('2026-10-13T20:00:00.000Z') / 1000 },
    },
  })
  const full = JSON.parse(sj.rateLimits([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-11T15:50:00.000Z' }])!)
  assert.equal(full.rate_limit_info.status, 'rejected')
  assert.equal(full.rate_limit_info.rateLimitType, 'five_hour')
  // Nothing usable: no line rather than a made-up one.
  for (const bad of [null, undefined, [], [{ kind: 'five_hour' }], [{ kind: 'x y', percentUsed: 1, resetsAt: '2026-10-11T00:00:00Z' }],
    [{ kind: 'five_hour', percentUsed: -1, resetsAt: '2026-10-11T00:00:00Z' }], [{ kind: 'five_hour', percentUsed: 1, resetsAt: 'soon' }]]) {
    assert.equal(sj.rateLimits(bad), null, JSON.stringify(bad))
  }
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
  assert.equal(row.message.model, 'm')
  assert.equal(row.is_api_error_message, undefined)
  // The engine's stand-in for a failed request (origin model `<synthetic>`) is printed as -p prints it.
  const standIn = JSON.parse(sj.row({ door: 'response', uuid: 'e', origin: { kind: 'model', model: '<synthetic>' },
    message: { type: 'assistant', content: [{ type: 'text', text: 'Login expired · Please run /login' }] } })[0]!)
  assert.equal(standIn.message.model, '<synthetic>')
  assert.equal(standIn.is_api_error_message, true)
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
TAP_DIES = os.environ.get('OC_BRIDGE_PERMISSION_MODE') == 'tap-dies'
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
# Real Claude Code takes seconds to load its plugins; the host reads claude.pid by polling and refuses
# a peer that calls before that read (BOX_BRIDGE_PEER_REFUSED), so a stand-in must not be faster.
# The pause comes before the first call, /out included.
import time as _startup; _startup.sleep(0.5)
call('POST', '/out', (json.dumps({'type': 'system', 'subtype': 'fake_init', 'argv': sys.argv, 'env': sorted(os.environ)}) + '\\n').encode())
call('POST', '/ready', b'{"plugins":["oc-bridge"]}')
tap = subprocess.Popen(['python3', d + '/tap.py', sock], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
tap.stdin.write(token.encode() + b'\\n'); tap.stdin.close()
if TAP_DIES:
    import time; time.sleep(0.5); tap.kill(); time.sleep(60)
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

// ---- the bridge end to end: interactive only; a session that cannot start fails the turn

/** Runs each exec request on this machine and answers in the exec API's
 * Connect framing, the way the Box's exec daemon does. */
function localExec(opts: { delayStderrMs?: number; failWritesToFirstLaunch?: boolean; env?: Record<string, string> } = {}): (url: string, init: RequestInit) => Promise<Response> {
  let firstFifo: string | undefined
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
    if (req.command === 'sh' && req.args[0] === '-c' && req.args[1]?.includes('mkfifo')) firstFifo ??= req.args[3]
    if (opts.failWritesToFirstLaunch && req.command === 'python3' && req.environment.OC_BOX_CC_FIFO === firstFifo) {
      // The write exec ran and could not deliver (the fifo was gone).
      return new Response(new Blob([Buffer.from(frame({ exitEvent: { exitCode: 1 } }))]).stream(), { status: 200 })
    }
    const child = spawn(req.command, req.args, { cwd: req.cwd, env: { ...req.environment, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true
        const push = (b: Uint8Array): void => { if (open) controller.enqueue(b) }
        child.stdout.on('data', (d: Buffer) => push(frame({ stdoutEvent: { data: d.toString('utf8') } })))
        child.stderr.on('data', (d: Buffer) => {
          const f = frame({ stderrEvent: { data: d.toString('utf8') } })
          if (opts.delayStderrMs) setTimeout(() => push(f), opts.delayStderrMs)
          else push(f)
        })
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
    # Never expected: the bridge has no -p runner. Leave a mark the tests check.
    open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'p-ran'), 'a').write('x')
    for line in sys.stdin:
        print(json.dumps({'type': 'result', 'runner': 'p', 'echo': json.loads(line)}), flush=True)
    sys.exit(0)
if mode == 'exit':
    sys.exit(3)
import time
if mode == 'slow-ready':
    time.sleep(30)
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
# Real Claude Code takes seconds to load its plugins; the host reads claude.pid by polling and refuses
# a peer that calls before that read (BOX_BRIDGE_PEER_REFUSED), so a stand-in must not be faster.
import time as _startup; _startup.sleep(0.5)
call('POST', '/ready', b'{"plugins":["oc-bridge"]}')
tap = subprocess.Popen(['python3', d + '/tap.py', sock], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
tap.stdin.write(token.encode() + b'\\n'); tap.stdin.close()
if mode == 'ready-exit':
    # Take whatever the tap hands over for a moment (a turn that ran), then die.
    import select
    end = time.time() + 1.0
    while time.time() < end:
        if select.select([tap.stdout], [], [], 0.1)[0]:
            line = tap.stdout.readline()
            if line:
                with open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'executed'), 'a') as f:
                    f.write(line.decode())
    sys.exit(3)
for line in tap.stdout:
    if mode == 'die-on-line':
        sys.exit(3)
    if mode == 'rejected':
        call('POST', '/out', (json.dumps({'type': 'rate_limit_event', 'rate_limit_info': {'status': 'rejected', 'resetsAt': 1791800000, 'utilization': 1.0}}) + '\\n').encode())
    if mode == 'near-limit':
        call('POST', '/out', (json.dumps({'type': 'rate_limit_event', 'rate_limit_info': {'status': 'allowed', 'utilization': 0.99, 'unifiedWindows': {'five_hour': {'utilization': 0.99, 'resetsAt': 1791800000}}}}) + '\\n').encode())
    if mode == 'notice':
        call('POST', '/out', (json.dumps({'type': 'assistant', 'message': {'model': '<synthetic>', 'content': [{'type': 'text', 'text': "You've hit your session limit \u00b7 resets 11:20pm (Asia/Taipei)"}]}}) + '\\n').encode())
        call('POST', '/out', (json.dumps({'type': 'assistant', 'message': {'model': 'claude-haiku-4-5', 'content': [{'type': 'text', 'text': 'an ordinary answer mentioning a rate limit stays as written'}]}}) + '\\n').encode())
        call('POST', '/out', (json.dumps({'type': 'result', 'is_error': True, 'result': "You've hit your session limit \u00b7 resets 11:20pm"}) + '\\n').encode())
        continue
    call('POST', '/out', (json.dumps({'type': 'result', 'runner': 'interactive', 'config_dir': os.environ.get('CLAUDE_CONFIG_DIR'), 'echo': json.loads(line)}) + '\\n').encode())
`

async function bridgeRun(
  mode: 'exit' | 'ready' | 'ready-exit' | 'die-on-line' | 'slow-ready' | 'rejected' | 'near-limit' | 'notice',
  opts: {
    lines: number
    login?: BoxLoginPort
    /** Overrides every exec's env (e.g. HOME holding a fake Box login). */
    execEnv?: Record<string, string>
    accountId?: string
    /** The chat's fifo base and the container's login memory, to run the same chat twice. */
    fifoBase?: string
    loginStateDir?: string
    mod?: ReturnType<typeof loadBoxBridgeMod>
    delayStderrMs?: number
    failWritesToFirstLaunch?: boolean
    env?: NodeJS.ProcessEnv
    expectResults?: boolean
  },
) {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-bridge-'))
  const fake = join(dir, 'claude')
  writeFileSync(fake, FAKE_BOTH)
  chmodSync(fake, 0o755)
  writeFileSync(join(dir, 'mode'), mode)
  const reports: Array<{ profile: string; lines: readonly string[]; unsafe?: boolean }> = []
  const login: BoxLoginPort = opts.login ?? {
    choose: async () => ({ profile: 'default', source: 'master' }),
    report: async (input) => { reports.push(input) },
  }
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', (b: Buffer) => { out += b.toString('utf8') })
  stderr.on('data', (b: Buffer) => { err += b.toString('utf8') })
  const control: BoxCcControl = {
    execUrl: 'https://exec.example', execToken: 't', networkToken: 'n', remoteClaude: fake,
    fifo: opts.fifoBase ?? `/tmp/oc-box-cc-${randomBytes(8).toString('hex')}.fifo`, cwd: dir,
    ...(opts.accountId ? { accountId: opts.accountId } : {}),
  }
  const running = runBoxCcBridge({
    control,
    args: ['--model', 'box-claude-haiku-4-5', '--permission-mode', 'bypassPermissions'],
    stdin, stdout, stderr,
    fetchImpl: localExec({ delayStderrMs: opts.delayStderrMs, failWritesToFirstLaunch: opts.failWritesToFirstLaunch,
      ...(opts.execEnv ? { env: opts.execEnv } : {}) }),
    runner: 'interactive',
    env: opts.env ?? {},
    login,
    loginStateDir: opts.loginStateDir ?? join(dir, 'login-state'),
    ...(opts.mod ? { bridgeMod: opts.mod } : {}),
  })
  // The gateway writes the turn at once, before anything is ready.
  for (let i = 1; i <= opts.lines; i++) {
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `turn ${i}` }] } })}\n`)
  }
  const results = (): any[] => out.trim() ? out.trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.type === 'result') : []
  let code: number | string
  if (opts.expectResults === false) {
    // The bridge ends by itself (the turn failed, rejecting as on -p); then
    // the gateway closes stdin.
    code = await running.catch((e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`)
    stdin.end()
    // The interactive host is stopped on the way out; give it a moment.
    await until(() => (leftovers(control.fifo).length === 0 ? true : undefined), 15_000).catch(() => undefined)
  } else {
    await until(() => (results().length >= opts.lines ? true : undefined), 40_000)
    stdin.end()
    code = await running
    // The launch script removes the fifo files once its host has exited, which can land just
    // after the bridge returns; the tests then assert nothing is left.
    await until(() => (leftovers(control.fifo).length === 0 ? true : undefined), 15_000).catch(() => undefined)
  }
  const executedPath = join(dir, 'executed')
  const executed = existsSync(executedPath) ? readFileSync(executedPath, 'utf8') : ''
  const pRan = existsSync(join(dir, 'p-ran'))
  rmSync(dir, { recursive: true, force: true })
  return { code, results: results(), err, out, fifoBase: control.fifo, executed, pRan, reports }
}

function leftovers(fifoBase: string): string[] {
  const prefix = fifoBase.slice('/tmp/'.length, -'.fifo'.length)
  return readdirSync('/tmp').filter((n) => n.startsWith(prefix))
}

/** The waiting turn ends with the plain failure a user sees; nothing ran, nothing names a quota. */
function assertPlainFailure(results: any[]): void {
  assert.deepEqual(results.map((m) => [m.is_error, m.result, m.usage?.output_tokens]), [[true, BOX_TURN_UNAVAILABLE_TEXT, 0]])
}

test('bridge: an interactive host that dies before ready is retried once, then the turn ends plainly; nothing on -p', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const r = await bridgeRun('exit', { lines: 2, expectResults: false })
  assert.equal(r.code, 0, 'a finished (failed) turn, not a crash')
  assertPlainFailure(r.results)
  assert.equal(r.pRan, false, 'no claude -p')
  assert.equal(r.err.match(/BOX_INTERACTIVE_NOT_READY exited/g)?.length, 2, 'two launches')
  assert.match(r.err, /BOX_INTERACTIVE_RETRY not_ready/)
  assert.match(r.err, /BOX_INTERACTIVE_NOT_READY_NO_FALLBACK not_ready/)
  assert.deepEqual(leftovers(r.fifoBase), [])
})

test('bridge: a ready interactive host serves the turns under the default login', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const r = await bridgeRun('ready', { lines: 2 })
  assert.equal(r.code, 0)
  assert.deepEqual(r.results.map((m) => [m.runner, m.config_dir, m.echo.message.content[0].text]),
    [['interactive', null, 'turn 1'], ['interactive', null, 'turn 2']])
  assert.match(r.err, /BOX_INTERACTIVE_LOGIN default master/)
  assert.equal(r.pRan, false)
  assert.deepEqual(leftovers(r.fifoBase), [])
})

test('bridge: an unusable mod, a refused runner or no usable login fails the turn without running anything', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const mod = { ...loadBoxBridgeMod(), hostPy: '#'.repeat(130 * 1024) }
  const bad = await bridgeRun('ready', { lines: 1, mod, expectResults: false })
  assert.equal(bad.code, 0)
  assertPlainFailure(bad.results)
  assert.equal(bad.pRan, false)
  assert.match(bad.err, /BOX_INTERACTIVE_NOT_READY BOX_INTERACTIVE_MOD_TOO_LARGE/)
  assert.doesNotMatch(bad.err, /BOX_INTERACTIVE_RETRY/, 'a launch that cannot be built is not retried')
  const stderr = new PassThrough()
  let err = ''
  stderr.on('data', (b: Buffer) => { err += b.toString('utf8') })
  const control: BoxCcControl = { execUrl: 'https://x', execToken: 't', networkToken: 'n', remoteClaude: '/c',
    fifo: `/tmp/oc-box-cc-${randomBytes(8).toString('hex')}.fifo`, cwd: '/tmp' }
  const never = async (): Promise<Response> => { throw new Error('no exec expected') }
  const stdout = new PassThrough()
  let out = ''
  stdout.on('data', (b: Buffer) => { out += b.toString('utf8') })
  const base = { control, args: [], stdin: new PassThrough(), stdout, stderr, fetchImpl: never, env: {} }
  assert.equal(await runBoxCcBridge({ ...base, runner: 'p' }), 1)
  assert.match(err, /BOX_CC_RUNNER_REFUSED p/)
  const unavailable: BoxLoginPort = { choose: async () => { throw new BoxLoginUnavailableError() }, report: async () => undefined }
  assert.equal(await runBoxCcBridge({ ...base, stdin: new PassThrough(), login: unavailable }), 0)
  assert.match(err, /BOX_LOGIN_UNAVAILABLE/)
  assertPlainFailure(out.trim().split('\n').map((l) => JSON.parse(l)))
})

test('bridge: a host that took /ready and died before the bridge saw READY never ran a turn, and nothing replays it', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  // READY reaches the bridge only after the host is gone: the lines were still
  // held here, so nothing ran anywhere; the turn fails.
  const r = await bridgeRun('ready-exit', { lines: 2, delayStderrMs: 3_000, expectResults: false })
  assert.equal(r.executed, '', 'no turn reached the interactive session')
  assertPlainFailure(r.results)
  assert.equal(r.pRan, false)
  assert.match(r.err, /BOX_INTERACTIVE_NOT_READY_NO_FALLBACK not_ready/)
  assert.deepEqual(leftovers(r.fifoBase), [])
})

test('bridge: once a line went to a ready host, its failure is not replayed', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const r = await bridgeRun('die-on-line', { lines: 1, expectResults: false })
  assert.notEqual(r.code, 0)
  assert.deepEqual(r.results, [])
  assert.equal(r.pRan, false)
  assert.deepEqual(leftovers(r.fifoBase), [])
})

test('host: a session whose tap is gone stops instead of piling up input', { timeout: 60_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const h = startHost({}, 'tap-dies')
  const code = await h.exited
  rmSync(h.dir, { recursive: true, force: true })
  assert.equal(code, 1)
  assert.match(h.stderr(), /BOX_INTERACTIVE_INPUT_LOST tap_lost/)
  assert.notEqual(spawnSync('tmux', ['-L', 'oc-box', 'has-session', '-t', `=${h.session}`]).status, 0)
  assert.ok(!existsSync(h.fifo))
})

test('bridge: after READY a failed write ends the bridge, never a second run', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const r = await bridgeRun('ready', { lines: 2, failWritesToFirstLaunch: true, expectResults: false })
  assert.equal(r.code, 'rejected: aborted')
  assert.deepEqual(r.results, [])
  assert.match(r.err, /BOX_CC_WRITE_FAILED BOX_CC_WRITE_EXIT_1/)
  assert.equal(r.pRan, false)
  assert.deepEqual(leftovers(r.fifoBase), [], 'host stopped on the way out')
})

test('bridge: held input over OC_BOX_INTERACTIVE_HOLD_MAX_BYTES abandons the host and fails the turn', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const started = Date.now()
  const r = await bridgeRun('slow-ready', { lines: 3, env: { OC_BOX_INTERACTIVE_HOLD_MAX_BYTES: '200' }, expectResults: false })
  assert.ok(Date.now() - started < 20_000, 'did not wait for the ready timeout')
  assertPlainFailure(r.results)
  assert.doesNotMatch(r.err, /BOX_INTERACTIVE_RETRY/, 'the same input would overflow again')
  assert.equal(r.pRan, false)
  assert.match(r.err, /BOX_INTERACTIVE_ABANDON held_overflow/)
  assert.match(r.err, /BOX_INTERACTIVE_NOT_READY_NO_FALLBACK held_overflow/)
  assert.deepEqual(leftovers(r.fifoBase), [])
})

/** A Box home with one extra login: `ok` is safe (shared projects symlink, credential file),
 * `own` keeps its own projects dir (a developer login), as discovery classifies them. */
function fakeBoxHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ocb-home-'))
  spawnSync('mkdir', ['-p', join(home, '.claude', 'projects'), join(home, '.claude-own', 'projects'), join(home, '.claude-ok')])
  spawnSync('ln', ['-s', join(home, '.claude', 'projects'), join(home, '.claude-ok', 'projects')])
  for (const p of ['.claude-ok', '.claude-own']) writeFileSync(join(home, p, '.credentials.json'), '{}', { mode: 0o600 })
  return home
}

test('bridge: the chosen login launches with its own CLAUDE_CONFIG_DIR; plan windows are reported per turn', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const home = fakeBoxHome()
  try {
    const reports: Array<{ accountId: string | undefined; profile: string; lines: readonly string[] }> = []
    const asked: Array<string | undefined> = []
    const r = await bridgeRun('ready', { lines: 1, accountId: '25', execEnv: { HOME: home },
      login: { choose: async (id) => { asked.push(id); return { profile: 'ok', source: 'master' } },
        report: async (input) => { reports.push(input) } } })
    assert.deepEqual(asked, ['25'], 'the account comes from the control file')
    assert.equal(r.code, 0)
    assert.deepEqual(r.results.map((m) => [m.runner, m.config_dir]), [['interactive', join(home, '.claude-ok')]])
    assert.match(r.err, /BOX_INTERACTIVE_LOGIN ok master/)
    assert.equal(r.pRan, false)
    assert.deepEqual(reports, [], 'no window line in this turn, nothing to report')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('bridge: a login the Box refuses is reported unsafe and the same turn is served on the next login', { timeout: 120_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const home = fakeBoxHome()
  try {
    for (const profile of ['own', 'missing']) {
      const reports: Array<{ profile: string; lines: readonly string[]; unsafe?: boolean }> = []
      const offered = [profile, 'ok']
      const r = await bridgeRun('ready', { lines: 1, accountId: '25', execEnv: { HOME: home },
        login: { choose: async () => ({ profile: offered.shift()!, source: 'master' }), report: async (input) => { reports.push(input) } } })
      assert.equal(r.code, 0, profile)
      assert.deepEqual(r.results.map((m) => [m.runner, m.config_dir, m.echo.message.content[0].text]),
        [['interactive', join(home, '.claude-ok'), 'turn 1']], 'the user sees the answer, not a failure')
      assert.equal(r.pRan, false)
      assert.match(r.err, /BOX_INTERACTIVE_NOT_READY profile_unsafe/)
      assert.match(r.err, /BOX_INTERACTIVE_RETRY profile_unsafe/)
      assert.deepEqual(reports.map((x) => [x.profile, x.unsafe]), [[profile, true]], 'reported before the retry asked again')
    }
    // Every login refused: the turn ends plainly.
    const r = await bridgeRun('ready', { lines: 1, accountId: '25', execEnv: { HOME: home }, expectResults: false,
      login: { choose: async () => ({ profile: 'own', source: 'master' }), report: async () => undefined } })
    assert.equal(r.code, 0)
    assertPlainFailure(r.results)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('bridge: near its window limit a session retires after its turn only when another login is usable', { timeout: 120_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  for (const alternatives of [1, 0]) {
    const r = await bridgeRun('near-limit', { lines: 1, accountId: '25',
      login: { choose: async () => ({ profile: 'default', source: 'master', alternatives }), report: async () => undefined } })
    assert.equal(r.code, 0)
    assert.deepEqual(r.results.map((m) => m.runner), ['interactive'], 'the turn itself is answered')
    if (alternatives > 0) assert.match(r.err, /BOX_LOGIN_ROTATE default near_limit/)
    else assert.doesNotMatch(r.err, /BOX_LOGIN_ROTATE/, 'no point relaunching onto the same login every turn')
  }
})

test('bridge: a quota or login notice the CLI writes for the user is reworded plainly', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const r = await bridgeRun('notice', { lines: 1, accountId: '25' })
  const shown = r.out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const texts = shown.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content.map((b: any) => b.text))
  assert.deepEqual(texts, [BOX_TURN_UNAVAILABLE_TEXT, 'an ordinary answer mentioning a rate limit stays as written'])
  assert.equal(shown.find((m) => m.type === 'result').result, BOX_TURN_UNAVAILABLE_TEXT)
  assert.doesNotMatch(r.out, /hit your session limit|resets 11:20pm|Please run \/login/)
})

test('bridge: a chat relaunches on the login it last ran on (its prompt cache), and forgets it after a rotation', { timeout: 120_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const state = mkdtempSync(join(tmpdir(), 'ocb-login-state-'))
  const home = fakeBoxHome()
  const fifoBase = `/tmp/oc-box-cc-${randomBytes(8).toString('hex')}.fifo`
  const session = fifoBase.slice('/tmp/oc-box-cc-'.length, -'.fifo'.length)
  const asked: Array<{ session?: string; prefer?: string } | undefined> = []
  const events: string[] = []
  const login = (profile: string): BoxLoginPort => ({
    choose: async (_id, sticky) => { asked.push(sticky); return { profile, source: 'master' } },
    report: async (input) => { await new Promise((r) => setTimeout(r, 300)); events.push(`report:${input.profile}`) },
  })
  try {
    await bridgeRun('ready', { lines: 1, accountId: '25', fifoBase, loginStateDir: state, login: login('default') })
    await bridgeRun('ready', { lines: 1, accountId: '25', fifoBase, loginStateDir: state, login: login('default') })
    assert.deepEqual(asked, [{ session }, { session, prefer: 'default' }], 'the second launch asks for the same login')
    const rotated = await bridgeRun('rejected', { lines: 1, accountId: '25', fifoBase, loginStateDir: state, login: login('default') })
    events.push('exit')
    assert.deepEqual(events, ['report:default', 'exit'], 'the master heard of the bench before the session ended')
    assert.match(rotated.err, /BOX_LOGIN_ROTATE default quota/)
    asked.length = 0
    // The master moves the chat to another login; --resume carries its history there.
    const moved = await bridgeRun('ready', { lines: 1, accountId: '25', fifoBase, loginStateDir: state, login: login('ok'),
      execEnv: { HOME: home } })
    assert.deepEqual(asked, [{ session }], 'an exhausted login is not suggested again')
    assert.deepEqual(moved.results.map((m) => m.config_dir), [join(home, '.claude-ok')])
    assert.equal(readFileSync(join(state, `login-${session}`), 'utf8'), 'ok')
  } finally {
    rmSync(state, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('bridge: a rejected plan window is reported and retires the session after its result', { timeout: 90_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const reports: Array<{ profile: string; lines: readonly string[] }> = []
  const r = await bridgeRun('rejected', { lines: 1, accountId: '25',
    login: { choose: async () => ({ profile: 'default', source: 'master' }), report: async (input) => { reports.push(input) } } })
  assert.equal(r.code, 0, 'a clean exit: the next message relaunches and asks for a login again')
  assert.deepEqual(r.results.map((m) => m.runner), ['interactive'])
  assert.match(r.err, /BOX_LOGIN_ROTATE default quota/)
  assert.equal(reports.length, 1)
  assert.match(reports[0]!.lines[0]!, /"status":\s*"rejected"/)
  assert.equal(r.pRan, false)
  assert.deepEqual(leftovers(r.fifoBase), [])
})

test('abandon exec: signals only a host whose argv names the run dir', { timeout: 30_000 }, async (t) => {
  if (!haveTools()) { t.skip('tmux/python3 missing'); return }
  const base = `/tmp/oc-box-cc-${randomBytes(8).toString('hex')}.fifo`
  const fifo = boxCcSpawnFifo(base, randomBytes(4).toString('hex'))
  const run = `${fifo.slice(0, -'.fifo'.length)}.d`
  const control: BoxCcControl = { execUrl: 'https://x', execToken: 't', networkToken: 'n', remoteClaude: '/bin/true', fifo, cwd: '/tmp' }
  const req = boxCcInteractiveAbandonExec(control)
  const run1 = (): number | null => spawnSync(req.command, req.args, { env: req.environment }).status
  try {
    assert.equal(run1(), 3, 'no host yet')
    spawnSync('mkdir', ['-m', '700', run])
    // A pid file naming some other process (here: a sleeper without the run dir in argv).
    const other = spawn('sleep', ['30'])
    writeFileSync(`${run}/host.pid`, String(other.pid))
    assert.equal(run1(), 5, 'not that host')
    assert.equal(other.exitCode, null)
    other.kill()
    // The real shape: argv carries the run dir.
    const host = spawn('python3', ['-c', 'import time; time.sleep(30)', run])
    const ended = new Promise<string | null>((resolve) => host.on('exit', (_code, signal) => resolve(signal)))
    writeFileSync(`${run}/host.pid`, String(host.pid))
    assert.equal(run1(), 0)
    assert.equal(await Promise.race([ended, new Promise((r) => setTimeout(() => r('timeout'), 5_000))]), 'SIGTERM')
  } finally {
    rmSync(run, { recursive: true, force: true })
  }
})
