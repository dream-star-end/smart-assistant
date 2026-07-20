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
  test("tail loads once, one gesture cannot cascade, and a new gesture continues", () => {
    const controller = new UserUpwardPagingController();
    const generation = "rev7::sha::anchor";

    expect(controller.begin(generation, false)).toBe(true);
    controller.settle(generation);
    expect(controller.begin(generation, false)).toBe(false);
    expect(controller.begin(generation, true)).toBe(false);

    controller.signalUpwardIntent();
    expect(controller.begin(generation, true)).toBe(true);
    // Momentum / repeated wheel events while the request is in flight are
    // consumed when that request settles, rather than cascading a new page.
    controller.signalUpwardIntent();
    controller.signalUpwardIntent();
    controller.settle(generation);
    expect(controller.begin(generation, true)).toBe(false);

    controller.signalUpwardIntent();
    expect(controller.begin(generation, true)).toBe(true);
  });

  test("programmatic scroll synchronization is not user intent and generations are isolated", () => {
    const controller = new UserUpwardPagingController();
    const oldGeneration = "rev7::sha::anchor";
    const freshGeneration = "rev8::sha::anchor";

    controller.syncScrollTop(900);
    controller.syncScrollTop(400);
    expect(controller.begin(oldGeneration, true)).toBe(false);

    expect(controller.begin(freshGeneration, false)).toBe(true);
    controller.reset(oldGeneration);
    controller.settle(oldGeneration);
    // A late old-generation finally cannot consume or settle the fresh one.
    expect(controller.begin(freshGeneration, false)).toBe(false);
    controller.settle(freshGeneration);
  });
});
