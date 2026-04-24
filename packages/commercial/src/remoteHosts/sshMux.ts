/**
 * sshMux.ts — 远程执行机 SSH ControlMaster 生命周期管理。
 *
 * 职责:
 *   - 每个 (userId, hostId) 维护一条 `ssh -MN` ControlMaster 连接;refcount=sessionIds.size
 *   - /run/ccb-ssh/u<uid>/h<hid>/{known_hosts, ctl.sock} 目录物化(tmpfs,systemd
 *     RuntimeDirectory 保证权限 0700)
 *   - known_hosts 文件始终从 DB `host_keys_text` rebuild(tmp+rename 原子覆盖,
 *     per-host async mutex);冷启动缓存丢失后不影响信任锚
 *   - sshpass -d 3 密码注入;写完立即 .fill(0),绝不进 argv/env
 *   - 暴露 `makeRemoteHostTester()`:Test 按钮的实际探测逻辑(keyscan + authprobe)
 *   - 进程组 SIGTERM → SIGKILL 清理(sshpass 是 pg leader,ssh 子进程随之终止)
 *
 * 不做:
 *   - 任何 DB 写(fingerprint / host_keys_text 回填由 service.testHostForUser 在
 *     拿到 tester 结果后统一完成;本模块只返回 captured 值)
 *   - AEAD / 权限校验 / session 管理(都在上游)
 *
 * 前置条件:
 *   - 宿主 PATH 存在 ssh / sshpass / ssh-keyscan / ssh-keygen。任一缺失
 *     → makeRemoteHostTester 返回 undefined;handler 层回 503 TESTER_NOT_CONFIGURED
 *   - /run/ccb-ssh 由 systemd RuntimeDirectory=ccb-ssh RuntimeDirectoryMode=0700
 *     托管;若不可写同样 fail-closed
 *
 * 单 gateway 假设:registry + mutex 都是进程本地。水平扩展需改为 Redis 锁,
 * 当前 out of scope。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { statSync, mkdirSync, accessSync, constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import { rootLogger } from "../logging/logger.js";
import { V3_AGENT_GID } from "../agent-sandbox/constants.js";
import {
  loadDecryptedCredential,
  RemoteHostError,
  type RemoteHostTester,
  type RemoteHostTestResult,
} from "./service.js";
import type { DecryptedCredential } from "./types.js";
import type { NodeAgentTarget } from "../compute-pool/nodeAgentClient.js";

const log = rootLogger.child({ subsys: "remote-ssh" });

// ─── 常量 ─────────────────────────────────────────────────────────────────

const RUN_ROOT = "/run/ccb-ssh";

/** ControlMaster "就绪"轮询上限 —— 5s 内 `-O check` 不通就判定失败。 */
const MUX_READY_TIMEOUT_MS = 5_000;
const MUX_READY_POLL_INTERVAL_MS = 500;

/** 单次 `-O check` 辅助子进程的最大存活时间。防止 helper 本身泄漏。 */
const OCHECK_ATTEMPT_TIMEOUT_MS = 2_000;

/** Test 按钮 authprobe 总超时(含密码交互)。 */
const AUTH_PROBE_TIMEOUT_MS = 15_000;

/** ssh-keyscan 超时 —— 本身 -T 10 后再留 5s 兜底。 */
const KEYSCAN_TIMEOUT_MS = 15_000;

/** ssh-keygen -lf - 超时。本地纯计算,5s 足够。 */
const KEYGEN_TIMEOUT_MS = 5_000;

/** kill -TERM 后等待自然退出的宽限期,超时再 -KILL。 */
const KILL_GRACE_MS = 3_000;

/** stderr 缓冲上限,防恶意 server 狂喷日志。 */
const STDERR_BUF_CAP = 64 * 1024;

// ─── 内部状态 ─────────────────────────────────────────────────────────────

type MuxKey = `${string}:${string}`;
function muxKey(userId: string, hostId: string): MuxKey {
  return `${userId}:${hostId}`;
}

/**
 * 容器执行位置。self = 容器跑在 gateway 所在宿主(单机 MVP 语义);
 * remote = 容器跑在某台 compute host 上,ssh ControlMaster 必须也搬到同一台,
 * 靠 node-agent RPC 代管。
 *
 * C.1 注入:`setRemoteMuxDeps({resolvePlacement, startSshControlMaster,
 * stopSshControlMaster})`。未注入时 acquireMux 仅支持 self。
 */
export type Placement =
  | { kind: "self" }
  | { kind: "remote"; target: NodeAgentTarget };

interface MuxEntry {
  /** self 分支:本机 sshpass/ssh 进程。remote 分支:null(节点侧进程由 node-agent 托管)。 */
  child: ChildProcess | null;
  /** 容器可见(host-side 绝对)路径;gateway subprocessRunner 剥 /u<uid> 后注入容器 env。 */
  controlPath: string;
  knownHostsPath: string;
  placement: Placement;
  /** 唯一 refcount 真源;size===0 触发 kill。 */
  sessionIds: Set<string>;
  meta: {
    userId: string;
    hostId: string;
    username: string;
    host: string;
    port: number;
    remoteWorkdir: string;
  };
}

const muxRegistry = new Map<MuxKey, MuxEntry>();

// ─── 跨机依赖注入(C.1) ─────────────────────────────────────────────
// sshMux 不 import DB / node-agent RPC 本体,保持可独立单测。commercial 侧
// bootstrap 通过 setRemoteMuxDeps 注入 remote-aware 实现。
//
// 默认行为(模块加载时):resolvePlacement 恒返 {kind:'self'},其他 RPC fn 抛
// "not configured"。personal 单机版 + commercial 未启用 compute pool 的场景
// 保持 C.1 前一字节行为 —— acquireMux 始终走本地分支。
//
// 注入后合约:
//   - resolvePlacement(userId, hostId) → {kind:'self'} / {kind:'remote', target}
//   - userId 无 active 容器行 → 抛 RemoteHostError("NO_CONTAINER") 让 caller 重试
//     (必须明确抛,不能默认 self;误默认会把远端容器的 mux 起在 gateway 本机)
//   - (userId, hostId) 不是用户拥有 → 抛(不归本模块判)
//   - 查询 / 解密失败 → 抛(acquireMux fail-closed)
export interface RemoteMuxDeps {
  /** 按 (userId, hostId) 查询容器所在位置。hostId 传入是因为同一用户理论可对多台
   *  remote host 发起会话;本模块按 (uid, hid) 粒度管理 mux。 */
  resolvePlacement(userId: string, hostId: string): Promise<Placement>;
  startSshControlMaster(
    target: NodeAgentTarget,
    args: {
      uid: number;
      hid: string;
      host: string;
      port: number;
      user: string;
      passwordB64: string;
    },
  ): Promise<void>;
  stopSshControlMaster(
    target: NodeAgentTarget,
    uid: number,
    hid: string,
  ): Promise<void>;
  /** PUT /files 的薄包装;remote 分支写 known_hosts + ctl.sock.hint 用。 */
  putRemoteFile(
    target: NodeAgentTarget,
    remotePath: string,
    content: Buffer,
    mode: number,
  ): Promise<void>;
  /** DELETE /files 的薄包装;release 分支清理两个 marker 文件用(best-effort)。 */
  deleteRemoteFile(target: NodeAgentTarget, remotePath: string): Promise<void>;
}

const NOT_CONFIGURED_REMOTE = () => {
  throw new RemoteHostError(
    "INTERNAL",
    "remote mux RPC fns not configured; call setRemoteMuxDeps (commercial bootstrap)",
  );
};

function defaultDeps(): RemoteMuxDeps {
  return {
    // 默认 = self。保持 C.1 前语义,personal 版不需 bootstrap。
    resolvePlacement: async () => ({ kind: "self" }),
    // 下面几个只有走到 remote 分支才会被调;默认 self,不会触发。
    startSshControlMaster: NOT_CONFIGURED_REMOTE as never,
    stopSshControlMaster: NOT_CONFIGURED_REMOTE as never,
    putRemoteFile: NOT_CONFIGURED_REMOTE as never,
    deleteRemoteFile: NOT_CONFIGURED_REMOTE as never,
  };
}

let deps: RemoteMuxDeps = defaultDeps();

export function setRemoteMuxDeps(next: RemoteMuxDeps): void {
  deps = next;
}

/** 测试 hook:清除注入,恢复默认(恒 self)实现。 */
export function resetRemoteMuxDeps(): void {
  deps = defaultDeps();
}

/**
 * Per-host async mutex。acquire/release/TOFU 写 known_hosts 都串行,
 * 避免并发 spawn 两条 ControlMaster 或 tmp+rename 竞争。
 *
 * 实现:链式 promise。每个调用 await 前一个,并把自己的完成 promise 塞进去。
 * 无 GC(key 数量 = 活跃 host 数,有界),接受。
 */
const hostMutexes = new Map<MuxKey, Promise<void>>();

async function runUnderHostMutex<T>(key: MuxKey, fn: () => Promise<T>): Promise<T> {
  const prev = hostMutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  hostMutexes.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

// ─── 进程组清理 ────────────────────────────────────────────────────────────

async function killProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  graceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid == null) return;
  try {
    // kill(-pid) 语义:整组(sshpass + 其派生的 ssh)一起收信号
    process.kill(-child.pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      log.warn("kill pg failed", { pid: child.pid, signal, code, err: String(err) });
    }
  }
  if (graceMs > 0) {
    const timer = new Promise<void>((r) => {
      const t = setTimeout(r, graceMs);
      t.unref?.();
    });
    await Promise.race([once(child, "exit").then(() => {}), timer]);
  }
}

async function forceKillProcessGroup(child: ChildProcess): Promise<void> {
  await killProcessGroup(child, "SIGTERM", KILL_GRACE_MS);
  if (child.exitCode === null && child.signalCode === null) {
    await killProcessGroup(child, "SIGKILL", 0);
  }
}

// ─── stderr drain(防背压 + 错误分类缓冲) ────────────────────────────────

function drainStderr(child: ChildProcess, sink: Buffer[]): void {
  let total = 0;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (total >= STDERR_BUF_CAP) return;
    const room = STDERR_BUF_CAP - total;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    sink.push(slice);
    total += slice.length;
  });
  // stdout 若有(ssh-keyscan 例外),调用方自己挂监听;这里只保证不会出现
  // 未消费 pipe 导致的背压死锁 —— 兜底 resume
  child.stdout?.resume();
}

/**
 * 把密码 Buffer 写进 fd 3 并关闭写端,写真正 flush 到内核后再清零。
 *
 * Codex R10 BLOCK 修复:`fd3.write(buf)` 只是把 chunk 入 queue,Node 可能仍
 * 引用原 Buffer 直到底层 pipe 排干。如果这时立刻 `.fill(0)`,实际送到 sshpass
 * 的就是一串 0 字节 → 认证失败且泄漏"密码已清"信号。
 *
 * 用 `stream.end(buf, cb)`:cb 在 'finish' 事件触发(所有数据已 flush)后才跑,
 * 此刻 Buffer 已被内核拷走,清零安全。
 */
async function writePasswordAndZero(fd3: Writable, password: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fd3.end(password, (err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
  password.fill(0);
}

// ─── 子进程退出竞赛(exit / error / timeout 三选一,单一失败路径) ──────

/**
 * Codex R9 实现提示:error/exit/ready 必须收敛成单一失败路径,避免双触发。
 * settled 标志位 + 提前返回保证。
 */
function raceExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    child.once("exit", (code) => done(code));
    child.once("error", () => done(null));
    const t = setTimeout(() => done(null), timeoutMs);
    t.unref?.();
  });
}

// ─── /run/ccb-ssh 目录 & known_hosts 物化 ────────────────────────────────

function hostRunDir(userId: string, hostId: string): string {
  return path.join(RUN_ROOT, `u${userId}`, `h${hostId}`);
}

/**
 * userId 在 v3 schema 里是 bigint,本模块当字符串流通;需要当 number 过 RPC
 * 时统一走这里,避免 NaN 漂过去。
 */
function parseUidOrThrow(userId: string): number {
  const n = Number.parseInt(userId, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== userId) {
    throw new RemoteHostError("INTERNAL", `userId not positive integer: ${userId}`);
  }
  return n;
}

async function ensureRunDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });
  // mkdir 对已存在目录不改权限;显式 chmod 抵御权限漂移(R8 NIT)
  await fs.chmod(dir, 0o750);
  // R14(task #4a):容器内 CCB 以 uid=V3_AGENT_UID gid=V3_AGENT_GID 运行,
  // 需要 group 权限进入该目录并 connect() 到 ctl.sock。
  // owner=root(gateway 进程) group=V3_AGENT_GID 0750 是最小满足条件。
  await fs.chown(dir, 0, V3_AGENT_GID);
}

/**
 * 原子覆盖写 known_hosts。绝不 append —— 一致性以 DB 为准,每次 acquireMux
 * 从 DB material 整体重建。tmp+rename 跨 rename 是原子的。
 */
async function materializeKnownHosts(targetPath: string, material: string): Promise<void> {
  const tmp = `${targetPath}.tmp-${randomUUID()}`;
  try {
    // R14(task #4a):容器内 ssh 以 gid=V3_AGENT_GID 运行,需要 r 权限读
    // known_hosts。0640 root:AGENT_GID 是最小满足条件 —— 宿主其他 uid 无权访问,
    // 容器 agent 能读。写完 tmp 后 chown/chmod 再 rename 保证"原子暴露"。
    await fs.writeFile(tmp, material, { mode: 0o640 });
    await fs.chown(tmp, 0, V3_AGENT_GID);
    await fs.chmod(tmp, 0o640);
    await fs.rename(tmp, targetPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ─── ssh ControlMaster spawn & ready probe ───────────────────────────────

function spawnControlMaster(
  cred: DecryptedCredential,
  controlPath: string,
  knownHostsPath: string,
): ChildProcess {
  const args = [
    "-d",
    "3",
    "ssh",
    "-M",
    "-N",
    "-T",
    "-S",
    controlPath,
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "NumberOfPasswordPrompts=1",
    "-o",
    "BatchMode=no",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "ControlPersist=no", // refcount=0 手动关,不留后台进程
    "-p",
    String(cred.port),
    `${cred.username}@${cred.host}`,
  ];
  return spawn("sshpass", args, {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true, // sshpass 成为 process group leader
  });
}

async function checkControlReady(
  controlPath: string,
  user: string,
  host: string,
  port: number,
): Promise<boolean> {
  const child = spawn(
    "ssh",
    ["-S", controlPath, "-O", "check", "-p", String(port), `${user}@${host}`],
    { stdio: "ignore", detached: true },
  );
  if (child.pid == null) return false;
  try {
    const code = await raceExit(child, OCHECK_ATTEMPT_TIMEOUT_MS);
    return code === 0;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await forceKillProcessGroup(child).catch(() => {});
    }
  }
}

async function waitForControlReady(
  child: ChildProcess,
  controlPath: string,
  meta: { username: string; host: string; port: number },
): Promise<void> {
  const deadline = Date.now() + MUX_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new RemoteHostError(
        "INTERNAL",
        "ssh controlmaster exited before ready",
      );
    }
    if (await checkControlReady(controlPath, meta.username, meta.host, meta.port)) {
      return;
    }
    await new Promise<void>((r) => {
      const t = setTimeout(r, MUX_READY_POLL_INTERVAL_MS);
      t.unref?.();
    });
  }
  throw new RemoteHostError("INTERNAL", "ssh controlmaster ready timeout");
}

// ─── 公共 API:acquire / release / shutdown ──────────────────────────────

export interface MuxHandle {
  sessionId: string;
  userId: string;
  hostId: string;
  controlPath: string;
  knownHostsPath: string;
  username: string;
  host: string;
  port: number;
  remoteWorkdir: string;
}

function toHandle(entry: MuxEntry, sessionId: string): MuxHandle {
  return {
    sessionId,
    userId: entry.meta.userId,
    hostId: entry.meta.hostId,
    controlPath: entry.controlPath,
    knownHostsPath: entry.knownHostsPath,
    username: entry.meta.username,
    host: entry.meta.host,
    port: entry.meta.port,
    remoteWorkdir: entry.meta.remoteWorkdir,
  };
}

export async function acquireMux(
  sessionId: string,
  userId: string,
  hostId: string,
): Promise<MuxHandle> {
  // R10 CR 修复:信号清理不能只依赖 makeRemoteHostTester 被调过;
  // acquireMux 有可能在 tester 未初始化的路径下被触发(例如 feature flag OFF
  // 但内部某条流程跑到了),那时 SIGTERM 不装 handler 会跳过 mux teardown。
  installSignalHandlers();
  const key = muxKey(userId, hostId);
  return runUnderHostMutex(key, async () => {
    const existing = muxRegistry.get(key);
    if (existing) {
      // 同 sessionId 重复 acquire 幂等:Set.add 返回 Set,无副作用计数
      existing.sessionIds.add(sessionId);
      return toHandle(existing, sessionId);
    }

    const cred = await loadDecryptedCredential(userId, hostId);
    try {
      if (!cred.knownHostsText) {
        // 强制先过 Test:未 TOFU 的 host 不允许 cold start
        throw new RemoteHostError(
          "VALIDATION",
          "host not yet verified; run test first",
        );
      }
      // C.1:先问 placement 再分流。placement lookup 抛 → fail-closed,不默认 self。
      // 默认注入(personal 版)直接返 {kind:'self'},不触发 remote 分支 RPC。
      const placement = await deps.resolvePlacement(userId, hostId);
      const entry =
        placement.kind === "self"
          ? await acquireMuxSelf(sessionId, userId, hostId, cred)
          : await acquireMuxRemote(sessionId, userId, hostId, cred, placement.target);
      muxRegistry.set(key, entry);
      return toHandle(entry, sessionId);
    } finally {
      // 不管走哪条分支,cred.password 在分支内部清零;这里兜底 —— 分支未 zero
      // 的异常路径(例如 placement lookup 抛在 loadDecryptedCredential 之后、分支
      // 调用之前)也要把密码擦了。反复 fill(0) 幂等。
      cred.password.fill(0);
    }
  });
}

async function acquireMuxSelf(
  sessionId: string,
  userId: string,
  hostId: string,
  cred: DecryptedCredential,
): Promise<MuxEntry> {
  const runDir = hostRunDir(userId, hostId);
  const knownHostsPath = path.join(runDir, "known_hosts");
  const controlPath = path.join(runDir, "ctl.sock");
  await ensureRunDir(runDir);
  // known_hosts 每次从 DB 重建:systemd 清 tmpfs 后自动恢复;TTL=进程生命周期
  await materializeKnownHosts(knownHostsPath, cred.knownHostsText!);
  // 残留 socket 先 rm(可能是上次崩溃后未清)
  await fs.rm(controlPath, { force: true }).catch(() => {});

  let child: ChildProcess | null = null;
  let pwZeroed = false;
  try {
    child = spawnControlMaster(cred, controlPath, knownHostsPath);
    if (child.pid == null) {
      throw new RemoteHostError("INTERNAL", "spawn sshpass failed");
    }
    // controlmaster stderr 只需防背压,不做诊断采集(认证诊断走 Test 路径);
    // R10 NIT:直接 resume 即可,别囤 buffer。
    child.stderr?.resume();
    child.stdout?.resume();
    child.once("error", (err) => {
      log.warn("controlmaster spawn error", { userId, hostId, err: String(err) });
    });

    const fd3 = child.stdio[3] as Writable | undefined;
    if (!fd3) {
      throw new RemoteHostError("INTERNAL", "sshpass fd 3 unavailable");
    }
    // R10 BLOCK 修复:必须等 write flush 完成再 fill(0),否则 Node 可能
    // 把零字节送进 sshpass。writePasswordAndZero 内完成清零。
    await writePasswordAndZero(fd3, cred.password);
    pwZeroed = true;

    await waitForControlReady(child, controlPath, {
      username: cred.username,
      host: cred.host,
      port: cred.port,
    });

    // R14(task #4a):ControlMaster ready 后 ssh 已创建 ctl.sock(默认 0600
    // owner=root)。容器内 CCB 要 connect() 这个 unix socket,必须 group 可写
    // (Linux unix socket 的 connect 需要 w 权限)。
    // 0660 root:AGENT_GID 让容器 uid=1000 通过 gid 匹配获得访问权;宿主其他
    // 用户仍无权。bind mount ro 不阻止 connect(ro 只禁 write/unlink/create)。
    await fs.chown(controlPath, 0, V3_AGENT_GID);
    await fs.chmod(controlPath, 0o660);
  } catch (err) {
    if (!pwZeroed) cred.password.fill(0);
    if (child && child.exitCode === null && child.signalCode === null) {
      await forceKillProcessGroup(child).catch(() => {});
    }
    throw err;
  }

  const key = muxKey(userId, hostId);
  const capturedChild = child;
  const entry: MuxEntry = {
    child: capturedChild,
    controlPath,
    knownHostsPath,
    placement: { kind: "self" },
    sessionIds: new Set([sessionId]),
    meta: {
      userId,
      hostId,
      username: cred.username,
      host: cred.host,
      port: cred.port,
      remoteWorkdir: cred.remoteWorkdir,
    },
  };
  capturedChild!.once("exit", (code, signal) => {
    log.info("controlmaster exited", { userId, hostId, code, signal });
    const cur = muxRegistry.get(key);
    if (cur && cur.child === capturedChild) muxRegistry.delete(key);
  });
  log.info("controlmaster ready", { userId, hostId, placement: "self" });
  return entry;
}

/**
 * Remote 分支:ssh ControlMaster 进程由远端 node-agent 代管。
 * 1. putFile known_hosts → node-agent MkdirAll parent(0755),写文件 mode 0640
 * 2. putFile ctl.sock.hint → 信息性 marker,帮 CCB 识别远程托管语义
 * 3. POST /sshmux/start → node-agent 在本机 spawn `ssh -M -N`;sock 落在
 *    `/run/ccb-ssh/u<uid>/h<hid>/ctl.sock`,perms 由 node-agent 设为 0660
 *    root:AGENT_GID(详见 C.2)
 *
 * C.1 注记:/sshmux/start endpoint 在 node-agent 里尚未实现,本分支被实际调用
 * 会命中 404 → AgentAppError 抛出。这是 C.2 的收尾工作。C.1 只装 seam。
 *
 * 密码纪律弱化:passwordB64 作为 JSON 字符串过线,master 这端无法清零中间 V8
 * 字符串。TLS 承担传输加密;节点侧收到后负责用完即清。
 */
async function acquireMuxRemote(
  sessionId: string,
  userId: string,
  hostId: string,
  cred: DecryptedCredential,
  target: NodeAgentTarget,
): Promise<MuxEntry> {
  const uidInt = parseUidOrThrow(userId);
  const runDir = hostRunDir(userId, hostId);
  const knownHostsPath = path.join(runDir, "known_hosts");
  const controlPath = path.join(runDir, "ctl.sock");
  const hintPath = path.join(runDir, "ctl.sock.hint");

  // 全段失败时回滚 put 产物 —— 即便 known_hosts 非 load-bearing,保持 acquire
  // 语义的"要么都在、要么都不在"便于排障(Codex C.1 NIT-1)。
  const cleanupRemoteArtifacts = async (): Promise<void> => {
    await deps
      .deleteRemoteFile(target, knownHostsPath)
      .catch((e) => log.warn("cleanup known_hosts failed", { userId, hostId, err: String(e) }));
    await deps
      .deleteRemoteFile(target, hintPath)
      .catch((e) => log.warn("cleanup hint failed", { userId, hostId, err: String(e) }));
  };

  // Codex C.4 MAJOR-1:startSshControlMaster 可能在 node-agent 侧部分成功
  // (ControlMaster 进程已起,响应未达 master / TLS 断) 。master 无法区分
  // "node-agent 根本没起" vs "起了但响应丢了",fail-closed 必须也发 stop RPC
  // 清掉潜在 orphan。stop handler 对不存在 key 幂等(204),所以调多调少都安全。
  let startAttempted = false;
  try {
    // 1. known_hosts —— 节点侧 MkdirAll 自动建父目录。
    await deps.putRemoteFile(
      target,
      knownHostsPath,
      Buffer.from(cred.knownHostsText!, "utf8"),
      0o640,
    );
    // 2. ctl.sock.hint marker(纯信息性,非 load-bearing)
    const hintBody = JSON.stringify({ managedBy: "node-agent", hostId });
    await deps.putRemoteFile(target, hintPath, Buffer.from(hintBody, "utf8"), 0o640);

    // 3. 启远端 ControlMaster。password base64 编码,node-agent 收到 decode + 清零。
    //    cred.password 本地 side 在 acquireMux 的 finally 里 .fill(0)。
    //    注意:toString('base64') 产出不可变 V8 字符串,master 这端无法清零中间值;
    //    TLS 承担传输加密,节点侧用完即清。
    startAttempted = true;
    const passwordB64 = cred.password.toString("base64");
    await deps.startSshControlMaster(target, {
      uid: uidInt,
      hid: hostId,
      host: cred.host,
      port: cred.port,
      user: cred.username,
      passwordB64,
    });
  } catch (err) {
    // 任意步骤失败 —— best-effort 清理,不遮原始错误。
    // startAttempted=true 时额外发 stop RPC 兜底 orphan ControlMaster。
    if (startAttempted) {
      await deps
        .stopSshControlMaster(target, uidInt, hostId)
        .catch((e) => log.warn("rollback stop controlmaster failed", { userId, hostId, err: String(e) }));
    }
    await cleanupRemoteArtifacts();
    throw err;
  }

  const entry: MuxEntry = {
    child: null,
    controlPath,
    knownHostsPath,
    placement: { kind: "remote", target },
    sessionIds: new Set([sessionId]),
    meta: {
      userId,
      hostId,
      username: cred.username,
      host: cred.host,
      port: cred.port,
      remoteWorkdir: cred.remoteWorkdir,
    },
  };
  log.info("controlmaster ready", {
    userId,
    hostId,
    placement: "remote",
    agentHost: target.host,
  });
  return entry;
}

export async function releaseMux(
  sessionId: string,
  userId: string,
  hostId: string,
): Promise<void> {
  const key = muxKey(userId, hostId);
  await runUnderHostMutex(key, async () => {
    const entry = muxRegistry.get(key);
    if (!entry) return;
    // 未 hold 过(重复 release 或从未 acquire)→ 幂等 return
    if (!entry.sessionIds.delete(sessionId)) return;
    if (entry.sessionIds.size > 0) return;
    muxRegistry.delete(key);
    // Codex C.1 MAJOR-1:remote 分支的 stop/delete RPC 必须 best-effort,绝不
    // 冒泡到 sessionManager.setExecutionTarget 的 rollback 路径 —— 会话切换
    // 语义上"释放"一旦开始就没有返回,外部 I/O 错误只能记日志。
    if (entry.placement.kind === "self") {
      if (entry.child) {
        try {
          await forceKillProcessGroup(entry.child);
        } catch (err) {
          log.warn("force kill pg failed", { userId, hostId, err: String(err) });
        }
      }
      await fs.rm(entry.controlPath, { force: true }).catch(() => {});
    } else {
      const target = entry.placement.target;
      try {
        await deps.stopSshControlMaster(target, parseUidOrThrow(userId), hostId);
      } catch (err) {
        log.warn("remote stop controlmaster failed", {
          userId,
          hostId,
          err: String(err),
        });
      }
      // known_hosts + ctl.sock.hint 节点侧残留无害(ro mount,内容已静态),
      // 但主动清理便于排障。失败只记录。
      await deps
        .deleteRemoteFile(target, entry.knownHostsPath)
        .catch((e) => log.warn("remote rm known_hosts failed", { userId, hostId, err: String(e) }));
      await deps
        .deleteRemoteFile(target, path.join(path.dirname(entry.controlPath), "ctl.sock.hint"))
        .catch((e) => log.warn("remote rm hint failed", { userId, hostId, err: String(e) }));
    }
    log.info("controlmaster released", {
      userId,
      hostId,
      placement: entry.placement.kind,
    });
  });
}

export async function shutdownAllMux(): Promise<void> {
  const entries = Array.from(muxRegistry.values());
  muxRegistry.clear();
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.placement.kind === "self") {
        if (entry.child) {
          await forceKillProcessGroup(entry.child).catch(() => {});
        }
        await fs.rm(entry.controlPath, { force: true }).catch(() => {});
      } else {
        const target = entry.placement.target;
        let uid: number;
        try {
          uid = parseUidOrThrow(entry.meta.userId);
        } catch (e) {
          log.warn("shutdown skipped (bad uid)", {
            userId: entry.meta.userId,
            hostId: entry.meta.hostId,
            err: String(e),
          });
          return;
        }
        await deps
          .stopSshControlMaster(target, uid, entry.meta.hostId)
          .catch((e) =>
            log.warn("shutdown remote stop failed", {
              userId: entry.meta.userId,
              hostId: entry.meta.hostId,
              err: String(e),
            }),
          );
        // 节点文件不主动清 —— 进程退出时机敏感,best-effort 保守些,留给下次
        // node-agent tmpfs 清理(/run/ccb-ssh 由 systemd RuntimeDirectory 托管)。
      }
    }),
  );
}

// ─── 进程退出信号 ─────────────────────────────────────────────────────────

let signalHandled = false;
let signalsInstalled = false;

function installSignalHandlers(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  const handle = async (sig: NodeJS.Signals) => {
    if (signalHandled) return;
    signalHandled = true;
    try {
      await shutdownAllMux();
    } catch (err) {
      log.error("shutdown mux on signal failed", { sig, err: String(err) });
    } finally {
      process.exit(sig === "SIGINT" ? 130 : 143);
    }
  };
  process.once("SIGTERM", () => {
    void handle("SIGTERM");
  });
  process.once("SIGINT", () => {
    void handle("SIGINT");
  });
  // beforeExit 只作 best-effort:异步清理在 beforeExit 里不保证跑完(R8 CR)
  process.once("beforeExit", () => {
    void shutdownAllMux().catch(() => {});
  });
}

// ─── Tester 工厂:环境 capability 检测 + TOFU / verify 两分支 ─────────────

function which(bin: string): boolean {
  const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const p of paths) {
    try {
      if (statSync(path.join(p, bin)).isFile()) return true;
    } catch {
      /* ENOENT / EACCES — 继续下一个 */
    }
  }
  return false;
}

function canUseRunRoot(): boolean {
  try {
    mkdirSync(RUN_ROOT, { recursive: true, mode: 0o700 });
    accessSync(RUN_ROOT, fsConstants.W_OK);
    return true;
  } catch (err) {
    log.warn("RUN_ROOT not writable", { RUN_ROOT, err: String(err) });
    return false;
  }
}

export function makeRemoteHostTester(): RemoteHostTester | undefined {
  // R8 BLOCK 修复:ssh-keygen 也必须在(TOFU 分支要 `ssh-keygen -lf -` 派生 fp)
  const required = ["sshpass", "ssh", "ssh-keyscan", "ssh-keygen"];
  for (const bin of required) {
    if (!which(bin)) {
      log.warn("remote-ssh tester disabled; capability missing", { bin });
      return undefined;
    }
  }
  if (!canUseRunRoot()) return undefined;
  installSignalHandlers();
  log.info("remote-ssh tester enabled", { RUN_ROOT });
  return testerImpl;
}

async function testerImpl(cred: DecryptedCredential): Promise<RemoteHostTestResult> {
  if (cred.knownHostsText) {
    // 已有 material → 严格按现有 material 验证,不 keyscan、不覆盖 DB
    return authProbe(cred, cred.knownHostsText);
  }
  // TOFU:keyscan 取 material → ssh-keygen 派生 fp → authprobe
  const scan = await runKeyscan(cred.host, cred.port);
  if (!scan.ok) return { ok: false, error: scan.error };
  const fp = await deriveFingerprint(scan.material);
  if (!fp.ok) return { ok: false, error: "host key parse failed" };
  const probe = await authProbe(cred, scan.material);
  if (!probe.ok) return probe;
  return {
    ok: true,
    fingerprintCaptured: fp.fingerprint,
    knownHostsTextCaptured: scan.material,
  };
}

// ─── TOFU 三段 spawn ─────────────────────────────────────────────────────

async function runKeyscan(
  host: string,
  port: number,
): Promise<{ ok: true; material: string } | { ok: false; error: string }> {
  const child = spawn(
    "ssh-keyscan",
    ["-T", "10", "-t", "rsa,ecdsa,ed25519", "-p", String(port), host],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  if (child.pid == null) return { ok: false, error: "host unreachable" };
  const out: Buffer[] = [];
  let outTotal = 0;
  child.stdout?.on("data", (c: Buffer) => {
    if (outTotal >= STDERR_BUF_CAP) return;
    const room = STDERR_BUF_CAP - outTotal;
    const slice = c.length > room ? c.subarray(0, room) : c;
    out.push(slice);
    outTotal += slice.length;
  });
  // stderr 对 keyscan 不用于诊断,resume 防背压即可(R10 NIT)
  child.stderr?.resume();
  child.once("error", () => {});
  try {
    const code = await raceExit(child, KEYSCAN_TIMEOUT_MS);
    if (code !== 0) return { ok: false, error: "host unreachable" };
    const raw = Buffer.concat(out).toString("utf8");
    const material =
      raw
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("#"))
        .join("\n") + "\n";
    if (!material.trim()) return { ok: false, error: "host key missing" };
    return { ok: true, material };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await forceKillProcessGroup(child).catch(() => {});
    }
  }
}

async function deriveFingerprint(
  material: string,
): Promise<{ ok: true; fingerprint: string } | { ok: false }> {
  const child = spawn("ssh-keygen", ["-lf", "-"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  if (child.pid == null) return { ok: false };
  const out: Buffer[] = [];
  child.stdout?.on("data", (c: Buffer) => out.push(c));
  child.stderr?.resume();
  child.once("error", () => {});
  try {
    child.stdin?.write(material);
    child.stdin?.end();
  } catch {
    return { ok: false };
  }
  try {
    const code = await raceExit(child, KEYGEN_TIMEOUT_MS);
    if (code !== 0) return { ok: false };
    const firstLine = Buffer.concat(out).toString("utf8").split("\n")[0] ?? "";
    const m = firstLine.match(/SHA256:[A-Za-z0-9+/=]+/);
    return m ? { ok: true, fingerprint: m[0] } : { ok: false };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await forceKillProcessGroup(child).catch(() => {});
    }
  }
}

async function authProbe(
  cred: DecryptedCredential,
  material: string,
): Promise<RemoteHostTestResult> {
  // 隔离的临时 known_hosts —— 不污染 mux 共用的 /run/.../known_hosts,
  // 成功后由 service 统一回填到 DB 再触发实际 mux acquire。
  const probeDir = await fs.mkdtemp(path.join(RUN_ROOT, "probe-"));
  await fs.chmod(probeDir, 0o700);
  const probeKH = path.join(probeDir, "known_hosts");
  let child: ChildProcess | null = null;
  let pwZeroed = false;
  try {
    await fs.writeFile(probeKH, material, { mode: 0o600 });
    const args = [
      "-d",
      "3",
      "ssh",
      "-o",
      `UserKnownHostsFile=${probeKH}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-o",
      "BatchMode=no",
      "-o",
      "ConnectTimeout=10",
      "-p",
      String(cred.port),
      `${cred.username}@${cred.host}`,
      "true",
    ];
    child = spawn("sshpass", args, {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      detached: true,
    });
    if (child.pid == null) return { ok: false, error: "connection failed" };
    const errBuf: Buffer[] = [];
    drainStderr(child, errBuf);
    child.once("error", (e) => {
      log.warn("probe spawn error", { err: String(e) });
    });
    const fd3 = child.stdio[3] as Writable | undefined;
    if (!fd3) return { ok: false, error: "connection failed" };
    // R10 BLOCK 修复同 acquireMux:等写 flush 完成再清零。
    await writePasswordAndZero(fd3, cred.password);
    pwZeroed = true;
    const code = await raceExit(child, AUTH_PROBE_TIMEOUT_MS);
    if (code === 0) return { ok: true };
    const stderr = Buffer.concat(errBuf).toString("utf8");
    return { ok: false, error: classifyProbeError(stderr, code) };
  } finally {
    if (!pwZeroed) cred.password.fill(0);
    if (child && child.exitCode === null && child.signalCode === null) {
      await forceKillProcessGroup(child).catch(() => {});
    }
    await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 错误分类。只吐业务级 tag 到前端,原始 stderr 只进日志。
 * 不泄漏 "user exists / password wrong" 这类 oracle。
 */
function classifyProbeError(stderr: string, exitCode: number | null): string {
  if (/Host key verification failed/i.test(stderr)) return "host key mismatch";
  if (/Permission denied/i.test(stderr)) return "authentication failed";
  if (exitCode === 5) return "authentication failed"; // sshpass: password incorrect
  if (/Connection (refused|timed out)/i.test(stderr)) return "host unreachable";
  if (/Could not resolve|Name or service not known/i.test(stderr)) {
    return "host unreachable";
  }
  if (exitCode == null) return "connection timeout";
  return "connection failed";
}
