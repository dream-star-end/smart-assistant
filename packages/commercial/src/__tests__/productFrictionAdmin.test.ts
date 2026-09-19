import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { QueryRunner } from "../db/queries.js";
import { loadProblemCardAdminStats } from "../http/admin/audit.js";

describe("loadProblemCardAdminStats", () => {
  test("issues readonly problem-card funnel/decision/job/fallback aggregates", async () => {
    const sqls: string[] = [];
    const runner: QueryRunner = {
      async query(sql) {
        sqls.push(sql);
        return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      },
    };
    const stats = await loadProblemCardAdminStats(runner);
    assert.deepEqual(Object.keys(stats), ["funnel", "decisions", "jobs", "fallbacks"]);
    assert.deepEqual(Object.keys(stats.funnel), ["last_24h", "last_7d"]);
    assert.equal(sqls.length, 5);
    assert.match(sqls[0]!, /stage='problem_card'/);
    assert.match(sqls[0]!, /interval '24 hours'/);
    assert.match(sqls[0]!, /percentile_cont\(0\.5\) WITHIN GROUP/);
    assert.match(sqls[0]!, /LIMIT 100/);
    assert.match(sqls[1]!, /interval '7 days'/);
    assert.match(sqls[2]!, /stage='recovery_decision'/);
    assert.match(sqls[3]!, /stage='recovery_job'/);
    assert.match(sqls[4]!, /stage='visible_fallback'/);
    for (const sql of sqls) {
      assert.equal(/INSERT|UPDATE|DELETE|TRUNCATE/i.test(sql), false);
      assert.match(sql, /LIMIT 100/);
    }
  });
});
