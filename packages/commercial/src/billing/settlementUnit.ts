/**
 * One proxy request's credit reservation as a unit of work (P3 pilot S2, plan §9.4):
 * reserve → either abort (release the reservation once) or hand it to the finalizer, which then
 * owns the release (finalize is the only release path from there on).
 *
 * Before this unit the proxy handler released the reservation by hand on six separate exit paths
 * between preCheck and makeFinalizer. Billing's transactions and lock order are untouched: the unit
 * only decides who releases the reservation and when.
 */
import type { Logger } from "../logging/logger.js";
import {
  type PreCheckRedis,
  type PreCheckResult,
  type PreCheckWithCostInput,
  preCheckWithCost,
  releasePreCheck,
} from "./preCheck.js";
import { type FinalizeContext, type FinalizerHandle, makeFinalizer } from "./proxyBilling.js";

type FinalizeDeps = Parameters<typeof makeFinalizer>[0];

export interface SettlementUnit {
  /** What the reservation actually holds (capped to the balance when the balance is short). */
  readonly reserved: PreCheckResult;
  /**
   * Release the reservation. Once only; a no-op after a previous abort or after hand-off (the
   * finalizer owns the release then). A failed release is logged, not thrown: the reservation's
   * TTL heals it.
   */
  abort(): Promise<void>;
  /** Hand the reservation to the finalizer. Once only, and never after abort. */
  handOff(
    deps: FinalizeDeps,
    ctx: Omit<FinalizeContext, "precheckCredits" | "preCheckReservation">,
  ): FinalizerHandle;
}

/** Test seam: the billing primitives the unit sequences. */
export interface SettlementPrimitives {
  reserve: typeof preCheckWithCost;
  release: typeof releasePreCheck;
  finalizer: typeof makeFinalizer;
}

const PRIMITIVES: SettlementPrimitives = {
  reserve: preCheckWithCost,
  release: releasePreCheck,
  finalizer: makeFinalizer,
};

/** Reserve credits for one request. InsufficientCreditsError propagates unchanged. */
export async function openSettlementUnit(
  redis: PreCheckRedis,
  input: PreCheckWithCostInput,
  log: Pick<Logger, "warn">,
  primitives: SettlementPrimitives = PRIMITIVES,
): Promise<SettlementUnit> {
  const reserved = await primitives.reserve(redis, input);
  let state: "reserved" | "released" | "handed_off" = "reserved";
  return {
    reserved,
    async abort() {
      if (state !== "reserved") return;
      state = "released";
      await primitives.release(redis, reserved.reservation).catch((e: unknown) => {
        log.warn("precheck_release_failed", { msg: (e as Error)?.message ?? String(e) });
      });
    },
    handOff(deps, ctx) {
      if (state !== "reserved") throw new Error(`settlement unit already ${state}`);
      state = "handed_off";
      return primitives.finalizer(deps, {
        ...ctx,
        precheckCredits: reserved.maxCost,
        preCheckReservation: reserved.reservation,
      });
    },
  };
}
