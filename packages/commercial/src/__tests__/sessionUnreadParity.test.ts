/**
 * 0240/0241 last_read_at:迁移存在、requiredMigrations 登记、PG/SQLite list 派生 unread。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/sessionUnreadParity.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { lastReadAtWatermarkMsSql, LAST_READ_AT_EPOCH_MS_FLOOR } from "@openclaude/storage";

const here = dirname(fileURLToPath(import.meta.url));
const migration0240 = join(here, "../db/migrations/0240_client_session_last_read_at.sql");
const rollback0240 = join(here, "../db/rollbacks/0240_client_session_last_read_at.sql");
const migration0241 = join(here, "../db/migrations/0241_raise_last_read_watermark.sql");
const rollback0241 = join(here, "../db/rollbacks/0241_raise_last_read_watermark.sql");
const backendSrc = readFileSync(join(here, "../db/pgSessionsBackend.ts"), "utf8");
const sqliteSrc = readFileSync(join(here, "../../../storage/src/sessionsDb.ts"), "utf8");
const metadata = JSON.parse(
  readFileSync(join(here, "../../../../deploy/v5/release-metadata.json"), "utf8"),
) as { requiredMigrations: string[] };

describe("0240 client_sessions.last_read_at", () => {
  test("迁移加列回填并登记 requiredMigrations", () => {
    assert.equal(existsSync(migration0240), true);
    assert.equal(existsSync(rollback0240), true);
    const sql = readFileSync(migration0240, "utf8");
    assert.match(sql, /ALTER TABLE client_sessions/);
    assert.match(sql, /last_read_at BIGINT/);
    assert.match(sql, /SET last_read_at = last_at/);
    assert.match(sql, /WHERE last_read_at IS NULL/);
    assert.match(readFileSync(rollback0240, "utf8"), /DROP COLUMN IF EXISTS last_read_at/);
    assert.ok(metadata.requiredMigrations.includes("0240_client_session_last_read_at"));
    assert.match(sqliteSrc, /last_read_at INTEGER DEFAULT NULL/);
  });

  test("两条 backend 覆盖 markRead / readAll,list SQL 派生 unread;无 unread-migrate", () => {
    for (const method of ["markClientSessionRead", "markAllClientSessionsRead"]) {
      assert.ok(backendSrc.includes(`async ${method}(`), `PG 缺 ${method}`);
      assert.ok(sqliteSrc.includes(`${method}:`), `sqliteBackend 缺 ${method}`);
    }
    assert.doesNotMatch(backendSrc, /migrateClientSessionsUnread/);
    assert.doesNotMatch(sqliteSrc, /migrateClientSessionsUnread/);
    const pgList = backendSrc.slice(
      backendSrc.indexOf("async listClientSessions"),
      backendSrc.indexOf("async listClientSessions") + 5500,
    );
    assert.match(pgList, /last_d\.outcome IN \(/);
    assert.match(pgList, /LAST_READ_AT_MS_SQL/);
    assert.match(pgList, /AS unread/);
    assert.match(sqliteSrc, /LAST_READ_AT_MS_SQL/);
    assert.match(sqliteSrc, /THEN 1 ELSE 0 END AS unread/);
  });
});

describe("0241 raise last_read_at watermark", () => {
  test("迁移把水位抬到 max(terminal_at) epoch ms 并登记 requiredMigrations", () => {
    assert.equal(existsSync(migration0241), true);
    assert.equal(existsSync(rollback0241), true);
    const sql = readFileSync(migration0241, "utf8");
    assert.match(sql, /order-dependency: 0240_client_session_last_read_at/);
    assert.match(sql, /GREATEST\(/);
    assert.match(sql, /EXTRACT\(EPOCH FROM MAX\(td\.terminal_at\)\)/);
    assert.match(sql, /\* 1000\)\)::bigint/);
    assert.match(sql, /FROM turn_dispatches td/);
    assert.doesNotMatch(sql, /SET last_read_at = last_at/);
    assert.match(readFileSync(rollback0241, "utf8"), /SET last_read_at = last_at/);
    assert.ok(metadata.requiredMigrations.includes("0241_raise_last_read_watermark"));
    assert.match(sqliteSrc, /user_version = 241/);
    assert.match(sqliteSrc, /MAX\(updated_at\) FROM turn_dispatch_inbox/);
  });

  test("水位比较把 unix seconds 放大为 epoch ms（阈值锁死）", () => {
    assert.equal(LAST_READ_AT_EPOCH_MS_FLOOR, 100_000_000_000);
    const sql = lastReadAtWatermarkMsSql("cs.last_read_at");
    assert.match(sql, /COALESCE\(cs\.last_read_at, 0\) <= 0/);
    assert.match(sql, /cs\.last_read_at < 100000000000/);
    assert.match(sql, /cs\.last_read_at \* 1000/);
    assert.match(backendSrc, /lastReadAtWatermarkMsSql\("cs\.last_read_at"\)/);
    assert.match(sqliteSrc, /lastReadAtWatermarkMsSql\('cs\.last_read_at'\)/);
    assert.match(sqliteSrc, /lastReadAtWatermarkMsSql\('last_d\.terminal_at'\)/);
  });
});
