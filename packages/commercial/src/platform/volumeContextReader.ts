/**
 * VolumeContextReader — 跨主机统一读取 per-user OpenClaude 用户级 context
 * (USER.md / MEMORY.md / SKILLS frontmatter)。
 *
 * 见 docs/V3_CC_EXTERNAL_ENDPOINT_PHASE5_PLAN_2026-05-21.md §3.6。
 *
 * 三种实现:
 *   - makeLocalVolumeReader  — master 自身托管用户容器时,直接 fs.readFile
 *     `/var/lib/docker/volumes/oc-v3-data-u<uid>/_data/agents/main/...`
 *   - makeRemoteVolumeReader — 用户容器在远端 host(boheyun 等)时,通过
 *     node-agent mTLS RPC GET /v1/users/<uid>/openclaude-context
 *   - makeRoutingVolumeReader — 顶层 entry,用 findUserDataHost(packages/
 *     commercial/src/compute-pool/queries.ts:1460)按 host 调度
 *
 * 错误语义统一(本 reader 接口契约):
 *   - 成功 → 返回 PlatformContext(三段允许空字符串,skills 允许空数组)
 *   - 用户从未启过容器(没 agent_containers 行 OR volume 不存在)→ 返 null
 *   - 基础设施失败(网络 / cert / fs IO 错)→ throw,由 loader 层 fallback
 *
 * 不在本层做缓存 / TTL / fallback —— 那些是 platformContextLoader 的职责。
 */

import { promises as fsp } from "node:fs";
import { join } from "node:path";

import { getRuntimeChannel } from "../runtimeChannel.js";

import {
  AgentAppError,
  getUserOpenClaudeContext,
  hostRowToTarget,
  type PlatformContextResponse,
} from "../compute-pool/nodeAgentClient.js";
import {
  findUserDataHost,
  getHostById,
  getSelfHost,
} from "../compute-pool/queries.js";

/** 平台 context 数据,跟 node-agent Response 同形态(camelCase TS)。 */
export interface PlatformContext {
  userMd: string;
  memoryMd: string;
  skills: Array<{ name: string; description: string }>;
  /** 三类文件 max(mtime);全缺失时为 null。用于 loader mtime invalidation。 */
  volumeMtime: Date | null;
}

export interface VolumeContextReader {
  /**
   * 读用户 OpenClaude context。
   *
   * 返 null:用户从未启过容器(容器行不存在 OR volume 不存在)。
   *           这是正常路径,caller 应注入空 attribution block。
   * 抛错:网络 / cert / fs IO 错。caller(loader 层)按 R10 fallback 到空 context。
   */
  read(userId: bigint): Promise<PlatformContext | null>;
}

// ─── Local reader (master 自托管路径) ───────────────────────────────────

const SKILL_HEAD_BYTES = 4 * 1024;
const FILE_CAP_BYTES = 256 * 1024;
const MAX_SKILL_COUNT = 200;

const DEFAULT_VOLUME_BASE_DIR = "/var/lib/docker/volumes";

function volumeRoot(userId: bigint, baseDir: string): string {
  // 与 packages/commercial/node-agent/internal/containers/volumes.go reVolumeName 对齐
  // P1a:channel 化 —— v3 → oc-v3-data(不变)、v5 → oc-v5-data(node-agent Go 侧 reVolumeName
  // 加 oc-v5-* 白名单留 P1d;v5 远程卷路径当前不走,本机 local-only)。
  return join(baseDir, `oc-${getRuntimeChannel()}-data-u${userId.toString()}`, "_data");
}

function agentMainRoot(userId: bigint, baseDir: string): string {
  return join(volumeRoot(userId, baseDir), "agents", "main");
}

/**
 * 读单文件,cap 到 FILE_CAP_BYTES;返 {text, mtime} or null(不存在)。
 * 任何其它 IO 错抛出。
 *
 * 实现:用 fsp.open + fh.read(Buffer.alloc(cap), 0, cap, 0) 真正分配 cap 大小 buffer,
 * 内核只 copy 前 cap 字节,避免 fsp.readFile 把整个文件读进内存再 slice 的浪费 ——
 * Go 端用 io.ReadFull 已经是 bounded read,TS 端这里跟齐(Codex Phase 5 round-1 MAJOR)。
 *
 * 文件 > cap 时只读到 cap 自然截断(剩余字节未 copy 入 buf);
 * 文件 ≤ cap 时 bytesRead === 文件长度,等价短读。
 */
async function readCappedFile(
  path: string,
): Promise<{ text: string; mtime: Date } | null> {
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (!stat.isFile()) return null;
  const fh = await fsp.open(path, "r");
  try {
    const buf = Buffer.alloc(FILE_CAP_BYTES);
    const { bytesRead } = await fh.read(buf, 0, FILE_CAP_BYTES, 0);
    return { text: buf.slice(0, bytesRead).toString("utf8"), mtime: stat.mtime };
  } finally {
    await fh.close();
  }
}

/** parse skill SKILL.md frontmatter 抽 name + description(与 Go 端逻辑同构)。 */
function parseFrontmatter(head: string): { name: string; description: string } {
  if (!head.startsWith("---\n") && !head.startsWith("---\r\n")) {
    return { name: "", description: "" };
  }
  const nlIdx = head.indexOf("\n");
  const rest = head.slice(nlIdx + 1);
  let endIdx = rest.indexOf("\n---");
  if (endIdx < 0) endIdx = rest.length;
  const fm = rest.slice(0, endIdx);
  let name = "";
  let description = "";
  for (const rawLine of fm.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    if (key === "name") name = val;
    else if (key === "description") description = val;
  }
  return { name, description };
}

async function readLocalSkills(
  skillsDir: string,
): Promise<{ skills: PlatformContext["skills"]; maxMtime: Date | null }> {
  let entries;
  try {
    entries = await fsp.readdir(skillsDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { skills: [], maxMtime: null };
    throw e;
  }
  const skills: PlatformContext["skills"] = [];
  let maxMtime: Date | null = null;
  let count = 0;
  for (const e of entries) {
    if (count >= MAX_SKILL_COUNT) break;
    if (!e.isDirectory()) continue;
    const mdPath = join(skillsDir, e.name, "SKILL.md");
    let stat;
    try {
      stat = await fsp.stat(mdPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (!stat.isFile()) continue;
    if (!maxMtime || stat.mtime > maxMtime) maxMtime = stat.mtime;
    // 只读头部 4 KiB 给 frontmatter
    const fh = await fsp.open(mdPath, "r");
    try {
      const buf = Buffer.alloc(SKILL_HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, SKILL_HEAD_BYTES, 0);
      const head = buf.slice(0, bytesRead).toString("utf8");
      const { name, description } = parseFrontmatter(head);
      skills.push({ name: name || e.name, description });
      count++;
    } finally {
      await fh.close();
    }
  }
  // 排序保证多机一致(fs readdir 顺序不稳定)
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { skills, maxMtime };
}

/**
 * 本地 reader:直接读 /var/lib/docker/volumes/...
 *
 * 必须以能访问 docker volume mountpoint 的权限运行(master 进程 root 实测可读)。
 * volume 整个不存在 → 返 null;局部文件缺失 → 该字段空串。
 *
 * `opts.volumeBaseDir` 是测试 hook:生产路径不传,默认 `/var/lib/docker/volumes`;
 * 单测里通过 tmpdir 注入,跑真 fs 不动产线行为。
 */
export function makeLocalVolumeReader(
  opts: { volumeBaseDir?: string } = {},
): VolumeContextReader {
  const baseDir = opts.volumeBaseDir ?? DEFAULT_VOLUME_BASE_DIR;
  return {
    async read(userId) {
      // volume 不存在 → 用户从未启过容器,返 null
      try {
        await fsp.access(volumeRoot(userId, baseDir));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
      const root = agentMainRoot(userId, baseDir);
      const vroot = volumeRoot(userId, baseDir);
      // USER.md → user-level shared (volume root `user.md`). MEMORY.md stays main's
      // per-agent memory *index* (memdir 范式:marker + `- [title](memory/x.md) — hook`
      // lines,不再是旧 §-blob working notes;路径不变,故本 reader 零改动). skills →
      // user-level shared library (volume root `skills/`) post skill-sharing — both no
      // longer under agents/main.
      const userFile = await readCappedFile(join(vroot, "user.md"));
      const memoryFile = await readCappedFile(join(root, "MEMORY.md"));
      const { skills, maxMtime: skillMtime } = await readLocalSkills(join(vroot, "skills"));
      const mtimes: Date[] = [];
      if (userFile) mtimes.push(userFile.mtime);
      if (memoryFile) mtimes.push(memoryFile.mtime);
      if (skillMtime) mtimes.push(skillMtime);
      const maxMtime = mtimes.length ? mtimes.reduce((a, b) => (a > b ? a : b)) : null;
      return {
        userMd: userFile?.text ?? "",
        memoryMd: memoryFile?.text ?? "",
        skills,
        volumeMtime: maxMtime,
      };
    },
  };
}

// ─── Remote reader (node-agent RPC) ────────────────────────────────────

/**
 * 远端 reader:走 node-agent mTLS RPC。hostUuid 用于 getHostById 拿 ComputeHostRow,
 * 构造 NodeAgentTarget(含 psk 解密)。
 *
 * 404 VOLUME_NOT_FOUND → 返 null(用户未在该 host 启过容器)。
 * 其它失败透出(网络 / cert / 5xx),由 loader 层 fallback。
 */
export function makeRemoteVolumeReader(deps: {
  loadHostRow: (hostUuid: string) => Promise<import("../compute-pool/types.js").ComputeHostRow | null>;
  rpc?: typeof getUserOpenClaudeContext;
  /** 生产路径必传 hostUuid(由 routing reader 注入)。 */
  hostUuid: string;
  /** 测试 hook;默认 hostRowToTarget。 */
  toTarget?: typeof hostRowToTarget;
}): VolumeContextReader {
  const rpc = deps.rpc ?? getUserOpenClaudeContext;
  const toTarget = deps.toTarget ?? hostRowToTarget;
  return {
    async read(userId) {
      const row = await deps.loadHostRow(deps.hostUuid);
      if (!row) {
        // host 行不存在 — 数据库层异常状态,抛错而非 silent null
        throw new Error(`makeRemoteVolumeReader: hostUuid ${deps.hostUuid} not found in compute_hosts`);
      }
      // A3 — 终态 revoked host 不再做 volume context RPC(deny)。
      if (row.status === "revoked") {
        throw new Error(`makeRemoteVolumeReader: hostUuid ${deps.hostUuid} revoked`);
      }
      const target = toTarget(row);
      target.requireFingerprint = true;
      try {
        const resp = await rpc(target, userId);
        return mapResponseToContext(resp);
      } catch (e) {
        if (e instanceof AgentAppError && e.httpStatus === 404) {
          // VOLUME_NOT_FOUND 走 null 路径(server agentErrCode === "VOLUME_NOT_FOUND",
          // 但 client 不依赖 errCode 字面 — 404 即可)
          return null;
        }
        throw e;
      } finally {
        if (target.psk) target.psk.fill(0);
      }
    },
  };
}

function mapResponseToContext(resp: PlatformContextResponse): PlatformContext {
  return {
    userMd: resp.userMd,
    memoryMd: resp.memoryMd,
    skills: resp.skills,
    volumeMtime: resp.volumeMtime ? new Date(resp.volumeMtime) : null,
  };
}

// ─── Routing reader (顶层 entry) ────────────────────────────────────────

/**
 * 顶层调度:
 *   1. findUserDataHost(userId) → 拿 hostUuid + containerState
 *   2. 若 hostUuid === self host id → 走 local reader
 *   3. 否则 → 走 remote reader(以 hostUuid 构造)
 *   4. findUserDataHost 返 null(用户从未启过容器)→ 直接返 null
 *
 * 注:不预判 host.status === 'ready' — vanished container 仍可能 host fs 可读;
 * 真不通在 reader 层会抛,loader 层 fallback。
 */
export function makeRoutingVolumeReader(deps: {
  local: VolumeContextReader;
  /** 工厂:按 hostUuid 现造 remote reader(避免预先构造所有 host 的 reader)。 */
  makeRemote: (hostUuid: string) => VolumeContextReader;
  /** 测试 hook;默认调 queries.findUserDataHost。 */
  findUserDataHost?: typeof findUserDataHost;
  /** 测试 hook;默认调 queries.getSelfHost。 */
  getSelfHost?: typeof getSelfHost;
}): VolumeContextReader {
  const findHost = deps.findUserDataHost ?? findUserDataHost;
  const fetchSelf = deps.getSelfHost ?? getSelfHost;

  // self host id 缓存:整个 master 进程生命周期不变,首次查询后冻结
  let selfHostId: string | null = null;
  const ensureSelfId = async (): Promise<string> => {
    if (selfHostId !== null) return selfHostId;
    const self = await fetchSelf();
    selfHostId = self.id;
    return selfHostId;
  };

  return {
    async read(userId) {
      // findUserDataHost 入参 userId 是 number(queries 内部 SQL bigint 参数会自动接受);
      // 直接传 Number(userId) 即可,但 bigint > Number.MAX_SAFE 时会丢精度。
      // master DB 当前 user_id 是 BIGINT,但实际值远低于 2^53,Number 安全。
      const idNum = Number(userId);
      if (!Number.isSafeInteger(idNum) || idNum <= 0) {
        throw new Error(`routing reader: unsafe userId ${userId.toString()}`);
      }
      const host = await findHost(idNum);
      if (!host) return null; // 用户从未启过容器

      const selfId = await ensureSelfId();
      if (host.hostUuid === selfId) {
        return deps.local.read(userId);
      }
      return deps.makeRemote(host.hostUuid).read(userId);
    },
  };
}

/**
 * 生产环境 wiring helper — 把 local + remote(用 getHostById 加载 host row)+
 * routing 串起来。caller 通常在 builder 层直接拿这个。
 */
export function makeDefaultVolumeContextReader(): VolumeContextReader {
  const local = makeLocalVolumeReader();
  return makeRoutingVolumeReader({
    local,
    makeRemote: (hostUuid) =>
      makeRemoteVolumeReader({
        loadHostRow: getHostById,
        hostUuid,
      }),
  });
}
