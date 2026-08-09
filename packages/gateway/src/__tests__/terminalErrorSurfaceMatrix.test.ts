/**
 * Terminal-error surface matrix —— "错误以正常返回值出现" 这一类引擎适配 bug 的门。
 *
 * ── 根因(#229 原文)────────────────────────────────────────────────────────
 *   "Codex capacity failures arrive as a resolved TurnSummary (isError=true,
 *    errorClass=model_capacity), so the existing outer exception retry loop
 *    never saw them and performed zero retries."
 *
 * 同族已连续出现三次:#229(resolved TurnSummary 绕过重试)、#215(codex 把放弃的
 * JSON 尝试当正常输出吐出)、#230(MCP `isError: true` 被 CLI 当 exit 0)。共同形态:
 * **失败以"正常返回值"投递,而消费方只认异常**。用户可见后果是同一件事:平台明明知道
 * 这是可自动恢复的临时故障,却一次不重试,直接把红色错误卡摔给用户。
 *
 * ── 门的形状 ────────────────────────────────────────────────────────────────
 * 一个 turn 的终态错误有**两种投递形态**,它们在 sessionManager 里落在**两处**判定:
 *   A. throw   —— `_runOneTurn` 抛异常 → runOneTurnWithRetry catch 分支按
 *                 `classifyRunError(msg)` 判 transient(sessionManager.ts ~3933);
 *   B. resolved —— 引擎给出 `TurnSummary{isError:true, errorClass}` → turn 内部按
 *                 `result.errorClass` 判 transient(sessionManager.ts ~4630)。
 * 两处各有一份判定,共用一个私有码集合。本门对**每个** errorClass 同时跑两种形态,
 * 断言二者收敛到:同一个 taxonomy 码 + 同一个重试决策(attempt 次数逐一相等)。
 * 任何一侧被单独改动(新增可重试码只加进一处、或某形态被漏掉)立即红。
 *
 * 覆盖率不靠手抄:码集合从 errorClassify 的声明值域派生(helpers/classifiedErrorCodes),
 * 新增码没有登记期望决策即红 —— 不允许"新错误码悄悄上线、没人回答它该不该重试"。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/terminalErrorSurfaceMatrix.test.ts
 */

import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import type { OpenClaudeConfig } from '@openclaude/storage'
import { isKnownTurnErrorCode } from '@openclaude/protocol'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import { classifyRunError } from '../errorClassify.js'
import { type AgentSession, SessionManager } from '../sessionManager.js'
import type { SubprocessRunner } from '../subprocessRunner.js'
import {
  setV3MasterSinkSingleton,
  type V3MasterSink,
  type V3MasterSinkPayload,
} from '../v3MasterSink.js'
import { readClassifiedErrorCodes } from './helpers/classifiedErrorCodes.js'

// ── 期望决策表(每个引擎可产出的 errorClass 都必须在此回答"该不该自动重试")──────
//
// attempts = 用户这一条消息实际发生的引擎尝试次数(1 = 不重试;11 = 初次 + 10 次自动重试)。
// 这张表是**声明**,不是从实现读的镜子:改了实现的重试集合而不改这里
// 就会红,改了这里则两种投递形态必须同时满足 —— 两处判定漂移由此暴露。
interface Scenario {
  /** errorClass / classifyRunError 产出码。 */
  readonly code: string
  /** 能被 classifyRunError 分到该码的真实错误串(两种形态共用)。 */
  readonly sample: string
  /** 期望的引擎尝试次数(两种投递形态必须一致)。 */
  readonly attempts: number
  /** 期望依据(评审可读性;不参与断言)。 */
  readonly why: string
}

const SCENARIOS: readonly Scenario[] = [
  {
    code: 'model_config_changed_retry_turn',
    sample:
      'API Error: 409 {"error":{"code":"MODEL_CONFIG_CHANGED_RETRY_TURN","message":"model configuration changed, please retry in a new turn"}}',
    attempts: 1,
    why: '旧执行票据已失效,必须让用户在新 turn 重发,自动重试同一 turn 不会恢复',
  },
  {
    code: 'rate_limited',
    sample: '429 Too Many Requests',
    attempts: 11,
    why: '账号限流是临时的,自动续跑比让用户手点重试更符合"不降 UX"',
  },
  {
    code: 'model_capacity',
    sample: 'Selected model is at capacity. Please try a different model.',
    attempts: 11,
    why: '#229 本体:容量故障必须自动重试,而不是把红卡摔给用户',
  },
  {
    code: 'upstream_failed',
    sample: 'Anthropic returned 502 Bad Gateway',
    attempts: 11,
    why: '上游 5xx 属瞬时故障',
  },
  {
    code: 'insufficient_credits',
    sample: '402 INSUFFICIENT_CREDITS: balance=1 required=9',
    attempts: 1,
    why: '余额不足重试多少次都一样,必须立刻给"去充值"CTA(重试反而多扣一次预扣)',
  },
  {
    code: 'context_too_long',
    sample: "prompt is too long: ran out of room in the model's context window",
    attempts: 1,
    why:
      'CCB 引擎下不可自动恢复(缩史续跑是 codex-native 专属路径,由 ' +
      'sessionManagerEngineTurn 的 codex context-overflow 用例覆盖)',
  },
  {
    code: 'bad_request',
    sample: JSON.stringify({
      subtype: 'error_during_execution',
      result:
        'API Error: 400 {"error":{"code":"INVALID_REQUEST","message":"The upstream provider rejected this request"}}',
    }),
    attempts: 1,
    why: '请求语义无效不是瞬时上游故障，重复同一请求只会制造重复原始错误',
  },
]

/**
 * 当前所有分类码都必须回答 throw/resolved 两种终态投递形态的重试决策。
 */
const MATRIX_EXCLUDED_CODES = new Set<string>()

// ── 最小 CCB 引擎夹具(与 sessionManagerEngineTurn.test.ts 同构)────────────────

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
  } as unknown as OpenClaudeConfig
}

class FakeCcbRunner extends EventEmitter {
  lastActivityAt = Date.now()
  submits = 0

  constructor(private readonly onSubmit: (runner: FakeCcbRunner) => void) {
    super()
  }

  interrupt(): boolean {
    return false
  }
  async shutdown(): Promise<void> {}
  clearSessionId(): void {}
  async waitForOutputDrain(): Promise<void> {}

  async submit(): Promise<void> {
    this.submits += 1
    this.onSubmit(this)
  }

  /** 终态 result 行:is_error + errorClass = "错误以正常返回值投递" 的形态。 */
  errorResult(errorClass: string, detail: string): void {
    this.emit('message', {
      type: 'result',
      total_cost_usd: 0,
      usage: {},
      is_error: true,
      subtype: 'error_during_execution',
      result: detail,
      errorClass,
    })
  }
}

function makeSession(runner: FakeCcbRunner): AgentSession {
  const adapter = new CcbAdapter({} as EngineCreateOpts, runner as unknown as SubprocessRunner)
  return {
    sessionKey: 'agent:main:webchat:dm:surface-matrix',
    agentId: 'main',
    channel: 'webchat',
    userId: 'user-1',
    peerId: 'surface-matrix',
    title: 'Surface Matrix',
    startedAt: Date.now(),
    runner: adapter,
    ccbSessionId: 'ccb-sess-1',
    lock: Promise.resolve(),
    lastUsedAt: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 0,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' },
    providerTag: 'ccb',
    agentProvider: undefined,
  } as unknown as AgentSession
}

function makeCapturingSink(): { sink: V3MasterSink; payloads: V3MasterSinkPayload[] } {
  const payloads: V3MasterSinkPayload[] = []
  const sink = {
    persistOrQueue: async (payload: V3MasterSinkPayload) => {
      payloads.push(payload)
      return { ok: true }
    },
    attemptOnce: async () => {
      throw new Error('not used')
    },
  } as unknown as V3MasterSink
  return { sink, payloads }
}

function newSessionManager(): SessionManager {
  const sm = new SessionManager(makeConfigStub())
  // 退避改 0:本门测的是"重试了几次",不是等了多久(sleep 会把竞态藏起来还慢)。
  ;(sm as unknown as { _transientRetryDelayMs: () => number })._transientRetryDelayMs = () => 0
  return sm
}

/** 形态 A —— `_runOneTurn` 抛异常。返回实际尝试次数。 */
async function attemptsForThrownSurface(sample: string): Promise<number> {
  const sm = newSessionManager()
  const runner = new FakeCcbRunner(() => {})
  const session = makeSession(runner)
  let attempts = 0
  ;(sm as unknown as { _runOneTurn: () => Promise<void> })._runOneTurn = async () => {
    attempts += 1
    throw new Error(sample)
  }
  await (
    sm as unknown as { runOneTurnWithRetry: (...args: unknown[]) => Promise<void> }
  )
    .runOneTurnWithRetry(session, 'hello', () => {}, 'a'.repeat(32))
    .catch(() => {
      // 非可重试码耗尽后 reject 是既定语义(caller 转终态错误卡),本门只数次数。
    })
  return attempts
}

/** 形态 B —— 引擎 resolved TurnSummary(isError=true + errorClass)。 */
async function attemptsForResolvedSurface(
  code: string,
  sample: string,
): Promise<{ attempts: number; persistedErrorCode: unknown }> {
  const captured = makeCapturingSink()
  setV3MasterSinkSingleton(captured.sink)
  try {
    const sm = newSessionManager()
    const runner = new FakeCcbRunner((r) => {
      setImmediate(() => r.errorResult(code, sample))
    })
    const session = makeSession(runner)
    await sm.submit(session, 'hello', () => {}, undefined, undefined, 'b'.repeat(32))
    return {
      attempts: runner.submits,
      persistedErrorCode: captured.payloads.at(-1)?.errorCode,
    }
  } finally {
    setV3MasterSinkSingleton(null)
  }
}

// ── 门 ────────────────────────────────────────────────────────────────────────

const inventory = await readClassifiedErrorCodes()

describe('terminal-error surface matrix — 覆盖率', () => {
  it('每个引擎可产出的 errorClass 都登记了期望重试决策(新增码不登记即红)', () => {
    const declared = inventory.classifyCodes.filter((c) => !MATRIX_EXCLUDED_CODES.has(c))
    const registered = new Set(SCENARIOS.map((s) => s.code))
    const missing = declared.filter((c) => !registered.has(c))
    assert.deepEqual(
      missing,
      [],
      `errorClassify 能产出但本矩阵没有场景的码:${missing.join(', ')};` +
        '修法=在 SCENARIOS 补一条(代表串 + 期望 attempts + 依据)。' +
        '没有场景 = 没人回答"这个错误该不该自动重试",两处判定可以各自漂移。',
    )
    const ghosts = [...registered].filter((c) => !inventory.allCodes.includes(c))
    assert.deepEqual(ghosts, [], `矩阵里的码不在 errorClassify 值域内:${ghosts.join(', ')}`)
  })

  it('每条场景的代表串真的被分到该码(驱动集有效)', () => {
    for (const s of SCENARIOS) {
      assert.equal(classifyRunError(s.sample).code, s.code, `sample: ${s.sample}`)
      assert.ok(isKnownTurnErrorCode(s.code), `${s.code} 不在 TURN_ERROR_TAXONOMY`)
    }
  })
})

describe('terminal-error surface matrix — throw 与 resolved(isError=true)必须同决策', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.code}: 两种投递形态都恰好 ${scenario.attempts} 次尝试`, async () => {
      const thrown = await attemptsForThrownSurface(scenario.sample)
      const resolved = await attemptsForResolvedSurface(scenario.code, scenario.sample)

      assert.equal(
        thrown,
        scenario.attempts,
        `${scenario.code} 以异常投递时尝试了 ${thrown} 次,期望 ${scenario.attempts}(${scenario.why})`,
      )
      assert.equal(
        resolved.attempts,
        scenario.attempts,
        `${scenario.code} 以 resolved TurnSummary(isError=true)投递时尝试了 ` +
          `${resolved.attempts} 次,期望 ${scenario.attempts}。这正是 #229 的形状:` +
          '失败作为"正常返回值"到达,外层异常重试环看不见它 → 零重试,用户直接吃红卡。',
      )
      assert.equal(
        resolved.attempts,
        thrown,
        `${scenario.code} 的两种终态投递形态重试决策不一致(${thrown} vs ${resolved.attempts})——` +
          'sessionManager 里两处 transient 判定已漂移,同一个故障在不同引擎/路径上表现不同。',
      )
      // resolved 形态还要证明:引擎上报的 errorClass 原样成为持久化终态码
      // (前端按它渲染红卡 + CTA;链路一断用户看到的就是无 CTA 的通用失败)。
      assert.equal(
        resolved.persistedErrorCode,
        scenario.code,
        `${scenario.code}: 终态 tape 的 errorCode 不是引擎上报的 errorClass(链路断了)`,
      )
    })
  }
})
