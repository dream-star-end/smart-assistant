import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  CheckCircle2,
  ExternalLink,
  Pencil,
  Plug,
  QrCode,
  Settings2,
  Store,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, api, apiErrorMessage } from '../../lib/api'
import {
  type ConnectorConnection,
  type ConnectorFormField,
  type ConnectorProvider,
  type ConnectorsResponse,
  type DeclarativeCatalogEntry,
  type DeclarativeConnection,
  type DeclarativeManagementConnector,
  type DeclarativeManagementResponse,
  type KnowledgePlanetSetupView,
  type PluginManagementResponse,
  type RuntimePluginAccount,
  type RuntimePluginCatalogEntry,
  bindFieldMeta,
  connectorCapabilityLabel,
  connectorErrorText,
  connectorIcon,
  connectorNeedsRelink,
  declarativeCapabilityLabel,
  isOauthAuthMode,
} from "../../lib/connectors";
import type { AuthSession } from "../../lib/types";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  ListSkeleton,
  Modal,
  PanelHeader,
  Sheet,
  Skeleton,
  Spinner,
  Switch,
  TimeAgo,
  useConfirm,
  useToast,
} from "../ui";
import { KnowledgePlanetAutomationPanel } from './KnowledgePlanetAutomationPanel'

/** 把 ApiError 的机器码映射为中文（无码/未知码走 apiErrorMessage 收口：后端中文直显、
 *  英文/技术串回退 fallback + 追踪号，绝不裸露码或英文原文）。 */
function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.code) return connectorErrorText(e.code);
  return apiErrorMessage(e, fallback);
}

function managedSetupFailureText(
  isWeibo: boolean,
  setup: Pick<KnowledgePlanetSetupView, 'status' | 'errorCode'>,
): string {
  if (setup.status === 'expired') return '二维码已过期，请重新授权。'
  if (isWeibo && setup.errorCode === 'UPSTREAM_FAILED')
    return '微博触发了安全验证，本次授权已安全停止。请先在微博 App 完成安全验证并确认账号可正常使用，再重新授权；若仍反复出现，请稍后再试。'
  return '本次授权未完成，请重试。'
}

/**
 * Plugin 账号状态的**唯一判据**（颜色与文案同源）。
 *
 * 改造前颜色由 `account.executable` 决定、文案由 `account.status` 决定，两条判据不同源：
 * `status==='error' && executable===true` 时界面会渲染出绿色的「需重新授权」——
 * 颜色说没事、文字说要重来。这里把 status 定为最高优先判据，executable / 版本差异
 * 只在 status==='active' 时细分，渲染侧统一吃返回值，不再各自算一遍。
 *
 * `needsReauth` 表示"重新扫码授权可以修好它"——只有这一类才在账号行内给出重新授权出口，
 * 「需先更新」这种要走更新流程的不给（否则扫完码还是不能用）。
 */
export type PluginAccountState = {
  tone: 'success' | 'warning' | 'danger'
  label: string
  needsReauth: boolean
}

export function pluginAccountState(
  account: Pick<RuntimePluginAccount, 'status' | 'executable' | 'versionId'>,
  plugin: Pick<RuntimePluginCatalogEntry, 'updateAvailable' | 'installedCurrent' | 'versionId'>,
): PluginAccountState {
  if (account.status === 'error')
    return { tone: 'danger', label: '需重新授权', needsReauth: true }
  if (account.executable) return { tone: 'success', label: '可用', needsReauth: false }
  if (plugin.updateAvailable) return { tone: 'warning', label: '需先更新', needsReauth: false }
  if (plugin.installedCurrent && account.versionId !== plugin.versionId)
    return { tone: 'warning', label: '需重新授权', needsReauth: true }
  return { tone: 'warning', label: '当前不可用', needsReauth: false }
}

/**
 * 卡片内提示：**反馈必须渲染在发起它的那个容器里**。
 *
 * 改造前所有成功/失败都收敛到面板最顶部两个 Alert，而这是一个能滚很长的列表 ——
 * 在第 6 张卡片上切写入开关，提示渲染在滚动容器顶部，视口里什么都不会变，
 * 观感就是"点了没反应"。现在按 slug 定位到卡片内渲染；顶部 Alert 只留整表加载失败。
 * 会让当前容器消失的操作（解绑 / 卸载 / 更新后重排）走 toast，不留在原地。
 */
type CardNotice = { slug: string; tone: 'success' | 'warning' | 'danger'; text: string }

/** oauth2_byoa provider 未下发 formFields 时的兜底字段（契约 body 键 clientId/clientSecret）。 */
const DEFAULT_OAUTH_FIELDS: ConnectorFormField[] = [
  { key: "clientId", label: "Client ID", type: "text", required: true },
  { key: "clientSecret", label: "Client Secret", type: "password", required: true },
];

/**
 * 统一连接器卡片模型：把 v1 手写 provider 与声明式 connector 归一到同一套渲染契约。
 * system 决定绑定/解绑/能力标注走哪一套后端，slug 是去重键（声明式优先）。
 */
type UnifiedProvider =
  | { system: "v1"; slug: string; label: string; description: string; v1: ConnectorProvider }
  | {
      system: "declarative";
      slug: string;
      label: string;
      description: string;
      decl: DeclarativeCatalogEntry | null;
      management: DeclarativeManagementConnector;
    };

type UnifiedConnection = ConnectorConnection & { system: "v1" | "declarative" };

/**
 * 应用连接器 Tab：统一展示 **v1 手写 provider** + **声明式 connector** 两套后端。
 * 同一列表里按 slug 去重（同 slug 两边都有 → 只显示声明式版，因其是权威且带
 * allowlist+pin）。绑定/解绑按卡片 system 路由：
 *   - v1：formFields 弹层（token/basic）· BYOA OAuth 整页跳转 · github 复用账号 OAuth；
 *   - 声明式：requiredBindSources 驱动的 DeclarativeBindDialog。
 *
 * v1 目录（GET /api/connectors）是硬依赖，失败 → 整体报错；声明式（catalog +
 * connections）是增量，任一失败各自降级为空，**绝不阻断 v1 现有能力**。任何变更后
 * 整体 reload，不做本地乐观拼接。
 */
export function ConnectorsTab({
  auth,
  onOpenMarketplace,
  autoAuthorizePluginSlug,
  onAutoAuthorizeConsumed,
}: {
  auth: AuthSession;
  onOpenMarketplace?: () => void;
  autoAuthorizePluginSlug?: string | null;
  onAutoAuthorizeConsumed?: () => void;
}) {
  const [data, setData] = useState<ConnectorsResponse | null>(null)
  const [declConnections, setDeclConnections] = useState<DeclarativeConnection[]>([])
  const [management, setManagement] = useState<DeclarativeManagementConnector[]>([])
  const [runtimeCatalog, setRuntimeCatalog] = useState<RuntimePluginCatalogEntry[]>([])
  const [runtimeAccounts, setRuntimeAccounts] = useState<RuntimePluginAccount[]>([])
  const [loading, setLoading] = useState(true)
  /** 顶部 Alert 只承载「整表读不到」这一类全局态；其余反馈就地渲染在卡片内。 */
  const [err, setErr] = useState<string | null>(null)
  const [cardNotice, setCardNotice] = useState<CardNotice | null>(null)
  /** 打开 v1 绑定弹层的 provider（github 不走弹层，直接跳 OAuth）。 */
  const [bindFor, setBindFor] = useState<ConnectorProvider | null>(null);
  /** 打开声明式绑定弹层的 catalog 条目。 */
  const [bindDeclFor, setBindDeclFor] = useState<DeclarativeCatalogEntry | null>(null)
  const [setupRuntimeFor, setSetupRuntimeFor] = useState<RuntimePluginCatalogEntry | null>(null)
  const [setupRuntimeAccountId, setSetupRuntimeAccountId] = useState<string | null>(null)
  const [confirm, confirmEl] = useConfirm()
  const toast = useToast()
  const noticeFor = useCallback(
    (slug: string) => (cardNotice?.slug === slug ? cardNotice : null),
    [cardNotice],
  )
  const dismissNotice = useCallback(() => setCardNotice(null), [])

  const reload = useCallback(() => {
    let alive = true;
    setErr(null);
    // 声明式是增量：各自 catch 降级为空，永不 reject 到 Promise.all；只有 v1 会阻断。
    const managementP: Promise<DeclarativeManagementResponse> = api
      .getDeclarativeManagement(auth)
      .catch((e) => {
        console.warn('[connectors] 管理聚合加载失败，降级仅显示 v1 连接器', e)
        return { connectors: [], connections: [] }
      })
    const runtimeP: Promise<PluginManagementResponse> = api.getPluginManagement(auth).catch((e) => {
      console.warn('[plugins] 运行时 Plugin 管理加载失败，降级显示现有连接器', e)
      return { catalog: [], accounts: [] }
    })
    Promise.all([api.getConnectors(auth), managementP, runtimeP])
      .then(([d, managed, runtime]) => {
        if (!alive) return
        setData(d)
        setManagement(managed.connectors)
        setDeclConnections(managed.connections)
        setRuntimeCatalog(runtime.catalog)
        setRuntimeAccounts(runtime.accounts)
      })
      .catch((e) => {
        // 仅 v1 会 reject 到此（声明式已各自 catch 降级）。
        if (alive) setErr(errText(e, "暂时读不到你的应用连接，请稍后重试。"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  /** 整表读不到时的可重入重试（v1 目录是硬依赖，失败即空白，必须给出口）。 */
  const retry = useCallback(() => {
    setLoading(true)
    reload()
  }, [reload])

  useEffect(() => reload(), [reload]);

  useEffect(() => {
    if (loading || !autoAuthorizePluginSlug) return
    const plugin = runtimeCatalog.find((item) => item.slug === autoAuthorizePluginSlug)
    const account = runtimeAccounts.find(
      (item) => item.provider === autoAuthorizePluginSlug && item.executable,
    )
    const staleAccount = runtimeAccounts.find(
      (item) => item.provider === autoAuthorizePluginSlug && !item.executable,
    )
    onAutoAuthorizeConsumed?.()
    setCardNotice(null)
    setErr(null)
    if (account) {
      setCardNotice({
        slug: autoAuthorizePluginSlug,
        tone: 'success',
        text: `${plugin?.label ?? 'Plugin'}账号已授权，无需重复扫码。`,
      })
      return
    }
    if (staleAccount) {
      // 失效不再让用户先走一遍破坏性解绑：账号行内就有「重新扫码授权」，这里只做定位指引。
      setCardNotice({
        slug: autoAuthorizePluginSlug,
        tone: 'warning',
        text: `${plugin?.label ?? 'Plugin'}账号的登录已失效，点击账号行上的「重新扫码授权」即可恢复。`,
      })
      return
    }
    if (plugin?.installedCurrent && plugin.available) {
      setSetupRuntimeAccountId(null)
      setSetupRuntimeFor(plugin)
      return
    }
    setErr('Plugin 尚未安装到当前版本，请返回市场完成安装或更新后重试。')
  }, [
    autoAuthorizePluginSlug,
    loading,
    onAutoAuthorizeConsumed,
    runtimeAccounts,
    runtimeCatalog,
  ])

  /** slug 去重、声明式优先，合并成统一卡片列表（声明式在前，各自保持插入序，渲染稳定）。 */
  const unified = useMemo<UnifiedProvider[]>(() => {
    const bySlug = new Map<string, UnifiedProvider>();
    for (const c of management) {
      bySlug.set(c.slug, {
        system: "declarative",
        slug: c.slug,
        label: c.label,
        description: c.description,
        decl: c.contract,
        management: c,
      });
    }
    // v1 provider 仅当该 slug 未被声明式占据时加入（声明式权威，带 allowlist+pin）。
    for (const p of data?.providers ?? []) {
      if (bySlug.has(p.id)) continue;
      bySlug.set(p.id, {
        system: "v1",
        slug: p.id,
        label: p.label,
        description: p.description,
        v1: p,
      });
    }
    const decl: UnifiedProvider[] = [];
    const v1: UnifiedProvider[] = [];
    for (const u of bySlug.values()) (u.system === "declarative" ? decl : v1).push(u);
    return [...decl, ...v1];
  }, [data, management]);

  /** v1 provider id → 已绑连接；即使同 slug 有声明式目录项也保留，避免连接被隐藏。 */
  const v1ConnsBySlug = useMemo(() => {
    const m = new Map<string, UnifiedConnection[]>();
    for (const c of data?.connections ?? []) {
      const list = m.get(c.provider) ?? [];
      list.push({ ...c, system: "v1" });
      m.set(c.provider, list);
    }
    return m;
  }, [data]);

  /** 声明式 slug → 已绑连接（无 status，映射为 active 形状喂给 ConnectionRow）。 */
  const declConnsBySlug = useMemo(() => {
    const m = new Map<string, UnifiedConnection[]>();
    for (const c of declConnections) {
      const list = m.get(c.slug) ?? [];
      list.push({
        id: c.id,
        provider: c.slug,
        displayName: c.displayName,
        accountHint: c.accountHint ?? "",
        status: "active",
        lastErrorCode: null,
        createdAt: c.createdAt,
        system: "declarative",
      });
      m.set(c.slug, list);
    }
    return m;
  }, [declConnections]);

  const startBind = useCallback(
    (u: UnifiedProvider) => {
      if (u.system === "declarative") {
        if (u.management.canBind && u.decl) setBindDeclFor(u.decl);
        return;
      }
      const p = u.v1;
      if (p.id === "github") {
        // GitHub 复用现有账号 OAuth 绑定入口（v1 只读，凭据权威在 github_links）。
        api
          .startGithubOAuth(auth)
          .then((r) => {
            window.location.href = r.authorizeUrl;
          })
          .catch((e) =>
            setCardNotice({
              slug: p.id,
              tone: "danger",
              text: errText(e, "发起 GitHub 授权失败"),
            }),
          );
        return;
      }
      setBindFor(p);
    },
    [auth],
  );

  const unbind = useCallback(
    async (conn: UnifiedConnection) => {
      const name = conn.displayName || conn.accountHint || conn.provider;
      const ok = await confirm({
        title: `解绑「${name}」?`,
        body: "解绑后 AI 助手将立即无法访问该账号，凭据会被销毁。此操作不可撤销。",
        confirmText: "解绑",
        danger: true,
      });
      if (!ok) return;
      try {
        if (conn.system === "declarative") await api.unbindDeclarativeConnector(auth, conn.id);
        else await api.deleteConnector(auth, conn.id);
        // 行会消失 → 反馈不能留在原地，走 toast。
        toast(`已解绑「${name}」`, "success");
        reload();
      } catch (e) {
        // 失败时行还在 → 就地渲染在这张卡片里。
        setCardNotice({ slug: conn.provider, tone: "danger", text: errText(e, "解绑失败") });
      }
    },
    [auth, confirm, reload, toast],
  );

  const relink = useCallback(
    (u: UnifiedProvider, conn: UnifiedConnection) => {
      if (conn.system === "declarative") {
        if (u.system === "declarative" && u.management.canBind && u.decl) setBindDeclFor(u.decl);
        return;
      }
      const provider = data?.providers.find((p) => p.id === conn.provider);
      if (!provider) return;
      startBind({
        system: "v1",
        slug: provider.id,
        label: provider.label,
        description: provider.description,
        v1: provider,
      });
    },
    [data, startBind],
  );

  const rename = useCallback(
    async (conn: ConnectorConnection, displayName: string) => {
      try {
        await api.renameConnector(auth, conn.id, displayName);
        reload();
      } catch (e) {
        setCardNotice({ slug: conn.provider, tone: "danger", text: errText(e, "重命名失败") });
      }
    },
    [auth, reload],
  );

  const updateMarketConnector = useCallback(
    async (c: DeclarativeManagementConnector) => {
      if (!c.latestVersionId) return;
      setCardNotice(null);
      try {
        await api.installMarketplace(auth, c.latestVersionId);
        toast(`「${c.label}」已更新到 v${c.latestVersion ?? ""}`.trim(), "success");
        reload();
      } catch (e) {
        setCardNotice({ slug: c.slug, tone: "danger", text: errText(e, "更新 API 插件失败") });
      }
    },
    [auth, reload, toast],
  );

  const uninstallMarketConnector = useCallback(
    async (c: DeclarativeManagementConnector) => {
      if (c.installation !== "marketplace" || c.connectionCount > 0) return;
      const ok = await confirm({
        title: `卸载 API 插件「${c.label}」?`,
        body: "卸载后不能再绑定或执行；以后仍可从 AI 市场重新安装。",
        confirmText: "卸载",
        danger: true,
      });
      if (!ok) return;
      setCardNotice(null);
      try {
        await api.uninstallMarketplace(auth, c.slug);
        toast(`已卸载「${c.label}」`, "success");
        reload();
      } catch (e) {
        setCardNotice({ slug: c.slug, tone: "danger", text: errText(e, "卸载 API 插件失败") });
      }
    },
    [auth, confirm, reload, toast],
  );

  const revokeRuntimeAccount = useCallback(
    async (account: RuntimePluginAccount) => {
      const name = account.displayName || account.accountHint || account.provider
      const ok = await confirm({
        title: `解绑「${name}」?`,
        body: '解绑后 Plugin 将立即无法访问该账号，加密保存的登录状态会被销毁。此操作不可撤销。',
        confirmText: '解绑',
        danger: true,
      })
      if (!ok) return
      setCardNotice(null)
      setErr(null)
      try {
        await api.revokePluginAccount(auth, account.id)
        toast(`已解绑「${name}」`, 'success')
        reload()
      } catch (e) {
        setCardNotice({
          slug: account.provider,
          tone: 'danger',
          text: errText(e, '解绑 Plugin 账号失败'),
        })
      }
    },
    [auth, confirm, reload, toast],
  )

  /**
   * 微博当前版本账号直接原位换新登录状态：新扫码成功前旧连接仍可用；失败或取消不动旧状态。
   * 旧版本账号与知识星球继续走原有解绑后重建，避免把跨版本迁移混进本次修复。
   */
  const reauthorizeRuntimeAccount = useCallback(
    async (account: RuntimePluginAccount, plugin: RuntimePluginCatalogEntry) => {
      const relinkInPlace =
        plugin.slug === 'weibo' && plugin.installedCurrent && account.versionId === plugin.versionId
      const ok = await confirm({
        title: `重新登录「${plugin.label}」?`,
        body: relinkInPlace
          ? '新扫码成功前会保留当前登录状态；成功后将替换登录，并自动关闭写入能力和免逐次确认，需重新手动开启。'
          : '将销毁当前登录状态并打开扫码弹层，扫码完成后重新绑定。',
        confirmText: '重新扫码登录',
      })
      if (!ok) return
      setCardNotice(null)
      setErr(null)
      if (relinkInPlace) {
        setSetupRuntimeAccountId(account.id)
        setSetupRuntimeFor(plugin)
        return
      }
      try {
        await api.revokePluginAccount(auth, account.id)
        setSetupRuntimeAccountId(null)
        setSetupRuntimeFor(plugin)
        reload()
      } catch (e) {
        setCardNotice({
          slug: plugin.slug,
          tone: 'danger',
          text: errText(e, '重新授权失败，请稍后重试'),
        })
      }
    },
    [auth, confirm, reload],
  )

  const updateRuntimePlugin = useCallback(
    async (plugin: RuntimePluginCatalogEntry, accountCount: number) => {
      if (!plugin.latestVersionId || !plugin.updateAvailable || accountCount > 0) return
      setCardNotice(null)
      setErr(null)
      try {
        await api.installMarketplace(auth, plugin.latestVersionId)
        toast(
          plugin.installed
            ? `「${plugin.label}」已更新到 v${plugin.latestVersion ?? ''}`.trim()
            : `「${plugin.label}」已重新安装`,
          'success',
        )
        reload()
      } catch (e) {
        setCardNotice({
          slug: plugin.slug,
          tone: 'danger',
          text: errText(e, plugin.installed ? '更新 Plugin 失败' : '重新安装 Plugin 失败'),
        })
      }
    },
    [auth, reload, toast],
  )

  const uninstallRuntimePlugin = useCallback(
    async (plugin: RuntimePluginCatalogEntry, accountCount: number) => {
      if (!plugin.installed || accountCount > 0) return
      const ok = await confirm({
        title: `卸载 Plugin「${plugin.label}」?`,
        body: '卸载后不能再执行该 Plugin；以后仍可从 AI 市场重新安装。',
        confirmText: '卸载',
        danger: true,
      })
      if (!ok) return
      setCardNotice(null)
      setErr(null)
      try {
        await api.uninstallMarketplace(auth, plugin.slug)
        toast(`已卸载「${plugin.label}」`, 'success')
        reload()
      } catch (e) {
        setCardNotice({ slug: plugin.slug, tone: 'danger', text: errText(e, '卸载 Plugin 失败') })
      }
    },
    [auth, confirm, reload, toast],
  )

  /**
   * 卡片按**连接状态**分两组，而不是按后端分层（运行时 / 声明式 / v1）。
   * 后端分层对用户没有意义；用户心里只有"哪些已经能用了 / 还能加什么"。
   * 已连接组内失效的排最前 —— 需要处理的东西必须先被看见。
   */
  const pluginCards = runtimeCatalog.map((plugin) => {
    const accounts = runtimeAccounts.filter((account) => account.provider === plugin.slug)
    return {
      kind: 'plugin' as const,
      key: plugin.slug,
      plugin,
      accounts,
      connected: accounts.length > 0,
      broken: accounts.filter((account) => pluginAccountState(account, plugin).tone !== 'success')
        .length,
    }
  })
  const providerCards = unified.map((u) => {
    const connections =
      u.system === 'declarative'
        ? [...(declConnsBySlug.get(u.slug) ?? []), ...(v1ConnsBySlug.get(u.slug) ?? [])]
        : (v1ConnsBySlug.get(u.slug) ?? [])
    return {
      kind: 'provider' as const,
      key: u.slug,
      u,
      connections,
      connected: connections.length > 0,
      broken: connections.filter((c) => c.status === 'error').length,
    }
  })
  type CatalogCard = (typeof pluginCards)[number] | (typeof providerCards)[number]
  const allCards: CatalogCard[] = [...pluginCards, ...providerCards]
  const connectedCards = allCards.filter((c) => c.connected).sort((a, b) => b.broken - a.broken)
  const availableCards = allCards.filter((c) => !c.connected)
  // 只有两组都非空才出组标题 —— 单组时标题是纯噪音。
  const grouped = connectedCards.length > 0 && availableCards.length > 0

  const renderCard = (card: CatalogCard) => {
    if (card.kind !== 'plugin') return renderProviderCard(card)
    return (
      <RuntimePluginCard
        key={card.key}
        auth={auth}
        plugin={card.plugin}
        accounts={card.accounts}
        notice={noticeFor(card.plugin.slug)}
        onDismissNotice={dismissNotice}
        onAuthorize={() => {
          setCardNotice(null)
          setErr(null)
          setSetupRuntimeAccountId(null)
          setSetupRuntimeFor(card.plugin)
        }}
        onUpdate={() => updateRuntimePlugin(card.plugin, card.accounts.length)}
        onUninstall={() => uninstallRuntimePlugin(card.plugin, card.accounts.length)}
        onRevoke={(account) => revokeRuntimeAccount(account)}
        onReauthorize={(account) => reauthorizeRuntimeAccount(account, card.plugin)}
        onWriteAccessChanged={(enabled) => {
          setErr(null)
          setCardNotice({
            slug: card.plugin.slug,
            tone: 'success',
            text: enabled
              ? `${card.plugin.label}写入能力已开启；默认仍需在对话中逐次确认，免逐次确认需另行同意。${card.plugin.slug === 'knowledge-planet' ? '无人值守自动回复仍由独立开关控制。' : ''}`
              : `${card.plugin.label}写入能力已关闭。`,
          })
          reload()
        }}
        onWriteAccessError={(error) =>
          setCardNotice({
            slug: card.plugin.slug,
            tone: 'danger',
            text: errText(error, '切换 Plugin 写入能力失败'),
          })
        }
        onWritePreapprovalChanged={(enabled) => {
          setErr(null)
          setCardNotice({
            slug: card.plugin.slug,
            tone: 'success',
            text: enabled
              ? `${card.plugin.label}“免逐次确认”已开启；Agent 可直接执行所有已开放写入动作，不再展示确认卡。${card.plugin.slug === 'knowledge-planet' ? '无人值守自动回复仍由独立开关控制。' : ''}`
              : `${card.plugin.label}“免逐次确认”已关闭；后续写入恢复逐次确认。`,
          })
          reload()
        }}
        onWritePreapprovalError={(error) =>
          setCardNotice({
            slug: card.plugin.slug,
            tone: 'danger',
            text: errText(error, '切换 Plugin 免逐次确认失败'),
          })
        }
      />
    )
  }

  const renderProviderCard = (card: Extract<CatalogCard, { kind: 'provider' }>) => {
    const u = card.u
    const management = u.system === 'declarative' ? u.management : undefined
    return (
      <ProviderCard
        key={card.key}
        slug={u.slug}
        label={u.label}
        description={u.description}
        capabilityLabel={
          u.system === 'declarative'
            ? u.decl
              ? declarativeCapabilityLabel(u.decl.actions)
              : '当前不可用'
            : connectorCapabilityLabel(u.slug)
        }
        connections={card.connections}
        notice={noticeFor(u.slug)}
        onDismissNotice={dismissNotice}
        onBind={() => startBind(u)}
        canBind={management ? management.canBind : true}
        management={management}
        onOpenMarketplace={onOpenMarketplace}
        onUpdate={management ? () => updateMarketConnector(management) : undefined}
        onUninstallMarket={management ? () => uninstallMarketConnector(management) : undefined}
        onUnbind={unbind}
        onRename={rename}
        onRelink={(c) => relink(u, c)}
      />
    )
  }

  return (
    <div className="flex flex-col">
      <PanelHeader
        title="插件账号"
        hint="绑定应用账号后，AI 助手即可在对话中访问它们；写入操作默认逐次确认，个别 Plugin 可另行授权免逐次确认。"
        action={
          onOpenMarketplace && (
            <Button size="sm" variant="secondary" onClick={onOpenMarketplace}>
              <Store size={13} /> 去市场添加
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-3 px-4 pb-4">
        {err && (
          <Alert
            tone="danger"
            density="compact"
            action={
              data === null ? (
                <Button size="sm" variant="secondary" onClick={retry}>
                  重试
                </Button>
              ) : onOpenMarketplace ? (
                <Button size="sm" variant="secondary" onClick={onOpenMarketplace}>
                  <Store size={13} /> 去市场
                </Button>
              ) : undefined
            }
            onDismiss={data === null ? undefined : () => setErr(null)}
          >
            {err}
          </Alert>
        )}

        {loading ? (
          <ListSkeleton rows={3} />
        ) : (
          <>
            {grouped && (
              <div className="px-1 text-caption font-medium text-muted">
                已连接（{connectedCards.length}）
              </div>
            )}
            {connectedCards.map(renderCard)}
            {grouped && (
              <div className="px-1 pt-1 text-caption font-medium text-muted">
                可添加（{availableCards.length}）
              </div>
            )}
            {availableCards.map(renderCard)}
            {!err && allCards.length === 0 && (
              <EmptyState
                icon={Plug}
                title="还没有可用的应用连接"
                hint="从 AI 市场安装连接器或 Plugin 后，就能把邮箱、网盘、笔记等账号交给助手使用。"
                action={
                  onOpenMarketplace && (
                    <Button size="sm" variant="accent" onClick={onOpenMarketplace}>
                      <Store size={13} /> 去市场看看
                    </Button>
                  )
                }
              />
            )}
          </>
        )}
      </div>

      <BindDialog
        auth={auth}
        provider={bindFor}
        onClose={() => setBindFor(null)}
        onBound={() => {
          setBindFor(null);
          reload();
        }}
      />
      <DeclarativeBindDialog
        auth={auth}
        entry={bindDeclFor}
        onClose={() => setBindDeclFor(null)}
        onBound={() => {
          setBindDeclFor(null);
          reload();
        }}
      />
      <ManagedBrowserSetupDialog
        key={`${setupRuntimeFor?.versionId ?? 'closed'}:${setupRuntimeAccountId ?? 'new'}`}
        auth={auth}
        plugin={setupRuntimeFor}
        relinkAccountId={setupRuntimeAccountId}
        onClose={() => {
          setSetupRuntimeFor(null)
          setSetupRuntimeAccountId(null)
        }}
        onBound={(agentReady) => {
          setErr(null)
          const label = setupRuntimeFor?.label ?? 'Plugin'
          // 授权结果落在**那张卡片上**：弹层关掉后用户回到列表，提示就在他刚授权的那张卡里。
          if (setupRuntimeFor)
            setCardNotice({
              slug: setupRuntimeFor.slug,
              tone: 'success',
              text: setupRuntimeAccountId
                ? `${label}登录已更新；为保护新账号，写入能力和免逐次确认均已关闭，可按需重新开启。`
                : agentReady
                  ? `${label}账号已授权，Agent 现在可以直接读取相关内容；写入能力默认关闭。`
                  : `${label}登录信息已加密保存；系统完成 Plugin 升级后会自动启用。`,
            })
          reload()
        }}
      />
      {confirmEl}
    </div>
  );
}

function RuntimePluginCard({
  auth,
  plugin,
  accounts,
  notice,
  onDismissNotice,
  onAuthorize,
  onUpdate,
  onUninstall,
  onRevoke,
  onReauthorize,
  onWriteAccessChanged,
  onWriteAccessError,
  onWritePreapprovalChanged,
  onWritePreapprovalError,
}: {
  auth: AuthSession
  plugin: RuntimePluginCatalogEntry
  accounts: RuntimePluginAccount[]
  /** 本卡片的就地反馈（成功/失败都渲染在这里，不再飞到面板顶部）。 */
  notice: CardNotice | null
  onDismissNotice: () => void
  onAuthorize: () => void
  onUpdate: () => Promise<void>
  onUninstall: () => Promise<void>
  onRevoke: (account: RuntimePluginAccount) => Promise<void>
  onReauthorize: (account: RuntimePluginAccount) => Promise<void>
  onWriteAccessChanged: (enabled: boolean) => void
  onWriteAccessError: (error: unknown) => void
  onWritePreapprovalChanged: (enabled: boolean) => void
  onWritePreapprovalError: (error: unknown) => void
}) {
  const Icon = connectorIcon(plugin.slug)
  const canSelfAuthorize =
    ['knowledge-planet', 'weibo'].includes(plugin.slug) && plugin.installedCurrent
  const authorizeLabel = plugin.slug === 'weibo' ? '微博扫码授权' : '微信扫码授权'
  const readCount = plugin.actions.filter((action) => action.readOnly).length
  const writeCount = plugin.actions.length - readCount
  const [consentAccount, setConsentAccount] = useState<RuntimePluginAccount | null>(null)
  const [consentChecked, setConsentChecked] = useState(false)
  const [consentError, setConsentError] = useState<string | null>(null)
  const [preapprovalAccount, setPreapprovalAccount] = useState<RuntimePluginAccount | null>(null)
  const [preapprovalChecked, setPreapprovalChecked] = useState(false)
  const [preapprovalError, setPreapprovalError] = useState<string | null>(null)
  const [writeBusyId, setWriteBusyId] = useState<string | null>(null)
  /** 卡片级异步动作的忙态键（`update` / `uninstall` / `revoke:<id>` / `reauth:<id>`）。 */
  const [busyAction, setBusyAction] = useState<string | null>(null)
  /** 自动回复配置面板（从账号行里外提，见下方 Sheet）。 */
  const [automationAccount, setAutomationAccount] = useState<RuntimePluginAccount | null>(null)

  const runAction = async (key: string, action: () => Promise<void>) => {
    if (busyAction) return
    setBusyAction(key)
    try {
      await action()
    } finally {
      setBusyAction(null)
    }
  }

  const accountStates = accounts.map((account) => pluginAccountState(account, plugin))
  const brokenCount = accountStates.filter((state) => state.tone !== 'success').length
  /** 账号存在时更新/卸载会被后端拒（登录状态与新版本不匹配），把原因写成可见文字而非 title。 */
  const blockedByAccounts = accounts.length > 0

  const disableWrite = async (account: RuntimePluginAccount) => {
    if (writeBusyId) return
    setWriteBusyId(account.id)
    try {
      await api.setPluginWriteAccess(auth, account.id, { enabled: false })
      onWriteAccessChanged(false)
    } catch (error) {
      onWriteAccessError(error)
    } finally {
      setWriteBusyId(null)
    }
  }

  const enableWrite = async () => {
    const account = consentAccount
    const control = account?.writeControl
    if (!account || !control || !consentChecked || writeBusyId) return
    setConsentError(null)
    setWriteBusyId(account.id)
    try {
      await api.setPluginWriteAccess(auth, account.id, {
        enabled: true,
        accepted: true,
        disclaimerVersion: control.disclaimerVersion,
      })
      setConsentAccount(null)
      setConsentChecked(false)
      setConsentError(null)
      onWriteAccessChanged(true)
    } catch (error) {
      setConsentError(errText(error, '开启 Plugin 写入能力失败'))
      onWriteAccessError(error)
    } finally {
      setWriteBusyId(null)
    }
  }

  const disablePreapproval = async (account: RuntimePluginAccount) => {
    if (writeBusyId) return
    setWriteBusyId(account.id)
    try {
      await api.setPluginWritePreapproval(auth, account.id, { enabled: false })
      onWritePreapprovalChanged(false)
    } catch (error) {
      onWritePreapprovalError(error)
    } finally {
      setWriteBusyId(null)
    }
  }

  const enablePreapproval = async () => {
    const account = preapprovalAccount
    const preapproval = account?.writeControl?.preapproval
    if (
      !account ||
      !preapproval ||
      preapproval.disclaimerVersion === null ||
      !preapprovalChecked ||
      writeBusyId
    )
      return
    setPreapprovalError(null)
    setWriteBusyId(account.id)
    try {
      await api.setPluginWritePreapproval(auth, account.id, {
        enabled: true,
        accepted: true,
        disclaimerVersion: preapproval.disclaimerVersion,
      })
      setPreapprovalAccount(null)
      setPreapprovalChecked(false)
      onWritePreapprovalChanged(true)
    } catch (error) {
      setPreapprovalError(errText(error, '开启 Plugin 免逐次确认失败'))
      onWritePreapprovalError(error)
    } finally {
      setWriteBusyId(null)
    }
  }
  return (
    <Card className="p-3.5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          {/* 标题行只放身份与能力标注；连接状态单独成行，避免四类信息平铺争夺注意力。 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-section font-medium text-fg">{plugin.label}</span>
            <Badge tone="neutral" size="sm">
              {writeCount > 0 ? '可读写' : '只读'}
            </Badge>
            {plugin.installed ? (
              <Badge tone="accent" size="sm">
                市场已安装 · v{plugin.installedVersion}
              </Badge>
            ) : (
              <Badge tone="warning" size="sm">
                历史账号 · 当前未安装
              </Badge>
            )}
            {plugin.updateAvailable && plugin.latestVersion && (
              <Badge tone="accent" size="sm">
                {plugin.installed ? `可更新 v${plugin.latestVersion}` : '可重新安装'}
              </Badge>
            )}
            {plugin.pluginType === 'managed-browser' && (
              <Badge tone="neutral" size="sm">
                隔离运行
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-meta leading-snug text-faint">{plugin.description}</p>
          <p className="mt-1 text-caption text-faint">
            {readCount} 项读取能力{writeCount > 0 ? ` · ${writeCount} 项写入能力（默认关闭）` : ''}
            {plugin.accountMode === 'none' ? ' · 无需账号' : ' · 账号登录状态加密保存'}
          </p>
          {accounts.length > 0 && (
            <div className="mt-1.5">
              {brokenCount > 0 ? (
                <Badge tone="warning">
                  <AlertTriangle size={11} aria-hidden="true" />
                  {brokenCount} 个账号待处理
                </Badge>
              ) : (
                <Badge tone="success">
                  <CheckCircle2 size={11} aria-hidden="true" />
                  已授权
                </Badge>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {plugin.updateAvailable && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void runAction('update', onUpdate)}
              loading={busyAction === 'update'}
              disabled={blockedByAccounts || busyAction !== null}
            >
              <ArrowUpCircle size={13} /> {plugin.installed ? '更新' : '重新安装'}
            </Button>
          )}
          {plugin.accountMode === 'required' && accounts.length === 0 && plugin.installedCurrent && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onAuthorize}
              disabled={!canSelfAuthorize}
            >
              <QrCode size={13} /> {canSelfAuthorize ? authorizeLabel : '暂不可授权'}
            </Button>
          )}
          {plugin.installed && (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger"
              onClick={() => void runAction('uninstall', onUninstall)}
              loading={busyAction === 'uninstall'}
              disabled={blockedByAccounts || busyAction !== null}
            >
              <Trash2 size={13} /> 卸载
            </Button>
          )}
        </div>
      </div>
      {/* 禁用原因写成可见文字：title 属性在触屏上永远不出现，键盘与读屏用户也读不到。 */}
      {blockedByAccounts && (plugin.updateAvailable || plugin.installed) && (
        <p className="mt-2 text-caption text-warning">
          更新或卸载前需先解绑下方账号：重装会让已保存的登录状态失配。
        </p>
      )}
      {plugin.accountMode === 'required' &&
        accounts.length === 0 &&
        plugin.installedCurrent &&
        !canSelfAuthorize && (
          <p className="mt-2 text-caption text-faint">
            该 Plugin 暂未提供自助授权流程，请在对话中让助手引导完成绑定。
          </p>
        )}
      {notice && (
        <Alert
          tone={notice.tone}
          density="compact"
          className="mt-2"
          onDismiss={onDismissNotice}
        >
          {notice.text}
        </Alert>
      )}
      {!plugin.available && (
        <Alert tone="warning" density="compact" className="mt-2">
          该 Plugin 当前已下架、被撤销或签名契约不可用；保留在此供你解绑历史账号或卸载。
        </Alert>
      )}
      {accounts.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-border border-t border-border pt-1">
          {accounts.map((account, index) => {
            const accountState = accountStates[index] ?? pluginAccountState(account, plugin)
            const writePolicyStale =
              account.writeControl !== null &&
              account.writeControl.acceptedVersion !== null &&
              account.writeControl.acceptedVersion !== account.writeControl.disclaimerVersion
            const preapprovalPolicyStale =
              account.writeControl?.preapproval?.acceptedVersion !== null &&
              account.writeControl?.preapproval?.acceptedVersion !== undefined &&
              account.writeControl.preapproval.disclaimerVersion !== null &&
              account.writeControl.preapproval.acceptedVersion !==
                account.writeControl.preapproval.disclaimerVersion
            return (
              <li key={account.id} className="flex flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1 basis-40">
                  <div className="truncate text-body text-fg">
                    {account.displayName || plugin.label}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    {/* 颜色与文案同源（pluginAccountState），不再出现"绿色的需重新授权"。 */}
                    <Badge tone={accountState.tone} size="sm">
                      {accountState.tone === 'success' ? (
                        <CheckCircle2 size={11} aria-hidden="true" />
                      ) : (
                        <AlertTriangle size={11} aria-hidden="true" />
                      )}
                      {accountState.label}
                    </Badge>
                    {account.accountHint && (
                      <span className="truncate text-caption text-faint">{account.accountHint}</span>
                    )}
                  </div>
                </div>
                {canSelfAuthorize && (accountState.needsReauth || plugin.slug === 'weibo') && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void runAction(`reauth:${account.id}`, () => onReauthorize(account))}
                    loading={busyAction === `reauth:${account.id}`}
                    disabled={busyAction !== null}
                  >
                    <QrCode size={13} />
                    {plugin.slug === 'weibo' ? '重新扫码登录' : '重新扫码授权'}
                  </Button>
                )}
                {account.writeControl && (
                  <div className="flex items-center gap-2 text-caption text-muted">
                    <span className={writePolicyStale ? 'text-warning' : undefined}>
                      {writePolicyStale
                        ? '写入条款已更新，需重新同意'
                        : account.writeControl.enabled
                          ? '写入已开启'
                          : '写入已关闭'}
                    </span>
                    <Switch
                      aria-label={`${account.displayName || plugin.label}写入能力`}
                      checked={account.writeControl.enabled}
                      disabled={!account.executable || writeBusyId === account.id}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setConsentChecked(false)
                          setConsentError(null)
                          setConsentAccount(account)
                        } else {
                          void disableWrite(account)
                        }
                      }}
                    />
                  </div>
                )}
                <IconButton
                  variant="danger"
                  size="sm"
                  aria-label="解绑"
                  title="解绑"
                  disabled={busyAction !== null}
                  onClick={() => void runAction(`revoke:${account.id}`, () => onRevoke(account))}
                >
                  {busyAction === `revoke:${account.id}` ? <Spinner size={14} /> : <Trash2 size={14} />}
                </IconButton>
                {account.writeControl?.preapproval?.available && (
                  <Card tone="sunken" padding="sm" className="basis-full">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-0 flex-1 basis-40">
                        <div className="text-caption font-medium text-fg">免逐次确认</div>
                        <div
                          className={`mt-0.5 text-caption leading-relaxed ${
                            preapprovalPolicyStale ? 'text-warning' : 'text-faint'
                          }`}
                        >
                          {preapprovalPolicyStale
                            ? '免确认条款已更新，需重新同意后才会生效。'
                            : account.writeControl.preapproval.enabled
                              ? '已生效：Agent 直接执行写入，不展示确认卡。'
                              : '开启后，Agent 直接执行写入，不展示确认卡；默认关闭。'}
                        </div>
                      </div>
                      <span className="text-caption text-muted">
                        {preapprovalPolicyStale
                          ? '需重新同意'
                          : account.writeControl.preapproval.enabled
                            ? '已开启'
                            : '已关闭'}
                      </span>
                      <Switch
                        aria-label={`${account.displayName || plugin.label}免逐次确认`}
                        checked={account.writeControl.preapproval.enabled}
                        disabled={
                          !account.executable ||
                          !account.writeControl.enabled ||
                          writeBusyId === account.id
                        }
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setPreapprovalChecked(false)
                            setPreapprovalError(null)
                            setPreapprovalAccount(account)
                          } else {
                            void disablePreapproval(account)
                          }
                        }}
                      />
                    </div>
                  </Card>
                )}
                {/* 自动回复外提：账号行只留一行摘要 + 入口，847 行的规则子系统去 Sheet 里展开。 */}
                {plugin.slug === 'knowledge-planet' && account.status === 'active' && (
                  <Card tone="sunken" padding="sm" className="basis-full">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-0 flex-1 basis-40">
                        <div className="text-caption font-medium text-fg">无人值守自动回复</div>
                        <div className="mt-0.5 text-caption leading-relaxed text-faint">
                          按规则自动回复星球里的新主题与提问；默认关闭，需单独同意免责声明。
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setAutomationAccount(account)}
                      >
                        <Settings2 size={13} /> 配置
                      </Button>
                    </div>
                  </Card>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <Modal
        open={consentAccount != null}
        onOpenChange={(open) => {
          if (!open && !writeBusyId) {
            setConsentAccount(null)
            setConsentChecked(false)
            setConsentError(null)
          }
        }}
        title={`开启${plugin.label}写入能力`}
        description={`开启后，此 Plugin 的写入动作默认仍须由你在对话确认卡中单独批准；免逐次确认使用独立授权。${plugin.slug === 'knowledge-planet' ? '无人值守回复也使用独立授权。' : ''}`}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={writeBusyId != null}
              onClick={() => {
                setConsentAccount(null)
                setConsentChecked(false)
                setConsentError(null)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={writeBusyId != null}
              disabled={!consentChecked}
              onClick={() => void enableWrite()}
            >
              同意并开启
            </Button>
          </>
        }
      >
        {consentAccount?.writeControl && (
          <div className="flex flex-col gap-3">
            {/* 失败提示留在弹层内 —— 渲染到面板顶部会被这层遮罩整个盖住。 */}
            {consentError && (
              <Alert tone="danger" density="compact">
                {consentError}
              </Alert>
            )}
            <Alert tone="warning" density="compact" className="leading-relaxed">
              {consentAccount.writeControl.disclaimerText}
            </Alert>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-meta leading-relaxed text-muted">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-accent"
                checked={consentChecked}
                onChange={(event) => setConsentChecked(event.target.checked)}
              />
              <span>我已阅读并理解上述风险与责任，并同意开启写入能力。</span>
            </label>
          </div>
        )}
      </Modal>
      <Modal
        open={preapprovalAccount != null}
        onOpenChange={(open) => {
          if (!open && !writeBusyId) {
            setPreapprovalAccount(null)
            setPreapprovalChecked(false)
            setPreapprovalError(null)
          }
        }}
        title="开启免逐次确认"
        description={`这是独立的账号级高风险授权。开启后，所有可使用此账号的 Agent 都可直接执行${plugin.label}写入，不再展示逐次确认卡。`}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={writeBusyId != null}
              onClick={() => {
                setPreapprovalAccount(null)
                setPreapprovalChecked(false)
                setPreapprovalError(null)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={writeBusyId != null}
              disabled={!preapprovalChecked}
              onClick={() => void enablePreapproval()}
            >
              同意并开启
            </Button>
          </>
        }
      >
        {preapprovalAccount?.writeControl?.preapproval && (
          <div className="flex flex-col gap-3">
            {preapprovalError && (
              <Alert tone="danger" density="compact">
                {preapprovalError}
              </Alert>
            )}
            <Alert tone="warning" density="compact" className="leading-relaxed">
              {preapprovalAccount.writeControl.preapproval.disclaimerText}
            </Alert>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-meta leading-relaxed text-muted">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-accent"
                checked={preapprovalChecked}
                onChange={(event) => setPreapprovalChecked(event.target.checked)}
              />
              <span>我已阅读并理解上述风险与责任，并明确同意当前账号免逐次确认。</span>
            </label>
          </div>
        )}
      </Modal>
      {/*
        自动回复配置面板：从账号 <li> 里外提到贴底抽屉。
        原来的层级是 管理中心 → 插件账号 Tab → 插件卡片 → 账号行 → 自动回复子系统，
        四层缩进里还塞着规则列表、免责声明、运行记录与多个弹层；现在它有了自己的标题与呼吸空间。
      */}
      <Sheet
        open={automationAccount != null}
        onOpenChange={(open) => {
          if (!open) setAutomationAccount(null)
        }}
        side="bottom"
        srTitle={`${plugin.label}自动回复设置`}
      >
        <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-3">
          <div className="min-w-0">
            <h3 className="text-title font-semibold text-fg">{plugin.label}自动回复设置</h3>
            <p className="mt-0.5 truncate text-caption text-muted">
              账号：{automationAccount?.displayName || automationAccount?.accountHint || plugin.label}
            </p>
          </div>
          <IconButton
            aria-label="关闭自动回复设置"
            size="sm"
            onClick={() => setAutomationAccount(null)}
          >
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {automationAccount && (
            <KnowledgePlanetAutomationPanel auth={auth} account={automationAccount} />
          )}
        </div>
      </Sheet>
    </Card>
  )
}

function ManagedBrowserSetupDialog({
  auth,
  plugin,
  relinkAccountId,
  onClose,
  onBound,
}: {
  auth: AuthSession
  plugin: RuntimePluginCatalogEntry | null
  relinkAccountId: string | null
  onClose: () => void
  onBound: (agentReady: boolean) => void
}) {
  const provider = plugin?.slug === 'weibo' ? 'weibo' : 'knowledge-planet'
  const isWeibo = provider === 'weibo'
  const label = isWeibo ? '微博' : '知识星球'
  const scanner = isWeibo ? '微博客户端' : '微信'
  const [starting, setStarting] = useState(false)
  const [setup, setSetup] = useState<KnowledgePlanetSetupView | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [loadedQrKey, setLoadedQrKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reportedActive, setReportedActive] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const setupSessionId = setup?.sessionId ?? null
  const setupStatus = setup?.status ?? null
  const setupQrReady = setup?.qrReady === true
  const hasSetupQrRevision =
    typeof setup?.qrRevision === 'number' && Number.isSafeInteger(setup.qrRevision)
  const setupQrRevision =
    hasSetupQrRevision
      ? Number(setup?.qrRevision)
      : setupQrReady
        ? 1
        : 0
  const setupPhase =
    setup?.phase ??
    (setupStatus === 'active'
      ? 'active'
      : setupStatus === 'finalizing'
        ? 'saving'
        : setupStatus === 'waiting_for_scan'
          ? setupQrReady
            ? 'waiting_for_scan'
            : 'generating_qr'
          : setupStatus)

  const findExistingAccount = useCallback(async (): Promise<
    RuntimePluginAccount | undefined
  > => {
    const management = await api.getPluginManagement(auth)
    return management.accounts.find(
      (item) => item.provider === provider && item.status === 'active',
    )
  }, [auth, provider])

  const markExistingAccountActive = useCallback(
    (account: RuntimePluginAccount, sessionId?: string) => {
      const now = new Date().toISOString()
      setSetup({
        sessionId: sessionId ?? `existing-${account.id}`,
        status: 'active',
        phase: 'active',
        qrReady: false,
        agentReady: account.executable,
        createdAt: now,
        expiresAt: now,
        accountId: account.id,
      })
      setError(null)
    },
    [],
  )

  useEffect(
    () => () => {
      if (qrUrl) URL.revokeObjectURL(qrUrl)
    },
    [qrUrl],
  )

  useEffect(() => {
    if (
      !setupSessionId ||
      !setupStatus ||
      !['waiting_for_scan', 'finalizing'].includes(setupStatus)
    )
      return
    let cancelled = false
    let timer: number | undefined
    const poll = () => {
      const request = isWeibo
        ? api.getWeiboSetup(auth, setupSessionId)
        : api.getKnowledgePlanetSetup(auth, setupSessionId)
      void request
        .then((next) => {
          if (!cancelled) {
            setSetup(next)
            setError(null)
          }
        })
        .catch(async (e) => {
          if (cancelled) return
          if (e instanceof ApiError && e.code === 'SETUP_NOT_FOUND') {
            if (!relinkAccountId) {
              const account = await findExistingAccount().catch(() => undefined)
              if (cancelled) return
              if (account) {
                markExistingAccountActive(account, setupSessionId)
                return
              }
            }
            setSetup((current) =>
              current
                ? { ...current, status: 'failed', qrReady: false, errorCode: 'SETUP_NOT_FOUND' }
                : current,
            )
            setError('扫码会话已失效，可能是授权服务刚刚更新；请重新生成二维码。')
            return
          }
          setError(errText(e, '读取扫码状态失败，请重试'))
        })
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(poll, 900)
        })
    }
    timer = window.setTimeout(poll, 900)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [
    auth,
    findExistingAccount,
    isWeibo,
    markExistingAccountActive,
    relinkAccountId,
    setupSessionId,
    setupStatus,
  ])

  useEffect(() => {
    if (!setupQrReady || !setupSessionId) return
    const qrKey = `${setupSessionId}:${setupQrRevision}`
    const revisionBound = !isWeibo && hasSetupQrRevision
    if (revisionBound && loadedQrKey === qrKey) return
    let cancelled = false
    let timer: number | undefined
    const load = () => {
      const request = isWeibo
        ? api.getWeiboSetupQr(auth, setupSessionId)
        : api.getKnowledgePlanetSetupQr(auth, setupSessionId)
      void request
        .then((blob) => {
          if (cancelled) return
          const next = URL.createObjectURL(blob)
          setQrUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous)
            return next
          })
          if (revisionBound) setLoadedQrKey(qrKey)
          setError(null)
          timer = window.setTimeout(load, 8_000)
        })
        .catch((e) => {
          if (!cancelled) {
            setError(errText(e, '二维码加载失败，请重试'))
            timer = window.setTimeout(load, 900)
          }
        })
    }
    load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [
    auth,
    hasSetupQrRevision,
    isWeibo,
    loadedQrKey,
    setupQrReady,
    setupQrRevision,
    setupSessionId,
  ])

  useEffect(() => {
    if (setupStatus !== 'active' || reportedActive) return
    if (relinkAccountId && setup?.accountId !== relinkAccountId) {
      setSetup((current) =>
        current
          ? { ...current, status: 'failed', phase: 'failed', qrReady: false, errorCode: 'ACCOUNT_STALE' }
          : current,
      )
      setError('重新登录结果与目标账号不一致，请重试。')
      return
    }
    setReportedActive(true)
    onBound(setup?.agentReady !== false)
  }, [onBound, relinkAccountId, reportedActive, setup?.accountId, setup?.agentReady, setupStatus])

  const start = async () => {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      setSetup(
        await (isWeibo
          ? relinkAccountId
            ? api.startWeiboSetup(auth, relinkAccountId)
            : api.startWeiboSetup(auth)
          : api.startKnowledgePlanetSetup(auth)),
      )
    } catch (e) {
      if (!relinkAccountId && e instanceof ApiError && e.code === 'ACCOUNT_ALREADY_EXISTS') {
        const account = await findExistingAccount().catch(() => undefined)
        if (account) {
          markExistingAccountActive(account)
          return
        }
      }
      setError(errText(e, `发起${label}授权失败`))
    } finally {
      setStarting(false)
    }
  }

  const close = async () => {
    if (cancelling) return
    if (setup?.status === 'finalizing') return
    if (setup?.status === 'waiting_for_scan') {
      setCancelling(true)
      setError(null)
      try {
        if (isWeibo) await api.cancelWeiboSetup(auth, setup.sessionId)
        else await api.cancelKnowledgePlanetSetup(auth, setup.sessionId)
      } catch (e) {
        setError(errText(e, '取消授权失败，请重试'))
        setCancelling(false)
        return
      }
      setCancelling(false)
    }
    onClose()
  }

  const retry = () => {
    if (qrUrl) URL.revokeObjectURL(qrUrl)
    setQrUrl(null)
    setSetup(null)
    setError(null)
    setReportedActive(false)
  }

  const terminalFailure = setup && ['cancelled', 'expired', 'failed'].includes(setup.status)
  return (
    <Modal
      open={plugin != null}
      onOpenChange={(open) => !open && void close()}
      title={relinkAccountId ? `重新登录${label}` : `授权${label}`}
      description={
        relinkAccountId
          ? `${scanner}扫码成功前会保留当前登录；成功后替换登录状态，并关闭写入能力和免逐次确认。`
          : `${scanner}扫码一次即可复用登录。读取能力授权后可用；发布媒体、互动、编辑和删除默认关闭，需另行阅读免责声明并手动开启。`
      }
      footer={
        <>
          {setup?.status !== 'active' && (
            <Button
              variant="ghost"
              size="sm"
              loading={cancelling}
              disabled={setup?.status === 'finalizing'}
              onClick={() => void close()}
            >
              {setup?.status === 'finalizing' ? '正在安全保存…' : '取消'}
            </Button>
          )}
          {!setup && (
            <Button
              variant="primary"
              size="sm"
              loading={starting}
              onClick={() => void start()}
            >
              <QrCode size={13} /> 同意并生成二维码
            </Button>
          )}
          {terminalFailure && (
            <Button variant="secondary" size="sm" onClick={retry}>
              重新授权
            </Button>
          )}
          {setup?.status === 'active' && (
            <Button variant="primary" size="sm" onClick={onClose}>
              <Check size={13} /> 完成
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Alert tone="danger" density="compact">{error}</Alert>}
        {!setup && (
          <div className="rounded-lg bg-hover px-3 py-2.5 text-meta leading-relaxed text-muted">
            点击“同意并生成二维码”即表示你同意使用{scanner}扫码保存{label}
            登录状态。登录状态仅保存在服务端加密账号库中；Plugin
            只访问固定域名白名单。扫码本身不会开启发布能力，写入需在账号卡片中另行同意并开启，且每次执行仍需确认。
          </div>
        )}
        {setup && !terminalFailure && (
          <ol
            className="grid grid-cols-4 gap-1 rounded-lg border border-border bg-surface px-2 py-2"
            aria-label={`${label}授权进度`}
          >
            {['生成二维码', `${scanner}确认`, '加密保存', '授权完成'].map((stepLabel, index) => {
              const current =
                setupPhase === 'generating_qr'
                  ? 0
                  : setupPhase === 'waiting_for_scan'
                    ? 1
                    : setupPhase === 'scan_confirmed' || setupPhase === 'saving'
                      ? 2
                      : 3
              const complete = setupPhase === 'active' || index < current
              const active = index === current && setupPhase !== 'active'
              return (
                <li
                  key={stepLabel}
                  className={`flex min-w-0 flex-col items-center gap-1 text-center text-caption ${
                    complete || active ? 'text-accent' : 'text-faint'
                  }`}
                >
                  <span
                    className={`flex size-5 items-center justify-center rounded-full border ${
                      complete
                        ? // accent-fg 才是 accent 底上的可读前景（暗色主题下 accent 是浅紫，
                          // 白色对勾会糊掉）；与 Button 的 accent 变体同一套判据。
                          'border-accent bg-accent text-accent-fg'
                        : active
                          ? 'border-accent bg-accent-soft'
                          : 'border-border'
                    }`}
                  >
                    {complete ? <Check size={12} /> : active ? <Spinner /> : index + 1}
                  </span>
                  <span className="truncate">{stepLabel}</span>
                </li>
              )
            })}
          </ol>
        )}
        {setup?.status === 'waiting_for_scan' && (
          // 白底卡**只包二维码图像**：二维码必须在白底上才扫得动，但任何跟随主题的
          // token 文字落在写死的白底上都会失联（暗色 --muted 对白底约 1.5:1）。
          // 说明文字与链接一律留在主题面上，扫码这条一次性关键路径才不会失去指引。
          <div className="flex flex-col items-center gap-3">
            {qrUrl ? (
              <div className="flex justify-center rounded-xl border border-border bg-white p-4">
                <img
                  src={qrUrl}
                  alt={isWeibo ? '微博登录二维码' : '知识星球微信登录二维码'}
                  className="size-56 object-contain"
                />
              </div>
            ) : (
              <div className="flex min-h-64 w-full items-center justify-center rounded-xl border border-border bg-hover p-4">
                <Skeleton className="size-56 rounded-lg" />
              </div>
            )}
            <output className="text-center text-meta text-muted" aria-live="polite">
              {setupPhase === 'generating_qr'
                ? `正在安全生成${scanner}二维码，通常需要几秒…`
                : qrUrl
                  ? `二维码已生成 · 请使用${scanner}扫码，并在手机上确认登录`
                  : '正在加载二维码…'}
            </output>
            {qrUrl && (
              <a
                href={qrUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-meta text-accent hover:underline"
              >
                <ExternalLink size={12} /> 单独打开二维码
              </a>
            )}
          </div>
        )}
        {setup?.status === 'finalizing' && (
          <output
            className="flex items-center justify-center gap-2 py-12 text-body text-muted"
            aria-live="polite"
          >
            <Spinner />{' '}
            {setupPhase === 'scan_confirmed'
              ? `${scanner}扫码已确认 · 正在校验并关闭临时登录环境…`
              : '登录状态有效 · 正在加密保存账号…'}
          </output>
        )}
        {setup?.status === 'active' && (
          <Alert tone="success">
            {setup.agentReady === false
              ? `${scanner}登录已确认，登录信息已加密保存。系统完成 Plugin 升级后会自动启用，无需再次扫码。`
              : `授权成功，Agent 现在可以直接读取${label}内容；写入能力保持关闭，需你另行开启。`}
          </Alert>
        )}
        {terminalFailure && (
          <Alert tone="warning">{managedSetupFailureText(isWeibo, setup)}</Alert>
        )}
      </div>
    </Modal>
  )
}

// ── provider 目录卡（含该 provider 的已绑多账号列表） ────────────────────────

function ProviderCard({
  slug,
  label,
  description,
  capabilityLabel,
  connections,
  notice,
  onDismissNotice,
  onBind,
  canBind = true,
  management,
  onOpenMarketplace,
  onUpdate,
  onUninstallMarket,
  onUnbind,
  onRename,
  onRelink,
}: {
  slug: string;
  label: string;
  description: string;
  capabilityLabel: string;
  connections: UnifiedConnection[];
  /** 本卡片的就地反馈（见 CardNotice 注释）。 */
  notice: CardNotice | null;
  onDismissNotice: () => void;
  onBind: () => void;
  canBind?: boolean;
  management?: DeclarativeManagementConnector;
  onOpenMarketplace?: () => void;
  onUpdate?: () => Promise<void>;
  onUninstallMarket?: () => Promise<void>;
  onUnbind: (conn: UnifiedConnection) => Promise<void>;
  onRename: (conn: ConnectorConnection, displayName: string) => void;
  onRelink: (conn: UnifiedConnection) => void;
}) {
  const Icon = connectorIcon(slug);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const runAction = async (key: string, action: () => Promise<void>) => {
    if (busyAction) return;
    setBusyAction(key);
    try {
      await action();
    } finally {
      setBusyAction(null);
    }
  };
  const broken = connections.filter((c) => c.status === "error").length;
  const orphanInstall = management?.installation === "orphan";
  return (
    <Card className="p-3.5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-section font-medium text-fg">{label}</span>
            <Badge tone="neutral" size="sm">
              {capabilityLabel}
            </Badge>
            {management?.installation === "default" && (
              <Badge tone="accent" size="sm">
                官方预装
              </Badge>
            )}
            {management?.installation === "marketplace" && (
              <Badge tone="accent" size="sm">
                市场已安装{management.installedVersion ? ` · v${management.installedVersion}` : ""}
              </Badge>
            )}
            {orphanInstall && (
              <Badge tone="warning" size="sm">
                历史绑定 · 当前未安装
              </Badge>
            )}
            {management?.updateAvailable && management.latestVersion && (
              <Badge tone="accent" size="sm">
                可更新 v{management.latestVersion}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-meta leading-snug text-faint">{description}</p>
          {/* 连接状态单独成行：卡片头不能永远绿着，失效必须一眼看得见。 */}
          {connections.length > 0 && (
            <div className="mt-1.5">
              {broken > 0 ? (
                <Badge tone="warning">
                  <AlertTriangle size={11} aria-hidden="true" />
                  {broken} 个账号需重新绑定
                </Badge>
              ) : (
                <Badge tone="success">
                  <CheckCircle2 size={11} aria-hidden="true" />
                  已绑定 {connections.length} 个账号
                </Badge>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {management?.updateAvailable && onUpdate && (
            <Button
              variant="primary"
              size="sm"
              loading={busyAction === "update"}
              disabled={busyAction !== null}
              onClick={() => void runAction("update", onUpdate)}
            >
              <ArrowUpCircle size={13} /> 更新
            </Button>
          )}
          {/* 不可绑定的历史安装给真出路（去市场重装），而不是一个灰掉且没有解释的按钮。 */}
          {!canBind && orphanInstall && onOpenMarketplace ? (
            <Button variant="secondary" size="sm" onClick={onOpenMarketplace}>
              <Store size={13} /> 去市场安装
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onBind} disabled={!canBind}>
              {canBind ? (connections.length > 0 ? "添加账号" : "绑定") : "不可绑定"}
            </Button>
          )}
          {management?.installation === "marketplace" && onUninstallMarket && (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger"
              loading={busyAction === "uninstall"}
              disabled={management.connectionCount > 0 || busyAction !== null}
              onClick={() => void runAction("uninstall", onUninstallMarket)}
            >
              <Trash2 size={13} /> 卸载
            </Button>
          )}
        </div>
      </div>

      {/* 禁用原因写成可见文字（title 在触屏/读屏上等于不存在）。 */}
      {management?.installation === "marketplace" && management.connectionCount > 0 && (
        <p className="mt-2 text-caption text-warning">卸载前需先解绑下方全部账号。</p>
      )}
      {!canBind && !orphanInstall && (
        <p className="mt-2 text-caption text-faint">
          该连接器当前不可绑定；等它在市场恢复可用后即可继续添加账号。
        </p>
      )}

      {notice && (
        <Alert tone={notice.tone} density="compact" className="mt-2" onDismiss={onDismissNotice}>
          {notice.text}
        </Alert>
      )}

      {management && !management.available && (
        <Alert tone="warning" density="compact" className="mt-2">
          该 API 插件当前已下架、被撤销或签名契约不可用；保留在此供你解绑历史账号。
        </Alert>
      )}

      {connections.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-border border-t border-border pt-1">
          {connections.map((c) => (
            <ConnectionRow
              key={c.id}
              conn={c}
              canRename={c.system === "v1"}
              onUnbind={onUnbind}
              onRename={onRename}
              onRelink={() => onRelink(c)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── 已绑连接行（备注名行内编辑 / 状态 / RELINK 引导 / 解绑） ──────────────────

function ConnectionRow({
  conn,
  canRename = true,
  onUnbind,
  onRename,
  onRelink,
}: {
  conn: UnifiedConnection;
  /** 是否支持改名（声明式后端无 rename → 传 false 隐藏铅笔与行内编辑）。 */
  canRename?: boolean;
  onUnbind: (conn: UnifiedConnection) => Promise<void>;
  onRename: (conn: ConnectorConnection, displayName: string) => void;
  onRelink: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(conn.displayName);
  const [unbinding, setUnbinding] = useState(false);
  const needsRelink = connectorNeedsRelink(conn);
  const hasError = conn.status === "error";

  const save = () => {
    setEditing(false);
    const next = name.trim();
    if (next !== conn.displayName) onRename(conn, next);
  };

  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              aria-label="备注名"
              className="h-8 max-w-56"
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") {
                  setName(conn.displayName);
                  setEditing(false);
                }
              }}
              // biome-ignore lint/a11y/noAutofocus: 行内编辑开启即聚焦是预期交互
              autoFocus
            />
            <IconButton size="sm" aria-label="保存备注名" onClick={save}>
              <Check size={14} />
            </IconButton>
            <IconButton
              size="sm"
              aria-label="取消编辑"
              onClick={() => {
                setName(conn.displayName);
                setEditing(false);
              }}
            >
              <X size={14} />
            </IconButton>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body text-fg">
              {conn.displayName || conn.accountHint || "未命名连接"}
            </span>
            {canRename && (
              <IconButton size="sm" aria-label="编辑备注名" onClick={() => setEditing(true)}>
                <Pencil size={13} />
              </IconButton>
            )}
          </div>
        )}
        {/* 状态升级为徽章（原来是三段同字号同粗细的裸文字，只靠颜色区分）；
            账号提示与绑定时间降一层做元信息行，不再与状态争同一行。 */}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {!hasError && (
            <Badge tone="success" size="sm">
              <CheckCircle2 size={11} aria-hidden="true" />
              正常
            </Badge>
          )}
          {needsRelink && (
            <Badge tone="warning" size="sm">
              <AlertTriangle size={11} aria-hidden="true" />
              需要重新绑定
            </Badge>
          )}
          {hasError && !needsRelink && (
            <Badge tone="danger" size="sm">
              <AlertTriangle size={11} aria-hidden="true" />
              连接异常
            </Badge>
          )}
          {conn.accountHint && (
            <span className="truncate text-caption text-faint">{conn.accountHint}</span>
          )}
          {conn.createdAt && (
            <span className="text-caption text-faint">
              绑定于 <TimeAgo value={conn.createdAt} format="short" tooltip={false} />
            </span>
          )}
        </div>
        {/* 具体错误是一句话而不是标签：单独成行才能换行，塞进 nowrap 徽章会在窄屏顶破行。 */}
        {hasError && !needsRelink && (
          <p className="mt-0.5 text-caption text-danger">
            {connectorErrorText(conn.lastErrorCode)}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {needsRelink && (
          <Button variant="secondary" size="sm" onClick={onRelink}>
            重新绑定
          </Button>
        )}
        <IconButton
          size="sm"
          variant="danger"
          aria-label="解绑"
          title="解绑"
          disabled={unbinding}
          onClick={() => {
            if (unbinding) return;
            setUnbinding(true);
            void onUnbind(conn).finally(() => setUnbinding(false));
          }}
        >
          {unbinding ? <Spinner size={14} /> : <Trash2 size={14} />}
        </IconButton>
      </div>
    </li>
  );
}

// ── 绑定弹层（formFields 驱动；token/basic 直落库，BYOA OAuth 整页跳授权） ────

function BindDialog({
  auth,
  provider,
  onClose,
  onBound,
}: {
  auth: AuthSession;
  provider: ConnectorProvider | null;
  onClose: () => void;
  onBound: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 换 provider / 重开弹层 → 重置表单瞬态（凭据绝不跨 provider 残留）。
  useEffect(() => {
    setValues({});
    setDisplayName("");
    setErr(null);
    setSubmitting(false);
  }, [provider?.id]);

  const isOauth = provider?.authKind === "oauth2_byoa";
  const fields: ConnectorFormField[] =
    provider == null
      ? []
      : provider.formFields.length > 0
        ? provider.formFields
        : isOauth
          ? DEFAULT_OAUTH_FIELDS
          : [];

  const missingRequired = fields.some((f) => f.required && !(values[f.key] ?? "").trim());
  /** 顶部引导（helpText/helpUrl，如「如何获取 QQ 邮箱授权码」）。 */
  const helps = fields.filter((f) => f.helpText || f.helpUrl);

  const submit = async () => {
    if (!provider || submitting || missingRequired) return;
    setSubmitting(true);
    setErr(null);
    const trimmed: Record<string, string> = {};
    for (const f of fields) {
      const v = (values[f.key] ?? "").trim();
      if (v) trimmed[f.key] = v;
    }
    const dn = displayName.trim() || undefined;
    try {
      if (isOauth) {
        const r = await api.startConnectorOAuth(auth, provider.id, {
          clientId: trimmed.clientId ?? "",
          clientSecret: trimmed.clientSecret ?? "",
          displayName: dn,
        });
        // 整页跳转授权页；回跳 /?connector_linked=<provider> 由 App 层 toast。
        window.location.href = r.authorizeUrl;
        return; // 跳转中，不再触发本地状态更新
      }
      await api.bindConnector(auth, provider.id, { fields: trimmed, displayName: dn });
      onBound();
    } catch (e) {
      setErr(errText(e, "绑定失败，请重试"));
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={provider != null}
      onOpenChange={(o) => !o && onClose()}
      title={provider ? `绑定 ${provider.label}` : undefined}
      description={
        isOauth
          ? "填写你的自建应用凭据，前往授权后即可完成绑定。"
          : "凭据仅用于服务端加密存储，不会进入对话。"
      }
      footer={
        provider && (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={missingRequired}
              onClick={() => void submit()}
            >
              {isOauth ? "前往授权" : "绑定"}
            </Button>
          </>
        )
      }
    >
      {provider && (
        <div className="flex flex-col gap-3">
          {helps.length > 0 && (
            <div className="rounded-lg bg-hover px-3 py-2.5">
              {helps.map((f) => (
                <div key={f.key} className="text-meta leading-relaxed text-muted">
                  {f.helpText}
                  {f.helpUrl && (
                    <a
                      href={f.helpUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ml-1 inline-flex items-center gap-0.5 text-accent hover:underline"
                    >
                      查看指引
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 提交失败就地渲染在弹层内 —— 面板顶部的 Alert 会被这层遮罩整个盖住。 */}
          {err && (
            <Alert tone="danger" density="compact">
              {err}
            </Alert>
          )}

          {fields.map((f) => (
            <Field key={f.key} label={f.label} required={f.required}>
              <Input
                type={f.type === "password" ? "password" : f.type === "url" ? "url" : "text"}
                value={values[f.key] ?? ""}
                placeholder={f.placeholder}
                autoComplete="off"
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </Field>
          ))}

          <Field label="备注名（可选）">
            <Input
              value={displayName}
              maxLength={64}
              placeholder="如：工作邮箱"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

// ── 声明式绑定弹层（requiredBindSources 驱动；直填落库 / oauth2 整页跳授权） ───

/**
 * 声明式连接器绑定弹层：表单字段由 entry.requiredBindSources 驱动，每个 source 经
 * bindFieldMeta 取 label/输入类型（未知 source 回退密码框）。全部必填，另有可选备注名。
 * 凭据仅用于服务端加密存储，绝不进入对话或容器。
 *
 * 按 authMode 分两条提交路径（判定收口于 isOauthAuthMode，禁散写字符串比较）：
 *   - **oauth2-auth-code**：字段即用户 BYOA 自建应用的 client_id/client_secret →
 *     api.startDeclarativeOauth → 整页跳转授权页（后端回跳 /?connector_linked=<slug>
 *     由 App 层 toast）。此模式走直填 bind 会被后端硬拒，故必须走这条。
 *   - 其余（static-token / token-exchange…）：api.bindDeclarativeConnector 直填落库
 *     （secrets 键 = source 名）。
 */
function DeclarativeBindDialog({
  auth,
  entry,
  onClose,
  onBound,
}: {
  auth: AuthSession;
  entry: DeclarativeCatalogEntry | null;
  onClose: () => void;
  onBound: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 换连接器 / 重开弹层 → 重置表单瞬态（凭据绝不跨连接器残留）。
  useEffect(() => {
    setValues({});
    setDisplayName("");
    setErr(null);
    setSubmitting(false);
  }, [entry?.versionId]);

  const isOauth = entry != null && isOauthAuthMode(entry.authMode);
  // 平台已注册 OAuth App → 用户零填写，一键授权（读后端显式字段，不从空数组反推）。
  const isPlatformOauth = isOauth && entry.clientProvisioning === "platform";
  const sources = entry?.requiredBindSources ?? [];
  const missingRequired = sources.some((s) => !(values[s] ?? "").trim());

  const submit = async () => {
    if (!entry || submitting || missingRequired) return;
    setSubmitting(true);
    setErr(null);
    const secrets: Record<string, string> = {};
    for (const s of sources) {
      const v = (values[s] ?? "").trim();
      if (v) secrets[s] = v;
    }
    const dn = displayName.trim() || undefined;
    try {
      if (isOauth) {
        // 键 = 后端下发的 source 名（client_id / client_secret），非 camelCase。
        const r = await api.startDeclarativeOauth(auth, {
          versionId: entry.versionId,
          clientId: secrets.client_id ?? "",
          clientSecret: secrets.client_secret ?? "",
          displayName: dn,
        });
        // 整页跳转授权页；回跳 /?connector_linked=<slug> 由 App 层 toast。
        window.location.href = r.authorizeUrl;
        return; // 跳转中，不再触发本地状态更新
      }
      await api.bindDeclarativeConnector(auth, {
        versionId: entry.versionId,
        secrets,
        displayName: dn,
      });
      onBound();
    } catch (e) {
      setErr(errText(e, isOauth ? "发起授权失败，请重试" : "绑定失败，请重试"));
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={entry != null}
      onOpenChange={(o) => !o && onClose()}
      title={entry ? `绑定 ${entry.label}` : undefined}
      description={
        isPlatformOauth
          ? "无需填写任何凭据，点击前往授权即可完成绑定。"
          : isOauth
            ? "填写你的自建应用凭据，前往授权后即可完成绑定。"
            : "凭据仅用于服务端加密存储，绝不会进入对话或容器。"
      }
      footer={
        entry && (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={missingRequired}
              onClick={() => void submit()}
            >
              {isOauth ? "前往授权" : "绑定"}
            </Button>
          </>
        )
      }
    >
      {entry && (
        <div className="flex flex-col gap-3">
          {err && (
            <Alert tone="danger" density="compact">
              {err}
            </Alert>
          )}

          {sources.map((s) => {
            const meta = bindFieldMeta(s);
            return (
              <Field key={s} label={meta.label} required>
                <Input
                  type={meta.type === "password" ? "password" : "text"}
                  value={values[s] ?? ""}
                  placeholder={meta.placeholder}
                  autoComplete="off"
                  onChange={(e) => setValues((prev) => ({ ...prev, [s]: e.target.value }))}
                />
              </Field>
            );
          })}

          <Field label="备注名（可选）">
            <Input
              value={displayName}
              maxLength={64}
              placeholder="如：工作账号"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}
