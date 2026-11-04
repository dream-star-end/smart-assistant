/** Failure collection before privacy cleanup. Never changes journal state. */
import { dirname, join } from "node:path";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { BoxRemoteCleanupCandidate } from "./boxDurableJournal.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import { rootLogger } from "../../logging/logger.js";
import { boxReplayDirectory } from "../../egress/boxReplaySetup.js";
import { BoxFailureDiagnosticStore } from "./boxFailureDiagnosticStore.js";
import { DIAGNOSTIC_TTL_MS, diagnosticId, parseDiagnosticSnapshot, parseRemoteDiagnostic,
  type BoxFailureDiagnosticIdentity, type DiagnosticSnapshot, type DiagnosticStatus } from "./boxFailureDiagnosticSchema.js";
export { parseRemoteDiagnostic, type BoxFailureDiagnosticIdentity } from "./boxFailureDiagnosticSchema.js";
const log = rootLogger.child({ subsys: "box-failure-diagnostic" });

const READ = String.raw`import json,os,re,stat,sys
nonce=sys.argv[1]
if not re.fullmatch(r'[a-f0-9]{24}',nonce):raise SystemExit(1)
d=f=None
try:
 d=os.open('/tmp/ocv5-289-proof-'+nonce,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 s=os.fstat(d)
 if s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o700:raise ValueError()
 f=os.open('failure.diag.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
 s=os.fstat(f)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1 or not 1<=s.st_size<=8192:raise ValueError()
 b=os.read(f,8193)
 if len(b)!=s.st_size:raise ValueError()
 v=json.loads(b)
 print(json.dumps({'status':'ok','diagnostic':v},separators=(',',':')))
except FileNotFoundError:print('{"status":"missing"}')
except (OSError,ValueError,UnicodeError):print('{"status":"invalid"}')
finally:
 if f is not None:os.close(f)
 if d is not None:os.close(d)`;
export function makeBoxFailureDiagnosticRead(runNonce: string): BoxCcExecRequest {
  if (!/^[a-f0-9]{24}$/.test(runNonce)) throw new Error("BOX_DIAGNOSTIC_IDENTITY_INVALID");
  return { command: "/usr/bin/python3", args: ["-I", "-c", READ, runNonce],
    cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}
export type BoxBeforeCleanup = (candidate: BoxRemoteCleanupCandidate,
  target: Pick<BoxResolvedTarget, "exec">, signal: AbortSignal) => Promise<void>;

/** Every destructive cleanup caller uses this independent deadline; diagnostic
 * outages must never hold a slot or retain private run contents indefinitely. */
export async function beforeBoxPrivacyCleanup(hook: BoxBeforeCleanup | undefined,
  candidate: BoxRemoteCleanupCandidate, target: Pick<BoxResolvedTarget, "exec">,
  timeoutMs = 6000): Promise<void> {
  if (candidate.proof.reason === "worker_complete") return;
  let id: string;
  try { id = diagnosticId(candidate); }
  catch {
    log.warn("box_failure_diagnostic_unavailable", { status: "invalid_identity" });
    return;
  }
  if (!hook) {
    log.warn("box_failure_diagnostic_unavailable", { diagnosticId: id, requestId: candidate.requestId,
      status: "disabled", terminalReason: candidate.proof.reason });
    return;
  }
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(() => hook(candidate, target, abort.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        abort.abort(); reject(new Error("BOX_DIAGNOSTIC_DEADLINE"));
      }, timeoutMs); })]);
  } catch {
    log.warn("box_failure_diagnostic_unavailable", { diagnosticId: id, requestId: candidate.requestId,
      status: abort.signal.aborted ? "timeout" : "persist_failed", terminalReason: candidate.proof.reason });
  } finally { if (timer) clearTimeout(timer); abort.abort(); }
}

export class BoxFailureDiagnostics {
  readonly store: BoxFailureDiagnosticStore;
  private sweeping: Promise<number> | null = null;
  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.store = new BoxFailureDiagnosticStore(directory, now);
  }
  readonly beforeCleanup: BoxBeforeCleanup = async (candidate, target, signal) => {
    if (candidate.proof.reason === "worker_complete") return;
    const id = diagnosticId(candidate);
    if ((await this.store.read(id))?.status === "ok") return;
    signal.throwIfAborted();
    let status: DiagnosticStatus = "read_failed";
    let remote: DiagnosticSnapshot["remote"] = null;
    try {
      const result = await target.exec.run(makeBoxFailureDiagnosticRead(candidate.runNonce), {
        timeoutMs: 2500, maxResponseBytes: 16384, signal });
      signal.throwIfAborted();
      const data = JSON.parse(result.stdout) as { status?: unknown; diagnostic?: unknown };
      const fields = Object.keys(data).sort().join(",");
      if (data.status === "ok" && fields === "diagnostic,status") {
        remote = parseRemoteDiagnostic(data.diagnostic, candidate);
        status = remote ? "ok" : "invalid";
      } else if (fields === "status" && (data.status === "missing" || data.status === "invalid")) status = data.status;
      else status = "invalid";
    } catch (error) {
      if (signal.aborted) throw error;
      // Exception text may contain credentials; never stringify/log it.
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      status = error instanceof SyntaxError ? "invalid"
        : code === "BOX_EXEC_TIMEOUT" ? "timeout" : "read_failed";
    }
    const observedAtMs = this.now();
    const safe = parseDiagnosticSnapshot({ version: 1, id, observedAtMs,
      expiresAtMs: observedAtMs + DIAGNOSTIC_TTL_MS,
      identity: { uid: String(candidate.uid), accountId: String(candidate.accountId),
        requestId: candidate.requestId, runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch },
      terminal: candidate.proof, status, remote });
    if (!safe) throw new Error("BOX_DIAGNOSTIC_SNAPSHOT_INVALID");
    signal.throwIfAborted();
    await this.store.write(safe, signal);
    log.info("box_failure_diagnostic_saved", { diagnosticId: id, requestId: candidate.requestId,
      status, terminalReason: candidate.proof.reason,
      ...(candidate.proof.reason === "worker_failed" ? { workerExitCode: candidate.proof.workerExitCode } : {}) });
  };
  async findId(identity: BoxFailureDiagnosticIdentity): Promise<string | null> {
    try { const id = diagnosticId(identity); return await this.store.read(id) ? id : null; }
    catch { return null; }
  }
  /** Existing cleanup schedulers call even when there are no failed runs. */
  sweep(): Promise<number> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.store.sweep().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }
}
export function createBoxFailureDiagnostics(platformRoot: string | undefined): BoxFailureDiagnostics | undefined {
  const replay = boxReplayDirectory(platformRoot);
  return replay ? new BoxFailureDiagnostics(join(dirname(replay), "box-failure-diagnostics")) : undefined;
}
