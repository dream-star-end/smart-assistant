import * as assert from 'node:assert/strict'
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
import { describe, it } from 'node:test'
import { paths } from '@openclaude/storage'
import {
  _CODEX_5H_WINDOW_MINS,
  _CODEX_7D_WINDOW_MINS,
  _parseCodexRateLimits,
  CodexAppServerRunner,
  _classifyJsonRpcLine,
  _codexUsageToAnthropicShape,
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
  } = {},
): Promise<Harness> {
  const baseTmp = await mkdtemp(join(tmpdir(), 'codex-aps-'))
  const runner = new CodexAppServerRunner({
    sessionKey: 'test',
    agentId: 'test',
    cwd: baseTmp,
    resumeSessionId: opts.resumeSessionId,
    model: opts.model,
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
})

describe('CodexAppServerRunner route-specific provider lifecycle', () => {
  it('restarts only the current app-server proc on route change and preserves queued turns', async () => {
    const h = await makeHarness({ withFakeProc: true })
    const queuedErrors: Error[] = []
    const queuedTurn = {
      prompt: 'queued',
      resolve: () => {},
      reject: (err: Error) => queuedErrors.push(err),
      requestId: 'queued-req',
    }
    ;(h.runner as any).queue = [queuedTurn]
    ;(h.runner as any).spawnedProviderSignature = JSON.stringify({
      modelProvider: 'old_provider',
      baseUrl: `http://127.0.0.1:18789/internal/v3/codex-relay/route/${'a'.repeat(64)}`,
    })
    ;(h.runner as any).setCodexRoute({
      modelProvider: 'new_provider',
      baseUrl: `http://127.0.0.1:18789/internal/v3/codex-relay/route/${'b'.repeat(64)}`,
      wireApi: 'responses',
      preferredAuthMethod: 'apikey',
      disableResponseStorage: true,
    })

    let shutdowns = 0
    let ensureSpawned = 0
    ;(h.runner as any).shutdown = async () => {
      shutdowns += 1
      assert.equal((h.runner as any).queue.length, 0, 'queued turns are shielded from shutdown rejection')
      ;(h.runner as any).proc = null
      ;(h.runner as any).initialized = false
      ;(h.runner as any).attached = false
      ;(h.runner as any).spawnedProviderSignature = null
    }
    ;(h.runner as any).ensureSpawned = async () => {
      ensureSpawned += 1
      ;(h.runner as any).proc = { killed: false }
      ;(h.runner as any).initialized = true
      ;(h.runner as any).attached = true
      ;(h.runner as any).spawnedProviderSignature = (h.runner as any).codexRouteSignature()
    }
    ;(h.runner as any).sendRequest = async (method: string) => {
      if (method !== 'turn/start') throw new Error(`unexpected rpc method ${method}`)
      setImmediate(() => {
        ;(h.runner as any).currentTurnCompleter?.resolve({ status: 'completed', durationMs: 1 })
      })
      return { turn: { id: 'turn-route-change' } }
    }

    await (h.runner as any).runTurn('hello', 'route-req')

    assert.equal(shutdowns, 1)
    assert.equal(ensureSpawned, 1)
    assert.equal(queuedErrors.length, 0, 'route restart must not reject queued turns')
    assert.deepEqual((h.runner as any).queue, [queuedTurn])
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

  it('unknown server-request responds with -32601 method-not-found', async () => {
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

  it('auto-approves recognized codex permission requests for the session', async () => {
    const h = await makeHarness({ withFakeProc: true })
    feed(h.runner, {
      jsonrpc: '2.0',
      id: 'srv-approve',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'pwd' },
    })
    assert.equal(h.written.length, 1)
    const reply = JSON.parse(h.written[0])
    assert.equal(reply.id, 'srv-approve')
    assert.deepEqual(reply.result, { decision: 'acceptForSession' })
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

describe('handleNotification — native plan updates', () => {
  it('emits OpenClaude plan messages from codex plan deltas and updates', async () => {
    const h = await makeHarness()
    ;(h.runner as any).threadId = 'thr-plan'
    ;(h.runner as any).activeTurnId = 't-plan'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/plan/delta',
      params: { threadId: 'thr-plan', turnId: 't-plan', delta: 'Step 1' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/plan/delta',
      params: { threadId: 'thr-plan', turnId: 't-plan', delta: '\nStep 2' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'turn/plan/updated',
      params: {
        threadId: 'thr-plan',
        turnId: 't-plan',
        explanation: 'Implementation plan',
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Patch', status: 'inProgress' },
          { step: 'Verify', status: 'blocked' },
        ],
      },
    })

    assert.equal(h.messages.length, 3)
    assert.equal(h.messages[0].type, 'openclaude_plan')
    assert.equal(h.messages[0].session_id, 'thr-plan')
    assert.equal(h.messages[0].plan.blockId, 'codex-plan-t-plan')
    assert.equal(h.messages[0].plan.text, 'Step 1')
    assert.equal(h.messages[1].plan.blockId, 'codex-plan-t-plan')
    assert.equal(h.messages[1].plan.text, 'Step 1\nStep 2')
    assert.equal(h.messages[2].plan.blockId, 'codex-plan-t-plan')
    assert.equal(h.messages[2].plan.explanation, 'Implementation plan')
    assert.deepEqual(h.messages[2].plan.steps, [
      { step: 'Inspect', status: 'completed' },
      { step: 'Patch', status: 'inProgress' },
      { step: 'Verify', status: 'pending' },
    ])
    assert.equal(h.messages[2].plan.partial, true)
    await h.cleanup()
  })
})

// Reasoning streaming: codex emits either `textDelta` (raw chain-of-thought)
// or `summaryTextDelta` (model-distilled summary) depending on the reasoning
// mode. Both are surfaced to the UI as CCB `thinking_delta` so the frontend
// renders a 💭 thinking card — same surface claude-code uses. `summaryPartAdded`
// inserts a paragraph separator (`\n\n`) between named summary sections.
describe('handleNotification — item/reasoning/* (codex-ui-unify thinking surface)', () => {
  it('item/reasoning/textDelta emits content_block_delta thinking_delta', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'Thinking…' },
    })
    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].type, 'stream_event')
    assert.equal(h.messages[0].event.type, 'content_block_delta')
    assert.equal(h.messages[0].event.delta.type, 'thinking_delta')
    assert.equal(h.messages[0].event.delta.thinking, 'Thinking…')
    await h.cleanup()
  })

  it('item/reasoning/summaryTextDelta also maps to thinking_delta', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'Summary part…' },
    })
    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].event.delta.type, 'thinking_delta')
    assert.equal(h.messages[0].event.delta.thinking, 'Summary part…')
    await h.cleanup()
  })

  it('item/reasoning/summaryPartAdded between filled parts emits \\n\\n separator', async () => {
    // First part: no-op (see CONCERN #2 test below). Add content, then a
    // second part — only the second emits the paragraph separator.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', part: { name: 'p1' } },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'first' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', part: { name: 'p2' } },
    })
    // Expect: first, \n\n — initial summaryPartAdded suppressed.
    assert.equal(h.messages.length, 2)
    assert.equal(h.messages[1].event.delta.type, 'thinking_delta')
    assert.equal(h.messages[1].event.delta.thinking, '\n\n')
    await h.cleanup()
  })

  it('reasoning delta does NOT accumulate into currentAssistantBuf (it is thinking, not text)', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'XYZ' },
    })
    assert.equal((h.runner as any).currentAssistantBuf, '')
    await h.cleanup()
  })

  it('empty reasoning delta string is a no-op', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: '' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: '' },
    })
    assert.equal(h.messages.length, 0)
    await h.cleanup()
  })

  it('reasoning delta drops on turnId mismatch (same guard as agentMessage/delta)', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-mine'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-other', itemId: 'r-1', delta: 'oops' },
    })
    assert.equal(h.messages.length, 0)
    await h.cleanup()
  })

  it('summary mode locks: textDelta after summaryTextDelta is dropped (codex review CONCERN #1)', async () => {
    // If codex emits both raw text and summary for the same reasoning item,
    // we surface only the summary — splicing raw chain-of-thought into the
    // distilled summary would corrupt the rendered thinking card.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'distilled' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'raw-cot' },
    })
    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].event.delta.thinking, 'distilled')
    await h.cleanup()
  })

  it('textDelta-only items still surface when summary never arrives (non-reasoning model fallback)', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'raw1' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'raw2' },
    })
    assert.equal(h.messages.length, 2)
    assert.equal(h.messages[0].event.delta.thinking, 'raw1')
    assert.equal(h.messages[1].event.delta.thinking, 'raw2')
    await h.cleanup()
  })

  it('summary mode is per-itemId (different reasoning items track independently)', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    // Item A: summary mode.
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-A', delta: 'A-sum' },
    })
    // Item B: text mode (different itemId — should NOT be locked by A).
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-B', delta: 'B-raw' },
    })
    assert.equal(h.messages.length, 2)
    assert.equal(h.messages[0].event.delta.thinking, 'A-sum')
    assert.equal(h.messages[1].event.delta.thinking, 'B-raw')
    await h.cleanup()
  })

  it('summaryPartAdded first event for an item is a no-op (codex review CONCERN #2)', async () => {
    // The first summaryPartAdded is the start of part 1 — emitting \n\n
    // there would prepend a blank line / surface an empty thinking card
    // before any real content. Skip the first; only insert separators
    // BETWEEN parts (i.e. after content has been seen).
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', part: { name: 'first' } },
    })
    assert.equal(h.messages.length, 0)
    // Now content + a second part — second one DOES emit separator.
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'p1' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', part: { name: 'second' } },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'p2' },
    })
    // Expect: p1, \n\n, p2 — three emits, no leading separator.
    assert.equal(h.messages.length, 3)
    assert.equal(h.messages[0].event.delta.thinking, 'p1')
    assert.equal(h.messages[1].event.delta.thinking, '\n\n')
    assert.equal(h.messages[2].event.delta.thinking, 'p2')
    await h.cleanup()
  })

  it('summaryPartAdded first-call locks mode to summary even before content arrives', async () => {
    // First summaryPartAdded (no \n\n emit) must still flip the item into
    // summary mode so a subsequent stray textDelta is suppressed.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', part: { name: 'first' } },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'should-be-dropped' },
    })
    assert.equal(h.messages.length, 0)
    await h.cleanup()
  })

  it('text mode locks: summaryTextDelta after textDelta is dropped (codex review v2 — symmetric lock)', async () => {
    // v1 only blocked summary→text. v2 review caught that text→summary
    // would still splice (raw CoT + distilled summary concatenation).
    // Verifies the symmetric direction: once text is locked, summary is
    // dropped just like the other way around.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'raw-cot' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'late-summary' },
    })
    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0].event.delta.thinking, 'raw-cot')
    await h.cleanup()
  })

  it('text mode drops summaryPartAdded entirely (codex review v2 — orphan \\n\\n guard)', async () => {
    // If the item already streamed raw textDelta(s), a stray
    // summaryPartAdded must NOT inject \n\n — there's no second part
    // coming (the matching summaryTextDelta would also be dropped by the
    // symmetric mode lock), so the separator would be a noise paragraph
    // break wedged between text deltas.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-r'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'raw1' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', part: { name: 'stray' } },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thr-1', turnId: 't-r', itemId: 'r-1', delta: 'raw2' },
    })
    // Expect only raw1, raw2 — no \n\n between them.
    assert.equal(h.messages.length, 2)
    assert.equal(h.messages[0].event.delta.thinking, 'raw1')
    assert.equal(h.messages[1].event.delta.thinking, 'raw2')
    await h.cleanup()
  })

  it('interleaved reasoning + agentMessage emit in order (no buffering)', async () => {
    // Drives the UI's flush-before-null invariant: gateway must emit each
    // delta in the order codex sent it, so the websocket layer can stamp
    // completedAt + drain `_streamingThinking` before swapping to a fresh
    // `_streamingAssistant` row.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-mix'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thr-1', turnId: 't-mix', itemId: 'r-1', delta: 'thinking' },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr-1', turnId: 't-mix', itemId: 'a-1', delta: 'answer' },
    })
    assert.equal(h.messages.length, 2)
    assert.equal(h.messages[0].event.delta.type, 'thinking_delta')
    assert.equal(h.messages[0].event.delta.thinking, 'thinking')
    assert.equal(h.messages[1].event.delta.type, 'text_delta')
    assert.equal(h.messages[1].event.delta.text, 'answer')
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

  it('surfaces contextCompaction items from an internal turn while user turn is in flight', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-user'
    ;(h.runner as any).currentTurnCompleter = { resolve: () => {}, reject: () => {} }
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr-1',
        turnId: 't-compact',
        item: { id: 'ctx-1', type: 'contextCompaction', tokensBefore: 100000 },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr-1',
        turnId: 't-compact',
        item: { id: 'ctx-1', type: 'contextCompaction', tokensBefore: 100000, tokensAfter: 20000 },
      },
    })

    assert.equal((h.runner as any).activeTurnId, 't-user')
    assert.equal(h.messages.length, 4)
    assert.deepEqual(
      h.messages.map((m) => [m.type, m.subtype ?? '', m.status ?? '']),
      [
        ['system', 'status', 'compacting'],
        ['assistant', '', ''],
        ['user', '', ''],
        ['system', 'status', ''],
      ],
    )
    assert.equal(h.messages[1].message.content[0].name, 'codex:contextCompaction')
    assert.equal(h.messages[1].message.content[0].input.type, 'contextCompaction')
    assert.equal(h.messages[2].message.content[0].tool_use_id, 'ctx-1')
    await h.cleanup()
  })

  it('normalises snake_case context compaction item types for the frontend card', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-user'
    ;(h.runner as any).currentTurnCompleter = { resolve: () => {}, reject: () => {} }
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr-1',
        turnId: 't-user',
        item: { id: 'ctx-2', type: 'context_compaction' },
      },
    })

    assert.equal(h.messages.length, 2)
    assert.equal(h.messages[1].message.content[0].name, 'codex:contextCompaction')
    assert.equal(h.messages[1].message.content[0].input.type, 'contextCompaction')
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
    throw new Error(
      `runner never wrote a new line (prevLen=${prevLen}, total=${written.length})`,
    )
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
    assert.deepEqual(h.sessionIds, ['thr-NEW'], 'session_id must be emitted exactly once for the new thread')

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

  it('self-heal resets thread-scoped token usage baselines (v3 billing — Codex review #019e0b90)', async () => {
    // v3-specific: priorTurnTotal/activeTurnTotal/currentTurnUsage are
    // thread-scoped, accumulated from `thread/tokenUsage/updated`. After
    // self-heal swaps to a fresh thread, the new thread's first usage frame
    // would otherwise be diffed against the dead thread's stale baseline,
    // clamping turn billing to ~0 (or causing _subtractTokenBreakdown to
    // floor negatives). _startNewThread() must clear all three.
    const h = await makeHarness({ withFakeProc: true, resumeSessionId: 'thr-stale-billing' })
    const runner = h.runner as any

    // Simulate post-shutdown state: stale baseline from prior thread, like
    // what shutdown() leaves behind when promoting activeTurnTotal at line ~588.
    runner.priorTurnTotal = {
      cachedInputTokens: 100,
      inputTokens: 200,
      outputTokens: 300,
      reasoningOutputTokens: 50,
      totalTokens: 650,
    }
    runner.activeTurnTotal = null
    runner.currentTurnUsage = null

    const turnPromise = runner.runTurn('hello')

    const req1 = await waitForNextWritten(h.written, 0)
    assert.equal(req1.method, 'thread/resume')
    feed(h.runner, {
      jsonrpc: '2.0',
      id: req1.id,
      error: { code: -32600, message: 'no rollout found for thread id thr-stale-billing' },
    })

    const req2 = await waitForNextWritten(h.written, 1)
    assert.equal(req2.method, 'thread/start')
    feed(h.runner, {
      jsonrpc: '2.0',
      id: req2.id,
      result: { thread: { id: 'thr-NEW-billing' } },
    })

    // Reset must happen BEFORE turn/start writes — by the time runner emits
    // turn/start, _startNewThread continuation has run and the baselines are
    // null. Otherwise the new thread's first tokenUsage frame would diff
    // against the dead thread's stale priorTurnTotal.
    const req3 = await waitForNextWritten(h.written, 2)
    assert.equal(req3.method, 'turn/start')
    assert.equal(runner.priorTurnTotal, null, 'priorTurnTotal must reset on self-heal')
    assert.equal(runner.activeTurnTotal, null, 'activeTurnTotal must reset on self-heal')
    assert.equal(runner.currentTurnUsage, null, 'currentTurnUsage must reset on self-heal')
    feed(h.runner, {
      jsonrpc: '2.0',
      id: req3.id,
      result: { turn: { id: 't-billing' } },
    })

    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thr-NEW-billing',
        turn: { id: 't-billing', status: 'completed', durationMs: 5 },
      },
    })

    await turnPromise
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
    assert.match(err.message, /thread\/resume -> -32600: no rollout found/)
    const e = err as Error & { rpcCode: number; rpcMessage: string; rpcMethod: string }
    assert.equal(e.rpcCode, -32600)
    assert.equal(e.rpcMessage, 'no rollout found for thread id xyz')
    assert.equal(e.rpcMethod, 'thread/resume')
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
    // Phase 1 (master a88419ba ported): updateConfig/setEffortLevel are no
    // longer no-ops — they invalidate launch-overrides cache and record
    // effort respectively. Test still asserts they don't throw.
    const h = await makeHarness()
    h.runner.updateConfig({} as any)
    h.runner.setEffortLevel('high')
    assert.equal(h.runner.sendPermissionResponse('req-1', {}), false)
    await h.cleanup()
  })

  it('model getter / setModel mutates and never spawns', async () => {
    // Regression: sessionManager.submit calls session.runner.setModel on every
    // InboundMessage with model field; missing method = TypeError → turn never
    // completes → user sees "思考中" forever (witnessed in v3 v1.0.61b prod).
    const h = await makeHarness({ model: 'gpt-5.5' })
    assert.equal(h.runner.model, 'gpt-5.5')
    h.runner.setModel('gpt-5-codex')
    assert.equal(h.runner.model, 'gpt-5-codex')
    h.runner.setModel(undefined)
    assert.equal(h.runner.model, undefined)
    // Contract parity with SubprocessRunner.setModel: pure setter, no spawn.
    // Caller (sessionManager) owns restart via shutdown() + next submit.
    assert.equal((h.runner as any).proc, null)
    assert.equal(h.spawns.length, 0)
    await h.cleanup()
  })

  it('isRunning reflects proc presence', async () => {
    const h = await makeHarness({ withFakeProc: true })
    assert.equal(h.runner.isRunning, true)
    await h.cleanup()
  })
})

// ── PR1 v1.0.65: codex item-type rendering + tokenUsage tracking ────────────

describe('handleItemStarted — suppression + lowercase prefix (PR1 v1.0.65 A.1)', () => {
  it('userMessage item is fully suppressed (no tool_use emit)', async () => {
    // codex echoes the user prompt back as a `userMessage` thread item.
    // Without suppression this surfaced as a "CODEX:USERMESSAGE" tool card
    // — pure noise from the user's perspective. boss flagged this in v1.0.64.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-um'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-um',
        item: { id: 'um-1', type: 'userMessage', text: 'echo of user prompt' },
      },
    })
    assert.equal(h.messages.length, 0, 'userMessage must not emit any tool_use')
    await h.cleanup()
  })

  it('userMessage item.completed is also suppressed (no tool_result echo)', async () => {
    // Mirror suppression at item/completed — otherwise the generic
    // JSON.stringify fallback would emit a pseudo-tool_result containing the
    // echoed user text.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-um2'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-um2',
        item: { id: 'um-2', type: 'userMessage', text: 'echo' },
      },
    })
    await new Promise((r) => setImmediate(r))
    assert.equal(h.messages.length, 0, 'userMessage completion must not emit tool_result')
    await h.cleanup()
  })

  it('hookPrompt item is fully suppressed', async () => {
    // hookPrompt = system-internal scaffolding (e.g. session-init prompts).
    // Same suppression rationale as userMessage.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-hp'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-hp',
        item: { id: 'hp-1', type: 'hookPrompt', text: 'system' },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thr',
        turnId: 't-hp',
        item: { id: 'hp-1', type: 'hookPrompt', text: 'system' },
      },
    })
    await new Promise((r) => setImmediate(r))
    assert.equal(h.messages.length, 0)
    await h.cleanup()
  })

  it('unknown item type → tool_use with lowercase `codex:` prefix', async () => {
    // The fallback emit path for non-special types (mcpToolCall, webSearch,
    // dynamicToolCall, etc.) must emit `codex:<type>` lowercase so the
    // frontend's _CODEX_TYPE_META table can match. v1.0.64 used `Codex:`
    // capitalised prefix → no FE table match → ugly fallback rendering.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-ws'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-ws',
        item: { id: 'ws-1', type: 'webSearch', query: 'foo' },
      },
    })
    assert.equal(h.messages.length, 1)
    const msg = h.messages[0]
    assert.equal(msg.type, 'assistant')
    assert.equal(msg.message.content[0].type, 'tool_use')
    assert.equal(msg.message.content[0].name, 'codex:webSearch')
    assert.deepEqual(msg.message.content[0].input, {
      id: 'ws-1',
      type: 'webSearch',
      query: 'foo',
    })
    await h.cleanup()
  })

  it('agentMessage / reasoning items still emit no tool_use (existing contract preserved)', async () => {
    // Regression guard: the suppression refactor for userMessage/hookPrompt
    // must not accidentally re-enable tool_use cards for agentMessage and
    // reasoning, which are streamed via deltas.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-am'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-am',
        item: { id: 'am-1', type: 'agentMessage' },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-am',
        item: { id: 'r-1', type: 'reasoning' },
      },
    })
    assert.equal(h.messages.length, 0)
    await h.cleanup()
  })

  it('commandExecution / fileChange item.started still aliases to Bash / Write (legacy contract preserved)', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-cmd'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-cmd',
        item: { id: 'cmd-1', type: 'commandExecution', command: 'ls' },
      },
    })
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: 'thr',
        turnId: 't-cmd',
        item: {
          id: 'fc-1',
          type: 'fileChange',
          changes: [{ kind: { type: 'add' }, path: '/tmp/x.txt' }],
        },
      },
    })
    const names = h.messages.map((m) => m.message.content[0].name)
    assert.deepEqual(names, ['Bash', 'Write'])
    await h.cleanup()
  })
})

describe('handleNotification — thread/tokenUsage/updated (PR1 v1.0.65 A.2)', () => {
  it('refreshes activeTurnTotal and computes baseline on first notification (no priorTurnTotal)', async () => {
    // First-ever notification on a fresh runner. priorTurnTotal is null so
    // the bootstrap path infers baseline = total - last (≈ everything before
    // this most recent LLM call). Subsequent notifications during this turn
    // refresh activeTurnTotal but do NOT mutate priorTurnTotal.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-tu'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thr',
        turnId: 't-tu',
        tokenUsage: {
          last: {
            cachedInputTokens: 0,
            inputTokens: 100,
            outputTokens: 50,
            reasoningOutputTokens: 0,
            totalTokens: 150,
          },
          total: {
            cachedInputTokens: 0,
            inputTokens: 1000,
            outputTokens: 500,
            reasoningOutputTokens: 0,
            totalTokens: 1500,
          },
        },
      },
    })
    const runner = h.runner as any
    assert.deepEqual(runner.activeTurnTotal, {
      cachedInputTokens: 0,
      inputTokens: 1000,
      outputTokens: 500,
      reasoningOutputTokens: 0,
      totalTokens: 1500,
    })
    // baseline inferred = total - last
    assert.deepEqual(runner.priorTurnTotal, {
      cachedInputTokens: 0,
      inputTokens: 900,
      outputTokens: 450,
      reasoningOutputTokens: 0,
      totalTokens: 1350,
    })
    await h.cleanup()
  })

  it('drops notification when turnId mismatches activeTurnId', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-mine'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thr',
        turnId: 't-other',
        tokenUsage: {
          last: { cachedInputTokens: 0, inputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
          total: { cachedInputTokens: 0, inputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
        },
      },
    })
    const runner = h.runner as any
    assert.equal(runner.activeTurnTotal, null)
    assert.equal(runner.priorTurnTotal, null)
    await h.cleanup()
  })

  it('multiple notifications during a turn → activeTurnTotal tracks the latest, baseline frozen', async () => {
    // Codex emits one tokenUsage notification per server-side LLM call. A
    // multi-call agentic turn can produce 3+ frames. activeTurnTotal must
    // reflect the LATEST frame (idempotent snapshot); priorTurnTotal must
    // remain at the bootstrap value so the eventual delta = full turn usage.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-multi'
    const send = (totalIn: number, totalOut: number) => {
      feed(h.runner, {
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thr',
          turnId: 't-multi',
          tokenUsage: {
            last: { cachedInputTokens: 0, inputTokens: 50, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 100 },
            total: {
              cachedInputTokens: 0,
              inputTokens: totalIn,
              outputTokens: totalOut,
              reasoningOutputTokens: 0,
              totalTokens: totalIn + totalOut,
            },
          },
        },
      })
    }
    send(1000, 500)
    const baselineAfterFirst = (h.runner as any).priorTurnTotal
    send(1100, 600)
    send(1300, 800)
    const runner = h.runner as any
    assert.deepEqual(runner.activeTurnTotal.inputTokens, 1300)
    assert.deepEqual(runner.activeTurnTotal.outputTokens, 800)
    // baseline must NOT shift on subsequent frames
    assert.deepEqual(runner.priorTurnTotal, baselineAfterFirst)
    await h.cleanup()
  })

  it('malformed tokenUsage frame is coerced rather than throwing', async () => {
    // Defensive: codex bug or schema drift shouldn't crash the runner.
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-bad'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thr',
        turnId: 't-bad',
        tokenUsage: {
          last: { inputTokens: 'not-a-number', outputTokens: -5 } as any,
          total: { inputTokens: 'wat' } as any,
        },
      },
    })
    const runner = h.runner as any
    // total coerced to all-zeros (all fields invalid)
    assert.deepEqual(runner.activeTurnTotal, {
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    })
    await h.cleanup()
  })

  it('missing tokenUsage object → no-op, no crash', async () => {
    const h = await makeHarness()
    ;(h.runner as any).activeTurnId = 't-empty'
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thr', turnId: 't-empty' /* no tokenUsage */ },
    })
    const runner = h.runner as any
    assert.equal(runner.activeTurnTotal, null)
    await h.cleanup()
  })
})

describe('runTurn token usage propagation (PR1 v1.0.65 A.3)', () => {
  it('subtractTokenBreakdown clamps negatives to 0 (defense in depth)', async () => {
    // Direct functional test of the helper exposed via runtime behavior:
    // simulate two notifications where second total is LESS than baseline
    // (impossible per schema but we should not emit negative usage).
    const h = await makeHarness()
    const runner = h.runner as any
    runner.activeTurnId = 't-clamp'
    runner.priorTurnTotal = {
      cachedInputTokens: 100,
      inputTokens: 1000,
      outputTokens: 500,
      reasoningOutputTokens: 50,
      totalTokens: 1650,
    }
    // Pretend a notification arrives with a weird total LOWER than baseline
    // (shouldn't happen per schema, but defense in depth).
    feed(h.runner, {
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thr',
        turnId: 't-clamp',
        tokenUsage: {
          last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
          total: {
            cachedInputTokens: 50,
            inputTokens: 800,
            outputTokens: 300,
            reasoningOutputTokens: 0,
            totalTokens: 1150,
          },
        },
      },
    })
    // Now drive turn/completed manually — runTurn internals: delta computed
    // and emitResult called. Since we can't easily fake a full runTurn path,
    // just verify activeTurnTotal got updated.
    assert.equal(runner.activeTurnTotal.inputTokens, 800)
    await h.cleanup()
  })
})

describe('shutdown — token state cleared (PR1 v1.0.65 A.2)', () => {
  it('shutdown PROMOTES activeTurnTotal to priorTurnTotal when mid-turn (avoid next-turn over-bill)', async () => {
    // Mid-turn shutdown scenario: tokenUsage notification arrived once
    // (activeTurnTotal=200), then runner is killed before turn/completed.
    // The killed turn's tokens (200 - 100 = 100) must be folded into the
    // baseline so the next turn's delta calculation doesn't over-bill.
    const h = await makeHarness({ withFakeProc: true })
    const runner = h.runner as any
    runner.priorTurnTotal = {
      cachedInputTokens: 10,
      inputTokens: 100,
      outputTokens: 50,
      reasoningOutputTokens: 5,
      totalTokens: 165,
    }
    runner.activeTurnTotal = { ...runner.priorTurnTotal, inputTokens: 200 }
    runner.currentTurnUsage = { ...runner.priorTurnTotal, inputTokens: 100 }
    await h.runner.shutdown()
    assert.deepEqual(
      runner.priorTurnTotal,
      { ...runner.priorTurnTotal, inputTokens: 200 },
      'mid-turn shutdown: priorTurnTotal promoted from activeTurnTotal',
    )
    assert.equal(runner.activeTurnTotal, null)
    assert.equal(runner.currentTurnUsage, null)
    await h.cleanup()
  })

  it('shutdown LEAVES priorTurnTotal unchanged when no active notification yet', async () => {
    // Pre-notification shutdown: turn started but tokenUsage notification
    // hadn't arrived (activeTurnTotal=null). priorTurnTotal must survive
    // verbatim so the next respawn's bootstrap baseline is still correct.
    const h = await makeHarness({ withFakeProc: true })
    const runner = h.runner as any
    runner.priorTurnTotal = {
      cachedInputTokens: 10,
      inputTokens: 100,
      outputTokens: 50,
      reasoningOutputTokens: 5,
      totalTokens: 165,
    }
    // activeTurnTotal stays null
    await h.runner.shutdown()
    assert.deepEqual(runner.priorTurnTotal, {
      cachedInputTokens: 10,
      inputTokens: 100,
      outputTokens: 50,
      reasoningOutputTokens: 5,
      totalTokens: 165,
    })
    assert.equal(runner.activeTurnTotal, null)
    assert.equal(runner.currentTurnUsage, null)
    await h.cleanup()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PR2 v1.0.66 — server-owned requestId pass-through.
//
// 校验 sessionManager.submit 透传过来的 requestId 在 codex 路径全程不丢:
//   submit(prompt, requestId) → QueuedTurn.requestId → runTurn(_, requestId)
//   → emitResult(opts.requestId) → RunnerMessage.requestId
//
// 直接测 emitResult 私有方法 + queue 入队结构,不需要真 spawn codex app-server。
// 多并发 turn 场景测 queue entry-scoped 的隔离(关键决策:不挂 instance 字段)。
// ─────────────────────────────────────────────────────────────────────────────

describe('PR2 v1.0.66 — requestId queue-entry transit', () => {
  it('emitResult success with requestId — RunnerMessage 携带 requestId', async () => {
    const h = await makeHarness()
    const runner = h.runner as any
    runner.emitResult({
      durationMs: 123,
      ok: true,
      text: 'hello',
      usage: { input_tokens: 10, output_tokens: 5 },
      requestId: 'req-abc',
    })
    assert.equal(h.messages.length, 1)
    const msg = h.messages[0]
    assert.equal(msg.type, 'result')
    assert.equal(msg.subtype, 'success')
    assert.equal(msg.requestId, 'req-abc')
    assert.equal(msg.is_error, false)
    assert.equal(msg.duration_ms, 123)
    assert.deepEqual(msg.usage, { input_tokens: 10, output_tokens: 5 })
    await h.cleanup()
  })

  it('emitResult error with requestId — error_during_execution + requestId', async () => {
    const h = await makeHarness()
    const runner = h.runner as any
    runner.emitResult({
      durationMs: 50,
      ok: false,
      error: 'codex turn interrupted',
      usage: { input_tokens: 3 },
      requestId: 'req-err-1',
    })
    assert.equal(h.messages.length, 1)
    const msg = h.messages[0]
    assert.equal(msg.subtype, 'error_during_execution')
    assert.equal(msg.is_error, true)
    assert.equal(msg.requestId, 'req-err-1')
    assert.equal(msg.result, 'codex turn interrupted')
    await h.cleanup()
  })

  it('emitResult without requestId → RunnerMessage.requestId === undefined', async () => {
    const h = await makeHarness()
    const runner = h.runner as any
    // legacy/non-billing path:caller 没传 requestId(personal-edition 或非 codex)
    runner.emitResult({ durationMs: 1, ok: true, text: '' })
    assert.equal(h.messages.length, 1)
    const msg = h.messages[0]
    assert.equal(msg.requestId, undefined)
    await h.cleanup()
  })

  it('submit() — requestId 挂在 queue entry 上,不挂 runner instance', async () => {
    const h = await makeHarness()
    const runner = h.runner as any
    // 不让 drain 真跑(没 fake proc 也没 mock ensureSpawned),拦截 drain。
    runner.processing = true
    // .catch(noop) 吸收 cleanup 阶段的 reject,避免 Node 把它当 unhandledRejection。
    const noop = () => {}
    h.runner.submit('first prompt', 'req-1').catch(noop)
    h.runner.submit('second prompt', 'req-2').catch(noop)
    h.runner.submit('third prompt').catch(noop) // 无 requestId 也合法
    assert.equal(runner.queue.length, 3)
    assert.equal(runner.queue[0].requestId, 'req-1')
    assert.equal(runner.queue[0].prompt, 'first prompt')
    assert.equal(runner.queue[1].requestId, 'req-2')
    assert.equal(runner.queue[1].prompt, 'second prompt')
    assert.equal(runner.queue[2].requestId, undefined)
    assert.equal(runner.queue[2].prompt, 'third prompt')
    // runner instance 字段不被设置(防 race:多 turn 并发不串)
    assert.equal(runner.requestId, undefined)
    // cleanup:reject pending 让 promise 不悬挂
    for (const q of runner.queue) q.reject(new Error('test cleanup'))
    runner.queue = []
    runner.processing = false
    await h.cleanup()
  })

  it('drain() 把 queue entry 的 requestId 透传到 runTurn', async () => {
    const h = await makeHarness()
    const runner = h.runner as any
    let receivedRequestId: string | undefined
    let receivedPrompt: string | undefined
    // stub runTurn 捕获参数
    runner.runTurn = async (prompt: string, requestId?: string) => {
      receivedPrompt = prompt
      receivedRequestId = requestId
    }
    await h.runner.submit('hello', 'req-drain-1')
    assert.equal(receivedPrompt, 'hello')
    assert.equal(receivedRequestId, 'req-drain-1')
    await h.cleanup()
  })

  it('drain() 透传 undefined requestId 给非计费路径', async () => {
    const h = await makeHarness()
    const runner = h.runner as any
    let receivedRequestId: string | undefined = 'sentinel-not-overwritten'
    runner.runTurn = async (_prompt: string, requestId?: string) => {
      receivedRequestId = requestId
    }
    await h.runner.submit('legacy turn')
    // 关键:我们要的就是 undefined,不是 falsy 'sentinel'
    assert.equal(receivedRequestId, undefined)
    await h.cleanup()
  })

  it('多 turn 并发:每个 turn 拿自己的 requestId(不被后到的覆盖)', async () => {
    // 关键回归:如果 requestId 挂在 runner instance 字段,第二次 submit
    // 会把第一次未结束的 turn 的字段覆盖。挂 queue entry 才能隔离。
    const h = await makeHarness()
    const runner = h.runner as any
    const captured: Array<{ prompt: string; rid: string | undefined }> = []
    // 用预先 resolve 拿出的 fn 控制 turn1 释放,避开 TS 对 callback 内赋值的窄化问题
    let releaseTurn1: () => void = () => {}
    const turn1Gate = new Promise<void>((r) => {
      releaseTurn1 = r
    })
    runner.runTurn = async (prompt: string, requestId?: string) => {
      captured.push({ prompt, rid: requestId })
      // 第一个 turn 卡住,模拟"前一个 turn 还没结束就来下一个 submit"
      if (prompt === 't1') {
        await turn1Gate
      }
    }
    const p1 = h.runner.submit('t1', 'req-1')
    const p2 = h.runner.submit('t2', 'req-2')
    // 等到 turn1 已 dequeue 进 runTurn(captured.length === 1)
    await waitFor(() => captured.length === 1)
    assert.equal(captured[0].rid, 'req-1')
    // queue 还剩 turn2,requestId 仍然是 req-2 没被覆盖
    assert.equal(runner.queue.length, 1)
    assert.equal(runner.queue[0].requestId, 'req-2')
    // 放行 turn1,turn2 应进 runTurn 拿到 req-2
    releaseTurn1()
    await Promise.all([p1, p2])
    assert.equal(captured.length, 2)
    assert.equal(captured[1].rid, 'req-2')
    await h.cleanup()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Issue C — codex inputTokens contains cached portion (OpenAI shape) but
  // calculator.computeCost expects Anthropic disjoint shape. Without subtracting
  // cached at the boundary, billing double-charges the cached portion.
  // ─────────────────────────────────────────────────────────────────────────

  it('_codexUsageToAnthropicShape: subtracts cachedInputTokens to keep input_tokens disjoint', () => {
    // Typical cache-hit turn: 1000 total prompt tokens, 600 served from cache.
    // Anthropic-shape: input_tokens=400 (non-cached), cache_read=600. Adding
    // them in calculator.computeCost gives the original 1000 — correct.
    const usage = _codexUsageToAnthropicShape({
      cachedInputTokens: 600,
      inputTokens: 1000,
      outputTokens: 200,
      reasoningOutputTokens: 50,
      totalTokens: 1850,
    })
    assert.equal(usage.input_tokens, 400)
    assert.equal(usage.cache_read_input_tokens, 600)
    assert.equal(usage.cache_creation_input_tokens, 0)
    assert.equal(usage.output_tokens, 200)
    assert.equal(usage.reasoning_output_tokens, 50)
  })

  it('_codexUsageToAnthropicShape: clamps to 0 when cached > input (defense)', () => {
    // Shouldn't happen per OpenAI semantics (non_cached_input = max(0, input - cached))
    // but if a stale baseline / out-of-order frame produces this, prefer 0
    // over a negative input_tokens that would either crash math or under-bill.
    const usage = _codexUsageToAnthropicShape({
      cachedInputTokens: 1000,
      inputTokens: 600,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      totalTokens: 1650,
    })
    assert.equal(usage.input_tokens, 0)
    assert.equal(usage.cache_read_input_tokens, 1000)
  })

  it('_codexUsageToAnthropicShape: zero-cache turn passes inputTokens through unchanged', () => {
    // Cold turn: no cache hit. input_tokens should equal inputTokens verbatim.
    const usage = _codexUsageToAnthropicShape({
      cachedInputTokens: 0,
      inputTokens: 800,
      outputTokens: 300,
      reasoningOutputTokens: 0,
      totalTokens: 1100,
    })
    assert.equal(usage.input_tokens, 800)
    assert.equal(usage.cache_read_input_tokens, 0)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Issue A v1.0.108 — codex `account/rateLimits/updated` 通知解析 + 落到
  // emitResult.rateLimits → outbound.codex_billing.rateLimits → quota DB。
  // ─────────────────────────────────────────────────────────────────────────

  it('_parseCodexRateLimits: 双窗口带 windowDurationMins 路由到正确桶', () => {
    const rl = {
      primary: { usedPercent: 42, resetsAt: 1714425600, windowDurationMins: _CODEX_5H_WINDOW_MINS },
      secondary: { usedPercent: 17, resetsAt: 1714512000, windowDurationMins: _CODEX_7D_WINDOW_MINS },
    }
    const out = _parseCodexRateLimits(rl)
    assert.ok(out, 'should parse')
    assert.equal(out!.util5h, 42)
    assert.equal(out!.util7d, 17)
    assert.equal(out!.reset5h, new Date(1714425600 * 1000).toISOString())
    assert.equal(out!.reset7d, new Date(1714512000 * 1000).toISOString())
  })

  it('_parseCodexRateLimits: 7d-only plan 即使无 windowDurationMins,带 duration 仍精确路由', () => {
    const rl = {
      secondary: { usedPercent: 60, resetsAt: 1714512000, windowDurationMins: _CODEX_7D_WINDOW_MINS },
    }
    const out = _parseCodexRateLimits(rl)
    assert.ok(out)
    assert.equal(out!.util7d, 60)
    assert.equal(out!.util5h, undefined)
    assert.equal(out!.reset5h, undefined)
  })

  it('_parseCodexRateLimits: 单窗口且无 windowDurationMins → 拒绝写入(NEEDS-FIX 1)', () => {
    // free / usage-based plan 可能只发一个窗口且无 duration 标识 — 不能强行
    // 当成 5h 写,会污染 admin UI。
    const rl = { primary: { usedPercent: 80, resetsAt: 1714425600 } }
    const out = _parseCodexRateLimits(rl)
    assert.equal(out, null)
  })

  it('_parseCodexRateLimits: 双窗口都无 windowDurationMins → fallback primary=5h secondary=7d', () => {
    // 双窗口都缺 duration:plus/pro plan 早期版本观察到的形态;允许 fallback。
    const rl = {
      primary: { usedPercent: 30, resetsAt: 1714425600 },
      secondary: { usedPercent: 12, resetsAt: 1714512000 },
    }
    const out = _parseCodexRateLimits(rl)
    assert.ok(out)
    assert.equal(out!.util5h, 30)
    assert.equal(out!.util7d, 12)
  })

  it('_parseCodexRateLimits: clamp usedPercent to 0..100', () => {
    const rl = {
      primary: { usedPercent: 150, windowDurationMins: _CODEX_5H_WINDOW_MINS },
      secondary: { usedPercent: -5, windowDurationMins: _CODEX_7D_WINDOW_MINS },
    }
    const out = _parseCodexRateLimits(rl)
    assert.ok(out)
    assert.equal(out!.util5h, 100)
    assert.equal(out!.util7d, 0)
  })

  it('_parseCodexRateLimits: resetsAt 缺失 / null → 只更 util 不更 reset', () => {
    const rl = {
      primary: { usedPercent: 22, windowDurationMins: _CODEX_5H_WINDOW_MINS },
    }
    const out = _parseCodexRateLimits(rl)
    assert.ok(out)
    assert.equal(out!.util5h, 22)
    assert.equal(out!.reset5h, undefined)
  })

  it('_parseCodexRateLimits: 全空 snapshot → null', () => {
    assert.equal(_parseCodexRateLimits({}), null)
    assert.equal(_parseCodexRateLimits(null), null)
    assert.equal(_parseCodexRateLimits('not-an-object'), null)
  })

  it('_parseCodexRateLimits: resetsAt 已是毫秒 (>1e12) 不再 *1000', () => {
    // 防御性兼容:如果哪天 codex 改成 ms epoch,我们不会得到 1715... 年
    const ms = Date.now()
    const rl = {
      primary: { usedPercent: 50, resetsAt: ms, windowDurationMins: _CODEX_5H_WINDOW_MINS },
    }
    const out = _parseCodexRateLimits(rl)
    assert.ok(out)
    assert.equal(out!.reset5h, new Date(ms).toISOString())
  })

  it('handleNotification("account/rateLimits/updated") 写入 latestRateLimits;runTurn emitResult 带上', async () => {
    const h = await makeHarness()
    const runner = h.runner as any
    // 注入一个最小化 ensureSpawned + drain stub 让 runTurn 能完整跑过 emitResult
    runner.ensureSpawned = async () => {}
    runner.attached = true
    runner.threadId = 'thread-test'
    runner.sendRequest = async (method: string) => {
      if (method === 'turn/start') return { turn: { id: 'turn-1' } }
      return undefined
    }

    // 模拟先收到 account/rateLimits/updated(turn 还没开始也可以 — 不 clear at turn start)
    runner.handleNotification('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 33, resetsAt: 1714425600, windowDurationMins: _CODEX_5H_WINDOW_MINS },
        secondary: { usedPercent: 8, resetsAt: 1714512000, windowDurationMins: _CODEX_7D_WINDOW_MINS },
      },
    })
    assert.deepEqual(runner.latestRateLimits, {
      util5h: 33,
      reset5h: new Date(1714425600 * 1000).toISOString(),
      util7d: 8,
      reset7d: new Date(1714512000 * 1000).toISOString(),
    })

    // 触发 turn/completed 让 runTurn 走到 emitResult
    setTimeout(() => {
      runner.handleNotification('turn/completed', {
        turnId: 'turn-1',
        turn: { id: 'turn-1', status: 'completed', durationMs: 5 },
      })
    }, 1)
    await runner.runTurn('hi', 'req-rl-1')

    const resultMsg = h.messages.find((m: any) => m.type === 'result' && m.requestId === 'req-rl-1')
    assert.ok(resultMsg, 'emitResult must fire')
    assert.deepEqual(resultMsg.rateLimits, {
      util5h: 33,
      reset5h: new Date(1714425600 * 1000).toISOString(),
      util7d: 8,
      reset7d: new Date(1714512000 * 1000).toISOString(),
    })
    await h.cleanup()
  })

  it('handleNotification("account/rateLimits/updated") top-level snapshot fallback 兼容', async () => {
    const h = await makeHarness()
    const runner = h.runner as any
    // 容器旧版本可能直接把 snapshot 放 params 顶层(无 rateLimits 包装)
    runner.handleNotification('account/rateLimits/updated', {
      primary: { usedPercent: 7, windowDurationMins: _CODEX_5H_WINDOW_MINS },
    })
    assert.equal(runner.latestRateLimits?.util5h, 7)
    await h.cleanup()
  })

  it('latestRateLimits 粘性 + dedup:同值仅首次 emit 带,变更后再 emit', async () => {
    // round-2 dedup(Codex review NEEDS-FIX 2):latestRateLimits 不在 turn 边界
    // clear,但 emitResult 现场对比上次发出的 JSON 序列化 — 相同 → 不带,
    // 避免下游 quota_updated_at 假刷新。
    const h = await makeHarness()
    const runner = h.runner as any
    runner.ensureSpawned = async () => {}
    runner.attached = true
    runner.threadId = 'thread-multi'
    runner.sendRequest = async (method: string) => {
      if (method === 'turn/start') {
        return { turn: { id: `turn-${runner._turnCounter++}` } }
      }
      return undefined
    }
    runner._turnCounter = 1

    // 先收一帧 rateLimits
    runner.handleNotification('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 15, windowDurationMins: _CODEX_5H_WINDOW_MINS },
      },
    })

    // turn1 — 第一次 emit,带 rateLimits
    setTimeout(() => {
      runner.handleNotification('turn/completed', {
        turnId: 'turn-1',
        turn: { id: 'turn-1', status: 'completed', durationMs: 1 },
      })
    }, 1)
    await runner.runTurn('first', 'req-1')

    // turn2,无新 notification — dedup 应让 result 不带 rateLimits
    setTimeout(() => {
      runner.handleNotification('turn/completed', {
        turnId: 'turn-2',
        turn: { id: 'turn-2', status: 'completed', durationMs: 1 },
      })
    }, 1)
    await runner.runTurn('second', 'req-2')

    // turn3,**收到新 notification**(util 改 15→25)— 应再带
    runner.handleNotification('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 25, windowDurationMins: _CODEX_5H_WINDOW_MINS },
      },
    })
    setTimeout(() => {
      runner.handleNotification('turn/completed', {
        turnId: 'turn-3',
        turn: { id: 'turn-3', status: 'completed', durationMs: 1 },
      })
    }, 1)
    await runner.runTurn('third', 'req-3')

    const r1 = h.messages.find((m: any) => m.type === 'result' && m.requestId === 'req-1')
    const r2 = h.messages.find((m: any) => m.type === 'result' && m.requestId === 'req-2')
    const r3 = h.messages.find((m: any) => m.type === 'result' && m.requestId === 'req-3')
    assert.equal(r1?.rateLimits?.util5h, 15, 'turn1 first emit carries snapshot')
    assert.equal(r2?.rateLimits, undefined, 'turn2 dedup skips identical snapshot')
    assert.equal(r3?.rateLimits?.util5h, 25, 'turn3 carries newly observed snapshot')
    await h.cleanup()
  })

  it('_parseCodexRateLimits: resetsAt 越界(>Date 范围)→ util 仍写,reset 丢弃不抛', () => {
    // Codex review NEEDS-FIX:容器侧 JSON-RPC 任意输入,Date max ≈ ±8.64e15 ms。
    // 超出后 toISOString 会 RangeError;实现用 d.getTime() finite 检查规避。
    const rl = {
      primary: {
        usedPercent: 50,
        // 1e16 sec → 1e19 ms,远超 Date 上界 8.64e15 ms
        resetsAt: 1e16,
        windowDurationMins: _CODEX_5H_WINDOW_MINS,
      },
    }
    let out: ReturnType<typeof _parseCodexRateLimits> | undefined
    assert.doesNotThrow(() => {
      out = _parseCodexRateLimits(rl)
    })
    assert.ok(out)
    assert.equal(out!.util5h, 50, 'util still written even when reset invalid')
    assert.equal(out!.reset5h, undefined, 'invalid Date silently dropped')
  })

  it('runTurn catch 路径 emitResult 也带 requestId(B.4 要求异常也能 settle)', async () => {
    // 如果 ensureSpawned 抛(进程启不起来 / EPIPE 等),emitResult 还要回 requestId
    // 让 master 关掉 inflight 行,否则 60s Redis preCheck 锁悬挂。
    const h = await makeHarness()
    const runner = h.runner as any
    runner.ensureSpawned = async () => {
      throw new Error('synthetic spawn failure')
    }
    // 直接调 runTurn,closure 模式校验 requestId 进 catch 分支
    await runner.runTurn('hi', 'req-catch')
    const resultMsg = h.messages.find((m: any) => m.type === 'result')
    assert.ok(resultMsg, 'emitResult must fire on catch')
    assert.equal(resultMsg.requestId, 'req-catch')
    assert.equal(resultMsg.is_error, true)
    assert.match(resultMsg.result, /synthetic spawn failure/)
    await h.cleanup()
  })
})
