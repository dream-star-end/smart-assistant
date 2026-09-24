/** Reconstruct only read access to an already admitted detached Box run.
 * A resumed HTTP request must not rebuild the original prompt or launch CLI. */
import type { BoxExecTransport } from "./boxExecTransport.js";

type BoxCcExecRequest = Parameters<BoxExecTransport["run"]>[0];

const PYTHON = "/usr/bin/python3";
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
// Verify and execute the very same fd bytes. A path-only precheck followed by
// `python runnerPath` would allow replacement between validation and import.
const PINNED_RUNNER = String.raw`import hashlib,os,stat,sys
p,want,*argv=sys.argv[1:]
try:fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
except OSError:raise SystemExit(126)
try:
 st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or not 1<=st.st_size<=32768:raise SystemExit(126)
 with os.fdopen(fd,'rb',closefd=False) as src:raw=src.read(32769)
 if len(raw)!=st.st_size or hashlib.sha256(raw).hexdigest()!=want:raise SystemExit(126)
finally:os.close(fd)
sys.argv=[p,*argv]
scope={'__name__':'__main__','__file__':p}
exec(compile(raw,p,'exec'),scope,scope)`;

export class BoxDetachedRunAccessError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxDetachedRunAccessError"; }
}

export interface BoxDetachedRunAccess {
  readonly cwd: string;
  readonly runnerPath: string;
  readSpool(offset: number, limit?: number): BoxCcExecRequest;
}

export function makeBoxPinnedRunnerRequest(input: {
  runnerPath: string;
  detachedRunnerHash: string;
  args: readonly string[];
  cwd: string;
  environment: Record<string, string>;
}): BoxCcExecRequest {
  if (!/^\/tmp\/ocv5-289-detached-runner-[a-f0-9]{16}\.py$/.test(input.runnerPath)
    || !/^[a-f0-9]{64}$/.test(input.detachedRunnerHash)
    || !input.runnerPath.endsWith(`${input.detachedRunnerHash.slice(0, 16)}.py`)) {
    throw new BoxDetachedRunAccessError("BOX_DETACHED_RUN_IDENTITY_INVALID");
  }
  return { command: PYTHON, args: ["-c", PINNED_RUNNER, input.runnerPath,
    input.detachedRunnerHash, ...input.args], cwd: input.cwd,
    environment: input.environment };
}

export function makeBoxDetachedRunAccess(input: {
  runNonce: string;
  detachedRunnerHash: string;
}): BoxDetachedRunAccess {
  if (!/^[a-f0-9]{24}$/.test(input.runNonce)
    || !/^[a-f0-9]{64}$/.test(input.detachedRunnerHash)) {
    throw new BoxDetachedRunAccessError("BOX_DETACHED_RUN_IDENTITY_INVALID");
  }
  const cwd = `/tmp/ocv5-289-run-${input.runNonce}`;
  const runnerPath = `/tmp/ocv5-289-detached-runner-${input.detachedRunnerHash.slice(0, 16)}.py`;
  return { cwd, runnerPath, readSpool: (offset: number, limit = 65536) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 8 * 1024 * 1024
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536) {
      throw new BoxDetachedRunAccessError("BOX_SPOOL_READ_INVALID");
    }
    return makeBoxPinnedRunnerRequest({ runnerPath,
      detachedRunnerHash: input.detachedRunnerHash,
      args: ["--read", cwd, String(offset), String(limit)],
      cwd: "/tmp", environment: ENV });
  } };
}
