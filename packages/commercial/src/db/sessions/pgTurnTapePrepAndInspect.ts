import { createHash } from "node:crypto";
import { freemem } from "node:os";
import { getHeapStatistics } from "node:v8";
import type { Pool, PoolClient } from "pg";
import {
  LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID,
  LOSSLESS_TURN_TAPE_PART_BYTES,
  LOSSLESS_TURN_TAPE_SHA256_RE,
  isClientMessageId,
  type LosslessTurnTapeFinalizeRequest,
  type LosslessTurnTapeVisibleRequest,
} from "@openclaude/protocol";
import type { LosslessTurnPayload } from "../../http/losslessTurnTape.js";
import { foldSyntheticServiceRestartTape } from "../serviceRestartLiveFold.js";
import type { PgSessionsDeps } from "./deps.js";
import { userVisiblePhysicalPayload } from "./pgTapeSanitizeAndEncode.js";
import { bigIntNum, sha256Bytes, withTx } from "./sqlHelpers.js";
import type {
  LateDelegateRootDecision,
  LosslessTurnTapeHeaderRow,
  LosslessTurnTapeStorageFormat,
  PhysicalFinalizeMemorySnapshot,
  PreparedLosslessTurnTape,
  PreparedModelSidecar,
  TurnTapeRecoveryLinkRow,
  UserVisiblePhysicalPayload,
} from "./types.js";

const READ_RECOVERY_LINK_SQL = `SELECT source_tape_id,recovery_tape_id,source_tape_sha256,recovery_tape_sha256,
        source_turn_key,recovery_turn_key
   FROM turn_tape_recovery_links
  WHERE session_id=$1 AND user_id=$2 AND recovery_tape_id=$3`;
const READ_RECOVERY_LINK_FOR_UPDATE_SQL = `${READ_RECOVERY_LINK_SQL} FOR UPDATE`;

const READ_PART_MANIFEST_SQL = `SELECT part_index,part_sha256,octet_length(payload)::text AS payload_bytes
   FROM client_session_turn_tape_parts
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
  ORDER BY part_index`;

const READ_TAPE_HEADER_SQL = `SELECT agent_id,turn_index,status,turn_key,tape_sha256,total_bytes,
        part_count,created_at,waive_reason,finalized_at,record_storage_format
   FROM client_session_turn_tapes
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`;
const READ_TAPE_HEADER_FOR_UPDATE_SQL = `${READ_TAPE_HEADER_SQL} FOR UPDATE`;

export function yieldLosslessTapeWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function sameTurnTapeRecoveryLink(
  left: TurnTapeRecoveryLinkRow,
  right: TurnTapeRecoveryLinkRow,
): boolean {
  return left.source_tape_id === right.source_tape_id &&
    left.recovery_tape_id === right.recovery_tape_id &&
    left.source_tape_sha256 === right.source_tape_sha256 &&
    left.recovery_tape_sha256 === right.recovery_tape_sha256 &&
    left.source_turn_key === right.source_turn_key &&
    left.recovery_turn_key === right.recovery_turn_key;
}

export async function readTurnTapeRecoveryLink(
  runner: Pool | PoolClient,
  sessionId: string,
  userId: string,
  recoveryTapeId: string,
  forUpdate = false,
): Promise<TurnTapeRecoveryLinkRow | null> {
  const sql = forUpdate ? READ_RECOVERY_LINK_FOR_UPDATE_SQL : READ_RECOVERY_LINK_SQL;
  return (await runner.query<TurnTapeRecoveryLinkRow>(sql, [sessionId, userId, recoveryTapeId])).rows[0] ?? null;
}

export function sameLosslessTurnTapeHeader(
  tape: Pick<LosslessTurnTapeHeaderRow,
    "agent_id" | "turn_index" | "status" | "turn_key" | "tape_sha256" |
    "total_bytes" | "part_count" | "created_at" | "waive_reason">,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
): boolean {
  return tape.agent_id === request.agentId &&
    tape.turn_index === request.turnIndex &&
    tape.status === request.status &&
    tape.turn_key === request.turnKey &&
    tape.tape_sha256 === request.tapeSha256 &&
    bigIntNum(tape.total_bytes, "turn_tape.total_bytes") === request.totalBytes &&
    tape.part_count === request.partCount &&
    bigIntNum(tape.created_at, "turn_tape.created_at") === request.createdAt &&
    tape.waive_reason === (request.waiveReason ?? null);
}

export function preparedModelSidecarsForOrdinal(
  physicalOrdinal: number,
  physicalMsgId: string,
  visible: UserVisiblePhysicalPayload,
): PreparedModelSidecar[] {
  return visible.modelRecords.map((modelRecord) => ({
    physicalOrdinal,
    logicalOrdinal: modelRecord.logicalOrdinal,
    msgId: modelRecord.msgId === `logical-${modelRecord.logicalOrdinal}`
      ? `${physicalMsgId}:logical-${modelRecord.logicalOrdinal}`
      : modelRecord.msgId,
    role: modelRecord.role,
    semanticText: modelRecord.semanticText,
    tokenEstimate: modelRecord.tokenEstimate,
    ts: modelRecord.ts,
    clientMessageId: modelRecord.clientMessageId,
  })).sort((a, b) => a.logicalOrdinal - b.logicalOrdinal);
}

export function preparedModelSidecarManifest(prepared: PreparedLosslessTurnTape): PreparedModelSidecar[] {
  return prepared.turn.records.flatMap((record, physicalOrdinal) =>
    preparedModelSidecarsForOrdinal(physicalOrdinal, record.id, prepared.visible[physicalOrdinal]!));
}

export async function verifyPreparedPartManifest(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  expectedManifest: PreparedLosslessTurnTape["partManifest"],
): Promise<"complete" | "incomplete"> {
  const actualManifest = (
    await client.query<{ part_index: number; part_sha256: string; payload_bytes: string }>(
      READ_PART_MANIFEST_SQL,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows;
  if (actualManifest.length !== expectedManifest.length) return "incomplete";
  for (let index = 0; index < actualManifest.length; index++) {
    const actual = actualManifest[index]!;
    const expected = expectedManifest[index]!;
    if (
      actual.part_index !== expected.partIndex ||
      actual.part_sha256 !== expected.partSha256 ||
      bigIntNum(actual.payload_bytes, "turn tape part bytes") !== expected.payloadBytes
    ) {
      throw new Error("lossless turn tape immutable part manifest conflict");
    }
  }
  return "complete";
}

function retryableFinalizeCapacityError(reason: string): Error {
  return Object.assign(new Error(`lossless turn tape finalize capacity unavailable: ${reason}`), {
    code: "OC_TURN_TAPE_FINALIZE_CAPACITY",
    retryable: true,
  });
}

function defaultReadFinalizeMemory(): PhysicalFinalizeMemorySnapshot {
  const heapLimitBytes = getHeapStatistics().heap_size_limit;
  return {
    availableSystemBytes: typeof process.availableMemory === "function" ? process.availableMemory() : freemem(),
    heapAvailableBytes: Math.max(0, heapLimitBytes - process.memoryUsage().heapUsed),
    heapLimitBytes,
  };
}

/**
 * Physical-memory admission, not a product content cap. Finalization still
 * materializes one canonical JSON value, so concurrent preparations reserve
 * their declared physical peaks.
 */
export function _createPhysicalFinalizeAdmission(
  readMemory: () => PhysicalFinalizeMemorySnapshot = defaultReadFinalizeMemory,
): (totalBytes: number) => () => void {
  let reservedExternalBytes = 0;
  let reservedHeapBytes = 0;
  return (totalBytes: number): (() => void) => {
    const externalNeed = totalBytes * 3;
    const heapNeed = totalBytes * 2;
    const memory = readMemory();
    if (
      !Number.isFinite(externalNeed) || !Number.isFinite(heapNeed) ||
      heapNeed > memory.heapLimitBytes ||
      reservedExternalBytes + externalNeed > memory.availableSystemBytes ||
      reservedHeapBytes + heapNeed > memory.heapAvailableBytes
    ) {
      throw retryableFinalizeCapacityError("current process/cgroup memory is insufficient");
    }
    reservedExternalBytes += externalNeed;
    reservedHeapBytes += heapNeed;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reservedExternalBytes -= externalNeed;
      reservedHeapBytes -= heapNeed;
    };
  };
}

export const acquireFinalizeMemoryAdmission = _createPhysicalFinalizeAdmission();

function validateStagedPartRows(
  parts: ReadonlyArray<{ part_index: number; part_sha256: string; payload_bytes: string }>,
  request: LosslessTurnTapeFinalizeRequest,
): void {
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex]!;
    const expectedBytes = partIndex === request.partCount - 1
      ? request.totalBytes - LOSSLESS_TURN_TAPE_PART_BYTES * (request.partCount - 1)
      : LOSSLESS_TURN_TAPE_PART_BYTES;
    if (
      part.part_index !== partIndex ||
      !LOSSLESS_TURN_TAPE_SHA256_RE.test(part.part_sha256) ||
      bigIntNum(part.payload_bytes, "turn tape part bytes") !== expectedBytes
    ) {
      throw new Error("lossless turn tape immutable part manifest conflict");
    }
  }
}

export async function isLosslessTurnTapeReadyForPreparation(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
): Promise<boolean> {
  const header = (
    await pool.query<LosslessTurnTapeHeaderRow>(
      READ_TAPE_HEADER_SQL,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows[0];
  if (!header) return false;
  if (!sameLosslessTurnTapeHeader(header, request)) {
    throw new Error("lossless turn tape finalize header conflict");
  }
  if (header.finalized_at !== null) return false;
  if (request.partCount !== Math.ceil(request.totalBytes / LOSSLESS_TURN_TAPE_PART_BYTES)) {
    throw new Error("lossless turn tape immutable part manifest conflict");
  }
  const parts = (
    await pool.query<{ part_index: number; part_sha256: string; payload_bytes: string }>(
      READ_PART_MANIFEST_SQL,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows;
  if (parts.length < request.partCount) return false;
  if (parts.length > request.partCount) {
    throw new Error("lossless turn tape immutable part manifest conflict");
  }
  validateStagedPartRows(parts, request);
  return true;
}

function retryableTapeError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { retryable: true, cause });
}

function lateDelegateRootConflict(): Error {
  return Object.assign(new Error("lossless turn tape late-delegate root conflict"), {
    immutableConflict: true,
  });
}

export async function loadAssembledTapePayload(
  pool: Pool | PoolClient,
  userId: string,
  sessionId: string,
  tapeId: string,
  expected: { totalBytes: number; tapeSha256: string; partCount: number },
): Promise<{ raw: unknown } | "incomplete"> {
  const parts = (
    await pool.query<{ part_index: number; part_sha256: string; payload: Buffer }>(
      `SELECT part_index, part_sha256, payload FROM client_session_turn_tape_parts
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 ORDER BY part_index`,
      [sessionId, userId, tapeId],
    )
  ).rows;
  if (parts.length !== expected.partCount) return "incomplete";
  const canonical = Buffer.allocUnsafe(expected.totalBytes);
  const aggregate = createHash("sha256");
  let writeOffset = 0;
  for (let partIndex = 0; partIndex < expected.partCount; partIndex++) {
    const part = parts[partIndex];
    if (!part || part.part_index !== partIndex) return "incomplete";
    const bytes = Buffer.from(part.payload);
    if (sha256Bytes(bytes) !== part.part_sha256) throw new Error("lossless turn tape part hash mismatch");
    if (writeOffset + bytes.length > canonical.length) {
      throw new Error("lossless turn tape aggregate length mismatch");
    }
    bytes.copy(canonical, writeOffset);
    aggregate.update(bytes);
    writeOffset += bytes.length;
  }
  if (writeOffset !== expected.totalBytes || aggregate.digest("hex") !== expected.tapeSha256) {
    throw new Error("lossless turn tape aggregate hash mismatch");
  }
  try {
    return { raw: JSON.parse(canonical.toString("utf8")) };
  } catch (err) {
    throw new Error(`lossless turn tape canonical JSON invalid: ${(err as Error).message}`);
  }
}

export async function loadAssembledTapePayloadAdmitted(
  pool: Pool | PoolClient,
  userId: string,
  sessionId: string,
  tapeId: string,
  expected: { totalBytes: number; tapeSha256: string; partCount: number },
): Promise<{ raw: unknown } | "incomplete"> {
  const release = acquireFinalizeMemoryAdmission(expected.totalBytes);
  try {
    return await loadAssembledTapePayload(pool, userId, sessionId, tapeId, expected);
  } finally {
    release();
  }
}

export function isLateDelegateContinuationAgentId(agentId: string): boolean {
  // B1 writer: `late_${runKey.slice(0, 24)}`. `tail_` runtimeEvents-only
  // continuations keep the visible-first contract and must not assemble here.
  return agentId.startsWith("late_");
}

export function losslessEnvelopeMatchesPayload(
  request: LosslessTurnTapeFinalizeRequest,
  payload: LosslessTurnPayload,
): boolean {
  return payload.sessionId === request.sessionId &&
    payload.agentId === request.agentId &&
    payload.turnIndex === request.turnIndex &&
    payload.status === request.status &&
    payload.turnKey === request.turnKey &&
    payload.waiveReason === request.waiveReason;
}

export function assertLosslessEnvelopeMatchesPayload(
  request: LosslessTurnTapeFinalizeRequest,
  payload: LosslessTurnPayload,
): void {
  if (!losslessEnvelopeMatchesPayload(request, payload)) {
    throw new Error("lossless turn tape envelope/payload identity mismatch");
  }
}

function rethrowInspectTapeError(err: unknown): never {
  if (err && typeof err === "object") {
    if ((err as { immutableConflict?: unknown }).immutableConflict === true) throw err;
    if ((err as { retryable?: unknown }).retryable === true) throw err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /part hash mismatch|aggregate (?:hash|length) mismatch|canonical JSON invalid|envelope\/payload identity mismatch/.test(msg)
  ) {
    throw err;
  }
  throw retryableTapeError("late-delegate root lookup failed", err);
}

type LateDelegateRootTapeRow = {
  tape_id: string; tape_sha256: string; total_bytes: string; part_count: number;
  finalized_at: string | null; visible_at: string | null; agent_id: string; turn_index: number;
  status: string; turn_key: string; created_at: string; physical_record_count: string | null;
  materialization_status: string | null; client_message_id: string | null;
};

type ReadyLateDelegateRootTapeRow = Omit<LateDelegateRootTapeRow, "status"> & {
  status: "completed" | "interrupted" | "crashed";
};

type PublishedAgentGroupRow = { msg_id: string; role: string; content_sha256: string; payload: Buffer };

async function resolveLateDelegatePayload(
  pool: Pool | PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  deps: PgSessionsDeps,
  continuationPayload?: LosslessTurnPayload,
): Promise<LosslessTurnPayload | "proceed" | "retry"> {
  if (continuationPayload) return continuationPayload;
  if (!isLateDelegateContinuationAgentId(request.agentId)) return "proceed";
  let assembled: { raw: unknown } | "incomplete";
  try {
    assembled = await loadAssembledTapePayloadAdmitted(pool, userId, request.sessionId, request.tapeId, {
      totalBytes: request.totalBytes,
      tapeSha256: request.tapeSha256,
      partCount: request.partCount,
    });
  } catch (err) {
    rethrowInspectTapeError(err);
  }
  return assembled === "incomplete" ? "retry" : deps.lossless.parseLosslessTurnPayload(assembled.raw);
}

function isReadyLateDelegateRoot(
  root: LateDelegateRootTapeRow,
): { root: ReadyLateDelegateRootTapeRow; physicalCount: number } | null {
  if (root.finalized_at == null || root.visible_at == null) return null;
  if (root.materialization_status !== "complete") return null;
  if (root.status !== "completed" && root.status !== "interrupted" && root.status !== "crashed") return null;
  const physicalCount = root.physical_record_count == null
    ? Number.NaN
    : bigIntNum(root.physical_record_count, "root turn tape physical_record_count");
  return Number.isFinite(physicalCount) && physicalCount >= 1
    ? { root: { ...root, status: root.status }, physicalCount }
    : null;
}

async function loadReadyRootForLateDelegate(
  pool: Pool | PoolClient,
  userId: string,
  sessionId: string,
  ownerTurnKey: string,
): Promise<{ root: ReadyLateDelegateRootTapeRow; recordPrefix: string } | null> {
  let roots: LateDelegateRootTapeRow[];
  try {
    roots = (
      await pool.query<LateDelegateRootTapeRow>(
        `SELECT t.tape_id, t.tape_sha256, t.total_bytes::text AS total_bytes, t.part_count,
                t.finalized_at::text, t.visible_at::text, t.agent_id, t.turn_index, t.status,
                t.turn_key, t.created_at::text, t.physical_record_count::text AS physical_record_count,
                t.materialization_status, t.client_message_id
           FROM client_session_turn_tapes t
          WHERE t.session_id=$1 AND t.user_id=$2 AND t.turn_key=$3
            AND t.continuation_of_turn_key IS NULL LIMIT 2`,
        [sessionId, userId, ownerTurnKey],
      )
    ).rows;
  } catch (err) {
    throw retryableTapeError("late-delegate root lookup failed", err);
  }
  if (roots.length !== 1) return null;
  const ready = isReadyLateDelegateRoot(roots[0]!);
  if (!ready) return null;
  const { root, physicalCount } = ready;
  const recordPrefix = root.agent_id === LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID
    ? `srv-${sessionId}-t${root.turn_index}`
    : `srv-${sessionId}-${root.agent_id}-t${root.turn_index}`;
  let recordStats: { total: string; off_prefix: string };
  try {
    recordStats = (
      await pool.query<{ total: string; off_prefix: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE msg_id NOT LIKE $4)::text AS off_prefix
           FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
        [sessionId, userId, root.tape_id, `${recordPrefix}%`],
      )
    ).rows[0] ?? { total: "0", off_prefix: "0" };
  } catch (err) {
    throw retryableTapeError("late-delegate root lookup failed", err);
  }
  const totalRecords = bigIntNum(recordStats.total, "root turn tape record count");
  const offPrefix = bigIntNum(recordStats.off_prefix, "root turn tape off-prefix record count");
  return totalRecords === physicalCount && offPrefix === 0 ? { root, recordPrefix } : null;
}

function collectLateDelegateGroupMsgIds(
  groups: ReadonlyArray<Record<string, unknown>>,
  recordPrefix: string,
): string[] | null {
  const msgIds: string[] = [];
  for (const group of groups) {
    const runId = typeof group.runId === "string" ? group.runId : "";
    if (!runId) return null;
    msgIds.push(`${recordPrefix}-agentgroup-${runId}`);
  }
  return msgIds;
}

async function loadPublishedAgentGroupRows(
  pool: Pool | PoolClient,
  userId: string,
  sessionId: string,
  rootTapeId: string,
  msgIds: string[],
): Promise<Map<string, PublishedAgentGroupRow>> {
  try {
    const rows = (
      await pool.query<PublishedAgentGroupRow>(
        `SELECT msg_id, role, content_sha256, payload FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND msg_id = ANY($4::text[])`,
        [sessionId, userId, rootTapeId, msgIds],
      )
    ).rows;
    return new Map(rows.map((row) => [row.msg_id, row]));
  } catch (err) {
    throw retryableTapeError("late-delegate root lookup failed", err);
  }
}

function parsePublishedAgentGroupObject(
  published: PublishedAgentGroupRow,
  bytes: Buffer,
): Record<string, unknown> | null {
  if (sha256Bytes(bytes) !== published.content_sha256) return null;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (err) {
    void err;
    return null;
  }
}

function verifyPublishedAgentGroupOrigin(
  parsed: Record<string, unknown>,
  group: Record<string, unknown>,
  root: LateDelegateRootTapeRow,
): string | undefined {
  const origin = parsed._clientMessageId;
  if (origin === undefined) return undefined;
  if (!isClientMessageId(origin)) throw lateDelegateRootConflict();
  if (root.client_message_id != null && root.client_message_id !== origin) {
    throw lateDelegateRootConflict();
  }
  if (group._clientMessageId !== undefined && group._clientMessageId !== origin) {
    throw lateDelegateRootConflict();
  }
  return origin;
}

function verifyPublishedAgentGroupMatches(
  group: Record<string, unknown>,
  published: PublishedAgentGroupRow,
  root: ReadyLateDelegateRootTapeRow,
  sessionId: string,
  createdAt: number,
  deps: PgSessionsDeps,
): "matched" | "retry" {
  if (published.role !== "agent-group") return "retry";
  const bytes = Buffer.from(published.payload);
  const release = acquireFinalizeMemoryAdmission(bytes.length);
  try {
    const parsed = parsePublishedAgentGroupObject(published, bytes);
    if (!parsed) return "retry";
    const origin = verifyPublishedAgentGroupOrigin(parsed, group, root);
    const expected = deps.lossless.materializeRootDomainAgentGroupRecord(group, {
      sessionId,
      agentId: root.agent_id,
      turnIndex: root.turn_index,
      status: root.status,
      turnKey: root.turn_key,
      createdAt,
      ...(typeof origin === "string" ? { clientMessageId: origin } : {}),
    });
    const lateFp = deps.lossless.canonicalPublishedAgentGroupRecordFingerprint(expected);
    const rootFp = deps.lossless.canonicalPublishedAgentGroupRecordFingerprint(parsed);
    if (lateFp !== rootFp) throw lateDelegateRootConflict();
    return "matched";
  } catch (err) {
    rethrowInspectTapeError(err);
  } finally {
    release();
  }
}

/** Master-side R1-4: agent-group continuation vs the owner root tape's parts/records. */
export async function inspectLateDelegateContinuationAgainstRoot(
  pool: Pool | PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  deps: PgSessionsDeps,
  continuationPayload?: LosslessTurnPayload,
): Promise<LateDelegateRootDecision> {
  const payload = await resolveLateDelegatePayload(pool, userId, request, deps, continuationPayload);
  if (payload === "proceed" || payload === "retry") return payload;
  assertLosslessEnvelopeMatchesPayload(request, payload);
  const ownerTurnKey = payload.continuationOfTurnKey;
  const groups = payload.agentGroups;
  if (!ownerTurnKey || !Array.isArray(groups) || groups.length === 0) return "proceed";

  const rootInfo = await loadReadyRootForLateDelegate(pool, userId, request.sessionId, ownerTurnKey);
  if (!rootInfo) return "retry";
  const msgIds = collectLateDelegateGroupMsgIds(groups, rootInfo.recordPrefix);
  if (!msgIds) return "retry";

  const byMsgId = await loadPublishedAgentGroupRows(pool, userId, request.sessionId, rootInfo.root.tape_id, msgIds);
  const createdAt = bigIntNum(rootInfo.root.created_at, "root turn tape created_at");
  let matched = 0;
  for (let index = 0; index < groups.length; index++) {
    const published = byMsgId.get(msgIds[index]!);
    if (!published) continue;
    const verdict = verifyPublishedAgentGroupMatches(
      groups[index]!, published, rootInfo.root, request.sessionId, createdAt, deps,
    );
    if (verdict === "retry") return "retry";
    matched += 1;
  }
  if (matched === groups.length) return "idempotent";
  if (matched > 0) throw lateDelegateRootConflict();
  return "proceed";
}

async function readTapePartByIndex(
  pool: Pool, sessionId: string, userId: string, tapeId: string, partIndex: number,
): Promise<{ part_sha256: string; payload: Buffer } | undefined> {
  return (
    await pool.query<{ part_sha256: string; payload: Buffer }>(
      `SELECT part_sha256,payload FROM client_session_turn_tape_parts
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND part_index=$4`,
      [sessionId, userId, tapeId, partIndex],
    )
  ).rows[0];
}

async function assembleCanonicalTapeParts(
  pool: Pool, userId: string, request: LosslessTurnTapeFinalizeRequest,
): Promise<{ rawPayload: unknown; partManifest: PreparedLosslessTurnTape["partManifest"] } | null> {
  const canonical = Buffer.allocUnsafe(request.totalBytes);
  const aggregate = createHash("sha256");
  const partManifest: PreparedLosslessTurnTape["partManifest"] = [];
  let writeOffset = 0;
  for (let partIndex = 0; partIndex < request.partCount; partIndex++) {
    const part = await readTapePartByIndex(pool, request.sessionId, userId, request.tapeId, partIndex);
    if (!part) return null;
    const bytes = Buffer.from(part.payload);
    if (sha256Bytes(bytes) !== part.part_sha256) throw new Error("lossless turn tape part hash mismatch");
    if (writeOffset + bytes.length > canonical.length) {
      throw new Error("lossless turn tape aggregate length mismatch");
    }
    bytes.copy(canonical, writeOffset);
    aggregate.update(bytes);
    partManifest.push({ partIndex, partSha256: part.part_sha256, payloadBytes: bytes.length });
    writeOffset += bytes.length;
  }
  if (writeOffset !== request.totalBytes || aggregate.digest("hex") !== request.tapeSha256) {
    throw new Error("lossless turn tape aggregate hash mismatch");
  }
  try {
    return { rawPayload: JSON.parse(canonical.toString("utf8")), partManifest };
  } catch (err) {
    throw new Error(`lossless turn tape canonical JSON invalid: ${(err as Error).message}`);
  }
}

async function buildVisiblePhysicalPayloads(
  request: LosslessTurnTapeFinalizeRequest, turn: PreparedLosslessTurnTape["turn"],
): Promise<UserVisiblePhysicalPayload[]> {
  const visible: UserVisiblePhysicalPayload[] = [];
  for (let ordinal = 0; ordinal < turn.records.length; ordinal++) {
    await yieldLosslessTapeWork();
    const item = turn.records[ordinal]!;
    const payload = userVisiblePhysicalPayload({
      tape_id: request.tapeId, tape_sha256: request.tapeSha256, waive_reason: null,
      waiver_applied: false, msg_id: item.id, ordinal, role: item.role,
      content_sha256: item.payloadSha256, payload: item.payloadBytes,
      cost_credits: "0", delegate_costs: [],
    }, request.tapeSha256, turn.billingAnchorId);
    if (!payload) {
      throw new Error(`[pgSessions] lossless tape record is not a JSON object: ${item.id}`);
    }
    visible.push(payload);
  }
  return visible;
}

export async function _prepareLosslessTurnTapeOutsideLocks(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  recordStorageFormat: LosslessTurnTapeStorageFormat,
  deps: PgSessionsDeps,
): Promise<PreparedLosslessTurnTape | null> {
  const header = (
    await pool.query<LosslessTurnTapeHeaderRow>(
      READ_TAPE_HEADER_SQL,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows[0];
  if (!header || header.finalized_at !== null) return null;
  if (!sameLosslessTurnTapeHeader(header, request)) {
    throw new Error("lossless turn tape finalize header conflict");
  }
  if (header.record_storage_format !== recordStorageFormat) {
    throw new Error("lossless turn tape materialization format changed during prepare");
  }
  const assembled = await assembleCanonicalTapeParts(pool, userId, request);
  if (!assembled) return null;
  const rawPayload = await foldSyntheticServiceRestartTape(
    pool, { sessionId: request.sessionId, userId, tapeId: request.tapeId }, assembled.rawPayload,
  );
  const turn = deps.lossless.materializeLosslessTurn(rawPayload, {
    runtimeBatching: recordStorageFormat === 3,
  });
  assertLosslessEnvelopeMatchesPayload(request, turn.payload);
  if (
    turn.payload.continuationOfTurnKey &&
    Array.isArray(turn.payload.agentGroups) &&
    turn.payload.agentGroups.length > 0
  ) {
    const lateDelegateRoot = await inspectLateDelegateContinuationAgainstRoot(
      pool, userId, request, deps, turn.payload,
    );
    if (lateDelegateRoot === "retry") return null;
    if (lateDelegateRoot === "idempotent") {
      throw Object.assign(new Error("late-delegate continuation already on root"), {
        lateDelegateRootIdempotent: true,
      });
    }
  }
  const visible = await buildVisiblePhysicalPayloads(request, turn);
  return {
    turn,
    visible,
    partManifest: assembled.partManifest,
    recordPayloadBytes: turn.records.reduce((sum, record) => sum + record.payloadBytes.length, 0),
    recordStorageFormat,
  };
}

export async function claimLosslessTurnTapeStorageFormat(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  deps: PgSessionsDeps,
): Promise<LosslessTurnTapeStorageFormat | null> {
  return withTx(pool, async (client) => {
    const tape = (
      await client.query<LosslessTurnTapeHeaderRow>(
        READ_TAPE_HEADER_FOR_UPDATE_SQL,
        [request.sessionId, userId, request.tapeId],
      )
    ).rows[0];
    if (!tape || tape.finalized_at !== null) return null;
    if (!sameLosslessTurnTapeHeader(tape, request)) {
      throw new Error("lossless turn tape finalize header conflict");
    }
    if (tape.record_storage_format !== 2 && tape.record_storage_format !== 3) {
      throw new Error("lossless turn tape storage format is invalid");
    }
    if (tape.record_storage_format === 3 || !deps.lossless.isLosslessRuntimeBatchingEnabled()) {
      return tape.record_storage_format;
    }
    await client.query(
      "DELETE FROM client_session_turn_tape_model_records WHERE session_id=$1 AND user_id=$2 AND tape_id=$3",
      [request.sessionId, userId, request.tapeId],
    );
    await client.query(
      "DELETE FROM client_session_turn_tape_records WHERE session_id=$1 AND user_id=$2 AND tape_id=$3",
      [request.sessionId, userId, request.tapeId],
    );
    await client.query(
      "UPDATE client_session_turn_tapes SET record_storage_format=3 WHERE session_id=$1 AND user_id=$2 AND tape_id=$3",
      [request.sessionId, userId, request.tapeId],
    );
    return 3;
  });
}
