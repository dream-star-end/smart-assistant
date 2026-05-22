# `docs/archive/` — 历史 plan / audit 归档

存放**已完成历史使命**或**被后续 plan 取代**的 plan、audit、refactor 清单。
保留 git 历史,但**不代表当前任务状态**。

## 归档清单

### `AUDIT_REMEDIATION_TASKS_2026-04-11.md` (归档 2026-05-23)

**背景**:2026-04-11 个人版安全审计,16 个任务(T01-T16)。

**当前状态**:历史完成度记录见 `docs/V3_REFACTOR_PHASE0_2026-05-10.md` §1.3。
T01-T03 部分完成,T04 部分,T05-T16 基本未动。

**为什么归档**:
- 任务**针对个人版** (45.32 master),不针对 v3 商用版
- v3 fork 后引入了容器隔离、多 host 等新的安全面,旧 audit 清单已不完整
- 后续 v3 安全工作在 `docs/v3/SECURITY-AUDIT-REMEDIATION.md` 走

### `AUDIT_REMEDIATION_TASKS_2026-04-25.md` (归档 2026-05-23)

**背景**:2026-04-25 个人版后续 audit。

**当前状态**:个人版残留,v3 不引用。归档保留 git 历史。

### `CCB_ASSISTANT_REFACTOR_PLAN_2026-04-12.md` (归档 2026-05-23)

**背景**:2026-04-12 CCB 集成 + assistant 重构计划,A1-A15。

**当前状态**:仅 A12 (app.js 拆 21 模块) 完成,其余 14 项基本未动。

**为什么归档**:
- 计划写于 v3 fork 之前,**目标是个人版**
- v3 已有独立 R-series 计划接续(`docs/v3/02-DEVELOPMENT-PLAN.md`)
- 继续放在仓根级目录会误导新人以为是当前活跃 plan

## 当前活跃 plan

- v3 商用版:`docs/v3/02-DEVELOPMENT-PLAN.md` (R-series)
- v3 重构 Phase 0:`docs/V3_REFACTOR_PHASE0_2026-05-10.md` (本次重构起点)
