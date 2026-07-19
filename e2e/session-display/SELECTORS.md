# 会话展示 e2e — 选择器与契约地图(调研 agent 交付,写 spec 唯一依据)

## 硬提醒
1. 非 demo 模式(禁 ?demo=1),真实路径走 cards.tsx。
2. 登录=视图态切换非 URL 跳转;断言工作区元素出现(侧栏"新建会话"按钮/composer textarea)。
3. 关键节点缺 testid:user=.bg-bubble(父 items-end)、assistant=.prose、typing=aria-label="生成中"、
   history skeleton=aria-label="正在加载会话历史"、选中会话=[aria-current="true"]。
   **建议先补少量 data-testid(user-row/assistant-row/message-text)再写 spec。**
4. Turnstile bypass 环境 token 用字符串 "bypass"(login body turnstile_token 必非空)。
5. 双击第二击=停止按钮(非重发);排队去重 sess._sendingInFlight;服务端幂等 idempotencyKey=web:<cmid>:<attempt>。

## 登录
- / → 营销页按钮 role=button name=登录|免费开始 → AuthGate。
- email: getByPlaceholder('邮箱');password: getByLabel('密码');提交: getByRole('button',{name:'登录'})。
- turnstileBypass 来自 GET /api/public/config。

## 会话列表(Sidebar)
- 新建会话: getByRole('button',{name:'新建会话'})(纯本地,PUT /api/sessions/:id 在首发时才发)。
- 会话项=button,文本=标题(空="新对话");选中 aria-current="true";重命名/删除 aria-label。
- 空列表文案"暂无会话"。

## 消息行
- **本批已补 data-testid**(cards.tsx):user 行 wrapper=`user-row`、user 气泡=`message-text`、
  assistant 行 wrapper=`assistant-row`、§9 折叠卡=`collapse-card`。assistant 正文仍走既有
  `.prose`(不侵入共享 Markdown 组件)。
- **选择器双模(lib/ui.ts SEL)**:testid 优先 + 既有 class 回退,**同元素同时命中两者→union 去重**
  (绝不祖先/后代双计)。user=`[data-testid=user-row], .flex.flex-col.items-end:has(.bg-bubble)`;
  assistant=`[data-testid=assistant-row], .group.flex.gap-4:has(.prose)`。故套件对"含 testid 的
  本分支构建"与"尚未部署 testid 的现网构建"都能跑(现网自验即靠回退)。
- 过程卡顺序回归锚点:`team-panel` / `permission-card`；与 `assistant-row` 组成 DOM 全序断言。
- user 状态标签 发送中/排队中/已送达/已读/已回复/发送失败(+重试按钮文案"重试")。
- 加载完成判据:aria-label="正在加载会话历史" 消失 ∧ 出现 .prose/.bg-bubble。

## 发送
- composer 占位符**随 agent 变**(如"和「全能助手」对话…"/"给 OpenClaude 发消息…"),用
  `getByRole('textbox',{name:/对话|发消息/})` 定位(排除"搜索会话"框);发送按钮 aria-label=发送(busy 时=停止)。
- clientMessageId=本地行 id(mintMsgId,前缀 m-);WS 帧 inbound.message @ socket.ts:2233。

## typing/终态
- aria-label="生成中"(TurnActivity/TypingDots);final 后消失(等消失即终态判据)。

## 错误卡
- 全局横幅 role=alert,标题"发送失败",按钮 aria-label="重试发送"。
- 内联终态错误卡 Alert:dispatch_lost/dispatch_not_accepted → title"消息未开始处理",message 含"已确认未计费";
  service_restart → "服务重启,本轮已中断";按钮"重新尝试"(insufficient_credits→"去充值")。
- projection 抑制:同 _clientMessageId 有真生成行 → oc-dispatch-err: 行不显示(isProjectionSuppressedByTerminal)。

## 折叠卡(§9)
- 折叠态 button 文案 `本轮完整输出 {N MB},点击加载`;加载中"正在加载完整输出…";失败"加载失败,点击重试"。
- 展开后分节头"…· 已展开"+"继续加载更多"+"收起";卷级截断提示"内容较多,部分记录已省略…"。
- 勿混淆 msg._truncated(max_tokens 续写 banner,按钮"继续")。

## 历史分页
- 本地:"加载更多历史(还有 N 条)";云端:"从云端加载更早的历史(还有 N 条)"/加载中…/失败重试。
- API: GET /api/sessions/:id/archive?before=<seq>&limit=<n> → {messages 升序,hasMore,oldestSeq}。

## WS
- path /ws/user-chat-bridge;bearer 走子协议 ["bearer", token](非 query 非 header)。

## API 表
- POST /api/auth/login {email,password,turnstile_token} → {user,access_token,...}(429 限流)
- GET /api/sessions/list → {sessions[]};GET /api/sessions/:id(?since=)→ SessionDetail{messages,maxSeq,archivedCount,...}
- PUT /api/sessions/:id {agentId,title,messages,_baseSyncedAt}(409 stale/413 2MB)
- GET /api/sessions/:id/tape/:tapeId/records?cursor&limit → {records,nextCursor,total}(404 越权)
- session id 约束 [A-Za-z0-9_-]{8,50};前端 genWsSessionId() 生成 web-*。
