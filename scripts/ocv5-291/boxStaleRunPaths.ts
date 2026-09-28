/** Read-only exact-path status for one pinned selfhost Box run. No content. */
import { hostname } from "node:os";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const PY = String.raw`import json,os,re,stat,sys
nonce,digest=sys.argv[1:]
if not re.fullmatch(r'[a-f0-9]{24}',nonce) or not re.fullmatch(r'[a-f0-9]{64}',digest):raise SystemExit(126)
base='/tmp/ocv5-289-run-'+nonce
paths={'run':base,'stdout':base+'/stdout.jsonl','stderr':base+'/stderr.log',
 'proof':'/tmp/ocv5-289-proof-'+nonce+'/terminal.json',
 'runner':'/tmp/ocv5-289-v2-detached-runner-'+digest[:16]+'.py'}
out={}
for key,path in paths.items():
 try:s=os.lstat(path)
 except FileNotFoundError:out[key]={'present':False};continue
 out[key]={'present':True,'kind':'dir' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'other',
  'mode':stat.S_IMODE(s.st_mode),'owner':s.st_uid==os.getuid(),'bytes':s.st_size,'nlink':s.st_nlink}
own={os.getpid(),os.getppid()};matches=0
for item in os.listdir('/proc'):
 if not item.isdecimal() or int(item) in own:continue
 try:
  p='/proc/'+item+'/cmdline';st=os.stat(p)
  if st.st_uid!=os.getuid():continue
  with open(p,'rb') as f:raw=f.read(8192)
  if nonce.encode() in raw:matches+=1
 except (FileNotFoundError,ProcessLookupError,PermissionError):continue
out['matchingRunProcesses']=matches
print(json.dumps(out,sort_keys=True))`;
async function main(): Promise<void> {
  const nonce = process.env.OCV5_291_EXPECT_RUN_NONCE ?? "";
  const digest = process.env.OCV5_291_EXPECT_RUNNER_HASH ?? "";
  if (hostname() !== "v3-dev-sg" || getRuntimeChannel() !== "v5"
    || process.env.OC_USER_ID !== "3" || process.env.OCV5_291_READ_ACK !== "1"
    || !/^[a-f0-9]{24}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("BOX_PATHS_BOUNDARY_INVALID");
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  const resolver = createProductionBoxAccountResolver();
  let target: Awaited<ReturnType<typeof resolver.resolve>> | undefined;
  try {
    target = await resolver.resolve({ uid: 3n, sessionId: null,
      requestId: "91da5d7643ecdc67b30f476b4449072a",
      upstreamModel: "claude-opus-5-5", requiredAccountId: 20n,
      allowWakeIfHibernated: false, signal: abort.signal });
    if (target.accountId !== 20n) throw new Error("BOX_PATHS_ACCOUNT_MISMATCH");
    const result = await target.exec.run({ command: "/usr/bin/python3",
      args: ["-I", "-c", PY, nonce, digest], cwd: "/tmp",
      environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
    { timeoutMs: 10_000, maxResponseBytes: 2048, signal: abort.signal });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(",") !==
      "matchingRunProcesses,proof,run,runner,stderr,stdout")
      throw new Error("BOX_PATHS_FRAME_INVALID");
    process.stdout.write(JSON.stringify(parsed) + "\n");
  } finally {
    clearTimeout(timer);
    if (target) await Promise.race([Promise.resolve().then(() => target!.dispose?.())
      .catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error && /^BOX_[A-Z0-9_]+$/.test(error.message)
    ? error.message + "\n" : "BOX_PATHS_FAILED\n");
  process.exitCode = 1;
});
