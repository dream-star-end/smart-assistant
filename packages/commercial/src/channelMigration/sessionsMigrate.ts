// channelMigration/sessionsMigrate.ts
//
// P3 — L2 会话历史迁移的 commercial 侧编排包装:解析 v3 master HOME、调 storage 的行级
// 迁移原语、写审计。真正的跨库 upsert 在 @openclaude/storage:migrateUserClientSessionsFromV3。

import { migrateUserClientSessionsFromV3 } from "@openclaude/storage";
import { join } from "node:path";
import { withAudit } from "./audit.js";
import { normUid } from "./channelState.js";

// v3 master 网关 HOME(其 sessions.db 落点)。默认现网 /root/.openclaude;可 env 覆盖(dev/迁站)。
export const V3_MASTER_HOME = process.env.OC_V3_MASTER_HOME ?? "/root/.openclaude";

export interface SessionsMigrationOutcome {
  clientSessions: number;
  wechatBindings: number;
  skipped?: string;
  wechatWarning?: string;
}

/**
 * 迁移单用户的 master 会话历史(client_sessions + wechat_bindings)从 v3 库到当前 v5 库。
 * 必须在 v5 master 进程内运行(OPENCLAUDE_HOME=/root/.openclaude-v5)。幂等可重入。
 */
export async function migrateUserSessions(
  userId: bigint | number | string,
): Promise<SessionsMigrationOutcome> {
  const uid = normUid(userId);
  const v3DbPath = join(V3_MASTER_HOME, "sessions.db");
  return withAudit(uid, "sessions", { v3DbPath }, async () => {
    const res = await migrateUserClientSessionsFromV3(v3DbPath, uid);
    return {
      result: res,
      detail: {
        clientSessions: res.clientSessions,
        wechatBindings: res.wechatBindings,
        skipped: res.skipped,
        wechatWarning: res.wechatWarning,
      },
    };
  });
}
