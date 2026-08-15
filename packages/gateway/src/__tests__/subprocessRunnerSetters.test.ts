/**
 * Regression for SubprocessRunner.setModel + .model getter (added 2026-04-26
 * v1.0.4 to support InboundMessage.model — per-user model override via
 * user_preferences.default_model).
 *
 * Contract: model + effortLevel are pure opts mutators with NO subprocess
 * side effects. Restart is the caller's responsibility (sessionManager.submit
 * detects diff via getter, calls setX, then shutdown so the next submit()
 * re-spawns with the new value). If this getter ever becomes async or has
 * side effects, sessionManager's "merged needsRestart" branch will misfire.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/subprocessRunnerSetters.test.ts
 */
import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { ALLOWED_INBOUND_MODELS, resolveExecutionModel } from '../server.js'
import {
  DEFAULT_SECONDARY_UTILITY_MODEL,
  SubprocessRunner,
  _buildSecondaryUtilityModelEnv,
} from '../subprocessRunner.js'

function createRunner(
  initial: Partial<{ model: string; effortLevel: string; agentToolsets: string[] }> = {},
): SubprocessRunner {
  return new SubprocessRunner({
    sessionKey: 'test',
    agentId: 'test',
    agentBaseDir: '/tmp',
    config: {} as any,
    ...initial,
  } as any)
}

describe('SubprocessRunner.model getter / setModel', () => {
  it('returns undefined when not set in constructor', () => {
    const r = createRunner()
    assert.equal(r.model, undefined)
  })

  it('reflects constructor-supplied model', () => {
    const r = createRunner({ model: 'claude-opus-4-7' })
    assert.equal(r.model, 'claude-opus-4-7')
  })

  it('setModel mutates and getter reflects the new value', () => {
    const r = createRunner({ model: 'claude-opus-4-7' })
    r.setModel('claude-sonnet-4-6')
    assert.equal(r.model, 'claude-sonnet-4-6')
  })

  it('setModel(undefined) clears the model', () => {
    const r = createRunner({ model: 'claude-opus-4-7' })
    r.setModel(undefined)
    assert.equal(r.model, undefined)
  })

  it('setModel does not start a subprocess (no side-effect contract)', () => {
    // Sanity: we only construct + mutate. If setModel ever starts spawning
    // (e.g. someone "helpfully" added auto-restart), this test would hang
    // or emit a 'spawn'/'exit' event we don't expect.
    const r = createRunner()
    let spawned = false
    r.on('spawn' as any, () => { spawned = true })
    r.setModel('claude-opus-4-7')
    r.setModel('claude-sonnet-4-6')
    r.setModel(undefined)
    assert.equal(spawned, false, 'setModel must not spawn — caller owns restart via shutdown()')
  })

  it('ALLOWED_INBOUND_MODELS contains the currently exposed model set', () => {
    // 新增其他模型时这个测试要同步更新。
    // 防止 server.ts WS handler 的静态白名单跟前端 modelPicker 期望的列表漂移。
    // Codex GPT-5.6 三型号都走 app-server JSON-RPC；旧 GPT-5.5 已退场。
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      assert.ok(ALLOWED_INBOUND_MODELS.has(model))
    }
    assert.equal(ALLOWED_INBOUND_MODELS.has('gpt-5.5'), false)
    // direct DeepSeek anthropic-compatible 上游(在 anthropicProxy
    // isDeepseekModel 命中后切 DEEPSEEK_UPSTREAM_ENDPOINT):
    assert.ok(ALLOWED_INBOUND_MODELS.has('deepseek-v4-pro'))
    // MiniMax-M3 Token Plan anthropic-compatible 上游:
    assert.ok(ALLOWED_INBOUND_MODELS.has('MiniMax-M3'))
    // glm-5.1/5.2/5.3 火山方舟 Ark Coding Plan anthropic-compatible 上游:
    assert.ok(ALLOWED_INBOUND_MODELS.has('glm-5.1'))
    assert.ok(ALLOWED_INBOUND_MODELS.has('glm-5.2'))
    assert.ok(ALLOWED_INBOUND_MODELS.has('glm-5.3'))
    // DeepSeek V4 Flash canonical/兼容 alias + qwen3.7 历史模型走 OpenCode Go:
    assert.ok(ALLOWED_INBOUND_MODELS.has('deepseek-v4-flash'))
    assert.ok(ALLOWED_INBOUND_MODELS.has('deepseek-v4-flash-opencode-go'))
    assert.ok(ALLOWED_INBOUND_MODELS.has('qwen3.7-max'))
    assert.ok(ALLOWED_INBOUND_MODELS.has('qwen3.7-plus'))
    // kimi-k2.7-code 火山方舟 Agent Plan anthropic-compatible 上游(2026-07-06):
    assert.ok(ALLOWED_INBOUND_MODELS.has('kimi-k2.7-code'))
  })

  it('ALLOWED_INBOUND_MODELS 全面下线 Claude 官方模型(v3+v5)', () => {
    // Claude 官方模型已下线,任何渠道都不再接受;stale prefs / 构造帧会被拒。
    assert.equal(ALLOWED_INBOUND_MODELS.has('claude-opus-4-7'), false)
    assert.equal(ALLOWED_INBOUND_MODELS.has('claude-sonnet-4-6'), false)
    assert.equal(ALLOWED_INBOUND_MODELS.has('claude-haiku-4-5'), false)
  })

  it('resolveExecutionModel 收敛 agent 级已下线模型(spawn 收口点)', () => {
    // 白名单内的模型原样保留。
    assert.equal(resolveExecutionModel('glm-5.2', 'gpt-5.6-sol'), 'glm-5.2')
    assert.equal(resolveExecutionModel('deepseek-v4-pro', undefined), 'deepseek-v4-pro')
    // 已下线的 Claude(marketplace manifest / seed / delegate 里 stale)→ 降级到平台默认,
    // 不会以不可路由的 --model spawn。
    assert.equal(resolveExecutionModel('claude-opus-4-7', undefined), 'glm-5.3')
    assert.equal(resolveExecutionModel('claude-sonnet-4-6', 'claude-haiku-4-5'), 'glm-5.3')
    // preferred 非法但 fallback 合法 → 用 fallback。
    assert.equal(resolveExecutionModel('claude-opus-4-7', 'MiniMax-M3'), 'MiniMax-M3')
    // 两者都缺/非法 → 平台默认 glm-5.3。
    assert.equal(resolveExecutionModel(undefined, null), 'glm-5.3')
    assert.equal(resolveExecutionModel('some-unknown-model', undefined), 'glm-5.3')
  })

  it('ALLOWED_INBOUND_MODELS rejects bogus / typo model ids', () => {
    // CCB --model 拿到非法值会启动失败 → session 卡死,所以静态白名单要拦住
    // 用户 prefs 残留的旧 id / 恶意 frame 注入字符串。
    for (const bogus of [
      '',
      'opus-4-7',                    // 缺 claude- 前缀
      'claude-opus-4-7-bogus',       // 后缀污染
      'claude-haiku-4-5',            // Claude 官方模型已下线
      'gpt-5',
      'minimax-m3',                  // 大小写敏感；产品暴露 canonical MiniMax-M3
      'CLAUDE-OPUS-4-7',             // 大小写敏感 — Anthropic API 也是
      ' claude-opus-4-7',            // 前导空格
    ]) {
      assert.equal(ALLOWED_INBOUND_MODELS.has(bogus), false, `should reject "${bogus}"`)
    }
  })

  it('parity with effortLevel: same getter/setter shape', () => {
    // Both fields use the same "pure mutator + getter" pattern in
    // sessionManager.submit's needsRestart logic (lines 609-611). If their
    // shapes diverge, the merged-restart branch would silently miss one.
    const r = createRunner({ model: 'claude-opus-4-7', effortLevel: 'medium' })
    assert.equal(r.model, 'claude-opus-4-7')
    assert.equal(r.effortLevel, 'medium')
    r.setModel('claude-sonnet-4-6')
    r.setEffortLevel('high')
    assert.equal(r.model, 'claude-sonnet-4-6')
    assert.equal(r.effortLevel, 'high')
  })

  it('toolsets getter / setToolsets follows the same pure-mutator contract', () => {
    const r = createRunner({ agentToolsets: ['core'] })
    assert.deepEqual(r.toolsets, ['core'])
    let spawned = false
    r.on('spawn' as any, () => { spawned = true })
    r.setToolsets(['core', 'browser'])
    assert.deepEqual(r.toolsets, ['core', 'browser'])
    r.setToolsets(undefined)
    assert.equal(r.toolsets, undefined)
    assert.equal(spawned, false, 'setToolsets must not spawn — caller owns restart via shutdown()')
  })
})

describe('SubprocessRunner bounded shutdown', () => {
  it('returns after SIGKILL but retains ownership until the real close boundary', async () => {
    const oldGrace = process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS
    const oldFinal = process.env.OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS
    process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS = '5'
    process.env.OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS = '5'
    const runner = createRunner()
    const proc = new EventEmitter() as EventEmitter & {
      pid?: number
      stdin: { end: () => void }
      kill: (signal: NodeJS.Signals) => boolean
    }
    const signals: NodeJS.Signals[] = []
    proc.stdin = { end: () => {} }
    proc.kill = (signal) => {
      signals.push(signal)
      return true
    }
    ;(runner as any).proc = proc
    try {
      await runner.shutdown()
      assert.deepEqual(signals, ['SIGKILL'])
      assert.equal((runner as any).proc, proc)
      assert.equal((runner as any).shuttingDown, true)
      proc.emit('close')
      assert.equal((runner as any).proc, null)
      assert.equal((runner as any).shuttingDown, false)
    } finally {
      if (oldGrace === undefined) delete process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS
      else process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS = oldGrace
      if (oldFinal === undefined) delete process.env.OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS
      else process.env.OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS = oldFinal
    }
  })

  it('ignores a drained exit from a detached old process after a new process owns the runner', () => {
    const runner = createRunner()
    const oldProc = new EventEmitter()
    const newProc = new EventEmitter()
    ;(runner as any).proc = newProc
    const exits: unknown[] = []
    runner.on('exit', (info) => exits.push(info))

    const forwarded = (runner as any)._forwardDrainedExitForProcess(oldProc, {
      code: 137,
      signal: 'SIGKILL',
      crashed: true,
    })

    assert.equal(forwarded, false)
    assert.deepEqual(exits, [])
    assert.equal((runner as any).proc, newProc)
  })
})

describe('SubprocessRunner lossless stdout', () => {
  it('parses a valid stream-json line larger than the former 8 MiB cap without dropping it', () => {
    const runner = createRunner()
    const text = '模型与工具完整输出😀'.repeat(600_000)
    const messages: Array<Record<string, any>> = []
    const overflows: unknown[] = []
    runner.on('message', (message) => messages.push(message as Record<string, any>))
    runner.on('overflow', (info) => overflows.push(info))

    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    })
    assert.ok(Buffer.byteLength(line, 'utf8') > 8 * 1024 * 1024)
    ;(runner as any).handleStdout(`${line}\n`)

    assert.equal(messages.length, 1)
    assert.equal(messages[0].message.content[0].text, text)
    assert.deepEqual(overflows, [])
  })
})

describe('SubprocessRunner secondary utility model env', () => {
  it('pins CCB hidden secondary calls to the dedicated cheap static model, unconditionally', () => {
    // Decoupled from the main model: WebFetch/hook/search secondary calls must
    // never fall back to Haiku (OAuth pool → 402) nor run on a heavyweight
    // thinking model (glm-5.2 → upstream 400 → 502). Always deepseek-v4-flash.
    const prev = process.env.OPENCLAUDE_SECONDARY_MODEL
    delete process.env.OPENCLAUDE_SECONDARY_MODEL
    try {
      assert.deepEqual(_buildSecondaryUtilityModelEnv(), {
        ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v4-flash',
      })
      assert.equal(DEFAULT_SECONDARY_UTILITY_MODEL, 'deepseek-v4-flash')
    } finally {
      if (prev === undefined) delete process.env.OPENCLAUDE_SECONDARY_MODEL
      else process.env.OPENCLAUDE_SECONDARY_MODEL = prev
    }
  })

  it('honours the OPENCLAUDE_SECONDARY_MODEL ops override', () => {
    const prev = process.env.OPENCLAUDE_SECONDARY_MODEL
    process.env.OPENCLAUDE_SECONDARY_MODEL = 'minimax-m3'
    try {
      assert.deepEqual(_buildSecondaryUtilityModelEnv(), {
        ANTHROPIC_SMALL_FAST_MODEL: 'minimax-m3',
      })
    } finally {
      if (prev === undefined) delete process.env.OPENCLAUDE_SECONDARY_MODEL
      else process.env.OPENCLAUDE_SECONDARY_MODEL = prev
    }
  })

  it('ignores a blank override and keeps the default', () => {
    const prev = process.env.OPENCLAUDE_SECONDARY_MODEL
    process.env.OPENCLAUDE_SECONDARY_MODEL = '   '
    try {
      assert.deepEqual(_buildSecondaryUtilityModelEnv(), {
        ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v4-flash',
      })
    } finally {
      if (prev === undefined) delete process.env.OPENCLAUDE_SECONDARY_MODEL
      else process.env.OPENCLAUDE_SECONDARY_MODEL = prev
    }
  })
})
