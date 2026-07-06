/**
 * `/api/org/*` 发票路由(批次 D 填充)。
 *
 * TODO(批次 D — 方案 §5):org 发票抬头 + 按已付订单申请。
 *   - GET/PUT /api/org/invoice-profile   (admin) → 维护抬头
 *   - POST    /api/org/invoices          (admin) → 对 paid 订单发起申请
 *   - GET     /api/org/invoices          (admin) → 申请列表
 * 占位空数组:routes.ts 已聚合本表,批次 D 只需往这里加条目即自动接入 gated 分发。
 */

import type { OrgRoute } from "./routeTypes.js";

export const invoicesRoutes: OrgRoute[] = [];
