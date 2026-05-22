# KNOWN STALE TESTS — Phase 1 audit 输出 / Phase 5 收尾

> **范围**:Phase 0 baseline 跑出 10 个失败,Phase 1.C 已修 4 个 v3Supervisor mount-增量
> 失败 (`v3Supervisor.test.ts:560/1270/2497/2523`,详见 `PHASE1-TEST-COVERAGE-PLAN.md`
> 1.D 类 A);本文件登记**剩下 5 个真 stale 测试** —— 行为已演化、test 期望旧值,
> 修法跟 R6.11 ledger / 主线重构无耦合,统一推到 **Phase 5** 收尾时统一翻新。
>
> 不修但**显式登记**的理由(Codex round 3 反馈采纳):
> 1. Phase 1 baseline 报告里若混着 stale,后续 PR 会被这些误报噪音淹掉真正回归
> 2. Phase 5 收尾时一次性翻新比每次见到顺手乱改更可控(避免行为问题伪装成测试问题)
> 3. 留个权威列表,新人 onboarding 看到这些失败不再问「是不是我搞坏的」

---

## 5 truly-stale 测试登记

| # | 测试位置 | 现象 | 根因(代码已演化方向) | Phase 5 修法 |
|---|---|---|---|---|
| 1 | `src/__tests__/anthropicProxy.test.ts:252` `enforceFieldByteBudgets > tools 序列化超 64KB → 413` | `assert.throws` 拿不到 expected exception("Missing expected exception") | 64KB tools threshold 阈值或拒绝条件被改宽 / 取消;实现已不再抛 | 读 `anthropicProxy.ts enforceFieldByteBudgets`,确认当前真实阈值与失败码,改测试期望;或测试目标从「64KB 必抛」改为「阈值边界回归」 |
| 2 | `src/__tests__/rateLimit.test.ts:54` `checkRateLimit > calls 2..5: still allowed, EXPIRE NOT called again in same window` | 期望 EXPIRE 调用次数=1 实际=5 | 实现改成 every-call EXPIRE(每次 INCR 都 refresh TTL,而非仅首次 INCR 设);保留旧 first-call-only 期望 | 决定哪种语义对(every-call 更安全防 TTL drift,first-call-only 省 redis 调用次数);要么改测试 expected=5,要么改实现回 first-call-only |
| 3 | `src/__tests__/rateLimit.test.ts:78` `checkRateLimit > rolling into next window resets counter` | 期望新 window EXPIRE 总数=2 实际=6 | 同 #2,新 window 也每次 INCR 都 refresh TTL | 跟 #2 同源,一次性修 |
| 4 | `src/__tests__/v3IdleSweep.test.ts:302` `runIdleSweepTick > 单行 stopAndRemove 抛 → errors 累计,其他行继续 sweep` | 期望 `r.swept===1` 实际=2(line 302 strictEqual fail) | `stopAndRemoveV3Container` 已升级成 "stop 抛错仍尝试 force remove;remove 成功 OR 404 即视为清理成功"(`v3supervisor.ts:2241` 注释明确写;`force: true` remove 容错覆盖 daemon 抖动 / 容器自启)。Mock 只让 `stop` 抛,force `remove` 仍走 OK 路径 → wrapper 不再向上抛 → 该行 swept 计数 += 1。所以 swept=2、errors=0、`d-20` 行也被翻 vanished — 整条 fixture 都跟新实现反着 | 决定测试目标:要么改测试期望成「stop 抛 + force-remove OK = 清理成功,swept=2,errors=0,d-20 翻 vanished,captured.stopped=['d-21'](d-20 stop 抛所以没 captured),captured.removed=['d-20','d-21']」,要么再加一条**只让 remove 也抛**的 case 来覆盖"真失败"语义;两条 case 都要(stop抛+remove成功 vs stop抛+remove也抛),旧那条 single-throw=single-error 直觉已废 |
| 5 | `src/admin/__tests__/metricsV3_2I2.test.ts:263` `V3 2I-2 — anthropicProxy + bridge histograms/counters > renderPrometheus 全局结构 > v1 + v3 系列都出现一次,以 newline 结尾` | 期望 HELP 行总数=13 实际=16 | renderPrometheus 输出结构扩了 3 个新 metric 系列(超出 `4 v1 counter + 6 v3 + 2 gauge + 1 v1.0.3 precheck_capped`);**注释字面值已过期** | 跑 `renderPrometheus()` 实际输出 → grep `^# HELP`,把新增 3 个 metric 列入注释 + expected 改 16;或改成"动态统计 v1/v3 prefix 数量"风格不锁绝对值 |

---

## 不在本文件范围(也不在 Phase 5)

- `userChatBridge.test.ts:399` close(1011) vs (1009) —— **是行为问题不是 stale**,
  挂 Phase 1 plan 「类 B」由 boss 决断处理,不归本文件。

## Phase 5 工作量估计

5 个测试都是单文件单 assertion 级 fix,加起来 1-2 小时实际编辑量;但 #2/#3 (rateLimit)
跟 #1 (anthropicProxy) 是「测试 vs 实现谁对」的语义问题,需要先看实现意图再决定方向,
**不是机械改 expected**。Phase 5 collator 必须连带读相关源代码注释和近期 git log,
不要无脑改测试 expected 让它过 —— 那是埋雷。

---

> 维护规则:
> - 任一项被 Phase 5(或其它先发车的 PR)实际修复 → 从本文件删除该行,在 commit msg
>   引用本文件路径表明 "Phase 5 partial drain"
> - 新发现 stale 测试 → 也来这里加,**不要**散落在各 PR commit msg
> - 本文件**只**记 truly-stale(行为演化 + test 期望旧值,且与主线重构无耦合)。
>   行为问题、设计争议、ledger-coupled 不来这里
