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
const OLD_CHECK = String.raw`import hashlib,json,os,re,stat,sys,time
nonce=sys.argv[1]
if not re.fullmatch(r'[a-f0-9]{24}',nonce):raise SystemExit(126)
run='/tmp/ocv5-289-run-'+nonce
proof='/tmp/ocv5-289-proof-'+nonce
project='/home/box/.claude/projects/-tmp-ocv5-289-run-'+nonce
def summary(path):
 try:s=os.lstat(path)
 except FileNotFoundError:return {'exists':False,'metadataHash':None,'count':0,'safe':True}
 if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode):return {'exists':True,'metadataHash':None,'count':0,'safe':False}
 names=os.listdir(path)
 if len(names)>256:raise SystemExit(126)
 entries=[]
 for name in names:
  t=os.lstat(os.path.join(path,name))
  kind='history' if re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl(?:\.part)?',name) else 'stdin' if name.startswith('stdin.jsonl') else 'system' if name.startswith('system.txt') else 'catalog' if name.startswith('tool-catalog.json') else 'stdout' if name.startswith('stdout.jsonl') else 'stderr' if name.startswith('stderr.log') else 'terminal' if name=='terminal.json' else 'pending' if name.startswith('pending.') else 'result' if name.startswith('result.') else 'other'
  entries.append((kind,t.st_dev,t.st_ino,t.st_size,t.st_mtime_ns,stat.S_IMODE(t.st_mode),stat.S_ISREG(t.st_mode),t.st_uid==os.getuid(),t.st_nlink))
 encoded=json.dumps([s.st_dev,s.st_ino,s.st_mtime_ns,sorted(entries)],separators=(',',':')).encode()
 return {'exists':True,'metadataHash':hashlib.sha256(encoded).hexdigest(),'count':len(entries),
  'safe':s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700 and all(x[-3] and x[-2] and x[-1]==1 and x[-4]==0o600 for x in entries),
  'kinds':sorted(x[0] for x in entries)}
own=os.getuid();ancestors=set();pid=os.getpid()
while pid>1 and pid not in ancestors:
 ancestors.add(pid)
 try:
  raw=open('/proc/'+str(pid)+'/stat').read();pid=int(raw.rsplit(') ',1)[1].split()[1])
 except (OSError,ValueError,IndexError):break
matched=[];argv_errors=0;cwd_errors=0;stat_errors=0;zombies=0;seen=0;truncated=0
for name in os.listdir('/proc'):
 if not name.isdigit() or int(name) in ancestors:continue
 path='/proc/'+name
 try:owner=os.stat(path).st_uid
 except OSError:stat_errors+=1;continue
 if owner!=own:continue
 try:state=open(path+'/stat').read().rsplit(') ',1)[1].split()[0]
 except (OSError,IndexError):stat_errors+=1;continue
 if state=='Z':zombies+=1;continue
 seen+=1;argv=b'';cwd=''
 try:
  argv=open(path+'/cmdline','rb').read(262145)
  if len(argv)>262144:truncated+=1
 except OSError:argv_errors+=1
 try:cwd=os.readlink(path+'/cwd')
 except OSError:cwd_errors+=1
 if nonce.encode() in argv or run in cwd:matched.append(int(name))
init=open('/proc/1/stat').read().rsplit(') ',1)[1].split()
runtime=(os.uname().nodename+'|'+init[19]).encode()
print(json.dumps({'runtimeHash':hashlib.sha256(runtime).hexdigest()[:20],
 'sampleTimeMs':time.time_ns()//1000000,'run':summary(run),'proof':summary(proof),
 'project':summary(project),
 'matchingPids':matched[:16],'matchingProcessCount':len(matched),
 'sameUidProcessCount':seen,'argvErrors':argv_errors,'cwdErrors':cwd_errors,
 'statErrors':stat_errors,'zombies':zombies,'cmdlineTruncated':truncated},sort_keys=True,separators=(',',':')))`;

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
  const wakeAuthorized = process.env.OCV5_289_AUTO_WAKE_TEST_ACK === "1";
  const target = await resolver.resolve({ uid: 3n, sessionId: null,
    requestId: `box-no-paid-fence-${runNonce}`, upstreamModel: "claude-opus-5-5",
    requiredAccountId: 20n, allowWakeIfHibernated: wakeAuthorized,
    signal: new AbortController().signal });
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
    let oldEvidence: unknown = undefined;
    if (process.env.OCV5_289_INSPECT_OLD === "1") {
      const oldNonce = "23aa4f1a6e60b1d4efcdcaac";
      const readOld = async () => {
        const result = await run({ command: "/usr/bin/python3",
          args: ["-I", "-c", OLD_CHECK, oldNonce], cwd: "/tmp",
          environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        if (typeof parsed.runtimeHash !== "string"
          || !/^[a-f0-9]{20}$/.test(parsed.runtimeHash)
          || !Number.isSafeInteger(parsed.matchingProcessCount)
          || Number(parsed.matchingProcessCount) < 0
          || ![parsed.argvErrors, parsed.cwdErrors, parsed.statErrors,
            parsed.zombies].every((n) => Number.isSafeInteger(n) && Number(n) >= 0)
          || !Number.isSafeInteger(parsed.cmdlineTruncated)
          || Number(parsed.cmdlineTruncated) < 0
          || !Number.isSafeInteger(parsed.sampleTimeMs)
          || Number(parsed.sampleTimeMs) <= 0) {
          throw new Error("BOX_OLD_INSPECT_INVALID");
        }
        const projectDirectory = (value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("BOX_OLD_INSPECT_INVALID");
          }
          const item = value as Record<string, unknown>;
          if (typeof item.exists !== "boolean" || typeof item.safe !== "boolean"
            || !Number.isSafeInteger(item.count) || Number(item.count) < 0
            || Number(item.count) > 256
            || (item.metadataHash !== null
              && (typeof item.metadataHash !== "string"
                || !/^[a-f0-9]{64}$/.test(item.metadataHash)))
            || (item.kinds !== undefined && (!Array.isArray(item.kinds)
              || item.kinds.length > 256 || item.kinds.some((kind) =>
                typeof kind !== "string" || !["history", "stdin", "system", "catalog",
                  "stdout", "stderr", "terminal", "pending", "result", "other"]
                  .includes(kind))))) throw new Error("BOX_OLD_INSPECT_INVALID");
          return { exists: item.exists, safe: item.safe, count: item.count,
            metadataHash: item.metadataHash,
            ...(item.kinds === undefined ? {} : { kinds: item.kinds }) };
        };
        return { runtimeHash: parsed.runtimeHash, sampleTimeMs: parsed.sampleTimeMs,
          run: projectDirectory(parsed.run), proof: projectDirectory(parsed.proof),
          project: projectDirectory(parsed.project),
          matchingProcessCount: parsed.matchingProcessCount,
          argvErrors: parsed.argvErrors, cwdErrors: parsed.cwdErrors,
          statErrors: parsed.statErrors, zombies: parsed.zombies,
          cmdlineTruncated: parsed.cmdlineTruncated };
      };
      const first = await readOld();
      await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
      const second = await readOld();
      oldEvidence = { oldNonce, first, second,
        sameRuntime: first.runtimeHash === second.runtimeHash,
        separatedMs: Number(second.sampleTimeMs) - Number(first.sampleTimeMs) };
    }
    process.stdout.write(JSON.stringify({ accountId: "20", runNonce,
      realBox: true, paidCalls: 0, wakeAuthorized, syntheticProjectFile: true,
      stagedHashesMatch: true, remoteCleaned: true,
      ...(oldEvidence === undefined ? {} : { oldEvidence }) }) + "\n");
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
