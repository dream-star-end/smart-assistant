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
import { BOX_DEFAULT_PROFILE, boxProfileKey } from "./boxClaudeProfile.js";
import { listBoxProfiles, writeBoxProfileHealth, type BoxProfileRow } from "./boxClaudeProfileStore.js";
import { BoxProfileHealth } from "./boxProfileHealth.js";
import { BOX_PROFILE_GUARD_REFUSED, makeBoxProfileGuard } from "./boxProfileDiscovery.js";
import { scopeBoxExecToProfile } from "./boxProfileExec.js";
import { pickBoxProfile, type BoxProfileCandidate, type BoxProfilePolicy } from "./boxProfileScheduler.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import { rootLogger } from "../../logging/logger.js";

const log = rootLogger.child({ subsys: "box-account-resolver" });
const MIN_REMAINING_MS = 60_000;

export class BoxAccountResolverError extends Error {
  /** Safe cause tag (error name and provision code only, never a message). */
  constructor(readonly code: string, readonly causeTag?: string) {
    super(causeTag ? `${code} cause=${causeTag}` : code);
    this.name = "BoxAccountResolverError";
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
    list: (accountIds: readonly bigint[]) => Promise<BoxProfileRow[]>;
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
  const parent = lstatSync(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0
    || (parent.mode & 0o777) !== 0o700) throw new BoxAccountResolverError("BOX_UID_PROXY_INVALID");
  const path = join(dir, ".https-proxy");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o777) !== 0o600
      || st.nlink !== 1 || st.size < 1 || st.size > 2048) {
      throw new BoxAccountResolverError("BOX_UID_PROXY_INVALID");
    }
    const raw = readFileSync(fd, "utf8").trim();
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname
      || url.search || url.hash || url.pathname !== "/") {
      throw new BoxAccountResolverError("BOX_UID_PROXY_INVALID");
    }
    return raw;
  } catch (error) {
    if (error instanceof BoxAccountResolverError) throw error;
    throw new BoxAccountResolverError("BOX_UID_PROXY_UNAVAILABLE");
  } finally { if (fd !== undefined) closeSync(fd); }
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

  private profileCache: { atMs: number; ids: string; rows: BoxProfileRow[] } | null = null;
  private readonly guardOkUntil = new Map<string, number>();

  /** Account x login choice: affinity first (one user keeps one login), then
   * quota/health/load fallback. See boxProfileScheduler. "legacy" = no saved logins
   * anywhere in the candidate set (or no table): the original random pick, unchanged. */
  private async chooseLogin(rows: AccountRow[], args: { uid: bigint; requestId: string;
    upstreamModel: string }, nowMs: number, skip: ReadonlySet<string>):
    Promise<{ accountId: bigint; profile: string } | "legacy" | null> {
    const profiles = this.deps.profiles!;
    const selectable = cursorSelectableAccounts({ accounts: rows, model: args.upstreamModel,
      now: new Date(nowMs), cooled: new Set() });
    if (selectable.length === 0) return null;
    const ids = selectable.map((item) => item.row.id);
    const idsKey = ids.map(String).sort().join(",");
    const cacheMs = profiles.cacheMs ?? 5_000;
    let stored: BoxProfileRow[];
    if (this.profileCache && this.profileCache.ids === idsKey && nowMs - this.profileCache.atMs < cacheMs) {
      stored = this.profileCache.rows;
    } else {
      try { stored = await profiles.list(ids); }
      catch {
        // Fail closed: a read error must not turn an account whose logins were all switched off
        // into an implicit default. Only the identical account set, seen very recently, is reused.
        log.error("BOX_PROFILE_LIST_FAILED");
        if (this.profileCache && this.profileCache.ids === idsKey && nowMs - this.profileCache.atMs < 60_000) {
          stored = this.profileCache.rows;
        } else throw new BoxAccountResolverError("BOX_PROFILE_STORE_UNAVAILABLE");
      }
      this.profileCache = { atMs: nowMs, ids: idsKey, rows: stored };
    }
    if (stored.length === 0) return "legacy";
    const candidates: BoxProfileCandidate[] = [];
    for (const { row, weight } of selectable) {
      const own = stored.filter((item) => item.accountId === row.id);
      // This account has no saved logins: it predates profiles and runs its default login.
      const logins = own.length === 0
        ? [{ profile: BOX_DEFAULT_PROFILE, isDefault: true }]
        // Defence in depth behind the admin API: a row edited by hand can never route traffic to a
        // login that is logged out or whose projects dir is not the shared one (a developer dir).
        : own.filter((item) => item.enabled && item.loginState === "logged_in"
          && (item.projectsMode === "root" || item.projectsMode === "shared"))
          .map((item) => ({ profile: item.profile, isDefault: item.isDefault }));
      for (const login of logins) {
        const key = boxProfileKey(row.id, login.profile);
        if (skip.has(key)) continue;
        const durable = own.find((item) => item.profile === login.profile);
        if (durable?.healthUpdatedAt) {
          profiles.health.load(key, { utilization: durable.utilization,
            cooldownUntilMs: durable.cooldownUntil?.getTime() ?? null,
            lastReason: durable.lastReason, updatedAtMs: durable.healthUpdatedAt.getTime() });
        }
        candidates.push({ accountId: row.id, profile: login.profile, isDefault: login.isDefault,
          weight, utilization: profiles.health.get(key)?.utilization ?? null,
          cooldownActive: profiles.health.cooldownActive(key),
          loginLoad: profiles.health.recentLaunches(key), boxLoad: 0 });
      }
    }
    for (const candidate of candidates) {
      candidate.boxLoad = candidates.filter((other) => other.accountId === candidate.accountId)
        .reduce((sum, other) => sum + other.loginLoad, 0);
    }
    const pick = pickBoxProfile({ candidates, affinityKey: args.uid.toString(),
      ...(profiles.policy ? { policy: profiles.policy } : {}) });
    if (!pick) return null;
    log.info("box_login_picked", { accountId: pick.candidate.accountId.toString(),
      profile: pick.candidate.profile, reason: pick.reason, candidates: candidates.length });
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
    adminProbe?: boolean }): Promise<BoxResolvedTarget> {
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
    adminProbe?: boolean }, refused: ReadonlySet<string>): Promise<BoxResolvedTarget> {
    if (args.signal.aborted) throw new BoxAccountResolverError("BOX_RESOLVE_ABORTED");
    const now = this.deps.now ?? Date.now;
    const rows = (await this.deps.list()).filter((row) => eligible(row, now())
      && (args.requiredAccountId === undefined || row.id === args.requiredAccountId));
    let accountId: bigint;
    let profile = BOX_DEFAULT_PROFILE;
    // Cleanup, stop and observer paths pin an account and do not launch (they never wake a Box): a benched
    // or refused login must not stop them from reaching the Box to clean up.
    const inspectOnly = args.adminProbe === true
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
        const proxy = this.deps.uidProxy(args.uid);
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
      const exec = this.deps.profiles
        ? scopeBoxExecToProfile(transport, { key: boxProfileKey(accountId, profile), profile,
          health: this.deps.profiles.health }) : transport;
      const owned = owner;
      handedOff = true;
      return { accountId, exec, profile, ...(owned ? { dispose: () => owned.close() } : {}) };
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

export function createProductionBoxAccountResolver(): BoxAccountResolver {
  return new BoxAccountResolver({
    list: () => listAccounts({ provider: "cursor", status: "active", limit: 500 }),
    account: getAccount,
    token: (id) => getTokenForUse(id, undefined, { requireActiveStatus: true }),
    snapshot: getCursorTokenSnapshot,
    egress: (id, token) => resolveAccountEgressDispatcher(id, {
      egressProxy: token.egress_proxy, egressTarget: token.egress_target,
      egressProxyId: token.egress_proxy_id, egressHostUuid: token.egress_host_uuid }),
    uidProxy: boxUnboundProxy(),
    profiles: { list: (ids) => listBoxProfiles(ids),
      health: productionBoxProfileHealth() },
    makeProxyAgent: (uri) => new ProxyAgent(uri),
    fetch: (url, init, dispatcher) => undiciFetch(url,
      { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>,
  });
}
