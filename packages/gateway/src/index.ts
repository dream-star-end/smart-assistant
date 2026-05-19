export * from './server.js'
export * from './sessionManager.js'
export * from './subprocessRunner.js'
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
