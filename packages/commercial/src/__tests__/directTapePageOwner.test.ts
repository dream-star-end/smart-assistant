import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";

import { hydrateDirectTapePage, listTurnTapeRecordsImpl } from "../db/pgSessionsBackend.js";

async function reconcile(rows: unknown[]) {
  const persistUrl = "../../../web-react/src/lib/persist.ts";
  const mod = await import(persistUrl) as {
    reconcileLateDelegateAgentGroups: (messages: unknown[]) => Array<{ id: string }>;
  };
  return mod.reconcileLateDelegateAgentGroups(rows);
}

const OWNER_TURN_KEY = "a".repeat(64);
const CONTINUATION_TURN_KEY = "c".repeat(64);

function deferredHead(runId: string) {
  return {
    msg_id: `srv-late-agentgroup-${runId}`,
    ordinal: 1,
    role: "agent-group",
    ts: "1720000000000",
    content_sha256: "d".repeat(64),
    payload_bytes: String(1_100_000),
    visible_content_sha256: null as string | null,
  };
}

describe("OCV5-180 B1 direct-page hydrate owner (R1-3)", () => {
  test("hydrateDirectTapePage deferred locator carries header owner, not a pre-stamped fixture", async () => {
    const pool = {
      query: async () => {
        throw new Error("unexpected SQL");
      },
    } as unknown as Pool;
    const [late] = await hydrateDirectTapePage(
      pool,
      "sess-owner",
      "c:1",
      "late-tape",
      "e".repeat(64),
      "anchor-1",
      [deferredHead("dlg-late-1")],
      { continuationOfTurnKey: OWNER_TURN_KEY },
    );
    assert.equal(late?._payloadDeferred, true);
    assert.equal(late?._payloadBytes, 1_100_000);
    assert.equal(late?._continuationOfTurnKey, OWNER_TURN_KEY);
    assert.equal(late?._delegateRunId, "dlg-late-1");
    assert.equal(late?._turnTapeId, "late-tape");
    assert.equal(late?._recordOrdinal, 1);
    const rows = [
      { id: "t1", role: "assistant", text: "T1", _turnKey: OWNER_TURN_KEY },
      { id: "t2-user", role: "user", text: "T2" },
      late,
    ];
    assert.deepEqual(
      (await reconcile(rows)).map((row) => row.id),
      ["t1", late!.id, "t2-user"],
    );
  });

  test("listTurnTapeRecordsImpl forward and before stamp continuation owner from header SELECT", async () => {
    const headerSql: string[] = [];
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("continuation_of_turn_key") && sql.includes("client_session_turn_tapes")) {
          headerSql.push(sql);
          return {
            rows: [{
              tape_sha256: "e".repeat(64),
              billing_anchor_id: "anchor-1",
              physical_record_count: "2",
              logical_record_count: "2",
              continuation_of_turn_key: OWNER_TURN_KEY,
            }],
          };
        }
        if (sql.includes("client_session_turn_tape_records")) {
          return { rows: [deferredHead("dlg-page-1")] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    } as unknown as Pool;
    const forward = await listTurnTapeRecordsImpl(pool, "sess-owner", "c:1", "late-tape", 0, 20);
    const before = await listTurnTapeRecordsImpl(pool, "sess-owner", "c:1", "late-tape", 0, 20, null);
    assert.equal(headerSql.length, 2);
    assert.equal(forward?.records[0]?._continuationOfTurnKey, OWNER_TURN_KEY);
    assert.equal(forward?.records[0]?._delegateRunId, "dlg-page-1");
    assert.equal(forward?.records[0]?._payloadDeferred, true);
    assert.equal(before?.records[0]?._continuationOfTurnKey, OWNER_TURN_KEY);
    const late = forward!.records[0]!;
    const t2 = { id: "t2-user", role: "user", text: "T2" };
    const waiting = await reconcile([t2, late]);
    assert.deepEqual(waiting.map((row) => row.id), ["t2-user", late.id]);
    const t1 = { id: "t1", role: "assistant", text: "T1", _turnKey: OWNER_TURN_KEY };
    const merged = await reconcile([t1, t2, late]);
    assert.deepEqual(merged.map((row) => row.id), ["t1", late.id, "t2-user"]);
    assert.equal(CONTINUATION_TURN_KEY.length, 64);
  });
});
