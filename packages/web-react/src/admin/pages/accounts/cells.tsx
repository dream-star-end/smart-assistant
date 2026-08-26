import { Badge, Tooltip } from "../../../components/ui";
import { TimeAgo } from "../../components";
import type { AccountRow } from "./types";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

/** 绝对时间 yyyy-MM-dd HH:mm(本地时区),对齐 vanilla fmtDate。 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 账号 / 凭据状态 → 语义徽标。cooldown 视为 warning(优于 vanilla 的 muted)。 */
export function StatusBadge({ status }: { status: string }) {
  const tone: Tone =
    status === "active"
      ? "success"
      : status === "banned" || status === "deleted"
        ? "danger"
        : status === "cooldown" || status === "deleting"
          ? "warning"
          : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

/** 小号内联百分比芯片(用于今日错误率 / 累计失败率)。 */
function MiniChip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <Badge tone={tone} className="ml-1 px-1.5 py-0 text-[11px]">
      {children}
    </Badge>
  );
}

/** M9 配额单元格:pct 0-100;>1h 陈旧灰显,≥95 红 / ≥80 黄。 */
export function QuotaCell({ pct, updatedAt }: { pct: number | null; updatedAt: string | null }) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) {
    return <span className="text-faint">—</span>;
  }
  const num = Number(pct);
  const updMs = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
  const stale = Number.isFinite(updMs) ? Date.now() - updMs > 60 * 60 * 1000 : true;
  const tone: Tone | null = stale ? "neutral" : num >= 95 ? "danger" : num >= 80 ? "warning" : null;
  const label = `${num.toFixed(0)}%`;
  const title = updatedAt ? `更新: ${fmtDateTime(updatedAt)}${stale ? " (陈旧)" : ""}` : undefined;
  const inner = tone ? (
    <Badge tone={tone} className="px-1.5 py-0 text-[11px]">
      {label}
    </Badge>
  ) : (
    <span className="tabular-nums">{label}</span>
  );
  return title ? <Tooltip content={title}>{inner}</Tooltip> : inner;
}

/** 配额 / 冷却重置时间(剩余时间;<60m→Xm,<24h→Xh,否则 MM-DD),tooltip 绝对时间。 */
export function ResetCell({ resetsAt }: { resetsAt: string | null }) {
  if (!resetsAt) return <span className="text-faint">—</span>;
  const ms = new Date(resetsAt).getTime();
  if (Number.isNaN(ms)) return <span className="text-faint">—</span>;
  const diff = ms - Date.now();
  if (diff <= 0) {
    return (
      <Tooltip content={fmtDateTime(resetsAt)}>
        <span className="text-faint">已过</span>
      </Tooltip>
    );
  }
  let label: string;
  if (diff < 60 * 60 * 1000) label = `${Math.max(1, Math.ceil(diff / 60000))}m`;
  else if (diff < 24 * 60 * 60 * 1000) label = `${Math.ceil(diff / (60 * 60 * 1000))}h`;
  else {
    const d = new Date(resetsAt);
    label = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return (
    <Tooltip content={fmtDateTime(resetsAt)}>
      <span className="font-mono tabular-nums">{label}</span>
    </Tooltip>
  );
}

/** "冷却至"列:剩余时间 warn 芯片;已过灰显。 */
export function CooldownCell({ cooldownUntil }: { cooldownUntil: string | null }) {
  if (!cooldownUntil) return <span className="text-faint">—</span>;
  const ms = new Date(cooldownUntil).getTime() - Date.now();
  if (Number.isNaN(ms)) return <span className="font-mono">{cooldownUntil}</span>;
  if (ms <= 0) {
    return (
      <Tooltip content={fmtDateTime(cooldownUntil)}>
        <Badge tone="neutral" className="px-1.5 py-0 text-[11px]">
          已过
        </Badge>
      </Tooltip>
    );
  }
  const mins = Math.max(1, Math.round(ms / 60000));
  const label = mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
  return (
    <Tooltip content={fmtDateTime(cooldownUntil)}>
      <Badge tone="warning" className="px-1.5 py-0 text-[11px]">
        {label}
      </Badge>
    </Tooltip>
  );
}

/** 今日请求数 + 错误率芯片。 */
export function TodayCell({ a }: { a: AccountRow }) {
  const req = a.today_requests ?? 0;
  const err = a.today_errors ?? 0;
  const rate = req > 0 ? err / req : 0;
  return (
    <span className="tabular-nums">
      {req}
      {req > 0 && (
        <MiniChip tone={rate > 0.1 ? "danger" : rate > 0.02 ? "warning" : "success"}>
          {(rate * 100).toFixed(1)}%
        </MiniChip>
      )}
    </span>
  );
}

/** 累计 ok/fail + 失败率芯片(总量>20 才显示率)。 */
export function LifetimeCell({ a }: { a: AccountRow }) {
  const ok = Number(a.success_count || 0);
  const fail = Number(a.fail_count || 0);
  const total = ok + fail;
  const rate = total > 0 ? fail / total : 0;
  return (
    <span className="tabular-nums">
      {ok}/{fail}
      {total > 20 && (
        <MiniChip tone={rate > 0.15 ? "danger" : rate > 0.05 ? "warning" : "neutral"}>
          {(rate * 100).toFixed(1)}%
        </MiniChip>
      )}
    </span>
  );
}

/** label 单元格尾部的告警芯片行(最近出错 / OAuth 到期 / 冷却 / 订阅到期)。 */
export function CursorPoolCell({ a }: { a: AccountRow }) {
  if (a.provider !== "cursor") return <span className="text-faint">—</span>;
  const poolLabel =
    a.cursor_quota_class === "other_ok"
      ? "Other OK"
      : a.cursor_quota_class === "cursor_only"
        ? "仅 Cursor Models"
        : "未观察";
  return (
    <div className="flex flex-col gap-0.5">
      <span>{poolLabel}</span>
      {a.cursor_sand_enabled ? (
        <Badge tone="accent" className="w-fit px-1.5 py-0 text-[10px]">
          Sand
        </Badge>
      ) : null}
    </div>
  );
}

export function AccountWarningChips({ a }: { a: AccountRow }) {
  const chips: { tone: Tone; label: string; title?: string }[] = [];
  const now = Date.now();
  if (a.last_error) chips.push({ tone: "danger", label: "最近出错", title: a.last_error });
  if (a.oauth_expires_at) {
    const exp = new Date(a.oauth_expires_at).getTime();
    if (!Number.isNaN(exp)) {
      const title = fmtDateTime(a.oauth_expires_at);
      if (exp < now) {
        if (a.has_refresh_token === true) chips.push({ tone: "neutral", label: "OAuth 待刷新", title });
        else chips.push({ tone: "danger", label: "OAuth 已过期", title });
      } else if (exp - now < 24 * 3600 * 1000) {
        chips.push({ tone: "warning", label: "24h 内到期", title });
      }
    }
  }
  if (a.cooldown_until) {
    const c = new Date(a.cooldown_until).getTime();
    if (!Number.isNaN(c) && c > now) chips.push({ tone: "warning", label: "冷却中" });
  }
  if (a.subscription_end_at) {
    const sub = new Date(a.subscription_end_at).getTime();
    if (!Number.isNaN(sub)) {
      const days = (sub - now) / (24 * 3600 * 1000);
      const title = fmtDateTime(a.subscription_end_at);
      if (days <= 0) chips.push({ tone: "danger", label: "订阅已过期", title });
      else if (days < 2) chips.push({ tone: "danger", label: `订阅 ${Math.ceil(days * 24)}h 内到期`, title });
      else if (days < 7) chips.push({ tone: "warning", label: `订阅 ${Math.ceil(days)}d 内到期`, title });
    }
  }
  if (chips.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {chips.map((c) =>
        c.title ? (
          <Tooltip key={c.label} content={c.title}>
            <Badge tone={c.tone} className="px-1.5 py-0 text-[11px]">
              {c.label}
            </Badge>
          </Tooltip>
        ) : (
          <Badge key={c.label} tone={c.tone} className="px-1.5 py-0 text-[11px]">
            {c.label}
          </Badge>
        ),
      )}
    </div>
  );
}

/** 最近使用相对时间(空→—)。 */
export function LastUsed({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-faint">—</span>;
  return <TimeAgo value={iso} className="font-mono text-[12px]" />;
}
