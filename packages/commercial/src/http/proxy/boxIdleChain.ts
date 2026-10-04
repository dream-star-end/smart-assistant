import { createHash } from "node:crypto";
import { parseBoxReplayMessagePointer, type BoxReplayMessagePointer } from "./boxReplayMessageFile.js";
import { BOX_EXPIRED_UNPROVEN_STATE, parseBoxExpiredClose } from "./boxExpiredClose.js";
import { parseBoxStoredToolHandoff } from "./boxStoredToolHandoff.js";
import { BOX_TOOL_MAX_ROUNDS } from "./boxToolCapacity.js";

/** Real autocompact floor for a 200k window minus the stock buffer. Not a test override. */
export const IDLE_COMPACT_USAGE_FLOOR = 167_000;

export interface IdleChainRow {
  requestId: string;
  state: string;
  ctx: Record<string, unknown>;
  /** Journal settlement columns (final_credits as text). Only the
   * expired_unproven projection reads them. */
  finalCredits?: string | null;
  failureCode?: string | null;
}

export type BoxIdleProof =
  | { status: "not_found" }
  | { status: "pending"; reason: string }
  | {
      status: "terminal";
      sessionId: string;
      turnKey: string;
      requestId: string;
      revision: string;
      compactRequired: boolean;
      capsuleSha256: string;
      summaryText?: string;
    }
  | {
      status: "terminal_set";
      sessionId: string;
      turnKey: string;
      revision: string;
      requestIds: string[];
    }
  /** OCV5-297: the whole chain ended in a proven stop with no model result.
   * Only the exact failure shapes written by the journal state machine
   * qualify; anything unknown or malformed stays pending.
   * OCV5-313: also a chain closed as expired_unproven. */
  | {
      status: "failed";
      sessionId: string;
      turnKey: string;
      requestIds: string[];
    };

function textOf(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim()) return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.map((block) => {
    const row = block as { type?: unknown; text?: unknown };
    return row?.type === "text" && typeof row.text === "string" ? row.text : "";
  }).join("").trim();
  return text || undefined;
}

function proofReason(ctx: Record<string, unknown>): string | undefined {
  const proof = ctx.boxTerminalProof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return undefined;
  const reason = (proof as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const FAILED_PROOF_REASONS = new Set(["keeper_stopped", "worker_failed"]);
const RESUMABLE_STATES = new Set(["inflight", "finalizing", "committed"]);

/**
 * One owner-linked chain that ended in a proven failure, mirroring
 * markToolChainStoppedFailure / CLEANUP_PROOF_FENCE (failed branch) and the
 * prestart stop fences. Returns null for every other shape.
 */
function projectFailedChain(leafId: string, byId: Map<string, IdleChainRow>): IdleChainRow[] | null {
  const chain: IdleChainRow[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = leafId;
  while (cursor) {
    if (seen.has(cursor) || chain.length >= 128) return null;
    const row = byId.get(cursor);
    if (!row) return null;
    seen.add(cursor);
    chain.push(row);
    const parent = row.ctx.boxOwnerRequestId;
    if (parent !== undefined && typeof parent !== "string") return null;
    cursor = parent;
  }
  const leaf = chain[0]!;
  const ctx = leaf.ctx;
  if (ctx.boxState === "prestart_stopped") {
    // Prestart fences only apply before any launch permit; never launched.
    return chain.length === 1 && !Object.hasOwn(ctx, "boxLaunchPermit")
      && ctx.boxOwnerRequestId === undefined && ctx.boxResumeRequestId === undefined
      ? chain : null;
  }
  if (ctx.boxState === BOX_EXPIRED_UNPROVEN_STATE) return projectExpiredChain(chain);
  if (ctx.boxState !== "failed_stopped") return null;
  const proof = ctx.boxTerminalProof as { reason?: unknown; runNonce?: unknown; leaseEpoch?: unknown } | undefined;
  // OCV5-300: a first round whose stream egress rejected is settled with the
  // keeper's own proof (even worker_complete); nothing was delivered or billed.
  // OCV5-306: the same settlement may close the unknown leaf of a linked chain;
  // its ancestors are still checked below (failed_stopped/failed handoffs).
  const rejectedStream = ctx.boxStopOutcome === "rejected_stream"
    && leaf.state === "aborted" && ctx.boxToolHandoff === undefined;
  if (!proof || typeof proof !== "object" || typeof proof.reason !== "string"
    || !(FAILED_PROOF_REASONS.has(proof.reason)
      || (rejectedStream && proof.reason === "worker_complete"))
    || typeof proof.runNonce !== "string" || typeof proof.leaseEpoch !== "string") return null;
  const hasHandoff = ctx.boxToolHandoff !== undefined;
  if (hasHandoff ? !RESUMABLE_STATES.has(leaf.state) : leaf.state !== "aborted") return null;
  if (ctx.boxResumeRequestId !== undefined) return null;
  for (const row of chain) {
    if (row.ctx.boxRunNonce !== proof.runNonce || row.ctx.boxLeaseEpoch !== proof.leaseEpoch) return null;
    if (row.ctx.boxAccountId !== ctx.boxAccountId || row.ctx.boxSessionId !== ctx.boxSessionId
      || row.ctx.boxTurnKey !== ctx.boxTurnKey || row.ctx.model !== ctx.model) return null;
  }
  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i]!;
    const child = chain[i - 1]!;
    if (parent.ctx.boxState !== "failed_stopped" || parent.ctx.boxStopOutcome !== "failed"
      || parent.ctx.boxToolHandoff === undefined || !RESUMABLE_STATES.has(parent.state)
      || parent.ctx.boxResumeRequestId !== child.requestId
      || typeof parent.ctx.boxResumeRevision !== "string"
      || parent.ctx.boxResumeRevision !== child.ctx.boxParentResumeRevision) return null;
  }
  return chain;
}

const HEX64 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Same rule as the journal's stop fence: a detached tool run, or the durably
 * armed detached text lane. */
function stoppableMode(ctx: Record<string, unknown>): boolean {
  return ctx.boxInvocationMode === "detached_tool"
    || (ctx.boxInvocationMode === "text" && ctx.boxLaunchPermit === true
      && ctx.boxUpstreamModel === "claude-opus-5-5"
      && typeof ctx.boxDetachedRunnerHash === "string" && HEX64.test(ctx.boxDetachedRunnerHash));
}

/** OCV5-313: only the exact end state markRunExpiredUnproven writes, checked
 * as strictly as that method checks the chain before it writes: settlement
 * columns of an unbilled leaf, round numbers, handoff/catalog/runner binding,
 * revisions, one identity. The run ended without a keeper proof, so there is
 * no model result to wait for. Anything else stays pending. */
function projectExpiredChain(chain: IdleChainRow[]): IdleChainRow[] | null {
  const leaf = chain[0]!, ctx = leaf.ctx;
  const marker = parseBoxExpiredClose(ctx.boxExpiredClose);
  if (!marker || ctx.boxTerminalProof !== undefined || ctx.boxResumeRequestId !== undefined
    || ctx.settlementClaimId !== undefined
    || typeof ctx.boxRunNonce !== "string" || !/^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
    || typeof ctx.boxLeaseEpoch !== "string" || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)
    || typeof ctx.boxAccountId !== "string" || !/^[1-9][0-9]{0,19}$/.test(ctx.boxAccountId)) {
    return null;
  }
  const linked = ctx.boxOwnerRequestId !== undefined;
  const handoff = ctx.boxToolHandoff === undefined ? null
    : parseBoxStoredToolHandoff(ctx.boxToolHandoff);
  if (ctx.boxToolHandoff !== undefined && !handoff) return null;
  if (handoff) {
    if (!RESUMABLE_STATES.has(leaf.state) || !["handoff", "unknown"].includes(marker.priorBoxState)
      || typeof ctx.boxHandoffRevision !== "string" || !UUID_V4.test(ctx.boxHandoffRevision)) {
      return null;
    }
  } else if (leaf.state !== "aborted" || leaf.failureCode !== "STREAM_FAILED"
    || leaf.finalCredits !== "0"
    || !(linked ? ["linked", "unknown"] : ["running", "unknown"]).includes(marker.priorBoxState)) {
    return null;
  }
  for (const row of chain) {
    if (row.ctx.boxInvocationRecovery !== "v1" || !stoppableMode(row.ctx)
      || row.ctx.boxRunNonce !== ctx.boxRunNonce || row.ctx.boxLeaseEpoch !== ctx.boxLeaseEpoch
      || row.ctx.boxAccountId !== ctx.boxAccountId || row.ctx.boxSessionId !== ctx.boxSessionId
      || row.ctx.boxTurnKey !== ctx.boxTurnKey || row.ctx.model !== ctx.model) return null;
  }
  if (!linked) {
    return chain.length === 1 && (!handoff
      || (handoff.roundNo === 1 && ctx.boxInvocationMode === "detached_tool")) ? chain : null;
  }
  const roundNo = ctx.boxRoundNo;
  if (chain.some((row) => row.ctx.boxInvocationMode !== "detached_tool")
    || !Number.isSafeInteger(roundNo) || Number(roundNo) < 2
    || Number(roundNo) > BOX_TOOL_MAX_ROUNDS || chain.length !== roundNo
    || typeof ctx.boxCatalogHash !== "string" || !HEX64.test(ctx.boxCatalogHash)
    || typeof ctx.boxDetachedRunnerHash !== "string" || !HEX64.test(ctx.boxDetachedRunnerHash)
    || (handoff && (handoff.roundNo !== roundNo || handoff.catalogHash !== ctx.boxCatalogHash
      || handoff.detachedRunnerHash !== ctx.boxDetachedRunnerHash))) return null;
  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i]!, child = chain[i - 1]!;
    const stored = parseBoxStoredToolHandoff(parent.ctx.boxToolHandoff);
    if (parent.ctx.boxState !== BOX_EXPIRED_UNPROVEN_STATE || !stored
      || stored.roundNo !== Number(roundNo) - i
      || stored.catalogHash !== ctx.boxCatalogHash
      || stored.detachedRunnerHash !== ctx.boxDetachedRunnerHash
      || !RESUMABLE_STATES.has(parent.state)
      || parent.ctx.boxTerminalProof !== undefined
      || parent.ctx.boxResumeRequestId !== child.requestId
      || typeof parent.ctx.boxResumeRevision !== "string"
      || !UUID_V4.test(parent.ctx.boxResumeRevision)
      || parent.ctx.boxResumeRevision !== child.ctx.boxParentResumeRevision) return null;
  }
  return chain;
}

/** OCV5-313: request ids of the session's expired_unproven rows that form a
 * complete, valid expired chain within their own turn. Used to decide which
 * closed runs stop counting as another open chain; a row with a missing or
 * malformed marker, a broken linkage or a missing ancestor is not returned. */
export function validExpiredChainIds(rows: readonly IdleChainRow[]): Set<string> {
  const byTurn = new Map<string, IdleChainRow[]>();
  for (const row of rows) {
    const turnKey = row.ctx.boxTurnKey;
    if (row.ctx.boxState !== BOX_EXPIRED_UNPROVEN_STATE || typeof turnKey !== "string") continue;
    const group = byTurn.get(turnKey);
    if (group) group.push(row); else byTurn.set(turnKey, [row]);
  }
  const valid = new Set<string>();
  for (const group of byTurn.values()) {
    const byId = new Map(group.map((row) => [row.requestId, row]));
    if (byId.size !== group.length) continue;
    const owners = new Set(group.map((row) => row.ctx.boxOwnerRequestId));
    for (const leaf of group) {
      if (owners.has(leaf.requestId)) continue;
      const chain = projectFailedChain(leaf.requestId, byId);
      if (chain) for (const row of chain) valid.add(row.requestId);
    }
  }
  return valid;
}

type ChainFailure = { ok: false; reason: string };
type ChainOk = { ok: true; chain: IdleChainRow[] };

/** One owner-linked component. The single-chain revision below stays on this shape. */
function projectOneChain(leafId: string, byId: Map<string, IdleChainRow>): ChainOk | ChainFailure {
  const chain: IdleChainRow[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = leafId;
  while (cursor) {
    if (seen.has(cursor) || chain.length >= 128) return { ok: false, reason: "cycle" };
    const row = byId.get(cursor);
    if (!row) return { ok: false, reason: "gap" };
    seen.add(cursor);
    chain.push(row);
    const parent = row.ctx.boxOwnerRequestId;
    cursor = typeof parent === "string" ? parent : undefined;
  }
  const leaf = chain[0]!;
  if (leaf.state !== "committed" || leaf.ctx.boxState !== "terminal"
    || proofReason(leaf.ctx) !== "worker_complete") {
    return { ok: false, reason: "unsettled" };
  }
  const pointer = leaf.ctx.boxReplayMessage as { sha256?: unknown } | undefined;
  if (!pointer || typeof pointer.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pointer.sha256)) {
    return { ok: false, reason: "capsule" };
  }
  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i]!;
    const child = chain[i - 1]!;
    if (parent.state !== "committed" || parent.ctx.boxState === "unknown" || parent.ctx.boxState === "resuming") {
      return { ok: false, reason: "ancestor" };
    }
    if (parent.ctx.boxState !== "terminal") return { ok: false, reason: "ancestor" };
    if (parent.ctx.boxToolHandoff !== undefined) {
      if (parent.ctx.boxResumeRequestId !== child.requestId
        || typeof parent.ctx.boxResumeRevision !== "string"
        || parent.ctx.boxResumeRevision !== child.ctx.boxParentResumeRevision) {
        return { ok: false, reason: "handoff" };
      }
    }
  }
  const proof = leaf.ctx.boxTerminalProof as { runNonce?: unknown; leaseEpoch?: unknown } | undefined;
  if (typeof leaf.ctx.boxRunNonce === "string" && leaf.ctx.boxRunNonce !== proof?.runNonce) {
    return { ok: false, reason: "identity" };
  }
  if (typeof leaf.ctx.boxLeaseEpoch === "string" && leaf.ctx.boxLeaseEpoch !== proof?.leaseEpoch) {
    return { ok: false, reason: "identity" };
  }
  if (typeof leaf.ctx.boxRoundNo === "number" && leaf.ctx.boxRoundNo !== chain.length) {
    return { ok: false, reason: "identity" };
  }
  for (const row of chain) {
    if (typeof row.ctx.boxRunNonce === "string" && row.ctx.boxRunNonce !== leaf.ctx.boxRunNonce
      && typeof leaf.ctx.boxRunNonce === "string") {
      return { ok: false, reason: "identity" };
    }
    if (typeof row.ctx.boxAccountId === "string" && typeof leaf.ctx.boxAccountId === "string"
      && row.ctx.boxAccountId !== leaf.ctx.boxAccountId) {
      return { ok: false, reason: "identity" };
    }
  }
  return { ok: true, chain };
}

function singleRevision(input: { sessionId: string; turnKey: string }, chain: IdleChainRow[]): string {
  const leaf = chain[0]!;
  const pointer = leaf.ctx.boxReplayMessage as { sha256: string };
  const ids = [...chain].reverse().map((row) => row.requestId);
  return sha({
    sessionId: input.sessionId,
    turnKey: input.turnKey,
    ids,
    proof: chain.map((row) => ({
      id: row.requestId,
      reason: proofReason(row.ctx) ?? null,
      nonce: (row.ctx.boxTerminalProof as { runNonce?: unknown } | undefined)?.runNonce ?? null,
    })),
    capsule: pointer.sha256,
  });
}

/**
 * Project one authenticated session/turn snapshot.
 * One complete chain keeps the original terminal result. Several independent
 * complete chains are a ready set, not a summary.
 */
export function projectBoxIdleChain(input: {
  sessionId: string;
  turnKey: string;
  rows: readonly IdleChainRow[];
  otherOpenRequestIds?: readonly string[];
  /** Text already checked against the capsule file hash by the replay reader. */
  verifiedSummaryText?: string;
}): BoxIdleProof {
  const scoped = input.rows.filter((row) => row.ctx.boxSessionId === input.sessionId
    && row.ctx.boxTurnKey === input.turnKey
    && row.ctx.model === "box-api-claude-opus-5-5"
    && row.ctx.boxInvocationRecovery === "v1");
  if (scoped.length === 0) return { status: "not_found" };
  if (scoped.length > 128) return { status: "pending", reason: "cycle" };
  const byId = new Map(scoped.map((row) => [row.requestId, row]));
  if (byId.size !== scoped.length) return { status: "pending", reason: "fork" };
  const children = new Map<string, string>();
  for (const row of scoped) {
    const parent = row.ctx.boxOwnerRequestId;
    if (parent === undefined) continue;
    if (typeof parent !== "string" || children.has(parent)) {
      return { status: "pending", reason: "fork" };
    }
    children.set(parent, row.requestId);
  }
  const leaves = scoped.filter((row) => !children.has(row.requestId) && row.ctx.boxResumeRequestId === undefined);
  if (leaves.length === 0) return { status: "pending", reason: "leaf" };
  const chains: IdleChainRow[][] = [];
  const covered = new Set<string>();
  for (const leafRow of leaves) {
    const built = projectOneChain(leafRow.requestId, byId);
    if (!built.ok) {
      // Tried only after the success projection failed, for a single chain
      // that covers every scoped row with no other open chain.
      const failed = leaves.length === 1 ? projectFailedChain(leafRow.requestId, byId) : null;
      const open = (input.otherOpenRequestIds ?? []).filter((id) => !byId.has(id));
      if (failed && failed.length === scoped.length && open.length === 0) {
        return { status: "failed", sessionId: input.sessionId, turnKey: input.turnKey,
          requestIds: failed.map((row) => row.requestId).sort() };
      }
      return { status: "pending", reason: built.reason };
    }
    for (const row of built.chain) {
      if (covered.has(row.requestId)) return { status: "pending", reason: "fork" };
      covered.add(row.requestId);
    }
    chains.push(built.chain);
  }
  if (covered.size !== scoped.length) return { status: "pending", reason: "gap" };
  const open = (input.otherOpenRequestIds ?? []).filter((id) => !byId.has(id));
  if (open.length > 0) return { status: "pending", reason: "other_chain" };
  if (chains.length === 1) {
    const chain = chains[0]!;
    const leaf = chain[0]!;
    const pointer = leaf.ctx.boxReplayMessage as { sha256: string };
    // The leaf call's input+cache is the prompt that call actually sent. Earlier
    // rounds already include prior context, so summing them is not the current window.
    const usage = leaf.ctx.boxUsage as { inputTokens?: unknown; cacheReadTokens?: unknown } | undefined;
    const tokens = (typeof usage?.inputTokens === "number" ? usage.inputTokens : 0)
      + (typeof usage?.cacheReadTokens === "number" ? usage.cacheReadTokens : 0);
    return {
      status: "terminal",
      sessionId: input.sessionId,
      turnKey: input.turnKey,
      requestId: leaf.requestId,
      revision: singleRevision(input, chain),
      compactRequired: tokens >= IDLE_COMPACT_USAGE_FLOOR,
      capsuleSha256: pointer.sha256,
      ...(input.verifiedSummaryText !== undefined ? { summaryText: input.verifiedSummaryText } : {}),
    };
  }
  const members = chains.map((chain) => {
    const leaf = chain[0]!;
    const pointer = leaf.ctx.boxReplayMessage as { sha256: string };
    return {
      ids: [...chain].reverse().map((row) => row.requestId),
      proof: chain.map((row) => ({
        id: row.requestId,
        reason: proofReason(row.ctx) ?? null,
        nonce: (row.ctx.boxTerminalProof as { runNonce?: unknown } | undefined)?.runNonce ?? null,
      })),
      capsule: pointer.sha256,
    };
  }).sort((left, right) => left.ids.join("\0").localeCompare(right.ids.join("\0")));
  return {
    status: "terminal_set",
    sessionId: input.sessionId,
    turnKey: input.turnKey,
    revision: sha({ sessionId: input.sessionId, turnKey: input.turnKey, members }),
    requestIds: [...covered].sort(),
  };
}

export function capsuleSummaryText(message: unknown): string | undefined {
  return textOf(message);
}

/** Leaves of a ready set: members that no other member names as its owner. */
export function idleSetLeafIds(rows: readonly IdleChainRow[], requestIds: readonly string[]): string[] {
  const allowed = new Set(requestIds);
  const parents = new Set<string>();
  for (const row of rows) {
    if (!allowed.has(row.requestId)) continue;
    const parent = row.ctx.boxOwnerRequestId;
    if (typeof parent === "string") parents.add(parent);
  }
  return requestIds.filter((id) => !parents.has(id));
}

/** Attach text only after the replay reader has checked the capsule hash.
 * A read failure stays pending. It does not settle the row. */
export async function withVerifiedCapsule(proof: BoxIdleProof, pointer: unknown,
  read: (pointer: BoxReplayMessagePointer) => Promise<unknown>): Promise<BoxIdleProof> {
  if (proof.status !== "terminal") return proof;
  const parsed = parseBoxReplayMessagePointer(pointer);
  if (!parsed || parsed.sha256 !== proof.capsuleSha256) {
    return { status: "pending", reason: "capsule" };
  }
  try {
    const text = capsuleSummaryText(await read(parsed));
    if (!text) return { status: "pending", reason: "capsule" };
    return { ...proof, summaryText: text };
  } catch {
    return { status: "pending", reason: "capsule" };
  }
}
