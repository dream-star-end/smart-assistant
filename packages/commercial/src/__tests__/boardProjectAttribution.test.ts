import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseUsageBoardProjectQuery,
  pgUsageBoardProjectSql,
  resolveBoardProjectAttribution,
  sessionOwnerMatchesUsageUser,
  usageSessionOwnerCandidates,
  type AttributionQuery,
} from "../billing/boardProjectAttribution.js";
import { settleUsageAndLedger } from "../billing/proxyBilling.js";
import type { Pool } from "pg";

describe("usage board project query filter", () => {
  test("missing = no filter, none = IS NULL, uuid parameterized", () => {
    assert.equal(parseUsageBoardProjectQuery(null), undefined);
    assert.equal(parseUsageBoardProjectQuery("none"), null);
    const none = pgUsageBoardProjectSql(null, 2);
    assert.match(none.sql, /IS NULL/);
    const id = pgUsageBoardProjectSql("852859fa-cf1d-481c-96fd-23f2966b8b5f", 4);
    assert.equal(id.sql, " AND board_project_id = $4");
    assert.deepEqual(id.params, ["852859fa-cf1d-481c-96fd-23f2966b8b5f"]);
  });
});

describe("session owner mapping", () => {
  test("usage user 3 matches c:3 and not another tenant", () => {
    assert.deepEqual(usageSessionOwnerCandidates(3n), ["c:3", "3"]);
    assert.equal(sessionOwnerMatchesUsageUser("c:3", 3n), true);
    assert.equal(sessionOwnerMatchesUsageUser("c:247", 3n), false);
  });
});

describe("resolveBoardProjectAttribution", () => {
  test("rejects session_id that belongs to another user", async () => {
    const client: AttributionQuery = {
      async query() {
        return { rows: [{ user_id: "c:247", board_project_id: "852859fa-cf1d-481c-96fd-23f2966b8b5f" }] };
      },
    };
    const got = await resolveBoardProjectAttribution(client, {
      usageUserId: 3n,
      sessionId: "web-other",
      mode: "chat",
    });
    assert.equal(got.boardProjectId, null);
  });

  test("chat bind snapshots board id", async () => {
    const client: AttributionQuery = {
      async query() {
        return { rows: [{ user_id: "c:3", board_project_id: "852859fa-cf1d-481c-96fd-23f2966b8b5f" }] };
      },
    };
    const got = await resolveBoardProjectAttribution(client, {
      usageUserId: 3n,
      sessionId: "web-mine",
      mode: "chat",
    });
    assert.equal(got.boardProjectId, "852859fa-cf1d-481c-96fd-23f2966b8b5f");
    assert.equal(got.source, "session_bind");
  });

  test("delegate uses parent session, not engine uuid", async () => {
    const seen: string[] = [];
    const client: AttributionQuery = {
      async query(_sql, params) {
        seen.push(String(params?.[0]));
        if (params?.[0] === "web-parent") {
          return { rows: [{ user_id: "c:3", board_project_id: "852859fa-cf1d-481c-96fd-23f2966b8b5f" }] };
        }
        return { rows: [] };
      },
    };
    const got = await resolveBoardProjectAttribution(client, {
      usageUserId: 3n,
      sessionId: "engine-uuid",
      parentSessionId: "web-parent",
      mode: "delegate",
    });
    assert.equal(seen[0], "web-parent");
    assert.equal(got.source, "delegate_parent");
    assert.equal(got.boardProjectId, "852859fa-cf1d-481c-96fd-23f2966b8b5f");
  });

  test("explicit override wins and later lookup is skipped", async () => {
    const client: AttributionQuery = {
      async query() {
        throw new Error("lookup should not run");
      },
    };
    const got = await resolveBoardProjectAttribution(client, {
      usageUserId: 3n,
      sessionId: "web-x",
      explicit: { boardProjectId: "852859fa-cf1d-481c-96fd-23f2966b8b5f", source: "explicit" },
    });
    assert.equal(got.source, "explicit");
  });
});

describe("settleUsageAndLedger appends attribution columns without shifting 0104/0143 slots", () => {
  test("existing mode/session param indices stay put; board columns are $27+", async () => {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    const stubClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO usage_records")) {
          inserts.push({ sql, params: params ?? [] });
          return { rows: [{ id: "1" }], rowCount: 1 };
        }
        if (sql.includes("FROM client_sessions")) {
          return {
            rows: [{ user_id: "c:3", board_project_id: "852859fa-cf1d-481c-96fd-23f2966b8b5f" }],
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const stubPool = { connect: async () => stubClient } as unknown as Pool;
    await settleUsageAndLedger(stubPool, {
      userId: 3n,
      accountId: null,
      requestId: "req-attr-1",
      model: "glm-5.2",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 },
      snapshotJson: "{}",
      costCredits: 0n,
      status: "success",
      sessionId: "web-mine",
      mode: "chat",
    });
    const { sql, params } = inserts[0]!;
    assert.match(sql, /board_project_id/);
    assert.equal(params[1], "chat");
    assert.equal(params[10], "web-mine");
    assert.equal(params[26], "852859fa-cf1d-481c-96fd-23f2966b8b5f");
    assert.equal(params[27], "session_bind");
  });
});
