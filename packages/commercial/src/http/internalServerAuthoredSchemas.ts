import { z } from "zod";
import { LOSSLESS_TURN_TAPE_PART_BYTES } from "@openclaude/protocol";

/** Legacy-v1 request cap. Current v2 admits one fixed-size multipart envelope
 * per request and has no per-turn semantic content cap. */
export const MAX_BODY_BYTES = 256 * 1024;
export const LOSSLESS_TURN_TAPE_WIRE_MAX_BODY_BYTES =
  Math.ceil((LOSSLESS_TURN_TAPE_PART_BYTES * 4) / 3) + 16 * 1024;

const SCHEMA_TOOL_OUTPUT_MAX_CHARS = 8 * 1024;
const SCHEMA_TOOL_INPUT_JSON_MAX_CHARS = 16 * 1024;
const SCHEMA_TOOL_INPUT_PREVIEW_MAX_CHARS = 2_000;
const SCHEMA_TOOLS_MAX_LEN = 50;

export const SCHEMA_SEGMENTS_MAX_LEN = 64;

const SCHEMA_AGENT_GROUPS_MAX_LEN = 50;
const SCHEMA_AGENT_GROUP_RESULT_MAX_CHARS = 2 * 1024;
const SCHEMA_AGENT_GROUP_GOAL_MAX_CHARS = 4 * 1024;
const SCHEMA_AGENT_GROUP_RUNID_MAX_CHARS = 128;
const SCHEMA_AGENT_GROUP_AGENTID_MAX_CHARS = 128;
const SCHEMA_PERMISSION_CARDS_MAX_LEN = 4;
const SCHEMA_PERMISSION_PATCHES_MAX_LEN = 4;
const SCHEMA_USER_ANSWER_MESSAGES_MAX_LEN = 4;
export const ASK_USER_REQUEST_ID_RE = /^ask-user:[0-9a-f]{32}$/;
const ASK_USER_ANSWER_ID_RE = /^ask-ans-[A-Za-z0-9_-]{8,64}$/;

function isToolInputJsonWithinCap(inputJson: unknown): boolean {
  try {
    const s = typeof inputJson === "string" ? inputJson : JSON.stringify(inputJson ?? {});
    return s.length <= SCHEMA_TOOL_INPUT_JSON_MAX_CHARS;
  } catch {
    return false;
  }
}

const ToolEntrySchema = z
  .object({
    toolUseId: z.string().min(1).max(128),
    blockId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    inputJson: z.unknown(),
    inputPreview: z.string().max(SCHEMA_TOOL_INPUT_PREVIEW_MAX_CHARS),
    output: z.string().max(SCHEMA_TOOL_OUTPUT_MAX_CHARS),
    isError: z.boolean(),
    durationMs: z.number().int().min(0),
    ts: z.number().int().min(0),
    arrivedAt: z.number().int().min(0).optional(),
    inputTruncated: z.boolean().optional(),
    outputTruncated: z.boolean().optional(),
  })
  .strict()
  .refine((v) => isToolInputJsonWithinCap(v.inputJson), {
    message: "inputJson exceeds size cap or is unserializable",
    path: ["inputJson"],
  });

const AgentGroupEntrySchema = z
  .object({
    runId: z
      .string()
      .min(1)
      .max(SCHEMA_AGENT_GROUP_RUNID_MAX_CHARS)
      .regex(/^[A-Za-z0-9_-]+$/, {
        message: "runId must match [A-Za-z0-9_-]{1,128}",
      }),
    agentId: z.string().min(1).max(SCHEMA_AGENT_GROUP_AGENTID_MAX_CHARS),
    goal: z.string().max(SCHEMA_AGENT_GROUP_GOAL_MAX_CHARS),
    status: z.enum(["ok", "failed", "timeout"]),
    resultSummary: z.string().max(SCHEMA_AGENT_GROUP_RESULT_MAX_CHARS).optional(),
    completedAt: z.number().int().positive(),
    verdict: z.enum(["PASS", "NEEDS_FIX"]).optional(),
  })
  .strict();

const PermissionCardSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(64)
      .regex(ASK_USER_REQUEST_ID_RE, {
        message: "requestId must match ask-user:<32 hex>",
      }),
    questions: z.array(z.unknown()).min(1).max(4),
    sessionKey: z.string().min(1).max(256),
    expiresAt: z.number().int().positive(),
    ts: z.number().int().positive().optional(),
    channel: z.string().min(1).max(64).optional(),
    peer: z
      .object({
        id: z.string().min(1).max(80),
        kind: z.enum(["dm", "group"]),
      })
      .strict()
      .optional(),
  })
  .strict();

const PermissionPatchSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(64)
      .regex(ASK_USER_REQUEST_ID_RE, {
        message: "requestId must match ask-user:<32 hex>",
      }),
    behavior: z.enum(["allow", "deny"]),
    settledReason: z.enum(["remote", "already_settled", "disconnect", "timeout", "crashed"]),
    answers: z.record(z.string(), z.string().max(512)).optional(),
  })
  .strict();

const UserAnswerMessageSchema = z
  .object({
    id: z
      .string()
      .min(8)
      .max(80)
      .regex(ASK_USER_ANSWER_ID_RE, {
        message: "user answer id must match ask-ans-<token>",
      }),
    text: z.string().min(1).max(MAX_BODY_BYTES),
    ts: z.number().int().positive().optional(),
  })
  .strict();

const TurnUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    cacheReadTokens: z.number().int().min(0).optional(),
    cacheCreationTokens: z.number().int().min(0).optional(),
    totalTokens: z.number().int().min(0).optional(),
    model: z.string().max(128).optional(),
    turn: z.number().int().min(0).optional(),
    traceId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  })
  .strict();

const TextSegmentSchema = z
  .object({
    index: z.number().int().min(0).max(SCHEMA_SEGMENTS_MAX_LEN - 1),
    text: z.string().max(MAX_BODY_BYTES),
    ts: z.number().int().min(0),
  })
  .strict();

const BodyObjectSchema = z
  .object({
    sessionId: z.string().min(8).max(50),
    agentId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, {
        message: "agentId must match [A-Za-z0-9_-]{1,64}",
      })
      .optional(),
    turnIndex: z.number().int().min(0),
    status: z.enum(["completed", "interrupted", "crashed"]),
    text: z.string().max(MAX_BODY_BYTES),
    thinkingText: z.string().min(1).max(MAX_BODY_BYTES).optional(),
    createdAt: z.number().int().positive().optional(),
    requestId: z.string().min(8).max(128).optional(),
    agentSessionId: z.string().min(1).max(256).optional(),
    usage: TurnUsageSchema.optional(),
    truncated: z.boolean().optional(),
    errorCode: z.string().max(64).optional(),
    errorDetail: z.string().max(2048).optional(),
    tools: z.array(ToolEntrySchema).max(SCHEMA_TOOLS_MAX_LEN).optional(),
    assistantSegments: z.array(TextSegmentSchema).max(SCHEMA_SEGMENTS_MAX_LEN).optional(),
    thinkingSegments: z.array(TextSegmentSchema).max(SCHEMA_SEGMENTS_MAX_LEN).optional(),
    agentGroups: z.array(AgentGroupEntrySchema).max(SCHEMA_AGENT_GROUPS_MAX_LEN).optional(),
    permissionCards: z.array(PermissionCardSchema).max(SCHEMA_PERMISSION_CARDS_MAX_LEN).optional(),
    permissionPatches: z.array(PermissionPatchSchema).max(SCHEMA_PERMISSION_PATCHES_MAX_LEN).optional(),
    userAnswerMessages: z.array(UserAnswerMessageSchema).max(SCHEMA_USER_ANSWER_MESSAGES_MAX_LEN).optional(),
  })
  .strict();

type RawBodyObject = z.infer<typeof BodyObjectSchema>;

function hasServerAuthoredBodyContent(v: RawBodyObject): boolean {
  if (v.text.length > 0 || v.thinkingText !== undefined) return true;
  const arrays = [
    v.tools,
    v.assistantSegments,
    v.thinkingSegments,
    v.agentGroups,
    v.permissionCards,
    v.permissionPatches,
    v.userAnswerMessages,
  ];
  return arrays.some((arr) => arr !== undefined && arr.length > 0);
}

export const BodySchema = BodyObjectSchema.refine(hasServerAuthoredBodyContent, {
  message:
    "either text, thinkingText, tools[], assistantSegments[], thinkingSegments[], agentGroups[], permissionCards[], permissionPatches[], or userAnswerMessages[] must be non-empty",
});

export type ServerAuthoredBody = z.infer<typeof BodySchema>;

export type ServerAuthoredMessageInput = {
  id: string;
  role: "assistant" | "thinking" | "tool" | "agent-group" | "permission" | "user";
  text: string;
  ts: number;
  status: "completed" | "interrupted" | "crashed";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalTokens?: number;
    model?: string;
    turn?: number;
    traceId?: string;
  };
  _truncated?: boolean;
  _errorCode?: string;
  _errorDetail?: string;
  toolName?: string;
  blockId?: string;
  inputJson?: unknown;
  inputPreview?: string;
  output?: string;
  error?: boolean;
  durationMs?: number;
  inputTruncated?: boolean;
  outputTruncated?: boolean;
  _completed?: boolean;
  _delegate?: boolean;
  _delegateRunId?: string;
  _delegateAgentId?: string;
  _delegateGoal?: string;
  _delegateStatus?: "ok" | "failed" | "timeout";
  _resultPreview?: string;
  _isError?: boolean;
  completedAt?: number;
  _reviewVerdict?: "PASS" | "NEEDS_FIX";
  requestId?: string;
  _resolved?: boolean;
  _detachedAskUser?: boolean;
  _askUserSessionKey?: string;
  _askUserExpiresAt?: number;
  _askUserUserId?: string;
  _askUserChannel?: string;
  _askUserPeer?: { id: string; kind: "dm" | "group" };
  _source?: "server";
};

export type ServerAuthoredStorageResult = {
  applied: boolean;
  reason?: "session_not_found" | "session_deleted" | "already_exists" | "malformed" | "oversized";
};

export interface ServerAuthoredStorage {
  appendServerAuthoredMessage(
    sessId: string,
    userId: string,
    message: ServerAuthoredMessageInput,
  ): Promise<ServerAuthoredStorageResult>;
  appendServerAuthoredMessageForRequest(
    requestId: string,
    sessId: string,
    userId: string,
    message: ServerAuthoredMessageInput,
  ): Promise<
    | { applied: true }
    | { applied: false; reason: "session_not_found" | "session_deleted" | "already_exists" | "malformed" | "oversized" }
  >;
  appendServerAuthoredMessageDrainByUser(
    sessId: string,
    userId: string,
    message: ServerAuthoredMessageInput,
    agentSessionId?: string | null,
  ): Promise<
    | { applied: true }
    | { applied: false; reason: "session_not_found" | "session_deleted" | "already_exists" | "malformed" | "oversized" }
  >;
  drainDelegateCostForClientSession(
    clientSessionId: string,
    userId: string,
    msgId: string,
  ): Promise<{ merged: string; drained: number }>;
  getClientSession?(
    sessId: string,
    userId: string,
  ): Promise<{ messages?: unknown[] } | null>;
  readArchivedMessages?(
    sessId: string,
    userId: string,
    beforeSeq?: number,
    limit?: number,
  ): Promise<{ messages: unknown[]; hasMore: boolean; oldestSeq: number | null }>;
  patchServerAuthoredMessage?(
    sessId: string,
    userId: string,
    msgId: string,
    patch: Record<string, unknown>,
  ): Promise<
    | { applied: true }
    | { applied: false; reason: "session_not_found" | "session_deleted" | "not_found" }
  >;
}
