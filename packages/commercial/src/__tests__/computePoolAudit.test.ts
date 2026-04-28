/**
 * 0042 — compute-pool/audit.ts 单测。
 *
 * 用 mock PoolClient 验证:
 *   - writeAuditInTx INSERT 走 jsonb cast,detail 经 JSON.stringify
 *   - operationId / reasonCode 缺省 → null,不传破洞 SQL 占位
 *   - writeAuditStandalone 自管 connect/release,即使 writeAuditInTx 抛仍 release
 *
 * 不测:listAuditEventsForHost(SQL ORDER BY 行为归 integ test)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";

import {
  writeAuditInTx,
  writeAuditStandalone,
} from "../compute-pool/audit.js";

interface RecordedQuery {
  sql: string;
  params: readonly unknown[];
}

function fakeClient(): { client: PoolClient; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 } as unknown;
    },
  } as unknown as PoolClient;
  return { client, queries };
}

describe("writeAuditInTx", () => {
  test("基础 INSERT 路径:hostId / operation / reasonCode / detail / actor 正确传入", async () => {
    const { client, queries } = fakeClient();
    await writeAuditInTx(client, {
      hostId: "host-uuid-1",
      operation: "bootstrap.image_pull",
      operationId: "op-1",
      reasonCode: null,
      detail: { foo: 1, bar: "x" },
      actor: "system:bootstrap",
    });
    assert.equal(queries.length, 1);
    const q = queries[0]!;
    // sql 必须包含 jsonb cast(避免被 pg 当 text 存)
    assert.match(q.sql, /::jsonb/, "INSERT 必须显式 cast detail 为 jsonb");
    assert.match(q.sql, /INSERT INTO compute_host_audit/);
    // params 顺序与 sql 占位 $1..$6 对齐
    assert.equal(q.params.length, 6);
    assert.equal(q.params[0], "host-uuid-1");
    assert.equal(q.params[1], "bootstrap.image_pull");
    assert.equal(q.params[2], "op-1");
    assert.equal(q.params[3], null);
    // detail 必须是 JSON 字符串(jsonb cast 在 SQL 侧完成)
    const detailStr = q.params[4] as string;
    assert.equal(typeof detailStr, "string");
    const parsed = JSON.parse(detailStr);
    assert.deepEqual(parsed, { foo: 1, bar: "x" });
    assert.equal(q.params[5], "system:bootstrap");
  });

  test("operationId / reasonCode / detail 缺省值兜底为 null / '{}'", async () => {
    const { client, queries } = fakeClient();
    await writeAuditInTx(client, {
      hostId: null,
      operation: "system.tick",
      actor: "system:imagePromote",
    });
    const q = queries[0]!;
    assert.equal(q.params[0], null);
    assert.equal(q.params[2], null); // operationId
    assert.equal(q.params[3], null); // reasonCode
    assert.equal(q.params[4], "{}"); // detail empty object
    assert.equal(q.params[5], "system:imagePromote");
  });

  test("detail 显式传 null → 也兜底成 '{}'(保留 jsonb 不为 null)", async () => {
    const { client, queries } = fakeClient();
    await writeAuditInTx(client, {
      hostId: "h",
      operation: "x",
      detail: null,
      actor: "system",
    });
    assert.equal(queries[0]!.params[4], "{}");
  });
});

describe("writeAuditStandalone", () => {
  test("成功路径:connect → writeAuditInTx → release", async () => {
    const { client, queries } = fakeClient();
    let released = 0;
    (client as unknown as { release: () => void }).release = () => {
      released++;
    };
    const pool = { connect: async () => client };
    await writeAuditStandalone(pool, {
      hostId: "h",
      operation: "test",
      actor: "system",
    });
    assert.equal(queries.length, 1);
    assert.equal(released, 1);
  });

  test("writeAuditInTx 抛错时仍 release(finally 路径)", async () => {
    const calls: string[] = [];
    let released = 0;
    const fakePool = {
      connect: async () => {
        calls.push("connect");
        return {
          query: async () => {
            throw new Error("simulated db failure");
          },
          release: () => {
            released++;
          },
        } as unknown as PoolClient;
      },
    };
    await assert.rejects(
      writeAuditStandalone(fakePool, {
        hostId: "h",
        operation: "broken",
        actor: "system",
      }),
      /simulated db failure/,
    );
    assert.equal(released, 1, "异常路径也必须 release");
    assert.equal(calls.length, 1);
  });
});
