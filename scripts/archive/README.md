# `scripts/archive/` — dormant 脚本归档

存放当前**无 prod 运行时效果**但保留 git 历史的脚本。重新启用前需读各脚本归档原因。

## 归档清单

### `rollout-node-agent.ts` (归档 2026-05-23)

**当前状态**:dormant。运行了不会有 prod 效果。

**原因**:
- self-host 不再跑独立 node-agent 进程(主进程内嵌)
- boheyun-1 已废弃(2026-05-22 用户卷整合到 KL self host)
- 当前 `compute_hosts` 表中无任何 host 运行独立 node-agent → **0 实例在跑**

**重启用条件**:如果未来再次部署独立 node-agent host pool,需:
1. 把脚本从 archive 取回 `scripts/`
2. KL self 上重新装 Go builder
3. 更新 `docs/hotfix-deploy-checklist.md` Step 4 把"坑 4.2 dormant"段恢复

源码仍在 `packages/commercial/node-agent/`,改它**不影响 prod**,只是为未来重启用作准备。

参考 memory:`v3_node_agent_dormant.md`、`v3_volume_consolidation_2026_05.md`。
