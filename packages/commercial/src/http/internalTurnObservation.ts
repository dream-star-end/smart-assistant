import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from "../auth/containerIdentity.js";
import { type Logger, rootLogger } from "../logging/logger.js";
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from "./util.js";

export { TURN_OBSERVATION_PATH } from "@openclaude/protocol";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_AGE_MS = 25 * 60 * 60 * 1000;

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

function validate(raw: unknown, now: number): TurnObservationBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "eventId", "sessionKey", "agentId", "traceId", "model",
    "durationMs", "toolCalls", "runtimeSourceCommit", "runtimeBootHash", "timestamp",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key)) || row.schemaVersion !== 1) return null;
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
  };
}

export async function insertTurnObservation(
  deps: TurnObservationDeps,
  userId: number,
  containerId: number,
  body: TurnObservationBody,
): Promise<{ duplicate: boolean }> {
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
  return { duplicate: result.rows[0]?.inserted !== true };
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
    let body: TurnObservationBody | null = null;
    try { body = validate(await readBody(req), deps.now?.() ?? Date.now()); } catch { /* invalid */ }
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
