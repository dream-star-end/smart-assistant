#!/usr/bin/env node
// OCV5-581: read-only proof-database preflight for the L0 departure check
// (scripts/lib/v5-release-preflight.sh). It answers "can the Box proofs get what they need from
// this server" before a train builds anything:
//   gate-db   — selfhost: a fresh database is created per train from template0 and the proofs run
//               CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public in it, so the role needs
//               CREATE DATABASE and pgcrypto must be installable by the database owner;
//   shared-db — the proofs use this database directly: pgcrypto, when present, must live in public
//               with EXECUTE on public.digest(bytea, text); when absent it must be installable here.
//
//   OC_V5_PREFLIGHT_PROOF_DSN=… node scripts/lib/proofDbPreflight.mjs gate-db|shared-db
//
// The DSN comes from the environment only and is never printed. One BEGIN READ ONLY transaction,
// catalog reads only, rolled back. Output: one "<ok|warn|fail>\t<reason>" line per finding.
// Exit 0 when nothing failed, 1 when something failed, 2 when the probe itself could not run.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Parse and vet the DSN the same way scripts/lib/gateTestDb.mjs vets its base DSN. */
export function vetDsn(raw) {
  if (!raw) return { error: "proof DSN missing" };
  let url;
  try { url = new URL(raw); } catch { return { error: "proof DSN unparsable" }; }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return { error: "proof DSN scheme" };
  if (!LOOPBACK.includes(url.hostname)) return { error: "proof DSN not loopback" };
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z0-9_]+_test$/.test(database)) return { error: "proof DSN is not a *_test database" };
  if (!url.username) return { error: "proof DSN has no user" };
  return {
    host: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

/** Which database to read. gate-db reaches the server the way scripts/lib/gateTestDb.mjs does
 * (through `postgres`): the per-train database is new and the base *_test database need not exist
 * (Codex r1 on the commercial port). shared-db reads the database the proofs will use. */
export function connectionFor(mode, conn) {
  return mode === "gate-db" ? { ...conn, database: "postgres" } : conn;
}

/** Pure decision over catalog facts → [[status, reason], ...]. */
export function evaluate(mode, f) {
  const out = [];
  const canInstall = f.superuser || (f.pgcryptoTrusted && f.dbCreate);
  if (!f.pgcryptoAvailable) {
    out.push(["fail", "pgcrypto is not available on this server (postgresql contrib missing); the Box proofs need public.digest"]);
  }
  if (mode === "gate-db") {
    if (!f.superuser && !f.createdb) out.push(["fail", `role ${f.user} cannot CREATE DATABASE (per-train gate database)`]);
    if (f.pgcryptoAvailable && !f.superuser && !f.pgcryptoTrusted) {
      out.push(["fail", `role ${f.user} is not superuser and pgcrypto is not a trusted extension: the gate database owner cannot install it`]);
    }
    if (out.length === 0) {
      out.push(["ok", `PG ${f.serverVersion}: role ${f.user} can create the gate database and install pgcrypto in it`]);
    }
    return out;
  }
  if (mode !== "shared-db") return [["fail", `unknown mode ${mode}`]];
  if (!f.dbCreate) out.push(["fail", `role ${f.user} lacks CREATE on database ${f.database} (proofs create their own schema)`]);
  if (f.pgcryptoSchema) {
    if (f.pgcryptoSchema !== "public") {
      out.push(["fail", `pgcrypto is installed in schema ${f.pgcryptoSchema}, not public: CREATE EXTENSION IF NOT EXISTS … WITH SCHEMA public is a no-op and public.digest(bytea, unknown) does not exist`]);
    } else if (!f.digestExists) {
      out.push(["fail", "pgcrypto is installed in public but public.digest(bytea, text) is missing"]);
    } else if (!f.digestExecute) {
      out.push(["fail", `role ${f.user} lacks EXECUTE on public.digest(bytea, text)`]);
    }
    if (!f.publicUsage) out.push(["fail", `role ${f.user} lacks USAGE on schema public`]);
  } else if (f.pgcryptoAvailable && !canInstall) {
    out.push(["fail", `pgcrypto is not installed in ${f.database} and role ${f.user} cannot install it`]);
  }
  if (out.length === 0) {
    const where = f.pgcryptoSchema ? "pgcrypto in public, digest executable" : "pgcrypto installable";
    out.push(["ok", `PG ${f.serverVersion}: ${f.database} ready for the proofs (${where})`]);
  }
  return out;
}

const FACTS_SQL = `
SELECT current_user AS user, current_database() AS database,
       current_setting('server_version') AS "serverVersion",
       r.rolsuper AS superuser, r.rolcreatedb AS createdb,
       has_database_privilege(current_database(), 'CREATE') AS "dbCreate",
       has_schema_privilege('public', 'USAGE') AS "publicUsage",
       EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgcrypto') AS "pgcryptoAvailable",
       COALESCE((SELECT v.trusted FROM pg_available_extensions a
                   JOIN pg_available_extension_versions v ON v.name = a.name AND v.version = a.default_version
                  WHERE a.name = 'pgcrypto'), false) AS "pgcryptoTrusted",
       (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
         WHERE e.extname = 'pgcrypto') AS "pgcryptoSchema",
       to_regprocedure('public.digest(bytea, text)') IS NOT NULL AS "digestExists",
       CASE WHEN to_regprocedure('public.digest(bytea, text)') IS NULL THEN false
            ELSE has_function_privilege(to_regprocedure('public.digest(bytea, text)'), 'EXECUTE') END AS "digestExecute"
  FROM pg_roles r WHERE r.rolname = current_user`;

async function main() {
  const mode = process.argv[2];
  if (mode !== "gate-db" && mode !== "shared-db") {
    process.stdout.write("fail\tusage: proofDbPreflight.mjs gate-db|shared-db\n");
    process.exit(2);
  }
  const conn = vetDsn(process.env.OC_V5_PREFLIGHT_PROOF_DSN);
  if (conn.error) {
    process.stdout.write(`fail\t${conn.error}\n`);
    process.exit(1);
  }
  // The DSN is vetted first (a non-loopback or non-_test DSN is wrong whatever is installed).
  // A tree without node_modules is a supported path: the caller installs dependencies after L0 and
  // the gates probe the server themselves, so a missing pg is a warning, not a refusal.
  const require = createRequire(`${process.cwd()}/package.json`);
  let pg;
  try {
    pg = require("pg");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    process.stdout.write("warn\tpg not installed in this tree yet (dependencies are installed after L0); proof server not probed\n");
    process.exit(0);
  }
  const client = new (pg.default ?? pg).Client({
    ...connectionFor(mode, conn), ssl: false, connectionTimeoutMillis: 10_000, statement_timeout: 10_000,
    application_name: "ocv5-581-preflight",
  });
  try {
    await client.connect();
  } catch (error) {
    // node-postgres messages carry no password; keep only the code/message
    process.stdout.write(`fail\tcannot connect to the proof database: ${error?.code ?? ""} ${error?.message ?? error}\n`);
    process.exit(1);
  }
  let facts;
  try {
    await client.query("BEGIN READ ONLY");
    facts = (await client.query(FACTS_SQL)).rows[0];
    await client.query("ROLLBACK");
  } finally {
    await client.end().catch(() => {});
  }
  if (!facts) {
    process.stdout.write("fail\tcurrent role not found in pg_roles\n");
    process.exit(1);
  }
  const results = evaluate(mode, facts);
  for (const [status, reason] of results) process.stdout.write(`${status}\t${reason}\n`);
  process.exit(results.some(([status]) => status === "fail") ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stdout.write(`fail\tprobe error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
