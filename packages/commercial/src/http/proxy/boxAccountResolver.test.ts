import test from "node:test";
import assert from "node:assert/strict";
import type { Dispatcher, ProxyAgent } from "undici";
import type { AccountRow, AccountToken, CursorTokenSnapshot } from "../../account-pool/store.js";
import { BoxAccountResolver, BoxAccountResolverError, type BoxAccountResolverDeps } from "./boxAccountResolver.js";
import { BoxExecTransportError } from "./boxExecTransport.js";

const now = Date.now();
function session(subject: string): string {
  return `x.${Buffer.from(JSON.stringify({ sub: subject, type: "session",
    exp: Math.floor((now + 3_600_000) / 1000) })).toString("base64url")}.y`;
}
function frame(value: unknown, flag = 0): Buffer {
  const raw = Buffer.from(JSON.stringify(value));
  const out = Buffer.alloc(5 + raw.length);
  out[0] = flag; out.writeUInt32BE(raw.length, 1); raw.copy(out, 5);
  return out;
}

function fixture() {
  let credential = session("box-account-20");
  let proxy = "http://127.0.0.1:18888";
  let row = { id: 20n, provider: "cursor", status: "active", cursor_sand_enabled: true,
    cursor_credential_kind: "session", cursor_sand_access_state: "SAND_ACCESS_STATE_GRANTED",
    oauth_expires_at: new Date(now + 3_600_000), cooldown_until: null,
    cursor_sand_usage_pct: 0, cursor_sand_next_reset_at: null,
    cursor_billing_cycle_end: null } as AccountRow;
  const calls: string[] = [];
  let closed = 0;
  let route: "unbound" | "unavailable" = "unbound";
  const accountToken = (): AccountToken => ({ id: 20n, plan: "pro",
    token: Buffer.from(credential), refresh: Buffer.from("synthetic-refresh"),
    expires_at: new Date(now + 3_600_000), egress_proxy: null,
    egress_target: null, egress_proxy_id: null, egress_host_uuid: null });
  const snapshot = (): CursorTokenSnapshot => ({ id: 20n, token: Buffer.from(credential),
    credential_kind: "session", machine_id: "0123456789abcdef0123456789abcdef",
    refresh: Buffer.from("synthetic-refresh"), expires_at: new Date(now + 3_600_000) });
  const deps: BoxAccountResolverDeps = {
    now: () => now, random: () => 0,
    list: async () => [row], account: async () => row,
    token: async () => accountToken(), snapshot: async () => snapshot(),
    egress: async () => route === "unbound" ? { kind: "unbound" }
      : { kind: "unavailable", reason: "synthetic disabled egress" },
    uidProxy: () => proxy,
    makeProxyAgent: () => ({ destroy: async () => { closed++; } } as unknown as ProxyAgent & Dispatcher),
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith("/GetSandBoxRunState")) {
        return Response.json({ state: "SAND_BOX_RUN_STATE_RUNNING" });
      }
      if (url.endsWith("/EnsureSandBox")) {
        return Response.json({ execDaemonUrl: "https://box.example.cursorvm.com",
          execDaemonAuthToken: "synthetic-exec-token", networkToken: "synthetic-network-token" });
      }
      if (url.endsWith("/agent.v1.ControlService/Exec")) {
        const payload = Buffer.concat([frame({ stdoutEvent: { data: "synthetic-exec-ok" } }),
          frame({ exitEvent: {} }), frame({}, 2)]);
        return new Response(payload, { status: 200 });
      }
      throw new Error("unexpected URL");
    },
  };
  const resolver = new BoxAccountResolver(deps);
  const args = { uid: 3n, sessionId: "synthetic-session", requestId: "synthetic-request",
    upstreamModel: "claude-opus-5-5", signal: new AbortController().signal };
  return { resolver, deps, args, calls, getClosed: () => closed,
    setCredential: (value: string) => { credential = value; },
    setRow: (value: AccountRow) => { row = value; },
    setStatus: (value: AccountRow["status"]) => { row = { ...row, status: value }; },
    setProxy: (value: string) => { proxy = value; },
    setRoute: (value: "unbound" | "unavailable") => { route = value; } };
}

test("official control guard precedes GetState/Ensure and terminal target has owned egress", async () => {
  const f = fixture();
  const target = await f.resolver.resolve(f.args);
  assert.equal(target.accountId, 20n);
  assert.deepEqual(f.calls.map((url) => url.split("/").at(-1)),
    ["GetSandBoxRunState", "EnsureSandBox"]);
  const result = await target.exec.run({ command: "/usr/bin/python3",
    args: ["--version"], cwd: "/tmp", environment: {} }, { timeoutMs: 2000 });
  assert.equal(result.stdout, "synthetic-exec-ok");
  assert.equal(f.calls.length, 3);
  assert.equal(f.getClosed(), 0);
  await target.dispose?.();
  assert.equal(f.getClosed(), 1);
});

test("account rotation after GetState blocks Ensure and disposes failed resolve", async () => {
  const f = fixture();
  const resolver = new BoxAccountResolver({
    ...f.deps,
    fetch: async (url, init, dispatcher) => {
      const result = await f.deps.fetch(url, init, dispatcher);
      if (url.endsWith("/GetSandBoxRunState")) f.setCredential(session("rotated-account"));
      return result;
    },
  });
  await assert.rejects(resolver.resolve(f.args),
    (error: unknown) => error instanceof BoxAccountResolverError
      && error.code === "BOX_ACCOUNT_CHANGED");
  assert.deepEqual(f.calls.map((url) => url.split("/").at(-1)), ["GetSandBoxRunState"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.getClosed(), 1);
});

test("post-resolution credential or uid-proxy rotation blocks Exec before network", async () => {
  for (const kind of ["credential", "proxy"] as const) {
    const f = fixture();
    const target = await f.resolver.resolve(f.args);
    if (kind === "credential") f.setCredential(session("rotated-after-resolve"));
    else f.setProxy("http://127.0.0.1:18889");
    await assert.rejects(target.exec.run({ command: "/usr/bin/python3",
      args: ["--version"], cwd: "/tmp", environment: {} }, { timeoutMs: 2000 }),
    (error: unknown) => error instanceof BoxExecTransportError
      && error.code === "BOX_EXEC_ACCOUNT_GUARD_FAILED");
    assert.equal(f.calls.length, 2, "Exec network must not be called");
    await target.dispose?.();
  }
});

test("ineligible account and unresolved bound egress never call Box control", async () => {
  const inactive = fixture();
  inactive.setStatus("disabled");
  await assert.rejects(inactive.resolver.resolve(inactive.args),
    (error: unknown) => error instanceof BoxAccountResolverError
      && error.code === "BOX_ACCOUNT_UNAVAILABLE");
  assert.equal(inactive.calls.length, 0);
  const egress = fixture();
  egress.setRoute("unavailable");
  await assert.rejects(egress.resolver.resolve(egress.args),
    (error: unknown) => error instanceof BoxAccountResolverError
      && error.code === "BOX_EGRESS_UNAVAILABLE");
  assert.equal(egress.calls.length, 0);
  assert.equal(egress.getClosed(), 0);
});

test("failed pre-handoff private-proxy close remains owned for explicit retry", async () => {
  const f = fixture();
  let closes = 0;
  const resolver = new BoxAccountResolver({ ...f.deps,
    makeProxyAgent: () => ({ destroy: async () => {
      closes++;
      if (closes === 1) throw new Error("synthetic first close failure");
    } } as unknown as ProxyAgent & Dispatcher),
    fetch: async (url, init, dispatcher) => {
      if (url.endsWith("/GetSandBoxRunState")) {
        return Response.json({ state: "SAND_BOX_RUN_STATE_STOPPED" });
      }
      return f.deps.fetch(url, init, dispatcher);
    },
  });
  await assert.rejects(resolver.resolve(f.args));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(await resolver.retryFailedAgentCleanup(), 0);
  assert.equal(closes, 2);
});
