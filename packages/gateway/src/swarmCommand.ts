/**
 * Swarm 蜂群操控指令、安全会话路由与高阶剧本库(OCV5-828 R2 · B5 + B8 闭环)。
 *
 * 能力与安全红线:
 *   1. 互斥锁串行化追加(`withSwarmBoardLock`):对 `board.jsonl` 读序号+追加采用同目录
 *      `O_CREAT | O_EXCL | O_NOFOLLOW` 独占锁文件与目录 dev/ino 校验,防止并发指令序号撞车;
 *   2. 诚实单点终止协议(B8):`terminateSwarmMember` 绝不绕过原生执行器无条件覆写 `members.json`
 *      伪装成 `killed`!而是向 `board.jsonl` 发送结构化 `@coordinator [control:kill]` 终止请求,
 *      明确区分 `status: 'requested'`(已提交控制请求)、`'confirmed'`(经权威执行器确认停止)
 *      与 `'already_killed'`,且讨论板写入失败必须报错绝不吞错;
 *   3. 正式会话路由处理器(B5):导出 `handleSwarmCommandRoute` 对应
 *      `POST /api/sessions/:id/swarm/command`,强校验认证 uid 与 session 归属,绝不接受
 *      客户端自选 `brainDir` 路径;
 *   4. 内置 4 套科研/工程默认高阶剧本模板(并行实现+验收、多源文献深研+核验、架构深度体检、多方案评审)。
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  SWARM_MAX_POST_CHARS,
  type SwarmMemberRole,
  extractSwarmMentions,
} from "@openclaude/protocol";

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_MEMBER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MEMBERS_JSON_BYTES = 512 * 1024;
/** Generous hard ceiling for large swarm boards (64 MB) paired with O(1) tail seq scanning. */
const MAX_BOARD_SCAN_BYTES = 64 * 1024 * 1024;
/** Tail window scanned first when `board.jsonl` grows past 256 KB so large boards stay O(1). */
const BOARD_TAIL_SCAN_BYTES = 256 * 1024;
const MAX_COMMAND_BODY_BYTES = 32 * 1024;
const BOARD_LOCK_STALE_MS = 15_000;
const BOARD_LOCK_TIMEOUT_MS = 5_000;
const BOARD_LOCK_BASE_DELAY_MS = 15;
const BOARD_LOCK_MAX_DELAY_MS = 120;
const BOARD_LOCK_JITTER_MS = 15;

/** Per-swarmDir in-process serialization queue to eliminate intra-process lock thrashing. */
const boardLockQueues = new Map<string, Promise<unknown>>();

export const SWARM_COMMAND_ROUTE_RE = /^\/api\/sessions\/([^/]+)\/swarm\/command\/?$/;

export type SwarmCommandErrorCode =
  | "INVALID_CONVERSATION_ID"
  | "SWARM_NOT_FOUND"
  | "SYMLINK_REJECTED"
  | "INVALID_TARGET"
  | "INVALID_MESSAGE"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_ALREADY_KILLED"
  | "CANNOT_KILL_COORDINATOR"
  | "LOCK_CONTENTION"
  | "IO_FAILED";

export interface SwarmCommandFailure {
  ok: false;
  code: SwarmCommandErrorCode;
  error: string;
}

export interface InjectSwarmDirectiveOptions {
  brainDir: string;
  conversationId: string;
  /** 目标成员名(`coordinator` / 成员名 / `all`,带或不带 `@` 前缀均可)。 */
  target: string;
  /** 人工纠偏内容。 */
  message: string;
  /** 目标频道(默认 `main`)。 */
  channel?: string;
  /** 发送者标识(默认 `human`)。 */
  sender?: string;
  /** 控制事件类型(默认 `steer`,网关停滞告警传 `stall`)。 */
  controlKind?: string;
  now?: number;
  /** 可选测试钩子:覆盖 `.board.lock` 异步等待上限(默认 5000ms)。 */
  lockTimeoutMs?: number;
}

export interface InjectSwarmDirectiveSuccess {
  ok: true;
  seq: number;
  target: string;
  channel: string;
  agent: string;
  text: string;
  mentions: string[];
  time: string;
}

export type InjectSwarmDirectiveResult = InjectSwarmDirectiveSuccess | SwarmCommandFailure;

export interface TerminateSwarmMemberOptions {
  brainDir: string;
  conversationId: string;
  memberName: string;
  reason?: string;
  sender?: string;
  now?: number;
  /**
   * 可选权威执行器回执回调:仅当真实会话执行器确认目标实例已停止并返回 `true` 时,
   * 才返回 `status: 'confirmed'`;否则诚实返回 `status: 'requested'`。
   */
  confirmByExecutor?: (memberName: string, reason: string) => boolean | Promise<boolean>;
  /** 可选测试钩子:覆盖 `.board.lock` 异步等待上限(默认 5000ms)。 */
  lockTimeoutMs?: number;
}

export type TerminateSwarmStatus = "requested" | "confirmed" | "already_killed";

export interface TerminateSwarmMemberSuccess {
  ok: true;
  status: TerminateSwarmStatus;
  memberName: string;
  alreadyKilled: boolean;
  noticeSeq?: number;
  time: string;
}

export type TerminateSwarmMemberResult = TerminateSwarmMemberSuccess | SwarmCommandFailure;

interface RawRosterRecord {
  title?: unknown;
  members?: Record<string, Record<string, unknown>>;
  channels?: unknown;
  [k: string]: unknown;
}

interface VerifiedSwarmDir {
  swarmDir: string;
  realBrainDir: string;
  dev: number;
  ino: number;
}

function resolveSafeSwarmDir(
  brainDir: string,
  conversationId: string,
): { ok: true; dir: VerifiedSwarmDir } | SwarmCommandFailure {
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return { ok: false, code: "INVALID_CONVERSATION_ID", error: "invalid swarm conversationId" };
  }
  try {
    const rootStat = lstatSync(brainDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, code: "SYMLINK_REJECTED", error: "brainDir must be a real directory" };
    }
    const realBrainDir = realpathSync(brainDir);
    const segments = [conversationId, ".system_generated", "swarm"];
    let cur = brainDir;
    let lastStat = rootStat;
    for (const seg of segments) {
      cur = path.join(cur, seg);
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) {
        return { ok: false, code: "SYMLINK_REJECTED", error: `symlink rejected at ${seg}` };
      }
      if (!st.isDirectory()) {
        return { ok: false, code: "SWARM_NOT_FOUND", error: "swarm directory not found" };
      }
      lastStat = st;
    }
    const realSwarmDir = realpathSync(cur);
    const prefix = realBrainDir.endsWith(path.sep) ? realBrainDir : `${realBrainDir}${path.sep}`;
    if (!realSwarmDir.startsWith(prefix)) {
      return { ok: false, code: "SYMLINK_REJECTED", error: "swarm directory escapes brainDir" };
    }
    return {
      ok: true,
      dir: { swarmDir: realSwarmDir, realBrainDir, dev: lastStat.dev, ino: lastStat.ino },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      return { ok: false, code: "SWARM_NOT_FOUND", error: "active swarm directory not found" };
    }
    return { ok: false, code: "IO_FAILED", error: `cannot inspect swarm directory: ${(err as Error).message}` };
  }
}

function assertSwarmDirIdentity(dir: VerifiedSwarmDir): SwarmCommandFailure | null {
  try {
    const st = lstatSync(dir.swarmDir);
    if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== dir.dev || st.ino !== dir.ino) {
      return { ok: false, code: "SYMLINK_REJECTED", error: "swarm directory identity changed" };
    }
    return null;
  } catch {
    return { ok: false, code: "SWARM_NOT_FOUND", error: "swarm directory disappeared" };
  }
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, ms));
    timer.unref();
  });
}

async function runInSwarmDirQueue<T>(swarmDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = boardLockQueues.get(swarmDir) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.catch(() => undefined).then(() => tail);
  boardLockQueues.set(swarmDir, chained);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (boardLockQueues.get(swarmDir) === chained) {
      boardLockQueues.delete(swarmDir);
    }
  }
}

/**
 * 异步独占锁文件保护 `board.jsonl` 读序号 + 追加(防并发指令序号撞车，绝不阻塞事件循环)。
 * 采用进程内 per-swarmDir Promise 队列 + 异步带抖动指数退避重试，保持 `O_NOFOLLOW`/symlink 安全校验不降级。
 */
async function withSwarmBoardLock<T>(
  dir: VerifiedSwarmDir,
  now: number,
  fn: () => T | SwarmCommandFailure | Promise<T | SwarmCommandFailure>,
  lockTimeoutMs: number = BOARD_LOCK_TIMEOUT_MS,
): Promise<T | SwarmCommandFailure> {
  return runInSwarmDirQueue(dir.swarmDir, async () => {
    const identityErr = assertSwarmDirIdentity(dir);
    if (identityErr) return identityErr;

    const lockPath = path.join(dir.swarmDir, ".board.lock");
    const lockFlags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);

    const deadline = Date.now() + Math.max(20, lockTimeoutMs);
    let lockFd: number | null = null;
    let attempt = 0;
    for (;;) {
      try {
        lockFd = openSync(lockPath, lockFlags, 0o600);
        writeSync(lockFd, `${process.pid}:${now}\n`, null, "utf8");
        closeSync(lockFd);
        lockFd = null;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === "ELOOP") {
          return { ok: false, code: "SYMLINK_REJECTED", error: "board lock symlink rejected" };
        }
        if (code === "EEXIST") {
          // 检查是否为过期孤儿锁或符号链接
          let unlinkedStale = false;
          try {
            const st = lstatSync(lockPath);
            if (st.isSymbolicLink()) {
              return { ok: false, code: "SYMLINK_REJECTED", error: "board lock symlink rejected" };
            }
            if (Date.now() - st.mtimeMs > BOARD_LOCK_STALE_MS) {
              try {
                unlinkSync(lockPath);
                unlinkedStale = true;
              } catch {
                /* raced */
              }
            }
          } catch {
            // lock already released
            unlinkedStale = true;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0 && !unlinkedStale) {
            return { ok: false, code: "LOCK_CONTENTION", error: "swarm board lock busy; retry shortly" };
          }
          if (!unlinkedStale) {
            const backoff = Math.min(
              BOARD_LOCK_MAX_DELAY_MS,
              BOARD_LOCK_BASE_DELAY_MS * Math.min(8, attempt + 1),
            );
            const jitter = Math.floor(Math.random() * BOARD_LOCK_JITTER_MS);
            await sleepAsync(Math.min(remaining, backoff + jitter));
          }
          attempt += 1;
          continue;
        }
        return { ok: false, code: "IO_FAILED", error: `cannot acquire board lock: ${(err as Error).message}` };
      }
    }

    try {
      const recheck = assertSwarmDirIdentity(dir);
      if (recheck) return recheck;
      return await fn();
    } finally {
      if (lockFd !== null) {
        try { closeSync(lockFd); } catch { /* ignore */ }
      }
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  });
}

function readRosterSafe(
  dir: VerifiedSwarmDir,
): { ok: true; membersPath: string; roster: RawRosterRecord } | SwarmCommandFailure {
  const idErr = assertSwarmDirIdentity(dir);
  if (idErr) return idErr;
  const membersPath = path.join(dir.swarmDir, "members.json");
  let fd: number | null = null;
  try {
    const lst = lstatSync(membersPath);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      return { ok: false, code: "SYMLINK_REJECTED", error: "members.json must be a regular file" };
    }
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
    fd = openSync(membersPath, flags);
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.dev !== lst.dev || fst.ino !== lst.ino) {
      return { ok: false, code: "SYMLINK_REJECTED", error: "members.json changed during open" };
    }
    if (fst.size <= 0 || fst.size > MAX_MEMBERS_JSON_BYTES) {
      return { ok: false, code: "IO_FAILED", error: "members.json size out of bounds" };
    }
    const raw = readFileSync(fd, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, code: "IO_FAILED", error: "members.json is not a JSON object" };
    }
    return { ok: true, membersPath, roster: parsed as RawRosterRecord };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      return { ok: false, code: "SWARM_NOT_FOUND", error: "members.json not found" };
    }
    if (code === "ELOOP") {
      return { ok: false, code: "SYMLINK_REJECTED", error: "members.json symlink rejected" };
    }
    return { ok: false, code: "IO_FAILED", error: `cannot read members.json: ${(err as Error).message}` };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseHeadSeqFromText(text: string, allowLineCountFallback: boolean): number {
  let headSeq = 0;
  let lineCount = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineCount += 1;
    try {
      const obj = JSON.parse(trimmed) as { seq?: unknown };
      if (typeof obj?.seq === "number" && Number.isFinite(obj.seq) && obj.seq > 0) {
        headSeq = Math.max(headSeq, Math.floor(obj.seq));
      } else if (allowLineCountFallback) {
        headSeq = Math.max(headSeq, lineCount);
      }
    } catch {
      if (allowLineCountFallback) {
        headSeq = Math.max(headSeq, lineCount);
      }
    }
  }
  return headSeq;
}

function readBoardHeadSeq(boardPath: string): { ok: true; headSeq: number } | SwarmCommandFailure {
  let fd: number | null = null;
  try {
    const lst = lstatSync(boardPath);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      return { ok: false, code: "SYMLINK_REJECTED", error: "board.jsonl must be a regular file" };
    }
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
    fd = openSync(boardPath, flags);
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.dev !== lst.dev || fst.ino !== lst.ino || fst.size > MAX_BOARD_SCAN_BYTES) {
      return { ok: false, code: "IO_FAILED", error: "board.jsonl invalid or exceeds scan cap" };
    }
    if (fst.size === 0) return { ok: true, headSeq: 0 };
    if (fst.size > BOARD_TAIL_SCAN_BYTES) {
      const tailSize = Math.min(fst.size, BOARD_TAIL_SCAN_BYTES);
      const startOffset = fst.size - tailSize;
      const buf = Buffer.allocUnsafe(tailSize);
      let readTotal = 0;
      while (readTotal < tailSize) {
        const n = readSync(fd, buf, readTotal, tailSize - readTotal, startOffset + readTotal);
        if (n <= 0) break;
        readTotal += n;
      }
      const rawTail = buf.subarray(0, readTotal).toString("utf8");
      const firstNl = rawTail.indexOf("\n");
      const completeTail = firstNl >= 0 ? rawTail.slice(firstNl + 1) : "";
      const tailSeq = parseHeadSeqFromText(completeTail, false);
      if (tailSeq > 0) {
        return { ok: true, headSeq: tailSeq };
      }
    }
    const text = readFileSync(fd, "utf8");
    return { ok: true, headSeq: parseHeadSeqFromText(text, true) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { ok: true, headSeq: 0 };
    if (code === "ELOOP") {
      return { ok: false, code: "SYMLINK_REJECTED", error: "board.jsonl symlink rejected" };
    }
    return { ok: false, code: "IO_FAILED", error: `cannot read board.jsonl: ${(err as Error).message}` };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

async function appendBoardPostLocked(
  dir: VerifiedSwarmDir,
  now: number,
  post: { agent: string; channel: string; text: string; time: string; control?: Record<string, unknown> },
  lockTimeoutMs?: number,
): Promise<{ ok: true; seq: number } | SwarmCommandFailure> {
  return withSwarmBoardLock(
    dir,
    now,
    () => {
      const boardPath = path.join(dir.swarmDir, "board.jsonl");
      const seqRes = readBoardHeadSeq(boardPath);
      if (!seqRes.ok) return seqRes;
      const nextSeq = seqRes.headSeq + 1;
      const line = `${JSON.stringify({
        seq: nextSeq,
        agent: post.agent,
        channel: post.channel,
        text: post.text,
        time: post.time,
        ...(post.control ? { control: post.control } : {}),
      })}\n`;

      let fd: number | null = null;
      try {
        const flags =
          fsConstants.O_WRONLY |
          fsConstants.O_APPEND |
          fsConstants.O_CREAT |
          (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
        fd = openSync(boardPath, flags, 0o600);
        const fst = fstatSync(fd);
        if (!fst.isFile()) {
          return { ok: false, code: "SYMLINK_REJECTED", error: "board.jsonl is not a regular file" };
        }
        writeSync(fd, line, null, "utf8");
        return { ok: true, seq: nextSeq };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === "ELOOP") {
          return { ok: false, code: "SYMLINK_REJECTED", error: "board.jsonl symlink rejected" };
        }
        return { ok: false, code: "IO_FAILED", error: `failed to append board.jsonl: ${(err as Error).message}` };
      } finally {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* ignore */ }
        }
      }
    },
    lockTimeoutMs,
  );
}

function normalizeTargetName(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

/**
 * 向活跃 Swarm board 注入人工纠偏指令(`@coordinator` / `@member` / `@all`)。
 */
export async function injectSwarmDirective(
  opts: InjectSwarmDirectiveOptions,
): Promise<InjectSwarmDirectiveResult> {
  const target = normalizeTargetName(opts.target);
  if (!target || !SAFE_MEMBER_NAME_RE.test(target)) {
    return { ok: false, code: "INVALID_TARGET", error: "invalid target member name" };
  }
  const rawMsg = typeof opts.message === "string" ? opts.message.trim() : "";
  if (!rawMsg) {
    return { ok: false, code: "INVALID_MESSAGE", error: "directive message cannot be empty" };
  }
  const channel = (opts.channel ?? "main").trim() || "main";
  if (!SAFE_CHANNEL_RE.test(channel)) {
    return { ok: false, code: "INVALID_TARGET", error: "invalid channel name" };
  }
  const agent = (opts.sender ?? "human").trim() || "human";

  const dirRes = resolveSafeSwarmDir(opts.brainDir, opts.conversationId);
  if (!dirRes.ok) return dirRes;

  const rosterRes = readRosterSafe(dirRes.dir);
  if (!rosterRes.ok) return rosterRes;

  const members =
    rosterRes.roster.members && typeof rosterRes.roster.members === "object"
      ? rosterRes.roster.members
      : {};

  if (target.toLowerCase() !== "all") {
    const entry = members[target];
    if (!entry && target.toLowerCase() !== "coordinator") {
      return {
        ok: false,
        code: "MEMBER_NOT_FOUND",
        error: `member "${target}" is not registered in this swarm`,
      };
    }
    if (entry && entry.killed === true) {
      return {
        ok: false,
        code: "MEMBER_ALREADY_KILLED",
        error: `member "${target}" has already been terminated`,
      };
    }
  }

  const existingMentions = extractSwarmMentions(rawMsg);
  const needsPrefix = !existingMentions.includes(target.toLowerCase());
  const fullText = needsPrefix ? `@${target} ${rawMsg}` : rawMsg;
  if (fullText.length > SWARM_MAX_POST_CHARS) {
    return {
      ok: false,
      code: "INVALID_MESSAGE",
      error: `directive exceeds ${SWARM_MAX_POST_CHARS} characters`,
    };
  }

  const now = opts.now ?? Date.now();
  const time = new Date(now).toISOString();
  const controlKind = (opts.controlKind ?? "steer").trim() || "steer";
  const appended = await appendBoardPostLocked(
    dirRes.dir,
    now,
    {
      agent,
      channel,
      text: fullText,
      time,
      control: { kind: controlKind, target },
    },
    opts.lockTimeoutMs,
  );
  if (!appended.ok) return appended;

  return {
    ok: true,
    seq: appended.seq,
    target,
    channel,
    agent,
    text: fullText,
    mentions: extractSwarmMentions(fullText),
    time,
  };
}

/**
 * 安全单点终止单个 Swarm 成员(B8 诚实状态协议):
 *   - 严禁终止 `coordinator`;
 *   - 绝不绕过权威执行器直接覆写 `members.json` 伪装成已停止;
 *   - 在独占锁保护下向 `board.jsonl` 追加 `@coordinator` 结构化终止控制请求;
 *   - 若讨论板写入失败直接返回 `{ ok: false }` 绝不吞错;
 *   - 仅当 `confirmByExecutor` 真实确认目标实例停止时返 `status: 'confirmed'`,
 *     否则诚实返回 `status: 'requested'` 等待 coordinator/执行器执行 `swarm{action:"kill"}`。
 */
export async function terminateSwarmMember(
  opts: TerminateSwarmMemberOptions,
): Promise<TerminateSwarmMemberResult> {
  const memberName = normalizeTargetName(opts.memberName);
  if (!memberName || !SAFE_MEMBER_NAME_RE.test(memberName)) {
    return { ok: false, code: "INVALID_TARGET", error: "invalid member name" };
  }
  if (memberName.toLowerCase() === "coordinator") {
    return {
      ok: false,
      code: "CANNOT_KILL_COORDINATOR",
      error: "refusing single-member termination of coordinator",
    };
  }

  const dirRes = resolveSafeSwarmDir(opts.brainDir, opts.conversationId);
  if (!dirRes.ok) return dirRes;

  const rosterRes = readRosterSafe(dirRes.dir);
  if (!rosterRes.ok) return rosterRes;

  const members = rosterRes.roster.members;
  if (!members || typeof members !== "object" || !members[memberName]) {
    return {
      ok: false,
      code: "MEMBER_NOT_FOUND",
      error: `member "${memberName}" not found in swarm roster`,
    };
  }

  const entry = members[memberName]!;
  if (String(entry.role ?? "").toLowerCase() === "coordinator") {
    return {
      ok: false,
      code: "CANNOT_KILL_COORDINATOR",
      error: "refusing single-member termination of coordinator role",
    };
  }

  const now = opts.now ?? Date.now();
  const time = new Date(now).toISOString();
  if (entry.killed === true) {
    return { ok: true, status: "already_killed", memberName, alreadyKilled: true, time };
  }

  const sender = (opts.sender ?? "human").trim() || "human";
  const reason = (opts.reason ?? "operator requested single-member stop").trim().slice(0, 240);

  const confirmed = opts.confirmByExecutor
    ? Boolean(await opts.confirmByExecutor(memberName, reason))
    : false;
  const noticeText = confirmed
    ? `@coordinator [control:kill:confirmed] 已确认单点终止成员 @${memberName}（原因：${reason}）。请评估是否需要重新分派未完成工作。`
    : `@coordinator [control:kill:requested] 人工请求单点终止成员 @${memberName}（原因：${reason}）。请调用 swarm{action:"kill", name:"${memberName}"} 安全回收并确认状态。`;

  const appended = await appendBoardPostLocked(
    dirRes.dir,
    now,
    {
      agent: sender,
      channel: "main",
      text: noticeText,
      time,
      control: {
        kind: "terminate",
        target: memberName,
        status: confirmed ? "confirmed" : "requested",
        reason,
      },
    },
    opts.lockTimeoutMs,
  );
  if (!appended.ok) {
    return appended;
  }

  return {
    ok: true,
    status: confirmed ? "confirmed" : "requested",
    memberName,
    alreadyKilled: false,
    noticeSeq: appended.seq,
    time,
  };
}

// ── 高阶剧本库(6 套内置科研/工程默认模板) ─────────────────────────────────────

export type SwarmPlaybookId =
  | "parallel-impl-verify"
  | "multi-source-lit-verify"
  | "arch-deep-audit"
  | "multi-option-review"
  | "research-write-review-revise"
  | "research-controlled-exp-loop";

export interface SwarmPlaybookRoleSpec {
  name: string;
  role: SwarmMemberRole;
  workspace: "inherit" | "share" | "branch";
  responsibility: string;
  readOnly?: boolean;
}

export interface SwarmPlaybookTemplate {
  id: SwarmPlaybookId;
  title: string;
  aliases: readonly string[];
  category: "engineering" | "research" | "decision";
  summary: string;
  channels: readonly { name: string; topic: string }[];
  roles: readonly SwarmPlaybookRoleSpec[];
  workflow: readonly string[];
  guardrails: readonly string[];
}

export const SWARM_PLAYBOOK_TEMPLATES: readonly SwarmPlaybookTemplate[] = Object.freeze([
  {
    id: "parallel-impl-verify",
    title: "并行实现+验收",
    aliases: ["并行实现", "impl-verify", "parallel-impl", "并行开发验收"],
    category: "engineering",
    summary: "将功能拆分为零冲突文件所有权的并行开发切片，并配置独立只读验收员执行类型与单测闭环。",
    channels: [
      { name: "main", topic: "任务切分、交付汇总与最终结论" },
      { name: "impl", topic: "各切片接口契约与并行实现进度" },
      { name: "verify", topic: "独立回归测试、边界审查与缺陷追踪" },
    ],
    roles: [
      {
        name: "coordinator",
        role: "coordinator",
        workspace: "inherit",
        responsibility: "切分零冲突文件所有权、定义共享类型契约、协调合并与最终交付。",
      },
      {
        name: "worker-a",
        role: "worker",
        workspace: "share",
        responsibility: "负责核心模块切片 A 实现及对应单元测试，严禁越界修改他人文件。",
      },
      {
        name: "worker-b",
        role: "worker",
        workspace: "share",
        responsibility: "负责外围/集成切片 B 实现及对应单元测试，严禁越界修改他人文件。",
      },
      {
        name: "verifier",
        role: "verifier",
        workspace: "inherit",
        readOnly: true,
        responsibility: "独立只读复核代码差异、运行全量单测与类型检查，发现问题点名 @worker 返修。",
      },
    ],
    workflow: [
      "1. @coordinator 先明确接口契约与严格文件所有权清单，广播至 @all。",
      "2. @worker-a 与 @worker-b 在各自独立工作区并行实现并自测，完成后直接 @verifier 交接。",
      "3. @verifier 独立跑类型检查、单测与边界审查，输出 PASS/FAIL 结论；未通过则退回对应 @worker。",
      "4. 验收全绿后 @coordinator 汇总交付清单并结束蜂群。",
    ],
    guardrails: [
      "严格文件所有权隔离，禁止两名写手编辑同一文件。",
      "验收员保持只读，不代改业务代码；发现缺陷必须由原作者修复并复测。",
    ],
  },
  {
    id: "multi-source-lit-verify",
    title: "多源文献深研+核验",
    aliases: ["文献深研", "lit-verify", "research-lit", "多源文献核验"],
    category: "research",
    summary: "多库并行检索、权威原文 Span 证据抽取与独立引用防幻觉核验（fail-closed）三段流水线。",
    channels: [
      { name: "main", topic: "研究问题定义、综述合成与最终交付" },
      { name: "search", topic: "OpenAlex / Crossref / arXiv / PubMed 多源去重检索" },
      { name: "evidence", topic: "原文 Span 定位、逐字 Quote 抽取与撤稿核验" },
    ],
    roles: [
      {
        name: "coordinator",
        role: "coordinator",
        workspace: "inherit",
        responsibility: "拆解研究子问题、汇总已核验论断并起草带规范角标的研究报告。",
      },
      {
        name: "lit-scout",
        role: "worker",
        workspace: "inherit",
        readOnly: true,
        responsibility: "跨 OpenAlex / Crossref / arXiv / PubMed 检索去重，输出候选文献清单与 OA 链接。",
      },
      {
        name: "evidence-analyst",
        role: "worker",
        workspace: "inherit",
        readOnly: true,
        responsibility: "从已入库权威文档抽取 verbatim quote 与 spanId/页码证据链，不编造引文。",
      },
      {
        name: "fact-verifier",
        role: "verifier",
        workspace: "inherit",
        readOnly: true,
        responsibility: "独立复核 DOI/arXiv 真实性、撤稿状态及论断对原文 span 的忠实度（fail-closed）。",
      },
    ],
    workflow: [
      "1. @coordinator 划定检索时间窗、关键词与核心研究问题。",
      "2. @lit-scout 完成多源检索与去重并导入文献库，交接 @evidence-analyst。",
      "3. @evidence-analyst 按原文 span 整理逐字证据表与正反方结论，交接 @fact-verifier。",
      "4. @fact-verifier 执行引用与撤稿核验，将未接地论断标为 unsupported/unchecked，交 @coordinator 终稿。",
    ],
    guardrails: [
      "遵循 quote-first 红线：所有关键定量论断必须绑定真实 docId + spanId。",
      "遇到撤稿或无法验证标识符的文献必须 fail-closed 标记，禁止静默通过。",
    ],
  },
  {
    id: "arch-deep-audit",
    title: "架构深度体检",
    aliases: ["架构体检", "arch-audit", "deep-audit", "架构审查"],
    category: "engineering",
    summary: "只读多维度并行体检：模块边界/债、安全鉴权/越界、性能热路径/内存泄漏三线审计并分级输出。",
    channels: [
      { name: "main", topic: "体检范围、P0/P1/P2 汇总与整改路线图" },
      { name: "audit", topic: "各维度取证路径、代码行号与交叉验证" },
    ],
    roles: [
      {
        name: "coordinator",
        role: "coordinator",
        workspace: "inherit",
        readOnly: true,
        responsibility: "划定审计范围、合并去重三线发现、按 P0/P1/P2 严重度排序并给出可落地修复计划。",
      },
      {
        name: "boundary-auditor",
        role: "verifier",
        workspace: "inherit",
        readOnly: true,
        responsibility: "审计包边界、循环依赖、大文件膨胀、契约漂移与向后兼容性。",
      },
      {
        name: "security-auditor",
        role: "verifier",
        workspace: "inherit",
        readOnly: true,
        responsibility: "审计鉴权/租户隔离、路径越界与符号链接攻击、命令/SQL 注入与敏感信息泄漏。",
      },
      {
        name: "perf-auditor",
        role: "verifier",
        workspace: "inherit",
        readOnly: true,
        responsibility: "审计事件循环阻塞、大文件全量读、缓存失效/泄漏、并发锁竞争与长尾超时。",
      },
    ],
    workflow: [
      "1. @coordinator 指定目标子系统、基线分支与重点风险假设。",
      "2. 三名审计员完全只读并行取证，每条发现必须附具体文件路径、行号与复现机理。",
      "3. 互审去重，剔除误报并确认严重度分级（P0 阻断 / P1 高危 / P2 改进）。",
      "4. @coordinator 输出结构化体检报告与分阶段整改清单。",
    ],
    guardrails: [
      "全员严格只读，体检期间不修改任何仓库源码。",
      "零猜测原则：每条缺陷必须有直接代码行号或实测证据支撑。",
    ],
  },
  {
    id: "multi-option-review",
    title: "多方案评审",
    aliases: ["方案评审", "option-review", "rfc-review", "架构选型"],
    category: "decision",
    summary: "稳健渐进派、架构重构派与红队反方三视角对抗评审，产出量化决策矩阵与回滚预案。",
    channels: [
      { name: "main", topic: "决策背景、对比矩阵与最终选型建议" },
      { name: "debate", topic: "多方案提案与红队质询交锋" },
    ],
    roles: [
      {
        name: "coordinator",
        role: "coordinator",
        workspace: "inherit",
        readOnly: true,
        responsibility: "定义评判维度与硬约束，主持方案质询，收敛形成决策矩阵与最终推荐。",
      },
      {
        name: "proposer-conservative",
        role: "worker",
        workspace: "inherit",
        readOnly: true,
        responsibility: "提出低风险、最小改动、高向后兼容性的渐进方案，给出工期与收益。",
      },
      {
        name: "proposer-radical",
        role: "worker",
        workspace: "inherit",
        readOnly: true,
        responsibility: "提出面向长期演进的根治/重构方案，量化架构红利与迁移步骤。",
      },
      {
        name: "devil-advocate",
        role: "verifier",
        workspace: "inherit",
        readOnly: true,
        responsibility: "担任红队反方：逐一拆解两套方案的隐含假设、边界故障、运维与回滚成本。",
      },
    ],
    workflow: [
      "1. @coordinator 发布问题背景、约束条件与评分维度（风险/工期/维护性/可回滚性）。",
      "2. @proposer-conservative 与 @proposer-radical 独立提交方案，避免相互锚定。",
      "3. @devil-advocate 针对两套方案发起结构化红队质询，指出最致命失效模式。",
      "4. @coordinator 综合质询结果产出对比矩阵、推荐选项及灰度回滚预案。",
    ],
    guardrails: [
      "双提案阶段独立发帖，避免过早趋同。",
      "最终推荐必须附带明确的不选理由与可验证的回滚路径。",
    ],
  },
  {
    id: "research-write-review-revise",
    title: "论文写作+盲审+批判修订",
    aliases: [
      "写审修",
      "write-review-revise",
      "论文盲审修订",
      "科研双版修订",
    ],
    category: "research",
    summary:
      "跨强模型主笔撰稿（metrics.json 单源绑定 + 静态预检）、保真双盲审稿（oc-docx extract --latex）与跨轮裁决账本 P0 收敛放行闭环，最终交付干净版 + Word 标黄 Diff 修订双版与去 AI 味体检报告。",
    channels: [
      { name: "main", topic: "选题范围、P0 收敛闸门结论与双版 DOCX 交付清单" },
      { name: "draft", topic: "初稿撰写、metrics.json 单源数值绑定、oc-cite 引用接地与 oc-docx check 静态预检" },
      { name: "review", topic: "保真读稿盲审、decision-ledger 裁决账本与 P0/P1/P2 收敛核验" },
    ],
    roles: [
      {
        name: "coordinator",
        role: "coordinator",
        workspace: "inherit",
        responsibility: "明确投稿体裁与引用格式（GB/T 7714/APA/IEEE/Nature），统筹写→静态预检→盲审→批判修订节奏，运行 `oc-review collate --ledger /home/agent/.openclaude/generated/review-<ts>/decision-ledger.json` 执行 P0 归零收敛闸门并核验收口双版产物。",
      },
      {
        name: "author-writer",
        role: "worker",
        workspace: "share",
        responsibility: "基于已入库权威文献撰写初稿（强制 oc-cite 校验、A/B 证据分级与 `metrics.json` 单源数值绑定），通过 `oc-docx check --expect-formulas` 静态预检后产出基准稿 base.docx。",
      },
      {
        name: "blind-reviewer",
        role: "verifier",
        workspace: "inherit",
        readOnly: true,
        responsibility: "独立只读盲审：先用 `oc-docx extract --latex` 保真读稿（大稿按 `--toc`/`--section` 分片读，防丢公式/炸链），按 P0（数学物理/代码数值/引文/硬矛盾）与 P1/P2（论证与风格）硬分级输出结构化评审 JSON。",
      },
      {
        name: "revision-editor",
        role: "worker",
        workspace: "share",
        responsibility: "逐条回应审稿意见完成批判修订，已采纳或带证据驳回条目写入会话独立账本 `/home/agent/.openclaude/generated/review-<ts>/decision-ledger.json`（`oc-review ledger record`）防跨轮翻案，过 `oc-docx check --expect-formulas`、`oc-docx diff` 生成干净版+标黄修订双版并通过 `oc-stylecheck` 门禁。",
      },
    ],
    workflow: [
      "1. @coordinator 划定论文结构、目标期刊引用规范与去 AI 味风格基线，并执行 `oc-review ledger init --file /home/agent/.openclaude/generated/review-<ts>/decision-ledger.json` 初始化本次评审独立的跨轮裁决账本。",
      "2. @author-writer 完成初稿并绑定 `metrics.json` 单源实验数值，经 `oc-cite` 核验引文与 A/B 级证据、过 `oc-docx check --expect-formulas` 静态预检后导出 base.docx 交接 @blind-reviewer。",
      "3. @blind-reviewer 严格只读执行独立盲审：用 `oc-docx extract --latex`（大稿先 `--toc` 再 `--section` 分片）保真读稿，按 P0/P1/P2 分级输出结构化评审 JSON 交接汇总。",
      "4. @coordinator 汇总多模型评审执行 `oc-review collate --dir <dir> --ledger /home/agent/.openclaude/generated/review-<ts>/decision-ledger.json` 检查收敛闸门；若有活跃 P0，由 @revision-editor 逐条批判修订并把已采纳/带证据驳回条文记入该账本。",
      "5. @revision-editor 产出 revised.docx 后强制通过 `oc-docx check --expect-formulas`（零残余占位符、交叉引用闭环、OMML 零乱码、渲染行尾标点无丢失）、`oc-docx diff` 双版交付与 `oc-stylecheck` 门禁；复核达 `gate.status === PASS_READY`（活跃 P0=0）即收敛交付。",
    ],
    guardrails: [
      "严格执行 quote-first、A/B 级证据分级（A=本地全文逐字核验，B=仅摘要/题录元数据）与 `metrics.json` 单源数值绑定，禁止臆造引文或手抄篡改实验数据。",
      "审稿前必须用 `oc-docx extract --latex` 保真读稿（大稿按 `--toc`/`--section` 分片读），严禁裸抽纯文本丢公式或超长原文直接塞入上下文。",
      "初稿与修订稿均须强制过 `oc-docx check --expect-formulas`（拦截残余占位符、断号交叉引用、OMML 乱码与渲染行尾标点丢失）、`oc-docx diff` 双版核验与 `oc-stylecheck` 去 AI 味扫描。",
      "盲审员保持只读且不与主笔串通；多轮汇总必须经 `oc-review collate --ledger /home/agent/.openclaude/generated/review-<ts>/decision-ledger.json` 执行 P0 归零收敛闸门——已带证据驳回/采纳意见写入会话独立账本防 Flip-Flop，P0=0（PASS_READY）即收敛交付，禁止为交差无休止拉锯挑刺。",
    ],
  },
  {
    id: "research-controlled-exp-loop",
    title: "受控实验循环（防刷分）",
    aliases: [
      "受控实验",
      "controlled-exp",
      "exp-loop",
      "防刷分实验循环",
    ],
    category: "research",
    summary:
      "锁定评测集与评判脚本防 Reward Hacking，按「假设→单变量改动→复现实验→独立锁评测审计」闭环推进受控实验迭代。",
    channels: [
      { name: "main", topic: "研究假设、基线指标与最终实验结论" },
      { name: "experiment", topic: "单变量改动记录、随机种子与实验原始输出" },
      { name: "eval-audit", topic: "评测集哈希锁校验、统计显著性与消融复核" },
    ],
    roles: [
      {
        name: "coordinator",
        role: "coordinator",
        workspace: "inherit",
        responsibility: "制定研究假设与评测锁定清单，记录每轮迭代指标账本，基于统计证据决定继续、回退或收敛交付。",
      },
      {
        name: "exp-engineer",
        role: "worker",
        workspace: "share",
        responsibility: "在严格不改动锁定评测代码/测试集的前提下，每轮仅执行一个明确假设驱动的单变量实验改动并保留完整运行日志。",
      },
      {
        name: "eval-guardian",
        role: "verifier",
        workspace: "inherit",
        readOnly: true,
        responsibility: "独立只读守护评测完整性：校验评测脚本/测试集哈希零篡改、排查数据泄漏与过拟合刷分（Reward Hacking），复跑验证结果可复现。",
      },
      {
        name: "ablation-analyst",
        role: "worker",
        workspace: "inherit",
        readOnly: true,
        responsibility: "汇总多轮对比指标、执行消融与误差分析、用科学绘图与 oc-figcheck 输出出版级实验图表。",
      },
    ],
    workflow: [
      "1. @coordinator 与 @eval-guardian 先记录锁定评测脚本、测试集切分与基线分数的 SHA-256 指纹并广播 @all。",
      "2. @exp-engineer 提出单一可证伪假设并实施最小单变量改动，跑完固定随机种子实验后交接 @eval-guardian。",
      "3. @eval-guardian 核查评测文件零篡改、零测试集泄漏并独立复跑核验指标；发现 Reward Hacking 立即判 FAIL 并退回。",
      "4. 有效增益经 @ablation-analyst 补齐消融对比与统计分析，由 @coordinator 汇总可复现实验报告与图表。",
    ],
    guardrails: [
      "严禁修改、放宽或绕过锁定的评测脚本、测试集切分与指标计算公式（零容忍 Reward Hacking）。",
      "每轮实验只允许单变量改动，必须记录随机种子、命令、基线对照与失败实验（禁止只报喜不报忧）。",
      "评测守护员保持只读，未通过完整性与可复现核验的分数不得进入结论。",
    ],
  },
]);

export function listSwarmPlaybooks(): readonly SwarmPlaybookTemplate[] {
  return SWARM_PLAYBOOK_TEMPLATES;
}

export function getSwarmPlaybook(idOrAlias: string): SwarmPlaybookTemplate | null {
  const key = idOrAlias.trim().toLowerCase();
  if (!key) return null;
  for (const tpl of SWARM_PLAYBOOK_TEMPLATES) {
    if (tpl.id === key || tpl.title.toLowerCase() === key) return tpl;
    if (tpl.aliases.some((a) => a.toLowerCase() === key)) return tpl;
  }
  return null;
}

export interface ExpandSwarmPlaybookOptions {
  constraints?: readonly string[];
  extraContext?: string;
}

export interface ExpandedSwarmPlaybook {
  template: SwarmPlaybookTemplate;
  task: string;
  roles: readonly SwarmPlaybookRoleSpec[];
  channels: readonly { name: string; topic: string }[];
  kickoffBoardMessage: string;
  prompt: string;
}

/** 将指定高阶剧本模板与具体任务展开为可执行 Swarm 启动提示与首条讨论板指引。 */
export function expandSwarmPlaybook(
  idOrAlias: string,
  task: string,
  opts: ExpandSwarmPlaybookOptions = {},
): ExpandedSwarmPlaybook | null {
  const template = getSwarmPlaybook(idOrAlias);
  if (!template) return null;
  const cleanTask = task.trim();
  if (!cleanTask) return null;

  const roleLines = template.roles
    .map(
      (r) =>
        `- **${r.name}** (${r.role}, workspace=${r.workspace}${r.readOnly ? ", 只读" : ""}): ${r.responsibility}`,
    )
    .join("\n");
  const channelLines = template.channels.map((c) => `- #${c.name}: ${c.topic}`).join("\n");
  const workflowLines = template.workflow.join("\n");
  const guardrailLines = [
    ...template.guardrails,
    ...(opts.constraints ?? []).map((c) => c.trim()).filter(Boolean),
  ]
    .map((g) => `- ${g}`)
    .join("\n");

  const prompt = [
    `【Swarm 剧本：${template.title} (${template.id})】`,
    `目标任务：${cleanTask}`,
    opts.extraContext?.trim() ? `补充上下文：\n${opts.extraContext.trim()}` : "",
    `角色编排：\n${roleLines}`,
    `频道规划：\n${channelLines}`,
    `执行流程：\n${workflowLines}`,
    `硬约束与红线：\n${guardrailLines}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const kickoffBoardMessage = `@all 启动剧本「${template.title}」：${cleanTask}。请按各自角色与红线推进，阶段交接直接 @下一环节负责人。`;

  return {
    template,
    task: cleanTask,
    roles: template.roles,
    channels: template.channels,
    kickoffBoardMessage,
    prompt,
  };
}

// ── 操作员斜杠控制命令解析 ────────────────────────────────────────────────────

export type ParsedSwarmControlCommand =
  | { kind: "steer"; target: string; message: string }
  | { kind: "kill"; memberName: string; reason?: string }
  | { kind: "playbook"; templateId: string; task: string };

/**
 * 解析操作员 Swarm 控制命令:
 *   - `/swarm-steer @worker <纠偏内容>`
 *   - `/swarm-kill <memberName> [原因]`
 *   - `/swarm-playbook <templateId|中文名> <任务说明>`
 */
export function parseSwarmControlCommand(raw: string): ParsedSwarmControlCommand | null {
  const trimmed = raw.trim();
  const steer = /^\/swarm-steer\s+(@?[A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+([\s\S]+)$/i.exec(trimmed);
  if (steer) {
    return {
      kind: "steer",
      target: normalizeTargetName(steer[1]!),
      message: steer[2]!.trim(),
    };
  }
  const kill = /^\/swarm-kill\s+(@?[A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (kill) {
    const reason = kill[2]?.trim();
    return {
      kind: "kill",
      memberName: normalizeTargetName(kill[1]!),
      ...(reason ? { reason } : {}),
    };
  }
  const playbook = /^\/swarm-playbook\s+(\S+)\s+([\s\S]+)$/i.exec(trimmed);
  if (playbook) {
    return {
      kind: "playbook",
      templateId: playbook[1]!.trim(),
      task: playbook[2]!.trim(),
    };
  }
  return null;
}

// ── 正式 HTTP 路由处理器: POST /api/sessions/:id/swarm/command (B5) ───────────

export interface ResolvedSessionSwarmTarget {
  brainDir: string;
  conversationId: string;
  confirmByExecutor?: (memberName: string, reason: string) => boolean;
}

export interface SwarmCommandRouteDeps {
  /** 认证调用方并返回唯一 `userId`(认证失败返回 null → 401)。 */
  authenticate: (req: IncomingMessage) => Promise<{ id: string } | null>;
  /**
   * 校验 `sessionId` 归属于 `userId` 并返回服务端持有的 `{ brainDir, conversationId }`。
   * 绝不接受客户端传入任意 `brainDir`!
   * 返回 `null` → 404,返回 `'forbidden'` → 403。
   */
  resolveSessionSwarm: (
    userId: string,
    sessionId: string,
  ) => Promise<ResolvedSessionSwarmTarget | "forbidden" | null>;
  now?: () => number;
}

function sendRouteJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

async function readCommandBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_COMMAND_BODY_BYTES) {
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function mapSwarmFailureStatus(code: SwarmCommandErrorCode): number {
  switch (code) {
    case "INVALID_CONVERSATION_ID":
    case "INVALID_TARGET":
    case "INVALID_MESSAGE":
      return 400;
    case "SYMLINK_REJECTED":
    case "CANNOT_KILL_COORDINATOR":
      return 403;
    case "SWARM_NOT_FOUND":
    case "MEMBER_NOT_FOUND":
      return 404;
    case "MEMBER_ALREADY_KILLED":
    case "LOCK_CONTENTION":
      return 409;
    default:
      return 500;
  }
}

/**
 * `POST /api/sessions/:id/swarm/command`
 * 认证 uid → 校验 session 归属 → 解析服务端持有 swarm 目录 → 执行 steer / terminate / playbook。
 */
export async function handleSwarmCommandRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SwarmCommandRouteDeps,
): Promise<void> {
  if (req.method !== "POST") {
    sendRouteJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "POST required" });
    return;
  }
  const user = await deps.authenticate(req);
  if (!user || !user.id) {
    sendRouteJson(res, 401, { ok: false, code: "UNAUTHORIZED", error: "authentication required" });
    return;
  }

  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  const match = SWARM_COMMAND_ROUTE_RE.exec(pathname);
  if (!match) {
    sendRouteJson(res, 404, { ok: false, code: "NOT_FOUND", error: "swarm command route not found" });
    return;
  }
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]!).trim();
  } catch {
    sendRouteJson(res, 400, { ok: false, code: "INVALID_SESSION_ID", error: "invalid session id encoding" });
    return;
  }
  if (!sessionId) {
    sendRouteJson(res, 400, { ok: false, code: "INVALID_SESSION_ID", error: "sessionId required" });
    return;
  }

  let body: Record<string, unknown> | null;
  try {
    body = await readCommandBody(req);
  } catch (err) {
    if ((err as Error).message === "BODY_TOO_LARGE") {
      sendRouteJson(res, 413, { ok: false, code: "BODY_TOO_LARGE", error: "command payload exceeds limit" });
      return;
    }
    sendRouteJson(res, 400, { ok: false, code: "INVALID_JSON", error: "invalid JSON body" });
    return;
  }
  if (!body) {
    sendRouteJson(res, 400, { ok: false, code: "INVALID_BODY", error: "JSON object body required" });
    return;
  }

  // 安全硬约束(B5):显式拒绝客户端自传 brainDir 试图越权访问服务器目录
  if ("brainDir" in body) {
    sendRouteJson(res, 400, { ok: false, code: "FORBIDDEN_FIELD", error: "client-supplied brainDir is not allowed" });
    return;
  }

  const targetSwarm = await deps.resolveSessionSwarm(user.id, sessionId);
  if (targetSwarm === "forbidden") {
    sendRouteJson(res, 403, { ok: false, code: "FORBIDDEN", error: "session does not belong to user" });
    return;
  }
  if (!targetSwarm) {
    sendRouteJson(res, 404, { ok: false, code: "SWARM_NOT_FOUND", error: "no active swarm for session" });
    return;
  }

  const now = deps.now ? deps.now() : Date.now();
  const sender = `user:${user.id}`;

  // 支持原始斜杠命令文本 `{ command: "/swarm-steer ..." }`
  let action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  let target = typeof body.target === "string" ? body.target : "";
  let message = typeof body.message === "string" ? body.message : "";
  let memberName = typeof body.memberName === "string" ? body.memberName : target;
  let reason = typeof body.reason === "string" ? body.reason : undefined;
  let templateId = typeof body.templateId === "string" ? body.templateId : "";
  let task = typeof body.task === "string" ? body.task : "";

  if (!action && typeof body.command === "string") {
    const parsedCmd = parseSwarmControlCommand(body.command);
    if (!parsedCmd) {
      sendRouteJson(res, 400, { ok: false, code: "INVALID_COMMAND", error: "unrecognized swarm control command" });
      return;
    }
    if (parsedCmd.kind === "steer") {
      action = "steer";
      target = parsedCmd.target;
      message = parsedCmd.message;
    } else if (parsedCmd.kind === "kill") {
      action = "kill";
      memberName = parsedCmd.memberName;
      reason = parsedCmd.reason;
    } else {
      action = "playbook";
      templateId = parsedCmd.templateId;
      task = parsedCmd.task;
    }
  }

  if (action === "steer") {
    const result = await injectSwarmDirective({
      brainDir: targetSwarm.brainDir,
      conversationId: targetSwarm.conversationId,
      target,
      message,
      channel: typeof body.channel === "string" ? body.channel : undefined,
      sender,
      now,
    });
    sendRouteJson(res, result.ok ? 200 : mapSwarmFailureStatus(result.code), result);
    return;
  }

  if (action === "kill" || action === "terminate") {
    const result = await terminateSwarmMember({
      brainDir: targetSwarm.brainDir,
      conversationId: targetSwarm.conversationId,
      memberName,
      reason,
      sender,
      now,
      confirmByExecutor: targetSwarm.confirmByExecutor,
    });
    sendRouteJson(res, result.ok ? 200 : mapSwarmFailureStatus(result.code), result);
    return;
  }

  if (action === "playbook") {
    const constraints = Array.isArray(body.constraints)
      ? body.constraints.filter((c): c is string => typeof c === "string")
      : undefined;
    const expanded = expandSwarmPlaybook(templateId, task, { constraints });
    if (!expanded) {
      sendRouteJson(res, 400, { ok: false, code: "INVALID_PLAYBOOK", error: "unknown playbook template or empty task" });
      return;
    }
    const kickoff =
      body.postKickoff === true
        ? await injectSwarmDirective({
            brainDir: targetSwarm.brainDir,
            conversationId: targetSwarm.conversationId,
            target: "all",
            message: expanded.kickoffBoardMessage,
            sender,
            now,
          })
        : undefined;
    sendRouteJson(res, 200, { ok: true, playbook: expanded, ...(kickoff ? { kickoff } : {}) });
    return;
  }

  sendRouteJson(res, 400, { ok: false, code: "INVALID_ACTION", error: "action must be steer, terminate/kill, or playbook" });
}
