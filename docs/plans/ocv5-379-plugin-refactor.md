# V5 个人版插件功能重构：调研与方案（OCV5-379）

> 2026-10-12 · 外机 cc3 · 范围：只做 V5 个人版（selfhost，`feat/v5-selfhost`），商业版不动。
> 基线：canonical `81aedcd83`（与 live `rel-81aedcd83-20261011-173241` 一致）。
> 证据：现网前截图（外机 `shots/before/`）（1440 与 390 两种宽度，canary 账号）；代码审查笔记（外机 `notes/audit.md`）；竞品调研（外机 `notes/research.md`，出处见第 7 节）（26 个已抓取出处）。

## 1. 现状：用户看到的插件

| 入口 | 现网显示 | 背后数据 |
|---|---|---|
| 侧栏 → **市场**（弹窗标题「AI 市场」）→ 发现 → 「插件」 | 只有 **知乎、微博**（受管浏览器插件，要先安装） | `/api/marketplace/search?kind=connector`（存储 kind=`connector`，对外投影为 `plugin`） |
| 侧栏 → **管理中心**（副标题「记忆 · 技能」）→ 「插件」（tab id 是 `connectors`） | **飞书、GitHub、Notion、WebDAV 网盘、邮箱**（「官方预装」，市场里看不到）；装过的知乎/微博也在这里 | 三套后端拼在一个 2648 行组件里：v1 手写 provider `/api/connectors`、声明式 `/api/connectors/declarative/management`、浏览器插件 `/api/plugins/management` |
| 市场 → 已安装 | 空态「还没有安装任何技能或智能体」；装了插件则另起一组「API 连接插件」 | `/api/marketplace/installed` |
| 市场 → 发布 | 发布技能 / 发布智能体 / 发布插件（贴 ConnectorSpec JSON） | `/api/marketplace/publish*` |
| 对话里的工具卡 | 「应用连接」（oc-connect）和「市场插件」（oc-plugin）两种 | 两个 CLI 进同一个 `connectors/rpc.ts` |

## 2. 问题清单（附证据）

**A. 名词混乱：同一个东西有 5 个名字**
1. 「插件」「插件账号」「API 连接插件」「应用连接」「应用连接器」「市场插件」「Plugin」混用：`manageTabs.ts:35`、`productCapabilities.ts:238`、`MarketplaceCenter.tsx:24`、`PublishPanel.tsx:794,2051`、`InstalledPanel.tsx:546`、`tool/meta.ts:147,150`，ConnectorsTab 的提示里也直接写英文「Plugin」。
2. Agent 让用户去 **「设置 → 应用连接器」**，这个菜单不存在，实际位置是「管理中心 → 插件」：`gateway/ocConnectCli.ts:71,76`、`ccb-baseline/skills/app-connectors/SKILL.md:22`。
3. 市场的名字不统一：侧栏「市场」、弹窗「AI 市场」、管理后台「技能市场」。
4. Agent 的插件说明（app-connectors SKILL）提到知识星球、微博，**没写知乎**，而知乎已经上线。

**B. 一个插件目录被拆成两半**
5. 市场「插件」只列「需要安装」的（知乎、微博）；预装的 5 个（飞书、GitHub、Notion、WebDAV、邮箱）只在管理中心出现。用户在任何一处都看不到完整的插件列表，也没法从市场知道「GitHub 已经可以用」。
6. 市场卡片不显示连接状态（未连接 / 已连接 N 个账号 / 需重新授权 / 可更新）；状态只在管理中心，而且三套后端各算各的。

**C. 入口跳错、说明不完整**
7. 管理中心 → 技能 → 「市场」打开的是**插件**类目：`App.tsx:4588-4591` 写死了 `openMarketplace("browse","connector")`，SkillsPanel 复用了这个回调。
8. 管理中心底部「去市场添加」不分页签，一律打开插件类目。
9. 侧栏「管理中心」副标题只写「记忆 · 技能」，漏了定时和插件（`Sidebar.tsx:1211`）。
10. 市场「已安装」的空态说「还没有安装任何技能或智能体」，没有提到插件；插件组标题是「API 连接插件」。

**D. 代码结构**
11. `ConnectorsTab.tsx` 2648 行，同时承担三套后端合并、v1 绑定弹层、声明式绑定弹层、扫码授权弹层、账号行、写入开关、知识星球自动回复入口。
12. 浏览器插件按 provider 写死：`managedQrMeta / startManagedQrSetup / get… / cancel…` 是一串 `if (provider === 'weibo') … else if 'zhihu' …`（ConnectorsTab.tsx:74-171），失败文案也按 provider 写死。新增一个插件要改 6 处。
13. 后端同样写死：`http/plugins.ts:217` 路由正则是固定列表；`index.ts:1674-1731` 三段复制粘贴的接线；`runtime.ts:1450-1456` 按 slug 写三元表达式；worker 是 2000 多行放在模板字符串里的 JS（`weiboWorkerSource.ts`），不在 TS/Biome 工具链里。
14. 死代码：`sandboxed-local` 运行时（localSandbox / localBroker / localRuntime，约 1.9k 行）从没接线（index.ts:1715），但类型和 UI 还在处理这个分支；平台 OAuth 应用的后台 API 没有任何界面。
15. 同一产品在后端有两份实现：飞书、GitHub、Notion 既有 v1（`connectors/providers/*`），又有声明式（`connectors/defaults/*`），前端按 slug 去重。
16. 两个 CLI（`oc-connect`、`oc-plugin`）进同一个 RPC，Agent 得先判断用哪个。
17. 安装只有「装 / 卸」两态，没有「启用 / 停用」，也不能按对话开关。
18. 个人版 CI（`v5-selfhost-gates`、`v5-selfhost-web-react`）不跑 commercial、gateway、storage 单测，插件后端的测试不挡个人版 PR。

## 3. 参照产品（摘要，出处见第 7 节）

| 产品 | 顶层单元 | 状态 | 认证 | 界面位置 |
|---|---|---|---|---|
| Claude Code / Claude.ai | Plugin，打包 skills、MCP、commands、agents、hooks [1][4] | Discover → Installed（可停用）；连接器另有 Connected / Not connected / Not added [3][4] | 每个用户自己 OAuth；安装插件 ≠ 登录 [4][5] | Customize 一页同时放 Connectors、Skills、Plugins [4] |
| ChatGPT / Codex | Plugin（2026 年吸收了 Apps 目录，未验证 [U1]）= skills + MCP + UI [7] | 目录 → 安装 → `@` 调用 [11] | OAuth 2.1 + PKCE，可连多个账号 [9] | 侧栏 Plugins [11] |
| Cursor / VS Code | Plugin / Extension，组件化 [12][16] | 安装 → 开关，作用域分用户 / 项目 [14][16] | OAuth 或注入变量 [14][15] | Customize；输入框里的 Configure Tools [14] |
| Dify | Plugin（6 类）[18] | 装在工作区，自动更新分三档 [19] | 管理员配 OAuth 客户端，用户各自授权 [20] | 工作区设置 →「集成」[19] |
| Coze | 插件 = 一组工具 [21] | 商店 / 空间 → 加到智能体 | none / oauth / service_token [21] | 资源库与智能体编辑页 |
| Gemini CLI / Open WebUI | Extension / Tools [23][25] | 安装 → 启用，分 user / workspace [24] | 存进钥匙串 / Valves | 输入框开关 [26] |

**共性**：① 用一个顶层名词「插件」统一，技能和连接器是它的组件；② 生命周期是「发现 → 已安装 → 启用」，连接状态单独一条线；③ 安装和授权分开，授权按用户、可连多个账号；④ 市场与「我的」是**同一份目录的两个视图**，卡片直接显示「已安装 / 已连接」；⑤ 用权限声明和详情页说清「会装什么、能做什么」；⑥ 可以按对话或按工具开关。

## 4. 方案

### 4.1 名词表（产品层唯一权威，写进 `lib/pluginDirectory.ts` 注释与测试）

| 用户看到的词 | 指什么 | 不再使用 |
|---|---|---|
| **插件** | 可以安装、授权后供助手调用的外部应用能力（API 插件与浏览器插件都算） | 连接器、应用连接、应用连接器、API 连接插件、市场插件、Plugin |
| **账号** | 插件里绑定的一个登录（可多个） | 插件账号、连接 |
| **技能** | SKILL.md 形式的做法 | — |
| **智能体** | agent | — |
| **AI 市场**（侧栏短名「市场」） | 发现、安装、发布的地方 | 技能市场、插件市场 |

存储层的 `kind=connector`、API 路径、tab id `connectors` 保持不变（持久契约，教程深链要用），只改产品层的文案和模型。

### 4.2 一个插件目录，两个视图（本轮实施）

新增纯函数模块 `lib/pluginDirectory.ts`，把三套后端（v1、声明式、浏览器插件）合成一份 `PluginEntry[]`，每项有：

- `source`：内置 / 市场
- `runtime`：API / 浏览器
- `accounts`：账号列表
- 统一的 **状态**：`未安装`、`待连接`、`已连接`（N 个账号）、`需处理`（需重新授权 / 需先更新 / 不可用）、`可更新`

目录只回答「**已有的插件**（内置 + 已安装 + 有账号）现在是什么状态」；**未安装的市场条目仍以 `/api/marketplace/search?kind=connector` 为准**（Codex 方案审查 r1 P1）。市场「插件」= 市场搜索结果 ∪ 目录中的内置项（按 slug 去重，市场条目优先；搜索态只并入名称/说明命中关键词的内置项），每张卡再按 slug 叠加目录状态；目录任一接口失败只降级为「不显示状态 / 不并入内置项」，绝不影响市场搜索结果、详情和安装流。

两个视图的用法：

- **市场 → 发现 → 插件**：显示**全部插件**（市场条目照旧 + 并入内置项）。内置的飞书、GitHub、Notion、WebDAV、邮箱也有卡片，标「官方 · 已预装」，卡片上显示状态徽标（未连接 / 已连接 2 个账号 / 需重新授权）。点击内置插件直接去管理中心对应插件（没有市场详情，v1 的 WebDAV/邮箱也没有 listing，不能走 DetailModal）；市场插件仍走详情 → 安装 → 授权，不变。
- **管理中心自动定位**：现在 `autoAuthorizePluginSlug` 只认浏览器插件；扩展到 API 插件：已有账号 → 卡片内提示「已连接 N 个账号」；没有账号 → 直接打开该插件的绑定弹层（GitHub 若走 v1 则沿用现有 OAuth 跳转，声明式优先时打开声明式弹层）。
- **管理中心 → 插件**：保留「已连接 / 可添加」分组，状态文案改用同一套判定。
- **市场 → 已安装**：插件组标题改为「插件」，每行显示状态，并提供「管理账号」；空态改为「还没有安装任何技能、智能体或插件」。

### 4.3 入口与文案修正（本轮实施）

- 管理中心 → 技能 → 「市场」改为打开**技能**类目；底部「去市场添加」按当前页签带上类目（技能页 → 技能，插件页 → 插件，其他 → 技能）。
- 侧栏副标题改为「记忆 · 技能 · 定时 · 插件」。
- 市场名：保留「AI 市场」为正式名（教程 tutorial-sync 截图与说明、工具卡「搜索 AI 市场」、productCapabilities 都已用它，改名会牵动教程同步门），侧栏短名「市场」保留；只把管理后台的「技能市场」、能力别名里的残留统一到「AI 市场」。
- 工具卡「应用连接」「市场插件」统一为「插件」；面向用户的文字里的「Plugin」改为「插件」。
- Agent 侧：`oc-connect` 的提示文字和 app-connectors SKILL 把「设置 → 应用连接器」改为「管理中心 → 插件」，SKILL 描述补上知乎。只改文字，不改 CLI 行为。

### 4.4 前端结构（本轮实施，行为不变）

- `lib/managedPluginProviders.ts`：浏览器插件注册表。每个 provider 一条数据（名称、扫码客户端、二维码替代文本、授权按钮文案、风控失败文案、是否支持重新扫码、setup API）。取代 ConnectorsTab 里的 if 链；新增一个浏览器插件的前端改动从 6 处减到 1 处。
- 拆分 `ConnectorsTab.tsx`：把 `ManagedBrowserSetupDialog`、`BindDialog`、`DeclarativeBindDialog` 移到 `components/settings/plugins/` 下各自的文件；ConnectorsTab 只做列表编排。现有 `ConnectorsTab.test.tsx` 的断言保持不变（只改 import 或文案相关的断言，并在提交说明里写依据）。

### 4.5 后续阶段（本轮不做，写给 operator 拍板）

这些改动涉及后端、数据库，或与商业版共享的代码，需要走两树同步，风险也更高，所以单列：

- **P2 后端插件注册表**：浏览器插件改为注册制（一个 provider 描述 setup、worker、契约），去掉 `index.ts` 里复制粘贴的接线、`/(knowledge-planet|weibo|zhihu)/setup` 写死的正则和 slug 三元表达式；worker 源码从模板字符串挪成真正的 TS 文件，接入工具链。
- **P2 合并 CLI**：`oc-plugin` 作为唯一入口，`oc-connect` 保留为兼容别名；SKILL 只教一个命令。
- **P2 清理**：飞书、GitHub、Notion 的 v1 实现确认没有存量连接后删除；`sandboxed-local` 运行时如果确定不上线，就删除死代码（约 1.9k 行）。
- **P3 生命周期**：给 `marketplace_installs` 加「启用 / 停用」（迁移）；输入框加按对话开关插件（参照 Claude 的「+」菜单 [5]、Open WebUI 的输入框开关 [26]）；详情页展示权限声明（参照 Dify `resource.permission` [17]）。
- **P2 门禁**：个人版 CI 加跑插件相关的 commercial、gateway 单测（加门不削门，需先确认基线是绿的）。

## 5. 验收

- 前后截图：市场插件页（之前 2 个 → 之后 7 个，带状态）、管理中心插件页、已安装页、技能页「市场」跳转、侧栏副标题；1440 与 390 两种宽度；没有页面报错，没有横向滚动。
- `npm run test:web-react` 全绿；新增 `pluginDirectory`、`managedPluginProviders` 单测；`check:v5:fast` 选中的门全部通过；`check-v5-fix-trailers.sh` 通过。
- Codex 审查（-s danger-full-access）：先审方案，再审代码，结果须为 APPROVED。
- 发布走个人版发布流程（搭车或亲自发），smoke 与验收按 docs/02 E 节。

## 6. 风险与回退

- 只改前端模型、文案和 CLI 提示，没有数据库迁移，也不改 API 契约。回退方法是 revert 合并提交，再发一版。
- 市场把内置插件也列成卡片：只在前端合成，不写市场表，不影响商业版。
- 运行时（SKILL 与 CLI 提示）随 runtime source release 生效；已经在运行的用户容器要等空闲回收、重建后才拿到新文字（已知行为）。

## 7. 出处


**已抓取：**
1. https://code.claude.com/docs/en/plugins-reference
2. https://code.claude.com/docs/en/plugin-marketplaces
3. https://code.claude.com/docs/en/plugins/install
4. https://claude.com/docs/plugins/overview
5. https://support.claude.com/en/articles/11176164-pre-built-web-connectors-using-remote-mcp
6. https://support.claude.com/en/articles/12512180-using-skills-in-claude
7. https://developers.openai.com/apps-sdk
8. https://developers.openai.com/api/docs/actions/introduction
9. https://developers.openai.com/plugins/build/auth
10. https://developers.openai.com/plugins/build/mcp-server
11. https://learn.chatgpt.com/docs/plugins （由 developers.openai.com/codex/plugins 重定向）
12. https://code.visualstudio.com/api/references/extension-manifest
13. https://code.visualstudio.com/docs/getstarted/extensions
14. https://code.visualstudio.com/docs/copilot/customization/mcp-servers
15. https://cursor.com/docs/context/mcp
16. https://cursor.com/docs/plugins
17. https://docs.dify.ai/en/develop-plugin/features-and-specs/plugin-types/plugin-info-by-manifest
18. https://docs.dify.ai/en/plugins/introduction
19. https://docs.dify.ai/zh/use-dify/workspace/plugins
20. https://docs.dify.ai/zh/develop-plugin/dev-guides-and-walkthroughs/tool-oauth
21. https://github.com/coze-dev/coze-studio/wiki/4.-Plugin-Configuration
22. https://github.com/coze-dev/coze-studio
23. https://geminicli.com/docs/extensions/
24. https://geminicli.com/docs/extensions/reference/
25. https://docs.openwebui.com/features/extensibility/plugin/
26. https://docs.openwebui.com/features/extensibility/plugin/tools/

**未验证（仅有搜索摘要，或官方页面无法抓取）：**
- U1. https://help.openai.com/en/articles/20001256-plugins-in-chatgpt （返回 403；“App 目录 2026-07-09 并入 Plugin 目录”和侧栏入口信息来自搜索摘要）
- U2. https://docs.dify.ai/en/develop-plugin/publishing/standards/third-party-signature-verification （签名校验内容来自搜索摘要，未抓取）
- U3. https://www.coze.cn/open/docs/guides/oauth_plugin 和 https://www.coze.com/open/docs/guides/agent_plugin （JS 渲染，抓不到正文；个人/共享授权、商店上架审核来自搜索摘要和 CSDN 教程）

另外两点：Gemini CLI 文档提到，2026-06-18 起免费层用户已迁移到 Antigravity CLI [23]。Coze 的官方 SaaS 文档无法直接抓取，结论主要依据开源版 Coze Studio 的 wiki。