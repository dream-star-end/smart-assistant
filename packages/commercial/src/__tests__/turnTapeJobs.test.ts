import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { enqueueMaterializationJob } from "../db/turnTapeJobs.js";

function inListStatuses(sql: string, column: "status" | "next_attempt_at"): string[] {
  const pattern = new RegExp(
    `${column} = CASE\\s+WHEN turn_tape_materialization_jobs\\.status IN \\(([^)]+)\\)`,
    "i",
  );
  const match = sql.match(pattern);
  assert.ok(match, `expected ON CONFLICT CASE for ${column}`);
  return match[1]!.split(",").map((item) => item.trim().replace(/'/g, ""));
}

describe("enqueueMaterializationJob SQL", () => {
  test("ON CONFLICT keeps an in-flight leased row leased and does not pull next_attempt_at", async () => {
    let captured = "";
    const q = {
      async query(sql: string) {
        captured = sql;
        return { rowCount: 1, rows: [] };
      },
    };
    await enqueueMaterializationJob(q as never, {
      sessionId: "s-1",
      userId: "c:1",
      tapeId: "t".repeat(64),
    });
    const statusKeep = inListStatuses(captured, "status");
    const nextKeep = inListStatuses(captured, "next_attempt_at");
    for (const status of ["complete", "failed", "leased"]) {
      assert.ok(statusKeep.includes(status), `status CASE must keep ${status}`);
      assert.ok(nextKeep.includes(status), `next_attempt_at CASE must keep ${status}`);
    }
    assert.match(
      captured,
      /ELSE LEAST\(turn_tape_materialization_jobs\.next_attempt_at, NOW\(\)\)/,
    );
  });
});

describe("Phase B enqueue wiring", () => {
  test("finalizeLosslessTurnTape only enqueues on HTTP materialize:false, not on worker Phase B", () => {
    const srcPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../db/pgSessionsBackend.ts",
    );
    const src = readFileSync(srcPath, "utf8");
    const marker = "async finalizeLosslessTurnTape(";
    const start = src.indexOf(marker);
    assert.ok(start >= 0, "finalizeLosslessTurnTape missing");
    const slice = src.slice(start, start + 2500);
    assert.ok(
      slice.includes("enqueueMaterialization: finalizeOptions?.materialize === false"),
      "Phase B must pass enqueueMaterialization based on materialize:false (HTTP create) vs worker suppress",
    );
    const visibleMarker = "async commitVisibleLosslessTurnTape(";
    const visibleStart = src.indexOf(visibleMarker);
    assert.ok(visibleStart >= 0);
    const visibleSlice = src.slice(visibleStart, visibleStart + 800);
    assert.ok(
      visibleSlice.includes("enqueueMaterialization: false"),
      "HTTP action:visible must keep enqueueMaterialization: false",
    );
  });
});
