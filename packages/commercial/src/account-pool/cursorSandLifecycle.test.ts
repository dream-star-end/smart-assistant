import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { CursorSandLifecycleCoordinator } from "./cursorSandLifecycle.js";
import { CursorSandProvisionClient } from "./cursorSandProvision.js";
import { readSandLifecycleState } from "./cursorSandState.js";

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
