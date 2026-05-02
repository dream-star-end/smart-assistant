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
import { describe, it } from 'node:test'
import { ALLOWED_INBOUND_MODELS } from '../server.js'
import { SubprocessRunner } from '../subprocessRunner.js'

function createRunner(initial: Partial<{ model: string; effortLevel: string }> = {}): SubprocessRunner {
  return new SubprocessRunner({
    sessionKey: 'test',
    agentId: 'test',
    cwd: '/tmp',
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
    // v1.0.4 launch set:
    assert.ok(ALLOWED_INBOUND_MODELS.has('claude-opus-4-7'))
    assert.ok(ALLOWED_INBOUND_MODELS.has('claude-sonnet-4-6'))
    // codex agent (gpt-5.5 走 codex JSON-RPC):
    assert.ok(ALLOWED_INBOUND_MODELS.has('gpt-5.5'))
    // v1.0.68 起 DeepSeek anthropic-compatible 上游(在 anthropicProxy
    // isDeepseekModel 命中后切 DEEPSEEK_UPSTREAM_ENDPOINT):
    assert.ok(ALLOWED_INBOUND_MODELS.has('deepseek-v4-flash'))
    assert.ok(ALLOWED_INBOUND_MODELS.has('deepseek-v4-pro'))
  })

  it('ALLOWED_INBOUND_MODELS rejects bogus / typo model ids', () => {
    // CCB --model 拿到非法值会启动失败 → session 卡死,所以静态白名单要拦住
    // 用户 prefs 残留的旧 id / 恶意 frame 注入字符串。
    for (const bogus of [
      '',
      'opus-4-7',                    // 缺 claude- 前缀
      'claude-opus-4-7-bogus',       // 后缀污染
      'claude-haiku-4-5',            // 协议本支持 Haiku 但 v1.0.4 产品没暴露
      'gpt-5',
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
})
