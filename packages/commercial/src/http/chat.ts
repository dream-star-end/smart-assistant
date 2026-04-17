/**
 * T-23 骨架 → T-41 接真 Claude。
 *
 * POST /api/chat — 非流式:内部跑完整个 SSE stream,把 delta 聚合成一段文本,再一次性返回。
 *
 * 流程:
 *   1. requireAuth → user
 *   2. 读 body: { model, max_tokens, messages }
 *   3. preCheck → Redis 预扣 + 余额校验(余额不足 → 402)
 *   4. 调 deps.chatLLM(默认 stub;生产注入 `createChatLLMFromRunChat(chatDeps)` 走真 Claude)
 *   5. success → tx 内 debitChatSuccess(users ↓ + credit_ledger + usage_records 原子落库)
 *      非 success → recordChatError 只写一行 usage_records(status='error', 不扣费)
 *   6. finally:释放 Redis 预扣
 *
 * 为什么 usage_records 在扣费事务内一起写(见 chat/debit.ts 注释):
 *   - `usage_records.ledger_id` 需要刚 INSERT 的 credit_ledger.id
 *   - 两边一起写保证"有 ledger 的 usage 必能追回,反之 usage.status=error 绝不扣费"
 *   - 失败的 LLM 也要写 usage_records(审计用),但不进事务
 *
 * T-41 对比 T-40 WS 的差异:仅响应形态,业务语义(preCheck/扣费/错误审计)完全一致。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./util.js";
import { requireAuth } from "./auth.js";
import { tx } from "../db/queries.js";
import { computeCost, type TokenUsage } from "../billing/calculator.js";
import {
  preCheck,
  releasePreCheck,
  InsufficientCreditsError as PreCheckInsufficientError,
  type PreCheckRedis,
} from "../billing/preCheck.js";
import {
  debitChatSuccess,
  recordChatError,
  InsufficientCreditsAfterPreCheckError,
  UserGoneError,
  RequestRetryWithDifferentResultError,
  DuplicateRequestError,
} from "../chat/debit.js";
import { runClaudeChat, type RunChatDeps } from "../chat/orchestrator.js";
import type { CommercialHttpDeps, RequestContext } from "./handlers.js";

export interface ChatBody {
  model: string;
  max_tokens: number;
  messages: unknown[];
}

/** LLM 调用抽象。真实接入(T-40)会替换这个。 */
export interface ChatLLM {
  /**
   * @returns usage + 完成状态。LLM 异常时 `status='error'`,调用方据此决定不扣费。
   *          LLM 自身的 HTTP 错误应映射到 status='error' 而非 throw(否则 catch 逻辑变复杂)。
   */
  complete(req: {
    userId: bigint;
    requestId: string;
    model: string;
    maxTokens: number;
    messages: unknown[];
  }): Promise<{
    usage: TokenUsage;
    status: "success" | "error";
    error?: { code: string; message: string };
    /** 扣费使用的 account_id(外键 claude_accounts.id);stub 可填 null */
    accountId?: bigint | number | null;
    /** 可选:回传给前端的文本(真实接入后是 stream chunks) */
    text?: string;
  }>;
}

/**
 * stub LLM:固定返回 1000 in / 500 out token,便于集成测试验证扣费正确。
 * 生产请注入真 LLM(`createChatLLMFromRunChat(chatDeps)`)。
 */
export const stubChatLLM: ChatLLM = {
  async complete({ maxTokens }) {
    // 特殊指令:maxTokens = 999_999 → 模拟 LLM 失败(测试 "不扣费" 路径)
    if (maxTokens === 999_999) {
      return { usage: { input_tokens: 0n, output_tokens: 0n, cache_read_tokens: 0n, cache_write_tokens: 0n },
        status: "error", error: { code: "UPSTREAM_FAIL", message: "simulated LLM failure" },
        accountId: null, text: "" };
    }
    return {
      usage: { input_tokens: 1000n, output_tokens: 500n, cache_read_tokens: 0n, cache_write_tokens: 0n },
      status: "success",
      accountId: null,
      text: "[stub] ok",
    };
  },
};

/**
 * T-41 — 把 `runClaudeChat`(AsyncGenerator)包装成 `ChatLLM.complete` 签名。
 *
 * 非流式语义:消费整条事件流,把 delta 累加成一段 text,取最后 `usage` 事件,
 * 成功/失败映射到 `status`。`error` 事件的 code/message 原样透传给 http 层,
 * 便于前端区分 `ERR_UPSTREAM` / `ERR_ACCOUNT_POOL_UNAVAILABLE` 等。
 *
 * 与 ws/chat.ts 的差异:WS 逐帧转发 delta,REST 累加后一次返回。两者共用
 * 同一个 orchestrator + 同一个 `debitChatSuccess`,避免双入口语义漂移。
 */
export function createChatLLMFromRunChat(deps: RunChatDeps): ChatLLM {
  return {
    async complete({ userId, requestId, model, maxTokens, messages }) {
      let text = "";
      let usage: TokenUsage | null = null;
      let accountId: bigint | null = null;
      let errorFrame: { code: string; message: string } | null = null;
      try {
        for await (const ev of runClaudeChat(
          {
            userId,
            mode: "chat",
            model,
            messages,
            max_tokens: maxTokens,
          },
          deps,
        )) {
          switch (ev.type) {
            case "meta": {
              accountId = ev.account_id;
              break;
            }
            case "delta": {
              text += ev.text;
              break;
            }
            case "usage": {
              usage = {
                input_tokens: BigInt(ev.usage.input_tokens),
                output_tokens: BigInt(ev.usage.output_tokens),
                cache_read_tokens: BigInt(ev.usage.cache_read_tokens),
                cache_write_tokens: BigInt(ev.usage.cache_write_tokens),
              };
              break;
            }
            case "error": {
              errorFrame = { code: ev.code, message: ev.message };
              break;
            }
            case "done":
              break;
          }
        }
      } catch (err) {
        errorFrame = {
          code: "ERR_INTERNAL",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      // 先看错误:orchestrator 不会同时 yield usage+error(error 之后就 return)
      if (errorFrame) {
        return {
          usage: zeroUsage(),
          status: "error",
          error: errorFrame,
          accountId,
          text,
        };
      }
      if (!usage) {
        // 理论上不该:orchestrator 的 done 前必 yield usage。但 orchestrator 的 done 也
        // 可能因调用方取消而没跑到 → 记成 error 防止 REST 把 0 usage 当 success 扣 0 费。
        return {
          usage: zeroUsage(),
          status: "error",
          error: { code: "ERR_INTERNAL", message: "usage event missing before stream end" },
          accountId,
          text,
        };
      }
      return { usage, status: "success", accountId, text };
    },
  };
}

function zeroUsage(): TokenUsage {
  return {
    input_tokens: 0n,
    output_tokens: 0n,
    cache_read_tokens: 0n,
    cache_write_tokens: 0n,
  };
}

function parseChatBody(b: unknown): ChatBody {
  if (!b || typeof b !== "object") {
    throw new HttpError(400, "VALIDATION", "body must be JSON object");
  }
  const rec = b as Record<string, unknown>;
  const model = typeof rec.model === "string" ? rec.model : "";
  const maxTokens = typeof rec.max_tokens === "number" ? rec.max_tokens : 0;
  const messages = Array.isArray(rec.messages) ? rec.messages : [];
  if (model.length === 0) throw new HttpError(400, "VALIDATION", "model is required");
  if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > 1_000_000) {
    throw new HttpError(400, "VALIDATION", "max_tokens must be integer in (0, 1_000_000]");
  }
  if (messages.length === 0) throw new HttpError(400, "VALIDATION", "messages is required and non-empty");
  return { model, max_tokens: maxTokens, messages };
}

/**
 * POST /api/chat handler。依赖(preCheck redis / pricing / ChatLLM)从 deps 读。
 */
export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps & { preCheckRedis?: PreCheckRedis; chatLLM?: ChatLLM },
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  if (!deps.pricing) {
    throw new HttpError(503, "PRICING_NOT_READY", "pricing cache not initialized");
  }
  if (!deps.preCheckRedis) {
    throw new HttpError(503, "PRECHECK_NOT_READY", "precheck redis not configured");
  }
  const llm = deps.chatLLM ?? stubChatLLM;

  const body = parseChatBody(await readJsonBody(req));
  const modelPricing = deps.pricing.get(body.model);
  if (!modelPricing || !modelPricing.enabled) {
    throw new HttpError(400, "UNKNOWN_MODEL", `model not available: ${body.model}`);
  }

  // 1) 预检
  let lockKey: string;
  try {
    const pc = await preCheck(deps.preCheckRedis, {
      userId: user.id,
      requestId: ctx.requestId,
      model: body.model,
      maxTokens: body.max_tokens,
      pricing: deps.pricing,
    });
    lockKey = pc.lockKey;
  } catch (err) {
    if (err instanceof PreCheckInsufficientError) {
      // 04-API §5 规定:余额不足 402 PAYMENT_REQUIRED
      throw new HttpError(402, "ERR_INSUFFICIENT_CREDITS",
        `insufficient credits: balance=${err.balance} required=${err.required}`,
        { issues: [{ path: "shortfall", message: err.shortfall.toString() }] });
    }
    throw err;
  }

  try {
    // 2) 调 LLM(mock / 真接入)
    const llmResp = await llm.complete({
      userId: BigInt(user.id),
      requestId: ctx.requestId,
      model: body.model,
      maxTokens: body.max_tokens,
      messages: body.messages,
    });

    if (llmResp.status === "error") {
      // 不扣费:只写 usage_records(审计)。共用 recordChatError 保证和 WS 结构一致
      await recordChatError({
        userId: user.id,
        requestId: ctx.requestId,
        sessionId: null,
        mode: "chat",
        accountId: llmResp.accountId ?? null,
        model: body.model,
        priceSnapshot: {
          model_id: modelPricing.model_id,
          display_name: modelPricing.display_name,
          input_per_mtok: modelPricing.input_per_mtok.toString(),
          output_per_mtok: modelPricing.output_per_mtok.toString(),
          cache_read_per_mtok: modelPricing.cache_read_per_mtok.toString(),
          cache_write_per_mtok: modelPricing.cache_write_per_mtok.toString(),
          multiplier: modelPricing.multiplier,
          captured_at: new Date().toISOString(),
        },
        errorMessage: llmResp.error?.message ?? "unknown",
      });
      // 映射到上游:LLM 错一般 502,除非是认证相关(这里 stub 固定 502)
      throw new HttpError(502, llmResp.error?.code ?? "UPSTREAM_ERROR",
        llmResp.error?.message ?? "upstream LLM error");
    }

    // 3) 成功 → 事务内 debit + 写 usage_records(复用 chat/debit.ts)
    const cost = computeCost(llmResp.usage, modelPricing);
    let result;
    try {
      result = await tx(async (client) =>
        debitChatSuccess(client, {
          userId: user.id,
          requestId: ctx.requestId,
          sessionId: null,
          mode: "chat",
          accountId: llmResp.accountId ?? null,
          model: body.model,
          usage: llmResp.usage,
          cost,
        }),
      );
    } catch (err) {
      // LLM 已消耗但本地结算失败 —— 审计链断点。补一条 billing_failed 的 usage_records,
      // 让 reconcile 脚本能发现"上游已扣但本地没扣" 的异常。
      // 注意幂等:status='billing_failed' 是第一条也是唯一一条(uniq_ur_request 拦截 retry)。
      // RequestRetryWithDifferentResultError / DuplicateRequestError 本身就意味着
      // 之前已写过 usage_records —— 重复写只会再撞 23505,recordChatError 内会 swallow。
      if (
        !(err instanceof UserGoneError) &&
        !(err instanceof InsufficientCreditsAfterPreCheckError) &&
        !(err instanceof RequestRetryWithDifferentResultError) &&
        !(err instanceof DuplicateRequestError)
      ) {
        try {
          await recordChatError({
            userId: user.id,
            requestId: ctx.requestId,
            sessionId: null,
            mode: "chat",
            accountId: llmResp.accountId ?? null,
            model: body.model,
            priceSnapshot: cost.snapshot,
            errorMessage: err instanceof Error ? err.message : String(err),
            status: "billing_failed",
            usage: llmResp.usage,
            costCredits: cost.cost_credits,
          });
        } catch { /* best-effort,别盖掉原始 err */ }
      }
      throw err;
    }

    sendJson(res, 200, {
      ok: true,
      request_id: ctx.requestId,
      usage: {
        input_tokens: Number(llmResp.usage.input_tokens),
        output_tokens: Number(llmResp.usage.output_tokens),
        cache_read_tokens: Number(llmResp.usage.cache_read_tokens),
        cache_write_tokens: Number(llmResp.usage.cache_write_tokens),
      },
      cost_credits: cost.cost_credits.toString(),
      balance_after: result.balance_after.toString(),
      ledger_id: result.ledger_id,
      usage_record_id: result.usage_record_id,
      text: llmResp.text ?? "",
    });
  } catch (err) {
    // 事务内 debit 余额不足(和 preCheck 不一致的极端情况 - admin_adjust 把预扣之后的余额扣穿)
    if (err instanceof InsufficientCreditsAfterPreCheckError) {
      throw new HttpError(402, "ERR_INSUFFICIENT_CREDITS", err.message);
    }
    if (err instanceof UserGoneError) {
      throw new HttpError(401, "UNAUTHORIZED", "user not found");
    }
    // 客户端用同一个 request_id 重试了一个先前失败的请求:按 04-API 错误
    // 合同映射到 409 CONFLICT,让客户端知道需换 request_id
    if (err instanceof RequestRetryWithDifferentResultError) {
      throw new HttpError(409, "ERR_REQUEST_ID_EXHAUSTED", err.message);
    }
    if (err instanceof DuplicateRequestError) {
      throw new HttpError(409, "ERR_DUPLICATE_REQUEST", err.message);
    }
    throw err;
  } finally {
    // 4) 无论成功/失败,释放预扣。LLM 超时 → TTL 5min 后自动清,这里是 best-effort
    try { await releasePreCheck(deps.preCheckRedis, lockKey); }
    catch { /* ignore — best-effort */ }
  }
}
