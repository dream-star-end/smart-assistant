import * as assert from 'node:assert/strict'
/**
 * CodexAppServerRunner — turn/start 窄路径自动重试 + 错误结构化(turn-retry 批,
 * 2026-07-18)。runner 层直驱 runTurn(override ensureSpawned/sendRequest/
 * computeRetryDelayMs),断言:
 *   - failed 分支不再注入 `[turn failed:]` text_delta,改带结构化 errorClass;
 *   - 仅 turn/start 请求被 JSON-RPC application error 拒 + retryable 语义 + 台账
 *     全清时才重试(初始执行 + 最多 10 次),retrying 状态帧发射并随后被 null 清除;
 *   - 台账 flag 置位 / transport 形状错误 / pendingUserInputs 非空 / status=
 *     'failed' 一律**不**重试(fail-closed);
 *   - 退避期间 interrupt() → USER_CANCELLED 终态 + 无第二次 turn/start + status null。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/codexTurnRetry.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { classifyRunError } from '../errorClassify.js'
import { CodexAppServerRunner } from '../engine/codexAppServerRunner.js'

interface RetryHarness {
  runner: CodexAppServerRunner
  // biome-ignore lint/suspicious/noExplicitAny: white-box drive of private surface
  r: any
  // biome-ignore lint/suspicious/noExplicitAny: fake-SDK message capture
  messages: any[]
  cleanup: () => Promise<void>
}

async function makeRetryHarness(opts: { delayMs?: number } = {}): Promise<RetryHarness> {
  const baseTmp = await mkdtemp(join(tmpdir(), 'codex-retry-'))
  const runner = new CodexAppServerRunner({ sessionKey: 'test', agentId: 'test', cwd: baseTmp })
  // biome-ignore lint/suspicious/noExplicitAny: capture emitted fake-SDK messages
  const messages: any[] = []
  // biome-ignore lint/suspicious/noExplicitAny: message payloads are heterogeneous
  runner.on('message', (m: any) => messages.push(m))
  runner.on('error', () => {}) // avoid EventEmitter throwing on stray 'error'
  // biome-ignore lint/suspicious/noExplicitAny: white-box override of private methods
  const r = runner as any
  r.ensureSpawned = async () => {
    // Alive proc with a harmless stdin so any writeRaw (settle paths) is a no-op.
    r.proc = { killed: false, stdin: { write: () => true } }
    r.initialized = true
    r.attached = true
    r.spawnedProviderSignature = r.codexRouteSignature()
  }
  r.computeRetryDelayMs = () => opts.delayMs ?? 5
  return { runner, r, messages, cleanup: () => rm(baseTmp, { recursive: true, force: true }) }
}

/** Build a codex-shaped JSON-RPC application error (has rpcCode/rpcMessage/rpcMethod
 *  — the exact shape sendRequest rejects with on a codex error frame). */
function jsonRpcAppError(message: string, code = -32010): Error {
  return Object.assign(new Error(`turn/start -> ${code}: ${message}`), {
    rpcCode: code,
    rpcMessage: message,
    rpcMethod: 'turn/start',
  })
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((res) => setTimeout(res, 5))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

// biome-ignore lint/suspicious/noExplicitAny: message filter helpers
const results = (msgs: any[]) => msgs.filter((m) => m.type === 'result')
// biome-ignore lint/suspicious/noExplicitAny: message filter helpers
const statusFrames = (msgs: any[]) =>
  msgs.filter((m) => m.type === 'system' && m.subtype === 'status')

describe('runTurn — failed 分支结构化(无裸文本注入)', () => {
  it('status=failed:不发 [turn failed] text_delta,result 带 errorClass(capacity→model_capacity)', async () => {
    const h = await makeRetryHarness()
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      setImmediate(() => {
        h.r.currentTurnCompleter?.resolve({
          status: 'failed',
          durationMs: 2,
          error: { message: 'the model is at capacity right now', codexErrorInfo: 'other' },
        })
      })
      return { turn: { id: 't-failed-1' } }
    }
    await h.r.runTurn('hi', 'req-failed')

    assert.equal(turnStarts, 1)
    // 无裸文本注入:任何 stream_event 都不含 "[turn failed"。
    assert.ok(
      !h.messages.some((m) => JSON.stringify(m).includes('[turn failed')),
      'must not inject [turn failed] text_delta',
    )
    const res = results(h.messages)
    assert.equal(res.length, 1)
    assert.equal(res[0].is_error, true)
    assert.equal(res[0].errorClass, 'model_capacity')
    assert.equal(res[0].errorClass, classifyRunError('the model is at capacity right now').code)
    // failed(非 turn/start 拒)不触发 retrying 侧信道。
    assert.equal(statusFrames(h.messages).length, 0)
    await h.cleanup()
  })

  it('status=failed 且错误不可分类(unknown)→ 不带 errorClass 字段', async () => {
    const h = await makeRetryHarness()
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      setImmediate(() => {
        h.r.currentTurnCompleter?.resolve({
          status: 'failed',
          durationMs: 1,
          error: { message: 'some weird internal failure with no known code' },
        })
      })
      return { turn: { id: 't-failed-2' } }
    }
    await h.r.runTurn('hi', 'req-failed-unknown')
    const res = results(h.messages)
    assert.equal(res.length, 1)
    assert.equal(res[0].is_error, true)
    assert.equal('errorClass' in res[0], false)
    await h.cleanup()
  })
})

describe('runTurn — turn/start 窄路径自动重试', () => {
  it('第一次 JSON-RPC application error(capacity)第二次成功 → retry=1/10,恰好一个 result,retrying 帧发射且被 null 清除', async () => {
    const h = await makeRetryHarness({ delayMs: 5 })
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      if (turnStarts === 1) throw jsonRpcAppError('the model is at capacity, retry later')
      setImmediate(() => {
        h.r.currentTurnCompleter?.resolve({ status: 'completed', durationMs: 3 })
      })
      return { turn: { id: 't-retry-2' } }
    }
    const t0 = Date.now()
    await h.r.runTurn('hi', 'req-retry')

    assert.equal(turnStarts, 2, 'exactly two turn/start attempts')
    const res = results(h.messages)
    assert.equal(res.length, 1, 'exactly one terminal result frame for the whole turn')
    assert.equal(res[0].is_error, false)
    assert.equal(res[0].requestId, 'req-retry')
    // 初始执行是 0；第一次额外执行是 retrying(1/10)。
    const st = statusFrames(h.messages)
    assert.equal(st.length, 2)
    assert.equal(st[0].status, 'retrying')
    assert.equal(st[0].retry.attempt, 1)
    assert.equal(st[0].retry.max, 10)
    assert.equal(st[0].retry.delayMs, 5)
    assert.ok(st[0].retry.retryAt >= t0, 'retryAt is an absolute epoch ms in the future')
    assert.equal(st[1].status, null)
    // retrying 帧必须在 result 之前(重试排定 → 退避 → 下一 attempt → 成功 result)。
    assert.ok(
      h.messages.indexOf(st[0]) < h.messages.indexOf(res[0]),
      'retrying status precedes the terminal result',
    )
    await h.cleanup()
  })

  it('从浏览器恢复 attempt=4 继续共享预算，底座下一次重试显示 5/10', async () => {
    const h = await makeRetryHarness({ delayMs: 1 })
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      if (turnStarts === 1) throw jsonRpcAppError('the model is at capacity, retry later')
      setImmediate(() => {
        h.r.currentTurnCompleter?.resolve({ status: 'completed', durationMs: 1 })
      })
      return { turn: { id: 't-shared-retry' } }
    }
    const shared = { rootClientMessageId: 'cm-root', attempt: 4, max: 10 }
    await h.r.runTurn('hi', 'req-shared-retry', undefined, shared)

    assert.equal(shared.attempt, 5)
    assert.equal(turnStarts, 2)
    const st = statusFrames(h.messages)
    assert.equal(st[0].status, 'retrying')
    assert.deepEqual(st[0].retry, {
      attempt: 5,
      max: 10,
      delayMs: 1,
      retryAt: st[0].retry.retryAt,
    })
    assert.equal(st[1].status, null)
    await h.cleanup()
  })

  it('连续 capacity 拒 → 初始执行加 10 次自动重试后终态', async () => {
    const h = await makeRetryHarness({ delayMs: 2 })
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      throw jsonRpcAppError('server overloaded, at capacity')
    }
    await h.r.runTurn('hi', 'req-exhaust')
    assert.equal(turnStarts, 11, '11 attempts total (initial + 10 retries)')
    const res = results(h.messages)
    assert.equal(res.length, 1)
    assert.equal(res[0].is_error, true)
    // 十次重试 → 十组 (retrying, null) 状态帧。
    const st = statusFrames(h.messages)
    assert.equal(st.length, 20)
    assert.deepEqual(
      st.map((s) => (s.status === 'retrying' ? s.retry.attempt : s.status)),
      Array.from({ length: 10 }, (_, index) => [index + 1, null]).flat(),
    )
    await h.cleanup()
  })
})

describe('runTurn — 重试门(fail-closed)', () => {
  it('台账 flag 置位(已 emit tool_use)→ 不重试,直接终态', async () => {
    const h = await makeRetryHarness()
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      // 先越过一个对外 emit 边界(tool_use)再让 turn/start 失败。
      h.r.emitAssistantToolUse('tool-x', 'Bash', {})
      throw jsonRpcAppError('at capacity')
    }
    await h.r.runTurn('hi', 'req-flag')
    assert.equal(turnStarts, 1, 'no retry once an observable/tool boundary was crossed')
    assert.equal(statusFrames(h.messages).length, 0, 'no retrying frame')
    const res = results(h.messages)
    assert.equal(res.length, 1)
    assert.equal(res[0].is_error, true)
    await h.cleanup()
  })

  it('transport 形状错误(无 rpcCode)→ 不重试', async () => {
    const h = await makeRetryHarness()
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      throw new Error('CodexAppServerRunner shutdown') // 裸 Error,无 rpc* 字段
    }
    await h.r.runTurn('hi', 'req-transport')
    assert.equal(turnStarts, 1, 'transport-shape reject is not an application error → no retry')
    assert.equal(statusFrames(h.messages).length, 0)
    assert.equal(results(h.messages).length, 1)
    await h.cleanup()
  })

  it('非 retryable 语义(insufficient_credits)→ 不重试', async () => {
    const h = await makeRetryHarness()
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      throw jsonRpcAppError('402 INSUFFICIENT_CREDITS: balance exhausted')
    }
    await h.r.runTurn('hi', 'req-credits')
    assert.equal(turnStarts, 1, 'insufficient_credits is not retryable → no retry')
    assert.equal(statusFrames(h.messages).length, 0)
    await h.cleanup()
  })

  it('pendingUserInputs 非空 → 不重试(fail closed,不静默清)', async () => {
    const h = await makeRetryHarness()
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      // 注入一个挂起的 reverse-request,违反重试门。
      h.r.pendingUserInputs.set('pu-1', {
        rpcId: 1,
        rpcKey: 'k1',
        turnId: 't',
        itemId: 'i',
        questions: [],
      })
      throw jsonRpcAppError('at capacity')
    }
    await h.r.runTurn('hi', 'req-pui')
    assert.equal(turnStarts, 1, 'pending reverse-request blocks the narrow-path retry')
    assert.ok(
      statusFrames(h.messages).every((frame) => frame.status !== 'retrying'),
      'settling the pending browser question may clear waiting state, but must not expose retrying',
    )
    await h.cleanup()
  })

  // 审计 R9 — 重试门逐维补齐。每维在 turn/start 被拒**之前**越过对应门条件,
  // 断言 fail-closed(仅一次 turn/start、无 retrying 侧信道、恰好一个 result)。
  it('可观测输出(先发 assistant delta)→ 不重试', async () => {
    const h = await makeRetryHarness()
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      // 走真实的 agentMessage delta 通知路径,置 attemptHadObservableOutput。
      h.r.handleNotification('item/agentMessage/delta', { delta: 'partial answer' })
      assert.equal(h.r.attemptHadObservableOutput, true, 'assistant delta 置可观测输出台账')
      throw jsonRpcAppError('at capacity')
    }
    await h.r.runTurn('hi', 'req-observable')
    assert.equal(turnStarts, 1, 'observable output blocks retry (重发会重复已展示内容)')
    assert.equal(statusFrames(h.messages).length, 0)
    assert.equal(results(h.messages).length, 1)
    await h.cleanup()
  })

  it('本 attempt usage 非零 → 不重试(已计费,重发会二次记账)', async () => {
    const h = await makeRetryHarness()
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      // 注入非零 usage delta(activeTurnTotal 非零、priorTurnTotal 缺省 → delta 非零)。
      h.r.activeTurnTotal = {
        cachedInputTokens: 0,
        inputTokens: 7,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 7,
      }
      assert.equal(h.r.activeAttemptUsageIsZero(), false, 'usage 门应判定非零')
      throw jsonRpcAppError('at capacity')
    }
    await h.r.runTurn('hi', 'req-usage')
    assert.equal(turnStarts, 1, 'non-zero usage blocks retry')
    assert.equal(statusFrames(h.messages).length, 0)
    await h.cleanup()
  })

  it('本 attempt 已 emit 终态帧(attemptEmittedTerminal)→ 不重试', async () => {
    const h = await makeRetryHarness()
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      // 模拟本 attempt 已发过 billing/result 终态帧(已记账,重发会二次 settle)。
      h.r.attemptEmittedTerminal = true
      throw jsonRpcAppError('at capacity')
    }
    await h.r.runTurn('hi', 'req-terminal')
    assert.equal(turnStarts, 1, 'a prior terminal frame this attempt blocks retry')
    assert.equal(statusFrames(h.messages).length, 0)
    await h.cleanup()
  })

  it('已 adopt turnId(reverse-RPC 先到)→ 不重试(activeTurnId 守卫)', async () => {
    const h = await makeRetryHarness()
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      // 模拟同 chunk 内 reverse-RPC 先于 turn/start resolve 已 adopt 了 turnId。
      h.r.activeTurnId = 't-adopted-early'
      throw jsonRpcAppError('at capacity')
    }
    await h.r.runTurn('hi', 'req-adopted')
    assert.equal(turnStarts, 1, 'an adopted turnId means the outcome is unknown → no retry')
    assert.equal(statusFrames(h.messages).length, 0)
    await h.cleanup()
  })

  it('R2:reverse-RPC 权限自动批准(先于 turn/start 拒到达)→ 记账 + adopt turnId + 不重试', async () => {
    const h = await makeRetryHarness()
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      // 走真实 handleLine 自动批准路径(命令审批 reverse-RPC,带 turnId)。
      h.r.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 501,
          method: 'item/commandExecution/requestApproval',
          params: { turnId: 't-approval-1', command: 'ls' },
        }),
      )
      // R2:写批准响应之前已单调置台账 + adopt turnId(双重 fail-closed)。
      assert.equal(h.r.attemptHadToolOrPermission, true, '自动批准即置权限台账 flag')
      assert.equal(h.r.activeTurnId, 't-approval-1', 'reverse-RPC turnId 已 adopt')
      throw jsonRpcAppError('at capacity')
    }
    await h.r.runTurn('hi', 'req-approval')
    assert.equal(turnStarts, 1, 'auto-approved permission side-effect blocks retry')
    assert.equal(statusFrames(h.messages).length, 0)
    // 批准响应确实写给了 codex(harness stdin no-op)。
    assert.equal(results(h.messages).length, 1)
    await h.cleanup()
  })
})

describe('runTurn — status=failed 永不自动重发 turn/start(实测②)', () => {
  it('failed 携带 capacity 语义(retryable)仍只发一次 turn/start', async () => {
    const h = await makeRetryHarness({ delayMs: 2 })
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      setImmediate(() => {
        h.r.currentTurnCompleter?.resolve({
          status: 'failed',
          durationMs: 2,
          error: { message: 'the model is at capacity' },
        })
      })
      return { turn: { id: 't-failed-noretry' } }
    }
    await h.r.runTurn('hi', 'req-failed-noretry')
    // turn/start 成功了,turn 才失败 → input 已落 thread → 绝不重发 turn/start。
    assert.equal(turnStarts, 1)
    assert.equal(statusFrames(h.messages).length, 0, 'failed turn does not emit retrying')
    const res = results(h.messages)
    assert.equal(res.length, 1)
    assert.equal(res[0].is_error, true)
    assert.equal(res[0].errorClass, 'model_capacity')
    await h.cleanup()
  })
})

describe('runTurn — 退避期间 interrupt()', () => {
  it('interrupt during backoff → 返回 true、USER_CANCELLED 终态、无第二次 turn/start、status 清 null', async () => {
    const h = await makeRetryHarness({ delayMs: 10_000 }) // 长退避,留出中断窗口
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      if (turnStarts === 1) throw jsonRpcAppError('at capacity')
      // 第二次不应发生
      setImmediate(() => h.r.currentTurnCompleter?.resolve({ status: 'completed' }))
      return { turn: { id: 't-should-not-happen' } }
    }
    const runPromise = h.r.runTurn('hi', 'req-interrupt')
    await waitFor(() => h.r.pendingRetryAbort !== null)
    const ok = h.runner.interrupt()
    assert.equal(ok, true, 'interrupt accepted during backoff (activeTurnId null but retry pending)')
    await runPromise

    assert.equal(turnStarts, 1, 'no second turn/start after interrupt')
    const res = results(h.messages)
    assert.equal(res.length, 1)
    assert.equal(res[0].is_error, true)
    assert.equal(res[0].billing_terminal_code, 'USER_CANCELLED')
    assert.equal(res[0].stop_reason, 'interrupted')
    // retrying 帧被 null 清除(退避 finally 保证)。
    const st = statusFrames(h.messages)
    assert.equal(st.length, 2)
    assert.equal(st[0].status, 'retrying')
    assert.equal(st[1].status, null)
    // pendingRetryAbort 已复位。
    assert.equal(h.r.pendingRetryAbort, null)
    await h.cleanup()
  })
})

describe('runTurn — proc 于退避期间消失(crash/shutdown)', () => {
  it('退避完成时 proc 已 null → 转终态,绝不把 turn/start 重发进死管道', async () => {
    const h = await makeRetryHarness({ delayMs: 20 })
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      if (turnStarts === 1) throw jsonRpcAppError('at capacity')
      // 第二次不应发生
      setImmediate(() => h.r.currentTurnCompleter?.resolve({ status: 'completed' }))
      return { turn: { id: 't-should-not-happen' } }
    }
    const runPromise = h.r.runTurn('hi', 'req-procgone')
    await waitFor(() => h.r.pendingRetryAbort !== null)
    // 模拟 proc close 期间 proc 被置 null(crash 路径 close handler 行为)。
    h.r.proc = null
    await runPromise // 退避自然睡满(20ms)→ proc-gone 门转终态
    assert.equal(turnStarts, 1, 'no turn/start re-send into a dead pipe')
    const res = results(h.messages)
    assert.equal(res.length, 1)
    assert.equal(res[0].is_error, true)
    await h.cleanup()
  })

  it('shutdown() 唤醒退避 → runTurn 转终态(不误报 USER_CANCELLED)', async () => {
    const h = await makeRetryHarness({ delayMs: 10_000 })
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      throw jsonRpcAppError('at capacity')
    }
    // 保持 proc 存活但触发 shuttingDown;不实际 kill(避免 close 异步竞态干扰断言)。
    const runPromise = h.r.runTurn('hi', 'req-shutdown-backoff')
    await waitFor(() => h.r.pendingRetryAbort !== null)
    h.r.shuttingDown = true
    h.r.pendingRetryAbort.abort()
    await runPromise
    assert.equal(turnStarts, 1)
    const res = results(h.messages)
    assert.equal(res.length, 1)
    assert.equal(res[0].is_error, true)
    // shutdown 路径不是用户取消 → 不带 USER_CANCELLED。
    assert.notEqual(res[0].billing_terminal_code, 'USER_CANCELLED')
    await h.cleanup()
  })

  // 审计 R8 — proc close/error 唤醒退避(proc-gone 立即转 crashed 终态)。
  it('R8:proc error(早于 close,proc 仍非 null)唤醒退避 → crashed 终态,不误判 USER_CANCELLED', async () => {
    const h = await makeRetryHarness({ delayMs: 10_000 })
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      throw jsonRpcAppError('at capacity')
    }
    const runPromise = h.r.runTurn('hi', 'req-proc-error')
    await waitFor(() => h.r.pendingRetryAbort !== null)
    // proc 'error' 回调的行为:唤醒退避但**刻意不清 proc**(晚到 stdout 留给 close)。
    // proc-gone 门靠 retryBackoffProcGone 标记命中,而非 `!this.proc`。
    h.r.wakeRetryBackoffOnProcGone()
    assert.equal(h.r.retryBackoffProcGone, true)
    await runPromise
    assert.equal(turnStarts, 1, 'no re-send after proc error during backoff')
    const res = results(h.messages)
    assert.equal(res.length, 1)
    assert.equal(res[0].is_error, true)
    // proc-gone(非用户取消)→ 不带 USER_CANCELLED。
    assert.notEqual(res[0].billing_terminal_code, 'USER_CANCELLED')
    assert.equal(h.r.pendingRetryAbort, null)
    await h.cleanup()
  })

  // 审计 R2-MAJOR — close-only 竞态:退避期间 proc 直接 close(无先行 error 事件)。
  // close handler 会 failAllPending():若旧 attempt 的 completer 未解除,会 reject 一个
  // 无人 await 的 completed promise → unhandled rejection(gateway 无全局守卫,Node
  // 默认可升级为进程退出)。修复=进入重试分支立即置空 completer + no-op catch。
  it('close-only:退避期间 close(failAllPending→wake→proc=null 全序)→ 零 unhandled rejection + 恰好一个 result + 无二次 turn/start', async () => {
    const h = await makeRetryHarness({ delayMs: 10_000 })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      let turnStarts = 0
      h.r.sendRequest = async (method: string) => {
        if (method !== 'turn/start') return {}
        turnStarts++
        throw jsonRpcAppError('at capacity')
      }
      const runPromise = h.r.runTurn('hi', 'req-close-only')
      await waitFor(() => h.r.pendingRetryAbort !== null)
      // 修复后的不变量:进入退避前 completer 已解除,failAllPending 无可 reject。
      assert.equal(h.r.currentTurnCompleter, null, 'completer detached before backoff')
      // 复刻 close handler 的真实顺序(codexAppServerRunner close 回调)。
      h.r.failAllPending('codex app-server exited code=1 signal=')
      h.r.wakeRetryBackoffOnProcGone()
      h.r.proc = null
      await runPromise
      // unhandledRejection 在宏任务边界才派发,settle 两拍再断言。
      await new Promise((r) => setTimeout(r, 30))
      assert.deepEqual(unhandled, [], 'no unhandled rejection from abandoned completer')
      assert.equal(turnStarts, 1, 'no second turn/start')
      const res = results(h.messages)
      assert.equal(res.length, 1)
      assert.equal(res[0].is_error, true)
      assert.notEqual(res[0].billing_terminal_code, 'USER_CANCELLED')
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
    await h.cleanup()
  })

  it('R8:proc 已 null(crash 与 close 之间)时 interrupt() 仍中断退避(先于 proc 存活守卫)', async () => {
    const h = await makeRetryHarness({ delayMs: 10_000 })
    let turnStarts = 0
    h.r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      turnStarts++
      throw jsonRpcAppError('at capacity')
    }
    const runPromise = h.r.runTurn('hi', 'req-interrupt-procdead')
    await waitFor(() => h.r.pendingRetryAbort !== null)
    // proc 已消失但退避仍在跑:旧顺序会被 `if (!this.proc) return false` 挡下。
    h.r.proc = null
    const ok = h.runner.interrupt()
    assert.equal(ok, true, 'interrupt 先处理 pendingRetryAbort,不被 proc 存活守卫挡下')
    await runPromise
    assert.equal(turnStarts, 1, 'no second turn/start')
    assert.equal(results(h.messages).length, 1)
    await h.cleanup()
  })
})
