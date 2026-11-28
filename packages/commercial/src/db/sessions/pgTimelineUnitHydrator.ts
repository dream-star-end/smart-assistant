import type { PoolClient } from "pg";
import type { LiveProcessIdentitySeed } from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import { loadSessionLiveCheckpointUnits } from "../liveUnitCheckpoints.js";
import { expandHydratedRuntimeBatch } from "../runtimeBatch.js";
import {
  classifyUnifiedTimelineIntegrityError,
  recordsPublished,
} from "../visibleFinalize.js";
import { readDirectTapeVisibleHeads } from "./pgTapeHydrateReader.js";
import {
  deferUnifiedTimelinePayload,
  userVisiblePhysicalPayload,
} from "./pgTapeSanitizeAndEncode.js";
import {
  deferredTapeRecord,
  mergeBillingAnchorUsage,
  mergeExactUsage,
  parseDelegateCosts,
  stampTapeLifecycle,
} from "./pgTapeUsageAndRecordHydrate.js";
import {
  timelineTapeKey,
  unifiedTimelineTapeFallbackMessages,
} from "./pgTimelineAuxReader.js";
import { bigIntNum, sha256Bytes } from "./sqlHelpers.js";
import type {
  DirectTapeSourceRecord,
  DirectTapeVisibleHead,
  ExactUsageEnrichment,
  UnifiedTimelineSelectedUnit,
  UnifiedTimelineTapeHeader,
} from "./types.js";

export type SelectedTapeUnit = Extract<UnifiedTimelineSelectedUnit, { kind: "tape" }>;

const READ_UNIFIED_TIMELINE_TAPE_PAYLOADS_SQL = `WITH selected(tape_id,ordinal) AS (
   SELECT * FROM unnest($3::text[],$4::integer[])
 )
 SELECT r.tape_id,r.msg_id,r.ordinal,r.role,r.content_sha256,r.payload,
        r.visible_payload,r.visible_content_sha256
   FROM selected
   JOIN client_session_turn_tape_records r
     ON r.session_id=$1 AND r.user_id=$2
    AND r.tape_id=selected.tape_id AND r.ordinal=selected.ordinal`;

function resolveTapeUnitVisibleBytes(
  source: DirectTapeSourceRecord,
  header: UnifiedTimelineTapeHeader,
  physicalKey: string,
): Buffer {
  if (source.visible_payload !== null) {
    const visibleBytes = Buffer.from(source.visible_payload);
    if (sha256Bytes(visibleBytes) !== source.visible_content_sha256) {
      throw new Error(`[pgSessions] unified timeline visible payload hash mismatch: ${physicalKey}`);
    }
    return visibleBytes;
  }
  const visible = userVisiblePhysicalPayload({
    tape_id: header.tapeId,
    tape_sha256: header.tapeSha256,
    waive_reason: null,
    waiver_applied: false,
    msg_id: source.msg_id,
    ordinal: source.ordinal,
    role: source.role,
    content_sha256: source.content_sha256,
    payload: Buffer.from(source.payload),
    cost_credits: "0",
    delegate_costs: [],
  }, header.tapeSha256, header.billingAnchorId);
  if (!visible) throw new Error(`[pgSessions] unified timeline record malformed: ${physicalKey}`);
  return visible.bytes;
}

function parseVisibleTapeRecordJson(visibleBytes: Buffer, physicalKey: string): MessageLike {
  try {
    const value = JSON.parse(visibleBytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as MessageLike;
  } catch (error) {
    throw new Error(
      `[pgSessions] unified timeline record JSON invalid: ${physicalKey}: ${(error as Error).message}`,
    );
  }
}

function hydrateInlineTapeUnitRecords(
  unit: SelectedTapeUnit,
  source: DirectTapeSourceRecord | undefined,
  isBillingAnchor: boolean,
  enrichment: ExactUsageEnrichment,
  physicalKey: string,
): MessageLike[] {
  if (!source) throw new Error(`[pgSessions] unified timeline tape record missing: ${physicalKey}`);
  const { anchor, header } = unit;
  const visibleBytes = resolveTapeUnitVisibleBytes(source, header, physicalKey);
  const parsed = parseVisibleTapeRecordJson(visibleBytes, physicalKey);
  let hydrated: MessageLike = {
    ...parsed,
    _source: "server",
    _turnTapeId: header.tapeId,
    _turnTapeMsgId: source.msg_id,
    _turnTapeOrdinal: source.ordinal,
    _turnTapeSha256: header.tapeSha256,
    _turnTapeExpanded: true,
    _turnTapeComplete: true,
    ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
    _orderSeq: unit.orderSeq,
  };
  hydrated = mergeBillingAnchorUsage(hydrated, anchor, isBillingAnchor);
  hydrated = mergeExactUsage(hydrated, enrichment, isBillingAnchor);
  return expandHydratedRuntimeBatch(
    hydrated,
    {
      tape_id: header.tapeId,
      tape_sha256: header.tapeSha256,
      waive_reason: null,
      waiver_applied: false,
      msg_id: source.msg_id,
      ordinal: source.ordinal,
      role: source.role,
      content_sha256: source.content_sha256,
      payload: source.payload,
      cost_credits: enrichment.costCredits,
      delegate_costs: enrichment.delegates,
    },
    anchor,
  ).messages;
}

function stampHydratedTapeUnitRecords(
  unit: SelectedTapeUnit,
  logicalRecords: MessageLike[],
  liveUnits: LiveProcessIdentitySeed[],
  roleIndex: Map<string, number>,
): MessageLike[] {
  const { anchor, header, head } = unit;
  return logicalRecords.map((record, logicalIndex) => {
    const decorated: MessageLike = {
      ...record,
      _source: "server",
      _turnTapeId: header.tapeId,
      _turnTapeSha256: header.tapeSha256,
      _turnTapeComplete: true,
      _turnTapeOrdinal: head.ordinal,
      _recordOrdinal: head.ordinal,
      ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
      _orderSeq: unit.orderSeq,
      status: typeof record.status === "string" ? record.status : header.status,
      // Non-display terminal evidence for the owning finalized tape.
      _automaticRecoveryDecisionPending: header.finalizedAt === null,
      _dispatchOutcome: header.status,
      _turnKey: header.turnKey,
      ...(header.clientMessageId && typeof record._clientMessageId !== "string"
        ? { _clientMessageId: header.clientMessageId }
        : {}),
      _timelineRecord: true,
      _timelineLogicalOrdinal: logicalIndex,
      _timelineUnitKey: timelineTapeKey(header.tapeId, head.ordinal, logicalIndex, record.id),
    };
    const deferred = decorated._payloadDeferred === true;
    const owner = typeof decorated._turnOwnerId === "string" && decorated._turnOwnerId
      ? decorated._turnOwnerId
      : typeof decorated._clientMessageId === "string"
        ? decorated._clientMessageId
        : "";
    const role = typeof decorated.role === "string" ? decorated.role : "";
    const idxKey = `${owner}\0${role}`;
    const sameRoleIndex = roleIndex.get(idxKey) ?? 0;
    roleIndex.set(idxKey, sameRoleIndex + 1);
    return stampTapeLifecycle(decorated, deferred ? "exact_deferred" : "exact_displayable", {
      historyRevision: unit.orderSeq,
      ordinal: head.ordinal,
      exactBit: deferred ? 0 : 1,
      liveUnits,
      sameRoleIndex,
      logicalIndex,
    });
  });
}

function hydrateSingleTapeUnit(
  unit: SelectedTapeUnit,
  billingByTape: Map<string, DirectTapeVisibleHead>,
  payloadByKey: Map<string, DirectTapeSourceRecord & { tape_id: string }>,
  liveUnits: LiveProcessIdentitySeed[],
  roleIndex: Map<string, number>,
): MessageLike[] {
  const { anchor, header, head } = unit;
  const physicalKey = `${header.tapeId}\0${head.ordinal}`;
  const payloadBytes = bigIntNum(head.payload_bytes, "turn tape timeline payload bytes");
  const billing = billingByTape.get(header.tapeId);
  const isBillingAnchor = head.msg_id === header.billingAnchorId;
  const enrichment: ExactUsageEnrichment = isBillingAnchor && billing
    ? {
        costCredits: billing.cost_credits,
        waiverApplied: billing.waiver_applied,
        delegates: parseDelegateCosts(billing.delegate_costs),
      }
    : { costCredits: "0", waiverApplied: false, delegates: [] };
  let logicalRecords: MessageLike[];
  if (deferUnifiedTimelinePayload(head.role, payloadBytes)) {
    let deferred = deferredTapeRecord(
      header.tapeId,
      header.tapeSha256,
      { ...head, content_sha256: head.visible_content_sha256 ?? undefined },
      payloadBytes,
      { continuationOfTurnKey: header.continuationOfTurnKey },
    );
    deferred = mergeBillingAnchorUsage(deferred, anchor, isBillingAnchor);
    deferred = mergeExactUsage(deferred, enrichment, isBillingAnchor);
    logicalRecords = [deferred];
  } else {
    logicalRecords = hydrateInlineTapeUnitRecords(
      unit,
      payloadByKey.get(physicalKey),
      isBillingAnchor,
      enrichment,
      physicalKey,
    );
  }
  return stampHydratedTapeUnitRecords(unit, logicalRecords, liveUnits, roleIndex);
}

export async function hydrateUnifiedTimelineTapeUnits(
  client: PoolClient,
  sessionId: string,
  userId: string,
  units: SelectedTapeUnit[],
): Promise<Map<string, MessageLike[]>> {
  const result = new Map<string, MessageLike[]>();
  if (units.length === 0) return result;
  const liveUnits = await loadSessionLiveCheckpointUnits(client, sessionId, userId);
  const roleIndex = new Map<string, number>();
  const tapeIds = [...new Set(units.map((unit) => unit.header.tapeId))];
  const billingHeads = await readDirectTapeVisibleHeads(client, sessionId, userId, tapeIds);
  const billingByTape = new Map(billingHeads.map((head) => [head.tape_id, head]));
  const planned = units.filter((unit) =>
    recordsPublished({
      materializationStatus: unit.header.materializationStatus,
      finalizedAt: unit.header.finalizedAt,
    }) &&
    !deferUnifiedTimelinePayload(
      unit.head.role,
      bigIntNum(unit.head.payload_bytes, "turn tape timeline payload bytes"),
    ));
  const payloadRows = planned.length === 0
    ? []
    : (
        await client.query<DirectTapeSourceRecord & { tape_id: string }>(
          READ_UNIFIED_TIMELINE_TAPE_PAYLOADS_SQL,
          [
            sessionId,
            userId,
            planned.map((unit) => unit.header.tapeId),
            planned.map((unit) => unit.head.ordinal),
          ],
        )
      ).rows;
  const payloadByKey = new Map(payloadRows.map((row) => [`${row.tape_id}\0${row.ordinal}`, row]));

  for (const unit of units) {
    const { anchor, header, head } = unit;
    if (!recordsPublished({
      materializationStatus: header.materializationStatus,
      finalizedAt: header.finalizedAt,
    })) {
      continue;
    }
    const physicalKey = `${header.tapeId}\0${head.ordinal}`;
    try {
      result.set(
        physicalKey,
        hydrateSingleTapeUnit(unit, billingByTape, payloadByKey, liveUnits, roleIndex),
      );
    } catch (error) {
      result.set(physicalKey, unifiedTimelineTapeFallbackMessages(sessionId, {
        tapeId: header.tapeId,
        orderSeq: unit.orderSeq,
        reason: classifyUnifiedTimelineIntegrityError(error),
        header,
        anchor,
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return result;
}
