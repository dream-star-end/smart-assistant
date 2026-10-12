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

/** A choice without its `alternatives` count (asserted on its own below). */
function brief(choice: unknown): unknown {
  const { alternatives: _count, ...rest } = choice as { alternatives?: number };
  return rest;
}

test("the answer says how many other logins a launch could move to now", async () => {
  const { service, health } = logins([row("default"), row("account2"), row("off", { enabled: false })]);
  const first = await service.choose(3n, ACCOUNT) as { profile: string; alternatives: number };
  assert.equal(first.alternatives, 1, "the other enabled login; a disabled one never counts");
  const other = first.profile === "default" ? "account2" : "default";
  health.observe(`25:${other}`, { kind: "rate_limit", status: "allowed", utilization: 0.95, resetsAtMs: null });
  assert.equal((await service.choose(3n, ACCOUNT, { prefer: first.profile }) as { alternatives: number }).alternatives, 0,
    "a login past the new-chat spill line is no place to move a chat to");
});

test("an account with no saved logins runs its default login", async () => {
  const { service } = logins([]);
  assert.deepEqual(brief(await service.choose(3n, ACCOUNT)), { kind: "login", profile: "default", reason: "affinity" });
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
  assert.deepEqual(brief(await service.choose(uid, ACCOUNT)), { kind: "login", profile: "default", reason: "quota_benched" });
  // A logged-out default leaves nothing.
  const notLoggedIn = JSON.stringify({ type: "assistant", message: { model: "<synthetic>",
    content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
  assert.equal(service.observe(uid, ACCOUNT, "default", { lines: [notLoggedIn], unsafe: false }), true);
  assert.deepEqual(brief(await service.choose(uid, ACCOUNT)), { kind: "unavailable" });
  at += 2 * 3_600_000;
  assert.equal((await service.choose(uid, ACCOUNT)).kind, "login", "benches expire");
});

test("a chat stays on its login across restarts (prompt cache, free --resume) until it must move", async () => {
  let at = 1_791_700_000_000;
  const rows = [row("default"), row("account2")];
  const { service, health } = logins(async () => rows, { now: () => (at += 1) });
  const session = "0123456789abcdef";
  const allowed = (u: number) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: u } });
  // Find a user whose affinity is default, then pin one of their chats to account2 (it ran there before).
  let uid = 1n;
  while ((await service.choose(uid, ACCOUNT) as { profile: string }).profile !== "default") uid++;
  assert.deepEqual(brief(await service.choose(uid, ACCOUNT, { session, prefer: "account2" })),
    { kind: "login", profile: "account2", reason: "session" }, "the container's record wins over affinity");
  // Past the new-chat spill line (0.92) the chat still stays; new chats of this user stay on default anyway.
  service.observe(uid, ACCOUNT, "account2", { lines: [allowed(0.95)], unsafe: false });
  assert.equal(health.utilization("25:account2"), 0.95);
  assert.deepEqual(brief(await service.choose(uid, ACCOUNT, { session })), { kind: "login", profile: "account2", reason: "session" },
    "the master remembers the chat when the container lost its record");
  // At the stay ceiling it moves (once), and says where from.
  service.observe(uid, ACCOUNT, "account2", { lines: [allowed(0.985)], unsafe: false });
  assert.deepEqual(brief(await service.choose(uid, ACCOUNT, { session, prefer: "account2" })),
    { kind: "login", profile: "default", reason: "affinity", moved: "account2" });
  assert.deepEqual(brief(await service.choose(uid, ACCOUNT, { session, prefer: "default" })),
    { kind: "login", profile: "default", reason: "session" }, "then it stays on the new login");
  // A benched login is left.
  const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(at / 1000) + 3600 } });
  service.observe(uid, ACCOUNT, "default", { lines: [rejected], unsafe: false });
  assert.equal((await service.choose(uid, ACCOUNT, { session, prefer: "default" }) as { moved?: string }).moved, "default");
});

test("a remembered or suggested login never overrides the safety filter or the admin's selection", async () => {
  const rows = [row("default"), row("account2", { enabled: false }), row("own", { projectsMode: "own" })];
  const { service } = logins(rows);
  for (const prefer of ["account2", "own", "ghost"]) {
    assert.deepEqual(brief(await service.choose(3n, ACCOUNT, { session: "0123456789abcdef", prefer })),
      { kind: "login", profile: "default", reason: "affinity", moved: prefer }, prefer);
  }
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
  assert.deepEqual(brief(await logins([row("default")], { active: false }).service.choose(3n, ACCOUNT)), { kind: "unknown_account" });
  let fail = false;
  let at = 1_791_700_000_000;
  const { service } = logins(async () => { if (fail) throw new Error("db down"); return [row("default"), row("account2", { enabled: false })]; },
    { now: () => at });
  assert.deepEqual(brief(await service.choose(3n, ACCOUNT)), { kind: "login", profile: "default", reason: "affinity" });
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
  const asked: Array<[bigint, bigint, unknown]> = [];
  const handler = makeBoxLoginHandler({ identity: container, logins: {
    choose: async (uid, accountId, sticky) => { asked.push([uid, accountId, sticky]); return { kind: "login", profile: "account2", reason: "affinity", alternatives: 1 }; },
    observe: () => true } });
  assert.deepEqual(await call(handler, "/internal/box/login", { account_id: "25" }), { status: 200, result: { profile: "account2", alternatives: 1 } });
  assert.deepEqual(asked, [[3n, 25n, {}]]);
  assert.deepEqual(await call(handler, "/internal/box/login", { account_id: "25", session: "0123456789abcdef", prefer: "default" }),
    { status: 200, result: { profile: "account2", alternatives: 1 } });
  assert.deepEqual(asked[1], [3n, 25n, { session: "0123456789abcdef", prefer: "default" }]);
  for (const body of [{}, { account_id: 25 }, { account_id: "025" }, { account_id: "25", uid: "1" }, [],
    { account_id: "25", session: "XYZ" }, { account_id: "25", prefer: "../x" }, { account_id: "25", session: 1 }]) {
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

test("POST /internal/box/exec-target: the endpoint for an entitled uid; refusal, failure and overload are plain", async () => {
  const asked: bigint[] = [];
  const answer = { kind: "target" as const, accountId: 25n, execUrl: "https://box.example.cursorvm.com/agent.v1.ControlService/Exec",
    execToken: "T0K", networkToken: "N3T" };
  const make = (execTargets: (uid: bigint) => Promise<unknown>) => makeBoxLoginHandler({ identity: container,
    logins: { choose: async () => ({ kind: "unavailable" }), observe: () => false }, execTargets: execTargets as never });
  assert.deepEqual(await call(make(async (uid) => { asked.push(uid); return answer; }), "/internal/box/exec-target", {}),
    { status: 200, result: { account_id: "25", exec_url: answer.execUrl, exec_token: "T0K", network_token: "N3T" } });
  assert.deepEqual(asked, [3n], "the uid comes from the container identity");
  assert.deepEqual(await call(make(async () => ({ kind: "not_entitled" })), "/internal/box/exec-target", {}),
    { status: 403, result: { error: "BOX_EXEC_NOT_ENTITLED" } });
  assert.deepEqual(await call(make(async () => ({ kind: "unavailable" })), "/internal/box/exec-target", {}),
    { status: 503, result: { error: "BOX_EXEC_TARGET_UNAVAILABLE" } });
  assert.deepEqual(await call(make(async () => { throw new Error("cursor down"); }), "/internal/box/exec-target", {}),
    { status: 503, result: { error: "BOX_EXEC_TARGET_UNAVAILABLE" } });
  assert.equal((await call(make(async () => answer), "/internal/box/exec-target", { account_id: "25" })).status, 400);
  // Not wired (an older egress build): not found, never a fallback.
  const bare = makeBoxLoginHandler({ identity: container, logins: { choose: async () => ({ kind: "unavailable" }), observe: () => false } });
  assert.equal((await call(bare, "/internal/box/exec-target", {})).status, 404);
  // Two in flight per uid at most.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = make(async () => { await gate; return answer; });
  const server = createServer((req, res) => { void slow(req, res, { hostUuid: "h", boundIp: "127.0.0.1" }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/box/exec-target`;
    const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const first = post(); const second = post();
    await new Promise((r) => setTimeout(r, 100));
    const third = await post();
    assert.equal(third.status, 429); await third.text();
    release();
    assert.deepEqual([(await first).status, (await second).status], [200, 200]);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});
