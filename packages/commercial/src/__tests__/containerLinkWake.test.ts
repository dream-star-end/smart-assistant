import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import type { Pool } from "pg";
import { resetPool, setPoolOverride } from "../db/index.js";
import { _clearMaintenanceCache } from "../middleware/maintenanceMode.js";
import { WebSocket, WebSocketServer } from "ws";
import { ContainerLinkRegistry, getContainerLinkHandle } from "../ws/containerLink.js";
import { availableExecutors, registerBridgeExecutors, type RecoveryExecutor } from "../ws/bridgeExecutorRegistration.js";
import { ContainerLinkWake, waitForOriginExecutor } from "../ws/containerLinkWake.js";
import { hasBrowserActivity } from "../ws/containerLinkPolicy.js";
import type { CronOriginExecutor } from "../ws/originTurnInjection.js";
import type { ResolveContainerEndpoint, UserChatBridgeDeps } from "../ws/userChatBridge.js";
import type { Queryable } from "../dispatch/turnDispatchStore.js";

// Maintenance deliberately preserves its existing DB-error fail-open contract;
// unit tests never initialize an external PG connection for that global read.
beforeEach(() => {
  _clearMaintenanceCache();
  setPoolOverride({
    query: async () => { throw new Error("global settings DB unavailable in unit test"); },
    end: async () => {},
  } as unknown as Pool);
});
afterEach(async () => { await resetPool(); _clearMaintenanceCache(); });

type WakeOptions = ConstructorParameters<typeof ContainerLinkWake>[0];
type Endpoint = Awaited<ReturnType<ResolveContainerEndpoint>>;
const carrier = { uid: "42", containerId: 7 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class ConnectingTransport extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  ping(): void { this.emit("pong"); }
  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

/** Exercise wake and real link ownership; fake only the large bridge execution closure. */
async function fixture(extra: Partial<UserChatBridgeDeps> = {}, register = true) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let physicalConnections = 0;
  server.on("connection", () => { physicalConnections++; });
  const pool = { query: async () => ({ rows: [{ role: "user", status: "active" }], rowCount: 1 }) } as unknown as Queryable;
  const links = new ContainerLinkRegistry(pool, undefined, { heartbeatMs: 10_000 });
  const endpoint: Endpoint = { host: "127.0.0.1", port: (server.address() as { port: number }).port,
    containerId: carrier.containerId, bundleRev: "endpoint-stale-rev" };
  const maps = { recovery: new Map<string, Set<RecoveryExecutor>>(), origin: new Map<string, Set<CronOriginExecutor>>() };
  const contexts: Array<Parameters<WakeOptions["start"]>[6]> = [];
  let dials = 0;
  let activity = 0;
  let starts = 0;
  let originCalls = 0;
  const subscribers: WebSocket[] = [];
  const install = (socket: WebSocket) => registerBridgeExecutors(42n, socket, {
    recovery: () => {},
    origin: () => { originCalls++; return { kind: "claimed" }; },
  }, maps);
  const deps: UserChatBridgeDeps = {
    jwtSecret: "container-link-wake-test",
    resolveContainerEndpoint: async () => { throw new Error("wake must not provision"); },
    resolveContainerLinkEndpoint: async (uid, cid) => {
      assert.equal(uid, 42n); assert.equal(cid, 7); return endpoint;
    },
    pgPool: pool as UserChatBridgeDeps["pgPool"],
    markContainerActivity: () => { activity++; },
    containerConnectTimeoutMs: 1500,
    createContainerSocket: (host, port) => { dials++; return new WebSocket(`ws://${host}:${port}/ws`); },
    ...extra,
  };
  const wake = new ContainerLinkWake({
    links, deps, maxFrameBytes: 1024 * 1024,
    start(user, _uid, _endpoint, socket, _abort, _connId, context) {
      starts++; contexts.push(context); subscribers.push(user);
      const handle = getContainerLinkHandle(socket)!;
      assert.equal(handle.background, true);
      assert.equal(handle.retained, true, "pin precedes start even with no open streams");
      assert.equal(handle.hasOpenDispatches, false);
      // Simulate bridge teardown while retaining the production handle and link.
      const cleanup = () => { if (handle.detached && !handle.retained && !handle.hasOpenDispatches) socket.terminate(); };
      handle.onStreamsChanged = cleanup;
      user.on("close", () => { handle.detach(); cleanup(); });
      if (register) install(socket);
    },
  });
  return {
    wake, links, endpoint, maps, contexts, subscribers, install,
    dials: () => dials, starts: () => starts, activity: () => activity,
    physicalConnections: () => physicalConnections, originCalls: () => originCalls,
    stop: async () => {
      wake.stop(); await wake.drain(); await links.shutdown();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("concurrent headless acquire pins one context and one physical connection without open streams", { timeout: 5000 }, async () => {
  const endpointRead = deferred<Endpoint>();
  let reads = 0;
  const actualRevision = "actual-running-bundle-rev";
  const loadedRevisions: Array<string | undefined> = [];
  const rig = await fixture({
    resolveContainerLinkEndpoint: async () => { reads++; return endpointRead.promise; },
    readContainerLinkBundleRev: async (uid, cid) => { assert.equal(uid, 42n); assert.equal(cid, 7); return actualRevision; },
    loadAllowedModelChecker: async () => () => true,
    loadAgentModelResolver: async (_uid, options) => { loadedRevisions.push(options.bundleRev); return () => "running-model"; },
  });
  try {
    const acquisitions = Array.from({ length: 8 }, () => rig.wake.acquire(carrier));
    assert.equal(reads, 1);
    endpointRead.resolve(rig.endpoint);
    const leases = await Promise.all(acquisitions);
    assert.ok(leases.every((lease) => lease !== null));
    const first = leases[0]!;
    assert.ok(leases.every((lease) => lease!.socket === first.socket));
    assert.equal(rig.dials(), 1);
    assert.equal(rig.physicalConnections(), 1);
    assert.equal(rig.starts(), 1);
    assert.deepEqual(loadedRevisions, [actualRevision]);
    assert.equal(rig.contexts[0]!.role, "user");
    assert.equal(rig.contexts[0]!.checker!.isAllowed("running-model"), true);
    assert.equal(rig.contexts[0]!.agents!.resolve("main"), "running-model");
    assert.equal(rig.links.snapshots()[0]!.subscribers, 0);
    assert.deepEqual(rig.links.snapshots()[0]!.dispatches, []);
    assert.equal(hasBrowserActivity(true, rig.subscribers[0]!.readyState), false);
    assert.equal(rig.activity(), 0);
    first.release(); first.release();
    assert.equal(getContainerLinkHandle(first.socket)!.retained, true, "one caller cannot unpin the other callers");
    for (const lease of leases.slice(1)) lease!.release();
    assert.equal(getContainerLinkHandle(first.socket)!.disposed, true);
    assert.deepEqual(rig.links.snapshots(), []);
  } finally { endpointRead.resolve(rig.endpoint); await rig.stop(); }
});

test("detached execution keeps origin available but excludes recovery and recovery-only contexts", { timeout: 5000 }, async () => {
  const rig = await fixture();
  try {
    const lease = await rig.wake.acquire(carrier);
    assert.ok(lease);
    const handle = getContainerLinkHandle(lease.socket)!;
    assert.equal(handle.detached, true);
    assert.equal(availableExecutors(rig.maps.recovery.get("42")).length, 0);
    assert.equal(availableExecutors(rig.maps.origin.get("42")).length, 1);
    const origin = [...rig.maps.origin.get("42")!][0]!;
    assert.deepEqual(await origin({} as Parameters<CronOriginExecutor>[0]), { kind: "claimed" });
    assert.equal(rig.originCalls(), 1);
    handle.recoveryOnly = true;
    assert.equal(availableExecutors(rig.maps.origin.get("42")).length, 0);
    assert.deepEqual(await origin({} as Parameters<CronOriginExecutor>[0]), { kind: "not_claimed" });
    lease.release();
    assert.equal(rig.maps.origin.size, 0);
    assert.equal(rig.maps.recovery.size, 0);
  } finally { await rig.stop(); }
});

for (const value of ["pending", null, { host: "wrong-carrier", port: 0, containerId: 8 }] as const) {
  test(`unavailable or mismatched endpoint ${JSON.stringify(value)} does not dial or initialize context`, { timeout: 5000 }, async () => {
    let loads = 0;
    const rig = await fixture({
      resolveContainerLinkEndpoint: async () => value,
      loadAllowedModelChecker: async () => { loads++; return () => true; },
    });
    try {
      assert.equal(await rig.wake.acquire(carrier), null);
      assert.equal(rig.dials(), 0); assert.equal(rig.starts(), 0); assert.equal(loads, 0);
      assert.deepEqual(rig.links.snapshots(), []);
    } finally { await rig.stop(); }
  });
}

for (const mode of ["timeout", "shutdown"] as const) {
  test(`${mode} fences an endpoint that resolves after acquire already ended`, { timeout: 5000 }, async () => {
    const endpointRead = deferred<Endpoint>();
    const rig = await fixture({ containerConnectTimeoutMs: 30, resolveContainerLinkEndpoint: () => endpointRead.promise });
    try {
      const acquire = rig.wake.acquire(carrier);
      if (mode === "shutdown") rig.wake.stop();
      assert.equal(await acquire, null);
      endpointRead.resolve(rig.endpoint);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(rig.dials(), 0); assert.equal(rig.starts(), 0);
      assert.deepEqual(rig.links.snapshots(), []);
      if (mode === "shutdown") assert.equal(await rig.wake.acquire(carrier), null);
    } finally { endpointRead.resolve(rig.endpoint); await rig.stop(); }
  });
}

test("a socket that never opens times out and releases its retained context", { timeout: 5000 }, async () => {
  const physical = new ConnectingTransport();
  const rig = await fixture({ containerConnectTimeoutMs: 30,
    createContainerSocket: () => physical as unknown as WebSocket });
  try {
    assert.equal(await rig.wake.acquire(carrier), null);
    assert.equal(physical.readyState, WebSocket.CLOSED);
    assert.deepEqual(rig.links.snapshots(), []);
    assert.equal(rig.maps.origin.size, 0);
  } finally { await rig.stop(); }
});

for (const stage of ["checker", "agents", "bundle"] as const) {
  test(`${stage} initialization failure cannot open a transport or invoke the execution context`, { timeout: 5000 }, async () => {
    const fail = async (): Promise<never> => { throw new Error("execution context unavailable"); };
    const rig = await fixture({
      ...(stage === "checker" ? { loadAllowedModelChecker: fail } : {}),
      ...(stage === "agents" ? { loadAgentModelResolver: fail } : {}),
      ...(stage === "bundle" ? { readContainerLinkBundleRev: fail } : {}),
    });
    try {
      assert.equal(await rig.wake.acquire(carrier), null);
      assert.equal(rig.dials(), 0); assert.equal(rig.starts(), 0);
      assert.equal(rig.maps.origin.size, 0);
    } finally { await rig.stop(); }
  });
}

test("origin readiness follows executor registration after physical transport opens", { timeout: 5000 }, async () => {
  const rig = await fixture({}, false);
  try {
    const lease = await rig.wake.acquire(carrier);
    assert.ok(lease);
    let ready = false;
    const wait = waitForOriginExecutor(lease.socket, 1500).then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false, "physical open alone does not authorize origin injection");
    rig.install(lease.socket);
    getContainerLinkHandle(lease.socket)!.emit("message", Buffer.from("{}"), false);
    await wait;
    assert.equal(ready, true);
    lease.release();
  } finally { await rig.stop(); }
});

test("origin registration wait fails on deadline or physical shutdown", { timeout: 5000 }, async () => {
  const rig = await fixture({}, false);
  try {
    const lease = await rig.wake.acquire(carrier);
    assert.ok(lease);
    await assert.rejects(waitForOriginExecutor(lease.socket, 30), /unavailable/);
    const waiting = assert.rejects(waitForOriginExecutor(lease.socket, 1500), /unavailable/);
    await rig.links.shutdown();
    await waiting;
    lease.release();
  } finally { await rig.stop(); }
});


test("disabled users cannot acquire an execution context", { timeout: 5000 }, async () => {
  let roleReads = 0;
  const disabledPool = { query: async () => {
    roleReads++;
    return { rows: [{ role: "user", status: "disabled" }], rowCount: 1 };
  } } as unknown as UserChatBridgeDeps["pgPool"];
  const rig = await fixture({ pgPool: disabledPool });
  try {
    assert.equal(await rig.wake.acquire(carrier, { execution: true }), null);
    assert.equal(roleReads, 1);
    assert.equal(rig.dials(), 0);
    assert.equal(rig.starts(), 0);
    assert.equal(rig.maps.origin.size, 0);
    assert.deepEqual(rig.links.snapshots(), []);
  } finally { await rig.stop(); }
});

test("the same disabled user may acquire a control-only link without execution grants", { timeout: 5000 }, async () => {
  let roleReads = 0;
  let grantLoads = 0;
  const disabledPool = { query: async () => {
    roleReads++;
    return { rows: [{ role: "user", status: "disabled" }], rowCount: 1 };
  } } as unknown as UserChatBridgeDeps["pgPool"];
  const rig = await fixture({
    pgPool: disabledPool,
    loadAllowedModelChecker: async () => { grantLoads++; return () => true; },
    loadAgentModelResolver: async () => { grantLoads++; return () => "model"; },
    readContainerLinkBundleRev: async () => { throw new Error("control must not need bundle execution authority"); },
  });
  try {
    const lease = await rig.wake.acquire(carrier, { execution: false });
    assert.ok(lease);
    assert.equal(rig.dials(), 1);
    assert.equal(rig.starts(), 1);
    assert.equal(roleReads, 0, "control delivery does not reauthorize a new user execution");
    assert.equal(grantLoads, 0);
    assert.equal(rig.contexts[0]!.checker, null);
    assert.equal(rig.contexts[0]!.agents, null);
    assert.equal(getContainerLinkHandle(lease.socket)!.recoveryOnly, true);
    assert.equal(availableExecutors(rig.maps.origin.get("42")).length, 0);
    assert.equal(rig.activity(), 0);
    lease.release();
    assert.deepEqual(rig.links.snapshots(), []);
  } finally { await rig.stop(); }
});
