/** Reconstruct only read access to an already admitted detached Box run.
 * A resumed HTTP request must not rebuild the original prompt or launch CLI. */
import type { BoxExecTransport } from "./boxExecTransport.js";

type BoxCcExecRequest = Parameters<BoxExecTransport["run"]>[0];

const PYTHON = "/usr/bin/python3";
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };

export class BoxDetachedRunAccessError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxDetachedRunAccessError"; }
}

export interface BoxDetachedRunAccess {
  readonly cwd: string;
  readonly runnerPath: string;
  readSpool(offset: number, limit?: number): BoxCcExecRequest;
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
    return { command: PYTHON, args: [runnerPath, "--read", cwd,
      String(offset), String(limit)], cwd: "/tmp", environment: ENV };
  } };
}
