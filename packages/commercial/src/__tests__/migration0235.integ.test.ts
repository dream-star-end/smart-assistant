import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { query } from "../db/queries.js";
import {
  flushDurableMetricRollups,
  observeDurableHistogram,
  resetDurableMetricRollupsForTest,
} from "../admin/durableMetricRollups.js";
import { evaluateTelemetryReadiness } from "../analytics/telemetryReadiness.js";
import { insertTurnObservation } from "../http/internalTurnObservation.js";
import { upsertResponseRating, upsertResponseRatingNudge } from "../responseRatings.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

useDedicatedTestDatabase("telemetry_0235_test");
const here = path.dirname(fileURLToPath(import.meta.url));
describe("0235 telemetry iteration closure", () => {
  test("creates privacy-safe aggregate/evidence tables and version columns", async () => {
    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_name=ANY($1::text[])
        ORDER BY table_name`,
      [[
        "response_rating_nudges",
        "telemetry_metric_rollups",
        "telemetry_readiness_evidence",
        "turn_runtime_observations",
        "turn_upstream_performance",
      ]],
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      "response_rating_nudges",
      "telemetry_metric_rollups",
      "telemetry_readiness_evidence",
      "turn_runtime_observations",
      "turn_upstream_performance",
    ]);
    const columns = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='turn_traces'
          AND column_name=ANY($1::text[])
        ORDER BY column_name`,
      [[
        "bundle_rev", "client_build", "control_plane_commit", "control_plane_release",
        "first_visible_at", "runtime_boot_hash", "runtime_source_commit", "runtime_total_ms",
      ]],
    );
    assert.equal(columns.rowCount, 8);
    const view = await query<{ kind: string }>(
      `SELECT table_type AS kind FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_name='turn_iteration_facts'`,
    );
    assert.equal(view.rows[0]?.kind, "VIEW");
  });

  test("absolute metric snapshots are keyed by process/bucket/series", async () => {
    const primary = await query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid='telemetry_metric_rollups'::regclass AND contype='p'`,
    );
    assert.match(
      primary.rows[0]!.definition,
      /process_run_id, bucket_start, metric, labels_hash/,
    );
  });

  test("unflushed eviction is exposed as a durable absolute loss counter", async () => {
    const saved = process.env.OC_DURABLE_METRIC_ROLLUPS;
    process.env.OC_DURABLE_METRIC_ROLLUPS = "1";
    try {
      const startedAt = 1_780_000_000_000;
      assert.equal(observeDurableHistogram(
        "anthropic_proxy_ttft_seconds",
        "gpt-5.6-sol",
        [0.5, 1, 2],
        0.75,
        startedAt,
      ), true);
      assert.equal(observeDurableHistogram(
        "anthropic_proxy_ttft_seconds",
        "gpt-5.6-sol",
        [0.5, 1, 2],
        0.8,
        startedAt + 10 * 60_000,
      ), true);
      await flushDurableMetricRollups();
      const loss = await query<{ counter_value: string }>(
        `SELECT counter_value::text FROM telemetry_metric_rollups
          WHERE metric='telemetry_rollup_dropped_series_total'
          ORDER BY updated_at DESC LIMIT 1`,
      );
      assert.equal(loss.rows[0]!.counter_value, "1");
    } finally {
      resetDurableMetricRollupsForTest();
      if (saved === undefined) delete process.env.OC_DURABLE_METRIC_ROLLUPS;
      else process.env.OC_DURABLE_METRIC_ROLLUPS = saved;
    }
  });

  test("duplicate runtime event has no trace-update side effect", async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users(email,email_verified,password_hash,role,credits,status)
       VALUES ('telemetry-turn-idempotency@example.test',TRUE,'x','user',1000,'active')
       RETURNING id::text`,
    );
    const traceId = "1".repeat(32);
    await query(
      `INSERT INTO turn_traces(trace_id,user_id,session_key)
       VALUES ($1,$2,'agent:main:webchat:dm:telemetry-idempotency')`,
      [traceId, user.rows[0]!.id],
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
    const body = {
      schemaVersion: 1 as const,
      eventId: "turn-event-idempotent",
      sessionKey: "agent:main:webchat:dm:telemetry-idempotency",
      agentId: "main",
      traceId,
      model: "gpt-5.6-sol",
      durationMs: 100,
      toolCalls: 1,
      runtimeSourceCommit: "2".repeat(40),
      runtimeBootHash: "3".repeat(12),
      timestamp: Date.now(),
    };
    assert.deepEqual(await insertTurnObservation(
      deps,
      Number(user.rows[0]!.id),
      null as unknown as number,
      body,
    ), {
      duplicate: false,
    });
    await query(
      `UPDATE turn_traces
          SET runtime_total_ms=NULL,runtime_tool_calls=NULL,runtime_observed_at=NULL
        WHERE trace_id=$1`,
      [traceId],
    );
    assert.deepEqual(await insertTurnObservation(deps, Number(user.rows[0]!.id), null as unknown as number, {
      ...body,
      durationMs: 999,
      toolCalls: 9,
    }), { duplicate: true });
    const trace = await query<{ runtime_total_ms: number | null; runtime_tool_calls: number | null }>(
      `SELECT runtime_total_ms,runtime_tool_calls FROM turn_traces WHERE trace_id=$1`,
      [traceId],
    );
    assert.equal(trace.rows[0]!.runtime_total_ms, null);
    assert.equal(trace.rows[0]!.runtime_tool_calls, null);
  });

  test("release metadata registers the claimed migration", async () => {
    const metadata = JSON.parse(
      await readFile(path.resolve(here, "../../../../deploy/v5/release-metadata.json"), "utf8"),
    ) as { requiredMigrations: string[] };
    assert.ok(metadata.requiredMigrations.includes("0235_telemetry_iteration_closure"));
  });

  test("rating nudge exposure is cross-refresh idempotent and later explicit rating wins", async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users(email,email_verified,password_hash,role,credits,status)
       VALUES ('telemetry-nudge@example.test',TRUE,'x','user',1000,'active')
       RETURNING id::text`,
    );
    const input = {
      userId: user.rows[0]!.id,
      messageId: "assistant-message-1",
      sessionId: "session-nudge",
      traceId: null,
      clientBuild: "abcdef123456",
      sampleBucket: 0,
      action: "expose" as const,
    };
    assert.deepEqual(await upsertResponseRatingNudge(input), {
      state: "exposed", newlyExposed: true,
    });
    assert.deepEqual(await upsertResponseRatingNudge(input), {
      state: "exposed", newlyExposed: false,
    });
    await upsertResponseRatingNudge({ ...input, action: "dismiss" });
    await upsertResponseRating({
      userId: user.rows[0]!.id,
      sessionId: "session-nudge",
      messageId: "assistant-message-1",
      traceId: null,
      model: "gpt-5.6-sol",
      rating: "up",
      tags: [],
      comment: null,
    });
    const row = await query<{ state: string }>(
      `SELECT state FROM response_rating_nudges WHERE user_id=$1 AND message_id=$2`,
      [user.rows[0]!.id,"assistant-message-1"],
    );
    assert.equal(row.rows[0]!.state, "rated");
  });

  test("concurrent rating and exposure never leave an already-rated message exposed", async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users(email,email_verified,password_hash,role,credits,status)
       VALUES ('telemetry-race@example.test',TRUE,'x','user',1000,'active')
       RETURNING id::text`,
    );
    for (let index = 0; index < 5; index += 1) {
      const messageId = `assistant-race-${index}`;
      await Promise.all([
        upsertResponseRatingNudge({
          userId: user.rows[0]!.id,
          messageId,
          sessionId: "session-race",
          traceId: null,
          clientBuild: "abcdef123456",
          sampleBucket: 0,
          action: "expose",
        }),
        upsertResponseRating({
          userId: user.rows[0]!.id,
          sessionId: "session-race",
          messageId,
          traceId: null,
          model: "gpt-5.6-sol",
          rating: "up",
          tags: [],
          comment: null,
        }),
      ]);
      const state = await query<{ rating: string; state: string | null }>(
        `SELECT r.rating,n.state
           FROM response_rating r
           LEFT JOIN response_rating_nudges n
             ON n.user_id=r.user_id AND n.message_id=r.message_id
          WHERE r.user_id=$1 AND r.message_id=$2`,
        [user.rows[0]!.id, messageId],
      );
      assert.equal(state.rows[0]!.rating, "up");
      assert.notEqual(state.rows[0]!.state, "exposed");
    }
  });

  test("Auto-Dream readiness is executable, evidenced and fail-closed on empty signals", async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users(email,email_verified,password_hash,role,credits,status)
       VALUES ('telemetry-ready@example.test',TRUE,'x','user',1000,'active')
       RETURNING id::text`,
    );
    const result = await evaluateTelemetryReadiness(user.rows[0]!.id);
    assert.equal(result.ready, false);
    assert.ok(result.blockers.includes("completed_sample"));
    assert.ok(result.blockers.includes("explicit_rating_sample"));
    await evaluateTelemetryReadiness(user.rows[0]!.id);
    const evidence = await query<{ ready: boolean; blockers: string[] }>(
      `SELECT ready,blockers FROM telemetry_readiness_evidence
        WHERE user_id=$1 ORDER BY created_at`,
      [user.rows[0]!.id],
    );
    assert.equal(evidence.rowCount, 2);
    assert.equal(evidence.rows[0]!.ready, false);
    assert.ok(evidence.rows[0]!.blockers.length >= 5);
  });
});
