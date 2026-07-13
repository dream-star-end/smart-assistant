import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  startIncidentSweeper,
  type SweeperDeps,
} from "../selfheal/sweeper.js";

describe("selfheal incident user-delivery gate", () => {
  it("sweeper never snapshots active incidents and only retires legacy deliveries", async () => {
    const previous = process.env.OC_SELFHEAL_DISPATCH_DISABLED;
    process.env.OC_SELFHEAL_DISPATCH_DISABLED = "1";
    const sql: string[] = [];
    const query = (async (statement: string) => {
      sql.push(statement.replace(/\s+/g, " ").trim());
      return { rows: [], rowCount: 0 };
    }) as unknown as NonNullable<SweeperDeps["query"]>;
    const handle = startIncidentSweeper({ intervalMs: 60_000, query });

    try {
      const result = await handle.runNow();
      assert.deepEqual(result, { ws: 0, inbox: 0, errors: 0 });
      assert.ok(sql.some((s) => s.includes("UPDATE incident_deliveries SET status='failed'")));
      assert.ok(!sql.some((s) => /FROM incidents\b/i.test(s)), "must not build a user incident snapshot");
      assert.ok(!sql.some((s) => /inbox_messages/i.test(s)), "must not create user inbox notices");
    } finally {
      await handle.stop();
      process.env.OC_SELFHEAL_DISPATCH_DISABLED = previous;
    }
  });
});
