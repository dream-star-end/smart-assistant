/**
 * V3 CC 外接 plan Phase 2 — ApiKeyIdentityStrategy。
 *
 * 见 docs/V3_CC_EXTERNAL_ENDPOINT_PLAN_2026-05-18.md §3.2.3 / §4 / §7。
 *
 * 这是 `IdentityStrategy` 的第二个实现(容器 strategy 之外):
 *   - resolve:解析 Bearer `oc-cc.<prefix>.<secret>` → repo.findByPrefix
 *     → timing-safe hash 比对 → bump last_used_at(5min in-process 节流)
 *     → 返 `{ uid, containerId: null }`
 *   - authorize:**直接复用** `authorizeProxyIdentity`,确保两 strategy 的
 *     模型授权语义不分裂(plan §3.2.3 / Phase 2 Codex 反馈)
 *
 * 不变量(plan §4):
 *   #2 撤销立即生效  — repo.findByPrefix 过滤 revoked → strategy 见 null 直接抛
 *   #4 timing-safe   — crypto.timingSafeEqual,不用 === / Buffer.compare
 *   #6 不调 recordHostRequest — 本 strategy 根本不持该 dep(Phase 3 wiring 锁)
 *   #7(first half)invalid/revoked → IdentityError,不引入任何账务副作用
 *      (副作用 spy 在 Phase 3 integ test 锁)
 *
 * 错误码体系(三个 server-side code,handler 统一映射 401):
 *   MISSING_API_KEY     — 无 Authorization 头 / 空 token
 *   BAD_API_KEY_FORMAT  — 头存在但不匹配 `oc-cc.<8 base36>.<48 hex>`
 *   API_KEY_INVALID     — 格式 OK 但 prefix 不存在 / 已撤销 / secret 错
 *                         三种情况合并成单一错误码,防 enumeration attack
 *                         (攻击者无法靠错误码区分 "prefix 是否存在")。
 *                         子因写进 `IdentityError.message`(handler 当前只记
 *                         errcode,不外泄 message);如未来 ops 需要看 prefix,
 *                         由 handler 决定是否记录,本 strategy 不擅自扩大契约。
 */

import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

import {
  IdentityError,
  type IdentityStrategy,
  type ProxyIdentity,
  authorizeProxyIdentity,
} from "./proxyIdentity.js";
import { type ApiKeyRepo, hashApiKeySecret } from "./apiKeyRepo.js";
import type { PricingCache } from "../billing/pricing.js";
import type { Logger } from "../logging/logger.js";

/** 5 分钟。SSE 长连接 + 频繁 /v1/messages 高峰下,这是 last_used_at 节流窗口。 */
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

/** Per-key LRU 上限。单进程上限 1k key 内存占用 ~80KB,远小于 OOM 阈值。 */
const TOUCH_LRU_CAP = 1000;

export interface ApiKeyIdentityStrategyDeps {
  /** user_api_keys 存取(见 auth/apiKeyRepo.ts) */
  repo: ApiKeyRepo;
  /** 价格表 — 共享 authz 用 */
  pricing: PricingCache;
  /** 服务端权威源 role + grants */
  loadUserModelAuthz: (
    uid: bigint,
  ) => Promise<{
    role: "user" | "admin";
    grantedModelIds: ReadonlySet<string>;
  }>;
  /**
   * `touchLastUsed` 失败时的 best-effort 日志。
   * Production 注入 strategy 装配处 logger;测试可注入 spy / no-op。
   * `Pick<Logger, "warn">` —— 我们只需要 warn,贴仓内 Logger 风格(Phase 2 Codex NIT 采纳)。
   */
  logger?: Pick<Logger, "warn">;
  /**
   * **测试 seam**:覆写当前时间戳源,用于验证 5min 节流逻辑而不真睡 5 分钟。
   * Production 不传,默认 `() => Date.now()`。
   */
  now?: () => number;
}

/**
 * 解析 `oc-cc.<prefix>.<secret>` token。
 *
 * 严格语法:
 *   - 可选 `Bearer ` 前缀(strategy 不强制 header parser 帮忙剥)
 *   - `oc-cc.` 常量
 *   - prefix = 8 字符 lowercase base36 `[0-9a-z]{8}`
 *   - secret = 48 hex 字符(24 字节 raw,熵 192-bit)
 *
 * **不**抽共用 helper 与容器 `parseContainerToken` 合并 — 它们只是形态相似,
 * regex / 错误码 / 返回 shape 全不同,抽出来会过早抽象(Codex Phase 2 PASS)。
 */
function parseApiKeyToken(raw: string | undefined): {
  keyPrefix: string;
  secretHex: string;
} {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new IdentityError("MISSING_API_KEY", "missing bearer token");
  }
  const trimmed = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  // 有头但 token 为空("Bearer " 或纯空白)语义上仍是 missing,不是格式错误。
  // 跟开头的 raw.length === 0 三分法一致(Codex Phase 2 code-review MINOR 采纳)。
  if (trimmed.length === 0) {
    throw new IdentityError("MISSING_API_KEY", "missing bearer token");
  }
  const m = /^oc-cc\.([0-9a-z]{8})\.([0-9a-f]{48})$/.exec(trimmed);
  if (!m) {
    throw new IdentityError(
      "BAD_API_KEY_FORMAT",
      "token does not match oc-cc.<prefix>.<secret>",
    );
  }
  return { keyPrefix: m[1]!, secretHex: m[2]! };
}

/**
 * `makeApiKeyIdentityStrategy` factory。
 *
 * 行为契约:
 *   - resolve 失败 → throw `IdentityError`(handler 401)
 *   - resolve 成功 → 返 `{ uid, containerId: null }` + fire-and-forget bump last_used_at
 *   - authorize → 走 `authorizeProxyIdentity`,跟 container strategy 行为完全一致
 *
 * **LRU 节流缓存放在 closure scope**(Phase 2 Codex MINOR 采纳):
 *   - production 仅一个 strategy 实例,行为不变
 *   - 测试天然隔离(每次 makeApiKeyIdentityStrategy 拿全新 Map),无需 reset 后门
 *   - now seam 在 deps 里,跟 cache 配对清晰
 */
export function makeApiKeyIdentityStrategy(
  deps: ApiKeyIdentityStrategyDeps,
): IdentityStrategy {
  const nowFn = deps.now ?? (() => Date.now());
  /** keyId → 上次写 DB 的时间戳(ms)。Map 插入序即 LRU 序。 */
  const lastTouchedAt = new Map<bigint, number>();

  /** 5min 节流 + LRU evict + fire-and-forget bump last_used_at。 */
  function bumpLastUsedThrottled(keyId: bigint): void {
    const now = nowFn();
    const last = lastTouchedAt.get(keyId);
    if (last !== undefined && now - last < TOUCH_THROTTLE_MS) return;

    // 先 delete 再 set:把 keyId 移到 Map 尾部(LRU "most recent")。
    // 注意:即使 touchLastUsed 失败,我们也写入 throttle cache —— DB 抖动时
    // 继续压写比 5min 内狂重试更符合 best-effort 字段定位(Codex Phase 2 NIT)。
    lastTouchedAt.delete(keyId);
    lastTouchedAt.set(keyId, now);

    if (lastTouchedAt.size > TOUCH_LRU_CAP) {
      // Map.keys().next().value = 最旧 keyId(最早插入的,迭代序保证)
      const oldest = lastTouchedAt.keys().next().value as bigint | undefined;
      if (oldest !== undefined) lastTouchedAt.delete(oldest);
    }

    deps.repo.touchLastUsed(keyId).catch((err) => {
      deps.logger?.warn("api_key_touch_last_used_failed", {
        keyId: keyId.toString(),
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    async resolve(
      req: IncomingMessage,
      _ctx: { hostUuid: string; boundIp: string },
    ): Promise<ProxyIdentity> {
      const { keyPrefix, secretHex } = parseApiKeyToken(req.headers.authorization);

      const row = await deps.repo.findByPrefix(keyPrefix);
      if (!row) {
        // findByPrefix 已经过滤 revoked_at IS NULL(Phase 1 unit lock),
        // null = "prefix 不存在" OR "已撤销" — 合并成同一错误码防 enumeration。
        throw new IdentityError(
          "API_KEY_INVALID",
          `unknown or revoked api key prefix=${keyPrefix}`,
        );
      }

      const candidate = hashApiKeySecret(secretHex);
      // 显式长度判 + 短路:`timingSafeEqual` 长度不一致会抛 RangeError。
      // 两侧理论上永远 = 32 字节(SHA-256 输出),长度判是 belt-and-suspenders。
      if (
        candidate.length !== row.keyHash.length ||
        !timingSafeEqual(candidate, row.keyHash)
      ) {
        throw new IdentityError(
          "API_KEY_INVALID",
          `secret mismatch for prefix=${keyPrefix}`,
        );
      }

      // Bump last_used_at,fire-and-forget + 5min 节流。
      bumpLastUsedThrottled(row.id);

      // 关键:`containerId: null` — 这是 Phase 0 类型放宽的实际消费点。
      // ApiKey 路径没有容器维度,journal.container_id 写 SQL NULL,
      // settle 路径(usage_records / credit_ledger)只按 uid 计费,与容器路径同型。
      return { uid: row.userId, containerId: null };
    },

    async authorize(identity, _pricing, model) {
      // 共享 authz 业务规则(plan §3.2.3 + Phase 2 Codex):任何 strategy
      // 走同一份 loadUserModelAuthz + canUseModel,authz 不允许分裂。
      await authorizeProxyIdentity(
        { pricing: deps.pricing, loadUserModelAuthz: deps.loadUserModelAuthz },
        identity,
        model,
      );
    },
  };
}
