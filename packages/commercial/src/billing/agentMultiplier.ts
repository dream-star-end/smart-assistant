/**
 * PR2 v1.0.66 — codex agent per-agent cost multiplier 查询 + 复合计算。
 *
 * 与 model_pricing.multiplier 的关系:每次扣费的 effective multiplier =
 *   model_multiplier × agent_cost_multiplier。两个都是 NUMERIC(*,3) 字符串,
 *   通过 multiplierToScaled (×1000 BigInt) 复合,避免 JS number 浮点。
 *
 * 调用模式:
 *   const agentMul = await getAgentCostMultiplier(pool, agentId)  // "1.000"|"1.500"|...
 *   const composedMul = composeMultiplier(pricing.multiplier, agentMul)
 *   const derivedPricing = { ...pricing, multiplier: composedMul }
 *   const { cost_credits } = computeCost(usage, derivedPricing)
 *
 * 这条链路让 calculator.ts 完全不知道 agent 维度,零侵入。
 *
 * Cache:60s TTL 内存 LRU(agentId → multiplier)。admin 改 SQL 后最多 60s 生效;
 *   不挂 LISTEN/NOTIFY(改价频率极低,不值得)。负缓存(miss → "1.000")也走同
 *   TTL,避免每次缺省 agent 都走 DB。
 */

import type { Pool } from "pg";

/** Cache 单条记录。 */
interface CacheEntry {
  multiplier: string;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * 测试 only:清空缓存,确保用例之间不串。
 */
export function _resetAgentMultiplierCacheForTests(): void {
  cache.clear();
}

/**
 * 查 `agent_cost_overrides.cost_multiplier`,缺省 "1.000"。
 *
 * 失败模式:DB 异常 → throw(让 caller 决定降级,通常是 sendErrorFrame INTERNAL +
 *   不放行 inbound)。不静默吞异常返回 "1.000",否则 admin 改的倍率不生效会
 *   误以为正常运行。
 */
export async function getAgentCostMultiplier(
  pool: Pool,
  agentId: string,
): Promise<string> {
  const now = Date.now();
  const hit = cache.get(agentId);
  if (hit && hit.expiresAt > now) {
    return hit.multiplier;
  }

  const result = await pool.query<{ cost_multiplier: string }>(
    "SELECT cost_multiplier FROM agent_cost_overrides WHERE agent_id = $1",
    [agentId],
  );

  // PG NUMERIC 默认以 string 返回,直接保留;缺省 "1.000"。
  const multiplier = result.rows.length > 0 ? result.rows[0].cost_multiplier : "1.000";
  cache.set(agentId, { multiplier, expiresAt: now + TTL_MS });
  return multiplier;
}

/**
 * multiplier 字符串 → BigInt scale 1000。复用 calculator 同款规则。
 *
 * 与 calculator.multiplierToScaled 行为一致,但本文件保留独立实现以避免循环依赖
 * (calculator 不该 import billing/agentMultiplier;agentMultiplier 也不该 import
 * calculator 内部 helper —— 它们是同层兄弟模块)。
 *
 * NUMERIC(8,3) 输入 → frac padEnd to 3 → slice(0, 3) → 3 位小数 BigInt。
 * 例:"1.5" → "1500"n,"0.001" → "1"n,"10" → "10000"n。
 */
// 合法 multiplier 字符串:可选负号 + 整数 + 可选小数。空字符串、多重小数点、字母等
// 都被拒。DB NUMERIC(*,3) 不会发 malformed 值,但本 helper 暴露公开 API,严格输入
// 验证防 caller 误用(例如未来 admin UI 直接拼字符串)。
const MULTIPLIER_PATTERN = /^-?\d+(\.\d+)?$/;

function multiplierToScaled(multiplier: string): bigint {
  if (!MULTIPLIER_PATTERN.test(multiplier)) {
    throw new TypeError(`multiplier malformed, got "${multiplier}"`);
  }
  const [intPart, fracRaw = ""] = multiplier.split(".");
  const frac = fracRaw.padEnd(3, "0").slice(0, 3);
  // 边界:negative multiplier 视为非法(DB CHECK 已挡,但 caller 也可能传裸字符串)。
  const scaled = BigInt(intPart + frac);
  if (scaled < 0n) {
    throw new TypeError(`multiplier must be non-negative, got ${multiplier}`);
  }
  return scaled;
}

/**
 * scaled BigInt(×1000)→ "X.YYY" 字符串。
 *
 * 例:1500n → "1.500",1n → "0.001",10000n → "10.000"。负值非法;0n 输出 "0.000"。
 */
function scaledToString(scaled: bigint): string {
  if (scaled < 0n) {
    throw new TypeError(`scaled must be non-negative, got ${scaled}`);
  }
  const intPart = scaled / 1000n;
  const fracPart = scaled % 1000n;
  return `${intPart.toString()}.${fracPart.toString().padStart(3, "0")}`;
}

/**
 * 复合两个 NUMERIC(*,3) 字符串 multiplier。
 *
 *   composed = (modelMul × agentMul) / 1.000
 *
 * 内部用 BigInt scale 1000:
 *   m × a / 1000 = composed_scaled
 *
 * 截断行为(向下取整):3+3 位小数乘积 6 位,除 1000 截掉低 3 位 = 向 0 截断。
 * 这是当前精度策略,**对客户有利**(扣得稍少而非稍多)。测试锁死该行为。
 *
 * 例:
 *   "2.000" × "1.500" = "3.000"           (2000 × 1500 / 1000 = 3000)
 *   "2.000" × "0.500" = "1.000"           (2000 × 500 / 1000 = 1000)
 *   "1.234" × "1.234" = "1.522"  (truncated, real = 1.522756)
 *   "10.000" × "0.001" = "0.010"          (10000 × 1 / 1000 = 10)
 *   "0.001" × "0.001" = "0.001"           (clamp:正×正 不允许变 0,见下方)
 *   "1.000" × any     = any               (恒等元)
 *
 * **正价不变免费**(clamp):向下截断的代价是两个非零正 multiplier 相乘可能精度
 * 损失到 0.000。这会让真实有价值的 turn 免费扣 — 不可接受。修复:m>0 且 a>0 但
 * composed=0 时 clamp 到最小精度 1n("0.001")。零值输入(modelMul=0 表示禁用计费)
 * 不 clamp,直接返回 "0.000"。
 */
export function composeMultiplier(modelMul: string, agentMul: string): string {
  const m = multiplierToScaled(modelMul);
  const a = multiplierToScaled(agentMul);
  let composed = (m * a) / 1000n; // 向下取整
  // Clamp:正 × 正 不能截断到 0,否则正价变免费(漏扣)。
  if (composed === 0n && m > 0n && a > 0n) {
    composed = 1n;
  }
  return scaledToString(composed);
}
