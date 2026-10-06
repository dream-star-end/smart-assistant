/** Per-login health the scheduler reads and the exec tap writes. Process-local
 * and fast; `persist` mirrors every change to the durable store (best effort)
 * so the admin page, a restarted egress and another process see it too. */
import type { BoxProfileSignal } from "./boxProfileSignals.js";

export interface BoxProfileHealthState {
  utilization: number | null;
  /** Epoch ms until which this login must not receive new work. */
  cooldownUntilMs: number | null;
  lastReason: string | null;
  updatedAtMs: number;
  /** When the quota window the utilization belongs to resets (epoch ms); not persisted. */
  windowResetsAtMs?: number | null;
}

export interface BoxProfileHealthSink {
  (key: string, state: BoxProfileHealthState): void;
}

const LAUNCH_WINDOW_MS = 90_000;
/** A rejection that reports no reset time still benches the login this long. */
export const BOX_PROFILE_DEFAULT_COOLDOWN_MS = 15 * 60_000;
/** Never trust a reset further out than a weekly window. */
export const BOX_PROFILE_MAX_COOLDOWN_MS = 7 * 24 * 3_600_000;
const LOGIN_COOLDOWN_MS = 30 * 60_000;
const UNSAFE_COOLDOWN_MS = 60 * 60_000;
const UTILIZATION_MAX_AGE_MS = 5 * 3_600_000 + 60_000;

export class BoxProfileHealth {
  private readonly states = new Map<string, BoxProfileHealthState>();
  private readonly launches = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now,
    private readonly persist: BoxProfileHealthSink = () => {}) {}

  get(key: string): BoxProfileHealthState | undefined { return this.states.get(key); }

  /** Seed from the durable store without re-persisting it. */
  load(key: string, state: BoxProfileHealthState): void {
    const held = this.states.get(key);
    if (!held || held.updatedAtMs < state.updatedAtMs) this.states.set(key, { ...state });
  }

  recordLaunch(key: string): void {
    const at = this.now();
    const list = (this.launches.get(key) ?? []).filter((t) => at - t < LAUNCH_WINDOW_MS);
    list.push(at);
    this.launches.set(key, list);
  }

  /** Launches in the last 90s: the concurrency estimate (detached runs have no
   * visible end, so recent starts stand in for in-flight work). */
  recentLaunches(key: string): number {
    const at = this.now();
    return (this.launches.get(key) ?? []).filter((t) => at - t < LAUNCH_WINDOW_MS).length;
  }

  /** Utilization worth acting on: a reading from a window that has since reset, or from before the
   * last 5-hour window could still apply, says nothing about the login now (it must be re-learned). */
  utilization(key: string): number | null {
    const state = this.states.get(key);
    if (!state || state.utilization === null) return null;
    const at = this.now();
    if (state.windowResetsAtMs != null && at >= state.windowResetsAtMs) return null;
    if (state.cooldownUntilMs != null && state.cooldownUntilMs <= at && state.lastReason === "quota_exhausted") return null;
    if (at - state.updatedAtMs > UTILIZATION_MAX_AGE_MS) return null;
    return state.utilization;
  }

  cooldownActive(key: string): boolean {
    const until = this.states.get(key)?.cooldownUntilMs;
    return until !== undefined && until !== null && until > this.now();
  }

  observe(key: string, signal: BoxProfileSignal): void {
    const at = this.now();
    const held = this.states.get(key);
    const next: BoxProfileHealthState = { utilization: held?.utilization ?? null,
      cooldownUntilMs: held?.cooldownUntilMs ?? null, lastReason: held?.lastReason ?? null,
      updatedAtMs: at };
    if (signal.kind === "profile_unsafe") {
      next.cooldownUntilMs = at + UNSAFE_COOLDOWN_MS;
      next.lastReason = "profile_unsafe";
    } else if (signal.kind === "login_required") {
      next.cooldownUntilMs = at + LOGIN_COOLDOWN_MS;
      next.lastReason = "login_required";
    } else if (signal.status === "rejected") {
      const reset = signal.resetsAtMs;
      const until = reset !== null && reset > at && reset - at <= BOX_PROFILE_MAX_COOLDOWN_MS
        ? reset : at + BOX_PROFILE_DEFAULT_COOLDOWN_MS;
      next.cooldownUntilMs = until;
      next.utilization = Math.max(signal.utilization ?? 1, 1);
      next.lastReason = "quota_exhausted";
      next.windowResetsAtMs = signal.resetsAtMs;
    } else if (signal.status === "allowed" || signal.status === "allowed_warning") {
      if (signal.utilization !== null) {
        next.utilization = signal.utilization;
        next.windowResetsAtMs = signal.resetsAtMs;
      }
      // A successful read after a reset clears an expired bench.
      if (next.cooldownUntilMs !== null && next.cooldownUntilMs <= at) {
        next.cooldownUntilMs = null; next.lastReason = null;
      }
    } else return;
    this.states.set(key, next);
    try { this.persist(key, next); } catch { /* the store is advisory */ }
  }
}
