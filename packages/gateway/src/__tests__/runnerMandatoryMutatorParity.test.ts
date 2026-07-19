/**
 * Runner 必调 mutator 平价契约(2026-07-18 门禁审计批E,重建)。
 *
 * 前身 runnerContractParity.test.ts 在引擎 adapter 重构中被删,只剩
 * codexAppServerRunner.ts 注释里的死引用——契约实际失守。故障形态历史上踩过两次
 * (setModel / setTraceId:sessionManager 硬调 runner 缺失的方法 → TypeError →
 * turn 永不 complete → 用户卡"思考中",2026-05-11 v1.0.123 复现):
 * sessionManager 对 runner 的 mutator 调用是**鸭子类型硬调**,任何 runner 类漏实现
 * 都在运行时才爆。本测试把"sessionManager 必调集"钉死在两个 runner 类的原型上:
 * 新增第三个必调 mutator / 新增 runner 类时,先在这里登记,漏实现即 CI 红。
 *
 * 必调集来源(单一权威=sessionManager.ts 调用点,行号随重构漂移,以 grep 为准):
 *   setGoalState / setTraceId / setEffortLevel / setModel / setExecutionTarget
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { CodexAppServerRunner } from '../engine/codexAppServerRunner.js'
import { SubprocessRunner } from '../subprocessRunner.js'

/** 双引擎通用必调集:每条 turn 路径都可能硬调,两个 runner 类都必须实现。 */
const MANDATORY_MUTATORS = [
  'setGoalState',
  'setTraceId',
  'setEffortLevel',
  'setModel',
] as const

const RUNNER_CLASSES = [
  ['SubprocessRunner', SubprocessRunner],
  ['CodexAppServerRunner', CodexAppServerRunner],
] as const

describe('runner 必调 mutator 平价(sessionManager 鸭子类型硬调集)', () => {
  for (const [name, cls] of RUNNER_CLASSES) {
    test(`${name} 实现全部 sessionManager 必调 mutator`, () => {
      for (const m of MANDATORY_MUTATORS) {
        assert.equal(
          typeof (cls.prototype as unknown as Record<string, unknown>)[m],
          'function',
          `${name}.prototype.${m} 缺失——sessionManager 硬调会 TypeError,turn 永不终态(用户卡"思考中")。` +
            `实现它,或若该 mutator 已从 sessionManager 移除,同步更新本清单。`,
        )
      }
    })
  }

  // setExecutionTarget 是 CCB 专属能力(codex app-server 会话 local-only,不实现)。
  // 契约变形为两条:① CCB runner 必须实现;② sessionManager.setExecutionTarget 必须在
  // 任何破坏性动作(shutdown/清 resume 表)**之前**做能力 fail-fast——本测试用运行时
  // 方法体反射断言顺序(2026-07-18 批E 挖出的原始隐患:TypeError 落在 runner 已停、
  // 上下文已清之后,会话留在半迁移残骸态)。
  test('SubprocessRunner 实现 setExecutionTarget(CCB 专属能力)', () => {
    assert.equal(typeof (SubprocessRunner.prototype as unknown as Record<string, unknown>).setExecutionTarget, 'function')
  })

  test('sessionManager.setExecutionTarget 的能力检查先于破坏性动作', async () => {
    const { SessionManager } = await import('../sessionManager.js')
    const src = (SessionManager.prototype as { setExecutionTarget: (...a: unknown[]) => unknown })
      .setExecutionTarget.toString()
    const guardAt = src.indexOf('does not support execution-target switch')
    const shutdownAt = src.indexOf('shutdown()')
    assert.ok(guardAt >= 0, 'setExecutionTarget 缺能力 fail-fast 守卫(codex 会话会在破坏性动作后才 TypeError)')
    assert.ok(shutdownAt > guardAt, '能力守卫必须位于 runner.shutdown() 之前(先验能力,再动上下文)')
  })
})
