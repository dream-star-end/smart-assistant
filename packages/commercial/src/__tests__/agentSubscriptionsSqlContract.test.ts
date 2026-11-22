/**
 * OCV5-136 SQL contract & unit tests for legacy openAgentSubscription.
 *
 * Runs without Postgres so unit CI catches any drift between:
 *   - agent_containers partial unique index migrations (0018 -> 0089/0090 -> 0265/0266)
 *   - secret_hash NOT NULL + 32-byte length check (0023 / 0024)
 *   - packages/commercial/src/agent/subscriptions.ts ON CONFLICT clause & column set
 *   - v5 fail-closed guard
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { setPoolOverride, resetPool } from "../db/index.js";
import { openAgentSubscription } from "../agent/subscriptions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "db", "migrations");
const SUBSCRIPTIONS_SRC = join(__dirname, "..", "agent", "subscriptions.ts");

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

afterEach(async () => {
  await resetPool();
});

describe("OCV5-136 migration & SQL contract for openAgentSubscription", () => {
  test("migration chain defines active partial unique index on (user_id, runtime_channel, runtime_kind) WHERE state = 'active' and 32-byte NOT NULL secret_hash", () => {
    const m0018 = readMigration("0018_v3_user_id_partial_unique.sql");
    assert.match(m0018, /DROP CONSTRAINT IF EXISTS agent_containers_user_id_key/i);
    assert.match(m0018, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_ac_user_id_active[\s\S]*ON agent_containers\(user_id\)[\s\S]*WHERE state = 'active'/i);

    const m0023 = readMigration("0023_agent_containers_secret_hash_notnull.sql");
    assert.match(m0023, /ALTER COLUMN secret_hash SET NOT NULL/i);

    const m0024 = readMigration("0024_agent_containers_secret_hash_length.sql");
    assert.match(m0024, /CHECK \(octet_length\(secret_hash\) = 32\)/i);

    const m0090 = readMigration("0090_drop_old_user_active_unique.sql");
    assert.match(m0090, /DROP INDEX CONCURRENTLY IF EXISTS uniq_ac_user_id_active/i);

    const m0265 = readMigration("0265_desktop_kind_unique_index.sql");
    assert.match(
      m0265,
      /CREATE UNIQUE INDEX CONCURRENTLY uniq_ac_user_channel_kind_active[\s\S]*ON agent_containers \(user_id, runtime_channel, runtime_kind\)[\s\S]*WHERE state = 'active'/i,
    );

    const m0266 = readMigration("0266_drop_user_channel_active.sql");
    assert.match(m0266, /DROP INDEX CONCURRENTLY IF EXISTS uniq_ac_user_channel_active/i);
  });

  test("subscriptions.ts uses exact partial unique arbiter and never bare ON CONFLICT (user_id)", () => {
    const src = readFileSync(SUBSCRIPTIONS_SRC, "utf8");
    assert.doesNotMatch(
      src,
      /ON CONFLICT\s*\(\s*user_id\s*\)\s*DO UPDATE/i,
      "bare ON CONFLICT (user_id) causes PG 42P10 after 0018",
    );
    assert.match(
      src,
      /ON CONFLICT\s*\(\s*user_id,\s*runtime_channel,\s*runtime_kind\s*\)\s*WHERE\s+state\s*=\s*'active'\s*DO UPDATE[\s\S]*WHERE\s+agent_containers\.subscription_id\s+IS\s+NOT\s+NULL/i,
    );
  });

  test("openAgentSubscription issues exact ON CONFLICT predicate + 32-byte secret_hash on v3 channel", async () => {
    const recorded: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 86400_000);

    const fakeClient = {
      async query(sql: string, params?: unknown[]) {
        recorded.push({ sql, params });
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) {
          return { rows: [], rowCount: 0 };
        }
        if (/FROM users WHERE id/i.test(sql)) {
          return { rows: [{ credits: "5000", status: "active" }], rowCount: 1 };
        }
        if (/FROM agent_subscriptions/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        if (/INSERT INTO agent_subscriptions/i.test(sql)) {
          return { rows: [{ id: "101", start_at: now, end_at: end }], rowCount: 1 };
        }
        if (/UPDATE users SET credits/i.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO credit_ledger/i.test(sql)) {
          return { rows: [{ id: "202" }], rowCount: 1 };
        }
        if (/INSERT INTO agent_containers/i.test(sql)) {
          return { rows: [{ id: "303" }], rowCount: 1 };
        }
        throw new Error(`unexpected SQL in contract test: ${sql}`);
      },
      release() {
        /* noop */
      },
    } as unknown as PoolClient;

    const fakePool = {
      async connect() {
        return fakeClient;
      },
      async end() {
        /* noop */
      },
    } as unknown as Pool;

    const prev = process.env.OC_RUNTIME_CHANNEL;
    process.env.OC_RUNTIME_CHANNEL = "v3";
    setPoolOverride(fakePool);
    try {
      const res = await openAgentSubscription({
        userId: 42n,
        image: "openclaude/agent-runtime:latest",
      });
      assert.equal(res.subscription_id, 101n);
      assert.equal(res.container_id, 303n);
      assert.equal(res.ledger_id, 202n);
      assert.equal(res.balance_after, 2100n);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "OC_RUNTIME_CHANNEL");
      else process.env.OC_RUNTIME_CHANNEL = prev;
    }

    const upsert = recorded.find((q) => /INSERT INTO agent_containers/i.test(q.sql));
    assert.ok(upsert, "expected INSERT INTO agent_containers query");
    assert.match(
      upsert.sql,
      /ON CONFLICT\s*\(\s*user_id,\s*runtime_channel,\s*runtime_kind\s*\)\s*WHERE\s+state\s*=\s*'active'\s*DO UPDATE[\s\S]*WHERE\s+agent_containers\.subscription_id\s+IS\s+NOT\s+NULL/i,
    );
    assert.match(upsert.sql, /\bstate\b[\s\S]*\bruntime_channel\b[\s\S]*\bruntime_kind\b[\s\S]*\bsecret_hash\b/i);
    assert.ok(Array.isArray(upsert.params), "expected query parameters");
    assert.equal(upsert.params[0], "42");
    assert.equal(upsert.params[6], "v3");
    assert.ok(Buffer.isBuffer(upsert.params[7]), "secret_hash must be a Buffer (BYTEA)");
    assert.equal((upsert.params[7] as Buffer).length, 32, "secret_hash must be 32 bytes for 0024 CHECK");
  });

  test("openAgentSubscription throws and rolls back tx when guarded upsert returns 0 rows (active supervisor container)", async () => {
    const sqls: string[] = [];
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 86400_000);

    const fakeClient = {
      async query(sql: string) {
        sqls.push(sql.trim());
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) {
          return { rows: [], rowCount: 0 };
        }
        if (/FROM users WHERE id/i.test(sql)) {
          return { rows: [{ credits: "5000", status: "active" }], rowCount: 1 };
        }
        if (/FROM agent_subscriptions/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        if (/INSERT INTO agent_subscriptions/i.test(sql)) {
          return { rows: [{ id: "101", start_at: now, end_at: end }], rowCount: 1 };
        }
        if (/UPDATE users SET credits/i.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO credit_ledger/i.test(sql)) {
          return { rows: [{ id: "202" }], rowCount: 1 };
        }
        if (/INSERT INTO agent_containers/i.test(sql)) {
          // Simulates DO UPDATE WHERE agent_containers.subscription_id IS NOT NULL matching 0 rows
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected SQL in contract test: ${sql}`);
      },
      release() {
        /* noop */
      },
    } as unknown as PoolClient;

    const fakePool = {
      async connect() {
        return fakeClient;
      },
      async end() {
        /* noop */
      },
    } as unknown as Pool;

    const prev = process.env.OC_RUNTIME_CHANNEL;
    process.env.OC_RUNTIME_CHANNEL = "v3";
    setPoolOverride(fakePool);
    try {
      await assert.rejects(
        () => openAgentSubscription({ userId: 42n, image: "openclaude/agent-runtime:latest" }),
        /active non-subscription container/,
      );
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "OC_RUNTIME_CHANNEL");
      else process.env.OC_RUNTIME_CHANNEL = prev;
    }

    assert.ok(sqls.includes("BEGIN"), "expected transaction BEGIN");
    assert.ok(sqls.includes("ROLLBACK"), "expected transaction ROLLBACK");
    assert.ok(!sqls.includes("COMMIT"), "must never COMMIT when supervisor container conflicts");
  });

  test("openAgentSubscription rejects on v5 channel before acquiring a DB connection", async () => {
    let connectCalled = false;
    const fakePool = {
      async connect() {
        connectCalled = true;
        throw new Error("should not connect on v5");
      },
      async end() {
        /* noop */
      },
    } as unknown as Pool;

    const prev = process.env.OC_RUNTIME_CHANNEL;
    process.env.OC_RUNTIME_CHANNEL = "v5";
    setPoolOverride(fakePool);
    try {
      await assert.rejects(
        () => openAgentSubscription({ userId: 42n, image: "openclaude/agent-runtime:latest" }),
        /forbidden on v5 channel/,
      );
      assert.equal(connectCalled, false);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "OC_RUNTIME_CHANNEL");
      else process.env.OC_RUNTIME_CHANNEL = prev;
    }
  });
});
