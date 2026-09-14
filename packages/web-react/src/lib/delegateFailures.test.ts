import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "./authSession";
import { DelegateFailureController, EMPTY_FAILURE_INBOX } from "./delegateFailureController";
import {
  delegateFailureApi, delegateRetryActionId, failureKey, failureSummaryText,
  parseFailurePage, parseFailureSummary, parseRetryResult, retryStateText, type DelegateFailure,
} from "./delegateFailures";

const row = (id = "job-1", generation = 1): DelegateFailure => ({ jobId: id, generation,
  parentSessionKey: "agent:main:webchat:dm:session-a", failedAt: 1, summaryCode: "delegate_failed",
  summaryText: '{"token":"must-not-be-displayed"}', retry: { available: true, reason: null } });
const summary = (n = 1) => ({ version: 1, available: true, running: 0, queued: 0, unacknowledgedFailures: n });
const page = (items: DelegateFailure[], nextCursor: string | null = null, count = items.length) => ({ version: 1, count, items, nextCursor });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const controllers: DelegateFailureController[] = [];
function createController(auth = createMemoryAuthSession(() => {}, "A"), user = "user-a") {
  const controller = new DelegateFailureController(auth, user);
  controllers.push(controller); controller.start(); return { controller, auth };
}
async function open(controller: DelegateFailureController) {
  controller.setOpen(true); await controller.refresh();
  expect(controller.getSnapshot().page).not.toBeNull();
}
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => { controllers.forEach(c => c.stop()); controllers.length = 0; vi.unstubAllGlobals(); });

test("DTO rejects malformed/unknown schemas and duplicate identities; errors are not an empty inbox", () => {
  expect(parseFailureSummary(summary(0)).unacknowledgedFailures).toBe(0);
  for (const v of [{ ...summary(), version: 2 }, { ...summary(), available: false }, { ...summary(), running: -1 }]) {
    expect(() => parseFailureSummary(v)).toThrow();
  }
  expect(() => parseFailurePage(page([row(), row()]))).toThrow();
  expect(() => parseFailurePage(page(Array.from({ length: 51 }, (_, i) => row(`job-${i}`))))).toThrow();
  expect(() => parseFailurePage({ ...page([]), nextCursor: "../bad" })).toThrow();
  expect(failureSummaryText(row())).not.toContain("token");
  expect(parseRetryResult({ version: 1, jobId: "new-target", state: "terminal", replay: true }).state).toBe("terminal");
  expect(retryStateText("terminal")).not.toContain("成功");
  expect(retryStateText("terminal")).toContain("以原会话为准");
});

test("one retry intent across reloads/tabs, separate principal and source generation", async () => {
  const a = await delegateRetryActionId("a", row());
  expect(a).toMatch(/^[A-Za-z0-9_-]{76}$/);
  expect(await delegateRetryActionId("a", row())).toBe(a);
  expect(await delegateRetryActionId("b", row())).not.toBe(a);
  expect(await delegateRetryActionId("a", row("job-1", 2))).not.toBe(a);
});

test("actual original auth response body fence rejects an A body finishing after B begins", async () => {
  const auth = createMemoryAuthSession(() => {}, "A"), body = deferred<unknown>();
  const res = response(summary()); res.json = () => body.promise;
  vi.stubGlobal("fetch", vi.fn(async () => res));
  const result = delegateFailureApi.summary(auth);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await Promise.resolve(); await Promise.resolve();
  auth.commitToken(auth.beginIdentity(), "B"); body.resolve(summary(12));
  await expect(result).rejects.toThrow();
});

test("same-epoch token refresh retains data; identity boundary hides every old field and blocks writes", async () => {
  const fetcher = vi.fn(async (url: string) => response(url.endsWith("summary") ? summary() : page([row()])));
  vi.stubGlobal("fetch", fetcher);
  const { controller, auth } = createController(); await open(controller);
  auth.commitToken(auth.snapshot().epoch, "A-refreshed");
  await controller.refresh(); expect(controller.getSnapshot().page?.items).toHaveLength(1);
  auth.commitToken(auth.beginIdentity(), "B");
  expect(controller.getSnapshot()).toBe(EMPTY_FAILURE_INBOX);
  const calls = fetcher.mock.calls.length;
  await controller.acknowledge(row()); await controller.retry(row());
  expect(fetcher.mock.calls).toHaveLength(calls);
});

test("failed ACK retains old >30min failure and count; only true ACK removes it", async () => {
  let acknowledged = false, failAck = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/ack")) { if (failAck) return response({ error: "unavailable" }, 503); acknowledged = true; return response({ version: 1, acknowledged: true }); }
    return response(url.endsWith("summary") ? summary(acknowledged ? 0 : 1) : page(acknowledged ? [] : [row()]));
  }));
  const { controller } = createController(); await open(controller);
  await controller.acknowledge(row());
  expect(controller.getSnapshot().page?.items).toHaveLength(1);
  expect(controller.getSnapshot().summary?.unacknowledgedFailures).toBe(1);
  expect(controller.getSnapshot().messages[failureKey(row())]).toBeTruthy();
  failAck = false; await controller.acknowledge(row());
  expect(acknowledged).toBe(true);
  expect(controller.getSnapshot().page?.items).toHaveLength(0);
  expect(controller.getSnapshot().summary?.unacknowledgedFailures).toBe(0);
});

test("ACK with an old page GET in flight cannot resurrect the acknowledged failure, refresh is not swallowed", async () => {
  let acknowledged = false, hold = false;
  const oldPage = deferred<Response>(); let waiting = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/ack")) { acknowledged = true; return response({ version: 1, acknowledged: true }); }
    if (url.endsWith("summary")) return response(summary(acknowledged ? 0 : 1));
    if (hold) { hold = false; waiting = true; return oldPage.promise; }
    return response(page(acknowledged ? [] : [row()]));
  }));
  const { controller } = createController(); await open(controller);
  hold = true; const pull = controller.refresh();
  await vi.waitFor(() => expect(waiting).toBe(true));
  const ack = controller.acknowledge(row());
  await vi.waitFor(() => expect(acknowledged).toBe(true));
  oldPage.resolve(response(page([row()]))); await Promise.all([pull, ack]);
  expect(controller.getSnapshot().page?.items).toHaveLength(0);
  expect(controller.getSnapshot().summary?.unacknowledgedFailures).toBe(0);
});

test("51 failures use real opaque next/back pages; late ACK does not replace the newly selected page", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => row(`job-${i}`));
  const ackGate = deferred<Response>(); let ackStarted = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/ack")) { ackStarted = true; return ackGate.promise; }
    return response(url.endsWith("summary") ? summary(51) : url.includes("before=") ? page(rows.slice(50), null, 51) : page(rows.slice(0, 50), "opaque_2", 51));
  }));
  const { controller } = createController(); await open(controller);
  expect(controller.getSnapshot().page?.items).toHaveLength(50);
  const ack = controller.acknowledge(rows[0]); await vi.waitFor(() => expect(ackStarted).toBe(true));
  controller.nextPage(); await controller.refresh();
  expect(controller.getSnapshot().page?.items[0].jobId).toBe("job-50");
  ackGate.resolve(response({ version: 1, acknowledged: true })); await ack;
  expect(controller.getSnapshot().before).toBe("opaque_2");
  expect(controller.getSnapshot().page?.items[0].jobId).toBe("job-50");
  controller.previousPage(); await controller.refresh(); expect(controller.getSnapshot().page?.items).toHaveLength(50);
});

test("accepted POST with lost response, availability false: explicit same-intent replay returns only one target without ACK", async () => {
  const intents = new Map<string, string>(); const ids: string[] = []; let lost = true, acks = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
    if (url.endsWith("/retry")) {
      const body = JSON.parse(String(opts.body)); ids.push(body.actionId);
      if (!intents.has(body.actionId)) intents.set(body.actionId, "target-1");
      if (lost) { lost = false; throw new TypeError("socket closed after accept"); }
      return response({ version: 1, jobId: intents.get(body.actionId), state: "terminal", replay: true });
    }
    if (url.endsWith("/ack")) acks++;
    return response(url.endsWith("summary") ? summary() : page([{ ...row(), retry: { available: !intents.size, reason: intents.size ? "retry_child_busy" : null } }]));
  }));
  const { controller } = createController(); await open(controller); await controller.retry(row());
  const unavailable = controller.getSnapshot().page!.items[0]; expect(unavailable.retry.available).toBe(false);
  await controller.retry(unavailable); expect(ids).toHaveLength(1);
  await controller.retry(unavailable, true);
  expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]); expect(intents.size).toBe(1);
  expect(controller.getSnapshot().retries[failureKey(row())].jobId).toBe("target-1");
  expect(controller.getSnapshot().page?.items).toHaveLength(1); expect(acks).toBe(0);
});

test("epoch change during the real action-ID async boundary cannot send a retry POST", async () => {
  const digest = deferred<ArrayBuffer>();
  vi.stubGlobal("crypto", { subtle: { digest: () => digest.promise } });
  const fetcher = vi.fn(async (url: string) => response(url.endsWith("summary") ? summary() : page([row()])));
  vi.stubGlobal("fetch", fetcher);
  const { controller, auth } = createController(); await open(controller);
  const pending = controller.retry(row()); auth.commitToken(auth.beginIdentity(), "B");
  digest.resolve(new Uint8Array(32).buffer); await pending;
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/retry"))).toBe(false);
  expect(controller.getSnapshot()).toBe(EMPTY_FAILURE_INBOX);
});

test("503 after prior successful read is unavailable with retained data, never false zero", async () => {
  let fail = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => fail ? response({ error: "offline" }, 503) : response(url.endsWith("summary") ? summary(3) : page([row()], null, 3))));
  const { controller } = createController(); await open(controller); fail = true; await controller.refresh();
  expect(controller.getSnapshot().summary?.unacknowledgedFailures).toBe(3);
  expect(controller.getSnapshot().error).toBeTruthy(); expect(controller.getSnapshot().page?.items).toHaveLength(1);
});

test("StrictMode-style stop/start retires old read and still fetches a fresh live scope", async () => {
  const gate = deferred<Response>(); let first = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (first) { first = false; return gate.promise; }
    return response(url.endsWith("summary") ? summary(2) : page([row()], null, 2));
  }));
  const { controller } = createController(); controller.stop(); controller.start(); controller.setOpen(true);
  gate.resolve(response(summary(99))); await controller.refresh();
  expect(controller.getSnapshot().summary?.unacknowledgedFailures).toBe(2);
  expect(controller.getSnapshot().pending).toEqual({});
});
