/**
 * V3 envv2 Phase 2(2026-05-21)— CC sysprompt prefix 模板缓存 + LISTEN/NOTIFY 重载。
 *
 * 见 docs/V3_CC_EXTERNAL_ENDPOINT_ENVV2_PLAN_2026-05-21.md §Phase 2。
 *
 * 与 `billing/pricing.ts:PricingCache` 同型(2026-05-21 Codex plan review:
 * 用 LISTEN/NOTIFY 替代原 plan 30s TTL,避免在 commercial 引入第二套并行 cache
 * 机制 — CLAUDE.md "consistency with existing abstractions")。本类 95% 行为是
 * PricingCache 的复刻,差异:
 *   1. 表只 3 行,Map<Variant, string>(只缓存 active text);
 *   2. **同步 get()** 返回 string | null —— null 在调用方等同于 cache 未 ready,
 *      由调用方决定是否 throw / fallback;
 *   3. admin PUT 后建议本进程显式 `await load()` 一次(read-your-write),
 *      不依赖 LISTEN/NOTIFY 异步窗口;其它进程靠 NOTIFY 收敛。
 *
 * 不抽公共 Base:与 PricingCache 字段类型 + 反向钩子有差异,**三行重复 < 过早抽象**
 * (CLAUDE.md "Three similar lines is better than a premature abstraction")。
 */

import { Client } from "pg";
import { query } from "../db/queries.js";
import { loadConfig } from "../config.js";

/**
 * Variant 枚举,与 SQL CHECK(0071)和 externalEnvelope.ts 三个 prefix 的逻辑顺序对齐:
 *   default = 0
 *   agent_sdk_claude_code_preset = 1
 *   agent_sdk = 2
 *
 * 新增 variant 需同步:
 *   1. 0071 migration 的 CHECK 约束(扩枚举值)
 *   2. 本文件 PrefixVariant union
 *   3. externalEnvelope.ts:detectCcPrefix 数组顺序
 *   4. Phase 0 baseline tests(ccExternalEndpoint.integ.test.ts)
 */
export type PrefixVariant =
  | "default"
  | "agent_sdk_claude_code_preset"
  | "agent_sdk";

export const PREFIX_VARIANTS: readonly PrefixVariant[] = [
  "default",
  "agent_sdk_claude_code_preset",
  "agent_sdk",
];

interface RawRow {
  variant: PrefixVariant;
  text: string;
}

/**
 * 模板缓存。bootstrap 在 commercial main 启动时 `await load()` 一次,然后异步
 * `startListener()`;运行时只读 `get()`,O(1) Map 查询无 I/O。
 *
 * 失败模式:
 *   - bootstrap `load()` 抛错:由 caller 决定 fail-fast 启动失败(prefix 是外接
 *     envelope 路径的硬依赖)。当前 caller(index.ts)选择 fail-fast。
 *   - 运行时 NOTIFY 重 load 失败:**保留旧缓存** + onError,不清空(与 PricingCache
 *     同型,避免热路径瞬间全部 cache-miss)。
 *   - listener 连接断:onError 报 + listener=null;下次 startListener 调用幂等重连。
 *     不在本类内部做自动重连定时器(交给上层观测处理,避免悄悄掩盖问题)。
 */
export class PrefixTemplateCache {
  private map: Map<PrefixVariant, string> = new Map();
  private listener: Client | null = null;
  private reloadInFlight: Promise<void> | null = null;

  onError: (err: unknown) => void = (e) => {
    // eslint-disable-next-line no-console
    console.error("[commercial/prefixTemplateCache]", e);
  };
  onReload: (count: number) => void = () => {};

  /**
   * 一次性加载全表 active 行。成功后替换内部 map。
   * 启动期 caller 决定捕获 / 冒泡。
   *
   * **完整性校验**(Codex Phase 2 code review FAIL 采纳):验证 PREFIX_VARIANTS 全部
   * active 存在 — 缺一行直接 throw。理由:本 cache 是 fail-fast 设计,DB 误删 / 误
   * deactivate 让启动健康检查能直接红,而不是 normalizeExternalApiKeyEnvelope 在请求
   * 路径上 500。`missing.join(',')` 写进 error message,事故定位用。
   */
  async load(): Promise<void> {
    const r = await query<RawRow>(
      `SELECT variant, text
         FROM envelope_prefix_templates
        WHERE active = TRUE`,
    );
    const next = new Map<PrefixVariant, string>();
    for (const row of r.rows) next.set(row.variant, row.text);
    const missing = PREFIX_VARIANTS.filter((v) => !next.has(v));
    if (missing.length > 0) {
      throw new Error(
        `envelope_prefix_templates missing active variants: ${missing.join(", ")}`,
      );
    }
    this.map = next;
    this.onReload(next.size);
  }

  /**
   * 合并重复触发 + dirty bit:已有 load 在跑就标 pending,跑完再补一次 — 否则会丢
   * "load SELECT 之后才 commit 的 UPDATE" 对应的那条 NOTIFY(Codex Phase 2 code review
   * FAIL #2 采纳)。本进程内 admin PUT 还有 await reloadPrefixTemplateCache() 做 read-
   * your-write 兜底,但其它进程纯靠 NOTIFY,会中招。失败不冒泡,只 onError。
   */
  private reloadPending = false;
  private scheduleReload(): void {
    if (this.reloadInFlight) {
      this.reloadPending = true;
      return;
    }
    this.reloadInFlight = this.load()
      .catch((err) => {
        this.onError(err);
      })
      .finally(() => {
        this.reloadInFlight = null;
        if (this.reloadPending) {
          this.reloadPending = false;
          this.scheduleReload();
        }
      });
  }

  /**
   * 开始监听 envelope_prefix_templates_changed 通知(0071 migration 的 trigger 发出)。
   *
   * @param connectionString 可选,默认 loadConfig().DATABASE_URL
   */
  async startListener(connectionString?: string): Promise<void> {
    if (this.listener) return;
    const cs = connectionString ?? loadConfig().DATABASE_URL;
    const c = new Client({
      connectionString: cs,
      application_name: "openclaude-commercial-prefix-templates",
    });
    c.on("notification", (msg) => {
      if (msg.channel === "envelope_prefix_templates_changed") {
        this.scheduleReload();
      }
    });
    c.on("error", (err) => {
      this.onError(err);
      // listener 断了,标记 null 让下次 startListener 重连
      this.listener = null;
    });
    await c.connect();
    await c.query("LISTEN envelope_prefix_templates_changed");
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

  async shutdown(): Promise<void> {
    await this.stopListener();
    this.map = new Map();
  }

  /**
   * 热路径同步查询。返回当前 active text。
   * - 命中 → string
   * - 缺失(cache 未 ready / DB 该 variant 行被误删)→ null
   *
   * 调用方(externalEnvelope.ts)对 null 的处理是 throw EnvelopePrefixCacheNotReadyError,
   * fail-closed,不 fallback 到 in-code 硬编码(CLAUDE.md 单一权威源)。
   */
  get(variant: PrefixVariant): string | null {
    return this.map.get(variant) ?? null;
  }

  /**
   * 调试 / test 用 — 暴露内部 Map 大小,生产代码不应依赖。
   */
  size(): number {
    return this.map.size;
  }
}

/**
 * 进程级 singleton。`startPrefixTemplateCache()` 在 commercial bootstrap(index.ts)
 * 调用,handler 路径只 import `getPrefixTemplateCache()` 读 singleton。
 *
 * test 注入:在 unit / integ 测试里直接 new PrefixTemplateCache() 并通过
 * normalizeExternalApiKeyEnvelope 的第三参 `prefixSource` 注入,避免动 singleton
 * 状态导致测试间泄漏。
 */
let cacheSingleton: PrefixTemplateCache | null = null;

/**
 * Bootstrap helper:new cache + load + startListener。失败由 caller 决定 fail-fast。
 *
 * **不**自动重试:启动期 DB 不通的根因应该被部署系统的 health check 看见,内部
 * sleep+retry 会延长 outage 信号。
 */
export async function startPrefixTemplateCache(
  connectionString?: string,
): Promise<PrefixTemplateCache> {
  const c = new PrefixTemplateCache();
  await c.load(); // 启动期失败冒泡(caller fail-fast)
  await c.startListener(connectionString); // listener 失败 caller 自行权衡
  cacheSingleton = c;
  return c;
}

/**
 * Production hot path 读 singleton。在 bootstrap 前调用返回 null —— handler 域
 * 不应该走到这条路径(commercial 启动后 prefix cache 必已 ready,否则 main 已抛)。
 */
export function getPrefixTemplateCache(): PrefixTemplateCache | null {
  return cacheSingleton;
}

/**
 * 仅 admin handler 用:在 PUT 后本进程 read-your-write reload(Codex Phase 2 plan
 * review 采纳)。其它进程靠 NOTIFY 收敛。
 *
 * cache 未 bootstrap(singleton=null)→ noop(测试环境不 boot singleton 的常见场景)。
 */
export async function reloadPrefixTemplateCache(): Promise<void> {
  if (!cacheSingleton) return;
  await cacheSingleton.load();
}

/**
 * 仅测试 / shutdown 用 — 清掉 singleton 引用。
 */
export function _resetPrefixTemplateCacheForTesting(): void {
  cacheSingleton = null;
}
