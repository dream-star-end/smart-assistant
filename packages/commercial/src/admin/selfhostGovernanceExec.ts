/**
 * OCV5-914 — Host subprocess & systemd execution helpers for Selfhost Governance (L3 admin-ops).
 *
 * Uses `execFile` arg arrays only (zero shell interpolation), avoids `--collect` on transient
 * deploy units, wraps deploy execution to persist durable `completed`/`failed` terminal outcomes
 * back via `oc-governor update-approval-resume` BEFORE unit exit, and parses `systemctl show`
 * by property name (checking `LoadState`) so collected/unreported units NEVER become `completed`.
 */
import { execFile as execFileCb } from "node:child_process";
import { lstat } from "node:fs/promises";
import type {
  CheckDeployBusyFn,
  ExecFileFn,
  ExecFileOptions,
  ExecFileResult,
  ProbeUnitStatusFn,
  ReadRepoHeadShaFn,
  SpawnDetachedDeployFn,
} from "./selfhostGovernanceTypes.js";

const SHA40_RE = /^[0-9a-f]{40}$/;
const SAFE_UNIT_RE = /^[a-zA-Z0-9._@-]{1,128}$/;

export const RESUME_WRAPPER_SCRIPT =
  'rc=0; "$1" "${@:7}" || rc=$?; ' +
  'if [ "$rc" -eq 0 ]; then st=completed; d="发版单元执行成功 (exit=0, sha=${5:0:12})"; ' +
  'else st=failed; d="发版单元执行失败 (exit=${rc}, sha=${5:0:12})"; fi; ' +
  'OC_GOVERNOR_ROOT="$3" "$2" update-approval-resume --id "$4" --status "$st" --expected-unit "$6" --unit "$6" --detail "$d" >/dev/null 2>&1 || true; exit "$rc"';

function isErrnoEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

export function defaultExecFile(file: string, args: readonly string[], options: ExecFileOptions): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFileCb(
      file,
      [...args],
      { timeout: options.timeout, env: options.env, cwd: options.cwd, maxBuffer: options.maxBuffer ?? 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || stdout || err.message).trim() || err.message));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

export function createDefaultCheckDeployBusy(execFn: ExecFileFn, timeout: number, env: Readonly<Record<string, string>>): CheckDeployBusyFn {
  return async (lockPath: string) => {
    try {
      const st = await lstat(lockPath);
      if (st.isSymbolicLink() || !st.isFile()) return { busy: true, detail: "发版锁文件异常（非普通文件），未自动发车" };
    } catch (err) {
      if (isErrnoEnoent(err)) return { busy: false };
      return { busy: true, detail: "无法检测发版锁状态，保守未自动发车" };
    }
    try {
      await execFn("flock", ["-n", lockPath, "true"], { timeout: Math.min(timeout, 5_000), env });
      return { busy: false };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "lock held";
      return { busy: true, detail: `发版锁正忙，凭证已签发但未自动发车（${detail.slice(0, 80)}）` };
    }
  };
}

export function createDefaultReadRepoHeadSha(execFn: ExecFileFn, timeout: number, env: Readonly<Record<string, string>>): ReadRepoHeadShaFn {
  return async (repoRoot: string) => {
    try {
      const out = await execFn("git", ["-C", repoRoot, "rev-parse", "HEAD"], { timeout: Math.min(timeout, 5_000), env });
      const sha = out.stdout.trim();
      return SHA40_RE.test(sha) ? sha : null;
    } catch (err) {
      void err;
      return null;
    }
  };
}

function parseSystemctlProps(stdout: string): ReadonlyMap<string, string> {
  const props = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0) props.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return props;
}

const ACTIVE_SYSTEMD_STATES: ReadonlySet<string> = new Set(["active", "activating", "reloading"]);

function classifySystemctlProps(props: ReadonlyMap<string, string>): { status: "running" | "failed" | "unknown"; detail?: string } {
  const load = props.get("LoadState") ?? "";
  const active = props.get("ActiveState") ?? "";
  const sub = props.get("SubState") ?? "";
  const result = props.get("Result") ?? "";
  if (load === "not-found") {
    return { status: "failed", detail: "发版单元已退出但未回写完成终态 (LoadState=not-found)，可安全重试" };
  }
  if (load !== "loaded") return { status: "unknown" };
  if (ACTIVE_SYSTEMD_STATES.has(active)) {
    return { status: "running", detail: `发版单元运行中 (${active}/${sub || "running"})` };
  }
  if (active === "failed" || (active === "inactive" && result !== "" && result !== "success")) {
    return { status: "failed", detail: `发版单元执行失败 (ActiveState=${active}, Result=${result || "unknown"})` };
  }
  if (active === "inactive") {
    return { status: "failed", detail: "发版单元已退出但未回写完成终态 (LoadState=loaded, ActiveState=inactive)，可安全重试" };
  }
  return { status: "unknown" };
}

export function createDefaultProbeUnitStatus(execFn: ExecFileFn, systemctlBin: string, env: Readonly<Record<string, string>>): ProbeUnitStatusFn {
  return async (unitName: string) => {
    if (!SAFE_UNIT_RE.test(unitName)) return { status: "unknown" };
    const unit = unitName.endsWith(".service") ? unitName : `${unitName}.service`;
    try {
      const out = await execFn(systemctlBin, ["show", "-p", "LoadState,ActiveState,SubState,Result", unit], { timeout: 2_000, env });
      return classifySystemctlProps(parseSystemctlProps(out.stdout));
    } catch (err) {
      void err;
      return { status: "unknown" };
    }
  };
}

export function createDefaultSpawnDetachedDeploy(
  execFn: ExecFileFn,
  systemdRunBin: string,
  timeout: number,
  baseEnv: Readonly<Record<string, string>>,
): SpawnDetachedDeployFn {
  return async (input) => {
    const useWrapper = Boolean(input.approvalId && input.governorBin && input.governorRoot && input.targetSha);
    const execCmd = useWrapper
      ? [
          "/bin/bash", "-c", RESUME_WRAPPER_SCRIPT, "oc-gov-resume",
          input.deployScriptPath, input.governorBin!, input.governorRoot!,
          input.approvalId!, input.targetSha!, input.unitName, ...input.args,
        ]
      : [input.deployScriptPath, ...input.args];
    const args: string[] = [
      "--unit", input.unitName, "--no-block",
      "--description", `OpenClaude selfhost governance resume ${input.unitName}`,
      ...Object.entries(input.env).map(([k, v]) => `--setenv=${k}=${v}`),
      ...(input.cwd ? [`--working-directory=${input.cwd}`] : []),
      "--", ...execCmd,
    ];
    await execFn(systemdRunBin, args, { timeout, env: baseEnv, cwd: input.cwd });
    return { started: true, unitName: input.unitName, detail: `已通过 systemd-run 拉起脱离发版单元 ${input.unitName}` };
  };
}
