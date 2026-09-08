import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { LOSSLESS_TURN_TAPE_VERSION } from "@openclaude/protocol";

const fixtureRoot = await mkdtemp(join(tmpdir(), "ocv5-180-r8-"));
const previousEnv = new Map(["HOME", "OPENCLAUDE_HOME", "TMPDIR"].map((key) => [key, process.env[key]]));
process.env.HOME = fixtureRoot;
process.env.OPENCLAUDE_HOME = join(fixtureRoot, ".openclaude");
process.env.TMPDIR = fixtureRoot;
await mkdir(process.env.OPENCLAUDE_HOME, { recursive: true });
after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const {
  _prepareLosslessTurnTapeOutsideLocks,
  createPgSessionsBackend,
  inspectLateDelegateContinuationAgainstRoot,
} = await import("../db/pgSessionsBackend.js");
const {
  canonicalAgentGroupFingerprint,
  canonicalPublishedAgentGroupRecordFingerprint,
  materializeLosslessTurn,
  materializeRootDomainAgentGroupRecord,
} = await import("../http/losslessTurnTape.js");
const { makeServerAuthoredHandler } = await import("../http/internalServerAuthored.js");
const {
  attemptSend,
  buildLosslessTurnTapeRequests,
  iterateLosslessTurnTapeParts,
  makeV3MasterSink,
} = await import("../../../gateway/src/v3MasterSink.js");
type V3MasterSinkWirePayload = import("../../../gateway/src/v3MasterSink.js").V3MasterSinkWirePayload;
const { makeV3MasterRetryQueue } = await import("../../../gateway/src/v3MasterRetryQueue.js");

const USER_ID = "c:1";
const SESSION_ID = "web-late-root";
const OTHER_USER = "c:9";
const OWNER_TURN = "b".repeat(64);
const CONT_TURN = "c".repeat(64);
const ROOT_TAPE = "tape-root-owner";
const LATE_TAPE = "tape-late-cont";
const ORDINARY_TAPE = "tape-ordinary-root";
const LATE_AGENT = "late_0123456789abcdef01234567";
const CREATED_AT = 1_783_945_000_000;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function billing() {
  return {
    requestId: "d".repeat(32),
    engineSessionId: `oceng-${"e".repeat(48)}`,
    status: "success" as const,
    durationMs: 42,
    turnKey: OWNER_TURN,
    parentTurnKey: OWNER_TURN,
    parentSessionId: SESSION_ID,
    delegateAgentId: "coding-assistant",
    usage: { input_tokens: 3, output_tokens: 4 },
  };
}

function group(over: Record<string, unknown> = {}) {
  return {
    runId: "dlg-late-1",
    agentId: "coding-assistant",
    goal: "晚到子任务",
    status: "ok" as const,
    completedAt: CREATED_AT + 1,
    engineBillings: [billing()],
    ...over,
  };
}

function rootBody(groups = [group()]) {
  return {
    sessionId: SESSION_ID,
    agentId: "main",
    turnIndex: 1,
    status: "completed" as const,
    turnKey: OWNER_TURN,
    text: "root answer",
    createdAt: CREATED_AT,
    agentGroups: groups,
  };
}

function continuationBody(groups = [group()]) {
  return {
    sessionId: SESSION_ID,
    agentId: LATE_AGENT,
    turnIndex: 1,
    status: "completed" as const,
    turnKey: CONT_TURN,
    continuationOfTurnKey: OWNER_TURN,
    text: "",
    createdAt: CREATED_AT + 1,
    agentGroups: groups,
  };
}

function partOf(body: object) {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  return { buf, sha: sha256(buf), bytes: buf.length };
}

function publishedRecords(body: ReturnType<typeof rootBody>) {
  return materializeLosslessTurn(body).records.map((item, ordinal) => ({
    part_index: ordinal,
    ordinal,
    msg_id: item.id,
    role: item.role,
    content_sha256: item.payloadSha256,
    payload: item.payloadBytes,
  }));
}

type Script = {
  rootUnready?: boolean;
  rootMissing?: boolean;
  recordsIncomplete?: boolean;
  rootGroups?: ReturnType<typeof group>[];
  lateParts?: Buffer;
  rootLookupError?: Error;
  rootHeader?: {
    agentId?: string;
    turnIndex?: number;
    status?: string;
    turnKey?: string;
  };
};

function assembledFullPayloadSql(sql: string): boolean {
  return sql.includes("FROM client_session_turn_tape_parts")
    && sql.includes("ORDER BY part_index")
    && !sql.includes("octet_length")
    && /\bpayload\b/.test(sql);
}

function fakePool(script: Script) {
  const sqls: string[] = [];
  const late = partOf(continuationBody());
  const lateParts = script.lateParts ?? late.buf;
  const lateSha = sha256(lateParts);
  const rootSource = rootBody(script.rootGroups ?? [group()]);
  const root = partOf(rootSource);
  const records = publishedRecords(rootSource);
  const query = async (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    if (/^BEGIN/i.test(sql) || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL") || sql.includes("pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("continuation_of_turn_key IS NULL")) {
      if (script.rootLookupError) throw script.rootLookupError;
      if (String(params[0]) !== SESSION_ID || String(params[1]) !== USER_ID) return { rows: [] };
      if (script.rootMissing) return { rows: [] };
      return {
        rows: [{
          tape_id: ROOT_TAPE,
          tape_sha256: root.sha,
          total_bytes: String(root.bytes),
          part_count: 1,
          finalized_at: script.rootUnready ? null : "1",
          visible_at: script.rootUnready ? null : "1",
          agent_id: script.rootHeader?.agentId ?? "main",
          turn_index: script.rootHeader?.turnIndex ?? 1,
          status: script.rootHeader?.status ?? "completed",
          turn_key: script.rootHeader?.turnKey ?? OWNER_TURN,
          created_at: String(CREATED_AT),
          physical_record_count: String(script.recordsIncomplete ? records.length + 4 : records.length),
          materialization_status: script.rootUnready ? "pending" : "complete",
        }],
      };
    }
    if (sql.includes("FILTER (WHERE msg_id NOT LIKE") && sql.includes("client_session_turn_tape_records")) {
      const prefix = String(params[3] ?? "");
      const off = records.filter((row) => !row.msg_id.startsWith(prefix.slice(0, -1))).length;
      return { rows: [{ total: String(records.length), off_prefix: String(off) }] };
    }
    if (sql.includes("msg_id = ANY") && sql.includes("client_session_turn_tape_records")) {
      const wanted = new Set((params[3] as string[]) ?? []);
      return { rows: records.filter((row) => wanted.has(row.msg_id)) };
    }
    if (sql.includes("octet_length(payload)")) {
      const tapeId = String(params[2]);
      if (tapeId === ROOT_TAPE) return { rows: [] };
      const buf = tapeId === ORDINARY_TAPE ? root.buf : lateParts;
      return { rows: [{ part_index: 0, part_sha256: sha256(buf), payload_bytes: String(buf.length) }] };
    }
    if (sql.includes("FROM client_session_turn_tape_parts")) {
      const tapeId = String(params[2]);
      if (tapeId === ROOT_TAPE) return { rows: [] };
      const buf = tapeId === ORDINARY_TAPE ? root.buf : lateParts;
      if (sql.includes("part_index=$4") || sql.includes("AND part_index=")) {
        return { rows: [{ part_sha256: sha256(buf), payload: buf }] };
      }
      return { rows: [{ part_index: 0, part_sha256: sha256(buf), payload: buf }] };
    }
    if (sql.includes("FROM client_session_turn_tapes")) {
      const tapeId = String(params[2]);
      if (tapeId === ORDINARY_TAPE) {
        return {
          rows: [{
            agent_id: "main",
            turn_index: 1,
            status: "completed",
            turn_key: OWNER_TURN,
            tape_sha256: root.sha,
            total_bytes: String(root.bytes),
            part_count: 1,
            created_at: String(CREATED_AT),
            waive_reason: null,
            finalized_at: null,
            visible_at: null,
            record_storage_format: 2,
            engine_billings: null,
            billing_anchor_id: null,
            settlement_hash: null,
            dispatch_id: null,
            attempt_no: null,
            visible_head: null,
          }],
        };
      }
      return {
        rows: [{
          agent_id: LATE_AGENT,
          turn_index: 1,
          status: "completed",
          turn_key: CONT_TURN,
          tape_sha256: lateSha,
          total_bytes: String(lateParts.length),
          part_count: 1,
          created_at: String(CREATED_AT + 1),
          waive_reason: null,
          finalized_at: null,
          visible_at: null,
          record_storage_format: 2,
          engine_billings: null,
          billing_anchor_id: null,
          settlement_hash: null,
          dispatch_id: null,
          attempt_no: null,
          visible_head: null,
        }],
      };
    }
    if (sql.includes("FROM client_sessions")) {
      return { rows: [], rowCount: 0 };
    }
    if (/^\s*SELECT/i.test(sql) || sql.includes("WITH ") || sql.startsWith("INSERT") || sql.startsWith("UPDATE") || sql.startsWith("DELETE")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const client = { query, release() {} };
  return {
    pool: { query, connect: async () => client } as unknown as Pool,
    sqls,
    records,
    lateRequest: {
      protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
      action: "finalize" as const,
      sessionId: SESSION_ID,
      agentId: LATE_AGENT,
      turnIndex: 1,
      status: "completed" as const,
      turnKey: CONT_TURN,
      tapeId: LATE_TAPE,
      tapeSha256: lateSha,
      totalBytes: lateParts.length,
      partCount: 1,
      createdAt: CREATED_AT + 1,
    },
    ordinaryRequest: {
      protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
      action: "finalize" as const,
      sessionId: SESSION_ID,
      agentId: "main",
      turnIndex: 1,
      status: "completed" as const,
      turnKey: OWNER_TURN,
      tapeId: ORDINARY_TAPE,
      tapeSha256: root.sha,
      totalBytes: root.bytes,
      partCount: 1,
      createdAt: CREATED_AT,
    },
  };
}

describe("OCV5-180 B1 R8 master root authority", () => {
  test("fingerprint changes when transcript/status change and ignores ordinal", () => {
    const base = group();
    const a = canonicalAgentGroupFingerprint(base);
    assert.notEqual(a, canonicalAgentGroupFingerprint({ ...base, transcript: [{ kind: "text", text: "B" }] }));
    assert.notEqual(a, canonicalAgentGroupFingerprint({ ...base, status: "failed" }));
    assert.equal(a, canonicalAgentGroupFingerprint({ ...base, _ocEventOrdinal: 9 }));
    const published = materializeRootDomainAgentGroupRecord(base as Record<string, unknown>, {
      sessionId: SESSION_ID,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey: OWNER_TURN,
      createdAt: CREATED_AT,
    });
    assert.equal(published._delegateStatus, "ok");
    assert.equal(
      canonicalPublishedAgentGroupRecordFingerprint(published),
      canonicalPublishedAgentGroupRecordFingerprint({ ...published, _ocEventOrdinal: 3, _recordOrdinal: 9 }),
    );
  });

  test("inspect: same published records are idempotent; different content conflicts; parts stay deleted", async () => {
    const same = fakePool({});
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(same.pool, USER_ID, same.lateRequest),
      "idempotent",
    );
    assert.equal(same.records.length > 0, true);
    assert.equal(
      same.sqls.some((sql) => sql.includes("FROM client_session_turn_tape_records")),
      true,
    );
    assert.equal(
      same.sqls.filter(assembledFullPayloadSql).length,
      1,
      "continuation parts may assemble; owner parts must not",
    );
    const conflict = fakePool({ rootGroups: [group({ resultSummary: "other" })] });
    await assert.rejects(
      () => inspectLateDelegateContinuationAgainstRoot(conflict.pool, USER_ID, conflict.lateRequest),
      (err: unknown) => Boolean(err && typeof err === "object" && (err as { immutableConflict?: boolean }).immutableConflict),
    );
  });

  test("inspect: missing root, incomplete records, or lookup EIO are retryable", async () => {
    const missing = fakePool({ rootMissing: true });
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(missing.pool, USER_ID, missing.lateRequest),
      "retry",
    );
    const incomplete = fakePool({ recordsIncomplete: true });
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(incomplete.pool, USER_ID, incomplete.lateRequest),
      "retry",
    );
    const eio = fakePool({
      rootLookupError: Object.assign(new Error("EIO"), { code: "EIO" }),
    });
    await assert.rejects(
      () => inspectLateDelegateContinuationAgainstRoot(eio.pool, USER_ID, eio.lateRequest),
      (err: unknown) => Boolean(err && typeof err === "object" && (err as { retryable?: boolean }).retryable),
    );
  });

  test("inspect: ready root without the run proceeds; other user retry; envelope session mismatch rejects", async () => {
    const empty = fakePool({ rootGroups: [] });
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(empty.pool, USER_ID, empty.lateRequest),
      "proceed",
    );
    const crossUser = fakePool({});
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(crossUser.pool, OTHER_USER, crossUser.lateRequest),
      "retry",
    );
    const crossSession = fakePool({});
    await assert.rejects(
      () => inspectLateDelegateContinuationAgainstRoot(crossSession.pool, USER_ID, {
        ...crossSession.lateRequest,
        sessionId: "web-other-session",
      }),
      /identity mismatch|conflict/,
    );
  });

  test("prepare skips materialize when root already has the same run", async () => {
    const same = fakePool({});
    await assert.rejects(
      () => _prepareLosslessTurnTapeOutsideLocks(same.pool, USER_ID, same.lateRequest, 2),
      (err: unknown) => Boolean(
        err && typeof err === "object" && (err as { lateDelegateRootIdempotent?: boolean }).lateDelegateRootIdempotent,
      ),
    );
  });

  test("finalize HTTP path is idempotent and does not run Phase A visible publish", async () => {
    const same = fakePool({});
    const backend = createPgSessionsBackend(same.pool, { expectedGeneration: 0 });
    const result = await backend.finalizeLosslessTurnTape(USER_ID, same.lateRequest, { materialize: false });
    assert.equal(result.applied, "idempotent");
    if (result.applied === "idempotent") {
      assert.deepEqual(result.engineBillings, []);
      assert.equal(result.recordCount, 0);
    }
    assert.equal(
      same.sqls.some((sql) => sql.includes("SET visible_at")),
      false,
      "idempotent ACK must not publish a second visible card",
    );
  });

  test("finalize retries when owner records are incomplete, not when parts were legally deleted", async () => {
    const missing = fakePool({ rootMissing: true });
    const backend = createPgSessionsBackend(missing.pool, { expectedGeneration: 0 });
    const result = await backend.finalizeLosslessTurnTape(USER_ID, missing.lateRequest, { materialize: false });
    assert.equal(result.applied, "incomplete");
    const purged = fakePool({});
    const ready = await createPgSessionsBackend(purged.pool, { expectedGeneration: 0 }).finalizeLosslessTurnTape(
      USER_ID,
      purged.lateRequest,
      { materialize: false },
    );
    assert.equal(ready.applied, "idempotent");
  });

  test("finalize conflicts when root run content differs", async () => {
    const conflict = fakePool({ rootGroups: [group({ resultSummary: "other" })] });
    const backend = createPgSessionsBackend(conflict.pool, { expectedGeneration: 0 });
    await assert.rejects(
      () => backend.finalizeLosslessTurnTape(USER_ID, conflict.lateRequest, { materialize: false }),
      (err: unknown) => Boolean(err && typeof err === "object" && (err as { immutableConflict?: boolean }).immutableConflict),
    );
  });

  test("leader: same run cannot ACK before the root is durable and visible", async () => {
    const p = fakePool({ rootUnready: true });
    const result = await createPgSessionsBackend(p.pool, { expectedGeneration: 0 }).finalizeLosslessTurnTape(USER_ID, p.lateRequest, { materialize: false });
    assert.equal(result.applied, "incomplete", "parts alone are not a completed owner root");
    assert.equal(
      p.sqls.some((sql) => sql.includes("client_session_turn_tape_records")),
      false,
      "unready root must not read published records",
    );
  });

  test("leader: idempotent root hit must not bypass payload/envelope locator check", async () => {
    const p = fakePool({ lateParts: partOf({ ...continuationBody(), turnIndex: 2 }).buf });
    await assert.rejects(
      () => createPgSessionsBackend(p.pool, { expectedGeneration: 0 }).finalizeLosslessTurnTape(USER_ID, p.lateRequest, { materialize: false }),
      /identity mismatch|conflict/,
    );
    assert.equal(
      p.sqls.some((sql) => sql.includes("continuation_of_turn_key IS NULL")),
      false,
      "identity mismatch must run before owner-root lookup or ACK",
    );
  });

  test("inspect: unready root is retry; header/record identity mismatch is retry", async () => {
    const unready = fakePool({ rootUnready: true });
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(unready.pool, USER_ID, unready.lateRequest),
      "retry",
    );
    const headerMismatch = fakePool({ rootHeader: { turnIndex: 9 } });
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(headerMismatch.pool, USER_ID, headerMismatch.lateRequest),
      "retry",
    );
  });

  test("ordinary root finalize does not extra-read all parts before admission", async () => {
    const p = fakePool({});
    const backend = createPgSessionsBackend(p.pool, { expectedGeneration: 0 });
    const result = await backend.finalizeLosslessTurnTape(USER_ID, p.ordinaryRequest, { materialize: false });
    assert.notEqual(result.applied, undefined);
    assert.equal(
      p.sqls.some(assembledFullPayloadSql),
      false,
      "ordinary root must not ungated full-read tape parts",
    );
    assert.equal(
      p.sqls.some((sql) => sql.includes("continuation_of_turn_key IS NULL")),
      false,
      "ordinary root must not inspect owner-root authority",
    );
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(p.pool, USER_ID, p.ordinaryRequest),
      "proceed",
    );
    assert.equal(
      p.sqls.filter(assembledFullPayloadSql).length,
      0,
      "inspect cheap-gate must skip assemble for non-late_ agents",
    );
  });
});

type TapeHeader = {
  tape_id: string;
  agent_id: string;
  turn_index: number;
  status: string;
  turn_key: string;
  tape_sha256: string;
  total_bytes: string;
  part_count: number;
  created_at: string;
  waive_reason: string | null;
  finalized_at: string | null;
  visible_at: string | null;
  dispatch_id: string | null;
  attempt_no: number | null;
  record_storage_format: number;
  continuation_of_turn_key: string | null;
  physical_record_count: string | null;
  materialization_status: string | null;
  engine_billings: unknown;
  billing_anchor_id: string | null;
  settlement_hash: string | null;
  visible_head: unknown;
  client_message_id: string | null;
};

function headerFromFinalize(e: {
  tapeId: string;
  agentId: string;
  turnIndex: number;
  status: string;
  turnKey: string;
  tapeSha256: string;
  totalBytes: number;
  partCount: number;
  createdAt: number;
  waiveReason?: string;
}): TapeHeader {
  return {
    tape_id: e.tapeId,
    agent_id: e.agentId,
    turn_index: e.turnIndex,
    status: e.status,
    turn_key: e.turnKey,
    tape_sha256: e.tapeSha256,
    total_bytes: String(e.totalBytes),
    part_count: e.partCount,
    created_at: String(e.createdAt),
    waive_reason: e.waiveReason ?? null,
    finalized_at: null,
    visible_at: null,
    dispatch_id: null,
    attempt_no: null,
    record_storage_format: 2,
    continuation_of_turn_key: null,
    physical_record_count: null,
    materialization_status: null,
    engine_billings: null,
    billing_anchor_id: null,
    settlement_hash: null,
    visible_head: null,
    client_message_id: null,
  };
}

async function productionPath(opts: {
  hasRun?: boolean;
  unready?: boolean;
  lookupEio?: boolean;
  conflict?: boolean;
  rootCmid?: string;
  headerCmid?: string;
  lateGroup?: Record<string, unknown>;
}) {
  const sid = "audit-root-session";
  const uid = USER_ID;
  const ownerTurn = "a".repeat(64);
  const g = {
    runId: "audit-logical-run",
    agentId: "child",
    goal: "synthetic late task",
    status: "ok" as const,
    completedAt: 1_700_000_000_001,
    transcript: [{ kind: "text", text: "x".repeat(1_100_000) }],
  };
  const rootGroups = opts.conflict
    ? [{ ...g, resultSummary: "other" }]
    : opts.hasRun === false ? [] : [g];
  const rootPayload = {
    sessionId: sid,
    agentId: "main",
    turnIndex: 1,
    status: "completed" as const,
    turnKey: ownerTurn,
    text: "root",
    createdAt: 1_700_000_000_000,
    agentGroups: rootGroups,
    ...(opts.rootCmid ? { clientMessageId: opts.rootCmid } : {}),
  };
  const late = {
    sessionId: sid,
    agentId: `late_${"b".repeat(24)}`,
    turnIndex: 1,
    status: "completed" as const,
    turnKey: "c".repeat(64),
    continuationOfTurnKey: ownerTurn,
    createdAt: 1_700_000_000_001,
    text: "",
    agentGroups: [{ ...g, ...opts.lateGroup }],
  };
  const rt = buildLosslessTurnTapeRequests(rootPayload);
  const persistedRecords = materializeLosslessTurn(rootPayload).records;
  const rh: TapeHeader = {
    ...headerFromFinalize(rt.finalize),
    finalized_at: opts.unready ? null : "1700000000010",
    visible_at: opts.unready ? null : "1700000000009",
    physical_record_count: String(persistedRecords.length),
    materialization_status: opts.unready ? "pending" : "complete",
    client_message_id: opts.headerCmid ?? opts.rootCmid ?? null,
  };
  const headers = new Map<string, TapeHeader>([[rt.finalize.tapeId, rh]]);
  const parts = new Map<string, Array<{ part_index: number; part_sha256: string; payload: Buffer }>>();
  parts.set(rt.finalize.tapeId, []);
  const records = new Map(persistedRecords.map((item) => [item.id, {
    msg_id: item.id,
    role: item.role,
    content_sha256: item.payloadSha256,
    payload: item.payloadBytes,
  }]));
  const session = {
    messages: "[]",
    next_seq: 1,
    deleted_at: null as string | null,
    archived_through_seq: "0",
    archived_count: "0",
  };
  let rootPartsReads = 0;
  let recordReads = 0;
  let unknown = 0;
  let visibleWrites = 0;
  let materializationWrites = 0;
  const sqlLog: string[] = [];
  let eio = Boolean(opts.lookupEio);
  const statuses: Array<{ action: string; status: number }> = [];
  const actions: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    const s = sql.trim().replace(/\s+/g, " ");
    sqlLog.push(s);
    if (/^(BEGIN|COMMIT|ROLLBACK|SET )/i.test(s) || s.includes("pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes("FROM client_sessions") && s.includes("deleted_at") && !s.includes("messages")) {
      assert.deepEqual(params.slice(0, 2), [sid, uid]);
      return { rows: [{ deleted_at: session.deleted_at }], rowCount: 1 };
    }
    if (s.includes("FROM client_sessions") && s.includes("messages")) {
      return {
        rows: [{
          messages: session.messages,
          next_seq: session.next_seq,
          deleted_at: session.deleted_at,
          archived_through_seq: session.archived_through_seq,
          archived_count: session.archived_count,
        }],
        rowCount: 1,
      };
    }
    if (s.startsWith("UPDATE client_sessions")) {
      if (typeof params[0] === "string") session.messages = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("continuation_of_turn_key IS NULL")) {
      assert.deepEqual(params, [sid, uid, ownerTurn]);
      if (eio) throw Object.assign(new Error("controlled root EIO"), { code: "EIO" });
      return { rows: [rh] };
    }
    if (s.startsWith("INSERT INTO client_session_turn_tapes")) {
      const tape = String(params[2]);
      if (!headers.has(tape)) {
        headers.set(tape, headerFromFinalize({
          tapeId: tape,
          agentId: String(params[3]),
          turnIndex: Number(params[4]),
          status: String(params[5]),
          turnKey: String(params[6]),
          tapeSha256: String(params[7]),
          totalBytes: Number(params[8]),
          partCount: Number(params[9]),
          createdAt: Number(params[10]),
        }));
      }
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("UPDATE client_session_turn_tapes") && s.includes("visible_at")) {
      assert.deepEqual(params.slice(6, 8), [sid, uid]);
      const tape = headers.get(String(params[8]));
      assert.ok(tape);
      tape.visible_at = String(params[0]);
      tape.visible_head = JSON.parse(String(params[1]));
      visibleWrites += 1;
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("FROM client_session_turn_tapes")) {
      const h = headers.get(String(params[2]));
      return { rows: h ? [h] : [] };
    }
    if (s.startsWith("INSERT INTO client_session_turn_tape_parts")) {
      const list = parts.get(String(params[2])) ?? [];
      list.push({ part_index: Number(params[3]), part_sha256: String(params[4]), payload: params[5] as Buffer });
      list.sort((a, b) => a.part_index - b.part_index);
      parts.set(String(params[2]), list);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("FROM client_session_turn_tape_parts")) {
      const tapeId = String(params[2]);
      if (tapeId === rt.finalize.tapeId) rootPartsReads += 1;
      let found = parts.get(tapeId) ?? [];
      if (params.length >= 4 && typeof params[3] === "number") {
        found = found.filter((part) => part.part_index === params[3]);
      }
      return {
        rows: found.map((part) => s.includes("octet_length")
          ? { part_index: part.part_index, part_sha256: part.part_sha256, payload_bytes: String(part.payload.length) }
          : part),
      };
    }
    if (s.includes("FILTER (WHERE msg_id NOT LIKE") && s.includes("client_session_turn_tape_records")) {
      recordReads += 1;
      const prefix = String(params[3] ?? "").replace(/%$/, "");
      const all = [...records.values()];
      return {
        rows: [{
          total: String(all.length),
          off_prefix: String(all.filter((row) => !row.msg_id.startsWith(prefix)).length),
        }],
      };
    }
    if (s.includes("msg_id = ANY") && s.includes("client_session_turn_tape_records")) {
      recordReads += 1;
      const wanted = new Set((params[3] as string[]) ?? []);
      return { rows: [...records.values()].filter((row) => wanted.has(row.msg_id)) };
    }
    if (s.startsWith("INSERT INTO turn_tape_materialization_jobs")) {
      assert.deepEqual(params.slice(0, 2), [sid, uid]);
      materializationWrites += 1;
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("turn_tape_materialization_jobs") || s.includes("turn_tape_settlement_jobs")) {
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("turn_dispatches") || s.includes("live_streams") || s.includes("live_frames") || s.includes("archive")) {
      return { rows: [] };
    }
    unknown += 1;
    throw new Error(`UNEXPECTED SQL ${s}`);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const backend = createPgSessionsBackend(pool, { expectedGeneration: 0 });
  const logger = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {} };
  const handler = makeServerAuthoredHandler({
    identityRepo: { findActiveByHostAndBoundIp: async () => null } as never,
    verify: async () => ({ userId: 1, containerId: 7, boundIp: "127.0.0.1", hostUuid: "audit-host" }),
    storage: {} as never,
    losslessTurnTapeStorage: backend,
    logger: logger as never,
    metric() {},
    onTapeFinalized() {},
  });
  const cfg = { baseUrl: "http://audit.test", bearer: `oc-v3.7.${"d".repeat(64)}` };
  const fetcher = async (_url: string, opts: { body?: string }) => {
    const envelope = JSON.parse(String(opts.body)) as { action: string };
    actions.push(envelope.action);
    const req = Readable.from([Buffer.from(String(opts.body))]) as IncomingMessage;
    req.method = "POST";
    req.url = "/internal/v3/server-authored";
    req.headers = { authorization: `Bearer ${cfg.bearer}` };
    let body = "";
    let status = 200;
    let headersSent = false;
    const res = {
      get headersSent() { return headersSent; },
      setHeader() {},
      writeHead(code: number) { status = code; headersSent = true; },
      end(chunk?: string) { if (chunk) body += chunk; },
    } as unknown as ServerResponse;
    await handler(req, res, { hostUuid: "audit-host", boundIp: "127.0.0.1" });
    statuses.push({ action: envelope.action, status });
    return { statusCode: status, body: Readable.from([Buffer.from(body)]) };
  };
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "q-"));
  let auditNow = Date.now();
  const send = (payload: V3MasterSinkWirePayload) => attemptSend(payload, { config: cfg, fetcher: fetcher as never });
  const queue = makeV3MasterRetryQueue({ dir, attemptSend: send, now: () => auditNow });
  const sink = makeV3MasterSink({
    config: cfg,
    retryQueue: { ...queue, kick() {} },
    attemptSendImpl: send,
  });
  return {
    late,
    rt,
    persistedRecords,
    sink,
    queue,
    dir,
    statuses,
    actions,
    session,
    headers,
    sqlLog,
    advance() { auditNow += 600_000; },
    setEio(value: boolean) { eio = value; },
    setReady() {
      rh.finalized_at = "1700000000010";
      rh.visible_at = "1700000000009";
      rh.materialization_status = "complete";
    },
    stats: () => ({ rootPartsReads, recordReads, unknown, visibleWrites, materializationWrites }),
  };
}

describe("OCV5-180 B1 R8 post-finalize records authority via sink/HTTP/drain", () => {
  test("same run on purged-parts root ACKs 200 and drains", async () => {
    const f = await productionPath({ hasRun: true });
    assert.ok(f.rt.finalize.partCount >= 2);
    assert.ok(f.persistedRecords.length > 0);
    const outcome = await f.sink.persistOrQueue(f.late);
    assert.equal(outcome.ok, true, JSON.stringify(f.statuses));
    assert.equal(f.statuses.at(-1)?.status, 200);
    assert.equal((await readdir(f.dir)).filter((name) => name.endsWith(".json")).length, 0);
    assert.equal(f.stats().rootPartsReads, 0);
    assert.ok(f.stats().recordReads >= 1);
    assert.equal(f.stats().unknown, 0);
    assert.notEqual(f.actions[0], "visible");
  });

  test("no-run purged-parts root publishes Phase A and dequeues", async () => {
    const f = await productionPath({ hasRun: false });
    const outcome = await f.sink.persistOrQueue(f.late);
    assert.equal(outcome.ok, true, JSON.stringify(f.statuses));
    assert.equal(f.statuses.at(-1)?.status, 200);
    assert.equal((await readdir(f.dir)).filter((name) => name.endsWith(".json")).length, 0);
    assert.equal(f.stats().unknown, 0);
    assert.ok(f.stats().recordReads >= 1);
    const expected = buildLosslessTurnTapeRequests(f.late).finalize;
    const messages = JSON.parse(f.session.messages) as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?._turnTapeId, expected.tapeId);
    assert.equal(messages[0]?._turnTapeSha256, expected.tapeSha256);
    assert.ok(f.headers.get(expected.tapeId)?.visible_at);
    assert.ok(f.headers.get(expected.tapeId)?.visible_head);
    assert.equal(f.stats().visibleWrites, 1);
    assert.equal(f.stats().materializationWrites, 1);
    assert.equal(f.sqlLog.at(-1), "COMMIT");
  });

  test("root clientMessageId stamp ACKs the same run and real drain never quarantines", async () => {
    const f = await productionPath({ rootCmid: "m-audit-root-origin" });
    const outcome = await f.sink.persistOrQueue(f.late);
    assert.equal(outcome.ok, true, JSON.stringify(f.statuses));
    assert.equal(f.statuses.at(-1)?.status, 200);
    f.setEio(true);
    const queued = await f.sink.persistOrQueue(f.late);
    assert.equal(queued.ok === false && queued.queued, true);
    f.setEio(false);
    f.advance();
    const drained = await f.queue.drainOnce();
    assert.equal(drained.drained, 1);
    assert.equal(drained.fatalDropped, 0);
    assert.equal(await f.queue.pendingCount(), 0);
    assert.equal((await readdir(f.dir)).some((name) => name.includes("quarantine")), false);
    assert.equal(f.stats().visibleWrites, 0);
    assert.equal(f.stats().materializationWrites, 0);
    assert.equal(f.session.messages, "[]");
    assert.equal(f.stats().unknown, 0);
  });

  test("legacy unstamped root does not acquire a later header clientMessageId stamp", async () => {
    const f = await productionPath({ headerCmid: "m-later-dispatch-origin" });
    assert.equal((await f.sink.persistOrQueue(f.late)).ok, true, JSON.stringify(f.statuses));
    assert.equal(f.statuses.at(-1)?.status, 200);
    assert.equal(f.stats().visibleWrites, 0);
    assert.equal(f.stats().unknown, 0);
  });

  test("root header versus published origin mismatch is an immutable conflict", async () => {
    const f = await productionPath({ rootCmid: "m-audit-root-origin", headerCmid: "m-other-origin" });
    assert.equal((await f.sink.persistOrQueue(f.late)).ok, false);
    assert.equal(f.statuses.at(-1)?.status, 409);
    assert.equal(f.stats().unknown, 0);
  });

  test("late group cannot hide its conflicting origin under the trusted root stamp", async () => {
    const f = await productionPath({ rootCmid: "m-audit-root-origin", lateGroup: { _clientMessageId: "m-other-origin" } });
    assert.equal((await f.sink.persistOrQueue(f.late)).ok, false);
    assert.equal(f.statuses.at(-1)?.status, 409);
    assert.equal(f.stats().unknown, 0);
  });

  test("different published content is 409 fatal, not a durable retry loop", async () => {
    const f = await productionPath({ conflict: true });
    const outcome = await f.sink.persistOrQueue(f.late);
    assert.equal(outcome.ok, false);
    assert.equal(f.statuses.at(-1)?.status, 409);
    assert.equal(f.stats().unknown, 0);
  });

  test("unready root queues then drains after visible+finalized records appear", async () => {
    const f = await productionPath({ unready: true, hasRun: true });
    const first = await f.sink.persistOrQueue(f.late);
    assert.equal(first.ok, false, JSON.stringify(f.statuses));
    assert.equal(first.ok === false && first.queued, true);
    assert.equal(f.statuses.at(-1)?.status, 503);
    f.setReady();
    f.advance();
    const drained = await f.queue.drainOnce();
    assert.equal(drained.drained, 1);
    assert.equal(await f.queue.pendingCount(), 0);
    assert.equal(f.stats().unknown, 0);
  });

  test("EIO then restore published records drains the real queue", async () => {
    const f = await productionPath({ hasRun: true, lookupEio: true });
    const first = await f.sink.persistOrQueue(f.late);
    assert.equal(first.ok, false);
    assert.equal(first.ok === false && first.queued, true);
    f.setEio(false);
    f.advance();
    const drained = await f.queue.drainOnce();
    assert.equal(drained.drained, 1);
    assert.equal(await f.queue.pendingCount(), 0);
    assert.equal(f.stats().unknown, 0);
  });
});
