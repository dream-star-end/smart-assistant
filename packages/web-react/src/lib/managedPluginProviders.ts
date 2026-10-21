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
export type ManagedQrProvider = 'knowledge-planet' | 'weibo' | 'zhihu' | 'bili-account' | 'douyin'

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
  /** 个别失败码的专属说明（优先于 challengeText）；没有就不填。 */
  codeTexts?: Readonly<Record<string, string>>
  /** 生成二维码前额外展示的提示（如账号风控风险）；没有就不填。 */
  setupNotice?: string
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
  // OCV5-402: 只读;字幕、收藏夹、观看历史。
  'bili-account': {
    slug: 'bili-account',
    label: '哔哩哔哩账号',
    scanner: '哔哩哔哩 App',
    qrAlt: '哔哩哔哩登录二维码',
    authorizeLabel: 'B 站扫码授权',
    qrRelink: true,
    challengeCodes: ['BILI_ACCOUNT_UPSTREAM_CHALLENGE', 'BILI_ACCOUNT_LOGIN_UNSUPPORTED'],
    challengeText:
      'B 站触发了风控验证或返回了无法安全保存的登录凭据，本次授权已安全停止。请稍后再试；若反复出现，请联系管理员。',
    start: (auth, relinkAccountId) =>
      relinkAccountId
        ? api.startBiliAccountSetup(auth, relinkAccountId)
        : api.startBiliAccountSetup(auth),
    get: (auth, sessionId) => api.getBiliAccountSetup(auth, sessionId),
    qr: (auth, sessionId) => api.getBiliAccountSetupQr(auth, sessionId),
    cancel: (auth, sessionId) => api.cancelBiliAccountSetup(auth, sessionId),
  },
  // OCV5-553: 个人抖音号扫码（抖音创作者服务平台的官方二维码）。setup 的 errorCode 是 worker 原始码。
  douyin: {
    slug: 'douyin',
    label: '抖音',
    scanner: '抖音 App',
    qrAlt: '抖音登录二维码',
    authorizeLabel: '抖音扫码授权',
    qrRelink: true,
    challengeCodes: ['UPSTREAM_CHALLENGE'],
    challengeText:
      '抖音触发了验证码或风控，本次授权已安全停止，系统不会尝试绕过。请稍后再试；若反复出现，请先在抖音 App 确认账号状态正常。',
    codeTexts: {
      VERIFICATION_REQUIRED:
        '抖音要求账号本人完成身份验证（如短信验证），本次授权未生效。请先在手机抖音上完成验证，再重新扫码。',
      LOGIN_STATE_UNSUPPORTED:
        '抖音返回的登录凭据无法安全保存，本次登录未生效。这是平台侧限制，请不要反复扫码，并联系管理员。',
    },
    setupNotice:
      '抖音插件以浏览器自动化方式使用你的个人抖音账号，这种方式不在抖音官方开放能力之内，可能触发抖音风控，严重时限制或封禁账号，风险由你本人承担。遇到验证码或本人验证时插件会立即停止，不会尝试绕过。抖音二维码通常需要约 1 分钟才能生成。',
    start: (auth, relinkAccountId) =>
      relinkAccountId ? api.startDouyinSetup(auth, relinkAccountId) : api.startDouyinSetup(auth),
    get: (auth, sessionId) => api.getDouyinSetup(auth, sessionId),
    qr: (auth, sessionId) => api.getDouyinSetupQr(auth, sessionId),
    cancel: (auth, sessionId) => api.cancelDouyinSetup(auth, sessionId),
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
  if (slug === 'weibo' || slug === 'zhihu' || slug === 'bili-account' || slug === 'douyin')
    return MANAGED_PLUGIN_PROVIDERS[slug]
  return MANAGED_PLUGIN_PROVIDERS['knowledge-planet']
}

export function managedSetupFailureText(
  provider: ManagedPluginProvider,
  setup: Pick<KnowledgePlanetSetupView, 'status' | 'errorCode'>,
): string {
  if (setup.status === 'expired') return '二维码已过期，请重新授权。'
  const codeText = setup.errorCode ? provider.codeTexts?.[setup.errorCode] : undefined
  if (codeText) return codeText
  if (
    provider.challengeText &&
    setup.errorCode &&
    provider.challengeCodes.includes(setup.errorCode)
  )
    return provider.challengeText
  return '本次授权未完成，请重试。'
}
