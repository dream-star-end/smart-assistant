/** Execute already-built private staging steps in one bounded Box Exec. This
 * reduces network round trips; each inner stage keeps its existing path,
 * control-receipt, hash and no-clobber checks. Never batch a paid launch. */
import type { BoxCcExecRequest } from "@openclaude/gateway";

const PYTHON = "/usr/bin/python3";
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
// Base64 is passed as one argv element; leave headroom below Linux MAX_ARG_STRLEN.
const MAX_PAYLOAD_BYTES = 48 * 1024;
const RUN_BATCH = String.raw`import base64,json,os,subprocess,sys
if len(sys.argv)!=2:raise SystemExit(1)
raw=base64.b64decode(sys.argv[1],validate=True)
if len(raw)>49152:raise SystemExit(1)
steps=json.loads(raw)
if not isinstance(steps,list) or not 2<=len(steps)<=16:raise SystemExit(1)
for argv in steps:
 if not isinstance(argv,list) or len(argv)<3 or argv[:2]!=['-I','-c'] or not all(isinstance(x,str) for x in argv):raise SystemExit(1)
for argv in steps:
 try:
  subprocess.run(['/usr/bin/python3',*argv],cwd='/tmp',env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=True)
 except (subprocess.CalledProcessError,subprocess.TimeoutExpired):raise SystemExit(1)
print('staged:'+str(len(steps)))`;

export interface BoxStageBatch {
  readonly request: BoxCcExecRequest;
  readonly expected: string;
}

/** Null means the safe fallback is the original per-step sequence. */
export function makeBoxStageBatch(steps: readonly BoxCcExecRequest[]): BoxStageBatch | null {
  if (steps.length < 2 || steps.length > 16 || steps.some((step) =>
    step.command !== PYTHON || step.cwd !== "/tmp"
    || step.args[0] !== "-I" || step.args[1] !== "-c"
    || typeof step.args[2] !== "string" || step.args.length < 3
    || step.environment.PATH !== ENV.PATH || step.environment.LANG !== ENV.LANG
    || Object.keys(step.environment).length !== 2)) return null;
  const raw = Buffer.from(JSON.stringify(steps.map((step) => step.args)));
  if (raw.length > MAX_PAYLOAD_BYTES) return null;
  return { request: { command: PYTHON,
    args: ["-I", "-c", RUN_BATCH, raw.toString("base64")],
    cwd: "/tmp", environment: ENV }, expected: `staged:${steps.length}` };
}
