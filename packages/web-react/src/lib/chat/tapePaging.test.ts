import { describe, expect, test } from "vitest";
import { TapePageRequestLedger, UserUpwardPagingController } from "./tapePaging";

describe("tape page request ledger", () => {
  test("a successful cursor is fetched once without retaining its record payload", () => {
    const ledger = new TapePageRequestLedger();
    const key = "s1::rev7::anchor::tape::tail";

    expect(ledger.begin(key)).toEqual({ kind: "start" });
    ledger.succeed(key, { nextCursor: 200, total: 873 });
    expect(ledger.begin(key)).toEqual({
      kind: "completed",
      result: { nextCursor: 200, total: 873 },
    });
    expect(JSON.stringify(ledger)).not.toContain("records");
  });

  test("failed and invalidated generations remain retryable", () => {
    const ledger = new TapePageRequestLedger();
    const oldKey = "s1::rev7::anchor::tape::tail";
    const freshKey = "s1::rev8::anchor::tape::tail";

    expect(ledger.begin(oldKey)).toEqual({ kind: "start" });
    ledger.fail(oldKey);
    expect(ledger.begin(oldKey)).toEqual({ kind: "start" });
    ledger.fail(oldKey);

    expect(ledger.begin(freshKey)).toEqual({ kind: "start" });
    ledger.succeed(freshKey, { nextCursor: null, total: 3 });
    ledger.clearSession("s1");
    expect(ledger.begin(freshKey)).toEqual({ kind: "start" });
  });
});

describe("explicit upward paging intent", () => {
  test("visible tails serialize globally, then each older page needs a new gesture", () => {
    const controller = new UserUpwardPagingController();
    const generation = "rev7::sha::anchor";

    const tail = controller.begin(generation, false);
    expect(tail).not.toBeNull();
    expect(controller.begin("rev7::sha::another", false)).toBeNull();
    controller.settle(tail!);
    expect(controller.begin(generation, false)).toBeNull();
    const anotherTail = controller.begin("rev7::sha::another", false);
    expect(anotherTail).not.toBeNull();
    controller.settle(anotherTail!);
    expect(controller.begin(generation, true)).toBeNull();

    controller.signalUpwardIntent();
    const first = controller.begin(generation, true);
    expect(first).not.toBeNull();
    expect(controller.begin("rev7::sha::another", true)).toBeNull();
    // Momentum / repeated wheel events while the request is in flight are
    // consumed when that request settles, rather than cascading a new page.
    controller.signalUpwardIntent();
    controller.signalUpwardIntent();
    controller.settle(first!);
    expect(controller.begin(generation, true)).toBeNull();

    controller.signalUpwardIntent();
    expect(controller.begin(generation, true)).not.toBeNull();
  });

  test("programmatic scroll synchronization is not user intent and stale tokens cannot release an owner", () => {
    const controller = new UserUpwardPagingController();
    const oldGeneration = "rev7::sha::anchor";
    const freshGeneration = "rev8::sha::anchor";

    controller.syncScrollTop(900);
    controller.syncScrollTop(400);
    expect(controller.begin(oldGeneration, true)).toBeNull();

    controller.signalUpwardIntent();
    const fresh = controller.begin(freshGeneration, false)!;
    controller.reset(oldGeneration);
    controller.settle({ generation: oldGeneration, token: fresh.token + 1 });
    // A late/wrong finally cannot consume or settle the fresh owner.
    controller.signalUpwardIntent();
    expect(controller.begin(oldGeneration, true)).toBeNull();
    controller.settle(fresh);
  });

  test("manual retry is a real intent but cannot bypass another generation's in-flight claim", () => {
    const controller = new UserUpwardPagingController();
    controller.signalUpwardIntent();
    const active = controller.begin("turn-a", true)!;

    controller.signalUpwardIntent();
    expect(controller.begin("turn-b", true, true)).toBeNull();
    controller.settle({ generation: "turn-b", token: active.token + 99 });
    expect(controller.begin("turn-b", true, true)).toBeNull();

    controller.settle(active);
    // The click observed while A was active was consumed with A. A new click
    // creates the retry intent that may now own the controller.
    controller.signalUpwardIntent();
    expect(controller.begin("turn-b", true, true)).not.toBeNull();
  });
});
