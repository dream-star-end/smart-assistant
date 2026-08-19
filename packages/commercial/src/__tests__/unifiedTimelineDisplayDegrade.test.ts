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
  return backend.getClientSession(SESSION_ID, USER_ID, { view: "timeline" });
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
  assert.equal(assistant[0]?._displayDegradeReason, "records_unpublished");
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
