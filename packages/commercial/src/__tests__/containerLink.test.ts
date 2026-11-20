import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { ContainerLinkRegistry, getContainerLinkHandle } from "../ws/containerLink.js";
import { registerBridgeExecutors, availableExecutors, type RecoveryExecutor } from "../ws/bridgeExecutorRegistration.js";
import { registerBridgeTransport } from "../ws/containerLinkTransport.js";
import type { CronOriginExecutor } from "../ws/userChatBridge.js";
import { containerLinkEnabled, hasBrowserActivity } from "../ws/containerLinkPolicy.js";
import { CONTAINER_ATTEST_FRAME_TYPE } from "../ws/userChatBridgeTypes.js";
import type { Queryable } from "../dispatch/turnDispatchStore.js";

class Transport extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  send(data: Buffer, _opts?: unknown, cb?: (err?: Error) => void): void {
    this.sent.push(JSON.parse(String(data)));
    cb?.();
  }
  ping(): void { this.emit("pong"); }
  terminate(): void { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  push(frame: unknown): void { this.emit("message", Buffer.from(JSON.stringify(frame)), false); }
}
const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Queryable;
const wire = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

test("RF-link: concurrent dial is singleflight; attestation, grants, billing, receipt each reach correct consumer", async () => {
  const registry = new ContainerLinkRegistry(pool);
  const physical = new Transport();
  let dials = 0;
  const dial = async () => { dials++; return physical as unknown as WebSocket; };
  try {
    const [one, two] = await Promise.all([registry.connect(1n, 7, dial), registry.connect(1n, 7, dial)]);
    const a: Record<string, any>[] = [];
    const b: Record<string, any>[] = [];
    one.on("message", (data) => a.push(JSON.parse(String(data))));
    two.on("message", (data) => b.push(JSON.parse(String(data))));
    getContainerLinkHandle(one)!.activate();
    physical.push({type: CONTAINER_ATTEST_FRAME_TYPE, challenge: "one-physical-challenge"});
    getContainerLinkHandle(two)!.activate();
    assert.equal(dials, 1);
    assert.equal(a[0]?.challenge, b[0]?.challenge);
    a.length = b.length = 0;
    one.send(wire({type: "inbound.message", peer: {id: "s1"}, clientMessageId: "m1", requestId: "bill1", __oc_prompt_queue_grant: {grantId: "grant1"}}));
    two.send(wire({type: "inbound.message", peer: {id: "s2"}, clientMessageId: "m2", requestId: "bill2"}));
    getContainerLinkHandle(one)!.detach();
    physical.push({type: "outbound.control.turn_dispatch_receipt", sessionId: "s1", clientMessageId: "m1"});
    physical.push({type: "outbound.prompt_queue.dispatch_activated", grantId: "grant1"});
    physical.push({type: "outbound.prompt_queue.dispatch_cancel", grantId: "grant1"});
    physical.push({type: "outbound.codex_billing", requestId: "bill1"});
    physical.push({type: "outbound.message", peer: {id: "s1"}, clientMessageId: "m1", frameSeq: 2});
    assert.equal(a.length, 5);
    assert.equal(b.length, 0);
    physical.push({type: "outbound.codex_billing", requestId: "bill2"});
    assert.equal(b.length, 1);
    one.terminate();
    assert.equal(physical.readyState, WebSocket.OPEN);
    two.terminate();
    assert.equal(physical.readyState, WebSocket.CLOSED);
  } finally { await registry.shutdown(); }
});

test("RF-link: two tabs with the same ping id receive only their own restored pong", async () => {
  const registry = new ContainerLinkRegistry(pool);
  const physical = new Transport();
  try {
    const a = await registry.connect(1n, 1, () => physical as unknown as WebSocket);
    const b = await registry.connect(1n, 1, () => { throw new Error("must attach"); });
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    a.on("message", (data) => gotA.push(JSON.parse(String(data))));
    b.on("message", (data) => gotB.push(JSON.parse(String(data))));
    getContainerLinkHandle(a)!.activate(); getContainerLinkHandle(b)!.activate();
    a.send(wire({type: "ping", id: "collision"}));
    b.send(wire({type: "ping", id: "collision"}));
    assert.notEqual(physical.sent[0]!.id, physical.sent[1]!.id);
    physical.push({type: "pong", id: physical.sent[1]!.id});
    assert.deepEqual(gotA, []);
    assert.deepEqual(gotB, [{type: "pong", id: "collision"}]);
    physical.push({type: "pong", id: physical.sent[0]!.id});
    assert.deepEqual(gotA, [{type: "pong", id: "collision"}]);
  } finally { await registry.shutdown(); }
});

test("RF-link: model switch control response returns to its requesting tab", async () => {
  const registry = new ContainerLinkRegistry(pool);
  const physical = new Transport();
  try {
    const a = await registry.connect(1n, 1, () => physical as unknown as WebSocket);
    const b = await registry.connect(1n, 1, () => { throw new Error("must attach"); });
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    a.on("message", (data) => gotA.push(JSON.parse(String(data))));
    b.on("message", (data) => gotB.push(JSON.parse(String(data))));
    getContainerLinkHandle(a)!.activate(); getContainerLinkHandle(b)!.activate();
    const sessionKey = "agent:main:webchat:dm:session-b";
    b.send(wire({type: "control.session.prepare_model_switch", requestId: "switch-b", sessionKey}));
    const response = {type: "outbound.model_switch.prepared", requestId: "switch-b", sessionKey, status: "completed"};
    physical.push(response);
    assert.deepEqual(gotA, []);
    assert.deepEqual(gotB, [response]);
    const sessionResponse = {type: "outbound.control", sessionKey};
    physical.push(sessionResponse);
    assert.deepEqual(gotA, []);
    assert.deepEqual(gotB, [response, sessionResponse]);
  } finally { await registry.shutdown(); }
});

test("RF-link: every bridge receives transport error before close, including reentrant cleanup", async () => {
  const registry = new ContainerLinkRegistry(pool);
  const physical = new Transport();
  try {
    const sockets = await Promise.all([1, 2].map(() => registry.connect(1n, 1, () => physical as unknown as WebSocket)));
    const events = sockets.map(() => [] as string[]);
    for (const [i, socket] of sockets.entries()) {
      socket.on("error", (error) => {
        events[i]!.push(error.message);
        socket.terminate(); // userChatBridge cleanup releases its own handle
      });
      socket.on("close", () => events[i]!.push("close"));
      getContainerLinkHandle(socket)!.activate();
    }
    physical.emit("error", new Error("transport error"));
    assert.deepEqual(events, [["transport error", "close"], ["transport error", "close"]]);
    assert.deepEqual(registry.snapshots(), []);
  } finally { await registry.shutdown(); }
});

test("RF-link: shutdown fences a late async dial and leaves no transport", async () => {
  const registry = new ContainerLinkRegistry(pool);
  const physical = new Transport();
  let finish!: (ws: WebSocket) => void;
  const connected = registry.connect(1n, 7, () => new Promise<WebSocket>((r) => { finish = r; }));
  const rejected = assert.rejects(connected, /shutting down/);
  await Promise.resolve();
  const stopping = registry.shutdown();
  finish(physical as unknown as WebSocket);
  await Promise.all([rejected, stopping]);
  assert.deepEqual(registry.snapshots(), []);
  assert.equal(physical.readyState, WebSocket.CLOSED);
  await assert.rejects(registry.connect(1n, 7, () => physical as unknown as WebSocket), /shutting down/);
});

test("RF-link: defaults and subscriber activity distinguish selfhost, rollback and idle links", () => {
  assert.equal(containerLinkEnabled("selfhost", {}), true);
  assert.equal(containerLinkEnabled("commercial", {}), false);
  assert.equal(containerLinkEnabled(undefined, {}), false);
  assert.equal(containerLinkEnabled("selfhost", {OC_CONTAINER_LINK: "0"}), false);
  assert.equal(containerLinkEnabled("commercial", {OC_CONTAINER_LINK: "1"}), true);
  assert.equal(hasBrowserActivity(false, WebSocket.OPEN), true);
  assert.equal(hasBrowserActivity(true, WebSocket.OPEN), false, "background link cannot keep idleSweep active");
  assert.equal(hasBrowserActivity(false, WebSocket.CLOSED), false);
});


test("RF-step3: one stable executor and control transport across tabs, detach and shutdown", async () => {
  const registry = new ContainerLinkRegistry(pool);
  const physical = new Transport();
  const maps = { recovery: new Map<string, Set<RecoveryExecutor>>(), origin: new Map<string, Set<CronOriginExecutor>>() };
  const transports = new Map<string, Set<WebSocket>>();
  try {
    const [a, b] = await Promise.all([1, 2].map(() => registry.attach(1n, 7, () => physical as unknown as WebSocket)));
    const calls: string[] = [];
    for (const [i, socket] of [a, b].entries()) {
      getContainerLinkHandle(socket)!.activate();
      registerBridgeTransport(1n, socket, transports);
      registerBridgeExecutors(1n, socket, {
        recovery: () => { calls.push(`recovery-${i}`); },
        origin: () => { calls.push(`origin-${i}`); return { kind: "not_claimed" }; },
      }, maps);
    }
    assert.equal(maps.recovery.get("1")!.size, 1);
    assert.equal(maps.origin.get("1")!.size, 1);
    assert.equal(transports.get("1")!.size, 1);
    const executor = [...maps.origin.get("1")!][0]!;
    await executor({} as Parameters<CronOriginExecutor>[0]);
    getContainerLinkHandle(a)!.detach();
    a.terminate();
    assert.equal([...maps.origin.get("1")!][0], executor, "detach keeps the same link executor");
    await executor({} as Parameters<CronOriginExecutor>[0]);
    assert.deepEqual(calls, ["origin-0", "origin-1"]);
    for (const socket of transports.get("1")!) socket.send(wire({type: "inbound.goal_sync", goal: {}}));
    assert.equal(physical.sent.length, 1, "one goal/control send per physical transport");
    getContainerLinkHandle(b)!.detach();
    assert.equal(availableExecutors(maps.recovery.get("1")).length, 0, "step4 wakeup is not implemented");
    assert.deepEqual(await executor({} as Parameters<CronOriginExecutor>[0]), {kind: "not_claimed"});
    await registry.shutdown();
    assert.equal(maps.origin.size, 0);
    assert.equal(maps.recovery.size, 0);
    assert.equal(transports.size, 0);
  } finally { await registry.shutdown(); }
});

test("RF-step3: hello uses persisted link cursor once, preserves bind ordering and strips tab terminal hints", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const queryPool = { query: async () => {
    reads++;
    await barrier;
    return { rows: [{after_seq: "12", active_message_ids: ["running-id"]}], rowCount: 1 };
  } } as unknown as Queryable;
  const registry = new ContainerLinkRegistry(queryPool);
  const physical = new Transport();
  try {
    const a = await registry.attach(1n, 7, () => physical as unknown as WebSocket);
    const b = await registry.attach(1n, 7, () => { throw new Error("second dial"); });
    getContainerLinkHandle(a)!.activate(); getContainerLinkHandle(b)!.activate();
    const hello = {type: "inbound.hello", peers: [{peerId: "session", agentId: "main", lastFrameSeq: 999,
      inFlight: true, inFlightClientMessageId: "stale-tab-turn", resumeActiveTurnCandidateMessageIds: ["stale-tab-turn"]}]};
    const send = (socket: WebSocket, frame: unknown) => new Promise<void>((resolve, reject) =>
      socket.send(wire(frame), {binary: false}, (error) => error ? reject(error) : resolve()));
    const first = send(a, hello);
    const bind = send(b, {type: "inbound.control.session_repo_bind", sessionId: "session"});
    const second = send(b, hello);
    await Promise.resolve();
    assert.equal(physical.sent.length, 0, "bind cannot overtake link hello while PG cursor is loading");
    release();
    await Promise.all([first, bind, second]);
    assert.equal(reads, 1);
    assert.deepEqual(physical.sent.map((frame) => frame.type), ["inbound.hello", "inbound.control.session_repo_bind", "inbound.hello"]);
    assert.deepEqual(physical.sent[0]!.peers, [{peerId: "session", agentId: "main", lastFrameSeq: 12}]);
    assert.deepEqual(physical.sent[2]!.peers, [{peerId: "session", agentId: "main", lastFrameSeq: -1}], "second tab refreshes snapshots without container ring replay");
  } finally { await registry.shutdown(); }
});

test("RF-step3: first link without persisted frames requests the PG open turn, not the tab's guessed turn", async () => {
  const queryPool = { query: async () => ({ rows: [{after_seq: null, active_message_ids: ["pg-turn"]}], rowCount: 1 }) } as unknown as Queryable;
  const registry = new ContainerLinkRegistry(queryPool);
  const physical = new Transport();
  try {
    const socket = await registry.attach(1n, 7, () => physical as unknown as WebSocket);
    getContainerLinkHandle(socket)!.activate();
    await new Promise<void>((resolve, reject) => socket.send(wire({type: "inbound.hello", peers: [{peerId: "s", inFlight: true, inFlightClientMessageId: "wrong"}]}), {}, (err) => err ? reject(err) : resolve()));
    assert.deepEqual(physical.sent[0]!.peers, [{peerId: "s", agentId: "main", lastFrameSeq: 0, resumeActiveTurnCandidateMessageIds: ["pg-turn"]}]);
  } finally { await registry.shutdown(); }
});


test("RF-step3: closing the first tab during cursor lookup does not suppress another tab's missing-frame replay", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const registry = new ContainerLinkRegistry({ query: async () => {
    reads++;
    await barrier;
    return { rows: [{after_seq: "12", active_message_ids: []}], rowCount: 1 };
  } } as unknown as Queryable);
  const physical = new Transport();
  try {
    const a = await registry.attach(1n, 7, () => physical as unknown as WebSocket);
    const b = await registry.attach(1n, 7, () => { throw new Error("second dial"); });
    getContainerLinkHandle(a)!.activate(); getContainerLinkHandle(b)!.activate();
    const hello = wire({type: "inbound.hello", peers: [{peerId: "session", agentId: "main", lastFrameSeq: 900}]});
    const first = new Promise<Error | undefined>((resolve) => a.send(hello, {}, resolve));
    while (reads === 0) await Promise.resolve();
    a.terminate();
    const second = new Promise<void>((resolve, reject) => b.send(hello, {}, (error) => error ? reject(error) : resolve()));
    release();
    assert.match((await first)!.message, /closed/);
    await second;
    assert.equal(reads, 2, "cancelled hello never committed link registration");
    assert.equal(physical.sent.length, 1);
    assert.equal(physical.sent[0]!.peers[0].lastFrameSeq, 12, "13..20 remain eligible for container replay");
  } finally { await registry.shutdown(); }
});

test("RF-linkrebuild: receive-only admitted does not renew before exact accepted proof", async () => {
  let status = "admitted";
  let renewals = 0;
  const queryPool = { query: async (sql: string) => {
    if (sql.includes("container_link_heartbeat")) { renewals++; return { rows: [], rowCount: 1 }; }
    return { rows: [{ user_id: "42", session_id: "s", client_message_id: "m", dispatch_id: "d",
      attempt_no: 1, lease_epoch: "2", status, terminal_at: null, anchor_seq: null, agent_container_id: "7" }] };
  } } as unknown as Queryable;
  const registry = new ContainerLinkRegistry(queryPool);
  const physical = new Transport();
  try {
    const socket = await registry.attach(42n, 7, () => physical as unknown as WebSocket);
    const handle = getContainerLinkHandle(socket)!;
    handle.recoveryOnly = true;
    handle.restoreDispatch({ sessionId: "s", clientMessageId: "m", agentId: "main", dispatchId: "d", attemptNo: 1, leaseEpoch: 2 });
    handle.activate();
    await handle.link.tick(); await handle.link.tick();
    assert.equal(renewals, 0);
    status = "accepted";
    await handle.link.tick();
    assert.equal(renewals, 1);
    status = "terminal";
    await handle.link.tick();
    assert.equal(handle.hasOpenDispatches, false);
  } finally { await registry.shutdown(); }
});

test("RF-linkrebuild: restore cannot replace an existing browser stream consumer", async () => {
  const registry = new ContainerLinkRegistry(pool);
  const physical = new Transport();
  try {
    const browser = getContainerLinkHandle(await registry.attach(42n, 7, () => physical as unknown as WebSocket))!;
    browser.noteStream("s", "m"); browser.activate();
    const recovery = getContainerLinkHandle(await registry.attach(42n, 7, () => { throw new Error("duplicate dial"); }))!;
    recovery.recoveryOnly = true;
    recovery.restoreDispatch({ sessionId: "s", clientMessageId: "m", agentId: "main", dispatchId: "d", attemptNo: 1, leaseEpoch: 2 });
    assert.equal(recovery.hasOpenDispatches, false);
    recovery.terminate();
    let delivered = 0;
    browser.socket.on("message", () => { delivered++; });
    physical.push({ type: "outbound.message", peer: { id: "s" }, clientMessageId: "m" });
    assert.equal(delivered, 1);
    assert.equal(physical.readyState, WebSocket.OPEN);
  } finally { await registry.shutdown(); }
});

test("OCV5-724: recovery executor stays available after last browser tab detaches while a dispatch is open", async () => {
  const registry = new ContainerLinkRegistry(pool);
  const physical = new Transport();
  const maps = { recovery: new Map<string, Set<RecoveryExecutor>>(), origin: new Map<string, Set<CronOriginExecutor>>() };
  try {
    const tab = await registry.attach(7n, 9, () => physical as unknown as WebSocket);
    const handle = getContainerLinkHandle(tab)!;
    handle.activate();
    handle.noteStream("sess-offline", "cm-offline", false);
    const recovered: string[] = [];
    registerBridgeExecutors(7n, tab, {
      recovery: (job) => { recovered.push(job.jobId); },
      origin: null,
    }, maps);
    // User closes the last browser tab while the turn stream is still open (detachUserSide):
    handle.detach();
    const executors = availableExecutors(maps.recovery.get("7"));
    assert.equal(executors.length, 1, "recovery executor must survive last browser detach while dispatch stream is open");
    executors[0]!({ jobId: "job-offline-1" } as Parameters<RecoveryExecutor>[0]);
    assert.deepEqual(recovered, ["job-offline-1"]);
    // If DB heartbeat marks the stream closed while final frame persistence is still in-flight
    // (pendingPersistCount > 0), the recovery executor must remain available:
    handle.pendingPersistCount = 1;
    handle.noteStream("sess-offline", "cm-offline", true);
    assert.equal(handle.streams.size, 0);
    assert.equal(handle.hasOpenDispatches, true);
    assert.equal(availableExecutors(maps.recovery.get("7")).length, 1);
    // Once final persistence + recovery drain releases the hold and no keepAlive is set, executor becomes idle:
    handle.pendingPersistCount = 0;
    handle.persisted("sess-offline", "cm-offline", true);
    assert.equal(availableExecutors(maps.recovery.get("7")).length, 0);
    // If a late recovery job needs this still-open link, retainKeepAliveConsumer promotes the handle:
    assert.equal(registry.retainKeepAliveConsumer(7n, 9), true);
    assert.equal(availableExecutors(maps.recovery.get("7")).length, 1);
  } finally {
    await registry.shutdown();
  }
});

test("OCV5-819 P0-2: slow hello on session A never head-of-line blocks session B messages or pings", async () => {
  let releaseHelloA!: () => void;
  const gateA = new Promise<void>((r) => { releaseHelloA = r; });
  const queryPool = {
    query: async () => {
      await gateA;
      return { rows: [{ after_seq: "5", active_message_ids: [] }], rowCount: 1 };
    },
  } as unknown as Queryable;
  const registry = new ContainerLinkRegistry(queryPool);
  const physical = new Transport();
  try {
    const sockA = await registry.attach(1n, 7, () => physical as unknown as WebSocket);
    const sockB = await registry.attach(1n, 7, () => { throw new Error("must reuse transport"); });
    getContainerLinkHandle(sockA)!.activate();
    getContainerLinkHandle(sockB)!.activate();

    const helloA = new Promise<void>((resolve, reject) =>
      sockA.send(wire({ type: "inbound.hello", peers: [{ peerId: "session-A", agentId: "main" }] }), {}, (e) => e ? reject(e) : resolve()),
    );
    await Promise.resolve();
    // While session-A hello is stalled in PG, session-B message and ping MUST transmit immediately!
    const msgB = new Promise<void>((resolve, reject) =>
      sockB.send(wire({ type: "inbound.message", peer: { id: "session-B" }, clientMessageId: "cm-b" }), {}, (e) => e ? reject(e) : resolve()),
    );
    const pingB = new Promise<void>((resolve, reject) =>
      sockB.send(wire({ type: "ping", id: "p-1" }), {}, (e) => e ? reject(e) : resolve()),
    );
    await Promise.all([msgB, pingB]);
    assert.deepEqual(physical.sent.map((f) => f.type), ["inbound.message", "ping"]);
    releaseHelloA();
    await helloA;
    assert.deepEqual(physical.sent.map((f) => f.type), ["inbound.message", "ping", "inbound.hello"]);
  } finally {
    await registry.shutdown();
  }
});

test("OCV5-819 P0-2 (B4): hello prepare timeout blocks dependent session frames without killing shared transport", async () => {
  const registry = new ContainerLinkRegistry(pool, null, { helloPrepareTimeoutMs: 40 });
  registry.beforeReplay = (scope) => {
    if (scope?.sessionIds.includes("session-A")) {
      return new Promise<void>(() => { /* deliberately stalled for session-A */ });
    }
    return Promise.resolve();
  };
  const physical = new Transport();
  try {
    const sockA = await registry.attach(1n, 7, () => physical as unknown as WebSocket);
    const sockB = await registry.attach(1n, 7, () => { throw new Error("must reuse transport"); });
    getContainerLinkHandle(sockA)!.activate();
    getContainerLinkHandle(sockB)!.activate();

    const errA = await new Promise<Error | undefined>((resolve) =>
      sockA.send(wire({ type: "inbound.hello", peers: [{ peerId: "session-A", agentId: "main" }] }), {}, resolve),
    );
    assert.ok(errA);
    assert.match(errA.message, /timeout/);
    assert.equal(physical.readyState, WebSocket.OPEN, "hello timeout must not tear down shared transport");

    // B4: Dependent message for session-A on the failed handle MUST NOT hit the physical wire!
    const blockedMsgA = await new Promise<Error | undefined>((resolve) =>
      sockA.send(wire({ type: "inbound.message", peer: { id: "session-A" }, clientMessageId: "cm-a-blocked" }), {}, resolve),
    );
    assert.ok(blockedMsgA);
    assert.match(blockedMsgA.message, /hello failed/);
    assert.equal(physical.sent.length, 0, "dependent session-A message must never bypass failed hello");

    // Session B continues working on the healthy shared transport.
    await new Promise<void>((resolve, reject) =>
      sockB.send(wire({ type: "inbound.message", peer: { id: "session-B" }, clientMessageId: "cm-ok" }), {}, (e) => e ? reject(e) : resolve()),
    );
    assert.equal(physical.sent.length, 1);
    assert.equal(physical.sent[0]!.clientMessageId, "cm-ok");
  } finally {
    await registry.shutdown();
  }
});

test("OCV5-819 P0-2 (B5): queued inbound frame fails at absolute sendQueueTimeoutMs BEFORE stalled predecessor finishes", async () => {
  let releaseHello!: () => void;
  const gate = new Promise<void>((r) => { releaseHello = r; });
  const queryPool = {
    query: async () => {
      await gate;
      return { rows: [{ after_seq: "1", active_message_ids: [] }], rowCount: 1 };
    },
  } as unknown as Queryable;
  const registry = new ContainerLinkRegistry(queryPool, null, {
    helloPrepareTimeoutMs: 5_000,
    sendQueueTimeoutMs: 30,
  });
  const physical = new Transport();
  try {
    const sock = await registry.attach(1n, 7, () => physical as unknown as WebSocket);
    getContainerLinkHandle(sock)!.activate();

    const helloDone = new Promise<void>((resolve, reject) =>
      sock.send(wire({ type: "inbound.hello", peers: [{ peerId: "s-same", agentId: "main" }] }), {}, (e) => e ? reject(e) : resolve()),
    );
    let queuedError: Error | undefined;
    let failedAt = 0;
    const startedAt = Date.now();
    const queuedPromise = new Promise<void>((resolve) => {
      sock.send(wire({ type: "inbound.message", peer: { id: "s-same" }, clientMessageId: "cm-stale" }), {}, (err) => {
        queuedError = err;
        failedAt = Date.now() - startedAt;
        resolve();
      });
    });

    // B5: Do NOT release predecessor yet — queuedPromise must fail on its own absolute timer!
    await queuedPromise;
    assert.ok(queuedError);
    assert.match(queuedError.message, /queue timeout/);
    assert.ok(failedAt < 200, `expected fast fail near 30ms before predecessor settles, got ${failedAt}ms`);

    // Releasing predecessor later must NOT cause the already-expired frame to be sent.
    releaseHello();
    await helloDone;
    assert.deepEqual(physical.sent.map((f) => f.type), ["inbound.hello"], "expired frame must never be sent after predecessor settles");
  } finally {
    await registry.shutdown();
  }
});

test("OCV5-819 P0-2 (B6): multi-peer hello [A, B] lets B register and send messages while A is stalled", async () => {
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => { releaseA = r; });
  const queryPool = {
    query: async (_sql: string, params?: unknown[]) => {
      const sessionId = String(params?.[3] ?? "");
      if (sessionId === "session-A") {
        await gateA;
      }
      return { rows: [{ after_seq: "3", active_message_ids: [] }], rowCount: 1 };
    },
  } as unknown as Queryable;
  const registry = new ContainerLinkRegistry(queryPool);
  const physical = new Transport();
  try {
    const sock = await registry.attach(1n, 7, () => physical as unknown as WebSocket);
    getContainerLinkHandle(sock)!.activate();

    // Browser sends ONE multi-peer hello covering both session-A and session-B.
    const multiHello = new Promise<void>((resolve, reject) =>
      sock.send(
        wire({
          type: "inbound.hello",
          peers: [
            { peerId: "session-A", agentId: "main" },
            { peerId: "session-B", agentId: "main" },
          ],
        }),
        {},
        (e) => (e ? reject(e) : resolve()),
      ),
    );

    // While session-A's PG lookup is STILL blocked, session-B's hello AND message MUST succeed!
    await new Promise<void>((resolve, reject) =>
      sock.send(wire({ type: "inbound.message", peer: { id: "session-B" }, clientMessageId: "cm-b-live" }), {}, (e) => e ? reject(e) : resolve()),
    );
    assert.equal(physical.sent.some((f) => f.type === "inbound.hello" && f.peers?.[0]?.peerId === "session-B"), true);
    assert.equal(physical.sent.some((f) => f.type === "inbound.message" && f.clientMessageId === "cm-b-live"), true);
    assert.equal(physical.sent.some((f) => f.type === "inbound.hello" && f.peers?.[0]?.peerId === "session-A"), false);

    releaseA();
    await multiHello;
    assert.equal(physical.sent.some((f) => f.type === "inbound.hello" && f.peers?.[0]?.peerId === "session-A"), true);
  } finally {
    await registry.shutdown();
  }
});

test("OCV5-819 P0-2: renew skips unsent and over-aged admitted dispatches but keeps renewing long accepted turns", async () => {
  let status = "admitted";
  let admittedAt = new Date();
  let renewals = 0;
  const queryPool = {
    query: async (sql: string) => {
      if (sql.includes("container_link_heartbeat")) {
        renewals += 1;
        return { rows: [], rowCount: 1 };
      }
      return {
        rows: [{
          user_id: "42",
          session_id: "s",
          client_message_id: "m",
          dispatch_id: "d",
          attempt_no: 1,
          lease_epoch: "2",
          status,
          admitted_at: admittedAt,
          terminal_at: null,
          anchor_seq: null,
          agent_container_id: "7",
        }],
      };
    },
  } as unknown as Queryable;
  const registry = new ContainerLinkRegistry(queryPool, null, { admittedRenewMaxAgeMs: 60_000 });
  const physical = new Transport();
  try {
    const socket = await registry.attach(42n, 7, () => physical as unknown as WebSocket);
    const handle = getContainerLinkHandle(socket)!;
    handle.activate();
    handle.bindDispatch({
      sessionId: "s",
      clientMessageId: "m",
      dispatchId: "d",
      attemptNo: 1,
      leaseEpoch: 2,
    });

    // 1. Before physical wire send completes (`wireSent === false`), admitted must NOT renew.
    await handle.link.tick();
    assert.equal(renewals, 0, "unsent admitted dispatch must not renew lease");

    // 2. After wire send succeeds and within grace window, admitted renews normally.
    handle.markDispatchSent("s", "m");
    await handle.link.tick();
    assert.equal(renewals, 1, "freshly sent admitted dispatch renews within grace window");

    // 3. Once admitted age exceeds cap (e.g. 90s without container ack), stop renewing.
    admittedAt = new Date(Date.now() - 90_000);
    await handle.link.tick();
    assert.equal(renewals, 1, "stale admitted dispatch beyond cap must stop renewing");

    // 4. Once container acknowledges (`accepted`), long-running swarm turns renew unboundedly.
    status = "accepted";
    await handle.link.tick();
    assert.equal(renewals, 2, "accepted long turns must keep renewing regardless of admitted age");
  } finally {
    await registry.shutdown();
  }
});

test("OCV5-819 R2-B4: PG 57014 error during hello.prepare isolates to handle A without closing shared transport or handle B", async () => {
  const queryPool = {
    query: async (_sql: string, params?: unknown[]) => {
      const sid = String(params?.[3] ?? "");
      if (sid === "session-A") {
        const err = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
        throw err;
      }
      return { rows: [{ after_seq: "2", active_message_ids: [] }], rowCount: 1 };
    },
  } as unknown as Queryable;
  const registry = new ContainerLinkRegistry(queryPool);
  const physical = new Transport();
  try {
    const sockA = await registry.attach(1n, 7, () => physical as unknown as WebSocket);
    const sockB = await registry.attach(1n, 7, () => { throw new Error("must reuse transport"); });
    getContainerLinkHandle(sockA)!.activate();
    getContainerLinkHandle(sockB)!.activate();

    const errA = await new Promise<Error | undefined>((resolve) =>
      sockA.send(wire({ type: "inbound.hello", peers: [{ peerId: "session-A", agentId: "main" }] }), {}, resolve),
    );
    assert.ok(errA);
    assert.match(errA.message, /hello prepare failed/);
    assert.equal(physical.readyState, WebSocket.OPEN, "PG error in hello prepare must not tear down shared transport");
    assert.equal(getContainerLinkHandle(sockB)!.disposed, false, "unrelated handle B must remain alive");

    // Dependent frame on A is blocked; B works normally.
    const blockedA = await new Promise<Error | undefined>((resolve) =>
      sockA.send(wire({ type: "inbound.message", peer: { id: "session-A" }, clientMessageId: "cm-a" }), {}, resolve),
    );
    assert.ok(blockedA);
    assert.match(blockedA.message, /hello failed/);

    await new Promise<void>((resolve, reject) =>
      sockB.send(wire({ type: "inbound.message", peer: { id: "session-B" }, clientMessageId: "cm-b" }), {}, (e) => e ? reject(e) : resolve()),
    );
    assert.equal(physical.sent.length, 1);
    assert.equal(physical.sent[0]!.clientMessageId, "cm-b");
  } finally {
    await registry.shutdown();
  }
});

test("OCV5-819 R2-B5: synchronous deadline check rejects expired queued frame even under event-loop delay before timer fires", async () => {
  let releaseHello!: () => void;
  const gate = new Promise<void>((r) => { releaseHello = r; });
  const queryPool = {
    query: async () => {
      await gate;
      return { rows: [{ after_seq: "1", active_message_ids: [] }], rowCount: 1 };
    },
  } as unknown as Queryable;
  const registry = new ContainerLinkRegistry(queryPool, null, {
    helloPrepareTimeoutMs: 5_000,
    sendQueueTimeoutMs: 20,
  });
  const physical = new Transport();
  try {
    const sock = await registry.attach(1n, 7, () => physical as unknown as WebSocket);
    getContainerLinkHandle(sock)!.activate();

    const helloDone = new Promise<void>((resolve, reject) =>
      sock.send(wire({ type: "inbound.hello", peers: [{ peerId: "s-jitter", agentId: "main" }] }), {}, (e) => e ? reject(e) : resolve()),
    );
    const queuedResult = new Promise<Error | undefined>((resolve) =>
      sock.send(wire({ type: "inbound.message", peer: { id: "s-jitter" }, clientMessageId: "cm-jitter" }), {}, resolve),
    );

    // Block event loop synchronously past the 20ms deadline, then release predecessor in the same tick
    // so the microtask continuation runs BEFORE setTimeout can fire!
    const spinUntil = Date.now() + 35;
    while (Date.now() < spinUntil) { /* busy wait */ }
    releaseHello();

    await helloDone;
    const err = await queuedResult;
    assert.ok(err);
    assert.match(err.message, /queue timeout/);
    assert.deepEqual(physical.sent.map((f) => f.type), ["inbound.hello"], "expired frame must not hit wire even under timer lag");
  } finally {
    await registry.shutdown();
  }
});
