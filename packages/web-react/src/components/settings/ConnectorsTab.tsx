import { Plug, Store } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { type ConnectorConnection, type ConnectorProvider, type ConnectorsResponse, type DeclarativeCatalogEntry, type DeclarativeConnection, type DeclarativeManagementConnector, type DeclarativeManagementResponse, type PluginManagementResponse, type RuntimePluginAccount, type RuntimePluginCatalogEntry, connectorCapabilityLabel, declarativeCapabilityLabel } from '../../lib/connectors'
import type { AuthSession } from '../../lib/types'
import { Alert, Button, EmptyState, ListSkeleton, PanelHeader, useConfirm, useToast } from '../ui'
import { managedPluginProvider } from '../../lib/managedPluginProviders'
import { pluginAccountState, type UnifiedProvider, unifyProviders } from '../../lib/pluginDirectory'
import { BindDialog, DeclarativeBindDialog } from './plugins/BindDialogs'
import { ManagedBrowserSetupDialog } from './plugins/ManagedBrowserSetupDialog'
import { ConnectionRow, ProviderCard } from './plugins/ProviderCard'
import { RuntimePluginCard } from './plugins/RuntimePluginCard'
import { type CardNotice, type UnifiedConnection, errText } from './plugins/shared'

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
  /** 增量目录（声明式 / 运行时 Plugin）降级为空 —— 列表不完整这件事必须对用户可见（M-20）。 */
  const [degraded, setDegraded] = useState(false)
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
    setDegraded(false)
    // 声明式是增量：各自 catch 降级为空，永不 reject 到 Promise.all；只有 v1 会阻断。
    // 降级不再只写 console：卡片少一半时用户分不清「没装」还是「没读到」，
    // 列表顶部给一条 info 提示 + 重试（承接 manage 审计 M-20）。
    const managementP: Promise<DeclarativeManagementResponse> = api
      .getDeclarativeManagement(auth)
      .catch((e) => {
        console.warn('[connectors] 管理聚合加载失败，降级仅显示 v1 连接器', e)
        if (alive) setDegraded(true)
        return { connectors: [], connections: [] }
      })
    const runtimeP: Promise<PluginManagementResponse> = api.getPluginManagement(auth).catch((e) => {
      console.warn('[plugins] 运行时 Plugin 管理加载失败，降级显示现有连接器', e)
      if (alive) setDegraded(true)
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
        if (alive) setErr(errText(e, "暂时读不到你的插件，请稍后重试。"));
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

  /** slug 去重、声明式优先，合并成统一卡片列表（声明式在前，各自保持插入序，渲染稳定）。 */
  const unified = useMemo<UnifiedProvider[]>(
    () => unifyProviders(data?.providers ?? [], management),
    [data, management],
  );

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
    // API 插件（v1 / 声明式）也能被定位（OCV5-379）：AI 市场里点内置插件、已安装页「去绑定」都走这里。
    // 改造前这里只认浏览器插件，API 插件会落到下面「尚未安装到当前版本」的误报。
    const providerCard = plugin ? undefined : unified.find((u) => u.slug === autoAuthorizePluginSlug)
    if (providerCard) {
      const count =
        (v1ConnsBySlug.get(providerCard.slug)?.length ?? 0) +
        (providerCard.system === 'declarative'
          ? (declConnsBySlug.get(providerCard.slug)?.length ?? 0)
          : 0)
      if (count > 0) {
        setCardNotice({
          slug: providerCard.slug,
          tone: 'success',
          text: `${providerCard.label}已连接 ${count} 个账号；需要再绑一个时点「绑定」。`,
        })
        return
      }
      const bindable =
        providerCard.system === 'v1'
          ? // GitHub v1 绑定是整页跳转 OAuth —— 不在用户没点「绑定」时自动离开页面。
            providerCard.slug !== 'github'
          : providerCard.management.canBind && !!providerCard.decl
      if (bindable) {
        startBind(providerCard)
        return
      }
      setCardNotice({
        slug: providerCard.slug,
        tone: providerCard.system === 'v1' ? 'success' : 'warning',
        text:
          providerCard.system === 'v1'
            ? `点「绑定」即可连接${providerCard.label}账号。`
            : `${providerCard.label}当前不可用，请稍后重试。`,
      })
      return
    }
    if (account) {
      setCardNotice({
        slug: autoAuthorizePluginSlug,
        tone: 'success',
        text: `${plugin?.label ?? '插件'}账号已授权，无需重复扫码。`,
      })
      return
    }
    if (staleAccount) {
      // 失效不再让用户先走一遍破坏性解绑：账号行内就有「重新扫码授权」，这里只做定位指引。
      setCardNotice({
        slug: autoAuthorizePluginSlug,
        tone: 'warning',
        text: `${plugin?.label ?? '插件'}账号的登录已失效，点击账号行上的「重新扫码授权」即可恢复。`,
      })
      return
    }
    if (plugin?.installedCurrent && plugin.available) {
      setSetupRuntimeAccountId(null)
      setSetupRuntimeFor(plugin)
      return
    }
    // 「这一个 Plugin 没装到当前版本」是单卡问题，不该占用为「整表读不到」保留的顶层 err
    // 通道 —— 反馈要渲染在发起它的容器里（承接 manage 审计 M-20）。
    setCardNotice({
      slug: autoAuthorizePluginSlug,
      tone: 'warning',
      text: `${plugin?.label ?? '插件'}尚未安装到当前版本，请返回市场完成安装或更新后重试。`,
    })
  }, [
    autoAuthorizePluginSlug,
    declConnsBySlug,
    loading,
    onAutoAuthorizeConsumed,
    runtimeAccounts,
    runtimeCatalog,
    startBind,
    unified,
    v1ConnsBySlug,
  ])

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
        // 改完只 reload 的话，用户看不出到底改没改（承接 manage 审计 M-21）。
        toast(displayName ? "已改名" : "已清空备注名", "success");
      } catch (e) {
        setCardNotice({ slug: conn.provider, tone: "danger", text: errText(e, "重命名失败") });
      }
    },
    [auth, reload, toast],
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
        setCardNotice({ slug: c.slug, tone: "danger", text: errText(e, "更新插件失败") });
      }
    },
    [auth, reload, toast],
  );

  const uninstallMarketConnector = useCallback(
    async (c: DeclarativeManagementConnector) => {
      if (c.installation !== "marketplace" || c.connectionCount > 0) return;
      const ok = await confirm({
        title: `卸载插件「${c.label}」?`,
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
        setCardNotice({ slug: c.slug, tone: "danger", text: errText(e, "卸载插件失败") });
      }
    },
    [auth, confirm, reload, toast],
  );

  const revokeRuntimeAccount = useCallback(
    async (account: RuntimePluginAccount) => {
      const name = account.displayName || account.accountHint || account.provider
      const ok = await confirm({
        title: `解绑「${name}」?`,
        body: '解绑后插件将立即无法访问该账号，加密保存的登录状态会被销毁。此操作不可撤销。',
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
          text: errText(e, '解绑插件账号失败'),
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
        managedPluginProvider(plugin.slug).qrRelink &&
        plugin.installedCurrent &&
        account.versionId === plugin.versionId
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
          text: errText(e, plugin.installed ? '更新插件失败' : '重新安装插件失败'),
        })
      }
    },
    [auth, reload, toast],
  )

  const uninstallRuntimePlugin = useCallback(
    async (plugin: RuntimePluginCatalogEntry, accountCount: number) => {
      if (!plugin.installed || accountCount > 0) return
      const ok = await confirm({
        title: `卸载插件「${plugin.label}」?`,
        body: '卸载后不能再执行该插件；以后仍可从 AI 市场重新安装。',
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
        setCardNotice({ slug: plugin.slug, tone: 'danger', text: errText(e, '卸载插件失败') })
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
            text: errText(error, '切换插件写入能力失败'),
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
            text: errText(error, '切换插件免逐次确认失败'),
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
      {/* 「插件」是唯一对用户的名词（与分区名一致）。窄屏标题/说明只留给读屏，
          「添加」portal 进上下文行右侧；它是本分区唯一的头部动作。 */}
      <PanelHeader
        title="插件"
        hint="绑定账号后，助手就能在对话中使用它们；写入默认逐次确认。"
        action={
          onOpenMarketplace && (
            <Button size="sm" variant="ghost" onClick={onOpenMarketplace} aria-label="添加插件">
              <Store size={14} strokeWidth={1.75} aria-hidden="true" /> 添加
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

        {/* 增量目录降级：卡片少一半时说清是「读不到」而不是「没装」，并给重试（M-20）。 */}
        {degraded && !loading && (
          <Alert
            tone="info"
            density="compact"
            data-testid="connectors-degraded"
            action={
              <Button size="sm" variant="secondary" onClick={retry}>
                重试
              </Button>
            }
          >
            部分插件目录暂时读不到，已显示可用部分。
          </Alert>
        )}

        {loading ? (
          <ListSkeleton rows={3} />
        ) : (
          <>
            {/* 每个插件是一段「标题 + 说明 + 元信息 + 它的账号列表」，段与段之间一条发丝线；
                不再是「每个插件一张卡、卡里再套账号卡」。两组都非空时才出组标题。 */}
            {connectedCards.length > 0 && (
              <ConnectorGroup label={grouped ? '已连接' : undefined} count={connectedCards.length}>
                {connectedCards.map(renderCard)}
              </ConnectorGroup>
            )}
            {availableCards.length > 0 && (
              <ConnectorGroup
                label={grouped ? '可添加' : undefined}
                count={availableCards.length}
                className={grouped ? 'mt-6' : undefined}
              >
                {availableCards.map(renderCard)}
              </ConnectorGroup>
            )}
            {!err && allCards.length === 0 && (
              <div className="-mx-4">
                <EmptyState
                  icon={Plug}
                  title="还没有插件"
                  hint="从市场安装后，就能把邮箱、网盘、笔记等账号交给助手使用。"
                  action={
                    onOpenMarketplace && (
                      <Button size="sm" variant="secondary" onClick={onOpenMarketplace}>
                        <Store size={14} strokeWidth={1.75} /> 去市场看看
                      </Button>
                    )
                  }
                />
              </div>
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
          const label = setupRuntimeFor?.label ?? '插件'
          // 授权结果落在**那张卡片上**：弹层关掉后用户回到列表，提示就在他刚授权的那张卡里。
          if (setupRuntimeFor)
            setCardNotice({
              slug: setupRuntimeFor.slug,
              tone: 'success',
              text: setupRuntimeAccountId
                ? `${label}登录已更新；为保护新账号，写入能力和免逐次确认均已关闭，可按需重新开启。`
                : agentReady
                  ? `${label}账号已授权，Agent 现在可以直接读取相关内容；写入能力默认关闭。`
                  : `${label}登录信息已加密保存；系统完成插件升级后会自动启用。`,
            })
          reload()
        }}
      />
      {confirmEl}
    </div>
  );
}

/** 插件分组：可选的弱化组标题（名称 + 等宽计数）+ 发丝线分隔的插件段。 */
function ConnectorGroup({
  label,
  count,
  className,
  children,
}: {
  label?: string
  count: number
  className?: string
  children: ReactNode
}) {
  return (
    <div className={className}>
      {label && (
        <h4 className="flex items-baseline gap-2 border-b border-border pb-2 text-meta font-medium text-faint">
          {label}
          <span className="tabular-nums">{count}</span>
        </h4>
      )}
      <div className="flex flex-col">{children}</div>
    </div>
  )
}
