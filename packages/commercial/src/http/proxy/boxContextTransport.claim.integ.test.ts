/** This regression creates only session-local TEMP billing tables. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { runBoxContextTransportProbe } from "./testing/boxContextTransportProbe.js";
import { assertLegacyContextClaim } from "./testing/boxContextTransportClaim.js";

test("OCV5-607 legacy handoff accepts a 17MiB restored history and never consumes a changed prefix", async () => {
  const connectionString = process.env.OC_V5_PROOF_TEST_DATABASE_URL
    ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error("loopback test database required"); }
  assert.ok(url.hostname === "127.0.0.1" && url.port === "55432"
    && url.pathname === "/openclaude_test", "loopback test database required");
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const directory = await mkdtemp(path.join(tmpdir(), "g607-context-claim-"));
  try {
    const where = await client.query("SELECT current_database() AS db,inet_server_port() AS port");
    assert.ok(where.rows[0]?.db === "openclaude_test" && Number(where.rows[0]?.port) === 55432);
    const ddl = await readFile(new URL("../../billing/boxBillingRecoveryTempSchema.sql", import.meta.url), "utf8");
    for (const statement of ddl.split(/;\s*(?:\r?\n|$)/)) {
      const sql = statement.replace(/^\s*--.*$/gm, "").trim();
      if (sql) await client.query(sql);
    }
    const result = await runBoxContextTransportProbe(directory,
      (body) => assertLegacyContextClaim(client, body));
    assert.equal(result.images, 91);
  } finally {
    await rm(directory, { recursive: true, force: true });
    client.release();
    await pool.end();
  }
});

