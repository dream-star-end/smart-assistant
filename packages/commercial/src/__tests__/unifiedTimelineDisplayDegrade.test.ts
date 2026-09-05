import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { createPgSessionsBackend } from "../db/pgSessionsBackend.js";
import { resetTapeDisplayDegradeLogForTests } from "../db/visibleFinalize.js";

const TAPE_SHA = "a".repeat(64);
const FULL_TEXT = "全文可见头：第二句也必须出现，不能只剩第一句。";
const FIRST_SENTENCE = "全文可见头：";
const USER_ID = "c:1";
const SESSION_ID = "webdisplay01";

type TimelineMessage = Record<string, unknown> & {
  id?: string;
  role?: string;
  text?: string;
  _displayDegraded?: boolean;
  _displayDegradeReason?: string;
  _timelineUnitKey?: string;
};
type TimelineSession = Record<string, unknown> & { messages: TimelineMessage[] };

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sessionMessages(over: Record<string, unknown> = {}) {
  return [
    {
      id: "user-1",
      role: "user",
      text: "hello",
      ts: 100,
      _seq: 1,
      _orderSeq: 1,
    },
    {
      id: "tape-anchor",
      role: "assistant",
      text: FIRST_SENTENCE,
      ts: 200,
      _seq: 2,
      _orderSeq: 2,
      _turnTapeComplete: true,
      _turnTapeId: "tape-failed",
      _turnTapeSha256: TAPE_SHA,
      ...over,
    },
  ];
}

function sessionRow(messages = sessionMessages()) {
  return {
    id: SESSION_ID,
    user_id: USER_ID,
    agent_id: "main",
    title: "display",
    pinned: 0,
    created_at: "1",
    last_at: "2",
    messages: JSON.stringify(messages),
    updated_at: "2",
    archived_through_seq: 0,
    archived_count: "0",
    history_revision: "1",
    timeline_generation: "1",
    model_id: null,
  };
}

function fakePool(handlers: Array<[string, unknown]>): Pool {
  const query = async (sql: string, params: unknown[] = []) => {
    if (/^BEGIN/i.test(sql) || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    for (const [needle, result] of handlers) {
      if (sql.includes(needle)) {
        return typeof result === "function" ? await (result as (s: string, p: unknown[]) => unknown)(sql, params) : result;
      }
    }
    if (/^\s*SELECT/i.test(sql) || sql.includes("WITH ")) return { rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 240)}`);
  };
  const client = { query, release() {} };
  return { query, connect: async () => client } as unknown as Pool;
}

async function getTimeline(handlers: Array<[string, unknown]>) {
  resetTapeDisplayDegradeLogForTests();
  const backend = createPgSessionsBackend(fakePool(handlers), { expectedGeneration: 0 });
  return await backend.getClientSession(SESSION_ID, USER_ID, { view: "timeline" }) as TimelineSession | null;
}

async function readPage(
  handlers: Array<[string, unknown]>,
  cursor: Parameters<ReturnType<typeof createPgSessionsBackend>["readClientTimelinePage"]>[2] = null,
  limit = 1,
) {
  resetTapeDisplayDegradeLogForTests();
  const backend = createPgSessionsBackend(fakePool(handlers), { expectedGeneration: 0 });
  return backend.readClientTimelinePage(SESSION_ID, USER_ID, cursor, limit);
}

function pagingMessages() {
  const hidden = Array.from({ length: 8 }, (_, i) => ({
    id: `rt-${i}`,
    role: "runtime-event",
    text: "hidden-runtime",
    ts: 110 + i,
    _seq: 2 + i,
    _orderSeq: 2 + i,
  }));
  return [
    {
      id: "user-old",
      role: "user",
      text: "更旧的用户消息，分页必须还能翻到",
      ts: 1,
      _seq: 1,
      _orderSeq: 1,
    },
    ...hidden,
    {
      id: "tape-anchor",
      role: "assistant",
      text: FIRST_SENTENCE,
      ts: 200,
      _seq: 20,
      _orderSeq: 20,
      _turnTapeComplete: true,
      _turnTapeId: "tape-failed",
      _turnTapeSha256: TAPE_SHA,
    },
  ];
}

function pagingHandlers(): Array<[string, unknown]> {
  const messages = pagingMessages();
  return [
    ["SELECT messages,archived_through_seq,history_revision,timeline_generation", {
      rows: [{
        messages: JSON.stringify(messages),
        archived_through_seq: 0,
        history_revision: "1",
        timeline_generation: "1",
      }],
    }],
    ["t.materialization_status, t.finalized_at::text, t.visible_head", { rows: [] }],
    ["WITH requested(tape_id,before_ordinal)", { rows: [] }],
    ["WITH selected(tape_id,ordinal)", { rows: [] }],
  ];
}

function baseHandlers(over: {
  headerRows?: unknown[];
  headRows?: unknown[];
  payloadRows?: unknown[];
}): Array<[string, unknown]> {
  return [
    ["SELECT cs.id, cs.user_id", { rows: [sessionRow()] }],
    ["SELECT messages,archived_through_seq,history_revision,timeline_generation", {
      rows: [{
        messages: JSON.stringify(sessionMessages()),
        archived_through_seq: 0,
        history_revision: "1",
        timeline_generation: "1",
      }],
    }],
    ["t.materialization_status, t.finalized_at::text, t.visible_head", {
      rows: over.headerRows ?? [],
    }],
    ["WITH requested(tape_id,before_ordinal)", { rows: over.headRows ?? [] }],
    ["WITH selected(tape_id,ordinal)", { rows: over.payloadRows ?? [] }],
  ];
}

test("unpublished failed tape GET 200 returns visible_head full text", async () => {
  const got = await getTimeline(baseHandlers({
    headerRows: [{
      tape_id: "tape-failed",
      tape_sha256: TAPE_SHA,
      billing_anchor_id: "srv-visible",
      status: "completed",
      turn_key: "b".repeat(64),
      client_message_id: "user-1",
      materialization_status: "failed",
      finalized_at: null,
      visible_head: {
        role: "assistant",
        text: FULL_TEXT,
        ts: 200,
        messageId: "srv-visible",
      },
    }],
  }));
  assert.ok(got);
  const assistant = got!.messages.filter((m) => m.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0]?.text, FULL_TEXT);
  assert.equal(assistant[0]?._displayDegraded, true);
  assert.equal(assistant[0]?._displayDegradeReason, "records_failed");
  assert.equal(got!.messages.some((m) => m.text === FIRST_SENTENCE && m.role === "assistant"), false);
});

test("unpublished tape with ordinal 0 still returns visible_head not the first sentence", async () => {
  const firstPayload = Buffer.from(JSON.stringify({
    id: "first-only",
    role: "assistant",
    text: FIRST_SENTENCE,
    ts: 200,
  }), "utf8");
  const got = await getTimeline(baseHandlers({
    headerRows: [{
      tape_id: "tape-failed",
      tape_sha256: TAPE_SHA,
      billing_anchor_id: "srv-visible",
      status: "completed",
      turn_key: "b".repeat(64),
      client_message_id: "user-1",
      materialization_status: "failed",
      finalized_at: null,
      visible_head: {
        role: "assistant",
        text: FULL_TEXT,
        ts: 200,
        messageId: "srv-visible",
      },
    }],
    headRows: [{
      tape_id: "tape-failed",
      msg_id: "first-only",
      ordinal: 0,
      role: "assistant",
      ts: "200",
      content_sha256: sha256(firstPayload),
      payload_bytes: String(firstPayload.length),
      visible_content_sha256: sha256(firstPayload),
    }],
    payloadRows: [{
      tape_id: "tape-failed",
      msg_id: "first-only",
      ordinal: 0,
      role: "assistant",
      content_sha256: sha256(firstPayload),
      payload: firstPayload,
      visible_payload: firstPayload,
      visible_content_sha256: sha256(firstPayload),
    }],
  }));
  assert.ok(got);
  const assistant = got!.messages.find((m) => m.role === "assistant");
  assert.equal(assistant?.text, FULL_TEXT);
  assert.notEqual(assistant?.text, FIRST_SENTENCE);
  assert.equal(assistant?._timelineUnitKey, "tape-fallback:tape-failed");
});

test("record missing / hash mismatch / malformed degrade to GET 200", async () => {
  const publishedHeader = {
    tape_id: "tape-failed",
    tape_sha256: TAPE_SHA,
    billing_anchor_id: "srv-visible",
    status: "completed",
    turn_key: "b".repeat(64),
    client_message_id: "user-1",
    materialization_status: "complete",
    finalized_at: "2026-08-19T00:00:00.000Z",
    visible_head: {
      role: "assistant",
      text: FULL_TEXT,
      ts: 200,
      messageId: "srv-visible",
    },
  };
  const head = {
    tape_id: "tape-failed",
    msg_id: "rec-1",
    ordinal: 1,
    role: "assistant",
    ts: "200",
    content_sha256: "c".repeat(64),
    payload_bytes: "12",
    visible_content_sha256: "d".repeat(64),
  };

  const missing = await getTimeline(baseHandlers({
    headerRows: [publishedHeader],
    headRows: [head],
    payloadRows: [],
  }));
  assert.equal(missing?.messages.find((m) => m.role === "assistant")?.text, FULL_TEXT);
  assert.equal(missing?.messages.find((m) => m.role === "assistant")?._displayDegradeReason, "record_missing");

  const badBytes = Buffer.from(JSON.stringify({ id: "rec-1", role: "assistant", text: "tampered", ts: 200 }), "utf8");
  const mismatch = await getTimeline(baseHandlers({
    headerRows: [publishedHeader],
    headRows: [head],
    payloadRows: [{
      tape_id: "tape-failed",
      msg_id: "rec-1",
      ordinal: 1,
      role: "assistant",
      content_sha256: "c".repeat(64),
      payload: badBytes,
      visible_payload: badBytes,
      visible_content_sha256: "d".repeat(64),
    }],
  }));
  assert.equal(mismatch?.messages.find((m) => m.role === "assistant")?.text, FULL_TEXT);
  assert.equal(
    mismatch?.messages.find((m) => m.role === "assistant")?._displayDegradeReason,
    "visible_payload_hash_mismatch",
  );

  const malformedBytes = Buffer.from("[1,2,3]", "utf8");
  const malformed = await getTimeline(baseHandlers({
    headerRows: [publishedHeader],
    headRows: [{ ...head, payload_bytes: String(malformedBytes.length), visible_content_sha256: sha256(malformedBytes) }],
    payloadRows: [{
      tape_id: "tape-failed",
      msg_id: "rec-1",
      ordinal: 1,
      role: "assistant",
      content_sha256: sha256(malformedBytes),
      payload: malformedBytes,
      visible_payload: malformedBytes,
      visible_content_sha256: sha256(malformedBytes),
    }],
  }));
  assert.equal(malformed?.messages.find((m) => m.role === "assistant")?.text, FULL_TEXT);
  assert.ok(
    malformed?.messages.find((m) => m.role === "assistant")?._displayDegradeReason === "record_malformed"
      || malformed?.messages.find((m) => m.role === "assistant")?._displayDegradeReason === "record_json_invalid",
  );
});

test("missing header falls back to anchor text instead of throwing", async () => {
  const got = await getTimeline(baseHandlers({ headerRows: [] }));
  assert.ok(got);
  const assistant = got!.messages.find((m) => m.role === "assistant");
  assert.equal(assistant?.text, FIRST_SENTENCE);
  assert.equal(assistant?._displayDegraded, true);
  assert.equal(assistant?._displayDegradeReason, "header_missing");
});

test("tape hash mismatch degrades to visible_head without throwing", async () => {
  const got = await getTimeline(baseHandlers({
    headerRows: [{
      tape_id: "tape-failed",
      tape_sha256: "f".repeat(64),
      billing_anchor_id: "srv-visible",
      status: "completed",
      turn_key: "b".repeat(64),
      client_message_id: "user-1",
      materialization_status: "complete",
      finalized_at: "2026-08-19T00:00:00.000Z",
      visible_head: {
        role: "assistant",
        text: FULL_TEXT,
        ts: 200,
        messageId: "srv-visible",
      },
    }],
  }));
  assert.equal(got?.messages.find((m) => m.role === "assistant")?.text, FULL_TEXT);
  assert.equal(got?.messages.find((m) => m.role === "assistant")?._displayDegradeReason, "tape_hash_mismatch");
});

test("fallback tape plus hidden runtime-events still pages to older messages", async () => {
  const handlers = pagingHandlers();
  const first = await readPage(handlers, null, 1);
  assert.ok(first);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.equal(
    first.messages.some((m) => m.role === "assistant" && m._displayDegraded === true),
    true,
  );
  assert.equal(first.messages.some((m) => m.id === "user-old"), false);

  const second = await readPage(handlers, first.nextCursor, 1);
  assert.ok(second);
  assert.equal(second.messages.some((m) => m.id === "user-old"), true);
  assert.equal(second.messages.find((m) => m.id === "user-old")?.text, "更旧的用户消息，分页必须还能翻到");
});

// ── INC-20260829-PARTIAL-FINAL-TAPE-POISON (gpt-6 audit case 5) ──────────────

function publishedHeader(over: Record<string, unknown> = {}) {
  return {
    tape_id: "tape-failed",
    tape_sha256: TAPE_SHA,
    billing_anchor_id: "srv-visible",
    status: "completed",
    turn_key: "b".repeat(64),
    client_message_id: "user-1",
    materialization_status: "complete",
    finalized_at: "2026-08-19T00:00:00.000Z",
    visible_head: {
      role: "assistant",
      text: FULL_TEXT,
      ts: 200,
      messageId: "srv-visible",
    },
    ...over,
  };
}

function recordBytes(value: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

/** A bash_output_tail runtime-event whose JSON text holds raw invalid UTF-8
 * bytes (0xff 0xfe 0x41). SQL-side convert_from would throw on it; the JS
 * lossy decode must turn them into U+FFFD replacement characters. */
function poisonTailEventBytes(): Buffer {
  return Buffer.concat([
    Buffer.from(`{"id":"rt-poison","role":"runtime-event","text":"tail:`, "utf8"),
    Buffer.from([0xff, 0xfe, 0x41]),
    Buffer.from(
      `","ts":150,"_runtimeEvent":{"type":"system","subtype":"bash_output_tail","tool_use_id":"tool-poison","total_bytes":9000000}}`,
      "utf8",
    ),
  ]);
}

function cleanTailEventBytes(): Buffer {
  return recordBytes({
    id: "rt-clean",
    role: "runtime-event",
    text: "tail:CLEAN-OUTPUT",
    ts: 150,
    _runtimeEvent: {
      type: "system",
      subtype: "bash_output_tail",
      tool_use_id: "tool-clean",
      total_bytes: 42,
    },
  });
}

type SqlCall = { sql: string; params: unknown[] };

async function readPageCaptured(
  handlers: Array<[string, unknown]>,
  cursor: Parameters<ReturnType<typeof createPgSessionsBackend>["readClientTimelinePage"]>[2] = null,
  limit = 1,
): Promise<{ page: Awaited<ReturnType<ReturnType<typeof createPgSessionsBackend>["readClientTimelinePage"]>>; sqlCalls: SqlCall[] }> {
  resetTapeDisplayDegradeLogForTests();
  const sqlCalls: SqlCall[] = [];
  const inner = fakePool(handlers);
  const query = async (sql: string, params: unknown[] = []) => {
    sqlCalls.push({ sql, params });
    return inner.query(sql, params);
  };
  const client = { query, release() {} };
  const pool = { query, connect: async () => client } as unknown as Pool;
  const backend = createPgSessionsBackend(pool, { expectedGeneration: 0 });
  const page = await backend.readClientTimelinePage(SESSION_ID, USER_ID, cursor, limit);
  return { page, sqlCalls };
}

test("published tape with zero semantic heads degrades to visible_head final text", async () => {
  const { page } = await readPageCaptured(baseHandlers({
    headerRows: [publishedHeader()],
  }));
  assert.ok(page);
  const assistant = page.messages.find((m) => m.role === "assistant");
  assert.equal(assistant?.text, FULL_TEXT);
  assert.equal(assistant?._displayDegraded, true);
  assert.equal(assistant?._displayDegradeReason, "final_record_missing");
  assert.equal(assistant?._timelineUnitKey, "tape-fallback:tape-failed");
  assert.equal(assistant?._turnTapeId, "tape-failed");
});

test("semantic heads present keep the exact hydrated record without fallback", async () => {
  const payload = recordBytes({ id: "rec-1", role: "assistant", text: "exact semantic answer", ts: 200 });
  const { page } = await readPageCaptured(baseHandlers({
    headerRows: [publishedHeader()],
    headRows: [{
      tape_id: "tape-failed",
      msg_id: "rec-1",
      ordinal: 1,
      role: "assistant",
      ts: "200",
      content_sha256: sha256(payload),
      payload_bytes: String(payload.length),
      visible_content_sha256: sha256(payload),
    }],
    payloadRows: [{
      tape_id: "tape-failed",
      msg_id: "rec-1",
      ordinal: 1,
      role: "assistant",
      content_sha256: sha256(payload),
      payload,
      visible_payload: payload,
      visible_content_sha256: sha256(payload),
    }],
  }));
  assert.ok(page);
  const assistant = page.messages.find((m) => m.role === "assistant");
  assert.equal(assistant?.text, "exact semantic answer");
  assert.equal(assistant?._displayDegraded, undefined);
  assert.equal(page.messages.some((m) => m._timelineUnitKey === "tape-fallback:tape-failed"), false);
});

test("heads without any final assistant record append the visible_head fallback after process rows", async () => {
  const toolPayload = recordBytes({
    id: "tool-1",
    role: "tool",
    text: "",
    toolName: "Bash",
    output: "ls -la",
    ts: 180,
  });
  const { page } = await readPageCaptured(baseHandlers({
    headerRows: [publishedHeader()],
    headRows: [{
      tape_id: "tape-failed",
      msg_id: "tool-1",
      ordinal: 3,
      role: "tool",
      ts: "180",
      content_sha256: sha256(toolPayload),
      payload_bytes: String(toolPayload.length),
      visible_content_sha256: sha256(toolPayload),
    }],
    payloadRows: [{
      tape_id: "tape-failed",
      msg_id: "tool-1",
      ordinal: 3,
      role: "tool",
      content_sha256: sha256(toolPayload),
      payload: toolPayload,
      visible_payload: toolPayload,
      visible_content_sha256: sha256(toolPayload),
    }],
  }));
  assert.ok(page);
  const tool = page.messages.find((m) => m.role === "tool");
  assert.equal(tool?.output, "ls -la");
  const assistant = page.messages.find((m) => m.role === "assistant");
  assert.equal(assistant?.text, FULL_TEXT);
  assert.equal(assistant?._displayDegradeReason, "final_record_missing");
});

test("bash-tail probe never decodes bytes in SQL and survives invalid UTF-8 tool output", async () => {
  const tailBytes = poisonTailEventBytes();
  const semantic = recordBytes({ id: "rec-1", role: "assistant", text: "done", ts: 200 });
  const handlers: Array<[string, unknown]> = [
    ...baseHandlers({
      headerRows: [publishedHeader()],
      headRows: [{
        tape_id: "tape-failed",
        msg_id: "rec-1",
        ordinal: 9,
        role: "assistant",
        ts: "200",
        content_sha256: sha256(semantic),
        payload_bytes: String(semantic.length),
        visible_content_sha256: sha256(semantic),
      }],
      payloadRows: [{
        tape_id: "tape-failed",
        msg_id: "rec-1",
        ordinal: 9,
        role: "assistant",
        content_sha256: sha256(semantic),
        payload: semantic,
        visible_payload: semantic,
        visible_content_sha256: sha256(semantic),
      }],
    }),
    ["AS probe_bytes", { rows: [{
      tape_id: "tape-failed",
      msg_id: "rt-poison",
      ordinal: 7,
      role: "runtime-event",
      ts: "150",
      content_sha256: "e".repeat(64),
      payload_bytes: String(tailBytes.length),
      visible_content_sha256: sha256(tailBytes),
      probe_bytes: tailBytes,
    }] }],
    ["ordinal=ANY($4::int[])", { rows: [{
      msg_id: "rt-poison",
      ordinal: 7,
      role: "runtime-event",
      content_sha256: "e".repeat(64),
      payload: tailBytes,
      visible_payload: tailBytes,
      visible_content_sha256: sha256(tailBytes),
    }] }],
  ];
  const { page, sqlCalls } = await readPageCaptured(handlers);
  assert.ok(page);
  const tail = page.messages.find((m) => m._timelineAuxiliary === "bash-tail");
  assert.ok(tail, "bash-tail auxiliary must survive invalid UTF-8 bytes");
  assert.equal(String(tail?.text), "tail:\uFFFD\uFFFDA");
  assert.equal(page.messages.find((m) => m.role === "assistant")?.text, "done");
  assert.equal(
    sqlCalls.every((call) => !call.sql.includes("convert_from")),
    true,
    "no SQL-side UTF-8 decode may remain on the timeline read path",
  );
  const probe = sqlCalls.find((call) => call.sql.includes("AS probe_bytes"));
  assert.ok(probe, "sidecar-incomplete bypass must fetch raw bytes for a JS-side probe");
  assert.equal(probe.sql.includes("model_sidecar_complete=FALSE"), true);
  assert.equal(probe.sql.includes("strpos("), true);
  assert.equal(probe.sql.includes("convert_to('bash_output_tail','UTF8')"), true);
});

function twoTapeMessages() {
  return [
    {
      id: "user-1",
      role: "user",
      text: "hello",
      ts: 100,
      _seq: 1,
      _orderSeq: 1,
    },
    {
      id: "tape-anchor-poison",
      role: "assistant",
      text: FIRST_SENTENCE,
      ts: 200,
      _seq: 2,
      _orderSeq: 2,
      _turnTapeComplete: true,
      _turnTapeId: "tape-poison",
      _turnTapeSha256: "d".repeat(64),
    },
    {
      id: "tape-anchor-clean",
      role: "assistant",
      text: "clean turn",
      ts: 300,
      _seq: 3,
      _orderSeq: 3,
      _turnTapeComplete: true,
      _turnTapeId: "tape-clean",
      _turnTapeSha256: "c".repeat(64),
    },
  ];
}

test("invalid UTF-8 probe bytes on one tape leave other tapes on the page intact", async () => {
  const poisonTail = poisonTailEventBytes();
  const cleanTail = cleanTailEventBytes();
  const poisonSemantic = recordBytes({ id: "rec-poison", role: "assistant", text: "poison answer", ts: 200 });
  const cleanSemantic = recordBytes({ id: "rec-clean", role: "assistant", text: "clean answer", ts: 300 });
  const tailHydrateRows: Record<string, unknown[]> = {
    "tape-poison": [{
      msg_id: "rt-poison",
      ordinal: 7,
      role: "runtime-event",
      content_sha256: "e".repeat(64),
      payload: poisonTail,
      visible_payload: poisonTail,
      visible_content_sha256: sha256(poisonTail),
    }],
    "tape-clean": [{
      msg_id: "rt-clean",
      ordinal: 9,
      role: "runtime-event",
      content_sha256: "f".repeat(64),
      payload: cleanTail,
      visible_payload: cleanTail,
      visible_content_sha256: sha256(cleanTail),
    }],
  };
  const handlers: Array<[string, unknown]> = [
    ["SELECT messages,archived_through_seq,history_revision,timeline_generation", {
      rows: [{
        messages: JSON.stringify(twoTapeMessages()),
        archived_through_seq: 0,
        history_revision: "1",
        timeline_generation: "1",
      }],
    }],
    ["t.materialization_status, t.finalized_at::text, t.visible_head", { rows: [
      publishedHeader({
        tape_id: "tape-poison",
        tape_sha256: "d".repeat(64),
        turn_key: "1".repeat(64),
        visible_head: {
          role: "assistant",
          text: FULL_TEXT,
          ts: 200,
          messageId: "srv-poison",
        },
      }),
      publishedHeader({
        tape_id: "tape-clean",
        tape_sha256: "c".repeat(64),
        turn_key: "2".repeat(64),
        billing_anchor_id: "srv-clean",
        visible_head: {
          role: "assistant",
          text: "clean final",
          ts: 300,
          messageId: "srv-clean",
        },
      }),
    ] }],
    ["WITH requested(tape_id,before_ordinal)", { rows: [
      {
        tape_id: "tape-poison",
        msg_id: "rec-poison",
        ordinal: 8,
        role: "assistant",
        ts: "200",
        content_sha256: sha256(poisonSemantic),
        payload_bytes: String(poisonSemantic.length),
        visible_content_sha256: sha256(poisonSemantic),
      },
      {
        tape_id: "tape-clean",
        msg_id: "rec-clean",
        ordinal: 10,
        role: "assistant",
        ts: "300",
        content_sha256: sha256(cleanSemantic),
        payload_bytes: String(cleanSemantic.length),
        visible_content_sha256: sha256(cleanSemantic),
      },
    ] }],
    ["WITH selected(tape_id,ordinal)", { rows: [
      {
        tape_id: "tape-poison",
        msg_id: "rec-poison",
        ordinal: 8,
        role: "assistant",
        content_sha256: sha256(poisonSemantic),
        payload: poisonSemantic,
        visible_payload: poisonSemantic,
        visible_content_sha256: sha256(poisonSemantic),
      },
      {
        tape_id: "tape-clean",
        msg_id: "rec-clean",
        ordinal: 10,
        role: "assistant",
        content_sha256: sha256(cleanSemantic),
        payload: cleanSemantic,
        visible_payload: cleanSemantic,
        visible_content_sha256: sha256(cleanSemantic),
      },
    ] }],
    ["AS probe_bytes", { rows: [
      {
        tape_id: "tape-poison",
        msg_id: "rt-poison",
        ordinal: 7,
        role: "runtime-event",
        ts: "150",
        content_sha256: "e".repeat(64),
        payload_bytes: String(poisonTail.length),
        visible_content_sha256: sha256(poisonTail),
        probe_bytes: poisonTail,
      },
      {
        tape_id: "tape-clean",
        msg_id: "rt-clean",
        ordinal: 9,
        role: "runtime-event",
        ts: "150",
        content_sha256: "f".repeat(64),
        payload_bytes: String(cleanTail.length),
        visible_content_sha256: sha256(cleanTail),
        probe_bytes: cleanTail,
      },
      {
        // Defensive shape: unusable probe bytes must be skipped per tape
        // without touching any other tape on the same page.
        tape_id: "tape-clean",
        msg_id: "rt-null",
        ordinal: 11,
        role: "runtime-event",
        ts: "150",
        content_sha256: "0".repeat(64),
        payload_bytes: "1",
        visible_content_sha256: null,
        probe_bytes: null,
      },
    ] }],
    ["ordinal=ANY($4::int[])", (_sql: string, params: unknown[]) => ({
      rows: tailHydrateRows[String(params[2])] ?? [],
    })],
  ];
  const { page, sqlCalls } = await readPageCaptured(handlers, null, 4);
  assert.ok(page);
  const answers = page.messages
    .filter((m) => m.role === "assistant" && m._timelineAuxiliary !== "bash-tail")
    .map((m) => String(m.text));
  assert.deepEqual([...answers].sort(), ["clean answer", "poison answer"]);
  const tails = page.messages.filter((m) => m._timelineAuxiliary === "bash-tail");
  assert.equal(tails.length, 2);
  const cleanTailMessage = tails.find((m) => String(m.text).includes("CLEAN"));
  const poisonTailMessage = tails.find((m) => m.text !== cleanTailMessage?.text);
  assert.equal(cleanTailMessage?.text, "tail:CLEAN-OUTPUT");
  assert.equal(String(poisonTailMessage?.text).includes("\uFFFD"), true);
  assert.equal(String(poisonTailMessage?.text).includes("CLEAN"), false);
  assert.equal(page.messages.some((m) => m._displayDegradeReason === "final_record_missing"), false);
  assert.equal(sqlCalls.every((call) => !call.sql.includes("convert_from")), true);
});
