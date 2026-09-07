import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { makeLeaseCallbackHandler } from "../http/internalLeaseCallback.js";
import type { CronOriginInjectResult } from "../ws/userChatBridge.js";

const secret = "a".repeat(64);
const body = { uid: "3", sessionId: "webtest", agentId: "main", clientMessageId: "lsc-test", text: "列车失败：只读查日志，不盲目重发" };
function req(extra: Record<string, unknown> = {}, payload: unknown = body) {
  return Object.assign(Readable.from([Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))]), {
    method: "POST", headers: { "x-oc-lease-secret": secret }, socket: { remoteAddress: "127.0.0.1" }, ...extra,
  }) as unknown as IncomingMessage;
}
function res() {
  return { statusCode: 0, body: null as any, setHeader() {}, end(s: string) { this.body = JSON.parse(s); } } as unknown as ServerResponse & { body: any };
}
test("callback: real peer and secret required; forwarded headers cannot authorize", async () => {
  let calls = 0;
  const h = makeLeaseCallbackHandler({ secret, lookupSession: async () => { calls++; return "owned"; }, inject: async () => ({ kind: "injected" }) });
  for (const [extra, code] of [
    [{ socket: { remoteAddress: "172.31.0.3" } }, 403],
    [{ headers: { "x-oc-lease-secret": secret, "x-v5-egress-peer-ip": "127.0.0.1" } }, 403],
    [{ headers: {} }, 401], [{ headers: { "x-oc-lease-secret": "x".repeat(64) } }, 401],
    [{ method: "GET" }, 405],
  ] as const) {
    const r = res(); await h(req(extra), r); assert.equal(r.statusCode, code);
  }
  assert.equal(calls, 0);
});
test("callback: strict bounded JSON and identity validation", async () => {
  const h = makeLeaseCallbackHandler({ secret, lookupSession: async () => "owned", inject: async () => ({ kind: "injected" }) });
  for (const payload of [{ ...body, userId: "4" }, { ...body, uid: "0" }, { ...body, sessionId: "../x" }, { ...body, clientMessageId: "other" }, "{oops"]) {
    const r = res(); await h(req({}, payload), r); assert.equal(r.statusCode, 400);
  }
  const r = res(); await h(req({}, { ...body, text: "中".repeat(20_000) }), r); assert.equal(r.statusCode, 413);
});
test("callback: ownership, deletion, read-only validation and unavailable lookup", async () => {
  let owner: "owned" | "gone" | "foreign" = "foreign";
  let injected = 0;
  const h = makeLeaseCallbackHandler({ secret, lookupSession: async (uid, sid) => {
    assert.equal(uid, "3"); assert.equal(sid, "webtest"); return owner;
  }, inject: async () => { injected++; return { kind: "injected" }; } });
  let r = res(); await h(req(), r); assert.equal(r.statusCode, 403);
  owner = "gone"; r = res(); await h(req(), r); assert.equal(r.body.kind, "gone");
  owner = "owned"; r = res();
  await h(req({}, { uid: "3", sessionId: "webtest", agentId: "main" }), r, true);
  assert.equal(r.body.kind, "validated"); assert.equal(injected, 0);
  r = res(); await h(req(), r, true); assert.equal(r.statusCode, 400); // no inject payload at validate
  const unavailable = makeLeaseCallbackHandler({ secret, lookupSession: async () => { throw Error("db down"); }, inject: async () => ({ kind: "injected" }) });
  r = res(); await unavailable(req(), r); assert.equal(r.statusCode, 503);
});
test("callback: preserves durable inject results, uid and stable message id on retry", async () => {
  for (const result of [{ kind: "injected" }, { kind: "in_flight" }, { kind: "gone" }, { kind: "no_transport" }, { kind: "failed", reason: "retry" }] as CronOriginInjectResult[]) {
    const inputs: unknown[] = [];
    const h = makeLeaseCallbackHandler({ secret, lookupSession: async () => "owned", inject: async (input) => { inputs.push(input); return result; } });
    for (let i=0; i<2; i++) { const r=res(); await h(req(),r); assert.equal(r.statusCode,200); assert.deepEqual(r.body,result); }
    assert.deepEqual(inputs, [{ ...body, uid: 3n }, { ...body, uid: 3n }]);
  }
});
test("callback: missing configuration and injector failure are retryable", async () => {
  const deps = { lookupSession: async () => "owned" as const, inject: async (): Promise<CronOriginInjectResult> => { throw Error("transport down"); } };
  for (const s of [undefined, secret]) { const r=res(); await makeLeaseCallbackHandler({ ...deps, secret:s })(req(),r); assert.equal(r.statusCode,503); }
});
