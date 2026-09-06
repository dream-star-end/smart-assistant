/**
 * 0277 — billing/apiKeyUsageReport 单测(fake pool,锁 SQL 形状 + 参数化 + key_id 校验)。
 *
 * 不起 PG:只断言五段查询都带 `user_id = $1`(无 IDOR)、`api_key_id IS NOT NULL`、
 * 钉单 key 时 `$3` 参数化(trend 段用已校验的数字字面量)、recent 段不按 status 过滤。
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { setPoolOverride, resetPool } from "../db/index.js";
import { getApiKeyUsageReport, parseApiKeyIdQuery } from "../billing/apiKeyUsageReport.js";

function fakePool(): { pool: Pool; queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const head = sql.trim().toUpperCase();
      if (head.startsWith("SELECT COUNT(*)::TEXT")) {
        return {
          rows: [{ requests: "2", input_tokens: "10", output_tokens: "5", cache_read_tokens: "0", cache_write_tokens: "0", credits: "3" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      throw new Error("not used");
    },
    async end() {},
  } as unknown as Pool;
  return { pool, queries };
}

afterEach(async () => {
  await resetPool();
});

describe("parseApiKeyIdQuery", () => {
  test("空 / null → 全部 key;合法数字 → 原串;非法 → ok:false", () => {
    assert.deepEqual(parseApiKeyIdQuery(null), { ok: true, keyId: null });
    assert.deepEqual(parseApiKeyIdQuery(""), { ok: true, keyId: null });
    assert.deepEqual(parseApiKeyIdQuery("42"), { ok: true, keyId: "42" });
    for (const bad of ["0", "-1", "abc", "1e3", "01", "1 OR 1=1", "99999999999999999999"]) {
      assert.deepEqual(parseApiKeyIdQuery(bad), { ok: false }, bad);
    }
  });
});

describe("getApiKeyUsageReport — SQL 形状", () => {
  test("全部 key:五段查询均限定 user_id=$1 + api_key_id IS NOT NULL;recent 不过滤 status", async () => {
    const { pool, queries } = fakePool();
    setPoolOverride(pool);
    const report = await getApiKeyUsageReport("7", "7d", null);
    assert.equal(report.window, "7d");
    assert.equal(report.key_id, null);
    assert.equal(report.summary.requests, "2");
    assert.deepEqual(report.by_key, []);
    assert.deepEqual(report.by_model, []);
    assert.deepEqual(report.recent, []);
    assert.equal(queries.length, 5, "summary / trend / by_key / by_model / recent");
    for (const q of queries) {
      assert.match(q.sql, /user_id\s*=\s*\$1/i, q.sql.slice(0, 80));
      assert.match(q.sql, /api_key_id\s+IS\s+NOT\s+NULL/i, q.sql.slice(0, 80));
      assert.equal(q.params[0], "7");
      assert.ok(!/\$3/.test(q.sql), "未钉 key 时不得出现 $3");
    }
    const recent = queries.find((q) => /ORDER BY u\.created_at DESC/i.test(q.sql))!;
    assert.ok(recent, "recent 段存在");
    assert.ok(!/status\s*=\s*'success'/i.test(recent.sql), "recent 段不按 status 过滤(失败请求也可见)");
    assert.match(recent.sql, /LIMIT 50/);
    const byKey = queries.find((q) => /GROUP BY u\.api_key_id/i.test(q.sql))!;
    assert.match(byKey.sql, /LEFT JOIN user_api_keys k/i);
    assert.match(byKey.sql, /revoked_at IS NOT NULL\)\s+AS revoked/i);
    assert.ok(!/key_hash/i.test(byKey.sql), "by_key 不得触碰 key_hash");
  });

  test("钉单 key:非 trend 段用 $3 参数;trend 段 extraWhere 是校验后的数字字面量", async () => {
    const { pool, queries } = fakePool();
    setPoolOverride(pool);
    const report = await getApiKeyUsageReport("7", "24h", "42");
    assert.equal(report.key_id, "42");
    const trend = queries.find((q) => /generate_series/i.test(q.sql))!;
    assert.ok(trend, "trend 段存在");
    assert.match(trend.sql, /api_key_id = 42\b/);
    assert.deepEqual(trend.params, ["7", 24]);
    for (const q of queries) {
      if (q === trend) continue;
      assert.match(q.sql, /api_key_id\s*=\s*\$3::bigint/i, q.sql.slice(0, 80));
      assert.deepEqual(q.params, ["7", 24, "42"]);
    }
  });

  test("未经校验的 keyId 直接抛(防御:caller 必须先 parseApiKeyIdQuery)", async () => {
    const { pool } = fakePool();
    setPoolOverride(pool);
    await assert.rejects(getApiKeyUsageReport("7", "7d", "1; DROP TABLE x"), /validated by caller/);
  });
});
