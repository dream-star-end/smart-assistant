import { api } from './api'
import type { KnowledgePlanetSetupView } from './connectors'
import type { AuthSession } from './types'

/**
 * 浏览器插件（受管浏览器扫码登录）的前端注册表 —— 每个 provider 一条数据（OCV5-379）。
 *
 * 改造前同一组判断散落在 ConnectorsTab 的 6 个 `if (provider === 'weibo') … else if 'zhihu'`
 * 函数里（名称 / 扫码客户端 / 二维码替代文本 / 失败文案 / 能否重新扫码 / 四个 setup 接口），
 * 新增一个浏览器插件要改 6 处。现在只加一条注册项。
 *
 * 未登记的 slug 回落到知识星球（与改造前 `managedQrProvider` 的兜底一致：知识星球是最早的
 * 受管浏览器插件，其余 slug 都是后来显式加的分支）。
 */
export type ManagedQrProvider = 'knowledge-planet' | 'weibo' | 'zhihu'

export type ManagedPluginProvider = {
  slug: ManagedQrProvider
  label: string
  /** 用来扫码的客户端（「请用 xx 扫码」）。 */
  scanner: string
  qrAlt: string
  authorizeLabel: string
  /** 失效账号能否在账号行上原地重新扫码（换登录不换账号）。 */
  qrRelink: boolean
  /** 上游风控 / 安全验证的错误码 → 专属说明；不在表里的走通用「请重试」。 */
  challengeCodes: readonly string[]
  challengeText: string | null
  start: (auth: AuthSession, relinkAccountId?: string) => Promise<KnowledgePlanetSetupView>
  get: (auth: AuthSession, sessionId: string) => Promise<KnowledgePlanetSetupView>
  qr: (auth: AuthSession, sessionId: string) => ReturnType<typeof api.getWeiboSetupQr>
  cancel: (auth: AuthSession, sessionId: string) => Promise<KnowledgePlanetSetupView>
}

const MANAGED_PLUGIN_PROVIDERS: Record<ManagedQrProvider, ManagedPluginProvider> = {
  weibo: {
    slug: 'weibo',
    label: '微博',
    scanner: '微博客户端',
    qrAlt: '微博登录二维码',
    authorizeLabel: '微博扫码授权',
    qrRelink: true,
    challengeCodes: ['UPSTREAM_FAILED'],
    challengeText:
      '微博触发了安全验证，本次授权已安全停止。请先在微博 App 完成安全验证并确认账号可正常使用，再重新授权；若仍反复出现，请稍后再试。',
    // 不带 relink 时保持单参调用（与改造前逐字一致，接口按参数个数区分新建 / 重新登录）。
    start: (auth, relinkAccountId) =>
      relinkAccountId ? api.startWeiboSetup(auth, relinkAccountId) : api.startWeiboSetup(auth),
    get: (auth, sessionId) => api.getWeiboSetup(auth, sessionId),
    qr: (auth, sessionId) => api.getWeiboSetupQr(auth, sessionId),
    cancel: (auth, sessionId) => api.cancelWeiboSetup(auth, sessionId),
  },
  zhihu: {
    slug: 'zhihu',
    label: '知乎',
    scanner: '知乎 App',
    qrAlt: '知乎登录二维码',
    authorizeLabel: '知乎扫码授权',
    qrRelink: true,
    challengeCodes: ['UPSTREAM_FAILED', 'ZHIHU_UPSTREAM_CHALLENGE'],
    challengeText:
      '知乎触发了风控或安全验证，本次授权已安全停止。请先在知乎 App 完成安全验证并确认账号可正常使用，再重新授权；若仍反复出现，请稍后再试。',
    start: (auth, relinkAccountId) =>
      relinkAccountId ? api.startZhihuSetup(auth, relinkAccountId) : api.startZhihuSetup(auth),
    get: (auth, sessionId) => api.getZhihuSetup(auth, sessionId),
    qr: (auth, sessionId) => api.getZhihuSetupQr(auth, sessionId),
    cancel: (auth, sessionId) => api.cancelZhihuSetup(auth, sessionId),
  },
  'knowledge-planet': {
    slug: 'knowledge-planet',
    label: '知识星球',
    scanner: '微信',
    qrAlt: '知识星球微信登录二维码',
    authorizeLabel: '微信扫码授权',
    qrRelink: false,
    challengeCodes: [],
    challengeText: null,
    // 知识星球没有「原地重新登录」：始终新建授权会话。
    start: (auth) => api.startKnowledgePlanetSetup(auth),
    get: (auth, sessionId) => api.getKnowledgePlanetSetup(auth, sessionId),
    qr: (auth, sessionId) => api.getKnowledgePlanetSetupQr(auth, sessionId),
    cancel: (auth, sessionId) => api.cancelKnowledgePlanetSetup(auth, sessionId),
  },
}

export function managedPluginProvider(slug: string | undefined): ManagedPluginProvider {
  if (slug === 'weibo' || slug === 'zhihu') return MANAGED_PLUGIN_PROVIDERS[slug]
  return MANAGED_PLUGIN_PROVIDERS['knowledge-planet']
}

export function managedSetupFailureText(
  provider: ManagedPluginProvider,
  setup: Pick<KnowledgePlanetSetupView, 'status' | 'errorCode'>,
): string {
  if (setup.status === 'expired') return '二维码已过期，请重新授权。'
  if (
    provider.challengeText &&
    setup.errorCode &&
    provider.challengeCodes.includes(setup.errorCode)
  )
    return provider.challengeText
  return '本次授权未完成，请重试。'
}
