# A·landing 落地页 / 登录 / 法务 / 桌面端登记 · 审计报告

- 分支：`feat/v5-selfhost-audit-landing`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`）
- 阶段：A（只审计，不改业务代码）
- 结论：**P1 × 0 / P2 × 3 / P3 × 17**，共 20 条。没有阻断主流程的问题：登录 / 注册 / 验证 / 找回 /
  重置五个模式的状态机、Turnstile 三态 fail-closed、多 tab 登出广播、静默续期都经得起读。三条 P2 全在
  公开首页：营销页把设计系统的 CTA 渐变换成了柠檬绿，但三处仍写死 `text-white`，白字压在柠檬绿上
  对比度约 1.3:1；页脚备案位是占位文案「备案信息更新中」+ 一个不可点的「联系合作」；移动端头部导航
  整体隐藏、没有替代菜单，九个分区在手机上只能一路滑。
- 跨模块另记 3 条（§6）：法务静态页在 `main.tsx` 入口短路、不经 `useTheme`（shell）；`--grad-cta`
  在落地页作用域缺一枚配套前景色 token（shell `styles.css`）；`BRAND.icp` 需运营提供真实备案号。

---

## 1. 范围与文件清单

首屏与登录链路：Landing、AuthGate（登录 / 注册 / 验证码 / Turnstile / 错误提示）、LegalPage、
DesktopEnrollPage、认证广播与会话恢复。

| 类别 | 文件（`packages/web-react/src/` 下） | 行数 |
|---|---|---|
| 落地页 | `components/Landing.tsx`（头部 / Hero / 工作方式 / 能力 / 场景 / 智能体 / 团队版 / FAQ / CTA / 页脚） | 657 |
| 落地页子件 | `components/landing/DemoShowcase.tsx`（动态演示）、`ArtifactPreview.tsx`、`Tutorials.tsx`（三步上手 + 开口第一句）、`demoScripts.ts`、`gameDemoTranscript.ts` | 381 / 373 / 167 / 352 / 46 |
| 登录 | `components/AuthGate.tsx`（五模式 + 协议弹窗 `LegalLinks`）、`components/TurnstileWidget.tsx` | 779 / 121 |
| 法务 | `components/LegalPage.tsx`、`lib/legal.ts`（正文权威源） | 65 / 173 |
| 桌面端登记 | `components/DesktopEnrollPage.tsx` | 153 |
| 鉴权状态 | `hooks/useAuth.ts`、`lib/{authBroadcast,authHint,authSession}.ts` | 365 / 69 / 27 / 26 |

对应 `*.test.ts(x)` 随源文件归属（`landing/DemoShowcase.test` 48 / `Tutorials.test` 25 /
`gameDemoTranscript.test` 44 行；AuthGate / useAuth 的用例在 `App.test.tsx` 与 `browser-tests/**`）。
审计维度按 PLAYBOOK §5 七项清单逐项过。

**不在本轮范围**：`main.tsx` / `App.tsx` 接线（shell）、`styles.css` 的 `.congjian-landing` 作用域
（shell）、`components/ui/**`、`lib/brand.ts`（shell）、`components/BrandMark` / `ThemeToggle`（shell）、
案例展厅 `TutorialCenter`（tutorials）。

---

## 2. 方法与证据

### 2.1 ui-preview 场景

这一组此前**没有任何** ui-preview 场景。新增 `browser-tests/ui-preview/scenes-landing.tsx`
（`api-stub.ts` 未改；`Scene.group` 沿用既有联合类型里的「工作区」，不动共享 `types.ts`），29 个场景：

| 组 | 场景 id | 内容 | 视口 |
|---|---|---|---|
| 落地页 | `landing-home` | 首屏（头部导航 / Hero / 双 CTA / 演示窗口顶部） | desktop / mobile |
| 落地页分区 | `landing-section-{demo,tutorials,workflow,capabilities,scenarios,agents,enterprise,faq,footer}` | 挂载后把锚点滚进视口（`<ScrollTo>`），还原点顶部导航后的真实位置 | desktop / mobile |
| 落地页交互 | `landing-faq-open` | FAQ 展开一条 | desktop |
| 登录 | `auth-login` / `auth-login-error` / `auth-login-config-pending` / `auth-login-turnstile-fail` / `auth-login-loading` | 默认；凭据错误 + 「重试恢复登录状态」；公开配置未就绪「正在准备登录…」；Turnstile 需要但 site key 缺失；提交中 | desktop（前四个 + mobile） |
| 注册 / 验证 / 找回 / 重置 | `auth-register` / `auth-register-closed` / `auth-verify` / `auth-forgot` / `auth-reset` / `auth-reset-invalid` | 四字段 + 协议勾选；关闭注册后回落登录；6 位验证码；找回；带 token 重置；缺 token | desktop / mobile |
| 协议弹窗 | `auth-legal-modal` | 登录页点《用户协议》就地弹窗 | desktop / mobile |
| 法务静态页 | `legal-terms` / `legal-privacy` | 整页 | desktop / mobile |
| 桌面端登记 | `desktop-enroll` / `desktop-enroll-invalid` / `desktop-enroll-device-limit` / `desktop-enroll-returning` | 带计算机名；链接无效；确认失败（DEVICE_LIMIT）；确认成功正在返回 | desktop / mobile |

技术点（收在场景文件里，不动 harness / shoot.mjs）：Landing 根节点是 `h-full overflow-y-auto` 内滚容器且
`styles.css` 把 `html/body/#root` 钉在 `100dvh + overflow:hidden`，整页截图只拍得到第一屏 —— 分区场景用
`<ScrollTo>` 把锚点 `scrollIntoView` 后再截；桌面登记确认成功会 `location.assign('openclaude://…')`，
预览台里把 `enrollNavigation.assign` 钉成空操作，页面不被导航走。

### 2.2 截图基线

```
D:\code\test_project\test123\.audit-tmp\landing\before\
```

100 张 PNG（29 场景 × 声明视口 × light/dark），`manifest.json` `failures: 0`、`retried: 0`、
`unmockedApi: []`。复跑命令：

```powershell
cd d:\code\test_project\test123\wt\landing\packages\web-react
$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:OC_UI_SHOTS='D:\code\test_project\test123\.audit-tmp\landing\before'
$env:OC_UI_SCENES='landing-,auth-,legal-,desktop-enroll'
$env:OC_UI_SHOT_DELAY='1200'
node browser-tests\ui-preview\shoot.mjs
```

直接充当证据的几张：

- `landing-section-tutorials--desktop--light.png` —— 「1 / 2 / 3」步骤圆点与「打开案例展厅 →」按钮都是
  白字压柠檬绿渐变，几乎读不出（L-01）。
- `landing-home--mobile--light.png` —— 390px 头部只剩 Logo / 主题切换 / 登录 / 免费开始，五个分区导航整体消失
  且无菜单（L-03）；主题切换图标在固定深色的首页上按了没有可见变化（L-07）。
- `landing-section-footer--*.png` —— 页脚「备案信息更新中」「联系合作」（L-02）。
- `landing-section-demo--mobile--light.png` —— 动画进行中，左栏在两行执行步骤之下留出约一屏空白（答案区按完整
  文案预留高度）；顶部能力 Tab 条第 4 片被右缘截断、无滚动暗示（L-08）。
- `auth-verify--desktop--light.png` —— 验证码输入框的占位文案被 `tracking-[0.4em]` 一并拉开成「请 输 入 邮 箱 里 的
  6 位 验 证 码」（L-05）。
- `auth-login-error--mobile--light.png` —— 「邮箱」「密码」标签与占位符同词（L-11）；页脚「全能助手 · 流式对话 ·
  持久会话」（L-13）。
- `auth-legal-modal--mobile--light.png` / `legal-terms--mobile--dark.png` —— 「更新日期:2026-07-10 · 生效日期:2026-
  07-10」半角冒号、同一值两个标签、窄屏把日期折成两行；正文「(以下简称"本服务")」「协议;你勾选」半角标点成片
  （L-04、L-14）。
- `desktop-enroll-device-limit--mobile--light.png` —— 「请先在设置中解绑」没有去设置的出口（L-16）。

预览台已知伪差异：`landing-home` 在 light 主题下也是深色 —— `.congjian-landing` 自带 `color-scheme: dark`
与整套 token 覆盖，首页固定深色是产品决定，不是缺陷；分区场景截图顶部的 sticky 头部是真实遮挡（`congjian-section`
已有 `scroll-margin-top: 84px`，锚点定位正确）。

### 2.3 跑过的验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿（exit 0；`browser-tests/**` 不在 tsconfig include 内，场景文件靠 esbuild 构建 + 运行期 0 失败兜底） |
| 代码风格 | `npx biome check packages/web-react/browser-tests/ui-preview/scenes-landing.tsx` | ✅ 绿 |
| 视觉基线 | `node browser-tests/ui-preview/shoot.mjs`（`OC_UI_SCENES=landing-,auth-,legal-,desktop-enroll`） | ✅ 100 张全部成功，0 渲染错误 0 页面异常，0 未打桩 API |
| 对比度取证 | 取 `styles.css` `.congjian-landing` 的 `--grad-cta`（`#d5ff84→#b4f04e`）与 `#fff` 计算 | 约 1.3:1（AA 要求 4.5:1） |
| 文案取证 | `rg "[\u4e00-\u9fa5][,;][\u4e00-\u9fa5]" lib/legal.ts` | 43 处半角逗号 / 分号夹在中文里 |

**未跑**（`NOT RUN`）：`npm test`（阶段 A 未改任何业务代码与既有测试；阶段 B 必跑）、`npm run test:browser`
（未触碰高频交互面；`browser-tests/` 里既有的 auth 契约用例属阶段 B 回归项）、真实 Turnstile 挑战 / 邮件验证码 /
密码重置邮件 / 桌面深链（都需真后端或真桌面端）、真机 iOS Safari。

---

## 3. 问题清单

严重度：**P1** 功能不可用/数据错误/阻断主流程；**P2** 明显体验缺陷/一致性破坏/移动端不可用；**P3** 打磨项。
文件路径省略 `packages/web-react/src/` 前缀。

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| L-01 | `components/landing/Tutorials.tsx:144-146`（步骤圆点 `bg-grad-cta … text-white`）、`:161-167`（「打开案例展厅」`bg-grad-cta … text-white`）、`components/landing/DemoShowcase.tsx:276-278`（窗口顶栏图标 `bg-grad-cta text-white`）；`styles.css:362`（`.congjian-landing { --grad-cta: linear-gradient(125deg,#d5ff84,#b4f04e) }`） | 落地页作用域把 CTA 渐变从紫蓝换成柠檬绿，但三处仍写死 `text-white`：白字 / 白图标压在 `#d5ff84–#b4f04e` 上，对比度约 1.3:1 | 「三步上手」的 1/2/3 与「打开案例展厅」这枚通往案例展厅的唯一 CTA 几乎不可读（AA 需 4.5:1）；同页 `Button variant="primary"` 用的是 `text-primary-fg`（落地页作用域覆盖为深色墨）所以正常 —— 只有这三处绕过了 token。见 `landing-section-tutorials` | P2 |
| L-02 | `components/Landing.tsx:704`（`<span>联系合作</span>`）、`:712`（`{BRAND.icp}`）；`lib/brand.ts:12`（`icp: '备案信息更新中'`） | 页脚「条款」栏第三项「联系合作」是与两条链接同样式的纯文本，没有任何联系方式；备案位显示占位文案「备案信息更新中」 | 公开首页页脚是可信度与合规的落点：一个"链接"点了没反应，一个法定信息位写着"更新中"。备案号需运营提供（§6 X-03），「联系合作」前端可先给邮箱 / 去掉 | P2 |
| L-03 | `Landing.tsx:294-313`（`<nav className="hidden … md:flex">`），无任何 `md:hidden` 的菜单入口 | 五个分区导航（产品演示 / 核心能力 / 工作场景 / 智能体 / 团队版）在 `<768px` 整体隐藏，没有汉堡菜单或替代跳转 | 手机上九个分区、约 12 屏高度只能一路下滑；页脚只兜住其中 3 个锚点。见 `landing-home--mobile` | P2 |
| L-04 | `lib/legal.ts:25`、`:108` 及全文（43 处 `，`→`,`、`；`→`;`，`(以下简称"本服务")` 半角括号 + 直引号）；`components/LegalPage.tsx:65`、`AuthGate.tsx:854`（`更新日期:${updated} · 生效日期:${updated}`） | 法务正文成片半角标点、直引号；日期行用半角冒号，且「更新日期」「生效日期」是同一个 `TERMS_VERSION` 值的两个标签 | 用户协议 / 隐私政策是全站最正式的文本，却是标点最乱的一块；两个日期恒等 = 其中一个是噪音。见 `legal-terms`、`auth-legal-modal` | P3 |
| L-05 | `AuthGate.tsx:652-659`（验证码 `Input` `className="… text-center text-[18px] tracking-[0.4em]"` + `placeholder="请输入邮箱里的 6 位验证码"`） | 为 6 位数字设计的 0.4em 字距同样作用于 12 字的中文占位符 | 占位文案被拉成「请 输 入 邮 箱 里 的 6 位 验 证 码」，像排版事故；见 `auth-verify` | P3 |
| L-06 | `Landing.tsx:326`（免费开始）、`:353`（开始使用从简）、`:669`（免费开始使用）、`:551`（用我的任务试试）、`:586`（浏览智能体市场）；`DemoShowcase.tsx:420`（免费试一句） | 同一个 `onStart` 动作在首页有六种文案；其中「浏览智能体市场」承诺的是市场，落地却是开始使用 / 登录 | CTA 文案不一致削弱"下一步是什么"的确定性；「浏览智能体市场」名不副实 | P3 |
| L-07 | `Landing.tsx:316`（`<ThemeToggle … titleHint="影响登录后的界面" />`） | 首页固定深色，主题切换按了没有任何可见变化，解释只在原生 `title`（触屏永远看不到） | 手机用户按了三下不知道发生了什么 | P3 |
| L-08 | `DemoShowcase.tsx:338-366`（答案区 `invisible` 撑位 + 绝对定位覆打）、`:250`（Tab 条 `overflow-x-auto no-scrollbar`） | ① 移动端左栏在执行步骤之下预留整段答案高度（约一屏）空白，直到打字开始；② 能力 Tab 条第 4 片起被截、无右缘渐隐或滚动暗示 | ① 「页面零位移」的代价在 390px 上是一屏空白（桌面 md 起定高 440px 无此感）；② 用户不知道右边还有「改代码 / 团队协作 / 深度调研」。见 `landing-section-demo--mobile` | P3 |
| L-09 | `AuthGate.tsx:494-502`、`:585-603`、`:766-784`（5 个 `type="password"` 输入） | 密码 / 确认密码 / 新密码均无「显示密码」切换 | 注册与重置各要输两遍密码，输错只能删掉重输；移动端尤甚 | P3 |
| L-10 | `AuthGate.tsx:527-533`（`loginPending ? <Spinner size={17} /> : …`） | 配置未就绪时点过登录，按钮只剩一枚 spinner，没有任何文字 / `aria-label` | 读屏听到一个空按钮；视觉上也分不清是"在登录"还是"在等配置"（旁边的 `output` 写的是「正在准备登录…」） | P3 |
| L-11 | `AuthGate.tsx:477`（`placeholder="邮箱"`）、`:499`（`placeholder="密码"`）、`:567`、`:717`（`注册邮箱`） | 占位符与上方标签同词 | 占位符没提供示例格式（`name@example.com`）也没提供帮助，纯重复 | P3 |
| L-12 | `AuthGate.tsx:757`（「重置链接无效或缺少 token。」） | 用户文案里出现 `token` | 开发者词汇 | P3 |
| L-13 | `AuthGate.tsx:802`（「全能助手 · 流式对话 · 持久会话」） | 登录页页脚三个卖点里「流式对话」「持久会话」是实现词 | 与落地页面向用户的语言（「长任务不中断」「成果直接可使用」）不一致 | P3 |
| L-14 | `AuthGate.tsx:854`（`Modal description`）、`:855`（`className="max-w-2xl"`） | 协议弹窗副标题在 390px 折成「…生效日期:2026-」「07-10」两行，日期被腰斩 | 见 `auth-legal-modal--mobile` | P3 |
| L-15 | `main.tsx:13-22`（`/terms` `/privacy` 在入口层短路渲染 `<LegalPage>`，不进 `<App>`）；`LegalPage.tsx` 无主题切换 | `useTheme` 挂在 App 内：法务静态页拿不到用户已选主题（也没有系统偏好接线），且页面本身没有切换入口 | 深色用户从登录页点《用户协议》**新标签**打开（修饰键路径）会落到亮色页；预览台由 harness 加 `.dark` 类才拍到暗色（代码审阅结论，接线归 shell，见 X-01） | P3 |
| L-16 | `DesktopEnrollPage.tsx:124`（「链接无效」）、`:43`（「请先在设置中解绑」）、`:52`（「操作过于频繁」）、`:78`（`cancel()` → `location.assign("/")` 整页刷新） | ① 无效链接只有一句话，没有「返回首页 / 重新发起」出口；② 设备上限提示没有去设置的链接；③ 限流提示没有「稍后再试」；④ 取消走整页刷新 | 卡在一个只有一句话的卡片里；见 `desktop-enroll-invalid`、`desktop-enroll-device-limit` | P3 |
| L-17 | `Landing.tsx:369`（hero 勾选列表 `text-[12.5px] text-[#747970]`）、`:384`（`text-[11.5px] … text-[#777d73]`）、`:222`（`text-[12px] … text-[#747a70]`）、`:428`（`text-[11px] … text-[#777d73]`） | `#74797x` / `#777d73` 压在 `#090a08–#0d0f0c` 上约 4.3–4.6:1，且都是 11–12.5px 小字 | 卡在 AA 门槛上下，暗色玻璃背景（`bg-white/[0.025]`）上再降一点；营销页小字用 `#8b9086`（≈6:1）一档更稳 | P3 |
| L-18 | `Landing.tsx:150-164`（`api.listOrgPlansPublic()` 失败静默）、`:211`（`{anchor ?? '¥88/席起'}`） | 公开档位接口失败时显示写死的「¥88/席起」 | 价格改了、接口抖一下，首页就在报旧价 | P3 |
| L-19 | `components/landing/Tutorials.tsx:102`（`title="点击复制"`）、`:117`（复制图标 `opacity-0 group-hover:opacity-70`） | 「开口第一句」芯片的可复制暗示只有 hover 才出现的图标 + 原生 `title` | 触屏用户看不到任何"可复制"的暗示（只有上方一句说明），点完才见 ✓ | P3 |
| L-20 | `components/TurnstileWidget.tsx:137`（宿主 `<div ref={hostRef} className={className}>` 无尺寸） | 真 widget（65px 高）加载完成才撑开高度 | 登录卡在 Turnstile 加载瞬间向下跳一次（CLS）；bypass=false 的生产环境每次打开都发生 | P3 |

---

## 4. 修复计划

### L-01 落地页三处 `text-white` 压柠檬绿渐变（P2，必修）

- **改**：`landing/Tutorials.tsx:144-146`、`:161-167`；`landing/DemoShowcase.tsx:276-278`。
- **怎么改**：`text-white` → `text-primary-fg`（落地页作用域已把 `--primary-fg` 覆盖为深色墨，与同页
  `Button variant="primary"` 一致；工作区主题下 `--grad-cta` 是紫蓝、`--primary-fg` 是白，两处都对）。
  若 shell 愿意给 `--grad-cta-fg` token（§6 X-02）则换成它，语义更准。
- **补测试**：`Tutorials.test.tsx` 加一例断言三处元素 `className` 不含 `text-white`；`landing-section-tutorials`
  出 after 图。
- **风险**：无。

### L-02 页脚「联系合作」与备案占位（P2，必修 · 部分需运营）

- **改**：`Landing.tsx:704`、`:712`；`lib/brand.ts:12`（shell）。
- **怎么改**：「联系合作」→ `<a href="mailto:…">`（邮箱由 `BRAND.contactEmail` 提供，缺则整项不渲染）；
  `BRAND.icp` 为占位文案时页脚**不渲染**备案位（而不是显示"更新中"），真实备案号由运营填入 `brand.ts`
  后自动出现，并加 `<a href="https://beian.miit.gov.cn/">` 外链（工信部要求）。
- **补测试**：`Landing` 渲染用例：`icp` 为占位时页脚无「备案」字样；有值时渲染为外链。
- **风险**：低；`brand.ts` 归 shell，改一行需 shell 点头（X-03）。

### L-03 移动端无分区导航（P2，必修）

- **改**：`Landing.tsx:294-330`。
- **怎么改**：`md:hidden` 处加一枚 `IconButton`（`Menu` 图标，`aria-label="打开导航"`，`aria-expanded`），
  点开在 header 下方展开一列锚点链接（`<details>`/受控 state，点击任一项后收起），复用 `nav` 的五个锚点；
  桌面端零变化。
- **补测试**：`Landing` 用例：窄屏（`matchMedia` 桩）点击「打开导航」后可见五个链接，点击链接后收起。
- **风险**：低。

### L-04 法务文案标点与日期行（P3）

- **改**：`lib/legal.ts` 全文标点全角化（`,`→`，`、`;`→`；`、`(…)`→`（…）`、`"…"`→`「…」`，数字 / 英文不动）；
  `LegalPage.tsx:65` 与 `AuthGate.tsx:854` 改为「生效日期：{updated}」一个字段（更新 = 生效时不重复），
  冒号全角。
- **补测试**：`legal.test.ts`（新建）：断言 `LEGAL_DOCS` 全部正文不含 `/[\u4e00-\u9fa5][,;][\u4e00-\u9fa5]/`。
- **风险**：无（不改语义，只改标点；`TERMS_VERSION` 不动 —— 它是后端留证的版本号，不是"内容改动"）。

### L-05 验证码占位符字距（P3）

- **改**：`AuthGate.tsx:652-659`：`placeholder` 改为「6 位数字」并把字距只作用于有值时
  （`className={cn("rounded-xl bg-bg text-center text-[18px]", code && "tracking-[0.4em]")}`），或用
  `placeholder:tracking-normal`。

### L-06 CTA 文案统一（P3）

- **改**：首页六处 → 两档：主 CTA 统一「免费开始」（头部 / hero / 末屏），场景内 CTA 统一「用它试试」；
  「浏览智能体市场」→「开始使用，再去市场安装」或改为登录后打开市场（需 App 支持 `onStart('market')`，
  可选）。

### L-07 首页主题切换（P3）

- **改**：`Landing.tsx:316`：切换后给一枚 2s 的 toast / 行内提示「已切换到浅色，登录后生效」；或首页直接不放
  主题切换（登录页已有）。

### L-08 演示区移动端（P3）

- **改**：`DemoShowcase.tsx:338-366`：`max-sm:` 下不预留完整答案高度（`invisible` 撑位改为 `hidden sm:block`），
  接受移动端打字时的自然增长；`:250` Tab 条加右缘渐隐（同 BrowsePanel 分类片写法）。

### L-09 / L-10 / L-11 / L-12 / L-13 登录页打磨（P3）

- `AuthGate.tsx`：① 抽 `PasswordInput`（`Input` + 尾部 `IconButton` `Eye/EyeOff`，`aria-label="显示密码"`），
  五处替换；② `loginPending` 分支加 `<span className="sr-only">正在准备登录</span>`；③ 占位符改示例：
  邮箱 `name@example.com`、密码留空（有标签即可）；④ 「缺少 token」→「链接不完整，请从邮件重新打开」；
  ⑤ 页脚三卖点改「多模型 · 长任务 · 成果可用」或去掉。
- **补测试**：`App.test.tsx` 既有登录用例不受影响（按钮可及名不变）；新增显示密码切换一例。

### L-14 协议弹窗副标题（P3）

- 随 L-04 改成单字段后自然不折行；再加 `whitespace-nowrap`。

### L-15 法务静态页主题（P3，跨模块）

- `main.tsx` 在渲染 `LegalPage` 前读一次 `useTheme` 的存储键并给 `<html>` 挂 `.dark`（或 `LegalPage` 自己
  `useTheme()`）；`LegalPage` 头部加 `ThemeToggle`。接线归 shell（X-01）。

### L-16 桌面端登记出口（P3）

- `DesktopEnrollPage.tsx`：「链接无效」→ `Alert` 加 action「返回首页」+ 说明「请在 {nameEn} 里重新发起」；
  DEVICE_LIMIT → action「去设置解绑」（`/?settings=devices` 深链，需 App 路由支持则先只放「返回首页」）；
  「操作过于频繁」→「操作过于频繁，请稍后再试」；`cancel()` 改 `history.pushState` + App 路由
  （若无路由钩子则保持）。

### L-17 小字对比度（P3）

- `Landing.tsx` 四处 `#74797x/#777d73` 小字 → `#8b9086`（Logo 副标已在用，≈6:1）；11px 的 kicker 提到 11.5px。

### L-18 静态兜底价（P3）

- `Landing.tsx:211`：接口失败时不显示价格（`anchor ?? null` → 只显示「随需加席」），或把兜底价放进
  `BRAND`/构建期常量并加注释「与 plans 表同步」。

### L-19 复制暗示（P3）

- `Tutorials.tsx:117`：复制图标常驻 `opacity-50`（hover 70），去掉 `title`；芯片右上加一枚「复制」文字徽章
  （`text-caption`）。

### L-20 Turnstile 宿主占位（P3）

- `TurnstileWidget.tsx:137`：宿主 `min-h-[65px]`（normal 尺寸官方高度）+ 加载期一枚 `Skeleton`。

---

## 5. 建议不修 / 暂缓项

| 项 | 理由 |
|---|---|
| **首页固定深色** | `.congjian-landing` 的 `color-scheme: dark` + token 覆盖是产品决定（营销页独立视觉），L-07 只处理"切了没反应"的困惑，不改固定深色本身。 |
| **`Landing.tsx` 的硬编码色值**（`#f5f4ed` / `#c7ff64` / `#777d73` …约 60 处） | 营销页刻意脱离设计系统 token；统一收敛成 `--landing-*` 变量属重构，不影响用户可感知结果，本轮只修对比度不达标的四处（L-17）。 |
| **鉴权状态机**（`useAuth` 静默续期 / epoch / 多 tab 登出 / lane 门） | 代码审阅未见用户可感知缺陷：refresh 只在 INVALID_REFRESH / VALIDATION 清鉴权，5xx / 网络留在恢复态重试；登出广播 token-free；`oc_auth_hint` 让匿名访客不发无谓 refresh。真实回归依赖后端，属阶段 B `browser-tests` 范畴。 |
| **Turnstile 真实挑战** | headless 无法完成 CF 挑战；组件只保证加载 / render / 回调 / 卸载清理（有注释说明），端到端待 canary 关闭 bypass 后验证。 |
| **`TutorialCenter` 案例展厅** | tutorials 归属；本轮只覆盖首页入口按钮。 |
| **备案号本身** | 需运营提供（X-03）；前端只负责"没有就不显示占位"。 |

---

## 6. 跨模块发现（不在本模块归属，已 / 待通报）

| 编号 | 位置 | 现象 | 归属 / 处置 |
|---|---|---|---|
| X-01 | `main.tsx:13-22` | `/terms` `/privacy` 在入口层短路，不经 `useTheme`，法务页拿不到用户主题 | **shell**：入口读一次主题存储键挂 `.dark`，或允许 `LegalPage` 自己调 `useTheme`（L-15）。 |
| X-02 | `styles.css:149`、`:188`、`:362`（`--grad-cta` 三处定义） | CTA 渐变只有背景色 token，没有配套前景色；落地页作用域换成柠檬绿后所有 `text-white` 搭配失效 | **shell**：建议补 `--grad-cta-fg`（工作区 `#fff`、落地页 `#0b0d09`）并在 `@theme` 暴露 `text-grad-cta-fg`；本模块 L-01 先用 `text-primary-fg` 兜住。 |
| X-03 | `lib/brand.ts:12`（`icp: '备案信息更新中'`） | 备案位是占位文案 | **shell + 运营**：真实备案号到位后填入；前端按 L-02 做"占位不渲染"。 |

---

## 附：阶段 B 开工前需要拍板的事

1. **L-02**：「联系合作」给邮箱还是删掉？备案号何时到位（决定是"占位不渲染"还是直接填真值）。
2. **L-03**：移动端菜单形态 —— header 下展开一列锚点（最小改动）还是全屏抽屉。
3. **L-06**：主 CTA 统一文案取「免费开始」还是「开始使用从简」；「浏览智能体市场」是否要真的打开市场
   （需 App `onStart` 带目标，shell 接线）。
4. **L-07**：首页保留主题切换（加即时反馈）还是去掉。
5. **L-15 / X-01**：法务页主题接线由 shell-B 顺手改，还是授权 landing-B 改 `main.tsx` 三行。
