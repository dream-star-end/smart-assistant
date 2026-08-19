/**
 * Visible-head helpers for lossless turn finalize decoupling (design rev2/rev3).
 */
import { createHash } from "node:crypto";
import type {
  DurableCodexBilling,
  LosslessTurnTapeFinalizeRequest,
  LosslessTurnTapeVisibleRequest,
} from "@openclaude/protocol";
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

function stableJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return current;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(current as Record<string, unknown>).sort()) {
      sorted[key] = (current as Record<string, unknown>)[key];
    }
    return sorted;
  });
  if (encoded === undefined) throw new Error("settlement authority is not JSON serializable");
  return encoded;
}

export function settlementPayloadEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export function settlementAuthorityHash(input: {
  billingAnchorId: string;
  requestId?: string | null;
  engineBillings: unknown;
}): string {
  return createHash("sha256").update(stableJson({
    billingAnchorId: input.billingAnchorId,
    requestId: input.requestId ?? null,
    engineBillings: input.engineBillings ?? [],
  })).digest("hex");
}

export function visibleHeadFromSettlement(
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
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
    ...(settlement.truncated || clipped.truncated ? { truncated: true } : {}),
  };
}

export function visibleHeadFallback(
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
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
  /** Structured Phase-A authority. Only used to upgrade the pre-stable-hash rollout. */
  persistedAuthority?: {
    billingAnchorId: string;
    requestId?: string | null;
    engineBillings: unknown;
  } | null;
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
    const persistedAuthorityHash = input.persistedAuthority
      ? settlementAuthorityHash(input.persistedAuthority)
      : null;
    if (persistedAuthorityHash !== canonicalHash) {
      throw new Error("lossless turn tape settlement hash mismatch");
    }
  }
  return canonicalHash;
}

export type TapeDisplayDegradeReason =
  | "records_unpublished"
  | "finalized_tape_missing"
  | "tape_hash_mismatch"
  | "record_missing"
  | "visible_payload_hash_mismatch"
  | "record_malformed"
  | "record_json_invalid"
  | "hydrated_group_missing"
  | "header_missing"
  | "visible_head_missing"
  | "runtime_batch_integrity"
  | "hydrate_unexpected";

const TAPE_DISPLAY_DEGRADE_LOG_MS = 60_000;
const tapeDisplayDegradeLogAt = new Map<string, number>();

export function resetTapeDisplayDegradeLogForTests(): void {
  tapeDisplayDegradeLogAt.clear();
}

export function classifyUnifiedTimelineIntegrityError(err: unknown): TapeDisplayDegradeReason {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("unified timeline tape record missing") || msg.includes("direct tape record missing")) {
    return "record_missing";
  }
  if (msg.includes("visible payload hash mismatch") || msg.includes("visible tape payload hash mismatch")) {
    return "visible_payload_hash_mismatch";
  }
  if (msg.includes("unified timeline record malformed") || msg.includes("direct tape record is not a JSON object")) {
    return "record_malformed";
  }
  if (msg.includes("unified timeline record JSON invalid") || msg.includes("not object")) {
    return "record_json_invalid";
  }
  if (msg.includes("unified timeline hydrated group missing")) return "hydrated_group_missing";
  if (msg.includes("unified timeline finalized tape missing") || msg.includes("finalized lossless turn tape missing")) {
    return "finalized_tape_missing";
  }
  if (msg.includes("unified timeline tape hash mismatch") || msg.includes("lossless turn tape aggregate hash mismatch")) {
    return "tape_hash_mismatch";
  }
  if (msg.includes("lossless runtime batch") || msg.includes("runtime tape record lacks")) {
    return "runtime_batch_integrity";
  }
  return "hydrate_unexpected";
}

export function pickTapeDisplayFallbackText(input: {
  visibleHead?: { text?: string | null } | null;
  anchorText?: unknown;
}): { text: string; source: "visible_head" | "anchor" | "placeholder" } {
  const head = typeof input.visibleHead?.text === "string" ? input.visibleHead.text : "";
  if (head.length > 0) return { text: head, source: "visible_head" };
  if (typeof input.anchorText === "string" && input.anchorText.length > 0) {
    return { text: input.anchorText, source: "anchor" };
  }
  return {
    text: "此轮回复暂时无法完整展开（记录物化异常）。正文仍保留在会话权威可见头中，稍后会自动补齐过程卡片。",
    source: "placeholder",
  };
}

export function warnTapeDisplayDegrade(input: {
  sessionId: string;
  tapeId: string;
  reason: TapeDisplayDegradeReason;
  detail?: string;
}): void {
  const key = `${input.tapeId}\0${input.reason}`;
  const now = Date.now();
  const last = tapeDisplayDegradeLogAt.get(key) ?? 0;
  if (now - last < TAPE_DISPLAY_DEGRADE_LOG_MS) return;
  tapeDisplayDegradeLogAt.set(key, now);
  console.warn(JSON.stringify({
    msg: "unified_timeline_tape_degraded",
    sessionId: input.sessionId,
    tapeId: input.tapeId,
    reason: input.reason,
    ...(input.detail ? { detail: input.detail.slice(0, 300) } : {}),
  }));
}

const PG_JSONB_REPLACEMENT = "\uFFFD";

function sanitizePgJsonbString(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      out += PG_JSONB_REPLACEMENT;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i]! + value[i + 1]!;
        i += 1;
      } else {
        out += PG_JSONB_REPLACEMENT;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += PG_JSONB_REPLACEMENT;
      continue;
    }
    out += value[i]!;
  }
  return out;
}

export function sanitizeValueForPgJsonb(value: unknown): unknown {
  if (typeof value === "string") return sanitizePgJsonbString(value);
  if (Array.isArray(value)) return value.map(sanitizeValueForPgJsonb);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, current] of Object.entries(value as Record<string, unknown>)) {
    out[sanitizePgJsonbString(key)] = sanitizeValueForPgJsonb(current);
  }
  return out;
}

/** Rewrite JSON bytes so PostgreSQL jsonb (`\u0000` / unpaired surrogates) will accept them.
 * Non-JSON / unparseable buffers are returned unchanged (original part BYTEA stays authoritative). */
export function sanitizeJsonBytesForPgJsonb(bytes: Buffer): { bytes: Buffer; changed: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { bytes, changed: false };
  }
  const sanitized = sanitizeValueForPgJsonb(parsed);
  const next = Buffer.from(JSON.stringify(sanitized), "utf8");
  if (next.equals(bytes)) return { bytes, changed: false };
  return { bytes: next, changed: true };
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
