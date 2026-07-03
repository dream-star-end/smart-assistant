import { AlertTriangle, ArrowUpCircle, Loader2, PackageOpen, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { updateAvailable } from "../../lib/marketplace";
import type { AuthSession, MarketplaceInstalled } from "../../lib/types";
import { Alert, Badge, Button, EmptyState, Spinner, useConfirm } from "../ui";

/**
 * 我的已安装：列出当前安装的技能/角色,可卸载;有新上架版本的给「更新」按钮
 * （复用 install 的幂等替换语义,以后端校验为准）;被平台下架(revoked)的醒目提醒。
 */
export function InstalledPanel({ auth, onGoBrowse }: { auth: AuthSession; onGoBrowse: () => void }) {
  const [rows, setRows] = useState<MarketplaceInstalled[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [confirmDialog, confirmDialogEl] = useConfirm();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .listMarketplaceInstalled(auth)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setErr((e as Error).message || "加载已安装失败"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const uninstall = useCallback(
    async (slug: string, name: string, isAgent: boolean) => {
      const ok = await confirmDialog({
        title: `卸载${isAgent ? "角色" : "技能"}「${name}」?`,
        body: "卸载后将不再可用,可随时从市场重新安装。",
        confirmText: "卸载",
        danger: true,
      });
      if (!ok) return;
      setBusy(slug);
      setErr(null);
      try {
        await api.uninstallMarketplace(auth, slug);
        setReload((n) => n + 1);
      } catch (e) {
        setErr((e as Error).message || "卸载失败");
      } finally {
        setBusy(null);
      }
    },
    [auth, confirmDialog],
  );

  // 更新 = 安装 listing 当前上架版本。latestVersionId 可能在打开面板后又变化,
  // 以后端 install 校验为准:失败(非当前版本)则报错并刷新列表。
  const update = useCallback(
    async (row: MarketplaceInstalled) => {
      if (!row.latestVersionId) return;
      setBusy(row.slug);
      setErr(null);
      try {
        await api.installMarketplace(auth, row.latestVersionId);
        setReload((n) => n + 1);
      } catch (e) {
        setErr((e as Error).message || "更新失败");
        setReload((n) => n + 1);
      } finally {
        setBusy(null);
      }
    },
    [auth],
  );

  return (
    <div className="flex flex-col">
      {confirmDialogEl}
      {err && (
        <div className="px-4 pt-3">
          <Alert tone="danger">{err}</Alert>
        </div>
      )}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-faint">
          <Spinner /> 加载已安装…
        </div>
      ) : !rows || rows.length === 0 ? (
        <EmptyState
          icon={PackageOpen}
          title="还没有安装任何技能或角色"
          hint="去市场发现别人沉淀好的能力，一键安装即可使用。"
          action={
            <Button variant="secondary" size="sm" onClick={onGoBrowse}>
              去市场看看
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2 px-4 py-4">
          {rows.map((r) => {
            const revoked = r.listingState === "revoked";
            const canUpdate = updateAvailable(r);
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
                    {r.kind === "agent" && <Badge tone="accent">角色</Badge>}
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
                      ? `平台已下架该${r.kind === "agent" ? "角色" : "技能"}，将自动从你的会话移除。`
                      : r.slug}
                  </p>
                </div>
                {canUpdate && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => update(r)}
                    disabled={busy === r.slug}
                  >
                    {busy === r.slug ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpCircle size={14} />}
                    更新
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => uninstall(r.slug, r.name, r.kind === "agent")}
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
