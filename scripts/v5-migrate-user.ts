#!/usr/bin/env -S npx tsx
/**
 * Ops 脚本: v3 → v5 单用户「切换即迁移」入口(见 deploy/v5/DATA-MIGRATION-RUNBOOK.md)。
 *
 * 用法(必须在 kl-mirror 本机、以 v5 环境跑):
 *   OPENCLAUDE_HOME=/root/.openclaude-v5 OC_RUNTIME_CHANNEL=v5 \
 *     env $(grep -v '^#' /etc/openclaude/commercial-v5.env | xargs) \
 *     npx tsx scripts/v5-migrate-user.ts <cmd> <uid>
 *
 *   cmd:
 *     status    只读:打印该用户迁移状态(v5_migrated_at / status)
 *     preseed   后台预热(v3 容器须已 idle 停止):拷会话+卷,不翻转权威
 *     cutover   切换栅栏:quiesce v3 容器 → 拷会话+卷 → 翻转权威到 v5
 *     rollback  回滚:清 v5_migrated_at,路由回 v3(v3 数据从未删,原样恢复)
 *
 * 设计:
 *   - 权威源单一 = users.v5_migrated_at(channelState);本脚本只是编排器 CLI 外壳。
 *   - DATABASE_URL / AGENT_DOCKER_SOCKET 从 commercial-v5.env 注入(共享库 + 本机 docker)。
 *   - OPENCLAUDE_HOME 必须是 v5 home(/root/.openclaude-v5),否则会话迁移的目标库指错 —
 *     脚本会在非 v5 home 时告警。v3 master home 由 OC_V3_MASTER_HOME(默认 /root/.openclaude)。
 *   - cutover 用 defaultQuiesceV3(直接 docker 停 v3 容器);集成 v3 进程时可换注入
 *     v3 supervisor 的 stopAndRemoveV3Container 走完整 bookkeeping。
 */
import Docker from "dockerode";
import { loadConfig } from "../packages/commercial/src/config.js";
import {
  cutoverUser,
  defaultQuiesceV3,
  getChannelState,
  preseedUser,
  rollbackUser,
} from "../packages/commercial/src/channelMigration/index.js";
import { getSelfHost } from "../packages/commercial/src/compute-pool/queries.js";

function usage(): never {
  console.error("usage: v5-migrate-user.ts <status|preseed|cutover|rollback> <uid>");
  process.exit(2);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const uid = process.argv[3];
  if (!cmd || !uid || !/^\d+$/.test(uid)) usage();

  if (process.env.OPENCLAUDE_HOME !== "/root/.openclaude-v5") {
    console.error(
      `[warn] OPENCLAUDE_HOME=${process.env.OPENCLAUDE_HOME ?? "(unset)"} 非 v5 home;` +
        " 会话迁移目标库可能指错。请以 OPENCLAUDE_HOME=/root/.openclaude-v5 运行。",
    );
  }

  if (cmd === "status") {
    const st = await getChannelState(uid);
    console.log(JSON.stringify(st ?? { uid, note: "user not found" }, null, 2));
    process.exit(0);
  }

  const cfg = loadConfig();
  const docker = cfg.AGENT_DOCKER_SOCKET
    ? new Docker({ socketPath: cfg.AGENT_DOCKER_SOCKET })
    : new Docker();
  const selfHostUuid = (await getSelfHost()).id;

  if (cmd === "preseed") {
    const r = await preseedUser(uid, { docker, selfHostUuid });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.applied ? 0 : 1);
  }
  if (cmd === "cutover") {
    const r = await cutoverUser(uid, { docker, selfHostUuid, quiesceV3: defaultQuiesceV3(docker) });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.applied ? 0 : 1);
  }
  if (cmd === "rollback") {
    const r = await rollbackUser(uid);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.applied ? 0 : 1);
  }
  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
