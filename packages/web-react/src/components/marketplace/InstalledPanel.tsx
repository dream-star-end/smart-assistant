import {
  AlertTriangle,
  ArrowUpCircle,
  Loader2,
  PackageOpen,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { updateAvailable } from "../../lib/marketplace";
import type { AuthSession, MarketplaceInstalled, MarketplaceMyAgent } from "../../lib/types";
import { AgentScopePicker, AgentScopeSummary, normalizeAgentScope } from "../AgentScopePicker";
import { Alert, Badge, Button, EmptyState, Modal, Spinner } from "../ui";

type UninstallReason =
  | "not_needed"
  | "poor_quality"
  | "missing_capability"
  | "install_error"
  | "other"
  | "prefer_not_say";

const UNINSTALL_REASON_OPTIONS: Array<{ value: UninstallReason; label: string }> = [
  { value: "prefer_not_say", label: "不说明" },
  { value: "not_needed", label: "暂时不需要" },
  { value: "poor_quality", label: "效果不好" },
  { value: "missing_capability", label: "缺少我需要的能力" },
  { value: "install_error", label: "安装或使用有问题" },
  { value: "other", label: "其他" },
];

/**
 * 我的已安装：列出当前安装的技能/智能体,可卸载;有新上架版本的给「更新」按钮
 * （复用 install 的幂等替换语义,以后端校验为准）;被平台下架(revoked)的醒目提醒。
 */
export function InstalledPanel({
  auth,
  onGoBrowse,
  onOpenConnectors,
}: {
  auth: AuthSession;
  onGoBrowse: () => void;
  onOpenConnectors?: (pluginSlug?: string) => void;
}) {
  const [rows, setRows] = useState<MarketplaceInstalled[] | null>(null);
  const [agents, setAgents] = useState<MarketplaceMyAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<MarketplaceInstalled | null>(null);
  const [editScope, setEditScope] = useState<string[]>(["main"]);
  const [reload, setReload] = useState(0);
  const [pendingUninstall, setPendingUninstall] = useState<{
    slug: string;
    name: string;
    isAgent: boolean;
  } | null>(null);
  const [uninstallReason, setUninstallReason] =
    useState<UninstallReason>("prefer_not_say");
  const connectorCount = rows?.filter((r) => r.kind === "connector").length ?? 0;
  const visibleRows = rows?.filter((r) => r.kind !== "connector") ?? null;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([
      api.listMarketplaceInstalled(auth),
      api.listMyAgents(auth).catch(() => [] as MarketplaceMyAgent[]),
    ])
      .then(([r, a]) => {
        if (!alive) return;
        setRows(r);
        setAgents(
          a.length
            ? a
            : [
                {
                  id: "main",
                  slug: "main",
                  name: "全能助手",
                  description: "",
                  installed: true,
                  isDefault: true,
                },
              ],
        );
      })
      .catch((e) => alive && setErr(apiErrorMessage(e, "加载已安装失败")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const uninstall = useCallback(async () => {
    if (!pendingUninstall) return;
    setBusy(pendingUninstall.slug);
    setErr(null);
    try {
      await api.uninstallMarketplace(auth, pendingUninstall.slug, uninstallReason);
      setPendingUninstall(null);
      setUninstallReason("prefer_not_say");
      setReload((n) => n + 1);
    } catch (e) {
      setErr(apiErrorMessage(e, "卸载失败"));
    } finally {
      setBusy(null);
    }
  }, [auth, pendingUninstall, uninstallReason]);

  // 更新 = 安装 listing 当前上架版本。latestVersionId 可能在打开面板后又变化,
  // 以后端 install 校验为准:失败(非当前版本)则报错并刷新列表。
  const update = useCallback(
    async (row: MarketplaceInstalled) => {
      if (!row.latestVersionId) return;
      setBusy(row.slug);
      setErr(null);
      try {
        await api.installMarketplace(
          auth,
          row.latestVersionId,
          row.kind === "skill"
            ? normalizeAgentScope(row.agentIds ?? row.manualAgentIds)
            : undefined,
          row.kind === "skill",
        );
        setReload((n) => n + 1);
      } catch (e) {
        setErr(apiErrorMessage(e, "更新失败"));
        setReload((n) => n + 1);
      } finally {
        setBusy(null);
      }
    },
    [auth],
  );

  const openScopeEditor = (row: MarketplaceInstalled) => {
    setEditing(row);
    setEditScope(normalizeAgentScope(row.manualAgentIds ?? row.agentIds));
  };

  const saveScope = async () => {
    if (!editing) return;
    setBusy(editing.slug);
    setErr(null);
    try {
      await api.updateMarketplaceInstallAgents(auth, editing.slug, editScope);
      setEditing(null);
      setReload((n) => n + 1);
    } catch (e) {
      setErr(apiErrorMessage(e, "保存归属失败"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col">
      <Modal
        open={pendingUninstall !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setPendingUninstall(null);
        }}
        title={
          pendingUninstall
            ? `卸载${pendingUninstall.isAgent ? "智能体" : "技能"}「${pendingUninstall.name}」?`
            : undefined
        }
        description={
          pendingUninstall?.isAgent
            ? "智能体会被移除；仅由它自动带来的 Skill 会退出。Plugin 会保留到你主动卸载。"
            : "卸载后将不再可用；其他智能体对它的依赖会明确显示为未就绪。"
        }
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setPendingUninstall(null)}
            >
              取消
            </Button>
            <Button variant="danger" disabled={busy !== null} onClick={() => void uninstall()}>
              {busy !== null && <Loader2 size={14} className="animate-spin" />}
              卸载
            </Button>
          </>
        }
      >
        <label className="block text-[12.5px] text-muted">
          原因（可不说明）
          <select
            value={uninstallReason}
            disabled={busy !== null}
            onChange={(event) => setUninstallReason(event.target.value as UninstallReason)}
            className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg"
          >
            {UNINSTALL_REASON_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </Modal>
      <Modal
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title="修改技能归属"
        description={editing ? `选择「${editing.name}」要安装给哪些智能体` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={saveScope}
              disabled={!editing || editScope.length === 0 || busy === editing.slug}
            >
              {editing && busy === editing.slug && <Loader2 size={14} className="animate-spin" />}
              保存
            </Button>
          </>
        }
      >
        <AgentScopePicker agents={agents} selectedIds={editScope} onChange={setEditScope} />
      </Modal>
      {err && (
        <div className="px-4 pt-3">
          <Alert tone="danger">{err}</Alert>
        </div>
      )}
      {connectorCount > 0 && (
        <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/30 bg-accent-soft/40 px-3 py-2.5">
          <span className="text-[12.5px] text-muted">
            {connectorCount} 个 API 连接插件在管理中心统一绑定账号、更新与卸载。
          </span>
          {onOpenConnectors && (
            <Button size="sm" variant="secondary" onClick={() => onOpenConnectors()}>
              管理插件账号
            </Button>
          )}
        </div>
      )}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-faint">
          <Spinner /> 加载已安装…
        </div>
      ) : !visibleRows || visibleRows.length === 0 ? (
        <EmptyState
          icon={PackageOpen}
          title={connectorCount > 0 ? "技能与智能体暂无安装" : "还没有安装任何技能或智能体"}
          hint="去市场发现别人沉淀好的能力，一键安装即可使用。"
          action={
            <Button variant="secondary" size="sm" onClick={onGoBrowse}>
              去市场看看
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2 px-4 py-4">
          {visibleRows.map((r) => {
            const revoked = r.listingState === "revoked";
            const canUpdate = updateAvailable(r);
            const dormant = r.kind === "skill" && (r.agentIds?.length ?? 0) === 0;
            return (
              <li
                key={r.slug}
                className="flex items-center gap-3 rounded-xl border border-border bg-elevated px-3.5 py-3"
              >
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                    revoked ? "bg-warning-soft text-warning" : "bg-success-soft text-success"
                  }`}
                >
                  {revoked ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-medium text-fg">{r.name}</span>
                    {r.kind === "agent" && <Badge tone="accent">智能体</Badge>}
                    {r.kind === "agent" && r.capabilityReadiness?.ready === true && (
                      <Badge tone="success">能力已就绪</Badge>
                    )}
                    {r.kind === "agent" &&
                      r.capabilityReadiness?.ready === true &&
                      r.capabilityReadiness.needsAuthorization.length > 0 && (
                        <Badge tone="warning">可选 Plugin 待授权</Badge>
                      )}
                    {r.kind === "agent" && r.capabilityReadiness?.ready === false && (
                      <Badge tone="warning">
                        {r.capabilityReadiness.needsAuthorization.length > 0
                          ? "Plugin 待授权"
                          : "能力未就绪"}
                      </Badge>
                    )}
                    <Badge tone="neutral">v{r.version}</Badge>
                    {canUpdate && r.latestVersion && (
                      <Badge tone="accent">
                        <ArrowUpCircle size={11} /> 新版本 v{r.latestVersion}
                      </Badge>
                    )}
                    {revoked && <Badge tone="warning">已被下架</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-muted">
                    {revoked
                      ? `平台已下架该${r.kind === "agent" ? "智能体" : "技能"}，将自动从你的会话移除。`
                      : r.slug}
                  </p>
                  {r.kind === "agent" && r.capabilityReadiness && (
                    <p className="mt-1 text-[11.5px] text-faint">
                      {r.capabilityReadiness.requirements.length === 0
                        ? "不依赖额外 Skill / Plugin"
                        : `${r.capabilityReadiness.requirements.filter((item) => item.status === "ready").length}/${r.capabilityReadiness.requirements.length} 项组合能力就绪`}
                    </p>
                  )}
                  {r.kind === "skill" && !revoked && (
                    <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
                      <span>适用：</span>
                      <AgentScopeSummary agentIds={r.agentIds} agents={agents} />
                    </div>
                  )}
                </div>
                {canUpdate && !dormant && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => update(r)}
                    disabled={busy === r.slug}
                  >
                    {busy === r.slug ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <ArrowUpCircle size={14} />
                    )}
                    更新
                  </Button>
                )}
                {r.kind === "agent" &&
                  (r.capabilityReadiness?.needsAuthorization.length ?? 0) > 0 &&
                  onOpenConnectors && (
                    <Button variant="secondary" size="sm" onClick={() => onOpenConnectors()}>
                      授权 Plugin
                    </Button>
                  )}
                {r.kind === "skill" && !revoked && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openScopeEditor(r)}
                    disabled={busy === r.slug}
                  >
                    <Settings2 size={14} />
                    归属
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setUninstallReason("prefer_not_say");
                    setPendingUninstall({
                      slug: r.slug,
                      name: r.name,
                      isAgent: r.kind === "agent",
                    });
                  }}
                  disabled={busy === r.slug}
                  aria-label="卸载"
                >
                  <Trash2 size={15} />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
