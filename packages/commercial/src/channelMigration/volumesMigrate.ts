// channelMigration/volumesMigrate.ts
//
// P4 — L3 每用户容器卷迁移(记忆/技能/cron/上传/generated/会话转录/容器 sessions.db)。
//
// 同一用户在 v3/v5 是两组各 5 个独立 docker 卷,仅前缀 oc-v3-* vs oc-v5-* 不同、uid 后缀
// 相同(命名权威 = v3supervisor.volumeNameForChannel)。迁移 = 把 v3 卷 _data 目录 rsync 到
// 同名 v5 卷。存储格式字节兼容(storage 层已验),原样复制无需 ETL。
//
// 安全不变量(fail-closed):
//   1. **v3 容器必须已停(state='vanished')** 才拷 —— 否则活跃写入会拷到撕裂的 SQLite。
//      切换栅栏(P5)先 stopAndRemoveV3Container 再调本函数;预热 sweeper 只挑已 idle-swept
//      的用户。容器优雅停止时其 data 卷内 sessions.db 已 wal_checkpoint(TRUNCATE),整目录
//      rsync(含 -wal/-shm)天然一致。
//   2. **v3 卷必须在 self host(kl-mirror)** —— v5 是 local-only。远端 host 的卷 fail-closed
//      报错(需先 consolidate 到 self host,见 P0;node-agent 跨机拉取为 P1 后续)。
// 幂等:rsync --delete 使 v5 卷收敛到 v3 当前态,可安全重跑(预热 + 栅栏最后 delta)。
// codex 卷跳过(v5 已删 codex)。

import { spawn } from "node:child_process";
import type Docker from "dockerode";
import {
  V3_MANAGED_LABEL_KEY,
  V3_UID_LABEL_KEY,
  type V3VolumeRole,
  volumeNameForChannel,
} from "../agent-sandbox/v3supervisor.js";
import { RUNTIME_CHANNEL_LABEL_KEY } from "../compute-pool/containerService.js";
import { query } from "../db/queries.js";
import { withAudit } from "./audit.js";
import { normUid } from "./channelState.js";

// 实际迁移的 role:data/proj 是 P0 核心(会话/记忆/技能/上传全在 data,转录在 proj);
// userlocal/userconfig 是 P1(pip/npm 缓存与工具配置,可重建但拷了免重装);codex 跳过。
const MIGRATE_ROLES: readonly V3VolumeRole[] = ["data", "proj", "userlocal", "userconfig"];

export interface VolumesMigrationDeps {
  docker: Docker;
  /** 本机(v5 master)在 compute_hosts 的 canonical uuid,用于判 v3 卷是否本机。 */
  selfHostUuid: string;
}

export interface RoleMigrationOutcome {
  role: V3VolumeRole;
  v3Volume: string;
  v5Volume?: string;
  copied: boolean;
  bytes?: number;
  skipped?: string;
}

export interface VolumesMigrationOutcome {
  /** v3 容器所在 host uuid;null 表示该用户从无 v3 容器(无卷可迁)。 */
  v3HostUuid: string | null;
  roles: RoleMigrationOutcome[];
}

interface V3ContainerRow {
  host_uuid: string | null;
  state: string;
}

/** 取该用户"当前" v3 容器行(active 优先,再取最新)。无 v3 footprint 返回 null。 */
async function latestV3Container(uid: string): Promise<V3ContainerRow | null> {
  // active 优先(最多一行,唯一索引保证);否则取最近活动过的那行(last_started_at 更能反映
  // "当前/最后一次真正跑起来的容器落点",防历史残留 vanished 行选到错误 host)。
  const r = await query<V3ContainerRow>(
    `SELECT host_uuid, state FROM agent_containers
      WHERE user_id = $1 AND runtime_channel = 'v3'
      ORDER BY (state = 'active') DESC,
               COALESCE(last_started_at, created_at) DESC,
               created_at DESC
      LIMIT 1`,
    [uid],
  );
  return r.rows[0] ?? null;
}

/** dockerode 错误是否 404(资源确实不存在)。区别于 daemon 不通/权限等真错。 */
export function isDockerNotFound(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { statusCode?: number }).statusCode === 404
  );
}

/**
 * cutover 前置 fail-closed:该用户 v3 卷若在远端 host,在 quiesce / 拷贝 / 标 vanished 之前抛错。
 * 防 quiesce 在本机 stop 一个远端不存在的容器拿到 404、误当"已停"后把 PG 行标 vanished
 * (而远端容器仍在跑)。远端场景须先 consolidate 到 self host(P0)。
 */
export async function assertV3VolumesOnSelfHost(uid: string, selfHostUuid: string): Promise<void> {
  const v3c = await latestV3Container(uid);
  if (v3c?.host_uuid && v3c.host_uuid !== selfHostUuid) {
    throw new Error(
      `v3 卷在远端 host ${v3c.host_uuid}(self=${selfHostUuid});cutover 前须先 consolidate 到 self host(P0),或走 node-agent 跨机通道(P1 未实现)`,
    );
  }
}

/** 返回卷 Mountpoint;卷确实不存在(404)→ null;其它错误(daemon 不通/权限)→ fail-closed 抛出。 */
async function volumeMountpoint(docker: Docker, name: string): Promise<string | null> {
  try {
    const info = await docker.getVolume(name).inspect();
    return (info as { Mountpoint?: string }).Mountpoint ?? null;
  } catch (err) {
    if (isDockerNotFound(err)) return null; // 卷确实不存在,合法跳过
    throw new Error(
      `docker volume inspect ${name} 失败(非 404,fail-closed 不当作卷缺失): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** 幂等创建 v5 目标卷(label 与 ensureSingleV3Volume 同款,便于 GC/reconcile 按 channel 过滤)。 */
async function ensureV5Volume(docker: Docker, uid: number, name: string): Promise<void> {
  await docker.createVolume({
    Name: name,
    Driver: "local",
    Labels: {
      [V3_MANAGED_LABEL_KEY]: "1",
      [V3_UID_LABEL_KEY]: String(uid),
      [RUNTIME_CHANNEL_LABEL_KEY]: "v5",
    },
  });
}

/** rsync 一个卷 _data 目录(尾斜杠拷内容),--delete 镜像收敛;返回传输字节(best-effort)。 */
function rsyncDir(srcDir: string, destDir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = [
      "-aHAX",
      "--numeric-ids",
      "--delete",
      "--stats",
      `${srcDir.replace(/\/?$/, "/")}`,
      `${destDir.replace(/\/?$/, "/")}`,
    ];
    const child = spawn("rsync", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => reject(new Error(`rsync spawn 失败: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`rsync 退出码 ${code}: ${err.trim() || out.trim()}`));
        return;
      }
      const m = out.match(/Total transferred file size:\s*([\d,]+)/);
      resolve(m ? Number(m[1].replace(/,/g, "")) : 0);
    });
  });
}

/**
 * 迁移单用户全部卷(v3 → v5)。须在 v5 master(self host)上运行,且该用户 v3 容器已停。
 * @param userId 纯数字 user_id。
 * @param deps   docker 实例 + 本机 selfHostUuid。
 */
export async function migrateUserVolumes(
  userId: bigint | number | string,
  deps: VolumesMigrationDeps,
): Promise<VolumesMigrationOutcome> {
  const uid = normUid(userId);
  const uidNum = Number(uid);
  if (!Number.isSafeInteger(uidNum) || uidNum <= 0) {
    throw new TypeError(`user_id 超出卷迁移可处理范围(需 1..2^53-1): ${uid}`);
  }

  return withAudit(uid, "volumes", { selfHostUuid: deps.selfHostUuid }, async () => {
    const v3c = await latestV3Container(uid);

    // 无 v3 容器 = 用户从未开过容器 → 无卷可迁,成功空跑。
    if (!v3c) {
      const outcome: VolumesMigrationOutcome = { v3HostUuid: null, roles: [] };
      return { result: outcome, detail: { v3HostUuid: null, note: "无 v3 容器,跳过卷迁移" } };
    }

    // 不变量 1:v3 容器仍 active → 拒绝(调用方须先 stopAndRemove 令其 vanished)。
    if (v3c.state === "active") {
      throw new Error("v3 容器仍 active,拷卷前必须先停止(stopAndRemoveV3Container)以释放卷写者");
    }

    // 不变量 2:v3 卷须在 self host。远端 fail-closed(P0 已确认现网基本整合到 self;跨机 P1)。
    if (v3c.host_uuid && v3c.host_uuid !== deps.selfHostUuid) {
      throw new Error(
        `v3 卷在远端 host ${v3c.host_uuid}(self=${deps.selfHostUuid});需先 consolidate 到 self host(P0)或走 node-agent 跨机通道(P1 未实现)`,
      );
    }

    const roles: RoleMigrationOutcome[] = [];
    for (const role of MIGRATE_ROLES) {
      const v3Volume = volumeNameForChannel("v3", role, uidNum);
      const v3Mount = await volumeMountpoint(deps.docker, v3Volume);
      if (!v3Mount) {
        roles.push({ role, v3Volume, copied: false, skipped: "v3 卷不存在" });
        continue;
      }
      const v5Volume = volumeNameForChannel("v5", role, uidNum);
      await ensureV5Volume(deps.docker, uidNum, v5Volume);
      const v5Mount = await volumeMountpoint(deps.docker, v5Volume);
      if (!v5Mount) {
        throw new Error(`v5 卷 ${v5Volume} 建后仍无 Mountpoint,无法拷贝`);
      }
      const bytes = await rsyncDir(v3Mount, v5Mount);
      roles.push({ role, v3Volume, v5Volume, copied: true, bytes });
    }

    const outcome: VolumesMigrationOutcome = { v3HostUuid: v3c.host_uuid, roles };
    return {
      result: outcome,
      detail: {
        v3HostUuid: v3c.host_uuid,
        roles: roles.map((r) => ({ role: r.role, copied: r.copied, bytes: r.bytes, skipped: r.skipped })),
      },
    };
  });
}
