# manage · 管理中心（记忆 / 技能 / 定时 / 连接器 / 文献库 / 优化）· 归档摘要

> 正文：[`docs/audit/manage.md`](../manage.md)（模块负责人维护；本文只做摘要与索引，不复制原文）。
> 任务：t-38「A·manage 审计」→ t-39「B·manage 修复」→ 补丁① t-426（在 settings 分支承接 ConnectorsTab 四条）→ t-626「二期·manage 遗留 P3 收尾」（**在跑**，fable-5-1-54）。
> 分支 `feat/v5-selfhost-audit-manage`，HEAD `26b865e2f`，基线 `210b9967`。
> 集成：manage-B（@`af79d7b05`）由集成① `09a13a472` 合入；二期提交 `0a47b4948` `26b865e2f` 由集成③ `c761bbd93` 合入（QA t-1028 复核 6 ✅ / 0 ❌）；a11y-mod-a manage 四条随集成④ `68f031ba6`；a11y-C `b591e64b6`（`OptimizationPanel` 图标块 `-fg`）待集成⑤。

## 1. 审出问题（P1 1 / P2 8 / P3 18，共 27；另跨模块 3 条）

| 严重度 | 编号与要点 |
|---|---|
| P1 | M-01 未绑定看板的聊天项目作用域下，定时任务面板把 `cronBlocked` 渲染成「还没有定时任务」假空态 |
| P2 | M-02 用量分区字号回落 · M-03 读取失败与空态并排 · M-04 本实例手册读失败过于响亮 · M-05 只读技能用 disabled 控件呈现 · M-06 项目专属技能块（原生控件 / 密钥类判定）· M-07 开发者词汇进用户文案 · M-08 技能行头部窄屏挤掉标题 · M-09 插件卡动作簇窄屏不让位（`ConnectorsTab`，settings 归属） |
| P3 | M-10 放弃训练草稿吞错 · M-11 采纳 / 忽略无忙态 · M-12 半角标点 · M-13 技能三处三个名字 · M-14 智能体芯片与标签同形 · M-15 排程原文只在 Tooltip · M-16 `datetime-local` 无 min / 心跳无标识 · M-17 文献库只有增删 · M-18 accountHint 重复 · M-19 通用错误码写死「微博」· M-20 连接器降级零提示 · M-21 备注名编辑失焦不提交 · M-22 优化面板文案与双主按钮 · M-23 移动端「优化」Tab 在视口外 · M-24 记忆面板信息架构 · M-25 用户画像字数口径 · M-26 「历史（N）」懒加载 · M-27 「✗错」与草稿切换 |
| 跨模块 | X-01 `useProjectScope` 作用域重置竞态（sidebar，P2）· X-02 `ConnectorsTab.tsx` 落在 settings 目录 · X-03 `ui/Textarea` 无 readOnly 视觉态（shell，仅备注） |

→ 逐条定位与影响见正文 [§3 问题清单](../manage.md#3-问题清单)、跨模块见 §6；不修 / 暂缓项（文献库引用导出需后端、`scenes-manage.tsx` 格式化、嵌套弹层截图 clip、面板体量拆分等）见 §5。

## 2. 修复情况（阶段 B 发现 27 / 修复 22 / 遗留 5 → 二期后遗留 2，均需后端）

阶段 B 代码提交（按主题归组；逐条改动与用例见正文 §7）：

| 提交 | 内容 | 主要覆盖 |
|---|---|---|
| `f51852e15` | 定时任务未绑定会话组改为可解释空态，行内信息补可达性 | M-01 M-15 M-16 |
| `18c4ffb3b` | 技能列表 / 工作台 / 项目专属技能改造 | M-05 M-06 M-08 M-13 M-14 M-26 M-27 |
| `34917f3e4` | 记忆面板读失败与空态互斥、用量分区回归设计系统、收拢信息架构 | M-02 M-03 M-04 M-11 M-23 M-24 M-25 |
| `45e5d7891` | 训练草稿放弃不吞错、文献库按 ID / 语言检索、优化弹层文案、通用错误码去「微博」 | M-07 M-10 M-12（部分）M-17（部分）M-19 M-22 |

- 阶段 B 状态：22 条 ✅（含 M-12、M-17 两条部分修复）；M-09 / M-18 / M-20 / M-21 ⏸（文件归 settings）；附录 5 件拍板事项按指挥官口径落地（M-01 维持 P1、ConnectorsTab 不越界、M-23 取「窄屏补待办提示行」、M-06 ③ 用 `isSecretSkill` 规则兜底、X-01 测试绕开）。
- 补丁① t-426（settings 分支 `138accab4`）：M-09 / M-18 / M-20 / M-21 四条在 `ConnectorsTab.tsx` 落地，**已闭环**。
- 二期 t-626（分支上已有提交，任务待交付）：M-12 余量 ✅ `0a47b4948`（`SkillOptPanel` 用户可见文案 50 行全角化）；跨模块转来的 X-03 `cronHuman` 区间 ✅ `26b865e2f`（`lib/cron.ts` 周位 / 小时区间，新增场景 `manage-cron-range`）；X-01 已由 taskboard-B T-02 在 integration `43b7cd3a4`（`ef872e91a`）闭环；M-17 导出 / 详情、M-06 ③ `sensitive` 下发保持遗留（需后端）。

→ 正文 §7 修复记录、§10.1–10.2。

## 3. 验证摘要（工作树 `wt\manage`）

| 门 | 阶段 B | 二期（HEAD `26b865e2f`） |
|---|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ 绿 | ✅ exit 0 |
| 模块 vitest | ✅ 14 文件 / 153 例（阶段 A 基线 127，新增 26） | ✅ 17 文件全绿；`cron.ts` 三个使用方单测单跑绿 |
| 全量 `npm test` | ◐ 279 文件 / 3591 通过 / 147 跳过 / 3 失败均在 manage 之外且为基线（`MessageRenderer.test` beforeAll 超时等） | NOT RUN（改动限于 manage 归属 + 纯函数，全量门交集成③） |
| `npx biome check / lint` | ✅ 新建 / 重写 7 文件绿，无新增诊断 | ✅ 新增 0 |
| after 截图 | ✅ 49 场景 = 136 张，failures 0（`unmockedApi` 同阶段 A：`listCronChannels` / `listProjectAssets`） | ✅ after-2 3 场景 12 张 |
| NOT RUN | `test:browser`（未触碰高频交互面）、真机 iOS Safari、真实 OAuth 回跳 | 同左 |

→ 正文 §8 验证（阶段 B）、§10.3 验证（二期）。

## 4. 遗留与理由

| 项 | 归属 / 分类 | 理由 |
|---|---|---|
| M-17 文献库引用导出 / 文档详情 | 需后端配合 | `ResearchLibraryDoc` 无作者 / 年份 / venue，`/api/me/research/library*` 无单文档读接口；前端可做的搜索 / 标识增强已落地 |
| M-06 ③ `SkillSummary.sensitive` | 需后端配合 | 需后端下发；前端 `isSecretSkill` 规则兜底已就位（`skillDisplay.test`） |
| **二期 t-626 结论** | 已完成并验收 | §9 遗留 5 项 → 已修 1（M-12 余量 `0a47b4948`）/ 已由他处闭环 2（M-09/18/20/21 补丁①；X-01 taskboard-B）/ 保持遗留 2（M-17、M-06 ③，均需后端）；计划外承接跨模块 X-03 `cronHuman` 星期 / 小时区间（`26b865e2f`，受益 CronPanel / taskboard StageSettings / tools memoryReminderCards）；文档 `6fae01440` |

已闭环项：M-09 / M-18 / M-20 / M-21（补丁① `138accab4`）、X-01（`ef872e91a` → integration `43b7cd3a4`）、M-12 余量（`0a47b4948`）、X-03（`26b865e2f`）。→ 正文 §9 遗留、[§10 二期（t-626）](../manage.md#10-二期t-626-遗留-p3-收尾)、§10.4 仍遗留。

## 5. 分支 / 提交

- 分支 `feat/v5-selfhost-audit-manage` @ `6fae01440`（基线 `210b9967`，10 个提交）
- 阶段 A：`43a6d52f5` 审计报告 + `scenes-manage-audit.tsx`
- 阶段 B：`f51852e15` `18c4ffb3b` `34917f3e4` `45e5d7891`；文档 `ea24dc498` `af79d7b05`
- 二期（t-626）：`0a47b4948` `26b865e2f`；文档 `6fae01440`
- 相关他分支提交：`138accab4` `9582b5eb5`（settings 补丁①：ConnectorsTab 承接、CronPanel Telegram 收口）
- 集成：`09a13a472`（集成①，B @`af79d7b05`）；**`c761bbd93`（集成③，二期 @`6fae01440`，6 files +212/−73）**
