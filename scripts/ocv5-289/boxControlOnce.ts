/** One-shot operator Box control. Default is read-only; a separate explicit
 * WAKE_ACK permits one official EnsureSandBox, never Exec or Claude. */
import { timingSafeEqual } from "node:crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { getAccount, getCursorTokenSnapshot, getTokenForUse } from
  "../../packages/commercial/src/account-pool/store.js";
import { resolveAccountEgressDispatcher } from
  "../../packages/commercial/src/account-pool/egressDispatcher.js";
import { CursorSandProvisionClient, sandPrincipal } from
  "../../packages/commercial/src/account-pool/cursorSandProvision.js";
import { readBoxUidProxy } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";

async function main(): Promise<void> {
  const accountId = "20";
  if (process.env.OCV5_289_ACK_ACCOUNT_ID !== accountId) {
    throw new Error("BOX_STATE_ACK_REQUIRED");
  }
  const account = await getAccount(accountId);
  if (!account || account.provider !== "cursor" || account.status !== "active"
    || !account.cursor_sand_enabled || account.cursor_credential_kind !== "session"
    || account.cursor_sand_access_state !== "SAND_ACCESS_STATE_GRANTED"
    || (account.cooldown_until && account.cooldown_until.getTime() > Date.now())) {
    throw new Error("BOX_ACCOUNT_NOT_ELIGIBLE");
  }
  const token = await getTokenForUse(accountId, undefined, { requireActiveStatus: true });
  const snapshot = await getCursorTokenSnapshot(accountId);
  let proxy: ProxyAgent | undefined;
  try {
    if (!token || !snapshot || snapshot.credential_kind !== "session"
      || !snapshot.machine_id || !snapshot.expires_at
      || snapshot.expires_at.getTime() <= Date.now() + 60_000
      || token.token.length !== snapshot.token.length
      || !timingSafeEqual(token.token, snapshot.token)) {
      throw new Error("BOX_CREDENTIAL_INVALID");
    }
    const credential = snapshot.token.toString("utf8");
    sandPrincipal(credential, "session");
    const egress = await resolveAccountEgressDispatcher(accountId, {
      egressProxy: token.egress_proxy, egressTarget: token.egress_target,
      egressProxyId: token.egress_proxy_id, egressHostUuid: token.egress_host_uuid,
    });
    if (egress.kind === "unavailable") throw new Error("BOX_EGRESS_UNAVAILABLE");
    if (egress.kind === "unbound") proxy = new ProxyAgent(readBoxUidProxy(3n));
    const dispatcher = egress.kind === "ready" ? egress.dispatcher : proxy!;
    const client = new CursorSandProvisionClient({ timeoutMs: 15_000,
      fetchImpl: (url, init) => undiciFetch(url, { ...init, dispatcher } as
        Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response> });
    client.setAccountGuard(async () => {
      const current = await getAccount(accountId);
      if (!current || current.status !== "active"
        || current.cursor_sand_access_state !== "SAND_ACCESS_STATE_GRANTED") {
        throw new Error("BOX_ACCOUNT_CHANGED");
      }
      const freshToken = await getTokenForUse(accountId, undefined,
        { requireActiveStatus: true });
      const freshSnapshot = await getCursorTokenSnapshot(accountId);
      try {
        if (!freshToken || !freshSnapshot
          || freshSnapshot.machine_id !== snapshot.machine_id
          || freshSnapshot.token.length !== snapshot.token.length
          || freshToken.token.length !== snapshot.token.length
          || !timingSafeEqual(freshSnapshot.token, snapshot.token)
          || !timingSafeEqual(freshToken.token, snapshot.token)) {
          throw new Error("BOX_CREDENTIAL_CHANGED");
        }
      } finally {
        freshToken?.token.fill(0); freshToken?.refresh?.fill(0);
        freshSnapshot?.token.fill(0); freshSnapshot?.refresh?.fill(0);
      }
    });
    // Reuse the official control request's auth/checksum, deadline and size
    // guard, but invoke ONLY its read method. The class intentionally does not
    // expose this as a production wake/resolve path.
    const readOnly = client as unknown as { control(method: "GetSandBoxRunState",
      token: string, machine: string, signal: AbortSignal): Promise<Record<string, unknown>> };
    const value = await readOnly.control("GetSandBoxRunState", credential,
      snapshot.machine_id, AbortSignal.timeout(16_000));
    if (typeof value.state !== "string"
      || !/^SAND_BOX_RUN_STATE_[A-Z_]+$/.test(value.state)) {
      throw new Error("BOX_STATE_INVALID");
    }
    const before = value.state;
    if (process.env.OCV5_289_WAKE_ACK === "1"
      && before === "SAND_BOX_RUN_STATE_HIBERNATED") {
      // connect() is the official Get→Ensure path; it never force-recreates
      // or automatically retries an ambiguous Ensure response.
      await client.connect(credential, snapshot.machine_id, AbortSignal.timeout(16_000));
      const after = await readOnly.control("GetSandBoxRunState", credential,
        snapshot.machine_id, AbortSignal.timeout(16_000));
      if (typeof after.state !== "string"
        || !/^SAND_BOX_RUN_STATE_[A-Z_]+$/.test(after.state)) {
        throw new Error("BOX_STATE_INVALID");
      }
      process.stdout.write(JSON.stringify({ accountId, before, state: after.state,
        wakeAttempted: true, observedAt: new Date().toISOString() }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({ accountId, state: before,
        wakeAttempted: false, observedAt: new Date().toISOString() }) + "\n");
    }
  } finally {
    token?.token.fill(0); token?.refresh?.fill(0);
    snapshot?.token.fill(0); snapshot?.refresh?.fill(0);
    await proxy?.destroy();
  }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
    ? error.message : "BOX_STATE_READ_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
