/**
 * T-40 — Chat 扣费 + usage_records 写入的公用事务帮助。
 *
 * 为什么单独抽出来:/api/chat(T-41 非流式)和 /ws/chat(T-40b 流式)都要做同样的事:
 *   - 拿到 LLM 的 TokenUsage + 定价快照
 *   - 在同一事务里 SELECT FOR UPDATE + UPDATE users.credits + INSERT credit_ledger + INSERT usage_records
 *   - 失败(非 success)只 INSERT usage_records status='error',不进事务
 *
 * 复制一份到 ws/chat.ts 不难,但容易漂移(两个入口做不同的扣费语义 = 审计恶梦),
 * 所以抽这一层。调用约定:pricing 和 cost 都在外头算好,本模块只管落库。
 *
 * 为什么不直接用 ledger.debit():
 *   - ledger.debit 不知道 usage 结构,没法把 usage_records.ledger_id 挂上
 *   - 把两表写入解耦会让"有 ledger 的 usage 必能追回,反之 usage.status=error 绝不扣费"
 *     这条审计约束飘掉(参见 http/chat.ts 注释)
 *
 * 这里只提供 *在事务内* 的纯操作函数,事务 open/commit 由调用方 tx() 负责。
 */
import type { PoolClient } from "pg";
import type { CostResult, TokenUsage } from "../billing/calculator.js";
import { query } from "../db/queries.js";

export class InsufficientCreditsAfterPreCheckError extends Error {
  readonly code = "ERR_INSUFFICIENT_CREDITS" as const;
  readonly balance: bigint;
  readonly cost: bigint;
  constructor(balance: bigint, cost: bigint) {
    super(`insufficient credits after precheck: balance=${balance} cost=${cost}`);
    this.name = "InsufficientCreditsAfterPreCheckError";
    this.balance = balance;
    this.cost = cost;
  }
}

export class UserGoneError extends Error {
  readonly code = "ERR_USER_GONE" as const;
  constructor() {
    super("user row not found when debiting");
    this.name = "UserGoneError";
  }
}

export interface DebitChatSuccessInput {
  userId: string | bigint;
  requestId: string;
  sessionId?: string | null;
  mode: "chat" | "agent";
  /** 账号池账号 id,来自 scheduler.pick() 的结果 */
  accountId?: bigint | number | null;
  model: string;
  usage: TokenUsage;
  cost: CostResult;
}

export interface DebitChatSuccessResult {
  balance_after: bigint;
  ledger_id: string;
  usage_record_id: string;
}

/**
 * 成功场景:事务内 debit + INSERT usage_records。调用方需在 tx(client => debitChatSuccess(client, ...)) 内调用。
 *
 * 并发语义:SELECT FOR UPDATE 锁 users 行,阻塞其他同用户事务直到本事务结束。
 *
 * 抛错:
 *   - UserGoneError(用户被 ban/delete)→ 调用方映射 401
 *   - InsufficientCreditsAfterPreCheckError → 调用方映射 402(预检期余额被 admin_adjust 扣穿)
 */
export async function debitChatSuccess(
  client: PoolClient,
  input: DebitChatSuccessInput,
): Promise<DebitChatSuccessResult> {
  const balRow = await client.query<{ credits: string }>(
    "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
    [input.userId],
  );
  if (balRow.rows.length === 0) throw new UserGoneError();
  const balance = BigInt(balRow.rows[0].credits);
  if (balance < input.cost.cost_credits) {
    throw new InsufficientCreditsAfterPreCheckError(balance, input.cost.cost_credits);
  }
  const newBalance = balance - input.cost.cost_credits;
  await client.query(
    "UPDATE users SET credits = $1 WHERE id = $2",
    [newBalance.toString(), input.userId],
  );
  const ledgerRow = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger
      (user_id, delta, balance_after, reason, ref_type, ref_id, memo)
     VALUES ($1, $2, $3, $4, 'request', $5, NULL)
     RETURNING id::text AS id`,
    [
      input.userId,
      (-input.cost.cost_credits).toString(),
      newBalance.toString(),
      input.mode,
      input.requestId,
    ],
  );
  const ledgerId = ledgerRow.rows[0].id;
  const usageRow = await client.query<{ id: string }>(
    `INSERT INTO usage_records
      (user_id, session_id, mode, account_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       price_snapshot, cost_credits, ledger_id, request_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, 'success')
     RETURNING id::text AS id`,
    [
      input.userId,
      input.sessionId ?? null,
      input.mode,
      input.accountId ?? null,
      input.model,
      BigInt(input.usage.input_tokens).toString(),
      BigInt(input.usage.output_tokens).toString(),
      BigInt(input.usage.cache_read_tokens).toString(),
      BigInt(input.usage.cache_write_tokens).toString(),
      JSON.stringify(input.cost.snapshot),
      input.cost.cost_credits.toString(),
      ledgerId,
      input.requestId,
    ],
  );
  return {
    balance_after: newBalance,
    ledger_id: ledgerId,
    usage_record_id: usageRow.rows[0].id,
  };
}

export interface RecordChatErrorInput {
  userId: string | bigint;
  requestId: string;
  sessionId?: string | null;
  mode: "chat" | "agent";
  accountId?: bigint | number | null;
  model: string;
  /** 即便 LLM 失败,也要记录已有的 price snapshot 便于排查定价问题 */
  priceSnapshot: unknown;
  errorMessage: string;
}

/**
 * 失败场景:只 INSERT usage_records,不扣费。不必在事务内,独立连接即可。
 *
 * 为什么不在事务里:失败路径不涉及 users.credits / credit_ledger,单表 insert 不需要隔离级别保护,
 * 而且失败路径常常已经发生在别的地方(超时、网络抖),尽量减少被连累的操作。
 */
export async function recordChatError(
  input: RecordChatErrorInput,
): Promise<void> {
  await query(
    `INSERT INTO usage_records
      (user_id, session_id, mode, account_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       price_snapshot, cost_credits, ledger_id, request_id, status, error_msg)
     VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 0, $6::jsonb, 0, NULL, $7, 'error', $8)`,
    [
      input.userId,
      input.sessionId ?? null,
      input.mode,
      input.accountId ?? null,
      input.model,
      JSON.stringify(input.priceSnapshot),
      input.requestId,
      input.errorMessage,
    ],
  );
}
