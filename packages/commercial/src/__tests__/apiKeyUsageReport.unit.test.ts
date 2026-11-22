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
import {
  getApiKeyUsageReport,
  listApiKeyUsageRecent,
  parseApiKeyIdQuery,
  USAGE_RECENT_PAGE_MAX_LIMIT,
} from "../billing/apiKeyUsageReport.js";

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
    const recent = queries.find((q) => /ORDER BY u\.id DESC/i.test(q.sql))!;
    assert.ok(recent, "recent 段存在且按 u.id DESC 排序(与分页端点排序键一致)");
    assert.ok(!/ORDER BY u\.created_at/i.test(recent.sql), "首屏 recent 不得再按 created_at 混序");
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

/**
 * listApiKeyUsageRecent — 最近明细游标分页的 SQL 形状。
 *
 * 关键不变量:user_id=$1 双重限定、api_key_id IS NOT NULL、**不过滤 status**、
 * 排序键与游标同为单列 `u.id`(复合排序会让单值 before 漏行/重行)、多取一行判 next_before、
 * keyId/beforeId 全参数化,未经校验的值直接抛。
 */
describe("listApiKeyUsageRecent — SQL 形状与游标语义", () => {
  /** 造 n 行、id 从 startId 递减(模拟 ORDER BY u.id DESC 的结果集)。 */
  function rowsPool(count: number, startId = 500): { pool: Pool; queries: { sql: string; params: unknown[] }[] } {
    const queries: { sql: string; params: unknown[] }[] = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        const limit = Number(params[params.length - 1]);
        const rows = Array.from({ length: Math.min(count, limit) }, (_, i) => ({
          id: String(startId - i),
          created_at: "2026-09-08T00:00:00.000Z",
          api_key_id: "11",
          label: "k",
          model: "cursor-haiku-4.5",
          input_tokens: "1",
          output_tokens: "1",
          cache_read_tokens: "0",
          cache_write_tokens: "0",
          cost_credits: "3",
          status: "success",
        }));
        return { rows, rowCount: rows.length };
      },
      async connect() { throw new Error("not used"); },
      async end() {},
    } as unknown as Pool;
    return { pool, queries };
  }

  test("全部 key:user_id=$1 + api_key_id IS NOT NULL + 不过滤 status + ORDER BY u.id DESC", async () => {
    const { pool, queries } = rowsPool(3);
    setPoolOverride(pool);
    const page = await listApiKeyUsageRecent("7", "7d", null, { limit: 10 });
    assert.equal(queries.length, 1);
    const { sql, params } = queries[0]!;
    assert.match(sql, /u\.user_id\s*=\s*\$1/i);
    assert.match(sql, /u\.api_key_id\s+IS\s+NOT\s+NULL/i);
    assert.match(sql, /ORDER BY u\.id DESC/i);
    assert.ok(!/status\s*=\s*'success'/i.test(sql), "不得过滤 status(失败请求也要可见)");
    assert.ok(!/key_hash/i.test(sql), "不得触碰 key_hash");
    // 多取一行判有没有下一页。
    assert.deepEqual(params, ["7", 168, 11]);
    assert.equal(page.window, "7d");
    assert.equal(page.key_id, null);
    assert.equal(page.entries.length, 3);
    assert.equal(page.next_before, null, "结果不足一页 → 到底");
  });

  test("满页 → next_before = 本页最后一行 id;多取的那一行不进 entries", async () => {
    const { pool } = rowsPool(100, 500);
    setPoolOverride(pool);
    const page = await listApiKeyUsageRecent("7", "24h", null, { limit: 5 });
    assert.deepEqual(page.entries.map((e) => e.id), ["500", "499", "498", "497", "496"]);
    assert.equal(page.next_before, "496");
  });

  test("keyId / beforeId 全参数化;窗口小时数进 $2", async () => {
    const { pool, queries } = rowsPool(1);
    setPoolOverride(pool);
    const page = await listApiKeyUsageRecent("7", "30d", "42", { beforeId: "900", limit: 20 });
    const { sql, params } = queries[0]!;
    assert.match(sql, /u\.api_key_id\s*=\s*\$3::bigint/i);
    assert.match(sql, /u\.id\s*<\s*\$4::bigint/i);
    assert.deepEqual(params, ["7", 720, "42", "900", 21]);
    assert.equal(page.key_id, "42");
    // 字面量拼接会让这两个值出现在 SQL 文本里 —— 断言它们只在参数里。
    assert.ok(!/42/.test(sql.replace(/\$\d+/g, "")), "key_id 不得被拼进 SQL 文本");
    assert.ok(!/900/.test(sql), "before 不得被拼进 SQL 文本");
  });

  test("limit 夹到 1..200;未经校验的 keyId / beforeId 直接抛", async () => {
    const { pool, queries } = rowsPool(1);
    setPoolOverride(pool);
    await listApiKeyUsageRecent("7", "7d", null, { limit: 99999 });
    assert.equal(queries[0]!.params[2], USAGE_RECENT_PAGE_MAX_LIMIT + 1);
    await listApiKeyUsageRecent("7", "7d", null, { limit: 0 });
    assert.equal(queries[1]!.params[2], 2, "下限夹到 1(+1 多取行)");
    await assert.rejects(
      listApiKeyUsageRecent("7", "7d", "1; DROP TABLE x"),
      /keyId must be validated by caller/,
    );
    await assert.rejects(
      listApiKeyUsageRecent("7", "7d", null, { beforeId: "1 OR 1=1" }),
      /beforeId must be validated by caller/,
    );
  });

  test("首屏(getApiKeyUsageReport.recent)与后续页(listApiKeyUsageRecent)在时间戳打平/逆序时零漏行零重复", async () => {
    // 构造 55 条同窗口记录(id 1001..1055):
    //   - 1004 / 1005 / 1006 共享完全相同的 created_at(打平时间戳);
    //   - 1007(高 id)的 created_at 比 1003(低 id)更早(模拟并发长事务开始早但晚分配 id)。
    // 若首屏仍按 created_at DESC, id DESC 排序,1007 会被挤出首屏前 50,而首屏末行 id < 1007,
    // 后续页按 u.id < before 拉取将永久漏掉 1007 且重复拉出已进首屏的 1003。
    const baseMs = Date.parse("2026-09-08T12:00:00.000Z");
    const dataset = Array.from({ length: 55 }, (_, i) => {
      const id = 1001 + i;
      let tsMs = baseMs + i * 1000;
      if (id >= 1004 && id <= 1006) tsMs = baseMs + 5000; // 同毫秒打平
      if (id === 1007) tsMs = baseMs - 60_000; // 高 id 但更早的事务开始时间
      if (id === 1003) tsMs = baseMs + 90_000; // 低 id 但更新的事务开始时间
      return {
        id: String(id),
        created_at: new Date(tsMs).toISOString(),
        tsMs,
        api_key_id: "11",
        label: "k",
        model: "cursor-haiku-4.5",
        input_tokens: "1",
        output_tokens: "1",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        cost_credits: "3",
        status: "success",
      };
    });

    const pool = {
      async query(sql: string, params: unknown[] = []) {
        const trimmed = sql.trim();
        if (/^SELECT COUNT\(\*\)::TEXT/i.test(trimmed)) {
          return {
            rows: [{ requests: "55", input_tokens: "55", output_tokens: "55", cache_read_tokens: "0", cache_write_tokens: "0", credits: "165" }],
            rowCount: 1,
          };
        }
        if (/FROM\s+usage_records\s+u\b/i.test(trimmed) && !/GROUP\s+BY/i.test(trimmed)) {
          const beforeMatch = trimmed.match(/u\.id\s*<\s*\$(\d+)::bigint/i);
          const beforeId = beforeMatch ? BigInt(params[Number(beforeMatch[1]) - 1] as string) : null;
          const limitParamMatch = trimmed.match(/LIMIT\s+\$(\d+)/i);
          const limitLiteralMatch = trimmed.match(/LIMIT\s+(\d+)/i);
          const lim = limitParamMatch
            ? Number(params[Number(limitParamMatch[1]) - 1])
            : limitLiteralMatch
              ? Number(limitLiteralMatch[1])
              : 50;
          const sortByCreatedAt = /ORDER\s+BY\s+u\.created_at\s+DESC/i.test(trimmed);
          const filtered = dataset.filter((r) => (beforeId === null ? true : BigInt(r.id) < beforeId));
          filtered.sort((a, b) => {
            if (sortByCreatedAt && b.tsMs !== a.tsMs) return b.tsMs - a.tsMs;
            return BigInt(b.id) > BigInt(a.id) ? 1 : -1;
          });
          const rows = filtered.slice(0, lim).map(({ tsMs: _ts, ...rest }) => rest);
          return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
      async connect() { throw new Error("not used"); },
      async end() {},
    } as unknown as Pool;
    setPoolOverride(pool);

    const report = await getApiKeyUsageReport("7", "7d", null);
    assert.equal(report.recent.length, 50);
    const page1Ids = report.recent.map((r) => r.id);
    const lastPage1Id = page1Ids[page1Ids.length - 1]!;
    assert.equal(lastPage1Id, "1006");

    const page2 = await listApiKeyUsageRecent("7", "7d", null, { beforeId: lastPage1Id, limit: 3 });
    assert.deepEqual(page2.entries.map((r) => r.id), ["1005", "1004", "1003"]);
    assert.equal(page2.next_before, "1003");

    const page3 = await listApiKeyUsageRecent("7", "7d", null, { beforeId: page2.next_before, limit: 10 });
    assert.deepEqual(page3.entries.map((r) => r.id), ["1002", "1001"]);
    assert.equal(page3.next_before, null);

    const combined = [...page1Ids, ...page2.entries.map((r) => r.id), ...page3.entries.map((r) => r.id)];
    const expected = Array.from({ length: 55 }, (_, i) => String(1055 - i));
    assert.deepEqual(combined, expected, "首屏 + 后续页必须覆盖全部 55 条且严格按 id 降序,零漏行零重复");
    assert.equal(new Set(combined).size, 55);
  });
});
