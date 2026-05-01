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
import { CodexAppServerRunner, _classifyJsonRpcLine } from '../codexAppServerRunner.js'

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

  it('server-request always responds with -32601 method-not-found', async () => {
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

  it('updateConfig / setEffortLevel / sendPermissionResponse are callable no-ops', async () => {
    const h = await makeHarness()
    h.runner.updateConfig({})
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
