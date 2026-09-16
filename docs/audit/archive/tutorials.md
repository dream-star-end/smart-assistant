# tutorials · 教程中心 · 归档摘要

> 正文：[`docs/audit/tutorials.md`](../tutorials.md)（模块负责人维护；本文只做摘要与索引，不复制原文）。
> 任务：t-52「A·tutorials 审计」（已完成）→ t-53「B·tutorials 修复」（已完成并验收，fable-5-1-54 接手自 fable-5-1-35 的未提交改动）。
> 分支 `feat/v5-selfhost-audit-tutorials`，HEAD `02c358655`（A 3 提交 + B 6 提交），基线 `210b9967`。
> 集成：集成③ `ce767d8ce` 合入（A+B 一起，25 files +2404/−934；唯一冲突 `shoot.mjs` 取 integration 外链 bundle 方案）；App 接线 TU-32 `bdf7b4d15`；集成② `419e0d218` 已在仓根 `.gitattributes` 把教程夹具标 `-text`（TU-36）。

## 1. 审出问题（P1 0 / P2 12 / P3 25，共 37）

| 严重度 | 编号与要点 |
|---|---|
| P2 | TU-01 26 篇功能参考在导航里没有入口 · TU-02 精选作品详情「案例展厅」页签失效且不可深链 · TU-03 「帮助与创作」原生 `<details>` 下拉 · TU-04 移动端搜索 / 筛选零反馈 · TU-05 手写教程表单必填星号无校验 · TU-06 发布对话框 placeholder 当模板 · TU-07 工作室目录错误态 / 骨架缺失 · TU-08 撤回无确认 · TU-09 快照分类标签裸值 · TU-10 「待采集」内部术语 · TU-11 移动端触控 < 44px · TU-12 免责声明可读性 |
| P3 | TU-13 22 KB 死代码 `MissionReplay` · TU-14 未落地设计（案例侧栏 / 搜索匹配）· TU-15 案例脚本无分类 / 搜索 · TU-16 「成果预览」装饰数据 · TU-17 快速上手 / 案例脚本 / 精选作品不进 URL · TU-18 侧栏不滚到当前教程 · TU-19 0.9s 即算已读 · TU-20 三套复制实现 · TU-21 五种 CTA 文案 · TU-22 `text-[8px]`～`text-[10.5px]` · TU-23 `sr-only` 逃出滚动容器 · TU-24 页签 / chip 无语义 · TU-25 工作室子视图顶部 120–350px 留白 · TU-26 文案 / 格式化 · TU-27 提交快照禁用条件 · TU-28 iframe 沙箱 · TU-29 / TU-30 图稿修补 · TU-31 快速上手第 1 / 4 步同指 · TU-32 任务面板 CTA 不识别 · TU-33 搜索框 < 16px iOS 放大 · TU-34 硬编码色值 · TU-35 空文本成果 · TU-36 字节精确夹具 Windows 不可移植 · TU-37 门禁路径分隔符进哈希 |

→ 逐条定位见正文 [§3 问题清单](../tutorials.md#3-问题清单)；不修 / 暂缓项（TU-13 删 vs 改需拍板、TU-31 内容决策、TU-34 品牌深蓝 hero、12 条案例 `pending_capture` 为采集流水线进度、`shoot.mjs` 存量诊断、演示媒体内容、真后端行为）见 §5；阶段 B 开工时的跨模块请求（TU-17 / TU-32 需 shell 配合）见 §4 末。

## 2. 修复情况

- 阶段 B（t-53）：37 条中 **✅ 28 / ◐ 部分 5（TU-19 / 20 / 24 / 29 / 32）/ ⏸ 4（TU-17 / 21 / 34 需 shell 或产品口径，TU-36 已由集成② 在仓根落地）**；P2 12/12 全部落地。
  - `e722bdf5f`：TU-01/02/03/04/10/11/13/14/15/16/18/19/22/23/24/26/31/33（沿用前任未提交改动并补齐用例；删 22 KB `MissionReplay`，拍板①；快速上手第 4 步改指「设定目标」，拍板②）
  - `d6eb6ef35`：TU-05/06/07/08/09/11/20/25/26/27/35（教程工作室表单门槛、错误态、撤回确认、分类标签）
  - `36ba6e6f0`：TU-10/11/12/22/28/29/30/32（免责声明对比度、展厅 iframe 沙箱、图稿口径、任务面板 CTA 门禁）
  - `527a514e2`：计划外 —— 窄屏页签去图标、状态播报 `<output>`、截图台适配 DropdownMenu
  - `0e0e4de76` 文档；`02c358655`：指挥官追加 TU-37 门禁路径归一化（集成待办 t-865 转来）+ TU-22 9–11px 字号收敛（t-762 走查转来）
- 阶段 A 已落地的共享基建修补（随本分支）：`be7ddf00b` ui-preview 内联 bundle 做 HTML 脚本数据转义（集成③ 合入时与 integration 外链方案冲突，取 integration 版本）。

→ 正文 [§6 修复记录（阶段 B）](../tutorials.md#6-修复记录阶段-b)（编号 → 状态 → 改动 → 用例 → 提交全表，含计划外与指挥官追加）。

## 3. 验证摘要（阶段 A，工作树 `wt\tutorials`）

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ exit 0 |
| 场景文件类型检查（单独 `tsc --noEmit` 跑 `scenes-tutorials.tsx`） | ✅ 0 错 |
| `npx biome check --formatter-enabled=false scenes-tutorials.tsx` | ✅ 0 诊断 |
| 视觉基线 | ✅ 27 场景 / 108 张全部成功，0 失败 0 重试 0 未打桩（`.audit-tmp\tutorials\before\`） |
| 模块单测基线（12 文件 / 82 例） | 80 ✅ 2 ❌，两条失败均为 `tutorialShowcase.test.ts` 字节 / SHA 校验，根因 CRLF；`public/tutorials` 以 LF 重检后 4/4 ✅ |
| `npm run check:tutorials` | ❌ 本机不可运行（CRLF + 反斜杠路径进哈希，TU-36 / TU-37）；`tutorial-sync.json` 与 history 未动 |
| NOT RUN | `npm test` 全量、`test:browser`、真后端（投稿 / 撤回 / 快照发布 / blob 内嵌）、真机 iOS Safari |
| **阶段 B** `typecheck` | ✅ exit 0（每次提交前） |
| **阶段 B** 模块单测 | ✅ 12 文件 / 95 例全绿（阶段 A 基线 82，新增 13；`tutorialShowcase` 夹具 LF 还原后 4/4） |
| **阶段 B** `biome lint` 22 文件 | ✅ 新增 0（`TutorialCenter.tsx` 4 → 2） |
| **阶段 B** 视觉 after | ✅ 27 场景 / 108 张，failures 0（两轮，首轮暴露菜单场景与窄屏页签问题后复拍） |
| **阶段 B** `npm run check:tutorials` | ✅ `OK · 26 capabilities · 12 real-world cases · 26 media pairs`（TU-37 修后本机首次转绿） |
| **阶段 B** NOT RUN | `npm test` 全量、`test:browser`（未触碰高频交互面；全量门由集成③ 跑：298 文件 / 4213 例全绿，`run.mjs` 68/68） |

→ 正文 §2.5 跑过的验证、§2.6 阶段 A 提交与接手说明、[§7 验证（阶段 B）](../tutorials.md#7-验证阶段-b)。

## 4. 遗留与理由

| 项 | 归属 / 原因 |
|---|---|
| TU-17 深链 `view=` / `work=` | shell `useAppRoute` + `App.tsx`（本模块 state 已上提，接线成本一层 props）；集成③ 登记待办 |
| TU-21 CTA 五种文案 + 字面量比较 | 产品口径 + `App.tsx` 传参，需同批改 3 个组件用例与场景 |
| TU-34 品牌深蓝 hero | shell token `--hero-bg / --hero-fg`；集成③ 登记待办（可选） |
| TU-19 已读判定 0.9s | 产品口径（改口径会让老用户已读勾号变少，先问再改） |
| TU-20 统一复制 hook / TU-24 余量（卡片内容模型、焦点交接、跳到正文）/ TU-29 封面幽灵字 | 打磨，部分修复保留 |
| TU-32 App 侧 `taskboardEnabled` 一行 | ✅ 已由集成③ `bdf7b4d15` 接线 |
| TU-36 `.gitattributes` | ✅ 集成② `419e0d218` |

阶段 A 的两个拍板点（TU-13 删 `MissionReplay`、TU-31 第 4 步改指「设定目标」）已按指挥官拍板落地。

→ 正文 §5 建议不修 / 暂缓项及理由、[§8 遗留](../tutorials.md#8-遗留)、[§9 跨模块接线](../tutorials.md#9-跨模块接线给集成③--owner)。

## 5. 分支 / 提交

- 分支 `feat/v5-selfhost-audit-tutorials` @ `02c358655`（基线 `210b9967`，9 个提交）
- 阶段 A：`be7ddf00b` ui-preview 内联 bundle 转义修补；`5023c70fd` 27 个 ui-preview 场景；`5bf80f0bc` 审计报告
- 阶段 B：`e722bdf5f` `d6eb6ef35` `36ba6e6f0` `527a514e2`；文档 `0e0e4de76`；指挥官追加 `02c358655`（TU-37 / TU-22）
- 集成：`ce767d8ce`（集成③，A+B @`02c358655`）；App 接线 `bdf7b4d15`（TU-32）；`shoot.mjs` 冲突取 integration 版本
