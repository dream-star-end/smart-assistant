import test from "node:test";
import assert from "node:assert/strict";
import type { Dispatcher, ProxyAgent } from "undici";
import type { AccountRow, AccountToken, CursorTokenSnapshot } from "../../account-pool/store.js";
import { BoxAccountResolver, BoxAccountResolverError } from "./boxAccountResolver.js";
import type { BoxProfileRow } from "./boxClaudeProfileStore.js";
import { BoxProfileHealth } from "./boxProfileHealth.js";

const now = Date.now();
const session = (subject: string) => `x.${Buffer.from(JSON.stringify({ sub: subject, type: "session",
  exp: Math.floor((now + 172_800_000) / 1000) })).toString("base64url")}.y`;
const frame = (value: unknown, flag = 0): Buffer => {
  const raw = Buffer.from(JSON.stringify(value));
  const out = Buffer.alloc(5 + raw.length);
  out[0] = flag; out.writeUInt32BE(raw.length, 1); raw.copy(out, 5);
  return out;
};
const row = (id: bigint): AccountRow => ({ id, provider: "cursor", status: "active", cursor_sand_enabled: true,
  cursor_credential_kind: "session", cursor_sand_access_state: "SAND_ACCESS_STATE_GRANTED",
  oauth_expires_at: new Date(now + 172_800_000), cooldown_until: null, cursor_sand_usage_pct: 0,
  cursor_sand_next_reset_at: null, cursor_billing_cycle_end: null } as AccountRow);
const stored = (accountId: bigint, profile: string, over: Partial<BoxProfileRow> = {}): BoxProfileRow => ({
  accountId, profile, enabled: true, isDefault: profile === "default", loginState: "logged_in",
  projectsMode: profile === "default" ? "root" : "shared", emailHint: null, accountFingerprint: null,
  orgType: null, lastSeenAt: null, utilization: null, cooldownUntil: null, lastReason: null,
  healthUpdatedAt: null, ...over });

function fixture(accounts: bigint[], rows: BoxProfileRow[], random = 0) {
  const clock = { t: now };
  const health = new BoxProfileHealth(() => clock.t);
  const launches: Array<{ account: string; config: string | null }> = [];
  let stdout = "synthetic-exec-ok";
  let current = rows;
  let storeFails = false;
  const guard: Record<string, "ok" | "refuse"> = {};
  const guarded: string[] = [];
  const hostOf = (url: string) => new URL(url).host.split(".")[0]!;
  const accountOf = (init: RequestInit): string => {
    const header = JSON.stringify(init.headers ?? {});
    const jwt = /x\.([A-Za-z0-9_-]+)\.y/.exec(header)?.[1];
    return jwt ? String(JSON.parse(Buffer.from(jwt, "base64url").toString()).sub).replace("box-", "") : "0";
  };
  const resolver = new BoxAccountResolver({
    now: () => clock.t, random: () => random,
    list: async () => accounts.map(row), account: async (id) => row(id),
    token: async (id) => ({ id, plan: "pro", token: Buffer.from(session(`box-${id}`)), refresh: Buffer.from("r"),
      expires_at: new Date(now + 172_800_000), egress_proxy: null, egress_target: null, egress_proxy_id: null,
      egress_host_uuid: null }) as AccountToken,
    snapshot: async (id) => ({ id, token: Buffer.from(session(`box-${id}`)), credential_kind: "session",
      machine_id: "0123456789abcdef0123456789abcdef", refresh: Buffer.from("r"),
      expires_at: new Date(now + 172_800_000) }) as CursorTokenSnapshot,
    egress: async () => ({ kind: "unbound" }), uidProxy: () => null,
    makeProxyAgent: () => ({ destroy: async () => {} }) as unknown as ProxyAgent & Dispatcher,
    profiles: { list: async (ids) => { if (storeFails) throw new Error("db down"); return current.filter((r) => ids.includes(r.accountId)); }, health, cacheMs: 0 },
    fetch: async (url, init) => {
      if (url.endsWith("/GetSandBoxRunState")) return Response.json({ state: "SAND_BOX_RUN_STATE_RUNNING" });
      if (url.endsWith("/EnsureSandBox")) return Response.json({ execDaemonUrl: `https://box${accountOf(init)}.example.cursorvm.com`,
        execDaemonAuthToken: "t", networkToken: "n" });
      if (url.endsWith("/agent.v1.ControlService/Exec")) {
        const text = Buffer.from(init.body as Uint8Array).toString("utf8");
        if (text.includes("SystemExit(7)")) {
          const name = /\.claude-([a-z0-9-]+)/.exec(text.slice(text.lastIndexOf("-c"), text.length))?.[1] ?? "?";
          const lastDir = [...text.matchAll(/\.claude-([a-z0-9-]+)(?![a-z0-9-])/g)].map((m) => m[1]!).filter((n) => n !== "default").pop() ?? name;
          guarded.push(lastDir);
          if (guard[lastDir] === "refuse") {
            return new Response(Buffer.concat([frame({ exitEvent: { exitCode: 7 } }), frame({}, 2)]), { status: 200 });
          }
          return new Response(Buffer.concat([frame({ stdoutEvent: { data: "ok\n" } }), frame({ exitEvent: {} }), frame({}, 2)]), { status: 200 });
        }
        const config = /CLAUDE_CONFIG_DIR[^/]*?(\/home\/box\/\.claude-[a-z0-9-]+)/.exec(text);
        launches.push({ account: hostOf(url), config: config ? config[1]! : text.includes("CLAUDE_CONFIG_DIR") ? "?" : null });
        return new Response(Buffer.concat([frame({ stdoutEvent: { data: stdout } }), frame({ exitEvent: {} }), frame({}, 2)]), { status: 200 });
      }
      throw new Error("unexpected URL");
    },
  });
  const args = (uid: bigint) => ({ uid, sessionId: "s", requestId: `r-${uid}`, upstreamModel: "claude-opus-5-5",
    signal: new AbortController().signal });
  const launchReq = { command: "/home/box/.local/bin/claude", args: [], cwd: "/tmp", environment: { CLAUDE_CODE_MAX_RETRIES: "0" } };
  const launch = async (uid: bigint, extra: Record<string, unknown> = {}) => {
    clock.t += 91_000; // each call is its own moment: load only matters in the scheduler's own tests
    const target = await resolver.resolve({ ...args(uid), ...extra });
    const before = launches.length;
    await target.exec.run(launchReq, { timeoutMs: 2000 });
    const out = { accountId: target.accountId, profile: target.profile, config: launches[before]?.config ?? null };
    await target.dispose?.();
    return out;
  };
  return { launch, advance: (ms: number) => { clock.t += ms; }, health, guard, guarded, setStoreFails: (v: boolean) => { storeFails = v; }, tick: () => { clock.t += 91_000; }, setRows: (r: BoxProfileRow[]) => { current = r; }, setStdout: (s: string) => { stdout = s; }, resolver, args };
}

const uids = Array.from({ length: 60 }, (_, i) => BigInt(500 + i));

test("an account with no saved logins runs its default login exactly as before", async () => {
  const f = fixture([20n], []);
  const out = await f.launch(7n);
  assert.deepEqual(out, { accountId: 20n, profile: "default", config: null });
});

test("a user keeps one login; ticked logins all carry traffic; the launch runs under that login's config dir", async () => {
  const f = fixture([20n], [stored(20n, "default"), stored(20n, "b")]);
  const seen = new Map<bigint, string>();
  for (const uid of uids) seen.set(uid, (await f.launch(uid)).profile!);
  assert.deepEqual([...new Set(seen.values())].sort(), ["b", "default"]);
  f.tick();
  for (const uid of uids.slice(0, 15)) {
    for (let i = 0; i < 3; i++) assert.equal((await f.launch(uid)).profile, seen.get(uid));
  }
  f.tick();
  const onB = uids.find((u) => seen.get(u) === "b")!;
  assert.equal((await f.launch(onB)).config, "/home/box/.claude-b");
  const onDefault = uids.find((u) => seen.get(u) === "default")!;
  assert.equal((await f.launch(onDefault)).config, null);
});

test("a login that reports a rejection is benched and its users move; they return once it is clear", async () => {
  const f = fixture([20n], [stored(20n, "default"), stored(20n, "b")]);
  const before = new Map<bigint, string>();
  for (const uid of uids) before.set(uid, (await f.launch(uid)).profile!);
  f.tick();
  const onB = uids.filter((u) => before.get(u) === "b");
  assert.ok(onB.length > 0);
  f.setStdout('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4000000000,"unifiedWindows":{"five_hour":{"utilization":1.04,"resetsAt":4000000000}}}}\n');
  await f.launch(onB[0]!);           // this run learns b is out of quota
  f.setStdout("synthetic-exec-ok");
  f.tick();
  f.health.observe("20:b", { kind: "rate_limit", status: "rejected", utilization: 1.04, resetsAtMs: Date.now() + 86_400_000 });
  for (const uid of uids) {
    const now = (await f.launch(uid)).profile;
    if (uids.indexOf(uid) % 10 === 9) f.tick();
    assert.equal(now, before.get(uid) === "b" ? "default" : before.get(uid));
  }
  f.health.observe("20:b", { kind: "rate_limit", status: "allowed", utilization: 0.1, resetsAtMs: null });
  f.health.load("20:b", { utilization: 0.1, cooldownUntilMs: null, lastReason: null, updatedAtMs: Date.now() + 1 });
  // an expired bench is the normal recovery path; simulate by a fresh health view
  const fresh = fixture([20n], [stored(20n, "default"), stored(20n, "b")]);
  for (const uid of onB.slice(0, 5)) assert.equal((await fresh.launch(uid)).profile, "b");
});

test("durable cooldown from the store benches a login in a process that never saw the rejection", async () => {
  const until = new Date(now + 86_400_000);
  const f = fixture([20n], [stored(20n, "default"), stored(20n, "b", { cooldownUntil: until, lastReason: "quota_exhausted",
    healthUpdatedAt: new Date(now), utilization: 1.04 })]);
  for (const uid of uids) assert.equal((await f.launch(uid)).profile, "default");
});

test("users spread across Boxes, each user staying on one Box", async () => {
  const f = fixture([20n, 21n], [stored(20n, "default"), stored(21n, "default")]);
  const seen = new Map<bigint, bigint>();
  for (const uid of uids) seen.set(uid, (await f.launch(uid)).accountId);
  assert.equal(new Set(seen.values()).size, 2);
  f.tick();
  for (const uid of uids.slice(0, 10)) assert.equal((await f.launch(uid)).accountId, seen.get(uid));
});

test("when one Box has every login benched its users go to the other Box", async () => {
  const f = fixture([20n, 21n], [stored(20n, "default", { cooldownUntil: new Date(now + 86_400_000), healthUpdatedAt: new Date(now), lastReason: "quota_exhausted" })]);
  for (const uid of uids) assert.equal((await f.launch(uid)).accountId, 21n);
});

test("nothing usable is a clean refusal; an admin probe still reaches the Box", async () => {
  const f = fixture([20n], [stored(20n, "default", { cooldownUntil: new Date(now + 86_400_000), healthUpdatedAt: new Date(now), lastReason: "quota_exhausted" })]);
  await assert.rejects(f.launch(7n), (e: unknown) => e instanceof BoxAccountResolverError && e.code === "BOX_ACCOUNT_UNAVAILABLE");
  const out = await f.launch(7n, { adminProbe: true, requiredAccountId: 20n });
  assert.equal(out.accountId, 20n);
});

test("an account whose logins were all unticked takes no Box traffic", async () => {
  const f = fixture([20n], [stored(20n, "default", { enabled: false, isDefault: false })]);
  await assert.rejects(f.launch(7n), (e: unknown) => e instanceof BoxAccountResolverError && e.code === "BOX_ACCOUNT_UNAVAILABLE");
});

test("a hand-edited row cannot route traffic to a login that is logged out or has its own projects dir", async () => {
  const f = fixture([20n], [stored(20n, "default", { enabled: false, isDefault: false }),
    stored(20n, "own", { projectsMode: "own", isDefault: false }),
    stored(20n, "out", { loginState: "logged_out", isDefault: false })]);
  await assert.rejects(f.launch(7n), (e: unknown) => e instanceof BoxAccountResolverError && e.code === "BOX_ACCOUNT_UNAVAILABLE");
  f.setRows([stored(20n, "default"), stored(20n, "own", { projectsMode: "own", isDefault: false })]);
  for (const uid of uids) assert.equal((await f.launch(uid)).profile, "default");
});

test("without any saved logins the original weighted random pick is used, exactly as before", async () => {
  const f = fixture([20n, 21n], [], 0.99);
  for (const uid of uids.slice(0, 20)) assert.equal((await f.launch(uid)).accountId, 21n);
  const g = fixture([20n, 21n], [], 0);
  for (const uid of uids.slice(0, 20)) assert.equal((await g.launch(uid)).accountId, 20n);
});

test("a login the Box-side guard refuses is benched before anything is leased and its users move", async () => {
  const f = fixture([20n], [stored(20n, "default"), stored(20n, "b")]);
  f.guard.b = "refuse";
  for (const uid of uids) assert.equal((await f.launch(uid)).profile, "default");
  assert.ok(f.guarded.includes("b"), "the guard ran for b");
  assert.equal(f.health.get("20:b")!.lastReason, "profile_unsafe");
  assert.equal(f.health.cooldownActive("20:b"), true);
});

test("a login that passes the guard runs, and the guard is not repeated for 30s", async () => {
  const f = fixture([20n], [stored(20n, "default"), stored(20n, "b")]);
  const onB = [];
  for (const uid of uids) {          // resolve only: no clock movement, so the 30s guard cache holds
    const target = await f.resolver.resolve(f.args(uid));
    if (target.profile === "b") onB.push(uid);
    await target.dispose?.();
  }
  assert.ok(onB.length > 3);
  assert.equal(f.guarded.filter((n) => n === "b").length, 1);
});

test("a profile-store failure fails closed unless the same account set was read moments ago", async () => {
  const f = fixture([20n], [stored(20n, "default", { enabled: false, isDefault: false })]);
  f.setStoreFails(true);
  await assert.rejects(f.launch(7n), (e: unknown) => e instanceof BoxAccountResolverError && e.code === "BOX_PROFILE_STORE_UNAVAILABLE");
  const g = fixture([20n], [stored(20n, "default"), stored(20n, "b")]);
  await (await g.resolver.resolve(g.args(7n))).dispose?.();          // populates the cache for this account set
  g.setStoreFails(true);
  assert.equal((await g.resolver.resolve(g.args(7n))).accountId, 20n);
});

test("cleanup-style resolves (pinned account, no wake) reach the Box even when every login is benched", async () => {
  const f = fixture([20n], [stored(20n, "default", { cooldownUntil: new Date(now + 86_400_000), healthUpdatedAt: new Date(now), lastReason: "quota_exhausted" })]);
  await assert.rejects(f.launch(7n, { requiredAccountId: 20n, allowWakeIfHibernated: true }),
    (e: unknown) => e instanceof BoxAccountResolverError, "a launch-capable resolve still honours the bench");
  const out = await f.launch(7n, { requiredAccountId: 20n, allowWakeIfHibernated: false });
  assert.equal(out.accountId, 20n);
});

test("the store-failure fallback expires 60s after the last successful read, however often it is retried", async () => {
  const f = fixture([20n], [stored(20n, "default"), stored(20n, "b")]);
  await f.resolver.resolve(f.args(7n)).then((t) => t.dispose?.());       // successful read at t0
  f.setStoreFails(true);
  for (const step of [20_000, 20_000]) {                                     // t0+20s, t0+40s: still inside the window
    f.advance(step);
    await f.resolver.resolve(f.args(7n)).then((t) => t.dispose?.());
  }
  f.advance(25_000);                                                         // t0+65s: failed attempts must not have extended it
  await assert.rejects(f.resolver.resolve(f.args(7n)),
    (e: unknown) => e instanceof BoxAccountResolverError && e.code === "BOX_PROFILE_STORE_UNAVAILABLE");
});

test("a login that was benched for quota takes traffic again once its window has reset", async () => {
  const f = fixture([20n], [stored(20n, "default"), stored(20n, "b")]);
  const before = new Map<bigint, string>();
  for (const uid of uids) before.set(uid, (await f.launch(uid)).profile!);
  f.health.observe("20:b", { kind: "rate_limit", status: "rejected", utilization: 1.04, resetsAtMs: Date.now() + 86_400_000 });
  f.advance(86_400_000 + 1_000_000);   // past the window's reset
  for (const uid of uids) assert.equal((await f.launch(uid)).profile, before.get(uid), "affinity restored, stale 1.04 ignored");
});
