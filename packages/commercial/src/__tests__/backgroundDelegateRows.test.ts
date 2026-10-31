import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { hydrateDirectTapePage, listTurnTapeRecordsImpl } from "../db/pgSessionsBackend.js";
import { materializeLosslessTurn } from "../http/losslessTurnTape.js";

test("background group retains passive delivery and cancelled state in its immutable row", () => {
  const group = { runId: "dlg-bg", agentId: "coding-assistant", goal: "校验", status: "failed", background: true, cancelled: true, jobId: "dlgjob-finished",
    completedAt: 1_783_944_000_000, resultSummary: "已停止", transcript: [{ kind: "text", text: "已完成的部分" }] };
  const materialized = materializeLosslessTurn({ sessionId: "web-bg-fixture", agentId: "main", turnIndex: 1, turnKey: "a".repeat(64),
    status: "completed", text: "", createdAt: group.completedAt, agentGroups: [group] });
  const row = materialized.records.find((record) => record.payload.role === "agent-group")!.payload;
  assert.equal(row._backgroundDelegate, true); assert.equal(row.cancelled, true); assert.equal(row._delegateJobId, group.jobId);
  assert.deepEqual(row.childBlocks, group.transcript);
  const bytes = materialized.records.find((record) => record.payload.role === "agent-group")!.payloadBytes;
  assert.ok(bytes.includes(Buffer.from('"_delegateRunId":"dlg-bg","_backgroundDelegate":true,"_delegateJobId":"dlgjob-finished"')));
  assert.equal(Buffer.from(JSON.stringify({ text: '"_delegateRunId":"dlg-bg","_backgroundDelegate":true' }))
    .includes(Buffer.from('"_delegateRunId":"dlg-bg","_backgroundDelegate":true')), false);
});

const head = () => ({ msg_id: "srv-late-agentgroup-dlg-bg", ordinal: 1, role: "agent-group", ts: "1720000000000",
  content_sha256: "d".repeat(64), payload_bytes: "1100000", visible_content_sha256: null, background_delegate: true, background_delegate_job_id: "dlgjob-finished" });

test("oversized background result keeps its small marker before Range hydration", async () => {
  const pool = { query: async () => { throw new Error("locator hydration must not download the body"); } } as unknown as Pool;
  const [row] = await hydrateDirectTapePage(pool, "web-bg-fixture", "c:1", "tape", "e".repeat(64), "anchor", [head()]);
  assert.equal(row?._backgroundDelegate, true); assert.equal(row?._payloadDeferred, true); assert.equal(row?._delegateJobId, "dlgjob-finished");
});

test("forward and reverse record-page SQL select only the background boolean for group locators", async () => {
  const seen: string[] = [];
  const pool = { query: async (sql: string) => {
    if (sql.includes("continuation_of_turn_key") && sql.includes("client_session_turn_tapes")) return { rows: [{ tape_sha256: "e".repeat(64),
      billing_anchor_id: "anchor", physical_record_count: "2", logical_record_count: "2", continuation_of_turn_key: "a".repeat(64) }] };
    if (sql.includes("client_session_turn_tape_records")) {
      seen.push(sql); assert.match(sql, /AS background_delegate/); assert.match(sql, /role='agent-group'/); assert.match(sql, /position\(convert_to/); assert.doesNotMatch(sql, /convert_from/);
      return { rows: [head()] };
    }
    throw new Error("unexpected query");
  } } as unknown as Pool;
  for (const before of [undefined, null]) {
    const page = await listTurnTapeRecordsImpl(pool, "web-bg-fixture", "c:1", "tape", 0, 20, before);
    assert.equal(page?.records[0]?._backgroundDelegate, true); assert.equal(page?.records[0]?._payloadDeferred, true);
    assert.equal(page?.records[0]?._delegateJobId, "dlgjob-finished");
  }
  assert.equal(seen.length, 2);
});
