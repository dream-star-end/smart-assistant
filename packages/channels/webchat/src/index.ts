// WebChat 不是真正的"外部渠道",而是 Gateway 自身的 WS server +
// 浏览器静态资源(packages/web)。本包只导出常量和类型,gateway 自动处理。

export const WEBCHAT_CHANNEL_NAME = 'webchat'
