// model-ops 页格式化 / 派生工具。纯函数,便于单测。

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** 数字缩写:>=1M→"1.2M",>=1K→"3.4K",接受 BIGINT 字符串(展示用,Number 精度损失可接受)。 */
export function fmtCompactNum(v: string | number | null | undefined): string {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO → date input 本地日期 "yyyy-mm-dd"。 */
export function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 订阅到期倒计时:<7天 danger / <30天 warning / 到期 danger / 其余 neutral;null=长期。 */
export function subCountdown(iso: string | null): { label: string; tone: Tone } {
  if (!iso) return { label: "长期/未登记", tone: "neutral" };
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { label: "—", tone: "neutral" };
  const days = Math.ceil((t - Date.now()) / 86_400_000);
  if (days <= 0) return { label: "已到期", tone: "danger" };
  if (days < 7) return { label: `${days}天后到期`, tone: "danger" };
  if (days < 30) return { label: `${days}天后到期`, tone: "warning" };
  return { label: `${days}天后到期`, tone: "neutral" };
}

/** 并发利用率 → 语义色:>80% danger / >50% warning / 其余 success。 */
export function utilTone(current: number, limit: number): { pct: number; tone: Tone } {
  const ratio = limit > 0 ? (current / limit) * 100 : 0;
  const tone: Tone = ratio > 80 ? "danger" : ratio > 50 ? "warning" : "success";
  return { pct: Math.min(100, Math.max(0, Math.round(ratio))), tone };
}

/** 模型 24h 用量一行:"N 请求 · X tok · Y 积分"(tokens = in+out 自加)。 */
export function usageLine(
  u: {
    attempts?: number; requests: number; failures?: number; cancellations?: number;
    input_tokens: string; output_tokens: string; credits: string;
  } | null | undefined,
): string {
  if (!u) return "—";
  const tokens = Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0);
  return `${fmtCompactNum(u.requests)}/${fmtCompactNum(u.attempts ?? u.requests)} 成功/尝试 · ${fmtCompactNum(u.failures ?? 0)} 失败 · ${fmtCompactNum(u.cancellations ?? 0)} 取消 · ${fmtCompactNum(tokens)} tok · ${fmtCompactNum(u.credits)} 积分`;
}

/** 服务商 24h 用量一行(tokens 后端已合计为字符串)。 */
export function providerUsageLine(u: {
  attempts?: number;
  requests: number;
  failures?: number;
  cancellations?: number;
  tokens: string;
  credits: string;
}): string {
  return `24h: ${fmtCompactNum(u.requests)}/${fmtCompactNum(u.attempts ?? u.requests)} 成功/尝试 · ${fmtCompactNum(u.failures ?? 0)} 失败 · ${fmtCompactNum(u.cancellations ?? 0)} 取消 · ${fmtCompactNum(u.tokens)} tokens · ${fmtCompactNum(u.credits)} 积分`;
}
