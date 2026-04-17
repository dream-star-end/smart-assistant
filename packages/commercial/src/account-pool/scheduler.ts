/**
 * T-32 — 账号池调度器。
 *
 * 规约(见 01-SPEC F-6.4):
 *   - `mode=agent` sticky: 按 sessionId 哈希取候选账号里 rendezvous-hash 最大的一个。
 *     账号上/下线时,只有 O(1/N) 的 session 会迁移到其他账号,满足 prompt cache 稳定性。
 *   - `mode=chat` 加权随机: 权重 = max(1, health_score)。health=0 的账号仍有 weight=1 用于
 *     探活 —— 避免所有 active 账号 health=0 时 picker 陷入死锁。
 *   - 没有 active 账号(或遇上全部 cooldown/disabled/banned)→ 抛 `AccountPoolUnavailableError`
 *     (code=ERR_ACCOUNT_POOL_UNAVAILABLE,503 语义)
 *
 * release 语义:
 *   - `success` → `health.onSuccess(id)` 恢复健康度
 *   - `failure` → `health.onFailure(id, msg)` 扣分;触发 3 连败熔断
 *
 * 非职责:
 *   - 本模块不关心 token 刷新(T-33)、不关心扣费(T-22)、不决定用哪个模型。
 *   - 本模块只做 "从 active 池子挑一个 account" 这一件事。
 */

import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { query } from "../db/queries.js";
import { loadKmsKey } from "../crypto/keys.js";
import {
  getTokenForUse,
  type AccountPlan,
  type AccountToken,
} from "./store.js";
import type { AccountHealthTracker } from "./health.js";

export const ERR_ACCOUNT_POOL_UNAVAILABLE = "ERR_ACCOUNT_POOL_UNAVAILABLE";

export class AccountPoolUnavailableError extends Error {
  readonly code = ERR_ACCOUNT_POOL_UNAVAILABLE;
  constructor(reason: string) {
    super(`account pool unavailable: ${reason}`);
    this.name = "AccountPoolUnavailableError";
  }
}

export interface PickInput {
  mode: "chat" | "agent";
  /** agent 模式必传;chat 可选(若传也会作为加权采样的 PRNG seed,保留方便) */
  sessionId?: string;
  /** 为未来 "按模型过滤账号池" 预留,目前不使用。 */
  model?: string;
}

export interface PickResult {
  account_id: bigint;
  plan: AccountPlan;
  /** 解密后的 OAuth access token —— **调用方用完必须 .fill(0)** */
  token: Buffer;
  /** 解密后的 refresh token(可能为 null)—— **调用方用完必须 .fill(0)** */
  refresh: Buffer | null;
  expires_at: Date | null;
}

export type ReleaseResult =
  | { kind: "success" }
  | { kind: "failure"; error?: string | null };

export interface ReleaseInput {
  account_id: bigint | string;
  result: ReleaseResult;
}

export interface SchedulerDeps {
  health: AccountHealthTracker;
  /** 注入测试 key fn;默认 loadKmsKey */
  keyFn?: () => Buffer;
  /** 注入 PRNG;默认 Math.random */
  random?: () => number;
  /** 注入 hash(用于测试;默认 SHA-256 64-bit) */
  hash?: (s: string) => bigint;
}

interface CandidateRow extends QueryResultRow {
  id: string;
  plan: AccountPlan;
  health_score: number;
}

/** 默认哈希:SHA-256,截前 8B 作 64-bit 无符号整数。 */
export function defaultHash(s: string): bigint {
  const h = createHash("sha256").update(s).digest();
  return h.readBigUInt64BE(0);
}

/**
 * Rendezvous(Highest Random Weight)哈希:
 *   对每个候选 id 计算 hash(`sessionId:id`),取最大。
 *
 * 这比朴素 `hash(sessionId) % N` 更稳:
 *   账号加入/退出只影响被 "抢走" / "让出" 的那一小部分 session,
 *   不会让全量 session 重哈希。
 */
export function pickSticky(
  candidates: ReadonlyArray<CandidateRow>,
  sessionId: string,
  hash: (s: string) => bigint = defaultHash,
): CandidateRow {
  if (candidates.length === 0) {
    throw new AccountPoolUnavailableError("no candidates for sticky");
  }
  let bestIdx = 0;
  let bestScore = hash(`${sessionId}:${candidates[0].id}`);
  for (let i = 1; i < candidates.length; i += 1) {
    const s = hash(`${sessionId}:${candidates[i].id}`);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  return candidates[bestIdx];
}

/**
 * 按 health_score 加权随机。权重 floor 1,保证 health=0 的账号也有机会被探活。
 */
export function pickWeighted(
  candidates: ReadonlyArray<CandidateRow>,
  random: () => number = Math.random,
): CandidateRow {
  if (candidates.length === 0) {
    throw new AccountPoolUnavailableError("no candidates for weighted");
  }
  let total = 0;
  const weights: number[] = [];
  for (const c of candidates) {
    const w = Math.max(1, c.health_score);
    weights.push(w);
    total += w;
  }
  const r = random() * total;
  let acc = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    acc += weights[i];
    if (r < acc) return candidates[i];
  }
  // 浮点误差兜底:取最后一个。
  return candidates[candidates.length - 1];
}

/**
 * 调度器 —— 从 `status='active'` 账号集里挑一个返 token(解密后的明文 Buffer)。
 *
 * 生命周期:
 *   - pick 时装填 `AccountPoolUnavailableError` 的唯一真相:候选集非空 ∧ token 解密成功
 *   - release 时调 health tracker 更新统计
 */
export class AccountScheduler {
  private readonly health: AccountHealthTracker;
  private readonly keyFn: () => Buffer;
  private readonly random: () => number;
  private readonly hash: (s: string) => bigint;

  constructor(deps: SchedulerDeps) {
    this.health = deps.health;
    this.keyFn = deps.keyFn ?? loadKmsKey;
    this.random = deps.random ?? Math.random;
    this.hash = deps.hash ?? defaultHash;
  }

  /**
   * 选一个账号并返回 token。
   *
   * @throws `AccountPoolUnavailableError` 当无 active 账号 / 选中账号已被删除
   * @throws `TypeError` 当 `mode=agent` 缺 sessionId
   */
  async pick(input: PickInput): Promise<PickResult> {
    if (input.mode === "agent") {
      if (!input.sessionId || input.sessionId.length === 0) {
        throw new TypeError("sessionId required when mode=agent");
      }
    } else if (input.mode !== "chat") {
      throw new TypeError(`unknown mode: ${String(input.mode)}`);
    }

    const res = await query<CandidateRow>(
      `SELECT id::text AS id, plan, health_score
       FROM claude_accounts
       WHERE status = 'active'
       ORDER BY id`,
    );
    const candidates = res.rows;
    if (candidates.length === 0) {
      throw new AccountPoolUnavailableError("no active accounts");
    }

    const chosen =
      input.mode === "agent"
        ? pickSticky(candidates, input.sessionId!, this.hash)
        : pickWeighted(candidates, this.random);

    const tok = await this.readToken(chosen.id);
    return {
      account_id: BigInt(chosen.id),
      plan: tok.plan,
      token: tok.token,
      refresh: tok.refresh,
      expires_at: tok.expires_at,
    };
  }

  /**
   * 请求结果回调:交给 health tracker 更新 status/计数。
   *
   * 上游流程:
   *   ```
   *   const p = await scheduler.pick({mode:"chat"});
   *   try {
   *     const r = await callClaudeApi(p.token);
   *     await scheduler.release({account_id:p.account_id, result:{kind:"success"}});
   *   } catch (err) {
   *     await scheduler.release({
   *       account_id:p.account_id,
   *       result:{kind:"failure", error:String(err)},
   *     });
   *     throw err;
   *   } finally {
   *     p.token.fill(0); p.refresh?.fill(0);
   *   }
   *   ```
   */
  async release(input: ReleaseInput): Promise<void> {
    if (input.result.kind === "success") {
      await this.health.onSuccess(input.account_id);
    } else {
      await this.health.onFailure(
        input.account_id,
        input.result.error ?? null,
      );
    }
  }

  /** 读并解密 token;失败 → AccountPoolUnavailableError(通常是账号在 pick 和 read 之间被删)。 */
  private async readToken(accountId: string): Promise<AccountToken> {
    const tok = await getTokenForUse(accountId, this.keyFn);
    if (!tok) {
      throw new AccountPoolUnavailableError(
        `account vanished between pick and readToken: ${accountId}`,
      );
    }
    return tok;
  }
}
