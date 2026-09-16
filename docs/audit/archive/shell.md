# shell · 应用壳层与设计系统 · 归档摘要

> 正文：[`docs/audit/shell.md`](../shell.md)（模块负责人维护，含定位 file:line、修复计划与逐条细节；本文只做摘要与索引，不复制原文）。
> 任务：t-30「A·shell 应用壳层与设计系统审计」→ t-31「B·shell 修复」。无二期任务。
> 分支 `feat/v5-selfhost-audit-shell`，HEAD `39697560b`，基线 `210b9967`。
> 集成：shell-B 已包含在 integration 起点 `e6f73dd99`（集成① 记录 §1）；sidebar-B 对 `App.tsx` 的接线由集成① `678fe9d38` 落地。

## 1. 审出问题（P1 1 / P2 8 / P3 11，共 20）

| 严重度 | 编号与要点 |
|---|---|
| P1 | S-01 桌面端 `⌘K` 打开 `md:hidden` 移动抽屉，`<body>` 被 Radix 置 `pointer-events:none`，整页点死 |
| P2 | S-02 Esc 双持有方（弹层关闭 vs 全局 `stopTurn`）· S-03 暗色 danger 按钮白字 3.07:1 · S-04 营销主题 `.congjian-landing` 漏定义 `--danger` · S-05 对比度契约只守 `:root`/`.dark` 两套主题 · S-06 输入框上方横幅栈无上限无折叠（390px 吃掉 ~560px）· S-07 `Alert` 恒为 `role="alert"`（assertive）· S-08 设置/管理/市场等面板只 `replaceState` 不进历史栈 · S-09 EmptyState 目标链接与 chunk 兜底屏「刷新」触控靶不足 |
| P3 | S-10 双 h1 · S-11 `theme-color` 首帧闪烁 · S-12 主题取值不校验/不跨标签同步 · S-13 UpdateBanner 半角标点与裸 button · S-14 Chip 触屏靶 36px · S-15 EmptyState 任意字号与缺 `type="button"` · S-16 空闲预取不看网络 · S-17 bottom Sheet 无滚动容器 · S-18 ChunkErrorBoundary 任意字号 · S-19 `browser-tests/**` 不在类型检查内 · S-20 主题切换 toast 冗余 / toast 顶距写死 |

→ 逐条定位、现象与影响见正文 [§3 问题清单](../shell.md#3-问题清单)；不修 / 暂缓项（拆分 `App.tsx`、Tooltip 触屏、`.preview-shell` 收编、SW 更新流程、任意字号、`--warning` 填充）及理由见正文 §5。

## 2. 修复情况（修复 18 / 半条 1 / 暂缓 1）

阶段 B 全部在同一分支小步提交，subject 一律 `feat/refactor/style/test(v5)`。

| 编号 | 严重度 | 状态 | 提交 |
|---|---|---|---|
| S-01 | P1 | ✅ | `561b3aeb5` |
| S-02 | P2 | ✅ | `274e11c85`、`561b3aeb5` |
| S-03 / S-04 / S-05 | P2 | ✅ | `ee8b65b25` |
| S-06 | P2 | ✅ | `bc280a16f`、`561b3aeb5`、`df7b2be2d`、`1da9a0f2b` |
| S-07 | P2 | ✅ | `1cf118526` |
| S-08 | P2 | ⏸ 暂缓 | —（指挥官裁决：与 2026-07-02「后退 = 上一个会话」定头交叉，等用户拍板） |
| S-09 | P2 | ✅ | `e5fdf2f78`、`67d540809` |
| S-10 / S-15 | P3 | ✅ | `67d540809` |
| S-11 / S-12 | P3 | ✅ | `8ee43e008` |
| S-13 | P3 | ✅ | `895db90e1` |
| S-14 | P3 | ✅ | `65b781271`（跨模块：manage / market 触屏筛选条约高 8px） |
| S-16 | P3 | ✅ | `f20597d54`、`561b3aeb5` |
| S-17 | P3 | ✅ | `1cf118526` |
| S-18 | P3 | ✅ | `e5fdf2f78` |
| S-19 | P3 | ✅ | `75ba343cd`（新增独立脚本 `npm run typecheck:preview`，不改主 `tsconfig` include） |
| S-20 | P3 | ◐ 半条 | `8c2e580e2`（只做 toast 顶距解耦 `--oc-toast-top`；「去掉主题切换 toast」等用户拍板） |

计划外顺手项（`isDialogLayerOpen` 纳入 `role="menu"`、`useTheme` 的 localStorage 读写包 try/catch、补回三份测试文件被误删的存量用例）已记入正文对应行。

→ 改了哪些文件、怎么改见正文 [§6 修复记录](../shell.md#6-修复记录)。

## 3. 验证摘要（工作树 `wt\shell`，HEAD `1da9a0f2b` 时跑）

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ 绿 |
| `npm run typecheck:preview`（S-19 新增） | ⚠️ `scenes-shell.tsx` 0 错；`scenes-taskboard.tsx` 3 错（他人存量，见 §4） |
| shell 模块 vitest（32 文件） | ✅ 315 用例全绿；App.test 复跑 47/47 |
| 全量 `npm test` | ✅ 278 文件 / 3608 用例；2 文件失败均为本机基线（`tutorialShowcase.test.ts` autocrlf 字节数、`MessageRenderer.test.tsx` beforeAll 并行超时，单跑 147/147 绿） |
| `npm run test:browser` | `run.mjs` 67/67 全过；`node --test` 73 例 70 过，3 失败均为 `cc-switch-ascii-name`（settings 基线，主克隆同样失败） |
| `npx biome lint` | ✅ 新增诊断 0 |
| after 截图 | ✅ 22 张全部成功；横幅栈 ~560px → ~390px、暗色 danger 按钮白字 → 深字、Chip 升到 44px 等逐张对照 |
| NOT RUN | S-17 双滚动条未真机目测（`shell-*` 场景不覆盖 InspectorPanel 抽屉）；真机 iOS Safari 未复核（网络受限） |

→ 命令原文与逐项说明见正文 [§7 验证](../shell.md#7-验证)。

## 4. 遗留与理由

| 项 | 类型 | 理由 / 下一步 |
|---|---|---|
| S-08 面板不进历史栈 | P2 · 暂缓 | 需用户拍板「面板是否应占历史栈」，再按正文 §4 方案（`pushState` + `history.state.ocPanel` + `useAppRoute.test`）做 |
| S-20 去掉主题切换 toast | P3 · 暂缓 | 产品口味判断，等用户拍板；顶距解耦那半已做 |
| `.preview-shell` 未纳入对比度守卫 | S-05 余项 | `--preview-*` 前缀且 `surface` 为半透明 rgba，需先定义合成底色；建议单列小任务 |
| `scenes-taskboard.tsx` 3 处类型错误 | S-19 暴露 · 他人文件 | 归 taskboard owner；**taskboard 二期 `cb6629bd1` 已修**（见 [taskboard 摘要](./taskboard.md)） |
| Chip 44px 对 manage / market 筛选条影响 | S-14 跨模块 | 需 manage / market owner 在各自 after 图确认无换行 / 溢出 |
| `EmptyState` 任意字号 | S-15 余项 | 等排版档位专项统一收敛，本轮不新增 token |
| `core.autocrlf=true` 环境噪音 | 环境 | `tutorialShowcase.test.ts` 字节断言、`biome format` 整文件重排均非代码问题；教程夹具部分已由集成② `419e0d218` 仓根 `.gitattributes` 标 `-text` 收口 |
| 待 integration 接线（sidebar-B S-05/S-06/S-08、UUS-01 对 `App.tsx`） | 跨模块 | **已由集成① `678fe9d38` 落地** |

→ 正文 [§8 遗留](../shell.md#8-遗留) 与 §8.1。

## 5. 分支 / 提交

- 分支 `feat/v5-selfhost-audit-shell` @ `39697560b`（基线 `210b9967`，18 个提交，31 files / +1927 −178）
- 阶段 A：`de38a312c` 审计报告 + `scenes-shell.tsx`
- 阶段 B（代码）：`274e11c85` `ee8b65b25` `1cf118526` `65b781271` `e5fdf2f78` `67d540809` `895db90e1` `8ee43e008` `bc280a16f` `f20597d54` `561b3aeb5` `df7b2be2d` `75ba343cd` `8c2e580e2` `1da9a0f2b`
- 阶段 B（文档）：`d2f21dd18` 修复记录 / 验证 / 遗留；`39697560b` 登记 sidebar-B 对 `App.tsx` 的接线需求
- 集成：包含在 integration 起点 `e6f73dd99`；接线 `678fe9d38`（集成①）
