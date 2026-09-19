# permission-card · 会话内权限审批卡 未决态审批交互 · 归档摘要（t-875，t-837 作废重开）

> 正文：`docs/audit/permission-card.md`（随 `feat/v5-selfhost-audit-permission-card` 合入后可读 **[待集成④]**）。本文只做摘要与索引。
> 任务：t-875「PermissionCard·未决态审批交互 专审+修复（重开，接 t-837）」，A→B 同人合一；执行 fable-5-1-56（场景 / before / PC-01…15 代码与用例，未提交即离线）→ fable-5-1-52（无改动）→ fable-5-1-23 接手收口。
> 背景：t-760 覆盖复查指出 messages-A 的 `ask-user-question` 场景只含「已解析权限卡」，未决态（待决 / 批准中 / 拒绝 / 超时 / 多卡并发 / 键盘 / 移动端）无人审过。
> 分支 `feat/v5-selfhost-audit-permission-card`，HEAD `8a3179896`，基线 `210b9967`。**归档统计排除 t-837**：正文 §0 核对表结论 —— t-837 没有任何声称项落地到 integration（`PermissionCard.tsx` 与基线逐字节相同、无文档、无提交），其工作树半成品由 t-875 逐行走读后收口。

## 1. 审出问题（P1 0 / P2 5 / P3 12，共 17）

| 严重度 | 编号与要点 |
|---|---|
| P2 | PC-01 卡头 390px 标题压成竖排、工具片截半 · PC-02 待决卡看不到智能体要做什么（命令 / 文件 / 题干）· PC-04 多卡并发被顶掉的活提问没记 dismissed 也无待答入口 → 轮次卡住 · PC-12 问答选项组每项独立 Tab 停靠、无方向键 / Home / End · PC-13 未答提交只给红边不播报不移焦点 |
| P3 | PC-03 过期 fail-safe 两句自相矛盾 · PC-05 状态切换读屏静默 · PC-06「约 1440 分钟内有效」· PC-07 临期只靠变色 · PC-08 内联「拒绝」像灰字 · PC-09 计划预览一刀切断 · PC-10 / 11 待答入口条信息缺失 / 重复 · PC-14 多题不知答到第几题 · PC-15「其他」回车不提交 · PC-16 批准中看不出在动 · PC-17 ExitPlan 卡头连写两遍 |

P1 0：待决 → 允许 / 拒绝 → 结清主链路可用；弹框单例、dismissed 记忆、过期判据、只读 surface、题干截断取回均有既有用例锁定。→ 正文 §3 问题清单、§3.1 指挥官补发审计面（可用态 / 记住选择 / loading / 防重复 / 失败重试 / 焦点去向 / Tab 顺序 / Esc / Enter / aria / 超时 / 撤回 / 会话切换 / 多卡 / 移动端 / 深浅色）逐项结论。

## 2. 修复情况（发现 17 / 修复 17 / 不修 0）

- `2ceeff88f` feat：PC-01…PC-17 全部（组件层，未改 `permissionPopupCoordinator.ts` / `permissionReconcile.ts` / socket 状态机 / ui 原语 / App）—— 卡头 `flex-wrap` + 状态 / 倒计时成组右对齐；`compactRequestSummary()` 待决摘要；活提问过期 fail-safe 说明；`PermissionPromptHost.minimized` 兜底扩到活提问；卡头状态 `<output>`；`formatPermissionRemaining()` ≥90 分钟按小时；临期图标 + title；「拒绝」改 `secondary`；计划预览渐隐；入口条「共 N 项待处理」；选项组方向键 / Home / End + roving tabindex；校验 `role=alert` + 聚焦；每题「i / N」；「其他」回车提交；批准中旋转 loader；ExitPlan 不重复工具片。
- `292ed1bad` test：`scenes-permission-card.tsx` 13 场景；`3f2c40ad9` test：截图台外链 bundle（前任带入，与 integration 同源方案）；`4680572c1` / `8a3179896` 文档。
- 跨模块：`MessageRenderer.test.tsx` 1 处断言随 PC-02 契约改写（`within(dialog)`），拿锁后改。

→ 正文 §4 修复记录。

## 3. 验证摘要（工作树 `wt\permission-card`）

| 门 | 结果 |
|---|---|
| `typecheck` | ✅ exit 0 |
| 组件单测 | ✅ `PermissionCard.test` 70 例（基线 57 → +13） |
| 时间线层 / chat 目录 | ✅ `MessageRenderer.test` 147 例；`src/components/chat` + `src/lib/chat` 60 文件 / 1274 例 |
| `biome lint` | ✅ 新增 0（`PermissionCard.tsx` 11 条与 HEAD 逐条相同） |
| 预览台类型检查 | ◐ 基线分支无 `typecheck:preview` 脚本；借 integration 配置临时跑，`browser-tests/ui-preview/**` 0 错，20 条落在 `../protocol/src` 为基线 tsconfig 差异 → 合入后由集成④ 全量门覆盖 **[待集成④]** |
| `test:browser` | ✅ `run.mjs` T1–T67 全部 ok；`node --test` 70/73（基线 cc-switch ×2 + ocv5-185 symlink） |
| 视觉 | ✅ before 12 场景 48 张 / after-2 13 场景 52 张，failures 0 |
| NOT RUN | `npm test` 全量（交集成④）、真机、读屏实机 |

## 4. 遗留与理由

| 项 | 处置 | 归属 |
|---|---|---|
| 自动弹出的弹框关闭后焦点落回 `document.body` | ⏸ 遗留 | shell（`Modal` 已暴露 `onCloseAutoFocus`，App / MessageList 层接线一行） |
| 「正在提交…」无超时 / 重试 | ⏸ 遗留 | 协调器 / `lib/chat` 状态机 |
| 内联「拒绝」无二次确认 · 「已跳过」问答不展示题目 · 待答入口条整条不可键盘聚焦 | 不修（既有交互约定 / 内置按钮即键盘入口） | — |

## 5. 分支 / 提交

- `feat/v5-selfhost-audit-permission-card` @ `8a3179896`：`3f2c40ad9` `292ed1bad` `2ceeff88f` `4680572c1` `8a3179896`
- 集成：**[待集成④]**（基于 `210b9967`；`3f2c40ad9` 与 integration 截图台改动同文件，留意合并）
