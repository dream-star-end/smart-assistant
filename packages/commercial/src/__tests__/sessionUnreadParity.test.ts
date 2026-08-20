/**
 * 0240 last_read_at:迁移存在、requiredMigrations 登记、PG/SQLite list 派生 unread。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/sessionUnreadParity.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "../db/migrations/0240_client_session_last_read_at.sql");
const rollback = join(here, "../db/rollbacks/0240_client_session_last_read_at.sql");
const backendSrc = readFileSync(join(here, "../db/pgSessionsBackend.ts"), "utf8");
const sqliteSrc = readFileSync(join(here, "../../../storage/src/sessionsDb.ts"), "utf8");
const metadata = JSON.parse(
  readFileSync(join(here, "../../../../deploy/v5/release-metadata.json"), "utf8"),
) as { requiredMigrations: string[] };

describe("0240 client_sessions.last_read_at", () => {
  test("迁移加列回填并登记 requiredMigrations", () => {
    assert.equal(existsSync(migration), true);
    assert.equal(existsSync(rollback), true);
    const sql = readFileSync(migration, "utf8");
    assert.match(sql, /ALTER TABLE client_sessions/);
    assert.match(sql, /last_read_at BIGINT/);
    assert.match(sql, /SET last_read_at = last_at/);
    assert.match(sql, /WHERE last_read_at IS NULL/);
    assert.match(readFileSync(rollback, "utf8"), /DROP COLUMN IF EXISTS last_read_at/);
    assert.ok(metadata.requiredMigrations.includes("0240_client_session_last_read_at"));
    assert.match(sqliteSrc, /last_read_at INTEGER DEFAULT NULL/);
  });

  test("两条 backend 覆盖 markRead / readAll / migrate,list SQL 派生 unread", () => {
    for (const method of [
      "markClientSessionRead",
      "markAllClientSessionsRead",
      "migrateClientSessionsUnread",
    ]) {
      assert.ok(backendSrc.includes(`async ${method}(`), `PG 缺 ${method}`);
      assert.ok(sqliteSrc.includes(`${method}:`), `sqliteBackend 缺 ${method}`);
    }
    const pgList = backendSrc.slice(
      backendSrc.indexOf("async listClientSessions"),
      backendSrc.indexOf("async listClientSessions") + 5500,
    );
    assert.match(pgList, /last_d\.outcome IN \(/);
    assert.match(pgList, /COALESCE\(cs\.last_read_at, 0\)/);
    assert.match(pgList, /AS unread/);
    assert.match(sqliteSrc, /COALESCE\(cs\.last_read_at, 0\)/);
    assert.match(sqliteSrc, /THEN 1 ELSE 0 END AS unread/);
  });
});
