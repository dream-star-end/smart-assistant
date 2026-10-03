// Test-only external engine transport. All gateway/session/callback consumers are real.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
assert.ok(process.env.OPENCLAUDE_HOME?.includes("oc-empty-engine-"));
assert.equal(process.env.HOME, process.env.OPENCLAUDE_HOME);
for (const key of Object.keys(process.env)) assert.ok(!/^(DATABASE_URL|PGHOST|.*API_KEY|OPENCLAUDE_V3_MASTER|OC_USER_ID|OC_CONTAINER_ID)$/.test(key), key);
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init: any) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "fixture network must remain loopback");
  return nativeFetch(input, init);
}) as typeof fetch;
process.stderr.write("OC_EMPTY_STAGE before-storage "+Date.now()+"\n");
const storage = await import("../../storage/src/index.js");
process.stderr.write("OC_EMPTY_STAGE before-gateway "+Date.now()+"\n");
const { Gateway } = await import("../../gateway/src/server.js");
const gatewayRequire = createRequire(new URL("../../gateway/src/server.js", import.meta.url));
const aliases = Object.fromEntries(["storage","protocol"].map(name => { const path=realpathSync(gatewayRequire.resolve("@openclaude/"+name)); assert.ok(path.startsWith(realpathSync(join(import.meta.dirname,"../.."))+"/"), "gateway alias must use this scratch source"); return [name,{path,sha256:createHash("sha256").update(readFileSync(path)).digest("hex")}]; }));
assert.equal((await import("@openclaude/storage")).getClientSession, storage.getClientSession, "fixture and Gateway storage must be the same module instance");
const { CcbAdapter } = await import("../../gateway/src/engine/ccbAdapter.js");
const { setV3MasterSinkSingleton } = await import("../../gateway/src/v3MasterSink.js");
const { getCcbLocalAgentCallbackState } = await import("../../gateway/src/ccbLocalAgentCallback.js");
const home = process.env.OPENCLAUDE_HOME!;
const agent = { id: "main", model: "glm-5.2" };
const agentsConfig = { agents: [agent], default: "main", routes: [] };
await storage.writeAgentsConfig(agentsConfig);
const config: any = { version: 1, gateway: { bind: "127.0.0.1", port: 0, accessToken: "proof-only" }, auth: { mode: "subscription", claudeCodePath: "/NONEXISTENT-NO-ENGINE-MAY-SPAWN" }, defaults: { model: "glm-5.2", permissionMode: "bypassPermissions" }, sessions: { dbPath: join(home, "sessions.db") }, channels: { webchat: { enabled: true } } };
process.stderr.write("OC_EMPTY_STAGE before-constructor "+Date.now()+"\n");
const gateway: any = new Gateway({ config, agentsConfig });
const sessions = gateway.sessions;
assert.equal(sessions.constructor, (await import("../../gateway/src/sessionManager.js")).SessionManager, "actual Gateway owns this exact SessionManager module");
const consumers=Object.fromEntries(["sessionManager","ccbLocalAgentCallback"].map(name=>{const path=realpathSync(fileURLToPath(new URL("../../gateway/src/"+name+".ts",import.meta.url)));return [name,{path,sha256:createHash("sha256").update(readFileSync(path)).digest("hex")}];}));
const payloads: any[] = [];
const durableFile = join(home, "terminal-payloads.json");
setV3MasterSinkSingleton({
  persistOrQueue: async (payload: any) => {
    payloads.push(structuredClone(payload));
    writeFileSync(durableFile, JSON.stringify(payloads));
    return { ok: true };
  },
} as any);
class ExternalCcbRunner extends EventEmitter {
  isRunning = true; lastActivityAt = Date.now(); submittedInputs: any[] = []; startCalls = 0;
  constructor(public mode: "empty" | "nonempty") { super(); }
  async start() { this.startCalls++; this.isRunning = true; }
  async shutdown() { this.isRunning = false; }
  async waitForOutputDrain() {}
  interrupt() { return false; }
  clearSessionId() {}
  model: string | undefined = "glm-5.2"; effortLevel: string | undefined; toolsets: string[] | undefined; executionTarget = { kind: "local" };
  setModel(model: string | undefined) { this.model = model; }
  setEffortLevel(level: string | undefined) { this.effortLevel = level; }
  setTraceId(_traceId: unknown) {}
  setGoalState(_goal: unknown) { return false; }
  updateConfig(_config: unknown) {}
  setToolsets(toolsets: string[] | undefined) { this.toolsets = toolsets; }
  setExecutionTarget(target: any) { this.executionTarget = target; }
  getBoundRepoBinding() { return null; }
  setConsultTurn(_binding: unknown) {}
  async submit(input: any) {
    this.submittedInputs.push(input);
    setImmediate(() => {
      this.emit("telemetry", { type: "_oc_telemetry", schemaVersion: 1, event: "turn.willCallApi", session_id: "fixture-native", data: {}, ts: Date.now() });
      if (this.mode === "nonempty") this.emit("message", { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "EMPTY_NONEMPTY_REAL_ANSWER" } } });
      this.emit("message", { type: "result", is_error: false, total_cost_usd: this.mode === "empty" ? 0 : 0.01, usage: this.mode === "empty" ? {} : { input_tokens: 3, output_tokens: 4 } });
    });
  }
}
const peers = new Map<string, { session: any; runner: ExternalCcbRunner; originalStarted: boolean }>();
async function createPeer(peer: string, mode: "empty" | "nonempty") {
  const sessionKey = `agent:main:webchat:dm:${peer}`;
  if (sessions.getByKey(sessionKey)) await sessions.destroySession(sessionKey);
  const now = Date.now();
  await storage.upsertClientSession({ id: peer, userId: "1", agentId: "main", title: "EMPTY proof", pinned: false, createdAt: now, lastAt: now, updatedAt: now, messages: [], modelId: "glm-5.2" });
  const session = await sessions.getOrCreate({ sessionKey, agent, model: "glm-5.2", channel: "webchat", peerId: peer, userId: "1", workspaceMode: "legacy", projectId: null });
  assert.equal(session.runner.isRunning, false, "original real runner must never have started");
  const original = session.runner;
  const runner = new ExternalCcbRunner(mode);
  session.runner = new CcbAdapter({ sessionKey } as any, runner as any);
  assert.notEqual(session.runner, original);
  peers.set(peer, { session, runner, originalStarted: original.isRunning });
  return { turns: await storage.getMaxTurnIdx([sessionKey]), memoryTurns: session.turns };
}
async function settled(peer: string) {
  const p = peers.get(peer)!;
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    await p.session.lock;
    await sessions.awaitPendingPersistence();
    if (!p.session._activeTurnCount && !p.session._activeClientTurnCount && !(gateway._syntheticTurnBarriers?.size ?? 0) && gateway._runtimeRecycleIngressActive === 0) return;
    await new Promise<void>(r => setImmediate(r));
  }
  throw new Error("real gateway/session consumers not settled");
}
async function snapshot(peer: string) {
  const p = peers.get(peer)!;
  return { sessionKey: p.session.sessionKey, turns: p.session.turns, inputCount: p.runner.submittedInputs.length, inputs: p.runner.submittedInputs, active: [p.session._activeTurnCount ?? 0, p.session._activeClientTurnCount ?? 0], originalStarted: p.originalStarted, payloads: JSON.parse(readFileSync(durableFile, "utf8")).filter((x: any) => x.sessionId === peer || x.sessionKey === p.session.sessionKey || x.peerId === peer), allPayloads: payloads, stored: await storage.getClientSession(peer, "1") };
}
writeFileSync(durableFile, "[]");
const failures: string[] = [];
const server = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const args = raw ? JSON.parse(raw) : {};
    let result: any;
    if (req.url === "/reset") { const baseline = await createPeer(args.peer, args.mode); result = { ok: true, ...baseline }; }
    else if (req.url === "/snapshot") { await settled(args.peer); result = await snapshot(args.peer); }
    else if (req.url === "/notify") {
      const p = peers.get(args.peer)!;
      gateway.handleCcbLocalAgentNotification(p.session, args.notification);
      const end = Date.now() + 12000;
      while (Date.now() < end && ["pending", "injecting"].includes(getCcbLocalAgentCallbackState(p.session.sessionKey, args.notification.taskId) ?? "")) await new Promise<void>(r => setImmediate(r));
      assert.ok(!["pending", "injecting"].includes(getCcbLocalAgentCallbackState(p.session.sessionKey, args.notification.taskId) ?? ""), "callback must reach settlement, not timeout");
      await settled(args.peer);
      result = await snapshot(args.peer);
      result.callbackState = getCcbLocalAgentCallbackState(p.session.sessionKey, args.notification.taskId) ?? null;
    } else if (req.url === "/failures") result = failures;
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e), stack: (e as Error).stack })); }
});
const wss = new WebSocketServer({ server });
wss.on("connection", ws => {
  ws.send(JSON.stringify({ type: "sys.relay_ready" }));
  ws.on("message", async raw => {
    try {
      const frame = JSON.parse(String(raw));
      if (frame.type === "ping") { ws.send(JSON.stringify({ type: "pong", id: frame.id })); return; }
      if (frame.type === "inbound.hello") { ws.send(JSON.stringify({ type: "sys.relay_ready" })); return; }
      if (frame.type !== "inbound.message") return;
      gateway.clientsByPeer.set(Gateway.makePeerKey("1", "webchat", frame.peer.id), new Set([ws]));
      await gateway.dispatchInbound({ ...frame, _userId: "1", _skipRateLimit: true });
    } catch (e) { failures.push((e as Error).stack ?? String(e)); console.error("FIXTURE_DISPATCH_ERROR", e); }
  });
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const sqlite = await (await import("../../storage/src/sessionsDb.js")).getSessionsDb();
const databaseFiles = sqlite.pragma("database_list") as Array<{file:string}>;
assert.ok(databaseFiles.some(row=>row.file.startsWith(home+"/")), "real SQLite must be within exclusive fixture HOME");
console.log("OC_EMPTY_READY " + JSON.stringify({ aliases, consumers, databaseFiles, url: "http://127.0.0.1:" + (server.address() as any).port, tree: realpathSync(join(import.meta.dirname, "../..")) }));
async function stop() {
  setV3MasterSinkSingleton(null);
  await sessions.shutdownAll();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.closeAllConnections(); server.close(() => process.exit(0));
}
process.on("SIGTERM", () => { void stop(); });
