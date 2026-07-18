// containerDispatchClient — dispatch-state 回执解析契约(RFC-v5-durable-turn-dispatch §2.3 / §3)。
// B4(R3):gateway 缺行回执必须收敛成 'absent'(而非解析失败当 error 无限重试),reconciler 据此
// 对 accepted 行走 manual_reconcile(行消失)。两侧契约:client parseStateBody 兼容
// {found:false,state:'absent'}(新 gateway)与 {found:false,state:null}(旧 gateway)。

import * as assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type ContainerCallResult,
  type DispatchIdentity,
  makeContainerDispatchClient,
} from "../dispatch/containerDispatchClient.js";
import type { ContainerTransport } from "../wechat/inboundDispatcher.js";

const ID: DispatchIdentity = {
  uid: 42n,
  dispatchId: "d-1",
  attemptNo: 1,
  sessionId: "web-1",
  clientMessageId: "cm-1",
};

/** 固定回执 body 的 transport（只实现 request，GET/POST 共用）。 */
function fixedTransport(status: number, bodyText: string): ContainerTransport {
  return {
    post: async () => ({ status, bodyText }),
    request: async () => ({ status, bodyText }),
  };
}

function clientWith(status: number, bodyText: string) {
  return makeContainerDispatchClient({
    transport: fixedTransport(status, bodyText),
    bridgeSecret: "s".repeat(32),
    resolveRunningEndpoint: async () => ({ host: "127.0.0.1", port: 8080, containerId: 7 }),
  });
}

describe("containerDispatchClient B4 dispatch-state 解析契约", () => {
  test("新 gateway 缺行 {found:false, state:'absent'} → ok/absent", async () => {
    const r: ContainerCallResult = await clientWith(200, JSON.stringify({ found: false, state: "absent", outcome: null })).getDispatchState(ID);
    assert.equal(r.kind, "ok");
    assert.equal((r as { state: string }).state, "absent");
  });

  test("旧 gateway 缺行 {found:false, state:null} → ok/absent(兼容)", async () => {
    const r = await clientWith(200, JSON.stringify({ found: false, state: null })).getDispatchState(ID);
    assert.equal(r.kind, "ok");
    assert.equal((r as { state: string }).state, "absent");
  });

  test("行存在 {found:true, state:'running'} → ok/running(不误判 absent)", async () => {
    const r = await clientWith(200, JSON.stringify({ found: true, state: "running" })).getDispatchState(ID);
    assert.equal(r.kind, "ok");
    assert.equal((r as { state: string }).state, "running");
  });

  test("行存在终态透传 outcome", async () => {
    const r = await clientWith(200, JSON.stringify({ found: true, state: "terminal", outcome: "completed" })).getDispatchState(ID);
    assert.equal(r.kind, "ok");
    assert.equal((r as { state: string; outcome?: string }).state, "terminal");
    assert.equal((r as { outcome?: string }).outcome, "completed");
  });

  test("真畸形 body(无 found、state 非法)→ error(不冒充 absent)", async () => {
    const r = await clientWith(200, JSON.stringify({ state: "garbage" })).getDispatchState(ID);
    assert.equal(r.kind, "error");
  });

  test("非 2xx → error(不推断 absent)", async () => {
    const r = await clientWith(500, "boom").getDispatchState(ID);
    assert.equal(r.kind, "error");
  });

  test("404(无 capability 端点)→ unreachable(保持 rejecting 重试,不推断)", async () => {
    const r = await clientWith(404, "not found").getDispatchState(ID);
    assert.equal(r.kind, "unreachable");
  });
});
