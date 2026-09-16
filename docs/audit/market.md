# A·market AI 市场 · 审计报告

- 分支：`feat/v5-selfhost-audit-market`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`）
- 阶段：A（审计，§1–§6）→ B（修复，§7–§9；发现 26 / 修复 12 / 遗留 14）→ 二期收尾（§10；再修 10，累计修复 22 / 遗留 4：K-23 按拍板不做、K-25 / K-27 / X-01 需后端或 shell）
- 结论：**P1 × 1 / P2 × 4 / P3 × 21**，共 26 条（另 1 条 admin 面备注 K-26）。P1 是发布表单草稿随市场弹窗关闭（Esc / 点遮罩）
  **无提示丢失**（代码注释自认技术债）。四条 P2：卡片描述 `line-clamp-2` 被同元素的 `block`
  抵消（卡高失控）、分区视图翻页时分区计数把「已加载」说成「共有」、详情弹层移动端底栏三枚
  全宽按钮吃掉 ¼ 视口、「加载更多」失败的红条落在列表顶部（用户在底部）。
- 跨模块另记 3 条（§6）：未登录「去登录」只是关弹窗（App 接线，shell）、`/api/marketplace/search`
  无 offset（后端）、`ui/Modal` 移动端底栏 `[&>*]:w-full` 把 Badge 也拉成全宽（shell，仅备注）。

---

## 1. 范围与文件清单

AI 市场四个标签页（发现 / 已安装 / 发布 /（管理员）审核）、三类条目（技能 / 智能体 / API 插件）、
详情与安装 / 更新 / 卸载反馈、长列表加载、移动端宽度。

| 类别 | 文件（`packages/web-react/src/` 下） | 行数 |
|---|---|---|
| 壳 | `components/MarketplaceCenter.tsx` | 251 |
| 发现 | `components/marketplace/BrowsePanel.tsx`（卡片 `CardTile` / 分区 `Section` / 分类片 `Chip`） | 742 |
| 详情 | `components/marketplace/DetailModal.tsx`（安装 / 更新 / 归属 / 修复） | 999 |
| 已安装 | `components/marketplace/InstalledPanel.tsx`（更新 / 归属 / 卸载确认） | 519 |
| 发布 | `components/marketplace/PublishPanel.tsx`（技能 / 智能体 / 插件三表单 + 我的发布） | 2128 |
| 审核 | `components/marketplace/ReviewPanel.tsx`（待审队列 / 批量 / kill-switch / AI 审批记录） | 848 |
| 精选管理 | `components/marketplace/FeaturedPanel.tsx`（**仅 `src/admin/**` 使用**，本轮轻审） | 377 |
| 纯函数 / 钩子 | `lib/marketplace.ts`、`components/marketplace/{riskFlags,useMarketplacePublishes,useMarketplaceRevision}.ts` | 168 / 45 / 167 / 70 |

对应 `*.test.ts(x)` 随源文件归属（BrowsePanel 324 / DetailModal 660 / InstalledPanel 102 /
PublishPanel 282 / ReviewPanel 227 / FeaturedPanel 122 / marketplace 165 / hooks 208 行）。
审计维度按 PLAYBOOK §5 七项清单逐项过：UI/视觉、响应式/移动端、交互友好性、功能正确性、可访问性、
文案、代码质量。

**不在本轮范围**：`components/ui/**` 原语（shell）、`App.tsx` 接线（shell）、`src/admin/**`
（商业运营面，PLAYBOOK §9）、需改协议 / 后端才能修的问题（记入 §5「需后端配合」）。

---

## 2. 方法与证据

### 2.1 ui-preview 场景

既有 `browser-tests/ui-preview/scenes-market.tsx` 覆盖四个 Tab 的首屏三态、详情五态、精选管理
（29 个场景），但只有「发现 · 技能」「发布 · 技能表单」给了移动端视口，且**没有任何点一下才到达的
状态**（安装成功 / 失败、卸载确认、归属编辑、分类筛选、加载更多、表单校验、批量选择、拒绝理由）。

新增 `browser-tests/ui-preview/scenes-market-audit.tsx`（只增不改既有文件；`api-stub.ts` 未改），
21 个场景：

| 组 | 场景 id | 内容 | 视口 |
|---|---|---|---|
| 移动端补齐 | `market-{browse-agent,browse-plugin,browse-search,browse-empty,browse-error,detail,detail-risky,detail-agent,installed,installed-empty,publish-list,publish-agent,publish-plugin,review,review-detail}-mobile` | 直接派生既有场景对象（同一份 mock），只跑 mobile | mobile |
| 发现二级 | `market-browse-category` / `market-browse-longlist` / `market-browse-longlist-more` | 选中一个分类筛选片；60 张卡装满一页出「加载更多」；点过「加载更多」后 | desktop / mobile |
| 详情写动作 | `market-detail-install-done` / `market-detail-install-error` | 点「安装」成功的完成态；`installMarketplace` 409 时的 footer 报错 | desktop / mobile |
| 已安装写动作 | `market-installed-uninstall` / `market-installed-scope` | 卸载确认弹层（原因选择）；修改归属弹层 | desktop / mobile |
| 发布 / 审核 | `market-publish-validation` / `market-review-batch` / `market-review-reject` | 空表单直接提交；全选进入批量态；点「拒绝」弹理由框 | desktop / mobile |
| 未登录 | `market-unauth` | `auth=null` 的空态与出口 | desktop / mobile |

技术点（都收在场景文件里，不动 harness / shoot.mjs）：`<AutoClick>` 按步骤轮询点击目标
（全等文案优先于子串，避免「拒绝」命中「批量拒绝」）；`derive()` 在既有场景之上叠加打桩覆盖与点击步骤，
不复制 mock 数据；长列表用 `longListCards(60)` 合成、`searchMarketplace` 按 `limit` 截断以模拟
分页。

### 2.2 截图基线

```
D:\code\test_project\test123\.audit-tmp\market\before\
```

126 张 PNG（50 场景 × 声明视口 × light/dark：既有 29 + 新增 21），`manifest.json`
`failures: 0`、`retried: 0`、`unmockedApi: []`。复跑命令：

```powershell
cd d:\code\test_project\test123\wt\market\packages\web-react
$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:OC_UI_SHOTS='D:\code\test_project\test123\.audit-tmp\market\before'
$env:OC_UI_SCENES='market-'
$env:OC_UI_SHOT_DELAY='900'
node browser-tests\ui-preview\shoot.mjs
```

直接充当证据的几张：

- `market-browse-skill--desktop--light.png` —— 「PPT 一键成稿」描述完整铺出 3 行、「公文写作助手」4 行，
  同排的「会议纪要整理」卡为对齐被拉高，标签行与底部信号行之间空出约 60px（K-02）；分类片最后一片
  「未分类」被右缘渐隐截断，桌面端无滚动条（K-12）。
- `market-browse-skill--mobile--light.png` / `market-browse-search-mobile--mobile--light.png` —— 390px 下
  同一段描述 4 行，一张卡高约 270px（K-02）。
- `market-browse-longlist--desktop--light.png` —— 结果条「共 50 个技能（可继续加载更多）」，但下方
  「办公文档 6」等分区计数与「平台精选 2」都只是**本页**成员数（K-03）。
- `market-detail-mobile--mobile--light.png` / `market-detail-agent-mobile--mobile--light.png` —— 底栏
  「安装 / 在对话中试用 / 关闭」三枚全宽按钮约 200px；已安装态的「已安装」Badge 被拉成一枚全宽、
  不可点的"按钮"（K-04、K-20）。
- `market-detail--desktop--light.png` —— 「详细介绍」段里 Markdown 的「它适合谁」标题比段标题更大更粗
  （K-15）；徽章行里 👍 表情与其余 lucide 图标混排（K-16）。
- `market-installed-mobile--mobile--light.png` —— 「编程助手 Pro」行动作区只剩一枚垃圾桶图标独占一行；
  「能力已就绪」徽章与「1/2 项组合能力就绪」并排（K-08、K-09）。
- `market-publish-validation--mobile--light.png` —— 底部粘性条四行缺项播报 + 按钮约 130px；导入芯片
  `ppt-master` / `sql-tuning` 与「会议纪要整理」混排（K-10、K-21）。
- `market-review-batch--mobile--light.png` —— kill-switch 分区（两输入 + 全宽红按钮）占 390px 首屏
  约 300px，待审队列在折叠线以下（K-13）。
- `market-unauth--mobile--light.png` —— 「去登录」主按钮实际只关闭弹窗（X-01）。

预览台已知伪差异：嵌套弹层（卸载确认 / 归属编辑 / 拒绝理由）场景里 `shoot.mjs` 把截图 clip 到
**第一个** `[role=dialog]`（市场壳），内层弹层居中落在 clip 内，不影响判读；`shoot.mjs` 是共享设施，
本轮不改。

### 2.3 跑过的验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿（exit 0；`browser-tests/**` 不在 tsconfig include 内，场景文件靠 esbuild 构建 + 运行期 0 失败兜底） |
| 代码风格 | `npx biome check packages/web-react/browser-tests/ui-preview/scenes-market-audit.tsx` | ✅ 绿 |
| 视觉基线 | `node browser-tests/ui-preview/shoot.mjs`（`OC_UI_SCENES=market-`） | ✅ 126 张全部成功，0 渲染错误 0 页面异常，0 未打桩 API |
| 文案取证 | 逐文件人工过（半角标点 / 开发者词汇 / 间距） | 见 K-17、K-18、K-19 |

**未跑**（`NOT RUN`）：`npm test`（阶段 A 未改任何业务代码与既有测试；阶段 B 必跑）、`npm run test:browser`
（未触碰 Composer / 消息 / 工具卡 / 侧栏）、真机 iOS Safari（本机网络受限，仅 Chromium 移动模拟）、
真实审核状态流转（`useMarketplacePublishes` 轮询 → 顶部通知，需真后端）。

---

## 3. 问题清单

严重度：**P1** 功能不可用/数据错误/阻断主流程；**P2** 明显体验缺陷/一致性破坏/移动端不可用；**P3** 打磨项。
文件路径省略 `packages/web-react/src/` 前缀。

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| K-01 | `components/MarketplaceCenter.tsx:127`（`Dialog.Root onOpenChange={(o) => !o && onClose()}`）、`marketplace/PublishPanel.tsx:607-609` + `:631-632`（`useDraft` 只活在面板生命周期；注释「已知技术债:草稿只活在本面板生命周期内(关闭市场弹窗即丢),尚未落 localStorage」） | 发布表单（技能正文 / 附属文件 / 商品信息，可达数千字）在 **Esc、点遮罩、点右上 ✕、切到其它中心** 时无任何确认直接丢弃；技能工作台（manage）同类场景有「放弃未保存的修改？」拦截，市场没有 | 用户写了十分钟的 SKILL.md 与 4 条适用场景，一个 Esc 全没；被拒后「载入这次提交继续修改」也只在本会话内可用（`submittedRef`） | **P1** |
| K-02 | `marketplace/BrowsePanel.tsx:181-186`（`<span className="mt-0.5 line-clamp-2 block …">`） | 描述同时挂 `line-clamp-2` 与 `block`，`display:block` 抵消了 `-webkit-box`，**两行截断失效**：桌面 3 行、390px 下 4 行完整铺出 | 卡片"固定三段式、同排等高"的契约被破：同排另一张卡为对齐被拉高，标签行与信号行之间空出约 60px；移动端一屏只剩 2.5 张卡。见 `market-browse-skill--*`、`market-browse-search-mobile` | P2 |
| K-03 | `BrowsePanel.tsx:453-455`（`truncated`）、`:280-282`（`Section` 计数 Badge）、`:701-705`（结果条）、`:767-780`（「加载更多」） | 分区视图下翻页是**全局**的（`limit` 50→100），但每个分区头的计数与成员只反映**已加载的一页**：结果条说「共 50 个技能（可继续加载更多）」，下方却写「办公文档 6」「平台精选 2」当作事实；「加载更多」按钮在 8 个分区之后的最底部 | 用户在「办公文档」分区看到 6 张就以为只有 6 个；要发现还有更多得滚过全部分区。`/api/marketplace/search` 没有 offset（`lib/api.ts:3492-3496`），每次「加载更多」重拉 0..limit 全量。见 `market-browse-longlist` | P2 |
| K-04 | `marketplace/DetailModal.tsx:722-735`（footer `max-sm:flex-col-reverse max-sm:[&>*]:w-full`）、`:723-725`（「关闭」按钮） | 移动端底栏「安装 / 在对话中试用 / 关闭」三枚全宽按钮堆叠约 200px（844px 视口的 ¼），正文区只剩约 55%；「关闭」与右上 ✕ 重复 | 决策信息（适用场景 / 效果）被压到需要滚动；见 `market-detail-mobile`、`market-detail-agent-mobile` | P2 |
| K-05 | `BrowsePanel.tsx:620-634`（`err` Alert 渲染在列表**顶部**）、`:767-780` | 「加载更多」（用户在列表**底部**）失败时，`loadCards(true)` 把错误写进顶部的 `err`，按钮 loading 结束、列表压暗恢复，底部没有任何变化 | 点了没反应；要滚回顶部才看见红条。与 InstalledPanel 已采用的「行内动作失败就近可见（toast 带重试）」契约不一致 | P2 |
| K-06 | `BrowsePanel.tsx:578-586` | 「试试「翻译」「论文」「写作」」是纯文字 `<p>`，不可点 | 三个像芯片的引号词点了没反应；输入建议本该一点即搜 | P3 |
| K-07 | `BrowsePanel.tsx:797-822`（`Chip`） | 分类筛选片是 `<button>` 无 `aria-pressed`，选中态只有颜色 | 读屏 / 高对比模式分不出当前筛选 | P3 |
| K-08 | `marketplace/InstalledPanel.tsx:289-338`（actions 簇）、`ui/Card.tsx` `CardRow` 在窄屏把 actions 换到底部整行 | 390px 下只有「卸载」一个动作的行（如未就绪智能体、无新版本的技能）动作区整行只剩一枚右对齐的垃圾桶，多出约 50px 空行 | 移动端已安装列表每行多一截空白；见 `market-installed-mobile` | P3 |
| K-09 | `InstalledPanel.tsx:258-266` + `:341-347` | 智能体行同时出「能力已就绪」success 徽章、「可选 Plugin 待授权」warning 徽章与「1/2 项组合能力就绪」灰字 | 三句话互相打架：到底就绪没就绪？（实际语义：必需已就绪、1 项可选待授权） | P3 |
| K-10 | `marketplace/PublishPanel.tsx:1064-1079` | 「从我的技能导入」芯片直接显示 `sk.name`（slug），与 manage 技能列表的展示名（描述首行，`skillDisplayTitle`）不一致：`ppt-master` / `sql-tuning` 与「会议纪要整理」混排 | 同一个技能在管理中心叫「PPT 一键成稿」、在发布页叫 `ppt-master` | P3 |
| K-11 | `BrowsePanel.tsx:181-186`（描述 `aria-hidden="true"`）、`:191`（徽章行 `aria-hidden`）、`:148`（`ariaLabel` 只含名称 / 分类 / 身份 / 状态） | 整卡是一个 button，描述与标签对辅助技术**完全隐藏**；读屏用户只听到「PPT 一键成稿，办公文档，官方」 | 描述是选装与否的主要依据，读屏用户拿不到；应改 `aria-describedby` 而非隐藏 | P3 |
| K-12 | `BrowsePanel.tsx:597`（`[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`）、`:613-616`（右缘渐隐） | 分类片横滚行在**桌面端**隐藏滚动条、无左右箭头：鼠标用户只能 Shift+滚轮或拖选；1024px 下最后一片「未分类」被截 | 桌面端第 9 个分类等于不可达（键盘 Tab 到 section 后方向键可滚，但没人知道） | P3 |
| K-13 | `marketplace/ReviewPanel.tsx:296`（`<RevokeBox>` 置顶）、`:863-905` | 移动端 kill-switch 分区（说明 + 两输入 + 全宽红按钮）占 390px 首屏约 300px，待审队列在折叠线以下；slug 输入 placeholder 是裸词「slug」 | 管理员在手机上打开审核页第一眼是最危险的操作而不是待办；见 `market-review-batch--mobile` | P3 |
| K-14 | `DetailModal.tsx:870-873`（审核徽章 `title={scriptReviewCopy(…)}`）、`:912-915`（bench `title`）、`ReviewPanel.tsx:479-484` + `:489-496`（「带 evals」「自报增益存疑」`title`） | 解释文案只在原生 `title`：触屏永远看不到，读屏多数不读 | 「人工审核」到底审了什么、「自报增益存疑」为什么存疑，手机用户无从得知 | P3 |
| K-15 | `DetailModal.tsx:952-960`（`<Markdown>{humanMd}</Markdown>` 无标题降级） | 「详细介绍」内 Markdown 的 `#`/`##` 渲染成比段标题（`text-section`）更大更粗的标题 | 层级倒挂：子内容比父标题响；见 `market-detail--desktop` 的「它适合谁」 | P3 |
| K-16 | `DetailModal.tsx:903-910`（`👍 {up}/{total}`） | 评分徽章用表情 👍，同一行其余徽章都是 lucide 图标；卡片上同一信号用的是 `ThumbsUp` 图标 | 同一信号两种图形语言；表情在不同系统字体下大小 / 风格不一 | P3 |
| K-17 | `DetailModal.tsx:820-822`（「无需安装,所有用户开箱即用;在输入框上方…」）、`InstalledPanel.tsx:371`（`「…」?`）、`:404`（「可选;它只用于…」）、`:488`（「人格入口:在输入框上方切换。」） | 半角 `,` `;` `:` `?` 混在全角文案里 | 与市场其余文案（全角）不一致；shell S-13 已把它列为全站问题 | P3 |
| K-18 | `ReviewPanel.tsx:498-502` | 「2026-07-26提交 · 提交者 #8812」：`TimeAgo` 输出与「提交」之间无空格 | 日期与动词粘连 | P3 |
| K-19 | `DetailModal.tsx:989-999`（`认证方式：{authMode}`、`{a.id} · 读取/发送/写入`） | API 插件详情把 `authMode` 枚举值（`bearer` / `oauth2`…）与动作 id（`create_post`…）原样给用户 | 开发者词汇进用户文案 | P3 |
| K-20 | `DetailModal.tsx:677-682`、`:630-634`（done 态 Badge `self-center max-sm:justify-center`）+ footer `max-sm:[&>*]:w-full` | 移动端「已安装」「安装成功」Badge 被 footer 的 `[&>*]:w-full` 拉成一枚全宽药丸，形似按钮但不可点 | 用户会去点它；见 `market-detail-agent-mobile` | P3 |
| K-21 | `PublishPanel.tsx:291-328`（`SubmitBar`） | 移动端校验失败后粘性底栏「还差 6 项必填：…」两行 + 「请修正上方标记的字段后重新提交。」+ 按钮约 130px | 表单可视区被吃掉一截；缺项清单可折成「还差 6 项」+ 展开 | P3 |
| K-22 | `InstalledPanel.tsx:253-257`（每行 kind 徽章）、`:284-288`（`description={r.slug}`） | 行已按「智能体 / 技能 / API 连接插件」分组，每行仍再挂一枚同名徽章；描述位固定放裸 slug | 徽章位被重复信息占掉；slug 作为唯一描述对普通用户无意义 | P3 |
| K-23 | `DetailModal.tsx`（已安装态 footer 只有 Badge / 归属 / 更新） | 详情弹层里已安装的条目没有「卸载」入口，要关掉详情 → 切「已安装」→ 找到行 → 点垃圾桶 | 决策入口与撤销入口分离三步 | P3 |
| K-24 | `MarketplaceCenter.tsx:211-221` | 未登录空态「去登录」主按钮 `onClick={onClose}`：只关弹窗，不去登录；壳外 `App.tsx:3120 / :3996` 给 ManageCenter 传了 `onRequireLogin`，市场没有同款 prop | 按钮文案与行为不符；未登录时四个 Tab 仍可点但全是同一空态 | P3（接线归 shell，见 X-01） |
| K-25 | `BrowsePanel.tsx:760-764`（平铺 `<ul>`）、`:453-455` | 目录无虚拟化；「加载更多」按 `limit` 全量重拉（50 → 100 → 150…），搜索目录上限 500 时一屏 500 张卡 + 每次翻页重下前面所有条目 | 大目录下翻到第 5 页要下 250 条、DOM 500 张卡；当前目录规模（<100）无感 | P3（需后端 offset，见 §5） |
| K-26 | `marketplace/FeaturedPanel.tsx`（仅 admin 页使用） | 精选管理是 `src/admin/**` 的组件，用户端不可达；场景 `market-featured*` 已有截图，未见阻断项 | — | 备注（不计入） |
| K-27 | `ReviewPanel.tsx:370-383`、`:436-446`、`:592-606`；`PublishPanel` 无 | 审核面全部用原生 `<input type=checkbox className="accent-accent">`，`ui/` 没有 Checkbox 原语；label 包裹与 44px 触控靶都做了 | 与全站 Switch/Chip 视觉语言不同（方框 vs 药丸），但功能与可访问性完整 | P3（低；需 shell 提供 Checkbox 原语，见 §5） |

---

## 4. 修复计划

### K-01 发布草稿随弹窗关闭无提示丢失（P1，必修）

- **改**：`components/MarketplaceCenter.tsx`、`marketplace/PublishPanel.tsx`。
- **怎么改**：
  1. `PublishPanel` 向上暴露 `isDirty()`（三份 `useDraft` 任一 `isDirty()`）—— 通过 `onDirtyChange(dirty)`
     回调或 `useImperativeHandle`；`MarketplaceCenter` 持有 `publishDirty` state。
  2. `Dialog.Root onOpenChange`：`publishDirty` 时不直接 `onClose()`，改走 `useConfirm`「放弃未保存的
     发布草稿？」（confirmText「放弃」danger），确认才关；同时 `Dialog.Content` 加 `onEscapeKeyDown` /
     `onPointerDownOutside` 走同一判定（Radix 事件可 `preventDefault`）。写法照 `manage/SkillEditor.tsx`
     的 `requestClose`。
  3. 顺手把三份草稿落 `localStorage`（key `oc_v5_market_publish_draft:<userId>:<kind>`，`useDraft.set`
     时防抖写、`reset()` 时清；挂载时若有且非空给一条「已恢复上次未提交的草稿」`Alert` + 「丢弃」），
     被拒后「载入这次提交继续修改」也就不再只在本会话有效。
- **补测试**：`MarketplaceCenter.test.tsx`：发布表单有内容时 Esc → 出现确认框、`onClose` 未被调用；
  取消后表单内容仍在；确认后关闭。`PublishPanel.test.tsx`：草稿写入 / 恢复 / `reset` 清除 localStorage 三例。
- **风险**：中。`useDraft` 是三表单共用的状态钩子，改动面要覆盖 `isDirty` 的 `NO_INTERACTION_FLAGS` 口径
  （`slugTouched` 不算脏）。

### K-02 卡片描述两行截断失效（P2，必修）

- **改**：`BrowsePanel.tsx:181-186`。
- **怎么改**：去掉 `block`（`line-clamp-*` 自带 `display:-webkit-box`），保留 `mt-0.5 line-clamp-2 text-meta
  leading-snug text-muted`；button 内 phrasing-content 约束用 `span` 即可满足，不需要 `block`。
- **补测试**：`BrowsePanel.test.tsx` 加一例断言描述节点 `className` 含 `line-clamp-2` 且不含 `block`
  （jsdom 不算行高，只能守类名）；`market-browse-skill--*` / `market-browse-search-mobile` 出 after 图
  对比卡高。
- **风险**：无。

### K-03 分区视图翻页时分区计数失真（P2，必修）

- **改**：`BrowsePanel.tsx` `Section` / 结果条 / 「加载更多」。
- **怎么改**：
  1. `truncated` 为真时，分区头计数改为「已加载 N」并加 `title`/可见注脚「还有更多未加载」；结果条
     「共 50 个技能」改为「已加载 50 个技能」。
  2. 「加载更多」在分区视图下**同时**出现在结果条右侧（`ml-auto`，`size="sm"`）与列表底部，用户在
     顶部就能翻页。
  3. 真正的 offset 分页需后端 `/api/marketplace/search?offset=`（§5）；前端先按 1/2 做诚实呈现。
- **补测试**：`BrowsePanel.test.tsx`：返回恰好 50 条时结果条含「已加载」、分区计数节点带「还有更多」；
  `market-browse-longlist*` 出 after 图。
- **风险**：低。

### K-04 详情弹层移动端底栏三枚全宽按钮（P2，必修）

- **改**：`DetailModal.tsx:722-735`。
- **怎么改**：移动端「关闭」不进 footer（右上 ✕ 已有；`hidden sm:inline-flex`）；「在对话中试用」与主
  动作在窄屏并排两栏（`max-sm:grid max-sm:grid-cols-2`，主动作 `col-span-2` 仅在无次级动作时），
  Badge 类结果（K-20）不再受 `[&>*]:w-full` 影响：把 `w-full` 只加在 `Button` 上或包一层
  `max-sm:contents`。
- **补测试**：`DetailModal.test.tsx` 断言窄屏类名（`hidden sm:inline-flex` 在关闭按钮上）；
  `market-detail-mobile` / `market-detail-agent-mobile` 出 after 图。
- **风险**：低。

### K-05 「加载更多」失败在顶部报错（P2，必修）

- **改**：`BrowsePanel.tsx` `loadCards` / 「加载更多」。
- **怎么改**：`loadCards` 增加 `origin: "initial" | "more" | "retry"`；`origin === "more"` 失败时不写顶部
  `err`，改 `toast(apiErrorMessage(e, "加载更多失败"), "error", { actionLabel: "重试", onAction })`
  （与 `InstalledPanel.update` 同款），并把「加载更多」按钮恢复可点。
- **补测试**：`BrowsePanel.test.tsx` 一例：第二页请求 reject → 顶部无 Alert、toast 含「重试」。
- **风险**：低。

### K-06 搜索提示词不可点（P3）

- **改**：`BrowsePanel.tsx:578-586` → 三个 `Chip`（复用本文件 `Chip`，`active=false`），点击 `setQ(word)`。
- **补测试**：点击「翻译」后 `searchMarketplace` 收到 `q="翻译"`。

### K-07 分类片无 aria-pressed（P3）

- **改**：`Chip` 加 `aria-pressed={active}`。**补测试**：`getByRole("button", { pressed: true })`。

### K-08 / K-22 已安装行的动作簇与徽章位（P3）

- **改**：`InstalledPanel.tsx`：① 只有「卸载」时把它并进 meta 行右侧（`ml-auto`）而不是单独一行；
  ② 去掉与分组同名的 kind 徽章；③ `description` 只在 revoked 时显示，slug 移到 meta 行 `font-mono
  text-caption`。**补测试**：`InstalledPanel.test.tsx` 断言无「智能体」徽章、有 `sql-tuning` caption。

### K-09 就绪状态三句打架（P3）

- **改**：`InstalledPanel.tsx:258-266` + `:341-347`：合成一句：「必需能力已就绪 · 1 项可选 Plugin 待授权」
  / 「2 项必需能力未就绪」，只留一枚徽章。**补测试**：`InstalledPanel.test.tsx` 三种 readiness 组合各一例。

### K-10 导入芯片用展示名（P3）

- **改**：`PublishPanel.tsx:1064-1079`：芯片文案 `skillDisplayTitle(sk).title`，`title`/`aria-label`
  带 slug。**补测试**：`PublishPanel.test.tsx` 断言芯片名为描述首行。

### K-11 卡片描述对辅助技术可见（P3）

- **改**：`CardTile`：描述 `span` 去 `aria-hidden`，加 `id`，button 挂 `aria-describedby`；`ariaLabel`
  保持短名。**补测试**：`BrowsePanel.test.tsx` `getByRole("button", { name, description })`。

### K-12 桌面端分类片横滚不可达（P3）

- **改**：`BrowsePanel.tsx:591-618`：`sm:` 起改为 `flex-wrap`（桌面有宽度，不需要横滚），移动端保持横滚。
- **风险**：分类多时桌面多一行；可接受。

### K-13 kill-switch 移动端占首屏（P3）

- **改**：`ReviewPanel.tsx` `RevokeBox`：窄屏默认折叠为一行「紧急下架（kill-switch）▸」（`details` 或
  `Disclosure`），`sm:` 起展开；placeholder 「slug」→「要下架的条目 slug，如 ppt-master」。

### K-14 title-only 解释（P3）

- **改**：审核徽章 → `Tooltip`（可聚焦触发器，同 manage M-15 写法）+ 详情页已有的明文注脚补「人工审核：
  已通过平台危险模式扫描与管理员人工审核」；`ReviewPanel` 两枚徽章的 `title` 内容移到展开区首行。

### K-15 详细介绍 Markdown 标题层级（P3）

- **改**：`DetailModal.tsx:955-958`：包一层 `[&_h1,&_h2,&_h3]:text-section [&_h1,&_h2,&_h3]:font-semibold
  [&_h1,&_h2,&_h3]:mt-3`（若 `Markdown` 组件支持 `compact`/`headingScale` prop 则用 prop）。

### K-16 评分徽章表情（P3）

- **改**：`DetailModal.tsx:903-910` `👍` → `<ThumbsUp size={12} aria-hidden />`。

### K-17 / K-18 / K-19 文案（P3）

- 半角标点全角化（4 处）；`ReviewPanel.tsx:499-501` `{" "}提交`；`authMode` 映射（`bearer`→「API 密钥」、
  `oauth2`→「OAuth 授权」、`basic`→「账号密码」、其余原样）；动作 id 优先用契约里的 `title`/`label`
  字段（若 `connectorContract.actions[]` 有），否则 `a.id.replace(/_/g, " ")`。

### K-20 移动端 Badge 被拉成全宽（P3）

- 随 K-04 一并修（`w-full` 只作用于 Button）。

### K-21 校验缺项播报占高（P3）

- **改**：`SubmitBar`：缺项 > 3 时显示「还差 N 项必填」+ 「查看」`Button variant="link"` 展开清单；
  `error` 与缺项二选一显示。

### K-23 详情内无卸载（P3）

- **改**：`DetailModal.tsx` 已安装态 footer 增加 `variant="ghost"`「卸载」→ 复用 `InstalledPanel` 的确认弹层
  （抽成 `marketplace/UninstallDialog.tsx` 供两处复用）。**补测试**：详情内卸载成功 → `onInstalled`
  被调、Badge 消失。

### K-24 未登录「去登录」（P3，跨模块）

- **改**：`MarketplaceCenter` 加 `onRequireLogin?: () => void`，有则用之、无则回落 `onClose`；`App.tsx`
  接线归 shell（§6 X-01）。

### K-25 长列表分页 / 虚拟化（P3，需后端）

- 后端 `search` 支持 `offset`（或 cursor）后，前端「加载更多」改 append；DOM 超过 200 张卡再考虑虚拟化
  （当前规模不做）。

---

## 5. 建议不修 / 暂缓项

| 项 | 理由 |
|---|---|
| **`/api/marketplace/search` offset 分页** | 现契约只有 `limit`（`lib/api.ts:3492`），前端只能全量重拉；**需后端配合**。本轮只做 K-03 的诚实呈现。 |
| **`ui/` Checkbox 原语** | 审核面原生 checkbox 功能与可访问性完整（K-27）；统一视觉需 shell 出原语，不在本模块内造第二套。 |
| **FeaturedPanel（精选管理）** | 仅 `src/admin/**` 使用（PLAYBOOK §9 不在范围），本轮只确认既有场景截图无阻断。 |
| **发布审核状态实时通知（`useMarketplacePublishes` 轮询 → 顶部 Alert）** | 需真后端状态流转；代码审阅：通知留在滚动区外、多条计数、CTA 切分类并聚焦，未见问题。 |
| **`scenes-market.tsx` 本身的格式** | 与 `scenes-manage.tsx` 同样不过 biome 格式检查；不混进审计分支。 |
| **`shoot.mjs` 嵌套弹层 clip** | 共享设施，同 manage 审计备注。 |

---

## 6. 跨模块发现（不在本模块归属，已 / 待通报）

| 编号 | 位置 | 现象 | 归属 / 处置 |
|---|---|---|---|
| X-01 | `App.tsx:3120` / `:3996`（`onRequireLogin` 只给了 ManageCenter）、`MarketplaceCenter.tsx:211-221` | 市场未登录空态「去登录」实为关闭；需 App 给市场同款 `onRequireLogin` | **shell**（App 接线）。K-24 在本模块加 prop，接线由 shell-B 补一行。 |
| X-02 | 后端 `/api/marketplace/search` | 无 offset / cursor，前端翻页只能全量重拉 | **后端**，记入需后端配合。 |
| X-03 | `components/ui/Modal.tsx` footer 在窄屏的 `[&>*]:w-full`（由 DetailModal 自己写在 footer 容器上，非原语） | 非 Button 的子项（Badge）也被拉成全宽 | 本模块内修（K-04/K-20）；若其它弹层也在 footer 放 Badge，可由 shell 给 `Modal` 一个 `footerLayout` 选项。仅备注。 |

---

## 附：阶段 B 开工前需要拍板的事

1. **K-01 严重度与做法**：按 PLAYBOOK「数据错误 / 阻断主流程」判 P1；若指挥官认为「关弹窗前确认」即可、
   localStorage 落盘可缓，可只做 1–2 步、把落盘留到后续。
2. **K-03 / K-25**：是否本轮向后端提 `offset` 需求；前端诚实呈现不依赖它。
3. **K-12**：桌面端分类片改换行（多一行高度）还是加左右箭头（保留单行）。
4. **K-23**：详情内加「卸载」是否与「已安装页是卸载唯一权威」的既有决定冲突（`InstalledPanel.tsx:498`
   注释里 API 插件按此原则不重复提供）。
5. **K-24 / X-01**：`onRequireLogin` 接线由 shell-B 顺手改还是授权 market-B 改 `App.tsx` 一行。

---

## 7. 修复记录（阶段 B）

- 分支：`feat/v5-selfhost-audit-market`（阶段 A 基线 `7240a826`）
- 统计：发现 26 / 修复 12（P1 ×1、P2 ×4、P3 ×7）/ 遗留 14（全部 P3，理由见 §9）。
- 接手说明：修复与 after 截图由 fable-5-1-22 完成（09-16 02:00–03:04），但会话离线前未提交、未交付，工作树里
  全部为未暂存改动。fable-5-1-29 于 09-16 19:00 接手：逐文件复核 diff，重跑 typecheck / 模块 vitest / biome lint、
  对 6 个关键场景重截 after 图核对后，按 K-01 / 发现页 / 详情与文案 / 文档 四组分别提交（`da6fc3bc6` / `2b81246ad` /
  `2e58b37bc` / `a96286981`），但**未推送、未交付**即离线。fable-5-1-35 于 09-16 19:30 再接手：核对这 4 个提交与本表
  逐条一致、工作树无残留改动；按指挥官拍板 ⑤ 补 K-24 可选 prop + 用例；重跑 typecheck / 模块 vitest（含 `lib/marketplace.test`）/
  biome lint、补截 `market-unauth` 与 `market-browse-skill` after 图核对；推送并交付。
- 附录 5 件拍板事项的落地口径（① – ④ 任务自动流转、无显式裁决，按最小改动取值；⑤ 由指挥官在接手任务书里明示）：
  ① K-01 以**落盘 + 关弹窗时 toast 提示已暂存**实现，不做阻断式确认 —— 草稿既然不会丢，每次关市场都弹一次
  「放弃？」反而是打扰；② 未向后端提 offset，前端只做诚实呈现；③ K-12 未动（遗留）；④ K-23 未动（与「已安装页
  是卸载唯一权威」冲突，遗留）；⑤ K-24：**market 侧给 `MarketplaceCenter` 加可选 prop `onRequireLogin?: () => void`**
  （有则「去登录」调它、由壳外负责关市场并切登录，与 `ManageCenter` 同款契约；没传保持只关弹窗），`App.tsx` 那一行
  归 shell、由集成②接线，本模块不改 `App.tsx`。

| 编号 | 状态 | 改动（`packages/web-react/src/` 下） | 用例 |
|---|---|---|---|
| K-01 | ✅ | `lib/marketplace.ts` 新增 `publishDraftStorageKey / loadPublishDraft / savePublishDraft / clearPublishDraft`；`marketplace/PublishPanel.tsx` `useDraft` 加 `persistKey`：挂载读回（新增字段自动补默认、坏数据当无草稿）、写入 300ms 防抖落盘、写空 / `reset` 后删除，暴露 `restored`；三份草稿按 kind 各落一份 `localStorage`；表单顶部「已恢复上次未提交的草稿」`Alert` + 「丢弃草稿」；新增 `onDirtyChange` 上报；`MarketplaceCenter.tsx` 关弹窗（Esc / 遮罩 / ✕）时若有草稿 toast「发布草稿已暂存，下次打开「发布」可以接着填」，不拦截关闭。 | `PublishPanel.test` ×2（落盘 / 恢复 / 丢弃 / 脏上报；坏数据兜底）、`MarketplaceCenter.test` ×1（干净不提示、脏提示）、`marketplace.test` ×1（存储纯函数） |
| K-02 | ✅ | `marketplace/BrowsePanel.tsx` 卡片描述去掉 `block`（`display:block` 抵消了 `line-clamp-2` 的 `-webkit-box`）。 | `BrowsePanel.test` 「卡片描述两行截断」 |
| K-03 | ✅ | `BrowsePanel.tsx`：`Section` 新增 `truncated`，计数徽章改「已加载 N」+ 注脚「还有更多未加载」；结果条「共 N 个」→「已加载 N 个，还有更多」；分区视图的结果条右侧再放一枚「加载更多」（不必滚过全部分区）。 | `BrowsePanel.test` 「目录不再硬截断」改写（断言两处「加载更多」与「已加载」文案） |
| K-04 / K-20 | ✅ | `marketplace/DetailModal.tsx` footer：「关闭」`max-sm:hidden`（右上 ✕ 已有）；动作容器 `max-sm:flex-nowrap max-sm:[&>button]:flex-1`，去掉 `max-sm:flex-col-reverse` 与 `[&>*]:w-full` —— 窄屏两枚动作并排各占一半，Badge 保持自身宽度。 | `DetailModal.test` 「footer 窄屏契约」 |
| K-05 | ✅ | `BrowsePanel.tsx` `loadCards` 记录本次是否由「加载更多」触发：失败走 `toast(…, "error", { actionLabel: "重试" })` 就近可见，不写顶部 `err`。 | `BrowsePanel.test` 「加载更多失败」 |
| K-06 | ✅ | 搜索提示词改为可点 `Chip`（点击 `setQ(word)`）。 | `BrowsePanel.test` 「分类筛选片带 aria-pressed；提示词芯片点一下即搜」 |
| K-07 | ✅ | `Chip` 加 `aria-pressed={active}`。 | 同上 |
| K-11 | ✅ | 卡片描述去 `aria-hidden`，改 `id` + button `aria-describedby`；徽章行仍 `aria-hidden`（名字保持短）。 | `BrowsePanel.test` 「卡片描述两行截断…aria-describedby」（`toHaveAccessibleDescription`） |
| K-16 | ✅ | 详情评分徽章 `👍` → `<ThumbsUp>`（与卡片同款 lucide 图标）。 | `DetailModal.test` 既有评分用例改写 |
| K-17 | ✅ | 半角标点 4 处：`DetailModal.tsx` 预设说明、`InstalledPanel.tsx` 卸载标题 `？`、原因 hint `；`、分组 hint `：`。 | —（文案） |
| K-18 | ✅ | `ReviewPanel.tsx` 「2026-07-26提交」→ 日期与「提交」之间补空格。 | —（文案） |
| K-24 | ✅（market 侧） | `MarketplaceCenter.tsx` 新增可选 prop `onRequireLogin?: () => void`；未登录空态「去登录」`onClick={onRequireLogin ?? onClose}` —— 接了就走它（与 `ManageCenter` 同款：回调自己负责关市场 + 切登录，壳层不重复关），没接保持只关弹窗。`App.tsx` 接线归 shell（X-01），待集成②补一行。 | `MarketplaceCenter.test` +1（接了 `onRequireLogin`：被调 1 次、`onClose` 不被调）；既有未登录用例保留「没接则只关弹窗」断言 |
| K-08 / K-09 / K-10 / K-12 / K-13 / K-14 / K-15 / K-19 / K-21 / K-22 / K-23 / K-25 / K-27 | ⏸ | 遗留，见 §9。 | — |

## 8. 验证（阶段 B）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿（exit 0；接手复核 09-16 19:08 再跑一次仍绿；fable-5-1-35 加 K-24 后 19:35 再跑仍绿） |
| 模块单测 | `npx vitest run src/components/marketplace src/components/MarketplaceCenter.test.tsx --maxWorkers=1` + `npx vitest run src/lib/marketplace.test.ts --maxWorkers=1` | ✅ 09-16 19:36 / 19:40（fable-5-1-35，含 K-24 用例）：`components/marketplace/**` + `MarketplaceCenter.test` 10 个文件 / 109 例全绿，`lib/marketplace.test` 1 个文件 / 29 例全绿（合计 11 文件 / 138 例；较 19:11 那次 137 例 +1 = K-24 新用例）。新增 9 例：MarketplaceCenter +2、BrowsePanel +3、DetailModal +1、PublishPanel +2、marketplace +1，另 2 例既有用例改写；每条逻辑改动有用例，见 §7 表；无 `.only` / `.skip` |
| 代码风格 | `npx biome lint <改动的 9 个源文件>` | ✅ 未新增诊断（`MarketplaceCenter.tsx` / `.test.tsx` 19:38 复跑：0 条）；其余 7 个文件 15 条 `useExhaustiveDependencies` / `noArrayIndexKey` / `noDelete` 全在未触碰的行。`biome check` 另报 **format / organizeImports**，经把工作树文件转 LF 后复跑核实：`MarketplaceCenter.tsx` 的 2 处 format 命中（`onCreateInChat={…}` 换行、`<div className="contents" …>` 折行）与 `MarketplaceCenter.test.tsx` 的整文件引号 / 分号风格、两文件的 import 顺序**全部是阶段 A 基线就有的既有差异**（这两个文件本来就不过 `biome format`，与 §5 备注的 `scenes-market.tsx` 同类），本轮新增行沿用文件既有风格，未引入新差异 |
| 视觉 after | `OC_UI_SCENES=market-` `node browser-tests/ui-preview/shoot.mjs` → `D:\code\test_project\test123\.audit-tmp\market\after\` | ✅ 126 张全部成功（`failures: 0`、`unmockedApi: []`，09-16 03:04）。接手复核对 `market-browse-skill` / `market-browse-search-mobile` / `market-browse-longlist(-more)` / `market-detail-mobile` / `market-detail-agent-mobile` 6 场景重截 18 张到 `…\market\after-takeover\`，全部成功，逐张核对与下文 after 对照描述一致。fable-5-1-35 加 K-24 后对 `market-unauth` / `market-browse-skill` 重截 8 张到 `…\market\after-k24\`（全部成功）：未登录空态与「去登录」按钮外观不变（K-24 只改行为、需 App 接线后才可见），`market-browse-skill` 与 `after-takeover` 一致 |

after 对照（同名 PNG，`before/` ↔ `after/`）：

- `market-browse-skill--*` / `market-browse-search-mobile` —— 卡片描述两行截断生效，同排卡片等高，标签行与信号行之间不再空出一截；提示词变成三枚可点芯片。
- `market-browse-longlist--*` —— 结果条「已加载 50 个技能，还有更多」+ 右侧「加载更多」，各分区计数「已加载 N」+「还有更多未加载」。
- `market-detail-mobile` / `market-detail-agent-mobile` —— 底栏从三枚竖排全宽按钮变为两枚并排，「已安装」Badge 不再被拉成全宽假按钮。
- `market-detail--desktop` —— 评分徽章用 ThumbsUp 图标，与其余徽章同一图形语言。
- `market-unauth--*`（`after-k24/`）—— 与 before 一致：K-24 在 market 侧只加了出口回调，未登录空态外观不变；
  「去登录」真正跳到登录要等 `App.tsx` 接上 `onRequireLogin`（X-01）。

**NOT RUN**：`npm test` 全量（本轮改动限于 marketplace 目录 + 壳 + `lib/marketplace.ts`，模块内 10 文件全绿；全量在 manage-B 已跑过一次、其 3 例既有失败与本模块无关）、`npm run test:browser`（未触碰高频交互面）、真机 iOS、真实审核状态流转。

## 9. 遗留

> 二期（t-625，§10）已关闭 K-08 / K-09 / K-22 / K-10 / K-12 / K-13 / K-14 / K-15 / K-19 / K-21 十条；下表只剩仍未动的。

| 项 | 原因 | 建议 |
|---|---|---|
| K-23（详情内卸载） | 与「已安装页是卸载唯一权威」的既有决定冲突（附录 4），二期任务书明示保持不做 | 拍板后复用卸载弹层 |
| X-01（未登录「去登录」的 `App.tsx` 接线；K-24 market 侧已修） | `MarketplaceCenter` 已暴露 `onRequireLogin?: () => void`（§7）；`App.tsx` 归 shell，本模块不动 | 集成②在 `App.tsx` 渲染 `<MarketplaceCenter>` 处补一行 `onRequireLogin={() => { setMarketplaceOpen(false); setAuthMode("login"); setView("app"); }}`（照 ManageCenter 那一行） |
| K-25 / X-02（offset 分页 / 虚拟化） | 需后端 | 后端提供 offset 后前端改 append |
| K-27（原生 checkbox） | 需 shell 出 Checkbox 原语 | shell |

## 10. 二期收尾（t-625 · 遗留 P3）

- 分支：仍是 `feat/v5-selfhost-audit-market`（接在 §7 的 `1fb99bfcc` 之后；与 settings2 / sidebar2 / taskboard2 同一口径，
  二期不另开分支）。接手说明：任务书要求先查本地是否已有前任（fable-5-1-41）的 worktree / 分支进度 —— 核对结果：
  `wt\market` 工作树干净（HEAD = `1fb99bfcc`，只有 `npm ci` 造成的两处 CRLF 假改动）、无 `feat/v5-selfhost-audit-market2`
  分支、`.audit-tmp\market2` 不存在，**前任没有留下任何进度**，本轮从零做。
- 范围：任务书列出的 10 条 P3 全部落地；K-23 按任务书保持不做，K-25 / K-27 保持遗留（需后端 / 需 shell）。
- 拍板项落地口径：附录 3（K-12 换行 vs 箭头）任务书未明示，取**换行**：桌面端有宽度、换行是零学习成本的方案，箭头
  还要多两个控件与滚动状态；移动端保持横滚 + 右缘渐隐不变。
- 顺手的改动（都在 K 号范围内、不越界）：K-14 把评分 / 实测徽章上与注脚重复的 `title` 一并撤掉（同一句话就在下方明文里）；
  K-15 除标题外把 `.prose` 正文也压回弹层的 `text-body`（此前 15.5px 的介绍正文比 13.5px 的段标题还大，同属层级倒挂）；
  K-10 的导入确认框标题与"正文没能读到"提示改用与芯片一致的展示名。

| 编号 | 状态 | 改动（`packages/web-react/src/` 下） | 用例 |
|---|---|---|---|
| K-08 | ✅ | `marketplace/InstalledPanel.tsx`：只剩「卸载」一个动作的行（无新版本、无待授权的智能体；已下架的技能）不再占 `CardRow` 的 `actions` 槽（窄屏那一槽独占一行、一枚 32px 垃圾桶右边挂 50px 空白），垃圾桶并进 meta 行右侧（`ml-auto`）；有「更新 / 授权 Plugin / 归属 / 启用」作伴时照旧走操作槽。 | `InstalledPanel.test` 「只剩「卸载」一个动作的行…（K-08）」 |
| K-09 | ✅ | `InstalledPanel.tsx` 新增导出 `agentReadinessSummary(readiness)`：按 `requirements[].optional / status` 算，**一枚**徽章 + 一句注脚 —— 全就绪「能力已就绪」；必需就绪但可选待授权「必需能力已就绪 · N 项可选 Plugin 待授权」；必需未就绪「N 项必需能力未就绪」/「N 项必需 Plugin 待授权」；注脚统一「M/N 项组合能力就绪」，无依赖时只留「不依赖额外 Skill / Plugin」。 | `InstalledPanel.test` `test.each` ×3（全就绪 / 必需就绪+可选待授权 / 2 项必需未就绪；并断言旧版三句不再同时出现） |
| K-22 | ✅ | `InstalledPanel.tsx`：删掉与分组同名的「智能体 / 技能 / API 插件」kind 徽章（分组标题 + 左侧按种类配色的图标芯片已经说明了种类）；`description` 只在已下架时显示提示，slug 改为 meta 行里的 `font-mono text-caption text-faint`（连接器行同步）。 | `InstalledPanel.test` 「列表按 kind 分组;行内不再重复挂…（K-22）」（改写自既有分组用例） |
| K-10 | ✅ | `marketplace/PublishPanel.tsx`「从我的技能导入」芯片改用 `manage/skillDisplay.skillDisplayTitle`（描述首行为名、slug 为 caption），与管理中心技能列表同一套展示名；`aria-label` =「展示名（slug）」、`title` 带 slug 供核对；导入确认框标题与"正文没能读到"提示同步用展示名。 | `PublishPanel.test` 「导入芯片与管理中心同一套展示名…（K-10）」+ 既有导入确认用例改写（按新无障碍名找芯片、断言确认框标题） |
| K-12 | ✅ | `marketplace/BrowsePanel.tsx` 分类片容器 `sm:flex-wrap sm:snap-none sm:overflow-x-visible`，右缘渐隐 `sm:hidden`；`aria-label` 「市场分类，可横向滚动」→「市场分类」（桌面已不横滚）。移动端行为不变。 | `BrowsePanel.test` 「分类筛选片只渲染有条目的分类」补断言（桌面换行类名 + 渐隐 `sm:hidden`） |
| K-13 | ✅ | `marketplace/ReviewPanel.tsx` `RevokeBox`：窄屏默认只留标题行 + 「展开」（`aria-expanded` / `aria-controls`，正文 `max-sm:hidden`），`sm:` 起照旧全展开、切换按钮 `sm:hidden`；置顶位置不变。slug 输入 placeholder「slug」→「要下架的条目 slug，如 ppt-master」。 | `ReviewPanel.test` 「kill-switch 分区窄屏默认折叠成一行…（K-13）」（含 `expectAriaControlsResolvable`） |
| K-14 | ✅ | `marketplace/DetailModal.tsx` 审核背书徽章：`title` → `Tooltip`（触发器 `tabIndex=0` 可聚焦，同 manage M-15 写法）+ 徽章下方明文注脚「人工审核：已通过平台危险模式扫描与管理员人工审核。」（四种 reviewSource 各自的文案）；评分 / 实测徽章上与注脚重复的 `title` 撤掉。`ReviewPanel.tsx`「带 evals」「自报增益存疑」：`title` → `Tooltip`，解释另在展开审查区首行明文列出（触屏 / 读屏可达）。 | `DetailModal.test` 「审核背书徽章:解释走 Tooltip…（K-14）」+ 既有 `test.each` reviewSource 用例改写（注脚与脚本说明两处口径一致）+ 既有评分用例改写（无 `title`）；`ReviewPanel.test` 「「带 evals」「自报增益存疑」的解释不再只挂 title…（K-14）」 |
| K-15 | ✅ | `DetailModal.tsx`「详细介绍」容器加 `HUMAN_MD_PROSE_CLASS`：`[&_.prose]:text-body!` + `[&_:is(h1,h2,h3,h4)]:text-section! font-semibold! mt-3! mb-1!` + `[&_.prose>:first-child]:mt-0!`。必须带 `!`：`styles.css` 的 `.prose` 规则未分层，会压过 `@layer utilities` 里任何后代选择器。结果：段标题 ≥ 介绍内标题 > 正文，不再倒挂。 | `DetailModal.test` 「详细介绍的 Markdown 标题层级不倒挂…（K-15）」（jsdom 不算样式，守类名契约；视觉由 after 图证明） |
| K-19 | ✅ | `lib/marketplace.ts` 新增 `connectorAuthModeLabel`（后端 `AuthMode` 七种 + `managed_browser` / `none` → 中文，未知值原样）、`connectorActionLabel`（`create_post` / `createFollowUp` / `pages.search` → `create post` / `create follow up` / `pages search`；契约 `projection.ts` 只投影 `id + effect`、没有 title 字段可用）、`connectorActionEffectLabel`（read / send / 其余按「写入」）；`DetailModal.tsx` 插件详情块改用三者，原始值仍在「查看发布者提交的技术声明」里。 | `marketplace.test` ×3；`DetailModal.test` 「API 插件详情:认证方式与动作范围用人话…（K-19）」 |
| K-21 | ✅ | `PublishPanel.tsx` `SubmitBar`：缺项 > 3 时折成「还差 N 项必填 · 查看」（`aria-expanded`），点开列全并可「收起」；≤3 项照旧直接列全。三张表单（技能 / 智能体 / 插件）共用。 | `PublishPanel.test` 「底部操作条:缺项超过 3 项折成…（K-21）」 |
| K-23 | ⏸ 不做 | 任务书明示：与「已安装页是卸载唯一权威」既有决定一致，保持不做。 | — |
| K-25 / K-27 | ⏸ 遗留 | 需后端 offset / 需 shell Checkbox 原语，见 §9。 | — |

预览台场景：`browser-tests/ui-preview/scenes-market-audit.tsx` 新增 `market-detail-plugin`（API 插件详情 · 带签名契约；此前插件详情的
「平台已签安全范围」块从未被截过图，K-19 的证据只能靠它），随代码提交。

### 10.1 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿（exit 0，09-16 22:47） |
| 模块单测 | `npx vitest run src/components/marketplace src/components/MarketplaceCenter.test.tsx src/lib/marketplace.test.ts --maxWorkers=1` | ✅ 11 文件 / **152 例全绿**（09-16 22:48；§8 时 138 例，+14 = marketplace +3、DetailModal +3、InstalledPanel +4、PublishPanel +2、ReviewPanel +2；另 5 例既有用例按新契约改写）。每条逻辑改动有用例，见上表；无 `.only` / `.skip` |
| 代码风格 | `npx biome lint <13 个改动文件>` | ✅ 未新增诊断：15 条全部是 §8 已登记的既有 `useExhaustiveDependencies` / `noArrayIndexKey` / `noDelete`（行号因插入而后移，代码未触碰）；新增的 1 条 `suppressions/unused` warning 已通过删掉多余的 biome-ignore 消掉 → 0 warning |
| 视觉 before / after | `OC_UI_SCENES=market-installed,market-publish,market-browse-skill,market-review,market-detail` → `D:\code\test_project\test123\.audit-tmp\market2\{before,after}\` | ✅ 各 88 张（34 场景 × 主题 × 声明视口），`failures: 0`、`retried: 0`、`unmockedApi: []`；before 在改代码前用旧代码出（仅先加了 `market-detail-plugin` 场景），after 用新代码出，同名 PNG 逐张对照 |

after 对照（同名 PNG，`market2/before/` ↔ `market2/after/`，PNG 不入库）：

- `market-installed-mobile--mobile--*` / `market-installed--desktop--*` —— 「编程助手 Pro」行垃圾桶从独占一行挪到 meta 行右侧，行高约 190 → 170px；「科研调研员」的「智能体 / 能力已就绪 / 可选 Plugin 待授权 / 1/2 项组合能力就绪」四句收成「必需能力已就绪 · 1 项可选 Plugin 待授权」+「1/2 项组合能力就绪」；所有行的 kind 徽章消失、slug 变等宽小字。
- `market-publish-validation--mobile--*` / `market-publish--mobile--*` —— 底栏从「四行缺项 + 失败原因 + 按钮 ≈130px」变为「还差 6 项必填 · 查看 + 失败原因」一行半（≈70px）；导入芯片 `ppt-master` / `sql-tuning` 变「PPT 一键成稿」「SQL 慢查询优化」，与「三段式纪要」等同一套口径。
- `market-browse-skill--desktop--*` —— 九个分类片换成两行全部可见（「未分类」落到第二行），右缘渐隐消失；移动端图不变。
- `market-review-mobile--mobile--*` / `market-review-batch--mobile--*` —— kill-switch 分区折成一行「紧急下架已上架条目（kill-switch） 展开」，待审队列进入首屏；桌面端 `market-review--desktop--*` 全展开、无切换按钮，placeholder 变「要下架的条目 slug，如 ppt-master」。
- `market-detail--desktop--*` / `market-detail-plugin--*` —— 徽章行下多出「人工审核：已通过平台危险模式扫描与管理员人工审核。」注脚；「详细介绍」内「它适合谁 / 授权范围」从 23px 粗标题降到与段标题同档（13.5px），介绍正文从 15.5px 回到 13px；插件块「认证方式：oauth2-auth-code」→「认证方式：OAuth 授权登录」，`search_pages · 读取` → `search pages · 读取`。暗色 / 移动端同样成立（`market-detail-plugin--mobile--dark` 核对）。

**NOT RUN**：`npm test` 全量（改动限于 marketplace 目录 + `lib/marketplace.ts`，模块内 11 文件全绿；全量门由集成分支统一跑）、`npm run test:browser`（未触碰 Composer / 消息 / 工具卡 / 侧栏）、真机 iOS Safari、Tooltip 的 hover 态截图（预览台静态挂载，无 hover 驱动；Tooltip 用的是全站同一 `ui/Tooltip` 原语，InstalledPanel 已在用）。
