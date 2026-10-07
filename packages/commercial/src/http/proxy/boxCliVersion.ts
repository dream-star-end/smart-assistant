/** OCV5-313: a new launch reads the Claude Code build on the Box first. Any
 * version that reads is admitted and may use native resume. A transcript
 * written by another build is still a cache miss. A version that cannot be
 * read is refused before admission (no slot, no launch, no bill). */
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { BoxResolvedTarget } from "./boxTextFetch.js";

const CLI_VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;

/** True for any build the version read actually parsed. There is no allowlist. */
export function boxCliNativeResumeVerified(version: string | undefined): boolean {
  return version !== undefined && CLI_VERSION.test(version);
}

export class BoxCliVersionError extends Error {
  constructor(readonly code: "BOX_CLI_VERSION_UNREADABLE",
    /** Content-free: `unreadable`. */
    readonly observed: string) {
    super(code); this.name = "BoxCliVersionError";
  }
}

// The native installer keeps each build at versions/<x.y.z> and points the
// launcher at it; this is the file the launch plan executes.
const READ = String.raw`import os,re,stat,sys
p=os.path.realpath('/home/box/.local/bin/claude')
m=re.fullmatch(r'/home/box/\.local/share/claude/versions/([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})',p)
if not m:raise SystemExit(3)
st=os.stat(p)
if not stat.S_ISREG(st.st_mode) or not st.st_mode&0o111:raise SystemExit(3)
sys.stdout.write(m.group(1)+'\n')`;

export function makeBoxCliVersionRead(): BoxCcExecRequest {
  return { command: "/usr/bin/python3", args: ["-I", "-c", READ], cwd: "/tmp",
    environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}

export function parseBoxCliVersion(stdout: string): string | null {
  const match = /^([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})\n$/.exec(stdout);
  return match ? match[1]! : null;
}

export class BoxCliVersionGate {
  private readonly seen = new Map<string, { version: string; atMs: number }>();
  constructor(private readonly opts: {
    /** A readable result is trusted this long per account. The Box has
     * auto-update off, so a build only changes with a new installation. */
    ttlMs?: number; now?: () => number; timeoutMs?: number;
    onRejected?: (info: { accountId: string; code: string; observed: string }) => void;
  } = {}) {}

  /** The version installed on this Box, or BoxCliVersionError when unreadable. */
  async read(target: Pick<BoxResolvedTarget, "accountId" | "exec">,
    signal?: AbortSignal): Promise<string> {
    const key = target.accountId.toString();
    const now = (this.opts.now ?? Date.now)();
    const cached = this.seen.get(key);
    if (cached && now - cached.atMs < (this.opts.ttlMs ?? 300_000)) return cached.version;
    this.seen.delete(key);
    let version: string | null = null;
    try {
      // 1024 is the exec transport's smallest response budget; a lower value
      // is refused before the request leaves. parseBoxCliVersion still accepts
      // one exact version line only.
      const result = await target.exec.run(makeBoxCliVersionRead(), {
        timeoutMs: this.opts.timeoutMs ?? 10_000, maxResponseBytes: 1024,
        ...(signal ? { signal } : {}) });
      version = parseBoxCliVersion(result.stdout);
    } catch { version = null; }
    if (version === null) {
      const error = new BoxCliVersionError("BOX_CLI_VERSION_UNREADABLE", "unreadable");
      this.opts.onRejected?.({ accountId: key, code: error.code, observed: error.observed });
      throw error;
    }
    this.seen.set(key, { version, atMs: now });
    return version;
  }
}

/** Wrap the resolver the model launch paths use. A call that picks an account
 * for a new launch (no requiredAccountId) must read a CLI version or it
 * fails before anything is admitted. A pinned call (continuation publish,
 * cleanup, stop) is only annotated and never fails here: its run exists. */
export function gateBoxLaunchResolver<A extends { requiredAccountId?: bigint;
  signal?: AbortSignal }>(resolve: (args: A) => Promise<BoxResolvedTarget>,
  gate: Pick<BoxCliVersionGate, "read">): (args: A) => Promise<BoxResolvedTarget> {
  return async (args) => {
    const target = await resolve(args);
    if (args.requiredAccountId !== undefined) {
      try { target.cliVersion = await gate.read(target, args.signal); }
      catch { /* unreadable version: no native pointer is recorded or claimed */ }
      return target;
    }
    try { target.cliVersion = await gate.read(target, args.signal); }
    catch (error) {
      // Nothing was admitted or launched on this target.
      const closing = Promise.resolve().then(() => target.dispose?.()).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closing, new Promise<void>((done) => {
        timer = setTimeout(done, 200);
      })]); }
      finally { if (timer) clearTimeout(timer); }
      throw error;
    }
    return target;
  };
}
