#!/usr/bin/env node
// OCV5-557: one throwaway PostgreSQL database per selfhost train for the Box gates.
// The shared openclaude_test was rebuilt by other sessions' integ runs under the gates
// (`relation "agent_containers" does not exist`, lock waits ending in `Query read timeout`).
//
//   node scripts/lib/gateTestDb.mjs create <owner-pid>   → prints the new DSN on stdout
//   node scripts/lib/gateTestDb.mjs drop <name>
//   node scripts/lib/gateTestDb.mjs sweep                → drops this tool's databases whose owner pid is gone
//
// The base DSN comes from OC_V5_GATE_BASE_DSN only (never argv, never printed). It must be a
// loopback *_test database; it is only used to reach the server, never created, reset or dropped.
// Ownership is not inferred from a name: create writes a registry record (name, server, owner pid,
// random token) before CREATE DATABASE and stores the token as the database comment. drop and sweep
// act only on a database whose record and comment both match, on the same server.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(`${process.cwd()}/package.json`);
const GATE_DB = /^ocv5_gate_([0-9]+)_[0-9a-f]{12}_test$/;
const REGISTRY = process.env.OC_V5_GATE_DB_REGISTRY || "/var/lib/openclaude-v5-selfhost/gate-test-dbs";

function fail(message) {
  process.stderr.write(`gate-test-db: ${message}\n`);
  process.exit(2);
}

function base() {
  const raw = process.env.OC_V5_GATE_BASE_DSN;
  if (!raw) fail("OC_V5_GATE_BASE_DSN missing");
  let url;
  try { url = new URL(raw); } catch { fail("base DSN unparsable"); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") fail("base DSN scheme");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) fail("base DSN not loopback");
  if (url.search || url.hash) fail("base DSN has options");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z0-9_]+_test$/.test(database)) fail("base DSN is not a *_test database");
  if (!url.username || !url.password) fail("base DSN incomplete");
  const host = url.hostname === "[::1]" ? "::1" : "127.0.0.1";
  return { url, database, host, port: Number(url.port || 5432) };
}

async function withAdmin(run) {
  const { url, host, port } = base();
  const pg = require("pg");
  const client = new (pg.default ?? pg).Client({
    host, port, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: "postgres", ssl: false, connectionTimeoutMillis: 10_000, statement_timeout: 60_000,
  });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

const recordPath = (name) => join(REGISTRY, `${name}.json`);

function readRecord(name) {
  try { return JSON.parse(readFileSync(recordPath(name), "utf8")); } catch { return null; }
}

/** The record says this tool created `name` on this very server; the database comment carries its token. */
async function owned(client, name) {
  const { host, port, database } = base();
  if (!GATE_DB.test(name) || name === database) return false;
  const record = readRecord(name);
  if (!record || record.name !== name || record.host !== host || record.port !== port
    || typeof record.token !== "string" || !/^[0-9a-f]{32}$/.test(record.token)) return false;
  const { rows } = await client.query(
    "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1", [name]);
  return rows.length === 1 && rows[0].comment === `ocv5-557 gate ${record.token}`;
}

async function dropOwned(client, name) {
  if (!await owned(client, name)) {
    // a record whose database is already gone (dropped, or CREATE never ran) is just removed
    const gone = (await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rows.length === 0;
    if (gone && GATE_DB.test(name) && readRecord(name)) { rmSync(recordPath(name), { force: true }); return false; }
    fail(`refusing to drop ${JSON.stringify(name)}: not a database this tool created on this server`);
  }
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  rmSync(recordPath(name), { force: true });
  return true;
}

async function create(owner) {
  if (!/^[0-9]+$/.test(owner ?? "")) fail("create needs the owner pid");
  const { url, host, port, database } = base();
  const name = `ocv5_gate_${owner}_${randomBytes(6).toString("hex")}_test`;
  if (!GATE_DB.test(name) || name === database) fail("generated name invalid");
  const token = randomBytes(16).toString("hex");
  mkdirSync(REGISTRY, { recursive: true, mode: 0o700 });
  writeFileSync(recordPath(name), JSON.stringify({ name, host, port, ownerPid: Number(owner), token,
    createdAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
  await withAdmin(async (client) => {
    await client.query(`CREATE DATABASE ${name} TEMPLATE template0`);
    try {
      await client.query(`COMMENT ON DATABASE ${name} IS 'ocv5-557 gate ${token}'`);
    } catch (error) {
      // created a moment ago by this call and not handed out yet: without its token nothing could drop it later
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      rmSync(recordPath(name), { force: true });
      throw error;
    }
  });
  url.pathname = `/${name}`;
  process.stdout.write(`${url.toString()}\n`);
}

async function drop(name) {
  await withAdmin((client) => dropOwned(client, name ?? ""));
}

async function sweep() {
  if (!existsSync(REGISTRY)) return;
  const names = readdirSync(REGISTRY).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
  if (names.length === 0) return;
  await withAdmin(async (client) => {
    for (const name of names) {
      const match = GATE_DB.exec(name);
      const record = readRecord(name);
      if (!match || !record || existsSync(`/proc/${record.ownerPid}`) || String(record.ownerPid) !== match[1]) continue;
      if (await dropOwned(client, name)) process.stderr.write(`gate-test-db: dropped leftover ${name} (pid ${match[1]} gone)\n`);
    }
  });
}

const [command, arg] = process.argv.slice(2);
const run = { create: () => create(arg), drop: () => drop(arg), sweep }[command ?? ""];
if (!run) fail("usage: gateTestDb.mjs create <owner-pid> | drop <name> | sweep");
run().catch((error) => fail(error instanceof Error ? error.message : String(error)));
