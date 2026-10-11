import type {
  ConnectorConnection,
  ConnectorProvider,
  ConnectorsResponse,
  DeclarativeCatalogEntry,
  DeclarativeManagementConnector,
  DeclarativeManagementResponse,
  PluginManagementResponse,
  RuntimePluginAccount,
  RuntimePluginCatalogEntry,
} from './connectors'

/**
 * 插件目录：产品层「插件」的**单一模型**（OCV5-379）。
 *
 * ── 名词表（用户可见文案的唯一口径）───────────────────────────────────────────
 *   插件   可以安装、授权后供助手调用的外部应用能力。API 插件（v1 手写 provider /
 *          声明式 connector）与浏览器插件（受管浏览器 runtime plugin）都叫插件。
 *          不再使用：连接器、应用连接、应用连接器、API 连接插件、市场插件、Plugin。
 *   账号   插件里绑定的一个登录，可以有多个。不再使用：插件账号、连接。
 *   AI 市场 发现、安装、发布的地方（侧栏短名「市场」）。不再使用：技能市场、插件市场。
 * 存储层 kind=`connector`、管理中心 tab id `connectors`、API 路径都是持久契约，不随之改名。
 *
 * ── 数据来源 ───────────────────────────────────────────────────────────────
 * 三套后端（v1 `/api/connectors`、声明式 management、浏览器插件 management）在这里合成
 * 一份 `PluginEntry[]`，管理中心「插件」和 AI 市场「插件」/「已安装」都按 slug 读它的状态。
 * 目录只描述**已有的插件**（内置 + 已安装 + 有账号）；未安装的市场条目仍以市场搜索为准，
 * 这里不负责「能装什么」。
 */

export type PluginAccountState = {
  tone: 'success' | 'warning' | 'danger'
  label: string
  needsReauth: boolean
}

/**
 * 浏览器插件账号状态的**唯一判据**（颜色与文案同源）。
 *
 * status 是最高优先判据；executable / 版本差异只在 status==='active' 时细分。
 * `needsReauth` 表示「重新扫码授权可以修好它」—— 只有这一类才在账号行内给出重新授权出口，
 * 「需先更新」这种要走更新流程的不给（否则扫完码还是不能用）。
 */
export function pluginAccountState(
  account: Pick<RuntimePluginAccount, 'status' | 'executable' | 'versionId'>,
  plugin: Pick<RuntimePluginCatalogEntry, 'updateAvailable' | 'installedCurrent' | 'versionId'>,
): PluginAccountState {
  if (account.status === 'error') return { tone: 'danger', label: '需重新授权', needsReauth: true }
  if (account.executable) return { tone: 'success', label: '可用', needsReauth: false }
  if (plugin.updateAvailable) return { tone: 'warning', label: '需先更新', needsReauth: false }
  if (plugin.installedCurrent && account.versionId !== plugin.versionId)
    return { tone: 'warning', label: '需重新授权', needsReauth: true }
  return { tone: 'warning', label: '当前不可用', needsReauth: false }
}

/**
 * API 插件的统一卡片模型：v1 手写 provider 与声明式 connector 归一到同一套契约。
 * system 决定绑定/解绑/能力标注走哪一套后端；slug 是去重键（声明式优先，因其权威且带
 * allowlist + pin）。
 */
export type UnifiedProvider =
  | { system: 'v1'; slug: string; label: string; description: string; v1: ConnectorProvider }
  | {
      system: 'declarative'
      slug: string
      label: string
      description: string
      decl: DeclarativeCatalogEntry | null
      management: DeclarativeManagementConnector
    }

export function unifyProviders(
  v1Providers: readonly ConnectorProvider[],
  management: readonly DeclarativeManagementConnector[],
): UnifiedProvider[] {
  const bySlug = new Map<string, UnifiedProvider>()
  for (const c of management) {
    bySlug.set(c.slug, {
      system: 'declarative',
      slug: c.slug,
      label: c.label,
      description: c.description,
      decl: c.contract,
      management: c,
    })
  }
  // v1 provider 仅当该 slug 未被声明式占据时加入。
  for (const p of v1Providers) {
    if (bySlug.has(p.id)) continue
    bySlug.set(p.id, {
      system: 'v1',
      slug: p.id,
      label: p.label,
      description: p.description,
      v1: p,
    })
  }
  const decl: UnifiedProvider[] = []
  const v1: UnifiedProvider[] = []
  for (const u of bySlug.values()) (u.system === 'declarative' ? decl : v1).push(u)
  return [...decl, ...v1]
}

/** 插件整体状态（市场卡片 / 已安装行的徽标）。 */
export type PluginState = 'connected' | 'needs-connect' | 'attention'

export type PluginEntry = {
  slug: string
  label: string
  description: string
  /** builtin = 平台预装（v1 provider 或声明式 installation=default），没有市场安装 / 卸载。 */
  origin: 'builtin' | 'market'
  runtime: 'api' | 'browser'
  accountCount: number
  state: PluginState
  /** 徽标文案：已连接 N 个账号 / 未连接 / 需重新授权 / 需先更新 / 当前不可用。 */
  stateLabel: string
  tone: 'success' | 'warning' | 'danger' | 'neutral'
  updateAvailable: boolean
}

export type PluginDirectoryInput = {
  v1?: ConnectorsResponse | null
  declarative?: DeclarativeManagementResponse | null
  runtime?: PluginManagementResponse | null
}

const connectedLabel = (n: number) => (n > 1 ? `已连接 ${n} 个账号` : '已连接')

function apiEntry(
  u: UnifiedProvider,
  connections: readonly Pick<ConnectorConnection, 'status'>[],
): PluginEntry {
  const management = u.system === 'declarative' ? u.management : null
  const base = {
    slug: u.slug,
    label: u.label,
    description: u.description,
    origin:
      management && management.installation !== 'default'
        ? ('market' as const)
        : ('builtin' as const),
    runtime: 'api' as const,
    accountCount: connections.length,
    updateAvailable: management?.updateAvailable ?? false,
  }
  if (connections.some((c) => c.status === 'error'))
    return { ...base, state: 'attention', stateLabel: '需重新授权', tone: 'danger' }
  if (management && (!management.available || !management.contract))
    return { ...base, state: 'attention', stateLabel: '当前不可用', tone: 'warning' }
  if (connections.length > 0)
    return {
      ...base,
      state: 'connected',
      stateLabel: connectedLabel(connections.length),
      tone: 'success',
    }
  return { ...base, state: 'needs-connect', stateLabel: '未连接', tone: 'neutral' }
}

function browserEntry(
  plugin: RuntimePluginCatalogEntry,
  accounts: readonly RuntimePluginAccount[],
): PluginEntry {
  const base = {
    slug: plugin.slug,
    label: plugin.label,
    description: plugin.description,
    origin: 'market' as const,
    runtime: 'browser' as const,
    accountCount: accounts.length,
    updateAvailable: plugin.updateAvailable,
  }
  // 最严重的账号状态决定整体：danger > warning；全部可用才算已连接。
  const states = accounts.map((a) => pluginAccountState(a, plugin))
  const worst = states.find((s) => s.tone === 'danger') ?? states.find((s) => s.tone === 'warning')
  if (worst) return { ...base, state: 'attention', stateLabel: worst.label, tone: worst.tone }
  if (accounts.length > 0)
    return {
      ...base,
      state: 'connected',
      stateLabel: connectedLabel(accounts.length),
      tone: 'success',
    }
  if (!plugin.available)
    return { ...base, state: 'attention', stateLabel: '当前不可用', tone: 'warning' }
  return { ...base, state: 'needs-connect', stateLabel: '待授权', tone: 'neutral' }
}

/**
 * 三套后端 → 一份目录。任一来源缺失（null / 加载失败）只少掉那部分条目，不抛错。
 * 连接归属与管理中心一致：声明式条目同时计入同 slug 的 v1 存量连接，避免连接被隐藏。
 */
export function buildPluginDirectory(input: PluginDirectoryInput): PluginEntry[] {
  const v1Conns = new Map<string, ConnectorConnection[]>()
  for (const c of input.v1?.connections ?? []) {
    const list = v1Conns.get(c.provider) ?? []
    list.push(c)
    v1Conns.set(c.provider, list)
  }
  const declConns = new Map<string, number>()
  for (const c of input.declarative?.connections ?? [])
    declConns.set(c.slug, (declConns.get(c.slug) ?? 0) + 1)

  const entries: PluginEntry[] = []
  const seen = new Set<string>()
  for (const plugin of input.runtime?.catalog ?? []) {
    const accounts = (input.runtime?.accounts ?? []).filter((a) => a.provider === plugin.slug)
    entries.push(browserEntry(plugin, accounts))
    seen.add(plugin.slug)
  }
  for (const u of unifyProviders(input.v1?.providers ?? [], input.declarative?.connectors ?? [])) {
    if (seen.has(u.slug)) continue
    const v1 = v1Conns.get(u.slug) ?? []
    const decl: Pick<ConnectorConnection, 'status'>[] =
      u.system === 'declarative'
        ? Array.from({ length: declConns.get(u.slug) ?? 0 }, () => ({ status: 'active' as const }))
        : []
    entries.push(apiEntry(u, [...decl, ...v1]))
  }
  return entries
}

/** 关键词是否命中插件（名称 / slug / 说明，大小写不敏感）—— 市场搜索态并入内置插件用。 */
export function pluginMatchesQuery(
  entry: Pick<PluginEntry, 'slug' | 'label' | 'description'>,
  q: string,
): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [entry.label, entry.slug, entry.description].some((s) => s.toLowerCase().includes(needle))
}
