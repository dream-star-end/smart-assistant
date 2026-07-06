# P2 批次4(团队产品化)+批次5(移动端) 方案(2026-07-06)

> 取证:两路 opus 调研(团队产品化 8 点/移动端 5 点),锚点行号已核。前置:批次2/3 的 agentGroups 通道、_runTeamReviewPass、per-parent 分桶已上线。

## 批次5 移动端(先行,纯前端+少量 index.html/构建)
1. **弱网重连三态呈现**(07-06 事故 UX 教训):App.tsx:1072 状态条消费已存在但未接线的 `chat.provisioning`(useChatSocket.ts:444)+`closeReasonLabel`+`isBrowserOnline`,分流文案「环境启动中/网络已断开/服务更新中」;pure.ts:460 CLOSE_REASON_LABELS 补 provisioning/starting 组。
2. **首屏瘦身**:SettingsCenter/ManageCenter/MarketplaceCenter/Landing 改 React.lazy+Suspense(entry 621KB 主因,App.tsx:14/16/28);报告前后体积。
3. **PWA 最小可行**(roadmap 措辞是"评估",按最小安全集落地):手写 sw.js **不引新依赖**——/assets/* cache-first(内容哈希 immutable);**导航 network-first,仅离线回落缓存 index**(红线:v5 与 v3 同源共存于 secret/cookie 闸后,network-first 保证在线路由永远正确);/api|/ws 永不拦截。manifest.webmanifest+图标(public/ 新建)+iOS meta(apple-touch-icon/status-bar);main.tsx 注册。Gateway 侧确认 mimeFor 支持 .webmanifest(不支持则补)。
4. **显式不做**:虚拟滚动——尾窗口 100 条已 bound DOM,四个滚动锚定冲突点(贴底 scrollHeight/上翻补偿/near-bottom 判定/切会话跳底)代价高于收益;若后续真机数据显示卡顿再评估。鸿蒙 ArkWeb 零标注现状保持(通用机制覆盖)。
5. 真机验收(iPhone Safari+鸿蒙)后才关单。

## 批次4 团队产品化(P2.2b,清债表剩余 4 行)
后端(gateway/mcp-memory/protocol):
1. **委派上下文结构化**(清「委派上下文纯文本」债):(a)server.ts:6970 委派 prompt 增加产物纪律——大产物写 `/home/agent/.openclaude/generated/<名>`,回传=路径+≤1.5k 蒸馏摘要;(b)_runDelegateTask 回传 output 兜底封顶(~4k 字符,截断时注明);团队卡 resultSummary 2k 截断不变。显式取舍:不引入正式工件 schema,基于共享容器 FS+prompt 纪律(父子同容器已天然共享)。
2. **fan-out 并行原语**(清「委派并行无机制」债):mcp-memory 新增 `delegate_tasks` 复数工具(tasks[]≤4,Promise.all 各自走既有 /delegate 端点);gateway 零改动——per-parent 分桶(3)+全局闸(5)+有界排队本就为并发设计。preamble 补"独立子任务用 delegate_tasks 并行"。
3. **普通成员每 turn 上限**(清「串行无上限」债):仿 HiddenDelegateGuard 新增 memberDelegateGuard(env 可配,默认 8/turn),turn 边界复位挂 server.ts:9863 同点;仅拦非 hidden 非 review 委派。
4. **effort 分档**:delegate_task(s) schema 加 effort(low/medium/high)→RunDelegateInput→sessions.submit 透传(server.ts:7012 现在不传);preamble 加按量级选档指引。
5. **plan-first 软引导**(plan 卡 v1):preamble 要求复杂多委派任务先输出简明计划(TodoWrite),PinnedTaskTracker 天然承接展示;**硬暂停等用户批改不做**(每 turn 加同步等待的产品代价大,先看软引导数据),登记为后续项。
前端(web-react,待批次5合并后做):
6. **teamMode 会话级**(清「粘滞开关」债):存储键改 `oc_v5_team_mode:<sessionId>`(全局键作默认值回退),App.tsx:56-125/319/705;后端零改动(帧字段本就 turn 级)。
7. **landing 团队演示对齐**:demoScripts.ts:204-229 角色改为实际预设成员(编程/科研/办公),fan-out 落地后「并行」表述成立予以保留,账本表述对齐 TeamPanel 实际能力;仍全虚构示意数据(boss 红线)。
显式不做:共享任务看板独立页(TeamPanel+PinnedTaskTracker 已承接 80%)、回放/分享链接(需新 token 设施,另立);死代码 submit_team_final/OPENCLAUDE_TEAM_RUN_ID(mcp-memory)顺手删除。

## 纪律
每批:typecheck+四层实跑+commercial 基线 diff;我验收 diff 清单+抽查+复跑;合并前 fetch(并行会话活跃);生效面——批次5=dist(+gateway mime 若改则 image);批次4 后端=runtime image(gateway/mcp-memory)+镜像 rebuild,前端=dist。
