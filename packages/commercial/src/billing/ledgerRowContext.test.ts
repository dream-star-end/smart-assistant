import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadLedgerRowContext, type LedgerContextQuery } from "./ledgerRowContext.js";

describe("loadLedgerRowContext (#1237 账单流水行的模型名/会话标题)", () => {
  test("只查本人 usage_record 引用;按 ledger id 回填,可多条 ledger 指向同一 usage", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const q: LedgerContextQuery = async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [
          { usage_id: "29026", model_name: "GPT-6-Astra", session_title: "  Kyoto trip  " },
          { usage_id: "28992", model_name: "kimi-k3", session_title: null },
        ],
      };
    };
    const out = await loadLedgerRowContext(q, "1614", [
      { id: "26710", ref_type: "usage_record", ref_id: "29026" },
      { id: "26711", ref_type: "usage_record", ref_id: "29026" },
      { id: "26600", ref_type: "usage_record", ref_id: "28992" },
      { id: "26500", ref_type: "subscription", ref_id: "29026" },
      { id: "26400", ref_type: "usage_record", ref_id: "not-a-number" },
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, ["1614", ["29026", "28992"], ["c:1614", "1614"]]);
    assert.match(calls[0].sql, /ur\.user_id = \$1/);
    assert.match(calls[0].sql, /cs\.deleted_at IS NULL/);
    assert.deepEqual(out.get("26710"), { model_name: "GPT-6-Astra", session_title: "Kyoto trip" });
    assert.deepEqual(out.get("26711"), { model_name: "GPT-6-Astra", session_title: "Kyoto trip" });
    assert.deepEqual(out.get("26600"), { model_name: "kimi-k3", session_title: null });
    assert.equal(out.has("26500"), false);
    assert.equal(out.has("26400"), false);
  });

  test("页内没有 usage_record 行时不发查询", async () => {
    let called = false;
    const out = await loadLedgerRowContext(async () => {
      called = true;
      return { rows: [] };
    }, "1", [{ id: "1", ref_type: null, ref_id: null }]);
    assert.equal(called, false);
    assert.equal(out.size, 0);
  });
});
