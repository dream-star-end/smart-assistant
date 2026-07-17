/**
 * CI 契约锚 — 把 codex 0.144.0 「清除一个从未设过目标的会话」时抛出的真实
 * -32600 "no goal exists" 错误串钉进 CI，防止 codex 升级换措辞时静默回归。
 *
 * 背景:2026-07-17 goal 停摆事故。syncPlatformGoal 对无目标会话发清除性
 * `thread/goal/set`(objective: null),codex 用 -32600
 * `cannot update goal for thread <id>: no goal exists` 拒绝;
 * isGoalAlreadyClearedError 把它当幂等成功吞掉(desired end state 已成立)。
 * 判定依赖对 rpcMessage 的正则 /no goal exists/i —— codex 一旦换措辞,该正则
 * 会漏判,goalless 会话每轮再次全挂。本测试让「换措辞」在 CI 变红,而不是
 * 上线后在生产炸。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/goalClearedErrorContract.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isGoalAlreadyClearedError } from '../engine/codexAppServerRunner.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(
  __dirname,
  'fixtures',
  'codex-app-server-0.144.0',
  'GoalClearNoGoalError.json',
)

interface GoalClearNoGoalFixture {
  codexVersion: string
  rpcMethod: string
  rpcCode: number
  messageTemplate: string
  messageSample: string
}

const fixture = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as GoalClearNoGoalFixture

/** 用 fixture 字段还原 JsonRpcCallError 的生产构造形态
 *  (Object.assign(new Error(msg), { rpcCode, rpcMessage, rpcMethod }))。 */
function makeRpcError(overrides: {
  rpcMethod?: string
  rpcCode?: number
  rpcMessage?: string
}): Error {
  const rpcMethod = overrides.rpcMethod ?? fixture.rpcMethod
  const rpcCode = overrides.rpcCode ?? fixture.rpcCode
  const rpcMessage = overrides.rpcMessage ?? fixture.messageSample
  return Object.assign(new Error(rpcMessage), { rpcCode, rpcMessage, rpcMethod })
}

describe('isGoalAlreadyClearedError — codex 0.144.0 fixture pin', () => {
  it('positive pin: fixture 的真实错误串被判为幂等清除成功', () => {
    // 这把 codex 0.144.0 的真实错误串钉进 CI。codex 升级换措辞时,重新生成本
    // fixture(messageSample 变成新串)——若新串不再含 "no goal exists",本
    // 断言即红,逼迫同步更新 codexAppServerRunner.ts 的 /no goal exists/i 正则。
    const err = makeRpcError({ rpcMessage: fixture.messageSample })
    assert.equal(isGoalAlreadyClearedError(err), true)
  })

  it('template consistency: messageTemplate 填入 thread 后 === messageSample', () => {
    // fixture 内部自洽:模板占位替换应精确还原样本串,防止模板与样本各写各的。
    const rendered = fixture.messageTemplate.replace('{thread}', 'thread-goal-none')
    assert.equal(rendered, fixture.messageSample)
  })

  it('negative drift sentinel: codex 换措辞(同 method+code)当前正则会漏判', () => {
    // codex 二进制里另一个真实串。若 codex 未来把 thread/goal/set 的清除错误
    // 改成这种措辞,当前 /no goal exists/i 正则会漏判(返回 false)→ 停摆重现。
    // 本负向断言在此显式记录该风险:换措辞 = 必须改正则 + 重生 fixture。
    const drift = makeRpcError({
      rpcMessage: 'cannot update goal because this thread has no goal',
    })
    assert.equal(isGoalAlreadyClearedError(drift), false)
  })

  it('method guard: 同 code+message 但换 method 时返回 false', () => {
    const other = makeRpcError({ rpcMethod: 'thread/goal/get' })
    assert.equal(isGoalAlreadyClearedError(other), false)
  })

  it('code guard: 同 method+message 但换 rpcCode 时返回 false', () => {
    const other = makeRpcError({ rpcCode: -32000 })
    assert.equal(isGoalAlreadyClearedError(other), false)
  })
})
