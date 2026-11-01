/** Box login choice for the interactive session route (box-claude-*: interactive Claude Code in
 * tmux on the Box, launched by the user container's bridge). The container asks before each
 * launch; the answer follows the admin's selection (box_claude_profiles) and the same affinity /
 * quota / health scheduling as the Box model route, over the same in-process health. After each
 * turn the container reports the session's plan-window and notice lines, read by the same parser
 * as the model route's stream (BoxProfileSignalTap). The Box itself re-checks a non-default login
 * at launch (host.py profile_safe) and the container reports a refusal as `unsafe`.
 * No credentials pass here: the answer is a login name. */
import { boxProfileKey } from "./boxClaudeProfile.js";
import type { BoxProfileRow } from "./boxClaudeProfileStore.js";
import type { BoxProfileHealth } from "./boxProfileHealth.js";
import { boxLoginCandidates } from "./boxLoginCandidates.js";
import { BOX_PROFILE_POLICY, pickBoxProfile, type BoxProfilePolicy } from "./boxProfileScheduler.js";
import { BoxProfileSignalTap } from "./boxProfileSignals.js";
import { rootLogger } from "../../logging/logger.js";

const log = rootLogger.child({ subsys: "box-interactive-logins" });
const ASSIGNMENT_TTL_MS = 24 * 3_600_000;
const MAX_ASSIGNMENTS = 10_000;
/** A chat already on a login stays there (its prompt cache lives with that Claude account, and its
 * --resume is free there) until the login is benched, deselected, or this close to its window
 * limit. New chats spill earlier (BOX_PROFILE_POLICY.utilizationCeiling). */
export const BOX_SESSION_STAY_CEILING = 0.98;

export interface BoxInteractiveLoginDeps {
  /** True when the id is an active Cursor account (the only kind that owns a Box). */
  accountActive: (id: bigint) => Promise<boolean>;
  list: (ids: readonly bigint[]) => Promise<BoxProfileRow[]>;
  health: BoxProfileHealth;
  policy?: BoxProfilePolicy;
  cacheMs?: number;
  now?: () => number;
}

export type BoxInteractiveChoice =
  | { kind: "login"; profile: string; reason: string; moved?: string;
      /** Other logins a new launch could move to now (not benched, below the new-chat spill line). */
      alternatives: number }
  | { kind: "unavailable" }
  | { kind: "unknown_account" };

export class BoxInteractiveLogins {
  private readonly cache = new Map<string, { atMs: number; rows: BoxProfileRow[] }>();
  /** `${uid}:${accountId}:${profile}` -> expiry: only a login handed to this user is reported on. */
  private readonly assigned = new Map<string, number>();
  /** `${uid}:${accountId}:${session}` -> the login that chat last launched under (and expiry). */
  private readonly sessions = new Map<string, { profile: string; expires: number }>();

  constructor(private readonly deps: BoxInteractiveLoginDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private async rows(accountId: bigint): Promise<BoxProfileRow[]> {
    const key = accountId.toString();
    const at = this.now();
    const cached = this.cache.get(key);
    if (cached && at - cached.atMs < (this.deps.cacheMs ?? 5_000)) return cached.rows;
    try {
      const rows = (await this.deps.list([accountId])).filter((row) => row.accountId === accountId);
      this.cache.set(key, { atMs: at, rows });
      return rows;
    } catch (error) {
      // Same rule as the model route: never turn a failed read into "implicit default" for an
      // account whose logins may all be switched off; reuse only a successful read within 60s.
      log.error("BOX_INTERACTIVE_PROFILE_LIST_FAILED");
      if (cached && at - cached.atMs < 60_000) return cached.rows;
      throw error;
    }
  }

  /** `sticky.session`: the chat's stable id; `sticky.prefer`: the login the container says it last ran
   * on. Either keeps the chat where it was, under the stay rule; neither ever selects a login that
   * the safety filter, a bench or the admin's selection rules out. */
  async choose(uid: bigint, accountId: bigint,
    sticky: { session?: string; prefer?: string } = {}): Promise<BoxInteractiveChoice> {
    if (!(await this.deps.accountActive(accountId))) return { kind: "unknown_account" };
    const own = await this.rows(accountId);
    const candidates = boxLoginCandidates({ accountId, weight: 1, own, health: this.deps.health, nowMs: this.now() });
    const load = candidates.reduce((sum, item) => sum + item.loginLoad, 0);
    for (const candidate of candidates) candidate.boxLoad = load;
    const sessionKey = sticky.session ? `${uid}:${accountId}:${sticky.session}` : null;
    const remembered = sessionKey ? this.sessions.get(sessionKey) : undefined;
    const previous = sticky.prefer
      ?? (remembered && remembered.expires > this.now() ? remembered.profile : undefined);
    const stay = previous === undefined ? undefined : candidates.find((c) => c.profile === previous
      && !c.cooldownActive && (c.utilization === null || c.utilization < BOX_SESSION_STAY_CEILING));
    let profile: string;
    let reason: string;
    if (stay) {
      profile = stay.profile;
      reason = "session";
    } else {
      const pick = pickBoxProfile({ candidates, affinityKey: uid.toString(),
        ...(this.deps.policy ? { policy: this.deps.policy } : {}) });
      if (!pick) return { kind: "unavailable" };
      profile = pick.candidate.profile;
      reason = pick.reason;
    }
    this.deps.health.recordLaunch(boxProfileKey(accountId, profile));
    this.remember(`${uid}:${accountId}:${profile}`);
    if (sessionKey) this.rememberSession(sessionKey, profile);
    const moved = previous !== undefined && previous !== profile ? previous : undefined;
    const ceiling = (this.deps.policy ?? BOX_PROFILE_POLICY).utilizationCeiling;
    const alternatives = candidates.filter((c) => c.profile !== profile && !c.cooldownActive
      && (c.utilization === null || c.utilization < ceiling)).length;
    log.info("box_interactive_login_picked", { accountId: accountId.toString(), profile,
      reason, candidates: candidates.length, ...(moved ? { movedFrom: moved } : {}) });
    return { kind: "login", profile, reason, alternatives, ...(moved ? { moved } : {}) };
  }

  /** Applies a turn's report to the login's health. False when this user was never handed that
   * login (nothing is recorded: one user cannot bench a login another is using). */
  observe(uid: bigint, accountId: bigint, profile: string,
    report: { lines: readonly string[]; unsafe: boolean }): boolean {
    const id = `${uid}:${accountId}:${profile}`;
    const expires = this.assigned.get(id);
    if (expires === undefined || expires <= this.now()) return false;
    const key = boxProfileKey(accountId, profile);
    if (report.unsafe) this.deps.health.observe(key, { kind: "profile_unsafe" });
    const tap = new BoxProfileSignalTap((signal) => this.deps.health.observe(key, signal));
    for (const line of report.lines) tap.push(`${line}\n`);
    tap.end();
    return true;
  }

  private rememberSession(key: string, profile: string): void {
    const at = this.now();
    this.sessions.delete(key);
    this.sessions.set(key, { profile, expires: at + ASSIGNMENT_TTL_MS });
    for (const [old, entry] of this.sessions) {
      if (this.sessions.size <= MAX_ASSIGNMENTS) break;
      if (entry.expires <= at || this.sessions.size > MAX_ASSIGNMENTS) this.sessions.delete(old);
    }
  }

  private remember(id: string): void {
    const at = this.now();
    this.assigned.delete(id);
    this.assigned.set(id, at + ASSIGNMENT_TTL_MS);
    if (this.assigned.size <= MAX_ASSIGNMENTS) return;
    for (const [key, expires] of this.assigned) {
      if (this.assigned.size <= MAX_ASSIGNMENTS) break;
      if (expires <= at || this.assigned.size > MAX_ASSIGNMENTS) this.assigned.delete(key);
    }
  }
}
