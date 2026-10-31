import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

const OLD_REASONS = ["logout", "rotated", "theft", "password_reset", "admin"] as const;

test("0331 keeps old refresh_tokens rows and writers valid, adds client_ip and 'reissued'", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Shape before 0331: the columns old binaries write, and the 0019 CHECK under its real name.
    await client.query(`CREATE TEMP TABLE refresh_tokens (
      id BIGSERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL,
      user_agent TEXT,
      ip INET,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoked_reason TEXT,
      CONSTRAINT refresh_tokens_revoked_reason_check
        CHECK (revoked_reason IS NULL OR revoked_reason IN ('logout', 'rotated', 'theft', 'password_reset', 'admin'))
    )`);
    const oldInsert = `INSERT INTO refresh_tokens(token_hash, user_agent, ip, expires_at, revoked_at, revoked_reason)
                       VALUES ($1, 'ua', '127.0.0.1', NOW() + INTERVAL '30 days', $2, $3)`;
    await client.query(oldInsert, ["live-before", null, null]);
    for (const reason of OLD_REASONS) await client.query(oldInsert, [`before-${reason}`, new Date(), reason]);

    const sql = await readFile(new URL("../db/migrations/0331_refresh_reissue_client_ip.sql", import.meta.url), "utf8");
    await client.query(sql);
    // Re-applying is a no-op (IF NOT EXISTS / IF EXISTS), as migrate.ts may meet a half-known schema.
    await client.query(sql);

    const existing = await client.query<{ n: string; with_ip: string }>(
      "SELECT COUNT(*)::text AS n, COUNT(client_ip)::text AS with_ip FROM refresh_tokens",
    );
    assert.deepEqual(existing.rows[0], { n: String(OLD_REASONS.length + 1), with_ip: "0" }, "existing rows keep NULL client_ip");

    // Old writers omit client_ip and only use the old reasons.
    await client.query(oldInsert, ["live-after", null, null]);
    for (const reason of OLD_REASONS) await client.query(oldInsert, [`after-${reason}`, new Date(), reason]);
    // Old readers still select their columns.
    const oldRead = await client.query("SELECT token_hash, user_agent, host(ip) AS ip, revoked_reason FROM refresh_tokens WHERE token_hash = 'after-rotated'");
    assert.deepEqual(oldRead.rows, [{ token_hash: "after-rotated", user_agent: "ua", ip: "127.0.0.1", revoked_reason: "rotated" }]);

    // New writer: client_ip and 'reissued'.
    await client.query(
      `INSERT INTO refresh_tokens(token_hash, ip, client_ip, expires_at, revoked_at, revoked_reason)
       VALUES ('new-reissued', '127.0.0.1', $1::inet, NOW() + INTERVAL '30 days', NOW(), 'reissued')`,
      ["203.0.113.10"],
    );
    const stored = await client.query<{ client_ip: string }>("SELECT host(client_ip) AS client_ip FROM refresh_tokens WHERE token_hash = 'new-reissued'");
    assert.equal(stored.rows[0].client_ip, "203.0.113.10");

    for (const [label, query, code] of [
      ["unknown reason", "INSERT INTO refresh_tokens(token_hash, expires_at, revoked_reason) VALUES ('bad', NOW(), 'bogus')", "23514"],
      ["non-IP client_ip", "INSERT INTO refresh_tokens(token_hash, expires_at, client_ip) VALUES ('bad', NOW(), 'not-an-ip')", "22P02"],
    ] as const) {
      await client.query("SAVEPOINT bad_row");
      await assert.rejects(client.query(query), { code }, label);
      await client.query("ROLLBACK TO SAVEPOINT bad_row");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
