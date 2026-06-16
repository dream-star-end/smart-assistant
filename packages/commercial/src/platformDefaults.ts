// 平台全局默认模型 —— master 侧单一权威常量(零依赖 leaf 模块)。
//
// 2026-06-16 改回 MiniMax-M3(新加坡端点)。原因：glm-5.1 走火山方舟【北京】端点,从 master(吉隆坡)
// 跨境进中国大陆,链路间歇抖动(connect 时快时慢、长 turn 撞上瞬时丢包 → fetch failed/terminated →
// 用户"半天没反应")。MiniMax-M3 端点在新加坡(connect ~0.02s 稳)+ 512k 窗口 + 已开思考,做默认更稳。
// glm-5.1 仍保留在模型选择器(可选),且 coder 仍显式用 glm-5.1(coding plan;coder turn 较短、暴露低)。
//
// 注意：runtime 容器入口 agent-sandbox/runtime/entrypoint.ts 因 Dockerfile 单独 COPY 进镜像、
// 无法 import 本模块(模块解析会失败)，故 entrypoint **本地另写一份** COMMERCIAL_DEFAULT_MODEL/
// PROVIDER 常量。两源一致性由 __tests__/runtimeEntrypointPolicy.test.ts 文本断言守护。
// 改这里的值时，必须同步改 entrypoint.ts 的本地常量，否则该测试会 fail。

export const PLATFORM_DEFAULT_MODEL = "MiniMax-M3";
export const PLATFORM_DEFAULT_PROVIDER = "minimax";
