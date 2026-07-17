import { ArrowUpCircle, Check, ExternalLink, Pencil, QrCode, Store, Trash2, X } from 'lucide-react'
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
import { Alert, Button, IconButton, Input, Modal, Spinner, useConfirm } from "../ui";

/** 把 ApiError 的机器码映射为中文（无码/未知码走 apiErrorMessage 收口：后端中文直显、
 *  英文/技术串回退 fallback + 追踪号，绝不裸露码或英文原文）。 */
function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.code) return connectorErrorText(e.code);
  return apiErrorMessage(e, fallback);
}

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
  const [err, setErr] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  /** 打开 v1 绑定弹层的 provider（github 不走弹层，直接跳 OAuth）。 */
  const [bindFor, setBindFor] = useState<ConnectorProvider | null>(null);
  /** 打开声明式绑定弹层的 catalog 条目。 */
  const [bindDeclFor, setBindDeclFor] = useState<DeclarativeCatalogEntry | null>(null)
  const [setupRuntimeFor, setSetupRuntimeFor] = useState<RuntimePluginCatalogEntry | null>(null)
  const [confirm, confirmEl] = useConfirm()

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
        if (alive) setErr(errText(e, "加载应用连接失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

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
    setSuccess(null)
    setErr(null)
    if (account) {
      setSuccess(`${plugin?.label ?? 'Plugin'}账号已授权，无需重复扫码。`)
      return
    }
    if (staleAccount) {
      setErr('现有 Plugin 账号已失效；请先在下方解绑，再更新并重新扫码授权。')
      return
    }
    if (plugin?.installedCurrent && plugin.available) {
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
          .catch((e) => setErr(errText(e, "发起 GitHub 授权失败")));
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
        reload();
      } catch (e) {
        setErr(errText(e, "解绑失败"));
      }
    },
    [auth, confirm, reload],
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
        setErr(errText(e, "重命名失败"));
      }
    },
    [auth, reload],
  );

  const updateMarketConnector = useCallback(
    async (c: DeclarativeManagementConnector) => {
      if (!c.latestVersionId) return;
      setErr(null);
      try {
        await api.installMarketplace(auth, c.latestVersionId);
        reload();
      } catch (e) {
        setErr(errText(e, "更新 API 插件失败"));
      }
    },
    [auth, reload],
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
      setErr(null);
      try {
        await api.uninstallMarketplace(auth, c.slug);
        reload();
      } catch (e) {
        setErr(errText(e, "卸载 API 插件失败"));
      }
    },
    [auth, confirm, reload],
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
      setSuccess(null)
      setErr(null)
      try {
        await api.revokePluginAccount(auth, account.id)
        reload()
      } catch (e) {
        setErr(errText(e, '解绑 Plugin 账号失败'))
      }
    },
    [auth, confirm, reload],
  )

  const updateRuntimePlugin = useCallback(
    async (plugin: RuntimePluginCatalogEntry, accountCount: number) => {
      if (!plugin.latestVersionId || !plugin.updateAvailable || accountCount > 0) return
      setSuccess(null)
      setErr(null)
      try {
        await api.installMarketplace(auth, plugin.latestVersionId)
        reload()
      } catch (e) {
        setErr(errText(e, plugin.installed ? '更新 Plugin 失败' : '重新安装 Plugin 失败'))
      }
    },
    [auth, reload],
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
      setSuccess(null)
      setErr(null)
      try {
        await api.uninstallMarketplace(auth, plugin.slug)
        reload()
      } catch (e) {
        setErr(errText(e, '卸载 Plugin 失败'))
      }
    },
    [auth, confirm, reload],
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
        <Spinner /> 加载应用连接…
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-4">
        <p className="text-[12.5px] leading-relaxed text-faint">
          绑定你的应用账号后，AI 助手即可在对话中访问这些应用；所有写入类操作（发邮件、
          上传文件等）都会先在对话里向你逐次确认，未经确认不会执行。
        </p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-faint">
            官方预装、市场安装与已绑定账号在这里统一管理。
          </span>
          {onOpenMarketplace && (
            <Button size="sm" variant="secondary" onClick={onOpenMarketplace}>
              <Store size={13} /> 去市场添加
            </Button>
          )}
        </div>
        {err && (
          <Alert tone="danger" className="mt-3 text-[12.5px]">
            {err}
          </Alert>
        )}
        {success && (
          <Alert tone="success" className="mt-3 text-[12.5px]">
            {success}
          </Alert>
        )}
      </div>

      <div className="flex flex-col gap-3 px-5 py-4">
        {runtimeCatalog.map((plugin) => {
          const accounts = runtimeAccounts.filter((account) => account.provider === plugin.slug)
          return (
            <RuntimePluginCard
              key={plugin.slug}
              plugin={plugin}
              accounts={accounts}
              onAuthorize={() => {
                setSuccess(null)
                setErr(null)
                setSetupRuntimeFor(plugin)
              }}
              onUpdate={() => void updateRuntimePlugin(plugin, accounts.length)}
              onUninstall={() => void uninstallRuntimePlugin(plugin, accounts.length)}
              onRevoke={(account) => void revokeRuntimeAccount(account)}
            />
          )
        })}
        {unified.map((u) => (
          <ProviderCard
            key={u.slug}
            slug={u.slug}
            label={u.label}
            description={u.description}
            capabilityLabel={
              u.system === "declarative"
                ? u.decl
                  ? declarativeCapabilityLabel(u.decl.actions)
                  : "当前不可用"
                : connectorCapabilityLabel(u.slug)
            }
            connections={
              u.system === "declarative"
                ? [...(declConnsBySlug.get(u.slug) ?? []), ...(v1ConnsBySlug.get(u.slug) ?? [])]
                : (v1ConnsBySlug.get(u.slug) ?? [])
            }
            onBind={() => startBind(u)}
            canBind={u.system === "v1" || u.management.canBind}
            management={u.system === "declarative" ? u.management : undefined}
            onUpdate={
              u.system === "declarative"
                ? () => void updateMarketConnector(u.management)
                : undefined
            }
            onUninstallMarket={
              u.system === "declarative"
                ? () => void uninstallMarketConnector(u.management)
                : undefined
            }
            onUnbind={unbind}
            onRename={rename}
            onRelink={(c) => relink(u, c)}
          />
        ))}
        {data && unified.length === 0 && runtimeCatalog.length === 0 && (
          <p className="py-6 text-center text-[13px] text-faint">暂无可绑定的应用。</p>
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
      <KnowledgePlanetSetupDialog
        key={setupRuntimeFor?.versionId ?? 'closed'}
        auth={auth}
        plugin={setupRuntimeFor}
        onClose={() => setSetupRuntimeFor(null)}
        onBound={(agentReady) => {
          setErr(null)
          setSuccess(
            agentReady
              ? '知识星球账号已授权并自动启用，Agent 现在可以直接读取相关内容。'
              : '知识星球登录信息已加密保存；系统完成 Plugin 升级后会自动启用。',
          )
          reload()
        }}
      />
      {confirmEl}
    </div>
  );
}

function RuntimePluginCard({
  plugin,
  accounts,
  onAuthorize,
  onUpdate,
  onUninstall,
  onRevoke,
}: {
  plugin: RuntimePluginCatalogEntry
  accounts: RuntimePluginAccount[]
  onAuthorize: () => void
  onUpdate: () => void
  onUninstall: () => void
  onRevoke: (account: RuntimePluginAccount) => void
}) {
  const Icon = connectorIcon(plugin.slug)
  const canSelfAuthorize = plugin.slug === 'knowledge-planet' && plugin.installedCurrent
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-medium text-fg">{plugin.label}</span>
            <span className="rounded-full bg-hover px-2 py-0.5 text-[10.5px] text-muted">只读</span>
            {plugin.installed ? (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] text-accent">
                市场已安装 · v{plugin.installedVersion}
              </span>
            ) : (
              <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10.5px] text-warning">
                历史账号 · 当前未安装
              </span>
            )}
            {plugin.updateAvailable && plugin.latestVersion && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] text-accent">
                {plugin.installed ? `可更新 v${plugin.latestVersion}` : '可重新安装'}
              </span>
            )}
            {plugin.pluginType === 'managed-browser' && (
              <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] text-success">
                隔离运行
              </span>
            )}
            {accounts.length > 0 && (
              <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] text-success">
                已授权
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-faint">{plugin.description}</p>
          <p className="mt-1 text-[11px] text-faint">
            {plugin.actions.length} 项只读能力
            {plugin.accountMode === 'none' ? ' · 无需账号' : ' · 账号登录状态加密保存'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {plugin.updateAvailable && (
            <Button
              variant="primary"
              size="sm"
              onClick={onUpdate}
              disabled={accounts.length > 0}
              title={accounts.length > 0 ? '请先解绑 Plugin 账号再更新' : undefined}
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
              title={canSelfAuthorize ? '使用微信扫码授权' : '该 Plugin 暂未提供自助授权流程'}
            >
              <QrCode size={13} /> {canSelfAuthorize ? '微信扫码授权' : '暂不可授权'}
            </Button>
          )}
          {plugin.installed && (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger"
              onClick={onUninstall}
              disabled={accounts.length > 0}
              title={accounts.length > 0 ? '请先解绑 Plugin 账号' : '卸载 Plugin'}
            >
              <Trash2 size={13} /> 卸载
            </Button>
          )}
        </div>
      </div>
      {!plugin.available && (
        <Alert tone="warning" className="mt-2 text-[11.5px]">
          该 Plugin 当前已下架、被撤销或签名契约不可用；保留在此供你解绑历史账号或卸载。
        </Alert>
      )}
      {accounts.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-border border-t border-border pt-1">
          {accounts.map((account) => (
            <li key={account.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-fg">
                  {account.displayName || plugin.label}
                </div>
                {account.accountHint && (
                  <div className="truncate text-[11px] text-faint">{account.accountHint}</div>
                )}
              </div>
              <span className={account.executable ? 'text-[11px] text-success' : 'text-[11px] text-warning'}>
                {account.status === 'error'
                  ? '需重新授权'
                  : account.executable
                    ? '可用'
                    : plugin.updateAvailable
                      ? '需先更新'
                      : plugin.installedCurrent && account.versionId !== plugin.versionId
                        ? '需重新授权'
                        : '当前不可用'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-danger"
                onClick={() => onRevoke(account)}
              >
                <Trash2 size={13} /> 解绑
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function KnowledgePlanetSetupDialog({
  auth,
  plugin,
  onClose,
  onBound,
}: {
  auth: AuthSession
  plugin: RuntimePluginCatalogEntry | null
  onClose: () => void
  onBound: (agentReady: boolean) => void
}) {
  const [starting, setStarting] = useState(false)
  const [setup, setSetup] = useState<KnowledgePlanetSetupView | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reportedActive, setReportedActive] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const setupSessionId = setup?.sessionId ?? null
  const setupStatus = setup?.status ?? null
  const setupQrReady = setup?.qrReady === true
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
      (item) => item.provider === 'knowledge-planet' && item.status === 'active',
    )
  }, [auth])

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
      void api
        .getKnowledgePlanetSetup(auth, setupSessionId)
        .then((next) => {
          if (!cancelled) {
            setSetup(next)
            setError(null)
          }
        })
        .catch(async (e) => {
          if (cancelled) return
          if (e instanceof ApiError && e.code === 'SETUP_NOT_FOUND') {
            const account = await findExistingAccount().catch(() => undefined)
            if (cancelled) return
            if (account) {
              markExistingAccountActive(account, setupSessionId)
              return
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
  }, [auth, findExistingAccount, markExistingAccountActive, setupSessionId, setupStatus])

  useEffect(() => {
    if (!setupQrReady || !setupSessionId || qrUrl) return
    let cancelled = false
    let timer: number | undefined
    const load = () => {
      void api
        .getKnowledgePlanetSetupQr(auth, setupSessionId)
        .then((blob) => {
          if (cancelled) return
          setQrUrl(URL.createObjectURL(blob))
          setError(null)
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
  }, [auth, qrUrl, setupQrReady, setupSessionId])

  useEffect(() => {
    if (setupStatus !== 'active' || reportedActive) return
    setReportedActive(true)
    onBound(setup?.agentReady !== false)
  }, [onBound, reportedActive, setup?.agentReady, setupStatus])

  const start = async () => {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      setSetup(await api.startKnowledgePlanetSetup(auth))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ACCOUNT_ALREADY_EXISTS') {
        const account = await findExistingAccount().catch(() => undefined)
        if (account) {
          markExistingAccountActive(account)
          return
        }
      }
      setError(errText(e, '发起知识星球授权失败'))
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
        await api.cancelKnowledgePlanetSetup(auth, setup.sessionId)
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
      title="授权知识星球"
      description="微信扫码一次即可；Plugin 只读取你已加入星球的内容，不执行发布、评论或删除。"
      footer={
        <>
          {setup?.status !== 'active' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={cancelling || setup?.status === 'finalizing'}
              onClick={() => void close()}
            >
              {cancelling
                ? '正在取消…'
                : setup?.status === 'finalizing'
                  ? '正在安全保存…'
                  : '取消'}
            </Button>
          )}
          {!setup && (
            <Button
              variant="primary"
              size="sm"
              disabled={starting}
              onClick={() => void start()}
            >
              <QrCode size={13} /> {starting ? '正在生成二维码…' : '同意并生成二维码'}
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
        {error && <Alert tone="danger">{error}</Alert>}
        {!setup && (
          <div className="rounded-lg bg-hover px-3 py-2.5 text-[12px] leading-relaxed text-muted">
            点击“同意并生成二维码”即表示你同意使用微信扫码授权只读访问。登录状态仅保存在服务端加密账号库中；Plugin
            只通过固定域名白名单读取数据，不会发布、评论、点赞或删除内容。
          </div>
        )}
        {setup && !terminalFailure && (
          <ol
            className="grid grid-cols-4 gap-1 rounded-lg border border-border bg-surface px-2 py-2"
            aria-label="知识星球授权进度"
          >
            {['生成二维码', '微信确认', '加密保存', '授权完成'].map((label, index) => {
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
                  key={label}
                  className={`flex min-w-0 flex-col items-center gap-1 text-center text-[10.5px] ${
                    complete || active ? 'text-accent' : 'text-faint'
                  }`}
                >
                  <span
                    className={`flex size-5 items-center justify-center rounded-full border ${
                      complete
                        ? 'border-accent bg-accent text-white'
                        : active
                          ? 'border-accent bg-accent-soft'
                          : 'border-border'
                    }`}
                  >
                    {complete ? <Check size={12} /> : active ? <Spinner /> : index + 1}
                  </span>
                  <span className="truncate">{label}</span>
                </li>
              )
            })}
          </ol>
        )}
        {setup?.status === 'waiting_for_scan' && (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-border bg-white p-4">
            {qrUrl ? (
              <img src={qrUrl} alt="知识星球微信登录二维码" className="size-56 object-contain" />
            ) : (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                <Spinner /> 正在加载二维码…
              </div>
            )}
            <output className="text-center text-[12px] text-muted" aria-live="polite">
              {setupPhase === 'generating_qr'
                ? '正在安全生成微信二维码，通常需要几秒…'
                : '二维码已生成 · 请使用微信扫码，并在手机上确认登录'}
            </output>
          </div>
        )}
        {setup?.status === 'finalizing' && (
          <output
            className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted"
            aria-live="polite"
          >
            <Spinner />{' '}
            {setupPhase === 'scan_confirmed'
              ? '微信扫码已确认 · 正在校验并关闭临时登录环境…'
              : '登录状态有效 · 正在加密保存账号…'}
          </output>
        )}
        {setup?.status === 'active' && (
          <Alert tone="success">
            {setup.agentReady === false
              ? '微信登录已确认，登录信息已加密保存。系统完成 Plugin 升级后会自动启用，无需再次扫码。'
              : '授权成功，知识星球已自动启用；Agent 现在可以直接读取相关内容。'}
          </Alert>
        )}
        {terminalFailure && (
          <Alert tone="warning">
            {setup.status === 'expired' ? '二维码已过期，请重新授权。' : '本次授权未完成，请重试。'}
          </Alert>
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
  onBind,
  canBind = true,
  management,
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
  onBind: () => void;
  canBind?: boolean;
  management?: DeclarativeManagementConnector;
  onUpdate?: () => void;
  onUninstallMarket?: () => void;
  onUnbind: (conn: UnifiedConnection) => void;
  onRename: (conn: ConnectorConnection, displayName: string) => void;
  onRelink: (conn: UnifiedConnection) => void;
}) {
  const Icon = connectorIcon(slug);
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-medium text-fg">{label}</span>
            <span className="rounded-full bg-hover px-2 py-0.5 text-[10.5px] text-muted">
              {capabilityLabel}
            </span>
            {management?.installation === "default" && (
              <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] text-success">
                官方预装
              </span>
            )}
            {management?.installation === "marketplace" && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] text-accent">
                市场已安装{management.installedVersion ? ` · v${management.installedVersion}` : ""}
              </span>
            )}
            {management?.installation === "orphan" && (
              <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10.5px] text-warning">
                历史绑定 · 当前未安装
              </span>
            )}
            {management?.updateAvailable && management.latestVersion && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] text-accent">
                可更新 v{management.latestVersion}
              </span>
            )}
            {connections.length > 0 && (
              <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] text-success">
                已绑定 {connections.length} 个账号
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-faint">{description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {management?.updateAvailable && onUpdate && (
            <Button variant="primary" size="sm" onClick={onUpdate}>
              <ArrowUpCircle size={13} /> 更新
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onBind} disabled={!canBind}>
            {canBind ? (connections.length > 0 ? "添加账号" : "绑定") : "不可绑定"}
          </Button>
          {management?.installation === "marketplace" && onUninstallMarket && (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger"
              onClick={onUninstallMarket}
              disabled={management.connectionCount > 0}
              title={management.connectionCount > 0 ? "请先解绑全部账号" : "卸载 API 插件"}
            >
              <Trash2 size={13} /> 卸载
            </Button>
          )}
        </div>
      </div>

      {management && !management.available && (
        <Alert tone="warning" className="mt-2 text-[11.5px]">
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
    </div>
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
  onUnbind: (conn: UnifiedConnection) => void;
  onRename: (conn: ConnectorConnection, displayName: string) => void;
  onRelink: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(conn.displayName);
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
              className="h-8 max-w-56 md:text-[13px]"
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
            <span className="truncate text-[13px] text-fg">
              {conn.displayName || conn.accountHint || "未命名连接"}
            </span>
            {canRename && (
              <IconButton size="sm" aria-label="编辑备注名" onClick={() => setEditing(true)}>
                <Pencil size={13} />
              </IconButton>
            )}
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
          {conn.accountHint && <span className="truncate">{conn.accountHint}</span>}
          {!hasError && <span className="text-success">正常</span>}
          {needsRelink && <span className="text-warning">需要重新绑定</span>}
          {hasError && !needsRelink && (
            <span className="text-danger">{connectorErrorText(conn.lastErrorCode)}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {needsRelink && (
          <Button variant="secondary" size="sm" onClick={onRelink}>
            重新绑定
          </Button>
        )}
        <IconButton
          size="sm"
          aria-label="解绑"
          className="text-danger"
          onClick={() => onUnbind(conn)}
        >
          <Trash2 size={14} />
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
              disabled={submitting || missingRequired}
              onClick={() => void submit()}
            >
              {submitting ? "提交中…" : isOauth ? "前往授权" : "绑定"}
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
                <div key={f.key} className="text-[12px] leading-relaxed text-muted">
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

          {err && (
            <Alert tone="danger" className="text-[12.5px]">
              {err}
            </Alert>
          )}

          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[12.5px] text-muted">
                {f.label}
                {f.required && <span className="ml-0.5 text-danger">*</span>}
              </span>
              <Input
                type={f.type === "password" ? "password" : f.type === "url" ? "url" : "text"}
                value={values[f.key] ?? ""}
                placeholder={f.placeholder}
                autoComplete="off"
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </label>
          ))}

          <label className="flex flex-col gap-1">
            <span className="text-[12.5px] text-muted">备注名（可选）</span>
            <Input
              value={displayName}
              maxLength={64}
              placeholder="如：工作邮箱"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
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
              disabled={submitting || missingRequired}
              onClick={() => void submit()}
            >
              {submitting ? "提交中…" : isOauth ? "前往授权" : "绑定"}
            </Button>
          </>
        )
      }
    >
      {entry && (
        <div className="flex flex-col gap-3">
          {err && (
            <Alert tone="danger" className="text-[12.5px]">
              {err}
            </Alert>
          )}

          {sources.map((s) => {
            const meta = bindFieldMeta(s);
            return (
              <label key={s} className="flex flex-col gap-1">
                <span className="text-[12.5px] text-muted">
                  {meta.label}
                  <span className="ml-0.5 text-danger">*</span>
                </span>
                <Input
                  type={meta.type === "password" ? "password" : "text"}
                  value={values[s] ?? ""}
                  placeholder={meta.placeholder}
                  autoComplete="off"
                  onChange={(e) => setValues((prev) => ({ ...prev, [s]: e.target.value }))}
                />
              </label>
            );
          })}

          <label className="flex flex-col gap-1">
            <span className="text-[12.5px] text-muted">备注名（可选）</span>
            <Input
              value={displayName}
              maxLength={64}
              placeholder="如：工作账号"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
        </div>
      )}
    </Modal>
  );
}
