/** One non-model, non-paid Box Sand concurrency capability probe. */
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

async function main(): Promise<void> {
  if (hostname() !== "v3-dev-sg" || getRuntimeChannel() !== "v5"
    || process.env.OC_USER_ID !== "3"
    || process.env.OCV5_291_PARALLEL_EXEC_PROBE_ACK !== "1") {
    throw new Error("BOX_PARALLEL_PROBE_BOUNDARY_INVALID");
  }
  const resolver = createProductionBoxAccountResolver();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  const targets: Array<Awaited<ReturnType<typeof resolver.resolve>>> = [];
  try {
    const t0 = performance.now();
    const resolved = await Promise.all(["a", "b"].map((label) =>
      resolver.resolve({ uid: 3n, sessionId: null,
        requestId: `box-parallel-exec-probe-${label}`,
        upstreamModel: "claude-opus-5-5", requiredAccountId: 20n,
        allowWakeIfHibernated: false, signal: abort.signal })));
    targets.push(...resolved);
    if (targets.some((target) => target.accountId !== 20n))
      throw new Error("BOX_PARALLEL_PROBE_ACCOUNT_MISMATCH");
    const readyMs = Math.round(performance.now() - t0);
    const start = performance.now();
    const results = await Promise.all(targets.map((target, index) =>
      target.exec.run({ command: "/usr/bin/python3", args: ["-I", "-c",
        `import time;time.sleep(2);print('probe-${index}')`], cwd: "/tmp",
        environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
      { timeoutMs: 10_000, maxResponseBytes: 1024, signal: abort.signal })));
    const elapsedMs = Math.round(performance.now() - start);
    if (results.some((result, index) => result.exitCode !== 0
      || result.stdout.trim() !== `probe-${index}`)) {
      throw new Error("BOX_PARALLEL_PROBE_RESULT_INVALID");
    }
    process.stdout.write(JSON.stringify({ accountId: "20", execCount: 2,
      readyMs, overlappedExecMs: elapsedMs, paidCliCalls: 0,
      promptsSent: 0 }) + "\n");
  } finally {
    clearTimeout(timer);
    await Promise.allSettled(targets.map((target) => target.dispose?.()));
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error && /^BOX_[A-Z0-9_]+$/.test(error.message)
    ? error.message + "\n" : "BOX_PARALLEL_PROBE_FAILED\n");
  process.exitCode = 1;
});
