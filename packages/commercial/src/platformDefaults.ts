// 平台全局默认模型 —— master 侧单一权威常量(零依赖 leaf 模块)。
//
// **2026-06-17 改为 glm-5.2(火山方舟 ark)。** boss 决定:替换掉 glm-5.1、团队队长(=平台默认)全切 glm-5.2。
// ⚠️ 已知运营权衡:glm-5.x 走火山方舟【北京】端点,从 master(吉隆坡)跨境进中国大陆,链路间歇抖动
// (connect 时快时慢、长 turn 撞上瞬时丢包 → fetch failed/terminated → 用户"半天没反应")—— 2026-06-16
// 正因此把队长撤回 MiniMax-M3。boss 2026-06-17 明确接受该风险、切回火山系 glm-5.2;部署 smoke 须重点
// 验证队长长 turn 稳定性。glm-5.1 退出 picker(定价 visibility=hidden)但仍可路由(兼容存量会话)。
//
// 注意：runtime 容器入口 agent-sandbox/runtime/entrypoint.ts 因 Dockerfile 单独 COPY 进镜像、
// 无法 import 本模块(模块解析会失败)，故 entrypoint **本地另写一份** COMMERCIAL_DEFAULT_MODEL/
// PROVIDER 常量。两源一致性由 __tests__/runtimeEntrypointPolicy.test.ts 文本断言守护。
// 改这里的值时，必须同步改 entrypoint.ts 的本地常量，否则该测试会 fail。

export const PLATFORM_DEFAULT_MODEL = "glm-5.2";
export const PLATFORM_DEFAULT_PROVIDER = "ark";
// 团队模式隐藏审查员的 master 侧镜像常量。runtime entrypoint 因 Docker COPY 限制
// 仍本地定义 COMMERCIAL_HIDDEN_REVIEWER_*；一致性由 runtimeEntrypointPolicy.test.ts 守护。
export const PLATFORM_HIDDEN_REVIEWER_MODEL = "glm-5.2";
export const PLATFORM_HIDDEN_REVIEWER_PROVIDER = "ark";
