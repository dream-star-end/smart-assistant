# landing · 落地页 / 登录 / 法务 / 桌面端登记 · 归档摘要

> 正文：[`docs/audit/landing.md`](../landing.md)（模块负责人维护；本文只做摘要与索引，不复制原文）。
> 任务：t-48「A·landing 审计」→ t-49「B·landing 修复」。无二期任务。
> 分支 `feat/v5-selfhost-audit-landing`，HEAD `b97adb3fb`，基线 `210b9967`。
> 集成：landing-B（@`b97adb3fb`）由集成② `6201518b2` 合入；`brand.contactEmail` 接线 `19799c0fe`、`App.test` 登录控件改按标签取（解除 L-11 阻塞）`f7c08f3eb`。

## 1. 审出问题（P1 0 / P2 3 / P3 17，共 20；另跨模块 3 条）

| 严重度 | 编号与要点 |
|---|---|
| P2 | L-01 落地页三处 `text-white` 压柠檬绿渐变（对比度约 1.3:1）· L-02 页脚「联系合作」不可点 + 备案占位文案 · L-03 移动端无分区导航 |
| P3 | L-04 法务文案半角标点与日期行 · L-05 验证码占位符字距 · L-06 同一动作六种 CTA 文案 · L-07 首页固定深色下主题切换无反馈 · L-08 演示区移动端留白 / Tab 条 · L-09 无「显示密码」· L-10 配置未就绪时只剩 spinner · L-11 占位符与标签同词 · L-12 用户文案出现 `token` · L-13 页脚卖点用实现词 · L-14 协议弹窗副标题折行 · L-15 法务静态页拿不到用户主题 · L-16 桌面端登记无效链接无出口 / 设备上限无去处 · L-17 小字对比度 · L-18 接口失败显示写死「¥88/席起」· L-19 复制暗示只在 hover · L-20 Turnstile 宿主无占位 |
| 跨模块 | X-01 `main.tsx` 法务页短路不经 `useTheme`（shell）· X-02 `--grad-cta` 无配套前景色 token（shell）· X-03 `BRAND.icp` 需真实备案号（shell + 运营） |

→ 逐条定位见正文 [§3 问题清单](../landing.md#3-问题清单)、跨模块 §6；不修 / 暂缓项（首页固定深色、`Landing.tsx` 约 60 处硬编码色值、鉴权状态机、真实 Turnstile 挑战、`TutorialCenter` 展厅、备案号本身）见 §5。

## 2. 修复情况（P2 3/3；P3 13 修复 + 2 部分 + 2 遗留）

| 提交 | 内容 | 覆盖 |
|---|---|---|
| `89b5e5a0d` | 落地页 / 登录 / 法务 / 桌面端登记修复（P2×3 + P3×13）：`text-primary-fg` 兜住 CTA 前景、`contactEmail` / `icp` 占位不渲染、窄屏导航 `IconButton` + 菜单、法务全文标点全角化、`PasswordInput`、CTA 文案统一「免费开始」、`LegalPage` 自接 `useTheme` + `ThemeToggle`、小字统一 `#8b9086`、Turnstile 300×65 占位 + Skeleton 等 | L-01～L-07、L-09、L-10、L-12～L-15、L-17～L-20 ✅；L-08、L-16 ◐ |

- 部分修复：L-08 ②③ 已做（Tab 条渐隐、触控靶），① 移动端左栏预留高度未动；L-16 ①③ 已做（无效链接补说明 + 「返回首页」），② 设备上限「去设置解绑」缺网页端设备管理页。
- 顺手项：`DemoShowcase` 三枚 `<button>` 补 `type="button"`、`legal.ts` 两条模板字面量改普通字符串。

→ 逐条改动与用例见正文 §7 修复记录。

## 3. 验证摘要（工作树 `wt\landing`）

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ exit 0 |
| 模块 vitest | ✅ 9 个文件全绿（`AuthGate.test` 既有 28 例未动 + 新增 8；`Landing.test` +9 / 改 2；`LegalPage.test` +3；`DesktopEnrollPage.test` +2；`TurnstileWidget.test` 等） |
| 全量 `npm test` | ◐ 278 文件 277 通过 / 3735 例 3733 通过；唯一失败 `tutorialShowcase.test.ts` 2 例为 Windows autocrlf 基线（主克隆同样红） |
| `npx biome lint`（17 个文件） | ✅ 新增 0；顺手修掉 8 条既有告警（18 → 10） |
| after 截图 | ✅ 106 张 / 31 场景 × light/dark（29 既有 + 2 新增），failures 0；关键 12 张逐张对照（正文 §8.1） |
| NOT RUN | `test:browser`（未触碰高频交互面，且 `run.mjs` 无真实 `AuthGate` / `Landing` DOM 用例；登录链路由 shell `App.test.tsx` 三层用例覆盖）、真实 Turnstile / 邮件验证码 / 重置邮件 / 桌面深链、真机 iOS Safari |

→ 正文 §8 验证（阶段 B）、§8.2 未跑与理由。

## 4. 遗留与理由

| 项 | 归属 | 理由 / 状态 |
|---|---|---|
| L-11 登录页占位符 = 标签 | shell（`App.test.tsx`） | 占位符被 shell 的 `App.test` 用 `getByPlaceholderText('邮箱'/'密码')` 锁定，本模块不越界；**集成② `f7c08f3eb` 已把 App.test 登录控件改按标签取**，后续可改占位符 |
| L-16 ② 设备上限「去设置解绑」 | 产品 / 桌面端 | 网页端缺设备管理页；设置中心若补「本地模式设备」分区，这里加一枚 `action` 即可 |
| X-01 法务页主题接线 | shell | 已由 `LegalPage` 自接 `useTheme`，`main.tsx` 不必再动 |
| X-02 `--grad-cta-fg` token | shell | 本模块用 `text-primary-fg` 兜住；补 token 后三处各换一个类名 |
| X-03 备案号 / 联系邮箱 | shell + 运营 | `brand.ts` 填入真实 `icp` 即自动出现；`contactEmail` 字段已由集成② `19799c0fe` 加上 |
| 兜底锚点价 | 产品 | L-18 改为接口失败不报价，仅「按席位计费，随需加席」 |

→ 正文 §7.1 遗留与需要别人的事。

## 5. 分支 / 提交

- 分支 `feat/v5-selfhost-audit-landing` @ `b97adb3fb`（基线 `210b9967`，3 个提交，18 files / +1604 −175）
- 阶段 A：`ecc7a7d2d` 审计报告 + `scenes-landing.tsx`
- 阶段 B：`89b5e5a0d`；文档 `b97adb3fb`
- 集成：`6201518b2`（集成②，@`b97adb3fb`）；接线 `19799c0fe`、用例 `f7c08f3eb`（集成②）
