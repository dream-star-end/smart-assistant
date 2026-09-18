# HUD · 任务列表 / 后台子任务 · 归档摘要（t-836，覆盖复查缺口 G-1 / G-2）

> 正文：[`docs/audit/hud.md`](../hud.md)（已随集成④ `2c1d659d2` 合入 integration，2026-09-17）。本文只做摘要与索引。
> 任务：t-836「HUD·任务列表/后台子任务 审计+修复（G-1/G-2）」，A→B 同人合一；QA 复核 t-1029（[qa.md](./qa.md)）。
> 分支 `feat/v5-selfhost-audit-hud`，HEAD `b1f06f8f5`，基线 `210b9967`；QA 修复 `747596782` 在 `feat/v5-selfhost-audit-qa-gap`。
> 范围：`components/chat/PinnedTaskTracker.tsx` / `PinnedDelegateTracker.tsx`、`hooks/useInflightDelegates.ts`、`lib/chat/inflightDelegates.ts`（App 接线只读）。

## 1. 审出问题（P1 0 / P2 7 / P3 13，共 20）

| 严重度 | 编号与要点 |
|---|---|
| P2 | H-01 后台任务失败原因不显示（终态摘要只在 completed 渲染）· H-02 折叠摘要 390px 下目标被挤没、计时截成「00:0」· H-03 全部结束后折叠头部只剩「后台任务 0/3」· H-04 `aria-hidden` 的可点 chevron 按钮 · H-05 键盘焦点环被 `overflow-hidden` 裁掉 · H-06 两枚同时展开吃掉约 60% 视口 · H-07 queued / paused 与 running 同一旋转图标 |
| P3 | H-08 `aria-controls` 悬空 / 固定 id · H-09 切换按钮无可读名 · H-10 「任务 N/M」与 inline 卡「任务列表」两个叫法 · H-11 刷新后仍在飞态永久展开 · H-12 计时起点不准 · H-13 无一键清除终态 · H-14 「知道了」刷新后复活 · H-15 回到前台不立即拉 · H-16 死参 `compact` · H-17 溢出无滚动提示 · H-18「停止本轮」父轮结束仍显示 · H-19 文案微调也重展开 · H-20 `TokenUsageBadge` 重放动画 / `text-faint` 对比度 |

→ 正文 §3 问题清单、§5 建议不修 / 暂缓。

## 2. 修复情况（发现 20 / 修复 17 / 不修 3）

- `9e6c29ad8` feat：H-01…H-17（H-12 半修：起点 `min(首次观察, updatedAt)` + title 注明 + 超 1h `h:mm:ss`）；共用 `HUD_TOGGLE_CLS`（inset 焦点环）/ `HUD_LIST_CLS`（`max-h-[min(13rem,30dvh)]`，窄屏 `9rem`）/ `useHudListOverflow`（底部渐隐）；`useInflightDelegates` 的 `dismissed` 按会话持久化到 sessionStorage（上限 64）+ `visibilitychange` 立即拉。
- `6811df3ee` test：`scenes-hud.tsx` 补 `Collapsed` 包装器与 10 个场景；`run.mjs` T61 断言随「任务列表 N/M」同步（仅 1 行）。
- `d09934912` 阶段 A 报告 + 场景；`983cb2a97` / `b1f06f8f5` 文档。
- 不修：H-18（需 shell 在 `App.tsx` 传 `onStop={wsSending ? stopTurn : undefined}`）、H-19（文件头声明的既有交互）、H-20（messages / shell 归属）。
- QA t-1029 追加：`scenes-hud.tsx:199` 给 `tokenUsage` 的字面量多写 `estimated` → `typecheck:preview` TS2353，`747596782`（qa-gap 分支）改为 `LiveTurnTokenUsageSnapshot` 类型常量，运行时零变化。

→ 正文 §6 修复记录。

## 3. 验证摘要（工作树 `wt\hud`；QA 复核见 [qa.md](./qa.md) §3）

| 门 | 结果 |
|---|---|
| `typecheck` | ✅ |
| `typecheck:preview` | ❌ 交付未跑 → QA 发现 TS2353 → 修后 ✅ 0 错 |
| 模块 vitest | ✅ 4 文件 / 55 例（新增 11） |
| `biome lint` 7 文件 | ✅ 0（基线 2 条 `useExhaustiveDependencies` 加说明性 ignore） |
| `test:browser` | ✅ `run.mjs` T1–T67 全部 ok；`node --test` 2 败为基线 / 环境（cc-switch、ocv5-185 symlink） |
| 视觉 | ✅ before / after 各 40 张（10 场景），failures 0 |

## 4. 遗留与理由

| 项 | 归属 | 说明 |
|---|---|---|
| H-18「停止本轮」父轮结束仍显示 | shell（`App.tsx` 接线） | ✅ **集成④ `4a2745283` 已落地**：`PinnedDelegateTracker` `onStop={wsSending ? stopTurn : undefined}`（`wsSending = !demo && chat.isSending(activeId)`），`PinnedDelegateTracker.test` 既有契约 + `App.test` 回归 |
| H-12 计时精确起点 | 需后端 `InflightDelegateSurface.startedAt` | 前端半修到位；仍开放（§5.1 需后端） |
| H-20 ① `TokenUsageBadge` 流式重放入场动画 | messages `chat/tokenUsage.tsx` | 建议去 key 或仅首次动画；仍开放 |
| H-20 ② `text-faint` 暗色对比度 | shell token | ✅ a11y-shell t-893 `d30ed780e` 压暗 `--faint`（深 `#92929b`），随集成④ `15f816145` 合入；集成④ a11y 复扫 hud 10 场景对比度命中 0 |
| H-19 文案微调也重展开 | 设计取舍 | 保留 |

## 5. 分支 / 提交

- `feat/v5-selfhost-audit-hud` @ `b1f06f8f5`：`d09934912` `9e6c29ad8` `6811df3ee` `983cb2a97` `b1f06f8f5`
- QA 修复：`feat/v5-selfhost-audit-qa-gap` `747596782`
- 集成：✅ 集成④ `2c1d659d2`（9 files, +959/−90；`run.mjs` T61 一行三方合并）；QA 修复随 qa-gap `902ade6e8` 合入（`scenes-hud.tsx` 唯一冲突取 qa-gap 版本）；H-18 接线 `4a2745283`。集成④ 终点 `rev-list HEAD..b1f06f8f5` = 0。集成④ 全量门：`npm test` 302 文件 / 4279 例（hud +11）、`run.mjs` 68/68、截图 301 场景含 hud 10 场景 failures 0、a11y 复扫 hud 10 场景全 0（仅 `hud-task-long` misc 1 = 长列表滚动区）
