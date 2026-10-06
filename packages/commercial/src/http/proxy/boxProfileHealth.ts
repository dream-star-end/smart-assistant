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
  private readonly runOwners = new Map<string, string>();
  constructor(private readonly now: () => number = Date.now,
    private readonly persist: BoxProfileHealthSink = () => {}) {}

  get(key: string): BoxProfileHealthState | undefined { return this.states.get(key); }

  /** Seed from the durable store without re-persisting it. */
  load(key: string, state: BoxProfileHealthState): void {
    const held = this.states.get(key);
    if (!held || held.updatedAtMs < state.updatedAtMs) this.states.set(key, { ...state });
  }

  /** Which login a run (by its 24-hex nonce) was launched under, so its output is attributed to it even
   * when a later request for the same run is served through another login. Process-local, bounded. */
  noteRun(nonce: string, key: string): void {
    this.runOwners.delete(nonce);
    this.runOwners.set(nonce, key);
    if (this.runOwners.size > 4096) this.runOwners.delete(this.runOwners.keys().next().value!);
  }
  runKey(nonce: string): string | undefined { return this.runOwners.get(nonce); }

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
    const held = this.states.get(key);
    // Strictly increasing per login, so the store's newer-wins guard can order writes that land out of order.
    const at = Math.max(this.now(), (held?.updatedAtMs ?? 0) + 1);
    const next: BoxProfileHealthState = { utilization: held?.utilization ?? null,
      cooldownUntilMs: held?.cooldownUntilMs ?? null, lastReason: held?.lastReason ?? null,
      updatedAtMs: at, windowResetsAtMs: held?.windowResetsAtMs ?? null };
    // Re-reading the same evidence (a replayed spool, a resumed run) must not push a bench further out.
    const benched = (reason: string): boolean => held?.lastReason === reason && (held.cooldownUntilMs ?? 0) > at;
    if (signal.kind === "profile_unsafe") {
      if (benched("profile_unsafe")) return;
      next.cooldownUntilMs = at + UNSAFE_COOLDOWN_MS;
      next.lastReason = "profile_unsafe";
    } else if (signal.kind === "login_required") {
      if (benched("login_required")) return;
      next.cooldownUntilMs = at + LOGIN_COOLDOWN_MS;
      next.lastReason = "login_required";
    } else if (signal.status === "rejected") {
      const reset = signal.resetsAtMs;
      const trusted = reset !== null && reset > at && reset - at <= BOX_PROFILE_MAX_COOLDOWN_MS;
      // Evidence without a usable reset time must not push an existing quota bench further out
      // (the same rejection can be read again by a resumed run).
      if (!trusted && benched("quota_exhausted")) return;
      const until = trusted ? reset! : at + BOX_PROFILE_DEFAULT_COOLDOWN_MS;
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
