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

/** Postgres unique_violation SQLSTATE(参见 0009_chat_idempotency.sql)。 */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

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
 * 幂等(0009_chat_idempotency.sql):client 透传同一 request_id 重放时,事务开始处先
 * 查 usage_records —— 命中就按命中结果返回,不再做第二次扣费。这里没走"乐观 INSERT
 * + 捕 23505"的路径是为了避免重放时先 UPDATE users 再回滚(事务在 FOR UPDATE 之后
 * 每一次 UPDATE 都会 WAL,多实例高并发下白白造大量 WAL 和 rollback 噪音)。
 *
 * 抛错:
 *   - UserGoneError(用户被 ban/delete)→ 调用方映射 401
 *   - InsufficientCreditsAfterPreCheckError → 调用方映射 402(预检期余额被 admin_adjust 扣穿)
 *   - RequestRetryWithDifferentResultError → 同 request_id 但之前结果是 error/billing_failed
 *     → 客户端必须用新 request_id 重试,不能复用已失败的那个
 */
export async function debitChatSuccess(
  client: PoolClient,
  input: DebitChatSuccessInput,
): Promise<DebitChatSuccessResult> {
  // 幂等检查:如果这个 request_id 已有 usage_records,按它的结果返回。
  // 这里不 FOR UPDATE —— uniq_ur_request 约束保证插入互斥,只读足够。
  const existing = await client.query<{
    id: string;
    status: string;
    ledger_id: string | null;
  }>(
    "SELECT id::text AS id, status, ledger_id::text AS ledger_id FROM usage_records WHERE request_id = $1",
    [input.requestId],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.status !== "success" || row.ledger_id === null) {
      // 前一次尝试失败(LLM 错 / billing_failed)。客户端若想重试必须换 request_id,
      // 否则无法区分"重试成功"与"客户端 buggy 地重用失败的 id"。
      throw new RequestRetryWithDifferentResultError(row.status);
    }
    // 成功路径:拿用户当前余额返回(balance_after 对调用方已不关键,但 API 合同不能变)
    const cur = await client.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1",
      [input.userId],
    );
    if (cur.rows.length === 0) throw new UserGoneError();
    return {
      balance_after: BigInt(cur.rows[0].credits),
      ledger_id: row.ledger_id,
      usage_record_id: row.id,
    };
  }

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
  // credit_ledger insert 也可能撞 0009 的 partial unique(另一事务并发同 request_id)—
  // 让约束接住,应用层捕成明确错误,调用方决定 409 / 读取已写入的记录。
  let ledgerId: string;
  try {
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
    ledgerId = ledgerRow.rows[0].id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateRequestError(input.requestId);
    throw err;
  }
  let usageRecordId: string;
  try {
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
    usageRecordId = usageRow.rows[0].id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateRequestError(input.requestId);
    throw err;
  }
  return {
    balance_after: newBalance,
    ledger_id: ledgerId,
    usage_record_id: usageRecordId,
  };
}

/** 同 request_id 的第一次尝试已被记录为 error/billing_failed,客户端需换新 request_id 重试。 */
export class RequestRetryWithDifferentResultError extends Error {
  readonly code = "ERR_REQUEST_ID_EXHAUSTED" as const;
  readonly previousStatus: string;
  constructor(previousStatus: string) {
    super(
      `request_id already used by a previous attempt with status=${previousStatus}; use a new request_id to retry`,
    );
    this.name = "RequestRetryWithDifferentResultError";
    this.previousStatus = previousStatus;
  }
}

/** 同 request_id 并发进入事务时的兜底 —— 概率极小,但 partial index 会在此处把 race 拦住。 */
export class DuplicateRequestError extends Error {
  readonly code = "ERR_DUPLICATE_REQUEST" as const;
  readonly requestId: string;
  constructor(requestId: string) {
    super(`concurrent request with duplicate request_id: ${requestId}`);
    this.name = "DuplicateRequestError";
    this.requestId = requestId;
  }
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
  /**
   * 'error' — LLM/上游/编排器路径失败,LLM 未产出 usage。扣费未启动。
   * 'billing_failed' — LLM 已产出 usage,但本地 debit 事务炸(DB 中断、并发 ERR_INSUFFICIENT_CREDITS 等)。
   *                    上游已消耗但本地未扣费 —— 财务上需 reconcile。
   * 未指定时默认 'error'(向后兼容旧调用方)。
   */
  status?: "error" | "billing_failed";
  /** 已消耗的 usage —— status='billing_failed' 时必填,审计用 */
  usage?: TokenUsage;
  /** 已算出的 cost —— status='billing_failed' 时填 */
  costCredits?: bigint;
}

/**
 * 失败场景:只 INSERT usage_records,不扣费。不必在事务内,独立连接即可。
 *
 * 为什么不在事务里:失败路径不涉及 users.credits / credit_ledger,单表 insert 不需要隔离级别保护,
 * 而且失败路径常常已经发生在别的地方(超时、网络抖),尽量减少被连累的操作。
 *
 * 幂等:uniq_ur_request 保证 request_id 只能写入一次。重复调用(比如同一次失败两个代码分支
 * 都想补一条)会撞唯一约束 —— 此处 swallow,返回 false 让调用方知晓"别人已经写过了"。
 */
export async function recordChatError(
  input: RecordChatErrorInput,
): Promise<{ recorded: boolean }> {
  const status = input.status ?? "error";
  const usage = input.usage ?? {
    input_tokens: 0n,
    output_tokens: 0n,
    cache_read_tokens: 0n,
    cache_write_tokens: 0n,
  };
  const cost = input.costCredits ?? 0n;
  try {
    await query(
      `INSERT INTO usage_records
        (user_id, session_id, mode, account_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         price_snapshot, cost_credits, ledger_id, request_id, status, error_msg)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, NULL, $12, $13, $14)`,
      [
        input.userId,
        input.sessionId ?? null,
        input.mode,
        input.accountId ?? null,
        input.model,
        BigInt(usage.input_tokens).toString(),
        BigInt(usage.output_tokens).toString(),
        BigInt(usage.cache_read_tokens).toString(),
        BigInt(usage.cache_write_tokens).toString(),
        JSON.stringify(input.priceSnapshot),
        cost.toString(),
        input.requestId,
        status,
        input.errorMessage,
      ],
    );
    return { recorded: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { recorded: false };
    throw err;
  }
}
