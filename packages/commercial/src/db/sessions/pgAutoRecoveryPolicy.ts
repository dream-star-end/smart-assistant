import type { Pool, PoolClient } from "pg";
import {
  AUTOMATIC_TURN_RETRY_MAX,
  SETTLED_TOOLS_CHECKPOINT_RETRY_MAX,
  SWARM_BOARD_TOOL_NAME,
  allowUnsafeAutomaticCheckpoint,
  automaticRetryStatus,
  emptyRecoveryRepeatsModelPlaneFailure,
  isClientMessageId,
  maxAutomaticTurnRetryAttempt,
  modelPlaneFailureAfterSettledTools,
  normalizeTurnErrorCode,
  parseSwarmSlashCommand,
  shouldDeclineLiveServiceRestartRecovery,
  shouldPauseSilentAutomaticRecovery,
  shouldReplayOriginalAfterEmptyExecution,
  shouldResetNativeSessionForRecovery,
  supportsAutomaticTurnRecovery,
  turnRecoveryAttemptIdentity,
} from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import type { AdmissionRestartStorageDeps } from "../../dispatch/admissionRestartRecovery.js";
import type { RecoveryJobTerminalRow } from "../../dispatch/turnRecoveryStore.js";
import type { LosslessTurnPayload } from "../../http/losslessTurnTape.js";
import {
  isLeftoverRecoveryRecordsTruncated,
  loadLeftoverRecoveryRecords,
  mergeTapeAndLeftoverRecoveryAssessment,
  sessionTurnHasSuccessfulUsage,
  terminalTurnRecordErrorCode,
} from "../sessionRecoveryEvidence.js";
import { appendRecoveryGiveUpTerminalCard } from "./appendCore.js";
import type { PgSessionsDeps } from "./deps.js";
import {
  advanceClientTimelineIdentityInTransaction,
  hydrateRecoverySourceUser,
} from "./sqlHelpers.js";
import type { AutomaticRecoveryDecision, PgSessionsBackendOptions } from "./types.js";

// ── Recovery policy constants & admission-restart source loader ──────────────

const AUTOMATIC_RECOVERY_CONTINUE_PROMPT =
  "继续完成刚才因临时异常中断的任务。以本会话中已经生成并持久化的思考、工具结果和部分回答为依据，从断点继续。这是一条断点续接指令，不是重放原始请求：不要重新执行已经完成的步骤，不要重复已经输出的内容。若中断前有外部写操作或部署操作，先查询其当前可观察状态（如 release 指针、进程、日志、健康检查或目标资源）并据此继续。只有在无法通过查询区分成功或失败、且重复执行可能造成不可逆后果时，才明确说明具体无法确认的操作和风险，并仅询问完成任务所必需的决定；不要泛泛要求用户再说“继续”。";

const PRE_EXECUTION_RECOVERY_CODES = new Set([
  "model_authority_unavailable",
  "model_catalog_unavailable",
  "codex_pool_busy",
  "codex_route_unavailable",
  "codex_container_recycled",
  "admission_restart_unexecuted",
]);

const SWARM_TOOL_NAMES = new Set([
  SWARM_BOARD_TOOL_NAME,
  "SwarmManage",
  "SwarmPost",
  "SwarmReadBoard",
  "SwarmWait",
]);

const SELECT_ADMISSION_SOURCE_SQL =
  "SELECT messages,deleted_at FROM client_sessions WHERE id=$1 AND user_id=$2";
const SELECT_ADMISSION_SOURCE_LOCK_SQL =
  "SELECT messages,deleted_at FROM client_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE";

export function recoveryWithoutCheckpointIsProven(code: string): boolean {
  return PRE_EXECUTION_RECOVERY_CODES.has(normalizeTurnErrorCode(code));
}

function replayMediaIsDurable(media: unknown[]): boolean {
  return media.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const ref = item as { url?: unknown; base64?: unknown };
    return (
      (typeof ref.url === "string" && ref.url.length > 0) ||
      (typeof ref.base64 === "string" && ref.base64.length > 0)
    );
  });
}

export async function loadAdmissionRestartSource(
  q: Pool | PoolClient,
  row: { sessionId: string; userId: bigint; clientMessageId: string },
  lock: boolean,
): Promise<MessageLike | null> {
  const result = await q.query<{ messages: string; deleted_at: string | null }>(
    lock ? SELECT_ADMISSION_SOURCE_LOCK_SQL : SELECT_ADMISSION_SOURCE_SQL,
    [row.sessionId, `c:${row.userId}`],
  );
  const session = result.rows[0];
  if (!session || session.deleted_at !== null) return null;
  let messages: MessageLike[];
  try {
    const parsed: unknown = JSON.parse(session.messages);
    if (!Array.isArray(parsed)) return null;
    messages = parsed as MessageLike[];
  } catch (err) {
    void err;
    return null;
  }
  const source = [...messages].reverse().find((item) => item?.role === "user");
  if (source?.id !== row.clientMessageId) return null;
  return hydrateRecoverySourceUser(q, row.sessionId, `c:${row.userId}`, source);
}

export function buildAdmissionRestartDeps(
  options: PgSessionsBackendOptions,
): AdmissionRestartStorageDeps | undefined {
  return options.admissionRestartRecovery
    ? {
        ...options.admissionRestartRecovery,
        loadLatestSource: loadAdmissionRestartSource,
        advanceTimeline: advanceClientTimelineIdentityInTransaction,
      }
    : undefined;
}

// ── Finalized turn control settlement ────────────────────────────────────────

export async function settleFinalizedTurnControls(
  client: PoolClient,
  input: {
    uid: bigint;
    sessionId: string;
    clientMessageId: string;
    outcome: "completed" | "interrupted" | "crashed";
  },
  deps: PgSessionsDeps,
): Promise<RecoveryJobTerminalRow[]> {
  await deps.dispatch.settleStopControlsForTurn(client, {
    userId: input.uid,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
  });
  await deps.dispatch.cancelPendingPermissionPromptsForTurn(client, {
    userId: input.uid,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    reason: "turn_finalized",
  });
  return deps.dispatch.settleRecoveryJobForTape(client, {
    userId: input.uid,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    outcome: input.outcome,
  });
}

// ── Automatic recovery scheduling for finalized turns ────────────────────────

export type ScheduleAutoRecoveryInput = {
  uid: bigint;
  sessionUserId: string;
  sessionId: string;
  turn: {
    payload: Pick<
      LosslessTurnPayload,
      | "clientMessageId"
      | "status"
      | "errorCode"
      | "waiveReason"
      | "agentId"
      | "turnKey"
      | "tools"
    >;
    records: Array<{ payload: MessageLike }>;
  };
  clientMessageId: string | null;
  tapeSha256: string;
  currentMessages: MessageLike[];
};

type DeclineReason = Extract<AutomaticRecoveryDecision, { scheduled: false }>["reason"];

type RecoveryEligibility = {
  mode: "checkpoint" | "replay";
  assessment: ReturnType<typeof mergeTapeAndLeftoverRecoveryAssessment>;
  recoveryRecords: MessageLike[];
  combinedRecords: unknown[];
};

function makeDeclinedDecision(
  sourceClientMessageId: string,
  reason: DeclineReason,
  errorCode: string,
  retryStatus = automaticRetryStatus("declined"),
): AutomaticRecoveryDecision {
  return { scheduled: false, retryStatus, sourceClientMessageId, errorCode, reason };
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

async function resolveRecoverySourceAndRoute(
  client: PoolClient,
  input: ScheduleAutoRecoveryInput,
  clientMessageId: string,
): Promise<
  | { ok: true; source: MessageLike; route: Record<string, unknown> }
  | { ok: false; reason: "source_not_latest" | "no_routing" }
> {
  const latestUser = [...input.currentMessages]
    .reverse()
    .find((message) => message?.role === "user");
  if (!latestUser || latestUser.id !== clientMessageId) {
    return { ok: false, reason: "source_not_latest" };
  }
  const source = await hydrateRecoverySourceUser(
    client,
    input.sessionId,
    input.sessionUserId,
    latestUser,
  );
  if (!source) return { ok: false, reason: "no_routing" };
  const route = asPlainObject(source._routing);
  if (!route) return { ok: false, reason: "no_routing" };
  return { ok: true, source, route };
}

async function evaluateRecoveryEligibility(
  client: PoolClient,
  input: ScheduleAutoRecoveryInput,
  clientMessageId: string,
  source: MessageLike,
  errorCode: string,
): Promise<{ ok: true; eligibility: RecoveryEligibility } | { ok: false; reason: DeclineReason }> {
  const status = input.turn.payload.status;
  const recoveryRecords = input.turn.records.map((record) => record.payload);
  const leftoverRecords = await loadLeftoverRecoveryRecords(
    client,
    input.sessionId,
    input.sessionUserId,
    clientMessageId,
  );
  const assessment = mergeTapeAndLeftoverRecoveryAssessment(recoveryRecords, leftoverRecords);
  const hasSuccessfulUpstreamUsage = await sessionTurnHasSuccessfulUsage(
    client,
    input.uid,
    input.turn.payload.turnKey,
  );
  const combinedRecords = [...recoveryRecords, ...leftoverRecords];
  const emptyOriginalReplay = shouldReplayOriginalAfterEmptyExecution({
    errorCode,
    records: combinedRecords,
    sourceIsAutomaticRecovery: source._automaticRecovery === true,
    hasSuccessfulUpstreamUsage,
  });
  if (status === "completed" && assessment.mode !== "checkpoint") {
    return { ok: false, reason: "completed_without_checkpoint" };
  }
  if (
    shouldDeclineLiveServiceRestartRecovery({
      errorCode,
      records: recoveryRecords,
      leftoverRecords,
      hasSuccessfulUpstreamUsage,
    })
  ) {
    return { ok: false, reason: "checkpoint_unsafe" };
  }
  const replayOverSyntheticCheckpoint = emptyOriginalReplay && assessment.mode === "checkpoint";
  const checkpointUnsafe =
    assessment.mode === "checkpoint" &&
    !assessment.checkpointSafe &&
    !replayOverSyntheticCheckpoint &&
    (isLeftoverRecoveryRecordsTruncated(leftoverRecords) ||
      !allowUnsafeAutomaticCheckpoint({
        status,
        errorCode,
        leftoverBacked: assessment.leftoverBacked,
        records: combinedRecords,
      }));
  if (checkpointUnsafe) return { ok: false, reason: "checkpoint_unsafe" };

  const replayUnproven =
    assessment.mode === "replay" &&
    !emptyOriginalReplay &&
    (!assessment.checkpointSafe || !recoveryWithoutCheckpointIsProven(errorCode));
  if (replayUnproven) return { ok: false, reason: "replay_not_proven" };

  return {
    ok: true,
    eligibility: {
      mode: replayOverSyntheticCheckpoint ? "replay" : assessment.mode,
      assessment,
      recoveryRecords,
      combinedRecords,
    },
  };
}

function resolveLineageAndBudget(
  source: MessageLike,
  clientMessageId: string,
  errorCode: string,
  eligibility: RecoveryEligibility,
): { rootClientMessageId: string; currentAttempt: number; retryLimit: number } {
  const rootClientMessageId = isClientMessageId(source._automaticRecoveryRootClientMessageId)
    ? source._automaticRecoveryRootClientMessageId
    : source._automaticRecovery === true && isClientMessageId(source._recoveryOfClientMessageId)
      ? source._recoveryOfClientMessageId
      : clientMessageId;
  const sourceAttempt =
    typeof source._automaticRecoveryAttempt === "number" &&
    Number.isSafeInteger(source._automaticRecoveryAttempt) &&
    source._automaticRecoveryAttempt >= 1
      ? source._automaticRecoveryAttempt
      : source._automaticRecovery === true
        ? 1
        : 0;
  const currentAttempt = Math.max(
    sourceAttempt,
    maxAutomaticTurnRetryAttempt(eligibility.recoveryRecords, rootClientMessageId),
  );
  const shortBudget =
    (eligibility.assessment.mode === "checkpoint" &&
      !eligibility.assessment.checkpointSafe &&
      modelPlaneFailureAfterSettledTools(errorCode, eligibility.combinedRecords)) ||
    emptyRecoveryRepeatsModelPlaneFailure({
      errorCode,
      currentAttempt,
      records: eligibility.combinedRecords,
    });
  return {
    rootClientMessageId,
    currentAttempt,
    retryLimit: shortBudget ? SETTLED_TOOLS_CHECKPOINT_RETRY_MAX : AUTOMATIC_TURN_RETRY_MAX,
  };
}

function resolveSwarmModeForRecovery(
  route: Record<string, unknown>,
  exactText: string,
  tools: LosslessTurnPayload["tools"],
): boolean | undefined {
  if (typeof route.swarmMode === "boolean") return route.swarmMode;
  if (parseSwarmSlashCommand(exactText)?.matched) return true;
  const usedSwarmTool = (tools ?? []).some((t) => {
    const name =
      typeof t?.toolName === "string" ? t.toolName : typeof t?.name === "string" ? t.name : "";
    return SWARM_TOOL_NAMES.has(name);
  });
  return usedSwarmTool ? true : undefined;
}

function buildRecoveryContentPayload(params: {
  mode: "checkpoint" | "replay";
  displayText: string;
  exactText: string;
  sourceMedia: unknown[] | undefined;
  imageEdit: Record<string, unknown> | undefined;
  replyTo: Record<string, unknown> | undefined;
  clientMessageId: string;
  rootClientMessageId: string;
  semanticRecoveryAttempt: number;
  resetNative: boolean;
}): Record<string, unknown> {
  const isReplay = params.mode === "replay";
  const content: Record<string, unknown> = {
    text: isReplay ? params.exactText : AUTOMATIC_RECOVERY_CONTINUE_PROMPT,
    displayText: params.displayText,
    recovery: {
      sourceClientMessageId: params.clientMessageId,
      mode: params.mode,
      automatic: true,
      rootClientMessageId: params.rootClientMessageId,
      attempt: params.semanticRecoveryAttempt,
      max: AUTOMATIC_TURN_RETRY_MAX,
      ...(params.resetNative ? { resetNativeSession: true } : {}),
    },
  };
  if (isReplay && params.sourceMedia) content.media = params.sourceMedia;
  if (isReplay && params.imageEdit) content.imageEdit = params.imageEdit;
  if (isReplay && params.replyTo) content.replyTo = params.replyTo;
  return content;
}

function buildAutomaticRecoveryRequest(params: {
  input: ScheduleAutoRecoveryInput;
  clientMessageId: string;
  source: MessageLike;
  route: Record<string, unknown>;
  mode: "checkpoint" | "replay";
  rootClientMessageId: string;
  currentAttempt: number;
  semanticRecoveryAttempt: number;
  retryLimit: number;
  errorCode: string;
  recoveryRecords: MessageLike[];
}): { displayText: string; request: Record<string, unknown> } | null {
  const { input, source, route, mode, rootClientMessageId, semanticRecoveryAttempt } = params;
  const exactText =
    typeof source._modelText === "string"
      ? source._modelText
      : typeof source.text === "string"
        ? source.text
        : "";
  const sourceMedia = Array.isArray(source._retryMedia)
    ? source._retryMedia
    : Array.isArray(source._media)
      ? source._media
      : undefined;
  if (mode === "replay" && sourceMedia && !replayMediaIsDurable(sourceMedia)) return null;

  const identity = turnRecoveryAttemptIdentity(
    input.sessionId,
    rootClientMessageId,
    semanticRecoveryAttempt,
  );
  const displayText = mode === "checkpoint" ? "↻ 自动从断点继续" : "↻ 自动重试";
  const replyTo = asPlainObject(source._replyTo);
  const imageEdit = asPlainObject(source._imageEdit);
  const content = buildRecoveryContentPayload({
    mode,
    displayText,
    exactText,
    sourceMedia,
    imageEdit,
    replyTo,
    clientMessageId: params.clientMessageId,
    rootClientMessageId,
    semanticRecoveryAttempt,
    resetNative: shouldResetNativeSessionForRecovery({
      errorCode: params.errorCode,
      currentAttempt: params.currentAttempt,
      records: params.recoveryRecords,
    }),
  });
  const request: Record<string, unknown> = {
    type: "inbound.message",
    _automaticRecoveryRetryLimit: params.retryLimit,
    idempotencyKey: identity.idempotencyKey,
    channel: "webchat",
    peer: { id: input.sessionId, kind: "dm" },
    agentId: input.turn.payload.agentId,
    content,
    ts: Date.now(),
    clientMessageId: identity.clientMessageId,
  };
  if (mode === "replay" && typeof replyTo?.messageId === "string") {
    request.replyToId = replyTo.messageId;
  }
  if (typeof route.effortLevel === "string" || route.effortLevel === null) {
    request.effortLevel = route.effortLevel;
  }
  if (typeof route.model === "string" && route.model.length > 0) request.model = route.model;
  if (route.teamMode === true) request.teamMode = true;
  const resolvedSwarmMode = resolveSwarmModeForRecovery(route, exactText, input.turn.payload.tools);
  if (resolvedSwarmMode !== undefined) request.swarmMode = resolvedSwarmMode;
  return { displayText, request };
}

async function handlePausedOrExhaustedRecovery(
  client: PoolClient,
  params: {
    input: ScheduleAutoRecoveryInput;
    clientMessageId: string;
    rootClientMessageId: string;
    currentAttempt: number;
    retryLimit: number;
    errorCode: string;
    recoveryRecords: MessageLike[];
    terminals: RecoveryJobTerminalRow[];
  },
  deps: PgSessionsDeps,
): Promise<{ decision: AutomaticRecoveryDecision; terminals: RecoveryJobTerminalRow[] } | null> {
  const { input, clientMessageId, rootClientMessageId, currentAttempt, retryLimit, errorCode } =
    params;
  if (
    shouldPauseSilentAutomaticRecovery({
      errorCode,
      currentAttempt,
      records: params.recoveryRecords,
    })
  ) {
    const paused = await deps.dispatch.pauseSilentRecoveryLineage(client, {
      userId: input.uid,
      sessionId: input.sessionId,
      rootClientMessageId,
      currentAttempt,
      terminalOutcome: input.turn.payload.status,
    });
    await appendRecoveryGiveUpTerminalCard(
      client,
      {
        sessionId: input.sessionId,
        sessionUserId: input.sessionUserId,
        rootClientMessageId,
        reason: "silent_no_progress",
      },
      deps,
    );
    return {
      decision: makeDeclinedDecision(
        clientMessageId,
        "silent_no_progress",
        errorCode,
        automaticRetryStatus("paused", currentAttempt),
      ),
      terminals: paused.length === 0 ? params.terminals : [...params.terminals, ...paused],
    };
  }
  if (currentAttempt >= retryLimit) {
    await appendRecoveryGiveUpTerminalCard(
      client,
      {
        sessionId: input.sessionId,
        sessionUserId: input.sessionUserId,
        rootClientMessageId,
        reason: "retry_exhausted",
      },
      deps,
    );
    return {
      decision: makeDeclinedDecision(
        clientMessageId,
        "retry_exhausted",
        errorCode,
        automaticRetryStatus("exhausted", currentAttempt, retryLimit),
      ),
      terminals: params.terminals,
    };
  }
  return null;
}

async function enqueueAndFinalizeRecovery(
  client: PoolClient,
  params: {
    input: ScheduleAutoRecoveryInput;
    clientMessageId: string;
    source: MessageLike;
    route: Record<string, unknown>;
    eligibility: RecoveryEligibility;
    errorCode: string;
    terminals: RecoveryJobTerminalRow[];
  },
  deps: PgSessionsDeps,
): Promise<{ decision: AutomaticRecoveryDecision | null; terminals: RecoveryJobTerminalRow[] }> {
  const { input, clientMessageId, source, route, eligibility, errorCode, terminals } = params;
  const { rootClientMessageId, currentAttempt, retryLimit } = resolveLineageAndBudget(
    source,
    clientMessageId,
    errorCode,
    eligibility,
  );
  const stopped = await handlePausedOrExhaustedRecovery(
    client,
    {
      input,
      clientMessageId,
      rootClientMessageId,
      currentAttempt,
      retryLimit,
      errorCode,
      recoveryRecords: eligibility.recoveryRecords,
      terminals,
    },
    deps,
  );
  if (stopped) return stopped;

  const semanticRecoveryAttempt = currentAttempt + 1;
  const built = buildAutomaticRecoveryRequest({
    input,
    clientMessageId,
    source,
    route,
    mode: eligibility.mode,
    rootClientMessageId,
    currentAttempt,
    semanticRecoveryAttempt,
    retryLimit,
    errorCode,
    recoveryRecords: eligibility.recoveryRecords,
  });
  if (!built) {
    return {
      decision: makeDeclinedDecision(clientMessageId, "media_not_durable", errorCode),
      terminals,
    };
  }
  const enqueued = await deps.dispatch.enqueueAutomaticRecoveryJob(client, {
    userId: input.uid,
    sessionId: input.sessionId,
    rootClientMessageId,
    sourceClientMessageId: clientMessageId,
    sourceTurnKey: input.turn.payload.turnKey,
    errorCode,
    recoveryMode: eligibility.mode,
    semanticRecoveryAttempt,
    request: built.request,
    tapeSha256: input.tapeSha256,
  });
  if (!enqueued) {
    return {
      decision: makeDeclinedDecision(clientMessageId, "enqueue_rejected", errorCode),
      terminals,
    };
  }
  return {
    decision: {
      scheduled: true,
      retryStatus: automaticRetryStatus("scheduled", semanticRecoveryAttempt, retryLimit),
      sourceClientMessageId: clientMessageId,
      rootClientMessageId,
      errorCode,
      mode: eligibility.mode,
      attempt: semanticRecoveryAttempt,
      max: AUTOMATIC_TURN_RETRY_MAX,
      displayText: built.displayText,
      agentId: input.turn.payload.agentId,
      ...(typeof route.model === "string" && route.model.length > 0 ? { model: route.model } : {}),
    },
    terminals,
  };
}

export async function scheduleAutomaticRecoveryForFinalizedTurn(
  client: PoolClient,
  input: ScheduleAutoRecoveryInput,
  deps: PgSessionsDeps,
): Promise<{ decision: AutomaticRecoveryDecision | null; terminals: RecoveryJobTerminalRow[] }> {
  const clientMessageId = input.clientMessageId;
  if (!clientMessageId || !isClientMessageId(clientMessageId)) {
    return { decision: null, terminals: [] };
  }
  const terminals = await settleFinalizedTurnControls(
    client,
    {
      uid: input.uid,
      sessionId: input.sessionId,
      clientMessageId,
      outcome: input.turn.payload.status,
    },
    deps,
  );
  const status = input.turn.payload.status;
  const terminalRecordErrorCode = terminalTurnRecordErrorCode(
    input.turn.records.map((record) => record.payload),
  );
  const completedWithRecoverableError =
    status === "completed" && supportsAutomaticTurnRecovery(terminalRecordErrorCode);
  if (status !== "crashed" && status !== "interrupted" && !completedWithRecoverableError) {
    return { decision: null, terminals };
  }
  const errorCode =
    terminalRecordErrorCode || input.turn.payload.errorCode || input.turn.payload.waiveReason || "";
  if (!supportsAutomaticTurnRecovery(errorCode)) {
    return {
      decision: makeDeclinedDecision(clientMessageId, "not_recoverable", errorCode),
      terminals,
    };
  }
  const resolved = await resolveRecoverySourceAndRoute(client, input, clientMessageId);
  if (!resolved.ok) {
    return {
      decision: makeDeclinedDecision(clientMessageId, resolved.reason, errorCode),
      terminals,
    };
  }
  const assessed = await evaluateRecoveryEligibility(
    client,
    input,
    clientMessageId,
    resolved.source,
    errorCode,
  );
  if (!assessed.ok) {
    return {
      decision: makeDeclinedDecision(clientMessageId, assessed.reason, errorCode),
      terminals,
    };
  }
  return enqueueAndFinalizeRecovery(
    client,
    {
      input,
      clientMessageId,
      source: resolved.source,
      route: resolved.route,
      eligibility: assessed.eligibility,
      errorCode,
      terminals,
    },
    deps,
  );
}
