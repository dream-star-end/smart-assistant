/**
 * `/api/org/*` 计费路由(批次 B 填充)。
 *
 * TODO(批次 B — 方案 §3):org 钱包充值 / 余额 / 流水。
 *   - POST /api/org/topup      (owner/admin) → createPendingOrder(org_id)
 *   - GET  /api/org/ledger     (admin)       → org 桶流水 keyset 分页
 * 占位空数组:routes.ts 已聚合本表,批次 B 只需往这里加条目即自动接入 gated 分发。
 */

import type { OrgRoute } from "./routeTypes.js";

export const billingRoutes: OrgRoute[] = [];
