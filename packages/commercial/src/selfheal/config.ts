/**
 * v5 自愈体系收尾批(B3+M5)— OC_SELFHEAL_* 配置单一收口。
 *
 * 职责:
 *   1. 所有 OC_SELFHEAL_* 数值 env 的解析/默认值/下限 clamp 统一在此(B3):
 *      此前 tick/cooldown/ack/total/verify 五处各自 Number(...) 散装解析,
 *      默认值飘在四个文件里;现在消费方(index 装配/dispatcher/sweeper/callbacks)
 *      一律 import 本模块,新增数值 env 必须先在这里登记。
 *   2. assertSelfhealConfig()(M5+B3):index.ts 装配 selfheal 前调用。
 *      dispatch 启用(OC_SELFHEAL_DISPATCH_DISABLED 显式 '0'/'false')时对密钥/派单
 *      URL 做 fail-fast 校验,违规直接 throw 拒启——绝不让弱密钥/出网派单 URL
 *      带病上线;禁用时仅 warn 摘要(dormant 部署合法)。
 *
 * SSRF 钉死(M5):OC_SELFHEAL_DISPATCH_URL 只允许 `http://` + loopback host
 * (127.0.0.1 / localhost / [::1])+ 显式端口——派单只会走本机 SSH 隧道,任何
 * 其他形态(https 直连公网/内网横移/隐式端口)都是配置错误。配合 dispatcher
 * fetch redirect:'manual'(3xx 按失败),重定向逃逸也被封死。
 */

import { rootLogger } from "../logging/logger.js";

/** 最小密钥长度(hex/base64 任意编码下 32 字符起步)。 */
export const MIN_SECRET_LENGTH = 32;

// ─── 数值 env 收口(B3)────────────────────────────────────────────────

function intEnv(name: string, def: number, min: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.trunc(raw) : def;
}

/** reconciler/sweeper tick 间隔(OC_SELFHEAL_TICK_MS,默认 10s,下限 2s)。 */
export function selfhealTickMs(): number {
  return intEnv("OC_SELFHEAL_TICK_MS", 10_000, 2_000);
}

/** 同 event_type 派单冷却(OC_SELFHEAL_REPAIR_COOLDOWN_MS,默认 30min;0=关)。 */
export function repairCooldownMs(): number {
  return intEnv("OC_SELFHEAL_REPAIR_COOLDOWN_MS", 30 * 60 * 1000, 0);
}

/** dispatched→ack 预算(OC_SELFHEAL_ACK_BUDGET_MS,默认 5min,下限 30s)。 */
export function ackBudgetMs(): number {
  return intEnv("OC_SELFHEAL_ACK_BUDGET_MS", 5 * 60 * 1000, 30_000);
}

/** 修复总预算(OC_SELFHEAL_TOTAL_BUDGET_MS,默认 90min,下限 60s)。 */
export function totalBudgetMs(): number {
  return intEnv("OC_SELFHEAL_TOTAL_BUDGET_MS", 90 * 60 * 1000, 60_000);
}

/** done/verify 后探测确认预算(OC_SELFHEAL_VERIFY_BUDGET_MS,默认 6min,下限 60s)。 */
export function verifyBudgetMs(): number {
  return intEnv("OC_SELFHEAL_VERIFY_BUDGET_MS", 6 * 60 * 1000, 60_000);
}

/** 派单总闸:默认视为禁用;仅 OC_SELFHEAL_DISPATCH_DISABLED 显式 '0'/'false' 才启用。 */
export function isSelfhealDispatchDisabled(): boolean {
  const v = (process.env.OC_SELFHEAL_DISPATCH_DISABLED ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false";
}

// ─── M5:派单 URL SSRF 校验 ────────────────────────────────────────────

// Node URL 对 IPv6 hostname 带方括号('[::1]');兼收裸形态防 Node 版本差异。
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * 校验派单 URL 形态(M5):`http://` + loopback host + 显式端口。
 * 返回 null=合法;否则返回违规原因(供 assert 汇总抛错)。
 */
export function validateDispatchUrl(raw: string | undefined): string | null {
  if (!raw || raw.length === 0) return "OC_SELFHEAL_DISPATCH_URL 未设置";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `OC_SELFHEAL_DISPATCH_URL 不是合法 URL:${raw}`;
  }
  if (u.protocol !== "http:") {
    return `OC_SELFHEAL_DISPATCH_URL 必须为 http://(隧道本机口),got ${u.protocol}//`;
  }
  // Node URL 对 [::1] 的 hostname 返回去括号的 '::1'。
  if (!LOOPBACK_HOSTNAMES.has(u.hostname)) {
    return `OC_SELFHEAL_DISPATCH_URL host 必须是 loopback(127.0.0.1/localhost/[::1]),got ${u.hostname}`;
  }
  if (u.port === "") {
    return "OC_SELFHEAL_DISPATCH_URL 必须带显式端口(隧道监听口)";
  }
  return null;
}

// ─── assertSelfhealConfig(index.ts 装配前调)─────────────────────────

/**
 * selfheal 装配前的配置硬校验(M5+B3)。
 *   - dispatch 启用:MASTER_SECRET ≥32 / WEBHOOK_HMAC ≥32 / 两者互异 /
 *     DISPATCH_URL 过 validateDispatchUrl,任一违规 throw(fail-fast 拒启)。
 *   - dispatch 禁用:仅 warn 一行摘要(观察层可独立上线)。
 */
export function assertSelfhealConfig(): void {
  const log = rootLogger.child({ subsys: "selfheal", module: "config" });
  if (isSelfhealDispatchDisabled()) {
    log.warn("selfheal_dispatch_disabled", {
      hint: "OC_SELFHEAL_DISPATCH_DISABLED 未显式置 0/false,观察层(reconciler/sweeper 投递)运行,派单/取消不出站",
    });
    return;
  }
  const problems: string[] = [];
  const master = process.env.OC_SELFHEAL_MASTER_SECRET ?? "";
  const webhook = process.env.OC_SELFHEAL_WEBHOOK_HMAC ?? "";
  if (master.length < MIN_SECRET_LENGTH) {
    problems.push(`OC_SELFHEAL_MASTER_SECRET 长度必须 ≥${MIN_SECRET_LENGTH}(capability 签发根)`);
  }
  if (webhook.length < MIN_SECRET_LENGTH) {
    problems.push(`OC_SELFHEAL_WEBHOOK_HMAC 长度必须 ≥${MIN_SECRET_LENGTH}(webhook 信任链)`);
  }
  if (master.length > 0 && master === webhook) {
    problems.push("OC_SELFHEAL_MASTER_SECRET 与 OC_SELFHEAL_WEBHOOK_HMAC 必须互异(域隔离,单泄不塌两链)");
  }
  const urlProblem = validateDispatchUrl(process.env.OC_SELFHEAL_DISPATCH_URL);
  if (urlProblem) problems.push(urlProblem);
  if (problems.length > 0) {
    throw new Error(
      `[selfheal/config] 派单已启用(OC_SELFHEAL_DISPATCH_DISABLED=0)但配置不合规,拒启:\n  - ${problems.join("\n  - ")}`,
    );
  }
  log.info("selfheal_dispatch_config_ok", {
    dispatchUrl: process.env.OC_SELFHEAL_DISPATCH_URL,
    tickMs: selfhealTickMs(),
    cooldownMs: repairCooldownMs(),
    ackBudgetMs: ackBudgetMs(),
    totalBudgetMs: totalBudgetMs(),
    verifyBudgetMs: verifyBudgetMs(),
  });
}
