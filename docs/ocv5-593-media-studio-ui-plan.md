# OCV5-593 方案：媒体工作台前端（商业版 web-react）

- 总票 OCV5-586。用户 2026-10-23 09:15 看过高保真设计稿（`design/hifi`，暗房 v1：桌面 d00–d09、手机 m01–m05，亮/暗两套）后，09:44 决定开始实现前端；商业版；PR 保持 draft；每个 PR 过 Codex（共享脚本默认模型）+ CI。
- 后端契约：A1（#1005）的 `/api/studio/*`（项目增删改查、暂停/继续/取消、上传、blob ticket + Range、聚合视图 `GET /projects/:id` = `{project, shots, lines, assets, takes, events}`）；A2-0（OCV5-591 A2-0）的 `GET /api/studio/providers`（四类能力的状态和型号）。编排器（A2-1）上线前，聚合视图里的镜头/台词/版本都是空的，前端要能优雅地显示空态。
- **只改 `packages/web-react`**，基于 `origin/feat/v5-aurora-rewrite`，不依赖后端 PR 的合入顺序：后端没有 `/api/studio` 时请求返回 404，入口自动隐藏，对现网零行为变化。

## 1. 入口与开关
- 侧栏新增一项「媒体工作台」，**只在 `GET /api/studio/providers` 返回 200 时出现**（服务端 `OC_STUDIO_ENABLED` + 白名单 uid 247 / 管理员决定，前端不另设开关）。结果缓存在会话内存中（登录身份变化时失效，沿用 `authBroadcast`）。404/401/网络错误一律视为“不可用”，不弹错。
- 路由（沿用 App.tsx 里 `/board`、`parseProjectPath` 的 pathname 写法，不引入路由库）：
  - `/studio` 首页；`/studio/p/:id` 项目（默认看板）；`/studio/p/:id/{brief|image|board|review|voice|music|final}` 各页。
  - 新增 `parseStudioPath()`（纯函数 + 单测）；`popstate` 同步；未授权或项目不存在时显示工作台内的 404 空态，不跳回聊天。
- 整个工作台是一个 lazy chunk（`components/studio/StudioApp.tsx`），首屏预算（`firstScreenBudget`）不变；预取只在侧栏入口 hover 时触发。

### 实现修订（FE-1，2026-10-23）
- **整页独立界面，而不是第四个聊天工作区**：设计稿的工作台用的是 64px 窄图标栏（d01–d08），不是聊天侧栏；把它塞进 App 的「对话 / 任务面板 / 项目主页」三工作区和 `useAppRoute` 的 popstate 状态机，改动面大、回归风险高。实际做法：`readLocationRoute` 识别 `/studio[/…]`（`studio: true`）并对其关闭聊天路由的解析和 URL 镜像；App 在 `/desktop/enroll` 分支旁提前返回 `<StudioApp>`（lazy chunk，未登录时仍先走登录页）。工作台内部用 `pushState` + `popstate` 自管路由；回到对话是整页跳转到 `/`。
- **入口**：账号菜单「媒体工作台」，App 登录后探测一次 `GET /api/studio/providers`（照「ChatGPT 直连」的门控：明确 200 才显示，默认隐藏；按身份 epoch 缓存）。
- **token 作用域**：工作台专有 token（舞台、agent 青柠、批注、轨道色）定义在 `.studio-root` / `.dark .studio-root` 上，放在随 lazy chunk 加载的 `components/studio/studio.css`，**不改全局 `styles.css`**，首屏 CSS 零增量；外壳颜色直接用主站已有 token。

## 2. 代码结构
```
src/lib/studio/
  api.ts          # 类型化客户端：projects / project view / patch(expectedRev) / pause|resume|cancel / upload / blobUrl(ticket) / providers
  types.ts        # 与后端聚合视图一一对应的 TS 类型（ProjectRow、Shot、Line、Asset、Take、StudioEvent、ProvidersView）
  path.ts         # parseStudioPath / studioHref
  format.ts       # 积分、时长、时间码（tnum）
src/hooks/
  useStudioProviders.ts   # 入口可见性 + 各能力状态
  useStudioProject.ts     # 聚合视图；项目处于 planning/running/composing 时 3 s 轮询，其余状态不轮询；页面隐藏时暂停
  useBlobUrl.ts           # 按 sha 申请 ticket，15 min 到期前自动续签；<img>/<video> 直接用 Range URL
src/components/studio/
  StudioApp.tsx  StudioHome.tsx  ProjectShell.tsx（顶部项目条 + 页签 + 右侧 agent 面板）
  Stage.tsx（深色舞台）  ShotCard.tsx  Timeline.tsx  Waveform.tsx  AgentPanel.tsx  BudgetBar.tsx
  UnconfiguredCard.tsx（能力未配置占位）  StateViews.tsx（空态 / 骨架 / 失败可恢复 / 需要你）
  pages/ Brief.tsx  ImageStudio.tsx  Board.tsx  Review.tsx  Voice.tsx  Music.tsx  Final.tsx
src/components/studio/studio.css   # 只放工作台组件样式；token 进 styles.css
```
- 复用主站组件（`./ui` 的 Button / IconButton / Sheet / Progress / useConfirm、Radix Popover/Tooltip、lucide 图标），鉴权请求统一走 `lib/api.ts` 的 `callWithRefresh` + `bearerHeaders` + `assertAuthResponseCurrent`（与 MediaTaskCenter 相同），不自造 fetch 封装。

## 3. 视觉实现（严格对照 design/hifi）
- token：在 `styles.css` 的 `:root` / `.dark` 增加 `--stage`、`--stage-2`、`--stage-fg`、`--stage-muted`、`--agent`、`--agent-ink`、`--agent-soft`、`--annot-point`、`--annot-range`、`--trk-voice`、`--trk-music`、`--trk-sub`、`--trk-sfx`，取值照 `VISUAL-DIRECTION.md §1`（舞台两种主题都是深色；`--agent-ink` 浅色主题用 `#4d7c0f`，深色用 `#c7ff64`），并在 `@theme` 里映射成 Tailwind 色名。**不改任何现有 token 的值**。
- 字体层级、4px 间距网格、圆角（控件 9 / 卡片 16 / 缩略图 12 / 舞台 20）、阴影（soft / float / stage）、舞台渐变 + vignette + 2% 颗粒、毛玻璃浮动工具条，全部照 `studio.css` 移植为 Tailwind 工具类 + 少量 `studio.css` 组件类。
- 动效全部包在 `@media (prefers-reduced-motion: no-preference)` 里：生成中青柠扫光、新版本淡入缩放、批注涟漪、agent 光环。
- 响应式：≥1200 三栏（侧栏 / 主区 / agent 面板）；768–1199 agent 面板收为右侧抽屉；<768 按 m01–m05：顶部项目条 + 横向页签（需要你 / 镜头 / 配音 / 音乐 / 成片），镜头双列卡、迷你时间线，左右 16px 边距，无横向滚动。
- 深色：外壳跟随主站 `.dark`，舞台不变；舞台与外壳之间 1px `rgba(255,255,255,.06)` 描边。

## 4. 能力状态（用户决定：缺 key 显示「未配置」不报错）
- 各页从 `useStudioProviders()` 取对应能力的状态：
  - `ready`：正常；
  - `offline`：显示「暂时不可用」提示条，允许继续排队（Muse bridge 离线时）；
  - `unconfigured` / 没有实例：显示 `UnconfiguredCard`（「音乐生成未配置——管理员配置供应商后自动开放」），**不发任何生成请求、不报错**。音乐页默认就是这个状态（用户决定：音乐只预留，不绑定供应商）。
- 方案页「自动模型安排」只列出 `ready` / `offline` 的实例和型号，不出现未配置的供应商。

## 5. 分 3 个 PR（都保持 draft）
| PR | 页面 | 只用已有接口 | 验收 |
|---|---|---|---|
| **FE-1** 外壳与首页 | 入口、路由、token、StudioApp、首页（d01/m01：一句话输入、项目卡片含状态与进度、模板胶囊、空态）、方案页骨架（d02：项目设置、预算、画幅/时长、能力状态与模型安排）、状态组件（d09）、`UnconfiguredCard` | 项目列表/新建/改/删、暂停/继续/取消、providers | 单测 + 亮/暗/手机截图对照 d01/d02/d09/m01 |
| **FE-2** 镜头与审阅 | 看板 + 多轨时间线（d04/m02）、审阅批注（d05/m03：点 / 框 / 时间段批注 UI、胶片条、版本对比）、设定·生图页（d03） | 聚合视图、blob ticket、上传（参考图） | 批注先以本地草稿保存；提交批注要等 A2-1 的 `POST /annotations`：在接口出现前按钮显示「即将开放」（feature 探测，不硬编码版本） |
| **FE-3** 配音、音乐、成片 | 配音（d06/m04：音色卡、逐句波形、时长匹配条；设计/克隆入口只做界面，提交按钮在后端开放前禁用）、音乐（d07：默认 `UnconfiguredCard`；有 ready 实例时显示候选与情绪曲线）、成片（d08/m05：舞台播放、导出参数、费用构成） | 聚合视图、blob ticket | 截图对照 d06/d07/d08/m04/m05 |

- 用户决定「设计音色、克隆音色暂不做真实调用」：FE-3 的这两个入口只到界面层，不调用任何接口。

## 6. 数据与安全
- 所有请求带登录态；blob 只通过 ticket URL 访问（后端绑定用户 + sha，15 分钟）；前端不缓存 ticket 到 localStorage。
- 用户输入（需求、批注、台词）只作为 JSON 字段发送；渲染一律走 React 文本节点，不用 `dangerouslySetInnerHTML`。
- 乐观并发：编辑项目用 `expectedRev`；409 时重新拉取并提示“已在别处更新”，不覆盖。
- localStorage 只存纯界面偏好（时间线缩放、面板折叠），读写包 try/catch。

## 7. 测试
- vitest + Testing Library：`parseStudioPath`、`format`、`useStudioProviders`（200 → 显示入口；404/401/网络错 → 隐藏且不报错）、`useStudioProject`（只在活跃状态轮询、隐藏页暂停、409 处理）、`UnconfiguredCard`（未配置时不发生成请求）、首页卡片各状态渲染。
- 截图：用现有 `browser-tests/ui-preview` 设施对 `/studio` 各页注入假数据，渲染桌面 1440×900 与手机 390×844 的亮/暗截图，和 `design/hifi-shots` 逐页并排对比，附进 PR 描述。
- CI：web-react 的 typecheck / vitest / build 全绿；web-react-browser 若仍是基线红（`INC-20260923-EMPTY-TURN-NO-REPLY`，用户决定不在本单修），在 PR 里注明与本改动无关。

## 8. 不在本票
- 编排器、批注转指令、`sys.studio_event` 推送（A2-1；在此之前用轮询）。
- 管理端供应商配置界面（运维改 `OC_STUDIO_PROVIDERS`）。
- 上线：媒体工作台的商业发布需要用户批准；本票只到 draft PR。

## 9. 给编排器（A2-1）的数据约定（FE-2a 起前端在读）
- `studio_shots.spec`：`title`（短标题，如「起跑」）、`framing`（景别）、`action`（动作描述）、`durationSec`（秒，缺省按 5 秒排时间线）、`source`（首帧来源说明，如「首帧 · GPT Image」「续接 #2」）。全部可选，前端对缺失字段有兜底。
- `studio_takes.qa.score`：0–1 的总分，镜头卡和需要你卡片显示它。
- 镜头媒体：`owner_kind = shot_video`（视频）或 `shot_frame`（首帧图）；`studio_shots.active_take_id` 指向采纳的版本，没有时前端取最新的成功版本。
- 台词：`studio_lines.shot_id` 决定它落在哪个镜头的时间段；配音版本 `owner_kind = line`。音乐版本 `owner_kind = music`。
- `studio_events.payload.message`：给人看的一句话；没有时前端按 `type` 显示通用文案。
