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
import { CursorSandProvisionClient, sandPrincipal } from "../../account-pool/cursorSandProvision.js";
import { selectCursorAccount } from "../../account-pool/cursorAccountSelection.js";
import { BoxExecTransport } from "./boxExecTransport.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import { rootLogger } from "../../logging/logger.js";

const log = rootLogger.child({ subsys: "box-account-resolver" });
const MIN_REMAINING_MS = 60_000;

export class BoxAccountResolverError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxAccountResolverError"; }
}

type FetchFn = (url: string, init: RequestInit, dispatcher: Dispatcher) => Promise<Response>;
type AccountGetter = (id: bigint) => Promise<AccountRow | null>;
type TokenGetter = (id: bigint) => Promise<AccountToken | null>;
type SnapshotGetter = (id: bigint) => Promise<CursorTokenSnapshot | null>;

export interface BoxAccountResolverDeps {
  list: () => Promise<AccountRow[]>;
  account: AccountGetter;
  token: TokenGetter;
  snapshot: SnapshotGetter;
  egress: (id: bigint, token: AccountToken) => Promise<EgressResolution>;
  uidProxy: (uid: bigint) => string;
  makeProxyAgent: (uri: string) => Pick<ProxyAgent, "destroy"> & Dispatcher;
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
    requiredAccountId?: bigint }): Promise<BoxResolvedTarget> {
    if (args.signal.aborted) throw new BoxAccountResolverError("BOX_RESOLVE_ABORTED");
    const now = this.deps.now ?? Date.now;
    const rows = (await this.deps.list()).filter((row) => eligible(row, now())
      && (args.requiredAccountId === undefined || row.id === args.requiredAccountId));
    const picked = selectCursorAccount({ accounts: rows, model: args.upstreamModel,
      now: new Date(now()), cooled: new Set(), sticky: null, random: this.deps.random });
    if (!picked) throw new BoxAccountResolverError("BOX_ACCOUNT_UNAVAILABLE");
    const accountId = picked.id;
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
      let dispatcher: Dispatcher;
      if (route.kind === "ready") dispatcher = route.dispatcher;
      else {
        const proxy = this.deps.uidProxy(args.uid);
        proxyHash = digest([proxy]);
        dispatcher = this.deps.makeProxyAgent(proxy);
        owner = new OwnedProxy(dispatcher);
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
        if (proxyHash !== null && !same(proxyHash, digest([this.deps.uidProxy(args.uid)]))) {
          throw new BoxAccountResolverError("BOX_EGRESS_CHANGED");
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
      const exec = new BoxExecTransport(descriptor, fetchImpl, assertCurrent);
      const owned = owner;
      handedOff = true;
      return { accountId, exec, ...(owned ? { dispose: () => owned.close() } : {}) };
    } catch (error) {
      if (error instanceof BoxAccountResolverError) throw error;
      if (args.signal.aborted) throw new BoxAccountResolverError("BOX_RESOLVE_ABORTED");
      throw new BoxAccountResolverError("BOX_TARGET_UNAVAILABLE");
    } finally {
      if (owner && !handedOff) this.closeFailedResolve(owner);
    }
  }
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
    uidProxy: readBoxUidProxy,
    makeProxyAgent: (uri) => new ProxyAgent(uri),
    fetch: (url, init, dispatcher) => undiciFetch(url,
      { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>,
  });
}
