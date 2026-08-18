/**
 * delegate_tasks(fan-out)纯逻辑测试:入参校验 + 结果聚合 + 单项失败隔离。
 *
 * 只测 delegateFanout.ts 的纯函数(index.ts 是带顶层 await + stdio server.connect 的
 * 入口模块,不适合直接 import);handleDelegateTasks 的编排(Promise.all 各自 POST
 * /delegate)在 gateway 侧经既有 delegate 路径 + 资源闸测试覆盖。
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/delegateFanout.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type FanoutItemResult,
  MAX_FANOUT_TASKS,
  aggregateDelegateFanoutResults,
  normalizeFanoutTasks,
} from '../delegateFanout.js'

describe('normalizeFanoutTasks — 入参校验', () => {
  it('非数组 / 空数组 → 拒绝', () => {
    assert.equal(normalizeFanoutTasks(undefined).ok, false)
    assert.equal(normalizeFanoutTasks(null).ok, false)
    assert.equal(normalizeFanoutTasks('x').ok, false)
    assert.equal(normalizeFanoutTasks([]).ok, false)
  })

  it(`超过 ${MAX_FANOUT_TASKS} 项 → 拒绝并说明`, () => {
    const many = Array.from({ length: MAX_FANOUT_TASKS + 1 }, (_, i) => ({ goal: `g${i}` }))
    const r = normalizeFanoutTasks(many)
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, new RegExp(String(MAX_FANOUT_TASKS)))
  })

  it('某项缺 goal → 拒绝并指出第几项', () => {
    const r = normalizeFanoutTasks([{ goal: 'ok' }, { context: '无 goal' }])
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /第 2 个/)
  })

  it('合法项规范化:effort 白名单外丢弃、toolsets 非字符串过滤、字段透传', () => {
    const r = normalizeFanoutTasks([
      {
        agentId: 'coding-assistant',
        goal: ' 实现 A ',
        context: 'ctx',
        effort: 'high',
        toolsets: ['browser', 42],
        resumeSessionKey: '  agent:coding-assistant:delegate:main:1:abcd  ',
      },
      { goal: 'B', effort: 'turbo' }, // 非法 effort → 丢弃
    ])
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.tasks.length, 2)
    assert.deepEqual(r.tasks[0], {
      agentId: 'coding-assistant',
      goal: '实现 A', // trim
      context: 'ctx',
      effort: 'high',
      toolsets: ['browser'], // 42 被过滤
      resumeSessionKey: 'agent:coding-assistant:delegate:main:1:abcd',
    })
    assert.equal(r.tasks[1].agentId, undefined)
    assert.equal(r.tasks[1].effort, undefined, '非白名单 effort 丢弃 → 用成员默认档位')
    assert.equal(r.tasks[1].toolsets, undefined)
  })
})

describe('aggregateDelegateFanoutResults — 结果聚合 + 单项失败隔离', () => {
  const mk = (over: Partial<FanoutItemResult>): FanoutItemResult => ({
    label: 'coding-assistant',
    goal: 'do something',
    isError: false,
    text: 'output text',
    ...over,
  })

  it('全部成功:头部计数 3 成功 / 0 失败,每项 ✅', () => {
    const out = aggregateDelegateFanoutResults([mk({}), mk({}), mk({})])
    assert.match(out, /3 成功 \/ 0 失败/)
    assert.equal((out.match(/✅/g) || []).length, 3)
    assert.doesNotMatch(out, /❌/)
  })

  it('单项失败被隔离标注 ❌,成功项照常呈现,计数正确', () => {
    const out = aggregateDelegateFanoutResults([
      mk({ label: 'research-assistant', text: '文献综述已完成' }),
      mk({ label: 'office-assistant', isError: true, text: 'error: 委派失败: ETIMEDOUT' }),
      mk({ label: 'coding-assistant', text: '代码已落 /home/agent/.openclaude/generated/x.py' }),
    ])
    assert.match(out, /3 个子任务已全部返回:2 成功 \/ 1 失败/)
    assert.match(out, /❌ office-assistant/)
    assert.match(out, /✅ research-assistant/)
    assert.match(out, /✅ coding-assistant/)
    // 各项正文都在(失败项不吞掉,成功项不被失败项影响)
    assert.match(out, /文献综述已完成/)
    assert.match(out, /ETIMEDOUT/)
    assert.match(out, /generated\/x\.py/)
  })

  it('按输入顺序编号', () => {
    const out = aggregateDelegateFanoutResults([mk({ goal: 'first' }), mk({ goal: 'second' })])
    assert.ok(out.indexOf('### 1.') < out.indexOf('### 2.'))
    assert.ok(out.indexOf('### 2.') < out.length)
  })

  it('超长 goal 在小标题里截断,不影响正文', () => {
    const longGoal = 'x'.repeat(200)
    const out = aggregateDelegateFanoutResults([mk({ goal: longGoal, text: 'BODY' })])
    assert.match(out, /…/)
    assert.match(out, /BODY/)
  })

  it('前端解析契约:首行「并行委派 …成功/…失败」+ 每节 `### i. ✅/❌ label — goal`(DelegateFanoutCard 依赖)', () => {
    // web-react 的 DelegateFanoutCard 逐行解析该聚合文本:首行取汇总计数,`### i.` 起每个
    // 子任务小节取状态徽标/标签/目标。这里把两处结构钉死,防止措辞漂移击穿前端解析。
    const out = aggregateDelegateFanoutResults([
      mk({ label: 'coding-assistant', goal: '写脚本', text: 'ok' }),
      mk({ label: 'office-assistant', isError: true, text: 'error: 委派失败' }),
    ])
    const lines = out.split('\n')
    assert.match(lines[0], /^并行委派 2 个子任务已全部返回:1 成功 \/ 1 失败。$/)
    assert.match(out, /### 1\. ✅ coding-assistant — 写脚本/)
    assert.match(out, /### 2\. ❌ office-assistant — do something/)
  })
})
