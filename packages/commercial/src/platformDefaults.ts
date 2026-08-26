// 平台全局默认模型 —— master 侧单一权威常量(零依赖 leaf 模块)。
//
// **2026-08-22 改为 glm-5.3-zai(Z.AI Coding Plan)。** ark 上的 glm-5.3 仍 active,但上游持续 400,
// 不能再当平台默认 / seed 绑定 / 本地 fallback 头。glm-5.1/5.2 仍退出默认执行面。
// ⚠️ 长 turn 仍须在每次默认切换发布中做真实工具循环与计费 smoke。ark glm-5.3 仅在独立下线批
// 完成前保留目录条目,不作为执行默认。
//
// ⚠️ 权威归属(模型权威批次 §5,2026-07-12 起)：
//   - 容器侧 seed agent 的执行三元组(model/provider/runnerKind)权威 = bundle 内的
//     agent-sandbox/platform-runtime/seed/platform-seed.yaml **声明**(schema v2)。entrypoint 已
//     删除本地 COMMERCIAL_DEFAULT_MODEL/PROVIDER 等常量，不再与本文件双端硬编码。
//   - **阶段 A(当前)**：本文件常量仍是 master 侧判定源，且**必须与 yaml 声明字面相等** ——
//     一致性锚测试 __tests__/runtimeEntrypointPolicy.test.ts 锁死；改这里的值必须同步改
//     platform-seed.yaml(main / hidden-reviewer 两处)，否则测试红。
//   - **阶段 B(flag OC_SEED_AUTHORITY_BY_REV=1)**：master 改为按容器 label 上的 bundle_rev 读
//     该 rev 的 seed 声明(ws/seedDeclarationLoader.ts)，本文件常量退化为 flag 未开时的回落路径
//     与一致性锚的对照值。届时“改模型”只需改 yaml 一处 + 走 bundle 滚动。

export const PLATFORM_DEFAULT_MODEL = "glm-5.3-zai";
export const PLATFORM_DEFAULT_PROVIDER = "zai";
// 团队模式隐藏审查员的 master 侧常量；与 platform-seed.yaml 的 hidden-reviewer 声明一致性
// 同样由 runtimeEntrypointPolicy.test.ts 的一致性锚守护。
export const PLATFORM_HIDDEN_REVIEWER_MODEL = "glm-5.3-zai";
export const PLATFORM_HIDDEN_REVIEWER_PROVIDER = "zai";
