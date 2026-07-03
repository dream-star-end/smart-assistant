// channelMigration/cutover.ts
//
// P5 — 每用户「切换即迁移」编排器 + 路由/门控判定。
//
// 编排器是**channel 无关的宿主级工具**(v3/v5 同机 kl-mirror):直接操作共享 PG + 本机
// docker + 本机文件系统。既可作 CLI(scripts/v5-migrate-user.ts)跑,也可挂 v5 admin。
//
// 切换栅栏(cutoverUser)时序(单向、可回滚、失败不翻转):
//   markMigrating(权威仍 v3)→ quiesce v3 容器(停+移除,释放卷写者)→ L2 会话最后 delta →
//   L3 卷最后 delta → markMigrated(权威翻转 v5)。任一步失败 → 停在 'migrating'(用户仍
//   路由 v3),不置 migrated;可重跑 cutoverUser(从 'migrating' 允许重入)或 abortInflight
//   复位回 v3。
//
// 权威单一:是否在 v5 恒看 users.v5_migrated_at(见 channelState)。路由/门控只读它。

import type Docker from "dockerode";
import { query } from "../db/queries.js";
import { withAudit } from "./audit.js";
import {
  abortInflight,
  markMigrated,
  markMigrating,
  markSeeding,
  normUid,
  rollbackToV3,
  type V5MigrationStatus,
} from "./channelState.js";
import { migrateUserSessions, type SessionsMigrationOutcome } from "./sessionsMigrate.js";
import { migrateUserVolumes, type VolumesMigrationOutcome } from "./volumesMigrate.js";

export interface CutoverDeps {
  docker: Docker;
  /** 本机(v5 master)在 compute_hosts 的 canonical uuid。 */
  selfHostUuid: string;
  /**
   * 停止并移除该用户的 v3 容器、释放卷写者。生产集成部署应注入 v3 的
   * stopAndRemoveV3Container(带完整 bookkeeping);standalone CLI 用 defaultQuiesceV3。
   */
  quiesceV3: (uid: string) => Promise<void>;
}

/**
 * standalone quiesce:直接 docker 停+移除 v3 容器(保留卷 v:false),并把该用户 v3 active
 * 行标 vanished。用于 CLI/host 级迁移工具(无 v3 进程在手时)。集成 v3 进程时应改注入
 * v3 supervisor 的 stopAndRemoveV3Container 以走完整 secret 清理等 bookkeeping。
 */
export function defaultQuiesceV3(docker: Docker): (uid: string) => Promise<void> {
  return async (uid: string) => {
    const uidNum = Number(uid);
    if (!Number.isSafeInteger(uidNum) || uidNum <= 0) throw new TypeError(`bad uid: ${uid}`);
    // 容器名权威 = v3ContainerNameFor;此处显式 v3 form(编排器在 v5 进程,getRuntimeChannel≠v3)。
    const name = `oc-v3-u${uidNum}`;
    try {
      const c = docker.getContainer(name);
      try {
        await c.stop({ t: 10 });
      } catch {
        /* 已停 / 404 —— 幂等忽略 */
      }
      try {
        await c.remove({ force: true, v: false }); // v:false 保留卷(迁移要用)
      } catch {
        /* 404 —— 幂等忽略 */
      }
    } catch {
      /* 容器根本不存在 —— 幂等忽略 */
    }
    await query(
      `UPDATE agent_containers SET state='vanished', last_stopped_at=NOW(), updated_at=NOW()
        WHERE user_id=$1 AND runtime_channel='v3' AND state='active'`,
      [uid],
    );
  };
}

export interface CutoverResult {
  uid: string;
  /** 是否真正执行了本次切换(false=未进入栅栏:已迁移或被并发抢占)。 */
  applied: boolean;
  status: V5MigrationStatus | null;
  sessions?: SessionsMigrationOutcome;
  volumes?: VolumesMigrationOutcome;
  note?: string;
}

/** 切换栅栏:把单用户从 v3 迁移并翻转权威到 v5。幂等可重入(失败停在 migrating)。 */
export async function cutoverUser(
  userId: bigint | number | string,
  deps: CutoverDeps,
): Promise<CutoverResult> {
  const uid = normUid(userId);
  const enter = await markMigrating(uid);
  if (!enter.applied) {
    return {
      uid,
      applied: false,
      status: enter.status,
      note:
        enter.status === "migrated"
          ? "已在 v5(幂等跳过)"
          : `未进入栅栏(当前 status=${enter.status};已迁移或并发抢占)`,
    };
  }
  return withAudit(uid, "cutover", { selfHostUuid: deps.selfHostUuid }, async () => {
    // 1. quiesce v3:停容器释放卷写者(此后卷内 sessions.db 稳定、无并发写)。
    await deps.quiesceV3(uid);
    // 2. L2 会话历史最后 delta(master client_sessions + wechat_bindings)。
    const sessions = await migrateUserSessions(uid);
    // 3. L3 卷最后 delta(data/proj/userlocal/userconfig)。
    const volumes = await migrateUserVolumes(uid, {
      docker: deps.docker,
      selfHostUuid: deps.selfHostUuid,
    });
    // 4. 翻转权威到 v5。
    const done = await markMigrated(uid);
    if (!done.applied) {
      throw new Error(
        `markMigrated 未生效(status=${done.status});数据已拷贝但权威未翻转,需人工核对一致性`,
      );
    }
    const result: CutoverResult = {
      uid,
      applied: true,
      status: "migrated",
      sessions,
      volumes,
    };
    return {
      result,
      detail: {
        clientSessions: sessions.clientSessions,
        wechatBindings: sessions.wechatBindings,
        volumeRoles: volumes.roles.map((r) => ({ role: r.role, copied: r.copied, bytes: r.bytes })),
      },
    };
  });
}

/**
 * 后台预热:对未迁移用户提前把 v3 数据拷到 v5(养温),使切换瞬间的 delta 近零。
 * 只处理 v3 容器已停(idle-swept)的用户(卷迁移不变量);活跃用户跳过,留待栅栏。
 * 预热后 status 复位回 NULL(warm 数据留在 v5,标记不占用),可被后续 cutover 直接接管。
 */
export async function preseedUser(
  userId: bigint | number | string,
  deps: Pick<CutoverDeps, "docker" | "selfHostUuid">,
): Promise<CutoverResult> {
  const uid = normUid(userId);
  const enter = await markSeeding(uid);
  if (!enter.applied) {
    return { uid, applied: false, status: enter.status, note: `未进入预热(status=${enter.status})` };
  }
  try {
    const out = await withAudit(uid, "preseed", { selfHostUuid: deps.selfHostUuid }, async () => {
      const sessions = await migrateUserSessions(uid);
      const volumes = await migrateUserVolumes(uid, deps);
      const result: CutoverResult = { uid, applied: true, status: "seeding", sessions, volumes };
      return {
        result,
        detail: {
          clientSessions: sessions.clientSessions,
          volumeRoles: volumes.roles.map((r) => ({ role: r.role, copied: r.copied, bytes: r.bytes })),
        },
      };
    });
    return out;
  } finally {
    // 释放 seeding 认领,复位回 NULL(不影响已养温的 v5 数据)。失败也复位,便于重试。
    await abortInflight(uid).catch(() => {});
  }
}

/**
 * 回滚:把已迁移用户路由回 v3(清 v5_migrated_at)。v3 卷/会话从未删,原样恢复;v5 侧拷贝
 * 数据被忽略(留待 GC)。秒级。
 */
export async function rollbackUser(userId: bigint | number | string): Promise<CutoverResult> {
  const uid = normUid(userId);
  return withAudit(uid, "rollback", {}, async () => {
    const r = await rollbackToV3(uid);
    const result: CutoverResult = {
      uid,
      applied: r.applied,
      status: r.status,
      note: r.applied ? "已回滚到 v3" : `未回滚(status=${r.status};非 migrated 态)`,
    };
    return { result, detail: { applied: r.applied, status: r.status } };
  });
}
