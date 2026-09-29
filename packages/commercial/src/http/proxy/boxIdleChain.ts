import { createHash } from "node:crypto";
import { parseBoxReplayMessagePointer, type BoxReplayMessagePointer } from "./boxReplayMessageFile.js";

/** Real autocompact floor for a 200k window minus the stock buffer. Not a test override. */
export const IDLE_COMPACT_USAGE_FLOOR = 167_000;

export interface IdleChainRow {
  requestId: string;
  state: string;
  ctx: Record<string, unknown>;
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

/**
 * Project one authenticated session/turn snapshot.
 * Historical handoff fields are allowed once the child consumed them.
 * Settlement `committed` is required separately from boxState terminal.
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
  if (leaves.length !== 1) return { status: "pending", reason: "leaf" };
  const chain: IdleChainRow[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = leaves[0]!.requestId;
  while (cursor) {
    if (seen.has(cursor) || chain.length >= 128) return { status: "pending", reason: "cycle" };
    const row = byId.get(cursor);
    if (!row) return { status: "pending", reason: "gap" };
    seen.add(cursor);
    chain.push(row);
    const parent = row.ctx.boxOwnerRequestId;
    cursor = typeof parent === "string" ? parent : undefined;
  }
  const leaf = chain[0]!;
  if (leaf.state !== "committed" || leaf.ctx.boxState !== "terminal"
    || proofReason(leaf.ctx) !== "worker_complete") {
    return { status: "pending", reason: "unsettled" };
  }
  const pointer = leaf.ctx.boxReplayMessage as { sha256?: unknown } | undefined;
  if (!pointer || typeof pointer.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pointer.sha256)) {
    return { status: "pending", reason: "capsule" };
  }
  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i]!;
    const child = chain[i - 1]!;
    if (parent.state !== "committed" || parent.ctx.boxState === "unknown" || parent.ctx.boxState === "resuming") {
      return { status: "pending", reason: "ancestor" };
    }
    if (parent.ctx.boxState !== "terminal") return { status: "pending", reason: "ancestor" };
    if (parent.ctx.boxToolHandoff !== undefined) {
      if (parent.ctx.boxResumeRequestId !== child.requestId
        || typeof parent.ctx.boxResumeRevision !== "string"
        || parent.ctx.boxResumeRevision !== child.ctx.boxParentResumeRevision) {
        return { status: "pending", reason: "handoff" };
      }
    }
  }
  const open = (input.otherOpenRequestIds ?? []).filter((id) => !byId.has(id));
  if (open.length > 0) return { status: "pending", reason: "other_chain" };
  const proof = leaf.ctx.boxTerminalProof as { runNonce?: unknown; leaseEpoch?: unknown } | undefined;
  if (typeof leaf.ctx.boxRunNonce === "string" && leaf.ctx.boxRunNonce !== proof?.runNonce) {
    return { status: "pending", reason: "identity" };
  }
  if (typeof leaf.ctx.boxLeaseEpoch === "string" && leaf.ctx.boxLeaseEpoch !== proof?.leaseEpoch) {
    return { status: "pending", reason: "identity" };
  }
  if (typeof leaf.ctx.boxRoundNo === "number" && leaf.ctx.boxRoundNo !== chain.length) {
    return { status: "pending", reason: "identity" };
  }
  for (const row of chain) {
    if (typeof row.ctx.boxRunNonce === "string" && row.ctx.boxRunNonce !== leaf.ctx.boxRunNonce
      && typeof leaf.ctx.boxRunNonce === "string") {
      return { status: "pending", reason: "identity" };
    }
    if (typeof row.ctx.boxAccountId === "string" && typeof leaf.ctx.boxAccountId === "string"
      && row.ctx.boxAccountId !== leaf.ctx.boxAccountId) {
      return { status: "pending", reason: "identity" };
    }
  }
  // The leaf call's input+cache is the prompt that call actually sent. Earlier
  // rounds already include prior context, so summing them is not the current window.
  const usage = leaf.ctx.boxUsage as { inputTokens?: unknown; cacheReadTokens?: unknown } | undefined;
  const tokens = (typeof usage?.inputTokens === "number" ? usage.inputTokens : 0)
    + (typeof usage?.cacheReadTokens === "number" ? usage.cacheReadTokens : 0);
  const ids = [...chain].reverse().map((row) => row.requestId);
  const revision = sha({
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
  return {
    status: "terminal",
    sessionId: input.sessionId,
    turnKey: input.turnKey,
    requestId: leaf.requestId,
    revision,
    compactRequired: tokens >= IDLE_COMPACT_USAGE_FLOOR,
    capsuleSha256: pointer.sha256,
    ...(input.verifiedSummaryText !== undefined ? { summaryText: input.verifiedSummaryText } : {}),
  };
}

export function capsuleSummaryText(message: unknown): string | undefined {
  return textOf(message);
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
