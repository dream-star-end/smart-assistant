import { Activity, Boxes, CircleSlash, Plus, RefreshCw, Snowflake } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, useConfirm, useToast } from "../../../components/ui";
import { type Column, DataTable, PageHeader, StatCard, StatCardRow, TimeAgo } from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";
import { ApiKeyFormModal } from "./ApiKeyFormModal";
import { type PoolMember, type PoolView, type PoolsResponse, cooldownLabel, remainingLabel, serviceLabel } from "./types";

function errMsg(e: unknown): string {
  return apiErrorMessage(e, "请求失败");
}

/**
 * OCV5-424 服务池:每个服务一个池(订阅账号 + API key),上层统一调度策略。
 * 冷却与恢复全部自动,本页只展示状态,并提供 API key 的添加与管理员启停。
 */
export default function PoolsPage() {
  const meta = getAdminPage("pools");
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [data, setData] = useState<PoolsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [addFor, setAddFor] = useState<string | null | undefined>(undefined);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick 是显式刷新触发器(刷新按钮 / 保存后重拉)。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void adminGet<PoolsResponse>("/pools")
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(errMsg(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  const pools = useMemo(() => (data?.pools ?? []).filter((p) => p.members.length > 0 || p.accepts_api_keys), [data]);
  const totals = useMemo(() => {
    const all = pools.flatMap((p) => p.members);
    return {
      pools: pools.filter((p) => p.members.length > 0).length,
      active: all.filter((m) => m.status === "active").length,
      cooldown: all.filter((m) => m.status === "cooldown").length,
      disabled: all.filter((m) => m.status === "disabled" || m.status === "banned").length,
    };
  }, [pools]);

  const toggleKey = useCallback(
    async (m: PoolMember) => {
      const next = m.status === "disabled" ? "active" : "disabled";
      if (next === "disabled") {
        const ok = await confirm({
          title: `停用 ${serviceLabel(m.service)} 的 API key ${m.label || m.hints.key || m.id}`,
          body: "管理员停用后调度不会再使用它,也不会自动恢复;冷却中的 key 无需停用,会自动恢复。",
          danger: true,
          confirmText: "停用",
        });
        if (!ok) return;
      }
      try {
        await adminSend("PATCH", `/pools/keys/${encodeURIComponent(m.id)}`, { status: next });
        toast(next === "active" ? "已启用" : "已停用", "success");
        refresh();
      } catch (e) {
        toast(`操作失败:${errMsg(e)}`, "error");
      }
    },
    [confirm, toast, refresh],
  );

  const keyServices = useMemo(() => (data?.pools ?? []).filter((p) => p.accepts_api_keys).map((p) => p.service), [data]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={loading ? "加载中…" : "每个服务一个池,订阅账号与 API key 共用同一套调度、冷却与自动恢复"}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RefreshCw size={15} /> 刷新
            </Button>
            <Button variant="primary" size="sm" onClick={() => setAddFor(null)} disabled={keyServices.length === 0}>
              <Plus size={15} /> 添加 API key
            </Button>
          </>
        }
      />

      <StatCardRow>
        <StatCard label="有成员的服务池" value={totals.pools.toLocaleString()} icon={Boxes} loading={loading} />
        <StatCard label="可调度" value={totals.active.toLocaleString()} tone="success" icon={Activity} loading={loading} />
        <StatCard
          label="冷却中(自动恢复)"
          value={totals.cooldown.toLocaleString()}
          tone={totals.cooldown > 0 ? "warning" : "neutral"}
          icon={Snowflake}
          loading={loading}
        />
        <StatCard label="管理员停用" value={totals.disabled.toLocaleString()} icon={CircleSlash} loading={loading} />
      </StatCardRow>

      {data?.policy ? <PolicyNote policy={data.policy} /> : null}

      {error ? (
        <div className="rounded-xl border border-danger/40 bg-danger-soft/40 px-4 py-6 text-center text-sm text-danger">
          加载失败:{error}
        </div>
      ) : (
        pools.map((p) => <PoolSection key={p.service} pool={p} loading={loading} onAdd={setAddFor} onToggle={toggleKey} />)
      )}

      <ApiKeyFormModal
        open={addFor !== undefined}
        onOpenChange={(o) => !o && setAddFor(undefined)}
        services={keyServices}
        initialService={addFor ?? keyServices[0] ?? ""}
        onSaved={refresh}
      />
      {confirmEl}
    </div>
  );
}

function PolicyNote({ policy }: { policy: PoolsResponse["policy"] }) {
  const min = (ms: number) => (ms >= 3_600_000 ? `${ms / 3_600_000} 小时` : `${Math.round(ms / 60_000)} 分钟`);
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3 text-meta leading-relaxed text-muted">
      统一调度策略:429 按 Retry-After 冷却(限 {Math.round(policy.rate_limit_ms[0] / 1000)} 秒–{min(policy.rate_limit_ms[1])});
      配额用尽冷却到重置时刻(未给出时 {min(policy.quota_default_ms)});认证失效每 {min(policy.auth_backoff_ms[0])} 起自动探测,
      逐次加倍至 {min(policy.auth_backoff_ms[1])};上游连续 {policy.fail_threshold} 次失败冷却 {min(policy.upstream_backoff_ms[0])}。
      订阅账号遇限流不在同一请求内换号,API key 失败后由下一请求换 key。
    </div>
  );
}

// 手机宽度下表格列会被压窄:徽标、名称都不换行(否则一字一行),最近错误给最小宽度并限三行,表格在卡片内横向滚动。
function StatusChip({ m }: { m: PoolMember }) {
  if (m.status === "active") {
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
        可调度
      </span>
    );
  }
  if (m.status === "cooldown") {
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
        {cooldownLabel(m.cooldownReason)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full bg-hover px-2 py-0.5 text-xs font-medium text-muted">
      {m.status === "banned" ? "封禁" : "管理员停用"}
    </span>
  );
}

function PoolSection({
  pool,
  loading,
  onAdd,
  onToggle,
}: {
  pool: PoolView;
  loading: boolean;
  onAdd: (service: string) => void;
  onToggle: (m: PoolMember) => void;
}) {
  const columns: Column<PoolMember>[] = [
    {
      key: "type",
      title: "类型",
      width: 92,
      render: (m) => <span className="whitespace-nowrap text-meta">{m.credentialType === "api_key" ? "API key" : "订阅账号"}</span>,
    },
    {
      key: "label",
      title: "名称",
      render: (m) => (
        <div className="flex flex-col">
          <span className="whitespace-nowrap font-medium">{m.label || `#${m.id}`}</span>
          <span className="whitespace-nowrap font-mono text-[11.5px] text-faint">
            {[m.hints.plan, m.hints.key, m.hints.source === "env" ? "来自环境变量" : null].filter(Boolean).join(" · ") || `#${m.id}`}
          </span>
        </div>
      ),
    },
    { key: "status", title: "状态", width: 140, render: (m) => <StatusChip m={m} /> },
    {
      key: "until",
      title: "恢复",
      width: 120,
      render: (m) =>
        m.status === "cooldown" ? (
          <span className="whitespace-nowrap text-meta">{remainingLabel(m.cooldownUntil)}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: "health",
      title: "健康",
      width: 72,
      align: "right",
      render: (m) => <span className="tabular-nums">{m.healthScore ?? "—"}</span>,
    },
    {
      key: "last",
      title: "最近使用",
      width: 110,
      render: (m) => (m.lastUsedAt ? <TimeAgo value={m.lastUsedAt} className="text-meta" /> : <span className="text-faint">—</span>),
    },
    {
      key: "err",
      title: "最近错误",
      render: (m) => (
        <span className="line-clamp-3 block min-w-[14rem] break-all text-meta text-muted" title={m.lastError ?? undefined}>
          {m.lastError || "—"}
        </span>
      ),
    },
    {
      key: "actions",
      title: "操作",
      align: "right",
      width: 90,
      render: (m) =>
        m.memberKind === "api_key" ? (
          <Button size="sm" variant="ghost" className={m.status === "disabled" ? "" : "text-danger"} onClick={() => onToggle(m)}>
            {m.status === "disabled" ? "启用" : "停用"}
          </Button>
        ) : null,
    },
  ];
  const c = pool.counts;
  return (
    <section className="flex flex-col gap-2" data-testid={`pool-${pool.service}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-semibold text-fg">{serviceLabel(pool.service)}</h2>
          <span className="text-meta text-muted">
            {c.total} 个成员 · 可调度 {c.active}
            {c.cooldown > 0 ? ` · 冷却 ${c.cooldown}` : ""}
            {c.disabled > 0 ? ` · 停用 ${c.disabled}` : ""}
          </span>
        </div>
        {pool.accepts_api_keys ? (
          <Button size="sm" variant="ghost" onClick={() => onAdd(pool.service)}>
            <Plus size={14} /> 添加 key
          </Button>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        rows={pool.members}
        rowKey={(m) => `${m.memberKind}:${m.id}`}
        loading={loading}
        emptyTitle={pool.accepts_api_keys ? "尚无成员,可添加 API key" : "尚无成员"}
      />
    </section>
  );
}
