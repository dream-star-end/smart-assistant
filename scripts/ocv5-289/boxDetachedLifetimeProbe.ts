/** Operator-only, non-model Box capability proof. Never replays a paid call.
 * Tests whether a detached child survives its launching Connect Exec and can
 * be observed from a separate request. Child self-exits within 30 seconds. */
import { randomBytes } from "node:crypto";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import { makeBoxDetachedProbePlan } from "./boxDetachedProbePlan.js";

const ACCOUNT_ID = 20n, UID = 3n;
async function main(): Promise<void> {
  if (process.env.OCV5_289_ACK_ACCOUNT_ID !== String(ACCOUNT_ID)
    || process.env.OCV5_289_ACK_USER_ID !== String(UID)
    || process.env.OCV5_289_DETACHED_ACK !== "1"
    || getRuntimeChannel() !== "v5") throw new Error("BOX_DETACHED_ACK_REQUIRED");
  const requestId = `ocv5-289-detached-${randomBytes(12).toString("hex")}`;
  const resolver = createProductionBoxAccountResolver();
  const target = await resolver.resolve({ uid: UID,
    sessionId: requestId, requestId, upstreamModel: "claude-opus-5-5",
    signal: new AbortController().signal, requiredAccountId: ACCOUNT_ID });
  let observationTarget: typeof target | null = null;
  let launchCloseAttempted = false;
  try {
    if (target.accountId !== ACCOUNT_ID) throw new Error("BOX_DETACHED_ACCOUNT_MISMATCH");
    const plan = makeBoxDetachedProbePlan(randomBytes(12).toString("hex"));
    const run = (selected: typeof target, request: typeof plan.launch) => selected.exec.run(request, {
      timeoutMs: 20_000, maxResponseBytes: 4096 });
    const launch = await run(target, plan.launch); // One launch; ambiguity is never retried.
    if (launch.stdout.trim() !== "started") throw new Error("BOX_DETACHED_LAUNCH_INVALID");
    // A second authenticated Box target, not just a second Exec on the same
    // ProxyAgent, must see the still-running detached child.
    launchCloseAttempted = true;
    await target.dispose?.();
    observationTarget = await resolver.resolve({ uid: UID, sessionId: requestId,
      requestId: `${requestId}-observe`, upstreamModel: "claude-opus-5-5",
      signal: new AbortController().signal, requiredAccountId: ACCOUNT_ID });
    if (observationTarget === target || observationTarget.accountId !== ACCOUNT_ID) {
      throw new Error("BOX_DETACHED_SECOND_TARGET_INVALID");
    }
    let observed = false;
    try {
      const result = await run(observationTarget, plan.observe);
      const counts = JSON.parse(result.stdout) as { first?: unknown; second?: unknown };
      observed = Number.isSafeInteger(counts.first) && Number.isSafeInteger(counts.second)
        && Number(counts.second) >= Number(counts.first) + 2;
      if (!observed) throw new Error("BOX_DETACHED_LIFETIME_UNPROVEN");
    } finally {
      // A failed cleanup is reported, never hidden. The child has its own 30s
      // deadline; do not issue a second stop after ambiguous transport.
      const stopped = await run(observationTarget, plan.stop);
      if (stopped.stdout.trim() !== "stopped") throw new Error("BOX_DETACHED_STOP_UNKNOWN");
    }
    process.stdout.write(JSON.stringify({ accountId: String(ACCOUNT_ID),
      launchExecTerminal: true, observedFromSecondExec: observed,
      observedFromFreshTarget: true,
      childStopped: true, paidModelCalls: 0 }) + "\n");
  } finally {
    if (observationTarget) await observationTarget.dispose?.();
    if (!launchCloseAttempted) await target.dispose?.();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(message)
    ? message : "BOX_DETACHED_PROBE_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
