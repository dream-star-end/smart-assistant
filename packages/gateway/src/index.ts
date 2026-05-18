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
export * from './rateLimit.js'

// Per-model extra system prompt 注入钩子 — commercial 启动时 setModelHintProvider(...)
// 注册查询函数;personal 不调,buildModelHintSlot 始终 noop。Public surface 与 v3 对齐,
// 同账号下 prompt 拼装路径可比对、防风控形状漂移。
export { setModelHintProvider, type ModelHintProvider } from './promptSlots.js'
