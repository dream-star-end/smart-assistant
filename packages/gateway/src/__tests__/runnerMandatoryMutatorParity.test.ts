/**
 * Runner mandatory-mutator parity 契约门(重建;2026-07-26 门禁审计)。
 *
 * ── 它防的是哪一类用户可见故障 ────────────────────────────────────────────
 * `sessionManager.submit()` 在 turn 启动前**按名字**调一串 runner mutator
 * (setModel / setTraceId / setEffortLevel / setGoalState / setExecutionTarget,
 * 以及 duck-typed 的 setToolsets / setCodexRoute)。任一 engine adapter(或它
 * 委派的内核 runner)少一个:
 *   - 硬调面缺失  → TypeError 抛在 turn 启动路径 → turn 永不 complete →
 *     用户永远卡在"思考中"(2026-05-11 setTraceId 实例、setModel 实例);
 *   - duck-typed 面缺失 → `typeof f === 'function'` 守卫把它**静默跳过** →
 *     模型路由 / toolsets 不生效,用户拿到的是**另一个模型/另一套工具**的回答,
 *     且没有任何报错。这比 TypeError 更难发现。
 *
 * 同型 bug 已出现三次。codexAppServerRunner.ts 的注释一直写着
 * "runnerContractParity.test.ts 会先把谁漏 parity 暴露出来" —— 但那个文件在仓内
 * **不存在**(丢失于某次重构)。本文件即其重建版。
 *
 * ── 为什么 typecheck 不够 ────────────────────────────────────────────────
 *   1. duck-typed 调用点写作 `(session.runner as any).setCodexRoute` —— 类型系统
 *      完全看不见,重命名/删除不会红,只会静默失效;
 *   2. adapter 的 mutator 多半是**委派**给内部内核(CcbAdapter→SubprocessRunner,
 *      CodexAdapter→CodexAppServerRunner)。委派链上任一环缺方法只在**运行时**炸,
 *      而 adapter 支持测试注入 kernelOverride,fake 内核会让类型侧看起来齐全。
 *   本门用**真实内核**构造 adapter 并真的调每个 mutator,所以委派链断裂立刻现形。
 *
 * ── 门的三个权威源(都不是手抄清单)──────────────────────────────────────
 *   A. 调用点清单:从 sessionManager.ts 源码提取 `session.runner.setX(` 与
 *      `(session.runner as any).setX` 两种形态(硬调 / duck-typed 分开)。
 *   B. 实现清单:engine registry 的**运行时**注册表(registeredEngines()),
 *      新增 engine 自动纳入,不登记探针即红。
 *   C. 探针表:每个 mutator 的benign 入参 + 可观测 getter(有 getter 的必须读回,
 *      证明"真的落到内核"而不是被吞)。
 *
 * 断言只针对**行为契约**(方法可调用 / 值可读回 / duck-typed 面按引擎声明存在),
 * 不锁任何实现细节(不断言委派写法、不断言字面排列)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/runnerMandatoryMutatorParity.test.ts
 */

import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

// 导入即注册(adapter 模块底部各自 registerEngine)。
import '../engine/ccbAdapter.js'
import '../engine/codexAdapter.js'
import '../engine/grokAdapter.js'
import '../engine/zcodeAdapter.js'
import type { EngineAdapter } from '../engine/engineAdapter.js'
import { type EngineCreateOpts, createEngine, registeredEngines } from '../engine/registry.js'

const here = dirname(fileURLToPath(import.meta.url))
const sessionManagerSource = readFileSync(join(here, '..', 'sessionManager.ts'), 'utf8')

/** 硬调面:缺方法 = TypeError = 用户卡"思考中"。 */
const HARD_CALLED_MUTATORS = [
  ...new Set(
    [...sessionManagerSource.matchAll(/session\.runner\.(set[A-Za-z0-9]*)\(/g)].map((m) => m[1]!),
  ),
].sort()

/** duck-typed 面:缺方法 = 静默跳过 = 用户拿到错模型/错工具集的回答。 */
const DUCK_TYPED_MUTATORS = [
  ...new Set(
    [...sessionManagerSource.matchAll(/\(session\.runner as any\)\.(set[A-Za-z0-9]*)/g)].map(
      (m) => m[1]!,
    ),
  ),
].sort()

interface MutatorProbe {
  /** benign 入参(不触发重启/远端能力,只验证可调用 + 落值)。 */
  arg: unknown
  /** 配套 getter 名;有则必须读回,证明 mutator 真的抵达内核而不是被吞。 */
  getter?: string
  /** 读回期望值(默认 = arg)。 */
  expected?: unknown
  /** mutator 返回 Promise 时置 true(await 之,拒绝即红)。 */
  async?: boolean
  /**
   * duck-typed mutator 的**按引擎语义**期望:列出必须实现它的 engineId。
   * 不在表里的引擎允许缺失(如 CCB 没有 codex provider route 概念)。
   */
  requiredOnEngines?: readonly string[]
}

/**
 * 探针表 —— 每个被 sessionManager 调用的 mutator 必须在此登记。新增调用点却不登记
 * 即红(见 "调用点全部登记" 用例):这正是把"新增 mutator 必须全 engine 对齐"变成
 * 门禁而不是口头约定的地方。
 */
const MUTATOR_PROBES: Record<string, MutatorProbe> = {
  // 硬调面
  setModel: { arg: 'glm-5.2', getter: 'model' },
  setEffortLevel: { arg: 'medium', getter: 'effortLevel' },
  setTraceId: { arg: 'trace-parity-1' }, // adapter 不暴露 getter,只验可调用
  setGoalState: { arg: null, async: true },
  // remote 目标是 SubprocessRunner 私有能力,codex 会拒并保持 local ——
  // 用 local 探针才是两个引擎共同的契约面。
  setExecutionTarget: { arg: { kind: 'local' }, getter: 'executionTarget' },
  // duck-typed 面
  setToolsets: {
    arg: ['core'],
    getter: 'toolsets',
    // 两个引擎都必须有:sessionManager 的 typeof 守卫会把缺失静默降级成
    // "toolsets 未生效"(用户少了工具却没有任何提示)。
    requiredOnEngines: ['ccb', 'codex'],
  },
  setCodexRoute: {
    arg: null,
    // codex 专属:缺失 = master 下发的 provider 路由被静默丢弃(计费/账号组错位)。
    // CCB 无此概念,允许缺失。
    requiredOnEngines: ['codex'],
  },
  setGrokRoute: {
    arg: null,
    // grok 专属:缺失 = master 下发的订阅 relay 路由被静默丢弃,turn 会在
    // provider spawn 前失败。CCB/Codex 无此概念,允许缺失。
    requiredOnEngines: ['grok'],
  },
  setZcodeRoute: {
    arg: null,
    // zcode 专属:缺失 = master mint 的本地 relay token 路由被静默丢弃。
    requiredOnEngines: ['zcode'],
  },
}

function makeOpts(sessionKey: string): EngineCreateOpts {
  return {
    sessionKey,
    agentId: 'main',
    agentBaseDir: tmpdir(),
    cwd: tmpdir(),
    model: 'glm-5.2',
  } as unknown as EngineCreateOpts
}

/** 真实内核(不注入 fake)—— 委派链断裂必须在这里现形。 */
function buildAdapter(engineId: string): EngineAdapter {
  const adapter = createEngine(engineId, makeOpts(`agent:main:webchat:dm:parity-${engineId}`))
  // 构造期 runner 只挂 listener、不 spawn;为防 stray 'error' 事件让进程退出,兜个空监听。
  adapter.on('error', () => {})
  return adapter
}

describe('runner mandatory-mutator parity — 权威源有效性', () => {
  it('sessionManager 调用点提取锚点有效', () => {
    // 锚点若被未来重构打空(如把 session.runner 换成局部变量),整个门会静默失效 —— 先炸。
    for (const core of ['setModel', 'setTraceId', 'setExecutionTarget', 'setGoalState']) {
      assert.ok(
        HARD_CALLED_MUTATORS.includes(core),
        `sessionManager 硬调 mutator 提取结果缺少 ${core} —— 提取锚点已失效,` +
          '本门会静默变空,请修正正则(或把调用收口到显式清单后改为 import)',
      )
    }
    assert.ok(
      DUCK_TYPED_MUTATORS.length > 0,
      'duck-typed(as any)mutator 提取结果为空 —— 锚点已失效',
    )
  })

  it('每个调用点都在探针表里登记(新增 mutator 不登记即红)', () => {
    const unregistered = [...HARD_CALLED_MUTATORS, ...DUCK_TYPED_MUTATORS].filter(
      (name) => !(name in MUTATOR_PROBES),
    )
    assert.deepEqual(
      unregistered,
      [],
      `sessionManager 新增了对 runner 的 mutator 调用但未登记探针:${unregistered.join(', ')};` +
        '修法=在 MUTATOR_PROBES 补一条(benign 入参 + 可读回的 getter),' +
        '这样"每个 engine 都实现了它"才有门在守。',
    )
  })

  it('engine 注册表可枚举且含全部生产引擎', () => {
    const engines = registeredEngines()
    for (const id of ['ccb', 'codex', 'grok', 'zcode']) {
      assert.ok(engines.includes(id), `engine registry 缺少 ${id} —— 注册副作用或权威源已变`)
    }
  })
})

describe('runner mandatory-mutator parity — 每个 engine × 每个 mutator', () => {
  for (const engineId of registeredEngines()) {
    it(`${engineId}: 硬调 mutator 全部可调用且落值(缺一个 = turn 卡死)`, async () => {
      const adapter = buildAdapter(engineId) as unknown as Record<string, unknown>
      for (const name of HARD_CALLED_MUTATORS) {
        const probe = MUTATOR_PROBES[name]!
        const fn = adapter[name]
        assert.equal(
          typeof fn,
          'function',
          `${engineId} adapter 缺少 ${name} —— sessionManager 无条件硬调它,` +
            'turn 启动即 TypeError,用户卡在"思考中"',
        )
        // 真的调:委派给内部内核的那一环若缺方法,只有这里能抓到。
        if (probe.async) {
          await (fn as (a: unknown) => Promise<unknown>).call(adapter, probe.arg)
        } else {
          ;(fn as (a: unknown) => void).call(adapter, probe.arg)
        }
        if (probe.getter) {
          assert.deepEqual(
            adapter[probe.getter],
            probe.expected ?? probe.arg,
            `${engineId}.${name}() 调用后 ${probe.getter} 没有反映新值 —— ` +
              'mutator 被吞(未抵达内核),用户的模型/档位/执行目标切换不会生效',
          )
        }
      }
      // adapter 被断言成 Record<string, unknown>,所以 shutdown 的静态类型是 {} ——
      // 直接 .call 过不了 tsc。这里显式收窄成"可选的零参函数"再调。
      const shutdown = adapter.shutdown
      if (typeof shutdown === 'function') await (shutdown as () => unknown).call(adapter)
    })

    it(`${engineId}: duck-typed mutator 按引擎语义齐备(缺一个 = 静默用错模型/工具)`, async () => {
      const adapter = buildAdapter(engineId) as unknown as Record<string, unknown>
      for (const name of DUCK_TYPED_MUTATORS) {
        const probe = MUTATOR_PROBES[name]!
        const required = probe.requiredOnEngines?.includes(engineId) ?? false
        const fn = adapter[name]
        if (!required) {
          // 允许缺失(语义上不适用);若实现了也必须真的能调,不许留一个会抛的桩。
          if (typeof fn !== 'function') continue
        } else {
          assert.equal(
            typeof fn,
            'function',
            `${engineId} adapter 缺少 ${name} —— sessionManager 用 ` +
              '`typeof f === "function"` 守卫调它,缺失会被**静默跳过**:' +
              '不报错、不重试,用户直接拿到错模型/缺工具的回答',
          )
        }
        if (probe.async) {
          await (fn as (a: unknown) => Promise<unknown>).call(adapter, probe.arg)
        } else {
          ;(fn as (a: unknown) => void).call(adapter, probe.arg)
        }
        if (probe.getter) {
          assert.deepEqual(
            adapter[probe.getter],
            probe.expected ?? probe.arg,
            `${engineId}.${name}() 调用后 ${probe.getter} 没有反映新值(mutator 被吞)`,
          )
        }
      }
      // adapter 被断言成 Record<string, unknown>,所以 shutdown 的静态类型是 {} ——
      // 直接 .call 过不了 tsc。这里显式收窄成"可选的零参函数"再调。
      const shutdown = adapter.shutdown
      if (typeof shutdown === 'function') await (shutdown as () => unknown).call(adapter)
    })
  }
})
