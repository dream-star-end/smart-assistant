# messages · 消息渲染与会话时间线 · 归档摘要

> 正文：[`docs/audit/messages.md`](../messages.md)（模块负责人维护；本文只做摘要与索引，不复制原文）。
> 任务：t-32「A·messages 审计」→ t-33「B·messages 修复」→ t-629「二期·messages 遗留 P3 收尾」（**待验收**，交于 09-16 20:58）。
> 分支 `feat/v5-selfhost-audit-messages`，HEAD `2abe389a9`，基线 `210b9967`。
> 集成：messages-B（@`d2f84063d`）已由集成① `985b3ae57` 合入；二期 `2abe389a9`（仅文档）待集成③。

## 1. 审出问题（P1 0 / P2 4 / P3 21，共 25）

| 严重度 | 编号与要点 |
|---|---|
| P2 | M-01 只读面（教程回放 / 后台查看器）仍出现可点「编辑」· M-02 移动端 Markdown 表格拆词、横滑提示常显 · M-03 触屏下每条消息常显整排 44px 动作图标 · M-04 活动指示 `aria-live` 每秒播报 `(Ns)` |
| P3 | M-05 footer 双内边距缩进 · M-06 流式光标独占一行 · M-07 折叠摘要恒绿勾 · M-08 token 数无单位 · M-09 每条用户消息常显「已回复 / 已送达」· M-10 折叠开关无 `aria-expanded` · M-11 dock / 原始记录按钮触控靶 · M-12 HtmlPreview / OptionsBlock 触控靶与 busy 无提示 · M-13 评价 TagChip 触控靶 · M-14 HtmlPreview 兜底用了不存在的 token · M-15 「重新加载」颜色回落 · M-16 品牌名硬编码 · M-17 目标卡用时 `1260s` · M-18 停止 / 失败后部分回答无复制 · M-19 英文回答中文朗读 · M-20 复制失败静默 · M-21 生成中查找不能跳转 · M-22 demo 通道动作条无触屏兜底 · M-23 回到底部按钮遮挡内容 · M-24 `_liveStreamBroken` 无 UI 消费方 · M-25 多标签旧快照覆写 IDB（待验证） |

→ 逐条定位与影响见正文 [§3 问题清单](../messages.md#3-问题清单)；不修 / 暂缓项（hover 动作条预留高度、KaTeX 预览台限制、demo 通道重构、首屏尾窗逻辑、socket/reducer/persist 内部重构）见正文 §5。

## 2. 修复情况（修复 22 / 遗留 3；二期 0 新增改动）

阶段 B 按主题分 4 个代码提交（正文 §8.1 未逐条标 SHA，按提交主题归组如下）：

| 提交 | 覆盖编号 |
|---|---|
| `6619d78a8` Markdown 宽表不拆词、流式光标内联、富块触控与复制失败提示 | M-02、M-06、M-12、M-14、M-20 |
| `94fc5a69a` 只读面去死按钮、触屏动作行折叠、token 并入 MetaRow 等卡片修复 | M-01、M-03、M-05、M-07、M-08、M-09、M-10、M-11、M-16、M-17、M-18、M-19、M-22、M-23 |
| `9d2fd9b4c` 活动指示读屏只播阶段文案、评价 chip / 重新加载触控与配色 | M-04、M-13、M-15 |
| `8e990ad12` 真浏览器用例 T68（触屏动作行折叠） | M-03 的 DOM 交互门 |

- P2 4/4 全部修复；P3 18/21。M-16 的另一处（`Composer.tsx:487` 品牌名）由 composer-B `360c82f50` 承接。
- 二期 t-629（`2abe389a9`，fable-5-1-35）：复核三条遗留均不满足「归属内可独立完成」，composer 移交的「排队中」气泡既有代码已满足且有用例 → **不改代码，只登记结论**。

→ 逐条改动 / 文件 / 用例见正文 §8.1，计划外顺手项见 §8.2，二期评估见 §10。

## 3. 验证摘要（工作树 `wt\messages`）

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ 绿 |
| 模块 vitest（15 个测试文件） | ✅ 411 用例全绿（含 tools 的 ToolCard.test 以确认 token 徽章文案改动不影响其断言） |
| 全量 `npm test` | 278 文件 / 3750 用例，唯一失败 `tutorialShowcase.test.ts` 2 例（Windows autocrlf 基线，主克隆同样失败） |
| `npm run test:browser` | `run.mjs` **68/68 ok**（含新增 T68；T25/T38/T29/T46/T63/T66 复跑通过）；`node --test` 中 `chat-navigation` 冷启抖动单跑 10/10 过，`cc-switch-ascii-name` 为 settings 基线失败 |
| `npx biome lint` | 改动文件无新增诊断 |
| after 截图 | 28/28（7 场景 × desktop/mobile × light/dark），`.audit-tmp\messages\after\`；对照要点见正文 §9.1 |
| 二期 | 只读复核，`git status` 干净，无代码改动 |

→ 正文 §9 验证（阶段 B）与 §10。另：阶段 A 顺手修了共享截图台两处（内联 bundle 被 HTML 解析器吞掉、移动端 fullPage 丢 `hover:none`），见正文 §2.2。

## 4. 遗留与理由

| 项 | 归档分类 | 理由 |
|---|---|---|
| M-21 生成中查找不能跳转 | 需独立设计 | 「跳转但不 pin」要与 stick-to-bottom / wheelFence（T63/T66 守的滚动篱笆）重新约定谁拥有 scrollTop，需独立的滚动交互设计 + 新真浏览器用例 |
| M-24 `_liveStreamBroken` 无 UI 消费方 | 需状态机专项 | 复核后范围缩到 `outbound.resume_failed → forceSync` 的 REST 全量同步窗口；落在 `socket.ts` / `useChatSocket.ts` 状态机上，须跑全部 chat 单测 + T29/T46，建议随下一轮 lib/chat 专项 |
| M-25 多标签旧快照覆写 IDB | 需真后端复现 | 本轮全部本地做（d-24），ui-preview / browser-tests 无 WS 后端，无法复现即不动持久层 |

→ 正文 §8.3 与 §10。

## 5. 分支 / 提交

- 分支 `feat/v5-selfhost-audit-messages` @ `2abe389a9`（基线 `210b9967`，8 个提交，29 files / +2201 −131）
- 阶段 A：`901cc3a06` 截图台改外链 bundle + 修移动端整页截图；`58d3fcc5d` 审计报告 + `scenes-messages.tsx`
- 阶段 B：`6619d78a8` `94fc5a69a` `9d2fd9b4c` `8e990ad12`；文档 `d2f84063d`
- 二期：`2abe389a9`（文档，t-629）
- 集成：`985b3ae57`（集成①，合入 @`d2f84063d`）；相关跨模块提交 `09d15400f`（集成①，`useChatSocket` 空标题走 `EMPTY_SESSION_TITLE`，sidebar ST-01）、`091a1a7bb`（settings 补丁①，红卡余额不足文案去手抄价格 SET-15）
- 待补：t-629 验收结论（当前待验收）
