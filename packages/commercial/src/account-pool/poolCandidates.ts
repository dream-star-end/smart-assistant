/**
 * poolCandidates — the one place that knows "which claude_accounts rows are
 * routable right now for provider P (optionally inside group G)".
 *
 * Before this file the same predicate was hand-built in four places
 * (scheduler.selectActiveCandidates, scheduler.pickOfficialOAuthAccountForBindingInTx,
 * groups.hasActiveOfficialOAuthAccountInGroup, and the codexBinding.acquire
 * pool-count probe in index.ts), each with its own copy of the
 * "codex → OC_CODEX_ACCOUNT_RUNTIME_CHANNEL, grok → runtime channel, others →
 * shared" rule — and a comment at one of them saying it "must match the picker
 * exactly". Now it does, by construction.
 *
 * This module deliberately stops at the WHERE clause. It does not choose a row
 * (that is the scheduler's job), does not decrypt tokens, and does not know
 * about provider-specific quota columns beyond what `activePoolWhere` needs.
 */
import type { AccountProvider } from "./store.js";
import { getCodexAccountRuntimeChannel, getRuntimeChannel, type RuntimeChannel } from "../runtimeChannel.js";

/**
 * Which `claude_accounts.runtime_channel` a provider's pool is partitioned by,
 * or `null` when the pool is shared across channels.
 *
 *   - codex → the (possibly overridden) Codex account-pool channel
 *   - grok  → this master's runtime channel
 *   - claude / cursor → shared (no channel filter)
 */
export function accountPoolChannelFor(provider: AccountProvider): RuntimeChannel | null {
  if (provider === "codex") return getCodexAccountRuntimeChannel();
  if (provider === "grok") return getRuntimeChannel();
  return null;
}

export interface ActivePoolWhereInput {
  provider: AccountProvider;
  /** Restrict to one account group; `null`/`undefined` = whole provider pool. */
  groupId?: bigint | string | null;
  /**
   * Parameter index to start numbering at (1-based, the value `$N` of the
   * first placeholder this helper emits). Lets callers prepend their own
   * params. Default 1.
   */
  startParam?: number;
  /** Table alias when the caller joins; default none (bare column names). */
  alias?: string;
}

export interface ActivePoolWhere {
  /** Conjuncts to `join(" AND ")` into the caller's WHERE. Never empty. */
  clauses: string[];
  /** Params in placeholder order, aligned with `startParam`. */
  params: unknown[];
  /** Next free placeholder index after this helper's params. */
  nextParam: number;
}

/**
 * `status='active' AND provider=$p [AND runtime_channel=$c] [AND group_id=$g]`
 * — exactly the routable-row predicate every picker and probe must agree on.
 * Quota-backoff filters (5h/7d/grok credit) are the scheduler's business and
 * are appended there; this helper is the common denominator only.
 */
export function activePoolWhere(input: ActivePoolWhereInput): ActivePoolWhere {
  const col = (name: string): string => (input.alias ? `${input.alias}.${name}` : name);
  const params: unknown[] = [];
  let n = input.startParam ?? 1;
  const clauses: string[] = [`${col("status")} = 'active'`];

  params.push(input.provider);
  clauses.push(`${col("provider")} = $${n}`);
  n += 1;

  const channel = accountPoolChannelFor(input.provider);
  if (channel !== null) {
    params.push(channel);
    clauses.push(`${col("runtime_channel")} = $${n}`);
    n += 1;
  }

  if (input.groupId !== undefined && input.groupId !== null) {
    params.push(String(input.groupId));
    clauses.push(`${col("group_id")} = $${n}`);
    n += 1;
  }

  return { clauses, params, nextParam: n };
}
