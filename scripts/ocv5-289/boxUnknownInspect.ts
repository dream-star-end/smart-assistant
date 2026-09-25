/** Read-only exact-run recovery inspection. No model launch, mutation, retry
 * or cleanup; the fixed account lock remains until proof permits release. */
import { createHash } from "node:crypto";
import { constants, closeSync, fsyncSync, lstatSync, openSync,
  readFileSync, unlinkSync } from "node:fs";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const LOCK = "/var/lib/openclaude/ocv5-289-box-operator/account-20.json";
const MUTEX = "/var/lib/openclaude/ocv5-289-box-operator/account-20.mutex";
const DIR = "/var/lib/openclaude/ocv5-289-box-operator";
const READ = String.raw`import hashlib,json,os,re,stat,sys
nonce,*assets=sys.argv[1:]
if not re.fullmatch(r'[a-f0-9]{24}',nonce) or len(assets)!=4:raise SystemExit(126)
def inspect(path,want=None):
 try:st=os.lstat(path)
 except FileNotFoundError:return {'present':False}
 if stat.S_ISLNK(st.st_mode):return {'present':True,'kind':'symlink'}
 kind='dir' if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'other'
 result={'present':True,'kind':kind,'mode':stat.S_IMODE(st.st_mode),'size':st.st_size}
 if want is not None and kind=='file' and st.st_size<=32768:
  with open(path,'rb') as f:result['hashMatches']=hashlib.sha256(f.read()).hexdigest()==want
 return result
out={'run':inspect('/tmp/ocv5-289-run-'+nonce),
 'proof':inspect('/tmp/ocv5-289-proof-'+nonce),
 'assets':[inspect(path,want) for path,want in
  (item.split(':',1) for item in assets)]}
print(json.dumps(out,separators=(',',':'))) `;

async function main(): Promise<void> {
  if (process.env.OCV5_289_ACK_ACCOUNT_ID !== "20"
    || process.env.OCV5_289_ACK_USER_ID !== "3"
    || process.env.OCV5_289_INSPECT_ACK !== "1"
    || getRuntimeChannel() !== "v5") throw new Error("BOX_INSPECT_ACK_REQUIRED");
  const clearing = process.env.OCV5_289_CLEAR_PRESTART_ACK === "1";
  let mutexHeld = false;
  const syncDirectory = (): void => {
    const fd = openSync(DIR, constants.O_RDONLY | constants.O_DIRECTORY
      | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  if (clearing) {
    let fd: number;
    try { fd = openSync(MUTEX, constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("BOX_INSPECT_OPERATOR_BUSY");
      }
      throw error;
    }
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(); mutexHeld = true;
  }
  try {
  const st = lstatSync(LOCK);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid()
    || (st.mode & 0o777) !== 0o600 || st.size < 1 || st.size > 4096) {
    throw new Error("BOX_INSPECT_LOCK_INVALID");
  }
  const rawLock = readFileSync(LOCK, "utf8");
  const record = JSON.parse(rawLock) as Record<string, unknown>;
  if (record.accountId !== "20" || record.uid !== "3"
    || typeof record.runNonce !== "string"
    || !/^[a-f0-9]{24}$/.test(record.runNonce)
    || typeof record.leaseEpoch !== "string"
    || !/^[a-f0-9]{32}$/.test(record.leaseEpoch)) {
    throw new Error("BOX_INSPECT_IDENTITY_INVALID");
  }
  const assets = ["box_supervisor.py", "box_keeper.py",
    "box_virtual_mcp.py", "box_detached_runner.py"].map((file) => {
      const hash = createHash("sha256").update(readFileSync(new URL(`./${file}`,
        import.meta.url))).digest("hex");
      const prefix = file === "box_supervisor.py" ? "supervisor"
        : file === "box_keeper.py" ? "keeper"
        : file === "box_virtual_mcp.py" ? "box-virtual-mcp" : "detached-runner";
      return `/tmp/ocv5-289-${prefix}-${hash.slice(0, 16)}.py:${hash}`;
    });
  const resolver = createProductionBoxAccountResolver();
  const target = await resolver.resolve({ uid: 3n, sessionId: null,
    requestId: `ocv5-289-inspect-${record.runNonce}`,
    upstreamModel: "claude-opus-5-5", requiredAccountId: 20n,
    signal: new AbortController().signal });
  try {
    if (target.accountId !== 20n) throw new Error("BOX_INSPECT_ACCOUNT_MISMATCH");
    const result = await target.exec.run({ command: "/usr/bin/python3",
      args: ["-I", "-c", READ, record.runNonce, ...assets], cwd: "/tmp",
      environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
    { timeoutMs: 20_000, maxResponseBytes: 4096 });
    const observed = JSON.parse(result.stdout) as Record<string, unknown>;
    let clearedLock = false;
    if (clearing) {
      if (process.env.OCV5_289_EXPECTED_RUN_NONCE !== record.runNonce
        || process.env.OCV5_289_EXPECTED_FIRST_ID !== record.firstId
        || process.env.OCV5_289_EXPECTED_PHASE !== "stage_transport_unknown"
        || (record.pid === undefined
          && process.env.OCV5_289_PROBE_PROCESS_EXITED_ACK !== "1")
        || record.state !== "unresolved"
        || (observed.run as { present?: unknown } | undefined)?.present !== false
        || (observed.proof as { present?: unknown } | undefined)?.present !== false) {
        throw new Error("BOX_INSPECT_PRESTART_NOT_PROVEN");
      }
      if (typeof record.pid === "number" && Number.isSafeInteger(record.pid)
        && record.pid > 0) {
        try { process.kill(record.pid, 0); throw new Error("BOX_INSPECT_PROBE_STILL_RUNNING"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      // The local stage catch ran before markRunning/launch; the exact remote
      // run and proof dirs are absent. Only now may this operator lock release.
      const latest = lstatSync(LOCK);
      if (latest.dev !== st.dev || latest.ino !== st.ino
        || readFileSync(LOCK, "utf8") !== rawLock) {
        throw new Error("BOX_INSPECT_LOCK_CHANGED");
      }
      unlinkSync(LOCK);
      syncDirectory();
      clearedLock = true;
    }
    process.stdout.write(JSON.stringify({ accountId: "20", runNonce: record.runNonce,
      observed, clearedLock }) + "\n");
  } finally { await target.dispose?.(); }
  } finally {
    if (mutexHeld) { unlinkSync(MUTEX); syncDirectory(); }
  }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_INSPECT_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
