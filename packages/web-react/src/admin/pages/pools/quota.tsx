import { Badge } from "../../../components/ui";
import type { AccountRow } from "../accounts/types";
import type { MemberQuota, QuotaWindowView } from "./types";

/** "3h 后" / "18m 后" / "10-20" for a reset time; "已重置" once it has passed. */
export function resetLabel(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const diff = ms - now;
  if (diff <= 0) return "已重置";
  if (diff < 3_600_000) return `${Math.max(1, Math.ceil(diff / 60_000))}m 后重置`;
  if (diff < 86_400_000) return `${Math.ceil(diff / 3_600_000)}h 后重置`;
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 重置`;
}

const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const STALE_MS = 6 * 3_600_000;

/**
 * Quota windows of a subscription account row, or why there are none. Sources
 * (OCV5-424 merged tab): Claude/Codex from the upstream rate-limit report of the
 * account's own traffic; Grok and Cursor Sand from the hourly usage sweepers.
 */
export function accountQuota(a: AccountRow, now = Date.now()): MemberQuota {
  if (a.provider === "grok") {
    const pct = num(a.grok_credit_usage_pct);
    if (pct === null) {
      return {
        windows: [],
        updatedAt: a.grok_usage_updated_at ?? null,
        note: a.grok_usage_error ? `读取失败:${a.grok_usage_error}` : "每小时从 xAI 读取,尚无数据",
      };
    }
    return { windows: [{ label: "每周", usedPct: pct, resetsAt: a.grok_credit_period_end ?? null }], updatedAt: a.grok_usage_updated_at ?? null, note: null };
  }
  if (a.provider === "cursor") {
    const pct = num(a.cursor_sand_usage_pct);
    if (pct === null) {
      return {
        windows: [],
        updatedAt: a.cursor_usage_updated_at ?? null,
        note: a.cursor_credential_kind !== "session"
          ? "API key 凭证读不到用量(需 Cursor 账号会话凭证)"
          : a.cursor_usage_error ? `读取失败:${a.cursor_usage_error}` : "每小时从 Cursor 读取,尚无数据",
      };
    }
    return { windows: [{ label: "Sand 周期", usedPct: pct, resetsAt: a.cursor_sand_next_reset_at ?? null }], updatedAt: a.cursor_usage_updated_at ?? null, note: null };
  }
  // claude / codex: written from the upstream's own rate-limit report on each served request.
  const p5 = num(a.quota_5h_pct);
  const p7 = num(a.quota_7d_pct);
  const windows: QuotaWindowView[] = [];
  if (p5 !== null) windows.push({ label: "5 小时", usedPct: p5, resetsAt: a.quota_5h_resets_at });
  if (p7 !== null) windows.push({ label: "每周", usedPct: p7, resetsAt: a.quota_7d_resets_at });
  const upd = a.quota_updated_at ? new Date(a.quota_updated_at).getTime() : Number.NaN;
  let note: string | null = null;
  if (windows.length === 0) {
    note = a.quota_updated_at ? "上游最近的响应没有带额度信息" : "尚无数据:额度随上游响应更新,账号被调用后出现";
  } else if (p5 === null) {
    note = "上游未返回 5 小时窗口";
  } else if (p7 === null) {
    note = "上游未返回每周窗口";
  }
  if (windows.length > 0 && Number.isFinite(upd) && now - upd > STALE_MS) {
    const why = a.status === "active" ? "近期未被调用" : "账号未在调度中";
    note = [note, `${why},数据可能已过时`].filter(Boolean).join(";");
  }
  return { windows, updatedAt: a.quota_updated_at, note };
}

function toneOf(pct: number): "danger" | "warning" | null {
  return pct >= 95 ? "danger" : pct >= 80 ? "warning" : null;
}

/** One line per window: "5 小时 23% · 3h 后重置"; a note says why data is missing or partial. */
export function QuotaWindowsCell({ quota, now = Date.now() }: { quota: MemberQuota; now?: number }) {
  return (
    <div className="flex min-w-[11rem] flex-col gap-0.5" data-testid="quota-cell">
      {quota.windows.map((w) => {
        const tone = w.usedPct === null ? null : toneOf(w.usedPct);
        const pct = w.usedPct === null ? "—" : `${w.usedPct % 1 === 0 ? w.usedPct.toFixed(0) : w.usedPct.toFixed(1)}%`;
        const reset = resetLabel(w.resetsAt, now);
        return (
          <span key={w.label} className="whitespace-nowrap text-meta">
            <span className="text-muted">{w.label}</span>{" "}
            {tone ? (
              <Badge tone={tone} className="px-1.5 py-0 text-caption">
                已用 {pct}
              </Badge>
            ) : (
              <span className="tabular-nums text-fg">已用 {pct}</span>
            )}
            {reset ? <span className="text-faint"> · {reset}</span> : null}
          </span>
        );
      })}
      {quota.note ? <span className="line-clamp-2 text-caption text-faint">{quota.note}</span> : null}
    </div>
  );
}
