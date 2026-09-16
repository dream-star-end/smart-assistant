# settings 模块审计（A 阶段）· 设置中心 / ChatGPT 直连 / 组织中心 / 支付

> 任务：t-40「A·settings 设置中心/组织/支付审计」 · 基线 `210b9967` · 分支 `feat/v5-selfhost-audit-settings`
> 审计人：fable-5-1-11（接手 fable-5-1-21 / fable-5-1-22 未开始的任务） · 日期 2026-09-15
> 口径：`TEAM_PLAYBOOK.md` §5 七项清单；严重度 P1 功能不可用/数据错误 · P2 明显体验缺陷/移动端不可用 · P3 打磨项
> 本阶段**未改任何业务代码**，只新增 ui-preview 场景文件与本文档。

## 1. 范围与文件清单

审计对象（全部位于 `packages/web-react/src/`，行号以基线为准）：

| 区域 | 文件 | 行数 | 说明 |
|---|---|---|---|
| 设置中心壳 | `components/SettingsCenter.tsx` | 479 | Modal + 桌面左导航 / 窄屏 grid Tabs，七分区分发 |
| 账户与计费 | `components/settings/AccountTab.tsx` | 528 | 组织归属 / 当前套餐 / 余额 / 收支图表 / 账单流水 |
| 用量 | `components/settings/UsageTab.tsx` | 697 | 窗口口径 4 卡 + 4 图 / 累计 / 会话明细（含组队） |
| API 接入（admin） | `components/settings/ApiAccessTab.tsx` `ApiKeysSection.tsx` `TablePager.tsx` | 850 / 1029 / 92 | CC Switch 引导 / 密钥管理 / 消耗统计 / 请求审计 |
| 偏好 + 快捷键 | `components/settings/PreferencesTab.tsx` `QqBindingCard.tsx` `labels.ts` | 476 / 197 / 76 | 主题 / 默认模型 / 输入 / Auto-Dream / QQ / 通知；快捷键只读表 |
| 反馈 | `components/settings/FeedbackTab.tsx` | 361 | 类型 + 正文 + 会话定位 + 草稿 |
| 关于 | `SettingsCenter.tsx` 内 `AboutSection` | 474–507 | 品牌 / 主体 / 备案 |
| 订阅 / 充值弹层 | `components/settings/SubscriptionDialog.tsx` `TopupDialog.tsx` | 398 / 236 | 套餐订阅 + 加量包；TopupDialog **无任何引用（死代码）** |
| ChatGPT 直连 | `components/ChatGptProxyDialog.tsx` | 263 | PAC / 代理 / 凭据 / 三种浏览器引导 |
| 支付 | `components/payment/HupijiaoPaymentEntry.tsx` `PendingPaymentRecovery.tsx` `lib/pendingPayment.ts` | 224 / 143 / 43 | 扫码 / H5 / 微信内复制链接；跨页恢复轮询 |
| 组织中心 | `components/OrgCenter.tsx` + `components/org/{OverviewTab,MembersTab,SkillsTab,ReportsTab,InvoicesTab,CreateOrgWizard,OrgSubscribeDialog,OrgTopupDialog,OrgPayQr,orgShared}.tsx` | 207 + ~2700 | 五分区 + 创建向导 + 订阅/加席/充值弹层 |
| 图表封装 | `components/charts.tsx` | 413 | chart.js 动态加载、token 取色、sr-only 数据表 |
| 纯函数层 | `lib/orgBilling.ts` `lib/plans.ts` `settings/labels.ts` | 171 / 110 / 76 | 席位计价 / 落地页套餐常量 / 文案映射 |

**范围说明**

- `components/settings/ConnectorsTab.tsx`（2415 行）与 `KnowledgePlanetAutomationPanel.tsx` 按目录归属 settings，但**只被 `ManageCenter.tsx:175` 渲染**（管理中心「连接器」页），功能上属 manage 模块，本轮不重复审计，由 manage-A 覆盖；B 阶段建议把这两个文件迁到 `components/manage/`（需 manage owner 同意，见 §5）。
- `components/settings/SettingsRow.tsx` 除自身测试外**无任何引用**（死代码）。
- `lib/chat/pure.ts` 的 `insufficientCreditsCopy`（账户页红卡文案来源）归属 messages 模块，问题记入 §3 但修复需 send_to owner。
- `src/admin/**` 与后端包不在范围；前端改不了的记「需后端配合」。

## 2. 方法与证据

1. 通读上表全部源码（含 `App.tsx:3874–3904 / 3964 / 4067` 装配点、`lib/api.ts` 相关方法签名、`lib/types.ts` 契约）。
2. 新增 ui-preview 场景 `packages/web-react/browser-tests/ui-preview/scenes-settings.tsx`（25 个场景，desktop 1440 / mobile 390 × light / dark），配合既有 `settings-api-access`、`workspace-settings-about` 两场景，覆盖七分区 + 三个弹层 + 支付入口 + 组织中心五分区/向导/两弹层。其中 6 个 `*-full-*` 场景把长分区裸渲染（放开 `#root` 的 `position:fixed; overflow:hidden`）取整页截图，解决 Dialog 定高只截首屏的问题。
3. 截图 108 张（27 场景 × 4），逐张用 Read 看图：`D:\code\test_project\test123\.audit-tmp\settings\before\`（`manifest.json`：27 scenes / 108 shots / 0 failures / 0 retried / unmockedApi 空；运行日志 `shoot-before.log`）。超长图切段版在同级 `crops\`。
4. 验证：`npm run typecheck --workspace packages/web-react` 绿（49s）；`npx biome check browser-tests/ui-preview/scenes-settings.tsx` 绿；shoot.mjs 全部场景「全部成功」（首轮 hotkeys 场景在未打桩 `getPublicModels` 时崩溃，见 SET-02，补桩后通过）。
5. 既有 vitest 覆盖良好（`SettingsCenter/AccountTab/UsageTab/ApiAccessTab/PreferencesTab/FeedbackTab/QqBindingCard/ChatGptProxyDialog/OrgCenter/ReportsTab/OrgTopupDialog/OrgPayQr/HupijiaoPaymentEntry/PendingPaymentRecovery/charts/orgBilling/plans` 均有测试），B 阶段每条修复对应补用例。

场景 id 一览（`settings-`、`payment-`、`org-` 前缀）：
`settings-account-paid-org` `settings-account-free-empty` `settings-usage` `settings-usage-empty` `settings-preferences` `settings-preferences-locked` `settings-hotkeys` `settings-feedback` `settings-subscription-dialog` `settings-chatgpt-proxy` `payment-hupijiao-entry` `org-center-overview` `org-center-members` `org-center-skills` `org-center-reports` `org-center-invoices` `org-center-wizard` `org-topup-dialog` `org-subscribe-dialog` + 整页 `settings-full-account` `settings-full-usage` `settings-full-preferences` `settings-full-api-access` `org-full-members` `org-full-invoices`；复用 `settings-api-access`、`workspace-settings-about`。

## 3. 问题清单

统计：**P1 0 · P2 12 · P3 31**（共 43 条）。截图列写场景 id，文件名为 `<id>--<desktop|mobile>--<light|dark>.png`。

### 3.1 P2

| 编号 | 位置 | 现象 | 影响 | 证据 |
|---|---|---|---|---|
| SET-01 | `SubscriptionDialog.tsx:166-186, 296-357, 387-391` | 点「续费 / 升档 / 切换」立即 `api.subscribe / upgradeSubscription` 下单进二维码，没有任何确认；「续费/订阅**重置当期积分**并顺延周期」只写在底部 11.5px 灰字 | 付费用户在期内还有大量余量时误点续费会损失余量（有损操作无确认、后果不可见） | `settings-subscription-dialog--*` |
| SET-02 | `SettingsCenter.tsx:118, 135-160, 411-443`；`PreferencesTab.tsx:89-102, 132-142` | 「快捷键」分区是纯静态表，却和偏好共用 `needsPreferences`：先拉 `/api/me/preferences` 转圈，失败则整页只剩「加载偏好失败 · 重试」；`PreferencesTab` 挂载还会再拉 `getPublicModels`，且 `initialModelFromPreferences(models…)` 在早退 `pane==='hotkeys'` **之前**执行（harness 里返回体缺 `models` 直接 `find` 崩） | 两次无意义请求；偏好接口故障时快捷键说明不可用；容错弱 | `settings-hotkeys--*`（首轮 4 张全部 ErrorBoundary，见 shoot 日志） |
| SET-03 | `UsageTab.tsx:464-494` | 趋势 / 请求次数两张图在全 0 数据时仍挂 canvas，chart.js 画出 0–1.0 的小数刻度空图；同页另外两张图有空态文案 | 新用户首次打开用量页看到假坐标轴，同页四张卡空态不一致 | `settings-usage-empty--desktop--light` |
| SET-04 | `UsageTab.tsx:22-27, 135-142, 323-341` | 项目范围为「当前聊天项目」且未绑看板时 `blocked`：效果跳过所有请求、渲染只剩一条 Alert「…用量按全部项目统计」 | 文案说按全部项目统计，页面却**一条用量都不显示**，用户只能手动切回「全部项目」 | 代码路径（场景默认 scope=all 未触发） |
| SET-05 | `PreferencesTab.tsx:39-42, 418-434`；`CronPanel.tsx:64-66`（manage） | 「Telegram 通知」开关直接暴露，但用户侧**没有任何 Telegram 绑定入口**；旧前端 `packages/web/public/modules/userPrefs.js:14` 明确「MVP 不暴露（telegram 通道未接）」；本文件 35-38 行已用同样理由隐藏了微信两开关 | 死开关：承诺做不到的事（定时任务里还引导用户来这里打开它） | `settings-full-preferences--*` 底部 |
| SET-06 | `ApiAccessTab.tsx:886-900`；`Stat` 用 `text-[20px]` | 390px 下「消耗积分 2,340,000 积分」在卡内折成「积/分」两行；同页 `UsageTab.Stat` 用 16px 无此问题 | 移动端数字卡断字 | `settings-full-api-access--mobile--light`（crops/api-mobile-part1） |
| SET-07 | `ApiAccessTab.tsx:370-380, 482-491, 715-727` + `TableShell:862-885` | 表格 `th/td` 没有 `whitespace-nowrap`，`minWidth` 只作用于表格整体；移动端「状态」表头与「启用中 / 已撤销」徽章逐字竖排 | 移动端三张表几乎不可读（横向滚动本身正常） | `crops/api-mobile-part2.png` |
| SET-08 | `ChatGptProxyDialog.tsx:210-215`（`Tabs layout="grid"` 三列） | 390px 下浏览器引导 Tab 标签截成「Chrome / E…」「SwitchyOm…」 | 移动端看不出三个选项是什么 | `settings-chatgpt-proxy--mobile--*` |
| SET-09 | `OrgTopupDialog.tsx:186-241` | 组织充值只填「元」，到账积分「按平台当前汇率计算」但页面**不显示汇率也不预估到账积分**；个人版充值/订阅都写明到账数 | 付款前不知道买到多少积分，组织财务无法核对 | `org-topup-dialog--*` |
| SET-10 | `CreateOrgWizard.tsx:168-170` | 组织名步骤提示「可稍后在组织中心修改」，但 `OrgCenter` 五分区无改名入口，`lib/api.ts` 也没有任何 rename/patch org 方法 | 文案承诺不存在的功能，用户输错名字无处修正 | `org-center-wizard--*` |
| SET-11 | 多处触控尺寸 < 44px（移动端） | `ApiKeysSection.tsx:1043-1066 IconBtn size-8`(32)、`:985-992` 撤销 `size-9`(36)；`CreateOrgWizard.tsx:292-297` 关闭按钮 `size-8` 且缺 `type="button"`（`OrgCenter.tsx:139` 同位置有 `[@media(hover:none)]:size-11`）；`CreateOrgWizard.tsx:405-433 SeatPicker ± size-8`；`MembersTab.tsx:272-273 select h-8`；`UsageTab.tsx:686-692` 与 `AccountTab.tsx:405-413` 的纯文本「加载更多 / 重试」；`InvoicesTab.tsx:283-288` 16px 复选框 | 手册 §5.2 触控 ≥44px 不达标，密钥行的重命名 / 保存 / 取消尤其难点 | `settings-full-api-access--mobile`、`org-center-wizard--mobile`、`org-subscribe-dialog--mobile` |
| SET-12 | `SettingsCenter.tsx:205-219`（窄屏 `Tabs layout="grid"` 三列） | admin 有 7 个分区时第三行只剩「关于」孤零零一个；普通用户 6 个刚好两行 | 窄屏导航占高 ~200px 且排版失衡 | `workspace-settings-about--mobile--light`、`settings-api-access--mobile--light` |

### 3.2 P3

| 编号 | 位置 | 现象 | 影响 | 证据 |
|---|---|---|---|---|
| SET-13 | `AccountTab.tsx:182-188, 338-347` | 「本期套餐积分」进度条画的是**已用**占比，右侧文字却是「本期剩余 x / y」；免费用户余额 0 时满条紫色配「剩余 0」；加量包进期内桶使剩余 > 月度额度时被夹到 0 | 进度语义与文字相反，组织概览 `OverviewTab:190-199` 同类条画的是剩余，两处不一致 | `settings-account-free-empty--desktop--light` |
| SET-14 | `AccountTab.tsx:312-315, 354-374` | 免费/低余额态同时出现「升级套餐」「开通 Lite」「加量包」三个按钮，全部打开同一个 SubscriptionDialog | 主次不清；「加量包」对免费用户是否可购未在 UI 说明（弹层脚注称仅套餐期内可用） | `settings-account-free-empty--*` |
| SET-15 | `lib/chat/pure.ts:587-592`（messages 归属）；`SubscriptionDialog.tsx:372, 388-390`；`lib/plans.ts:108-112` | 红卡文案硬编码「Lite(¥38/月,4000 积分)」；订阅弹层硬编码「¥50 加 5,000 积分」「免费版（每月 300 积分）」；`TOPUP_PACK` 又是一份 50/5000 | 套餐从 `listSubscriptionPlans` 拉真值，脚注却是三处手抄常量，改价即漂移 | `settings-subscription-dialog--*` |
| SET-16 | `AccountTab.tsx:503, labels.ts:24-26` | 未知 `reason` 原样显示（如 `some_unknown_reason`） | 开发者术语泄漏；建议显示「其他」并 `title` 保留原值 | `settings-full-account--*` 流水末行 |
| SET-17 | `AccountTab.tsx:201-213` | 收支趋势柱图收入（4,000,000）与日扣费（十万级）同轴，支出压成一条线 | 图看不出支出变化 | `settings-full-account--desktop--light` |
| SET-18 | `SubscriptionDialog.tsx:284-289` | 「本期到期 2026-09-20」与右侧余额 `justify-between` 无 `shrink-0/nowrap`，390px 下日期断成「2026-09-」「20」 | 移动端日期折行难读 | `settings-subscription-dialog--mobile--light` |
| SET-19 | `SubscriptionDialog.tsx:352-354` | 免费档右侧只有一个「—」 | 不解释为何不可选（不可降级 / 到期自动回落） | 同上 |
| SET-20 | `PreferencesTab.tsx:231-236` | 发送键选项写死「⌘+Enter 发送」；同文件 `BuiltinHotkeysTable:443` 已按平台切 `Ctrl/⌘` | Windows 用户看到 ⌘ | `settings-full-preferences--*` |
| SET-21 | `PreferencesTab.tsx:478-499` 原生 `<select>`；`MembersTab.tsx:272-273, 336-346, 421-429` 原生 `<select>` | 与 `ApiAccessTab` 使用的 `ui/Select` 不同源，视觉（原生箭头、高度）不一致 | 设计系统一致性 | `settings-preferences--*`、`org-center-members--*` |
| SET-22 | `PreferencesTab.tsx:39-42` | 「邮件通知」无 hint（发到哪、通知什么）；`NOTIF_FIELDS` 支持 `hint` 却未填 | 用户不知开关含义 | `settings-full-preferences--*` |
| SET-23 | `QqBindingCard.tsx:173-181` | `void navigator.clipboard.writeText()` 无 try/catch；非安全上下文 `navigator.clipboard` 为 undefined 会同步抛错；`ApiKeysSection:428-449` 同类操作有兜底并提示 | 复制失败无提示 / 可能红控制台 | 代码 |
| SET-24 | `ApiKeysSection.tsx:499-501` | 名称输入 `Enter` 直接 `create()`，未判 `e.nativeEvent.isComposing`；`CreateOrgWizard:158-163`、`OrgTopupDialog:195-199` 均有判 | 中文输入法选词回车误创建密钥 | 代码 |
| SET-25 | `ApiAccessTab.tsx:514-524` | 最近明细状态非 success 时原样显示后端码（`insufficient_credits` 等） | 开发者术语泄漏；审计面板 `:780` 同样 | `crops/api-access-part2.png` |
| SET-26 | `ApiAccessTab.tsx:384-386` vs `:499-501` | 「按密钥」表已撤销 key 名称显示「(未知)」，「最近明细」同情况显示「(已撤销)」 | 同页术语不一致 | 同上 |
| SET-27 | `ApiAccessTab.tsx:886-900` vs `UsageTab.tsx:707-720` vs `ReportsTab.tsx:301-315` | 三处 `Stat` 卡各写一份，样式不同（有无边框 / 16 与 20px） | 重复实现 + 视觉不一致 | 各 `*-usage`、`*-api-access`、`org-center-reports` |
| SET-28 | `ApiKeysSection.tsx:1030-1037` | 单 key 触达上限只把进度条变红，没有「已达上限」文字 | 色盲 / 快速扫读看不出 | `crops/api-access-part1.png` |
| SET-29 | `ChatGptProxyDialog.tsx:17-21` | `formatTime` 用 `toLocaleString()`（含秒、随浏览器语言变），其余设置页统一 `shortTime`「M月D日 HH:mm」 | 时间格式不统一 | `settings-chatgpt-proxy--*` |
| SET-30 | `ChatGptProxyDialog.tsx:126, 176, 220-269`；`ApiKeysSection.tsx` 大量文案；`CreateOrgWizard.tsx:164, 169`；`OrgSubscribeDialog.tsx:261-263` | 用户可见中文里使用 ASCII 逗号/冒号/分号「,:;」，`AccountTab/UsageTab/FeedbackTab` 用全角 | 文案标点不统一（约 60 处） | 各弹层截图 |
| SET-31 | `HupijiaoPaymentEntry.tsx:229-235` | 二维码 `<img>` 无 `onError` 兜底 | 第三方图片加载失败时只剩裂图，没有「重新获取」 | 代码 |
| SET-32 | `PendingPaymentRecovery.tsx:75-111`；`SubscriptionDialog:205-247` | 手机端跳转支付返回时，恢复条与仍挂载的订阅弹层各自每 3s 轮询同一订单 | 双份轮询 | 代码 |
| SET-33 | `OverviewTab.tsx:275-278` | JSX 换行在「统一结算」与「（按成员…」之间渲染出一个多余空格 | 文案瑕疵 | `org-center-overview--desktop--light` |
| SET-34 | `OrgCenter.tsx:127-129` | 无组织用户进向导时仍用 `h-[min(85vh,46rem)]` 定高，一个输入框下面 700px 空白 | 视觉空洞 | `org-center-wizard--*` |
| SET-35 | `CreateOrgWizard.tsx:106-121, 309-342` | 进入扫码段后 `WizardSteps` 不再渲染，第 3 步「支付」永远不会显示为进行中 | 进度指示器在最后一步消失 | 代码 |
| SET-36 | `SkillsTab.tsx:165-171` | 「可安装」区每项也用 ✓ 图标 | 语义误导（看起来像已安装） | `org-center-skills--mobile--light` |
| SET-37 | `ReportsTab.tsx:205-207` | 小节标题 `uppercase` 把「Token 构成」渲染成「TOKEN 构成」，个人版同名图表卡是「Token 构成」 | 术语大小写不一致 | `org-center-reports--desktop--light` |
| SET-38 | `MembersTab.tsx:296-299` | 移动端「邮箱 · 加入 时间」单行 `truncate`，加入时间被省略号吃掉 | 信息丢失 | `org-center-members--mobile--light` |
| SET-39 | `MembersTab.tsx:286-386` | 成员列表无搜索 / 分页（`max_members` 50） | 大组织可用性 | 代码 |
| SET-40 | `MembersTab.tsx:310-318` | 非 owner 看到禁用的「组织结算」开关，无提示为何不可点 | 交互反馈缺失 | 代码 |
| SET-41 | `SettingsCenter.tsx:52-62, 301-305` | 左导航只有「个人」一个分组却渲染分组标题 | 多余层级 | `settings-*--desktop--*` |
| SET-42 | `SettingsCenter.tsx:474-507` | 「关于」无版本 / 构建号（`meta[name=oc-build]` 已存在，FeedbackTab 在用）、无法务 / 隐私链接、无更新检查入口 | 支持排障与合规入口缺失 | `workspace-settings-about--*` |
| SET-43 | `TopupDialog.tsx`（236 行 + `PaymentDialogs.test.tsx`）；`SettingsRow.tsx`（+ test）；`AccountTab.tsx:46` 注释「充值走 TopupDialog」 | 两个组件零引用；注释指向已不存在的流程 | 死代码 + 误导性注释 | `rg TopupDialog / SettingsRow src` |

## 4. 修复计划（B 阶段 t-41）

原则：P2 全修；P3 按「同文件顺手」打包，做不完的进遗留。每条附测试。跨模块（`lib/chat/pure.ts`、`components/ui/**`、`ManageCenter`）只 send_to，不越界。

| 编号 | 改动文件 | 做法 | 测试 | 风险 |
|---|---|---|---|---|
| SET-01 | `SubscriptionDialog.tsx` | `choose()` 前用 `useConfirm` 弹确认：续费显示「当前剩余 N 将重置为月度额度 M」，升档显示「按差价补齐，周期不变」；脚注文案上移到当前套餐卡下方 | `SubscriptionDialog` 新增 vitest：续费需确认、取消不发请求；`PaymentDialogs.test.tsx` 已有流程回归 | 低；确认文案需与后端履约规则核对（`upgrade` 补差 / `subscribe` 重置） |
| SET-02 | `SettingsCenter.tsx`、`PreferencesTab.tsx` | `needsPreferences = section === 'preferences'`；`BuiltinHotkeysTable` 抽成独立导出直接渲染；`PreferencesTab` 把 `pane==='hotkeys'` 早退移到 hooks 之后但模型请求加 `pane` 守卫；`getPublicModels` 回调对 `models` 做数组守卫 | `SettingsCenter.test.tsx`：hotkeys 分区不请求 preferences / models；偏好接口 reject 时 hotkeys 仍渲染 | 低 |
| SET-03 | `UsageTab.tsx` | 复用同页空态：`trendHasData = trend.some(credits>0)` / `requestHasData`，无数据渲染文案而非 canvas | `UsageTab.test.tsx` 全 0 report 断言两张卡显示空态文案、无 canvas | 低 |
| SET-04 | `UsageTab.tsx` | `blocked` 时改为**继续按全部项目请求并展示**，Alert 作为顶部提示保留（文案「已按全部项目统计」+「去项目设置」） | vitest：chat scope 无 workProject → 仍调用 `getUsage` 且渲染 Stat | 中：需确认产品意图（是「阻断」还是「回落」）；按文案字面取「回落」 |
| SET-05 | `PreferencesTab.tsx` | 与微信开关同策略：从 `NOTIF_FIELDS` 移除 `notify_telegram`（保留字段 allowlist）；同时 send_to manage owner 调整 `CronPanel.tsx:66` hint | `PreferencesTab.test.tsx` 断言不渲染 Telegram 开关 | **需确认**：若 selfhost 已接 Telegram 通道则改为增加绑定入口而非隐藏；开 `ask_decision` |
| SET-06/07/27 | `ApiAccessTab.tsx`、`UsageTab.tsx`、`ReportsTab.tsx`、新增 `components/settings/StatCard.tsx` | 抽一个 `StatCard`（16px、`tabular-nums`、`break-keep`），三处替换；`TableShell` 的 `th/td` 统一 `whitespace-nowrap`，状态列徽章 `inline-flex whitespace-nowrap` | 现有 `ApiAccessTab.test.tsx` 回归；ui-preview `settings-full-api-access--mobile` after 对照 | 低 |
| SET-08 | `ChatGptProxyDialog.tsx` | 窄屏 Tabs 改 `layout` 默认（可横滚）或缩短标签「Chrome」「Firefox」「Switchy」+ 首行说明全名 | `ChatGptProxyDialog.test.tsx` 回归；after 截图 | 低 |
| SET-09 | `OrgTopupDialog.tsx`（+ 需后端） | 前端：若 `api.getOrgPlans`/后端能给汇率则实时显示「预计到账 N 积分」；无接口时至少把「汇率见组织中心 → 概览」改成可点的说明并在输入下方显示「到账 = 金额 × 平台汇率，支付后概览可见」 | vitest：输入金额后出现预估文案 | **需后端配合**提供汇率字段（记入 §5） |
| SET-10 | `CreateOrgWizard.tsx` | 文案改为「将作为组织在平台内的显示名，创建后暂不可自助修改，如需变更请联系客服」；真实改名功能记「需后端配合」 | 快照/文本断言 | 低 |
| SET-11 | `ApiKeysSection.tsx`、`CreateOrgWizard.tsx`、`MembersTab.tsx`、`UsageTab.tsx`、`AccountTab.tsx`、`InvoicesTab.tsx` | `IconBtn` / 撤销 / `SeatPicker ±` / 向导关闭按钮加 `[@media(hover:none)]:size-11`；纯文本按钮改 `Button variant="ghost" size="sm"`；`select` 改 `ui/Select`（与 SET-21 合并）；复选框改 `size-5` + 行整体可点 | ui-preview mobile after 对照；`ApiAccessTab.test.tsx` 中按 aria-label 取按钮不受影响 | 低 |
| SET-12 | `SettingsCenter.tsx` | 窄屏 Tabs 改为可横滚单行（去掉 `layout="grid"`）或 4 列；验证 6/7 项两种数量 | `SettingsCenter.test.tsx` 窄屏分支回归；after 截图 | 低（需与 shell owner 确认 `Tabs` 横滚样式是否满足，不改 `ui/Tabs`） |
| SET-13 | `AccountTab.tsx` | 进度值改为「剩余占比」与文字一致（或文字改「已用」）；剩余 > 月度时显示 100% 并加「含加量包」说明；与 `OverviewTab` 对齐 | `AccountTab.test.tsx` 断言 `Progress value` | 低 |
| SET-14 | `AccountTab.tsx` | 免费态只保留一个主 CTA「开通 Lite」，「加量包」按钮仅 `sub.paid` 时显示；「升级套餐」按钮与主 CTA 合并语义 | vitest 免费/付费两态按钮集合 | 低；需确认免费用户是否允许买加量包（`buyPack` 后端行为） |
| SET-15 | `SubscriptionDialog.tsx`；`lib/plans.ts`；send_to messages owner（`lib/chat/pure.ts`） | 脚注从 `plans` 数据取免费档积分；加量包价格/积分改从 `TOPUP_PACK` 单一来源（或后端 `buyPack` 预览）；红卡文案由调用方注入 Lite 真值 | vitest：脚注随 plans 变化 | 低 |
| SET-16 | `labels.ts`、`AccountTab.tsx` | 未知 reason → 「其他」+ `title={reason}`；`ledgerReasonLabel` 返回 `{label, raw}` | `labels` 单测 | 低 |
| SET-17 | `AccountTab.tsx` | 收支趋势改为「支出」单序列柱图 + 收入以标注点/分组显示，或按 `Math.log` 不做（保守：改双图并列） | after 截图 | 低 |
| SET-18/19 | `SubscriptionDialog.tsx` | 到期/余额行改 `flex-wrap` + `whitespace-nowrap`；免费档右侧文案「到期自动回落」 | after 截图 | 低 |
| SET-20 | `PreferencesTab.tsx` | 复用 `isMacPlatform()` 生成「Ctrl+Enter / ⌘+Enter」 | `PreferencesTab.test.tsx` mock platform | 低 |
| SET-21/40 | `PreferencesTab.tsx`、`MembersTab.tsx` | 原生 `select` → `ui/Select`；禁用开关加 `title`/tooltip「仅拥有者可改」 | 回归 | 低 |
| SET-22 | `PreferencesTab.tsx` | 邮件通知补 hint「支付 / 重要事件发送到 {user.email}」 | 文本断言 | 低 |
| SET-23/24 | `QqBindingCard.tsx`、`ApiKeysSection.tsx` | 复制包 try/catch + 失败提示；Enter 创建加 `isComposing` 守卫 | vitest：clipboard 缺失不抛；composing 回车不创建 | 低 |
| SET-25/26/28 | `ApiAccessTab.tsx`、`ApiKeysSection.tsx`、`labels.ts` | 新增 `apiRequestStatusLabel()`（success/insufficient_credits/rate_limited/…→中文，未知回落原值+title）；两表统一「(已撤销)」；上限 100% 时加「已达上限」文字 | `labels` 单测；`ApiAccessTab.test.tsx` | 低 |
| SET-29/30/33 | `ChatGptProxyDialog.tsx`、`ApiKeysSection.tsx`、`CreateOrgWizard.tsx`、`OrgSubscribeDialog.tsx`、`OverviewTab.tsx` | `formatTime` 改 `shortTime`；用户可见文案标点全角化（只改字符串字面量）；修掉 JSX 空格 | 现有文本断言若含 ASCII 标点需同步更新 | 低 |
| SET-31/32 | `HupijiaoPaymentEntry.tsx`、`SubscriptionDialog.tsx` | `<img onError>` 显示「二维码加载失败 · 重新获取」调用 `onReorder`；订阅弹层在 `client!=='desktop'` 跳出前 `stopPoll`，交给恢复条 | `HupijiaoPaymentEntry.test.tsx` 新增 onError 用例 | 低 |
| SET-34/35 | `OrgCenter.tsx`、`CreateOrgWizard.tsx` | 向导态去掉 `fixedHeight`（`showWizard ? 'max-h-[85vh]' : 'h-[…]'`）；扫码段也渲染 `WizardSteps` 并高亮第 3 步 | after 截图；`OrgCenter.test.tsx` | 低 |
| SET-36/37/38/39 | `SkillsTab.tsx`、`ReportsTab.tsx`、`MembersTab.tsx` | 可安装项换 `Plus/Boxes` 图标；小节标题去 `uppercase` 或标题写「Token 构成」为 `normal-case`；成员行邮箱与时间分两行；成员 > 10 时加客户端搜索框（复用 `TablePager` 分页） | 回归 | 低 |
| SET-41/42 | `SettingsCenter.tsx` | 单分组时不渲染分组标题；关于页增加「版本 {oc-build}」「服务条款 / 隐私政策」（走 `LegalPage` 路由，send_to landing owner 要链接常量）、复制诊断信息按钮 | `SettingsCenter.test.tsx` | 低 |
| SET-43 | 删除 `TopupDialog.tsx`、`SettingsRow.tsx` 及各自 test；改 `AccountTab.tsx:46` 注释 | 确认 `rg` 零引用后删除 | typecheck + 全量 vitest | 低（`PaymentDialogs.test.tsx` 若同时测 Subscription 需拆分保留） |

B 阶段交付顺序建议：SET-02/03/04（用量与快捷键，纯前端、低风险）→ SET-06/07/11/12（移动端一组，一次出 after 截图）→ SET-01/13/14/15（计费一组，需先确认 §5 两个问题）→ SET-05/09/10（依赖决策/后端）→ 其余 P3 文案打包。

## 5. 建议不修 / 暂缓项及理由

| 项 | 理由 / 处置 |
|---|---|
| `ConnectorsTab.tsx` / `KnowledgePlanetAutomationPanel.tsx` 目录迁移 | 文件在 `components/settings/` 但只被 ManageCenter 使用；迁移会牵动 manage 的 import 与 ui-preview `scenes-manage`。建议 B 阶段由 manage owner（fable-5-1-17）决定；本模块不动。 |
| SET-09 组织充值汇率 | 后端 `POST /api/org/topup` 契约无汇率/预估字段；前端只能做文案。**需后端配合**：`GET /api/org/plans` 或新端点下发 `credits_per_yuan`。 |
| SET-10 组织改名 | 无 API；前端只改文案。**需后端配合**：`PATCH /api/org {name}`。 |
| SET-05 Telegram 开关 | 需用户/后端确认 selfhost 是否接了 Telegram 通道，开 `ask_decision` 后再定「隐藏」还是「补绑定流程」。 |
| Auto-Dream 卡片提及「MiniMax M3」等供应商细节、营销风格 | 产品决策，不在 UX 审计范围。 |
| 会话用量「加载更多」为 offset 分页 | 后端契约如此，翻页期间新增会话会导致重复/漏行，属后端分页语义，前端不改。 |
| `ApiKeysSection` 深链把完整密钥放进 `ccswitch://` URL | 设计如此（CC Switch V1 协议要求），页面已有「请勿分享导入链接」提示。 |
| 账单流水未知 reason「绝不吞掉」的注释意图 | 保留可观测性：SET-16 用「其他 + title 原值」兼顾，不做纯隐藏。 |
| 关于页「备案信息更新中」占位 | 来自 `lib/brand.ts`（shell 归属），运营填值即可，非代码问题。 |

## 6. 修复记录（B 阶段 t-41）

> 分支 `feat/v5-selfhost-audit-settings`（接续 A 阶段 commit `82c0f80f`） · 修复人：fable-5-1-20（接手 fable-5-1-21 / fable-5-1-11 的未交付工作树）
> 口径：P1 0 条（本模块无）；**P2 12 条全部落地**；P3 31 条中 29 条落地，2 条按下表判定为「不修」并写明理由。

### 6.1 P2（12/12）

| 编号 | 改动 | 落点 |
|---|---|---|
| SET-01 | `choose()` 在「续费 / 切换」（付费用户且非升档）前弹 `useConfirm`：写明「本期积分会重置为 N、当前剩余 M 不累计、周期顺延 X 天、钱包余额不受影响」；升档按差价补齐、周期不变，不打断 | `settings/SubscriptionDialog.tsx` |
| SET-02 | `needsPreferences = section === 'preferences'`；`BuiltinHotkeysTable` 提升为导出件，由 `SettingsCenter` 直接渲染；`PreferencesTab` 删掉 `pane` 形参，`getPublicModels` 回调对 `models` 做数组守卫（返回体缺字段不再把整页打崩） | `SettingsCenter.tsx`、`settings/PreferencesTab.tsx` |
| SET-03 | `creditTrendHasData` / `requestTrendHasData` 为假时不挂 canvas，改渲染与同页另两卡一致的文字空态 | `settings/UsageTab.tsx` |
| SET-04 | `blocked` 改 `notice`：范围选「当前聊天项目」但未绑看板时**回落到全部项目照常请求并展示**，顶部保留 Alert +「去项目设置」 | `settings/UsageTab.tsx` |
| SET-05 | 与微信两开关同策略，从 `NOTIF_FIELDS` 移除 `notify_telegram`（偏好字段保留在后端 allowlist，通道接通再放回渲染）。判据：用户侧无任何 Telegram 绑定入口，后端只有 `admin/alertChannels` 管理员告警通道（`commercial/src/http/router.ts:1368` 仅 `/api/admin/alerts/channels/telegram`），开关打开也不会有消息送达 —— 属「死开关」，不必开 `ask_decision` | `settings/PreferencesTab.tsx` |
| SET-06 | 新增 `settings/StatTile.tsx`（16px + `tabular-nums`，数字与单位各自 `whitespace-nowrap`、只在两者之间换行），替换 `ApiAccessTab` 的 20px `Stat` | `settings/StatTile.tsx`、`settings/ApiAccessTab.tsx` |
| SET-07 | `THEAD_CLS` 加 `[&_th]:whitespace-nowrap`；结果徽章抽 `StatusChip`（`inline-flex whitespace-nowrap`，`title` 保留后端原始码）；模型列 `whitespace-nowrap` | `settings/ApiAccessTab.tsx` |
| SET-08 | 引导 Tab 标签缩短为 `Chrome / Firefox / Switchy`，完整名写进各段正文第一句 | `ChatGptProxyDialog.tsx` |
| SET-09 | 付款前无法预估（后端不下发汇率，见 §5）：填额段说明「到账积分 = 支付金额 × 平台汇率（以支付时为准，本页暂不预估）+ 到账数会在本弹层与概览显示」；**到账段新增实际入账数**（`creditedDelta(到账后余额, 基线)`，纯 BigInt） | `org/OrgTopupDialog.tsx` |
| SET-10 | 组织名步骤文案改为「创建后暂不支持自助修改，如需变更请联系客服」，不再承诺不存在的改名功能 | `org/CreateOrgWizard.tsx` |
| SET-11 | 触控靶统一下沉到原语：密钥行 `IconBtn` / 撤销键 → `ui/IconButton`（触屏 44px）；向导关闭键、`OrgCenter` 关闭键 → `IconButton`；`SeatPicker ±` 与席位输入 `[@media(hover:none)]:size-11 / h-11`；发票复选框 16→20px（整行 label 仍是命中区）；用量与账单的纯文本「加载更多 / 重试」→ `Button` | `settings/ApiKeysSection.tsx`、`org/CreateOrgWizard.tsx`、`OrgCenter.tsx`、`org/InvoicesTab.tsx`、`settings/UsageTab.tsx`、`settings/AccountTab.tsx` |
| SET-12 | 窄屏宫格分区数 > 6（admin 7 项）时改四列（4+3），6 项保持 3+3；并给「账户与计费」加 `narrowLabel: '账户'`，避免四列列宽把长标签截成「账户与…」 | `SettingsCenter.tsx` |

### 6.2 P3（29/31 落地）

- **计费与文案**：SET-13 进度条改「剩余占比」与右侧文字同语义、剩余 > 月度额度时按 100% 显示并加注「含加量包积分」；SET-14 余额耗尽时红卡承担主 CTA（免费 → `开通 Lite` + `加量包`；付费 → `购买加量包` + `升级套餐`），此时套餐行按钮隐藏，余额充足时只保留套餐行一个入口；SET-15 免费档积分从 `plans` 真值取、加量包价格/积分统一读 `lib/plans.ts` 的 `TOPUP_PACK`；SET-18 到期/余额行 `flex-wrap` + `whitespace-nowrap`；SET-19 免费档右侧改「到期未续自动回落」。
- **术语与状态码**：SET-16 新增 `ledgerReasonView()`（未知 reason → 「其他」+ 原值进 `title`）；SET-25 新增 `apiRequestStatusLabel()`（success/insufficient_credits/rate_limited/key_revoked/… → 中文，未知回退原文并保留 `title`）；SET-26 「按密钥」表已撤销 key 与「最近明细」统一显示「(已撤销)」；SET-28 单 key 触达上限补「已达上限」文字徽章（不只靠进度条变红）。
- **图表**：SET-17 `charts.tsx` 的 `LineSeries` 新增 `axis: 'left' | 'right'`（标 right 的序列走右侧独立刻度 `y1`，不画第二套网格），收支趋势把收入挂右轴、支出留左轴，卡片 hint 同步标注轴别；SET-37 组织报表小节标题 `uppercase` → `normal-case`（不再把「Token 构成」渲成「TOKEN 构成」）。
- **设计系统一致性**：SET-21 偏好页自绘原生 `select` 与成员页两处原生 `select` 全部换 `ui/Select`（本文件内的 `Select` 私有实现删除）；SET-27 `ApiAccessTab` / `UsageTab` / `org/ReportsTab` 三份 `Stat` 合并为共用 `StatTile`。
- **交互与容错**：SET-20 发送键选项与快捷键表共用 `modifierKeyLabel()`（Windows/Linux 显示 `Ctrl`）；SET-22 邮件通知补 hint；SET-23 QQ 绑定命令复制包 try/catch，失败给「复制失败，请手动输入上面的绑定命令。」；SET-24 密钥名输入回车加 `isComposing` 守卫；SET-29 ChatGPT 直连时间格式改 `shortTime`；SET-31 二维码 `onError` → 失败态文案 +「重新获取二维码」（新二维码 URL 到达时自动复位）；SET-34 组织中心弹层在向导态改 `max-h` 自适应（不再留 700px 空白）；SET-35 扫码段也渲染 `WizardSteps` 并高亮第 3 步；SET-36 「可安装」项换中性 `Boxes` 图标；SET-38 成员行邮箱与加入时间分两行；SET-39 成员 > 10 时出现搜索框（`filterMembers`：名称/邮箱大小写不敏感）+ 本地分页（复用 `TablePager`，每页 10）；SET-40 非 owner 的「组织结算」开关补 `title` 与「（仅拥有者可改）」说明。
- **文案标点（SET-30）**：settings / org / payment 归属文件里**用户可见中文**的 ASCII `, ; : ? !` 全部全角化（脚本按「紧邻 CJK」匹配后逐条过 diff），复扫结果 0 处遗留。
- **死代码（SET-43）**：`git rm` 掉零引用的 `settings/TopupDialog.tsx`、`settings/SettingsRow.tsx`（含 `SettingsRow.test.tsx`）；`PaymentDialogs.test.tsx` 去掉 TopupDialog 用例、保留订阅弹层用例；`AccountTab` 顶部注释里指向 TopupDialog 的失效说明改为 SubscriptionDialog。
- **SET-41/42**：左导航单分组时不渲染分组标题；关于页新增「版本 {meta[name=oc-build]}」与「用户协议 / 隐私政策」两个新标签链接（术语与落地页、登录页一致）。

### 6.3 遗留 / 不修（连同 §5 一并读）

| 项 | 处置 |
|---|---|
| SET-32 双份轮询 | **判定不修**：手机跳出收银台后整页重载时订阅弹层已卸载、由 `PendingPaymentRecovery` 接手；bfcache 原页恢复时恢复条不会重读 sessionStorage（`pending` 只在挂载时取一次），两者不会在同一 document 里并存。已把这段判据写进 `SubscriptionDialog.tsx` 轮询 effect 的注释。 |
| SET-42 更新检查入口 | 关于页只补了版本号与法务链接；「检查更新」属 shell 归属（`lib/appUpdate.ts` / `UpdateBanner`），不越界。 |
| SET-09 汇率预估 / SET-10 组织改名 | 前端已做到文案与到账数可核对；真正的预估与改名**需后端配合**（`credits_per_yuan` 下发、`PATCH /api/org {name}`），见 §5。 |
| 跨模块 · `lib/chat/pure.ts:587` 红卡文案 | 硬编码「Lite(¥38/月,4000 积分)」+ ASCII 标点，归属 messages。已 `send_to` messages owner（fable-5-1-26）说明改法；本模块不越界改 `lib/chat/**`。**→ 已在补丁①（§8.1 ③）由指挥官授权收口。** |
| 跨模块 · `manage/CronPanel.tsx:64-66` | Telegram 投递项 hint 指向已移除的偏好开关。manage 当前无人持有，已请指挥官代转给 manage 接手人。**→ 已在补丁①（§8.1 ②）由指挥官授权收口。** |
| `ConnectorsTab` / `KnowledgePlanetAutomationPanel` 目录迁移 | 仍按 §5：由 manage owner 决定，本轮不动。 |

## 7. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿 |
| 模块单测 | `npx vitest run src/components/settings src/components/org src/components/payment src/components/SettingsCenter.test.tsx src/components/ChatGptProxyDialog.test.tsx src/components/OrgCenter.test.tsx src/components/charts.test.tsx --maxWorkers=1` | ✅ 19 文件 / 215 用例全绿 |
| web-react 全量单测 | `npm test --workspace packages/web-react` | ✅ 绿（见交付摘要里的文件/用例数） |
| after 截图 | `OC_UI_SCENES='settings-,payment-,org-' node browser-tests/ui-preview/shoot.mjs` | ✅ 27 场景 / 108 张 / failures 0 / retried 0 / `unmockedApi` 空 |
| 代码风格 | `npx biome lint <改动文件>` | 与基线逐文件对比**未新增**任何诊断（`UsageTab` / `ApiAccessTab` 各减少 1 条）。注：仓库 `npm run lint` 在基线即为红（本目录既有文件与 biome 的 quote/semicolon 配置不一致），故以「不新增」为判据。 |

本轮新增/改写的测试（每个逻辑改动都有用例）：

- `SettingsCenter.test.tsx`：快捷键分区不再请求 prefs / models 且偏好接口 reject 时照常渲染（SET-02）；关于页版本号与法务链接（SET-42）；窄屏 6 项三列 / admin 7 项四列 + 账户短名（SET-12）。
- `settings/UsageTab.test.tsx`：全 0 数据四张卡都走文字空态且不构造 chart（SET-03）；未绑看板回落全部项目仍发请求并渲染数据（SET-04）。
- `settings/PreferencesTab.test.tsx`：`BuiltinHotkeysTable` 独立渲染不发请求、修饰键随平台（SET-02/SET-20）；不渲染 Telegram 开关、邮件通知带 hint（SET-05/SET-22）；`getPublicModels` 返回体缺 `models` 时退化为空列表（SET-02）。
- `settings/AccountTab.test.tsx`：进度条与文字同为剩余语义、加量包超额按 100% + 加注（SET-13）；套餐入口三态按钮集合（SET-14）；未知 reason 显示「其他」且原值在 `title`（SET-16）；收支趋势收入挂右轴 `y1`（SET-17）。
- `settings/labels.test.ts`（新增）：`ledgerReasonView` 与 `apiRequestStatusLabel` 的已知/未知/空值分支（SET-16/SET-25）。
- `settings/ApiAccessTab.test.tsx`：统计卡走 `StatTile`（数字与单位分离、accent 落在数字行）（SET-06/SET-27）。
- `settings/QqBindingCard.test.tsx`：clipboard 缺失（非安全上下文）不抛错并给出提示，可用时正常复制（SET-23）。
- `org/MembersTab.test.tsx`（新增）：`filterMembers` 纯函数分支；≤10 人无搜索无分页且邮箱/加入时间分两行；>10 人搜索 + 翻页；角色下拉是 `ui/Select` 且改选即 patch；非 owner 开关禁用并说明原因（SET-38/39/40/21）。
- `org/OrgTopupDialog.test.tsx`：`creditedDelta` 大数分支；填额段汇率说明；到账段显示实际入账积分（SET-09）。
- `org/ReportsTab.test.tsx`：摘要卡走 `StatTile`、「Token 构成」不被 uppercase 改写（SET-27/SET-37）。
- `payment/HupijiaoPaymentEntry.test.tsx`：二维码加载失败 → 提示 + 重新获取，换新 URL 后复位（SET-31）。
- `charts.test.tsx`：双 y 轴接线（未标 right 时只有一条轴；标 right 的序列挂 `y1` 且不画第二套网格）（SET-17）。

截图（仓库外）：`D:\code\test_project\test123\.audit-tmp\settings\{before,after}\`（各 27 场景 × desktop/mobile × light/dark = 108 张，`manifest.json` failures 0）；长图切段在 `crops\`（before）与 `crops-after\`（after）。逐张对照已确认：快捷键页不再是错误态、用量空态无假坐标轴、移动端统计卡与表格状态列不再断字竖排、ChatGPT 引导 Tab 标签完整、窄屏设置导航两行无孤项且标签不截断、订阅弹层日期不折行、创建组织向导无 700px 空白且第 3 步高亮、组织成员行邮箱与加入时间分两行、组织报表「Token 构成」大小写正确、可安装技能不再用 ✓。

## 8. 补丁①（t-426）

manage-B / settings-B / messages-B 三条 B 任务互相登记了三处「归别人」的遗留，由本补丁在 settings 分支统一收口。跨归属改动（`components/manage/CronPanel.tsx`、`lib/chat/pure.ts` 及其用例）均由指挥官在 t-426 任务书中显式授权；改前均已 `acquire_file_lock`。基线：先把本分支合入 integration `feat/v5-selfhost-ocv5-audit-ux @ 43b7cd3a4`（含 sidebar/manage/taskboard/messages-B，`dc99a93ca`，无冲突），再改这两个跨模块文件，避免与已合入的 manage-B / messages-B 打架。

### 8.1 三处改动

| # | 来源 | 文件 | 改动 | 用例 | commit |
|---|---|---|---|---|---|
| ① | manage 审计 M-09（P2）/ M-18 / M-20 / M-21（P3），修法见 `docs/audit/manage.md` §4 | `components/settings/ConnectorsTab.tsx` | **M-09** `RuntimePluginCard` / `ProviderCard` 卡头外层 `flex-wrap`，动作簇 `max-sm:basis-full max-sm:justify-start max-sm:pt-1` 窄屏整行下沉，桌面不变；**M-18** 元信息行仅 `conn.displayName && conn.accountHint` 时渲染 accountHint（标题已在 displayName 为空时回落显示它）；**M-20** 声明式 / 运行时目录任一读失败 → `degraded` 态，列表顶部 `Alert tone="info"`「部分插件目录暂时读不到，已显示可用部分」+ 重试（`data-testid="connectors-degraded"`）；市场回跳「Plugin 尚未安装到当前版本」改走单卡 `cardNotice`，不再占用为「整表读不到」保留的顶层 `err`；**M-21** 备注名 Input `onBlur` 提交、「取消」按 `mousedown` 置 `cancelingRef` 让路、Enter 忽略 `isComposing`、改名成功 toast「已改名 / 已清空备注名」 | `ConnectorsTab.test.tsx`：收紧「已绑多账号」用例为 accountHint 恰出现 1 次（M-18）；新增 describe「承接 manage 审计」7 例——声明式目录读失败出现可重试提示且重试后重拉目录、运行时目录读失败同样提示 / 正常不出现、市场回跳未安装提示落在卡内且无顶层错误与「去市场」、失焦提交 + toast、未改动失焦不发请求、取消 mousedown 让路不提交、IME 合成 Enter 不提交 | `138accab4` |
| ② | 本文件 SET-05（Telegram 开关为死开关，已从偏好页移除） | `components/manage/CronPanel.tsx` | `DELIVER_OPTIONS` 加 `fallback` 标记：`/api/cron/channels` 拉不到时的兜底列表只保留「网页对话 / 仅记录」，Telegram 只在后端明确下发 `available` 时出现（二选一里选了「隐藏」）；Telegram hint 改为中性「结果推送到 Telegram。」，不再引导去已不存在的偏好开关；存量 `deliver=telegram` 任务仍按「Telegram」标签回显、编辑保留原值 | `CronPanel.test.tsx`：改写兜底用例（不含 Telegram）；新增「后端下发可用时可选且 hint 不提偏好页 / Telegram 通知」「存量 telegram 任务回显与编辑保留」 | `9582b5eb5` |
| ③ | 本文件 SET-15（红卡价格硬编码） | `lib/chat/pure.ts` | `insufficientCreditsCopy`：免费 →「免费额度已用完，开通任意订阅套餐（Lite 及以上任一档）即可继续」（CTA 仍「开通 Lite」）；付费 →「本期积分已用完，可购买加量包或升级套餐」。**不再写价格 / 积分数**而非改读 `lib/plans.ts`：该函数在 `BRIDGE_ERROR_MESSAGES` / `ERROR_LABELS` import 时即求值，拿不到后端套餐真值，`plans.ts` 自注是落地页营销展示数据，读它只是把手抄常量换个地方、改价照样漂移；口径对齐 `lib/cursorModelPicker` `lockedModelUnlockNotice` 的「开通任意订阅套餐即可解锁」。标点全角 | `lib/chat/render.test.ts` 同步断言 + 新增「不含货币符号 / 数字 / 半角标点」守卫；`components/chat/cards.test.tsx`、`settings/AccountTab.test.tsx` 同步两处文案 | `091a1a7bb` |

### 8.2 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿（合并后、三处改完各跑一次） |
| ui-preview 场景类型检查 | `npm run typecheck:preview --workspace packages/web-react` | ⚠ 红，2 处均为 integration 带入的既有错误（`scenes-manage-audit.tsx:54` TS5097、`scenes-taskboard.tsx:163` TS2322），与本补丁无关，integ1 记录里已登记为基线失败 |
| 涉及目录单测 | `npx vitest run src/components/settings src/components/manage/CronPanel.test.tsx src/lib/chat src/components/chat/cards.test.tsx src/components/MessageRenderer.test.tsx src/lib/plans.test.ts --maxWorkers=1` | ✅ 52 文件 / 1321 用例全绿（其中 ConnectorsTab 60、CronPanel 18；render + cards + AccountTab + MessageRenderer 274 亦分别单跑过） |
| 代码风格 | `npx biome lint <改动文件>` | 与基线逐文件对比**未新增**诊断（`ConnectorsTab.tsx` 2 error + 1 warning、`CronPanel.tsx` 1、`pure.ts` 2、`cards.test.tsx` 1 均在未触碰的既有行；测试文件 0） |
| after 截图 | `OC_UI_SCENES='manage-connectors,manage-cron-create,settings-account-free-empty' node browser-tests/ui-preview/shoot.mjs` → `D:\code\test_project\test123\.audit-tmp\patch1\after\` | ✅ 9 场景 / 28 张 / failures 0 / retried 0 / unmockedApi 空。已用 Read 逐张看：`manage-connectors-mobile--mobile--light` 微博卡「更新 / 卸载」整行落到描述下方，描述不再被压成窄柱（M-09）；`manage-connectors--desktop--light` 桌面布局不变，邮箱第二账号 `momo.muying@163.com · imap.163.com` 只出现一次（M-18）；`settings-account-free-empty--{desktop,mobile}` 红卡新文案，移动端两行不溢出；`manage-cron-create--mobile` 表单送达方式正常渲染（该场景 api-stub 声明 telegram `available:true`，属后端下发可用的分支；兜底隐藏与 hint 由 vitest 覆盖） |
| `test:browser` | — | NOT RUN：本补丁未触碰 Composer / 消息渲染路径 / 工具卡 / 侧栏的交互面，`pure.ts` 只改了纯文案常量 |

### 8.3 对 manage.md / messages.md 遗留项的闭环说明

那两份文档在各自分支上，本补丁不改它们，只在此登记：

- `docs/audit/manage.md` §6 修复记录中 **M-09 ⏸ / M-18·M-20·M-21 ⏸**（「遗留：`ConnectorsTab.tsx` 归 settings」）与 §7 X-02 → **已由本补丁 ① 落地**，修法与 manage.md §4 一致，用例见 8.1。
- `lib/chat/pure.ts` 红卡文案（SET-15）当时是 `send_to` 转交 messages owner，`docs/audit/messages.md` 里没有对应登记条目（合并后核对过）→ **已由本补丁 ③ 落地**，以本文件为闭环记录；messages 归属的 `render.test.ts` / `cards.test.tsx` 仅同步了文案断言，未改行为。
- 本文件 §6.3 的两条「跨模块」行已回指到这里。
