import { createHash } from "node:crypto";

import { LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID } from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";

export type LosslessTurnPayload = {
  sessionId: string;
  agentId: string;
  turnIndex: number;
  status: "completed" | "interrupted" | "crashed";
  turnKey: string;
  parentTurnKey?: string;
  text: string;
  thinkingText?: string;
  createdAt: number;
  requestId?: string;
  agentSessionId?: string;
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
};

const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_TURN_KEY = /^[0-9a-f]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

/** Strictly validates routing/identity fields while leaving generated content unbounded. */
export function parseLosslessTurnPayload(raw: unknown): LosslessTurnPayload {
  if (!isObject(raw)) throw new Error("turn tape payload must be an object");
  const sessionId = requiredString(raw, "sessionId");
  const agentId = requiredString(raw, "agentId");
  const turnIndex = requiredInt(raw, "turnIndex");
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
  const truncated = raw.truncated;
  if (truncated !== undefined && typeof truncated !== "boolean") {
    throw new Error("turn tape payload.truncated must be boolean");
  }
  const thinkingText = optionalString(raw, "thinkingText");
  const createdAt = optionalPositiveInt(raw, "createdAt");
  if (createdAt === undefined) throw new Error("turn tape payload.createdAt is required");
  const requestId = optionalString(raw, "requestId");
  const agentSessionId = optionalString(raw, "agentSessionId");
  const usage = optionalObject(raw, "usage");
  const errorCode = optionalString(raw, "errorCode");
  const errorDetail = optionalString(raw, "errorDetail");
  const tools = optionalObjectArray(raw, "tools");
  const assistantSegments = parseSegments(raw, "assistantSegments");
  const thinkingSegments = parseSegments(raw, "thinkingSegments");
  const agentGroups = optionalObjectArray(raw, "agentGroups");
  const structuredBlocks = optionalObjectArray(raw, "structuredBlocks");
  const runtimeEvents = parseRuntimeEvents(raw);
  return {
    sessionId,
    agentId,
    turnIndex,
    status,
    turnKey,
    ...(parentTurnKey !== undefined ? { parentTurnKey } : {}),
    text: requiredString(raw, "text"),
    ...(thinkingText !== undefined ? { thinkingText } : {}),
    createdAt,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(agentSessionId !== undefined ? { agentSessionId } : {}),
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
  };
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
    const blockId = typeof block.blockId === "string" && block.blockId.length > 0
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
    }, event.ordinal));
  }
  if (records.length === 0) throw new Error("turn tape contains no persistable records");

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
  return { payload: body, records, billingAnchorId };
}
