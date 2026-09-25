/** Eight distinct read-only Box Exec calls on one pinned account target.
 * Stop at first failure; no stage, paid model, retry or remote mutation. */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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
  const payloadProbe = process.env.OCV5_289_PAYLOAD_ACK === "1";
  const encoded = payloadProbe ? readFileSync(new URL("./box_detached_runner.py",
    import.meta.url)).toString("base64") : "";
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
  let attempted = 0, started = 0;
  try {
    if (target.accountId !== 20n) throw new Error("BOX_STABILITY_ACCOUNT_MISMATCH");
    for (let i = 0; i < 8; i++) {
      attempted = i + 1;
      const nonce = randomBytes(6).toString("hex");
      const large = payloadProbe && i >= 4;
      const argument = large ? encoded : nonce;
      const expected = large ? String(encoded.length) : nonce;
      started = Date.now();
      const result = await target.exec.run({ command: "/usr/bin/python3",
        args: ["-I", "-c", large ? "import sys;print(len(sys.argv[1]))"
          : "import sys;print(sys.argv[1])", argument], cwd: "/tmp",
        environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
      { timeoutMs: 45_000, maxResponseBytes: 4096 });
      if (result.stdout.trim() !== expected || result.exitCode !== 0) {
        throw new Error("BOX_STABILITY_ECHO_INVALID");
      }
      completed++;
      elapsedMs.push(Date.now() - started);
    }
    process.stdout.write(JSON.stringify({ accountId: "20", completed,
      readOnlyExec: true, payloadProbe, payloadBytes: encoded.length,
      elapsedMs, transportFailures: failures }) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ completed, attempted,
      pendingMs: started ? Date.now() - started : null, elapsedMs,
      code: error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
        ? error.message : "BOX_STABILITY_FAILED", transportFailures: failures }) + "\n");
    throw error;
  } finally { await target.dispose?.(); }
}
void main().then(() => process.exit(0), () => process.exit(1));
