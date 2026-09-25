/** Read-only, pinned-account recovery evidence. A marker proves remote stop,
 * not successful delivery, billable usage or settlement. Missing evidence is
 * unknown; callers must never restart an ambiguous paid invocation. */
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { BoxExecTransport } from "./boxExecTransport.js";

const READ_PROOF = String.raw`import os,re,stat,sys
path=sys.argv[1]
if not re.fullmatch(r'/tmp/ocv5-289-proof-[0-9a-f]{24}',path):raise SystemExit(1)
directory=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 st=os.fstat(directory)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(1)
 fd=os.open('terminal.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or not 1<=st.st_size<=512:raise SystemExit(1)
  raw=os.read(fd,513)
  if len(raw)!=st.st_size or not raw.endswith(b'\n'):raise SystemExit(1)
  os.write(1,raw)
 finally:os.close(fd)
finally:os.close(directory)`;

interface BoxTerminalIdentity {
  runNonce: string;
  leaseEpoch: string;
  keeperPid: number;
  cliPid: number;
}
export type BoxTerminalProof = BoxTerminalIdentity & (
  { reason: "worker_complete" | "keeper_stopped"; revision: 1 }
  | { reason: "worker_failed"; revision: 2; workerExitCode: number }
);

export function makeBoxTerminalRead(proofDir: string): BoxCcExecRequest {
  if (!/^\/tmp\/ocv5-289-proof-[0-9a-f]{24}$/.test(proofDir)) {
    throw new Error("BOX_TERMINAL_PATH_INVALID");
  }
  return { command: "/usr/bin/python3", args: ["-I", "-c", READ_PROOF, proofDir],
    cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}

export function parseBoxTerminalProof(raw: string, expected: {
  runNonce: string; leaseEpoch: string;
}): BoxTerminalProof {
  if (Buffer.byteLength(raw, "utf8") > 512 || !raw.endsWith("\n")) {
    throw new Error("BOX_TERMINAL_PROOF_INVALID");
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error("BOX_TERMINAL_PROOF_INVALID"); }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("BOX_TERMINAL_PROOF_INVALID");
  }
  const proof = data as Record<string, unknown>;
  const keys = Object.keys(proof).sort().join(",");
  const successShape = keys === "cliPid,keeperPid,leaseEpoch,reason,revision,runNonce"
    && (proof.reason === "worker_complete" || proof.reason === "keeper_stopped")
    && proof.revision === 1;
  const failureShape = keys === "cliPid,keeperPid,leaseEpoch,reason,revision,runNonce,workerExitCode"
    && proof.reason === "worker_failed" && proof.revision === 2
    && Number.isSafeInteger(proof.workerExitCode)
    && Number(proof.workerExitCode) !== 0
    && Number(proof.workerExitCode) >= -255 && Number(proof.workerExitCode) <= 255;
  if ((!successShape && !failureShape)
    || proof.runNonce !== expected.runNonce || proof.leaseEpoch !== expected.leaseEpoch
    || !Number.isSafeInteger(proof.keeperPid) || (proof.keeperPid as number) < 1
    || !Number.isSafeInteger(proof.cliPid) || (proof.cliPid as number) < 1
  ) {
    throw new Error("BOX_TERMINAL_PROOF_INVALID");
  }
  return proof as unknown as BoxTerminalProof;
}

/** May be called in a later HTTP request after resolving the pinned account.
 * A read failure is unknown, not permission to replay a paid invocation. */
export async function readBoxTerminalProof(input: {
  target: { accountId: bigint; exec: Pick<BoxExecTransport, "run"> };
  expectedAccountId: bigint;
  runNonce: string;
  leaseEpoch: string;
  signal?: AbortSignal;
}): Promise<BoxTerminalProof> {
  if (input.target.accountId !== input.expectedAccountId
    || !/^[0-9a-f]{24}$/.test(input.runNonce)
    || !/^[0-9a-f]{32}$/.test(input.leaseEpoch)) {
    throw new Error("BOX_TERMINAL_IDENTITY_INVALID");
  }
  const proofDir = `/tmp/ocv5-289-proof-${input.runNonce}`;
  const result = await input.target.exec.run(makeBoxTerminalRead(proofDir), {
    timeoutMs: 10_000, maxResponseBytes: 1024, signal: input.signal,
  });
  return parseBoxTerminalProof(result.stdout, input);
}
