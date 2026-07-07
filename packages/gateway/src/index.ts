export * from './server.js'
export * from './sessionManager.js'
export * from './subprocessRunner.js'
// M0 engine 适配层(EngineAdapter 契约 / 中立事件权威源 / registry / CCB 实现)
export * from './engine/engineEvents.js'
export * from './engine/engineAdapter.js'
export * from './engine/engineSessionId.js'
export * from './engine/registry.js'
export * from './engine/ccbAdapter.js'
export * from './router.js'
export * from './auth.js'
export * from './cron.js'
export * from './ccbMessageParser.js'
export * from './eventBus.js'
export * from './openaiCompat.js'
export * from './terminalBackend.js'
export * from './webhooks.js'
export * from './runLog.js'
export * from './logger.js'
export * from './metrics.js'
export * from './outboundRing.js'
export * from './rateLimit.js'
export * from './bridgeApiAllowlist.js'
// V3 P1.7 slice 7c — container 侧 wechat outbound 适配器(personal 不用)。
// cli launcher 在容器 env 全集时 `channelFactories.push(() => makeV3WechatOutboundAdapter({config}))`。
export {
  makeV3WechatOutboundAdapter,
  readV3WechatOutboundConfig,
  type V3WechatOutboundConfig,
} from './v3WechatOutbound.js'
// Per-model extra system prompt 注入钩子 — commercial 启动时 setModelHintProvider(...)
// 注册查询函数(查 PricingCache.extra_system_prompt)。Personal 不调即 noop。
// 仅 export setter + 类型,不暴露 promptSlots 内部 helper,避免被外部误依赖。
export { setModelHintProvider, type ModelHintProvider } from './promptSlots.js'
// Literature skill 注入钩子 — commercial 启动时 setLiteratureSkillProvider(...)
// 注册"读 DB → 返渲染好的 SKILLS_LITERATURE slot"查询函数。Personal 不调即 noop。
// 仅 export setter + 类型,不暴露内部 helper,避免外部误依赖 buildLiteratureSkillSlot()。
export { setLiteratureSkillProvider, type LiteratureSkillProvider } from './promptSlots.js'
// host 静态 provider 平台直连 key seam — commercial 启动时 setHostStaticProviderKeys(...)
// 注入平台静态 key 表(供 host 平台 agent 合成首帧解析到静态模型后 CCB 子进程直连上游)。
// Personal 不调即恒 null = 整块 no-op(settings.json 继续掌权,零行为变化)。见 hostStaticProviders。
export { setHostStaticProviderKeys } from './hostStaticProviders.js'
