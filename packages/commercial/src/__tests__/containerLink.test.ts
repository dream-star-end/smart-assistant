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
