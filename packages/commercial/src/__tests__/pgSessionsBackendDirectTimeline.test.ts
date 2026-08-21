import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
        return { rows: [{ tape_sha256: "a".repeat(64), model_record_count: 2, finalized_at: "1" }] };
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

test("CCB finite rebuild budgets dense ASCII by UTF-8 worst case without changing exact tape payloads", async () => {
  const base64 = "A".repeat(64 * 1024);
  const denseAscii = `recent-${"x".repeat(20_000)}-tail`;
  const legacyImage = `Output: {"source":{"type":"base64","media_type":"image/jpeg","data":"${base64}"},"caption":"keep-caption"}`;
  const rows = [
    { physical_ordinal: 1, logical_ordinal: 0, msg_id: "dense", role: "assistant", token_estimate: 5_003, ts: "102", client_message_id: null },
    { physical_ordinal: 0, logical_ordinal: 0, msg_id: "legacy-image", role: "tool", token_estimate: 16_410, ts: "101", client_message_id: null },
  ];
  const fakePool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT messages, archived_through_seq FROM client_sessions")) {
        return { rows: [{ messages: JSON.stringify([completeTapeAnchor()]), archived_through_seq: 0 }] };
      }
      if (sql.includes("SELECT tape_sha256,model_record_count")) {
        return { rows: [{ tape_sha256: "a".repeat(64), model_record_count: rows.length, finalized_at: "1" }] };
      }
      if (sql.includes("ORDER BY physical_ordinal DESC,logical_ordinal DESC")) return { rows };
      if (sql.includes("SELECT right(semantic_text")) {
        const source = Number(params?.[3]) === 1 ? denseAscii : legacyImage;
        return { rows: [{ semantic_text: source.slice(-Number(params?.[5])) }] };
      }
      if (sql.includes("SELECT semantic_text FROM client_session_turn_tape_model_records")) {
        return { rows: [{ semantic_text: Number(params?.[3]) === 1 ? denseAscii : legacyImage }] };
      }
      if (sql.includes("FROM client_session_archive_chunks")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const backend = createPgSessionsBackend(fakePool, { expectedGeneration: 0 });

  const contextWindow = 34_400;
  const currentUserText = "继续 dense ASCII task";
  const context = await backend.getEngineContextMessages("session-1", "c:1", {
    contextWindow,
    engine: "ccb",
    currentUserText,
  });
  const rebuiltBytes = Buffer.byteLength(
    (context ?? []).map((row) => String(row.text ?? "")).join("\n\n"),
    "utf8",
  );
  assert.ok(rebuiltBytes <= contextWindow - 33_256 - Buffer.byteLength(currentUserText, "utf8"));
  assert.match(String(context?.at(-1)?.text), /-tail$/);

  const exactVisible = userVisibleTapeRecord({
    id: "legacy-image", role: "tool", toolName: "Read", output: legacyImage,
  });
  assert.match(JSON.stringify(exactVisible), new RegExp(`A{${base64.length}}`),
    "browser/audit projection keeps the exact binary payload");
});

test("finite rebuild sanitizes a complete legacy Base64 sidecar before model injection", async () => {
  const base64 = "A".repeat(4_096);
  const legacyImage = `Output: {"source":{"type":"base64","media_type":"image/jpeg","data":"${base64}"},"caption":"keep-caption"}`;
  const fakePool = {
    query: async (sql: string) => {
      if (sql.includes("SELECT messages, archived_through_seq FROM client_sessions")) {
        return { rows: [{ messages: JSON.stringify([completeTapeAnchor()]), archived_through_seq: 0 }] };
      }
      if (sql.includes("SELECT tape_sha256,model_record_count")) {
        return { rows: [{ tape_sha256: "a".repeat(64), model_record_count: 1, finalized_at: "1" }] };
      }
      if (sql.includes("ORDER BY physical_ordinal DESC,logical_ordinal DESC")) {
        return { rows: [{
          physical_ordinal: 0,
          logical_ordinal: 0,
          msg_id: "legacy-image",
          role: "tool",
          token_estimate: 1_040,
          ts: "101",
          client_message_id: null,
        }] };
      }
      if (sql.includes("SELECT semantic_text FROM client_session_turn_tape_model_records")) {
        return { rows: [{ semantic_text: legacyImage }] };
      }
      if (sql.includes("FROM client_session_archive_chunks")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const backend = createPgSessionsBackend(fakePool, { expectedGeneration: 0 });
  const context = await backend.getEngineContextMessages("session-1", "c:1", {
    contextWindow: 40_000,
    engine: "ccb",
    currentUserText: "继续",
  });
  const text = String(context?.[0]?.text);
  assert.match(text, /binary image\/jpeg omitted from model context/);
  assert.match(text, /keep-caption/);
  assert.equal(text.includes(base64), false);
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
        return { rows: [{ tape_sha256: "a".repeat(64), model_record_count: 1, finalized_at: "1" }] };
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
        return { rows: [{ tape_sha256: "a".repeat(64), model_record_count: 129, finalized_at: "1" }] };
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

test("predecessor 16k-record tape backfills only the newest physical suffix needed by the model window", async () => {
  const physicalCount = 16_822;
  const newestOrdinal = physicalCount - 1;
  const payload = Buffer.from(JSON.stringify({
    id: "legacy-newest-tool",
    role: "tool",
    text: "",
    toolName: "Bash",
    output: `real newest output ${"x".repeat(20_000)}`,
    ts: 200,
    _clientMessageId: "cm-legacy",
  }), "utf8");
  const contentSha256 = createHash("sha256").update(payload).digest("hex");
  const sqlCalls: Array<{ sql: string; params: unknown[] }> = [];
  const payloadOrdinals: number[] = [];
  let inserted: unknown[] | null = null;
  const fakePool = {
    query: async (sql: string, params: unknown[] = []) => {
      sqlCalls.push({ sql, params });
      if (sql.includes("SELECT messages, archived_through_seq FROM client_sessions")) {
        return { rows: [{ messages: JSON.stringify([completeTapeAnchor({
          _turnTapePhysicalRecordCount: physicalCount,
        })]), archived_through_seq: 0 }] };
      }
      if (sql.includes("SELECT tape_sha256,model_record_count")) {
        return { rows: [{
          tape_sha256: "a".repeat(64),
          billing_anchor_id: "tape-anchor",
          model_record_count: -1,
          finalized_at: "1",
        }] };
      }
      if (sql.includes("SELECT ordinal,msg_id,role,content_sha256")) {
        return {
          rows: Array.from({ length: 512 }, (_, index) => ({
            ordinal: newestOrdinal - index,
            msg_id: index === 0 ? "legacy-newest-tool" : `opaque-${newestOrdinal - index}`,
            role: index === 0 ? "tool" : "thinking",
            content_sha256: index === 0 ? contentSha256 : "b".repeat(64),
            payload_bytes: index === 0 ? String(payload.length) : "1",
            model_sidecar_complete: false,
          })),
        };
      }
      if (sql.includes("SELECT msg_id,ordinal,role,content_sha256,payload")) {
        const ordinals = params[3] as number[];
        payloadOrdinals.push(...ordinals);
        assert.deepEqual(ordinals, [newestOrdinal]);
        return { rows: [{
          msg_id: "legacy-newest-tool",
          ordinal: newestOrdinal,
          role: "tool",
          content_sha256: contentSha256,
          payload,
        }] };
      }
      if (sql.includes("INSERT INTO client_session_turn_tape_model_records")) {
        inserted = params;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text")) {
        assert.ok(inserted);
        const physicalOrdinals = inserted[3] as number[];
        const logicalOrdinals = inserted[4] as number[];
        const msgIds = inserted[5] as string[];
        const roles = inserted[6] as string[];
        const texts = inserted[7] as string[];
        const estimates = inserted[8] as number[];
        const timestamps = inserted[9] as Array<string | number | null>;
        const clientIds = inserted[10] as Array<string | null>;
        return { rows: logicalOrdinals.map((logicalOrdinal, index) => ({
          physical_ordinal: physicalOrdinals[index],
          logical_ordinal: logicalOrdinal,
          msg_id: msgIds[index],
          role: roles[index],
          semantic_text: texts[index],
          token_estimate: estimates[index],
          ts: timestamps[index] === null ? null : String(timestamps[index]),
          client_message_id: clientIds[index],
        })) };
      }
      if (sql.includes("SET model_sidecar_complete=TRUE")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const backend = createPgSessionsBackend(fakePool, { expectedGeneration: 0 });

  const context = await backend.getEngineContextMessages("session-1", "c:1", {
    contextWindow: 400,
  });

  assert.equal(context?.length, 1);
  assert.equal(context?.[0]?.id, "legacy-newest-tool");
  assert.match(String(context?.[0]?.text), /Earlier bytes of this exact message/);
  assert.deepEqual(payloadOrdinals, [newestOrdinal]);
  const headQuery = sqlCalls.find(({ sql }) =>
    sql.includes("SELECT ordinal,msg_id,role,content_sha256"));
  assert.ok(headQuery);
  assert.equal(
    headQuery.sql.includes("SELECT msg_id,ordinal,role,content_sha256,payload"),
    false,
  );
  assert.equal(sqlCalls.some(({ sql }) => sql.includes("SELECT r.tape_id, t.tape_sha256")), false);
});

test("predecessor sparse 16k-record tape backfills in bounded pages instead of per physical row", async () => {
  const physicalCount = 16_822;
  const semanticOrdinals = new Set([3, 4_201, 10_777, physicalCount - 2]);
  const payloads = Array.from({ length: physicalCount }, (_, ordinal) => {
    const semantic = semanticOrdinals.has(ordinal);
    const value = semantic
      ? {
          id: `semantic-${ordinal}`,
          role: "assistant",
          text: `short semantic ${ordinal}`,
          ts: ordinal + 1,
        }
      : {
          id: `runtime-${ordinal}`,
          role: "runtime-event",
          text: "",
          ts: ordinal + 1,
          _runtimeEvent: { type: "progress", phase: `step-${ordinal}` },
        };
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    return {
      payload,
      contentSha256: createHash("sha256").update(payload).digest("hex"),
      msgId: String(value.id),
      role: String(value.role),
    };
  });
  const sidecars = new Map<number, Array<{
    physical_ordinal: number;
    logical_ordinal: number;
    msg_id: string;
    role: string;
    semantic_text: string;
    token_estimate: number;
    ts: string | null;
    client_message_id: string | null;
  }>>();
  const completed = new Set<number>();
  let metadataQueries = 0;
  let rawQueries = 0;
  let totalQueries = 0;
  let countPublished = false;
  const fakePool = {
    query: async (sql: string, params: unknown[] = []) => {
      totalQueries += 1;
      if (sql.includes("SELECT messages, archived_through_seq FROM client_sessions")) {
        return { rows: [{ messages: JSON.stringify([completeTapeAnchor({
          _turnTapePhysicalRecordCount: physicalCount,
        })]), archived_through_seq: 0 }] };
      }
      if (sql.includes("SELECT tape_sha256,model_record_count")) {
        return { rows: [{
          tape_sha256: "a".repeat(64),
          billing_anchor_id: "tape-anchor",
          model_record_count: -1,
          finalized_at: "1",
        }] };
      }
      if (sql.includes("SELECT ordinal,msg_id,role,content_sha256")) {
        metadataQueries += 1;
        const before = params[3] === null ? physicalCount : Number(params[3]);
        const rows = [];
        for (let ordinal = before - 1; ordinal >= 0 && rows.length < 512; ordinal -= 1) {
          const source = payloads[ordinal]!;
          rows.push({
            ordinal,
            msg_id: source.msgId,
            role: source.role,
            content_sha256: source.contentSha256,
            payload_bytes: String(source.payload.length),
            model_sidecar_complete: completed.has(ordinal),
          });
        }
        return { rows };
      }
      if (sql.includes("SELECT msg_id,ordinal,role,content_sha256,payload")) {
        rawQueries += 1;
        const ordinals = params[3] as number[];
        return {
          rows: ordinals
            .filter((ordinal) => !completed.has(ordinal))
            .map((ordinal) => {
              const source = payloads[ordinal]!;
              return {
                msg_id: source.msgId,
                ordinal,
                role: source.role,
                content_sha256: source.contentSha256,
                payload: source.payload,
              };
            }),
        };
      }
      if (sql.includes("INSERT INTO client_session_turn_tape_model_records")) {
        const physicalOrdinals = params[3] as number[];
        const logicalOrdinals = params[4] as number[];
        const msgIds = params[5] as string[];
        const roles = params[6] as string[];
        const texts = params[7] as string[];
        const estimates = params[8] as number[];
        const timestamps = params[9] as Array<string | number | null>;
        const clientIds = params[10] as Array<string | null>;
        for (let index = 0; index < physicalOrdinals.length; index += 1) {
          const physicalOrdinal = physicalOrdinals[index]!;
          const rows = sidecars.get(physicalOrdinal) ?? [];
          rows.push({
            physical_ordinal: physicalOrdinal,
            logical_ordinal: logicalOrdinals[index]!,
            msg_id: msgIds[index]!,
            role: roles[index]!,
            semantic_text: texts[index]!,
            token_estimate: estimates[index]!,
            ts: timestamps[index] === null ? null : String(timestamps[index]),
            client_message_id: clientIds[index] ?? null,
          });
          sidecars.set(physicalOrdinal, rows);
        }
        return { rows: [], rowCount: physicalOrdinals.length };
      }
      if (sql.includes("SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text")) {
        const ordinals = params[3] as number[];
        return {
          rows: ordinals
            .flatMap((ordinal) => sidecars.get(ordinal) ?? [])
            .sort((a, b) =>
              a.physical_ordinal - b.physical_ordinal ||
              a.logical_ordinal - b.logical_ordinal),
        };
      }
      if (sql.includes("SET model_sidecar_complete=TRUE")) {
        const ordinals = params[3] as number[];
        for (const ordinal of ordinals) completed.add(ordinal);
        return { rows: [], rowCount: ordinals.length };
      }
      if (sql.includes("UPDATE client_session_turn_tapes t")) {
        countPublished = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM client_session_archive_chunks")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const backend = createPgSessionsBackend(fakePool, { expectedGeneration: 0 });

  const context = await backend.getEngineContextMessages("session-1", "c:1", {
    contextWindow: 258_400,
  });

  assert.deepEqual(
    context?.map((row) => row.id),
    [...semanticOrdinals].map((ordinal) => `semantic-${ordinal}`),
  );
  assert.equal(metadataQueries, Math.ceil(physicalCount / 512));
  assert.equal(rawQueries, Math.ceil(physicalCount / 512));
  assert.equal(completed.size, physicalCount);
  assert.equal(countPublished, true);
  assert.ok(totalQueries < 200, `expected page-level queries, received ${totalQueries}`);
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
