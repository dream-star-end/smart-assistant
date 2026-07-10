/**
 * Prometheus 文本解析纯函数集 —— 从 vanilla admin.js（`renderHealthTab` 一族）
 * 逐字移植，只做 DOM 无关的取数聚合，便于单测。
 *
 * 权威来源：packages/web/public/modules/admin.js
 *  - `_parsePromLine` / `_parsePromText` / `_sumSeries` / `_groupByLabel` / `_histogramByLabel`
 *
 * 口径与 vanilla 一致：
 *  - label value 反转义（\\ \" \n），否则仅转义形式不同的两条 series 会被算成不同 key；
 *  - 末尾可能跟 timestamp，只取第一个数字；
 *  - histogram 平均 = _sum / _count（count>0）。
 */

export type PromSample = { labels: Record<string, string>; value: number };
export type PromMetrics = Map<string, PromSample[]>;
/** histogram 每个 label 值一行：请求数 count、总和 sum、平均 avg=sum/count。 */
export type HistRow = { key: string; count: number; sum: number; avg: number };
export type ParsedLine = { name: string; labels: Record<string, string>; value: number };

/**
 * Prom exposition 转义还原：`\\`→`\`、`\"`→`"`、`\n`→换行，其余 `\X`→`X`。
 * 单次回调等价 vanilla 的占位符四步 replace（避免转义形式不同被算成不同 key），且不引入
 * 中间控制字符占位。
 */
function unescapeLabel(raw: string): string {
  return raw.replace(/\\(.)/g, (_m, ch: string) => (ch === "n" ? "\n" : ch));
}

/** 解析一行 exposition 文本。注释 / 空行 / 非数字值 → null。 */
export function parsePromLine(line: string): ParsedLine | null {
  if (!line || line.startsWith("#")) return null;
  const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(.+?)$/);
  if (!m) return null;
  const name = m[1];
  const labelStr = m[3] || "";
  const valStr = m[4].trim().split(/\s+/)[0]; // 末尾可能跟 timestamp，只取数字
  const value = Number(valStr);
  if (!Number.isFinite(value)) return null;
  const labels: Record<string, string> = {};
  if (labelStr) {
    const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
    let lm: RegExpExecArray | null = re.exec(labelStr);
    while (lm) {
      labels[lm[1]] = unescapeLabel(lm[2]);
      lm = re.exec(labelStr);
    }
  }
  return { name, labels, value };
}

/** 解析整段 text，按 metric name 分桶。返回 Map<name, Array<{labels, value}>>。 */
export function parsePromText(text: string): PromMetrics {
  const out: PromMetrics = new Map();
  for (const line of (text || "").split("\n")) {
    const r = parsePromLine(line);
    if (!r) continue;
    let bucket = out.get(r.name);
    if (!bucket) {
      bucket = [];
      out.set(r.name, bucket);
    }
    bucket.push({ labels: r.labels, value: r.value });
  }
  return out;
}

/** 一组 series 的值求和（undefined → 0）。 */
export function sumSeries(samples?: PromSample[]): number {
  if (!samples) return 0;
  return samples.reduce((s, x) => s + x.value, 0);
}

/** 返回 {[label_value]: sum_value} 按指定 label 聚合（缺失 label 落 '?'）。 */
export function groupByLabel(
  samples: PromSample[] | undefined,
  labelName: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!samples) return out;
  for (const s of samples) {
    const k = s.labels[labelName] ?? "?";
    out[k] = (out[k] || 0) + s.value;
  }
  return out;
}

/**
 * Histogram 平均（sum/count），用 `_sum` / `_count` 两件套按 label 聚合。
 * model label 已在 server 端按 shortModel 折叠过，前端不再二次聚合，直接返回每 key 的
 * (count, sum, avg)。
 */
export function histogramByLabel(
  metrics: PromMetrics,
  baseName: string,
  labelName: string,
): HistRow[] {
  const sumSamples = metrics.get(`${baseName}_sum`) || [];
  const countSamples = metrics.get(`${baseName}_count`) || [];
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const s of sumSamples) {
    const k = s.labels[labelName] ?? "?";
    sums[k] = (sums[k] || 0) + s.value;
  }
  for (const s of countSamples) {
    const k = s.labels[labelName] ?? "?";
    counts[k] = (counts[k] || 0) + s.value;
  }
  const out: HistRow[] = [];
  for (const k of Object.keys(counts)) {
    const c = counts[k];
    const sum = sums[k] || 0;
    out.push({ key: k, count: c, sum, avg: c > 0 ? sum / c : 0 });
  }
  return out;
}

// ── 健康页派生口径（把 metrics 一次性算成视图模型，供组件消费） ──────────────

export type Diagnostics = {
  server?: {
    version?: { tag?: string; builtAt?: string; commit?: string };
    node?: string;
    uptime_sec?: number;
    now?: string;
  };
  db?: { pool_total?: number; pool_idle?: number; pool_waiting?: number; pg_version?: string };
  alerts?: {
    rules?: { firing?: number; normal?: number; recent_firing?: Array<{ rule_id: string; fired_at: string }> };
    outbox?: { pending?: number; failed?: number; sent_24h?: number; oldest_pending_age_sec?: number };
    events_24h_by_severity?: { critical?: number; warning?: number; info?: number };
  };
  account_pool?: {
    total?: number;
    active?: number;
    cooldown?: number;
    disabled?: number;
    banned?: number;
    avg_health?: number;
    today_requests?: number;
    today_success_rate?: number;
  };
};

export type AcctRow = { account_id: string; status: string; health: number };

export type HealthView = {
  reqTotal: number;
  reqByStatus: Record<string, number>;
  debitByResult: Record<string, number>;
  claudeByStatus: Record<string, number>;
  settleByKind: Record<string, number>;
  rejectByReason: Record<string, number>;
  auditFailByAction: Record<string, number>;
  containersRunning: number;
  okStatusSum: number;
  errStatusSum: number;
  acctRows: AcctRow[];
  ttftHist: HistRow[];
  streamHist: HistRow[];
  bridgeBufferedHist: HistRow[];
  bridgeSessionHist: HistRow[];
  /** 每 model TTFT 平均毫秒（仅 avg>0），供柱图。 */
  ttftMsByModel: Record<string, number>;
};

/** 把 Prom 文本一次性算成健康页视图模型（口径逐条对齐 vanilla renderHealthTab）。 */
export function deriveHealthView(text: string): HealthView {
  const metrics = parsePromText(text);

  const reqByStatus = groupByLabel(metrics.get("gateway_http_requests_total"), "status");
  const okStatusSum =
    (reqByStatus["200"] || 0) + (reqByStatus["201"] || 0) + (reqByStatus["204"] || 0);
  const errStatusSum = Object.entries(reqByStatus)
    .filter(([k]) => /^5/.test(k))
    .reduce((s, [, v]) => s + v, 0);

  const acctSamples = metrics.get("account_pool_health") || [];
  const acctRows: AcctRow[] = acctSamples
    .map((s) => ({
      account_id: s.labels.account_id || "?",
      status: s.labels.status || "?",
      health: s.value,
    }))
    .sort((a, b) => a.health - b.health);

  const ttftHist = histogramByLabel(metrics, "anthropic_proxy_ttft_seconds", "model");
  const ttftMsByModel: Record<string, number> = {};
  for (const h of ttftHist) {
    if (h.avg > 0) ttftMsByModel[h.key] = Math.round(h.avg * 1000);
  }

  return {
    reqTotal: sumSeries(metrics.get("gateway_http_requests_total")),
    reqByStatus,
    debitByResult: groupByLabel(metrics.get("billing_debit_total"), "result"),
    claudeByStatus: groupByLabel(metrics.get("claude_api_requests_total"), "status"),
    settleByKind: groupByLabel(metrics.get("anthropic_proxy_settle_total"), "kind"),
    rejectByReason: groupByLabel(metrics.get("anthropic_proxy_reject_total"), "reason"),
    auditFailByAction: groupByLabel(metrics.get("admin_audit_write_failures_total"), "action"),
    containersRunning: sumSeries(metrics.get("agent_containers_running")),
    okStatusSum,
    errStatusSum,
    acctRows,
    ttftHist,
    streamHist: histogramByLabel(metrics, "anthropic_proxy_stream_duration_seconds", "model"),
    bridgeBufferedHist: histogramByLabel(metrics, "ws_bridge_buffered_bytes", "side"),
    bridgeSessionHist: histogramByLabel(metrics, "ws_bridge_session_duration_seconds", "cause"),
    ttftMsByModel,
  };
}

// ── 展示辅助（纯函数，页面与测试共用） ────────────────────────────────────────

/** HTTP 状态码 → 语义色 token（2xx success / 3xx info / 4xx warning / 5xx danger / 其它 muted）。 */
export function statusColorToken(code: string): string {
  const s = String(code);
  if (/^2/.test(s)) return "success";
  if (/^3/.test(s)) return "info";
  if (/^4/.test(s)) return "warning";
  if (/^5/.test(s)) return "danger";
  return "muted";
}

/** {k:v} → 按值降序的 [k,v] 数组，过滤 v>0。用于 donut/bar 取数。 */
export function positiveEntriesDesc(obj: Record<string, number>): Array<[string, number]> {
  return Object.entries(obj)
    .filter(([, v]) => Number(v) > 0)
    .sort((a, b) => b[1] - a[1]);
}
