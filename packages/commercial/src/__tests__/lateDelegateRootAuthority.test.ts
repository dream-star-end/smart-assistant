import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import { LOSSLESS_TURN_TAPE_VERSION } from "@openclaude/protocol";
import {
  _prepareLosslessTurnTapeOutsideLocks,
  createPgSessionsBackend,
  inspectLateDelegateContinuationAgainstRoot,
} from "../db/pgSessionsBackend.js";
import { canonicalAgentGroupFingerprint } from "../http/losslessTurnTape.js";

const USER_ID = "c:1";
const SESSION_ID = "web-late-root";
const OTHER_USER = "c:9";
const OWNER_TURN = "b".repeat(64);
const CONT_TURN = "c".repeat(64);
const ROOT_TAPE = "tape-root-owner";
const LATE_TAPE = "tape-late-cont";
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
    agentId: "late_0123456789abcdef01234567",
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

type Script = {
  rootParts?: Buffer | null;
  lateParts?: Buffer;
  rootLookupError?: Error;
  userId?: string;
};

function fakePool(script: Script) {
  const sqls: string[] = [];
  const late = partOf(continuationBody());
  const lateParts = script.lateParts ?? late.buf;
  const lateSha = sha256(lateParts);
  const root = partOf(rootBody());
  const query = async (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    if (/^BEGIN/i.test(sql) || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("continuation_of_turn_key IS NULL")) {
      if (script.rootLookupError) throw script.rootLookupError;
      if (String(params[0]) !== SESSION_ID || String(params[1]) !== USER_ID) return { rows: [] };
      if (script.rootParts === null) return { rows: [] };
      return {
        rows: [{
          tape_id: ROOT_TAPE,
          tape_sha256: script.rootParts ? sha256(script.rootParts) : root.sha,
          total_bytes: String(script.rootParts ? script.rootParts.length : root.bytes),
          part_count: 1,
          finalized_at: "1",
          visible_at: "1",
        }],
      };
    }
    if (sql.includes("octet_length(payload)")) {
      const tapeId = String(params[2]);
      const buf = tapeId === ROOT_TAPE ? (script.rootParts ?? root.buf) : lateParts;
      if (tapeId === ROOT_TAPE && script.rootParts === null) return { rows: [] };
      return {
        rows: [{
          part_index: 0,
          part_sha256: sha256(buf),
          payload_bytes: String(buf.length),
        }],
      };
    }
    if (sql.includes("FROM client_session_turn_tape_parts")) {
      const tapeId = String(params[2]);
      if (tapeId === ROOT_TAPE) {
        if (script.rootParts === null) return { rows: [] };
        const buf = script.rootParts ?? root.buf;
        if (sql.includes("part_index=$4") || sql.includes("AND part_index=")) {
          return { rows: [{ part_sha256: sha256(buf), payload: buf }] };
        }
        return { rows: [{ part_index: 0, part_sha256: sha256(buf), payload: buf }] };
      }
      if (sql.includes("part_index=$4") || sql.includes("AND part_index=")) {
        return { rows: [{ part_sha256: sha256(lateParts), payload: lateParts }] };
      }
      return { rows: [{ part_index: 0, part_sha256: sha256(lateParts), payload: lateParts }] };
    }
    if (sql.includes("FROM client_session_turn_tapes")) {
      return {
        rows: [{
          agent_id: "late_0123456789abcdef01234567",
          turn_index: 1,
          status: "completed",
          turn_key: CONT_TURN,
          tape_sha256: lateSha,
          total_bytes: String(lateParts.length),
          part_count: 1,
          created_at: String(CREATED_AT + 1),
          waive_reason: null,
          finalized_at: null,
          record_storage_format: 2,
        }],
      };
    }
    if (/^\s*SELECT/i.test(sql) || sql.includes("WITH ")) return { rows: [] };
    return { rows: [], rowCount: 1 };
  };
  const client = { query, release() {} };
  return {
    pool: { query, connect: async () => client } as unknown as Pool,
    sqls,
    lateRequest: {
      protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
      action: "finalize" as const,
      sessionId: SESSION_ID,
      agentId: "late_0123456789abcdef01234567",
      turnIndex: 1,
      status: "completed" as const,
      turnKey: CONT_TURN,
      tapeId: LATE_TAPE,
      tapeSha256: lateSha,
      totalBytes: lateParts.length,
      partCount: 1,
      createdAt: CREATED_AT + 1,
    },
  };
}

describe("OCV5-180 B1 R6 master root authority", () => {
  test("fingerprint changes when transcript/status change and ignores ordinal", () => {
    const base = group();
    const a = canonicalAgentGroupFingerprint(base);
    assert.notEqual(a, canonicalAgentGroupFingerprint({ ...base, transcript: [{ kind: "text", text: "B" }] }));
    assert.notEqual(a, canonicalAgentGroupFingerprint({ ...base, status: "failed" }));
    assert.equal(a, canonicalAgentGroupFingerprint({ ...base, _ocEventOrdinal: 9 }));
  });

  test("inspect: same content on ready root is idempotent; different content conflicts", async () => {
    const same = fakePool({});
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(same.pool, USER_ID, same.lateRequest),
      "idempotent",
    );
    const conflict = fakePool({ rootParts: partOf(rootBody([group({ resultSummary: "other" })])).buf });
    await assert.rejects(
      () => inspectLateDelegateContinuationAgainstRoot(conflict.pool, USER_ID, conflict.lateRequest),
      (err: unknown) => Boolean(err && typeof err === "object" && (err as { immutableConflict?: boolean }).immutableConflict),
    );
  });

  test("inspect: missing root, incomplete parts, or lookup EIO are retryable", async () => {
    const missing = fakePool({ rootParts: null });
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(missing.pool, USER_ID, missing.lateRequest),
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

  test("inspect: ready root without the run proceeds; other user/session retry", async () => {
    const empty = fakePool({ rootParts: partOf(rootBody([])).buf });
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
    assert.equal(
      await inspectLateDelegateContinuationAgainstRoot(crossSession.pool, USER_ID, {
        ...crossSession.lateRequest,
        sessionId: "web-other-session",
      }),
      "retry",
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

  test("finalize retries when root parts are missing", async () => {
    const missing = fakePool({ rootParts: null });
    const backend = createPgSessionsBackend(missing.pool, { expectedGeneration: 0 });
    const result = await backend.finalizeLosslessTurnTape(USER_ID, missing.lateRequest, { materialize: false });
    assert.equal(result.applied, "incomplete");
  });

  test("finalize conflicts when root run content differs", async () => {
    const conflict = fakePool({ rootParts: partOf(rootBody([group({ resultSummary: "other" })])).buf });
    const backend = createPgSessionsBackend(conflict.pool, { expectedGeneration: 0 });
    await assert.rejects(
      () => backend.finalizeLosslessTurnTape(USER_ID, conflict.lateRequest, { materialize: false }),
      (err: unknown) => Boolean(err && typeof err === "object" && (err as { immutableConflict?: boolean }).immutableConflict),
    );
  });
});
