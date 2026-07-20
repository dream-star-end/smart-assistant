import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { createPgSessionsBackend, userVisibleTapeRecord } from "../db/pgSessionsBackend.js";

function completeTapeAnchor(over: Record<string, unknown> = {}) {
  return {
    id: "tape-anchor",
    role: "assistant",
    text: "",
    ts: 100,
    _seq: 10,
    _orderSeq: 10,
    _turnTapeComplete: true,
    _turnTapeId: "tape-1",
    _turnTapeSha256: "a".repeat(64),
    ...over,
  };
}

test("future roles and child block fields survive while known private collectors do not", () => {
  const future = userVisibleTapeRecord({
    id: "future-1",
    role: "future-agent-stage",
    text: "exact future output",
    ts: 1,
    futureField: { nested: [1, 2, 3] },
  });
  assert.deepEqual(future, {
    id: "future-1",
    role: "future-agent-stage",
    text: "exact future output",
    ts: 1,
    futureField: { nested: [1, 2, 3] },
  });

  const group = userVisibleTapeRecord({
    id: "group-1",
    role: "agent-group",
    text: "delegate",
    runtimeEvents: [{ secret: true }],
    childBlocks: [{
      kind: "future_widget",
      futureField: "exact child field",
      _nestedDelegateRuntimeEvents: [{ credentials: "private" }],
    }],
  });
  assert.equal(JSON.stringify(group).includes("private"), false);
  assert.equal(JSON.stringify(group).includes("exact child field"), true);
  assert.equal(group?._internalFieldsOmitted, true);
});

test("runtime lifecycle stays visible after only known private keys are removed", () => {
  const visible = userVisibleTapeRecord({
    id: "runtime-1",
    role: "runtime-event",
    text: "raw",
    ts: 1,
    _hiddenRuntimeEvent: true,
    _runtimeEvent: {
      type: "progress",
      phase: "tool-running",
      futureProgressField: { percent: 42 },
      headers: { authorization: "private" },
    },
  });
  assert.equal(visible?._hiddenRuntimeEvent, undefined);
  assert.deepEqual(visible?._runtimeEvent, {
    type: "progress",
    phase: "tool-running",
    futureProgressField: { percent: 42 },
  });
  assert.match(String(visible?.text), /tool-running/);
  assert.equal(String(visible?.text).includes("private"), false);
});

test("a fresh clientMessageId never scans archive payloads during completed-turn dedup", async () => {
  const sqlCalls: string[] = [];
  const fakePool = {
    query: async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes("FROM client_session_turn_tapes")) {
        return { rows: [{ present: false }] };
      }
      if (sql.includes("FROM client_sessions")) {
        return { rows: [{ messages: JSON.stringify([{ id: "current-hot", role: "user", text: "new" }]) }] };
      }
      if (sql.includes("FROM client_session_archived_ids")) {
        return { rows: [{ present: false }] };
      }
      throw new Error(`unexpected archive payload query: ${sql}`);
    },
  } as unknown as Pool;
  const backend = createPgSessionsBackend(fakePool, { expectedGeneration: 0 });

  assert.equal(
    await backend.hasCompletedClientTurn("session-1", "c:1", "brand-new-id"),
    false,
  );
  assert.equal(sqlCalls.some((sql) => sql.includes("client_session_archive_chunks")), false);
  assert.equal(sqlCalls.some((sql) => sql.includes("client_session_archived_ids")), true);
});

test("a clientMessageId still in the hot suffix returns false without archive lookup", async () => {
  const sqlCalls: string[] = [];
  const fakePool = {
    query: async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes("FROM client_session_turn_tapes")) return { rows: [{ present: false }] };
      if (sql.includes("FROM client_sessions")) {
        return { rows: [{ messages: JSON.stringify([{ id: "hot-id", role: "user", text: "new" }]) }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const backend = createPgSessionsBackend(fakePool, { expectedGeneration: 0 });

  assert.equal(await backend.hasCompletedClientTurn("session-1", "c:1", "hot-id"), false);
  assert.equal(sqlCalls.length, 2);
});

test("finite model context reads immutable semantic sidecars including exact Bash tails", async () => {
  const sqlCalls: string[] = [];
  const fakePool = {
    query: async (sql: string, params?: unknown[]) => {
      sqlCalls.push(sql);
      if (sql.includes("SELECT messages, archived_through_seq FROM client_sessions")) {
        return { rows: [{ messages: JSON.stringify([completeTapeAnchor()]), archived_through_seq: 0 }] };
      }
      if (sql.includes("SELECT tape_sha256,model_record_count")) {
        return { rows: [{ tape_sha256: "a".repeat(64), model_record_count: 2 }] };
      }
      if (sql.includes("ORDER BY physical_ordinal DESC,logical_ordinal DESC")) {
        return { rows: [
          {
            physical_ordinal: 1,
            logical_ordinal: 0,
            msg_id: "tail-1",
            role: "tool",
            token_estimate: 24,
            ts: "102",
            client_message_id: "cm-1",
          },
          {
            physical_ordinal: 0,
            logical_ordinal: 0,
            msg_id: "assistant-1",
            role: "assistant",
            token_estimate: 4,
            ts: "101",
            client_message_id: "cm-1",
          },
        ] };
      }
      if (sql.includes("SELECT semantic_text FROM client_session_turn_tape_model_records")) {
        return { rows: [{ semantic_text: params?.[3] === 1
          ? 'Exact tool output tail: {"tail":"REAL-BASH-TAIL","totalBytes":9000000}'
          : "completed answer" }] };
      }
      if (sql.includes("FROM client_session_archive_chunks")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const backend = createPgSessionsBackend(fakePool, { expectedGeneration: 0 });

  const context = await backend.getEngineContextMessages("session-1", "c:1", {
    contextWindow: 2_000,
  });
  assert.deepEqual(context?.map((row) => row.role), ["assistant", "tool"]);
  assert.equal(context?.[0]?.text, "completed answer");
  assert.match(String(context?.[1]?.text), /REAL-BASH-TAIL/);
  assert.equal(sqlCalls.some((sql) => sql.includes("client_session_turn_tape_records")), false);
});

test("finite model context selects a Unicode-safe SQL suffix without loading a giant semantic row", async () => {
  const sqlCalls: Array<{ sql: string; params?: unknown[] }> = [];
  const exactTail = `${"末".repeat(300)}😀END`;
  const fakePool = {
    query: async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      if (sql.includes("SELECT messages, archived_through_seq FROM client_sessions")) {
        return { rows: [{ messages: JSON.stringify([completeTapeAnchor()]), archived_through_seq: 0 }] };
      }
      if (sql.includes("SELECT tape_sha256,model_record_count")) {
        return { rows: [{ tape_sha256: "a".repeat(64), model_record_count: 1 }] };
      }
      if (sql.includes("ORDER BY physical_ordinal DESC,logical_ordinal DESC")) {
        return { rows: [{
          physical_ordinal: 0,
          logical_ordinal: 0,
          msg_id: "huge-tool",
          role: "tool",
          token_estimate: 100_000,
          ts: "101",
          client_message_id: "cm-huge",
        }] };
      }
      if (sql.includes("SELECT right(semantic_text")) {
        const maxCharacters = Number(params?.[5]);
        return { rows: [{ semantic_text: Array.from(exactTail).slice(-maxCharacters).join("") }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const backend = createPgSessionsBackend(fakePool, { expectedGeneration: 0 });

  const context = await backend.getEngineContextMessages("session-1", "c:1", {
    contextWindow: 400,
  });
  assert.equal(context?.length, 1);
  assert.match(String(context?.[0]?.text), /Earlier bytes of this exact message/);
  assert.match(String(context?.[0]?.text), /😀END$/);
  assert.doesNotMatch(String(context?.[0]?.text), /�/);
  assert.equal(
    sqlCalls.some(({ sql }) => sql.includes("SELECT semantic_text FROM client_session_turn_tape_model_records")),
    false,
  );
  assert.equal(sqlCalls.some(({ sql }) => sql.includes("client_session_turn_tape_records")), false);
});

test("finite model context pages past 128 semantic records in exact chronological order", async () => {
  const metadataCalls: unknown[][] = [];
  const fakePool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT messages, archived_through_seq FROM client_sessions")) {
        return { rows: [{ messages: JSON.stringify([completeTapeAnchor()]), archived_through_seq: 0 }] };
      }
      if (sql.includes("SELECT tape_sha256,model_record_count")) {
        return { rows: [{ tape_sha256: "a".repeat(64), model_record_count: 129 }] };
      }
      if (sql.includes("ORDER BY physical_ordinal DESC,logical_ordinal DESC")) {
        metadataCalls.push(params ?? []);
        const before = params?.[3] === null ? 129 : Number(params?.[3]);
        const rows = [];
        for (let ordinal = before - 1; ordinal >= 0 && rows.length < 128; ordinal -= 1) {
          rows.push({
            physical_ordinal: ordinal,
            logical_ordinal: 0,
            msg_id: `m-${ordinal}`,
            role: ordinal % 2 === 0 ? "user" : "assistant",
            token_estimate: 2,
            ts: String(ordinal),
            client_message_id: null,
          });
        }
        return { rows };
      }
      if (sql.includes("SELECT semantic_text FROM client_session_turn_tape_model_records")) {
        return { rows: [{ semantic_text: `text-${params?.[3]}` }] };
      }
      if (sql.includes("FROM client_session_archive_chunks")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const backend = createPgSessionsBackend(fakePool, { expectedGeneration: 0 });

  const context = await backend.getEngineContextMessages("session-1", "c:1", {
    contextWindow: 10_000,
  });
  assert.equal(metadataCalls.length, 2);
  assert.equal(context?.length, 129);
  assert.equal(context?.[0]?.id, "m-0");
  assert.equal(context?.at(-1)?.id, "m-128");
});

test("finite model context suffixes deferred giant user text in SQL", async () => {
  const sqlCalls: string[] = [];
  const fakePool = {
    query: async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes("SELECT messages, archived_through_seq FROM client_sessions")) {
        return { rows: [{ messages: JSON.stringify([{
          id: "giant-user",
          role: "user",
          text: "",
          ts: 1,
          _payloadDeferred: true,
          _userPayloadDeferred: true,
          _payloadBytes: 50_000_000,
        }]), archived_through_seq: 0 }] };
      }
      if (sql.includes("SELECT model_token_estimate, length(text_payload)")) {
        return { rows: [{ model_token_estimate: 100_000, character_count: "100000" }] };
      }
      if (sql.includes("SELECT right(text_payload")) {
        return { rows: [{ text_payload: "用户消息真实末尾😀" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const backend = createPgSessionsBackend(fakePool, { expectedGeneration: 0 });

  const context = await backend.getEngineContextMessages("session-1", "c:1", {
    contextWindow: 400,
  });
  assert.match(String(context?.[0]?.text), /用户消息真实末尾😀$/);
  assert.equal(sqlCalls.some((sql) => /SELECT text_payload FROM/.test(sql)), false);
});
