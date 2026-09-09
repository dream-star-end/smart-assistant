import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { CursorSandLifecycleCoordinator } from "./cursorSandLifecycle.js";
import { CursorSandProvisionClient } from "./cursorSandProvision.js";
import { readSandLifecycleState, writeSandJsonAtomic, SAND_STATE_FILE, sandHash, type SandLifecycleState } from "./cursorSandState.js";
import { syncCursorAuthDir } from "./cursorMaterializer.js";

test("lost install response survives new processes without a second create/send; only a real probe promotes ready", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-coordinator-"));
  const token = "x." + Buffer.from(JSON.stringify({ type: "session", sub: "same-principal", exp: 2_000_000_000 })).toString("base64url") + ".y";
  const moduleHash = "d".repeat(64), machine = "a".repeat(32);
  let now = Date.now(), creates = 0, sends = 0, installed = false;
  const agents: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", (x) => chunks.push(x));
    req.on("end", () => {
      const path = req.url!, body = Buffer.concat(chunks).toString();
      const reply = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path.endsWith("GetSandBoxRunState")) return reply({ state: "SAND_BOX_RUN_STATE_RUNNING" });
      if (path.endsWith("EnsureSandBox")) return reply({ gatewayUrl: base + "/box", gatewayToken: "GATE", networkToken: "NET" });
      assert.equal(req.headers.authorization, "Bearer GATE");
      if (path.endsWith("/health")) return reply({ ok: true, pid: 321, isBusy: false });
      if (path.endsWith("InferenceService/Stream")) return installed ? reply({ protocol: "oc-sand-relay-v2", moduleSha256: moduleHash, nonce: req.headers["x-oc-sand-box-probe-nonce"], active: 0, maxConcurrent: 4 }) : reply({}, 404);
      if (path.endsWith("/listAgents")) return reply(agents);
      if (path.endsWith("/createAgent")) { creates++; const data = JSON.parse(body); agents.push({ id: "owned-maintenance-bot", description: data.description, isRunning: false }); return reply({ id: "owned-maintenance-bot" }); }
      if (path.endsWith("/sendPrompt")) { sends++; req.socket.destroy(); return; }
      return reply({}, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const row: any = { id: 1n, provider: "cursor", status: "active", cursor_sand_enabled: true, runtime_channel: "v5" };
  const deps = { authDir: dir, moduleHash, listAccounts: async () => [row], getAccount: async () => row,
    getTokenSnapshot: async () => ({ id: 1n, token: Buffer.from(token), refresh: null, credential_kind: "session" as const, machine_id: machine, expires_at: null }),
    clientFor: async () => ({ client: new CursorSandProvisionClient({ fetchImpl: fetch, apiBase: base, allowTestLoopback: true }) }),
    installerPrompt: () => "synthetic deterministic installer", onChange: () => {}, now: () => now };
  const first = new CursorSandLifecycleCoordinator(deps);
  const children = new Set<ReturnType<typeof spawn>>();
  async function inNewProcess() {
    const script = `
      const {CursorSandLifecycleCoordinator}=await import(${JSON.stringify(new URL("./cursorSandLifecycle.ts", import.meta.url).href)});
      const {CursorSandProvisionClient}=await import(${JSON.stringify(new URL("./cursorSandProvision.ts", import.meta.url).href)});
      const row={id:1n,provider:'cursor',status:'active',cursor_sand_enabled:true,runtime_channel:'v5'};
      const c=new CursorSandLifecycleCoordinator({authDir:${JSON.stringify(dir)},moduleHash:${JSON.stringify(moduleHash)},listAccounts:async()=>[row],getAccount:async()=>row,
      getTokenSnapshot:async()=>({id:1n,token:Buffer.from(${JSON.stringify(token)}),refresh:null,credential_kind:'session',machine_id:${JSON.stringify(machine)},expires_at:null}),
      clientFor:async()=>({client:new CursorSandProvisionClient({fetchImpl:fetch,apiBase:${JSON.stringify(base)},allowTestLoopback:true})}),
      installerPrompt:()=>{throw Error('must not reinstall')},onChange:()=>{},now:()=>${now}});
      try{await c.tick()}finally{await c.stop()}
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
    let err = ""; child.stdout.resume(); child.stderr.on("data", (b) => { err += b; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { const exit = await new Promise<number | null>((r, reject) => { child.on("error", reject); child.on("close", r); }); assert.equal(exit, 0, err); }
    finally { clearTimeout(timer); children.delete(child); }
  }
  try {
    await first.tick(); await first.stop();
    assert.deepEqual({ creates, sends }, { creates: 1, sends: 1 });
    const original = Object.values(readSandLifecycleState(dir).operations)[0];
    assert.equal(original.phase, "install-intent");
    now += 60_001; await inNewProcess();
    assert.deepEqual({ creates, sends }, { creates: 1, sends: 1 });
    assert.equal(Object.values(readSandLifecycleState(dir).operations)[0].nonce, original.nonce);
    assert.notEqual(readSandLifecycleState(dir).accounts["1"].phase, "ready");
    installed = true; now += 60_001; await inNewProcess();
    assert.equal(readSandLifecycleState(dir).accounts["1"].phase, "ready");
    assert.deepEqual({ creates, sends }, { creates: 1, sends: 1 });
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await first.stop(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("healthy periodic recheck keeps actual slots and policy usable; genuine rejection still withdraws", { timeout: 15_000 }, async () => {
  const CoordinatorUnderTest = process.env.OC_SAND_C2_NEGATIVE === "1"
    ? (assert.equal(createHash("sha256").update(readFileSync(new URL("./cursorSandLifecycle.c2-baseline.ts", import.meta.url))).digest("hex"), "7d2ea72bf7ccb41ae191763099e9962f37a96aadd4d97231855a8960ab972454"), (await import(new URL("./cursorSandLifecycle.c2-baseline.ts", import.meta.url).href)).CursorSandLifecycleCoordinator)
    : CursorSandLifecycleCoordinator;
  const dir = mkdtempSync(join(tmpdir(), "sand-ready-recheck-"));
  const token = "headerheader." + Buffer.from(JSON.stringify({ type: "session", sub: "ready-principal", exp: 2_000_000_000 })).toString("base64url") + ".signaturesignature";
  const machine = "a".repeat(32), subject = sandHash("ready-principal"), moduleHash = "d".repeat(64);
  let now = Date.now(), release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((r) => { release = r; }), started = new Promise<void>((r) => { entered = r; });
  let first = true, mode: "ok" | "network" | "rejected" = "ok";
  const row: any = { id: 1n, provider: "cursor", status: "active", cursor_sand_enabled: true, runtime_channel: "v5", cooldown_until: null };
  const snapshot = async () => ({ id: 1n, token: Buffer.from(token), refresh: null, credential_kind: "session" as const, machine_id: machine, expires_at: new Date(2_000_000_000_000) });
  const state: SandLifecycleState = { version: 1, accounts: { "1": { credentialHash: sandHash(token), subjectHash: subject, machineId: machine, machineHash: sandHash(machine), phase: "ready", updatedAt: now - 600_000, readyUntil: now + 3600_000 } }, operations: { [subject]: { nonce: "oc-sand-" + "a".repeat(32), moduleHash, phase: "ready", startedAt: now - 600_000, nextAttemptAt: 0 } } };
  writeSandJsonAtomic(dir, SAND_STATE_FILE, state, () => true);
  const materialize = () => syncCursorAuthDir({ authDir: dir, lifecycleManaged: true, now: () => new Date(now), listAccounts: async () => [row], getCursorTokenSnapshot: snapshot, createAccount: async () => { throw Error("no import"); } });
  const coordinator = new CoordinatorUnderTest({ authDir: dir, moduleHash, listAccounts: async () => [row], getAccount: async () => row, getTokenSnapshot: snapshot, installerPrompt: () => { throw Error("no installation for healthy binding"); }, onChange: () => {}, now: () => now,
    clientFor: async () => ({ client: new CursorSandProvisionClient({ now: () => now, fetchImpl: async (url, init) => {
      if (url.endsWith("GetSandBoxRunState")) {
        if (first) { first = false; entered(); await barrier; }
        if (mode === "network") throw Error("network unavailable");
        return Response.json({ state: "SAND_BOX_RUN_STATE_RUNNING" });
      }
      if (url.endsWith("EnsureSandBox")) return Response.json({ gatewayUrl: "https://ready.cursorvm.com", gatewayToken: "G", networkToken: "N" });
      if (mode === "rejected") return Response.json({}, { status: 401 });
      return Response.json({ protocol: "oc-sand-relay-v2", moduleSha256: moduleHash, nonce: new Headers(init.headers).get("x-oc-sand-box-probe-nonce"), active: 0, maxConcurrent: 4 });
    } }) }) });
  let running: Promise<void> | undefined;
  try {
    assert.equal((await materialize()).written, 1);
    running = coordinator.tick(); await started;
    assert.equal((await materialize()).written, 1, "slow healthy recheck must not withdraw the account");
    const policy = JSON.parse(readFileSync(join(dir, ".sand-box-policy.json"), "utf8")); assert.equal(policy.accounts.length, 1);
    const { CursorSandBoxResolver } = await import(new URL("../../../gateway/src/engine/cursorSandBox.ts", import.meta.url).href);
    const resolver = new CursorSandBoxResolver({ accountId: "1", credentialKind: "session", readPolicy: () => JSON.parse(readFileSync(join(dir, ".sand-box-policy.json"), "utf8")), fetchImpl: async (url: string) => Response.json(url.endsWith("GetSandBoxRunState") ? { state: "SAND_BOX_RUN_STATE_RUNNING" } : { gatewayUrl: "https://ready.cursorvm.com", gatewayToken: "G", networkToken: "N" }) });
    assert.ok(await resolver.resolve(token, machine, new AbortController().signal));
    release(); await running;
    assert.equal((await materialize()).written, 1);
    now += 300_001; mode = "network"; await coordinator.tick();
    assert.equal((await materialize()).written, 1, "transient failure retains an unexpired ready binding");
    now += 60_001; mode = "rejected"; await coordinator.tick();
    assert.equal((await materialize()).written, 0, "actual gateway rejection must withdraw readiness");
  } finally { release(); await running; await coordinator.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("GET capability probe upgrades a real legacy relay without any empty inference requests", { timeout: 15_000 }, async () => {
  const require = createRequire(import.meta.url);
  const legacyPath = new URL("../../../../scripts/cursor-sand-box-relay/fixtures/legacy-relay.cjs", import.meta.url);
  assert.equal(createHash("sha256").update(readFileSync(legacyPath)).digest("hex"), "97200144b9a591503687a7c06b8fc0597454590a496eeb0de31872a2a514203a");
  const modernPath = new URL("../../../../scripts/cursor-sand-box-relay/relay.cjs", import.meta.url), moduleHash = createHash("sha256").update(readFileSync(modernPath)).digest("hex");
  const dir = mkdtempSync(join(tmpdir(), "sand-legacy-upgrade-"));
  let tokenCalls = 0, upstreamCalls = 0, creates = 0, sends = 0, now = Date.now();
  const options = { authorize: (q: any, t: string) => q.headers.authorization === "Bearer " + t, getAuth: () => ({ getGrokBotToken: async () => { tokenCalls++; return "INFERENCE"; }, getMachineId: () => "a".repeat(32), backend: { backendUrl: "https://api2.cursor.sh", clientVersion: "0.44.0", boxNamespace: "prod" } }), createChecksum: () => "checksum", httpClient: async () => { upstreamCalls++; return { status: 400, header: new Headers({ "content-type": "application/json" }), body: (async function* () { yield Buffer.from('{"error":"empty request"}'); })() }; } };
  let handler = require(legacyPath.pathname).createRelay(options);
  const agents: any[] = [];
  const server = createServer((q, s) => {
    const reply = (value: unknown) => { s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify(value)); };
    if (q.url!.endsWith("InferenceService/Stream")) return void handler({ authToken: "G" }, q, s);
    const chunks: Buffer[] = []; q.on("data", x => chunks.push(x)); q.on("end", () => {
      if (q.url!.endsWith("GetSandBoxRunState")) return reply({ state: "SAND_BOX_RUN_STATE_RUNNING" });
      if (q.url!.endsWith("EnsureSandBox")) return reply({ gatewayUrl: base, gatewayToken: "G", networkToken: "N" });
      if (q.url!.endsWith("/health")) return reply({ ok: true, pid: 123, isBusy: false });
      if (q.url!.endsWith("/listAgents")) return reply(agents);
      if (q.url!.endsWith("/createAgent")) { creates++; agents.push({ id: "own", description: JSON.parse(Buffer.concat(chunks).toString()).description, isRunning: false }); return reply({ id: "own" }); }
      if (q.url!.endsWith("/sendPrompt")) { sends++; handler = require(modernPath.pathname).createRelay(options); return reply({ accepted: true }); }
      s.writeHead(404); s.end();
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const token = "x." + Buffer.from(JSON.stringify({ type: "session", sub: "legacy", exp: 2_000_000_000 })).toString("base64url") + ".y";
  const row: any = { id: 1n, provider: "cursor", status: "active", runtime_channel: "v5", cursor_sand_enabled: true };
  const coordinator = new CursorSandLifecycleCoordinator({ authDir: dir, moduleHash, listAccounts: async () => [row], getAccount: async () => row, getTokenSnapshot: async () => ({ id: 1n, credential_kind: "session", token: Buffer.from(token), machine_id: "a".repeat(32), expires_at: null, refresh: null }), clientFor: async () => ({ client: new CursorSandProvisionClient({ fetchImpl: fetch, apiBase: base, allowTestLoopback: true }) }), installerPrompt: () => "synthetic guarded installation", onChange: () => {}, now: () => now });
  try {
    const old = await fetch(base + "/sand-stream-relay/aiserver.v1.InferenceService/Stream", { method: "POST", body: "", headers: { authorization: "Bearer G", "content-type": "application/connect+proto" } });
    assert.equal(old.status, 400); await old.text(); assert.equal(upstreamCalls, 1, "positive control: legacy POST reaches rejected inference"); tokenCalls = upstreamCalls = 0;
    await coordinator.tick(); assert.deepEqual({ creates, sends, tokenCalls, upstreamCalls }, { creates: 1, sends: 1, tokenCalls: 0, upstreamCalls: 0 });
    now += 60_001; await coordinator.tick(); assert.equal(readSandLifecycleState(dir).accounts["1"].phase, "ready");
    assert.deepEqual({ creates, sends, tokenCalls, upstreamCalls }, { creates: 1, sends: 1, tokenCalls: 0, upstreamCalls: 0 });
  } finally { await coordinator.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
});

test("API-key exchange transient failures retain exact ready expiry; expiry and explicit rejection still withdraw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-exchange-recheck-"));
  const key = "crsr_" + "a".repeat(64), machine = "b".repeat(32), subject = sandHash("api-principal"), moduleHash = "c".repeat(64);
  const now = Date.now(), until = now + 3600_000;
  const row: any = { id: 1n, provider: "cursor", status: "active", runtime_channel: "v5", cursor_sand_enabled: true, cooldown_until: null };
  const snapshot = async () => ({ id: 1n, token: Buffer.from(key), refresh: null, machine_id: null, credential_kind: "api_key" as const, expires_at: null });
  try {
    for (const [status, expired, expected] of [[503, false, 1], [429, false, 1], [408, false, 1], [500, false, 1], [401, false, 0], [403, false, 0], [503, true, 0]] as const) {
      const readyUntil = expired ? now - 1 : until;
      const state: SandLifecycleState = { version: 1, accounts: { "1": { credentialHash: sandHash(key), subjectHash: subject, machineId: machine, machineHash: sandHash(machine), phase: "ready", updatedAt: now - 600_000, readyUntil } }, operations: { [subject]: { nonce: "oc-sand-" + "a".repeat(32), moduleHash, phase: "ready", machineId: machine, startedAt: now - 600_000, nextAttemptAt: 0 } } };
      writeSandJsonAtomic(dir, SAND_STATE_FILE, state, () => true);
      let calls = 0;
      const c = new CursorSandLifecycleCoordinator({ authDir: dir, moduleHash, listAccounts: async () => [row], getAccount: async () => row, getTokenSnapshot: snapshot, now: () => now, onChange: () => {}, installerPrompt: () => { throw Error("must not install"); },
        clientFor: async () => ({ client: new CursorSandProvisionClient({ now: () => now, fetchImpl: async (url) => { assert.ok(url.endsWith("/auth/exchange_user_api_key")); calls++; return Response.json({}, { status }); } }) }) });
      try { await c.tick(); } finally { await c.stop(); }
      const result = await syncCursorAuthDir({ authDir: dir, lifecycleManaged: true, listAccounts: async () => [row], getCursorTokenSnapshot: snapshot, now: () => new Date(now), createAccount: async () => { throw Error("no import"); } });
      assert.equal(result.written, expected, `exchange ${status}, expired=${expired}`);
      assert.equal(calls, 1);
      const after = readSandLifecycleState(dir).accounts["1"];
      if (expected === 1) { assert.equal(after.phase, "ready"); assert.equal(after.readyUntil, until, "background failure must not extend readiness"); }
      else assert.notEqual(after.phase, "ready");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
