# KNOWN STALE TESTS — Phase 1 audit 输出 / Phase 5 收尾

> **范围**:Phase 0 baseline 跑出 10 个失败,Phase 1.C 已修 4 个 v3Supervisor mount-增量
> 失败 (`v3Supervisor.test.ts:560/1270/2497/2523`,详见 `PHASE1-TEST-COVERAGE-PLAN.md`
> 1.D 类 A);其余 5 个真 stale 测试已在 **Phase 5 commit `<本 PR>`** 一次性 drain 完毕,
> 故本表为空。新发现 stale 测试请按下方维护规则继续追加。
>
> 不修但**显式登记**的理由(Codex round 3 反馈采纳,保留作 onboarding 说明):
> 1. baseline 报告里若混着 stale,后续 PR 会被这些误报噪音淹掉真正回归
> 2. Phase 5 收尾时一次性翻新比每次见到顺手乱改更可控(避免行为问题伪装成测试问题)
> 3. 留个权威列表,新人 onboarding 看到这些失败不再问「是不是我搞坏的」

---

## Truly-stale 测试登记

_(空 — 5 项已于 Phase 5 全部 drain。历史登记可见 git log。)_

---

## 不在本文件范围(也不在 Phase 5)

- `userChatBridge.test.ts:399` close(1011) vs (1009) —— **是行为问题不是 stale**,
  挂 Phase 1 plan 「类 B」由 boss 决断处理,不归本文件。

---

> 维护规则:
> - 任一项被 Phase 5(或其它先发车的 PR)实际修复 → 从本文件删除该行,在 commit msg
>   引用本文件路径表明 "Phase 5 partial drain"
> - 新发现 stale 测试 → 也来这里加,**不要**散落在各 PR commit msg
> - 本文件**只**记 truly-stale(行为演化 + test 期望旧值,且与主线重构无耦合)。
>   行为问题、设计争议、ledger-coupled 不来这里
