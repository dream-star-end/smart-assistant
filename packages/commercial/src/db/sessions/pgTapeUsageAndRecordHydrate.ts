import type { Pool, PoolClient } from "pg";
import {
  EPOCH_BAND,
  applyTimelineStamp,
  copyProcessKeyFromLiveUnits,
  deriveProcessKeyFromRecord,
  packEpoch,
  packTapeSeq,
  timelineIdentity,
  type CcbNativeTranscriptArchive,
  type CcbTranscriptRestoreBinding,
  type EngineIdentityFields,
  type LiveProcessIdentitySeed,
  type TimelineLifecycle,
} from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import type { LosslessTurnRecord } from "../../http/losslessTurnTape.js";
import { readCcbNativeRestoreArchiveFromDb } from "../pgCcbTranscriptRestore.js";
import { expandHydratedRuntimeBatch } from "../runtimeBatch.js";
import { bigIntNum, sha256Bytes } from "./sqlHelpers.js";
import type {
  ExactUsageEnrichment,
  HydratedTapeRow,
  RecoverySourceUsage,
  TapeFallbackSettlement,
} from "./types.js";

export function tapeAnchor(
  billingRecord: LosslessTurnRecord,
  tapeId: string,
  tapeSha256: string,
  physicalRecordCount: number,
  logicalRecordCount: number,
  runtimeBatchManifestSha256: string | undefined,
  structuredRoles: string[],
): MessageLike & { id: string } {
  return {
    id: billingRecord.id,
    role: billingRecord.role,
    ts: billingRecord.ts,
    _source: "server",
    _turnTapeId: tapeId,
    _turnTapeSha256: tapeSha256,
    _turnTapeComplete: true,
    _turnTapeRecordCount: physicalRecordCount,
    _turnTapePhysicalRecordCount: physicalRecordCount,
    _turnTapeLogicalRecordCount: logicalRecordCount,
    ...(runtimeBatchManifestSha256
      ? { _turnTapeRuntimeManifestSha256: runtimeBatchManifestSha256 }
      : {}),
    ...(structuredRoles.length > 0 ? { _turnTapeStructuredRoles: structuredRoles } : {}),
  };
}

export function parseDelegateCosts(value: unknown): Array<{ agentId: string; costCredits: string }> {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        return typeof row.agentId === "string" &&
          typeof row.costCredits === "string" && /^\d+$/.test(row.costCredits)
          ? [{ agentId: row.agentId, costCredits: row.costCredits }]
          : [];
      })
    : [];
}

export async function readRecoverySourceUsage(
  client: PoolClient,
  sessionId: string,
  userId: string,
  tapeId: string,
  billingAnchorId: string,
): Promise<RecoverySourceUsage> {
  const row = (
    await client.query<{ cost_credits: string; delegates: unknown }>(
      `WITH components AS (
         SELECT cost_credits::numeric AS cost_credits,delegate_agent_id
           FROM turn_tape_cost_components
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND billing_anchor_id=$4
       ), grouped AS (
         SELECT delegate_agent_id,SUM(cost_credits)::text AS cost_credits
           FROM components WHERE delegate_agent_id IS NOT NULL
          GROUP BY delegate_agent_id
       )
       SELECT COALESCE((SELECT SUM(cost_credits)::text FROM components),'0') AS cost_credits,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                'agentId',delegate_agent_id,'costCredits',cost_credits)
                                ORDER BY delegate_agent_id) FROM grouped),'[]'::jsonb) AS delegates`,
      [sessionId, userId, tapeId, billingAnchorId],
    )
  ).rows[0];
  return {
    costCredits: row?.cost_credits ?? "0",
    delegates: parseDelegateCosts(row?.delegates),
  };
}

export function assertRecoveryUsageFallback(
  usage: Record<string, unknown> | undefined,
  source: RecoverySourceUsage,
): void {
  if (!usage || usage.costCredits !== source.costCredits || !Array.isArray(usage.delegates)) {
    throw new Error("turn tape recovery usage fallback does not match source costs");
  }
  const delegates = parseDelegateCosts(usage.delegates);
  if (
    delegates.length !== usage.delegates.length ||
    JSON.stringify([...delegates].sort((a, b) => a.agentId.localeCompare(b.agentId))) !==
      JSON.stringify(source.delegates)
  ) {
    throw new Error("turn tape recovery delegate fallback does not match source costs");
  }
}

export function usageRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function attachFallbackSettlementUsage(
  msg: MessageLike,
  header: {
    usage?: unknown;
    requestId?: string | null;
    costCredits?: string;
    waiverApplied?: boolean;
    delegates?: Array<{ agentId: string; costCredits: string }>;
  } | null | undefined,
  anchorUsage: unknown,
): MessageLike {
  const tape = usageRecord(header?.usage) ?? {};
  const anchor = usageRecord(anchorUsage) ?? {};
  const base = { ...tape, ...anchor };
  const requestId = header?.requestId;
  const traceId =
    (typeof base.traceId === "string" && base.traceId.length > 0 ? base.traceId : undefined)
    ?? (typeof requestId === "string" && requestId.length > 0 ? requestId : undefined);
  const seeded = (Object.keys(base).length > 0 || traceId)
    ? { ...msg, usage: traceId ? { ...base, traceId } : base }
    : msg;
  return mergeExactUsage(
    seeded,
    {
      costCredits: header?.costCredits ?? "0",
      waiverApplied: header?.waiverApplied === true,
      delegates: header?.delegates ?? [],
    },
    true,
  );
}

const READ_TAPE_FALLBACK_SETTLEMENTS_SQL = `SELECT t.tape_id, t.usage,
        NULLIF(COALESCE(t.engine_billings->0->>'requestId', t.usage->>'traceId'), '') AS request_id,
        EXISTS (
          SELECT 1 FROM turn_waivers w
           WHERE ('c:' || w.user_id::text)=t.user_id
             AND w.turn_key=t.turn_key AND w.status='applied'
        ) AS waiver_applied,
        COALESCE((
          SELECT SUM(exact_cost.cost_credits)::text
            FROM (
              SELECT c.cost_credits::numeric AS cost_credits
                FROM turn_tape_cost_components c
               WHERE c.user_id=t.user_id AND c.session_id=t.session_id
                 AND c.tape_id=t.tape_id AND c.billing_anchor_id=t.billing_anchor_id
              UNION ALL
              SELECT p.cost_credits::numeric AS cost_credits
                FROM pending_usage_patches p
               WHERE p.user_id=t.user_id
                 AND (
                   p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key
                   OR p.request_id=NULLIF(t.engine_billings->0->>'requestId','')
                   OR p.request_id=NULLIF(t.usage->>'traceId','')
                 )
            ) exact_cost
        ), '0') AS cost_credits,
        COALESCE((
          SELECT jsonb_agg(
                   jsonb_build_object(
                     'agentId', grouped.delegate_agent_id,
                     'costCredits', grouped.cost_credits
                   ) ORDER BY grouped.delegate_agent_id
                 )
            FROM (
              SELECT exact_delegate.delegate_agent_id,
                     SUM(exact_delegate.cost_credits)::text AS cost_credits
                FROM (
                  SELECT c.delegate_agent_id, c.cost_credits::numeric AS cost_credits
                    FROM turn_tape_cost_components c
                   WHERE c.user_id=t.user_id AND c.session_id=t.session_id
                     AND c.tape_id=t.tape_id AND c.billing_anchor_id=t.billing_anchor_id
                  UNION ALL
                  SELECT p.delegate_agent_id, p.cost_credits::numeric AS cost_credits
                    FROM pending_usage_patches p
                   WHERE p.user_id=t.user_id
                     AND (
                       p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key
                       OR p.request_id=NULLIF(t.engine_billings->0->>'requestId','')
                       OR p.request_id=NULLIF(t.usage->>'traceId','')
                     )
                ) exact_delegate
               WHERE exact_delegate.delegate_agent_id IS NOT NULL
               GROUP BY exact_delegate.delegate_agent_id
            ) grouped
        ), '[]'::jsonb) AS delegate_costs
   FROM client_session_turn_tapes t
  WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=ANY($3::text[])`;

export async function readTapeFallbackSettlements(
  client: Pool | PoolClient,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<Map<string, TapeFallbackSettlement>> {
  if (tapeIds.length === 0) return new Map();
  const rows = (
    await client.query<{
      tape_id: string;
      usage: unknown;
      request_id: string | null;
      cost_credits: string;
      waiver_applied: boolean;
      delegate_costs: unknown;
    }>(READ_TAPE_FALLBACK_SETTLEMENTS_SQL, [sessionId, userId, tapeIds])
  ).rows;
  return new Map(rows.map((row) => [row.tape_id, {
    usage: row.usage,
    requestId: row.request_id,
    costCredits: row.cost_credits,
    waiverApplied: row.waiver_applied,
    delegates: parseDelegateCosts(row.delegate_costs),
  }]));
}

export async function mergeTapeFallbackSettlements<T extends { tapeId: string }>(
  client: Pool | PoolClient,
  sessionId: string,
  userId: string,
  headers: Map<string, T>,
): Promise<void> {
  const settlements = await readTapeFallbackSettlements(client, sessionId, userId, [...headers.keys()]);
  for (const [, header] of headers) {
    const settlement = settlements.get(header.tapeId);
    if (!settlement) continue;
    Object.assign(header, settlement);
  }
}

export function mergeExactUsage(
  msg: MessageLike,
  enrich: ExactUsageEnrichment,
  isBillingAnchor: boolean,
): MessageLike {
  const exactCostUsage = BigInt(enrich.costCredits) > 0n ? { costCredits: enrich.costCredits } : {};
  const exactWaiverUsage = enrich.waiverApplied && isBillingAnchor ? { waived: true } : {};
  const exactDelegateUsage = enrich.delegates.length > 0 ? { delegates: enrich.delegates } : {};
  if (
    Object.keys(exactCostUsage).length === 0 &&
    Object.keys(exactWaiverUsage).length === 0 &&
    Object.keys(exactDelegateUsage).length === 0
  ) {
    return msg;
  }
  const base = msg.usage && typeof msg.usage === "object" && !Array.isArray(msg.usage)
    ? (msg.usage as Record<string, unknown>)
    : {};
  return { ...msg, usage: { ...base, ...exactCostUsage, ...exactWaiverUsage, ...exactDelegateUsage } };
}

export function mergeBillingAnchorUsage(
  msg: MessageLike,
  anchor: MessageLike,
  isBillingAnchor: boolean,
): MessageLike {
  if (!isBillingAnchor || !anchor.usage || typeof anchor.usage !== "object" || Array.isArray(anchor.usage)) {
    return msg;
  }
  const base = msg.usage && typeof msg.usage === "object" && !Array.isArray(msg.usage)
    ? (msg.usage as Record<string, unknown>)
    : {};
  return { ...msg, usage: { ...base, ...(anchor.usage as Record<string, unknown>) } };
}

export function hydrateTapeRecordContent(
  row: HydratedTapeRow,
  anchor: MessageLike,
  requireRecordHash: boolean,
  fromCompleteAnchor = false,
): MessageLike {
  const payloadBytes = Buffer.from(row.payload);
  const actualSha = sha256Bytes(payloadBytes);
  if (
    actualSha !== row.content_sha256 ||
    (requireRecordHash && actualSha !== anchor._turnTapeSha256)
  ) {
    throw new Error(`[pgSessions] lossless turn tape record hash mismatch: ${row.tape_id}\0${row.msg_id}`);
  }
  let full: MessageLike;
  try {
    const parsed = JSON.parse(payloadBytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    full = parsed as MessageLike;
  } catch (err) {
    throw new Error(
      `[pgSessions] lossless turn tape record malformed: ${row.tape_id}\0${row.msg_id}: ${(err as Error).message}`,
    );
  }
  const recordUsage = full.usage && typeof full.usage === "object"
    ? (full.usage as Record<string, unknown>)
    : {};
  const anchorUsage = full.id === anchor.id && anchor.usage && typeof anchor.usage === "object"
    ? (anchor.usage as Record<string, unknown>)
    : {};
  return {
    ...full,
    _source: "server",
    _turnTapeId: row.tape_id,
    _turnTapeMsgId: row.msg_id,
    _turnTapeOrdinal: row.ordinal,
    _turnTapeSha256: row.tape_sha256,
    _turnTapeExpanded: true,
    ...(fromCompleteAnchor ? { _turnTapeComplete: true } : { _turnTapeComplete: undefined }),
    ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
    ...(typeof anchor._orderSeq === "number" ? { _orderSeq: anchor._orderSeq } : {}),
    ...(Object.keys(recordUsage).length > 0 || Object.keys(anchorUsage).length > 0
      ? { usage: { ...recordUsage, ...anchorUsage } }
      : {}),
  };
}

export function hydrateTapeRecord(
  row: HydratedTapeRow,
  anchor: MessageLike,
  requireRecordHash: boolean,
  fromCompleteAnchor = false,
): MessageLike {
  const content = hydrateTapeRecordContent(row, anchor, requireRecordHash, fromCompleteAnchor);
  return mergeExactUsage(
    content,
    {
      costCredits: row.cost_credits,
      waiverApplied: row.waiver_applied,
      delegates: parseDelegateCosts(row.delegate_costs),
    },
    content.id === anchor.id,
  );
}

export function readCcbNativeRestoreArchive(
  pool: Pool | PoolClient,
  owner: string,
  binding: CcbTranscriptRestoreBinding,
): Promise<CcbNativeTranscriptArchive> {
  return readCcbNativeRestoreArchiveFromDb(
    pool,
    owner,
    binding,
    (row) => expandHydratedRuntimeBatch(hydrateTapeRecordContent(row, {}, false, true), row, {}),
  );
}

// ── Timeline identity & deferred record locators ─────────────────────────────

export function identityFieldsOf(record: MessageLike): EngineIdentityFields {
  return {
    role: typeof record.role === "string" ? record.role : undefined,
    messageId: typeof record.messageId === "string" ? record.messageId : undefined,
    blockId: typeof record.blockId === "string" ? record.blockId : undefined,
    runId: typeof record.runId === "string" ? record.runId : undefined,
    jobId: typeof record.jobId === "string" ? record.jobId : undefined,
    requestId: typeof record.requestId === "string" ? record.requestId : undefined,
    _delegateRunId: typeof record._delegateRunId === "string" ? record._delegateRunId : undefined,
    _timelineProcessKey: typeof record._timelineProcessKey === "string"
      ? record._timelineProcessKey
      : undefined,
    _turnTapeId: typeof record._turnTapeId === "string" ? record._turnTapeId : undefined,
    _turnTapeOrdinal: typeof record._turnTapeOrdinal === "number" ? record._turnTapeOrdinal : undefined,
    _recordOrdinal: typeof record._recordOrdinal === "number" ? record._recordOrdinal : undefined,
    _timelineLogicalOrdinal: typeof record._timelineLogicalOrdinal === "number"
      ? record._timelineLogicalOrdinal
      : undefined,
    _clientMessageId: typeof record._clientMessageId === "string" ? record._clientMessageId : undefined,
    _turnOwnerId: typeof record._turnOwnerId === "string" ? record._turnOwnerId : undefined,
  };
}

export function stampTapeLifecycle(
  record: MessageLike,
  lifecycle: TimelineLifecycle,
  opts: {
    processKey?: string;
    historyRevision?: number;
    ordinal?: number;
    exactBit?: 0 | 1;
    liveUnits?: LiveProcessIdentitySeed[];
    sameRoleIndex?: number;
    logicalIndex?: number;
  } = {},
): MessageLike {
  const fields = identityFieldsOf(record);
  const owner = fields._turnOwnerId || fields._clientMessageId || "";
  const role = fields.role || "";
  const ordinal = opts.ordinal ?? (
    typeof record._recordOrdinal === "number"
      ? record._recordOrdinal
      : typeof record._turnTapeOrdinal === "number"
        ? record._turnTapeOrdinal
        : 0
  );
  const copied = opts.liveUnits
    ? copyProcessKeyFromLiveUnits(opts.liveUnits, fields, opts.sameRoleIndex ?? 0)
    : undefined;
  const processKey = opts.processKey
    ?? copied
    ?? deriveProcessKeyFromRecord(
      fields,
      typeof record._turnTapeId === "string" ? record._turnTapeId : undefined,
      ordinal,
      opts.logicalIndex,
    );
  const seq = packTapeSeq(opts.historyRevision ?? 0, ordinal);
  const exactBit = opts.exactBit ?? (lifecycle === "exact_displayable" ? 1 : 0);
  return applyTimelineStamp(record as Record<string, unknown>, {
    _lifecycle: lifecycle,
    _lifecycleEpoch: packEpoch(EPOCH_BAND.TAPE, 0, seq, exactBit),
    _timelineIdentity: timelineIdentity(String(owner), role, processKey),
    _timelineProcessKey: processKey,
  }) as MessageLike;
}

export function agentGroupRunIdFromRecordId(msgId: string): string | undefined {
  const marker = "-agentgroup-";
  const index = msgId.indexOf(marker);
  if (index < 0) return undefined;
  const runId = msgId.slice(index + marker.length);
  return runId.length > 0 ? runId : undefined;
}

export function deferredTapeRecord(
  tapeId: string,
  tapeSha256: string,
  head: { msg_id: string; ordinal: number; role: string; ts: string; content_sha256?: string },
  payloadBytes: number,
  extras?: { continuationOfTurnKey?: string | null },
): MessageLike {
  const continuationOfTurnKey = extras?.continuationOfTurnKey;
  const delegateRunId = head.role === "agent-group"
    ? agentGroupRunIdFromRecordId(head.msg_id)
    : undefined;
  return stampTapeLifecycle({
    id: head.msg_id,
    role: head.role,
    text: "",
    ts: bigIntNum(head.ts, "turn tape record ts"),
    _source: "server",
    _turnTapeId: tapeId,
    _turnTapeMsgId: head.msg_id,
    _turnTapeOrdinal: head.ordinal,
    _turnTapeSha256: tapeSha256,
    _turnTapeComplete: true,
    _recordOrdinal: head.ordinal,
    _payloadDeferred: true,
    _payloadBytes: payloadBytes,
    ...(head.content_sha256 ? { _payloadSha256: head.content_sha256 } : {}),
    ...(typeof continuationOfTurnKey === "string" && continuationOfTurnKey.length > 0
      ? { _continuationOfTurnKey: continuationOfTurnKey }
      : {}),
    ...(delegateRunId ? { _delegateRunId: delegateRunId } : {}),
  }, "exact_deferred", { ordinal: head.ordinal, exactBit: 0 });
}
