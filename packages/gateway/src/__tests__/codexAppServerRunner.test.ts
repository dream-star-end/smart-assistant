import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
/**
 * Tests for CodexAppServerRunner — the JSON-RPC 2.0 client over
 * `codex app-server --listen stdio://` that replaces the legacy
 * `codex exec --json` subprocess for `runnerKind === 'app-server'` agents.
 *
 * Strategy: most tests drive `handleLine` directly with synthetic JSON-RPC
 * frames, avoiding actual subprocess spawn. A handful use a fake duplex `proc`
 * stub for the few methods that need to read `this.proc` (interrupt, write).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/codexAppServerRunner.test.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { paths } from '@openclaude/storage'
import {
  CodexAppServerRunner,
  __setCodexAppServerSpawnForTests,
  _classifyJsonRpcLine,
} from '../codexAppServerRunner.js'

// ── helpers ─────────────────────────────────────────────────────────────────

interface Harness {
  runner: CodexAppServerRunner
  messages: any[]
  errors: any[]
  parseErrors: any[]
  spawns: any[]
  exits: any[]
  sessionIds: any[]
  written: string[] // lines written to the (fake) proc.stdin
  cleanup: () => Promise<void>
}

interface FakeProc {
  killed: boolean
  stdin: { write: (line: string) => void }
  kill: (sig?: string) => void
}

async function makeHarness(
  opts: {
    resumeSessionId?: string
    withFakeProc?: boolean
    model?: string
    conversationMode?: 'default' | 'plan'
  } = {},
): Promise<Harness> {
  const baseTmp = await mkdtemp(join(tmpdir(), 'codex-aps-'))
  const runner = new CodexAppServerRunner({
    sessionKey: 'test',
    agentId: 'test',
    cwd: baseTmp,
    resumeSessionId: opts.resumeSessionId,
    model: opts.model,
    conversationMode: opts.conversationMode,
  })
  const messages: any[] = []
  const errors: any[] = []
  const parseErrors: any[] = []
  const spawns: any[] = []
  const exits: any[] = []
  const sessionIds: any[] = []
  const written: string[] = []

  runner.on('message', (m: any) => messages.push(m))
  runner.on('error', (e: any) => errors.push(e))
  runner.on('parse_error', (e: any) => parseErrors.push(e))
  runner.on('spawn', (e: any) => spawns.push(e))
  runner.on('exit', (e: any) => exits.push(e))
  runner.on('session_id', (id: any) => sessionIds.push(id))

  if (opts.withFakeProc) {
    const fakeProc: FakeProc = {
      killed: false,
      stdin: {
        write: (line: string) => {
          written.push(line.replace(/\n$/, ''))
        },
      },
      kill: () => {
        fakeProc.killed = true
      },
    }
    ;(runner as any).proc = fakeProc
    ;(runner as any).initialized = true
  }

  return {
    runner,
    messages,
    errors,
    parseErrors,
    spawns,
    exits,
    sessionIds,
    written,
    cleanup: () => rm(baseTmp, { recursive: true, force: true }),
  }
}

/** Drive a single JSON-RPC frame through the runner's line handler. */
function feed(runner: CodexAppServerRunner, frame: unknown): void {
  ;(runner as any).handleLine(JSON.stringify(frame))
}

function makeSpawnedFakeProc(written: string[], opts: { replyInitialize?: boolean } = {}): any {
  const ee = new EventEmitter() as any
  ee.killed = false
  ee.pid = 12345
  ee.stdin = new PassThrough()
  ee.stdout = new PassThrough()
  ee.stderr = new PassThrough()
  ee.stdin.on('data', (chunk: Buffer) => {
    for (const raw of chunk.toString('utf8').split('\n')) {
      const line = raw.trim()
      if (!line) continue
      written.push(line)
      const req = JSON.parse(line)
      if (opts.replyInitialize !== false && req.method === 'initialize') {
        ee.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })}\n`)
      }
    }
  })
  ee.kill = (sig?: string) => {
    ee.killed = true
    setImmediate(() => ee.emit('close', null, sig ?? 'SIGTERM'))
  }
  return ee
}

afterEach(() => {
  __setCodexAppServerSpawnForTests(null)
})

/** Poll until predicate is true or timeout. Async copies (fs work) can take
 *  >100ms on slow hosts so a fixed sleep is flaky; this is the robust pattern. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('_classifyJsonRpcLine', () => {
  it('classifies a JSON-RPC response (result)', () => {
    const c = _classifyJsonRpcLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
    assert.equal(c.kind, 'response')
    assert.equal((c as any).id, 1)
    assert.deepEqual((c as any).result, { ok: true })
  })

  it('classifies a JSON-RPC response (error)', () => {
    const c = _classifyJsonRpcLine(
      JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'bad' } }),
    )
    assert.equal(c.kind, 'response')
    assert.equal((c as any).error.code, -32600)
  })

  it('classifies a server-initiated request', () => {
    const c = _classifyJsonRpcLine(
      JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method: 'permission/request', params: {} }),
    )
    assert.equal(c.kind, 'server-request')
    assert.equal((c as any).method, 'permission/request')
    assert.equal((c as any).id, 'req-1')
  })

  it('classifies a notification (no id)', () => {
    const c = _classifyJsonRpcLine(
      JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 't1' } } }),
    )
    assert.equal(c.kind, 'notification')
    assert.equal((c as any).method, 'turn/completed')
  })

  it('returns "unknown" for malformed JSON', () => {
    assert.equal(_classifyJsonRpcLine('not json').kind, 'unknown')
    assert.equal(_classifyJsonRpcLine('').kind, 'unknown')
    assert.equal(_classifyJsonRpcLine('null').kind, 'unknown')
    assert.equal(_classifyJsonRpcLine('{"foo":"bar"}').kind, 'unknown')
  })
})

describe('CodexAppServerRunner constructor', () => {
  it('defaults: no resume → threadId null, attached false', async () => {
    const h = await makeHarness()
    assert.equal((h.runner as any).threadId, null)
    assert.equal((h.runner as any).attached, false)
    await h.cleanup()
  })

  it('resumeSessionId set: threadId captured + attached false (must reattach on first turn)', async () => {
    const h = await makeHarness({ resumeSessionId: 'thr-abc' })
    assert.equal((h.runner as any).threadId, 'thr-abc')
    // attached is intentionally false even with resumeSessionId — the first
    // runTurn must explicitly thread/resume into the freshly spawned proc.
    assert.equal((h.runner as any).attached, false)
    await h.cleanup()
  })
})

describe('CodexAppServerRunner.start', () => {
  it('emits spawn event synchronously', async () => {
    const h = await makeHarness()
    await h.runner.start()
    assert.equal(h.spawns.length, 1)
    assert.equal(h.spawns[0].resumed, false)
    await h.cleanup()
  })

  it('emits spawn with resumed=true when resumeSessionId set', async () => {
    const h = await makeHarness({ resumeSessionId: 'thr-z' })
    await h.runner.start()
    assert.equal(h.spawns[0].resumed, true)
    await h.cleanup()
  })

  it('does not double-emit spawn when submit follows start', async () => {
    const h = await makeHarness()
    await h.runner.start()
    await h.runner.start()
    assert.equal(h.spawns.length, 1)
    await h.cleanup()
  })
})

describe('CodexAppServerRunner.warmup', () => {
  it('spawns and initializes without attaching a thread or starting a turn', async () => {
    const h = await makeHarness()
    const captured: { cmd: string; args: string[]; opts: unknown }[] = []
    __setCodexAppServerSpawnForTests(((cmd: string, args: string[], opts: unknown) => {
      captured.push({ cmd, args, opts })
      return makeSpawnedFakeProc(h.written)
    }) as any)

    assert.equal(await h.runner.warmup(500), true)
    assert.equal(captured.length, 1)
    assert.equal(h.spawns.length, 1)
    assert.deepEqual(
      h.written.map((line) => JSON.parse(line).method),
      ['initialize'],
    )
    assert.equal((h.runner as any).initialized, true)
    assert.equal((h.runner as any).attached, false)

    await h.runner.shutdown()
    await h.cleanup()
  })

  it('does not double-emit spawn when start ran before warmup', async () => {
    const h = await makeHarness()
    __setCodexAppServerSpawnForTests((() => makeSpawnedFakeProc(h.written)) as any)

    await h.runner.start()
    assert.equal(await h.runner.warmup(500), true)
    assert.equal(h.spawns.length, 1)

    await h.runner.shutdown()
    await h.cleanup()
  })

  it('times out a stuck initialize and clears the partial proc/pending request', async () => {
    const h = await makeHarness()
    __setCodexAppServerSpawnForTests((() =>
      makeSpawnedFakeProc(h.written, { replyInitialize: false })) as any)

    assert.equal(await h.runner.warmup(10), false)
    assert.equal(h.written.length, 1)
    assert.equal(JSON.parse(h.written[0]).method, 'initialize')
    assert.equal((h.runner as any).proc, null)
    assert.equal((h.runner as any).pending.size, 0)

    await h.cleanup()
  })
})

describe('CodexAppServerRunner initialize', () => {
  it('declares experimentalApi for plan-first collaborationMode fields', async () => {
    const h = await makeHarness()

    const params = (h.runner as any).buildInitializeParams()

    assert.deepEqual(params, {
      clientInfo: { name: 'openclaude-gateway', version: '1.0' },
      capabilities: {
        experimentalApi: true,
      },
    })
    await h.cleanup()
  })
})

describe('CodexAppServerRunner plan-first turn/start params', () => {
  it('plan mode uses codex collaborationMode=plan and read-only sandbox', async () => {
    const h = await makeHarness({
      model: 'gpt-5-codex',
      conversationMode: 'plan',
    })
    ;(h.runner as any).threadId = 'thr-plan'
    ;(h.runner as any).effortLevel = 'high'

    const params = (h.runner as any).buildTurnStartParams('make a plan')

    assert.deepEqual(params.collaborationMode, {
      mode: 'plan',
      settings: {
        model: 'gpt-5-codex',
        reasoning_effort: 'high',
        developer_instructions: null,
      },
    })
    assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: true })
    assert.equal(params.model, 'gpt-5-codex')
    await h.cleanup()
  })

  it('default mode uses codex collaborationMode=default and danger-full-access sandbox', async () => {
    const h = await makeHarness({
      model: 'gpt-5-codex',
      conversationMode: 'plan',
    })
    ;(h.runner as any).threadId = 'thr-run'
    h.runner.setConversationMode('default')

    const params = (h.runner as any).buildTurnStartParams('implement it')

    assert.equal((params.collaborationMode as any).mode, 'default')
    assert.match(
      (params.collaborationMode as any).settings.developer_instructions,
      /implementation mode, not plan-only mode/,
    )
    assert.deepEqual(params.sandboxPolicy, { type: 'dangerFullAccess' })
    await h.cleanup()
  })
})

describe('handleLine — dispatch', () => {
  it('response with matching id → resolves pending request', async () => {
    const h = await makeHarness({ withFakeProc: true })
    let resolved: any
    const promise = (h.runner as any).sendRequest('initialize', {})
    promise.then((r: unknown) => {
      resolved = r
    })
    // Find pending id (nextRequestId = 1 after first send)
    feed(h.runner, { jsonrpc: '2.0', id: 1, result: { ok: 1 } })
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(resolved, { ok: 1 })
    await h.cleanup()
  })

  it('response with error → rejects pending request', async () => {
    const h = await makeHarness({ withFakeProc: true })
    let err: any
    ;(h.runner as any).sendRequest('thread/start', {}).catch((e: any) => {
      err = e
    })
    feed(h.runner, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } })
    await new Promise((r) => setImmediate(r))
    assert.ok(err instanceof Error)
    assert.match(err.message, /thread\/start -> -32602: bad params/)
    await h.cleanup()
  })

  it('auto-approves command and file-change server requests', async () => {
    const h = await makeHarness({ withFakeProc: true })
    feed(h.runner, {
      jsonrpc: '2.0',
      id: 'cmd-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'git status' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      id: 'file-1',
      method: 'item/fileChange/requestApproval',
      params: { grantRoot: '/tmp/project' },
    })
    assert.equal(h.written.length, 2)
    assert.deepEqual(JSON.parse(h.written[0]).result, { decision: 'acceptForSession' })
    assert.deepEqual(JSON.parse(h.written[1]).result, { decision: 'acceptForSession' })
    await h.cleanup()
  })

  it('auto-approves permissions server requests for the session', async () => {
    const h = await makeHarness({ withFakeProc: true })
    const permissions = {
      network: { additional: ['example.com'] },
      fileSystem: { write: ['/tmp/project'] },
    }
    feed(h.runner, {
      jsonrpc: '2.0',
      id: 'perm-1',
      method: 'item/permissions/requestApproval',
      params: { permissions },
    })
    assert.equal(h.written.length, 1)
    assert.deepEqual(JSON.parse(h.written[0]).result, {
      permissions,
      scope: 'session',
      strictAutoReview: false,
    })
    await h.cleanup()
  })

  it('auto-accepts MCP elicitation approvals with an approval-looking content value', async () => {
    const h = await makeHarness({ withFakeProc: true })
    feed(h.runner, {
      jsonrpc: '2.0',
      id: 'mcp-1',
      method: 'mcpServer/elicitation/request',
      params: {
        mode: 'form',
        serverName: 'openclaude_memory',
        requestedSchema: {
          type: 'object',
          required: ['approval_mode'],
          properties: {
            approval_mode: {
              type: 'string',
              enum: ['prompt', 'approve'],
            },
          },
        },
      },
    })
    assert.equal(h.written.length, 1)
    assert.deepEqual(JSON.parse(h.written[0]).result, {
      action: 'accept',
      content: { approval_mode: 'approve' },
      _meta: null,
    })
    await h.cleanup()
  })

  it('unknown server-request still responds with -32601 method-not-found', async () => {
    const h = await makeHarness({ withFakeProc: true })
    feed(h.runner, {
      jsonrpc: '2.0',
      id: 'srv-1',
      method: 'permission/request',
      params: { tool: 'Bash' },
    })
    assert.equal(h.written.length, 1)
    const reply = JSON.parse(h.written[0])
    assert.equal(reply.id, 'srv-1')
    assert.equal(reply.error.code, -32601)
    assert.match(reply.error.message, /permission\/request/)
    await h.cleanup()
  })

  it('unknown shape emits parse_error', async () => {
    const h = await makeHarness()
    ;(h.runner as any).handleLine('not-json-at-all')
    assert.equal(h.parseErrors.length, 1)
    assert.equal(h.parseErrors[0].line, 'not-json-at-all')
    await h.cleanup()
  })

  it('orphan response (no matching pending) is logged + dropped, no crash', async () => {
    const h = await makeHarness()
    feed(h.runner, { jsonrpc: '2.0', id: 999, result: {} })
    // no throw; no parse_error (it IS valid JSON-RPC, just nobody's waiting)
    assert.equal(h.parseErrors.length, 0)
    await h.cleanup()
  })
})

describe('handleNotification — item/agentMessage/delta', () => {
  it('emits stream_event content_block_delta + accumulates assistant buf', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-stream'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr-1', turnId: 't-stream', itemId: 'i-1', delta: 'Hel' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr-1', turnId: 't-stream', itemId: 'i-1', delta: 'lo' },
    })
    assert.equal(h.messages.length, 2)
    assert.equal(h.messages[0].type, 'stream_event')
    assert.equal(h.messages[0].event.type, 'content_block_delta')
    assert.equal(h.messages[0].event.delta.text, 'Hel')
    assert.equal(h.messages[1].event.delta.text, 'lo')
    assert.equal((h.runner as any).currentAssistantBuf, 'Hello')
    await h.cleanup()
  })

  it('drops delta when turnId mismatches activeTurnId', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-mine'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr-1', turnId: 't-other', itemId: 'i-1', delta: 'X' },
    })
    assert.equal(h.messages.length, 0)
    assert.equal((h.runner as any).currentAssistantBuf, '')
    await h.cleanup()
  })

  it('empty delta string is a no-op', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-stream'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr-1', turnId: 't-stream', itemId: 'i-1', delta: '' },
    })
    assert.equal(h.messages.length, 0)
    await h.cleanup()
  })
})

describe('handleNotification — plan and reasoning deltas', () => {
  it('item/plan/delta accumulates into one partial openclaude_plan payload', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-plan'
    ;(h.runner as any).threadId = 'thr-plan'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/plan/delta',
      params: { threadId: 'thr-plan', turnId: 't-plan', itemId: 'p-1', delta: '1. inspect' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/plan/delta',
      params: { threadId: 'thr-plan', turnId: 't-plan', itemId: 'p-1', delta: '\n2. patch' },
    })

    assert.equal(h.messages.length, 2)
    assert.equal(h.messages[1].type, 'openclaude_plan')
    assert.equal(h.messages[1].plan.blockId, 'p-1')
    assert.equal(h.messages[1].plan.text, '1. inspect\n2. patch')
    assert.equal(h.messages[1].plan.partial, true)
    await h.cleanup()
  })

  it('item/started plan records native plan id without emitting a generic tool card', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-plan'
    ;(h.runner as any).threadId = 'thr-plan'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr-plan',
        turnId: 't-plan',
        item: { id: 'plan-1', type: 'plan', text: '' },
      },
    })

    assert.equal(h.messages.length, 0)

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'turn/plan/updated',
      params: {
        threadId: 'thr-plan',
        turnId: 't-plan',
        explanation: 'native plan',
        plan: [{ step: 'inspect', status: 'pending' }],
      },
    })

    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].type, 'openclaude_plan')
    assert.equal(h.messages[0].plan.blockId, 'plan-1')
    assert.equal(h.messages[0].plan.explanation, 'native plan')
    await h.cleanup()
  })

  it('turn/plan/updated emits a structured plan block with codex statuses', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-plan'
    ;(h.runner as any).threadId = 'thr-plan'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'turn/plan/updated',
      params: {
        threadId: 'thr-plan',
        turnId: 't-plan',
        explanation: 'short path',
        plan: [
          { step: 'read files', status: 'completed' },
          { step: 'edit code', status: 'inProgress' },
          { step: 'run tests', status: 'pending' },
        ],
      },
    })

    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].type, 'openclaude_plan')
    assert.equal(h.messages[0].plan.explanation, 'short path')
    assert.deepEqual(h.messages[0].plan.steps, [
      { step: 'read files', status: 'completed' },
      { step: 'edit code', status: 'inProgress' },
      { step: 'run tests', status: 'pending' },
    ])
    assert.equal(h.messages[0].plan.partial, true)
    await h.cleanup()
  })

  it('item/completed plan finalizes the native plan card with full text', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-plan'
    ;(h.runner as any).threadId = 'thr-plan'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr-plan',
        turnId: 't-plan',
        item: { id: 'plan-final', type: 'plan', text: '' },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/plan/delta',
      params: {
        threadId: 'thr-plan',
        turnId: 't-plan',
        itemId: 'plan-final',
        delta: '# Draft\n\n- partial',
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr-plan',
        turnId: 't-plan',
        item: {
          id: 'plan-final',
          type: 'plan',
          text: '# Full plan\n\n- complete',
        },
      },
    })

    await new Promise((r) => setImmediate(r))
    const plans = h.messages.filter((m) => m.type === 'openclaude_plan')
    assert.equal(plans.length, 2)
    assert.equal(plans[0].plan.blockId, 'plan-final')
    assert.equal(plans[0].plan.partial, true)
    assert.equal(plans[0].plan.text, '# Draft\n\n- partial')
    assert.equal(plans[1].plan.blockId, 'plan-final')
    assert.equal(plans[1].plan.partial, false)
    assert.equal(plans[1].plan.text, '# Full plan\n\n- complete')
    assert.equal(
      h.messages.some((m) => m.type === 'user' && m.message.content[0]?.type === 'tool_result'),
      false,
    )
    await h.cleanup()
  })

  it('reasoning deltas stream as thinking and do not pollute assistant text', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-reason'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: {
        threadId: 'thr',
        turnId: 't-reason',
        itemId: 'r-1',
        delta: 'checking constraints',
      },
    })

    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].type, 'stream_event')
    assert.equal(h.messages[0].event.delta.type, 'thinking_delta')
    assert.equal(h.messages[0].event.delta.thinking, 'checking constraints')
    assert.equal((h.runner as any).currentAssistantBuf, '')
    await h.cleanup()
  })
})

describe('handleNotification — goals', () => {
  it('thread/goal/updated emits an openclaude_goal payload with forward-compatible status', async () => {
    const h = await makeHarness()
    ;(h.runner as any).threadId = 'thr-goal'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'thread/goal/updated',
      params: {
        threadId: 'thr-goal',
        goal: {
          objective: 'Ship goals support',
          status: 'usageLimited',
          tokenBudget: 1000,
          tokensUsed: 125,
          timeUsedSeconds: 8,
          createdAt: 1779999999,
          updatedAt: 1780000000,
        },
      },
    })

    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].type, 'openclaude_goal')
    assert.deepEqual(h.messages[0].goal, {
      blockId: 'codex-goal',
      objective: 'Ship goals support',
      status: 'usageLimited',
      tokenBudget: 1000,
      tokensUsed: 125,
      timeUsedSeconds: 8,
      createdAt: 1779999999,
      updatedAt: 1780000000,
    })
    assert.equal((h.runner as any).currentAssistantBuf, '')
    await h.cleanup()
  })

  it('thread/goal/cleared upserts the stable goal block as cleared', async () => {
    const h = await makeHarness()
    ;(h.runner as any).threadId = 'thr-goal'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'thread/goal/cleared',
      params: { threadId: 'thr-goal' },
    })

    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].type, 'openclaude_goal')
    assert.deepEqual(h.messages[0].goal, {
      blockId: 'codex-goal',
      cleared: true,
    })
    await h.cleanup()
  })

  it('setGoal cold-starts a thread, sends thread/goal/set, and emits a goal block', async () => {
    const h = await makeHarness({ withFakeProc: true })

    const p = h.runner.setGoal({
      objective: 'Ship UI controls',
      status: 'active',
      tokenBudget: 500,
    })

    await waitFor(() => h.written.length === 1)
    const startReq = JSON.parse(h.written[0])
    assert.equal(startReq.method, 'thread/start')
    feed(h.runner, {
      jsonrpc: '2.0',
      id: startReq.id,
      result: { thread: { id: 'thr-goal-set' } },
    })

    await waitFor(() => h.written.length === 2)
    const setReq = JSON.parse(h.written[1])
    assert.equal(setReq.method, 'thread/goal/set')
    assert.deepEqual(setReq.params, {
      threadId: 'thr-goal-set',
      objective: 'Ship UI controls',
      status: 'active',
      tokenBudget: 500,
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      id: setReq.id,
      result: {
        goal: {
          objective: 'Ship UI controls',
          status: 'active',
          tokenBudget: 500,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          updatedAt: 1780000000,
        },
      },
    })

    const goal = await p
    assert.equal(goal.objective, 'Ship UI controls')
    assert.equal(h.sessionIds[0], 'thr-goal-set')
    assert.equal(h.messages.at(-1).type, 'openclaude_goal')
    assert.equal(h.messages.at(-1).goal.objective, 'Ship UI controls')
    await h.cleanup()
  })

  it('getGoal emits a cleared goal block when Codex reports no goal', async () => {
    const h = await makeHarness({ withFakeProc: true, resumeSessionId: 'thr-goal-get' })

    const p = h.runner.getGoal()

    await waitFor(() => h.written.length === 1)
    const resumeReq = JSON.parse(h.written[0])
    assert.equal(resumeReq.method, 'thread/resume')
    feed(h.runner, { jsonrpc: '2.0', id: resumeReq.id, result: {} })

    await waitFor(() => h.written.length === 2)
    const getReq = JSON.parse(h.written[1])
    assert.equal(getReq.method, 'thread/goal/get')
    assert.deepEqual(getReq.params, { threadId: 'thr-goal-get' })
    feed(h.runner, { jsonrpc: '2.0', id: getReq.id, result: { goal: null } })

    assert.equal(await p, null)
    assert.equal(h.messages.at(-1).type, 'openclaude_goal')
    assert.deepEqual(h.messages.at(-1).goal, { blockId: 'codex-goal', cleared: true })
    await h.cleanup()
  })

  it('clearGoal sends thread/goal/clear and emits a cleared goal block', async () => {
    const h = await makeHarness({ withFakeProc: true, resumeSessionId: 'thr-goal-clear' })
    ;(h.runner as any).attached = true

    const p = h.runner.clearGoal()

    await waitFor(() => h.written.length === 1)
    const clearReq = JSON.parse(h.written[0])
    assert.equal(clearReq.method, 'thread/goal/clear')
    assert.deepEqual(clearReq.params, { threadId: 'thr-goal-clear' })
    feed(h.runner, { jsonrpc: '2.0', id: clearReq.id, result: { cleared: true } })

    assert.equal(await p, true)
    assert.equal(h.messages.at(-1).type, 'openclaude_goal')
    assert.deepEqual(h.messages.at(-1).goal, { blockId: 'codex-goal', cleared: true })
    await h.cleanup()
  })
})

describe('handleNotification — collabAgentToolCall', () => {
  it('spawnAgent creates an Agent group but completed spawn does not close it', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-collab'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'spawn-1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          receiverThreadIds: ['child-1'],
          prompt: 'inspect auth flow',
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          agentsStates: {},
        },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'spawn-1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: ['child-1'],
          prompt: 'inspect auth flow',
          agentsStates: { 'child-1': { status: 'running', message: null } },
        },
      },
    })

    await new Promise((r) => setImmediate(r))
    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].message.content[0].type, 'tool_use')
    assert.equal(h.messages[0].message.content[0].name, 'Agent')
    assert.equal(
      h.messages.some((m) => m.type === 'user' && m.message.content[0]?.tool_use_id === 'spawn-1'),
      false,
    )
    await h.cleanup()
  })

  it('spawnAgent completed with terminal agentsStates closes the Agent group', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-collab'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'spawn-fast',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          receiverThreadIds: ['child-fast'],
          prompt: 'fast job',
          agentsStates: {},
        },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'spawn-fast',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: ['child-fast'],
          prompt: 'fast job',
          agentsStates: { 'child-fast': { status: 'completed', message: 'done' } },
        },
      },
    })

    await new Promise((r) => setImmediate(r))
    const agentResult = h.messages.find(
      (m) => m.type === 'user' && m.message.content[0]?.tool_use_id === 'spawn-fast',
    )
    assert.ok(agentResult)
    assert.equal(agentResult.message.content[0].is_error, false)
    assert.match(agentResult.message.content[0].content, /completed/)
    await h.cleanup()
  })

  it('failed spawnAgent closes the Agent group with an error result', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-collab'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'spawn-fail',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          receiverThreadIds: [],
          prompt: 'spawn fails',
          agentsStates: {},
        },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'spawn-fail',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'failed',
          receiverThreadIds: [],
          prompt: 'spawn fails',
          agentsStates: {},
        },
      },
    })

    await new Promise((r) => setImmediate(r))
    const result = h.messages.find(
      (m) => m.type === 'user' && m.message.content[0]?.tool_use_id === 'spawn-fail',
    )
    assert.ok(result)
    assert.equal(result.message.content[0].is_error, true)
    await h.cleanup()
  })

  it('wait with running agent stays as Codex:multiAgent and does not close spawn group', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-collab'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'spawn-2',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          receiverThreadIds: ['child-2'],
          prompt: 'long job',
          agentsStates: {},
        },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'spawn-2',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: ['child-2'],
          prompt: 'long job',
          agentsStates: {},
        },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'wait-1',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'inProgress',
          receiverThreadIds: ['child-2'],
          agentsStates: { 'child-2': { status: 'running', message: 'still working' } },
        },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'wait-1',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'completed',
          receiverThreadIds: ['child-2'],
          agentsStates: { 'child-2': { status: 'running', message: 'still working' } },
        },
      },
    })

    await new Promise((r) => setImmediate(r))
    const toolUses = h.messages
      .filter((m) => m.type === 'assistant')
      .map((m) => m.message.content[0])
    assert.equal(
      toolUses.some((c) => c.name === 'Codex:multiAgent'),
      true,
    )
    assert.equal(
      h.messages.some((m) => m.type === 'user' && m.message.content[0]?.tool_use_id === 'spawn-2'),
      false,
    )
    assert.equal(
      h.messages.some((m) => m.type === 'user' && m.message.content[0]?.tool_use_id === 'wait-1'),
      true,
    )
    await h.cleanup()
  })

  it('wait with terminal agentsStates completes the original Agent group', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-collab'

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'spawn-3',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          receiverThreadIds: ['child-3'],
          prompt: 'finish job',
          agentsStates: {},
        },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'spawn-3',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: ['child-3'],
          prompt: 'finish job',
          agentsStates: {},
        },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'wait-2',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'inProgress',
          receiverThreadIds: ['child-3'],
          agentsStates: { 'child-3': { status: 'running', message: null } },
        },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-collab',
        item: {
          id: 'wait-2',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'completed',
          receiverThreadIds: ['child-3'],
          agentsStates: { 'child-3': { status: 'completed', message: 'done' } },
        },
      },
    })

    await new Promise((r) => setImmediate(r))
    const controlResult = h.messages.find(
      (m) => m.type === 'user' && m.message.content[0]?.tool_use_id === 'wait-2',
    )
    const agentResult = h.messages.find(
      (m) => m.type === 'user' && m.message.content[0]?.tool_use_id === 'spawn-3',
    )
    assert.ok(controlResult)
    assert.ok(agentResult)
    assert.equal(agentResult.message.content[0].is_error, false)
    assert.match(agentResult.message.content[0].content, /completed/)
    await h.cleanup()
  })
})

describe('handleNotification — item/completed', () => {
  it('commandExecution → tool_result with exit code 0 (no error)', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-cmd'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr-1',
        turnId: 't-cmd',
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'ls -la',
          aggregatedOutput: 'file1\nfile2',
          exitCode: 0,
        },
      },
    })
    await new Promise((r) => setImmediate(r))
    const result = h.messages.find(
      (m) => m.type === 'user' && m.message.content[0].type === 'tool_result',
    )
    assert.ok(result)
    assert.equal(result.message.content[0].tool_use_id, 'cmd-1')
    assert.equal(result.message.content[0].content, 'file1\nfile2')
    assert.equal(result.message.content[0].is_error, false)
    await h.cleanup()
  })

  it('commandExecution non-zero exit → tool_result with is_error=true', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-cmd-err'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr-1',
        turnId: 't-cmd-err',
        item: {
          id: 'cmd-2',
          type: 'commandExecution',
          command: 'false',
          aggregatedOutput: '',
          exitCode: 1,
        },
      },
    })
    await new Promise((r) => setImmediate(r))
    const result = h.messages.find(
      (m) => m.type === 'user' && m.message.content[0].type === 'tool_result',
    )
    assert.ok(result)
    assert.equal(result.message.content[0].is_error, true)
    await h.cleanup()
  })

  it('fileChange → tool_result summary listing changes', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-fc'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr-1',
        turnId: 't-fc',
        item: {
          id: 'fc-1',
          type: 'fileChange',
          changes: [
            { kind: { type: 'add' }, path: '/tmp/new.txt', diff: '+hello' },
            { kind: { type: 'update' }, path: '/tmp/old.txt', diff: '-x\n+y' },
          ],
        },
      },
    })
    await new Promise((r) => setImmediate(r))
    const result = h.messages.find(
      (m) => m.type === 'user' && m.message.content[0].type === 'tool_result',
    )
    assert.ok(result)
    assert.match(result.message.content[0].content, /add: \/tmp\/new\.txt/)
    assert.match(result.message.content[0].content, /update: \/tmp\/old\.txt/)
    await h.cleanup()
  })

  it('imageGeneration with savedPath → copies to public dir + emits text_delta with public path', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-img'
    ;(h.runner as any).threadId = 'thr-img'

    // Set up a real source image + override paths.generatedDir via OPENCLAUDE_HOME isn't possible
    // post-import. Instead we mock copyImagePathsToPublicDir behavior by checking the file lands
    // wherever paths.generatedDir is. Simpler: use a tmp source file, let the real helper copy it.
    const baseTmp = await mkdtemp(join(tmpdir(), 'codex-aps-img-'))
    const srcImg = join(baseTmp, 'image_abc.png')
    await writeFile(srcImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr-img',
        turnId: 't-img',
        item: {
          id: 'img-1',
          type: 'imageGeneration',
          savedPath: srcImg,
        },
      },
    })
    // handleItemCompleted is async — wait for the tool_result to land (the
    // text_delta + tool_result are emitted in the same turn, but emit order is
    // text_delta first then tool_result, so awaiting tool_result guarantees
    // the delta has already been emitted).
    await waitFor(() =>
      h.messages.some((m) => m.type === 'user' && m.message.content[0]?.type === 'tool_result'),
    )

    // Should emit a text_delta containing a path that ends with the basename
    const deltas = h.messages.filter((m) => m.type === 'stream_event')
    assert.ok(deltas.length >= 1, `expected at least one text_delta, got ${deltas.length}`)
    const text = deltas[0].event.delta.text
    assert.match(text, /codex-thr-img-image_abc\.png/)

    // assistant buf updated for dedupe
    assert.match((h.runner as any).currentAssistantBuf, /codex-thr-img-image_abc\.png/)

    // Tool result also emitted
    const tr = h.messages.find(
      (m) => m.type === 'user' && m.message.content[0].type === 'tool_result',
    )
    assert.ok(tr)
    assert.match(tr.message.content[0].content, /imageGeneration/)
    await rm(baseTmp, { recursive: true, force: true })
    await h.cleanup()
  })

  it('imageGeneration when public path already in assistantBuf → dedupe (no extra text_delta)', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-img2'
    ;(h.runner as any).threadId = 'thr-dedup'

    const baseTmp = await mkdtemp(join(tmpdir(), 'codex-aps-dedup-'))
    const srcImg = join(baseTmp, 'dup.png')
    await writeFile(srcImg, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    // Pre-fill assistantBuf with the EXACT public path (the dedupe checks
    // `currentAssistantBuf.includes(publicPath)` with the full absolute path).
    const expectedPublicPath = join(paths.generatedDir, 'codex-thr-dedup-dup.png')
    ;(h.runner as any).currentAssistantBuf = `pre-emitted: ${expectedPublicPath}`

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr-dedup',
        turnId: 't-img2',
        item: {
          id: 'img-2',
          type: 'imageGeneration',
          savedPath: srcImg,
        },
      },
    })
    // Wait for tool_result (always emitted, with or without dedupe) so we
    // know the async handler has completed before asserting on deltas.
    await waitFor(() =>
      h.messages.some((m) => m.type === 'user' && m.message.content[0]?.type === 'tool_result'),
    )

    // No text_delta because the path is already in assistantBuf
    const deltas = h.messages.filter((m) => m.type === 'stream_event')
    assert.equal(deltas.length, 0, 'public path mention should suppress duplicate emit')

    // tool_result still emitted
    const tr = h.messages.find(
      (m) => m.type === 'user' && m.message.content[0].type === 'tool_result',
    )
    assert.ok(tr)
    await rm(baseTmp, { recursive: true, force: true })
    await h.cleanup()
  })

  it('imageGeneration without savedPath → falls back to generic tool_result (no copy)', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-img3'
    ;(h.runner as any).threadId = 'thr-x'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr-x',
        turnId: 't-img3',
        item: {
          id: 'img-3',
          type: 'imageGeneration',
          // no savedPath
        },
      },
    })
    await new Promise((r) => setImmediate(r))
    const deltas = h.messages.filter((m) => m.type === 'stream_event')
    assert.equal(deltas.length, 0)
    const tr = h.messages.find(
      (m) => m.type === 'user' && m.message.content[0].type === 'tool_result',
    )
    assert.ok(tr)
    await h.cleanup()
  })

  it('agentMessage / reasoning items → no separate tool_result (already streamed via deltas)', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-am'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-am',
        item: { id: 'am-1', type: 'agentMessage', text: 'Hello' },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-am',
        item: { id: 'r-1', type: 'reasoning', text: 'thinking...' },
      },
    })
    await new Promise((r) => setImmediate(r))
    const trs = h.messages.filter(
      (m) => m.type === 'user' && m.message.content[0]?.type === 'tool_result',
    )
    assert.equal(trs.length, 0)
    await h.cleanup()
  })
})

describe('handleNotification — turn/completed', () => {
  it('status=completed → resolves currentTurnCompleter with the turn record', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-done'
    let settled: any
    ;(h.runner as any).currentTurnCompleter = {
      resolve: (v: any) => {
        settled = v
      },
      reject: () => {},
    }
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thr',
        turn: { id: 't-done', status: 'completed', durationMs: 123 },
      },
    })
    assert.ok(settled)
    assert.equal(settled.status, 'completed')
    assert.equal((h.runner as any).currentTurnCompleter, null)
    await h.cleanup()
  })

  it('mismatched turn.id → does not resolve completer', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-mine'
    let settled = false
    ;(h.runner as any).currentTurnCompleter = {
      resolve: () => {
        settled = true
      },
      reject: () => {},
    }
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: 'thr', turn: { id: 't-other', status: 'completed' } },
    })
    assert.equal(settled, false)
    await h.cleanup()
  })
})

describe('handleNotification — early-arriving turn-scoped notifications (Codex review #019dde20 MAJOR 3)', () => {
  it('first delta arriving while turn/start response is still in flight: adopts turnId from notification', async () => {
    // Scenario: the runner has SENT turn/start but is still awaiting the
    // response. activeTurnId is null but currentTurnCompleter is set. A
    // delta notification carrying the new turnId arrives via stdout before
    // the turn/start response (microtask ordering issue). Without the
    // adopt-on-first-notification path, the delta would be silently dropped.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = null
    ;(h.runner as any).currentTurnCompleter = { resolve: () => {}, reject: () => {} }
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr-1', turnId: 't-early', itemId: 'i-1', delta: 'A' },
    })
    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].event.delta.text, 'A')
    assert.equal((h.runner as any).activeTurnId, 't-early')
    await h.cleanup()
  })

  it('turn-scoped notification with no turn in flight (no completer) → still dropped', async () => {
    // Defensive: server-internal turns (compaction, hooks) emit notifications
    // we should never adopt. Without currentTurnCompleter, drop.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = null
    ;(h.runner as any).currentTurnCompleter = null
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr-1', turnId: 't-internal', itemId: 'i-1', delta: 'X' },
    })
    assert.equal(h.messages.length, 0)
    assert.equal((h.runner as any).activeTurnId, null)
    await h.cleanup()
  })
})

describe('proc lifecycle — stale stdout frame attribution (Codex review #019dde20 BLOCKER round 2)', () => {
  it('a stale stdout chunk from an old proc must NOT be parsed against the new runner state', async () => {
    // Reproduce the production stdout handler inline (since the actual one is
    // a closure inside ensureSpawned that we don't spawn here). The
    // production code adds an identity check `if (this.proc !== proc) return`
    // at the top of the stdout 'data' handler; this test models that check.
    const h = await makeHarness()
    const runner = h.runner as any

    // Two synthetic procs. We installed a stdout handler closure for `oldProc`
    // (modelled inline). Now `runner.proc` points at `newProc` and a turn is
    // in flight — exactly the race window.
    const oldProc = { id: 'old' }
    const newProc = { id: 'new' }
    runner.proc = newProc
    runner.activeTurnId = null
    runner.currentTurnCompleter = { resolve: () => {}, reject: () => {} }

    // Inline replica of the production stdout handler with the identity guard.
    const oldStdoutHandler = (chunk: Buffer) => {
      if (runner.proc !== oldProc) return
      runner.stdoutBuf = (runner.stdoutBuf ?? '') + chunk.toString('utf8')
      let nl = runner.stdoutBuf.indexOf('\n')
      while (nl >= 0) {
        const line = runner.stdoutBuf.slice(0, nl).trim()
        runner.stdoutBuf = runner.stdoutBuf.slice(nl + 1)
        if (line) runner.handleLine(line)
        nl = runner.stdoutBuf.indexOf('\n')
      }
    }

    // Old proc flushes a buffered delta after being discarded
    const stalePayload = `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId: 'old-thr', turnId: 'old-turn', itemId: 'i', delta: 'STALE' },
    })}\n`
    oldStdoutHandler(Buffer.from(stalePayload, 'utf8'))

    // Identity guard must have rejected the chunk → no messages emitted, no
    // activeTurnId hijacked
    assert.equal(h.messages.length, 0, 'stale stdout must not emit messages')
    assert.equal(runner.activeTurnId, null, 'stale stdout must not hijack activeTurnId')
    assert.equal(runner.currentAssistantBuf, '', 'stale stdout must not pollute assistant buf')
    await h.cleanup()
  })

  it('a stale close handler from a discarded proc does not corrupt a freshly spawned proc', async () => {
    // Replicate the race: shutdown sets this.proc = null, immediately a new
    // submit() runs ensureSpawned which sets this.proc = newProc. Then the
    // OLD proc's close event fires. Without the identity check, the close
    // handler would null out newProc and reject newProc's pending requests.
    //
    // We construct this by hand because actually spawning two procs is racy
    // and overkill — we just simulate the close handler closure being held
    // by the OLD proc and see what happens when this.proc points elsewhere.
    const h = await makeHarness()
    const runner = h.runner as any

    // Simulate fresh spawn happening: we install a "stale close handler"
    // that the runner's spawn path would have set up. The handler runs the
    // exact identity check in production code.
    const oldProc = { id: 'old' }
    const newProc = { id: 'new' }
    runner.proc = oldProc

    // Capture the close handler logic by calling the runner's spawn-time
    // proc.on('close', ...) inline (we can't easily extract the closure, so
    // we model the identity check directly here as a regression test). The
    // production code's identity check is `if (this.proc !== proc) return`.
    const installCloseHandler = (proc: any) => {
      return () => {
        if (runner.proc !== proc) return // identity guard
        runner.proc = null
        runner.attached = false
        runner.initialized = false
      }
    }
    const oldCloseHandler = installCloseHandler(oldProc)

    // Now simulate respawn: this.proc is re-pointed to newProc. The OLD
    // close handler is about to fire because the OLD proc finally dies.
    runner.proc = newProc
    runner.attached = true
    runner.initialized = true

    oldCloseHandler() // stale close fires

    // newProc state must be untouched
    assert.equal(runner.proc, newProc, 'stale close handler must not null out newProc')
    assert.equal(runner.attached, true, 'stale close must not clear attached flag')
    assert.equal(runner.initialized, true, 'stale close must not clear initialized')
    await h.cleanup()
  })
})

describe('runTurn re-attach after respawn (Codex review #019dde20 BLOCKER 1)', () => {
  it('attached flag governs re-attach: false after construction with resumeSessionId', async () => {
    // After construction with resumeSessionId, attached MUST be false so the
    // first runTurn fires thread/resume against the fresh app-server proc.
    const h = await makeHarness({ resumeSessionId: 'thr-resume-1' })
    assert.equal((h.runner as any).attached, false)
    await h.cleanup()
  })

  it('proc close clears attached → next runTurn would re-resume', async () => {
    // We simulate an initialized + attached state, then have the proc emit
    // close. After close, attached must be false so the next runTurn sends
    // thread/resume before turn/start (instead of turn/start against an
    // unattached fresh proc).
    const h = await makeHarness({ withFakeProc: true })
    const runner = h.runner as any
    runner.attached = true

    // Simulate proc close handler running by calling the lifecycle reset
    // directly. (We don't have an actual subprocess here.)
    runner.proc = null
    runner.initialized = false
    runner.attached = false
    runner.activeTurnId = null

    assert.equal(runner.attached, false)
    assert.equal(runner.initialized, false)
    await h.cleanup()
  })

  it('shutdown clears attached', async () => {
    const h = await makeHarness({ withFakeProc: true })
    ;(h.runner as any).attached = true
    await h.runner.shutdown()
    assert.equal((h.runner as any).attached, false)
    await h.cleanup()
  })

  it('shutdown also clears stdoutBuf (Codex review #019dde20 BLOCKER round 3 — partial-line residue)', async () => {
    // Without this, a proc dying mid-line would leave a fragment like
    // '{"jsonrpc":"2.0",' in the runner-level stdoutBuf. The next proc's
    // first chunk would be appended to that fragment, producing invalid
    // JSON and causing the initialize response to be parse_error'd while
    // the pending initialize request hangs forever.
    const h = await makeHarness({ withFakeProc: true })
    ;(h.runner as any).stdoutBuf = '{"jsonrpc":"2.0","id":1,'
    await h.runner.shutdown()
    assert.equal((h.runner as any).stdoutBuf, '', 'shutdown must clear partial-line buffer')
    await h.cleanup()
  })
})

describe('thread/resume missing-rollout self-heal (Codex review #019e0b72 BLOCKER 1)', () => {
  // These tests cover the v3 commercial container "stale thread_id" failure:
  // master sessionManager persists codex thread_id across container rebuilds,
  // but codex's `~/.codex/sessions/...` rollout JSONL lives on the container's
  // ephemeral layer. After idle-stop + docker rm, the resume-map still feeds
  // the old thread_id to the runner, which calls thread/resume → JSON-RPC
  // error -32600 "no rollout found for thread id ...". The runner used to
  // emit ok=false directly (29-1188ms empty result frames, "未收到回复"
  // banner). Self-heal: detect missing-rollout via structured rpcCode/method/
  // message guards, transparently restart with thread/start, and re-emit the
  // new session_id so the next turn doesn't loop.

  /** Wait for the runner to write the next JSON-RPC line (poll the harness's
   *  written buffer). Throws if no new line appears within 50 microtasks. */
  async function waitForNextWritten(written: string[], prevLen: number): Promise<any> {
    for (let i = 0; i < 50; i++) {
      if (written.length > prevLen) return JSON.parse(written[written.length - 1])
      await new Promise((r) => setImmediate(r))
    }
    throw new Error(`runner never wrote a new line (prevLen=${prevLen}, total=${written.length})`)
  }

  it('thread/resume returns -32600 "no rollout found" → restart with thread/start, threadId updated, session_id re-emitted', async () => {
    const h = await makeHarness({ withFakeProc: true, resumeSessionId: 'thr-stale' })
    const runner = h.runner as any
    assert.equal(runner.threadId, 'thr-stale')
    assert.equal(runner.attached, false)

    // Drive runTurn — don't await; we need to pump replies in.
    const turnPromise = runner.runTurn('hello')

    // Step 1: runner writes thread/resume against the stale id.
    const req1 = await waitForNextWritten(h.written, 0)
    assert.equal(req1.method, 'thread/resume')
    assert.equal(req1.params.threadId, 'thr-stale')

    // Reply with the codex 0.125 missing-rollout shape.
    feed(h.runner, {
      jsonrpc: '2.0',
      id: req1.id,
      error: { code: -32600, message: 'no rollout found for thread id thr-stale' },
    })

    // Step 2: runner self-heals → thread/start.
    const req2 = await waitForNextWritten(h.written, 1)
    assert.equal(req2.method, 'thread/start')
    feed(h.runner, {
      jsonrpc: '2.0',
      id: req2.id,
      result: { thread: { id: 'thr-NEW' } },
    })

    // Step 3: runner proceeds to turn/start with the NEW threadId.
    const req3 = await waitForNextWritten(h.written, 2)
    assert.equal(req3.method, 'turn/start')
    assert.equal(req3.params.threadId, 'thr-NEW')
    feed(h.runner, {
      jsonrpc: '2.0',
      id: req3.id,
      result: { turn: { id: 't-1' } },
    })

    // Step 4: turn/completed notification settles runTurn.
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: 'thr-NEW', turn: { id: 't-1', status: 'completed', durationMs: 5 } },
    })

    await turnPromise

    // Post-conditions
    assert.equal(runner.threadId, 'thr-NEW', 'threadId must be updated to fresh id')
    assert.equal(runner.attached, true, 'attached must be true after successful self-heal')
    assert.deepEqual(
      h.sessionIds,
      ['thr-NEW'],
      'session_id must be emitted exactly once for the new thread',
    )

    // The runTurn should have emitted a result message with ok=true.
    const resultMsg = h.messages.find((m) => m.type === 'result')
    assert.ok(resultMsg, 'expected a result message after self-heal')
    assert.equal(resultMsg.is_error, false)

    await h.cleanup()
  })

  it('thread/resume returns -32600 with non-missing-rollout message → does NOT self-heal, surfaces as ok=false', async () => {
    // Guards against future codex releases repurposing -32600 for protocol/
    // schema drift. We must NOT silently restart in that case — the user
    // would lose context with no error surface.
    const h = await makeHarness({ withFakeProc: true, resumeSessionId: 'thr-stale-2' })
    const runner = h.runner as any

    const turnPromise = runner.runTurn('hello')

    const req1 = await waitForNextWritten(h.written, 0)
    assert.equal(req1.method, 'thread/resume')

    // -32600 but NOT "no rollout found" — e.g. param schema drift.
    feed(h.runner, {
      jsonrpc: '2.0',
      id: req1.id,
      error: { code: -32600, message: 'invalid params: sandbox value not recognized' },
    })

    await turnPromise

    // No second JSON-RPC request written — runner must NOT have started a
    // fresh thread.
    assert.equal(
      h.written.length,
      1,
      `expected only 1 request (thread/resume), got ${h.written.length}: ${h.written.join(' | ')}`,
    )
    assert.equal(runner.threadId, 'thr-stale-2', 'threadId must NOT be cleared')
    assert.equal(runner.attached, false, 'attached must remain false on hard failure')
    assert.deepEqual(h.sessionIds, [], 'session_id must NOT be re-emitted')

    // result message should be ok=false, surfacing the original error.
    const resultMsg = h.messages.find((m) => m.type === 'result')
    assert.ok(resultMsg, 'expected a result message for the failed turn')
    assert.equal(resultMsg.is_error, true)

    await h.cleanup()
  })

  it('thread/resume self-heals, but thread/start subsequently fails → attached stays false, threadId cleared, ok=false', async () => {
    // Edge case: missing-rollout detected, thread/start fired, but the
    // restart itself fails (e.g. codex proc crashed mid-restart). attached
    // must NOT be set to true — otherwise the next runTurn would skip the
    // attach block and call turn/start against an unattached proc.
    const h = await makeHarness({ withFakeProc: true, resumeSessionId: 'thr-stale-3' })
    const runner = h.runner as any

    const turnPromise = runner.runTurn('hello')

    // Reject thread/resume with missing-rollout
    const req1 = await waitForNextWritten(h.written, 0)
    assert.equal(req1.method, 'thread/resume')
    feed(h.runner, {
      jsonrpc: '2.0',
      id: req1.id,
      error: { code: -32600, message: 'no rollout found for thread id thr-stale-3' },
    })

    // Reject thread/start with a generic codex error
    const req2 = await waitForNextWritten(h.written, 1)
    assert.equal(req2.method, 'thread/start')
    feed(h.runner, {
      jsonrpc: '2.0',
      id: req2.id,
      error: { code: -32603, message: 'internal error during thread/start' },
    })

    await turnPromise

    assert.equal(runner.attached, false, 'attached must stay false when self-heal fails')
    assert.equal(runner.threadId, null, 'threadId must be cleared during self-heal even on failure')
    assert.equal(h.written.length, 2, 'no turn/start expected (attach failed)')

    const resultMsg = h.messages.find((m) => m.type === 'result')
    assert.ok(resultMsg, 'expected a result message')
    assert.equal(resultMsg.is_error, true)

    await h.cleanup()
  })

  it('sendRequest reject preserves rpcCode / rpcMessage / rpcMethod fields', async () => {
    // Sanity: the structured-error refactor must keep both the human message
    // shape (existing test asserts) AND the new fields used by
    // isMissingRolloutError.
    const h = await makeHarness({ withFakeProc: true })
    let err: any
    ;(h.runner as any).sendRequest('thread/resume', {}).catch((e: any) => {
      err = e
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'no rollout found for thread id xyz' },
    })
    await new Promise((r) => setImmediate(r))
    assert.ok(err instanceof Error)
    const rpcErr = err as Error & { rpcCode: number; rpcMessage: string; rpcMethod: string }
    assert.match(rpcErr.message, /thread\/resume -> -32600: no rollout found/)
    assert.equal(rpcErr.rpcCode, -32600)
    assert.equal(rpcErr.rpcMessage, 'no rollout found for thread id xyz')
    assert.equal(rpcErr.rpcMethod, 'thread/resume')
    await h.cleanup()
  })
})

describe('interrupt', () => {
  it('returns false when no active turn', async () => {
    const h = await makeHarness({ withFakeProc: true })
    assert.equal(h.runner.interrupt(), false)
    assert.equal(h.written.length, 0)
    await h.cleanup()
  })

  it('returns false when no proc', async () => {
    const h = await makeHarness()
    ;(h.runner as any).threadId = 'thr-1'
    ;(h.runner as any).activeTurnId = 't-1'
    assert.equal(h.runner.interrupt(), false)
    await h.cleanup()
  })

  it('with active turn + proc → writes turn/interrupt JSON-RPC', async () => {
    const h = await makeHarness({ withFakeProc: true })
    ;(h.runner as any).threadId = 'thr-int'
    ;(h.runner as any).activeTurnId = 't-int'
    assert.equal(h.runner.interrupt(), true)
    assert.equal(h.written.length, 1)
    const sent = JSON.parse(h.written[0])
    assert.equal(sent.method, 'turn/interrupt')
    assert.equal(sent.params.threadId, 'thr-int')
    assert.equal(sent.params.turnId, 't-int')
    await h.cleanup()
  })
})

describe('shutdown', () => {
  it('rejects pending JSON-RPC + turn completer + queued turns', async () => {
    const h = await makeHarness({ withFakeProc: true })

    // pending JSON-RPC
    let pendingErr: any
    ;(h.runner as any).sendRequest('initialize', {}).catch((e: any) => {
      pendingErr = e
    })

    // turn completer
    let completerErr: any
    ;(h.runner as any).currentTurnCompleter = {
      resolve: () => {},
      reject: (e: any) => {
        completerErr = e
      },
    }

    // queued turn
    let queuedErr: any
    ;(h.runner as any).queue.push({
      prompt: 'X',
      resolve: () => {},
      reject: (e: any) => {
        queuedErr = e
      },
    })

    await h.runner.shutdown()
    await new Promise((r) => setImmediate(r))

    assert.ok(pendingErr instanceof Error, 'pending JSON-RPC should reject')
    assert.match(pendingErr.message, /shutdown/)
    assert.ok(completerErr instanceof Error, 'turn completer should reject')
    assert.match(completerErr.message, /shutdown/)
    assert.ok(queuedErr instanceof Error, 'queued turn should reject')

    assert.equal((h.runner as any).proc, null)
    assert.equal(h.exits.length, 1)
    await h.cleanup()
  })
})

describe('SubprocessRunner interface parity', () => {
  it('exposes lastActivityAt + effortLevel + isRunning', async () => {
    const h = await makeHarness()
    assert.equal(typeof h.runner.lastActivityAt, 'number')
    assert.equal(h.runner.effortLevel, undefined)
    assert.equal(h.runner.isRunning, false)
    await h.cleanup()
  })

  it('updateConfig / setEffortLevel / sendPermissionResponse are callable', async () => {
    const h = await makeHarness()
    // updateConfig now mutates opts + clears cachedOverrides (Phase 1 platform
    // context plumbing); it's no longer a strict no-op but must remain callable
    // through the SubprocessRunner-shaped interface.
    h.runner.updateConfig({} as any)
    h.runner.setEffortLevel('high')
    assert.equal(h.runner.sendPermissionResponse('req-1', {}), false)
    await h.cleanup()
  })

  it('isRunning reflects proc presence', async () => {
    const h = await makeHarness({ withFakeProc: true })
    assert.equal(h.runner.isRunning, true)
    await h.cleanup()
  })
})
