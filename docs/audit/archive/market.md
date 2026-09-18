# market · AI 市场 · 归档摘要

> 正文：[`docs/audit/market.md`](../market.md)（模块负责人维护；本文只做摘要与索引，不复制原文）。
> 任务：t-46「A·market 审计」→ t-47「B·market 修复」→ t-625「二期·market 遗留 P3 收尾（K-08/09/22/10/12/13/…）」（**在跑**，fable-5-1-57）。
> 分支 `feat/v5-selfhost-audit-market`，HEAD `1fb99bfcc`，基线 `210b9967`。
> 集成：market-B（@`1fb99bfcc`）由集成② `ab765669a` 合入；未登录「去登录」`onRequireLogin` 由集成② `19799c0fe` 在 `App.tsx` 接线。

## 1. 审出问题（P1 1 / P2 4 / P3 21，共 26；另 admin 面备注 K-26、跨模块 3 条）

| 严重度 | 编号与要点 |
|---|---|
| P1 | K-01 发布表单草稿随市场弹窗关闭（Esc / 点遮罩）无提示丢失 |
| P2 | K-02 卡片描述 `line-clamp-2` 被 `block` 抵消 · K-03 分区视图翻页时分区计数把「已加载」说成「共有」· K-04 详情弹层移动端底栏三枚全宽按钮 · K-05 「加载更多」失败在列表顶部报错 |
| P3 | K-06 搜索提示词不可点 · K-07 分类片无 `aria-pressed` · K-08 已安装行动作簇 · K-09 就绪状态三句打架 · K-10 导入芯片显示 slug · K-11 卡片描述对辅助技术隐藏 · K-12 桌面端分类片横滚不可达 · K-13 kill-switch 移动端占首屏 · K-14 title-only 解释 · K-15 详细介绍 Markdown 标题层级 · K-16 评分徽章表情 · K-17 半角标点 · K-18 日期与动词粘连 · K-19 `authMode` 枚举值泄漏 · K-20 移动端 Badge 被拉成全宽 · K-21 校验缺项播报占高 · K-22 已安装行 kind 徽章位 · K-23 详情内无卸载 · K-24 未登录「去登录」只是关弹窗 · K-25 长列表无分页 / 虚拟化 · K-27 审核面原生 checkbox |
| 跨模块 | X-01 `App.tsx` 未给市场 `onRequireLogin`（shell）· X-02 `/api/marketplace/search` 无 offset（后端）· X-03 弹层 footer `[&>*]:w-full` 拉宽 Badge（本模块内修，shell 仅备注） |

→ 逐条定位见正文 [§3 问题清单](../market.md#3-问题清单)、跨模块 §6；不修 / 暂缓项（offset 分页需后端、Checkbox 原语、FeaturedPanel admin 面、审核状态实时通知、场景文件格式、截图台 clip）见 §5。

## 2. 修复情况（阶段 B 修复 13 / 遗留 13，全部 P3 → 二期 t-625 在跑）

| 提交 | 内容 | 覆盖 |
|---|---|---|
| `da6fc3bc6` | 发布草稿落盘，关弹窗不再无提示丢失（`lib/marketplace.ts` 草稿存取 + 关弹窗 toast「已暂存」） | K-01（P1） |
| `2b81246ad` | 发现页卡片截断、分区计数、加载更多报错与可访问性 | K-02 K-03 K-05 K-06 K-07 K-11 |
| `2e58b37bc` | 详情底栏窄屏布局、评分图标与文案标点 | K-04 K-16 K-17 K-18 K-20 |
| `ef4fe9539` | 未登录「去登录」接可选 `onRequireLogin` 出口（market 侧；`App.tsx` 归集成②） | K-24 |

- 附录 5 件拍板事项落地口径：① K-01 落盘 + toast 而非阻断确认；② 不向后端提 offset；③ K-12 未动；④ K-23 未动（与「已安装页是卸载唯一权威」冲突）；⑤ K-24 加可选 prop、与 `ManageCenter` 同款契约。
- 接手链：修复由 fable-5-1-22 完成未提交 → fable-5-1-29 复核并分四组提交未推送 → fable-5-1-35 核对、补 K-24、推送交付。

→ 正文 §7 修复记录。

## 3. 验证摘要（工作树 `wt\market`）

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ 绿（接手复核与加 K-24 后各再跑一次仍绿） |
| 模块 vitest | ✅ `components/marketplace/**` + `MarketplaceCenter.test` 10 文件 / 109 例；`lib/marketplace.test` 绿 |
| `npx biome lint`（9 个源文件） | ✅ 未新增诊断（其余 15 条为基线既有） |
| after 截图 | ✅ 126 张全部成功（failures 0，`unmockedApi: []`）；接手复核重截 6 个关键场景 + `market-unauth` / `market-browse-skill`；对照：卡片两行截断生效、结果条「已加载 50 个技能，还有更多」、详情底栏两枚并排、评分 ThumbsUp 图标 |
| NOT RUN | `npm test` 全量（改动限于 marketplace 目录 + `lib/marketplace.ts`）、`npm run test:browser`（未触碰高频交互面）、真机 iOS、真实审核状态流转 |

→ 正文 §8 验证（阶段 B）。

## 4. 遗留与理由（阶段 B 末 13 条全部 P3 → 二期 t-625 落地 10 条，余 K-23 不做 / K-25 需后端；K-27 已由 t-1234 落地，待集成⑤）

| 项 | 原因 | 建议 / 状态 |
|---|---|---|
| K-08 / K-09 / K-22 已安装行动作簇、就绪文案、kind 徽章 | 同一 `CardRow` 结构三处改动需连带重写 `InstalledPanel.test`，阶段 B 预算优先 P1/P2 | 二期一并做 |
| K-10 导入芯片显示名 | 需引入 `manage/skillDisplay.skillDisplayTitle` 并同步 `PublishPanel.test` 断言 | 二期 |
| K-12 桌面端分类片横滚 | 换行 vs 箭头需拍板 | 拍板后约 10 行 |
| K-13 kill-switch 移动端占首屏 | admin 面、低频 | 二期 |
| K-14 / K-15 / K-19 title-only 解释、Markdown 标题层级、`authMode` 映射 | 需逐项核对后端契约字段 | 二期 |
| K-21 校验缺项播报占高 | 需与 SubmitBar「缺项即定位」契约一起重设计 | 二期 |
| K-23 详情内卸载 | 与「已安装页是卸载唯一权威」既有决定冲突 | 拍板后复用卸载弹层 |
| X-01 `App.tsx` 接线 | shell 归属 | ✅ 集成② `19799c0fe` 已接 |
| K-25 / X-02 offset 分页 / 虚拟化 | 需后端 | 后端提供 offset 后前端改 append |
| K-27 原生 checkbox | 需 shell 出 Checkbox 原语 | ✅ 已由遗留清扫 t-1234 落地：shell 新增 `ui/Checkbox` 原语 `959735722`，market 审核面 / 发布页四处接入 `ffac63718`，补场景 `market-review-partial` / `market-publish-agent-toolsets` `dc404359b`（分支 `feat/v5-selfhost-audit-leftover-shell@7e7c7e43b`，待集成⑤；摘要见 [leftover.md](./leftover.md)） |
| **二期 t-625 结论** | 上表 K-08 / 09 / 22 / 10 / 12 / 13 / 14 / 15 / 19 / 21 **全部 ✅ 落地**（K-12 取「换行」；K-14 徽章解释改 `Tooltip` + 注脚；K-19 新增 `connectorAuthModeLabel` 等三个人话映射）；K-23 按任务书保持不做；K-25 / K-27 保持遗留（需后端 offset / 需 shell Checkbox） | 提交 `079797abf` `98aa1e9fe` `e065996c1` `5cc56b8e0`，文档 `5391c150a`；新增场景 `market-detail-plugin`；模块单测 11 文件 / 152 例全绿（+14），before / after 各 88 张 failures 0 |

→ 正文 §9 遗留、[§10 二期收尾（t-625）](../market.md#10-二期收尾t-625--遗留-p3)。

## 5. 分支 / 提交

- 分支 `feat/v5-selfhost-audit-market` @ `5391c150a`（基线 `210b9967`，12 个提交）
- 阶段 A：`7240a8261` 审计报告 + `scenes-market-audit.tsx`
- 阶段 B：`da6fc3bc6` `2b81246ad` `2e58b37bc`；文档 `a96286981`；K-24 `ef4fe9539` + 文档 `1fb99bfcc`
- 二期（t-625）：`079797abf` `98aa1e9fe` `e065996c1` `5cc56b8e0`；文档 `5391c150a`
- 集成：`ab765669a`（集成②，B @`1fb99bfcc`）；接线 `19799c0fe`（集成②）；集成② `f7c08f3eb` 随契约更新 market 场景 import 后缀；**`be20adaec`（集成③，二期 @`5391c150a`，14 files +839/−195）**
