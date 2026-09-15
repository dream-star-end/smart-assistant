# A·media 图片 / 媒体 / 容器网页预览 · 审计报告

- 分支：`feat/v5-selfhost-audit-media`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`）
- 阶段：A（审计，未改任何业务代码）
- 结论：**P1 × 2 / P2 × 11 / P3 × 14**，共 27 条。两条 P1 都在图片查看器的子模式里：
  「调整大小」在 data:/缓存命中的图片上永远画不出图；「评论」模式在输入框里按 Esc 会把整个
  评论模式连同已落的全部锚点一起丢掉。

---

## 1. 范围与文件清单

本轮覆盖 `packages/web-react` 的媒体面：聊天里点开一张图之后的全部界面（查看 / 圈选编辑 /
数字锚点评论 / 五比例调整大小）、右侧「视频任务」抽屉、以及容器内网页的实时预览与按元素评论。

| 类别 | 文件 | 行数 |
|---|---|---|
| 全屏图片查看器 | `src/components/ImageViewer.tsx` | 618 |
| 圈选编辑器 | `src/components/ImageAnnotationEditor.tsx` | 989 |
| 评论模式 | `src/components/ImageCommentMode.tsx` | 299 |
| 调整大小模式 | `src/components/ImageResizeMode.tsx` | 236 |
| 视频任务中心 | `src/components/MediaTaskCenter.tsx` | 497 |
| 容器网页预览 | `src/components/ContainerWebPreview.tsx` | 1561 |
| 预览会话 hook | `src/hooks/useContainerPreview.ts` | 492 |
| 预览提示词/链接工具 | `src/lib/containerPreview.ts` | 74 |

对应的 `*.test.ts(x)`（8 个）随源文件归属，本轮只读不改。

审计维度按 PLAYBOOK §5 的七项清单逐项过：UI/视觉、响应式/移动端、交互友好性、功能正确性、
可访问性、文案、代码质量。

**只读参照、不在本轮改动范围**：`lib/chat/{media,fetchImageProgressive,imageBytes,useProgressiveImage}`
（messages owner，媒体取字节管线，本文只引用其行为）；`components/ui/{Sheet,Modal}`
与 `styles.css` 的 `.preview-*` 规则（shell owner，涉及处已单列「需 shell owner 配合」）；
`@openclaude/protocol/containerPreview`（协议，不动）。

---

## 2. 方法与证据

### 2.1 ui-preview 场景

新增 `browser-tests/ui-preview/scenes-media.tsx`，11 个场景。这些界面在真机上都藏在
「点开一张图 / 有一条视频任务 / 容器里跑着网页」之后，静态页上才能一次性凑齐
desktop/mobile × light/dark：

| 场景 id | 内容 | 视口 |
|---|---|---|
| `media-image-viewer` | 全屏查看器（可编辑：编辑/评论/调整大小三动作可用） | desktop / mobile |
| `media-image-viewer-disabled` | 全屏查看器（当前模型不支持编辑：三动作禁用） | desktop / mobile |
| `media-image-comment` | 评论模式初始态（黑底舞台 + 顶栏 X / N 条评论 / 发送） | desktop / mobile |
| `media-image-resize` | 调整大小（五比例菜单） | desktop / mobile |
| `media-image-resize-unavailable` | 调整大小（当前模型不支持） | mobile |
| `media-annotation-editor` | 圈选编辑器（笔刷滑杆 + 画布 + 提示词条 + 底栏工具） | desktop / mobile |
| `media-task-center` | 视频任务中心：长视频项目（3 分镜，含依赖已变）+ 单段任务（生成中/排队/已完成/失败）+ 算力失联横幅 | desktop / mobile |
| `media-task-center-empty` | 视频任务中心空态 | desktop / mobile |
| `media-task-center-unavailable` | 视频任务中心「本账号未开放」 | desktop |
| `media-container-preview-loading` | 容器网页预览 · 授权中 / 首次启动 | desktop / mobile |
| `media-container-preview-error` | 容器网页预览 · 连接失败 + 诊断详情 | desktop / mobile |

桩数据全部就地写死，未新增 `api-stub.ts` 条目（manifest 的 `unmockedApi` 为空）。两处
网络边界在场景内接管：`MediaTaskCenter` 不走 `lib/api` 而是自己 `fetch('/api/media-generation/*')`，
场景按路由接管 `window.fetch`；圈选编辑器取原图走 `fetch(source.url)`，场景对样图 URL 就地合成
一个带 `content-type/content-length` 的 `Response`（首轮借 about:blank iframe 的 fetch 偶发拿到
空 blob，把编辑器截成了「图片解码失败」，已改为确定性实现）。

**覆盖不到的态**（真机才有）：`ContainerWebPreview` 的 ready 态、评论模式、评论抽屉、文字输入条
——需要真实容器 WebSocket 帧；`ImageViewer` 的下载/分享流程。这些只经代码审阅 + jsdom 探针。

### 2.2 截图基线

```
D:\code\test_project\test123\.audit-tmp\media\before\
```

40 张 PNG（11 场景 × 视口 × light/dark），外加 `manifest.json`（`failures: []`、`retried: []`、
`unmockedApi: []`）。复跑命令：

```powershell
cd d:\code\test_project\test123\wt\media\packages\web-react
$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:OC_UI_SHOTS='D:\code\test_project\test123\.audit-tmp\media\before'
$env:OC_UI_SCENES='media-'
node browser-tests\ui-preview\shoot.mjs
```

直接充当证据的几张：

- `media-image-resize--{desktop,mobile}--{light,dark}.png` —— 四张全部只有一块深色骨架，
  **没有图**；把 `OC_UI_SHOT_DELAY` 拉到 2500ms 复拍（`..\probe2\`）仍然如此，不是截图太早（M-01）。
- `media-annotation-editor--mobile--light.png` —— 笔刷滑杆压在画布左缘 44px 宽的一条上，
  遮住图片且挡住该区域的圈选（M-11）。
- `media-task-center--desktop--light.png` —— 「已完成 · done」「生成中 · denoise_step」
  「排队中 · wait_gpu」「rev 4」、失败任务的 `CUDA out of memory while allocating 2.1 GiB (worker gpu-h3-02)`
  原样进 UI（M-05）；抽屉顶栏只有「刷新」，没有关闭（M-04）。
- `media-task-center-unavailable--desktop--light.png` —— 「本账号暂未开放」卡片下面悬着一个
  空的「单段视频」标题（M-17）。
- `media-image-viewer-disabled--mobile--light.png` —— 三动作 40% 透明度，触屏下点它没有任何反馈
  （`title` 在触屏不显示）（M-13）。
- `media-container-preview-error--mobile--light.png` —— 「诊断详情」是 11px 的灰字 summary（M-19）。

### 2.3 jsdom 探针（一次性，已删除，不提交）

两条关键结论用 vitest + jsdom 复现（`npx vitest run … --maxWorkers=1`，2/2 通过，结果落盘
`..\.audit-tmp\media\probe-result-2.jsonl`）：

```
{"tag":"V-01","stillInCommentMode":false,"anchor1Kept":false,"viewActionsBack":true}
{"tag":"A-02","sameNode":false,"focusKept":false,"active":"BODY"}
```

- **V-01**：在查看器里进入评论模式 → 落 1 个锚点并确认（顶栏「1 条评论」）→ 再点图开第二条
  草稿 → 在输入框里按 `Escape`。结果：已不在评论模式（`stillInCommentMode=false`），锚点 1
  已丢（`anchor1Kept=false`），底部「编辑/评论/调整大小」动作条回来了（`viewActionsBack=true`）。
  即 Esc 没有取消当前草稿，而是把整个评论模式掐掉了（M-02）。上一手 opus-5-1 的探针
  （`..\.audit-tmp\media-probe-result.json`）结论相同。
- **A-02**：圈选编辑器里聚焦「放大画布」再点击一次。点击后按钮 DOM 节点被换掉
  （`sameNode=false`），焦点落回 `<body>`（`focusKept=false`）——底栏按钮组件定义在渲染函数
  内部，每次重渲都会重挂载（M-12）。

机制核对：`@radix-ui/react-dismissable-layer` 把 Esc 监听挂在 `document` 的**捕获**阶段
（`addEventListener("keydown", …, { capture: true })`），所以 `ImageViewer` 的 `onEscapeKeyDown`
永远先于 `ImageCommentMode` 输入框自己的 `onKeyDown` 触发。

### 2.4 浏览器核对

Chromium（Cursor 内置浏览器）里直接验证 `fetch('data:image/svg+xml;utf8,…')` → `content-type`
为 `image/svg+xml`、blob 可被 `<img>` 解码（`ok 1200x800`）——排除了「SVG data: URL 本身不能
用」这一解释，M-01 的成因落在组件自己的状态时序上（见 §3）。

### 2.5 跑过的验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿（见 §2.6） |
| 场景文件类型检查 | 临时 tsconfig（仓外 `..\.audit-tmp\media\tsconfig.preview.json`，extends 包内 tsconfig + `types:["node"]`）`npx tsc -p …` | ✅ 0 错 |
| 代码风格 | `npx biome check browser-tests/ui-preview/scenes-media.tsx` | ✅ 绿（修掉 1 处 `noUselessTernary`；文件行尾由 CRLF 规范为 LF） |
| 视觉基线 | `node browser-tests/ui-preview/shoot.mjs`（`OC_UI_SCENES=media-`） | ✅ 40 张全部成功，0 失败 0 重试 |
| 复拍取证 | 同上，`OC_UI_SCENES=media-image-resize,media-annotation-editor`，`OC_UI_SHOT_DELAY=2500` → `..\probe2\` | ✅ 10 张；resize 仍无图 |
| jsdom 探针 | `npx vitest run src/components/zz-audit-probe.test.tsx --maxWorkers=1`（已删） | ✅ 2/2，结论见 §2.3 |

**未跑**（`NOT RUN`）：

- `npm test`（全量 web-react 单测）—— 阶段 A 未改任何业务代码与既有测试；阶段 B 必跑。
- `npm run test:browser` —— 同上，且本轮未触碰 Composer/消息/工具卡/侧栏交互面。
- 真容器预览 ready 态 —— 本机没有可运行的 v5 后端与容器，`ContainerWebPreview` 的交互/评论/
  触屏滚动/键盘转发结论只经代码审阅 + 既有 `ContainerWebPreview.test.tsx` 的行为契约。
- 真机 iOS Safari —— safe-area / visualViewport / 触控结论只经 Chromium 移动模拟。

### 2.6 阶段 A 提交

- `docs/audit/media.md`（本文）+ `browser-tests/ui-preview/scenes-media.tsx`，commit SHA 见
  `complete_task` 的 deliverable。typecheck 在提交前跑绿。

---

## 3. 问题清单

严重度：**P1** 功能不可用/数据错误/阻断主流程；**P2** 明显体验缺陷/一致性破坏/移动端不可用；
**P3** 打磨项。位置均在 `packages/web-react/src/` 下。

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| M-01 | `components/ImageResizeMode.tsx:89` + `:192-202` | `useEffect(() => setImgReady(false), [displaySrc])` 在挂载后的 passive effect 里跑；`<img onLoad>` 对 data: / blob: / 已进 HTTP 缓存的签名 URL 会**先于**这个 effect 触发 → `setImgReady(true)` 随即被 effect 覆写回 `false`，之后再无 load 事件 | 「调整大小」页面只剩一块深色骨架（有缩略缓存时是一张 40% 透明的模糊底图），**图永远不出来**。base64 媒体（模型直出的图）走 `data:` 必现；查看器刚把原图 fetch 进缓存再点「调整大小」也大概率命中。五个比例按钮仍可点、提交仍成功，但用户看不见自己在调哪张图。见 `media-image-resize--*.png`（4/4 无图，2500ms 复拍同） | **P1** |
| M-02 | `components/ImageViewer.tsx:452-462` + `components/ImageCommentMode.tsx:285-292` | Radix 在 `document` 捕获阶段派发 Esc；查看器的 `onEscapeKeyDown` 见 `mode==='comment'` 就 `setMode('view')`，评论模式输入框自己的 `Escape → cancelInput()` 永远轮不到 | 用户落了 N 个锚点、正在写第 N+1 条时按 Esc（最自然的「取消这条」）→ **整个评论模式退出，N 个锚点全部丢失，无确认**。探针 V-01 复现 | **P1** |
| M-03 | `components/ImageCommentMode.tsx:162-169`（X → `onBack`）、`components/ImageViewer.tsx:457-460`（Esc） | 评论模式有未发送锚点时，点 X 或按 Esc 直接返回浏览态，不问一句；而同一查看器里的圈选编辑器有完整的「放弃当前编辑？」确认层（`ImageAnnotationEditor.tsx:991-1020`） | 同一入口的两个子模式对「未保存工作」态度相反；评论是多锚点累积后一次发送的流程，误触 X 的代价最高却零保护 | P2 |
| M-04 | `components/MediaTaskCenter.tsx:269-275` + `components/ui/Sheet.tsx`（原语本身不带关闭钮） | 「视频任务」右侧抽屉没有任何关闭按钮，顶栏只有「刷新」；关闭只能 Esc 或点遮罩 | 移动端遮罩只剩 `100vw - 94vw ≈ 23px` 的一条，且没有键盘 → **小屏几乎关不掉**（PLAYBOOK §5.2「抽屉/弹层在小屏的可关闭性」）。见 `media-task-center--mobile-*.png` | P2 |
| M-05 | `components/MediaTaskCenter.tsx:85`、`:333`、`:474-475`、`:56-57` | `{STATUS[job.status]} · {job.phase}` 把协议枚举 `denoise_step / wait_gpu / sampling / upload / done` 原样展示；项目行「rev 4」；失败任务直接渲染服务端 `errorMessage`（英文 CUDA OOM + worker 主机名）；`apiCall` 抛 `HTTP ${status}` 原样进错误横幅 | 开发者术语与内部主机名泄漏给最终用户，看不懂也无法行动（PLAYBOOK §5.6）。见 `media-task-center--desktop--light.png` | P2 |
| M-06 | `components/MediaTaskCenter.tsx:376-390`（重做）、`:422-437`（取消项目）、`:477-487`（取消任务） | 三个不可逆/花钱的动作都是单击即发：取消整个多分镜项目、取消生成中的任务、重新生成一镜（重新占 GPU） | 无确认、无撤销；卡片上「重做」与「保留旧结果」并排，手滑代价高 | P2 |
| M-07 | `components/ContainerWebPreview.tsx:719-738`（Esc）、`:770-779`（X）、`:660-672`、`:1005-1011`（canvas 键盘转发） | 操作模式下焦点在画布上，Esc 一边被 `keyboardShortcut` 转发给容器内网页，一边被 Radix 当成关闭整个预览；X 与 Esc 关闭时不看 `annotations.length` | 用户在被预览的网页里按 Esc 关个下拉 → **整个预览关掉**；已写好的 N 条元素评论全部丢失、无确认（评论只存在组件 state 里，重开即空） | P2 |
| M-08 | `components/ContainerWebPreview.tsx:1005-1011` + `:1609-1618` | canvas 聚焦后所有键（含 `Tab` / `Shift+Tab`）都 `preventDefault` 并转发给远端页面 | 键盘用户一旦进入画布就出不来：Tab 不能到达关闭/设备切换/工具坞，唯一能离开的键是 Esc——而 Esc = 关闭整个预览（M-07）。事实上的焦点陷阱（PLAYBOOK §5.5） | P2 |
| M-09 | `components/ContainerWebPreview.tsx:496-519` | 触屏手势只在 `pointerup` 时把总位移换算成一条 `preview.wheel`（`-dx*2, -dy*2`） | 手指滑动过程中画面不动，抬手后**一次性跳滚**；没有惯性、没有双指缩放。移动端浏览被预览网页基本不可用（PLAYBOOK §5.2） | P2 |
| M-10 | `components/ContainerWebPreview.tsx:94-117`、`:132-134`、`:178-188`、`:993-996` | 远端视口尺寸只在挂载时 `readAccessProfile()` 测一次；全屏态 canvas 用 `size-full object-fill` 铺满 | 手机旋转、iOS 地址栏/键盘收放、桌面改窗口后，canvas 容器比例变了但远端帧比例没变 → **画面被非等比拉伸**；不重连不会恢复 | P2 |
| M-11 | `components/ImageAnnotationEditor.tsx:864-866` + `:867-878` | 笔刷滑杆 `absolute left-2 top-1/2`（44×192px）叠在画布区之上，画布 `max-w-full` 不为它让位 | 390px 下图片几乎满宽，滑杆压在图片左缘：遮住内容，且该 44px 竖条内的 pointerdown 被滑杆吃掉、**无法圈选**。见 `media-annotation-editor--mobile--light.png` | P2 |
| M-12 | `components/ImageAnnotationEditor.tsx:701-739` | `ToolButton` / `RoundBtn` 两个子组件定义在 `ImageAnnotationEditor` 函数体内，每次渲染都是新的组件类型 | 任何一次 setState（撤销、缩放、画一笔）都让底栏按钮**整段卸载重挂**：焦点掉回 `<body>`（探针 A-02），键盘/读屏用户每按一下都要重新找位置；hover/active 过渡也被打断 | P2 |
| M-13 | `components/ImageViewer.tsx:154-168`、`:592-613` | 三动作禁用态用原生 `disabled` + `title={reason}`；「评论」的禁用理由复用「当前模型不支持图片编辑」 | 触屏没有 `title`，点禁用按钮**零反馈**；而同产品内的圈选编辑器已经用 `aria-disabled + 提示文案` 解决了同一问题（`ImageAnnotationEditor.tsx:782-797`），调整大小页也有内联提示（`ImageResizeMode.tsx:214-216`）。评论按钮的理由文案还说错了功能 | P2 |
| M-14 | `components/ImageViewer.tsx:522-560` | 「更多」是手写浮层：无 `role="menu"`/`menuitem`、无方向键、打开后焦点不进菜单、点外关闭靠一个 `aria-hidden tabIndex=-1` 的全屏 `<button>` | 键盘/读屏拿不到菜单语义；仓内已有 `components/ui/DropdownMenu` 原语却没用 | P3 |
| M-15 | `components/ImageCommentMode.tsx:166`、`:239`、`:251`、`:274`、`:301`；`components/ImageResizeMode.tsx:151` | 子模式顶栏 X 是 `size-10`（40px）且没有查看器顶栏那条 `[@media(hover:none)]:size-11`；锚点圆点 `size-7`（28px）即命中区；输入条的删除/确认 `size-9`（36px） | 触屏命中区低于 44px 标准（PLAYBOOK §5.2）；锚点是评论模式最常点的对象，28px 直接影响「点锚点改文案」的成功率。对照：`ContainerWebPreview` 的锚点用 44px 隐形命中区包 28px 圆点（`styles.css` `.preview-anchor-hit`） | P3 |
| M-16 | `components/MediaTaskCenter.tsx:183-184`、`:246-250`、`:286-294`、`:252-266` | 有活跃任务时每 5s `refresh('first')`，走的是同一个全局 `loading` → 「刷新」按钮每 5 秒禁用+转一圈，「加载更早」按钮同步抖动；`mutate` 没有 busy 态，按钮可重复点击 | 视觉噪音；双击「取消项目」发两次请求，第二次会以 `expectedRev` 不匹配失败并弹红色横幅 | P3 |
| M-17 | `components/MediaTaskCenter.tsx:461-462`、`:474-476`、`:491-498` | 「单段视频」`<h3>` 无条件渲染：账号未开放、只有项目没有单段任务时都悬着一个空标题；失败任务只给错误文本，没有「重试」入口 | 空标题见 `media-task-center-unavailable--desktop--light.png`；错误态不可恢复（PLAYBOOK §5.3） | P3 |
| M-18 | `components/MediaTaskCenter.tsx:96-101`、`:297-311`、`:283`、`:347`、`:468` | 进度条是裸 `<div>`（无 `role="progressbar"`/`aria-valuenow`）；错误/告警横幅无 `role`；`text-[12.5px]` / `text-[12px]` / `text-[13px]` 任意值字号不走语义档位 | 读屏读不到进度与告警；字号漂移（shell 审计 S-15/S-18 同类） | P3 |
| M-19 | `components/ContainerWebPreview.tsx:716`、`:1070-1078`、`:1311-1333`；`hooks/useContainerPreview.ts:203-206` | `phase==='closed' && !error`（服务端正常断开/容器停了）与「从未连上」共用一套文案「运行环境可能仍在启动…」；「诊断详情」是 11px `--preview-faint` 的 `<summary>`，命中高 32px；断开后不自动重连 | 中途断线的用户被引导去「确认网页已运行」而不是重连；小字低对比小靶（PLAYBOOK §5.1/5.2） | P3 |
| M-20 | `components/ContainerWebPreview.tsx:889-899`、`:924-931` + `:1051-1068` | <430px 下「加入输入框」缩成「完成」；加载期状态胶囊与画布中央加载态同时显示同一个 `PHASE_LABEL` | 「完成」暗示流程结束，实际动作是把提示词填进输入框且不发送；同屏两处同文案属冗余 | P3 |
| M-21 | `components/ContainerWebPreview.tsx:1441-1449`、`:506-508`、`:1263-1265` | 评论编辑器 textarea 没有 `⌘/Ctrl+Enter` 保存；`setAnnouncement` 多次设同一字串（如连续两次「正在识别网页元素…」）aria-live 不会重复播报 | 键盘效率；读屏用户第二次点选没有反馈 | P3 |
| M-22 | `components/ContainerWebPreview.tsx:92`、`:259-314`、`:904-916` | 全屏操作模式下 3s 后隐藏顶栏/工具坞/状态胶囊（含关闭钮），唤出只靠右上角一枚半透明 `…` 钮；鼠标移动、触边、在画布上点按都不唤出（点按会作为 click 转发给远端） | 沉浸是对的，但唤出方式单一且不易发现；桌面端「鼠标动一下控件回来」是通用预期 | P3 |
| M-23 | `components/ImageAnnotationEditor.tsx:892-911`、`:93-99` + `:605-608` | 提示词 `textarea rows={1}` 不自增高，多行后在 1 行高里滚动；`hasSelection` 每次 `revision` 变化都对整张 ≤1600² 的 mask 做 `getImageData` 全量扫描 | 多行描述可读性差；每一笔抬手都扫 2.5M 像素，低端手机可感知卡顿（PLAYBOOK §5.7） | P3 |
| M-24 | `components/ImageAnnotationEditor.tsx:780`、`:914` | 「Image 2 · 每张 50 积分」计费文案硬编码在 UI（含 sr-only 帮助文本），`ImageResizeMode.tsx:1-4` 注释也写死 50 积分 | 计费口径一改，前端就说谎；应来自能力/计费配置 | P3 |
| M-25 | `components/ImageViewer.tsx:382-403`、`:418-431` | 「分享」与「复制链接」把**签名 URL**（`/api/media-signed/…?t=…`，短时效）当作可分享链接 | 收到链接的人过一会就是 410；签名 URL 按仓内铁律「禁当持久引用」。当前产品没有持久可分享地址可用 → 需后端配合，见 §5 | P3 |
| M-26 | `components/ImageCommentMode.tsx:83-91`、`:146` | 落点层是 `<button>`，键盘 Enter 触发时 `clientX/Y=0` → 锚点固定落到 (0%,0%)；上传文件名固定 `${alt}.png` 而 `type` 取 blob 真实类型（可能是 jpeg） | 键盘用户无法有意义地落点（PLAYBOOK §5.5）；扩展名与内容不符 | P3 |
| M-27 | `styles.css:629`（10px 状态胶囊）、`:640` `:652` `:700` `:737` `:743`（11px） | 容器预览的状态胶囊 10px，工具坞标签/提示条/错误详情/次级按钮 11px | 移动端 10–11px 灰字可读性差，低于全站 `text-caption` 档；文件归 shell owner | P3 |

---

## 4. 修复计划

每条：改哪些文件 / 怎么改 / 补什么测试 / 预计风险。阶段 B 在同一工作树 `wt/media` 上做，
只碰归属文件；跨模块的三处（M-04 原语、M-27 样式、M-14 原语复用）见备注。

### M-01 调整大小页图片不显示 · P1

- **文件**：`ImageResizeMode.tsx`
- **改法**：删掉 `useEffect(() => setImgReady(false), [displaySrc])`（:89）。就绪态改为
  「记录已加载的 src」：`const [loadedSrc, setLoadedSrc] = useState<string | null>(null)`，
  `imgReady = loadedSrc === displaySrc`，`onLoad={() => setLoadedSrc(displaySrc)}`。换图/重试时
  `displaySrc` 一变 `imgReady` 自然回到 false，不再依赖 effect 时序；load 早于 effect 也不会被覆写。
  另给 `<img>` 加 ref 回调：挂载即 `complete && naturalWidth > 0` 的（浏览器同步命中缓存）直接
  `setLoadedSrc`。
- **测试**：`ImageResizeMode.test.tsx` 补 3 例：① 渲染后对 `<img>` `fireEvent.load` → 骨架消失、
  `<img>` 不再 `opacity-0`；② 重试重签换 src → 回到骨架，再次 load → 显形；③ 在 `act` 内
  先 load 再让 effect 跑（用 `flushSync`/微任务顺序模拟）仍显形。after 截图
  `media-image-resize--*.png` 四张必须能看到图。
- **风险**：低。只改本文件的就绪判定；`choose()` 合成管线不动。

### M-02 / M-03 评论模式 Esc 与脏状态保护 · P1 / P2

- **文件**：`ImageViewer.tsx`、`ImageCommentMode.tsx`
- **改法**：
  1. `ImageCommentMode` 暴露一个 Esc 处理器（`escapeRef?: MutableRefObject<(() => boolean) | null>` 或
     `onRegisterEscape` prop）：有草稿/正在改锚点 → `cancelInput()` 返回 `true`；有锚点无草稿 →
     打开确认层「放弃这 N 条评论？」返回 `true`；没有锚点 → 返回 `false`。
  2. `ImageViewer.onEscapeKeyDown`（:452-462）在 `mode==='comment'` 时先调该处理器，返回 `true`
     就 `preventDefault` 并停止；`false` 才 `setMode('view')`。
  3. `ImageCommentMode` 顶栏 X（:162-169）走同一条 `requestBack`：有锚点先确认，空白直接 `onBack()`。
     确认层复用 `ImageAnnotationEditor` 的 `role="alertdialog"` 写法（抽成小组件放本文件或
     `components/chat/` 内共用）。
  4. 同样给 `ImageResizeMode` 的 Esc 加 `busy` 守卫：提交中不退出。
- **测试**：`ImageViewer.test.tsx` 补：① 输入框内 Esc 只取消草稿、锚点保留、仍在评论模式（就是探针
  V-01，翻成断言）；② 有锚点无草稿按 Esc → 出现确认层，「继续评论」留在原地，「放弃」回 view；
  ③ 有锚点点 X → 同 ②；④ 无锚点 Esc/X → 直接回 view（回归既有用例）。`ImageCommentMode.test.tsx`
  补 X 的确认分支。
- **风险**：中低。Esc 分层已经有 ref 读最新态的机制，只是多一层委托；注意 `ImageAnnotationEditor`
  作为更高层 Dialog 打开时 Radix 不会把 Esc 派给查看器（既有行为，保持）。

### M-04 视频任务抽屉无关闭钮 · P2

- **文件**：`MediaTaskCenter.tsx`
- **改法**：顶栏右侧「刷新」旁加 `IconButton`（`components/ui`）`aria-label="关闭视频任务"`，
  `onClick={() => onOpenChange(false)}`，触屏 44px；窄屏放最右，保证 X 在拇指区。
  （备选：给 `Sheet` 原语加 `closeButton` 选项 —— 归 shell owner，本轮不越界，先在本组件内加。）
- **测试**：`MediaTaskCenter.test.tsx` 补「点关闭 → onOpenChange(false)」。after 截图
  `media-task-center--mobile--light.png` 可见 X。
- **风险**：低。

### M-05 开发者术语泄漏 · P2

- **文件**：`MediaTaskCenter.tsx`
- **改法**：
  1. 新增 `PHASE_LABEL: Record<string, string>`（`wait_gpu→等待算力`、`sampling/denoise_step→正在生成`、
     `upload→正在上传`、`done→已完成`…），未知 phase 不显示（只留 status）；进度行改为
     `{STATUS[status]}{phaseLabel ? ` · ${phaseLabel}` : ''}`。
  2. 「rev 4」改为不展示（用户不需要），或「第 4 版」放到 `title`。
  3. `errorCode → 友好文案` 映射（`H3_OOM→显存不足，请缩短时长或降低分辨率后重试` 等），
     原始 `errorMessage` 收进「详情」`<details>`；`apiCall` 的 `HTTP ${status}` 改为
     `服务暂时不可用（${status}）`。
- **测试**：`MediaTaskCenter.test.tsx` 补 phase/errorCode 映射与未知值兜底各 1 例。
- **风险**：低。纯展示层。

### M-06 危险操作无确认 · P2

- **文件**：`MediaTaskCenter.tsx`
- **改法**：「取消项目」「取消」「重做」三处包一层 `ConfirmDialog`（`components/ui`），文案写清
  后果（「取消后已生成的 N 个分镜会保留，未完成的立即停止」「重做会重新占用算力并覆盖这一镜」）。
  顺带 M-16 的 busy 态：`mutate` 记 `pendingPath`，对应按钮 `disabled` + spinner。
- **测试**：`MediaTaskCenter.test.tsx`：点「取消项目」→ 出现确认 → 「再想想」不发请求；
  「确认取消」发一次且期间按钮禁用；双击只发一次。
- **风险**：低。

### M-07 / M-08 容器预览 Esc 冲突、关闭无确认、键盘焦点陷阱 · P2

- **文件**：`ContainerWebPreview.tsx`
- **改法**：
  1. `Modal.onEscapeKeyDown`：`mode==='interact' && surface==='none'` 且 `document.activeElement`
     是画布/iframe 时 `preventDefault`，把 `Escape` 作为 `preview.key` 转发（既有 onKeyDown 已做），
     **不关闭**；焦点在控件上时 Esc 才关闭。
  2. 抽出 `requestClose()`：`annotations.length > 0 || draft` → 确认层「关闭后 N 条评论不会保留」；
     X、遮罩、Esc（控件态）都走它；`submitReview` 不变。
  3. `keyboardShortcut` 不再拦 `Tab` / `Shift+Tab`（浏览器原生把焦点移到工具坞/顶栏），
     `canvas` 的 `aria-label` 追加「按 Tab 离开画面」；是否保留「Tab 转发给远端」交指挥官拍板
     （备选：`Ctrl+Shift+Tab` 才转发）。
- **测试**：`ContainerWebPreview.test.tsx` 补：① 画布聚焦按 Esc → `onClose` 未调用、`send` 收到
  `preview.key Escape`；② 有评论点 X → 确认层；③ 画布上按 Tab → `preventDefault` 未调用。
- **风险**：中。改的是全局键位，需在 `test:browser` 门里跑一遍键盘用例（本模块非高频交互面，
  但键盘语义变了，建议跑）。

### M-09 触屏滑动不跟手 · P2

- **文件**：`ContainerWebPreview.tsx`
- **改法**：`onPointerMove` 对 `pointerType==='touch'` 且已判定为拖动（累计位移 > 8px）时，按
  ≥50ms 节流把**增量**发成 `preview.wheel`（`-Δx, -Δy`，系数与现有 `*2` 一致），`pointerup` 只
  处理「未移动 → click / select」，不再补发总位移；`pointercancel` 清状态。协议已有
  `preview.wheel`，不需要后端改动。双指缩放留待协议支持（记 §5）。
- **测试**：`ContainerWebPreview.test.tsx` 模拟 touch down → 3 次 move → up：收到 ≥2 条
  `preview.wheel`、0 条 click；小位移 up → 1 条 click。
- **风险**：低。

### M-10 视口只测一次、object-fill 拉伸 · P2

- **文件**：`ContainerWebPreview.tsx`
- **改法**：① 全屏态 canvas 由 `object-fill` 改 `object-contain`（容器背景已是 `#15151c`，
  比例失配时黑边而不是拉伸）；② 监听 `visualViewport` `resize` + `orientationchange`（防抖 300ms），
  尺寸变化超过 15% 或 `matchMedia('(max-width:767px)')` 翻转时重新 `readAccessProfile()` 并
  `reconnect()`（既有逻辑），小幅变化只依赖 ①。
- **测试**：vitest：触发 `window.resize` 大幅变化 → `createContainerPreviewTicket` 被以新 viewport
  再调一次；小幅变化不重连。after 截图 desktop 场景无拉伸（静态页看不出，靠单测）。
- **风险**：中低。重连会重置远端页面状态；用防抖+阈值把重连限制在真正的旋转/断点切换。

### M-11 笔刷滑杆压画布 · P2

- **文件**：`ImageAnnotationEditor.tsx`
- **改法**：画布容器（:816）加左内边距为滑杆让位（`pl-14 sm:pl-16`），滑杆保持 `absolute left-2`，
  这样 `max-w-full` 的画布永远从滑杆右侧开始；<sm 时滑杆高度从 `h-48` 收到 `h-40` 减少纵向占位。
- **测试**：after 截图 `media-annotation-editor--mobile--*.png` 滑杆与图片无重叠；
  `ImageAnnotationEditor.test.tsx` 断言容器 className 含让位 padding（轻量）。
- **风险**：低。

### M-12 底栏按钮重挂载丢焦点 · P2

- **文件**：`ImageAnnotationEditor.tsx`
- **改法**：把 `ToolButton`、`RoundBtn`（:701-739）提到模块顶层，`tool/setTool/setToolsOpen` 通过
  props 传入。
- **测试**：`ImageAnnotationEditor.test.tsx` 补探针 A-02 的断言版：聚焦「放大画布」点一次，
  `document.activeElement` 仍是同一节点。
- **风险**：低。

### M-13 禁用动作零反馈 · P2

- **文件**：`ImageViewer.tsx`
- **改法**：`ActionButton` 改 `aria-disabled` + 点击时 `flash(reason)`（既有轻提示通道），保留
  40% 透明视觉；「评论」理由改为「当前模型不支持图片评论」。
- **测试**：`ImageViewer.test.tsx`：无 `submitImageEdit` 时点「编辑」→ 出现提示文案、不进入编辑。
- **风险**：低。

### P3 批（量力而行，做不完写进遗留）

| 编号 | 文件 | 改法 | 测试 |
|---|---|---|---|
| M-14 | `ImageViewer.tsx` | 「更多」改用 `components/ui/DropdownMenu`（黑底样式走 className），得到 menu 语义与方向键 | vitest：`role=menu` 存在，ArrowDown 移焦点 |
| M-15 | `ImageCommentMode.tsx`、`ImageResizeMode.tsx` | 顶栏 X 补 `[@media(hover:none)]:size-11`；锚点用 44px 透明命中区包 28px 圆点（`before:absolute before:-inset-2`）；删除/确认 `size-9→size-11`（触屏） | after 截图 mobile；vitest 断言 className |
| M-16 | `MediaTaskCenter.tsx` | 轮询用独立 `polling` 状态不碰 `loading`；`mutate` busy 态（与 M-06 一起） | vitest：轮询期间「刷新」不禁用 |
| M-17 | `MediaTaskCenter.tsx` | 「单段视频」标题仅在 `standalone.length>0 \|\| (!loading && projects.length===0 && capability?.available!==false)` 时渲染；失败任务加「重试」（若后端有 `jobs/:id/retry`，否则「重新发起」跳回对话预填 prompt） | vitest 三种态的标题渲染 |
| M-18 | `MediaTaskCenter.tsx` | 进度条加 `role="progressbar" aria-valuenow/min/max`；横幅 `role="status"`/`"alert"`；任意值字号换 `text-caption/text-body` | vitest role 断言；designTokens 不涉及 |
| M-19 | `ContainerWebPreview.tsx` | 区分 `disconnected`（`phase==='closed' && !error`）文案「连接已断开，可能是容器休眠或网页已停止」+ 主按钮「重新连接」；`诊断详情` summary 升到 12px `--preview-muted`、`min-height:44px`（后者在 styles.css，见 M-27） | vitest 两种态文案 |
| M-20 | `ContainerWebPreview.tsx` | 「完成」改「加入」；加载期只保留画布中央态，状态胶囊在 `!ready` 时隐藏 | vitest / after 截图 loading 场景 |
| M-21 | `ContainerWebPreview.tsx` | textarea `onKeyDown` `⌘/Ctrl+Enter → onSave`；`announce(text)` 帮助函数在同文时先清空再设（或追加零宽变化） | vitest |
| M-22 | `ContainerWebPreview.tsx` | 全屏态 `pointermove`（鼠标）/ 触屏顶部 24px 边缘下滑 → `keepControlsVisible()`；节流 250ms | vitest：mousemove 后 `data-controls-visible=true` |
| M-23 | `ImageAnnotationEditor.tsx` | textarea 自增高（`onInput` 设 `style.height`，上限 `max-h-28`）；`hasSelection` 改为维护 `selectionDirty` 布尔（画/擦/清空/撤销时置位），只在 `undo/redo/restore` 后才扫一次 | vitest：三行文本后高度增长；性能项无自动测试 |
| M-24 | `ImageAnnotationEditor.tsx`、`ImageResizeMode.tsx` | 计费文案改读 `PRODUCT_CAPABILITIES.images`（若无价格字段 → 记「需后端配合」，先去掉硬编码数字只保留「Image 2」） | vitest 文案断言 |
| M-26 | `ImageCommentMode.tsx` | 落点层键盘触发（`detail===0`）时落在图片中心并提示「用方向键微调」；文件名扩展名按 `blob.type` 推导 | vitest：keyboard click → 锚点 (50%,50%) |

跨模块（本轮记录，阶段 B 用 `send_to` 找 owner）：

- **M-04 备选 / Sheet 原语关闭钮**、**M-27 preview 字号**、**M-19 的 summary 尺寸** → `styles.css` /
  `components/ui/Sheet.tsx` 归 shell owner；阶段 B 先在本模块内解决，原语层建议单独提。
- **M-14 用 DropdownMenu** 只是复用原语，不改原语。

---

## 5. 建议不修 / 暂缓项及理由

| 编号 | 项 | 处置 | 理由 |
|---|---|---|---|
| M-25 | 分享/复制链接是短时签名 URL | **暂缓 · 需后端配合** | 产品当前没有「可分享的持久媒体地址」；`/api/media/<digest>` 需登录 cookie 也不适合分享。要修得先有分享令牌/公开链接接口。前端能做的只是把「复制链接」改名为「复制临时链接」并提示有效期 —— 阶段 B 只做这一步 |
| M-24 | 「每张 50 积分」硬编码 | **部分暂缓** | 若 `productCapabilities` 没有价格字段，前端无从读取；阶段 B 先去掉数字，价格来源需后端/计费侧定 |
| M-17 失败任务「重试」 | 需确认 `/api/media-generation/jobs/:id/retry` 是否存在 | **需后端确认** | 不存在则退化为「重新发起」跳回对话 |
| M-09 双指缩放 | 触屏 pinch → 远端缩放 | **暂缓** | 协议 `ContainerPreviewClientMessage` 没有 zoom 消息；先把单指滚动做跟手 |
| M-08 Tab 是否转发 | 键盘可达性 vs 远端页面内 Tab 导航 | **待指挥官拍板** | 两种都合理，见 M-07/M-08 改法第 3 条备选；不拍板前按「不转发 Tab」实施 |
| M-22 移动端唤出控件 | 触边手势 | **只做鼠标移动唤出** | 触屏「顶部边缘下滑」与被预览网页自身的手势冲突风险高，先只做桌面鼠标 |
| M-27 | preview 10–11px 字号 | **转 shell owner** | 归属 `styles.css`；本模块阶段 B 不越界 |
| — | `ImageAnnotationEditor.wheelZoom` / `ContainerWebPreview.onWheel` 里的 `event.preventDefault()`（React 对 `wheel` 默认 passive，调用无效） | **不修** | 两处容器都已 `overflow-hidden` + 滚动锁，实际没有可感知后果；改成原生非 passive 监听收益低 |
| — | `ImageViewer.flash()` 的 `setTimeout` 无卸载清理 | **不修** | React 19 对卸载后 setState 静默；1.8s 定时器无泄漏风险 |
| — | `containerPreview.ts`、`useContainerPreview.ts` 逻辑层 | **未发现需修项** | 消息校验、重签、回退、心跳、清理路径完整；`send()` 静默返回 false 由上层处理 |
