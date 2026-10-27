import assert from "node:assert/strict";
import { test } from "node:test";
import { InsufficientCreditsError, type PreCheckResult } from "../billing/preCheck.js";
import { type SettlementPrimitives, openSettlementUnit } from "../billing/settlementUnit.js";

// P3 pilot S2: the reservation lifecycle that replaced six hand-written releases in the proxy.
const reserved = {
  maxCost: 70n,
  originalMaxCost: 100n,
  balance: 70n,
  capped: true,
  reservation: { key: "k", member: "m" },
} as unknown as PreCheckResult;

function harness(opts: { releaseFails?: boolean; reserveError?: Error } = {}) {
  const calls: string[] = [];
  const warns: unknown[] = [];
  const finalizerCtx: Record<string, unknown>[] = [];
  const primitives = {
    reserve: async () => {
      calls.push("reserve");
      if (opts.reserveError) throw opts.reserveError;
      return reserved;
    },
    release: async (_redis: unknown, handle: unknown) => {
      calls.push("release");
      assert.equal(handle, reserved.reservation);
      if (opts.releaseFails) throw new Error("redis down");
    },
    finalizer: (_deps: unknown, ctx: Record<string, unknown>) => {
      calls.push("finalizer");
      finalizerCtx.push(ctx);
      return { finalizer: true };
    },
  } as unknown as SettlementPrimitives;
  const log = { warn: (event: string, fields: unknown) => warns.push([event, fields]) };
  const open = () =>
    openSettlementUnit({} as never, { userId: 1, requestId: "req-s2", maxCost: 100n }, log, primitives);
  return { calls, warns, finalizerCtx, open };
}

test("S2: abort releases the reservation exactly once", async () => {
  const h = harness();
  const unit = await h.open();
  assert.equal(unit.reserved, reserved);
  await unit.abort();
  await unit.abort();
  assert.deepEqual(h.calls, ["reserve", "release"]);
});

test("S2: hand-off gives the finalizer the reservation; abort after hand-off releases nothing", async () => {
  const h = harness();
  const unit = await h.open();
  const handle = unit.handOff({} as never, { requestId: "req-s2" } as never);
  assert.deepEqual(handle, { finalizer: true });
  assert.equal(h.finalizerCtx[0]?.precheckCredits, 70n);
  assert.equal(h.finalizerCtx[0]?.preCheckReservation, reserved.reservation);
  await unit.abort();
  assert.deepEqual(h.calls, ["reserve", "finalizer"]);
});

test("S2: hand-off after abort, or twice, throws instead of double-owning the release", async () => {
  const h = harness();
  const aborted = await h.open();
  await aborted.abort();
  assert.throws(() => aborted.handOff({} as never, {} as never), /already released/);
  const handed = await h.open();
  handed.handOff({} as never, {} as never);
  assert.throws(() => handed.handOff({} as never, {} as never), /already handed_off/);
});

test("S2: a failed release is logged, not thrown", async () => {
  const h = harness({ releaseFails: true });
  const unit = await h.open();
  await unit.abort();
  assert.deepEqual(h.warns, [["precheck_release_failed", { msg: "redis down" }]]);
});

test("S2: insufficient credits propagate from reserve unchanged", async () => {
  const err = new InsufficientCreditsError(5n, 100n);
  const h = harness({ reserveError: err });
  await assert.rejects(h.open(), (e) => e === err);
  assert.deepEqual(h.calls, ["reserve"]);
});
