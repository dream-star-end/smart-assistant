/**
 * `/api/org/*` 报表路由(批次 D 填充)。
 *
 * TODO(批次 D — 方案 §5):org 维度用量报表(写时 org_id 戳为权威)。
 *   - GET /api/org/usage   (admin) → 按成员/模型/趋势聚合,窗口 24h/7d/30d
 * 占位空数组:routes.ts 已聚合本表,批次 D 只需往这里加条目即自动接入 gated 分发。
 */

import type { OrgRoute } from "./routeTypes.js";

export const reportsRoutes: OrgRoute[] = [];
