// Browser-only fixture: real commercial router, JWT middleware, accounts, migrations and audit.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import IORedis from "ioredis";
import { createPool, setPoolOverride, closePool } from "../../commercial/src/db/index.js";
import { query } from "../../commercial/src/db/queries.js";
import { runMigrations } from "../../commercial/src/db/migrate.js";
import { resetTestSchemaForTest } from "../../commercial/src/__tests__/helpers/db.js";
import { createCommercialHandler } from "../../commercial/src/http/router.js";
import { signAccess } from "../../commercial/src/auth/jwt.js";
import { wrapIoredis } from "../../commercial/src/middleware/rateLimit.js";
import { adminCreateAccount, adminPatchAccount } from "../../commercial/src/admin/accounts.js";
import { createEgressProxy } from "../../commercial/src/admin/egressProxies.js";

const secret = "egress-browser-synthetic-jwt-".repeat(4);
const originalFetch = globalThis.fetch;
let redis: IORedis | undefined;
let server: Server | undefined;
let initialized = false;
let admin: bigint;
let profileCalls = 0;
let namespace = "";

export async function startFixture(root: string, js: string, css: string) {
  process.env.OPENCLAUDE_KMS_KEY = Buffer.alloc(32, 0x9a).toString("base64");
  const url = process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
  const pool = createPool({ connectionString: url, max: 5, connectionTimeoutMillis: 1500 });
  setPoolOverride(pool);
  await pool.query("SELECT 1"); // unavailable PG is failure, never skip
  initialized = true;
  await resetTestSchemaForTest();
  await runMigrations({ dir: join(root, "packages/commercial/src/db/migrations") });
  namespace = `egress-browser:${randomUUID()}:`;
  const redisUrl = new URL(process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0");
  // Separate logical test DB and random key prefix: never flush a shared DB.
  redisUrl.pathname = "/15";
  redis = new IORedis(redisUrl.href, { keyPrefix: namespace, lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1 });
  await redis.connect();
  assert.equal(await redis.ping(), "PONG");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.anthropic.com/api/oauth/profile") {
      profileCalls += 1;
      return new Response(JSON.stringify({ account: { uuid: randomUUID() } }), { status: 200 });
    }
    assert.match(url, /^http:\/\/127\.0\.0\.1:/, "synthetic OAuth tokens must never leave loopback/profile stub");
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const user = await query<{ id: string }>("INSERT INTO users(email,password_hash,credits,role,status) VALUES ($1,'synthetic',0,'admin','active') RETURNING id::text", [`${namespace.replace(/:/g, "-")}@fixture.invalid`]);
  admin = BigInt(user.rows[0].id);
  const { token } = await signAccess({ sub: String(admin), role: "admin" }, secret);
  const handler = createCommercialHandler({ jwtSecret: secret, mailer: { async send() {} }, redis: wrapIoredis(redis), turnstileBypass: true,
    verifyEmailUrlBase: "https://fixture.invalid", resetPasswordUrlBase: "https://fixture.invalid",
    rateLimits: { register: { scope: namespace + "register", windowSeconds: 60, max: 100 }, login: { scope: namespace + "login", windowSeconds: 60, max: 100 }, requestReset: { scope: namespace + "reset", windowSeconds: 60, max: 100 } } });
  server = createServer(async (req, res) => {
    try {
      if (req.url === "/fixture") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.__fixtureJwt=${JSON.stringify(token)}</script><script src="/fixture.js"></script>`);
      } else if (req.url === "/fixture.js") { res.setHeader("Content-Type", "application/javascript"); res.end(js); }
      else if (!await handler(req, res)) { res.statusCode = 404; res.end("fixture not found"); }
    } catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

export async function seed(kind: "disabled" | "active" | "non-claude") {
  const proxy = await createEgressProxy({ label: `browser-${kind}`, url: "http://synthetic:synthetic@127.0.0.1:9" }, { adminId: admin });
  const old = await adminCreateAccount({ label: `old-${kind}`, plan: "pro", provider: kind === "non-claude" ? "codex" : "claude",
    oauth_token: "synthetic-never-outbound", ...(kind === "non-claude" ? { oauth_refresh_token: "synthetic-refresh" } : {}), egress_proxy_id: String(proxy.id) }, { adminId: admin });
  if (kind === "disabled") await adminPatchAccount(old.id, { status: "disabled" }, { adminId: admin });
  return { proxyId: String(proxy.id), oldId: String(old.id) };
}

export async function snapshot(proxyId: string) {
  const accounts = await query("SELECT to_jsonb(a) AS row FROM claude_accounts a WHERE egress_proxy_id=$1::bigint ORDER BY id", [proxyId]);
  const audit = await query("SELECT to_jsonb(a) AS row FROM admin_audit a WHERE action='account.create' ORDER BY id");
  return { accounts: accounts.rows.map((r) => r.row), audit: audit.rows.map((r) => r.row), profileCalls };
}

export async function stopFixture() {
  globalThis.fetch = originalFetch;
  const failures: unknown[] = [];
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
  if (redis) {
    try {
      // SCAN returns raw keys; pipeline with prefixed connection would double-prefix.
      let cursor = "0";
      const keys: string[] = [];
      do { const result = await redis.scan(cursor, "MATCH", namespace + "*", "COUNT", 100); cursor = result[0]; keys.push(...result[1]); } while (cursor !== "0");
      for (const key of keys) await redis.del(key.slice(namespace.length));
    } catch (e) { failures.push(e); }
    try { await redis.quit(); } catch (e) { redis.disconnect(); failures.push(e); }
  }
  if (initialized) try { await resetTestSchemaForTest(); } catch (e) { failures.push(e); }
  try { await closePool(); } catch (e) { failures.push(e); }
  assert.deepEqual(failures, [], "fixture cleanup must finish under mutex");
}
