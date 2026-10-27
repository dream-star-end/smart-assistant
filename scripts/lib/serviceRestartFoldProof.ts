// OCV5-646 incident proof, kept out of scripts/check-v5-box-incident-proofs.ts to keep it inside the
// file-size ratchet (same split as scripts/lib/boxRunCleanupProof.ts). The candidate's own sessions backend
// finalizes a boot-recovery SERVICE_RESTART tape over a dispatch that had streamed, and its own prune runs.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Db = { query: (sql: string, params?: unknown[]) => Promise<any> };
// biome-ignore lint/suspicious/noExplicitAny: the candidate backend is loaded dynamically
type Backend = any;

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}

/** INC-20261028-RESTART-LIVE-FOLD (t1134u): the user watched the answer and tool steps stream, a gateway restart
 * then staged the inbox-only SERVICE_RESTART tape (text ''), finalize projected the stream to tape and the hourly
 * prune deleted its frames — another browser hydrated an empty turn. The tape records now carry what the dispatch
 * streamed, and still do after the frames are pruned. */
export async function proveRestartTapeFold(candidate: string, tape: { version: number; partBytes: number },
  withBackend: (run: (backend: Backend, db: Db) => Promise<string>) => Promise<string>): Promise<string> {
  const frames = await import(pathToFileURL(join(candidate, "packages/commercial/src/db/liveTurnFrames.ts")).href);
  return withBackend(async (backend, db) => {
    const uid = 9n;
    const sessionUser = "c:9";
    const sessionId = "s-ocv5-646-restart";
    const clientMessageId = "cm-ocv5-646-restart";
    const sessionKey = `agent:main:webchat:dm:${sessionId}`;
    const admitted = await backend.admitUserTurn({ uid, sessionUserId: sessionUser, sessionId, clientMessageId,
      agentId: "main", model: "k3.1-pro", requestHash: "h".repeat(64), billingRequestId: `brq-${clientMessageId}`,
      dispatchId: randomUUID(), ownerId: "conn-A",
      message: { id: clientMessageId, role: "user", text: "怎么根治", ts: 1 } });
    if (admitted.kind !== "admitted") fail("RESTART_FOLD_NOT_ADMITTED");
    const dispatchId: string = admitted.dispatch.dispatchId;
    const blocks = [
      [{ kind: "text", text: "要根治，", messageId: "m1" }],
      [{ kind: "text", text: "必须同时处理远端终态证明。", messageId: "m1" }],
      [{ kind: "tool_use", blockId: "tu-1", toolName: "Bash", inputPreview: "ls" }],
      [{ kind: "tool_result", toolUseBlockId: "tu-1", toolName: "Bash", output: "a.ts" }],
    ];
    const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
    // the dispatch's own stream, as persistGatewayLiveFrame writes it (raw SQL: its debounced unit
    // checkpoint would outlive this proof's schema)
    const streamKey = `dispatch:${dispatchId}:1`;
    await db.query(`INSERT INTO client_session_live_streams
      (stream_key,session_id,user_id,client_message_id,dispatch_id,attempt_no,source,projection_source)
      VALUES ($1,$2,$3,$4,$5::uuid,1,'gateway','live')`, [streamKey, sessionId, sessionUser, clientMessageId, dispatchId]);
    for (const [index, frameBlocks] of blocks.entries()) {
      const payload = Buffer.from(JSON.stringify({ type: "outbound.message", sessionKey, frameSeq: index + 1,
        clientMessageId, peer: { id: sessionId, kind: "dm" }, blocks: frameBlocks }));
      await db.query(`INSERT INTO client_session_live_frames
        (stream_key,source,agent_container_id,session_key,frame_seq,payload,payload_sha256)
        VALUES ($1,'gateway',1,$2,$3,$4,$5)`, [streamKey, sessionKey, index + 1, payload, hash(payload)]);
    }
    // gateway buildSyntheticCrashedTapePayload, as boot recovery stages it
    const turnKey = hash(`ocv5-646:${sessionId}`);
    const canonical = Buffer.from(JSON.stringify({ agentId: "main", sessionId, turnIndex: 1, clientMessageId,
      status: "crashed", turnKey, createdAt: 1_793_102_341_000, text: "", errorCode: "SERVICE_RESTART",
      errorDetail: "任务因服务重启中断，此前已生成的过程已完整保留", dispatchId, attemptNo: 1 }), "utf8");
    const partCount = Math.ceil(canonical.length / tape.partBytes);
    const base = { protocolVersion: tape.version, sessionId, agentId: "main", turnIndex: 1, status: "crashed",
      turnKey, tapeId: hash(`proof-tape\0${turnKey}`), tapeSha256: hash(canonical), totalBytes: canonical.length,
      partCount, createdAt: 1_793_102_341_000 };
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      const bytes = canonical.subarray(partIndex * tape.partBytes, (partIndex + 1) * tape.partBytes);
      await backend.stageLosslessTurnTapePart(sessionUser, { ...base, action: "part", partIndex,
        partSha256: hash(bytes), payloadBytes: bytes.length, data: bytes.toString("base64") }, bytes,
      { dispatchId, attemptNo: 1 });
    }
    const finalized = await backend.finalizeLosslessTurnTape(sessionUser, { ...base, action: "finalize" });
    if (finalized.applied !== "finalized") fail(`RESTART_FOLD_FINALIZE_${String(finalized.applied)}`);
    await frames.pruneProjectedLiveFrames(db, { batchSize: 100 });
    const left = await db.query(`SELECT COUNT(*)::int AS n FROM client_session_live_frames f
      JOIN client_session_live_streams s ON s.stream_key=f.stream_key WHERE s.session_id=$1`, [sessionId]);
    if (left.rows[0].n !== 0) fail("RESTART_FOLD_FRAMES_NOT_PRUNED");
    const timeline = await backend.getClientSession(sessionId, sessionUser, { view: "timeline" });
    const rows = (timeline?.messages ?? []) as Array<Record<string, unknown>>;
    const answer = rows.find((row) => row.role === "assistant" && row._errorCode === "SERVICE_RESTART");
    if (answer?.text !== "要根治，必须同时处理远端终态证明。") fail(`RESTART_FOLD_ANSWER_LOST_${JSON.stringify(answer?.text)}`);
    if (!rows.some((row) => row.role === "tool" && row.output === "a.ts")) fail("RESTART_FOLD_TOOL_LOST");
    return "[ocv5-646-restart-tape-fold] PASS — a boot-recovery SERVICE_RESTART tape keeps the answer and tool steps the dispatch streamed, after its live frames are pruned";
  });
}
