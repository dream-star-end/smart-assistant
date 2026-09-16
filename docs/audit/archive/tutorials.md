# tutorials · 教程中心 · 归档摘要

> 正文：[`docs/audit/tutorials.md`](../tutorials.md)（模块负责人维护；本文只做摘要与索引，不复制原文）。
> 任务：t-52「A·tutorials 审计」（已完成）→ t-53「B·tutorials 修复」（**在跑**，fable-5-1-54；原持有人多次离线后重派）。
> 分支 `feat/v5-selfhost-audit-tutorials`，HEAD `5bf80f0bc`（仅阶段 A），基线 `210b9967`。
> 集成：尚未合入 integration（待 tutorials-B 交付后由集成③合入）；集成② `419e0d218` 已在仓根 `.gitattributes` 把教程夹具标 `-text`（对应 TU-36 的 Windows 检出问题）。

## 1. 审出问题（P1 0 / P2 12 / P3 25，共 37）

| 严重度 | 编号与要点 |
|---|---|
| P2 | TU-01 26 篇功能参考在导航里没有入口 · TU-02 精选作品详情「案例展厅」页签失效且不可深链 · TU-03 「帮助与创作」原生 `<details>` 下拉 · TU-04 移动端搜索 / 筛选零反馈 · TU-05 手写教程表单必填星号无校验 · TU-06 发布对话框 placeholder 当模板 · TU-07 工作室目录错误态 / 骨架缺失 · TU-08 撤回无确认 · TU-09 快照分类标签裸值 · TU-10 「待采集」内部术语 · TU-11 移动端触控 < 44px · TU-12 免责声明可读性 |
| P3 | TU-13 22 KB 死代码 `MissionReplay` · TU-14 未落地设计（案例侧栏 / 搜索匹配）· TU-15 案例脚本无分类 / 搜索 · TU-16 「成果预览」装饰数据 · TU-17 快速上手 / 案例脚本 / 精选作品不进 URL · TU-18 侧栏不滚到当前教程 · TU-19 0.9s 即算已读 · TU-20 三套复制实现 · TU-21 五种 CTA 文案 · TU-22 `text-[8px]`～`text-[10.5px]` · TU-23 `sr-only` 逃出滚动容器 · TU-24 页签 / chip 无语义 · TU-25 工作室子视图顶部 120–350px 留白 · TU-26 文案 / 格式化 · TU-27 提交快照禁用条件 · TU-28 iframe 沙箱 · TU-29 / TU-30 图稿修补 · TU-31 快速上手第 1 / 4 步同指 · TU-32 任务面板 CTA 不识别 · TU-33 搜索框 < 16px iOS 放大 · TU-34 硬编码色值 · TU-35 空文本成果 · TU-36 字节精确夹具 Windows 不可移植 · TU-37 门禁路径分隔符进哈希 |

→ 逐条定位见正文 [§3 问题清单](../tutorials.md#3-问题清单)；不修 / 暂缓项（TU-13 删 vs 改需拍板、TU-31 内容决策、TU-34 品牌深蓝 hero、12 条案例 `pending_capture` 为采集流水线进度、`shoot.mjs` 存量诊断、演示媒体内容、真后端行为）见 §5；阶段 B 开工时的跨模块请求（TU-17 / TU-32 需 shell 配合）见 §4 末。

## 2. 修复情况

- **待补：t-53「B·tutorials 教程中心修复」**（在跑）。阶段 B 提交、编号 → 状态 → 提交映射、计划偏离以 `docs/audit/tutorials.md` 修复记录章节与 complete_task 交付为准。
- 阶段 A 已落地的共享基建修补（随本分支）：`be7ddf00b` ui-preview 内联 bundle 做 HTML 脚本数据转义（`<!--` / `</script` 转义，避免新增场景后整段脚本静默失效）。

→ 正文 §4 修复计划（含每条的改法、补测与风险）。

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
| **待补：阶段 B 验证** | t-53 交付后补 |

→ 正文 §2.5 跑过的验证、§2.6 阶段 A 提交与接手说明。

## 4. 遗留与理由

- **待补：t-53** —— 阶段 B 遗留清单以其交付为准。
- 阶段 A 已知需拍板 / 需他人：TU-13（`MissionReplay` 删或改）、TU-31（内容决策）、TU-34（shell token）、TU-17 / TU-32（需 shell 配合深链与任务面板 CTA）、TU-36 / TU-37（仓库级 `.gitattributes` 与门禁脚本路径归一化；夹具行尾部分已由集成② `419e0d218` 处理）。

→ 正文 §5 建议不修 / 暂缓项及理由。

## 5. 分支 / 提交

- 分支 `feat/v5-selfhost-audit-tutorials` @ `5bf80f0bc`（基线 `210b9967`，3 个提交，3 files / +1319 −1）
- 阶段 A：`be7ddf00b` ui-preview 内联 bundle 转义修补；`5023c70fd` 27 个 ui-preview 场景；`5bf80f0bc` 审计报告
- 阶段 B：待补（t-53）
- 集成：待集成③
