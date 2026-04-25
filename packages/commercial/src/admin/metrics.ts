/**
 * T-62 / V3 2I-2 — Prometheus 指标(最小实现)。
 *
 * ### 范围(02-ARCH §7.2 + V3 03-MVP-CHECKLIST 2I-2)
 *
 * v1(T-62 已上):
 *   - gateway_http_requests_total{route, method, status}  counter
 *   - billing_debit_total{result}                          counter  (success/insufficient/error)
 *   - claude_api_requests_total{account_id, status}        counter (success/error)
 *   - admin_audit_write_failures_total{action}             counter
 *   - account_pool_health{account_id, status}              gauge   (从 DB 抽)
 *   - agent_containers_running                             gauge   (从 DB 抽)
 *
 * v3 2I-2 新增(V3 anthropicProxy + userChatBridge):
 *   - anthropic_proxy_ttft_seconds{model}                  histogram (response 起到第一字节)
 *   - anthropic_proxy_stream_duration_seconds{model}       histogram (fetch 到 stream end)
 *   - anthropic_proxy_settle_total{kind}                   counter (final/partial/aborted)
 *   - anthropic_proxy_reject_total{reason}                 counter
 *       (insufficient/rate_limited/concurrency/account_pool/account_pool_busy/unknown_model/bad_body/too_large/identity)
 *   - ws_bridge_buffered_bytes{side}                       histogram
 *   - ws_bridge_session_duration_seconds{cause}            histogram
 *
 * ### 设计取舍
 *   - 不引 `prom-client`:依赖小 + 我们只要十几个系列,手搓可控(2I-2 加 Histogram 类)
 *   - 计数器是进程级 module-level Map(单实例 gateway 进程内聚合,符合当前部署)
 *   - 2 个 DB gauge 在 scrape 时才查 DB —— 指标永远反映"当前真相",而不是上次 tick
 *   - route label 归一化:动态段(数字 id / model_id)折叠成 `:id` / `:slug`,
 *     否则 label 基数会爆(每个 user_id 一条 series)
 *
 * ### 使用
 *   - `metricsInc(counter, labels)` 在调用点++
 *   - `observe*(seriesHelper, value)` 给 histogram 加观察样本
 *   - `renderPrometheus(deps)` 在 /api/admin/metrics 调用,返回 text/plain
 *   - `resetMetricsForTest()` 测试用,不对外 export 到 index.ts
 */

import type { Pool } from "pg";
import { query } from "../db/queries.js";

// ─── label normalization ─────────────────────────────────────────────

/**
 * 把 HTTP path 折叠成稳定的 route label。
 *
 * 例:
 *   /api/admin/users/42         → /api/admin/users/:id
 *   /api/admin/pricing/claude-sonnet-4-6 → /api/admin/pricing/:slug
 *   /api/payment/orders/xxx     → /api/payment/orders/:order_no
 *
 * 未命中白名单 → 原样返回(上游 404/405 本身 route label 不影响业务)。
 */
export function normalizeRoute(path: string): string {
  // 严格白名单,避免不相关路径进 metrics
  const patterns: Array<[RegExp, string]> = [
    [/^\/api\/admin\/users\/[0-9]+\/credits$/, "/api/admin/users/:id/credits"],
    [/^\/api\/admin\/users\/[0-9]+$/, "/api/admin/users/:id"],
    [/^\/api\/admin\/pricing\/[^/]+$/, "/api/admin/pricing/:model_id"],
    [/^\/api\/admin\/plans\/[^/]+$/, "/api/admin/plans/:code"],
    [/^\/api\/admin\/accounts\/[0-9]+$/, "/api/admin/accounts/:id"],
    [/^\/api\/admin\/agent-containers\/[0-9]+\/(restart|stop|remove)$/, "/api/admin/agent-containers/:id/:action"],
    [/^\/api\/payment\/orders\/[A-Za-z0-9_-]+$/, "/api/payment/orders/:order_no"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(path)) return label;
  }
  return path;
}

// ─── escaping ────────────────────────────────────────────────────────

function escLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

// ─── counter / gauge ─────────────────────────────────────────────────

type LabelValues = Readonly<Record<string, string | number>>;

interface SeriesDef {
  name: string;
  help: string;
  labelNames: readonly string[];
}

class Counter {
  readonly def: SeriesDef;
  private readonly values = new Map<string, { labels: LabelValues; count: number }>();

  constructor(def: SeriesDef) {
    this.def = def;
  }

  inc(labels: LabelValues, delta = 1): void {
    const key = serializeLabels(this.def.labelNames, labels);
    const entry = this.values.get(key);
    if (entry) {
      entry.count += delta;
    } else {
      // 只保留白名单里的 label,多余字段丢弃;缺失字段补 ""
      const norm: Record<string, string | number> = {};
      for (const name of this.def.labelNames) norm[name] = labels[name] ?? "";
      this.values.set(key, { labels: norm, count: delta });
    }
  }

  reset(): void {
    this.values.clear();
  }

  render(out: string[]): void {
    out.push(`# HELP ${this.def.name} ${this.def.help}`);
    out.push(`# TYPE ${this.def.name} counter`);
    // 稳定输出:按 label key 字典序
    const keys = [...this.values.keys()].sort();
    for (const k of keys) {
      const v = this.values.get(k)!;
      out.push(`${this.def.name}${renderLabels(v.labels)} ${v.count}`);
    }
  }
}

/** Gauge 只做"按 series render"——值由外部 collector 在 scrape 时填入。 */
class GaugeStream {
  readonly def: SeriesDef;
  private readonly rows: Array<{ labels: LabelValues; value: number }> = [];

  constructor(def: SeriesDef) {
    this.def = def;
  }

  set(labels: LabelValues, value: number): void {
    this.rows.push({ labels, value });
  }

  reset(): void {
    this.rows.length = 0;
  }

  render(out: string[]): void {
    out.push(`# HELP ${this.def.name} ${this.def.help}`);
    out.push(`# TYPE ${this.def.name} gauge`);
    for (const r of this.rows) {
      out.push(`${this.def.name}${renderLabels(r.labels)} ${r.value}`);
    }
  }
}

/**
 * 简易 Prometheus histogram。固定 bucket 上界(升序),每次 observe 把样本累计到所有
 * `<= upper` 的 bucket 里。`render` 输出 `_bucket{le="X"}` / `_sum` / `_count`,
 * 兼容 prom client / Grafana 的 `histogram_quantile()`。
 *
 * 不实现 prom-client 的 exemplars / native histogram —— 我们只要 p50/p99 用。
 */
class Histogram {
  readonly def: SeriesDef;
  /** 升序 bucket 上界。`+Inf` 自动追加,无需外部传。 */
  readonly buckets: readonly number[];
  private readonly series = new Map<
    string,
    { labels: LabelValues; counts: number[]; sum: number; total: number }
  >();

  constructor(def: SeriesDef, buckets: readonly number[]) {
    this.def = def;
    // 防御:运维写错 bucket 次序会让 histogram_quantile 输出乱
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i]! <= buckets[i - 1]!) {
        throw new Error(
          `Histogram ${def.name} buckets must be strictly ascending (got ${buckets[i - 1]} >= ${buckets[i]})`,
        );
      }
    }
    this.buckets = buckets;
  }

  observe(labels: LabelValues, value: number): void {
    if (!Number.isFinite(value) || value < 0) return; // 负数/NaN 静默丢
    const key = serializeLabels(this.def.labelNames, labels);
    let entry = this.series.get(key);
    if (!entry) {
      const norm: Record<string, string | number> = {};
      for (const name of this.def.labelNames) norm[name] = labels[name] ?? "";
      entry = {
        labels: norm,
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        total: 0,
      };
      this.series.set(key, entry);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) entry.counts[i]!++;
    }
    entry.sum += value;
    entry.total++;
  }

  reset(): void {
    this.series.clear();
  }

  render(out: string[]): void {
    out.push(`# HELP ${this.def.name} ${this.def.help}`);
    out.push(`# TYPE ${this.def.name} histogram`);
    const keys = [...this.series.keys()].sort();
    for (const k of keys) {
      const e = this.series.get(k)!;
      for (let i = 0; i < this.buckets.length; i++) {
        const b = this.buckets[i]!;
        const labelsWithLe: LabelValues = {
          ...e.labels,
          le: bucketLabel(b),
        };
        out.push(`${this.def.name}_bucket${renderLabels(labelsWithLe)} ${e.counts[i]}`);
      }
      const labelsInf: LabelValues = { ...e.labels, le: "+Inf" };
      out.push(`${this.def.name}_bucket${renderLabels(labelsInf)} ${e.total}`);
      out.push(`${this.def.name}_sum${renderLabels(e.labels)} ${e.sum}`);
      out.push(`${this.def.name}_count${renderLabels(e.labels)} ${e.total}`);
    }
  }
}

function bucketLabel(v: number): string {
  // Prometheus 习惯:整数 bucket 输出整数,小数 bucket 用通用格式。NaN 不会出现(构造期已禁)
  if (Number.isInteger(v)) return v.toString();
  return v.toString();
}

function serializeLabels(names: readonly string[], v: LabelValues): string {
  return names.map((n) => `${n}=${String(v[n] ?? "")}`).join("|");
}

function renderLabels(v: LabelValues): string {
  const parts: string[] = [];
  for (const [k, val] of Object.entries(v)) {
    parts.push(`${k}="${escLabel(String(val))}"`);
  }
  return parts.length ? `{${parts.join(",")}}` : "";
}

// ─── registry ─────────────────────────────────────────────────────────

export const gatewayRequests = new Counter({
  name: "gateway_http_requests_total",
  help: "Total HTTP requests handled by the commercial gateway",
  labelNames: ["route", "method", "status"],
});

export const billingDebits = new Counter({
  name: "billing_debit_total",
  help: "Total billing debit attempts (chat + agent_chat + admin_adjust etc.)",
  labelNames: ["result"], // success | insufficient | error
});

export const claudeApiRequests = new Counter({
  name: "claude_api_requests_total",
  help: "Total Claude API calls via account pool",
  labelNames: ["account_id", "status"], // status: success | error
});

/**
 * 合规相关:accounts/containers 的 audit 写入是 best-effort(非 tx),
 * 这条 counter 专门累计 "主操作成功但 audit 写失败" 的 case,运维 alert 可以挂。
 */
export const adminAuditWriteFailures = new Counter({
  name: "admin_audit_write_failures_total",
  help: "Failed admin_audit writes in best-effort (non-tx) paths",
  labelNames: ["action"],
});

/**
 * preCheck reservation 被 cap 到余额的次数(per model)。
 *
 * 2026-04-26 v1.0.3:preCheck 改为允许 drain-to-zero 后,余额 < 估算 cost
 * 的请求会把 reservation cap 到 balance。这条 counter 让运维观察 cap 触发率,
 * 间接反映"潜在 overage 暴露面"。
 */
export const precheckCappedTotal = new Counter({
  name: "precheck_capped_total",
  help: "Pre-check reservation was capped to user balance (drain-to-zero with finalize clamp safety net)",
  labelNames: ["model"],
});

/** 便捷 incr helper —— 把 labels 去 undefined。 */
export function incrGatewayRequest(route: string, method: string, status: number | string): void {
  gatewayRequests.inc({ route: normalizeRoute(route), method, status: String(status) });
}

export type DebitResultLabel = "success" | "insufficient" | "error";
export function incrBillingDebit(result: DebitResultLabel): void {
  billingDebits.inc({ result });
}

export function incrClaudeApi(accountId: bigint | number | string | null, status: "success" | "error"): void {
  claudeApiRequests.inc({
    account_id: accountId === null ? "" : String(accountId),
    status,
  });
}

export function incrAdminAuditWriteFailure(action: string): void {
  adminAuditWriteFailures.inc({ action });
}

/**
 * preCheck cap 计数。caller 传原始 model 名,内部用 shortModel 归一化防 cardinality 爆。
 */
export function incrPrecheckCapped(model: string): void {
  precheckCappedTotal.inc({ model: shortModel(model) });
}

// ─── V3 2I-2:anthropicProxy + userChatBridge 系列 ────────────────────

/**
 * Bucket 设计原则:覆盖 99% 的预期分布,头尾留余地。
 *   - TTFT:Anthropic 的 chat 通常 0.3-2s,流量大时偶尔 5-10s
 *   - 总 stream 时长:几秒到几十秒;tool 用户极端可上 5min
 *   - buffered bytes:1KB-4MB(maxBufferedBytes 默认 4MB)
 *   - ws 会话时长:秒到 1h+
 */
const TTFT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30] as const;
const STREAM_DURATION_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] as const;
const BUFFERED_BYTES_BUCKETS = [
  1024, 4 * 1024, 16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024,
] as const;
const WS_SESSION_DURATION_BUCKETS = [1, 5, 30, 60, 300, 900, 1800, 3600, 7200] as const;

export const anthropicProxyTtft = new Histogram(
  {
    name: "anthropic_proxy_ttft_seconds",
    // 起点 = fetch() 调用瞬间;终点 = 首个非空 SSE chunk。
    // 包含 DNS/TLS/请求发送/上游排队/上游模型首字节。不是 Anthropic 模型 first-token 的纯 TTFT。
    help: "Time from fetch() call to first non-empty SSE chunk (seconds), per model. Includes DNS/TLS/request send/upstream queueing.",
    labelNames: ["model"],
  },
  TTFT_BUCKETS,
);

export const anthropicProxyStreamDuration = new Histogram(
  {
    name: "anthropic_proxy_stream_duration_seconds",
    help: "Total upstream stream duration from fetch start to last byte (seconds), per model",
    labelNames: ["model"],
  },
  STREAM_DURATION_BUCKETS,
);

/**
 * settle 三态:final = stream 正常完成 + 提取到 usage;partial = 中断 + 部分 usage;
 * aborted = finalize.fail 路径(无 usage 写入,不扣费)。运维盯 partial+aborted 占比。
 */
export const anthropicProxySettle = new Counter({
  name: "anthropic_proxy_settle_total",
  help: "Anthropic proxy stream settle outcome (final/partial/aborted)",
  labelNames: ["kind"], // final | partial | aborted
});

/**
 * 早期拒绝原因。reason 是闭集合(代码白名单),避免 cardinality 爆。
 *   - insufficient    余额不足(preCheck)
 *   - rate_limited    per-uid 滑窗
 *   - concurrency     per-uid 并发上限
 *   - account_pool    池空 / 全 down
 *   - account_pool_busy  所有账号都到达 per-account 并发上限(瞬时过载,429)
 *   - unknown_model   定价表缺
 *   - bad_body        zod parse 失败
 *   - too_large       413
 *   - identity        容器双因子失败
 *   - bad_path        非 POST /v1/messages
 *   - bad_headers     header allowlist 失败
 *   - upstream_auth   refresh token 失败
 */
export const anthropicProxyReject = new Counter({
  name: "anthropic_proxy_reject_total",
  help: "Anthropic proxy rejected requests, by reason",
  labelNames: ["reason"],
});

export const wsBridgeBufferedBytes = new Histogram(
  {
    name: "ws_bridge_buffered_bytes",
    help: "Per-side buffered bytes observed in user-chat-bridge",
    labelNames: ["side"], // user_to_container | container_to_user
  },
  BUFFERED_BYTES_BUCKETS,
);

export const wsBridgeSessionDuration = new Histogram(
  {
    name: "ws_bridge_session_duration_seconds",
    help: "user-chat-bridge session duration (seconds), labeled by close cause",
    labelNames: ["cause"],
  },
  WS_SESSION_DURATION_BUCKETS,
);

// ─── 便捷 incr / observe helpers ────────────────────────────────────

export function observeAnthropicProxyTtft(model: string, seconds: number): void {
  anthropicProxyTtft.observe({ model: shortModel(model) }, seconds);
}

export function observeAnthropicProxyStreamDuration(model: string, seconds: number): void {
  anthropicProxyStreamDuration.observe({ model: shortModel(model) }, seconds);
}

export type SettleKind = "final" | "partial" | "aborted";
export function incrAnthropicProxySettle(kind: SettleKind): void {
  anthropicProxySettle.inc({ kind });
}

export type ProxyRejectReason =
  | "insufficient"
  | "rate_limited"
  | "concurrency"
  | "account_pool"
  | "account_pool_busy"
  | "unknown_model"
  | "bad_body"
  | "too_large"
  | "identity"
  | "bad_path"
  | "bad_headers"
  | "upstream_auth";
export function incrAnthropicProxyReject(reason: ProxyRejectReason): void {
  anthropicProxyReject.inc({ reason });
}

export type BridgeSide = "user_to_container" | "container_to_user";
export function observeWsBridgeBuffered(side: BridgeSide, bytes: number): void {
  wsBridgeBufferedBytes.observe({ side }, bytes);
}

export function observeWsBridgeSessionDuration(cause: string, seconds: number): void {
  wsBridgeSessionDuration.observe({ cause }, seconds);
}

/**
 * Model label 折叠:把 vendor + 主版本号留下,丢日期 / 后缀。
 * 例:claude-sonnet-4-6-20250101 → claude-sonnet-4-6
 *
 * 这个函数对 cardinality 防爆很关键 —— 我们 model 名形如 claude-sonnet-4-6 已是稳定 ID,
 * 但如果运维写错放进去 my-experimental-2026-01-23-v123 这种,会爆。strip 末尾 8 位日期。
 */
function shortModel(m: string): string {
  // 8 位日期后缀(可带前导 -)→ 删掉
  return m.replace(/-\d{8}$/, "").slice(0, 64);
}

// ─── gauges 由 scrape 时 collector 填 ─────────────────────────────────

export interface CollectDeps {
  /** 可选:注入测试 pool;未传则用 getPool() (在 renderPrometheus 里解) */
  pool?: Pool;
  /** 可选:覆盖 gauge 查询结果(测试用 —— 避免依赖真 DB) */
  override?: {
    accountHealth?: Array<{ account_id: string; health_score: number; status: string }>;
    agentContainersRunning?: number;
  };
}

/**
 * 查账号池健康 + 运行中容器数,不抛。任何查询失败返空数组(记为 stderr 警告)。
 * 为什么不抛:/metrics 被 Prometheus 定时抓,一次抖动不应让监控自己先挂。
 */
async function collectGauges(deps: CollectDeps): Promise<{
  accountHealth: Array<{ account_id: string; health_score: number; status: string }>;
  agentContainersRunning: number;
}> {
  if (deps.override) {
    return {
      accountHealth: deps.override.accountHealth ?? [],
      agentContainersRunning: deps.override.agentContainersRunning ?? 0,
    };
  }

  let accountHealth: Array<{ account_id: string; health_score: number; status: string }> = [];
  try {
    const r = await query<{ id: string; health_score: number; status: string }>(
      "SELECT id::text AS id, health_score, status FROM claude_accounts ORDER BY id",
    );
    accountHealth = r.rows.map((row) => ({
      account_id: row.id,
      health_score: Number(row.health_score ?? 0),
      status: row.status,
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[admin/metrics] collect accountHealth failed:", err);
  }

  let agentContainersRunning = 0;
  try {
    // v3 ephemeral 容器用 `state='active'` 表示"本 supervisor 仍视为 alive"。
    // 旧 `status='running'` 是 v2 legacy 列 —— v3 INSERT 只写 state,不写 status,
    // 导致 v3 容器永远不会被旧查询计到,gauge 永远报 0。
    const r = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM agent_containers WHERE state = 'active'",
    );
    agentContainersRunning = Number(r.rows[0]?.n ?? "0");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[admin/metrics] collect agentContainersRunning failed:", err);
  }

  return { accountHealth, agentContainersRunning };
}

// ─── render ───────────────────────────────────────────────────────────

/**
 * 渲染完整 Prometheus exposition 文本(`text/plain; version=0.0.4`)。
 *
 * 调用 `collectGauges` 在 scrape 时刷新 gauge —— counter 是累加的,gauge 是快照。
 */
export async function renderPrometheus(deps: CollectDeps = {}): Promise<string> {
  const { accountHealth, agentContainersRunning } = await collectGauges(deps);

  const accountPoolHealth = new GaugeStream({
    name: "account_pool_health",
    help: "Per-account health score (0..100); also tagged with status",
    labelNames: ["account_id", "status"],
  });
  for (const a of accountHealth) {
    accountPoolHealth.set({ account_id: a.account_id, status: a.status }, a.health_score);
  }

  const agentRunning = new GaugeStream({
    name: "agent_containers_running",
    help: "Number of agent containers in running state",
    labelNames: [],
  });
  agentRunning.set({}, agentContainersRunning);

  const out: string[] = [];
  gatewayRequests.render(out);
  billingDebits.render(out);
  claudeApiRequests.render(out);
  adminAuditWriteFailures.render(out);
  precheckCappedTotal.render(out);
  // V3 2I-2 新增系列
  anthropicProxyTtft.render(out);
  anthropicProxyStreamDuration.render(out);
  anthropicProxySettle.render(out);
  anthropicProxyReject.render(out);
  wsBridgeBufferedBytes.render(out);
  wsBridgeSessionDuration.render(out);
  // gauges 走 collector
  accountPoolHealth.render(out);
  agentRunning.render(out);
  out.push(""); // 结尾必须带换行
  return out.join("\n");
}

// ─── test helper(不出 index.ts)─────────────────────────────────────

export function resetMetricsForTest(): void {
  gatewayRequests.reset();
  billingDebits.reset();
  claudeApiRequests.reset();
  adminAuditWriteFailures.reset();
  precheckCappedTotal.reset();
  // V3 2I-2
  anthropicProxyTtft.reset();
  anthropicProxyStreamDuration.reset();
  anthropicProxySettle.reset();
  anthropicProxyReject.reset();
  wsBridgeBufferedBytes.reset();
  wsBridgeSessionDuration.reset();
}

/** 给 alerts.ts 读取 account health / agent running 的 snapshot(避免双查)。 */
export async function snapshotForAlerts(deps: CollectDeps = {}): Promise<{
  accountHealth: Array<{ account_id: string; health_score: number; status: string }>;
  agentContainersRunning: number;
}> {
  return await collectGauges(deps);
}
