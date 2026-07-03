// channelMigration — v3 → v5 用户「切换即迁移」子系统。
//
// 分层(见 deploy/v5/DATA-MIGRATION-RUNBOOK.md):
//   channelState  权威源单一读写(users.v5_migrated_at)+ 状态机
//   audit         v5_migration_audit 写入
//   sessionsMigrate  L2 master 会话历史 per-user 行迁移(commercial 侧包装)
//   volumesMigrate   L3 每用户容器卷迁移(rsync)
//   cutover       P5 切换栅栏编排 + 路由/门控判定

export * from "./channelState.js";
export * from "./audit.js";
export * from "./sessionsMigrate.js";
export * from "./volumesMigrate.js";
export * from "./cutover.js";
