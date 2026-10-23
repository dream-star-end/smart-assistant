// OCV5-581: proofDbPreflight decisions on frozen catalog facts. Each failing fact set is one
// observed or minimal fault; the healthy set is what v5-dev's proof server reports today.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONNECT_TIMEOUT_MS, READ_TIMEOUTS_MS, connectionFor, evaluate, readFactsRetryingTimeout, vetDsn } from "./proofDbPreflight.mjs";

const healthy = {
  user: "test", database: "openclaude_test", serverVersion: "16.15",
  superuser: true, createdb: false, dbCreate: true, publicUsage: true,
  pgcryptoAvailable: true, pgcryptoTrusted: true, pgcryptoSchema: "public",
  digestExists: true, digestExecute: true,
};
const statuses = (r) => r.map(([s]) => s);
const failsWith = (r, re) => r.some(([s, m]) => s === "fail" && re.test(m));

test("healthy shared and gate databases pass", () => {
  assert.deepEqual(statuses(evaluate("shared-db", healthy)), ["ok"]);
  assert.deepEqual(statuses(evaluate("gate-db", { ...healthy, pgcryptoSchema: null })), ["ok"]);
});

test("seq365 attempt 2: public.digest(bytea, unknown) missing is refused before the build", () => {
  // pgcrypto absent from the shared database and the role cannot install it
  assert.ok(failsWith(evaluate("shared-db", { ...healthy, superuser: false, pgcryptoSchema: null,
    digestExists: false, digestExecute: false, pgcryptoTrusted: false }), /cannot install/));
  // pgcrypto installed outside public: IF NOT EXISTS … WITH SCHEMA public is a no-op
  assert.ok(failsWith(evaluate("shared-db", { ...healthy, pgcryptoSchema: "extensions",
    digestExists: false, digestExecute: false }), /schema extensions, not public/));
  assert.ok(failsWith(evaluate("shared-db", { ...healthy, digestExists: false, digestExecute: false }),
    /public\.digest\(bytea, text\) is missing/));
  assert.ok(failsWith(evaluate("shared-db", { ...healthy, digestExecute: false }), /lacks EXECUTE/));
  assert.ok(failsWith(evaluate("shared-db", { ...healthy, publicUsage: false }), /lacks USAGE/));
  assert.ok(failsWith(evaluate("shared-db", { ...healthy, dbCreate: false }), /lacks CREATE on database/));
});

test("absent but installable pgcrypto passes the shared database", () => {
  const r = evaluate("shared-db", { ...healthy, superuser: false, pgcryptoSchema: null,
    digestExists: false, digestExecute: false });
  assert.deepEqual(statuses(r), ["ok"]);
});

test("gate database: CREATE DATABASE, contrib and trusted install are required", () => {
  assert.ok(failsWith(evaluate("gate-db", { ...healthy, superuser: false, createdb: false }), /cannot CREATE DATABASE/));
  assert.ok(failsWith(evaluate("gate-db", { ...healthy, pgcryptoAvailable: false }), /not available/));
  assert.ok(failsWith(evaluate("gate-db", { ...healthy, superuser: false, createdb: true, pgcryptoTrusted: false }),
    /not a trusted extension/));
  assert.deepEqual(statuses(evaluate("gate-db", { ...healthy, superuser: false, createdb: true })), ["ok"]);
});

test("DSN vetting matches the gate database tool and never echoes the DSN", () => {
  assert.match(vetDsn("").error, /missing/);
  assert.match(vetDsn("postgres://u:secret@10.0.0.1/x_test").error, /not loopback/);
  assert.match(vetDsn("postgres://u:secret@127.0.0.1/openclaude").error, /not a \*_test/);
  const ok = vetDsn("postgres://u:secret@127.0.0.1:5433/openclaude_test");
  assert.equal(ok.port, 5433);
  assert.equal(ok.database, "openclaude_test");
  for (const raw of ["postgres://u:secret@10.0.0.1/x_test", "postgres://u:secret@127.0.0.1/y"]) {
    assert.ok(!JSON.stringify(vetDsn(raw)).includes("secret"));
  }
});

test("the probe only reads: one read-only transaction around a single SELECT", () => {
  const src = readFileSync(new URL("./proofDbPreflight.mjs", import.meta.url), "utf8");
  const queries = [...src.matchAll(/client\.query\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(queries, ['"BEGIN READ ONLY"', "FACTS_SQL", '"ROLLBACK"']);
  const sql = /const FACTS_SQL = `([\s\S]*?)`;/.exec(src)[1];
  assert.match(sql.trim(), /^SELECT /);
  // privilege names such as 'CREATE' are string literals passed to has_*_privilege, not statements
  assert.doesNotMatch(sql.replace(/'[^']*'/g, "''"), /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COMMENT)\b/);
});

test("gate-db reads the server through postgres like gateTestDb.mjs; shared-db reads the proof database", () => {
  const conn = vetDsn("postgres://u:p@127.0.0.1/missing_test");
  assert.equal(connectionFor("gate-db", conn).database, "postgres");
  assert.equal(connectionFor("shared-db", conn).database, "missing_test");
  const tool = readFileSync(new URL("./gateTestDb.mjs", import.meta.url), "utf8");
  assert.match(tool, /database: "postgres"/, "gateTestDb.mjs still connects through postgres");
});

test("a statement timeout is retried once with a longer budget; nothing else is (OCV5-583)", async () => {
  const timeout = () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  const calls = [];
  const seq = (...outcomes) => async (ms) => {
    calls.push(ms);
    const o = outcomes.shift();
    if (o instanceof Error) throw o;
    return o;
  };
  // 2026-10-23 04:39Z: the first read timed out, the server was fine
  calls.length = 0;
  const got = await readFactsRetryingTimeout(seq(timeout(), healthy));
  assert.deepEqual(calls, [10_000, 30_000]);
  assert.equal(got.facts, healthy);
  assert.match(got.warn, /statement timeout once; retried with 30s/);
  // a fast answer: one read, no warning
  calls.length = 0;
  assert.deepEqual(await readFactsRetryingTimeout(seq(healthy)), { facts: healthy });
  assert.deepEqual(calls, [10_000]);
  // two timeouts: still refused (fail-closed), never a third read
  calls.length = 0;
  await assert.rejects(readFactsRetryingTimeout(seq(timeout(), timeout(), healthy)), /statement timeout/);
  assert.deepEqual(calls, [10_000, 30_000]);
  // any other error is not retried
  calls.length = 0;
  await assert.rejects(readFactsRetryingTimeout(seq(Object.assign(new Error("permission denied"), { code: "42501" }), healthy)),
    /permission denied/);
  assert.deepEqual(calls, [10_000]);
});

test("the shell wrapper's timeout covers the probe's worst case, retry included (Codex #1021 r1)", () => {
  const wrapper = readFileSync(new URL("./v5-release-preflight.sh", import.meta.url), "utf8");
  const m = /OC_V5_PREFLIGHT_PROOF_DSN="\$dsn" timeout (\d+) node "\$probe"/.exec(wrapper);
  assert.ok(m, "wrapper runs the probe under timeout N");
  const worstMs = READ_TIMEOUTS_MS.length * CONNECT_TIMEOUT_MS + READ_TIMEOUTS_MS.reduce((a, b) => a + b, 0);
  assert.ok(Number(m[1]) * 1000 > worstMs, `timeout ${m[1]}s must exceed the probe's worst case ${worstMs / 1000}s`);
});
