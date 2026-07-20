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

describe("automatic latest-tail owner", () => {
  test("uninitialized tails serialize globally, run once, and never admit initialized cursors", () => {
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
  });

  test("stale tokens cannot release a fresh owner", () => {
    const controller = new UserUpwardPagingController();
    const oldGeneration = "rev7::sha::anchor";
    const freshGeneration = "rev8::sha::anchor";

    const fresh = controller.begin(freshGeneration, false)!;
    controller.reset(oldGeneration);
    controller.settle({ generation: oldGeneration, token: fresh.token + 1 });
    expect(controller.begin(oldGeneration, false)).toBeNull();
    controller.settle(fresh);
    expect(controller.begin(oldGeneration, false)).not.toBeNull();
  });

  test("user interaction versions cancel stale viewport restoration without admitting pages", () => {
    const controller = new UserUpwardPagingController();
    expect(controller.interactionVersion()).toBe(0);
    controller.signalUserInteraction();
    expect(controller.interactionVersion()).toBe(1);
    expect(controller.begin("older-cursor", true)).toBeNull();
  });

  test("archive and tape clicks run in one deduplicated FIFO", async () => {
    const controller = new UserUpwardPagingController();
    const order: string[] = [];
    let finishArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => { finishArchive = resolve; });

    const archive = controller.runExplicit("archive:0", async () => {
      order.push("archive:start");
      await archiveGate;
      order.push("archive:end");
      return "archive";
    });
    const duplicate = controller.runExplicit("archive:0", async () => "duplicate");
    const tape = controller.runExplicit("tape:200", async () => {
      order.push("tape:start");
      return "tape";
    });

    expect(duplicate).toBe(archive);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["archive:start"]);
    finishArchive();
    await expect(archive).resolves.toBe("archive");
    await expect(tape).resolves.toBe("tape");
    expect(order).toEqual(["archive:start", "archive:end", "tape:start"]);
  });

  test("an explicit click waits for the active automatic tail and blocks a new one", async () => {
    const controller = new UserUpwardPagingController();
    const automatic = controller.begin("latest-tail", false)!;
    let explicitStarted = false;
    const explicit = controller.runExplicit("archive:0", async () => {
      explicitStarted = true;
    });

    await Promise.resolve();
    expect(explicitStarted).toBe(false);
    expect(controller.begin("another-tail", false)).toBeNull();
    controller.settle(automatic);
    await explicit;
    expect(explicitStarted).toBe(true);

    const nextAutomatic = controller.begin("another-tail", false);
    expect(nextAutomatic).not.toBeNull();
    controller.settle(nextAutomatic!);
  });
});
