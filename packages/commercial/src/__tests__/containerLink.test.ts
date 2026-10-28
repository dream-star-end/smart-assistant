import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { ContainerLinkRegistry, getContainerLinkHandle } from "../ws/containerLink.js";
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
const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as Queryable;
const wire = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

test("RF-link: concurrent dial is singleflight; attestation, grants, billing, receipt each reach correct consumer", async () => {
  const registry = new ContainerLinkRegistry(pool);
  const physical = new Transport();
  let dials = 0;
  const dial = async () => { dials++; return physical as unknown as WebSocket; };
  try {
    const [one, two] = await Promise.all([registry.connect(1n, 7, dial), registry.connect(1n, 7, dial)]);
    const a: Record<string, any>[] = [], b: Record<string, any>[] = [];
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
    const gotA: unknown[] = [], gotB: unknown[] = [];
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
