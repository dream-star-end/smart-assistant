/**
 * Visible-head helpers for lossless turn finalize decoupling (design rev2/rev3).
 */
import { createHash } from "node:crypto";
import type { DurableCodexBilling, LosslessTurnTapeFinalizeRequest } from "@openclaude/protocol";
import {
  losslessBillingAnchorId,
  type LosslessTurnTapeSettlement,
} from "@openclaude/protocol";

export const TAPE_VISIBLE_SQL =
  "(t.visible_at IS NOT NULL OR t.finalized_at IS NOT NULL)";
export const TAPE_RECORDS_PUBLISHED_SQL =
  "(t.materialization_status = 'complete' OR t.finalized_at IS NOT NULL)";

export const VISIBLE_HEAD_TEXT_MAX_BYTES = 512 * 1024;

export type VisibleHead = {
  role: "assistant";
  text: string;
  ts: number;
  messageId: string;
  clientMessageId?: string;
  errorCode?: string | null;
  truncated?: boolean;
};

export function recordsPublished(input: {
  materializationStatus?: string | null;
  finalizedAt?: string | number | null;
}): boolean {
  return input.materializationStatus === "complete" || input.finalizedAt != null;
}

export function clipVisibleText(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= VISIBLE_HEAD_TEXT_MAX_BYTES) return { text, truncated: false };
  let end = VISIBLE_HEAD_TEXT_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export function settlementAuthorityHash(input: {
  billingAnchorId: string;
  requestId?: string | null;
  engineBillings: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify({
    billingAnchorId: input.billingAnchorId,
    requestId: input.requestId ?? null,
    engineBillings: input.engineBillings ?? [],
  })).digest("hex");
}

export function visibleHeadFromSettlement(
  request: LosslessTurnTapeFinalizeRequest,
  settlement: LosslessTurnTapeSettlement,
  clientMessageId?: string | null,
): VisibleHead {
  const clipped = clipVisibleText(settlement.text ?? "");
  return {
    role: "assistant",
    text: clipped.text,
    ts: settlement.ts,
    messageId: settlement.billingAnchorId,
    ...(clientMessageId ? { clientMessageId } : {}),
    errorCode: settlement.errorCode ?? null,
    ...(clipped.truncated ? { truncated: true } : {}),
  };
}

export function visibleHeadFallback(
  request: LosslessTurnTapeFinalizeRequest,
  text: string,
  clientMessageId?: string | null,
): VisibleHead {
  const clipped = clipVisibleText(text);
  return {
    role: "assistant",
    text: clipped.text,
    ts: request.createdAt,
    messageId: losslessBillingAnchorId({
      sessionId: request.sessionId,
      agentId: request.agentId,
      turnIndex: request.turnIndex,
      text,
      errorCode: request.status === "crashed" ? "crashed" : undefined,
    }),
    ...(clientMessageId ? { clientMessageId } : {}),
    errorCode: null,
    ...(clipped.truncated ? { truncated: true } : {}),
  };
}

export function settlementEngineBillings(
  settlement: LosslessTurnTapeSettlement | undefined,
): DurableCodexBilling[] {
  if (!settlement?.engineBillings?.length) return [];
  return settlement.engineBillings.map((row) => structuredClone(row));
}

export function phaseAVisibleHeadText(input: {
  hasSettlement: boolean;
  settlementText?: string;
  liveFrameText?: string;
}): string {
  const raw = input.hasSettlement ? (input.settlementText ?? "") : (input.liveFrameText ?? "");
  return clipVisibleText(raw).text;
}

export function assertSettlementMatchesCanonical(input: {
  canonicalAnchorId: string;
  canonicalRequestId?: string | null;
  canonicalBillings: unknown;
  envelope?: {
    billingAnchorId: string;
    requestId?: string | null;
    engineBillings: unknown;
  } | null;
  persistedHash?: string | null;
}): string {
  const canonicalHash = settlementAuthorityHash({
    billingAnchorId: input.canonicalAnchorId,
    requestId: input.canonicalRequestId,
    engineBillings: input.canonicalBillings,
  });
  if (input.envelope) {
    if (input.envelope.billingAnchorId !== input.canonicalAnchorId) {
      throw new Error("lossless turn tape billingAnchorId mismatch");
    }
    const envelopeRequestId = input.envelope.requestId ?? null;
    const canonicalRequestId = input.canonicalRequestId ?? null;
    if (envelopeRequestId !== canonicalRequestId) {
      throw new Error("lossless turn tape settlement requestId mismatch");
    }
    const envelopeHash = settlementAuthorityHash({
      billingAnchorId: input.envelope.billingAnchorId,
      requestId: input.envelope.requestId,
      engineBillings: input.envelope.engineBillings,
    });
    if (envelopeHash !== canonicalHash) {
      throw new Error("lossless turn tape settlement envelope/canonical mismatch");
    }
  }
  if (input.persistedHash && input.persistedHash !== canonicalHash) {
    throw new Error("lossless turn tape settlement hash mismatch");
  }
  return canonicalHash;
}

export function isTransientTapeError(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { retryable?: unknown }).retryable === true) {
    return true;
  }
  const code =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "";
  if (
    code === "57014" || code === "40001" || code === "40P01" || code === "55P03"
    || code.startsWith("08") || code.startsWith("57P")
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /statement timeout|canceling statement due to|connection terminated|terminating connection|server closed the connection|ECONNRESET|ETIMEDOUT|EPIPE|materialization killed/i.test(
    msg,
  );
}
