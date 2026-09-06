import { useCallback, useEffect, useState } from "react";
import { Badge, Button, DescriptionList, DescriptionRow, Modal, Progress, Spinner } from "../../../components/ui";
import { DataTable, type Column } from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import { fmtDateTime, ResetCell } from "./cells";
import type { CursorUsageSnapshot, GrokUsageSnapshot, RecentUser, RefreshEvent } from "./types";

function errMsg(e: unknown): string {
  return apiErrorMessage(e, "请求失败");
}

/** 通用只读模态数据加载封装。 */
function useModalData<T>(open: boolean, fetcher: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    void fetcher()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);
  return { data, error, loading };
}

/** OAuth refresh 历史(近 50 条,后端 28 天 retention)。 */
export function RefreshHistoryModal({
  open,
  onOpenChange,
  accountId,
  accountLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  accountLabel: string;
}) {
  const { data, error, loading } = useModalData<RefreshEvent[]>(
    open && accountId != null,
    async () => {
      const r = await adminGet<{ events: RefreshEvent[] }>("/accounts/refresh-events", {
        account_id: accountId ?? "",
        limit: 50,
      });
      return Array.isArray(r.events) ? r.events : [];
    },
    [accountId],
  );

  const columns: Column<RefreshEvent>[] = [
    { key: "ts", title: "时间", width: 150, render: (e) => <span className="font-mono text-meta">{fmtDateTime(e.ts)}</span> },
    {
      key: "ok",
      title: "结果",
      width: 90,
      render: (e) =>
        e.ok ? (
          <Badge tone="success">成功</Badge>
        ) : (
          <Badge tone={e.err_code === "network_transient" ? "warning" : "danger"}>
            {e.err_code || "unknown"}
          </Badge>
        ),
    },
    {
      key: "detail",
      title: "详情",
      render: (e) => (e.ok ? <span className="text-faint">—</span> : <span className="font-mono text-meta break-all">{e.err_msg || ""}</span>),
    },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`账号 #${accountId ?? ""} — OAuth refresh 历史`}
      description={accountLabel}
      className="max-w-2xl"
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Spinner className="size-4" /> 加载中…
        </div>
      ) : error ? (
        <div className="py-8 text-center text-sm text-danger">加载失败:{error}</div>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={data ?? []}
            rowKey={(e) => e.id}
            emptyTitle="暂无 refresh 事件"
            emptyHint="该账号暂无记录(28 天 retention)。"
          />
          <p className="mt-2 text-caption text-faint">
            仅展示最近 50 条;事件保留 28 天。详情字段为后端枚举字面量,不含 raw error。
          </p>
        </>
      )}
    </Modal>
  );
}

/** 近 24h 使用过该账号的用户(按请求量倒序,Top 20)。 */
export function RecentUsersModal({
  open,
  onOpenChange,
  accountId,
  accountLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  accountLabel: string;
}) {
  const { data, error, loading } = useModalData<RecentUser[]>(
    open && accountId != null,
    async () => {
      const r = await adminGet<{ rows: RecentUser[] }>(
        `/accounts/${encodeURIComponent(accountId ?? "")}/recent-users`,
        { hours: 24, limit: 20 },
      );
      return Array.isArray(r.rows) ? r.rows : [];
    },
    [accountId],
  );

  const columns: Column<RecentUser>[] = [
    { key: "user_id", title: "user_id", render: (u) => <span className="font-mono text-meta">{u.user_id}</span> },
    { key: "email", title: "email", render: (u) => u.email || <span className="text-faint">—</span> },
    { key: "request_count", title: "请求数", align: "right", cellClassName: "tabular-nums", render: (u) => Number(u.request_count).toLocaleString() },
    { key: "last_used_at", title: "最近使用", width: 150, render: (u) => <span className="font-mono text-meta">{fmtDateTime(u.last_used_at)}</span> },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`账号 #${accountId ?? ""} — 近 24h 使用方`}
      description={accountLabel}
      className="max-w-2xl"
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Spinner className="size-4" /> 加载中…
        </div>
      ) : error ? (
        <div className="py-8 text-center text-sm text-danger">加载失败:{error}</div>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={data ?? []}
            rowKey={(u) => u.user_id}
            emptyTitle="近 24h 无用户使用"
            emptyHint="近 24h 无用户使用过该账号。"
          />
          <p className="mt-2 text-caption text-faint">仅近 24h、Top 20。</p>
        </>
      )}
    </Modal>
  );
}

// ─── Cursor 账号会话额度 ────────────────────────────────────────────────────

function fmtCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(iso: string | null): string {
  return iso ? fmtDateTime(iso).slice(0, 10) : "—";
}

const USAGE_SOURCE_LABEL: Record<string, string> = {
  current_period: "api2 当前账期",
  plan_info: "api2 套餐",
  hard_limit: "api2 花费上限",
  aggregated_usage: "api2 按模型聚合",
  usage_summary: "cursor.com 用量摘要",
  stripe_profile: "cursor.com 订阅状态",
  sand_usage: "cursor.com Grok Bot 池用量",
  sand_access: "cursor.com Grok Bot 访问状态",
  super_grok: "cursor.com SuperGrok 关联",
};

/** SAND_ACCESS_STATE_GRANTED → "GRANTED";未知形态原样返回。 */
function shortEnum(v: string | null, prefix: string): string | null {
  if (!v) return null;
  return v.startsWith(prefix) ? v.slice(prefix.length) : v;
}

type CursorUsageResponse = { usage: CursorUsageSnapshot; cached: boolean };

/**
 * Cursor 账号会话(Sand)的额度/用量。数据来自 Cursor 内部 dashboard 接口
 * (随时可能变),字段缺失一律显示 "—";仅供查看,不是计费依据。
 */
export function CursorUsageModal({
  open,
  onOpenChange,
  accountId,
  accountLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  accountLabel: string;
}) {
  const [data, setData] = useState<CursorUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (force: boolean) => {
      if (!accountId) return;
      setLoading(true);
      setError(null);
      try {
        const r = await adminGet<CursorUsageResponse>(
          `/accounts/${encodeURIComponent(accountId)}/cursor-usage`,
          force ? { refresh: 1 } : undefined,
        );
        setData(r);
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [accountId],
  );

  useEffect(() => {
    if (!open || !accountId) return;
    setData(null);
    void load(false);
  }, [open, accountId, load]);

  const u = data?.usage ?? null;
  const pct = u?.included.total_percent_used ?? null;
  const errorEntries = u ? Object.entries(u.errors) : [];
  const sand = u?.sand ?? null;
  const sandPct = sand?.usage_percent ?? null;
  const sandAccess = shortEnum(sand?.access_state ?? null, "SAND_ACCESS_STATE_");
  const sandBlock = shortEnum(sand?.block_reason ?? null, "SAND_ACCESS_BLOCK_REASON_");
  // 三个来源全没拿到任何字段 → 视为该池不可读(旧后端 / 无 authId / 全部 403)。
  const sandReadable =
    sand !== null &&
    (sandPct !== null || sand.access_state !== null || sand.super_grok_linked !== null || sand.grok_plan !== null);

  type ModelRow = CursorUsageSnapshot["cycle_usage"]["models"][number];
  const modelColumns: Column<ModelRow>[] = [
    { key: "model", title: "模型", render: (m) => <span className="font-mono text-meta">{m.model}</span> },
    { key: "cost", title: "费用", align: "right", cellClassName: "tabular-nums", render: (m) => fmtCents(m.cost_cents) },
    { key: "in", title: "输入", align: "right", cellClassName: "tabular-nums", render: (m) => fmtTokens(m.input_tokens) },
    { key: "out", title: "输出", align: "right", cellClassName: "tabular-nums", render: (m) => fmtTokens(m.output_tokens) },
    { key: "cw", title: "缓存写", align: "right", cellClassName: "tabular-nums", render: (m) => fmtTokens(m.cache_write_tokens) },
    { key: "cr", title: "缓存读", align: "right", cellClassName: "tabular-nums", render: (m) => fmtTokens(m.cache_read_tokens) },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`账号 #${accountId ?? ""} — Cursor 额度 / 用量`}
      description={accountLabel}
      className="max-w-3xl"
    >
      {loading && !u ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Spinner className="size-4" /> 正在向 Cursor 查询…
        </div>
      ) : error && !u ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center text-sm text-danger">
          <span>查询失败:{error}</span>
          <Button size="sm" variant="secondary" onClick={() => void load(true)}>
            重试
          </Button>
        </div>
      ) : u ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 text-meta text-faint">
            <span>
              拉取于 {fmtDateTime(u.fetched_at)}
              {data?.cached ? "(缓存,60s)" : ""}
            </span>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load(true)}>
              {loading ? <Spinner className="size-3.5" /> : null} 强制刷新
            </Button>
          </div>

          <section className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium">Grok Bot / Sand 池</span>
              <span className="text-caption text-faint">独立额度 · 每周重置</span>
              {sand?.grok_plan_label && <Badge tone="neutral">{sand.grok_plan_label}</Badge>}
              {!sand?.grok_plan_label && sand?.grok_plan && <Badge tone="neutral">{sand.grok_plan}</Badge>}
              {sandAccess && (
                <Badge tone={sandAccess === "GRANTED" ? "success" : "warning"}>
                  {sandAccess === "GRANTED" ? "已开通" : sandAccess}
                </Badge>
              )}
              {sand?.super_grok_linked === true && <Badge tone="success">已关联 SuperGrok</Badge>}
              {sand?.super_grok_linked === false && <Badge tone="neutral">未关联 SuperGrok</Badge>}
            </div>
            {!sandReadable ? (
              <p className="text-meta text-faint">
                未能读取 Grok Bot 池
                {u.errors.sand_usage === "no_auth_id" ? "(该凭证缺少 auth id,无法访问 cursor.com dashboard)" : "(见下方来源提示)"}。
              </p>
            ) : (
              <>
                {sandPct != null && (
                  <div className="mb-2 flex items-center gap-3">
                    <Progress value={sandPct} thresholds={{ warning: 75, danger: 90 }} className="flex-1" />
                    <span className="w-12 text-right text-sm tabular-nums">{fmtPct(sandPct)}</span>
                  </div>
                )}
                <DescriptionList>
                  <DescriptionRow
                    label="本周期"
                    value={`${fmtDate(sand?.period_start ?? null)} → ${fmtDate(sand?.next_reset_at ?? null)}(重置)`}
                  />
                  <DescriptionRow
                    label="可用状态"
                    value={
                      sand?.has_available_usage === true ? (
                        "仍有额度"
                      ) : sand?.has_available_usage === false ? (
                        <span className="text-danger">额度耗尽,等待重置</span>
                      ) : (
                        "—"
                      )
                    }
                  />
                  {sandBlock && sandBlock !== "NONE" && (
                    <DescriptionRow label="限制原因" value={<span className="text-warning">{sandBlock}</span>} />
                  )}
                  {sand?.link_blocked_reason && (
                    <DescriptionRow label="SuperGrok 关联受限" value={<span className="text-warning">{sand.link_blocked_reason}</span>} />
                  )}
                  <DescriptionRow
                    label="按需付费"
                    value={
                      sand?.on_demand_eligible === true
                        ? "可开启"
                        : sand?.on_demand_eligible === false
                          ? "不可用"
                          : "—"
                    }
                  />
                  {sand?.super_grok_linked_at && (
                    <DescriptionRow label="SuperGrok 关联时间" value={fmtDateTime(sand.super_grok_linked_at)} />
                  )}
                </DescriptionList>
              </>
            )}
          </section>

          <section className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium">套餐内额度</span>
              <span className="text-caption text-faint">Cursor IDE / CLI · 月度</span>
              {u.plan.name && <Badge tone="neutral">{u.plan.name}</Badge>}
              {u.plan.membership_type && u.plan.membership_type !== u.plan.name?.toLowerCase() && (
                <Badge tone="neutral">{u.plan.membership_type}</Badge>
              )}
              {u.plan.subscription_status && (
                <Badge tone={u.plan.subscription_status === "active" ? "success" : "warning"}>
                  {u.plan.subscription_status}
                </Badge>
              )}
              {u.included.is_unlimited === true && <Badge tone="success">无限</Badge>}
            </div>
            {pct != null && (
              <div className="mb-2 flex items-center gap-3">
                <Progress value={pct} thresholds={{ warning: 75, danger: 90 }} className="flex-1" />
                <span className="w-12 text-right text-sm tabular-nums">{fmtPct(pct)}</span>
              </div>
            )}
            <DescriptionList>
              <DescriptionRow label="已用 / 上限" value={`${fmtCents(u.included.used_cents)} / ${fmtCents(u.included.limit_cents)}`} />
              <DescriptionRow
                label="剩余"
                value={
                  u.included.remaining_cents != null ? (
                    <span className={u.included.remaining_cents <= 0 ? "text-danger" : undefined}>
                      {fmtCents(u.included.remaining_cents)}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <DescriptionRow
                label="Auto(Composer / Grok 4.5)/ 具名模型 占比"
                value={`${fmtPct(u.included.auto_percent_used)} / ${fmtPct(u.included.api_percent_used)}`}
              />
              <DescriptionRow
                label="账期"
                value={`${fmtDate(u.plan.billing_cycle_start)} → ${fmtDate(u.plan.billing_cycle_end)}`}
              />
              {u.included.display_message && (
                <DescriptionRow label="Cursor 提示" value={<span className="text-faint">{u.included.display_message}</span>} />
              )}
            </DescriptionList>
          </section>

          <section className="rounded-md border border-border p-3">
            <div className="mb-1 text-sm font-medium">按需付费(On-demand)</div>
            <DescriptionList>
              <DescriptionRow
                label="状态"
                value={
                  u.on_demand.usage_based_allowed === false
                    ? "不允许(套餐不支持)"
                    : u.on_demand.enabled === true
                      ? "已开启"
                      : u.on_demand.enabled === false
                        ? "未开启"
                        : "—"
                }
              />
              <DescriptionRow
                label="已用 / 上限 / 剩余"
                value={`${fmtCents(u.on_demand.used_cents)} / ${fmtCents(u.on_demand.limit_cents)} / ${fmtCents(u.on_demand.remaining_cents)}`}
              />
            </DescriptionList>
          </section>

          <section className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">本账期消耗(按模型)</span>
              <span className="text-meta text-faint">
                {fmtDate(u.cycle_usage.range_start)} → {fmtDate(u.cycle_usage.range_end)} · 合计{" "}
                {fmtCents(u.cycle_usage.total_cost_cents)} · 输出 {fmtTokens(u.cycle_usage.total_output_tokens)} · 缓存读{" "}
                {fmtTokens(u.cycle_usage.total_cache_read_tokens)}
              </span>
            </div>
            <DataTable
              columns={modelColumns}
              rows={u.cycle_usage.models}
              rowKey={(m) => m.model}
              emptyTitle="本账期暂无消耗"
              emptyHint="Cursor 尚未返回该账期的模型聚合数据。"
            />
          </section>

          {errorEntries.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-meta text-warning">
              部分来源不可用:
              {errorEntries.map(([k, v]) => (
                <span key={k} className="ml-2 font-mono">
                  {USAGE_SOURCE_LABEL[k] ?? k}={v}
                </span>
              ))}
            </div>
          )}
          <p className="text-caption text-faint">
            数据来自 Cursor 内部 dashboard 接口,字段可能随 Cursor 变更;金额为 Cursor 侧计价(美元),仅供查看,不作为平台计费依据。
            平台 Sand(Opus / Fable)请求消耗的是顶部「Grok Bot / Sand 池」;「套餐内额度」对应 Cursor IDE / CLI 的 Auto 与具名模型,两者互不相通。
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

// ─── Grok Build 官方账号额度 ────────────────────────────────────────────────

type GrokUsageResponse = { usage: GrokUsageSnapshot; cached: boolean; stored?: boolean };

const GROK_ERROR_LABEL: Record<string, string> = {
  credits: "周额度池",
  monthly: "月度账单",
  user: "账号订阅",
};

function isZeroOrNull(n: number | null | undefined): boolean {
  return n == null || n === 0;
}

/**
 * Grok Build 官方账号的周额度 / 订阅快照。数据来自 xAI 用量接口
 * (随时可能变),字段缺失一律显示 "—";仅供查看,不是计费依据。
 */
export function GrokUsageModal({
  accountId,
  label,
  open,
  onClose,
}: {
  accountId: string | null;
  label: string;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<GrokUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (force: boolean) => {
      if (!accountId) return;
      setLoading(true);
      setError(null);
      try {
        const r = await adminGet<GrokUsageResponse>(
          `/accounts/${encodeURIComponent(accountId)}/grok-usage`,
          force ? { refresh: 1 } : undefined,
        );
        setData(r);
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [accountId],
  );

  useEffect(() => {
    if (!open || !accountId) return;
    setData(null);
    void load(false);
  }, [open, accountId, load]);

  const u = data?.usage ?? null;
  const credits = u?.credits ?? null;
  const monthly = u?.monthly ?? null;
  const account = u?.account ?? null;
  const errorEntries = u ? Object.entries(u.errors) : [];
  const pct = credits?.usage_percent ?? null;
  const noOnDemand =
    isZeroOrNull(credits?.on_demand_used) &&
    isZeroOrNull(credits?.on_demand_cap) &&
    isZeroOrNull(credits?.prepaid_balance);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`账号 #${accountId ?? ""} — Grok 额度 / 用量`}
      description={label}
      className="max-w-3xl"
    >
      {loading && !u ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Spinner className="size-4" /> 正在查询 Grok 额度…
        </div>
      ) : error && !u ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center text-sm text-danger">
          <span>查询失败:{error}</span>
          <Button size="sm" variant="secondary" onClick={() => void load(true)}>
            重试
          </Button>
        </div>
      ) : u ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 text-meta text-faint">
            <span>
              拉取于 {fmtDateTime(u.fetched_at)}
              {data?.cached ? " · 缓存" : ""}
              {data?.stored ? " · 已落库" : ""}
              {account?.email_masked ? ` · ${account.email_masked}` : ""}
            </span>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load(true)}>
              {loading ? <Spinner className="size-3.5" /> : null} 刷新
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {account?.subscription_tier ? (
              <>
                <span className="text-caption text-faint">订阅档</span>
                <Badge tone="neutral">{account.subscription_tier}</Badge>
              </>
            ) : null}
            {account?.has_grok_code_access === true ? <Badge tone="success">Grok Code 访问 已开通</Badge> : null}
            {account?.has_grok_code_access === false ? <Badge tone="warning">Grok Code 访问 未开通</Badge> : null}
            {account?.user_blocked_reason ? <Badge tone="danger">{account.user_blocked_reason}</Badge> : null}
          </div>

          <section className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium">周额度池</span>
              <span className="text-caption text-faint">xAI 周额度 · 每周重置</span>
            </div>
            {pct != null && (
              <div className="mb-2 flex items-center gap-3">
                <Progress value={pct} thresholds={{ warning: 75, danger: 90 }} className="flex-1" />
                <span className="w-12 text-right text-sm tabular-nums">{fmtPct(pct)}</span>
              </div>
            )}
            <DescriptionList>
              <DescriptionRow
                label="本周期"
                value={`${fmtDate(credits?.period_start ?? null)} ~ ${fmtDate(credits?.period_end ?? null)}`}
              />
              <DescriptionRow label="重置倒计时" value={<ResetCell resetsAt={credits?.period_end ?? null} />} />
              {(credits?.products ?? []).map((p) => (
                <DescriptionRow key={p.product} label={p.product} value={fmtPct(p.usage_percent)} />
              ))}
            </DescriptionList>
          </section>

          <section className="rounded-md border border-border p-3">
            <div className="mb-1 text-sm font-medium">按需 / 预付</div>
            {noOnDemand ? (
              <p className="text-meta text-faint">无按需消费</p>
            ) : (
              <DescriptionList>
                <DescriptionRow
                  label="按需已用 / 上限"
                  value={`${credits?.on_demand_used ?? "—"} / ${credits?.on_demand_cap ?? "—"}`}
                />
                <DescriptionRow label="预付余额" value={credits?.prepaid_balance ?? "—"} />
              </DescriptionList>
            )}
          </section>

          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">月度(legacy)</summary>
            <DescriptionList>
              <DescriptionRow label="已用 / 上限" value={`${monthly?.used ?? "—"} / ${monthly?.limit ?? "—"}`} />
              <DescriptionRow
                label="账期"
                value={`${fmtDate(monthly?.period_start ?? null)} ~ ${fmtDate(monthly?.period_end ?? null)}`}
              />
            </DescriptionList>
          </details>

          {errorEntries.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-meta text-warning">
              未能读取:
              {errorEntries.map(([k, v]) => (
                <span key={k} className="ml-2">
                  {GROK_ERROR_LABEL[k] ?? k} → {v}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
