/** One fresh no-paid Box capability probe. This intentionally obtains an Exec
 * descriptor (EnsureSandBox may wake a Box) for real write-fence acceptance;
 * it never runs Claude, never replays an ambiguous private write. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createProductionBoxAccountResolver } from "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { makeBoxPrelaunchBootstrap, parseBoxPrelaunchBootstrap,
  makeBoxPrelaunchInit, guardBoxPrivateStage, makeBoxPrelaunchCleanup,
  type BoxPrelaunchReceipt } from "../../packages/commercial/src/http/proxy/boxPrelaunchControl.js";
import { makeBoxStageFiles } from "../../packages/commercial/src/http/proxy/boxStageFiles.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import type { BoxCcExecRequest } from "@openclaude/gateway";

const OBSERVE = String.raw`import hashlib,json,os,re,sys
nonce,uuid=sys.argv[1:]
if not re.fullmatch(r'[a-f0-9]{24}',nonce) or not re.fullmatch(r'[0-9a-f-]{36}',uuid):raise SystemExit(126)
cwd='/tmp/ocv5-289-run-'+nonce
project='/home/box/.claude/projects/-tmp-ocv5-289-run-'+nonce
control='/tmp/ocv5-289-stage-'+nonce
def digest(path):
 with open(path,'rb') as f:return hashlib.sha256(f.read()).hexdigest()
print(json.dumps({'systemHash':digest(cwd+'/system.txt'),
 'snapshotHash':digest(project+'/'+uuid+'.jsonl'),
 'controlPresent':os.path.isdir(control)},sort_keys=True,separators=(',',':')))`;
const VERIFY_CLEAN = String.raw`import json,os,re,sys
nonce=sys.argv[1]
if not re.fullmatch(r'[a-f0-9]{24}',nonce):raise SystemExit(126)
base='/tmp/ocv5-289-run-'+nonce
project='/home/box/.claude/projects/-tmp-ocv5-289-run-'+nonce
control='/tmp/ocv5-289-stage-'+nonce
print(json.dumps({'runAbsent':not os.path.lexists(base),
 'projectAbsent':not os.path.lexists(project),
 'closed':os.path.isfile(control+'/CLOSED'),
 'cleaned':os.path.isfile(control+'/CLEANED')},sort_keys=True,separators=(',',':')))`;

async function main(): Promise<void> {
  if (process.env.OCV5_289_ACK_ACCOUNT_ID !== "20"
    || process.env.OCV5_289_ACK_USER_ID !== "3"
    || process.env.OCV5_289_NO_PAID_FENCE_ACK !== "1"
    || getRuntimeChannel() !== "v5") throw new Error("BOX_FENCE_OPERATOR_ACK_REQUIRED");
  const runNonce = randomBytes(12).toString("hex");
  const leaseEpoch = randomBytes(16).toString("hex");
  const controlId = randomBytes(16).toString("hex");
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  const project = `/home/box/.claude/projects/-tmp-ocv5-289-run-${runNonce}`;
  const uuid = randomUUID();
  const system = Buffer.from(`synthetic-system-${randomBytes(12).toString("hex")}`);
  const snapshot = Buffer.from(JSON.stringify({ synthetic: randomBytes(12).toString("hex") }) + "\n");
  const sha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
  const staged = makeBoxStageFiles({ cwd, project, files: [
    { path: `${cwd}/system.txt`, raw: system, hash: sha(system) },
    { path: `${project}/${uuid}.jsonl`, raw: snapshot, hash: sha(snapshot) },
  ] });
  const resolver = createProductionBoxAccountResolver();
  const target = await resolver.resolve({ uid: 3n, sessionId: null,
    requestId: `box-no-paid-fence-${runNonce}`, upstreamModel: "claude-opus-5-5",
    requiredAccountId: 20n, signal: new AbortController().signal });
  let receipt: BoxPrelaunchReceipt | null = null;
  let clean = false;
  let postconditionProven = false;
  const run = async (request: BoxCcExecRequest) => {
    if (request.command !== "/usr/bin/python3") throw new Error("BOX_PAID_COMMAND_FORBIDDEN");
    return target.exec.run(request, { timeoutMs: 20_000, maxResponseBytes: 8192 });
  };
  try {
    if (target.accountId !== 20n) throw new Error("BOX_ACCOUNT_MISMATCH");
    const bootstrap = await run(makeBoxPrelaunchBootstrap({ runNonce, leaseEpoch,
      accountId: "20", controlId }));
    receipt = parseBoxPrelaunchBootstrap(bootstrap.stdout, { runNonce, leaseEpoch,
      accountId: "20", controlId });
    const init = await run(makeBoxPrelaunchInit(receipt, project));
    if (init.stdout.trim() !== "ready") throw new Error("BOX_FENCE_INIT_UNPROVEN");
    for (const step of staged.requests.slice(1)) {
      await run(guardBoxPrivateStage(step, receipt));
    }
    const observed = JSON.parse((await run({ command: "/usr/bin/python3",
      args: ["-I", "-c", OBSERVE, runNonce, uuid], cwd: "/tmp",
      environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } })).stdout) as Record<string, unknown>;
    if (observed.systemHash !== sha(system) || observed.snapshotHash !== sha(snapshot)
      || observed.controlPresent !== true) throw new Error("BOX_FENCE_STAGE_MISMATCH");
    const cleaned = await run(makeBoxPrelaunchCleanup(receipt));
    if (cleaned.stdout.trim() !== `cleaned:${receipt.identityHash}`) {
      throw new Error("BOX_FENCE_CLEAN_UNPROVEN");
    }
    clean = true;
    const after = JSON.parse((await run({ command: "/usr/bin/python3",
      args: ["-I", "-c", VERIFY_CLEAN, runNonce], cwd: "/tmp",
      environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } })).stdout) as Record<string, unknown>;
    if (after.runAbsent !== true || after.projectAbsent !== true
      || after.closed !== true || after.cleaned !== true) {
      throw new Error("BOX_FENCE_POSTCONDITION_INVALID");
    }
    postconditionProven = true;
    process.stdout.write(JSON.stringify({ accountId: "20", runNonce,
      realBox: true, paidCalls: 0, projectHistory: true,
      stagedHashesMatch: true, remoteCleaned: true }) + "\n");
  } catch (error) {
    // Only independent, idempotent CLOSED/CLEANED is safe after a stage error.
    // Never resend INIT, WRITE or FINISH. Failure retains a synthetic-only
    // remote run for exact operator recovery; no paid model was started.
    if (receipt && !clean) {
      try {
        const cleaned = await run(makeBoxPrelaunchCleanup(receipt));
        clean = cleaned.stdout.trim() === `cleaned:${receipt.identityHash}`;
      } catch { /* fail closed */ }
    }
    process.stderr.write(JSON.stringify({ code: error instanceof Error
      && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "BOX_FENCE_PROBE_FAILED",
      runNonce, cleanedReceiptSeen: clean,
      cleanupProven: postconditionProven, paidCalls: 0 }) + "\n");
    throw error;
  } finally { await target.dispose?.(); }
}
void main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_FENCE_PROBE_FAILED";
  process.stderr.write(code + "\n"); process.exitCode = 1;
});
