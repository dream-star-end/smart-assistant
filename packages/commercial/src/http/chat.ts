/**
 * T-23 — POST /api/chat 骨架。
 *
 * 关键点:**这里不接真 Claude**。真实上游走 Gateway 的 `/v1/messages`(bedrock/anthropic/etc),
 * 由 T-40/T-41 去接。本路由只做:
 *   1. requireAuth → user
 *   2. 读 body: { model, max_tokens, messages }(messages 仅透传验证结构,本 stub 不真正调 LLM)
 *   3. preCheck → Redis 预扣 + 余额校验(余额不足 → 402)
 *   4. 调 deps.chatLLM(mockable):返回 `{ usage: TokenUsage, status: 'success'|'error', error? }`
 *   5. success → computeCost + tx 内 debit + INSERT usage_records(ledger_id 挂上)
 *      非 success → 只 INSERT usage_records(status='error', cost_credits=0,不扣费)
 *   6. finally:释放 Redis 预扣
 *
 * 为什么 usage_records 在扣费事务内一起写:
 *   - `usage_records.ledger_id` 需要刚 INSERT 的 credit_ledger.id
 *   - 两边一起写保证"有 ledger 的 usage 必能追回,反之 usage.status=error 绝不扣费"
 *   - 失败的 LLM 也要写 usage_records(审计用),但不进事务:即使 debit 失败(不发生),
 *     usage 行也要落地
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./util.js";
import { requireAuth } from "./auth.js";
import { query, tx } from "../db/queries.js";
import { debit, InsufficientCreditsError as LedgerInsufficientError } from "../billing/ledger.js";
import { computeCost, type TokenUsage } from "../billing/calculator.js";
import {
  preCheck,
  releasePreCheck,
  InsufficientCreditsError as PreCheckInsufficientError,
  type PreCheckRedis,
} from "../billing/preCheck.js";
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
 * 生产请注入真 LLM(T-40 接 Claude)。
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
      // 不扣费:只写 usage_records(审计);cost_credits=0,ledger_id=null
      await query(
        `INSERT INTO usage_records
          (user_id, session_id, mode, account_id, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           price_snapshot, cost_credits, ledger_id, request_id, status, error_msg)
         VALUES ($1, NULL, 'chat', $2, $3, 0, 0, 0, 0, $4::jsonb, 0, NULL, $5, 'error', $6)`,
        [
          user.id,
          llmResp.accountId ?? null,
          body.model,
          JSON.stringify({
            model_id: modelPricing.model_id,
            display_name: modelPricing.display_name,
            input_per_mtok: modelPricing.input_per_mtok.toString(),
            output_per_mtok: modelPricing.output_per_mtok.toString(),
            cache_read_per_mtok: modelPricing.cache_read_per_mtok.toString(),
            cache_write_per_mtok: modelPricing.cache_write_per_mtok.toString(),
            multiplier: modelPricing.multiplier,
            captured_at: new Date().toISOString(),
          }),
          ctx.requestId,
          llmResp.error?.message ?? "unknown",
        ],
      );
      // 映射到上游:LLM 错一般 502,除非是认证相关(这里 stub 固定 502)
      throw new HttpError(502, llmResp.error?.code ?? "UPSTREAM_ERROR",
        llmResp.error?.message ?? "upstream LLM error");
    }

    // 3) 成功 → 事务内 debit + 写 usage_records
    const cost = computeCost(llmResp.usage, modelPricing);
    const result = await tx(async (client) => {
      // 手动 SELECT FOR UPDATE + INSERT(和 debit() 逻辑一致,但要把 usage_records 塞进来)
      const balRow = await client.query<{ credits: string }>(
        "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
        [user.id],
      );
      if (balRow.rows.length === 0) throw new HttpError(401, "UNAUTHORIZED", "user gone");
      const balance = BigInt(balRow.rows[0].credits);
      if (balance < cost.cost_credits) {
        // 超卖(极少见:预检后 admin_adjust 扣走,或并发预检 < TTL)
        throw new HttpError(402, "ERR_INSUFFICIENT_CREDITS",
          `insufficient credits after precheck: balance=${balance} cost=${cost.cost_credits}`);
      }
      const newBalance = balance - cost.cost_credits;
      await client.query(
        "UPDATE users SET credits = $1 WHERE id = $2",
        [newBalance.toString(), user.id],
      );
      const ledgerRow = await client.query<{ id: string }>(
        `INSERT INTO credit_ledger
          (user_id, delta, balance_after, reason, ref_type, ref_id, memo)
         VALUES ($1, $2, $3, 'chat', 'request', $4, NULL)
         RETURNING id::text AS id`,
        [user.id, (-cost.cost_credits).toString(), newBalance.toString(), ctx.requestId],
      );
      const ledgerId = ledgerRow.rows[0].id;
      const usageRow = await client.query<{ id: string }>(
        `INSERT INTO usage_records
          (user_id, session_id, mode, account_id, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           price_snapshot, cost_credits, ledger_id, request_id, status)
         VALUES ($1, NULL, 'chat', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, 'success')
         RETURNING id::text AS id`,
        [
          user.id,
          llmResp.accountId ?? null,
          body.model,
          BigInt(llmResp.usage.input_tokens).toString(),
          BigInt(llmResp.usage.output_tokens).toString(),
          BigInt(llmResp.usage.cache_read_tokens).toString(),
          BigInt(llmResp.usage.cache_write_tokens).toString(),
          JSON.stringify(cost.snapshot),
          cost.cost_credits.toString(),
          ledgerId,
          ctx.requestId,
        ],
      );
      return {
        balance_after: newBalance,
        ledger_id: ledgerId,
        usage_record_id: usageRow.rows[0].id,
      };
    });

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
    // 保险:事务内的 ledger debit 余额不足(和 preCheck 不一致的极端情况)
    if (err instanceof LedgerInsufficientError) {
      throw new HttpError(402, "ERR_INSUFFICIENT_CREDITS", err.message);
    }
    throw err;
  } finally {
    // 4) 无论成功/失败,释放预扣。LLM 超时 → TTL 5min 后自动清,这里是 best-effort
    try { await releasePreCheck(deps.preCheckRedis, lockKey); }
    catch { /* ignore — best-effort */ }
  }
}
