import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { IdentityError } from "../../auth/proxyIdentity.js";
import { BoxInteractiveLogins } from "./boxInteractiveLogins.js";
import { makeBoxLoginHandler } from "./boxLoginHandler.js";
import { BoxProfileHealth } from "./boxProfileHealth.js";
import { boxModelRouteLogins } from "./boxAccountResolver.js";
import type { BoxProfileRow } from "./boxClaudeProfileStore.js";

const ACCOUNT = 25n;
function row(profile: string, over: Partial<BoxProfileRow> = {}): BoxProfileRow {
  return { accountId: ACCOUNT, profile, enabled: true, isDefault: profile === "default", loginState: "logged_in",
    projectsMode: profile === "default" ? "root" : "shared", emailHint: null, accountFingerprint: null, orgType: "claude_pro",
    lastSeenAt: null, utilization: null, cooldownUntil: null, lastReason: null, healthUpdatedAt: null, ...over };
}

function logins(rows: BoxProfileRow[] | (() => Promise<BoxProfileRow[]>), opts: { now?: () => number; active?: boolean } = {}) {
  const health = new BoxProfileHealth(opts.now ?? Date.now);
  const service = new BoxInteractiveLogins({ accountActive: async (id) => id === ACCOUNT && opts.active !== false,
    list: typeof rows === "function" ? rows : async () => rows, health, cacheMs: 0, ...(opts.now ? { now: opts.now } : {}) });
  return { service, health };
}

test("an account with no saved logins runs its default login", async () => {
  const { service } = logins([]);
  assert.deepEqual(await service.choose(3n, ACCOUNT), { kind: "login", profile: "default", reason: "affinity" });
});

test("only enabled, logged-in, shared logins are chosen; one user keeps one login", async () => {
  // Launches spaced past the 90s load window, so only affinity decides.
  let at = 1_791_700_000_000;
  const { service } = logins([row("default"), row("account2"), row("own", { projectsMode: "own" }),
    row("out", { loginState: "logged_out" }), row("off", { enabled: false })], { now: () => (at += 91_000) });
  const seen = new Set<string>();
  for (let uid = 1n; uid <= 200n; uid++) {
    const first = await service.choose(uid, ACCOUNT);
    assert.equal(first.kind, "login");
    const again = await service.choose(uid, ACCOUNT);
    assert.deepEqual(again, first, `uid ${uid} is sticky`);
    seen.add((first as { profile: string }).profile);
  }
  assert.deepEqual([...seen].sort(), ["account2", "default"]);
});

test("a login benched by its own reported window spills to the other; nothing usable is 'unavailable'", async () => {
  let at = 1_791_700_000_000;
  const { service } = logins([row("default"), row("account2")], { now: () => (at += 1) });
  // Find a user who lands on default, then report default exhausted for them.
  let uid = 1n;
  while ((await service.choose(uid, ACCOUNT) as { profile: string }).profile !== "default") uid++;
  const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected",
    resetsAt: Math.floor(at / 1000) + 3600, utilization: 1.01 } });
  assert.equal(service.observe(uid, ACCOUNT, "default", { lines: [rejected], unsafe: false }), true);
  assert.equal((await service.choose(uid, ACCOUNT) as { profile: string }).profile, "account2", "the benched login is skipped");
  // account2 refused on the Box as well: only the quota-benched default is still worth a try.
  assert.equal(service.observe(uid, ACCOUNT, "account2", { lines: [], unsafe: true }), true);
  assert.deepEqual(await service.choose(uid, ACCOUNT), { kind: "login", profile: "default", reason: "quota_benched" });
  // A logged-out default leaves nothing.
  const notLoggedIn = JSON.stringify({ type: "assistant", message: { model: "<synthetic>",
    content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
  assert.equal(service.observe(uid, ACCOUNT, "default", { lines: [notLoggedIn], unsafe: false }), true);
  assert.deepEqual(await service.choose(uid, ACCOUNT), { kind: "unavailable" });
  at += 2 * 3_600_000;
  assert.equal((await service.choose(uid, ACCOUNT)).kind, "login", "benches expire");
});

test("a report counts only for a login this user was handed", async () => {
  const { service, health } = logins([row("default"), row("account2")]);
  const choice = await service.choose(3n, ACCOUNT) as { profile: string };
  const other = choice.profile === "default" ? "account2" : "default";
  const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", utilization: 1 } });
  assert.equal(service.observe(4n, ACCOUNT, choice.profile, { lines: [rejected], unsafe: false }), false, "another user");
  assert.equal(service.observe(3n, ACCOUNT, other, { lines: [rejected], unsafe: true }), false, "another login");
  assert.equal(service.observe(3n, 26n, choice.profile, { lines: [rejected], unsafe: false }), false, "another account");
  assert.equal(health.cooldownActive(`25:${choice.profile}`), false);
  assert.equal(health.cooldownActive(`25:${other}`), false);
});

test("unknown account, and a store failure without a recent read", async () => {
  assert.deepEqual(await logins([row("default")], { active: false }).service.choose(3n, ACCOUNT), { kind: "unknown_account" });
  let fail = false;
  let at = 1_791_700_000_000;
  const { service } = logins(async () => { if (fail) throw new Error("db down"); return [row("default"), row("account2", { enabled: false })]; },
    { now: () => at });
  assert.deepEqual(await service.choose(3n, ACCOUNT), { kind: "login", profile: "default", reason: "affinity" });
  fail = true;
  at += 30_000;
  assert.equal((await service.choose(3n, ACCOUNT)).kind, "login", "a read from the last 60s is reused");
  at += 60_000;
  await assert.rejects(service.choose(3n, ACCOUNT), /db down/);
});

test("the Box model route (claude -p) only ever sees each account's default login", () => {
  const rows = [row("default", { enabled: false, isDefault: false, utilization: 0.5 }), row("account2", { isDefault: true })];
  assert.deepEqual(boxModelRouteLogins(rows).map((r) => [r.profile, r.enabled, r.isDefault, r.utilization]),
    [["default", true, true, 0.5]]);
  assert.deepEqual(boxModelRouteLogins([row("account2")]), []);
  assert.deepEqual(boxModelRouteLogins([row("default", { loginState: "logged_out" })]).map((r) => r.loginState), ["logged_out"],
    "a logged-out default still stops the route");
});

// ---- the egress endpoints

async function call(handler: ReturnType<typeof makeBoxLoginHandler>, path: string, body: unknown,
  method = "POST"): Promise<{ status: number; result: Record<string, unknown> }> {
  const server = createServer((req, res) => {
    void handler(req, res, { hostUuid: "selfhost-test", boundIp: "127.0.0.1" })
      .catch(() => { res.statusCode = 500; res.end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, result: await response.json() as Record<string, unknown> };
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

const container = { resolve: async () => ({ uid: 3n, containerId: 7n }) } as never;

test("POST /internal/box/login: the uid comes from the container identity; the answer is a login name", async () => {
  const asked: Array<[bigint, bigint]> = [];
  const handler = makeBoxLoginHandler({ identity: container, logins: {
    choose: async (uid, accountId) => { asked.push([uid, accountId]); return { kind: "login", profile: "account2", reason: "affinity" }; },
    observe: () => true } });
  assert.deepEqual(await call(handler, "/internal/box/login", { account_id: "25" }), { status: 200, result: { profile: "account2" } });
  assert.deepEqual(asked, [[3n, 25n]]);
  for (const body of [{}, { account_id: 25 }, { account_id: "025" }, { account_id: "25", uid: "1" }, []]) {
    assert.equal((await call(handler, "/internal/box/login", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(handler, "/internal/box/login", null, "GET")).status, 404);
});

test("POST /internal/box/login: unavailable, unknown account, store failure, and identity refusals", async () => {
  const make = (choose: () => Promise<unknown>, identity: unknown = container) =>
    makeBoxLoginHandler({ identity: identity as never, logins: { choose: choose as never, observe: () => true } });
  assert.deepEqual(await call(make(async () => ({ kind: "unavailable" })), "/internal/box/login", { account_id: "25" }),
    { status: 503, result: { error: "BOX_LOGIN_UNAVAILABLE" } });
  assert.equal((await call(make(async () => ({ kind: "unknown_account" })), "/internal/box/login", { account_id: "25" })).status, 404);
  assert.deepEqual(await call(make(async () => { throw new Error("db"); }), "/internal/box/login", { account_id: "25" }),
    { status: 503, result: { error: "BOX_LOGIN_STORE_UNAVAILABLE" } });
  const never = async () => { throw new Error("must not choose"); };
  assert.equal((await call(make(never, { resolve: async () => { throw new IdentityError("BAD_SECRET", "x"); } }),
    "/internal/box/login", { account_id: "25" })).status, 401);
  assert.equal((await call(make(never, { resolve: async () => ({ uid: 3n, containerId: null }) }),
    "/internal/box/login", { account_id: "25" })).status, 403);
  assert.equal((await call(make(never, { resolve: async () => ({ uid: 3n, containerId: 7n, apiKey: { id: 1 } }) }),
    "/internal/box/login", { account_id: "25" })).status, 403);
});

test("POST /internal/box/login-signals: bounded lines for one login; the service decides what counts", async () => {
  const seen: unknown[] = [];
  const handler = makeBoxLoginHandler({ identity: container, logins: {
    choose: async () => ({ kind: "unavailable" }),
    observe: (uid, accountId, profile, report) => { seen.push([uid, accountId, profile, report]); return profile === "account2"; } } });
  const line = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}';
  assert.deepEqual(await call(handler, "/internal/box/login-signals", { account_id: "25", profile: "account2", lines: [line] }),
    { status: 200, result: { recorded: true } });
  assert.deepEqual(await call(handler, "/internal/box/login-signals", { account_id: "25", profile: "default", lines: [], unsafe: true }),
    { status: 200, result: { recorded: false } });
  assert.deepEqual(seen, [[3n, 25n, "account2", { lines: [line], unsafe: false }], [3n, 25n, "default", { lines: [], unsafe: true }]]);
  for (const body of [
    { account_id: "25", profile: "account2" },
    { account_id: "25", profile: "Account2", lines: [] },
    { account_id: "25", profile: "account2", lines: [1] },
    { account_id: "25", profile: "account2", lines: ["a\nb"] },
    { account_id: "25", profile: "account2", lines: Array.from({ length: 17 }, () => line) },
    { account_id: "25", profile: "account2", lines: [], unsafe: false },
    { account_id: "25", profile: "account2", lines: [], extra: 1 },
  ]) assert.equal((await call(handler, "/internal/box/login-signals", body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal(seen.length, 2);
});
