// 平台全局默认模型 —— master 侧单一权威常量(零依赖 leaf 模块)。
//
// **2026-06-17 改为 glm-5.2(火山方舟 ark)。** boss 决定:替换掉 glm-5.1、团队队长(=平台默认)全切 glm-5.2。
// ⚠️ 已知运营权衡:glm-5.x 走火山方舟【北京】端点,从 master(吉隆坡)跨境进中国大陆,链路间歇抖动
// (connect 时快时慢、长 turn 撞上瞬时丢包 → fetch failed/terminated → 用户"半天没反应")—— 2026-06-16
// 正因此把队长撤回 MiniMax-M3。boss 2026-06-17 明确接受该风险、切回火山系 glm-5.2;部署 smoke 须重点
// 验证队长长 turn 稳定性。glm-5.1 退出 picker(定价 visibility=hidden)但仍可路由(兼容存量会话)。
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

export const PLATFORM_DEFAULT_MODEL = "glm-5.2";
export const PLATFORM_DEFAULT_PROVIDER = "ark";
// 团队模式隐藏审查员的 master 侧常量；与 platform-seed.yaml 的 hidden-reviewer 声明一致性
// 同样由 runtimeEntrypointPolicy.test.ts 的一致性锚守护。
export const PLATFORM_HIDDEN_REVIEWER_MODEL = "glm-5.2";
export const PLATFORM_HIDDEN_REVIEWER_PROVIDER = "ark";
