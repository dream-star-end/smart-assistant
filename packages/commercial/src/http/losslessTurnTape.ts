import { createHash } from "node:crypto";

import {
  isClientMessageId,
  LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID,
  type DurableCodexBilling,
} from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";

export type LosslessTurnPayload = {
  sessionId: string;
  agentId: string;
  turnIndex: number;
  clientMessageId?: string;
  status: "completed" | "interrupted" | "crashed";
  turnKey: string;
  continuationOfTurnKey?: string;
  parentTurnKey?: string;
  text: string;
  thinkingText?: string;
  createdAt: number;
  requestId?: string;
  agentSessionId?: string;
  goalId?: string;
  goalStateRevision?: number;
  usage?: Record<string, unknown>;
  truncated?: boolean;
  errorCode?: string;
  errorDetail?: string;
  tools?: Array<Record<string, unknown>>;
  assistantSegments?: Array<{ index: number; text: string; ts: number; eventOrdinal?: number }>;
  thinkingSegments?: Array<{ index: number; text: string; ts: number; eventOrdinal?: number }>;
  agentGroups?: Array<Record<string, unknown>>;
  structuredBlocks?: Array<Record<string, unknown>>;
  runtimeEvents?: Array<{
    ordinal: number;
    observedAt: number;
    source: "ccb" | "codex-jsonrpc" | "gateway";
    payload: unknown;
  }>;
  engineBilling?: DurableCodexBilling;
};

export type LosslessTurnRecord = {
  id: string;
  role: string;
  ts: number;
  payload: MessageLike & { id: string };
  payloadBytes: Buffer;
  payloadSha256: string;
  eventOrdinal?: number;
};

export type MaterializedLosslessTurn = {
  payload: LosslessTurnPayload;
  records: LosslessTurnRecord[];
  billingAnchorId: string;
  /** Root + delegate final billing frames, each validated against the owning
   * tape locator. Master must settle all of them before ACKing finalize. */
  engineBillings: DurableCodexBilling[];
};

const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_TURN_KEY = /^[0-9a-f]{64}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Detect only the legacy raw billing field at its two sanctioned locations;
 * user/tool text that happens to contain the word `errorReason` is unrelated. */
export function hasLegacyRawBillingReason(raw: unknown): boolean {
  if (!isObject(raw)) return false;
  if (isObject(raw.engineBilling) && Object.prototype.hasOwnProperty.call(raw.engineBilling, "errorReason")) {
    return true;
  }
  if (!Array.isArray(raw.agentGroups)) return false;
  return raw.agentGroups.some((group) =>
    isObject(group) && Array.isArray(group.engineBillings) &&
    group.engineBillings.some((billing) =>
      isObject(billing) && Object.prototype.hasOwnProperty.call(billing, "errorReason")));
}

function requiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw new Error(`turn tape payload.${key} must be a string`);
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`turn tape payload.${key} must be a string`);
  return value;
}

function requiredInt(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`turn tape payload.${key} must be a non-negative safe integer`);
  }
  return value;
}

function optionalPositiveInt(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`turn tape payload.${key} must be a positive safe integer`);
  }
  return value;
}

function optionalObject(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`turn tape payload.${key} must be an object`);
  return value;
}

function optionalObjectArray(obj: Record<string, unknown>, key: string): Array<Record<string, unknown>> | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !isObject(entry))) {
    throw new Error(`turn tape payload.${key} must be an object array`);
  }
  return value as Array<Record<string, unknown>>;
}

function parseSegments(
  obj: Record<string, unknown>,
  key: "assistantSegments" | "thinkingSegments",
): Array<{ index: number; text: string; ts: number; eventOrdinal?: number }> | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`turn tape payload.${key} must be an array`);
  return value.map((raw, ordinal) => {
    if (!isObject(raw)) throw new Error(`turn tape payload.${key}[${ordinal}] must be an object`);
    const eventOrdinal = raw.eventOrdinal === undefined ? undefined : requiredInt(raw, "eventOrdinal");
    return {
      index: requiredInt(raw, "index"),
      text: requiredString(raw, "text"),
      ts: requiredInt(raw, "ts"),
      ...(eventOrdinal !== undefined ? { eventOrdinal } : {}),
    };
  });
}

function parseRuntimeEvents(obj: Record<string, unknown>): LosslessTurnPayload["runtimeEvents"] {
  const value = obj.runtimeEvents;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("turn tape payload.runtimeEvents must be an array");
  return value.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`turn tape payload.runtimeEvents[${index}] must be an object`);
    const source = entry.source;
    if (source !== "ccb" && source !== "codex-jsonrpc" && source !== "gateway") {
      throw new Error(`turn tape payload.runtimeEvents[${index}].source is invalid`);
    }
    return {
      ordinal: requiredInt(entry, "ordinal"),
      observedAt: requiredInt(entry, "observedAt"),
      source,
      payload: entry.payload,
    };
  });
}

function parseEngineBillingValue(value: unknown, path: string): DurableCodexBilling {
  const prefix = `turn tape payload.${path}`;
  if (!isObject(value)) throw new Error(`${prefix} must be an object`);
  const finiteInt = (raw: unknown, field: string): number | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      throw new Error(`${prefix}.${field} is invalid`);
    }
    return raw;
  };
  const requestId = requiredString(value, "requestId");
  const engineSessionId = requiredString(value, "engineSessionId");
  if (!/^[0-9a-f]{32}$/.test(requestId)) throw new Error(`${prefix}.requestId is invalid`);
  if (!/^oceng-[0-9a-f]{48}$/.test(engineSessionId)) {
    throw new Error(`${prefix}.engineSessionId is invalid`);
  }
  if (value.status !== "success" && value.status !== "error") {
    throw new Error(`${prefix}.status is invalid`);
  }
  if (value.terminalCode !== undefined &&
      value.terminalCode !== "USER_CANCELLED" && value.terminalCode !== "CODEX_ERROR") {
    throw new Error(`${prefix}.terminalCode is invalid`);
  }
  for (const key of ["turnKey", "parentTurnKey"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !SAFE_TURN_KEY.test(value[key] as string))) {
      throw new Error(`${prefix}.${key} is invalid`);
    }
  }
  if (value.parentSessionId !== undefined &&
      (typeof value.parentSessionId !== "string" || value.parentSessionId.length < 1 || value.parentSessionId.length > 256)) {
    throw new Error(`${prefix}.parentSessionId is invalid`);
  }
  if (value.delegateAgentId !== undefined &&
      (typeof value.delegateAgentId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.delegateAgentId))) {
    throw new Error(`${prefix}.delegateAgentId is invalid`);
  }
  finiteInt(value.durationMs, "durationMs");
  if (value.errorReason !== undefined && typeof value.errorReason !== "string") {
    throw new Error(`${prefix}.errorReason is invalid`);
  }
  if (value.usage !== undefined) {
    if (!isObject(value.usage)) throw new Error(`${prefix}.usage is invalid`);
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "reasoning_output_tokens",
    ]) finiteInt(value.usage[key], `usage.${key}`);
  }
  if (value.rateLimits !== undefined) {
    if (!isObject(value.rateLimits)) throw new Error(`${prefix}.rateLimits is invalid`);
    for (const key of ["util5h", "util7d"] as const) {
      const raw = value.rateLimits[key];
      if (raw !== undefined && (typeof raw !== "number" || !Number.isFinite(raw))) {
        throw new Error(`${prefix}.rateLimits.${key} is invalid`);
      }
    }
    for (const key of ["reset5h", "reset7d"] as const) {
      const raw = value.rateLimits[key];
      if (raw !== undefined && typeof raw !== "string") {
        throw new Error(`${prefix}.rateLimits.${key} is invalid`);
      }
    }
  }
  const exact = structuredClone(value);
  const legacyReason = exact.errorReason;
  delete exact.errorReason;
  if (
    exact.status === "error" &&
    exact.terminalCode !== "USER_CANCELLED" &&
    exact.terminalCode !== "CODEX_ERROR"
  ) {
    exact.terminalCode = legacyReason === "codex turn interrupted"
      ? "USER_CANCELLED"
      : "CODEX_ERROR";
  }
  return exact as unknown as DurableCodexBilling;
}

function parseEngineBilling(obj: Record<string, unknown>): DurableCodexBilling | undefined {
  const value = obj.engineBilling;
  if (value === undefined) return undefined;
  return parseEngineBillingValue(value, "engineBilling");
}

function parseAgentGroups(obj: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const groups = optionalObjectArray(obj, "agentGroups");
  if (groups === undefined) return undefined;
  return groups.map((group, groupIndex) => {
    const exact = structuredClone(group);
    const rawUsage = group.goalUsageRecords;
    if (rawUsage !== undefined) {
      if (!Array.isArray(rawUsage)) {
        throw new Error(`turn tape payload.agentGroups[${groupIndex}].goalUsageRecords must be an array`);
      }
      exact.goalUsageRecords = rawUsage.map((record, recordIndex) => {
        if (!isObject(record)) {
          throw new Error(`turn tape payload.agentGroups[${groupIndex}].goalUsageRecords[${recordIndex}] must be an object`);
        }
        const runId = requiredString(record, "runId");
        const agentId = requiredString(record, "agentId");
        if (!runId || runId.length > 128 || !SAFE_AGENT_ID.test(agentId)) {
          throw new Error(`turn tape payload.agentGroups[${groupIndex}].goalUsageRecords[${recordIndex}] identity is invalid`);
        }
        if (record.engine !== "ccb" && record.engine !== "codex") {
          throw new Error(`turn tape payload.agentGroups[${groupIndex}].goalUsageRecords[${recordIndex}].engine is invalid`);
        }
        return {
          runId,
          agentId,
          engine: record.engine,
          inputTokens: requiredInt(record, "inputTokens"),
          outputTokens: requiredInt(record, "outputTokens"),
          cacheReadTokens: requiredInt(record, "cacheReadTokens"),
          cacheCreationTokens: requiredInt(record, "cacheCreationTokens"),
        };
      });
    }
    const rawBillings = group.engineBillings;
    if (rawBillings === undefined) return exact;
    if (!Array.isArray(rawBillings)) {
      throw new Error(`turn tape payload.agentGroups[${groupIndex}].engineBillings must be an array`);
    }
    return {
      ...exact,
      engineBillings: rawBillings.map((billing, billingIndex) =>
        parseEngineBillingValue(
          billing,
          `agentGroups[${groupIndex}].engineBillings[${billingIndex}]`,
        )),
    };
  });
}

/** Strictly validates routing/identity fields while leaving generated content unbounded. */
export function parseLosslessTurnPayload(raw: unknown): LosslessTurnPayload {
  if (!isObject(raw)) throw new Error("turn tape payload must be an object");
  const sessionId = requiredString(raw, "sessionId");
  const agentId = requiredString(raw, "agentId");
  const turnIndex = requiredInt(raw, "turnIndex");
  const clientMessageId = optionalString(raw, "clientMessageId");
  if (clientMessageId !== undefined && !isClientMessageId(clientMessageId)) {
    throw new Error("turn tape payload.clientMessageId is invalid");
  }
  const status = raw.status;
  const turnKey = requiredString(raw, "turnKey");
  if (sessionId.length < 8 || sessionId.length > 50) throw new Error("turn tape payload.sessionId is invalid");
  if (!SAFE_AGENT_ID.test(agentId)) throw new Error("turn tape payload.agentId is invalid");
  if (status !== "completed" && status !== "interrupted" && status !== "crashed") {
    throw new Error("turn tape payload.status is invalid");
  }
  if (!SAFE_TURN_KEY.test(turnKey)) throw new Error("turn tape payload.turnKey is invalid");
  const parentTurnKey = optionalString(raw, "parentTurnKey");
  if (parentTurnKey !== undefined && !SAFE_TURN_KEY.test(parentTurnKey)) {
    throw new Error("turn tape payload.parentTurnKey is invalid");
  }
  const continuationOfTurnKey = optionalString(raw, "continuationOfTurnKey");
  if (continuationOfTurnKey !== undefined && !SAFE_TURN_KEY.test(continuationOfTurnKey)) {
    throw new Error("turn tape payload.continuationOfTurnKey is invalid");
  }
  const truncated = raw.truncated;
  if (truncated !== undefined && typeof truncated !== "boolean") {
    throw new Error("turn tape payload.truncated must be boolean");
  }
  const thinkingText = optionalString(raw, "thinkingText");
  const createdAt = optionalPositiveInt(raw, "createdAt");
  if (createdAt === undefined) throw new Error("turn tape payload.createdAt is required");
  const requestId = optionalString(raw, "requestId");
  const agentSessionId = optionalString(raw, "agentSessionId");
  const goalId = optionalString(raw, "goalId");
  const goalStateRevision = optionalPositiveInt(raw, "goalStateRevision");
  if ((goalId === undefined) !== (goalStateRevision === undefined)) {
    throw new Error("turn tape payload goalId and goalStateRevision must be present together");
  }
  if (goalId !== undefined && !SAFE_UUID.test(goalId)) {
    throw new Error("turn tape payload.goalId is invalid");
  }
  const usage = optionalObject(raw, "usage");
  const errorCode = optionalString(raw, "errorCode");
  const errorDetail = optionalString(raw, "errorDetail");
  const tools = optionalObjectArray(raw, "tools");
  const assistantSegments = parseSegments(raw, "assistantSegments");
  const thinkingSegments = parseSegments(raw, "thinkingSegments");
  const agentGroups = parseAgentGroups(raw);
  const structuredBlocks = optionalObjectArray(raw, "structuredBlocks");
  const runtimeEvents = parseRuntimeEvents(raw);
  const engineBilling = parseEngineBilling(raw);
  if (engineBilling !== undefined) {
    if (requestId !== engineBilling.requestId) {
      throw new Error("turn tape payload engineBilling.requestId does not match requestId");
    }
    if (engineBilling.turnKey !== turnKey || engineBilling.parentTurnKey !== undefined) {
      throw new Error("turn tape payload root engineBilling turn locator is invalid");
    }
  }
  const seenBillingRequestIds = new Set<string>();
  if (engineBilling) seenBillingRequestIds.add(engineBilling.requestId);
  for (let groupIndex = 0; groupIndex < (agentGroups ?? []).length; groupIndex++) {
    const group = agentGroups![groupIndex]!;
    const billings = group.engineBillings;
    if (billings === undefined) continue;
    for (let billingIndex = 0; billingIndex < (billings as DurableCodexBilling[]).length; billingIndex++) {
      const billing = (billings as DurableCodexBilling[])[billingIndex]!;
      if (billing.parentTurnKey !== turnKey || billing.parentSessionId !== sessionId) {
        throw new Error(
          `turn tape payload.agentGroups[${groupIndex}].engineBillings[${billingIndex}] parent locator is invalid`,
        );
      }
      if (!billing.delegateAgentId) {
        throw new Error(
          `turn tape payload.agentGroups[${groupIndex}].engineBillings[${billingIndex}] delegateAgentId is required`,
        );
      }
      if (seenBillingRequestIds.has(billing.requestId)) {
        throw new Error("turn tape payload contains duplicate engine billing requestId");
      }
      seenBillingRequestIds.add(billing.requestId);
    }
  }
  if (continuationOfTurnKey !== undefined) {
    if (
      status !== "completed" ||
      requiredString(raw, "text") !== "" ||
      parentTurnKey !== undefined ||
      clientMessageId !== undefined ||
      requestId !== undefined ||
      agentSessionId !== undefined ||
      goalId !== undefined ||
      goalStateRevision !== undefined ||
      usage !== undefined ||
      thinkingText !== undefined ||
      truncated !== undefined ||
      errorCode !== undefined ||
      errorDetail !== undefined ||
      tools !== undefined ||
      assistantSegments !== undefined ||
      thinkingSegments !== undefined ||
      agentGroups !== undefined ||
      structuredBlocks !== undefined ||
      engineBilling !== undefined ||
      !runtimeEvents?.length
    ) {
      throw new Error("turn tape continuation must contain only completed runtimeEvents");
    }
  }
  return {
    sessionId,
    agentId,
    turnIndex,
    status,
    turnKey,
    ...(clientMessageId !== undefined ? { clientMessageId } : {}),
    ...(continuationOfTurnKey !== undefined ? { continuationOfTurnKey } : {}),
    ...(parentTurnKey !== undefined ? { parentTurnKey } : {}),
    text: requiredString(raw, "text"),
    ...(thinkingText !== undefined ? { thinkingText } : {}),
    createdAt,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(agentSessionId !== undefined ? { agentSessionId } : {}),
    ...(goalId !== undefined ? { goalId, goalStateRevision: goalStateRevision! } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(truncated === true ? { truncated: true } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorDetail !== undefined ? { errorDetail } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(assistantSegments !== undefined ? { assistantSegments } : {}),
    ...(thinkingSegments !== undefined ? { thinkingSegments } : {}),
    ...(agentGroups !== undefined ? { agentGroups } : {}),
    ...(structuredBlocks !== undefined ? { structuredBlocks } : {}),
    ...(runtimeEvents !== undefined ? { runtimeEvents } : {}),
    ...(engineBilling !== undefined ? { engineBilling } : {}),
  };
}

/** Sum the root execution and every delegate execution exactly once. The
 * normalized per-run records remain unaggregated on the tape so nested mixed
 * engine trees can be audited without re-reading billing ledgers. */
export function computeGoalTokensUsed(payload: LosslessTurnPayload): number {
  const seenRunIds = new Set<string>();
  let total = 0;
  const add = (value: unknown, field: string): void => {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`turn tape payload ${field} must be a non-negative safe integer`);
    }
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error("turn tape payload goal token total exceeds safe integer range");
  };
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
    add(payload.usage?.[field], `usage.${field}`);
  }
  let delegateRecordCount = 0;
  for (let groupIndex = 0; groupIndex < (payload.agentGroups ?? []).length; groupIndex++) {
    const records = payload.agentGroups![groupIndex]!.goalUsageRecords;
    if (records === undefined) continue;
    if (!Array.isArray(records)) throw new Error(`turn tape payload.agentGroups[${groupIndex}].goalUsageRecords must be an array`);
    for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
      const record = records[recordIndex] as Record<string, unknown>;
      const runId = requiredString(record, "runId");
      if (seenRunIds.has(runId)) throw new Error("turn tape payload contains duplicate goal usage runId");
      seenRunIds.add(runId);
      delegateRecordCount += 1;
      for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
        add(record[field], `agentGroups[${groupIndex}].goalUsageRecords[${recordIndex}].${field}`);
      }
    }
  }
  if (!payload.goalId && delegateRecordCount > 0) {
    throw new Error("turn tape payload without goal attribution cannot contain goal usage records");
  }
  return payload.goalId ? total : 0;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(
  payload: MessageLike & { id: string },
  eventOrdinal?: number,
): LosslessTurnRecord {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    id: payload.id,
    role: typeof payload.role === "string" ? payload.role : "unknown",
    ts: typeof payload.ts === "number" ? payload.ts : 0,
    payload,
    payloadBytes,
    payloadSha256: sha256(payloadBytes),
    ...(eventOrdinal !== undefined ? { eventOrdinal } : {}),
  };
}

/** Converts one complete canonical payload into immutable UI message records. */
export function materializeLosslessTurn(raw: unknown): MaterializedLosslessTurn {
  const body = parseLosslessTurnPayload(raw);
  const baseTs = body.createdAt;
  const tools = body.tools ?? [];
  const idPart = body.agentId === LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID
    ? body.sessionId
    : `${body.sessionId}-${body.agentId}`;
  const prefix = `srv-${idPart}-t${body.turnIndex}`;
  const records: LosslessTurnRecord[] = [];

  if (
    body.thinkingSegments?.length &&
    body.thinkingSegments.map((segment) => segment.text).join("") !== (body.thinkingText ?? "")
  ) {
    throw new Error("turn tape thinking segments do not reconstruct thinkingText");
  }
  if (
    body.assistantSegments?.length &&
    body.assistantSegments.map((segment) => segment.text).join("") !== body.text
  ) {
    throw new Error("turn tape assistant segments do not reconstruct text");
  }

  if (body.thinkingSegments?.length) {
    for (const segment of body.thinkingSegments) {
      records.push(record({
        id: `${prefix}-thinking-s${segment.index}`,
        role: "thinking",
        text: segment.text,
        ts: segment.ts,
        status: body.status,
      }, segment.eventOrdinal));
    }
  } else if (body.thinkingText) {
    records.push(record({
      id: `${prefix}-thinking`,
      role: "thinking",
      text: body.thinkingText,
      ts: baseTs - tools.length - 1,
      status: body.status,
    }));
  }

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]!;
    const blockId = requiredString(tool, "blockId");
    const output = requiredString(tool, "output");
    const completed = tool.completed !== false;
    const arrivedAt = tool.arrivedAt;
    const toolTs = typeof arrivedAt === "number" && Number.isSafeInteger(arrivedAt) && arrivedAt >= 0
      ? arrivedAt
      : baseTs - tools.length + i;
    const toolEventOrdinal = typeof tool.eventOrdinal === "number" && Number.isSafeInteger(tool.eventOrdinal)
      ? tool.eventOrdinal
      : undefined;
    records.push(record({
      ...tool,
      id: `${prefix}-tool-${blockId}`,
      role: "tool",
      text: output,
      ts: toolTs,
      status: body.status,
      toolName: requiredString(tool, "toolName"),
      blockId,
      inputJson: tool.inputJson,
      inputPreview: typeof tool.inputPreview === "string" ? tool.inputPreview : "",
      output,
      error: Boolean(tool.isError),
      durationMs: typeof tool.durationMs === "number" ? tool.durationMs : 0,
      ...(completed ? {} : { partial: true }),
      _completed: completed,
    }, toolEventOrdinal));
  }

  for (const group of body.agentGroups ?? []) {
    const runId = requiredString(group, "runId");
    const goal = requiredString(group, "goal");
    const completedAt = requiredInt(group, "completedAt");
    const groupStatus = group.status;
    if (groupStatus !== "ok" && groupStatus !== "failed" && groupStatus !== "timeout") {
      throw new Error("turn tape agentGroups[].status is invalid");
    }
    const groupEventOrdinal = typeof group._ocEventOrdinal === "number" && Number.isSafeInteger(group._ocEventOrdinal)
      ? group._ocEventOrdinal
      : undefined;
    records.push(record({
      ...group,
      id: `${prefix}-agentgroup-${runId}`,
      role: "agent-group",
      text: goal,
      ts: completedAt,
      status: body.status,
      _delegate: true,
      _delegateRunId: runId,
      _delegateAgentId: requiredString(group, "agentId"),
      _delegateGoal: goal,
      _delegateStatus: groupStatus,
      _isError: groupStatus !== "ok",
      _completed: true,
      completedAt,
      ...(typeof group.resultSummary === "string" ? { _resultPreview: group.resultSummary } : {}),
      ...(group.verdict === "PASS" || group.verdict === "NEEDS_FIX" ? { _reviewVerdict: group.verdict } : {}),
      ...(Array.isArray(group.transcript) ? { childBlocks: group.transcript } : {}),
    }, groupEventOrdinal));
  }

  const structuredGroups = new Map<
    string,
    { kind: "plan" | "goal"; blockId: string; events: Array<Record<string, unknown>> }
  >();
  for (let ordinal = 0; ordinal < (body.structuredBlocks ?? []).length; ordinal++) {
    const block = body.structuredBlocks![ordinal]!;
    const kind = block.kind;
    if (kind !== "plan" && kind !== "goal") {
      throw new Error("turn tape structuredBlocks[].kind is invalid");
    }
    const platformGoalId = kind === "goal" && typeof block.platformGoalId === "string" && block.platformGoalId.length > 0
      ? block.platformGoalId
      : null;
    const blockId = platformGoalId
      ? `platform-goal-${platformGoalId}`
      : typeof block.blockId === "string" && block.blockId.length > 0
        ? block.blockId
        : `${kind}-${ordinal}`;
    const key = `${kind}\0${blockId}`;
    const current = structuredGroups.get(key) ?? { kind, blockId, events: [] };
    current.events.push(block);
    structuredGroups.set(key, current);
  }
  for (const [key, group] of structuredGroups) {
    const last = group.events.at(-1)!;
    const observedAt = last._ocObservedAt;
    const ts = typeof observedAt === "number" && Number.isSafeInteger(observedAt) && observedAt > 0
      ? observedAt
      : baseTs;
    const eventHistory = group.events.map((event) => {
      const { _ocObservedAt, _ocEventOrdinal, ...exactBlock } = event;
      return exactBlock;
    });
    const { _ocObservedAt, _ocEventOrdinal, ...lastBlock } = last;
    const identity = sha256(Buffer.from(key, "utf8"));
    if (group.kind === "plan") {
      records.push(record({
        ...lastBlock,
        id: `${prefix}-plan-${identity}`,
        role: "plan",
        blockId: group.blockId,
        text: typeof lastBlock.text === "string" ? lastBlock.text : "",
        ts,
        _partial: lastBlock.partial === true,
        _eventHistory: eventHistory,
        status: body.status,
      }, typeof _ocEventOrdinal === "number" ? _ocEventOrdinal : undefined));
    } else {
      records.push(record({
        ...lastBlock,
        id: `${prefix}-goal-${identity}`,
        role: "goal",
        blockId: group.blockId,
        text: typeof lastBlock.objective === "string" ? lastBlock.objective : "",
        goalStatus: typeof lastBlock.status === "string" ? lastBlock.status : "",
        ts,
        _eventHistory: eventHistory,
        status: body.status,
      }, typeof _ocEventOrdinal === "number" ? _ocEventOrdinal : undefined));
    }
  }

  const assistantRecords: LosslessTurnRecord[] = [];
  if (body.assistantSegments?.length) {
    for (let i = 0; i < body.assistantSegments.length; i++) {
      const segment = body.assistantSegments[i]!;
      const last = i === body.assistantSegments.length - 1;
      assistantRecords.push(record({
        id: `${prefix}-s${segment.index}`,
        role: "assistant",
        text: segment.text,
        ts: segment.ts,
        status: body.status,
        ...(last && body.usage ? { usage: body.usage } : {}),
        ...(last && body.truncated ? { _truncated: true } : {}),
        ...(last && body.errorCode ? { _errorCode: body.errorCode } : {}),
        ...(last && body.errorDetail ? { _errorDetail: body.errorDetail } : {}),
      }, segment.eventOrdinal));
    }
  } else if (body.text.length > 0 || body.errorDetail || body.errorCode) {
    const visibleText = body.text.length > 0
      ? body.text
      : body.errorDetail ?? body.errorCode ?? "unknown error";
    assistantRecords.push(record({
      id: prefix,
      role: "assistant",
      text: visibleText,
      ts: baseTs,
      status: body.status,
      ...(body.text.length === 0 ? { _isError: true } : {}),
      ...(body.usage ? { usage: body.usage } : {}),
      ...(body.truncated ? { _truncated: true } : {}),
      ...(body.errorCode ? { _errorCode: body.errorCode } : {}),
      ...(body.errorDetail ? { _errorDetail: body.errorDetail } : {}),
    }));
  }
  records.push(...assistantRecords);

  for (const event of body.runtimeEvents ?? []) {
    records.push(record({
      id: `${prefix}-runtime-${event.ordinal}`,
      role: "runtime-event",
      text: JSON.stringify(event.payload),
      ts: event.observedAt,
      status: body.status,
      _runtimeSource: event.source,
      _runtimeEvent: event.payload,
      _ocEventOrdinal: event.ordinal,
      _hiddenRuntimeEvent: true,
      ...(body.continuationOfTurnKey
        ? { _continuationOfTurnKey: body.continuationOfTurnKey }
        : {}),
    }, event.ordinal));
  }
  if (records.length === 0) throw new Error("turn tape contains no persistable records");

  // Exact origin attribution is part of each immutable message payload (not
  // a database column). Recompute bytes/hash after stamping so tape hashes,
  // hot history and archived history all expose the same evidence.
  if (body.clientMessageId) {
    for (const item of records) {
      item.payload = { ...item.payload, _clientMessageId: body.clientMessageId };
      item.payloadBytes = Buffer.from(JSON.stringify(item.payload), "utf8");
      item.payloadSha256 = sha256(item.payloadBytes);
    }
  }

  const seen = new Set<string>();
  for (const item of records) {
    if (seen.has(item.id)) throw new Error(`turn tape contains duplicate record id ${item.id}`);
    seen.add(item.id);
  }
  records.sort((a, b) => {
    const ao = a.eventOrdinal ?? Number.MAX_SAFE_INTEGER;
    const bo = b.eventOrdinal ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.id.localeCompare(b.id);
  });
  const billingAnchorId = assistantRecords.at(-1)?.id ?? records.at(-1)!.id;
  const engineBillings = [
    ...(body.engineBilling ? [structuredClone(body.engineBilling)] : []),
    ...(body.agentGroups ?? []).flatMap((group) =>
      Array.isArray(group.engineBillings)
        ? (group.engineBillings as DurableCodexBilling[]).map((billing) => structuredClone(billing))
        : []),
  ];
  return { payload: body, records, billingAnchorId, engineBillings };
}
