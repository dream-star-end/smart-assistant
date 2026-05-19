/**
 * V3 Phase 4(2026-05-18 anthropicProxy.ts 三层拆分 §4.8):退化为 façade。
 *
 * 历史:本文件曾包含 1700 行 monolith handler。Phase 1-4 物理切分后:
 *   - billing 子模块 → `../billing/proxyBilling.ts`(Phase 1)
 *   - upstream session 子模块 → `./proxy/upstream.ts`(Phase 3)
 *   - helpers / 常量 / schema / 类型 → `./proxy/shared.ts`(Phase 4 §4.5)
 *   - upstream round-trip(abort + fetch + SSE + finalize + broadcast)→ `./proxy/core.ts`(§4.6)
 *   - handler 工厂(0-9 步 + 调 core)→ `./proxy/index.ts`(§4.7)
 *
 * 本文件保留下来仅为**向后兼容**:所有外部 import 路径(commercial/index.ts、
 * __tests__/anthropicProxy.test.ts、__tests__/anthropicProxy.integ.test.ts)
 * 继续生效。`billing/proxyBilling.ts` 的 `UsageObservation` 类型 import 已
 * 改成直指 `../http/proxy/shared.js`(避免和 façade re-export shared 形成 cycle)。
 *
 * 新代码请直接 import from `./proxy/index.js` / `./proxy/shared.js` /
 * `./proxy/core.js` / `./proxy/upstream.js`。
 *
 * 见 docs/V3_ANTHROPIC_PROXY_SPLIT_PLAN_2026-05-18.md §4.8。
 */

// helpers / 常量 / schema / 类型 / 测试 re-export(_parseSseEvent / _UsageObserver)
export * from "./proxy/shared.js";

// handler 工厂
export { makeAnthropicProxyHandler } from "./proxy/index.js";
