import { type Column, DataTable, TimeAgo } from "../../components";
import { QuotaWindowsCell } from "./quota";
import type { BoxClaudeLoginView, BoxClaudeModelView, BoxClaudeView, MemberQuota, QuotaWindowView } from "./types";

const ROUTE_TEXT = {
  A: { title: "路线 A · box-api-claude-*", desc: "每次请求在 Box 里起一个 claude -p(仅用默认登录)" },
  B: { title: "路线 B · box-claude-*", desc: "Box 里常驻的交互式 Claude Code,可用任一已启用登录" },
} as const;

/** Whether users can pick the model now, and if not, why. */
export function modelStatus(m: BoxClaudeModelView): { on: boolean; text: string } {
  if (m.enabled === null) return { on: false, text: "未上架(无定价)" };
  if (!m.enabled) return { on: false, text: "已关闭" };
  if (m.catalog_state !== "active") return { on: false, text: m.catalog_state ? `目录状态 ${m.catalog_state}` : "不在模型目录" };
  return { on: true, text: m.visibility === "admin" ? "已开启(仅管理员)" : "已开启" };
}

function Chip({ on, text }: { on: boolean; text: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
        on ? "bg-success-soft text-success" : "bg-hover text-muted"
      }`}
    >
      {text}
    </span>
  );
}

/** A login's windows in the shared quota cell's shape (0..1 → percent). */
export function loginQuota(l: BoxClaudeLoginView): MemberQuota {
  const windows: QuotaWindowView[] = [];
  const pct = (u: number) => Math.round(u * 1000) / 10;
  if (l.quota.five_hour) windows.push({ label: "5 小时", usedPct: pct(l.quota.five_hour.used), resetsAt: l.quota.five_hour.resets_at });
  if (l.quota.weekly) windows.push({ label: "每周", usedPct: pct(l.quota.weekly.used), resetsAt: l.quota.weekly.resets_at });
  let note = l.quota.reason;
  if (windows.length > 0 && !note) {
    note = !l.quota.five_hour ? "Box CLI 未上报 5 小时窗口" : !l.quota.weekly ? "Box CLI 未上报每周窗口" : null;
  }
  return { windows, updatedAt: l.health_updated_at, note };
}

function loginState(l: BoxClaudeLoginView): { on: boolean; text: string } {
  if (l.login_state !== "logged_in") return { on: false, text: "未登录" };
  if (!l.enabled) return { on: false, text: "未参与调度" };
  if (l.cooldown_until) return { on: false, text: "冷却中" };
  return { on: true, text: l.is_default ? "可调度·默认" : "可调度" };
}

export function BoxClaudeSection({ view, loading }: { view: BoxClaudeView | null | undefined; loading: boolean }) {
  const modelColumns: Column<BoxClaudeModelView>[] = [
    { key: "id", title: "模型", render: (m) => <span className="whitespace-nowrap font-mono text-meta text-fg">{m.id}</span> },
    { key: "status", title: "状态", render: (m) => <Chip {...modelStatus(m)} /> },
    {
      key: "inflight",
      title: "当前并发",
      render: (m) =>
        m.inflight ? (
          <span className="whitespace-nowrap tabular-nums text-meta text-fg">
            {m.inflight.current} <span className="text-faint">· 峰值 {m.inflight.peak}</span>
          </span>
        ) : (
          <span className="text-caption text-faint">读不到</span>
        ),
    },
    { key: "engine", title: "引擎", render: (m) => <span className="whitespace-nowrap text-meta text-muted">{m.engine && m.provider ? `${m.engine}/${m.provider}` : "—"}</span> },
  ];
  const loginColumns: Column<BoxClaudeLoginView>[] = [
    {
      key: "login",
      title: "登录",
      render: (l) => (
        <div className="flex flex-col">
          <span className="whitespace-nowrap text-fg">{l.profile}</span>
          <span className="whitespace-nowrap text-caption text-faint">Box 账号 {l.account_id}{l.email_hint ? ` · ${l.email_hint}` : ""}</span>
        </div>
      ),
    },
    { key: "state", title: "状态", render: (l) => <Chip {...loginState(l)} /> },
    { key: "quota", title: "使用额度", render: (l) => <QuotaWindowsCell quota={loginQuota(l)} /> },
    { key: "seen", title: "最近上报", render: (l) => (l.health_updated_at ? <TimeAgo value={l.health_updated_at} className="text-meta" /> : <span className="text-faint">—</span>) },
  ];
  const caps = view?.caps;
  return (
    <section className="flex flex-col gap-3" data-testid="box-claude-section">
      <div>
        <h2 className="text-title font-semibold text-fg">Box Claude</h2>
        <p className="text-meta text-muted">
          用 Cursor Box 里自己的 Claude Code 登录,不在订阅账号表里;只读展示,不改登录、不读凭据。
        </p>
      </div>
      {view === null ? (
        <div className="rounded-xl border border-border bg-surface px-4 py-3 text-meta text-muted">Box Claude 信息读取失败,稍后自动刷新。</div>
      ) : view === undefined && !loading ? (
        <div className="rounded-xl border border-border bg-surface px-4 py-3 text-meta text-muted">服务端版本尚未提供 Box Claude 信息。</div>
      ) : (
        <>
          {(view?.routes ?? []).map((r) => (
            <div key={r.key} className="flex flex-col gap-2">
              <div>
                <h3 className="text-body font-medium text-fg">{ROUTE_TEXT[r.key].title}</h3>
                <p className="text-meta text-muted">{ROUTE_TEXT[r.key].desc}</p>
              </div>
              <DataTable columns={modelColumns} rows={r.models} rowKey={(m) => m.id} loading={loading && !view} emptyTitle="无模型" />
            </div>
          ))}
          {caps ? (
            <p className="text-meta text-muted" data-testid="box-claude-caps">
              并发上限:每个 Box 账号 {caps.max_runs_per_account} 个运行、每个用户 {caps.max_runs_per_user} 个运行
              {caps.proxy_concurrency !== null ? `;每用户代理并发 ${caps.proxy_concurrency}` : ""}
              {caps.proxy_rate_per_minute !== null ? `、每分钟 ${caps.proxy_rate_per_minute} 次` : ""}
              {view?.inflight_source === "unavailable" ? "。当前并发读取失败" : view?.inflight_source === "local_fallback" ? "。当前并发取自本进程(egress 统计不可达)" : ""}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <h3 className="text-body font-medium text-fg">Box 内的 Claude 登录</h3>
            <DataTable
              columns={loginColumns}
              rows={view?.logins ?? []}
              rowKey={(l) => `${l.account_id}:${l.profile}`}
              loading={loading && !view}
              emptyTitle="尚未发现 Box 内的 Claude 登录(在 Cursor 账号菜单「Box 内的 Claude Code 账号」中发现)"
            />
          </div>
        </>
      )}
    </section>
  );
}
