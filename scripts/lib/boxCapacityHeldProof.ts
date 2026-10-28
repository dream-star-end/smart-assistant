// OCV5-649 Box incident proof, kept out of scripts/check-v5-box-incident-proofs.ts to keep it inside the
// file-size ratchet (same split as scripts/lib/boxRunCleanupProof.ts). The candidate's cleanup worker talks to
// the Box through its real BoxExecTransport; the transport's request is executed for real on this host.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}

function frame(value: unknown, flag = 0): Buffer {
  const raw = Buffer.from(JSON.stringify(value));
  const out = Buffer.alloc(5 + raw.length);
  out[0] = flag;
  out.writeUInt32BE(raw.length, 1);
  raw.copy(out, 5);
  return out;
}

/** INC-20261028-BOX-CAPACITY-HELD-GHOST (commercial uid 4, account 79, #5adf074e): a resume row went unknown
 * after the Box rebooted and nothing of the run was left, yet the session got 409 BOX_CAPACITY_HELD until the
 * 4 h 15 min expiry. The liveness look asked for a response cap the transport refuses before sending, so the
 * OCV5-488 absence close never ran; and the 409 became tape ENGINE_ERROR / wire upstream_failed, both
 * auto-recovered, so three recoveries waited on the same hold. Now a gone run is released on its second look
 * and the refusal is box_capacity_held, never automatically recovered. */
export async function proveCapacityHeldReleased(candidate: string): Promise<string> {
  const load = (rel: string) => import(pathToFileURL(join(candidate, rel)).href);
  const { BoxRemoteCleanupWorker } = await load("packages/commercial/src/http/proxy/boxRemoteCleanupWorker.ts");
  const { BoxExecTransport } = await load("packages/commercial/src/http/proxy/boxExecTransport.ts");
  let looks = 0;
  const exec = new BoxExecTransport({ execUrl: "https://box.ocv5-649.test/connect.exec.v1.ExecService/Exec",
    execToken: "proof-exec", networkToken: "proof-network" }, async (_url: string, init: RequestInit) => {
    const request = JSON.parse(Buffer.from(init.body as Uint8Array).subarray(5).toString("utf8")) as
      { command: string; args: string[]; cwd: string; environment: Record<string, string> };
    if (request.args[2]?.includes("boot_id")) looks++;
    const done = spawnSync(request.command, request.args,
      { cwd: request.cwd, env: request.environment, encoding: "utf8", timeout: 10_000 });
    return new Response(Buffer.concat([...(done.stdout ? [frame({ stdoutEvent: { data: done.stdout } })] : []),
      frame({ exitEvent: done.status ? { exitCode: done.status } : {} }), frame({}, 2)]), { status: 200 });
  }, async () => {});
  // the 10-28 row: a launched first round, unknown, no proof directory and no process left on the Box
  const probe = { requestId: "box-ocv5-649", uid: 4n, accountId: 79n, runNonce: randomBytes(12).toString("hex"),
    leaseEpoch: randomBytes(16).toString("hex"), linked: false };
  let seen: { v: 1; atMs: number; boot: string } | null = null;
  const closes: Array<{ cause?: string; absence?: { boot?: string } }> = [];
  const worker = new BoxRemoteCleanupWorker({
    holds: { recordRunAbsence: async (args: { boot: string }) => {
      const prior = seen; seen ??= { v: 1, atMs: Date.now() - 61_000, boot: args.boot }; return prior;
    }, clearRunAbsence: async () => { seen = null; } },
    journal: { listStoppedFailureProbeCandidates: async () => [probe], claimStoppedFailureProbe: async () => true,
      markFirstRoundStoppedFailure: async () => fail("CAPACITY_HELD_NO_PROOF_EXISTS"),
      markToolChainStoppedFailure: async () => fail("CAPACITY_HELD_NO_PROOF_EXISTS"),
      markRunExpiredUnproven: async (args: { cause?: string; absence?: { boot?: string } }) => {
        closes.push(args);
        return { action: "closed", shape: "unbilled_leaf", priorBoxState: "unknown", ancestors: 0 };
      },
      listRemoteCleanupCandidates: async () => [], claimRemoteCleanup: async () => false,
      markRemoteCleaned: async () => fail("CAPACITY_HELD_MUST_NOT_CLEAN") },
    resolver: { resolve: async () => ({ accountId: 79n, exec, dispose: async () => {} }) },
  });
  await worker.reconcileStoppedFailures(10);
  if (looks !== 1 || seen === null || closes.length !== 0) fail(`CAPACITY_HELD_FIRST_LOOK_${looks}_${closes.length}`);
  await worker.reconcileStoppedFailures(10);
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (looks !== 2 || closes.length !== 1 || closes[0]?.cause !== "box_process_absent"
    || closes[0]?.absence?.boot !== boot) {
    fail(`CAPACITY_HELD_GONE_RUN_NOT_RELEASED_${looks}_${closes.length}_${String(closes[0]?.cause)}`);
  }
  // the exact 01:36Z terminal of trace 5adf074e
  const raw = JSON.stringify({ subtype: "success", result: 'API Error: 409 {"error":{"code":"BOX_CAPACITY_HELD",'
    + '"message":"Box slot busy"},"request_id":"065f563d454c692b1f828fd3d36d49c3"}' });
  const { _buildEngineErrorFrame } = await load("packages/gateway/src/turnFrames.ts");
  const { _tapeErrorCodeForGenericFailure } = await load("packages/gateway/src/sessionManager.ts");
  const { supportsAutomaticTurnRecovery } = await load("packages/protocol/src/turnErrorTaxonomy.ts");
  const wire = _buildEngineErrorFrame({ sessionKey: "sk", channel: "webchat", peer: { id: "u4", kind: "dm" } },
    { kind: "error", error: raw }).code as string;
  const tape = _tapeErrorCodeForGenericFailure(raw) as string;
  if (wire !== "box_capacity_held" || tape !== "box_capacity_held"
    || supportsAutomaticTurnRecovery(wire) || supportsAutomaticTurnRecovery(tape)) {
    fail(`CAPACITY_HELD_AUTO_RECOVERED_${wire}_${tape}`);
  }
  return "[ocv5-649-capacity-held-ghost] PASS — a run gone from the Box is released on its second look through the real exec transport, and its 409 BOX_CAPACITY_HELD is box_capacity_held on wire and tape and never automatically recovered";
}
