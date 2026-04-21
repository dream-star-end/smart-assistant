/**
 * V3 Phase 2 Task 2D — central anthropic proxy(monolith MVP)。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §3 / §3.3 / §7 / 03-MVP-CHECKLIST.md Task 2D。
 *
 * 拓扑(MVP):
 *   容器内 OpenClaude → POST http://172.30.0.1:18791/v1/messages →(本进程)
 *   anthropicProxy → 上游 https://api.anthropic.com/v1/messages
 *
 * MVP 跳过(P1 再做):
 *   - split 拓扑 / edge sidecar 子进程 / WG 跨 host
 *   - HMAC 加签(monolith 同进程函数调用,无需端间签名)
 *   - host_state_version / pending_apply / 双 ACK barrier(单 host 不需要)
 *   - reconciler 重扫(R4):MVP 漏 finalizer = 漏单,接受;Phase 5 再加
 *   - R5b CAS release / scheduler health 双扣保护:MVP scheduler.release 内存幂等够用
 *
 * 强制不变量(R3 文档总结):
 *   1. zod **strict** body schema:unknown 字段直接 400,杜绝塞参数
 *   2. 字段字节预算:messages/system/tools 单字段 byteLength 上限,防超大 input 烧 token
 *   3. 双侧 cost 估算:preCheck = estimated_input_cost + max_output_cost(按 model.output 单价做最坏估)
 *   4. header allowlist:仅放过 anthropic-version + 白名单 anthropic-beta + content-type/accept
 *   5. per-uid rate-limit + concurrency cap(in-process Map);超限 → 429
 *   6. 容器身份双因子(2C verifyContainerIdentity)— 任一失败 401
 *   7. **single-shot finalizer**:journal 一行 (request_id PK),inflight→finalizing→committed/aborted
 *      release 与 settle 都只发生一次,即使被中途 abort 也只在 finally 里跑一次
 *   8. 双向 abort:req.close / res.close → ac.abort() → upstream fetch reject → 进 finalize.fail
 *   9. usage capture failure 不阻塞 stream,**先发完字节再处理 finalize**
 *  10. preCheck 释放兜底:Redis TTL=300s,即使 finalize 漏调也自动清
 *
 * 不在本文件:
 *   - 容器调度 / supervisor.ensureRunning(2H gateway 接 + Phase 3 实现)
 *   - 用户 WS ↔ 容器 WS 桥(2E userChatBridge)
 *   - reconciler 重扫 stuck inflight/finalizing(Phase 5 5x)
 *   - 7d cron GC committed/aborted journal(Phase 5)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";

import { rootLogger, type Logger } from "../logging/logger.js";
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  setSecurityHeaders,
} from "./util.js";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import type { PricingCache, ModelPricing } from "../billing/pricing.js";
import {
  preCheckWithCost,
  releasePreCheck,
  InsufficientCreditsError,
  type PreCheckRedis,
  type ReservationHandle,
} from "../billing/preCheck.js";
import { computeCost, type TokenUsage } from "../billing/calculator.js";
import {
  AccountPoolUnavailableError,
  type AccountScheduler,
} from "../account-pool/scheduler.js";
import {
  checkRateLimit,
  type RateLimitConfig,
  type RateLimitRedis,
} from "../middleware/rateLimit.js";
import {
  shouldRefresh,
  refreshAccountToken,
  RefreshError,
  DEFAULT_REFRESH_SKEW_MS,
  type RefreshDeps,
} from "../account-pool/refresh.js";
import { getDispatcherForAccount } from "../account-pool/egressDispatcher.js";
import {
  observeAnthropicProxyTtft,
  observeAnthropicProxyStreamDuration,
  incrAnthropicProxySettle,
  incrAnthropicProxyReject,
  incrBillingDebit,
  type ProxyRejectReason,
} from "../admin/metrics.js";

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** 上游 endpoint。可被 deps 覆盖(测试)。 */
export const DEFAULT_UPSTREAM_ENDPOINT = "https://api.anthropic.com/v1/messages";

/** anthropic-version 唯一允许值。OAuth 管理账号路径与 v2 / 个人版一致。 */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * 允许的 anthropic-beta 值集合(逗号分隔的每个 token 都必须在这里)。
 *
 * 来源:
 *   - oauth-2025-04-20 — OAuth-managed account 必带(对齐个人版 src/utils/http.ts)
 *   - claude-code-20250219 — 工具使用 / 思考模式 / Claude Code 特性
 *
 * 后续运营加新 beta:在这里加常量;MVP 不做 DB 配置项(改一行重启即可)。
 */
export const ALLOWED_BETA_VALUES: ReadonlySet<string> = new Set([
  "oauth-2025-04-20",
  "claude-code-20250219",
  "computer-use-2024-10-22",
  "files-api-2025-04-14",
  "interleaved-thinking-2025-05-14",
  "context-1m-2025-08-07",
  "fine-grained-tool-streaming-2025-05-14",
  "prompt-caching-2024-07-31",
  // 2026-04-21 上线:ccb v2.1.888+ 默认带这一组 beta,见个人版
  // src/constants/betas.ts。一次加全,免得一个一个 ANTHROPIC_BETA_NOT_ALLOWED 反复。
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "web-search-2025-03-05",
  "advanced-tool-use-2025-11-20",
  "tool-search-tool-2025-10-19",
  "effort-2025-11-24",
  "task-budgets-2026-03-13",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
  "afk-mode-2026-01-31",
  "advisor-tool-2026-03-01",
  // ccb 桥接/teleport 路径用的 ccr-byoc / triggers / mcp-servers / environments
  "ccr-byoc-2025-07-29",
  "ccr-triggers-2026-01-30",
  "environments-2025-11-01",
  "mcp-servers-2025-12-04",
]);

/** body 字段字节预算(R3)。Buffer.byteLength(JSON.stringify(field), 'utf8') 口径。
 *
 * 2026-04-21 调整:原值(messages 256K / system 32K / tools 64K / 总 512K)是按
 * 极简对话场景设的,boss 接 ccb 后立刻撞 system 32K 上限 — 个人版 ccb 的 system prompt
 * 含 persona + identity + platform-capabilities + skills 索引 + memory 索引,光骨架就
 * 50-200 KB,加上 13+ MCP 工具描述总轻松破 200 KB。提到 commercial v3 真实需求量级:
 *   - system: 2 MB(留够工具描述 + skills 元数据 + 多 MCP server 拼接)
 *   - tools: 2 MB(同上,tool schema 大量 JSON 描述)
 *   - messages: 8 MB(长会话 + 嵌入图片 base64;低于 anthropic 的 ~32 MB 上限)
 *   - 总 body: 16 MB
 *   还是远低于 anthropic 自己的 ~32 MB 限制,但够用并防 DoS。
 */
export const SIZE_LIMITS = {
  messages: 8 * 1024 * 1024,
  system: 2 * 1024 * 1024,
  tools: 2 * 1024 * 1024,
} as const;

/** 总 body 上限(JSON 全文 byteLength)。超过 → 413。 */
export const MAX_BODY_BYTES_DEFAULT = 16 * 1024 * 1024;

/** messages / tools 数量上限(对齐 R3 §3.3 注解)。 */
export const MAX_MESSAGES_COUNT = 200;
export const MAX_TOOLS_COUNT = 64;

/** 估算 input token 时的字符 → token 经验比(保守:chars/4 即 1 token = 4 chars)。 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** 默认 per-uid 限流:60s 30 次。 */
export const DEFAULT_PROXY_RATE_LIMIT: RateLimitConfig = {
  scope: "proxy_uid",
  windowSeconds: 60,
  max: 30,
};

/** 默认 per-uid 并发上限。in-process Map,单 host MVP 足够。 */
export const DEFAULT_MAX_CONCURRENT_PER_UID = 4;

// ─── body schema ──────────────────────────────────────────────────────────

/**
 * Anthropic /v1/messages body 严格白名单。
 *
 * unknown 字段 → 400 BAD_REQUEST。这是 R3 防"塞 max_tokens_to_sample 走老路径"
 * 类绕过的核心机制。
 *
 * messages / tools / system 用 z.unknown() 不深入校验内容(由上游 Anthropic 自己拒,
 * 我们只控大小),否则 schema 维护成本巨大。
 */
export const proxyBodySchema = z
  .object({
    model: z.string().min(1).max(128),
    max_tokens: z.number().int().positive().max(200_000),
    messages: z.array(z.unknown()).min(1).max(MAX_MESSAGES_COUNT),
    system: z.union([z.string(), z.array(z.unknown())]).optional(),
    tools: z.array(z.unknown()).max(MAX_TOOLS_COUNT).optional(),
    tool_choice: z.unknown().optional(),
    stop_sequences: z.array(z.string().max(64)).max(8).optional(),
    metadata: z
      .object({
        user_id: z.string().max(256).optional(),
        session_id: z.string().max(256).optional(),
      })
      .strict()
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().nonnegative().max(500).optional(),
    /** stream 强制为 true(我们只跑流式;非流接口 MVP 不开)。 */
    stream: z.literal(true).optional(),
    /** Claude SDK 会在 system + messages 之外塞 thinking;允许透传 */
    thinking: z.unknown().optional(),
    /**
     * 2026-04 新 beta: claude-code-best (CCB v2.1.888+) 会带 `context_management`
     * (server-side 自动 context 截断)。不透传 → ccb 整轮 400 卡死(boss claudeai.chat
     * 踩雷于 2026-04-21)。我们不解析它的语义,与 thinking 同样按 z.unknown() 透传给
     * 上游 Anthropic 自决,size 走 system/messages/tools 现有预算。
     */
    context_management: z.unknown().optional(),
    /** Anthropic priority/standard tier 提示;透传不解析。 */
    service_tier: z.string().max(64).optional(),
  })
  .strict();

export type ProxyBody = z.infer<typeof proxyBodySchema>;

/**
 * 字段字节预算校验。zod schema 不做大小,这里单独算。
 *
 * 用 Buffer.byteLength(JSON.stringify(...), 'utf8'):base64 image 自然计入,符合 R3 口径。
 * 任意维超限 → throw HttpError(413, "BODY_FIELD_TOO_LARGE", ...)。
 */
export function enforceFieldByteBudgets(body: ProxyBody): void {
  const checks: Array<[keyof typeof SIZE_LIMITS, unknown]> = [
    ["messages", body.messages],
    ["system", body.system],
    ["tools", body.tools],
  ];
  for (const [field, value] of checks) {
    if (value === undefined) continue;
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const limit = SIZE_LIMITS[field];
    if (bytes > limit) {
      throw new HttpError(
        413,
        "BODY_FIELD_TOO_LARGE",
        `field '${field}' size ${bytes} exceeds ${limit} bytes`,
      );
    }
  }
}

/**
 * 估算 input token 数(保守口径,宁可高估)。
 *
 * MVP 不引入完整 tokenizer(`@anthropic-ai/tokenizer` 增加依赖体积),用
 * "JSON.stringify(messages + system + tools).length / 4" 兜底;开 prompt cache
 * 的高级用户最坏只是 preCheck 数字偏大,影响是更早 402,符合"安全方向"。
 *
 * 字符数除以 4 是社区经验值(英文偏低估;中文偏高估,反正都向上对我们安全)。
 */
export function estimateInputTokens(body: ProxyBody): number {
  let chars = 0;
  chars += JSON.stringify(body.messages).length;
  if (body.system !== undefined) chars += JSON.stringify(body.system).length;
  if (body.tools !== undefined) chars += JSON.stringify(body.tools).length;
  if (body.stop_sequences !== undefined) chars += JSON.stringify(body.stop_sequences).length;
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * 双侧 cost 估算(R3):input + output 都按"最差 = output 单价 * tokens"看。
 *
 * 为什么 input 也按 output 单价:
 *   - input 单价通常是 output 的 1/3~1/5;按 output 估永远不会低估
 *   - 实际扣费在 finalizer 里按真 usage 算,这只是 preCheck 上限
 *   - cache_read / cache_write 我们不预扣(它们一定 ≤ input + output 总数,且
 *     在结算时正确扣;MVP 偏保守 OK)
 */
export function estimateMaxCostBothSides(
  inputTokens: number,
  maxOutputTokens: number,
  pricing: ModelPricing,
): bigint {
  const totalTokens = inputTokens + maxOutputTokens;
  const tokens = BigInt(totalTokens);
  const [intPart, fracRaw = ""] = pricing.multiplier.split(".");
  const frac = fracRaw.padEnd(3, "0").slice(0, 3);
  const mulScaled = BigInt(intPart + frac); // "2.000" → 2000n
  // 同 estimateMaxCost 公式:tokens * output_per_mtok * mul / (10^6 * 10^3)
  const num = tokens * pricing.output_per_mtok * mulScaled;
  const den = 1_000_000_000n;
  return (num + den - 1n) / den;
}

// ─── header allowlist ─────────────────────────────────────────────────────

/**
 * 构造发给上游的 header。
 *
 * 显式 allowlist 而非 strip blacklist —— blacklist 总会漏掉新 header。
 * Authorization 由调用方加(用 account.token);本函数不接触 token。
 */
export function buildSafeUpstreamHeaders(
  reqHeaders: IncomingMessage["headers"],
): Record<string, string> {
  const out: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  // 客户端可声明 anthropic-version,但只允许等于我们支持的常量
  const cv = reqHeaders["anthropic-version"];
  if (typeof cv === "string" && cv !== ANTHROPIC_VERSION) {
    throw new HttpError(
      400,
      "ANTHROPIC_VERSION_NOT_ALLOWED",
      `anthropic-version must be ${ANTHROPIC_VERSION} (got ${cv})`,
    );
  }
  // anthropic-beta:逗号分隔,每个 token 都必须在 ALLOWED_BETA_VALUES 里
  const beta = reqHeaders["anthropic-beta"];
  if (typeof beta === "string" && beta.length > 0) {
    const tokens = beta.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    for (const t of tokens) {
      if (!ALLOWED_BETA_VALUES.has(t)) {
        throw new HttpError(
          400,
          "ANTHROPIC_BETA_NOT_ALLOWED",
          `anthropic-beta '${t}' is not in allowlist`,
        );
      }
    }
    out["anthropic-beta"] = tokens.join(",");
  }
  return out;
}

// ─── 进程内 per-uid concurrency / rate-limit 状态 ──────────────────────────

/**
 * In-process per-uid concurrent slot 计数。
 *
 * MVP 单 host:同一用户的请求都在同一进程;Map 足以做硬上限。
 * P1 多 host 时改 Redis SETNX EX 1s + heartbeat refresh。
 */
export class ConcurrencyLimiter {
  private inflight = new Map<string, number>();
  constructor(readonly maxPerKey: number) {
    if (maxPerKey <= 0) throw new TypeError(`maxPerKey must be > 0`);
  }
  /** 抢占;成功返释放函数(用 try/finally)。失败返 null。 */
  acquire(key: string): (() => void) | null {
    const cur = this.inflight.get(key) ?? 0;
    if (cur >= this.maxPerKey) return null;
    this.inflight.set(key, cur + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = this.inflight.get(key) ?? 0;
      if (n <= 1) this.inflight.delete(key);
      else this.inflight.set(key, n - 1);
    };
  }
  /** 测试观察用 */
  count(key: string): number {
    return this.inflight.get(key) ?? 0;
  }
}

/**
 * 2026-04-21 安全审计 HIGH#3 修复 — 进程内兜底限流器。
 *
 * 原设计:Redis 限流抖动 / 断连时一律 fail-open,记一行 error log 就放行。
 * 风险:Redis 真出问题(集群分区 / OOM / 持续超时)时 proxy 变成无限流
 * 开放中转,盗用 token 的攻击者可无约束打下游 Anthropic,秒级烧钱 + 触发
 * 上游 429 连坐封我们整个 account pool。
 *
 * 修复:当 Redis 失败时,退到一个进程内固定窗口计数器。Cap 选 Redis cap
 * 的 ~1/3(更严格),目的是"可用性降级而非开闸":正常用户可能体感慢,但
 * 异常放大必然被拦住。窗口长度保持与 Redis 一致以便行为连续。
 *
 * 简化口径:
 *   - 每 `windowSeconds` 固定窗口,无滑动;和 Redis 侧算法同构
 *   - Map 定期 GC(每 60s 扫一遍丢过期窗口条目,防止过万 uid 时长期驻留)
 *   - maxPerKey < 1 会拒绝构造(避免 0 等于无条件 block)
 */
export class FallbackRateLimiter {
  private entries = new Map<string, { windowStart: number; count: number }>();
  private lastGc = 0;
  constructor(
    readonly windowSeconds: number,
    readonly maxPerKey: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    if (windowSeconds <= 0) throw new TypeError("windowSeconds must be > 0");
    if (maxPerKey <= 0) throw new TypeError("maxPerKey must be > 0");
  }
  /** true = 放行,false = 拒绝。 */
  tryAcquire(key: string): boolean {
    const nowSec = this.now();
    const windowStart = Math.floor(nowSec / this.windowSeconds) * this.windowSeconds;
    // Cheap GC:每 60s 扫一次,丢掉 windowStart 已过 2 个窗口的 entry
    if (nowSec - this.lastGc >= 60) {
      this.lastGc = nowSec;
      const cutoff = windowStart - this.windowSeconds;
      for (const [k, v] of this.entries) {
        if (v.windowStart < cutoff) this.entries.delete(k);
      }
    }
    const e = this.entries.get(key);
    if (!e || e.windowStart !== windowStart) {
      this.entries.set(key, { windowStart, count: 1 });
      return true;
    }
    if (e.count >= this.maxPerKey) return false;
    e.count += 1;
    return true;
  }
  /** 测试观察用 */
  count(key: string): number {
    return this.entries.get(key)?.count ?? 0;
  }
}

// ─── usage capture(SSE 透传 + 旁路解析) ──────────────────────────────────

/**
 * 解析过程中观察到的 usage。MVP 只关心终态(message_delta 携带的最新 usage)。
 *   - kind="final": 看到 message_stop / message_delta with stop_reason → usage 是最终值
 *   - kind="partial": 收到 message_start / 中间 message_delta → usage 是部分值(input known,
 *                     output 是已发字符)。流被 abort 时用这个值结算,代价只算客户已收到的 token。
 *   - kind="none": 整条流未见任何 usage(网络死/最早就 4xx)。结算 cost=0,但仍记一笔 status=error
 */
export type UsageObservation =
  | { kind: "none" }
  | { kind: "partial"; usage: TokenUsage }
  | { kind: "final"; usage: TokenUsage };

/** SSE 事件:`raw` 是去掉首部 `data: ` 的字符串。 */
interface SseEvent {
  event: string;
  data: string;
}

/**
 * 一个轻量 SSE 解析器,只为提取 usage,不拦截/不修改字节流。
 *
 * 不要用它做"完美 SSE 解析";它会跟字节透传并行跑,失败也不回退到字节传输。
 */
class UsageObserver {
  private buf = "";
  private latest: UsageObservation = { kind: "none" };

  /** 把 chunk 送进来(同时已经 byte-pass 给客户端)。 */
  push(chunkText: string): void {
    this.buf += chunkText;
    while (true) {
      const idx = this.findEventBoundary();
      if (idx === null) break;
      const raw = this.buf.slice(0, idx.end);
      this.buf = this.buf.slice(idx.end + idx.sepLen);
      const ev = parseSseEvent(raw);
      if (ev) this.handleEvent(ev);
    }
    // 缓存上限:超 256KB 直接丢弃旧的(usage 字段总是在新事件里)
    if (this.buf.length > 256 * 1024) {
      this.buf = this.buf.slice(this.buf.length - 64 * 1024);
    }
  }

  /** 流 EOF 后调一下,如果最后还有非空残片也尝试解析。 */
  flush(): void {
    if (this.buf.length > 0) {
      const ev = parseSseEvent(this.buf);
      if (ev) this.handleEvent(ev);
      this.buf = "";
    }
  }

  result(): UsageObservation {
    return this.latest;
  }

  private findEventBoundary(): { end: number; sepLen: number } | null {
    const a = this.buf.indexOf("\n\n");
    const b = this.buf.indexOf("\r\n\r\n");
    if (a === -1 && b === -1) return null;
    if (a === -1) return { end: b, sepLen: 4 };
    if (b === -1) return { end: a, sepLen: 2 };
    return a < b ? { end: a, sepLen: 2 } : { end: b, sepLen: 4 };
  }

  private handleEvent(ev: SseEvent): void {
    if (ev.event !== "message_start" && ev.event !== "message_delta") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      return;
    }
    // message_start: { type, message: { ..., usage: {...}}}
    // message_delta: { type, delta:{...}, usage: {...}}
    const usage =
      ev.event === "message_start"
        ? extractUsageFromMessageStart(parsed)
        : extractUsageFromMessageDelta(parsed);
    if (!usage) return;
    // message_delta 携 stop_reason 时视为 final
    const isFinal =
      ev.event === "message_delta" && hasStopReason(parsed);
    this.latest = { kind: isFinal ? "final" : "partial", usage };
  }
}

function parseSseEvent(raw: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function readNonNegInt(v: unknown): bigint {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return BigInt(Math.floor(v));
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}

function extractUsageFromMessageStart(parsed: unknown): TokenUsage | null {
  if (!isObj(parsed)) return null;
  const msg = parsed.message;
  if (!isObj(msg)) return null;
  const u = msg.usage;
  if (!isObj(u)) return null;
  return {
    input_tokens: readNonNegInt(u.input_tokens),
    output_tokens: readNonNegInt(u.output_tokens),
    cache_read_tokens: readNonNegInt(u.cache_read_input_tokens),
    cache_write_tokens: readNonNegInt(u.cache_creation_input_tokens),
  };
}

function extractUsageFromMessageDelta(parsed: unknown): TokenUsage | null {
  if (!isObj(parsed)) return null;
  const u = parsed.usage;
  if (!isObj(u)) return null;
  return {
    input_tokens: readNonNegInt(u.input_tokens),
    output_tokens: readNonNegInt(u.output_tokens),
    cache_read_tokens: readNonNegInt(u.cache_read_input_tokens),
    cache_write_tokens: readNonNegInt(u.cache_creation_input_tokens),
  };
}

function hasStopReason(parsed: unknown): boolean {
  if (!isObj(parsed)) return false;
  const d = parsed.delta;
  return isObj(d) && typeof d.stop_reason === "string" && d.stop_reason.length > 0;
}

// ─── 上游字节透传(byte-exact passthrough + usage 旁路) ──────────────────

export interface PipeStreamResult {
  observation: UsageObservation;
  /** 写入下游字节数(只统计 res.write 成功的字节)。 */
  bytesOut: number;
  /** 第一字节 ms(performance.now / Date.now 相对值);未收到任何 chunk → null。 */
  firstByteAtMs: number | null;
  /**
   * 中断/异常原因。null 表示流正常结束(EOF)。非 null 表示上游/下游中途断开,
   * 但 observation 仍然反映"已看到的部分 usage",caller 据此区分 partial vs aborted。
   */
  error: unknown;
}

/**
 * 把上游 ReadableStream 的 chunk 字节完整透传给 res,同时旁路 UsageObserver。
 *
 * **永远 resolve,不 throw** —— 失败信息通过 `result.error` 暴露,observation 始终是 caller
 * 视角下"最后看到的状态"(可能是 partial)。这样 caller 才能区分 "中途断流但拿到部分 usage"
 * (settle=partial)与"压根没拿到"(settle=aborted),不会把 partial 误归到 aborted。
 *
 * upstream reader 永远在 finally 里 cancel,避免上游 socket keep-alive hang。
 */
export async function pipeStreamWithUsageCapture(
  upstreamBody: ReadableStream<Uint8Array>,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<PipeStreamResult> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder("utf-8");
  const observer = new UsageObserver();
  let bytesOut = 0;
  let firstByteAtMs: number | null = null;
  let error: unknown = null;
  try {
    try {
      while (true) {
        if (signal.aborted) {
          throw new ProxyAbortError("aborted before next chunk");
        }
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        if (firstByteAtMs === null) firstByteAtMs = Date.now();
        // 1) 字节透传 — write 失败 → 抛进外层 catch(下游已关连接)
        const wrote = res.write(value);
        bytesOut += value.length;
        if (!wrote) {
          // backpressure;等 drain 或 close。close 会让 signal abort 进而下次循环退出。
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              res.off("drain", onDrain);
              res.off("error", onErr);
              resolve();
            };
            const onErr = (e: unknown) => {
              res.off("drain", onDrain);
              res.off("error", onErr);
              reject(e);
            };
            res.on("drain", onDrain);
            res.on("error", onErr);
          });
        }
        // 2) 旁路 usage 提取(失败/异常都不影响 stream)
        try {
          observer.push(decoder.decode(value, { stream: true }));
        } catch {
          // observer 内部解析失败不该传染主路径
        }
      }
    } catch (err) {
      error = err;
    }
    try {
      observer.flush();
    } catch {
      /* ignore */
    }
    return { observation: observer.result(), bytesOut, firstByteAtMs, error };
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

class ProxyAbortError extends Error {
  readonly code = "PROXY_ABORT" as const;
  constructor(reason: string) {
    super(reason);
    this.name = "ProxyAbortError";
  }
}

// ─── finalizer(single-shot + journal) ────────────────────────────────────

export interface FinalizeContext {
  requestId: string;
  userId: bigint;
  containerId: bigint;
  accountId: bigint;
  model: string;
  pricing: ModelPricing;
  precheckCredits: bigint;
  preCheckReservation: ReservationHandle;
  log: Logger;
}

export interface FinalizeOutcome {
  /** 写入 usage_records.cost_credits 的标称积分(基于 pricing 算出);abort/none → 0n */
  finalCredits: bigint;
  /**
   * 真正 debit 进 credit_ledger 的积分数(== ledger delta 绝对值)。
   *
   * 与 finalCredits 的区别:
   *   - clamp 场景:余额不足,debitedCredits = balance (< finalCredits)
   *   - billing_failed 场景(obs.kind='partial'):不走 ledger,debitedCredits=null
   *   - 23505 重入:DB 已提交,无法重读当次 debit → null
   *   - abort / cost=0 / 广播器想知道"有没有真的扣"→ null 表示不可用
   *
   * 广播/UI 应该用这个,不要用 finalCredits,否则 billing_failed/clamp 时会误报。
   */
  debitedCredits: bigint | null;
  /** 'committed' | 'aborted' */
  state: "committed" | "aborted";
  /** journal 行的 PG 主键(== requestId) */
  requestId: string;
  /**
   * debit 完成后的 users.credits(== credit_ledger.balance_after)。
   *
   * 语义与 SettleResult.balanceAfter 一致:只要走了 ledger debit 事务就可读,
   * 即便 clamp 到 0n 也是合法值;非扣费路径 / 23505 重入 → null。
   * 调用方想展示"当前余额"且此处为 null 时,得另查 users 表。
   */
  balanceAfter: bigint | null;
}

interface FinalizeDeps {
  pgPool: Pool;
  preCheckRedis: PreCheckRedis;
  scheduler: AccountScheduler;
}

/**
 * 在 stream 开始前写一行 `inflight` journal。**幂等**:同 requestId 二次调用 noop。
 *
 * 设计理由:journal INSERT 必须先于上游 fetch,这样进程哪怕在 fetch 时 crash,
 * journal 里就有这条 inflight 记录,reconciler 后续可以扫到并兜底退预扣(P1)。
 */
export async function startInflightJournal(
  pool: Pool,
  ctx: Pick<FinalizeContext, "requestId" | "userId" | "containerId" | "model" | "precheckCredits">,
): Promise<void> {
  await pool.query(
    `INSERT INTO request_finalize_journal
       (request_id, user_id, container_id, state, ctx, precheck_credits)
     VALUES ($1, $2, $3, 'inflight', $4::jsonb, $5)
     ON CONFLICT (request_id) DO NOTHING`,
    [
      ctx.requestId,
      ctx.userId.toString(),
      ctx.containerId.toString(),
      JSON.stringify({ model: ctx.model }),
      ctx.precheckCredits.toString(),
    ],
  );
}

/**
 * Single-shot finalizer 工厂。
 *
 * 返回的 commit / fail 内部用 once-flag 包裹,保证两者总共只有一次实际效果。
 * 第二次/第三次调用立即返回上次的结果。
 *
 * 不变量:
 *   - release(scheduler) 与 releasePreCheck(redis) 都在这里发生,**不在外面**
 *   - DB 出错绝不阻塞响应已 flush 的字节流(异常被 catch + log + alert metric 留待运营)
 *   - usage_records 可能写不进去(如 status='error');不写 ledger 也不写 journal final
 *
 * 调用契约:外层 try 里 commit(observed),catch 里 fail(observed, err)。
 * finally 里**不要**再调任何 release —— finalize 内部已经搞定。
 */
export function makeFinalizer(deps: FinalizeDeps, ctx: FinalizeContext): {
  commit: (obs: UsageObservation) => Promise<FinalizeOutcome>;
  fail: (obs: UsageObservation, err: unknown) => Promise<FinalizeOutcome>;
} {
  let done: FinalizeOutcome | null = null;
  let inflight: Promise<FinalizeOutcome> | null = null;

  async function runCommit(obs: UsageObservation): Promise<FinalizeOutcome> {
    if (obs.kind === "none") {
      // 看不到任何 usage 但 stream 正常结束 — 罕见(上游协议异常)。
      // 视为 abort,不扣费。
      return runAbort(obs, new Error("no usage observed in successful stream"));
    }
    const usage = obs.usage;
    const { cost_credits, snapshot } = computeCost(usage, ctx.pricing);
    const status = obs.kind === "final" ? "success" : "billing_failed";
    // 二阶段:UPDATE → INSERT × 2 + UPDATE。失败任何一步都 catch 掉走 abort 路径。
    try {
      await deps.pgPool.query(
        `UPDATE request_finalize_journal
            SET state='finalizing', updated_at=NOW()
          WHERE request_id=$1 AND state IN ('inflight','finalizing')`,
        [ctx.requestId],
      );
      // 写 usage_records + credit_ledger + 更新 users.credits 一个事务里
      const settled = await settleUsageAndLedger(deps.pgPool, {
        userId: ctx.userId,
        accountId: ctx.accountId,
        requestId: ctx.requestId,
        model: ctx.model,
        usage,
        snapshotJson: JSON.stringify(snapshot),
        costCredits: cost_credits,
        status,
      });
      await deps.pgPool.query(
        `UPDATE request_finalize_journal
            SET state='committed',
                final_credits=$2,
                ledger_id=$3,
                usage_id=$4,
                updated_at=NOW()
          WHERE request_id=$1`,
        [
          ctx.requestId,
          cost_credits.toString(),
          settled.ledgerId === null ? null : settled.ledgerId.toString(),
          settled.usageId.toString(),
        ],
      );
      ctx.log.info("proxy_finalize_committed", {
        finalCredits: cost_credits.toString(),
        kind: obs.kind,
        usage: usageToLog(usage),
        clamped: settled.clamped,
      });
      // 2I-2: billing_debit 三态语义重新对齐(Codex 审核结论):
      //   * success      = obs.kind='final' + cost>0 + 余额 >= cost (足额扣款)
      //   * insufficient = obs.kind='final' + cost>0 + 余额 < cost (debit 被夹到 0,欠费)
      //   * (不计数)    = obs.kind='partial' (status='billing_failed' 路径不走 ledger debit,settle 计 partial)
      //   * error        = settle 写库失败 (catch 块)
      if (status === "success" && cost_credits > 0n) {
        incrBillingDebit(settled.clamped ? "insufficient" : "success");
      }
      return {
        finalCredits: cost_credits,
        debitedCredits: settled.debitedCredits,
        state: "committed",
        requestId: ctx.requestId,
        balanceAfter: settled.balanceAfter,
      };
    } catch (err) {
      ctx.log.error("proxy_finalize_commit_db_failed", {
        err: errSummary(err),
        precheckCredits: ctx.precheckCredits.toString(),
      });
      // settle 写库失败 = billing_debit_failures_total{result="error"}
      incrBillingDebit("error");
      // 走 abort 路径,确保 journal/redis/scheduler 状态一致
      return runAbort(obs, err);
    }
  }

  async function runAbort(_obs: UsageObservation, err: unknown): Promise<FinalizeOutcome> {
    const msg = errMessageShort(err);
    try {
      await deps.pgPool.query(
        `UPDATE request_finalize_journal
            SET state='aborted',
                error_msg=$2,
                final_credits=0,
                updated_at=NOW()
          WHERE request_id=$1`,
        [ctx.requestId, msg],
      );
    } catch (dbErr) {
      ctx.log.error("proxy_finalize_abort_db_failed", { err: errSummary(dbErr) });
    }
    ctx.log.warn("proxy_finalize_aborted", { reason: msg });
    return {
      finalCredits: 0n,
      debitedCredits: null,
      state: "aborted",
      requestId: ctx.requestId,
      balanceAfter: null,
    };
  }

  async function runFinalizeAndRelease(
    runner: () => Promise<FinalizeOutcome>,
    schedulerResult: "success" | "failure",
    schedulerErrMsg: string | null,
  ): Promise<FinalizeOutcome> {
    if (done) return done;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const out = await runner();
        // releasePreCheck:即使失败,Redis TTL 也会兜底(300s)
        try {
          await releasePreCheck(deps.preCheckRedis, ctx.preCheckReservation);
        } catch (e) {
          ctx.log.warn("proxy_release_precheck_failed", { err: errSummary(e) });
        }
        try {
          await deps.scheduler.release({
            account_id: ctx.accountId,
            result:
              schedulerResult === "success"
                ? { kind: "success" }
                : { kind: "failure", error: schedulerErrMsg },
          });
        } catch (e) {
          ctx.log.warn("proxy_release_scheduler_failed", { err: errSummary(e) });
        }
        done = out;
        return out;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    commit: (obs) => runFinalizeAndRelease(() => runCommit(obs), "success", null),
    fail: (obs, err) =>
      runFinalizeAndRelease(() => runAbort(obs, err), "failure", errMessageShort(err)),
  };
}

interface SettleResult {
  usageId: bigint;
  ledgerId: bigint | null;
  /**
   * true 表示 debit 被夹到余额(`debit < costCredits`),用户余额已扣到 0 但还欠 cost - balance。
   * 此时 metrics 应记 `billing_debit_total{result="insufficient"}` 而非 "success"。
   * 仅在 `args.status === 'success'` 且 `costCredits > 0n` 路径才可能为 true。
   */
  clamped: boolean;
  /**
   * 真正 debit 进 ledger 的积分数(负号已去掉,就是绝对值)。
   *   - status='success' + cost>0:实际 debit (clamp 时 = balance,否则 = costCredits)
   *   - status='billing_failed' / cost=0:不走 ledger → null
   *   - 23505 重入:无法重算 → null
   *
   * 调用方用这个值决定是否向前端广播"已扣费"事件,以及广播多少。
   */
  debitedCredits: bigint | null;
  /**
   * debit 完成后的 users.credits(即 ledger balance_after)。
   *
   * 取值规则:
   *   - 走 ledger debit 的事务路径(status='success' + cost>0 + 非 23505 重入)
   *     → debit 后的 newBalance(clamp 场景下可能是 0n,也算合法值)
   *   - status='billing_failed' / cost=0 / abort / 23505 重入 → null
   *
   * caller 想展示"当前余额"且这里拿到 null 时,请另查 users 表。
   */
  balanceAfter: bigint | null;
}

/**
 * 一个事务:INSERT usage_records,(若 status='success' 且 cost_credits>0)再走 debit。
 *
 * 幂等:`(user_id, request_id)` 唯一索引保证 usage_records 不会重插。
 * 重复进入 settle 时 INSERT 抛 23505 → 我们 catch 改成 SELECT 取已有行返回。
 */
async function settleUsageAndLedger(
  pool: Pool,
  args: {
    userId: bigint;
    accountId: bigint;
    requestId: string;
    model: string;
    usage: TokenUsage;
    snapshotJson: string;
    costCredits: bigint;
    status: "success" | "billing_failed" | "error";
  },
): Promise<SettleResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let usageId: bigint;
    let ledgerId: bigint | null = null;
    let clamped = false;
    let balanceAfter: bigint | null = null;
    let debitedCredits: bigint | null = null;
    try {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO usage_records
          (user_id, mode, account_id, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           price_snapshot, cost_credits, request_id, status)
         VALUES ($1, 'chat', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
         RETURNING id::text AS id`,
        [
          args.userId.toString(),
          args.accountId.toString(),
          args.model,
          BigInt(args.usage.input_tokens).toString(),
          BigInt(args.usage.output_tokens).toString(),
          BigInt(args.usage.cache_read_tokens).toString(),
          BigInt(args.usage.cache_write_tokens).toString(),
          args.snapshotJson,
          args.costCredits.toString(),
          args.requestId,
          args.status,
        ],
      );
      usageId = BigInt(ins.rows[0]!.id);
    } catch (err) {
      // 23505 = unique_violation;复用 (user_id, request_id) 上的 UNIQUE
      if (isUniqueViolation(err)) {
        const sel = await client.query<{ id: string; ledger_id: string | null }>(
          `SELECT id::text AS id, ledger_id::text AS ledger_id
             FROM usage_records WHERE user_id=$1 AND request_id=$2`,
          [args.userId.toString(), args.requestId],
        );
        if (sel.rowCount === 0) throw err;
        const r = sel.rows[0]!;
        await client.query("COMMIT");
        // 重试时无法重新算 clamp(原始 balance 已变),保守标 false。
        // metric 只对首次 settle 路径完整反映 — 重复 settle 是边界场景,
        // 由 inflight 兜底,clamp 状态以原 ledger memo 为准(非 metric 来源)。
        return {
          usageId: BigInt(r.id),
          ledgerId: r.ledger_id === null ? null : BigInt(r.ledger_id),
          clamped: false,
          // 重入路径 DB 已是提交态,原始 debit 金额无法安全重算,标 null
          // (caller 用 null 决定不对外广播 cost_charged,只靠 refreshBalance 更新气泡)。
          debitedCredits: null,
          // 同上:余额可能被别的并发请求改过,无法还原当时的 balance_after。
          balanceAfter: null,
        };
      }
      throw err;
    }
    if (args.status === "success" && args.costCredits > 0n) {
      // FOR UPDATE 行锁:同一 user 并发 finalize 串行,balance_after 单调
      const before = await client.query<{ credits: string }>(
        "SELECT credits::text AS credits FROM users WHERE id=$1 FOR UPDATE",
        [args.userId.toString()],
      );
      if (before.rowCount === 0) throw new Error(`user ${args.userId} not found`);
      const balance = BigInt(before.rows[0]!.credits);
      // 余额 < cost:不再回滚 stream(已发字节回不来),把扣费金额 clamp 到余额。
      // status 仍是 'success' (业务上已交付完整流), ledger memo 标 'clamped' 并把
      // billing_debit_total{result="insufficient"} +1 (由 runCommit 根据 settled.clamped 上报)。
      // balance_after = 0,用户回到 0 再充值。
      const debit = balance < args.costCredits ? balance : args.costCredits;
      clamped = debit < args.costCredits;
      const newBalance = balance - debit;
      balanceAfter = newBalance;
      debitedCredits = debit;
      await client.query(
        "UPDATE users SET credits=$1 WHERE id=$2",
        [newBalance.toString(), args.userId.toString()],
      );
      const led = await client.query<{ id: string }>(
        `INSERT INTO credit_ledger
           (user_id, delta, balance_after, reason, ref_type, ref_id, memo)
         VALUES ($1, $2, $3, 'chat', 'usage_record', $4, $5)
         RETURNING id::text AS id`,
        [
          args.userId.toString(),
          (-debit).toString(),
          newBalance.toString(),
          usageId.toString(),
          debit < args.costCredits
            ? `cost=${args.costCredits} balance=${balance} clamped`
            : null,
        ],
      );
      ledgerId = BigInt(led.rows[0]!.id);
      await client.query(
        "UPDATE usage_records SET ledger_id=$1 WHERE id=$2",
        [ledgerId.toString(), usageId.toString()],
      );
    }
    await client.query("COMMIT");
    return { usageId, ledgerId, clamped, debitedCredits, balanceAfter };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return isObj(err) && (err as { code?: unknown }).code === "23505";
}

function usageToLog(u: TokenUsage): Record<string, string> {
  return {
    input_tokens: BigInt(u.input_tokens).toString(),
    output_tokens: BigInt(u.output_tokens).toString(),
    cache_read_tokens: BigInt(u.cache_read_tokens).toString(),
    cache_write_tokens: BigInt(u.cache_write_tokens).toString(),
  };
}

function errSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}

function errMessageShort(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return String(err).slice(0, 500);
}

/** 把 readBoundedJson / enforceFieldByteBudgets 抛的 HttpError 折射到 reject 标签。 */
function httpErrToReject(err: HttpError): ProxyRejectReason {
  if (err.status === 413) return "too_large";
  return "bad_body";
}

// ─── handler 工厂 ─────────────────────────────────────────────────────────

export interface AnthropicProxyDeps {
  pgPool: Pool;
  pricing: PricingCache;
  preCheckRedis: PreCheckRedis;
  scheduler: AccountScheduler;
  identityRepo: ContainerIdentityRepo;
  rateLimitRedis: RateLimitRedis;
  /** 注入 fetch(测试用)。 */
  fetchImpl?: typeof fetch;
  /** 上游 endpoint;默认 api.anthropic.com */
  upstreamEndpoint?: string;
  /** 限流配置覆盖 */
  rateLimit?: RateLimitConfig;
  /** per-uid 并发上限 */
  maxConcurrentPerUid?: number;
  /** body 上限 byteLength */
  maxBodyBytes?: number;
  /** OAuth refresh deps;不给 → 不刷新(假设 token 还没过期) */
  refreshDeps?: RefreshDeps;
  /** 根 logger */
  logger?: Logger;
  /**
   * 可选:扣费成功后把实际 credits / balance 推到该 uid 的前端 WS。
   * 典型实现:userChatBridge.broadcastToUser。前端靠此帧把响应 meta 行的
   * "$0.xxxx" 替换成真实扣费积分(容器侧的 m.cost 是 USD 估算,与商用扣费不一致)。
   * 不传 → 扣费仍正常发生,只是前端看到的还是估算 $;deploy 时必须注入。
   */
  broadcastToUser?: (uid: bigint, payload: unknown) => void;
}

export interface AnthropicProxyHandler {
  (req: IncomingMessage, res: ServerResponse, peerIp: string): Promise<void>;
}

/**
 * 工厂:返回 (req, res, peerIp) 的 async handler。
 *
 * peerIp 由 caller 提供 —— gateway/server.ts 在 IP 18791 监听上拿 socket.remoteAddress
 * 传进来。容器内 OpenClaude 出去的 peerIp 是 docker bridge 上的 container_internal_ip,
 * 与 agent_containers.bound_ip 等值(2C 双因子的因子 A)。
 */
export function makeAnthropicProxyHandler(
  deps: AnthropicProxyDeps,
): AnthropicProxyHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "anthropicProxy" });
  const fetchFn = deps.fetchImpl ?? fetch;
  const endpoint = deps.upstreamEndpoint ?? DEFAULT_UPSTREAM_ENDPOINT;
  const rateLimitCfg = deps.rateLimit ?? DEFAULT_PROXY_RATE_LIMIT;
  const concurrency = new ConcurrencyLimiter(
    deps.maxConcurrentPerUid ?? DEFAULT_MAX_CONCURRENT_PER_UID,
  );
  // 2026-04-21 安全审计 HIGH#3:Redis 抖动时的兜底限流(cap = Redis cap 的 1/3,
  // 向下取整至少 1;窗口同 Redis 以便行为连续)。Redis 正常时这个 map 始终空,
  // 不占资源;Redis 异常时它是最后一道防线。
  const fallbackCap = Math.max(1, Math.floor(rateLimitCfg.max / 3));
  const fallbackLimiter = new FallbackRateLimiter(rateLimitCfg.windowSeconds, fallbackCap);
  const maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES_DEFAULT;

  return async function handle(req, res, peerIp) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const reqLog = log.child({
      requestId,
      peerIp,
      method: req.method ?? "GET",
      path: req.url ?? "",
    });

    // 0) 路径白名单 — 这个 handler 只挂在 POST /v1/messages
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      reqLog.warn("proxy_bad_path", { method: req.method, path: url.pathname });
      incrAnthropicProxyReject("bad_path");
      sendJsonError(res, 404, "NOT_FOUND", "endpoint not found", requestId);
      return;
    }

    // 1) 容器身份双因子
    let identity;
    try {
      identity = await verifyContainerIdentity(
        deps.identityRepo,
        peerIp,
        req.headers.authorization,
      );
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        // errcode 进 server log,不外泄
        reqLog.warn("proxy_identity_failed", { errcode: err.code });
        incrAnthropicProxyReject("identity");
        sendJsonError(
          res,
          401,
          "UNAUTHORIZED",
          "container identity verification failed",
          requestId,
        );
        return;
      }
      throw err;
    }
    const uid = BigInt(identity.userId);
    const containerIdBig = BigInt(identity.containerId);
    const userLog = reqLog.child({ uid: uid.toString(), containerId: containerIdBig.toString() });

    // 2) 限流(per-uid 滑动固定窗口)
    try {
      const decision = await checkRateLimit(
        deps.rateLimitRedis,
        rateLimitCfg,
        `uid:${uid.toString()}`,
      );
      if (!decision.allowed) {
        userLog.warn("proxy_rate_limited", { count: decision.count });
        incrAnthropicProxyReject("rate_limited");
        sendJsonError(
          res,
          429,
          "RATE_LIMITED",
          "too many requests, slow down",
          requestId,
          { "Retry-After": String(decision.retryAfterSeconds) },
        );
        return;
      }
    } catch (err) {
      // 2026-04-21 安全审计 HIGH#3 修复:Redis 抖动不再 fail-open 无脑放行。
      // 退到进程内 FallbackRateLimiter(cap = Redis cap/3),保底防止"Redis 持续
      // 宕掉 → proxy 变成无限流 open relay → 盗用 token 秒级烧钱"。
      // Fallback 放行 → 继续(记 error log);Fallback 也拒 → 429 RATE_LIMITED。
      userLog.error("proxy_rate_limit_redis_failed", { err: errSummary(err) });
      if (!fallbackLimiter.tryAcquire(`uid:${uid.toString()}`)) {
        userLog.warn("proxy_rate_limit_fallback_blocked", {
          fallbackCap,
          fallbackCount: fallbackLimiter.count(`uid:${uid.toString()}`),
        });
        incrAnthropicProxyReject("rate_limited");
        sendJsonError(
          res,
          429,
          "RATE_LIMITED",
          "rate limit fallback engaged (redis degraded)",
          requestId,
          { "Retry-After": String(rateLimitCfg.windowSeconds) },
        );
        return;
      }
    }

    // 3) per-uid 并发上限
    const releaseSlot = concurrency.acquire(`uid:${uid.toString()}`);
    if (!releaseSlot) {
      userLog.warn("proxy_concurrency_full", { max: deps.maxConcurrentPerUid ?? DEFAULT_MAX_CONCURRENT_PER_UID });
      incrAnthropicProxyReject("concurrency");
      sendJsonError(res, 429, "CONCURRENT_LIMIT", "too many concurrent requests", requestId);
      return;
    }

    try {
      // 4) 读 + parse + 校验 body
      let body: ProxyBody;
      try {
        const raw = await readBoundedJson(req, maxBodyBytes);
        const parsed = proxyBodySchema.safeParse(raw);
        if (!parsed.success) {
          userLog.warn("proxy_body_schema_failed", { issues: parsed.error.issues });
          incrAnthropicProxyReject("bad_body");
          sendJsonError(res, 400, "BAD_BODY", "invalid request body", requestId);
          return;
        }
        body = parsed.data;
        enforceFieldByteBudgets(body);
      } catch (err) {
        if (err instanceof HttpError) {
          userLog.warn("proxy_body_rejected", { status: err.status, code: err.code });
          incrAnthropicProxyReject(httpErrToReject(err));
          sendJsonError(res, err.status, err.code, err.message, requestId);
          return;
        }
        throw err;
      }

      // 5) 取 pricing
      const pricing = deps.pricing.get(body.model);
      if (!pricing || !pricing.enabled) {
        userLog.warn("proxy_unknown_model", { model: body.model });
        incrAnthropicProxyReject("unknown_model");
        sendJsonError(res, 400, "UNKNOWN_MODEL", `model '${body.model}' not enabled`, requestId);
        return;
      }

      // 6) 双侧 cost 估算 + preCheck(原子预留:Lua 一次完成 余额比对 + 写入)
      const inputTokens = estimateInputTokens(body);
      const totalMaxCost = estimateMaxCostBothSides(inputTokens, body.max_tokens, pricing);
      let pre;
      try {
        // 走 preCheckWithCost(已知 maxCost,跳过 estimateMaxCost 重算)。
        // 内部:getBalance(PG) → atomicReserve(Lua: 清过期 + HVALS 求和 + 比 balance + HSET/ZADD)
        pre = await preCheckWithCost(deps.preCheckRedis, {
          userId: uid,
          requestId,
          maxCost: totalMaxCost,
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          userLog.warn("proxy_insufficient_credits", {
            balance: err.balance.toString(),
            required: err.required.toString(),
          });
          incrAnthropicProxyReject("insufficient");
          sendJsonError(
            res,
            402,
            "INSUFFICIENT_CREDITS",
            `insufficient credits: balance=${err.balance} required=${err.required}`,
            requestId,
          );
          return;
        }
        throw err;
      }

      // 7) 取账号 + (按需)刷 token
      let pick;
      try {
        pick = await deps.scheduler.pick({
          mode: "chat",
          sessionId: body.metadata?.session_id,
          model: body.model,
        });
      } catch (err) {
        await releasePreCheck(deps.preCheckRedis, pre.reservation).catch(() => {});
        if (err instanceof AccountPoolUnavailableError) {
          userLog.warn("proxy_account_pool_unavailable", { msg: err.message });
          incrAnthropicProxyReject("account_pool");
          sendJsonError(res, 503, "ACCOUNT_POOL_UNAVAILABLE", "account pool unavailable, try again", requestId);
          return;
        }
        throw err;
      }
      // 不持有 finalizer 之前,任何后续异常都得手动 release pick + preCheck;
      // 之后(从 startInflightJournal 起)统一交给 finalize.fail
      // HIGH#5:同 account 的 chat 与 refresh 必须从同一出口 IP 出去 —— Anthropic
      // anti-abuse 会把 refresh 与紧随其后的 chat 关联,IP 一变立即触发风控。
      const accountDispatcher = getDispatcherForAccount(pick.account_id, pick.egress_proxy);
      try {
        if (
          deps.refreshDeps &&
          pick.expires_at &&
          shouldRefresh(pick.expires_at, new Date(), DEFAULT_REFRESH_SKEW_MS)
        ) {
          try {
            const r = await refreshAccountToken(pick.account_id, {
              ...deps.refreshDeps,
              // 显式覆盖:即使 caller 在 refreshDeps 里塞了别的 dispatcher,
              // 也用 account 的固定出口,不让"全局 dispatcher 漏选"破坏稳定 IP。
              dispatcher: accountDispatcher,
            });
            // 释放老 token(零化),用新 token
            try {
              pick.token.fill(0);
            } catch {
              /* ignore */
            }
            try {
              pick.refresh?.fill(0);
            } catch {
              /* ignore */
            }
            pick = {
              account_id: pick.account_id,
              plan: pick.plan,
              token: r.token,
              refresh: r.refresh,
              expires_at: r.expires_at,
              egress_proxy: pick.egress_proxy,
            };
          } catch (err) {
            // refresh 失败:account 已在 RefreshError 内部按规约处理 disable/不 disable;
            // 我们 release(failure) 让 health 扣分,然后 502
            userLog.warn("proxy_refresh_failed", {
              accountId: pick.account_id.toString(),
              code: err instanceof RefreshError ? err.code : "unknown",
              msg: err instanceof Error ? err.message : String(err),
            });
            await deps.scheduler
              .release({
                account_id: pick.account_id,
                result: { kind: "failure", error: errMessageShort(err) },
              })
              .catch(() => {});
            await releasePreCheck(deps.preCheckRedis, pre.reservation).catch(() => {});
            incrAnthropicProxyReject("upstream_auth");
            sendJsonError(res, 502, "UPSTREAM_AUTH_REFRESH_FAILED", "failed to refresh upstream token", requestId);
            return;
          }
        }
      } catch (err) {
        try {
          pick.token.fill(0);
          pick.refresh?.fill(0);
        } catch {
          /* ignore */
        }
        await deps.scheduler
          .release({
            account_id: pick.account_id,
            result: { kind: "failure", error: errMessageShort(err) },
          })
          .catch(() => {});
        await releasePreCheck(deps.preCheckRedis, pre.reservation).catch(() => {});
        throw err;
      }

      // 8) 写 inflight journal(必须先于 fetch — 进程在 fetch 时 crash 也有线索)
      try {
        await startInflightJournal(deps.pgPool, {
          requestId,
          userId: uid,
          containerId: containerIdBig,
          model: body.model,
          precheckCredits: pre.maxCost,
        });
      } catch (err) {
        try {
          pick.token.fill(0);
          pick.refresh?.fill(0);
        } catch {
          /* ignore */
        }
        await deps.scheduler
          .release({
            account_id: pick.account_id,
            result: { kind: "failure", error: errMessageShort(err) },
          })
          .catch(() => {});
        await releasePreCheck(deps.preCheckRedis, pre.reservation).catch(() => {});
        userLog.error("proxy_journal_insert_failed", { err: errSummary(err) });
        sendJsonError(res, 500, "INTERNAL", "internal error", requestId);
        return;
      }

      // 9) 装 finalizer(从此 release 唯一调用点 = finalize)
      const finalize = makeFinalizer(
        {
          pgPool: deps.pgPool,
          preCheckRedis: deps.preCheckRedis,
          scheduler: deps.scheduler,
        },
        {
          requestId,
          userId: uid,
          containerId: containerIdBig,
          accountId: pick.account_id,
          model: body.model,
          pricing,
          precheckCredits: pre.maxCost,
          preCheckReservation: pre.reservation,
          log: userLog,
        },
      );

      // 10) 双向 abort 绑定
      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.on("close", onClose);
      res.on("close", onClose);

      let observed: UsageObservation = { kind: "none" };
      try {
        // safe headers + Authorization
        let safeHeaders: Record<string, string>;
        try {
          safeHeaders = buildSafeUpstreamHeaders(req.headers);
        } catch (err) {
          if (err instanceof HttpError) {
            incrAnthropicProxyReject("bad_headers");
            await finalize.fail(observed, err);
            sendJsonError(res, err.status, err.code, err.message, requestId);
            return;
          }
          throw err;
        }
        safeHeaders.authorization = `Bearer ${pick.token.toString("utf8")}`;

        // 强制注入 oauth-2025-04-20 — 我们所有 claude_accounts 都用 OAuth bearer,
        // 没这个 beta header Anthropic 会回 401 "OAuth authentication is currently not supported"。
        // 个人版 ccb 在 isClaudeAISubscriber()=false 时(我们容器内就是这种)不会自己加,
        // 所以必须在 proxy 侧无条件补上(允许多 token 共存,merge 而不是覆盖)。
        {
          const existing = (safeHeaders["anthropic-beta"] ?? "").split(",").map(s => s.trim()).filter(Boolean);
          if (!existing.includes("oauth-2025-04-20")) existing.unshift("oauth-2025-04-20");
          safeHeaders["anthropic-beta"] = existing.join(",");
        }

        // body 强制 stream:true
        const upstreamBodyJson = JSON.stringify({ ...body, stream: true });

        const fetchInit: RequestInit & { dispatcher?: unknown } = {
          method: "POST",
          headers: safeHeaders,
          body: upstreamBodyJson,
          signal: ac.signal,
        };
        // HIGH#5:绑账号 egress_proxy。pick.egress_proxy 为 null → 走默认出口。
        // dispatcher 由 egressDispatcher 缓存,同 account 的 chat / refresh 共享
        // 同一 ProxyAgent,确保稳定 source IP。dispatcher 在 ProxyAgent.close()
        // 时会等流结束 —— pipeStreamWithUsageCapture finally 块里 cancel reader,
        // 这条流不会让 admin 改 proxy 时 hang(参 egressDispatcher.ts 注释)。
        if (accountDispatcher) fetchInit.dispatcher = accountDispatcher;

        const fetchStartMs = Date.now();
        const upstream = await fetchFn(endpoint, fetchInit);
        if (upstream.status < 200 || upstream.status >= 300) {
          // 上游 4xx/5xx — 读 body preview 写 log,直接转译成 502
          let preview = "";
          try {
            preview = (await upstream.text()).slice(0, 500);
          } catch {
            /* ignore */
          }
          const err = new Error(
            `upstream returned ${upstream.status}: ${preview}`,
          );
          await finalize.fail(observed, err);
          incrAnthropicProxySettle("aborted");
          sendJsonError(res, 502, "UPSTREAM_ERROR", `upstream returned ${upstream.status}`, requestId);
          return;
        }
        if (!upstream.body) {
          const err = new Error(`upstream ${upstream.status} but no body`);
          await finalize.fail(observed, err);
          incrAnthropicProxySettle("aborted");
          sendJsonError(res, 502, "UPSTREAM_NO_BODY", "upstream returned no body", requestId);
          return;
        }
        // 写 SSE 响应头,开始 byte-pipe
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          [REQUEST_ID_HEADER]: requestId,
        });
        const result = await pipeStreamWithUsageCapture(
          upstream.body as ReadableStream<Uint8Array>,
          res,
          ac.signal,
        );
        observed = result.observation;
        const streamEndMs = Date.now();
        // 2I-2 metrics:TTFT 是 fetch 起到第一字节;stream duration 是 fetch 起到最后一字节。
        // 任意一项 < 0 / NaN 由 metrics observe 自动丢弃,无需在这里防御。
        if (result.firstByteAtMs !== null) {
          observeAnthropicProxyTtft(body.model, (result.firstByteAtMs - fetchStartMs) / 1000);
        }
        observeAnthropicProxyStreamDuration(body.model, (streamEndMs - fetchStartMs) / 1000);
        try {
          res.end();
        } catch {
          /* ignore */
        }
        // 中途断流(result.error != null)走 fail,但 observation 已捕获 partial 状态
        let outcome: FinalizeOutcome;
        if (result.error !== null) {
          outcome = await finalize.fail(observed, result.error);
        } else {
          outcome = await finalize.commit(observed);
        }
        // 把真实扣费的积分 + 扣费后余额推给该 uid 的前端 WS,前端会替换响应 meta
        // 行里 $0.xxxx(容器侧估算,口径不一致)为真实扣费积分。
        //
        // **只用 debitedCredits,不要用 finalCredits**:
        //   - billing_failed 路径(obs.kind='partial') ledger 根本没 debit,
        //     finalCredits 可能 > 0 但用户没被扣到 → debitedCredits=null → 跳过广播
        //   - clamp(余额不足)路径 finalCredits=标称,debitedCredits=实际扣款(<标称),
        //     必须发实际扣款值,否则用户面板看到的 meta 和左上角余额对不上
        //   - 23505 重入路径 debitedCredits=null → 跳过广播,前端靠 refreshBalance 兜底
        if (
          deps.broadcastToUser
          && outcome.state === "committed"
          && outcome.debitedCredits !== null
          && outcome.debitedCredits > 0n
        ) {
          try {
            deps.broadcastToUser(uid, {
              type: "outbound.cost_charged",
              requestId,
              // credits 用字符串序列化,保留 BigInt 精度,避免 JS Number 53bit 边界。
              // (虽然单笔不太可能上亿积分,但 balance_after 累计可能。)
              costCredits: outcome.debitedCredits.toString(),
              balanceAfter: outcome.balanceAfter === null
                ? null
                : outcome.balanceAfter.toString(),
              sessionId: body.metadata?.session_id ?? null,
            });
          } catch (err) {
            userLog.warn("proxy_broadcast_cost_failed", { err: errSummary(err) });
          }
        }
        // settle 三态(2I-2 codex 审核结论:partial 必须基于 observed.kind 判断,
        // 不能因 pipeStream 抛错就直接归 aborted —— observation 捕获了部分 usage):
        //   final   = stream 正常结束 + message_stop event 给齐 usage
        //   partial = stream 中途断 / 仅看到 message_delta,有部分 usage
        //   aborted = stream 没看到任何 usage(最早期就断)
        if (observed.kind === "final") incrAnthropicProxySettle("final");
        else if (observed.kind === "partial") incrAnthropicProxySettle("partial");
        else incrAnthropicProxySettle("aborted");
      } catch (err) {
        await finalize.fail(observed, err);
        incrAnthropicProxySettle("aborted");
        // 字节是否已 flush 决定怎么发错误
        if (!res.headersSent) {
          sendJsonError(res, 500, "INTERNAL", "internal error", requestId);
        } else {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
      } finally {
        req.off("close", onClose);
        res.off("close", onClose);
        try {
          pick.token.fill(0);
          pick.refresh?.fill(0);
        } catch {
          /* ignore */
        }
      }
    } finally {
      releaseSlot();
    }
  };
}

// ─── 小工具:body 读 + JSON parse(带上限) ──────────────────────────────

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string);
    total += b.length;
    if (total > maxBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", `request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(b);
  }
  if (total === 0) {
    throw new HttpError(400, "EMPTY_BODY", "request body is empty");
  }
  const text = Buffer.concat(chunks, total).toString("utf-8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError(400, "INVALID_JSON", `body is not valid JSON: ${(err as Error).message}`);
  }
}

// ─── err response helper(不走 router 的 sendError,因为 proxy 不走 router) ──

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent) return;
  const body = JSON.stringify({
    error: { code, message },
    request_id: requestId,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf-8")),
    [REQUEST_ID_HEADER]: requestId,
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(body);
}

// ─── re-export 给测试 ─────────────────────────────────────────────────────

export {
  parseSseEvent as _parseSseEvent,
  UsageObserver as _UsageObserver,
};
