/**
 * T-20 — 模型定价(Pricing)缓存 + LISTEN/NOTIFY 实时重载。
 *
 * Invariants:
 *   - 启动时一次性把 `model_pricing` 全表加载到内存 Map
 *   - `getPricing(modelId)` O(1) 无 I/O:计费热路径(T-21 计算器)每 chat 都要查一次,
 *     不能再走 DB
 *   - admin UI 改价 → pg trigger (0008) 发 `NOTIFY pricing_changed` → 本进程
 *     收到通知后重新 load 全表。多个并发 UPDATE 被 pg 合并成一次 NOTIFY,cache 只 reload 1 次
 *   - reload 失败(e.g. pool 暂时不可用)→ 保留旧缓存 + 错误日志,**不清空**
 *     (清空会让热路径瞬间全部返回"未知模型",比继续用旧值危险)
 *   - 所有数值字段(BIGINT / NUMERIC)由 pg driver 作为 string 返回,我们在边界
 *     一次性转成 `bigint` / 保留 `multiplier` 的 string 形式(T-21 用 decimal.js 或
 *     手工乘除)—— 绝不依赖 JS number 表达金额
 *
 * 线程模型:LISTEN 需要独占一个 `pg.Client`(pool 里的 client 没法稳定 LISTEN,
 *   因为下一次 `query()` 可能回到不同的底层连接)。所以 PricingCache 在 start()
 *   时**额外**开一个 Client,它的生命周期和 cache 一致。
 */

import { Client } from "pg";
import { query } from "../db/queries.js";
import { loadConfig } from "../config.js";

export interface ModelPricing {
  model_id: string;
  display_name: string;
  /** 每 1M input token 的定价,单位:分(人民币)。 */
  input_per_mtok: bigint;
  output_per_mtok: bigint;
  cache_read_per_mtok: bigint;
  cache_write_per_mtok: bigint;
  /** NUMERIC(6,3),保留字符串形式,避免 JS number 丢精度。T-21 会用它算账。 */
  multiplier: string;
  enabled: boolean;
  sort_order: number;
  updated_at: Date;
}

/**
 * `/api/public/models` 返回的单个模型条目。
 *
 * `*_per_ktok_credits` = (分/Mtok * multiplier) / 100 分每积分 / 1000 ktok per Mtok
 *                      = "每 1000 token 实际扣减的积分数"
 * 保留 6 位小数字符串形式,前端可直接展示或精确转成 BigDecimal。
 */
export interface PublicModel {
  id: string;
  display_name: string;
  input_per_ktok_credits: string;
  output_per_ktok_credits: string;
  cache_read_per_ktok_credits: string;
  cache_write_per_ktok_credits: string;
  multiplier: string;
}

type RawRow = {
  model_id: string;
  display_name: string;
  input_per_mtok: string;
  output_per_mtok: string;
  cache_read_per_mtok: string;
  cache_write_per_mtok: string;
  multiplier: string;
  enabled: boolean;
  sort_order: number;
  updated_at: Date;
};

function rowToPricing(r: RawRow): ModelPricing {
  return {
    model_id: r.model_id,
    display_name: r.display_name,
    input_per_mtok: BigInt(r.input_per_mtok),
    output_per_mtok: BigInt(r.output_per_mtok),
    cache_read_per_mtok: BigInt(r.cache_read_per_mtok),
    cache_write_per_mtok: BigInt(r.cache_write_per_mtok),
    multiplier: r.multiplier,
    enabled: r.enabled,
    sort_order: r.sort_order,
    updated_at: r.updated_at,
  };
}

/**
 * 计算 per-ktok credits,以 6 位小数字符串返回(向下取整到 6 位)。
 *
 * 推导:
 *   credits/ktok = per_mtok_cents * multiplier                   (分 * mul / Mtok)
 *                  / 100 分每积分
 *                  / 1000 ktok 每 Mtok
 *                = per_mtok_cents * multiplier / 100_000
 *
 * multiplier 是 NUMERIC(6,3) —— 用 "整数 × 10^3" 的形式避免 JS float:
 *   mul_scaled = BigInt(multiplier_without_dot_padded_to_3_frac_digits)
 *
 * 要 6 位小数精度就把结果放大 10^6 再除整,然后拆 whole/frac:
 *   scaled_credits_e6 = per_mtok_cents * mul_scaled * 10^6
 *                       / (10^3 * 100_000)
 *                     = per_mtok_cents * mul_scaled / 100
 *   whole = scaled_credits_e6 / 10^6
 *   frac  = scaled_credits_e6 % 10^6
 */
export function perKtokCredits(perMtokCents: bigint, multiplier: string): string {
  const [intPart, fracPartRaw = ""] = multiplier.split(".");
  const fracPart = fracPartRaw.padEnd(3, "0").slice(0, 3);
  const mulScaled = BigInt(intPart + fracPart); // e.g. "2.000" → 2000n, "1" → 1000n
  // 约分后:scaled = per_mtok_cents * mul_scaled / 100
  // 这里先乘后除避免小值归零;100 整除失败则说明上游给了极端异常数据,此处
  // 仍然截断到 6 位小数(向下取整是会计上安全的"不高估"方向)。
  const scaled = (perMtokCents * mulScaled) / 100n;
  const whole = scaled / 1_000_000n;
  const rem = scaled % 1_000_000n;
  const fracStr = rem.toString().padStart(6, "0");
  return `${whole}.${fracStr}`;
}

/**
 * 定价缓存 + NOTIFY 监听。单实例使用;测试可 new 多个并用 connectionString override。
 */
export class PricingCache {
  private map: Map<string, ModelPricing> = new Map();
  private listener: Client | null = null;
  private reloadInFlight: Promise<void> | null = null;
  /** 外部可注入 log hook(不注入时落 stderr)。 */
  onError: (err: unknown) => void = (e) => {
    // eslint-disable-next-line no-console
    console.error("[commercial/pricing]", e);
  };
  onReload: (count: number) => void = () => {};

  /** 一次性加载全表。成功后替换内部 map。 */
  async load(): Promise<void> {
    const r = await query<RawRow>(
      `SELECT model_id, display_name,
              input_per_mtok::text       AS input_per_mtok,
              output_per_mtok::text      AS output_per_mtok,
              cache_read_per_mtok::text  AS cache_read_per_mtok,
              cache_write_per_mtok::text AS cache_write_per_mtok,
              multiplier::text           AS multiplier,
              enabled, sort_order, updated_at
         FROM model_pricing`,
    );
    const next = new Map<string, ModelPricing>();
    for (const row of r.rows) next.set(row.model_id, rowToPricing(row));
    this.map = next;
    this.onReload(next.size);
  }

  /** 合并重复触发:已有 load 在跑就等它。失败不冒泡到调用方,只 onError。 */
  private scheduleReload(): void {
    if (this.reloadInFlight) return;
    this.reloadInFlight = this.load()
      .catch((err) => {
        this.onError(err);
      })
      .finally(() => {
        this.reloadInFlight = null;
      });
  }

  /**
   * 开始监听 pricing_changed 通知。
   *
   * @param connectionString 可选,默认 loadConfig().DATABASE_URL
   */
  async startListener(connectionString?: string): Promise<void> {
    if (this.listener) return; // 幂等
    const cs = connectionString ?? loadConfig().DATABASE_URL;
    const c = new Client({ connectionString: cs, application_name: "openclaude-commercial-pricing" });
    c.on("notification", (msg) => {
      if (msg.channel === "pricing_changed") this.scheduleReload();
    });
    c.on("error", (err) => this.onError(err));
    await c.connect();
    await c.query("LISTEN pricing_changed");
    this.listener = c;
  }

  async stopListener(): Promise<void> {
    if (!this.listener) return;
    const c = this.listener;
    this.listener = null;
    try {
      await c.end();
    } catch {
      /* ignore */
    }
  }

  /** 关闭 listener + 丢弃缓存。shutdown 路径幂等。 */
  async shutdown(): Promise<void> {
    await this.stopListener();
    this.map = new Map();
  }

  /** 热路径查询:O(1),不做 I/O。 */
  get(modelId: string): ModelPricing | null {
    return this.map.get(modelId) ?? null;
  }

  /** 测试用:直接注入 pricing(跳过 DB)。 */
  _setForTests(list: ModelPricing[]): void {
    this.map = new Map(list.map((p) => [p.model_id, p]));
  }

  /** 当前缓存大小,便于观察重载。 */
  size(): number {
    return this.map.size;
  }

  /**
   * 列出启用模型(按 sort_order 升序),用于 `/api/public/models`。
   * 返回已经算好"每 ktok 积分数"的公共视图,调用方 JSON.stringify 即可。
   */
  listPublic(): PublicModel[] {
    return [...this.map.values()]
      .filter((p) => p.enabled)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((p) => ({
        id: p.model_id,
        display_name: p.display_name,
        input_per_ktok_credits: perKtokCredits(p.input_per_mtok, p.multiplier),
        output_per_ktok_credits: perKtokCredits(p.output_per_mtok, p.multiplier),
        cache_read_per_ktok_credits: perKtokCredits(p.cache_read_per_mtok, p.multiplier),
        cache_write_per_ktok_credits: perKtokCredits(p.cache_write_per_mtok, p.multiplier),
        multiplier: p.multiplier,
      }));
  }
}
