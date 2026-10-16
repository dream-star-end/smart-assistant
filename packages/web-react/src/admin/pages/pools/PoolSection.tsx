import { Plus } from "lucide-react";
import { Button } from "../../../components/ui";
import { type Column, DataTable, TimeAgo } from "../../components";
import { apiErrorMessage } from "../../lib/adminApi";
import { QuotaWindowsCell } from "./quota";
import { type PoolMember, type PoolView, type PoolsResponse, cooldownLabel, remainingLabel, serviceLabel } from "./types";

/** Members a pool section can enable/disable itself (subscription accounts of account-pool services have their own rows). */
export function togglePath(m: PoolMember): string {
  if (m.memberKind === "account" && m.service === "gemini") return `/antigravity-accounts/${encodeURIComponent(m.id)}`;
  return `/pools/keys/${encodeURIComponent(m.id)}`;
}

export function canToggle(m: PoolMember): boolean {
  return m.memberKind === "api_key" || (m.memberKind === "account" && m.service === "gemini");
}

export function errMsg(e: unknown): string {
  return apiErrorMessage(e, "请求失败");
}

export function PolicyNote({ policy }: { policy: PoolsResponse["policy"] }) {
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
export function StatusChip({ m }: { m: PoolMember }) {
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

export function PoolSection({
  pool,
  loading,
  onAdd,
  onToggle,
  title,
  bare = false,
}: {
  pool: PoolView;
  loading: boolean;
  onAdd: (service: string) => void;
  onToggle: (m: PoolMember) => void;
  /** Heading override; `bare` renders only the table (inside an account section). */
  title?: string;
  bare?: boolean;
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
            {[
              m.hints.plan,
              m.hints.name,
              m.hints.key,
              m.hints.source === "env" ? "来自环境变量" : null,
              typeof m.hints.bound_users === "number" ? `绑定 ${m.hints.bound_users} 人` : null,
            ]
              .filter(Boolean)
              .join(" · ") || `#${m.id}`}
          </span>
        </div>
      ),
    },
    { key: "status", title: "状态", width: 140, render: (m) => <StatusChip m={m} /> },
    { key: "quota", title: "使用额度", render: (m) => <QuotaWindowsCell quota={memberQuota(m)} /> },
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
        canToggle(m) ? (
          <Button size="sm" variant="ghost" className={m.status === "disabled" ? "" : "text-danger"} onClick={() => onToggle(m)}>
            {m.status === "disabled" ? "启用" : "停用"}
          </Button>
        ) : null,
    },
  ];
  const c = pool.counts;
  if (bare) {
    return (
      <div className="flex flex-col gap-2" data-testid={`pool-${pool.service}-keys`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-meta text-muted">{title ?? "API key"} · {pool.members.length} 个</span>
          {pool.accepts_api_keys ? (
            <Button size="sm" variant="ghost" onClick={() => onAdd(pool.service)}>
              <Plus size={14} /> 添加 key
            </Button>
          ) : null}
        </div>
        {pool.members.length > 0 ? (
          <DataTable columns={columns} rows={pool.members} rowKey={(m) => `${m.memberKind}:${m.id}`} loading={loading} />
        ) : null}
      </div>
    );
  }
  return (
    <section className="flex flex-col gap-2" data-testid={`pool-${pool.service}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-semibold text-fg">{title ?? serviceLabel(pool.service)}</h2>
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
        emptyTitle={
          pool.service === "gemini"
            ? "尚无成员:Antigravity 订阅账号登录后出现在这里,也可添加 API key"
            : pool.accepts_api_keys
              ? "尚无成员,可添加 API key"
              : "尚无成员"
        }
      />
    </section>
  );
}

/** Quota shown for a pool member: the upstream's windows, or why there are none. */
export function memberQuota(m: PoolMember) {
  if (m.quota) return m.quota;
  if (m.credentialType === "api_key") return { windows: [], updatedAt: null, note: "按量计费,没有订阅额度" };
  if (m.memberKind === "box_profile") {
    return { windows: [], updatedAt: null, note: "Box 内的 Claude 登录没有上游额度信号;见所属 Cursor 账号的 Sand 用量" };
  }
  return { windows: [], updatedAt: null, note: "上游没有额度数据" };
}

