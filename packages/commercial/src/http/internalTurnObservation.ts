import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from "../auth/containerIdentity.js";
import { type Logger, rootLogger } from "../logging/logger.js";
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from "./util.js";

export { TURN_OBSERVATION_PATH } from "@openclaude/protocol";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_AGE_MS = 25 * 60 * 60 * 1000;
const MAX_CONTEXT_EVENTS = 16;
const MAX_CONTEXT_SLOTS = 32;
const MAX_CONTEXT_STEPS = 32;

export type ContextEvalEventKind = "context_compacted" | "prompt_context_decision";

export type ContextEvalWireEvent = {
  eventId: string;
  eventKind: ContextEvalEventKind;
  sessionKey?: string;
  agentId?: string;
  traceId?: string;
  turnIndex?: number;
  engine?: string;
  model?: string;
  compactionScope?: string;
  compactionStrategy?: string;
  beforeBytes?: number;
  afterBytes?: number;
  beforeTokens?: number;
  afterTokens?: number;
  droppedEntries?: number;
  decision?: string;
  reason?: string;
  changedSlots?: string[];
  staticPrefixSha256?: string;
  totalBytes?: number;
  tokensEstimate?: number;
  degradedSteps?: string[];
  observedAt: number;
};

export type TurnObservationBody = {
  schemaVersion: 1;
  eventId: string;
  sessionKey: string;
  agentId: string;
  traceId?: string;
  model?: string;
  durationMs: number;
  toolCalls: number;
  runtimeSourceCommit?: string;
  runtimeBootHash?: string;
  timestamp: number;
  contextOnly?: boolean;
  contextEvents?: ContextEvalWireEvent[];
};

export interface TurnObservationDeps {
  identityRepo: ContainerIdentityRepo;
  queryRunner: {
    query<Row = unknown>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: Row[]; rowCount: number | null }>;
  };
  logger?: Logger;
  now?: () => number;
}

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ...(body as object), requestId }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const ALLOWED_CONTEXT_EVENT_KEYS = new Set([
  "eventId", "eventKind", "sessionKey", "agentId", "traceId", "turnIndex",
  "engine", "model", "compactionScope", "compactionStrategy",
  "beforeBytes", "afterBytes", "beforeTokens", "afterTokens", "droppedEntries",
  "decision", "reason", "changedSlots", "staticPrefixSha256",
  "totalBytes", "tokensEstimate", "degradedSteps", "observedAt",
]);

function validateContextEvent(raw: unknown, now: number): ContextEvalWireEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some((key) => !ALLOWED_CONTEXT_EVENT_KEYS.has(key))) return null;
  const str = (key: string, max: number): string | undefined | null => {
    const value = row[key];
    if (value === undefined) return undefined;
    return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
  };
  const nonNegInt = (key: string, max = 1_000_000_000): number | undefined | null => {
    const value = row[key];
    if (value === undefined) return undefined;
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max
      ? Number(value)
      : null;
  };
  const strArr = (key: string, maxItems: number, maxItemLen: number): string[] | undefined | null => {
    const value = row[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > maxItems) return null;
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || item.length === 0 || item.length > maxItemLen) return null;
      out.push(item);
    }
    return out;
  };

  const eventId = str("eventId", 128);
  const eventKind = row.eventKind;
  if (!eventId || (eventKind !== "context_compacted" && eventKind !== "prompt_context_decision")) {
    return null;
  }
  const sessionKey = str("sessionKey", 512);
  const agentId = str("agentId", 128);
  const traceId = str("traceId", 128);
  const engineName = str("engine", 64);
  const modelName = str("model", 128);
  const compactionScope = str("compactionScope", 64);
  const compactionStrategy = str("compactionStrategy", 64);
  const decision = str("decision", 64);
  const reason = str("reason", 64);
  const staticPrefixSha256 = str("staticPrefixSha256", 64);
  if (
    sessionKey === null || agentId === null || traceId === null ||
    engineName === null || modelName === null || compactionScope === null ||
    compactionStrategy === null || decision === null || reason === null ||
    staticPrefixSha256 === null
  ) {
    return null;
  }
  if (traceId !== undefined && !/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (staticPrefixSha256 !== undefined && !/^[0-9a-f]{12,64}$/.test(staticPrefixSha256)) return null;

  const turnIndex = nonNegInt("turnIndex", 1_000_000);
  const beforeBytes = nonNegInt("beforeBytes");
  const afterBytes = nonNegInt("afterBytes");
  const beforeTokens = nonNegInt("beforeTokens");
  const afterTokens = nonNegInt("afterTokens");
  const droppedEntries = nonNegInt("droppedEntries", 1_000_000);
  const totalBytes = nonNegInt("totalBytes");
  const tokensEstimate = nonNegInt("tokensEstimate");
  if (
    turnIndex === null || beforeBytes === null || afterBytes === null ||
    beforeTokens === null || afterTokens === null || droppedEntries === null ||
    totalBytes === null || tokensEstimate === null
  ) {
    return null;
  }

  const changedSlots = strArr("changedSlots", MAX_CONTEXT_SLOTS, 64);
  const degradedSteps = strArr("degradedSteps", MAX_CONTEXT_STEPS, 64);
  if (changedSlots === null || degradedSteps === null) return null;

  const observedAt = row.observedAt;
  if (!Number.isSafeInteger(observedAt) || Number(observedAt) < now - MAX_AGE_MS || Number(observedAt) > now + 10 * 60_000) {
    return null;
  }

  return {
    eventId,
    eventKind,
    ...(sessionKey !== undefined ? { sessionKey } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
    ...(turnIndex !== undefined ? { turnIndex } : {}),
    ...(engineName !== undefined ? { engine: engineName } : {}),
    ...(modelName !== undefined ? { model: modelName } : {}),
    ...(compactionScope !== undefined ? { compactionScope } : {}),
    ...(compactionStrategy !== undefined ? { compactionStrategy } : {}),
    ...(beforeBytes !== undefined ? { beforeBytes } : {}),
    ...(afterBytes !== undefined ? { afterBytes } : {}),
    ...(beforeTokens !== undefined ? { beforeTokens } : {}),
    ...(afterTokens !== undefined ? { afterTokens } : {}),
    ...(droppedEntries !== undefined ? { droppedEntries } : {}),
    ...(decision !== undefined ? { decision } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(changedSlots !== undefined ? { changedSlots } : {}),
    ...(staticPrefixSha256 !== undefined ? { staticPrefixSha256 } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    ...(tokensEstimate !== undefined ? { tokensEstimate } : {}),
    ...(degradedSteps !== undefined ? { degradedSteps } : {}),
    observedAt: Number(observedAt),
  };
}

function validate(raw: unknown, now: number): TurnObservationBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "eventId", "sessionKey", "agentId", "traceId", "model",
    "durationMs", "toolCalls", "runtimeSourceCommit", "runtimeBootHash", "timestamp",
    "contextOnly", "contextEvents",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key)) || row.schemaVersion !== 1) return null;
  if (row.contextOnly !== undefined && typeof row.contextOnly !== "boolean") return null;
  const str = (key: string, max: number): string | undefined | null => {
    const value = row[key];
    if (value === undefined) return undefined;
    return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
  };
  const eventId = str("eventId", 128);
  const sessionKey = str("sessionKey", 512);
  const agentId = str("agentId", 128);
  const traceId = str("traceId", 128);
  const model = str("model", 128);
  const source = str("runtimeSourceCommit", 40);
  const boot = str("runtimeBootHash", 64);
  const durationMs = row.durationMs;
  const toolCalls = row.toolCalls;
  const timestamp = row.timestamp;
  if (!eventId || !sessionKey || !agentId || traceId === null || model === null) return null;
  if (traceId !== undefined && !/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (source === null || (source !== undefined && !/^[0-9a-f]{40}$/.test(source))) return null;
  if (boot === null || (boot !== undefined && !/^[0-9a-f]{12,64}$/.test(boot))) return null;
  if (!Number.isInteger(durationMs) || Number(durationMs) < 0 || Number(durationMs) > 7 * 24 * 60 * 60 * 1000) return null;
  if (!Number.isInteger(toolCalls) || Number(toolCalls) < 0 || Number(toolCalls) > 1_000_000) return null;
  if (!Number.isSafeInteger(timestamp) || Number(timestamp) < now - MAX_AGE_MS || Number(timestamp) > now + 10 * 60_000) return null;

  let contextEvents: ContextEvalWireEvent[] | undefined;
  if (row.contextEvents !== undefined) {
    if (!Array.isArray(row.contextEvents) || row.contextEvents.length > MAX_CONTEXT_EVENTS) {
      return null;
    }
    contextEvents = [];
    for (const item of row.contextEvents) {
      const parsed = validateContextEvent(item, now);
      if (!parsed) return null;
      contextEvents.push(parsed);
    }
  }
  const contextOnly = row.contextOnly === true ? true : undefined;

  return {
    schemaVersion: 1,
    eventId,
    sessionKey,
    agentId,
    ...(traceId ? { traceId } : {}),
    ...(model ? { model } : {}),
    durationMs: Number(durationMs),
    toolCalls: Number(toolCalls),
    ...(source ? { runtimeSourceCommit: source } : {}),
    ...(boot ? { runtimeBootHash: boot } : {}),
    timestamp: Number(timestamp),
    ...(contextOnly ? { contextOnly: true } : {}),
    ...(contextEvents && contextEvents.length > 0 ? { contextEvents } : {}),
  };
}

export async function insertTurnObservation(
  deps: TurnObservationDeps,
  userId: number,
  containerId: number,
  body: TurnObservationBody,
): Promise<{ duplicate: boolean }> {
  let duplicate = false;
  // Context-only carriers (orphan / chunk overflow) MUST NOT insert into
  // `turn_runtime_observations` or update `turn_traces`, preventing durationMs=0
  // from polluting real turn latency via COALESCE.
  if (body.contextOnly !== true) {
    const result = await deps.queryRunner.query<{ inserted: boolean }>(
      `WITH attribution AS (
         SELECT trace_id,dispatch_id,model
           FROM turn_traces
          WHERE $4::text IS NOT NULL AND trace_id=$4 AND user_id=$2
          LIMIT 1
       ), inserted AS (
         INSERT INTO turn_runtime_observations(
           event_id,user_id,container_id,trace_id,dispatch_id,session_key,agent_id,model,
           runtime_source_commit,runtime_boot_hash,duration_ms,tool_calls,observed_at
         ) VALUES (
           $1,$2,$3,(SELECT trace_id FROM attribution),(SELECT dispatch_id FROM attribution),
           $5,$6,COALESCE((SELECT model FROM attribution),$7),$8,$9,$10,$11,
           to_timestamp($12::double precision/1000.0)
         )
         ON CONFLICT (event_id) DO NOTHING
         RETURNING 1
       ), trace_update AS (
         UPDATE turn_traces
            SET runtime_container_id=COALESCE(runtime_container_id,$3),
                runtime_source_commit=COALESCE(runtime_source_commit,$8),
                runtime_boot_hash=COALESCE(runtime_boot_hash,$9),
                runtime_total_ms=COALESCE(runtime_total_ms,$10),
                runtime_tool_calls=COALESCE(runtime_tool_calls,$11),
                runtime_observed_at=COALESCE(runtime_observed_at,to_timestamp($12::double precision/1000.0))
          WHERE $4::text IS NOT NULL AND trace_id=$4 AND user_id=$2
            AND EXISTS (SELECT 1 FROM inserted)
       )
       SELECT EXISTS(SELECT 1 FROM inserted) AS inserted`,
      [
        body.eventId, userId, containerId, body.traceId ?? null, body.sessionKey,
        body.agentId, body.model ?? null, body.runtimeSourceCommit ?? null,
        body.runtimeBootHash ?? null, body.durationMs, body.toolCalls, body.timestamp,
      ],
    );
    duplicate = result.rows[0]?.inserted !== true;
  }

  // Idempotently upsert context_eval_events (even when turn_runtime_observations was duplicate),
  // backfilling missing dispatch_id / runtime_source_commit if a retry arrives after turn_traces.
  if (body.contextEvents && body.contextEvents.length > 0) {
    for (const ev of body.contextEvents) {
      const evTraceId = ev.traceId ?? body.traceId ?? null;
      await deps.queryRunner.query(
        `WITH attribution AS (
           SELECT dispatch_id
             FROM turn_traces
            WHERE $4::text IS NOT NULL AND trace_id=$4 AND user_id=$2
            LIMIT 1
         )
         INSERT INTO context_eval_events(
           event_id, user_id, container_id, trace_id, dispatch_id,
           session_key, agent_id, turn_index, event_kind,
           engine, model, compaction_scope, compaction_strategy,
           before_bytes, after_bytes, before_tokens, after_tokens, dropped_entries,
           decision, reason, changed_slots, static_prefix_sha256,
           total_bytes, tokens_estimate, degraded_steps, runtime_source_commit, observed_at
         ) VALUES (
           $1, $2, $3, $4, (SELECT dispatch_id FROM attribution),
           $5, $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15, $16, $17,
           $18, $19, $20, $21,
           $22, $23, $24, $25, to_timestamp($26::double precision/1000.0)
         )
         ON CONFLICT (event_id) DO UPDATE
           SET dispatch_id = COALESCE(context_eval_events.dispatch_id, EXCLUDED.dispatch_id),
               runtime_source_commit = COALESCE(context_eval_events.runtime_source_commit, EXCLUDED.runtime_source_commit)
         WHERE context_eval_events.user_id = EXCLUDED.user_id
           AND (context_eval_events.trace_id IS NULL OR context_eval_events.trace_id = EXCLUDED.trace_id)
           AND (context_eval_events.dispatch_id IS NULL
             OR context_eval_events.runtime_source_commit IS NULL)`,
        [
          ev.eventId,
          userId,
          containerId ?? null,
          evTraceId,
          ev.sessionKey ?? body.sessionKey,
          ev.agentId ?? body.agentId,
          ev.turnIndex ?? null,
          ev.eventKind,
          ev.engine ?? null,
          ev.model ?? body.model ?? null,
          ev.compactionScope ?? null,
          ev.compactionStrategy ?? null,
          ev.beforeBytes ?? null,
          ev.afterBytes ?? null,
          ev.beforeTokens ?? null,
          ev.afterTokens ?? null,
          ev.droppedEntries ?? null,
          ev.decision ?? null,
          ev.reason ?? null,
          ev.changedSlots ?? null,
          ev.staticPrefixSha256 ?? null,
          ev.totalBytes ?? null,
          ev.tokensEstimate ?? null,
          ev.degradedSteps ?? null,
          body.runtimeSourceCommit ?? null,
          ev.observedAt,
        ],
      );
    }
  }

  // Late-arrival reconciliation: if an earlier contextOnly chunk arrived before `turn_traces`,
  // backfill its `dispatch_id` and `runtime_source_commit` once the real turn observation lands.
  if (body.contextOnly !== true && body.traceId) {
    await deps.queryRunner.query(
      `UPDATE context_eval_events cee
          SET dispatch_id = COALESCE(cee.dispatch_id, tt.dispatch_id),
              runtime_source_commit = COALESCE(cee.runtime_source_commit, $3)
         FROM turn_traces tt
        WHERE cee.user_id = $1
          AND cee.trace_id = $2
          AND (cee.dispatch_id IS NULL OR cee.runtime_source_commit IS NULL)
          AND tt.user_id = $1
          AND tt.trace_id = $2`,
      [userId, body.traceId, body.runtimeSourceCommit ?? null],
    );
  }

  return { duplicate };
}

export function makeTurnObservationHandler(deps: TurnObservationDeps) {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalTurnObservation" });
  return async (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    if (req.method !== "POST") {
      send(res, 405, { error: { code: "METHOD_NOT_ALLOWED" } }, requestId);
      return;
    }
    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>;
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        send(res, 401, { error: { code: "UNAUTHORIZED" } }, requestId);
        return;
      }
      throw err;
    }
    let rawBody: unknown;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      if (err instanceof Error && err.message === "too_large") {
        send(res, 413, { error: { code: "PAYLOAD_TOO_LARGE" } }, requestId);
        return;
      }
      send(res, 400, { error: { code: "INVALID_BODY" } }, requestId);
      return;
    }
    const body = validate(rawBody, deps.now?.() ?? Date.now());
    if (!body) {
      send(res, 400, { error: { code: "INVALID_BODY" } }, requestId);
      return;
    }
    try {
      const result = await insertTurnObservation(deps, identity.userId, identity.containerId, body);
      send(res, 200, { ok: true, duplicate: result.duplicate }, requestId);
    } catch (err) {
      log.error("turn observation insert failed", {
        eventId: body.eventId,
        message: err instanceof Error ? err.message : String(err),
      });
      send(res, 500, { error: { code: "INTERNAL" } }, requestId);
    }
  };
}
