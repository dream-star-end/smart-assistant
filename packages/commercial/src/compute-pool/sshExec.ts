/**
 * sshExec — bootstrap 专用的一次性 SSH 执行封装(非 ControlMaster)。
 *
 * 语义跟 remoteHosts/sshMux 不同:
 *   - bootstrap 是一次性流程,跑完就释放,不长时间驻留
 *   - 密码走 sshpass -d <fd>(write + close,用完立即 .fill(0))
 *   - host key 采用 accept-new 策略,首次抓写 fingerprint 到 DB;之后 strict compare
 *
 * 单 call 上限 + 全局并发限制 + stderr 缓冲截断。每个 API 返回 {stdout, stderr}。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rootLogger } from "../logging/logger.js";

const log = rootLogger.child({ subsys: "compute-pool-ssh" });

/** 单次 ssh/scp 执行上限;bootstrap 中最长的 apt install 也不该超过 5 分钟。 */
export const SSH_CMD_TIMEOUT_MS = 5 * 60_000;
/** stderr 缓冲上限。 */
const STDERR_BUF_CAP = 64 * 1024;

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  /** 密码(明文 Buffer)— 函数内部只通过 pipe fd=3 注入 sshpass,之后由 caller 负责清零。 */
  password: Buffer;
  /** host 指纹(sha256:...);null 表示首次 bootstrap,允许 accept-new 并回填。 */
  knownHostsContent: string | null;
}

export interface SshExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 首次 bootstrap 时 accept-new 捕获的新 host key(ssh-keyscan 结果);strict 模式为 null。 */
  acceptedHostKey?: string | null;
}

export class SshExecError extends Error {
  readonly code = "SSH_EXEC_FAIL" as const;
  constructor(
    public readonly exitCode: number,
    public readonly stderrTail: string,
    message: string,
  ) {
    super(message);
    this.name = "SshExecError";
  }
}

// 全局并发(bootstrap 是 long-running,多个 host 同时 bootstrap 时控制)
let _inFlight = 0;
const MAX_CONCURRENT = 8;

async function acquire(): Promise<() => void> {
  while (_inFlight >= MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 100));
  }
  _inFlight++;
  return () => {
    _inFlight--;
  };
}

/**
 * 构建用于 ssh 的 known_hosts 文件内容。
 * - strict 模式:已有 knownHostsContent,写盘后 ssh -o StrictHostKeyChecking=yes
 * - accept-new:无 known_hosts,accept-new 策略,首次连接后从 ~/.ssh/known_hosts 读
 */
async function prepareKnownHosts(
  tmpDir: string,
  target: SshTarget,
): Promise<{ khPath: string; isNew: boolean }> {
  const khPath = path.join(tmpDir, "known_hosts");
  if (target.knownHostsContent) {
    await fs.writeFile(khPath, target.knownHostsContent, { mode: 0o600 });
    return { khPath, isNew: false };
  }
  // accept-new:先写空文件,让 ssh 首次抓
  await fs.writeFile(khPath, "", { mode: 0o600 });
  return { khPath, isNew: true };
}

/** 基础 ssh 选项(strict/accept-new)。 */
function sshOpts(khPath: string, strict: boolean): string[] {
  return [
    "-o", `UserKnownHostsFile=${khPath}`,
    "-o", `StrictHostKeyChecking=${strict ? "yes" : "accept-new"}`,
    "-o", "PasswordAuthentication=yes",
    "-o", "PubkeyAuthentication=no",
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=no",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
  ];
}

/** 用 sshpass -d 3 通过 fd=3 传入密码。调用方 fd 传入后立即 .fill(0) 原 buffer。 */
interface SpawnWithPasswordOpts {
  bin: "ssh" | "scp";
  args: string[];
  password: Buffer;
  input?: string; // stdin(可选)
  timeoutMs: number;
}

async function spawnWithPassword(
  opts: SpawnWithPasswordOpts,
): Promise<SshExecResult> {
  const release = await acquire();
  try {
    // sshpass -d 3 <bin> <args...>
    // fd3 由 Node 通过 child stdio[3] 传入,再从父进程 pipe 写密码
    const child = spawn(
      "sshpass",
      ["-d", "3", opts.bin, ...opts.args],
      {
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        detached: false,
      },
    );
    // 写密码到 fd=3,随后关闭,避免 ssh 等待更多输入
    const fd3 = child.stdio[3];
    if (!fd3 || !("write" in fd3)) {
      child.kill("SIGKILL");
      throw new Error("sshpass fd=3 not writable");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fd3 as NodeJS.WritableStream).write(opts.password);
    (fd3 as NodeJS.WritableStream).end();

    if (opts.input && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }

    const stdoutChunks: Buffer[] = [];
    let stderrTail = "";
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stderrTail = (stderrTail + s).slice(-STDERR_BUF_CAP);
    });

    const killer = setTimeout(() => {
      log.warn("ssh exec timeout, killing", { timeoutMs: opts.timeoutMs });
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, opts.timeoutMs);

    const code: number = await new Promise((resolve) => {
      child.on("close", (c) => resolve(c ?? -1));
      child.on("error", () => resolve(-1));
    });
    clearTimeout(killer);

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    return { code, stdout, stderr: stderrTail };
  } finally {
    release();
  }
}

/**
 * 在远程执行一条 bash 命令(通过 heredoc 传入,避免 shell quoting 噩梦)。
 * 返回 {code, stdout, stderr}。
 * 首次调用(knownHostsContent=null)时 acceptedHostKey 含抓到的第一条 host key。
 */
export async function sshRun(
  target: SshTarget,
  script: string,
  timeoutMs: number = SSH_CMD_TIMEOUT_MS,
): Promise<SshExecResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-ssh-"));
  try {
    const { khPath, isNew } = await prepareKnownHosts(tmpDir, target);
    // strict = !isNew
    const args = [
      ...sshOpts(khPath, !isNew),
      "-p", String(target.port),
      `${target.username}@${target.host}`,
      "bash", "-s", "--",
    ];
    const res = await spawnWithPassword({
      bin: "ssh",
      args,
      password: target.password,
      input: script,
      timeoutMs,
    });
    if (res.code !== 0) {
      throw new SshExecError(
        res.code,
        res.stderr.slice(-1000),
        `ssh failed on ${target.host}:${target.port}: exit=${res.code}`,
      );
    }
    // 首次抓到的 host key(accept-new 后 ssh 会把 line 写入 known_hosts)
    let acceptedHostKey: string | null = null;
    if (isNew) {
      try {
        const kh = await fs.readFile(khPath, "utf8");
        acceptedHostKey = kh.trim() || null;
      } catch {
        /* ignore */
      }
    }
    return { ...res, acceptedHostKey };
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 把本地 Buffer 上传为远程文件(通过 `ssh cat > path`)。
 * 避免 scp 的 known_hosts 复用成本 + 权限设置用远端 chmod。
 */
export async function sshUpload(
  target: SshTarget,
  remotePath: string,
  content: Buffer | string,
  mode: number = 0o600,
  timeoutMs: number = 60_000,
): Promise<void> {
  // 上传通过 base64 via stdin,保证任意字节安全
  const b64 = Buffer.isBuffer(content)
    ? content.toString("base64")
    : Buffer.from(content, "utf8").toString("base64");
  const modeStr = mode.toString(8);
  // tmp + rename + chmod 原子
  const remoteTmp = `${remotePath}.${randomUUID().slice(0, 8)}.tmp`;
  const script = `
set -e
mkdir -p "$(dirname ${shEscape(remotePath)})"
umask 077
base64 -d > ${shEscape(remoteTmp)} <<'__OC_B64__'
${b64}
__OC_B64__
chmod 0${modeStr} ${shEscape(remoteTmp)}
mv -f ${shEscape(remoteTmp)} ${shEscape(remotePath)}
`;
  await sshRun(target, script, timeoutMs);
}

/**
 * 从远端读取一个小文件(通过 ssh cat)。
 * 最多 sizeLimit 字节,超出视作错误。
 */
export async function sshDownload(
  target: SshTarget,
  remotePath: string,
  sizeLimit: number = 64 * 1024,
  timeoutMs: number = 30_000,
): Promise<Buffer> {
  const script = `
set -e
if [ ! -f ${shEscape(remotePath)} ]; then
  echo "NOT_FOUND" >&2
  exit 1
fi
sz=$(stat -c %s ${shEscape(remotePath)})
if [ "$sz" -gt ${sizeLimit} ]; then
  echo "TOO_LARGE $sz" >&2
  exit 1
fi
base64 ${shEscape(remotePath)}
`;
  const res = await sshRun(target, script, timeoutMs);
  return Buffer.from(res.stdout.replace(/\s+/g, ""), "base64");
}

/** 简化 shell 单引号转义。只用于已白名单的路径字符串,不处理任意用户输入。 */
export function shEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
