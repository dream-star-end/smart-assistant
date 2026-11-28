import { gzipSync } from "node:zlib";
import {
  estimateModelHistoryTokens,
  modelHistorySemanticRole,
  modelHistorySemanticText,
} from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import { expandHydratedRuntimeBatch } from "../runtimeBatch.js";
import { hydrateTapeRecord } from "./pgTapeUsageAndRecordHydrate.js";
import { pgModelSidecarText, sha256Bytes } from "./sqlHelpers.js";
import type { HydratedTapeRow, UserVisiblePhysicalPayload } from "./types.js";

export const TAPE_RECORD_PAGE_MAX_ROWS = 200;
export const TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES = 8 * 1024 * 1024;
export const TAPE_RECORD_INLINE_QUANTUM_BYTES = 1024 * 1024;
export const UNIFIED_TIMELINE_TOOL_INLINE_QUANTUM_BYTES = 128 * 1024;

export function deferUnifiedTimelinePayload(role: string, payloadBytes: number): boolean {
  return payloadBytes > (
    role === "tool"
      ? UNIFIED_TIMELINE_TOOL_INLINE_QUANTUM_BYTES
      : TAPE_RECORD_INLINE_QUANTUM_BYTES
  );
}

const PRIVATE_TAPE_ROOT_FIELDS = new Set([
  "engineBilling",
  "engineBillings",
  "goalUsageRecords",
  "runtimeEvents",
]);

const PRIVATE_NESTED_DELEGATE_FIELDS = new Set([
  "_nestedDelegateRuntimeEvents",
  "_durableDelegateRuntimeEvents",
  "_durableDelegateEngineBillings",
  "_durableDelegateGoalUsageRecords",
]);

const PRIVATE_RUNTIME_FIELD_NAMES = new Set([
  "account", "accessToken", "apiKeySource", "auth", "authorization", "balance",
  "collaborationMode", "config", "cookie", "cookies", "credentials", "cwd",
  "developerInstructions", "env", "headers", "idToken", "mcpServers", "planType",
  "plugins", "rateLimits", "refreshToken", "signature", "skills", "systemInstructions",
  "systemPrompt", "threadSettings",
]);

function normalizedPrivateField(key: string): string {
  return key.replace(/^_+/, "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

const NORMALIZED_PRIVATE_RUNTIME_FIELDS = new Set(
  [...PRIVATE_RUNTIME_FIELD_NAMES].map(normalizedPrivateField),
);

function sanitizeNestedDelegateValue(value: unknown): { value: unknown; omitted: boolean } {
  if (Array.isArray(value)) {
    let omitted = false;
    const items = value.map((item) => {
      const next = sanitizeNestedDelegateValue(item);
      omitted ||= next.omitted;
      return next.value;
    });
    return { value: items, omitted };
  }
  if (!value || typeof value !== "object") return { value, omitted: false };
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let omitted = false;
  for (const [key, child] of Object.entries(source)) {
    if (PRIVATE_NESTED_DELEGATE_FIELDS.has(key)) {
      omitted = true;
      continue;
    }
    const next = sanitizeNestedDelegateValue(child);
    omitted ||= next.omitted;
    out[key] = next.value;
  }
  return { value: out, omitted };
}

function sanitizeRuntimeValue(value: unknown): { value: unknown; omitted: boolean } {
  if (Array.isArray(value)) {
    let omitted = false;
    const items = value.map((item) => {
      const next = sanitizeRuntimeValue(item);
      omitted ||= next.omitted;
      return next.value;
    });
    return { value: items, omitted };
  }
  if (!value || typeof value !== "object") return { value, omitted: false };
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let omitted = false;
  for (const [key, child] of Object.entries(source)) {
    if (
      PRIVATE_TAPE_ROOT_FIELDS.has(key) ||
      PRIVATE_NESTED_DELEGATE_FIELDS.has(key) ||
      NORMALIZED_PRIVATE_RUNTIME_FIELDS.has(normalizedPrivateField(key))
    ) {
      omitted = true;
      continue;
    }
    const next = sanitizeRuntimeValue(child);
    omitted ||= next.omitted;
    out[key] = next.value;
  }
  return { value: out, omitted };
}

export function userVisibleTapeRecord(value: MessageLike): MessageLike | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  let visible: Record<string, unknown> = { ...source };
  let omitted = false;
  for (const key of PRIVATE_TAPE_ROOT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(visible, key)) {
      delete visible[key];
      omitted = true;
    }
  }
  if (source.role === "agent-group") {
    const group = sanitizeNestedDelegateValue(visible);
    visible = group.value as Record<string, unknown>;
    omitted ||= group.omitted;
  }
  if (source.role === "runtime-event") {
    if (!source._runtimeEvent || typeof source._runtimeEvent !== "object" || Array.isArray(source._runtimeEvent)) {
      throw new Error("[pgSessions] runtime tape record lacks a structured event payload");
    }
    const event = sanitizeRuntimeValue(source._runtimeEvent);
    visible._runtimeEvent = event.value;
    visible.text = JSON.stringify(event.value);
    Reflect.deleteProperty(visible, "_hiddenRuntimeEvent");
    omitted ||= event.omitted;
  }
  for (const key of PRIVATE_NESTED_DELEGATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(visible, key)) {
      delete visible[key];
      omitted = true;
    }
  }
  if (omitted) visible._internalFieldsOmitted = true;
  return visible as MessageLike;
}

function bashOutputTailContinuity(record: MessageLike): { role: string; semanticText: string } | null {
  if (record.role !== "runtime-event") return null;
  const event = record._runtimeEvent;
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const raw = event as Record<string, unknown>;
  if (raw.type !== "system" || raw.subtype !== "bash_output_tail") return null;
  return {
    role: "tool",
    semanticText: `Exact tool output tail: ${JSON.stringify({
      toolUseId: raw.tool_use_id,
      parentToolUseId: raw.parent_tool_use_id,
      tail: raw.tail,
      totalBytes: raw.total_bytes,
      truncatedHead: raw.truncated_head === true,
    })}`,
  };
}

export function modelContinuityRecords(
  records: MessageLike[],
): UserVisiblePhysicalPayload["modelRecords"] {
  const out: UserVisiblePhysicalPayload["modelRecords"] = [];
  for (let logicalOrdinal = 0; logicalOrdinal < records.length; logicalOrdinal++) {
    const record = records[logicalOrdinal]!;
    let role: string | null = modelHistorySemanticRole(record);
    let semanticText = modelHistorySemanticText(record);
    if (!role) {
      const tail = bashOutputTailContinuity(record);
      if (tail) {
        role = tail.role;
        semanticText = tail.semanticText;
      }
    }
    semanticText = pgModelSidecarText(semanticText);
    if (!role || semanticText.trim().length === 0) continue;
    out.push({
      logicalOrdinal,
      msgId: typeof record.id === "string" && record.id.length > 0
        ? record.id
        : `logical-${logicalOrdinal}`,
      role,
      semanticText,
      tokenEstimate: estimateModelHistoryTokens(semanticText),
      ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : null,
      clientMessageId: typeof record._clientMessageId === "string"
        ? record._clientMessageId
        : null,
    });
  }
  return out;
}

export function encodeUserVisibleRuntimeBatch(
  physical: MessageLike,
  row: HydratedTapeRow,
  records: MessageLike[],
): Buffer {
  const parts = records.map((record) => Buffer.from(JSON.stringify(record), "utf8"));
  let offset = 0;
  const manifest = records.map((record, index) => {
    const bytes = parts[index]!;
    const entry = {
      id: record.id,
      eventOrdinal: record._ocEventOrdinal,
      ts: record.ts,
      source: record._runtimeSource,
      offset,
      length: bytes.length,
      payloadSha256: sha256Bytes(bytes),
    };
    offset += bytes.length;
    return entry;
  });
  const raw = Buffer.concat(parts);
  const compressed = gzipSync(raw, { level: 9 });
  const wrapper: MessageLike = {
    id: row.msg_id,
    role: "runtime-event",
    text: "",
    ts: typeof physical.ts === "number" ? physical.ts : records[0]?.ts ?? 0,
    _runtimeEventBatch: {
      version: 1,
      encoding: "gzip+base64",
      logicalCount: records.length,
      uncompressedBytes: raw.length,
      compressedBytes: compressed.length,
      manifest,
      manifestSha256: sha256Bytes(Buffer.from(JSON.stringify(manifest), "utf8")),
      data: compressed.toString("base64"),
    },
  };
  if (physical.usage !== undefined) wrapper.usage = structuredClone(physical.usage);
  return Buffer.from(JSON.stringify(wrapper), "utf8");
}

export function userVisiblePhysicalPayload(
  row: HydratedTapeRow,
  tapeSha256: string,
  billingAnchorId: string,
): UserVisiblePhysicalPayload | null {
  const anchor: MessageLike = { id: billingAnchorId, _turnTapeSha256: tapeSha256 };
  const hydrated = hydrateTapeRecord(row, anchor, false, true);
  let bytes: Buffer;
  let visibleRecords: MessageLike[];
  if (hydrated._runtimeEventBatch !== undefined) {
    const expanded = expandHydratedRuntimeBatch(hydrated, row, anchor).messages;
    const visible = expanded
      .map(userVisibleTapeRecord)
      .filter((message): message is MessageLike => message !== null);
    if (visible.length === 0) return null;
    visibleRecords = visible;
    bytes = encodeUserVisibleRuntimeBatch(hydrated, row, visible);
  } else {
    const visible = userVisibleTapeRecord(hydrated);
    if (!visible) return null;
    visibleRecords = [visible];
    bytes = Buffer.from(JSON.stringify(visible), "utf8");
  }
  return {
    bytes,
    contentSha256: sha256Bytes(bytes),
    msgId: row.msg_id,
    role: row.role,
    modelRecords: modelContinuityRecords(visibleRecords),
  };
}
