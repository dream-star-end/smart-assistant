/** Exact wire shape for durable first-round handoff evidence. No raw tool
 * input/result may appear here; every reader shares this validator. */
import type { BoxToolUseDigest } from "./boxToolInputHash.js";
import type { BoxUsageEvidence } from "./boxDurableJournal.js";
import { BOX_TOOL_SPOOL_MAX_BYTES } from "./boxToolCapacity.js";

export interface BoxStoredToolHandoff {
  version: 1;
  roundNo: number;
  messageId: string;
  assistantContentHash: string;
  spoolOffset: number;
  detachedRunnerHash: string;
  catalogHash: string;
  toolUses: BoxToolUseDigest[];
  verifiedPendingToolUseIds: string[];
  usage: BoxUsageEvidence;
}
function record(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
function dense(x: unknown[], max: number): boolean {
  return x.length >= 1 && x.length <= max
    && Array.from({ length: x.length }, (_, i) => i).every((i) => Object.hasOwn(x, i));
}
export function parseBoxStoredToolHandoff(raw: unknown): BoxStoredToolHandoff | null {
  if (!record(raw)
    || Object.keys(raw).sort().join(",") !==
      "assistantContentHash,catalogHash,detachedRunnerHash,messageId,roundNo,spoolOffset,toolUses,usage,verifiedPendingToolUseIds,version"
    || raw.version !== 1 || !Number.isSafeInteger(raw.roundNo)
    || Number(raw.roundNo) < 1 || Number(raw.roundNo) > 32
    || typeof raw.messageId !== "string" || raw.messageId.length < 1
    || raw.messageId.length > 128
    || typeof raw.assistantContentHash !== "string"
    || !/^[a-f0-9]{64}$/.test(raw.assistantContentHash)
    || !Number.isSafeInteger(raw.spoolOffset) || Number(raw.spoolOffset) < 1
    || Number(raw.spoolOffset) > BOX_TOOL_SPOOL_MAX_BYTES
    || typeof raw.detachedRunnerHash !== "string"
    || !/^[a-f0-9]{64}$/.test(raw.detachedRunnerHash)
    || typeof raw.catalogHash !== "string"
    || !/^[a-f0-9]{64}$/.test(raw.catalogHash)
    || !Array.isArray(raw.toolUses) || !dense(raw.toolUses, 32)
    || !Array.isArray(raw.verifiedPendingToolUseIds)
    || !dense(raw.verifiedPendingToolUseIds, raw.toolUses.length)
    || !record(raw.usage)) return null;
  const ids = new Set<string>();
  for (const item of raw.toolUses) {
    if (!record(item) || Object.keys(item).sort().join(",") !==
        "boxName,clientName,id,inputHash"
      || typeof item.id !== "string" || !/^toolu_[A-Za-z0-9_-]{1,120}$/.test(item.id)
      || ids.has(item.id)
      || typeof item.boxName !== "string"
      || !/^mcp__ocbridge__t[0-9]{1,3}$/.test(item.boxName)
      || typeof item.clientName !== "string" || item.clientName.length < 1
      || item.clientName.length > 128
      || typeof item.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(item.inputHash)) return null;
    ids.add(item.id);
  }
  const pending = new Set<string>();
  for (const id of raw.verifiedPendingToolUseIds) {
    if (typeof id !== "string" || !ids.has(id) || pending.has(id)) return null;
    pending.add(id);
  }
  const usage = raw.usage;
  if (Object.keys(usage).sort().join(",") !==
      "cacheReadTokens,cacheWriteTokens,inputTokens,outputTokens"
    || [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens,
      usage.cacheWriteTokens].some((v) => !Number.isSafeInteger(v) || Number(v) < 0)) return null;
  return raw as unknown as BoxStoredToolHandoff;
}
