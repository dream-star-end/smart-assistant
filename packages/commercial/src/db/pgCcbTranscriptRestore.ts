import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CcbNativeTranscriptArchive, CcbNativeRestoreTape, CcbTranscriptRestoreBinding } from "@openclaude/protocol";
import type { MessageLike, HydratedTapeRow, HydratedRuntimeBatchDescriptor } from "./pgSessionsBackend.js";
const sha256Bytes = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** SELECT-only raw continuity reader. The public visible_payload view is
 * intentionally unsuitable: it removes opaque signatures and native envelopes. */
export async function readCcbNativeRestoreArchiveFromDb(
  pool: Pool | PoolClient,
  owner: string,
  binding: CcbTranscriptRestoreBinding,
  hydrate: (row: HydratedTapeRow) => { messages: MessageLike[]; descriptor?: HydratedRuntimeBatchDescriptor },
): Promise<CcbNativeTranscriptArchive> {
  const fail = (): never => { throw new Error('CCB_TRANSCRIPT_ARCHIVE_INCOMPLETE'); };
  const seed = await pool.query<{ messages: unknown }>(
    "SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
    [binding.peerId, owner],
  );
  if (seed.rows.length !== 1) return fail();
  const archived = await pool.query<{ messages: unknown }>(
    `SELECT ch.messages FROM client_session_archive_chunks ch
      JOIN client_sessions s ON s.id=ch.session_id AND s.user_id=$2 AND s.deleted_at IS NULL
     WHERE ch.session_id=$1 AND ch.user_id=$2 ORDER BY ch.first_seq`, [binding.peerId, owner],
  );
  const parse = (value: unknown): MessageLike[] => {
    const entries = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(entries) || entries.some(x => !x || typeof x !== 'object' || Array.isArray(x))) return fail();
    return entries as MessageLike[];
  };
  const sourceMessages = [...archived.rows.flatMap(row => parse(row.messages)), ...parse(seed.rows[0]!.messages)];
  const anchors = new Map<string, MessageLike>();
  const inputs = new Map<string, MessageLike>();
  for (const message of sourceMessages) {
    if (message.role === 'user' && typeof message.id === 'string') inputs.set(message.id, message);
    if (message._turnTapeComplete === true && typeof message._turnTapeId === 'string') {
      const prior = anchors.get(message._turnTapeId);
      if (prior && (prior._turnTapeSha256 !== message._turnTapeSha256
        || prior._turnTapeRuntimeManifestSha256 !== message._turnTapeRuntimeManifestSha256)) return fail();
      anchors.set(message._turnTapeId, message);
    }
  }
  type RestoreHeader = {
    tape_id: string; tape_sha256: string; physical_count: number; logical_count: number;
    client_message_id: string | null; payload_bytes: string; agent_id: string;
    turn_index: number; created_at: string; status: string; turn_key: string;
    finalized_at: string | null; materialization_status: string | null;
    billing_anchor_id: string | null; dispatch_id: string | null; attempt_no: number | null;
    own_client_message_id: string | null; waive_reason: string | null;
    dispatch_status: string | null; dispatch_outcome: string | null;
  };
  const headers = await pool.query<RestoreHeader>(
    `SELECT t.tape_id,t.tape_sha256,t.physical_record_count AS physical_count,
             t.logical_record_count AS logical_count,t.record_payload_bytes::text AS payload_bytes,
             COALESCE(t.client_message_id,d.client_message_id) AS client_message_id,
             t.agent_id,t.turn_index,t.created_at::text,t.status,t.turn_key,t.finalized_at::text,
             t.materialization_status,t.billing_anchor_id,t.dispatch_id,t.attempt_no,t.waive_reason,
             t.client_message_id AS own_client_message_id,d.status AS dispatch_status,d.outcome AS dispatch_outcome
        FROM client_session_turn_tapes t
        JOIN client_sessions s ON s.id=t.session_id AND s.user_id=t.user_id AND s.deleted_at IS NULL
        LEFT JOIN turn_dispatches d ON d.dispatch_id=t.dispatch_id
          AND t.user_id=('c:' || d.user_id::text) AND d.session_id=t.session_id AND d.agent_id=t.agent_id
       WHERE t.session_id=$1 AND t.user_id=$2 AND t.agent_id=$3 AND t.finalized_at IS NOT NULL`,
    [binding.peerId, owner, binding.agentId]);
  const byTapeId = new Map(headers.rows.map(row => [row.tape_id, row]));
  const links = await pool.query<{
    source_tape_id: string; recovery_tape_id: string; source_tape_sha256: string;
    recovery_tape_sha256: string; source_turn_key: string; recovery_turn_key: string;
  }>(`SELECT l.source_tape_id,l.recovery_tape_id,l.source_tape_sha256,l.recovery_tape_sha256,
             l.source_turn_key,l.recovery_turn_key
        FROM turn_tape_recovery_links l JOIN client_session_turn_tapes s
          ON s.tape_id=l.source_tape_id AND s.session_id=l.session_id AND s.user_id=l.user_id
       WHERE l.session_id=$1 AND l.user_id=$2 AND s.agent_id=$3`, [binding.peerId, owner, binding.agentId]);
  const replaced = new Set<string>();
  const originalInputs = new Map<string, string>();
  const linked = new Set<string>();
  for (const link of links.rows) {
    const source = byTapeId.get(link.source_tape_id);
    const recovery = byTapeId.get(link.recovery_tape_id);
    // A pending recovery must not hide the finalized source.
    if (!recovery || recovery.materialization_status !== 'complete') continue;
    if (!source || linked.has(source.tape_id) || linked.has(recovery.tape_id)
      || source.tape_sha256 !== link.source_tape_sha256 || recovery.tape_sha256 !== link.recovery_tape_sha256
      || source.turn_key !== link.source_turn_key || recovery.turn_key !== link.recovery_turn_key
      || source.agent_id !== recovery.agent_id || source.turn_index !== recovery.turn_index || source.created_at !== recovery.created_at
      || source.status !== 'crashed' || !source.dispatch_id || source.dispatch_status !== 'terminal' || source.dispatch_outcome !== 'crashed'
      || recovery.status !== 'completed' || recovery.dispatch_id !== null || recovery.own_client_message_id !== null
      || recovery.attempt_no !== null || recovery.waive_reason !== null || !source.billing_anchor_id
      || recovery.billing_anchor_id !== source.billing_anchor_id || !source.client_message_id) return fail();
    linked.add(source.tape_id); linked.add(recovery.tape_id);
    replaced.add(source.tape_id); originalInputs.set(recovery.tape_id, source.client_message_id);
  }
  const tapes: CcbNativeRestoreTape[] = [];
  let sawInit = false;
  for (const header of headers.rows) {
    if (replaced.has(header.tape_id) || header.materialization_status !== 'complete') continue;
    // Small SELECT per turn bounds the raw expansion to a single tape.
    const rows = await pool.query<HydratedTapeRow>(
      "SELECT r.tape_id,t.tape_sha256,r.msg_id,r.ordinal,r.role,r.content_sha256,r.payload, "
      + "NULL::text AS waive_reason,false AS waiver_applied,'0'::text AS cost_credits,NULL::jsonb AS delegate_costs "
      + "FROM client_session_turn_tape_records r JOIN client_session_turn_tapes t "
      + "ON t.tape_id=r.tape_id AND t.session_id=r.session_id AND t.user_id=r.user_id "
      + "WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=$3 ORDER BY r.ordinal", [binding.peerId, owner, header.tape_id]);
    if (rows.rows.length !== header.physical_count || header.physical_count < 1
      || rows.rows.reduce((n, row) => n + row.payload.length, 0) !== Number(header.payload_bytes)) return fail();
    const anchor = anchors.get(header.tape_id);
    const expanded: MessageLike[] = [];
    const descriptors: HydratedRuntimeBatchDescriptor[] = [];
    for (const row of rows.rows) {
      const result = hydrate(row);
      expanded.push(...result.messages);
      if (result.descriptor) descriptors.push(result.descriptor);
    }
    if (expanded.length !== header.logical_count) return fail();
    const native = expanded.filter(message => {
      const raw = message._runtimeEvent;
      return message._runtimeSource === 'ccb' && raw && typeof raw === 'object' && !Array.isArray(raw)
        && (raw as Record<string, unknown>).session_id === binding.nativeSessionId
        && (raw as Record<string, unknown>).parent_tool_use_id == null;
    });
    if (native.length === 0) continue;
    if (!anchor || anchor._turnTapeSha256 !== header.tape_sha256
      || anchor._turnTapePhysicalRecordCount !== header.physical_count
      || anchor._turnTapeLogicalRecordCount !== header.logical_count) return fail();
    const expectedManifest = anchor._turnTapeRuntimeManifestSha256;
    if (descriptors.length > 0 && sha256Bytes(Buffer.from(JSON.stringify(descriptors))) !== expectedManifest) return fail();
    if (descriptors.length === 0 && expectedManifest !== undefined) return fail();
    const anchorSeq = anchor._orderSeq ?? anchor._seq;
    const inputId = originalInputs.get(header.tape_id) ?? header.client_message_id;
    if (!Number.isSafeInteger(anchorSeq) || Number(anchorSeq) < 0 || !inputId) return fail();
    let input = inputs.get(inputId);
    if (!input) return fail();
    if (input._userPayloadDeferred === true) {
      const deferred = await pool.query<{ payload: Buffer; content_sha256: string; payload_bytes: string }>(
        `SELECT p.payload,p.content_sha256,p.payload_bytes::text FROM client_session_user_payloads p
          JOIN client_sessions s ON s.id=p.session_id AND s.user_id=p.user_id AND s.deleted_at IS NULL
         WHERE p.session_id=$1 AND p.user_id=$2 AND p.msg_id=$3`,
        [binding.peerId, owner, inputId]);
      const row = deferred.rows[0];
      if (!row || deferred.rows.length !== 1 || row.payload.length !== Number(row.payload_bytes)
        || sha256Bytes(row.payload) !== row.content_sha256) return fail();
      input = JSON.parse(row.payload.toString('utf8')) as MessageLike;
      if (input.id !== inputId || input.role !== 'user') return fail();
    }
    const modelText = input._modelText ?? input.text;
    if (typeof modelText !== 'string') return fail();
    const records: CcbNativeRestoreTape['records'] = [];
    for (const message of native) {
      const payload = message._runtimeEvent as Record<string, unknown>;
      if (payload.type === 'system' && payload.subtype === 'init') sawInit = true;
      if (payload.type !== 'assistant' && payload.type !== 'user'
        && !(payload.type === 'system' && payload.subtype === 'compact_boundary')) continue;
      if (!Number.isSafeInteger(message._ocEventOrdinal)) return fail();
      records.push({ ordinal: Number(message._ocEventOrdinal), payload, sha256: sha256Bytes(Buffer.from(JSON.stringify(payload))) });
    }
    if (records.some((record, index) => index > 0 && record.ordinal <= records[index - 1]!.ordinal)) return fail();
    tapes.push({ tapeId: header.tape_id, tapeSha256: header.tape_sha256, anchorSeq: Number(anchorSeq),
      physicalRecordCount: header.physical_count, logicalRecordCount: header.logical_count,
      ...(typeof expectedManifest === 'string' ? { runtimeManifestSha256: expectedManifest } : {}),
      canonicalInput: { id: inputId, modelText, sha256: sha256Bytes(Buffer.from(modelText)) }, records });
  }
  tapes.sort((a, b) => a.anchorSeq - b.anchorSeq);
  if (!sawInit || tapes.length === 0 || tapes.some((tape, i) => i > 0 && tape.anchorSeq === tapes[i - 1]!.anchorSeq)) return fail();
  return { version: 1, binding, tapes };
}
