/**
 * `/api/org/*` 技能路由(批次 C 填充)。
 *
 * TODO(批次 C — 方案 §4):org 维度共享技能(marketplace 扩 org)。
 *   - POST /api/org/skills/install   (owner/admin) → 写 org_installs
 *   - GET  /api/org/skills           (admin)       → org 已装技能列表
 * 占位空数组:routes.ts 已聚合本表,批次 C 只需往这里加条目即自动接入 gated 分发。
 */

import type { OrgRoute } from "./routeTypes.js";

export const skillsRoutes: OrgRoute[] = [];
