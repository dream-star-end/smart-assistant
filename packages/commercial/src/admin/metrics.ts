/**
 * T-62 — Prometheus 指标(最小实现)。
 *
 * ### 范围(02-ARCH §7.2)
 *   - gateway_http_requests_total{route, status}   counter
 *   - billing_debit_total{result}                  counter  (success/insufficient/error)
 *   - claude_api_requests_total{account_id, status} counter (success/error)
 *   - account_pool_health{account_id}              gauge   (从 DB 抽)
 *   - agent_containers_running                     gauge   (从 DB 抽)
 *
 * ### 设计取舍
 *   - 不引 `prom-client`:依赖小 + 我们只要 5 个系列,手搓 < 100 行可控
 *   - 计数器是进程级 module-level Map(单实例 gateway 进程内聚合,符合当前部署)
 *   - 2 个 gauge 在 scrape 时才查 DB —— 指标永远反映"当前真相",而不是上次 tick
 *   - route label 归一化:动态段(数字 id / model_id)折叠成 `:id` / `:slug`,
 *     否则 label 基数会爆(每个 user_id 一条 series)
 *
 * ### 使用
 *   - `metricsInc(counter, labels)` 在调用点++
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
    const r = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM agent_containers WHERE status = 'running'",
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
}

/** 给 alerts.ts 读取 account health / agent running 的 snapshot(避免双查)。 */
export async function snapshotForAlerts(deps: CollectDeps = {}): Promise<{
  accountHealth: Array<{ account_id: string; health_score: number; status: string }>;
  agentContainersRunning: number;
}> {
  return await collectGauges(deps);
}
