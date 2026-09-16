# tools · 工具卡 / 智能体过程 / 检查器 · 归档摘要

> 正文：[`docs/audit/tools.md`](../tools.md)（模块负责人维护；本文只做摘要与索引，不复制原文）。
> 任务：t-44「A·tools 审计」→ t-45「B·tools 修复」（fable-5-1-23 施工，fable-5-1-33 → fable-5-1-37 接手收尾）。无二期任务。
> 分支 `feat/v5-selfhost-audit-tools`，HEAD `d65c6741e`，基线 `210b9967`（阶段 B 前合入过 integration `e6f73dd99`）。
> 集成：tools-B（@`d65c6741e`）由集成② `6fa690d7e` 合入；T-18 选中态的 `App.tsx` 接线由集成② `19799c0fe` 落地。

## 1. 审出问题（P1 1 / P2 7 / P3 23，共 31；另跨模块 4 条）

| 分类 | 编号与要点 |
|---|---|
| 功能正确性 | **T-01（P1）** Grok 输出归一化误伤 oc-cli 研究报告卡 · T-02（P2）错误输出为 JSON 信封时不可读 · T-03（P2）Cursor shell 信封终端卡 · T-04（P2）「复制全文」复制错内容 · T-05（P2）卡片与面板状态矛盾 · T-06 WebFetch 摘要截断 · T-07 默认展开态只求值一次 |
| 响应式 / 触控 | T-08（P2）卡内触控靶系统性 < 44px · T-09（P2）终端 / 文件 / Grep 输出 320px 嵌套滚动 · T-10 390px diff 可读性 · T-11 移动端表头信息量归零 |
| UI / 视觉 | T-12 截断行噪音 · T-13 两套徽标 · T-14 卡中卡 · T-15 重复小标题 · T-16 运行中用成功色 · T-17 `TONE_TILE` 复制两份 |
| 交互友好性 | T-18 面板打开源卡无选中态 · T-19 剪贴板失败静默 · T-20 子任务卡展开重复表头 · T-21 「完整结果见上方回答」误导 |
| 可访问性 | T-22（P2）读屏丢失卡片主要信息与状态变化 · T-23 滚动区不可聚焦 · T-24 面板无标题 / 焦点管理 · T-25 emoji 逐字朗读 |
| 文案 | T-26 表头动词冗余 · T-27 开发者术语泄漏 · T-28 折叠态无摘要 · T-29 「未成功」口径不一致 · T-30 Read 元信息含糊 |
| 代码质量 | T-31 文件列表两种呈现 |
| 跨模块 | X-01 委派过程窗口固定高（messages，P2）· X-02 agent-group 表头 `aria-expanded` / 图标底尺寸（messages）· X-03 `cronHuman` 星期区间不人话化（manage）· X-04 测试绕过 `normalize`（随 T-01 修） |

→ 逐条定位与证据见正文 [§3 问题清单](../tools.md#3-问题清单)；不修 / 暂缓项（委派子任务 slug 需后端、Chip 字号、`HeaderTag` 极短窗口、面板宽度、通用 KvList 键名、表头 title）见 §5。

## 2. 修复情况（31 / 31 全部修复，本模块遗留 0）

| 提交 | 内容 | 覆盖 |
|---|---|---|
| `769596cec` | T-01 Grok 输出归一化只对原生名与明确信封形状生效 | T-01（P1）、X-04 |
| `c5ee11db4` | 工具卡 / 检查器阶段 B 修复：状态单一权威（新 `tool/status.ts`）、Cursor shell 信封解包（新 `tool/shellEnvelope.ts`）、卡内文字操作原语（新 `tool/inlineAction.tsx`）、`tool/tone.ts`、触控靶、a11y、文案 | T-02～T-31 |
| `e569f9e66` | 浏览器门随表头可及名口径更新，T13 补卡内触控靶断言 | T-08、T-22 的真浏览器门 |

- 计划偏离 6 条（T-08 用新 `InlineAction` 原语、T-09 改走 `useExpandableSlice`、T-16 `StatusLine` 加 tone、T-18 组件侧用 `ArtifactInspectActiveContext` 等）见正文 §6.2。
- T-18 组件侧完成，`App.tsx` 一行接线登记给集成② → **`19799c0fe` 已接**。

→ 编号 → 状态 → 改动 → 用例 → 提交完整映射见正文 §6.1。

## 3. 验证摘要（工作树 `wt\tools`，HEAD `e569f9e66`）

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ `tsc -b` 0 错误 |
| 模块 vitest（`src/components/tool` + ToolCard / InspectorPanel / AgentAvatar 等） | ✅ 22 files / 390 tests（阶段 A 19 / 340 → +3 文件 / +50 用例） |
| `npm run test:browser` | `run.mjs` 67/67 ok（含工具卡 T6/T12/T13/T21/T36/T41）；`node --test` 70/73，3 失败均为 `cc-switch-ascii-name`（settings 基线） |
| `npm run typecheck:preview` | `scenes-tools.tsx` 0 错误；剩余 3 错在 `scenes-taskboard.tsx`（后由 taskboard 二期修复） |
| `npx biome check`（28 个改动文件） | 36 条诊断与 integration 基线同批文件逐条相同，无新增 |
| after 截图 | ✅ 24 张（6 场景 × desktop/mobile × light/dark），亮色 12 张切片逐张对照：T-01 研究报告卡恢复、T-02/T-03 终端错误可读、T-10 移动端 diff 单行号列、T-13 徽标统一等 |

→ 正文 §7 验证（阶段 B）。

## 4. 遗留与理由（本模块内无；以下为跨模块 / 需接线）

| 项 | 归属 | 状态 / 理由 |
|---|---|---|
| T-18 `App.tsx` 接线 | shell / 集成② | ✅ 集成② `19799c0fe` 已接（工具卡选中态） |
| X-01 委派过程窗口 `h-[min(420px,50vh)]` 固定高 | messages | ⏸ 未修（P2，建议 `max-h` 代替 `h`；5 步时下方留白 ~200px） |
| X-02 agent-group 表头 | messages | ◐ `aria-expanded` 已由 messages-B 加上；图标底 `size-6` vs `size-7` 不一致可不改 |
| X-03 `cronHuman` 星期区间 | manage | ✅ manage 二期 `26b865e2f` 已修 |
| 并行委派子任务名显示 slug | 需后端配合 | mcp-memory 聚合文本需带 displayName |

→ 正文 §8 遗留。

## 5. 分支 / 提交

- 分支 `feat/v5-selfhost-audit-tools` @ `d65c6741e`（基线 `210b9967`，自有提交 5 个 + 1 次合入 integration，29 files / +3906 −521 相对 `e6f73dd99`）
- 阶段 A：`0c0d291c7` 审计报告 + `scenes-tools.tsx`
- 合入 integration：`a139215c8`（`origin/feat/v5-selfhost-ocv5-audit-ux` @ `e6f73dd99`）
- 阶段 B：`769596cec` `c5ee11db4` `e569f9e66`；文档 `d65c6741e`
- 集成：`6fa690d7e`（集成②，@`d65c6741e`）；接线 `19799c0fe`（集成②）
