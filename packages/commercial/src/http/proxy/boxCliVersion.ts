/** OCV5-313: the Claude Code build on a Box is part of the contract. The Box
 * of account 25 ran 2.1.288 while everything here was verified on 2.1.280; the
 * newer CLI echoes an MCP image with an extra block and the turn failed after
 * it was billed. A new launch now reads the installed version first and is
 * refused before admission (no slot, no launch, no bill) unless that version
 * is listed here. Add a version only after its probes pass. */
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { BoxResolvedTarget } from "./boxTextFetch.js";

/** nativeResume: `--resume` of a transcript this CLI wrote is verified. Where
 * it is not, no native pointer is recorded or claimed and every turn stages
 * the synthetic history instead. */
export const BOX_CLI_VERSIONS: Readonly<Record<string, { readonly nativeResume: boolean }>> = {
  "2.1.280": { nativeResume: true },
  "2.1.288": { nativeResume: false },
};

export function boxCliNativeResumeVerified(version: string | undefined): boolean {
  return version !== undefined && Object.hasOwn(BOX_CLI_VERSIONS, version)
    && BOX_CLI_VERSIONS[version]!.nativeResume;
}

export class BoxCliVersionError extends Error {
  constructor(readonly code: "BOX_CLI_VERSION_UNSUPPORTED" | "BOX_CLI_VERSION_UNREADABLE",
    /** Content-free: a version number or `unreadable`. */
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
    /** A supported result is trusted this long per account. The Box has
     * auto-update off, so a build only changes with a new installation. */
    ttlMs?: number; now?: () => number; timeoutMs?: number;
    onRejected?: (info: { accountId: string; code: string; observed: string }) => void;
  } = {}) {}

  /** The supported version installed on this Box, or BoxCliVersionError. */
  async read(target: Pick<BoxResolvedTarget, "accountId" | "exec">,
    signal?: AbortSignal): Promise<string> {
    const key = target.accountId.toString();
    const now = (this.opts.now ?? Date.now)();
    const cached = this.seen.get(key);
    if (cached && now - cached.atMs < (this.opts.ttlMs ?? 300_000)) return cached.version;
    this.seen.delete(key);
    let version: string | null = null;
    try {
      const result = await target.exec.run(makeBoxCliVersionRead(), {
        timeoutMs: this.opts.timeoutMs ?? 10_000, maxResponseBytes: 64,
        ...(signal ? { signal } : {}) });
      version = parseBoxCliVersion(result.stdout);
    } catch { version = null; }
    if (version === null || !Object.hasOwn(BOX_CLI_VERSIONS, version)) {
      const error = version === null
        ? new BoxCliVersionError("BOX_CLI_VERSION_UNREADABLE", "unreadable")
        : new BoxCliVersionError("BOX_CLI_VERSION_UNSUPPORTED", version);
      this.opts.onRejected?.({ accountId: key, code: error.code, observed: error.observed });
      throw error;
    }
    this.seen.set(key, { version, atMs: now });
    return version;
  }
}

/** Wrap the resolver the model launch paths use. A call that picks an account
 * for a new launch (no requiredAccountId) must find a supported CLI or it
 * fails before anything is admitted. A pinned call (continuation publish,
 * cleanup, stop) is only annotated and never fails here: its run exists. */
export function gateBoxLaunchResolver<A extends { requiredAccountId?: bigint;
  signal?: AbortSignal }>(resolve: (args: A) => Promise<BoxResolvedTarget>,
  gate: Pick<BoxCliVersionGate, "read">): (args: A) => Promise<BoxResolvedTarget> {
  return async (args) => {
    const target = await resolve(args);
    if (args.requiredAccountId !== undefined) {
      try { target.cliVersion = await gate.read(target, args.signal); }
      catch { /* unknown version: no native pointer is recorded or claimed */ }
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
