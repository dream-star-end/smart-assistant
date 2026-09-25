/** Eight distinct read-only Box Exec calls on one pinned account target.
 * Stop at first failure; no stage, paid model, retry or remote mutation. */
import { randomBytes } from "node:crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { getAccount, getCursorTokenSnapshot, getTokenForUse, listAccounts } from
  "../../packages/commercial/src/account-pool/store.js";
import { resolveAccountEgressDispatcher } from
  "../../packages/commercial/src/account-pool/egressDispatcher.js";
import { BoxAccountResolver, readBoxUidProxy } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

async function main(): Promise<void> {
  if (process.env.OCV5_289_ACK_ACCOUNT_ID !== "20"
    || process.env.OCV5_289_ACK_USER_ID !== "3"
    || process.env.OCV5_289_STABILITY_ACK !== "1"
    || getRuntimeChannel() !== "v5") throw new Error("BOX_STABILITY_ACK_REQUIRED");
  const failures: Array<{ path: string; code: string; name: string }> = [];
  const resolver = new BoxAccountResolver({
    list: () => listAccounts({ provider: "cursor", status: "active", limit: 500 }),
    account: getAccount,
    token: (id) => getTokenForUse(id, undefined, { requireActiveStatus: true }),
    snapshot: getCursorTokenSnapshot,
    egress: (id, token) => resolveAccountEgressDispatcher(id, {
      egressProxy: token.egress_proxy, egressTarget: token.egress_target,
      egressProxyId: token.egress_proxy_id, egressHostUuid: token.egress_host_uuid }),
    uidProxy: readBoxUidProxy,
    makeProxyAgent: (uri) => new ProxyAgent(uri),
    fetch: async (url, init, dispatcher) => {
      try { return await undiciFetch(url, { ...init, dispatcher } as
        Parameters<typeof undiciFetch>[1]) as unknown as Response; }
      catch (error) {
        const raw = error as { code?: unknown; cause?: { code?: unknown } };
        const code = raw.code ?? raw.cause?.code;
        const name = error instanceof Error ? error.name : "UnknownError";
        failures.push({ path: new URL(url).pathname,
          code: typeof code === "string" && /^[A-Z_]{2,40}$/.test(code)
            ? code : "FETCH_REJECTED_UNCLASSIFIED",
          name: /^[A-Za-z]{2,40}$/.test(name) ? name : "UnknownError" });
        throw error;
      }
    },
  });
  const target = await resolver.resolve({ uid: 3n, sessionId: null,
    requestId: `ocv5-289-stability-${randomBytes(12).toString("hex")}`,
    upstreamModel: "claude-opus-5-5", requiredAccountId: 20n,
    signal: new AbortController().signal });
  let completed = 0;
  const elapsedMs: number[] = [];
  try {
    if (target.accountId !== 20n) throw new Error("BOX_STABILITY_ACCOUNT_MISMATCH");
    for (let i = 0; i < 8; i++) {
      const nonce = randomBytes(6).toString("hex");
      const started = Date.now();
      const result = await target.exec.run({ command: "/usr/bin/python3",
        args: ["-I", "-c", "import sys;print(sys.argv[1])", nonce], cwd: "/tmp",
        environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
      { timeoutMs: 45_000, maxResponseBytes: 4096 });
      if (result.stdout.trim() !== nonce || result.exitCode !== 0) {
        throw new Error("BOX_STABILITY_ECHO_INVALID");
      }
      completed++;
      elapsedMs.push(Date.now() - started);
    }
    process.stdout.write(JSON.stringify({ accountId: "20", completed,
      readOnlyExec: true, elapsedMs, transportFailures: failures }) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ completed, elapsedMs,
      code: error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
        ? error.message : "BOX_STABILITY_FAILED", transportFailures: failures }) + "\n");
    throw error;
  } finally { await target.dispose?.(); }
}
void main().then(() => process.exit(0), () => process.exit(1));
