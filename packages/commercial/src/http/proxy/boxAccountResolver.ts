/** Official Cursor account -> Box Exec target. This is an internal master-side
 * dependency of the off-by-default Box model route, never a user-container API.
 * The route must still supply a durable invocation journal before activation.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { getAccount, getCursorTokenSnapshot, getTokenForUse, listAccounts,
  type AccountRow, type AccountToken, type CursorTokenSnapshot } from "../../account-pool/store.js";
import { resolveAccountEgressDispatcher, type EgressResolution } from "../../account-pool/egressDispatcher.js";
import { CursorSandProvisionClient, SandProvisionError, sandPrincipal } from "../../account-pool/cursorSandProvision.js";
import { cursorSelectableAccounts, selectCursorAccount } from "../../account-pool/cursorAccountSelection.js";
import { BoxExecTransport, BoxExecTransportError } from "./boxExecTransport.js";
import { BOX_DEFAULT_PROFILE, boxProfileKey, isBoxLaunchRequest } from "./boxClaudeProfile.js";
import { listBoxProfiles, writeBoxProfileHealth, type BoxProfileRow } from "./boxClaudeProfileStore.js";
import { BoxProfileHealth } from "./boxProfileHealth.js";
import { BOX_PROFILE_GUARD_REFUSED, makeBoxProfileGuard } from "./boxProfileDiscovery.js";
import { scopeBoxExecToProfile } from "./boxProfileExec.js";
import { boxLoginCandidates } from "./boxLoginCandidates.js";
import { BOX_PROFILE_POLICY, pickBoxProfile, type BoxProfileCandidate,
  type BoxProfilePolicy } from "./boxProfileScheduler.js";
import { affinitySettings, resolveAffinity } from "../../account-pool/policy/affinity.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import { rootLogger } from "../../logging/logger.js";

const log = rootLogger.child({ subsys: "box-account-resolver" });
const MIN_REMAINING_MS = 60_000;

/** Logins a model launch may run under: `default` for `claude -p` models (the default login of each
 * account only, boxModelRouteLogins), `all` for interactive-runner models (every enabled login). */
export type BoxLoginScope = "default" | "all";
/** How long a chat's login is remembered, and how many chats (oldest forgotten first). */
/** A running chat leaves its login at this utilization (operator, 2026-10-12): late enough that a
 * chat rarely moves, early enough that the switch turn (and the compaction before it, see
 * boxSwitchCompaction) still has room on the old window. New chats spill earlier (policy). */
export const BOX_CHAT_SWITCH_AT = 0.95;
const CHAT_LOGIN_TTL_MS = 24 * 3_600_000;
const CHAT_LOGIN_MAX = 10_000;

/** A no-launch target: every request is passed through except a Claude CLI launch, which no login was
 * scheduled for. */
export function refuseBoxLaunch<T extends Pick<BoxExecTransport, "run">>(inner: T): Pick<BoxExecTransport, "run"> {
  return {
    run(request, opts) {
      if (isBoxLaunchRequest(request)) return Promise.reject(new BoxAccountResolverError("BOX_TARGET_NO_LAUNCH"));
      return inner.run(request, opts);
    },
  };
}

export class BoxAccountResolverError extends Error {
  /** Safe cause tag (error name and provision code only, never a message). */
  constructor(readonly code: string, readonly causeTag?: string,
    readonly uidProxyFailure?: "missing" | "invalid") {
    super(causeTag ? `${code} cause=${causeTag}` : code);
    this.name = "BoxAccountResolverError";
  }
}

/** Only a confirmed configuration failure with no account-bound alternative in the
 * current eligible scope may end the turn. Unmarked/temporary failures keep the
 * gateway's existing recovery path; this proof never selects another account. */
export class BoxEgressNotConfiguredError extends BoxAccountResolverError {
  constructor(code: "BOX_UID_PROXY_UNAVAILABLE" | "BOX_UID_PROXY_INVALID",
    reason: "missing" | "invalid") {
    super(code, undefined, reason);
    this.name = "BoxEgressNotConfiguredError";
  }
}

/** The Box-side guard refused a non-default login (it logged out, or its projects dir is no longer the
 * shared one). Raised before any lease or admission, so the caller can pick another login. */
class BoxProfileUnsafeError extends BoxAccountResolverError {
  constructor(readonly key: string) { super("BOX_PROFILE_UNSAFE"); }
}

type FetchFn = (url: string, init: RequestInit, dispatcher: Dispatcher | undefined) => Promise<Response>;
type AccountGetter = (id: bigint) => Promise<AccountRow | null>;
type TokenGetter = (id: bigint) => Promise<AccountToken | null>;
type SnapshotGetter = (id: bigint) => Promise<CursorTokenSnapshot | null>;

export interface BoxAccountResolverDeps {
  list: () => Promise<AccountRow[]>;
  /** Failure-only metadata proof. Normal selection still uses list unchanged.
   * Missing, failed or truncated snapshots cannot prove no automatic recovery. */
  recoveryScope?: () => Promise<{ complete: boolean; accounts: readonly AccountRow[] }>;
  account: AccountGetter;
  token: TokenGetter;
  snapshot: SnapshotGetter;
  egress: (id: bigint, token: AccountToken) => Promise<EgressResolution>;
  /** The proxy an account without an egress binding leaves through for this user. Null: this deployment has
   * no per-user proxy and such an account uses the host's own egress (boxUnboundProxy). */
  uidProxy: (uid: bigint) => string | null;
  makeProxyAgent: (uri: string) => Pick<ProxyAgent, "destroy"> & Dispatcher;
  /** Claude Code logins per Box account. Absent: every account runs its default
   * login exactly as before (selfhost, unit fixtures). */
  profiles?: {
    /** `scope` says which logins a launch may use (BoxLoginScope). */
    list: (accountIds: readonly bigint[], scope: BoxLoginScope) => Promise<BoxProfileRow[]>;
    health: BoxProfileHealth;
    policy?: BoxProfilePolicy;
    cacheMs?: number;
  };
  fetch: FetchFn;
  now?: () => number;
  random?: () => number;
}

function eligible(row: AccountRow, now: number): boolean {
  return row.provider === "cursor" && row.status === "active"
    && row.cursor_sand_enabled && row.cursor_credential_kind === "session"
    && row.cursor_sand_access_state === "SAND_ACCESS_STATE_GRANTED"
    && (!row.cooldown_until || row.cooldown_until.getTime() <= now)
    && !!row.oauth_expires_at && row.oauth_expires_at.getTime() > now + MIN_REMAINING_MS;
}

function digest(parts: readonly (string | Buffer | null | undefined)[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = typeof part === "string" ? Buffer.from(part) : part ?? Buffer.alloc(0);
    const size = Buffer.allocUnsafe(4); size.writeUInt32BE(value.length, 0);
    hash.update(size).update(value);
  }
  return hash.digest();
}

function bindingDigest(token: AccountToken): Buffer {
  const target = token.egress_target;
  return digest([String(token.egress_proxy_id ?? ""), token.egress_host_uuid,
    token.egress_proxy, target?.hostUuid, target?.host,
    target ? String(target.port) : null, target?.fingerprint,
    target?.pskNonce, target?.pskCt]);
}

function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

class OwnedProxy {
  private done = false;
  private pending: Promise<void> | null = null;
  constructor(private readonly agent: Pick<ProxyAgent, "destroy">) {}
  close(): Promise<void> {
    if (this.done) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(() => this.agent.destroy()).then(() => {
      this.done = true; this.pending = null;
    }, (error: unknown) => { this.pending = null; throw error; });
    return this.pending;
  }
  get closing(): boolean { return this.pending !== null; }
}

/** Root-owned uid-specific proxy file. Never use global HTTPS_PROXY as fallback:
 * account20's Box identity can have a different egress from the master. */
export function readBoxUidProxy(uid: bigint): string {
  if (uid <= 0n || uid > 1_000_000_000n) throw new BoxAccountResolverError("BOX_UID_INVALID");
  const dir = `/etc/openclaude/cursor-v5-u${uid}`;
  const path = join(dir, ".https-proxy");
  let fd: number | undefined;
  try {
    const parent = lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0
      || (parent.mode & 0o777) !== 0o700) throw new BoxAccountResolverError("BOX_UID_PROXY_INVALID", undefined, "invalid");

    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o777) !== 0o600
      || st.nlink !== 1 || st.size < 1 || st.size > 2048) {
      throw new BoxAccountResolverError("BOX_UID_PROXY_INVALID", undefined, "invalid");
    }
    const raw = readFileSync(fd, "utf8").trim();
    let url: URL;
    try { url = new URL(raw); }
    catch { throw new BoxAccountResolverError("BOX_UID_PROXY_INVALID", undefined, "invalid"); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname
      || url.search || url.hash || url.pathname !== "/") {
      throw new BoxAccountResolverError("BOX_UID_PROXY_INVALID", undefined, "invalid");
    }
    return raw;
  } catch (error) {
    if (error instanceof BoxAccountResolverError) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    // Descriptor pressure, I/O errors and unknown failures may recover on the
    // existing next attempt. Do not turn them into a terminal configuration error.
    throw new BoxAccountResolverError("BOX_UID_PROXY_UNAVAILABLE", undefined,
      code === "ENOENT" ? "missing" : code === "ENOTDIR" ? "invalid" : undefined);
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** OCV5-424 user affinity over Box logins (account × profile). Best-effort: null → normal pick. */
export async function boxUserAffinityPick(uid: bigint, candidates: readonly BoxProfileCandidate[],
  policy: BoxProfilePolicy): Promise<BoxProfileCandidate | null> {
  const key = (c: BoxProfileCandidate) => `${c.accountId}:${c.profile}`;
  // Same "healthy and roomy" line pickBoxProfile spills on: a busy or hot bound login
  // hands the choice back to pickBoxProfile instead of overriding its load spill.
  const usable = candidates.filter((c) => !c.cooldownActive
    && (c.utilization === null || c.utilization < policy.utilizationCeiling)
    && c.loginLoad < policy.loginSpillLoad && c.boxLoad < policy.boxSpillLoad);
  if (usable.length === 0) return null;
  try {
    const caps = await affinitySettings();
    const resolved = await resolveAffinity({
      service: "box",
      userId: uid,
      candidates: usable.map((c) => ({ memberKind: "box_profile" as const, id: key(c), capacity: c.weight })),
      maxUsers: caps.maxUsersPerSubscription,
      boundState: async (b) => {
        // Candidates are request-scoped (login scope, model): a bound login missing here is
        // only out of scope for this request — spill, never treat it as deleted.
        const c = candidates.find((x) => key(x) === b.memberId);
        if (!c) return { status: "active", cooldownReason: null, cooldownUntil: null };
        // Out of quota (benched on quota or at the switch line) is persistent; load, health and
        // other benches are temporary.
        const outOfQuota = c.cooldownQuotaOnly === true || (c.utilization !== null && c.utilization >= BOX_CHAT_SWITCH_AT);
        return outOfQuota
          ? { status: "cooldown", cooldownReason: "quota", cooldownUntil: null }
          : { status: "active", cooldownReason: null, cooldownUntil: null };
      },
    });
    // A spill is pickBoxProfile's job (its load/health ranking); only stay/bind/migrate pick here.
    if (!resolved || resolved.action === "spill") return null;
    return usable.find((c) => key(c) === resolved.member.id) ?? null;
  } catch {
    return null;
  }
}

export class BoxAccountResolver {
  private readonly orphanedAgents = new Set<OwnedProxy>();
  constructor(private readonly deps: BoxAccountResolverDeps) {}

  /** Explicit operator recovery for an agent owned by a failed resolve. */
  async retryFailedAgentCleanup(): Promise<number> {
    const attempts = Promise.allSettled([...this.orphanedAgents].filter((owner) => !owner.closing)
      .map((owner) => owner.close().then(() => { this.orphanedAgents.delete(owner); })));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([attempts, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 200);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    return this.orphanedAgents.size;
  }

  private readonly profileCache = new Map<BoxLoginScope, { atMs: number; ids: string; rows: BoxProfileRow[] }>();
  private readonly guardOkUntil = new Map<string, number>();

  /** Account x login choice: affinity first (one user keeps one login), then
   * quota/health/load fallback. See boxProfileScheduler. "legacy" = no saved logins
   * anywhere in the candidate set (or no table): the original random pick, unchanged. */
  /** `${uid}:${chat}` -> the account and login that chat last ran on (see chooseLogin). */
  private readonly chatLogins = new Map<string, { accountId: bigint; profile: string; expires: number }>();

  private rememberChatLogin(key: string, accountId: bigint, profile: string, nowMs: number): void {
    this.chatLogins.delete(key);
    this.chatLogins.set(key, { accountId, profile, expires: nowMs + CHAT_LOGIN_TTL_MS });
    for (const old of this.chatLogins.keys()) {
      if (this.chatLogins.size <= CHAT_LOGIN_MAX) break;
      this.chatLogins.delete(old);
    }
  }

  /** Read-only: true when the chat's last login can no longer take it, so its next launch moves
   * to another login (chooseLogin applies the same rule to the same rows). False for a chat this
   * process has not placed yet: nothing would move. Reads the login's durable row first, as
   * chooseLogin does, so a reading from the other egress slot counts here too. */
  async chatMustMove(uid: bigint, stickyKey: string): Promise<boolean> {
    const profiles = this.deps.profiles;
    const last = this.chatLogins.get(`${uid}:${stickyKey}`);
    if (!profiles || !last || last.expires <= (this.deps.now ?? Date.now)()) return false;
    const rows = await profiles.list([last.accountId], "all");
    const nowMs = (this.deps.now ?? Date.now)();
    const candidate = boxLoginCandidates({ accountId: last.accountId, weight: 1,
      own: rows.filter((item) => item.accountId === last.accountId), health: profiles.health, nowMs })
      .find((c) => c.profile === last.profile);
    // Switched off, logged out or deselected: it cannot take the chat either.
    if (!candidate) return true;
    return candidate.cooldownActive
      || (candidate.utilization !== null && candidate.utilization >= BOX_CHAT_SWITCH_AT);
  }

  private async chooseLogin(rows: AccountRow[], args: { uid: bigint; requestId: string;
    upstreamModel: string; loginScope?: BoxLoginScope; stickyKey?: string }, nowMs: number,
    skip: ReadonlySet<string>):
    Promise<{ accountId: bigint; profile: string } | "legacy" | null> {
    const profiles = this.deps.profiles!;
    const selectable = cursorSelectableAccounts({ accounts: rows, model: args.upstreamModel,
      now: new Date(nowMs), cooled: new Set() });
    if (selectable.length === 0) return null;
    const ids = selectable.map((item) => item.row.id);
    const idsKey = ids.map(String).sort().join(",");
    const cacheMs = profiles.cacheMs ?? 5_000;
    const scope: BoxLoginScope = args.loginScope ?? "default";
    const cached = this.profileCache.get(scope);
    let stored: BoxProfileRow[];
    if (cached && cached.ids === idsKey && nowMs - cached.atMs < cacheMs) {
      stored = cached.rows;
    } else {
      try {
        stored = await profiles.list(ids, scope);
        this.profileCache.set(scope, { atMs: nowMs, ids: idsKey, rows: stored });
      } catch {
        // Fail closed: a read error must not turn an account whose logins were all switched off
        // into an implicit default. Only the identical account set, last READ successfully within
        // 60s, is reused; a failed attempt never refreshes that timestamp.
        log.error("BOX_PROFILE_LIST_FAILED");
        if (cached && cached.ids === idsKey && nowMs - cached.atMs < 60_000) {
          stored = cached.rows;
        } else throw new BoxAccountResolverError("BOX_PROFILE_STORE_UNAVAILABLE");
      }
    }
    if (stored.length === 0) return "legacy";
    const candidates: BoxProfileCandidate[] = [];
    for (const { row, weight } of selectable) {
      candidates.push(...boxLoginCandidates({ accountId: row.id, weight,
        own: stored.filter((item) => item.accountId === row.id), health: profiles.health, skip, nowMs }));
    }
    for (const candidate of candidates) {
      candidate.boxLoad = candidates.filter((other) => other.accountId === candidate.accountId)
        .reduce((sum, other) => sum + other.loginLoad, 0);
    }
    // A running chat stays on the login it last ran on: that Claude account holds its prompt cache
    // (caches are per account), so a move makes the next turn write the whole conversation again.
    // It moves only when that login is benched or at BOX_CHAT_SWITCH_AT,
    // not for load or the new-chat spill line; new chats keep spreading as before.
    const chatKey = args.stickyKey ? `${args.uid}:${args.stickyKey}` : null;
    const last = chatKey ? this.chatLogins.get(chatKey) : undefined;
    const stay = last && last.expires > nowMs ? candidates.find((c) => c.accountId === last.accountId
      && c.profile === last.profile && !c.cooldownActive
      && (c.utilization === null || c.utilization < BOX_CHAT_SWITCH_AT)) : undefined;
    // OCV5-424: a new chat goes to the user's bound login (user affinity across chats);
    // pickBoxProfile stays the fallback when there is no usable binding.
    const userPick = stay ? null : await boxUserAffinityPick(args.uid, candidates, profiles.policy ?? BOX_PROFILE_POLICY);
    const pick = stay ? { candidate: stay, reason: "session" as const }
      : userPick ? { candidate: userPick, reason: "user" as const }
      : pickBoxProfile({ candidates, affinityKey: args.uid.toString(),
        ...(profiles.policy ? { policy: profiles.policy } : {}) });
    if (!pick) return null;
    const moved = last && last.expires > nowMs && !stay ? last.profile : undefined;
    if (chatKey) this.rememberChatLogin(chatKey, pick.candidate.accountId, pick.candidate.profile, nowMs);
    log.info("box_login_picked", { accountId: pick.candidate.accountId.toString(),
      profile: pick.candidate.profile, reason: pick.reason, candidates: candidates.length,
      ...(moved ? { movedFrom: moved } : {}) });
    return { accountId: pick.candidate.accountId, profile: pick.candidate.profile };
  }

  /** Live check, on the Box and immediately before the target is handed out, that a non-default
   * login is still logged in and still shares the product's projects directory. A positive result is
   * reused for 30s; discovery data in the database is never the safety boundary. */
  private async guardLogin(transport: Pick<BoxExecTransport, "run">, accountId: bigint,
    profile: string, signal: AbortSignal): Promise<void> {
    const key = boxProfileKey(accountId, profile);
    const at = (this.deps.now ?? Date.now)();
    if ((this.guardOkUntil.get(key) ?? 0) > at) return;
    try {
      const result = await transport.run(makeBoxProfileGuard(profile),
        { timeoutMs: 10_000, maxResponseBytes: 1024, signal });
      if (result.stdout.trim() !== "ok") throw new BoxProfileUnsafeError(key);
    } catch (error) {
      if (error instanceof BoxProfileUnsafeError) throw error;
      if (error instanceof BoxExecTransportError && error.remoteExitCode === BOX_PROFILE_GUARD_REFUSED) {
        this.guardOkUntil.delete(key);
        throw new BoxProfileUnsafeError(key);
      }
      throw error;
    }
    this.guardOkUntil.set(key, at + 30_000);
  }

  private closeFailedResolve(owner: OwnedProxy): void {
    this.orphanedAgents.add(owner);
    void owner.close().then(() => { this.orphanedAgents.delete(owner); }, () => {
      log.error("BOX_RESOLVER_EGRESS_DISPOSE_FAILED");
    });
  }

  async resolve(args: { uid: bigint; sessionId: string | null; requestId: string;
    upstreamModel: string; signal: AbortSignal;
    /** Explicitly authorized real model-call path only. Cleanup/stop/probes
     * leave this false so they cannot wake a hibernated account. */
    allowWakeIfHibernated?: boolean;
    /** Operator-only exact account fence, checked before the first Box control request. */
    requiredAccountId?: bigint;
    /** Admin discovery/maintenance on a Box: no login scheduling, so a Box whose
     * every login is benched can still be inspected. Never set on model traffic. */
    adminProbe?: boolean;
    /** The interactive Box route (box-claude-*): resolve the account and its Box exec endpoint through
     * the same credential, identity and egress checks, and hand the endpoint out (`execTarget`). No login
     * scheduling here: the interactive route asks for its login separately (BoxInteractiveLogins). */
    interactiveExecTarget?: boolean;
    /** The target only reaches runs that already exist (publishing tool results to a live run, reading
     * its spool): no login is scheduled, so an unrelated login's health or selection cannot block it
     * and nothing is logged as a pick; a CLI launch through it is refused (OCV5-390). */
    noLaunch?: boolean;
    /** Logins this launch may use; `default` when absent (BoxLoginScope). */
    loginScope?: BoxLoginScope;
    /** The chat this launch belongs to (its CLI session id): it stays on the login it last ran on. */
    stickyKey?: string }): Promise<BoxResolvedTarget> {
    const refused = new Set<string>();
    for (let attempt = 0; ; attempt++) {
      try { return await this.resolveOnce(args, refused); }
      catch (error) {
        if (!(error instanceof BoxProfileUnsafeError)) throw error;
        // The guard refused this login: bench it and let the scheduler pick another.
        this.deps.profiles?.health.observe(error.key, { kind: "profile_unsafe" });
        refused.add(error.key);
        if (attempt >= 3) throw new BoxAccountResolverError("BOX_ACCOUNT_UNAVAILABLE", "profile_unsafe");
      }
    }
  }

  private async resolveOnce(args: { uid: bigint; sessionId: string | null; requestId: string;
    upstreamModel: string; signal: AbortSignal;
    /** Explicitly authorized real model-call path only. Cleanup/stop/probes
     * leave this false so they cannot wake a hibernated account. */
    allowWakeIfHibernated?: boolean;
    /** Operator-only exact account fence, checked before the first Box control request. */
    requiredAccountId?: bigint;
    /** Admin discovery/maintenance on a Box: no login scheduling, so a Box whose
     * every login is benched can still be inspected. Never set on model traffic. */
    adminProbe?: boolean;
    /** The interactive Box route (box-claude-*): resolve the account and its Box exec endpoint through
     * the same credential, identity and egress checks, and hand the endpoint out (`execTarget`). No login
     * scheduling here: the interactive route asks for its login separately (BoxInteractiveLogins). */
    interactiveExecTarget?: boolean;
    /** The target only reaches runs that already exist (publishing tool results to a live run, reading
     * its spool): no login is scheduled, so an unrelated login's health or selection cannot block it
     * and nothing is logged as a pick; a CLI launch through it is refused (OCV5-390). */
    noLaunch?: boolean;
    loginScope?: BoxLoginScope; stickyKey?: string }, refused: ReadonlySet<string>): Promise<BoxResolvedTarget> {
    if (args.signal.aborted) throw new BoxAccountResolverError("BOX_RESOLVE_ABORTED");
    const now = this.deps.now ?? Date.now;
    const scopedRows = (await this.deps.list()).filter((row) =>
      args.requiredAccountId === undefined || row.id === args.requiredAccountId);
    const rows = scopedRows.filter((row) => eligible(row, now()));
    let accountId: bigint;
    let profile = BOX_DEFAULT_PROFILE;
    // Cleanup, stop and observer paths pin an account and do not launch (they never wake a Box): a benched
    // or refused login must not stop them from reaching the Box to clean up.
    const inspectOnly = args.adminProbe === true || args.interactiveExecTarget === true
      || args.noLaunch === true
      || (args.requiredAccountId !== undefined && args.allowWakeIfHibernated !== true);
    const choice = this.deps.profiles && !inspectOnly
      ? await this.chooseLogin(rows, args, now(), refused) : "legacy";
    if (choice === null) throw new BoxAccountResolverError("BOX_ACCOUNT_UNAVAILABLE");
    if (choice === "legacy") {
      const picked = selectCursorAccount({ accounts: rows, model: args.upstreamModel,
        now: new Date(now()), cooled: new Set(), sticky: null, random: this.deps.random });
      if (!picked) throw new BoxAccountResolverError("BOX_ACCOUNT_UNAVAILABLE");
      accountId = picked.id;
    } else {
      accountId = choice.accountId;
      profile = choice.profile;
    }
    const snapshot = await this.deps.snapshot(accountId);
    if (!snapshot) throw new BoxAccountResolverError("BOX_ACCOUNT_UNAVAILABLE");
    let credential: string;
    let tokenHash: Buffer;
    let machine: string;
    try {
      if (snapshot.credential_kind !== "session" || !snapshot.machine_id
        || !/^[a-z0-9]{16,64}$/.test(snapshot.machine_id)
        || !snapshot.expires_at || snapshot.expires_at.getTime() <= now() + MIN_REMAINING_MS) {
        throw new BoxAccountResolverError("BOX_ACCOUNT_INELIGIBLE");
      }
      credential = snapshot.token.toString("utf8");
      sandPrincipal(credential, "session", now());
      tokenHash = digest([snapshot.token]);
      machine = snapshot.machine_id;
    } finally { snapshot.token.fill(0); snapshot.refresh?.fill(0); }

    let owner: OwnedProxy | null = null;
    let handedOff = false;
    try {
      const initial = await this.deps.token(accountId);
      if (!initial) throw new BoxAccountResolverError("BOX_ACCOUNT_UNAVAILABLE");
      let basis: Buffer;
      let route: EgressResolution;
      let proxyHash: Buffer | null = null;
      try {
        if (initial.id !== accountId || !initial.expires_at
          || initial.expires_at.getTime() <= now() + MIN_REMAINING_MS
          || !same(tokenHash, digest([initial.token]))) {
          throw new BoxAccountResolverError("BOX_ACCOUNT_CHANGED");
        }
        basis = bindingDigest(initial);
        route = await this.deps.egress(accountId, initial);
      } finally { initial.token.fill(0); initial.refresh?.fill(0); }
      if (route.kind === "unavailable") throw new BoxAccountResolverError("BOX_EGRESS_UNAVAILABLE");
      let dispatcher: Dispatcher | undefined;
      if (route.kind === "ready") dispatcher = route.dispatcher;
      else {
        let proxy: string | null;
        try { proxy = this.deps.uidProxy(args.uid); }
        catch (error) {
          if (error instanceof BoxAccountResolverError
            && (error.code === "BOX_UID_PROXY_UNAVAILABLE" || error.code === "BOX_UID_PROXY_INVALID")
            && error.uidProxyFailure !== undefined
            && args.allowWakeIfHibernated === true && !inspectOnly
            // Reuse only the already-authorized candidate snapshot. A binding
            // or missing metadata means recovery may exist: keep base behavior.
            // Do not probe candidates, change affinity or move a native session.
            // Eligibility can recover during the existing retry window. Use
            // the original scoped metadata, not only this instant's selection.
            && scopedRows.every((row) => row.id === accountId
              || (row.egress_proxy === null && row.egress_proxy_id === null
                && row.egress_host_uuid === null))) {
            // Production's normal list contains only active accounts. Include
            // cooldown members that the existing health actor can restore; do
            // not mistake their absence for proof that recovery is impossible.
            let recoveryScope: Awaited<ReturnType<NonNullable<BoxAccountResolverDeps["recoveryScope"]>>> | undefined;
            try { recoveryScope = await this.deps.recoveryScope?.(); }
            catch { /* An uncertain snapshot keeps the original retry path. */ }
            if (recoveryScope?.complete === true && recoveryScope.accounts
              .filter((row) => (args.requiredAccountId === undefined || row.id === args.requiredAccountId)
                && row.provider === "cursor" && (row.status === "active" || row.status === "cooldown"))
              .every((row) => row.status === "active"
                && row.egress_proxy === null && row.egress_proxy_id === null
                && row.egress_host_uuid === null)) {
              throw new BoxEgressNotConfiguredError(error.code, error.uidProxyFailure);
            }
          }
          throw error;
        }
        if (proxy !== null) {
          proxyHash = digest([proxy]);
          const agent = this.deps.makeProxyAgent(proxy);
          dispatcher = agent;
          owner = new OwnedProxy(agent);
        }
      }
      const originalDispatcher = dispatcher;
      const assertCurrent = async (): Promise<void> => {
        if (args.signal.aborted) throw new BoxAccountResolverError("BOX_RESOLVE_ABORTED");
        const row = await this.deps.account(accountId);
        if (!row || !eligible(row, now())) throw new BoxAccountResolverError("BOX_ACCOUNT_CHANGED");
        const current = await this.deps.snapshot(accountId);
        if (!current) throw new BoxAccountResolverError("BOX_ACCOUNT_CHANGED");
        try {
          if (current.credential_kind !== "session" || current.machine_id !== machine
            || !current.expires_at || current.expires_at.getTime() <= now() + MIN_REMAINING_MS
            || !same(tokenHash, digest([current.token]))) {
            throw new BoxAccountResolverError("BOX_ACCOUNT_CHANGED");
          }
        } finally { current.token.fill(0); current.refresh?.fill(0); }
        const latest = await this.deps.token(accountId);
        if (!latest) throw new BoxAccountResolverError("BOX_ACCOUNT_CHANGED");
        try {
          if (latest.id !== accountId || !latest.expires_at
            || latest.expires_at.getTime() <= now() + MIN_REMAINING_MS
            || !same(tokenHash, digest([latest.token])) || !same(basis, bindingDigest(latest))) {
            throw new BoxAccountResolverError("BOX_ACCOUNT_CHANGED");
          }
          const latestRoute = await this.deps.egress(accountId, latest);
          if (latestRoute.kind !== route.kind
            || (latestRoute.kind === "ready" && latestRoute.dispatcher !== originalDispatcher)) {
            throw new BoxAccountResolverError("BOX_EGRESS_CHANGED");
          }
        } finally { latest.token.fill(0); latest.refresh?.fill(0); }
        if (route.kind === "unbound") {
          const proxy = this.deps.uidProxy(args.uid);
          if (proxy === null ? proxyHash !== null : proxyHash === null || !same(proxyHash, digest([proxy]))) {
            throw new BoxAccountResolverError("BOX_EGRESS_CHANGED");
          }
        }
        if (args.signal.aborted) throw new BoxAccountResolverError("BOX_RESOLVE_ABORTED");
      };
      const fetchImpl = (url: string, init: RequestInit): Promise<Response> =>
        this.deps.fetch(url, init, originalDispatcher);
      const client = new CursorSandProvisionClient({ fetchImpl, now });
      // Guard MUST be installed before GetState, not just before Ensure/Exec.
      client.setAccountGuard(assertCurrent);
      const descriptor = await client.resolveBoxExec(credential, machine, args.signal,
        { allowWakeIfHibernated: args.allowWakeIfHibernated === true });
      if (args.signal.aborted) throw new BoxAccountResolverError("BOX_RESOLVE_ABORTED");
      const transport = new BoxExecTransport(descriptor, fetchImpl, assertCurrent);
      if (this.deps.profiles && !inspectOnly && profile !== BOX_DEFAULT_PROFILE) {
        await this.guardLogin(transport, accountId, profile, args.signal);
      }
      const scoped = this.deps.profiles
        ? scopeBoxExecToProfile(transport, { key: boxProfileKey(accountId, profile), profile,
          health: this.deps.profiles.health }) : transport;
      const exec = args.noLaunch === true ? refuseBoxLaunch(scoped) : scoped;
      const owned = owner;
      handedOff = true;
      return { accountId, exec, profile, ...(owned ? { dispose: () => owned.close() } : {}),
        ...(args.interactiveExecTarget === true ? { execTarget: { execUrl: descriptor.execUrl,
          execToken: descriptor.execToken, networkToken: descriptor.networkToken } } : {}) };
    } catch (error) {
      if (error instanceof BoxAccountResolverError) throw error;
      if (args.signal.aborted) throw new BoxAccountResolverError("BOX_RESOLVE_ABORTED");
      throw new BoxAccountResolverError("BOX_TARGET_UNAVAILABLE", targetCauseTag(error));
    } finally {
      if (owner && !handedOff) this.closeFailedResolve(owner);
    }
  }
}

// OCV5-321: #611729fb lost the reason a resume target failed to resolve.
function targetCauseTag(error: unknown): string {
  if (error instanceof SandProvisionError) {
    return `SandProvisionError:${error.code}${error.httpStatus ? `:${error.httpStatus}` : ""}`;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const tag = typeof code === "string" && /^[A-Z0-9_]{1,48}$/.test(code) ? `:${code}` : "";
    return `${error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 48)}${tag}`;
  }
  return "non_error";
}

/** Where an account without an egress binding leaves from. Selfhost keeps one root-owned proxy file per user
 * and fails closed without it: the Box identity must not share the master's egress there. Commercial hosts have
 * no such files; OC_BOX_UNBOUND_EGRESS=host says so, and an unbound account then uses the host's own egress, as
 * the Sand lifecycle and the box-resident CLI lane already do on that host. Any other value keeps the file. */
export function boxUnboundProxy(env: NodeJS.ProcessEnv = process.env): (uid: bigint) => string | null {
  const setting = env.OC_BOX_UNBOUND_EGRESS;
  if (setting === "host") return () => null;
  if (setting !== undefined && setting !== "") log.error("BOX_UNBOUND_EGRESS_INVALID");
  return readBoxUidProxy;
}

let sharedHealth: BoxProfileHealth | null = null;
/** One health view per process: the resolver writes launches, the admin page reads it. */
export function productionBoxProfileHealth(): BoxProfileHealth {
  return sharedHealth ??= new BoxProfileHealth(Date.now, (key, state) => {
    const at = key.indexOf(":");
    const accountId = /^[1-9][0-9]{0,18}$/.test(key.slice(0, at)) ? BigInt(key.slice(0, at)) : null;
    if (accountId === null) return;
    void writeBoxProfileHealth(accountId, key.slice(at + 1), state).catch(() => {
      log.error("BOX_PROFILE_HEALTH_PERSIST_FAILED");
    });
  });
}

/** A `claude -p` launch of the Box model route runs only the default login of each account,
 * whatever else an admin enabled: the other logins serve interactive sessions only (operator
 * rule 2026-10-11, Box logins never serve `claude -p` product turns). Interactive-runner models
 * (BoxApiRunner "interactive", scope `all`) use every enabled login.
 * The default row keeps its stored login state and health, so a logged-out default still stops
 * the route. */
export function boxModelRouteLogins(rows: readonly BoxProfileRow[]): BoxProfileRow[] {
  return rows.filter((row) => row.profile === BOX_DEFAULT_PROFILE)
    .map((row) => ({ ...row, enabled: true, isDefault: true }));
}

export function createProductionBoxAccountResolver(): BoxAccountResolver {
  return new BoxAccountResolver({
    list: () => listAccounts({ provider: "cursor", status: "active", limit: 500 }),
    recoveryScope: async () => {
      const accounts = await listAccounts({ provider: "cursor", limit: 500 });
      return { complete: accounts.length < 500, accounts };
    },
    account: getAccount,
    token: (id) => getTokenForUse(id, undefined, { requireActiveStatus: true }),
    snapshot: getCursorTokenSnapshot,
    egress: (id, token) => resolveAccountEgressDispatcher(id, {
      egressProxy: token.egress_proxy, egressTarget: token.egress_target,
      egressProxyId: token.egress_proxy_id, egressHostUuid: token.egress_host_uuid }),
    uidProxy: boxUnboundProxy(),
    profiles: { list: async (ids, scope) => scope === "all" ? listBoxProfiles(ids)
      : boxModelRouteLogins(await listBoxProfiles(ids)),
      health: productionBoxProfileHealth(),
      // An installation that keeps one login for itself and the others as backup (selfhost:
      // cc2 first, cc1 shared with the commercial edition) turns this on.
      ...(process.env.OC_BOX_LOGIN_DEFAULT_FIRST === "1"
        ? { policy: { ...BOX_PROFILE_POLICY, defaultFirst: true } } : {}) },
    makeProxyAgent: (uri) => new ProxyAgent(uri),
    fetch: (url, init, dispatcher) => undiciFetch(url,
      { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>,
  });
}
