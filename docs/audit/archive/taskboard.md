# taskboard · 任务面板 · 归档摘要

> 正文：[`docs/audit/taskboard.md`](../taskboard.md)（模块负责人维护；本文只做摘要与索引，不复制原文）。
> 任务：t-42「A·taskboard 审计」→ t-43「B·taskboard 修复」→ t-630「二期·taskboard 遗留 P3 收尾」（**待验收**，交于 09-16 21:30）。
> 分支 `feat/v5-selfhost-audit-taskboard`，HEAD `05dd185df`，基线 `210b9967`。
> 集成：taskboard-B（@`0b06f7ce5`）由集成① `bf8188def` 合入（集成① `1ae92b831` 随契约更新 `cost-authority` 用例）；二期 `cb6629bd1` `05dd185df` 由集成③ `425655631` 合入（仅场景 1 行，消 `typecheck:preview` TS2322）；a11y-mod-b taskboard#2 随集成④ `80e757d95` 合入。

## 1. 审出问题（P1 2 / P2 14 / P3 14，共 30）

| 严重度 | 编号与要点 |
|---|---|
| P1 | T-01 首屏 projects / agents 丢失（与 `loadInitial` 同 commit 抢跑）· T-02 冷启深链 `?project=` 被误判失效回落 `all`（`useProjectScope`，sidebar 归属） |
| P2 | T-03 看板接口失败无错误态 · T-04 默认在途筛选不可见 · T-05 抽屉无关闭按钮 · T-06 移动端抽屉主动作折叠成「···」· T-07 「取消」歧义 · T-08 状态术语多套叫法 · T-09 卡片 meta 截断 · T-10 移动端顶栏密度 · T-11 阶段导航触控靶 · T-12 阶段编辑草稿随 `reload` 丢失 · T-13 输入即请求 · T-14 开发者术语 · T-15 卡片 `role=button` 嵌套可交互 · T-16 空态无下一步 |
| P3 | T-17 a11y 细节 · T-18 抽屉结构（评论框在讨论上方）· T-19 冲突文案三套与忙态 · T-20 死代码 · T-21 成本 / 周报打磨 · T-22 护栏设置数字输入 · T-23 危险操作位置与确认 · T-24 桌面 6 列固定 288px · T-25 移动端弹层范式不统一 · T-26 内联新建表单无标题 / 标签 · T-27 乐观评论作者 · T-28 流水线配置移动端与长表单 · T-29 来源会话按钮 · T-30 深链单据不在已加载列表时无操作 |

→ 逐条定位见正文 [§3 问题清单](../taskboard.md#3-问题清单)；不修 / 暂缓 9 项（触屏拖拽、`Sheet` 原语关闭钮、`cronHuman`、`BoardViewParam` 类型、成本钉死文案、轮询改推送、200/页、成本图表化、CRLF 格式差异）见 §5。

## 2. 修复情况（P1 1 修复 + 1 转 sidebar；P2 14/14；P3 12/14 + 2 部分）

| 提交 | 内容 | 覆盖 |
|---|---|---|
| `42fc60a79` | 阶段 B 业务代码 + 测试（21 个文件；新增 `PanelSheet.tsx` 统一四个配置抽屉外壳、`auditFixes.test.tsx` 按 T 编号组织的回归用例） | T-01、T-03～T-19、T-21～T-27、T-29、T-30 全修；T-20、T-28 部分 |
| `fe787f009` | ui-preview 场景随阶段 B UI 更新（新增 `taskboard-mobile-config-menu`） | 视觉门 |
| `ef872e91a`（sidebar 分支） | 项目范围深链冷启不再误判失效回落 `all` | **T-02 已由 sidebar-B 修复**（integration `43b7cd3a4` 起生效） |
| `cb6629bd1`（二期） | 预览台末站 `onSuccess` 改 `wait_human`，修 `typecheck:preview` 的 TS2322（shell S-19 暴露的 3 处） | 二期唯一可独立完成项 |

- 需指挥官知悉的取舍（正文 §6.3）：T-08 状态文案按计划推荐值直接落地（「积压 / 待确认 / 已完成 / 已取消」，只动 `TICKET_STATUS_LABEL`）；T-12 保存遇 409 改为保留本地草稿 + 提示覆盖 / 载入最新；T-20 删掉 URL 不可达的 `backlog` 视图及其用例。
- 接手说明：修复由 fable-5-1-23 完成后掉线，fable-5-1-19 接手只复核、按精确文件分两条提交并推送；二期 t-630 由 fable-5-1-35 完成，新增代码改动 0（场景 1 行 + 文档）。

→ 正文 §6 修复记录、§8 二期。

## 3. 验证摘要（工作树 `wt\taskboard`）

| 门 | 阶段 B（含接手复核 §7.2） | 二期 |
|---|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ exit 0 | ✅ |
| 模块 vitest（`src/components/taskboard` + `taskboardFeature.test`） | ✅ 10 files / 124 tests（阶段 A 9 / 101 → 新增 `auditFixes.test` 23 条 + 1 条，删 1 条死视图用例） | ✅ |
| `npm run typecheck:preview` | —（S-19 脚本在 shell 分支） | ✅ `scenes-taskboard.tsx` 0 错 |
| `npx biome check --formatter-enabled=false` | 0 条新增；2 条存量 `organizeImports` 未动 | 同左 |
| after 截图 | ✅ 17 场景 × desktop/mobile × light/dark = 66 张，failures 0，接手后以提交内容全量重拍 | — |
| `npm run test:browser` | NOT RUN（任务面板不在 §3 高频交互面内） | NOT RUN |

顺手清理（二期）：删除工作树里一次 `tsc` 误发射留下的 753 个未跟踪 `.js`，未动被跟踪文件。→ 正文 §7 验证、§7.2 接手复核、§8。

## 4. 遗留与理由

| 项 | 分类 | 理由 |
|---|---|---|
| T-20 `BoardViewParam` 的 `inbox/backlog` 类型 | 部分修复 · shell 归属 | `hooks/useAppRoute.ts` 属 shell，注释声明「仅保留旧调用兼容」，无功能影响；本模块死分支已删净（集成①记录：不接） |
| T-28 直接新建 AI 阶段 | 部分修复 · 后端约束 | 后端要求 AI 阶段绑定 agent（`buildStagePatch` 同一约束），前端已把两步流程写进新建行说明 |
| §5 暂缓 9 项 | 维持 | 平台限制 / 他模块归属 / 需后端 / 非缺陷（其中 `cronHuman` 区间已由 manage 二期 `26b865e2f` 修复） |
| **二期 t-630 结论** | 已验收通过 | 可独立完成的只有 1 项（`scenes-taskboard.tsx` `onSuccess:'close'` → `'wait_human'`，消集成① 登记的 `typecheck:preview` TS2322，`cb6629bd1`，业务代码零改动）；T-20 / T-28 维持部分修复；T-02 已由 sidebar-B `ef872e91a` 修复；§5 暂缓 9 项全部维持 |

→ 正文 [§8 二期](../taskboard.md#8-二期t-630--09-16--fable-5-1-35-遗留-p3-收尾)。

## 5. 分支 / 提交

- 分支 `feat/v5-selfhost-audit-taskboard` @ `05dd185df`（基线 `210b9967`，6 个提交，23 files / +4586 −1550）
- 阶段 A：`6cdb31cdf` 审计报告 + 重写 `scenes-taskboard.tsx`
- 阶段 B：`42fc60a79` `fe787f009`；文档 `0b06f7ce5`
- 二期：`cb6629bd1`；文档 `05dd185df`
- 集成：`bf8188def`（集成①，@`0b06f7ce5`）、`1ae92b831`（集成①用例更新）；**`425655631`（集成③，二期 @`05dd185df`，2 files +20/−1）**
