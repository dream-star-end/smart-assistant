import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { query } from "../db/queries.js";
import { insertTurnObservation, type TurnObservationBody } from "../http/internalTurnObservation.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

useDedicatedTestDatabase("context_eval_0353_test");

describe("0353 context eval observability", () => {
  test("creates context_eval_events table, indexes, and constraints", async () => {
    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'context_eval_events'`,
    );
    assert.deepEqual(
      tables.rows.map((r) => r.table_name),
      ["context_eval_events"],
    );

    const indexes = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'context_eval_events'
        ORDER BY indexname`,
    );
    const names = indexes.rows.map((r) => r.indexname);
    assert.ok(names.includes("idx_context_eval_events_user_time"));
    assert.ok(names.includes("idx_context_eval_events_kind_time"));
    assert.ok(names.includes("idx_context_eval_events_trace_time"));
    assert.ok(names.includes("idx_context_eval_events_commit_time"));

    const commitCol = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'context_eval_events'
          AND column_name = 'runtime_source_commit'`,
    );
    assert.equal(commitCol.rowCount, 1);
  });

  test("insertTurnObservation persists context_eval_events idempotently and backfills on duplicate outer turn", async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users(email,email_verified,password_hash,role,credits,status)
       VALUES ('context-eval-0353@example.test',TRUE,'x','user',1000,'active')
       RETURNING id::text`,
    );
    const userId = Number(user.rows[0]!.id);
    const traceId = "a".repeat(32);
    const dispatchId = "11111111-2222-4333-8444-555555555555";
    await query(
      `INSERT INTO turn_dispatches(
         dispatch_id, user_id, session_id, client_message_id, agent_id, model,
         request_hash, billing_request_id, status
       ) VALUES ($1, $2, 'sess-0353', 'msg-0353', 'main', 'gpt-5.6-sol', $3, 'bill-0353', 'accepted')`,
      [dispatchId, userId, "e".repeat(64)],
    );
    await query(
      `INSERT INTO turn_traces(trace_id,user_id,session_key,dispatch_id)
       VALUES ($1,$2,'agent:main:webchat:dm:0353',$3)`,
      [traceId, userId, dispatchId],
    );

    const deps = {
      identityRepo: {} as never,
      queryRunner: {
        async query<Row>(sql: string, params?: readonly unknown[]) {
          const result = await query(sql, params);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
      },
    };
    const now = Date.now();
    const baseBody: TurnObservationBody = {
      schemaVersion: 1,
      eventId: "turn-0353-evt-1",
      sessionKey: "agent:main:webchat:dm:0353",
      agentId: "main",
      traceId,
      model: "gpt-5.6-sol",
      durationMs: 250,
      toolCalls: 1,
      timestamp: now,
      contextEvents: [
        {
          eventId: "ctx-0353-decision-1",
          eventKind: "prompt_context_decision",
          engine: "antigravity",
          decision: "full_inject",
          reason: "inputs_changed",
          changedSlots: ["SOUL", "TOOLS"],
          staticPrefixSha256: "b".repeat(64),
          totalBytes: 12345,
          tokensEstimate: 3087,
          observedAt: now,
        },
      ],
    };

    assert.deepEqual(
      await insertTurnObservation(deps, userId, null as unknown as number, baseBody),
      { duplicate: false },
    );

    // Duplicate outer turn_runtime_observations eventId MUST still idempotently backfill new contextEvents
    assert.deepEqual(
      await insertTurnObservation(deps, userId, null as unknown as number, {
        ...baseBody,
        contextEvents: [
          baseBody.contextEvents![0]!,
          {
            eventId: "ctx-0353-compact-1",
            eventKind: "context_compacted",
            engine: "antigravity",
            compactionScope: "launch_prompt",
            compactionStrategy: "history_suffix",
            beforeBytes: 200000,
            afterBytes: 90000,
            droppedEntries: 4,
            observedAt: now + 10,
          },
        ],
      }),
      { duplicate: true },
    );

    const rows = await query<{
      event_id: string;
      event_kind: string;
      dispatch_id: string | null;
      decision: string | null;
      changed_slots: string[] | null;
      compaction_strategy: string | null;
      dropped_entries: number | null;
    }>(
      `SELECT event_id, event_kind, dispatch_id::text, decision, changed_slots, compaction_strategy, dropped_entries
         FROM context_eval_events
        WHERE user_id = $1
        ORDER BY event_id`,
      [userId],
    );
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.rows[0]!.event_id, "ctx-0353-compact-1");
    assert.equal(rows.rows[0]!.event_kind, "context_compacted");
    assert.equal(rows.rows[0]!.dispatch_id, dispatchId);
    assert.equal(rows.rows[0]!.compaction_strategy, "history_suffix");
    assert.equal(rows.rows[0]!.dropped_entries, 4);

    assert.equal(rows.rows[1]!.event_id, "ctx-0353-decision-1");
    assert.equal(rows.rows[1]!.event_kind, "prompt_context_decision");
    assert.equal(rows.rows[1]!.dispatch_id, dispatchId);
    assert.equal(rows.rows[1]!.decision, "full_inject");
    assert.deepEqual(rows.rows[1]!.changed_slots, ["SOUL", "TOOLS"]);

    // Reject invalid event_kind via CHECK constraint
    await assert.rejects(
      () =>
        query(
          `INSERT INTO context_eval_events(event_id, user_id, session_key, agent_id, event_kind, observed_at)
           VALUES ('bad-kind', $1, 's', 'main', 'invalid_kind', NOW())`,
          [userId],
        ),
    );
  });

  test("contextOnly never pollutes turn_traces/turn_runtime_observations and real turn backfills late dispatch_id + runtime_source_commit", async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users(email,email_verified,password_hash,role,credits,status)
       VALUES ('context-eval-0353-reconcile@example.test',TRUE,'x','user',1000,'active')
       RETURNING id::text`,
    );
    const userId = Number(user.rows[0]!.id);
    const traceId = "f".repeat(32);
    const dispatchId = "22222222-3333-4444-8555-666666666666";
    const commitSha = "9".repeat(40);
    const deps = {
      identityRepo: {} as never,
      queryRunner: {
        async query<Row>(sql: string, params?: readonly unknown[]) {
          const result = await query(sql, params);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
      },
    };
    const now = Date.now();

    // 1. contextOnly carrier arrives BEFORE turn_traces exists
    const ctxOnlyRes = await insertTurnObservation(deps, userId, null as unknown as number, {
      schemaVersion: 1,
      eventId: "ctx-batch-early-1",
      sessionKey: "agent:main:webchat:dm:reconcile",
      agentId: "main",
      traceId,
      durationMs: 0,
      toolCalls: 0,
      timestamp: now,
      contextOnly: true,
      contextEvents: [
        {
          eventId: "ctx-early-1",
          eventKind: "prompt_context_decision",
          engine: "antigravity",
          decision: "elide_resumed",
          reason: "elided",
          observedAt: now,
        },
      ],
    });
    assert.deepEqual(ctxOnlyRes, { duplicate: false });

    const troBefore = await query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM turn_runtime_observations WHERE user_id = $1`,
      [userId],
    );
    assert.equal(troBefore.rows[0]!.cnt, "0", "contextOnly must never insert turn_runtime_observations");

    const ceeBefore = await query<{ dispatch_id: string | null; runtime_source_commit: string | null }>(
      `SELECT dispatch_id::text, runtime_source_commit FROM context_eval_events WHERE event_id = 'ctx-early-1'`,
    );
    assert.equal(ceeBefore.rows[0]!.dispatch_id, null);
    assert.equal(ceeBefore.rows[0]!.runtime_source_commit, null);

    // 2. turn_traces lands, followed by the real completed turn with real durationMs=420 and runtimeSourceCommit
    await query(
      `INSERT INTO turn_dispatches(
         dispatch_id, user_id, session_id, client_message_id, agent_id, model,
         request_hash, billing_request_id, status
       ) VALUES ($1, $2, 'sess-reconcile', 'msg-reconcile', 'main', 'gpt-5.6-sol', $3, 'bill-reconcile', 'accepted')`,
      [dispatchId, userId, "d".repeat(64)],
    );
    await query(
      `INSERT INTO turn_traces(trace_id, user_id, session_key, dispatch_id)
       VALUES ($1, $2, 'agent:main:webchat:dm:reconcile', $3)`,
      [traceId, userId, dispatchId],
    );

    await insertTurnObservation(deps, userId, null as unknown as number, {
      schemaVersion: 1,
      eventId: "turn-real-reconcile-1",
      sessionKey: "agent:main:webchat:dm:reconcile",
      agentId: "main",
      traceId,
      model: "gpt-5.6-sol",
      durationMs: 420,
      toolCalls: 3,
      runtimeSourceCommit: commitSha,
      timestamp: now + 500,
    });

    const traceRow = await query<{ runtime_total_ms: string | number | null; runtime_tool_calls: number | null }>(
      `SELECT runtime_total_ms, runtime_tool_calls FROM turn_traces WHERE trace_id = $1`,
      [traceId],
    );
    assert.equal(Number(traceRow.rows[0]!.runtime_total_ms), 420, "turn_traces must keep real duration, never 0");
    assert.equal(traceRow.rows[0]!.runtime_tool_calls, 3);

    const ceeAfter = await query<{ dispatch_id: string | null; runtime_source_commit: string | null }>(
      `SELECT dispatch_id::text, runtime_source_commit FROM context_eval_events WHERE event_id = 'ctx-early-1'`,
    );
    assert.equal(ceeAfter.rows[0]!.dispatch_id, dispatchId);
    assert.equal(ceeAfter.rows[0]!.runtime_source_commit, commitSha);
  });
});
