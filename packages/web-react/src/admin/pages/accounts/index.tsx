import { KeyRound, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  useConfirm,
  useToast,
} from "../../../components/ui";
import {
  ChartCard,
  type Column,
  DataTable,
  FilterBar,
  PageHeader,
  SelectFilter,
  StatCard,
  StatCardRow,
  donutConfig,
  useChart,
} from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { useAdminPoll } from "../../lib/useAdminPoll";
import { getAdminPage } from "../../registry";
import { AccountFormModal } from "./AccountFormModal";
import { RecentUsersModal, RefreshHistoryModal } from "./AccountInfoModals";
import {
  AccountWarningChips,
  CooldownCell,
  LastUsed,
  LifetimeCell,
  QuotaCell,
  ResetCell,
  StatusBadge,
  TodayCell,
  fmtDateTime,
} from "./cells";
import {
  ACCOUNT_STATUSES,
  type AccountPoolSnapshot,
  type AccountRow,
  type AccountsPoolStats,
} from "./types";

const STATUS_KEY = "admin_acc_status";
const PROVIDER_KEY = "admin_acc_provider";

function errMsg(e: unknown): string {
  return apiErrorMessage(e, "请求失败");
}

type AccountsData = {
  rows: AccountRow[];
  stats: AccountsPoolStats | null;
  snapshot: AccountPoolSnapshot | null;
};

export default function AccountsPage() {
  const meta = getAdminPage("accounts");
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [status, setStatus] = useState<string>(() => sessionStorage.getItem(STATUS_KEY) || "");
  const [provider, setProvider] = useState<string>(() => sessionStorage.getItem(PROVIDER_KEY) || "");

  const { data, error, loading, refresh } = useAdminPoll<AccountsData>(
    async () => {
      const rowsP = adminGet<{ rows: AccountRow[] }>("/accounts", {
        with_stats: 1,
        limit: 500,
        status: status || undefined,
        provider: provider || undefined,
      });
      const statsP = adminGet<AccountsPoolStats>("/accounts/stats").catch(() => null);
      const snapP = adminGet<AccountPoolSnapshot>("/stats/account-pool").catch(() => null);
      const [rowsR, stats, snapshot] = await Promise.all([rowsP, statsP, snapP]);
      return { rows: Array.isArray(rowsR.rows) ? rowsR.rows : [], stats, snapshot };
    },
    { intervalMs: 30_000, deps: [status, provider] },
  );

  const rows = data?.rows ?? [];
  const stats = data?.stats ?? null;
  const snapshot = data?.snapshot ?? null;

  // ── modals ──
  const [formModal, setFormModal] = useState<{ mode: "create" | "edit"; account?: AccountRow } | null>(null);
  const [historyAcc, setHistoryAcc] = useState<{ id: string; label: string } | null>(null);
  const [recentAcc, setRecentAcc] = useState<{ id: string; label: string } | null>(null);

  const onStatusChange = useCallback((v: string) => {
    setStatus(v);
    sessionStorage.setItem(STATUS_KEY, v);
  }, []);
  const onProviderChange = useCallback((v: string) => {
    setProvider(v);
    sessionStorage.setItem(PROVIDER_KEY, v);
  }, []);

  const doReset = useCallback(
    async (a: AccountRow) => {
      const ok = await confirm({
        title: `释放账号冷却 #${a.id}`,
        body: `账号:${a.label}。清除 cooldown 与 last_error,不修改 status。`,
      });
      if (!ok) return;
      try {
        await adminSend("POST", `/accounts/${encodeURIComponent(a.id)}/reset-cooldown`);
        toast(`#${a.id} 冷却已释放`, "success");
        refresh();
      } catch (e) {
        toast(`释放失败:${errMsg(e)}`, "error");
      }
    },
    [confirm, toast, refresh],
  );

  const doDelete = useCallback(
    async (a: AccountRow) => {
      const ok = await confirm({
        title: `删除账号 #${a.id}`,
        body: `账号:${a.label}。不可恢复;若有运行中容器仍在使用该账号,后端会拒绝。`,
        danger: true,
        confirmText: "删除",
      });
      if (!ok) return;
      try {
        await adminSend("DELETE", `/accounts/${encodeURIComponent(a.id)}`);
        toast(`#${a.id} 已删除`, "success");
        refresh();
      } catch (e) {
        toast(`删除失败:${errMsg(e)}`, "error");
      }
    },
    [confirm, toast, refresh],
  );

  const columns: Column<AccountRow>[] = [
    { key: "id", title: "id", width: 60, render: (a) => <span className="font-mono text-[12px]">{a.id}</span> },
    {
      key: "label",
      title: "label",
      render: (a) => (
        <div className="min-w-[9rem]">
          <span className="font-medium">{a.label}</span>
          <AccountWarningChips a={a} />
        </div>
      ),
    },
    { key: "plan", title: "plan", width: 64, render: (a) => a.plan },
    { key: "provider", title: "provider", width: 90, render: (a) => a.provider },
    { key: "status", title: "状态", width: 90, render: (a) => <StatusBadge status={a.status} /> },
    { key: "health", title: "health", align: "right", cellClassName: "tabular-nums", render: (a) => a.health_score ?? "—" },
    { key: "today", title: "今日 / 错误率", align: "right", render: (a) => <TodayCell a={a} /> },
    { key: "lifetime", title: "累计 ok/fail", align: "right", render: (a) => <LifetimeCell a={a} /> },
    { key: "oauth_exp", title: "OAuth 到期", width: 140, render: (a) => <span className="font-mono text-[12px]">{fmtDateTime(a.oauth_expires_at)}</span> },
    {
      key: "sub_end",
      title: "订阅到期",
      width: 140,
      render: (a) =>
        a.subscription_end_at ? (
          <span className="font-mono text-[12px]">{fmtDateTime(a.subscription_end_at)}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    { key: "group", title: "分组", width: 70, render: (a) => (a.group_id ? <span className="font-mono text-[12px]">#{a.group_id}</span> : <span className="text-faint">—</span>) },
    { key: "q5h", title: "5h%", align: "right", render: (a) => <QuotaCell pct={a.quota_5h_pct} updatedAt={a.quota_updated_at} /> },
    { key: "q5hr", title: "5h 重置", align: "right", render: (a) => <ResetCell resetsAt={a.quota_5h_resets_at} /> },
    { key: "q7d", title: "7d%", align: "right", render: (a) => <QuotaCell pct={a.quota_7d_pct} updatedAt={a.quota_updated_at} /> },
    { key: "q7dr", title: "7d 重置", align: "right", render: (a) => <ResetCell resetsAt={a.quota_7d_resets_at} /> },
    { key: "cooldown", title: "冷却至", align: "right", render: (a) => <CooldownCell cooldownUntil={a.cooldown_until} /> },
    { key: "last_used", title: "最近使用", width: 110, render: (a) => <LastUsed iso={a.last_used_at} /> },
    {
      key: "egress",
      title: "egress",
      render: (a) => (
        <span className="max-w-[10rem] truncate text-[12px]" title={a.egress_proxy_pool_label || ""}>
          {a.egress_proxy_pool_label || "—"}
        </span>
      ),
    },
    {
      key: "actions",
      title: "操作",
      align: "right",
      render: (a) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setFormModal({ mode: "edit", account: a })}>
            编辑
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" onClick={() => doDelete(a)}>
            删除
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" shape="square" aria-label="更多操作">
                <MoreHorizontal size={16} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {a.cooldown_until && (
                <DropdownMenuItem onSelect={() => doReset(a)}>释放冷却</DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setRecentAcc({ id: a.id, label: a.label })}>
                查看使用方
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setHistoryAcc({ id: a.id, label: a.label })}>
                刷新历史
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={loading && !data ? "加载中…" : `共 ${rows.length} 条`}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RefreshCw size={15} /> 刷新
            </Button>
            <Button variant="primary" size="sm" onClick={() => setFormModal({ mode: "create" })}>
              <Plus size={15} /> 新建账号
            </Button>
          </>
        }
      />

      <StatCardRow>
        <StatCard
          label="总账号"
          value={stats ? stats.total.toLocaleString() : "—"}
          hint={stats ? `disabled ${stats.disabled} · banned ${stats.banned}` : "加载中…"}
          tone={stats && stats.banned > 0 ? "warning" : "neutral"}
          icon={KeyRound}
          loading={loading && !stats}
        />
        <StatCard
          label="可用 / 冷却"
          value={stats ? `${stats.active} / ${stats.cooldown}` : "—"}
          hint={stats ? (stats.cooldown > 0 ? `有 ${stats.cooldown} 个冷却中` : "全部可用") : "加载中…"}
          tone={stats ? (stats.cooldown > 0 ? "warning" : "success") : "neutral"}
          loading={loading && !stats}
        />
        <StatCard
          label="OAuth 过期风险"
          value={stats ? `${stats.expiring_24h} + ${stats.expired_unrefreshable}` : "—"}
          hint={
            stats
              ? `24h 内 ${stats.expiring_24h} / 待刷新 ${stats.expired_refreshable} / 已过期 ${stats.expired_unrefreshable}`
              : "加载中…"
          }
          tone={
            stats
              ? stats.expired_unrefreshable > 0
                ? "danger"
                : stats.expiring_24h > 0
                  ? "warning"
                  : "success"
              : "neutral"
          }
          loading={loading && !stats}
        />
        <StatCard
          label="今日请求"
          value={stats ? stats.today_requests.toLocaleString() : "—"}
          hint={
            stats
              ? `错误 ${stats.today_errors}(${((stats.today_requests > 0 ? stats.today_errors / stats.today_requests : 0) * 100).toFixed(1)}%)`
              : "加载中…"
          }
          tone={
            stats
              ? (() => {
                  const r = stats.today_requests > 0 ? stats.today_errors / stats.today_requests : 0;
                  return r > 0.1 ? "danger" : r > 0.02 ? "warning" : "success";
                })()
              : "neutral"
          }
          loading={loading && !stats}
        />
      </StatCardRow>

      <PoolDonut snapshot={snapshot} />

      <FilterBar>
        <SelectFilter
          label="provider"
          value={provider}
          onChange={onProviderChange}
          options={[
            { label: "全部", value: "" },
            { label: "Claude", value: "claude" },
            { label: "Codex", value: "codex" },
            { label: "Grok", value: "grok" },
          ]}
        />
        <SelectFilter
          label="状态"
          value={status}
          onChange={onStatusChange}
          options={[
            { label: "全部", value: "" },
            ...ACCOUNT_STATUSES.map((s) => ({ label: s, value: s })),
          ]}
        />
      </FilterBar>

      {error ? (
        <div className="rounded-xl border border-danger/40 bg-danger-soft/40 px-4 py-6 text-center text-sm text-danger">
          加载失败:{errMsg(error)}
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(a) => a.id}
          loading={loading && !data}
          emptyTitle="无匹配账号"
        />
      )}

      <AccountFormModal
        open={formModal !== null}
        onOpenChange={(o) => !o && setFormModal(null)}
        mode={formModal?.mode ?? "create"}
        account={formModal?.account}
        onSaved={refresh}
      />
      <RefreshHistoryModal
        open={historyAcc !== null}
        onOpenChange={(o) => !o && setHistoryAcc(null)}
        accountId={historyAcc?.id ?? null}
        accountLabel={historyAcc?.label ?? ""}
      />
      <RecentUsersModal
        open={recentAcc !== null}
        onOpenChange={(o) => !o && setRecentAcc(null)}
        accountId={recentAcc?.id ?? null}
        accountLabel={recentAcc?.label ?? ""}
      />
      {confirmEl}
    </div>
  );
}

/** 账号池状态构成 donut(active/cooldown/disabled/banned)+ 平均健康 / 今日成功率。 */
function PoolDonut({ snapshot }: { snapshot: AccountPoolSnapshot | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const segs = snapshot
    ? [
        { label: "可用 active", value: snapshot.active, token: "success" },
        { label: "冷却 cooldown", value: snapshot.cooldown, token: "warning" },
        { label: "停用 disabled", value: snapshot.disabled, token: "muted" },
        { label: "封禁 banned", value: snapshot.banned, token: "danger" },
      ].filter((x) => x.value > 0)
    : [];
  useChart(
    ref,
    (theme) =>
      donutConfig(theme, {
        labels: segs.map((s) => s.label),
        data: segs.map((s) => s.value),
        colorTokens: segs.map((s) => s.token),
      }),
    [segs.map((s) => `${s.label}:${s.value}`).join("|")],
  );

  const hint = snapshot
    ? `平均健康 ${snapshot.avg_health.toFixed(1)} / 100 · 今日成功率 ${(snapshot.today_success_rate * 100).toFixed(1)}%`
    : undefined;

  return (
    <ChartCard title="账号池状态构成" hint={hint} height={240}>
      {segs.length > 0 ? (
        <canvas ref={ref} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-faint">
          {snapshot ? "无账号" : "加载中…"}
        </div>
      )}
    </ChartCard>
  );
}
