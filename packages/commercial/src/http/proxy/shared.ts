/**
 * V3 Phase 4(2026-05-18 anthropicProxy.ts 三层拆分 §4.5):shared leaf 模块。
 *
 * 全部 helpers / 常量 / schema / 类型集中在此,作为 proxy/ 子目录的纯叶子,
 * **不 import** 任何 proxy/* 文件。proxy/upstream.ts / proxy/core.ts /
 * proxy/index.ts / anthropicProxy.ts(façade)都向此处单向依赖。
 *
 * 物理迁移自 anthropicProxy.ts L1-955 + L1646-1700。仅调整 import 相对路径
 * (../ → ../../),不动语义不动注释。`sendJsonError` 从原私有提升为 export
 * (proxy/core.ts 错误响应路径需要)。`httpErrToReject` 保留私有,放进
 * proxy/index.ts(handler gate policy)。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §3 / §3.3 / §7 / 03-MVP-CHECKLIST.md Task 2D。
 *
 * 强制不变量(R3 文档总结,Phase 1-4 拆分后仍由本叶子持有):
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
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Pool } from "pg";
import { getStaticProvider, type StaticProviderKeys } from "@openclaude/protocol";

import { type Logger } from "../../logging/logger.js";
import {
  HttpError,
  REQUEST_ID_HEADER,
  errMessageShort,
  errSummary,
  isObj,
} from "../util.js";
import {
  type IdentityStrategy,
} from "../../auth/proxyIdentity.js";
import type { PricingCache, ModelPricing } from "../../billing/pricing.js";
import {
  type PreCheckRedis,
} from "../../billing/preCheck.js";
import type { TokenUsage } from "../../billing/calculator.js";
import type { AccountScheduler } from "../../account-pool/scheduler.js";
import { personaToHeaderPairs } from "../../account-pool/persona.js";
import {
  type RateLimitConfig,
  type RateLimitRedis,
} from "../../middleware/rateLimit.js";
import type { RefreshDeps } from "../../account-pool/refresh.js";
import type { PlatformContextLoader } from "../../platform/platformContextLoader.js";

// 上面 import 仅类型 / 值的占位重导出:errMessageShort / errSummary 留这里仅为给
// proxy/core.ts 与 proxy/index.ts 复用同一份(避免到处 import util.js)。
export { errMessageShort, errSummary, HttpError, REQUEST_ID_HEADER, isObj };
export type { Logger };

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** 上游 endpoint。可被 deps 覆盖(测试)。 */
export const DEFAULT_UPSTREAM_ENDPOINT = "https://api.anthropic.com/v1/messages";

// ─── 静态 key provider 常量/匹配器:thin re-export ────────────────────────────
//
// 路由元数据(endpoint / matchesRoute / strip / maxInputTokens)的**单一权威源**已上移到
// @openclaude/protocol 的 STATIC_KEY_PROVIDERS 注册表(commercial+gateway 共享)。
// 下面这些导出仅为**保护现有 caller**(如 ws/voiceTranscribe.ts import DEEPSEEK_UPSTREAM_ENDPOINT)
// 而保留的 thin re-export,值从注册表派生、与历史逐字节一致。新代码请直接用注册表。

/**
 * DeepSeek 的 anthropic 兼容端点。命中 `isDeepseekModel`(大小写敏感前缀)后切到这里,
 * Bearer <DEEPSEEK_API_KEY>,strip anthropic-beta,不占 OAuth 池。详见注册表 spec。
 */
export const DEEPSEEK_UPSTREAM_ENDPOINT = getStaticProvider("deepseek").upstreamEndpoint;

/** 模型 id 是否走 deepseek 路径(大小写敏感前缀 `deepseek-`)。 */
export function isDeepseekModel(modelId: string): boolean {
  return getStaticProvider("deepseek").matchesRoute(modelId);
}

/** MiniMax Token Plan 的 Anthropic 兼容端点(完整 /v1/messages)。 */
export const MINIMAX_UPSTREAM_ENDPOINT = getStaticProvider("minimax").upstreamEndpoint;

/** MiniMax-M3 只支持 <=512k input tokens 的标准档。 */
export const MINIMAX_M3_MAX_INPUT_TOKENS = getStaticProvider("minimax").maxInputTokens ?? 512_000;

/** 模型 id 是否走 MiniMax Token Plan 路径(精确 minimax-m3,大小写不敏感)。 */
export function isMiniMaxM3Model(modelId: string): boolean {
  return getStaticProvider("minimax").matchesRoute(modelId);
}

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

/** messages / tools 数量上限。
 *
 * tools 不能沿用 Anthropic 文档里的 64 个窄限:商业版团队委派时,CCB native
 * tools + openclaude-memory + browser + research/scansci-pdf 这类 MCP toolsets
 * 会自然超过 64。这里的 128 只是本代理层的容忍上限,不代表所有上游模型都承诺
 * 支持 128 个工具；DoS 防护主要仍靠 tools 字段 2MB byte budget 和总 body
 * 16MB budget。
 */
export const MAX_MESSAGES_COUNT = 2000;
export const MAX_TOOLS_COUNT = 128;

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
        // 512(原 256):CCB 会把 `CLAUDE_CODE_EXTRA_METADATA` env(gateway 对
        // delegate 子会话注入的计费归因 oc_mode / oc_parent_session_id /
        // oc_delegate_agent_id,见 extractUsageAttribution)spread 进
        // device_id/account_uuid/session_id 同一个 JSON 串;基础 ~200 字节 +
        // 归因 ~130 字节,维持 256 会把 delegate 子会话的请求整条 400 掉。
        user_id: z.string().max(512).optional(),
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
    /**
     * 2026-04-22:CCB v2.1.9+ 把 effort / task_budget / format 等全塞进
     * `output_config` 里发(claude-code-best claude.ts:1711-1713)。默认档不带
     * 此字段 — 一旦用户在前端"思考深度"菜单里选 low/medium/high/xhigh/max,
     * CCB 就会加 `output_config: { effort: 'xxx' }`,被 strict() 拒 → 整条
     * 消息 400 BAD_BODY(user claudeai.chat 2026-04-22 踩雷于"最高"档位)。
     * 对应 beta 是 effort-2025-11-24,已在 ALLOWED_BETA_VALUES 白名单里,
     * 所以 header 侧没问题,只缺 body 侧放行。与 thinking/context_management
     * 同策略,按 z.unknown() 透传给上游 Anthropic 自决,size 不受限
     * (object 整体小,没必要专门预算)。
     */
    output_config: z.unknown().optional(),
    /** Anthropic priority/standard tier 提示;透传不解析。 */
    service_tier: z.string().max(64).optional(),
  })
  .strict();

export type ProxyBody = z.infer<typeof proxyBodySchema>;

/**
 * 0105 — per-model 默认思考深度注入(model_pricing.default_effort,admin 运维页可配)。
 *
 * 语义(Codex 方案评审吸收):
 * - client 显式 output_config.effort **永远优先**,本函数只在缺失时补;
 * - **合并不覆盖**:output_config 其他子字段保留(OAuth 透传路径需要;静态 ark 的
 *   effort 白名单归一/capability-zero 的整体 strip 在 upstream 层照常兜底);
 * - 在 proxy handler 的 pricing/authorize 之后、selectUpstreamRoute/estimateInputTokens
 *   之前调用 —— 注入的少量字节计入 input 估算,与真实转发内容一致。
 */
export function applyModelDefaultEffort(
  body: ProxyBody,
  defaultEffort: string | null | undefined,
): void {
  if (!defaultEffort) return;
  const oc = body.output_config;
  if (oc === undefined || oc === null) {
    body.output_config = { effort: defaultEffort };
    return;
  }
  if (typeof oc === "object" && !Array.isArray(oc)) {
    const rec = oc as Record<string, unknown>;
    if (rec.effort === undefined) {
      body.output_config = { ...rec, effort: defaultEffort };
    }
  }
}

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
 * 从请求 metadata 提取 session_id,写入 usage_records.session_id 用于「按会话消耗」聚合。
 *
 * Anthropic API 标准 metadata schema 只有 `user_id: string` 一个字段。Claude Code CLI
 * 把多字段编码成 JSON 塞进 `user_id`(`device_id` / `account_uuid` / `session_id`),
 * 见 claude-code-best/src/services/api/claude.ts:485-510。如果只看顶层
 * `metadata.session_id`,所有 Claude Code 客户端都会落 NULL → 「按会话消耗」表永远空。
 *
 * 提取顺序:
 *   1. 显式顶层 `metadata.session_id`(优先,任何客户端可主动传)
 *   2. 解析 `metadata.user_id` 为 JSON,若是 plain object 且 `session_id` 是 string,提取
 *
 * 任何路径异常都返回 null:
 *   - JSON 不是 object / 是 array / parse 失败 / session_id 类型不对 / trim 后为空
 * trim 是因为 zod schema 已经允许 ≤256 字符,但中间空白不应阻断 fallback;truncate 到 256
 * 是兜底防御(zod schema 上限若被改大或绕过,DB 列也是 VARCHAR(256))。
 *
 * 安全:此函数只产出"分组键",最终 SQL 在 handlers.ts 始终先 `WHERE user_id = $1` 隔离,
 * 任何客户端伪造 session_id 也只影响自己的聚合视图。
 */
export function extractSessionId(
  metadata: { user_id?: string; session_id?: string } | undefined,
): string | null {
  return extractUsageAttribution(metadata).sessionId;
}

/** delegate 计费归因在 `metadata.user_id` JSON 里占用的键(gateway 经 CCB
 *  `CLAUDE_CODE_EXTRA_METADATA` env 注入;`oc_` 前缀 = OpenClaude 内部键命名空间,
 *  CCB 自有键 device_id/account_uuid/session_id 永不冲突)。 */
export const OC_ATTR_MODE_KEY = "oc_mode";
export const OC_ATTR_PARENT_SESSION_KEY = "oc_parent_session_id";
export const OC_ATTR_DELEGATE_AGENT_KEY = "oc_delegate_agent_id";
export const OC_ATTR_TURN_KEY = "oc_turn_key";
export const OC_ATTR_PARENT_TURN_KEY = "oc_parent_turn_key";

/**
 * 计费归因(usage_records 落库维度)。
 *
 * - `sessionId`:既有语义不变 —— 引擎原生会话 id(CCB UUID),
 *   用于会话聚合与 pending cost 折叠，**禁止**改成客户端会话 id。
 *   逻辑 turn 免单独立按 turnKey / parentTurnKey 归因。
 * - `mode`:'delegate' 当且仅当 user_id JSON 带 `oc_mode:"delegate"`(gateway 只对
 *   delegate 子会话注入);其余(普通 chat/cron/webhook/未打标旧容器)一律 'chat',
 *   与既有行为逐字节一致。
 * - `parentSessionId`:delegate 所属的父**客户端**会话 id(web-*;父会话不在内存时
 *   退化为容器内部 parentSessionKey,映射链见 gateway server.ts delegate 注入点)。
 * - `delegateAgentId`:委派目标 agent id(hidden-reviewer 同样打标)。
 *
 * 非 delegate 模式下 parent/delegateAgent 强制 null —— 防止客户端只伪造零散键
 * 造成"chat 行挂 delegate 归因"的脏组合。伪造整套 delegate 键的影响面与
 * extractSessionId 相同:只污染伪造者自己的聚合视图(settle SQL 恒 WHERE user_id)。
 */
export interface UsageAttribution {
  sessionId: string | null;
  mode: "chat" | "delegate";
  parentSessionId: string | null;
  delegateAgentId: string | null;
  turnKey: string | null;
  parentTurnKey: string | null;
}

const CHAT_ATTRIBUTION: Omit<UsageAttribution, "sessionId"> = {
  mode: "chat",
  parentSessionId: null,
  delegateAgentId: null,
  turnKey: null,
  parentTurnKey: null,
};

function cleanAttrString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, 256) : null;
}

function cleanTurnKey(v: unknown): string | null {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null;
}

export function extractUsageAttribution(
  metadata: { user_id?: string; session_id?: string } | undefined,
): UsageAttribution {
  // user_id JSON 只 parse 一次,session_id 与归因键同源提取。
  let parsed: Record<string, unknown> | null = null;
  const uid = metadata?.user_id;
  if (typeof uid === "string" && uid.length > 0) {
    try {
      const p: unknown = JSON.parse(uid);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        parsed = p as Record<string, unknown>;
      }
    } catch {
      /* user_id 不是 JSON(普通字符串),正常情况,静默 */
    }
  }

  // session_id:1) 显式顶层优先 2) fallback 从 user_id JSON 提取(语义与旧
  // extractSessionId 逐字节一致)。
  const explicit = metadata?.session_id?.trim();
  const sessionId = explicit
    ? explicit.slice(0, 256)
    : cleanAttrString(parsed?.session_id);

  if (parsed?.[OC_ATTR_MODE_KEY] !== "delegate") {
    return {
      sessionId,
      ...CHAT_ATTRIBUTION,
      turnKey: cleanTurnKey(parsed?.[OC_ATTR_TURN_KEY]),
    };
  }
  return {
    sessionId,
    mode: "delegate",
    parentSessionId: cleanAttrString(parsed[OC_ATTR_PARENT_SESSION_KEY]),
    delegateAgentId: cleanAttrString(parsed[OC_ATTR_DELEGATE_AGENT_KEY]),
    turnKey: cleanTurnKey(parsed[OC_ATTR_TURN_KEY]),
    parentTurnKey: cleanTurnKey(parsed[OC_ATTR_PARENT_TURN_KEY]),
  };
}

/**
 * 把 `metadata.user_id` JSON 里的 `oc_` 前缀内部归因键剥掉后重新序列化。
 *
 * 归因键只服务 master 计费落库,**不该出容器代理**:上游(Ark/DeepSeek/MiniMax
 * 的 Anthropic 兼容端点,或未来任何 OAuth 上游)拿到内部会话拓扑没有任何正当
 * 用途,徒增指纹面。handler 在 extractUsageAttribution 之后、转发上游之前调用。
 *
 * fail-open 口径与 rewriteMetadataDeviceId 对齐:非 JSON / 非 plain object /
 * 无 oc_ 键 → 原值原样返回(零改写,普通 chat 请求字节不变)。
 */
export function stripUsageAttributionKeys(
  userIdStr: string | undefined,
): string | undefined {
  if (!userIdStr) return userIdStr;
  try {
    const parsed: unknown = JSON.parse(userIdStr);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return userIdStr;
    }
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k.startsWith("oc_"));
    if (keys.length === 0) return userIdStr;
    for (const k of keys) delete obj[k];
    return JSON.stringify(obj);
  } catch {
    return userIdStr;
  }
}

/**
 * 把 `metadata.user_id` 这个 SDK 标准字段(CCB 那侧 jsonStringify 的 JSON 串)里的
 * `device_id` 改写为选号账号的 `pinned_user_id`。
 *
 * 反风控背景:CCB 在 `claude-code-best/src/services/api/claude.ts:501` 构造
 * `metadata.user_id = JSON.stringify({device_id, account_uuid, session_id, ...})`,
 * 其中 `device_id` 来自容器内 `~/.claude.json` userID(每个新容器随机生成 64 hex)。
 * 这条字符串随 POST body 直达 Anthropic 网关日志(`metadata` 是 Anthropic SDK 一级
 * 字段)。容器按需短命 → 同一 OAuth account_uuid 关联大量短命 device_id → 典型
 * 号商指纹。
 *
 * 修复策略:在 master 反代层把 device_id 锚定到账号身份(`pinned_user_id`, 0067
 * migration 注入 schema DEFAULT + NOT NULL + CHECK + UNIQUE),让 Anthropic 看到
 * "account_uuid ↔ device_id" 1:1 永久绑定。
 *
 * 行为(fail-open 全部场景保留可用性,不抹掉账号已有的 account_uuid/session_id):
 *   - `userIdStr` 为 undefined/空串 → 返回 `{"device_id": pinnedUserId}` 的最小 JSON
 *   - 合法 JSON plain object → 注入/覆盖 device_id,保留其他字段(account_uuid/session_id/extras)
 *   - 合法 JSON 但非 plain object(数组/primitive)→ 保持原值不动(对齐
 *     `extractSessionId` 既有口径,见本文件 line 311-334)
 *   - 非法 JSON → 保持原值不动(避免把诡异输入推到 Anthropic 网关引发新风控)
 */
export function rewriteMetadataDeviceId(
  userIdStr: string | undefined,
  pinnedUserId: string,
): string {
  if (!userIdStr) {
    return JSON.stringify({ device_id: pinnedUserId });
  }
  try {
    const parsed: unknown = JSON.parse(userIdStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({
        ...(parsed as Record<string, unknown>),
        device_id: pinnedUserId,
      });
    }
    // 不是 plain object(含数组、primitive):保持原值不改
    return userIdStr;
  } catch {
    // 非 JSON:保持原值
    return userIdStr;
  }
}

/**
 * Phase 6 配套:把 `metadata.user_id` 里的 `account_uuid` 重写为该请求选中
 * OAuth account 在 Anthropic 端的真 UUID(0070 migration `claude_accounts.account_uuid`)。
 *
 * 背景:Phase 5 builder 在 pickUpstream 之前跑(input token 估算锁),不知道
 * 哪个 OAuth account 会被选中 → account_uuid 用 HMAC 占位。容器路径里 CCB
 * 写本地 `~/.claude.json` 的 account_uuid 也可能跟 master 后续 pick 选的号
 * 不同号。本 hook 在 master applyUpstreamAuth 选号后统一对齐到真 UUID。
 *
 * **strict 双态(Codex round 1 BLOCKER 1)**:
 *   - `strict=false`(fail_open / off):malformed / 非 object 输入 → 保持原值,
 *     避免把诡异输入推到 Anthropic 网关引发新风控(fail-open 全场景可用性)。
 *     与 `rewriteMetadataDeviceId` 同型。
 *   - `strict=true`(fail_closed):H6 invariant **强保证**,无论客户端发什么
 *     形态都 normalize 到含 account_uuid 的最小 JSON object;malformed / 非
 *     object → 用 `{"account_uuid": pinnedAccountUuid}` 整个替换。这是 fail_closed
 *     语义的关键 — "我们承诺上游永远看到对齐的 account_uuid",字符串层不再
 *     fail-open。容器路径下客户端可能发任意形态 metadata.user_id,
 *     不能因为客户端 misbehavior 就让 H6 漏出。
 *
 * 分支表:
 *
 *   userIdStr      | strict=false (fail_open)              | strict=true (fail_closed)
 *   ---------------+---------------------------------------+---------------------------
 *   undefined/""   | {"account_uuid": pinnedAccountUuid}   | 同 fail_open
 *   JSON object    | spread + 覆盖 account_uuid            | 同 fail_open
 *   JSON array     | 保持原值                              | {"account_uuid": pinnedAccountUuid}
 *   JSON primitive | 保持原值                              | {"account_uuid": pinnedAccountUuid}
 *   非法 JSON      | 保持原值                              | {"account_uuid": pinnedAccountUuid}
 */
export function rewriteMetadataAccountUuid(
  userIdStr: string | undefined,
  pinnedAccountUuid: string,
  strict = false,
): string {
  if (!userIdStr) {
    return JSON.stringify({ account_uuid: pinnedAccountUuid });
  }
  try {
    const parsed: unknown = JSON.parse(userIdStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({
        ...(parsed as Record<string, unknown>),
        account_uuid: pinnedAccountUuid,
      });
    }
    // 非 object JSON(数组 / primitive)— strict 下强 normalize,否则保持原值
    if (strict) {
      return JSON.stringify({ account_uuid: pinnedAccountUuid });
    }
    return userIdStr;
  } catch {
    // 非法 JSON — strict 下强 normalize,否则保持原值
    if (strict) {
      return JSON.stringify({ account_uuid: pinnedAccountUuid });
    }
    return userIdStr;
  }
}

/**
 * canonical UUID(8-4-4-4-12 hex,任意版本)校验。
 *
 * 故意不强制 v4:Anthropic profile.account.uuid 可能用 v1/v5,运行时校验
 * 仅防御明显脏数据(空串/非 UUID 字符串)进入 metadata 重写。回填脚本和
 * applyUpstreamAuth 共用同一正则,语义统一。
 */
export function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * 估算 input token 数(保守口径,宁可高估)。
 *
 * MVP 不引入完整 tokenizer(`@anthropic-ai/tokenizer` 增加依赖体积),用
 * ASCII 4 chars/token、非 ASCII code point 1 token 的保守估算兜底。2026-05-06 移除
 * preCheck ceiling 之后,估算偏大不再导致 402;只影响 PreCheckResult.originalMaxCost
 * 字段值(metric/log 用)和 cap-to-balance 的 capped 标记判定。
 *
 * 该口径与 Moonshot 官方 Kimi Code 客户端的 transient estimate 一致；它用于
 * compaction/preflight，不冒充 provider tokenizer 的精确计数。
 */
export function estimateInputTokens(body: ProxyBody): number {
  let tokens = estimateSerializedTokens(body.messages);
  if (body.system !== undefined) tokens += estimateSerializedTokens(body.system);
  if (body.tools !== undefined) tokens += estimateSerializedTokens(body.tools);
  if (body.stop_sequences !== undefined) tokens += estimateSerializedTokens(body.stop_sequences);
  return tokens;
}

function estimateSerializedTokens(value: unknown): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of JSON.stringify(value)) {
    if (char.codePointAt(0)! <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN_ESTIMATE) + nonAscii;
}

/**
 * Signed execution-window estimate. Vision bodies must not count base64 as
 * text, but they also must not bypass the window gate. Reuse the existing
 * copy-on-write media traversal (including nested tool_result blocks), then
 * charge the same bounded 2k floor per image as CCB. Base64 documents use
 * decoded byte size as a conservative content-linked estimate instead of a
 * flat media floor, so a large PDF cannot look like a single tiny image.
 */
export function estimateContextInputTokens(body: ProxyBody): number {
  const stripped = stripNonTextContentBlocks(body.messages);
  return estimateInputTokens({ ...body, messages: stripped.messages as ProxyBody["messages"] }) +
    stripped.imagesStripped * 2_000 + stripped.documentTokensEstimated;
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
 * v3 反关联根治 — 把账号绑定的 persona 注入 safeHeaders。
 *
 * 调用方:applyUpstreamAuth(upstream.ts)— 持有 PickResult.persona,
 * 在写完 Authorization / anthropic-beta 后调一次,把 stainless 系列头按账号差异化。
 *
 * 行为:
 *   - persona == null:noop(0073 后 0074 NOT NULL 前的窗口 / 测试 mock 场景)
 *   - persona 合法:in-place 写入 9 个键值对(user-agent / x-stainless-* / accept-language)
 *
 * 注意:**不**校验 persona 形状 — 调用方 PickResult.persona 已经走过 0074 CHECK + store
 * 层 schema(0074 后)/runtime assertPersona(必要时)校验。本函数仅做无副作用的 spread。
 */
export function injectPersonaHeaders(
  safeHeaders: Record<string, string>,
  persona: import("../../account-pool/persona.js").Persona | null,
): void {
  if (persona === null) return;
  // 直接 spread —— PersonaToHeaderPairs 已转 kebab-case,这里只 mutate 入参 map
  for (const [k, v] of personaToHeaderPairs(persona)) {
    safeHeaders[k] = v;
  }
}

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

/**
 * 判断上游 4xx body 是不是 Anthropic `invalid_request_error` —— 用户/客户端
 * 输入参数损坏(典型:thinking block signature 不合法 / messages 序列乱)。
 * 这类错误反复重试也只会同样失败,**与账号本身无关**,scheduler 应走 client_error
 * 不扣健康分,避免 boss 自己客户端 bug 反复打到账号 cooldown。
 *
 * Anthropic 错误响应格式:`{ "type": "error", "error": { "type": "...", "message": "..." } }`。
 * 任何解析失败 / 字段缺失视为 false,保守走 failure。
 */
export function isAnthropicInvalidRequestError(bodyPreview: string): boolean {
  if (!bodyPreview) return false;
  try {
    const obj = JSON.parse(bodyPreview);
    const t = obj?.error?.type;
    return typeof t === "string" && t === "invalid_request_error";
  } catch {
    return false;
  }
}

/** True only for an explicit provider-bound history rejection. This narrow
 * predicate gates the one safe retry that removes signed assistant blocks;
 * generic 400s must never trigger a semantically different second request. */
export function isProviderBoundHistoryError(bodyPreview: string): boolean {
  if (!bodyPreview) return false;
  try {
    const obj = JSON.parse(bodyPreview);
    if (obj?.error?.type !== "invalid_request_error") return false;
    const message = obj?.error?.message;
    if (typeof message !== "string") return false;
    const normalized = message.toLowerCase();
    if (normalized.includes("signature")) return true;
    return (
      normalized.includes("thinking") ||
      normalized.includes("redacted_thinking") ||
      normalized.includes("connector_text")
    ) && /invalid|mismatch|not valid/.test(normalized);
  } catch {
    return false;
  }
}

/**
 * 客户端断流识别 —— 仅看 err 形状,**不看** ac.signal.aborted。
 *
 * 理由:我们自己 `res.end()` 完会触发 `res.on('close')` → `ac.abort()`,所以
 * pipe 后 ac.signal.aborted 可能已是 true,如果用 signalAborted 参与判定会把
 * 所有 mid-stream 错误误判成 client abort(Codex v2 review MAJOR)。
 *
 * 真正的客户端断流场景下 err 一定带特征:
 *   - pipeStreamWithUsageCapture 在 signal.aborted 时抛 `ProxyAbortError`
 *   - fetch() 在 signal.aborted 时抛 `Error{name:'AbortError'}` 或 undici
 *     `Error{code:'ABORT_ERR'}`
 * 上游 socket reset / TLS 错 / DNS 抖等 err 形状不会撞这些类型,会归到 fail
 * 路径(扣健康分),与 transient_network 选择正交。
 */
export function isClientAbort(err: unknown): boolean {
  if (err instanceof ProxyAbortError) return true;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    // undici / DOMException 兼容
    if ((err as { code?: string }).code === "ABORT_ERR") return true;
  }
  return false;
}

/**
 * thinking / redacted_thinking block 的 opaque 字段最小启发式长度。
 *
 * **这不是 signature 校验** —— 网关无 HMAC 密钥,无法验证 Anthropic signature
 * 的真实性。本阈值仅用于挡住"明显损坏"的形态(空字符串、缺失、明显截断的伪
 * 值),典型来源:CCB(claude-code-best)`services/api/claude.ts` 在 stream
 * 起步时把 signature 初始化为空串(`signature: ''`),如果上游(例如 DeepSeek
 * anthropic-兼容端点)不发 `signature_delta` 事件,CCB 就把空串持久化进 history。
 *
 * 长但伪造的 signature(例如 DeepSeek 主动塞了 64 字节假签名)本规则**挡不住**,
 * 那种情况 Anthropic 上游会自行拒绝。这是网关层的固有局限,不打算在此模拟
 * 签名学验证。
 */
const MIN_THINKING_OPAQUE_LEN = 16;

/**
 * 在转发到 Anthropic 上游前,从 messages history 里剔除"明显损坏"的 thinking /
 * redacted_thinking block。
 *
 * 触发场景(已观测,日志全量 89 次):用户在同一会话先用 DeepSeek 模型,然后切
 * 回 Claude。CCB 把 DeepSeek 兼容端点回的 assistant message 整条存进 history,
 * 其中 thinking block 的 `signature` 字段是 CCB 默认初始化的空串(DeepSeek 不
 * 可能签 Anthropic HMAC)。CCB 重发整段 history 给 Anthropic,Anthropic 校验
 * 第一条 assistant message 的 thinking signature → 400 invalid_request_error
 * "Invalid signature in thinking block"。
 *
 * 规则(只动 `role === "assistant"` 的 message):
 *   - thinking          : 要求 `signature` 是非空字符串且长度 >= MIN_THINKING_OPAQUE_LEN
 *   - redacted_thinking : 要求 `data` 是非空字符串且长度 >= MIN_THINKING_OPAQUE_LEN
 *   - 其它 type 原样保留
 *   - 一条 assistant message 的 content 在 sanitize 后变空 → 替换为
 *     `[{ type: "text", text: "[thinking block removed]" }]`(Anthropic 拒空
 *     content 数组,且 messages 必须 user/assistant 交替,直接整条删除会触发
 *     另一类 400)
 *
 * **不做的事**:
 *   - 不对 user message 做处理(只清 assistant 历史)
 *   - 不验 signature 真实性(网关无 HMAC 密钥;长伪造由 Anthropic 自拒)
 *   - 不递归进 tool_result / image / 其它 block 内部
 *
 * 性能:大多数 message 走 fast-path 直返原引用;仅在某条 message 实际被改时
 * 才克隆该 message 与外层数组。原 messages 数组与原 message 对象不被 mutate
 * (调用方在 sanitize 后还会读 body / estimateInputTokens 等)。
 */
export function stripMalformedThinkingBlocks(messages: unknown[]): {
  messages: unknown[];
  thinkingStripped: number;
  redactedThinkingStripped: number;
} {
  let thinkingStripped = 0;
  let redactedThinkingStripped = 0;
  let outer: unknown[] | null = null;

  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    let kept: unknown[] | null = null;
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      let drop = false;
      if (isRecord(block)) {
        if (block.type === "thinking") {
          const sig = block.signature;
          if (typeof sig !== "string" || sig.length < MIN_THINKING_OPAQUE_LEN) {
            drop = true;
            thinkingStripped++;
          }
        } else if (block.type === "redacted_thinking") {
          const data = block.data;
          if (typeof data !== "string" || data.length < MIN_THINKING_OPAQUE_LEN) {
            drop = true;
            redactedThinkingStripped++;
          }
        }
      }
      if (drop) {
        if (kept === null) kept = content.slice(0, j);
      } else if (kept !== null) {
        kept.push(block);
      }
    }

    if (kept === null) continue; // 此 message 未改

    // content 全被剔除 → 占位非空 text(空字符串 Anthropic 也可能拒)
    if (kept.length === 0) {
      kept = [{ type: "text", text: "[thinking block removed]" }];
    }
    const newMsg = { ...msg, content: kept };
    if (outer === null) outer = messages.slice();
    outer[i] = newMsg;
  }

  return {
    messages: outer ?? messages,
    thinkingStripped,
    redactedThinkingStripped,
  };
}

/**
 * Provider-bound history sanitizer used only for a bounded recovery retry.
 *
 * Anthropic-style thinking, redacted-thinking and connector-text blocks carry
 * provider/credential-bound opaque signatures. Replaying a block produced by
 * another model or API key is invalid even when the visible history is sound.
 * The same blocks are valid and necessary on ordinary same-provider turns, so
 * callers must not apply this helper pre-emptively: core invokes it only after
 * an explicit upstream signature-invalid response, then retries once.
 * persisted conversation history is never modified.  Text and tool blocks are
 * retained byte-for-byte, and an otherwise empty assistant message receives a
 * plain-text placeholder so the Anthropic-compatible message alternation stays
 * valid.
 */
export function stripProviderBoundAssistantBlocks(messages: unknown[]): {
  messages: unknown[];
  blocksStripped: number;
} {
  let blocksStripped = 0;
  let outer: unknown[] | null = null;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const content = message.content;
    let kept: unknown[] | null = null;
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      const drop =
        isRecord(block) &&
        (block.type === "thinking" ||
          block.type === "redacted_thinking" ||
          block.type === "connector_text");
      if (drop) {
        blocksStripped++;
        if (kept === null) kept = content.slice(0, j);
      } else if (kept !== null) {
        kept.push(block);
      }
    }
    if (kept === null) continue;
    if (kept.length === 0) {
      kept = [{ type: "text", text: "[signed reasoning block omitted]" }];
    }
    if (outer === null) outer = messages.slice();
    outer[i] = { ...message, content: kept };
  }

  return { messages: outer ?? messages, blocksStripped };
}

/**
 * 静态 key **文本 provider**(deepseek / minimax / ark glm-5.1 —— 见
 * @openclaude/protocol STATIC_KEY_PROVIDERS,通篇命名即"文本 provider")的 text-only
 * 输入兜底:把 messages 里的非文本 content block(image / document)就地替换为占位
 * text block,避免第三方 Anthropic 兼容上游对图片/文档输入返回 400。
 *
 * 实测(2026-06-15)ark glm-5.1 Coding Plan 端点对含 image block 的请求返回:
 *   `{"error":{"code":"InvalidParameter","message":"...Model only support text input...",
 *     "type":"BadRequest"}}`
 * → proxy 转译成 502 UPSTREAM_ERROR,且因每个 turn 重放含图历史 → 永久 400 + 重试风暴。
 *
 * 为什么必须放在 proxy 而非 gateway 入站:gateway dispatchInbound 已把"用户**上传**的图"
 * 转成纯文本提示(server.ts "Pass as plain text. No image content blocks"),但图片仍会经
 * **工具结果**(Read 图片文件 / 浏览器截图 / 返图 MCP)进入 CCB 历史 transcript,作为
 * `tool_result.content[]` 内嵌 image block 长期驻留。gateway 入站层看不到工具结果;proxy
 * 是唯一能看到"含历史 tool_result 的完整上游请求体"的权威 chokepoint。
 *
 * 处理面(与 Anthropic content block 形状对齐):
 *   - message.content[] 顶层 image / document        → 替换为占位 text block
 *   - tool_result.content[] 内嵌 image / document     → 同样替换(保留 tool_use_id;
 *     tool_result content 不允许为空,1:1 占位保证非空)
 *   - thinking / text / tool_use / 无内嵌非文本的 tool_result 等 → 原样保留
 *
 * 选择"就地替换为占位"而非"删除":1:1 保证 content 非空、保 tool_result 结构,并让文本
 * 模型明确"此处曾有一张它无法读取的图",而非静默丢上下文。
 *
 * 性能/不变量:copy-on-write —— 无任何非文本块时直返原引用,且不 mutate 入参(调用方在
 * sanitize 后还会读 body / estimateInputTokens 等),与 stripMalformedThinkingBlocks 同构。
 */
export function stripNonTextContentBlocks(messages: unknown[]): {
  messages: unknown[];
  imagesStripped: number;
  documentsStripped: number;
  documentTokensEstimated: number;
} {
  let imagesStripped = 0;
  let documentsStripped = 0;
  let documentTokensEstimated = 0;
  let outer: unknown[] | null = null;

  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  // 非文本 block → 占位 text block(并计数);非非文本 → 返回 null 表示原样保留。
  const placeholderFor = (
    block: Record<string, unknown>,
  ): Record<string, unknown> | null => {
    if (block.type === "image") {
      imagesStripped++;
      return { type: "text", text: "[image omitted: this model accepts text input only]" };
    }
    if (block.type === "document") {
      documentsStripped++;
      const source = isRecord(block.source) ? block.source : null;
      const data = source && typeof source.data === "string" ? source.data : null;
      if (source?.type === "base64" && data) {
        const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
        documentTokensEstimated += Math.max(2_000, Math.floor(data.length * 3 / 4) - padding);
      } else if (data) {
        documentTokensEstimated += Math.max(2_000, estimateSerializedTokens(data));
      } else {
        documentTokensEstimated += 2_000;
      }
      return { type: "text", text: "[document omitted: this model accepts text input only]" };
    }
    return null;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    let kept: unknown[] | null = null; // null = 本 message 尚未改
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      let replacement: unknown = block;
      if (isRecord(block)) {
        const ph = placeholderFor(block);
        if (ph !== null) {
          replacement = ph;
        } else if (block.type === "tool_result" && Array.isArray(block.content)) {
          // 进 tool_result.content 内层(image 最常出现在这里:Read 图片 / 截图工具返图)
          const inner = block.content;
          let innerKept: unknown[] | null = null;
          for (let k = 0; k < inner.length; k++) {
            const sub = inner[k];
            const subPh = isRecord(sub) ? placeholderFor(sub) : null;
            if (subPh !== null) {
              if (innerKept === null) innerKept = inner.slice(0, k);
              innerKept.push(subPh);
            } else if (innerKept !== null) {
              innerKept.push(sub);
            }
          }
          // innerKept 非 null = 内层有替换;占位已保证非空,直接装回。
          if (innerKept !== null) replacement = { ...block, content: innerKept };
        }
      }
      if (replacement !== block) {
        if (kept === null) kept = content.slice(0, j);
        kept.push(replacement);
      } else if (kept !== null) {
        kept.push(block);
      }
    }

    if (kept === null) continue; // 本 message 未改
    const newMsg = { ...msg, content: kept };
    if (outer === null) outer = messages.slice();
    outer[i] = newMsg;
  }

  return {
    messages: outer ?? messages,
    imagesStripped,
    documentsStripped,
    documentTokensEstimated,
  };
}

// ─── handler 接口契约(types only) ────────────────────────────────────────

export interface AnthropicProxyDeps {
  pgPool: Pool;
  pricing: PricingCache;
  preCheckRedis: PreCheckRedis;
  scheduler: AccountScheduler;
  /**
   * 身份层 strategy(2026-05-18 Phase 2 物理切出引入)。
   *
   * 通过 strategy 完成三件事(handler 不再直 import containerIdentity / authzModels /
   * hostReqCounter):
   *   - `resolve(req, ctx)`:容器身份双因子 + post-auth 流量计数(recordHostRequest)
   *   - `authorize(identity, pricing, model)`:role + grants + canUseModel
   *
   * 默认实现见 `makeContainerIdentityStrategy`(auth/proxyIdentity.ts);
   * wiring 在 index.ts 注入。失败模式:IdentityError → 401 / AuthzLoadError → 500 /
   * AuthzDeniedError → 403。
   */
  identity: IdentityStrategy;
  /** identity authorize 与 model-authority gate 共用的 epoch-aware 权威加载器。 */
  loadUserModelAuthz: import("../../auth/userModelAuthz.js").UserModelAuthzLoader;
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
  /**
   * Persist costCredits into master's `client_sessions.messages[i].usage.costCredits`
   * via the storage `appendCostCredits` helper. Called immediately before
   * `broadcastToUser({ type: 'outbound.cost_charged', ... })` — the broadcast is
   * still the in-page fast-path, but persistence is what survives a refresh.
   *
   * Signature is intentionally minimal (just requestId + userId + costCredits) —
   * the storage layer owns the (sessionId, msgId) lookup via
   * `server_authored_request_map`, and falls back to `pending_usage_patches`
   * when the assistant row hasn't been sunk yet. See plan §4.1 改动 3.
   *
   * Failure mode: throw is caught, logged, metric'd; broadcast still fires.
   * Pending GC sweep eventually reports stragglers.
   *
   * Not injected → persistence is a no-op (broadcast still works). deploy
   * must inject; tests MAY omit.
   */
  appendCostCredits?: (
    requestId: string,
    userId: string,
    costCredits: string,
    // agent 引擎会话 id(ccb getSessionId)→ pending.session_id,ccb 助手落库按 session 精确 drain。
    sessionId?: string | null,
    // delegate 子会话的父客户端会话 id(web-*)→ pending.parent_session_id,队长助手行按父会话归并。
    parentSessionId?: string | null,
    delegateAgentId?: string | null,
    turnKey?: string | null,
    parentTurnKey?: string | null,
  ) => Promise<unknown>;
  /**
   * 静态 key 文本 provider(deepseek/minimax/ark)的 key 解析表。
   *
   * 配置时 anthropicProxy 收到 model 命中某 provider matchesRoute 的请求 → forward 到该 provider
   * 上游(spec.upstreamEndpoint),Authorization: Bearer <对应 key>,不占 OAuth 池。
   *
   * 某 provider 未配 key → 命中其模型的请求在 preCheck 前返回 503 +
   * reject reason(STATIC_PROVIDER_META[id].rejectMetricLabel,如 'deepseek_config'/'ark_config')。
   *
   * 各装配点可只注入自己支持的子集:internal proxy 注全(deepseek+minimax+ark),external API-key
   * proxy 只注 deepseek。key 只在 master 进程环境变量中存在,**绝不注入用户容器**,避免商业版用户
   * 通过 shell/日志拿到平台订阅 key。
   *
   * 与 process.env 完全解耦:wiring 在 index.ts 显式从 loadConfig() 取对应字段并注入,proxy 内不读 process.env。
   */
  staticProviderKeys?: StaticProviderKeys;
  /**
   * 模型执行 catalog(模型权威批次 · 方案 §1.2/§4)。**注入 = 本进程参与 catalog 判定**。
   *
   * 装配点(两个进程各持一份,LISTEN 同一 NOTIFY 通道):
   *   - egress/main.ts —— 生产 `/v1/messages` 的独占进程,fence 真正生效的地方;
   *   - index.ts 的 internalProxyHandler —— 非 split 拓扑(dev/测试)。
   *
   * 不注入 → 完全走本批次之前的 legacy 判定(pricing.enabled + matchesRoute),零行为变化。
   */
  modelCatalog?: import("../../billing/modelCatalog.js").ModelCatalogCache;
  /**
   * authority 公钥 keyring 的取数函数(每请求现取 —— 轮换五步里 ring 会变,不能闭包快照)。
   *
   * master 私钥在 ws/authoritySigner.ts;egress 与 master 同机读同一份 keyring 文件,
   * 只取公钥用于**验签**。不注入 → bridge 签名凭据一律拒(fail-closed)。
   */
  authorityKeyring?: () => import("@openclaude/protocol").AuthorityKeyring;
  /**
   * `OC_MODEL_AUTHORITY=1`(方案 §7 步 4)。
   *
   * - false(默认)= **影子期**:catalog 判定照跑并与 legacy 判定对比打日志(零漂移锚),
   *   但拒绝权仍在 legacy —— 部署 catalog 基建不改变任何用户可见行为(§7 步 2);
   * - true = **强制**:每请求 epoch fence + authority 校验 + provider_id 驱动路由,
   *   无凭据/漂移/不可路由一律拒。
   */
  modelAuthorityEnforce?: boolean;
  /**
   * Phase 5 platform envelope rewriter(2026-05-21,取代 Phase 7 v1 envelope)。
   *
   * 在外接 ApiKey 路径 + OAuth 上游双重命中时,把 outbound body 改写成 CC 容器
   * 形态(强制 system[0]/[1] + PII strip + 注入 USER.md attribution +
   * 替换 messages[0] system-reminder + metadata.user_id 收紧到 3 key)。
   *
   * 见 packages/commercial/src/platform/platformEnvelopeBuilder.ts 与
   * docs/V3_CC_EXTERNAL_ENDPOINT_PHASE5_PLAN_2026-05-21.md §3。
   *
   * **Optional** 而非 required:internal proxy(容器双因子)永远 `containerId !== null`,
   * 触发条件不命中,装配时不需要给。但 external ApiKey proxy 装配必须两个都给齐 —
   * 缺其一时 handler 在触发条件命中时 fail-closed 503,避免 silent skip 透传 PII。
   * 两个字段 atomic 共生:有 loader 必须有 secret,反之亦然(运行时 check)。
   */
  platformContextLoader?: PlatformContextLoader;
  /**
   * HMAC server secret(Phase 5 envelope rewriter)。
   *
   * 派生 fp3(3 hex char)+ account_uuid(UUID v4 from HMAC),用 sha256;同一 secret
   * 必须跨多 master 一致,否则同一 ApiKey 在不同 master 上派生出不同指纹 → Anthropic
   * anti-abuse 看到漂移 → 整池 429。≥ 32 字符长度。生产由 systemd EnvironmentFile 注入。
   */
  platformServerSecret?: Buffer | string;
  /**
   * Phase 6 — `account_uuid` 锚定执行模式(0070 migration + plan §3.0)的运行时 getter。
   *
   *   - `off`(默认):applyUpstreamAuth hook 完全早退,builder HMAC 占位透出
   *     (Phase 5 行为,deploy 1 默认值)
   *   - `fail_open`:hook 重写;pick.account_uuid 为 null(回填未跑完)时跳过
   *   - `fail_closed`:scheduler 过滤掉 null 候选 + hook 强制重写;池空 → 503
   *
   * v1.0.207 起 wiring 从 `system_settings.phase6_account_uuid_enforce` 读取(admin UI
   * 立即可改),通过 `admin/runtimeFlags.ts` 的 30s TTL cache 包装。pickUpstream 入口
   * await 一次后冻结到局部常量,scheduler.pick 与 hook 闭包同值消费,保留 plan §5.5.4
   * 的竞态防护设计。getter 为 undefined → pickUpstream 兜底 "off"。
   */
  getPhase6AccountUuidEnforce?: () => Promise<"off" | "fail_open" | "fail_closed">;
  /**
   * v3 反关联根治 — chat_session_account_pin 三态执行模式的运行时 getter。
   *
   *   - `off`(默认):scheduler 走旧 WRH 路径,不查/不写 csap
   *   - `observe`:    跑 WRH + 观察 pin 一致性打点(metric `session_pin_observe`),不写 csap
   *   - `enforce`:    pin 命中 sticky;pin unbound 抛 409;pin miss 走"既往足迹优先"+ race-safe INSERT
   *
   * v1.0.207 起从 `system_settings.session_pin_mode` 读取(admin UI 立即可改),
   * 30s TTL cache。灰度路线 off → observe(收集 metric)→ enforce。
   */
  getSessionPinMode?: () => Promise<import("../../account-pool/scheduler.js").SessionPinMode>;
  /** Optional group resolver for official_oauth+claude routing. */
  listEnabledAccountGroupsForModel?: (args: {
    modelId: string;
    kind?: import("../../account-pool/groups.js").AccountGroupKind;
    provider?: import("../../account-pool/groups.js").AccountGroupProvider;
  }) => Promise<import("../../account-pool/groups.js").AccountGroupRow[]>;
}

/**
 * 身份定位上下文。两条路径的来源不同,由 caller 决定:
 *   - self-host(plaintext 18791 listener):hostUuid = 进程级 SELF_HOST_UUID,
 *     boundIp = socket.remoteAddress(docker bridge 上的容器 IP)
 *   - remote-host(mTLS 18443 listener):hostUuid 从 client cert SAN URI 解出
 *     (`verifyIncomingHostCert` helper),boundIp 从 `X-V3-Container-IP` 头取
 *     (node-agent L7 反代层注入,容器不可伪造)
 *
 * 见 docs/v3/D1-plan-draft.md。
 */
export interface AnthropicProxyIdentityCtx {
  hostUuid: string;
  boundIp: string;
}

export interface AnthropicProxyHandler {
  (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: AnthropicProxyIdentityCtx,
  ): Promise<void>;
}

// ─── 小工具:body 读 + JSON parse(带上限) ──────────────────────────────

export async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
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
//
// V3 Phase 4(2026-05-18):从 anthropicProxy.ts 内部 `sendJsonError` 提升 export。
// proxy/core.ts 错误响应路径需要复用同一份(buildSafeUpstreamHeaders throw、
// upstream 4xx/5xx 透译、catch-all 500 等),避免双份实现导致响应格式漂移。

export function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
  extraHeaders?: Record<string, string>,
  /**
   * 嵌入到 `error` object 内部的额外字段(例如 v3 session_pin_unbound 的
   * `retry_strategy='force_repin'`,session_pin_temporarily_unavailable 的
   * `retry_after_ms` / `fallback_strategy`)。客户端用这些 hint 实现"无 UI 自动闭环"。
   *
   * 默认 undefined → body 形如旧契约 `{ error: { code, message }, request_id }`。
   */
  extraErrorFields?: Record<string, unknown>,
): void {
  if (res.headersSent) return;
  const errorBody: Record<string, unknown> = { code, message };
  if (extraErrorFields) Object.assign(errorBody, extraErrorFields);
  const body = JSON.stringify({
    error: errorBody,
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
