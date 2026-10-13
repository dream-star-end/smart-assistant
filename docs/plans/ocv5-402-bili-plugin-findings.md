# OCV5-402 FINDINGS：B 站插件（bili）个人版市场条目

> 2026-10-13 · 外机 cc3 · 范围：V5 个人版（feat/v5-selfhost @ fe489dedf）。只上 AI 市场、不预装；商业版不动。
> 用户 12:10 CST：「把 B 站插件适配到个人版……公开接口部分用 declarative-http，要处理 wbi 签名和风控；字幕、收藏、历史这些需要登录的功能，用 managed-browser 扫码登录，参考现有知乎和微博插件的做法。cookie 是敏感凭据，绝不能打印。智能 UI 组件要配齐……必须遵守按需加载规则……先写 FINDINGS，再实现，按连接器审查流程发布成带版本号的市场条目。」
> 方法：只读走读源码（文件:行号见下，路径相对 `packages/commercial/src/`，另注明的除外）；从 v5-dev（与个人版 master 同一出口 IP，马来西亚机房段）用标准库脚本直接探测 B 站公开接口，不带任何登录态。

## 一句话结论

参考插件（dream-star-end/agent-plugins@1ea1f55 `bili/`，MIT）是一个在本机跑的 Python CLI，凭据存在 `~/.bili_auth.json`。照搬到平台有三处接不上：

1. **declarative-http 目前做不了 B 站公开接口**：没有免凭据模式；没有请求签名钩子（builtin 白名单是空集合）；只认 JSON 响应（弹幕是 deflate 压缩的 XML）。从机房 IP 不签名调 `x/web-interface/view` 直接 **412**，签了 WBI 的 `x/web-interface/wbi/view` 是 **200**，所以签名不是锦上添花，详情接口没有它就不通。
2. **一个市场条目只能是一种运行时**（`plugin_type` 按 listing 固定），所以「公开接口走 declarative-http、登录功能走 managed-browser」必须是**两个条目**。
3. **市场插件条目带不了自己的 SKILL.md**，Agent 只能从动作描述和基线技能 `app-connectors` 学用法；按需加载的组件登记机制（OCV5-393）也挂在基线技能目录上。

本单的做法：给 declarative-http 补上 RFC 里预留的 **builtin 层**的最小切片（平台专用、白名单、签进契约），以此做公开条目 `bili`；登录功能照知乎做 managed-browser 条目 `bili-account`，页面内同源请求、cookie 不出 worker；智能 UI 组件按 OCV5-393 的登记表接入。

## 1. 参考插件与许可

| 项 | 内容 |
|---|---|
| 来源 | https://github.com/dream-star-end/agent-plugins `bili/`，commit 1ea1f550125c925fcab5c89f53dfd5a9ee6b7031（2026-10-12） |
| 许可 | MIT，`Copyright (c) 2026 ths-plugin contributors`（仓库根 LICENSE）；`qrcodegen.py` 为 MIT，Copyright (c) Project Nayuki |
| 文件 | `bili.py` 1078 行（stdlib only）、`SKILL.md`、`README.md`、`qrcodegen.py` 907 行 |
| 功能 | search / video / rank / popular / up / comments / subtitle / danmaku / me / fav / history；写操作 like / coin / favadd / favdel / follow / comment / commentdel / senddm |
| 本单取用 | 接口清单、WBI 算法（mixin 表）、buvid 获取方式、字段整形、实测出来的坑（评论 mode 3=热门 2=最新；view 对机房 IP 412；弹幕是 raw deflate） |
| 本单不取 | 全部写操作（用户列出的功能里没有）；本机凭据文件；qrcodegen（平台扫码由 worker 截 B 站官方二维码，不自己生成） |

署名：新文件头注明「改写自 dream-star-end/agent-plugins bili（MIT）」，仓库内新增 `packages/commercial/src/plugins/bili/THIRD_PARTY_NOTICE.md` 收录原 MIT 全文与 copyright 行；市场详情页 humanMd 写明来源与许可。

## 2. 接口探测（v5-dev，无登录态，2026-10-13 12:2x CST）

| 接口 | 不带 buvid | 带 buvid（spi） | 需要签名 | 备注 |
|---|---|---|---|---|
| `x/web-interface/nav`（取 WBI 密钥） | 200，code -101（未登录，但 `wbi_img` 照给） | — | 否 | |
| `x/frontend/finger/spi`（取 buvid3/4） | 200 | — | 否 | |
| `x/web-interface/view?bvid=` | **412** | **412** | — | 机房 IP 风控 |
| `x/web-interface/wbi/view`（签名） | — | **200 code 0**，5.5KB | **是** | 详情只能走这个 |
| `x/web-interface/view/detail` | — | 412 | — | |
| `x/web-interface/wbi/search/type` | 200 | 200，约 29KB | 现在不签也过，按官方前端签 | |
| `x/web-interface/ranking/v2?rid=&type=all` | 200 | 200，**160–177KB** | 否 | 原始体大，需投影 |
| `x/web-interface/popular` | 200 | 200 | 否 | |
| `x/v2/reply/wbi/main`（签名） / `x/v2/reply/main` | — | 200 / 200 | 用签名版 | |
| `x/v1/dm/list.so?oid=<cid>` | — | 200 `text/xml`，raw deflate | 否 | **非 JSON** |
| `x/player/v2`（字幕列表） | — | 200（未登录时字幕列表通常为空） | 否 | 字幕要登录 |
| 视频页 HTML `__INITIAL_STATE__` | 200 | | | 参考插件的主通道；declarative 不解析 HTML，不采用 |

结论：所有公开功能都在 **同一个 origin `https://api.bilibili.com`**，正好满足 declarative 执行器「恰好一个 API origin」的限制（`connectors/engine/execute.ts:73-78`）。

## 3. declarative-http 现状与缺口

| # | 缺口 | 证据 | 对 bili 的影响 |
|---|---|---|---|
| D1 | 没有免凭据模式：`AuthMode` 七种都要凭据；执行引擎只解析 static-token / oauth2 / token-exchange；市场自助发布还强制 identity probe | `spec/types.ts:187-195`、`engine/tokenEngine.ts:135-172`、`marketplace/publishConnectorPipeline.ts:98-99,110-126`、`engine/bind.ts:181-185` | 公开接口没法绑定，也就没法调用（RPC 按连接行调度，`connectors/rpc.ts:893-915`） |
| D2 | 没有请求签名：`requestTransform / operation / resultTransform` schema 收、但 `BUILTIN_ALLOWLIST = new Set()`，任何引用编译期 `BUILTIN_NOT_ALLOWED`；编译结果 `ExecAction` 也不带这些字段 | `spec/compiler.ts:52-58,646-650,676-683` | 算不了 `wts` + `w_rid`，详情 412 |
| D3 | 不能串联请求（先 nav 取密钥 / 先 spi 取 buvid） | 只有 token-exchange 一种链，产物是凭据槽 | 同上 |
| D4 | 只收 JSON：非 2xx 不读体；2xx 体 ≤4MB 且必须 `JSON.parse` 成功 | `engine/driver.ts:234-248`、`connectors/providers/shared.ts:144-245` | 弹幕 XML 不可用 |
| D5 | 结果按 result schema 投影，≤256KB、深度 ≤8、数组 ≤200 | `engine/driver.ts:73-105` | 排行原始体 177KB 没问题，投影后很小；深度够用（`data.list[].owner.name` 为 4 层） |
| D6 | 固定请求头：只保留 Authorization / Host / Content-Type，`staticHeaders` 可写 UA、Referer | `spec/compiler.ts:261-275`、`engine/requestPlan.ts:242-250` | UA / Referer 能写死；buvid Cookie 不能写死（所有用户共用一个值，而且无法刷新） |
| D7 | 编译器注释：「slice① 无内置 builtin 注册表……白名单随 builtin 层（切片②）落地时收口」 | `spec/compiler.ts:52-57` | 本单就是这个切片②的最小实现 |

### 3.1 本单的扩展（最小、平台专用）

1. **`authMode: 'none'`**：无 placement、无 bind 字段、identity 可省；`bindDeclarativeConnector` 收空袋，落一行连接（`account_hint` 固定为「公开接口」），复用现有的连接行、停用开关、并发闸、审计。安装后在「管理中心 → 插件」点一次「启用」即绑定（与现有声明式插件同一个弹层，只是没有输入框）。
2. **builtin 注册表**（`connectors/builtins/`，代码实现、白名单登记、签进契约）：
   - `bilibili-wbi`（requestTransform）：经同一个 pinned fetch 取 nav 的 `wbi_img` 和 spi 的 buvid3/4，**按契约缓存**在 master 进程内（TTL：WBI 密钥 6 小时、buvid 24 小时，失败退避），给请求追加 `wts`、`w_rid`，并把 `buvid3/buvid4` 放进 Cookie 头。缓存的是**平台匿名指纹**，不是任何用户凭据；不进日志、不进结果。
   - `bilibili-dm-xml`（resultTransform）：仅对声明了它的动作放开「非 JSON 体」——raw deflate / gzip 解压（解压后 ≤4MB 上限）、只认 `<d p="…">文本</d>` 的正则解析（不引 XML 解析器、不解实体以外的任何东西），输出 `{cid, total, items:[{t, text, sentAt}]}`，再走正常的 result 投影。
   - 编译：`ExecAction` 带上 `requestTransform/resultTransform`，`COMPILER_VERSION` 1→2（契约哈希随之变化；已签的旧契约照旧按 v1 校验，不受影响——实现时用测试钉住）。
   - **只有平台能用**：自助发布（网页 / `oc-market`）遇到任何 builtin 一律拒（新增错误码 `BUILTIN_PLATFORM_ONLY`），AI 审查提示写明 builtin 的语义；只有官方 seed 走的路径可以带。
3. **风控处理**：固定桌面 UA + `Referer: https://www.bilibili.com/`；`-352/-412/-799`、HTTP 412 统一映射为 `UPSTREAM_RISK_CONTROL`（中文提示「B 站风控拦截，稍后再试」），并让 `bilibili-wbi` 作废缓存的 buvid/密钥后**最多重试一次**；保留现有每连接并发 2 的闸，不加重试风暴。

### 3.2 公开条目 `bili` 的动作（全部只读）

| 动作 | 接口 | 关键参数 | 产出 |
|---|---|---|---|
| `search` | `wbi/search/type`（search_type=video） | keyword, order(totalrank/click/pubdate/dm/stow), page | bvid、标题（去 `<em>`：在结果投影后由前端/Agent 处理，见 §6.3）、UP、播放、弹幕、时长、发布时间、封面 |
| `video` | `wbi/view` | bvid 或 aid | 标题、UP、七项统计、分 P（cid）、简介、发布时间、封面 |
| `rank` | `ranking/v2` | rid（0=全站） | 排行列表 |
| `popular` | `popular` | ps, pn | 热门列表 |
| `comments` | `v2/reply/wbi/main` | oid(aid), mode(3 热门 / 2 最新), next | 评论（用户、点赞、回复数、正文、时间） |
| `danmaku` | `v1/dm/list.so` | cid | 弹幕（时间轴、正文、发送时间） |

`up`（UP 主卡片）不在用户列出的功能里，本单不做。动作描述里写全参数（`oc-plugin list` 不显示参数 schema，`packages/gateway/src/ocConnectCli.ts:234-268`），并写明「评论要 aid、弹幕要 cid，先调 video」。

## 4. managed-browser 现状（知乎）与 `bili-account`

| 项 | 知乎的做法 | 证据 | bili-account |
|---|---|---|---|
| 条目 | 只上市场；运行时要求 `marketplace_installs` 精确行 | `plugins/accounts.ts:442-467` | 同 |
| 契约 | `managed-browser` v1：driver{id,version}（id 由 worker 源码 sha 推出）、`accountState.cookieDomains/origins`、`network.origins/methods`、≤32 个动作 | `plugins/contracts.ts:585-728`、`plugins/zhihuContract.ts:10-15,242-709` | `cookieDomains: ['.bilibili.com']`；origins：www / api / passport / `aisubtitle.hdslb.com`（字幕文件）；只有 GET |
| 扫码 | worker 容器里无头 Chromium 打开官方登录页，截二维码 PNG（8 秒刷新），PNG 只在 master 内存、4 分钟 TTL | `plugins/zhihuWorkerSource.ts` ~1925-1965、`plugins/zhihuSetup.ts:31,84-98` | 同：截 `passport.bilibili.com/login` 的官方二维码 |
| cookie 存储 | 只取契约 cookie 域、≤256KB，KMS AEAD 加密（AD 绑 uid+slug）存连接表 | `plugins/accounts.ts:21,320-353` | 同；**不打印、不进日志、不进动作结果** |
| 隔离 | 每次调用一个容器，`NetworkMode:none`、只读根、drop all caps，出网只经 Unix socket 上的 TLS CONNECT broker 且限 IP pin；页内路由只放行契约 origin/method；容器 `LogConfig:none` | `plugins/zhihu.ts:448-460,556-650`、`plugins/browserBroker.ts:1-20`、`plugins/zhihuWriteObservability.ts:97-186` | 同 |
| 取数方式 | **只读页面，不回放 API 响应** | `plugins/zhihuWorkerSource.ts:1-5` | **偏离点**，见下 |
| 每 provider 写死的地方 | `http/plugins.ts:36,41-64,191,224,232-247`（路由正则）、`http/handlers.ts:116,141-142`、`plugins/runtime.ts:32-46,277,1370-1393,1461-1468,1627-1629`、`plugins/writePolicy.ts:40-66`、`plugins/pluginErrorGuidance.ts:9,41,72-75`、`connectors/service.ts:255-306`、`marketplace/marketplaceDb.ts:39-43,589`；前端 `web-react/src/lib/managedPluginProviders.ts`、`lib/api.ts:4355-4380`、`lib/connectors.ts:481+`、`components/settings/plugins/RuntimePluginCard.tsx:68` | 本单逐处加 bili-account，不顺手重构（OCV5-379 P2 的注册制留给它自己的单） |
| 发布 | `publishOfficial…Version`（humanMd，rawSkillMd=null）→ `approveOfficialRuntimePluginVersion` → `transitionOfficialManagedBrowserPluginVersion`；要先用真实账号 `--verify-and-seed-user=<uid>` 做活体验证 | `marketplace/seedZhihuPlugin.ts:115-116,166-184,305-426` | 同；**活体验证需要真实扫码 → 按用户要求先停下汇报** |

**偏离点（需要拍板，推荐 A）**：B 站的收藏夹、历史、字幕都是前端 JS 调 JSON 接口渲染的，页面 DOM 里没有稳定结构（字幕甚至只在播放器里逐句出现）。

- **A（推荐）**：worker 打开 `https://www.bilibili.com/` 后，在页面上下文里用 `fetch(…, {credentials:'include'})` 调契约允许的 `api.bilibili.com` 只读接口（`x/web-interface/nav`、`x/v3/fav/folder/created/list-all`、`x/v3/fav/resource/list`、`x/web-interface/history/cursor`、`x/player/v2`，以及字幕文件 `aisubtitle.hdslb.com`），只把整形后的字段回传。cookie 始终留在浏览器里，比从页面「抠 cookie 再在 master 发请求」更安全；仍受页内路由（origin+GET）和 broker IP pin 约束。
- B：照知乎只抓 DOM：收藏夹 / 历史页能抓到标题和链接，字幕基本拿不到。

## 5. Agent 怎么知道用法；智能 UI 组件（按需加载）

- 市场插件条目带不了 SKILL.md（`packages/storage/src/marketplaceSync.ts` 只同步带 `raw_skill_md` 的技能条目，`marketplace/marketplaceDb.ts:3134-3184`）；现有浏览器插件的说明都在基线技能 `ccb-baseline/skills/app-connectors/SKILL.md`。
- 本单：
  - 动作描述写全参数和先后顺序（Agent 不加载任何技能也能用）；
  - `app-connectors/SKILL.md` 只加**一段几行的指引**（「B 站：需先从 AI 市场安装；公开数据用 bili，字幕/收藏/历史用 bili-account；要展示结果时先读 references/ui-bili.md」）。插件本身不预装：没安装时 `oc-plugin list` 里没有它，调用会被安装权限拒绝。
  - **组件**（OCV5-393 机制，author=model）：登记 `PLUGIN_UI_COMPONENTS` 一条 `{plugin:'bili', skill:'app-connectors', doc:'references/ui-bili.md', types:[…]}`；定义文件 `references/ui-bili.md` ≤2.5KB，只在 Agent 要展示 B 站结果时读；前端在 `web-react/src/components/iui/` 加类型：
    - `bili_videos`：视频卡片列表（封面、标题、UP、播放/弹幕/时长、发布时间、链接），用于搜索、热门、收藏夹、历史；
    - `bili_rank`：排行（名次、前三高亮、播放、综合分），超过 10 条折叠；
    - `bili_video`：单个视频详情卡（七项统计、分 P、简介折叠）；
    - `bili_comments`：评论（用户、点赞、回复数、正文折叠）；
    - `bili_danmaku`：弹幕时间轴（按分钟分桶的密度条 + 列表）；
    - `bili_subtitle`：字幕（时间码 + 文本，长文折叠，可复制全文）。
    每种都有 Markdown 版本（复制、导出、组件关闭、渲染失败）；封面图走现有图片代理/`referrerpolicy=no-referrer`（B 站图床校验 Referer），链接只接受 http(s)。守卫测试 `pluginUiOnDemand.test.ts` 自动覆盖：默认上下文不出现这些类型、定义文件存在且覆盖每个类型、SKILL.md 不内联定义。
- **依赖**：OCV5-393（另一会话，`workspace/ocv5-393-selfhost`）尚未推送。本单先做后端与两个条目；组件部分在 393 合入后 rebase 上去再写，不碰它的 worktree（已发消息给该会话协调）。

## 6. 风险与约束

1. **共享代码**：`packages/commercial` 两棵树都有。本单只改个人版分支；商业版不同步（如以后要同步，走 ocv5-two-tree-sync）。
2. **COMPILER_VERSION bump**：已有声明式连接（notion / feishu / github 的 platform seed）契约哈希不变；只有新编译的契约用 v2。要用测试证明旧契约加载、执行不受影响。
3. **B 站侧变化**：WBI mixin 表、风控策略会变。缓存失效 + 一次重试 + 明确报错；不做无限重试。所有探测与验证都是低频人工触发。
4. **个人版 CI 不跑 commercial 单测**（`v5-selfhost-gates.yml`、`v5-selfhost-web-react.yml`）：本单在 worktree 里本地跑相关 commercial / gateway / web-react 测试并留日志，不把「CI 没跑」当通过。
5. **个人版部署脚本不 seed 插件**（`scripts/deploy-v5-selfhost.sh` 没有 zhihu/weibo hook）：市场条目由 `packages/commercial/scripts/seed-bili-plugin.ts` 在发布后人工执行，版本号 `1.0.0`，走 `prepareConnectorPublish` 静态扫描 + 权限摘要 + AI 审查（declarative-ai）+ 官方审批，结果写进交接文件。
6. **cookie / 凭据**：测试与日志只打印 cookie 名、长度和 sha256 前 8 位；日志统一过脱敏；不跑 `env`。

## 7. 验收

- 单测：builtin（WBI 签名用参考算法的固定向量、缓存与失效、风控映射、dm-xml 解析与解压上限）、编译器（白名单、平台专用拒绝、v1 契约兼容）、`authMode none` 绑定、bili / bili-account 契约编译、seed、前端组件（含 Markdown 降级）与守卫。
- 实测（cc2 登录、Haiku，uid 3）：安装 `bili` → 搜索 / 详情 / 排行 / 评论 / 弹幕各一轮真实回合，组件渲染截图（1440 与 390 宽）；对比加载前后 token。
- `bili-account`：代码、契约、单测、二维码页面渲染到「等待扫码」为止；**真实扫码与活体 seed 需要用户本人扫码，到这一步先停下汇报**。
- Codex 审查（`scripts/codex-review.sh`）APPROVED；`check-v5-fix-trailers.sh` 通过；按 `docs/02` 走个人版发布，发布前后截图。
