import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CursorSandProvisionClient, SandProvisionError, sandPrincipal } from "./cursorSandProvision.js";
import { CursorSandBoxResolver } from "../../../gateway/src/engine/cursorSandBox.js";

async function server(fn: (req: IncomingMessage, res: ServerResponse) => void) {
  const http = createServer(fn); await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + (http.address() as { port: number }).port;
  return { url, close: async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); } };
}
const accountToken = "x." + Buffer.from(JSON.stringify({ sub: "synthetic-account", type: "session", exp: 2_000_000_000 })).toString("base64url") + ".y";
const machine = "a".repeat(32);
const signal = () => new AbortController().signal;
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }

test("real HTTP exchange/control/gateway keep separate bearers and preserve the gateway prefix", async () => {
  const seen: Array<{ path: string; bearer?: string; body: string }> = [];
  const f = await server((q, s) => {
    const chunks: Buffer[] = []; q.on("data", (x) => chunks.push(x));
    q.on("end", () => {
      const path = q.url!; seen.push({ path, bearer: q.headers.authorization, body: Buffer.concat(chunks).toString() });
      if (path === "/auth/exchange_user_api_key") return json(s, { accessToken: accountToken });
      if (path.endsWith("GetSandBoxRunState")) return json(s, { state: "SAND_BOX_RUN_STATE_RUNNING" });
      if (path.endsWith("EnsureSandBox")) return json(s, { gatewayUrl: f.url + "/prefix", gatewayToken: "GATEWAY", networkToken: "NETWORK" });
      if (path === "/prefix/health") return json(s, { ok: true, pid: 123, isBusy: false });
      if (path === "/prefix/api/listAgents") return json(s, []);
      if (path === "/prefix/sand-stream-relay/aiserver.v1.InferenceService/Stream") return json(s, {
        protocol: "oc-sand-relay-v2", moduleSha256: "f".repeat(64), nonce: q.headers["x-oc-sand-box-probe-nonce"], active: 0, maxConcurrent: 4,
      });
      json(s, {}, 404);
    });
  });
  try {
    const client = new CursorSandProvisionClient({ fetchImpl: fetch, apiBase: f.url, allowTestLoopback: true });
    const token = await client.accessToken("crsr_" + "a".repeat(64), "api_key", signal());
    assert.equal(sandPrincipal(token, "api_key").subjectHash.length, 64);
    const connection = await client.connect(token, machine, signal());
    assert.deepEqual(await client.health(connection, signal()), { pid: 123, isBusy: false });
    assert.deepEqual(await client.box("listAgents", connection, {}, signal()), []);
    assert.deepEqual(await client.probe(connection, signal()), { moduleHash: "f".repeat(64), active: 0, maxConcurrent: 4 });
    assert.equal(seen.length, 6);
    assert.ok(seen.filter((x) => x.path.startsWith("/aiserver.")).every((x) => x.bearer === "Bearer " + token && x.body === "{}"));
    assert.ok(seen.filter((x) => x.path.startsWith("/prefix/")).every((x) => x.bearer === "Bearer GATEWAY" && !x.body.includes(token)));
    assert.equal(seen.at(-1)!.body, "", "probe must not submit a generation request");
  } finally { await f.close(); }
});

test("ambiguous Ensure 503 is not retried; the next call rechecks state before obtaining a descriptor", async () => {
  const methods: string[] = []; let created = false;
  const f = await server((q, s) => { q.resume(); q.on("end", () => {
    methods.push(q.url!);
    if (q.url!.endsWith("GetSandBoxRunState")) return json(s, { state: created ? "SAND_BOX_RUN_STATE_RUNNING" : "SAND_BOX_RUN_STATE_ABSENT" });
    if (!created) { created = true; return json(s, {}, 503); }
    json(s, { gatewayUrl: f.url, gatewayToken: "G", networkToken: "N" });
  }); });
  try {
    const c = new CursorSandProvisionClient({ fetchImpl: fetch, apiBase: f.url, allowTestLoopback: true });
    await assert.rejects(c.connect(accountToken, machine, signal()), (e: unknown) => e instanceof SandProvisionError && e.code === "BOX_CONTROL_PENDING" && e.httpStatus === 503);
    assert.equal(methods.length, 2);
    await c.connect(accountToken, machine, signal());
    assert.deepEqual(methods.map((x) => x.split("/").at(-1)), ["GetSandBoxRunState", "EnsureSandBox", "GetSandBoxRunState", "EnsureSandBox"]);
  } finally { await f.close(); }
});

test("control redirects and stalled bodies fail closed within the request deadline", async () => {
  let leaked = 0;
  const target = await server((_q, s) => { leaked++; json(s, {}); });
  let stall = false;
  const source = await server((q, s) => { q.resume(); q.on("end", () => {
    if (!stall) { s.writeHead(302, { location: target.url }); s.end(); }
    else { s.writeHead(200, { "content-type": "application/json" }); s.write("{"); }
  }); });
  try {
    const c = new CursorSandProvisionClient({ fetchImpl: fetch, apiBase: source.url, allowTestLoopback: true, timeoutMs: 100 });
    await assert.rejects(c.connect(accountToken, machine, signal()), /REQUEST_FAILED/);
    assert.equal(leaked, 0);
    stall = true;
    await assert.rejects(c.connect(accountToken, machine, signal()), /REQUEST_ABORTED/);
  } finally { await source.close(); await target.close(); }
});

test("Box Exec resolves from the official account control plane without a Sand relay probe", async () => {
  const paths: string[] = [];
  const f = await server((q, s) => { q.resume(); q.on("end", () => {
    paths.push(q.url!);
    if (q.url!.endsWith("GetSandBoxRunState")) return json(s, { state: "SAND_BOX_RUN_STATE_RUNNING" });
    if (q.url!.endsWith("EnsureSandBox")) return json(s, {
      execDaemonUrl: f.url + "/box", execDaemonAuthToken: "EXEC", networkToken: "NETWORK",
    });
    json(s, {}, 404);
  }); });
  try {
    let oldFetchCalls = 0;
    const oldRelayBoundPath = new CursorSandBoxResolver({
      accountId: "20", credentialKind: "session",
      fetchImpl: async () => { oldFetchCalls++; throw new Error("OLD_ROUTE_MUST_NOT_FETCH"); },
      readPolicy: () => ({ version: 1, managed: true, accounts: [] }),
    });
    await assert.rejects(oldRelayBoundPath.resolveExec(accountToken, machine, signal()), /CURSOR_SAND_BOX_NOT_READY/);
    assert.equal(oldFetchCalls, 0, "old route must reject before any external fetch");
    assert.equal(paths.length, 0, "old path is rejected solely by the empty relay policy");
    const client = new CursorSandProvisionClient({ fetchImpl: fetch, apiBase: f.url, allowTestLoopback: true });
    const target = await client.resolveBoxExec(accountToken, machine, signal());
    assert.deepEqual(target, {
      execUrl: f.url + "/box/agent.v1.ControlService/Exec",
      execToken: "EXEC", networkToken: "NETWORK",
    });
    assert.deepEqual(paths.map((p) => p.split("/").at(-1)), ["GetSandBoxRunState", "EnsureSandBox"]);
  } finally { await f.close(); }
});

test("read-only Box run-state never sends EnsureSandBox or wakes a hibernated Box", async () => {
  const paths: string[] = [];
  let state = "SAND_BOX_RUN_STATE_HIBERNATED";
  const f = await server((q, s) => { q.resume(); q.on("end", () => {
    paths.push(q.url!);
    if (q.url!.endsWith("GetSandBoxRunState")) return json(s, { state });
    json(s, {}, 500);
  }); });
  try {
    const client = new CursorSandProvisionClient({ fetchImpl: fetch,
      apiBase: f.url, allowTestLoopback: true });
    assert.equal(await client.getBoxRunState(accountToken, machine, signal()), state);
    state = "SAND_BOX_RUN_STATE_RUNNING";
    assert.equal(await client.getBoxRunState(accountToken, machine, signal()), state);
    assert.deepEqual(paths.map((p) => p.split("/").at(-1)),
      ["GetSandBoxRunState", "GetSandBoxRunState"]);
  } finally { await f.close(); }
});

test("only explicit model-call wake turns HIBERNATED into a proven Exec descriptor", async () => {
  const methods: string[] = [];
  let state = "SAND_BOX_RUN_STATE_HIBERNATED";
  let ensureStatus = 200, wakeOnEnsure = true;
  const f = await server((q, s) => { q.resume(); q.on("end", () => {
    const method = q.url!.split("/").at(-1)!; methods.push(method);
    if (method === "GetSandBoxRunState") return json(s, { state });
    if (method === "EnsureSandBox") {
      if (ensureStatus !== 200) return json(s, {}, ensureStatus);
      if (wakeOnEnsure) state = "SAND_BOX_RUN_STATE_RUNNING";
      return json(s, { execDaemonUrl: f.url + "/box",
        execDaemonAuthToken: "EXEC", networkToken: "NETWORK" });
    }
    json(s, {}, 404);
  }); });
  try {
    const c = new CursorSandProvisionClient({ fetchImpl: fetch,
      apiBase: f.url, allowTestLoopback: true });
    await assert.rejects(c.resolveBoxExec(accountToken, machine, signal()),
      (e: unknown) => e instanceof SandProvisionError && e.code === "BOX_NOT_RUNNING");
    assert.deepEqual(methods.splice(0), ["GetSandBoxRunState"]);
    const target = await c.resolveBoxExec(accountToken, machine, signal(),
      { allowWakeIfHibernated: true });
    assert.equal(target.execUrl, f.url + "/box/agent.v1.ControlService/Exec");
    assert.deepEqual(methods.splice(0),
      ["GetSandBoxRunState", "EnsureSandBox", "GetSandBoxRunState"]);
    await c.resolveBoxExec(accountToken, machine, signal(),
      { allowWakeIfHibernated: true });
    assert.deepEqual(methods.splice(0), ["GetSandBoxRunState", "EnsureSandBox"],
      "already-running account needs no second status request");
    state = "SAND_BOX_RUN_STATE_HIBERNATED"; wakeOnEnsure = false;
    await assert.rejects(c.resolveBoxExec(accountToken, machine, signal(),
      { allowWakeIfHibernated: true }),
    (e: unknown) => e instanceof SandProvisionError && e.code === "BOX_WAKE_UNPROVEN");
    assert.deepEqual(methods.splice(0),
      ["GetSandBoxRunState", "EnsureSandBox", "GetSandBoxRunState"]);
    ensureStatus = 503;
    await assert.rejects(c.resolveBoxExec(accountToken, machine, signal(),
      { allowWakeIfHibernated: true }),
    (e: unknown) => e instanceof SandProvisionError && e.code === "BOX_CONTROL_PENDING");
    assert.deepEqual(methods.splice(0), ["GetSandBoxRunState", "EnsureSandBox"],
      "ambiguous Ensure must not be retried or treated as proof");
    state = "SAND_BOX_RUN_STATE_ABSENT"; ensureStatus = 200;
    await assert.rejects(c.resolveBoxExec(accountToken, machine, signal(),
      { allowWakeIfHibernated: true }),
    (e: unknown) => e instanceof SandProvisionError && e.code === "BOX_NOT_RUNNING");
    assert.deepEqual(methods.splice(0), ["GetSandBoxRunState"]);
  } finally { await f.close(); }
});

test("Box Exec rejects non-running, invalid identity, and malicious descriptors before use", async () => {
  let state = "SAND_BOX_RUN_STATE_ABSENT", descriptor = "https://evil.example/box", requests = 0;
  const f = await server((q, s) => { q.resume(); q.on("end", () => {
    requests++;
    if (q.url!.endsWith("GetSandBoxRunState")) return json(s, { state });
    json(s, { execDaemonUrl: descriptor, execDaemonAuthToken: "EXEC", networkToken: "NETWORK" });
  }); });
  try {
    const client = new CursorSandProvisionClient({ fetchImpl: fetch, apiBase: f.url, allowTestLoopback: true });
    await assert.rejects(client.resolveBoxExec("not-a-session-token", machine, signal()),
      (e: unknown) => e instanceof SandProvisionError && e.code === "ACCOUNT_IDENTITY_INVALID");
    assert.equal(requests, 0);
    await assert.rejects(client.resolveBoxExec(accountToken, machine, signal()),
      (e: unknown) => e instanceof SandProvisionError && e.code === "BOX_NOT_RUNNING");
    assert.equal(requests, 1, "non-running Box must not receive Ensure");
    state = "SAND_BOX_RUN_STATE_RUNNING";
    await assert.rejects(client.resolveBoxExec(accountToken, machine, signal()),
      (e: unknown) => e instanceof SandProvisionError && e.code === "EXEC_DESCRIPTOR_INVALID");
    assert.equal(requests, 3, "one state + one Ensure; no retries on invalid descriptor");
    descriptor = "https://ok.cursorvm.com/box?token=leak";
    await assert.rejects(client.resolveBoxExec(accountToken, machine, signal()),
      (e: unknown) => e instanceof SandProvisionError && e.code === "EXEC_DESCRIPTOR_INVALID");
  } finally { await f.close(); }
});

test("Box Exec does not retry an ambiguous Ensure response", async () => {
  const methods: string[] = [];
  const f = await server((q, s) => { q.resume(); q.on("end", () => {
    methods.push(q.url!);
    if (q.url!.endsWith("GetSandBoxRunState")) return json(s, { state: "SAND_BOX_RUN_STATE_RUNNING" });
    json(s, {}, 503);
  }); });
  try {
    const client = new CursorSandProvisionClient({ fetchImpl: fetch, apiBase: f.url, allowTestLoopback: true });
    await assert.rejects(client.resolveBoxExec(accountToken, machine, signal()),
      (e: unknown) => e instanceof SandProvisionError && e.code === "BOX_CONTROL_PENDING" && e.httpStatus === 503);
    assert.deepEqual(methods.map((p) => p.split("/").at(-1)), ["GetSandBoxRunState", "EnsureSandBox"]);
  } finally { await f.close(); }
});
