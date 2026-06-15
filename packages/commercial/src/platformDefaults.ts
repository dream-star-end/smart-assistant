// 平台全局默认模型 —— master 侧单一权威常量(零依赖 leaf 模块)。
//
// boss 2026-06-15 决策：glm-5.1(火山方舟 Ark)设为平台全局默认模型。
//
// 注意：runtime 容器入口 agent-sandbox/runtime/entrypoint.ts 因 Dockerfile 单独 COPY 进镜像、
// 无法 import 本模块(模块解析会失败)，故 entrypoint **本地另写一份** COMMERCIAL_DEFAULT_MODEL/
// PROVIDER 常量。两源一致性由 __tests__/runtimeEntrypointPolicy.test.ts 文本断言守护。
// 改这里的值时，必须同步改 entrypoint.ts 的本地常量，否则该测试会 fail。

export const PLATFORM_DEFAULT_MODEL = "glm-5.1";
export const PLATFORM_DEFAULT_PROVIDER = "ark";
