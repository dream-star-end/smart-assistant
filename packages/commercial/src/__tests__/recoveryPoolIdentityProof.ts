import assert from "node:assert/strict";
import { getStaticProvider } from "@openclaude/protocol";
import type { request } from "undici";
import { requestRecoveryProbe, startRecoveryProber } from "../egress/recoveryProber.js";

type Send = typeof request;
type Reply = { status: number; body: string };

/** OCV5-500 (INC-20261018-RECOVERY-POOL-IDENTITY): synthetic credentials only, no network/DB.
 * Runs the candidate's recovery prober and its real probe request against a fake upstream:
 * the probe authenticates with the eligible pool identity (never the admin-disabled env key),
 * sends nothing when no identity is eligible, and heals only on a completed inference. */
export async function proveRecoveryPoolIdentity(): Promise<string> {
  const spec = getStaticProvider("opencodego");
  const completed = JSON.stringify({ type: "message", role: "assistant", stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2 }, content: [{ type: "text", text: "pong" }] });
  const runOnce = async (resolve: (provider: string) => Promise<string | null>, reply: Reply) => {
    const keys: string[] = [];
    const healed: string[] = [];
    const send = (async (_url: unknown, init: { headers?: Record<string, string> }) => {
      keys.push(init.headers?.["x-api-key"] ?? init.headers?.authorization ?? "");
      return { statusCode: reply.status, body: (async function* () { yield Buffer.from(reply.body); })() };
    }) as unknown as Send;
    const handle = startRecoveryProber({
      resolveKey: resolve,
      log: { info: () => {}, warn: () => {} },
      _deps: {
        query: (async () => ({ rows: [{ provider_id: "opencodego", health_status: "degraded", health_mode: "auto" }] })) as never,
        probeRequest: (s, key) => requestRecoveryProbe(s, key, send),
        recordSuccess: (providerId) => healed.push(providerId),
      },
    });
    assert.ok(handle, "RECOVERY_PROBER_NOT_STARTED");
    try { await handle.runNow(); } finally { handle.stop(); }
    return { keys, healed };
  };
  // the egress wiring: the pool selector decides; the disabled env identity is not a candidate
  const pool = async (provider: string) => (provider === spec.id ? "synthetic-active-pool-key" : null);
  const ok = await runOnce(pool, { status: 200, body: completed });
  assert.deepEqual(ok.keys, ["synthetic-active-pool-key"], "RECOVERY_USED_NON_POOL_IDENTITY");
  assert.deepEqual(ok.healed, ["opencodego"], "RECOVERY_NOT_RECORDED");
  const none = await runOnce(async () => null, { status: 200, body: completed });
  assert.deepEqual(none, { keys: [], healed: [] }, "RECOVERY_SENT_WITHOUT_ELIGIBLE_IDENTITY");
  const envelope = await runOnce(pool, { status: 200, body: JSON.stringify({ type: "error", error: { type: "overloaded_error" } }) });
  assert.deepEqual(envelope.healed, [], "RECOVERY_HEALED_ON_ERROR_ENVELOPE");
  const truncated = await runOnce(pool, { status: 200, body: completed.slice(0, 40) });
  assert.deepEqual(truncated.healed, [], "RECOVERY_HEALED_ON_TRUNCATED_BODY");
  return "[ocv5-500-recovery-pool-identity] PASS — recovery probes authenticate with the eligible pool identity, send nothing without one, and heal only on a completed inference";
}
