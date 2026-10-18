# OCV5-496 第2步：提前唤醒与无推理预热

仅个人版独立 PR，基于 0b6809f01。DO NOT MERGE / DO NOT DEPLOY。
不改路由、现网环境、默认上下文、注册配置或商业版。
本 PR 不依赖第1步分支，可分别审查；最终一起合入时 gatewayLifecycle/index 的相邻改动需确认保留。

## 用户路径

用户登录或页面恢复认证、lane 准入成功且页面可见后，认证生命周期 hook 并行发一个
POST /api/agent/prepare，无须等 IndexedDB 会话记录完成。token 刷新不会取消同身份的在途请求；
关闭页面/切换账号会取消浏览器请求。StrictMode 重演可重发，但服务端按账号去重。
正常 WebSocket 仍负责 hello、游标与消息，不引入第二条连接或修改握手、idleSweep 阈值。

该提示只提前调用现有 ensureContainerEndpointReady，使用原 singleflight。
JWT、DB active/role、维护模式、新鲜目录和用户授权均先检查。
进程内最多2个准备任务、每 uid 60秒冷却、记录上限256；超限不排队。
后台失败固定字段记录，普通连接仍可沿原路径进行。不订阅、不扣费、不自动提交消息。

容器内 CLI 仍受现有 OC_ENGINE_PREHEAT 开关控制，默认关闭。
本 PR 不改该默认值或生产环境。**未来启用此开关属于配置变更，须另获用户批准。**
session-open 的既有触发点可提前准备 Codex：initialize + fresh thread/start，
没有 thread/resume、turn/start、compact 或推理。已有恢复线程不预先 resume。
静默新线程不发 session_id、不写恢复映射，真实引擎提交后才认领/宣布。

## 并发和闲置资源

每个用户容器最多1个未使用预热 runner，无队列。原有启动45秒 deadline 保留。
成功准备后60秒未使用则关闭；被普通页面读取不会刷新 TTL。
TTL 与真实提交使用同一 session lock。权限拒绝/Stop 在引擎提交前退出仍保留 TTL，
实际 runner.submitTurn 后才释放预热容量。忙状态保留容量并稍后检查；
关闭失败也保留容量，避免累积额外进程。模型/effort/路由/cwd/仓库版本变化会丢弃
静默线程，shutdown 代际隔离迟到结果。失败预热回退普通提交路径；已失效的未初始化
旧进程自愈可能使本次预热失败，不表示用户提交失败。

## 冷启动分段

container_boot_timing 固定阶段：
module_loaded → seed_validated → env_ready → cli_links_ready → package_config_ready →
codex_skills_ready → platform_overlay_ready → config_agents_ready → gateway_spawn。
相邻 stageMs 为本 TS 模块中的单调时间；tsEpochMs 用于跨进程对齐。
gateway shell 另记进入、预编译检查、exec node/tsx；其 stageMs 是墙钟差，
clockSource=wall，不与 TS 的单调时间混称。
网关监听记录 processUptimeMs。Docker StartedAt → 首个 TS marker 仍包括 shell/npx/
静态 imports，用端点相减，不能仅凭 module_loaded 将这段归因于某一个 import。
没有改镜像 entrypoint.sh，也没有镜像重建或生产用户容器重建。

旧现网的12.470秒仅有 Docker StartedAt 和 gateway-listen 起止证据，不能事后细分。
新日志在未来获批发布并新建测试容器后，才能给出现网各段 p50/最慢值；
离线断网容器的数据只代表其明确的镜像、seed、CPU/内存限制。

## 评估与验证

真实 CLI 可用 scripts/ocv5-496/codex-prewarm-probe.mjs 在独立 --network none、
只读根文件系统、无凭据、tmpfs HOME 中运行。只向回环假 provider 配置连接，
服务端拒绝一切推理 POST；观测 initialize/thread/start 和完整自有进程树的 RSS、
2秒闲置 CPU ticks。不会触达付费供应商。最小上下文数据不能替代生产 MCP/完整上下文数据。
本轮产品模型请求和扣费均为0。

历史普通用户样本：冷首轮16.488秒，其中提交到relay-ready 11.178秒；
热容器新对话 Sol p50 5.196秒，新 CLI/thread 准备 p50 1.306、最慢2.746秒。
因此提前唤醒的潜在收益是 min(提前量, 冷等待)，足够提前时上界约11.178秒；
CLI/thread 完成在提交前时另有约1.306秒中位准备成本可移出关键路径。
两项不是已测现网加速，区间可能重叠，不能相加承诺。用户立即提交时收益可能接近0。
历史51–151秒上游首字等待不在本步解决范围。

定向验证覆盖：真实引擎 RPC 合约、静默恢复 ID、模型变化/关闭竞态、
预热 cap/TTL/取消/关闭失败、HTTP JWT/准入、前端可见性/身份刷新/StrictMode、
平台阶段计时、既有 singleflight 和 runtime 策略。依赖 typecheck、lint 和托管 CI
保持原门；正式独立审查另附 PR。潜在风险是更早启动的容器会按原30分钟闲置策略保留，
以及短时多一个 CLI 进程树；不声称生产完整上下文资源开销已测清。

### 本轮离线实测结果（2026-10-18）

断网 CLI3轮均成功，新线程存在，推理 POST、GET models、其它 HTTP 计数均为0。
initialize + thread/start RPC窗口 p50 626.734ms，最慢733.863ms；
该窗口从 spawn 返回、监听器装好后开始，不包括所有同步 spawn 准备。
每轮真实CLI父子树均2进程，RSS合计中位数164.551MiB、最大165.559MiB，
含共享页重复计数；这不是PSS或容器总内存。
约2秒观察窗口CPU ticks为1/8/4，包含启动后的后台活动，不能宣称零CPU或长期稳态。

这约165MiB的短时增量不可忽略。TTL和cap限制了持续时间与单容器数量，但本轮没有
用完整默认MCP上下文证明生产资源增量。因此开关继续默认关闭，未来是否启用需在
个人版测试账号测完完整资源曲线后单独批准。正常TTL成功回收后的长时间闲置不新增CLI；
关闭失败时容量保留，不能声称一定回收成功。更早唤醒的整个容器仍按原30分钟策略保留。

### 路线参数与真实回合一致

原预热的空route参数与真实official override不一致，会被正确的失效检查重启，导致首轮收益抵消。
本PR补齐只读元数据：master在新鲜目录、当前epoch用户权限与active状态检查后，
按原group顺序确认下一条是可用official才发送固定official_oauth标记。
遇到API relay立即跳过，不绕过优先路线、不铸token、不写route contexts，不传账号或凭据。
容器用与真实inbound相同的安全builder，取得session.lock并复核模型后才绑定预热参数。
真实请求仍独立决策，路线变化照常重启；无明确模型/授权/标记时不预热Codex。
这不是生产路由策略或配置变更。

### 冷启动离线阶段分布

以下3个独立临时容器均到达网关监听，使用当前runtime镜像、只读源码/依赖、
默认seed与全新tmpfs用户目录，断网、根盘只读、2CPU/768MiB限制。
走的是tsx源码回退（无预编译产物）；root readonly导致部分固定路径写入被原有容错跳过。
因此不是普通账号现网对照，不用来替换此前12.470秒的生产样本，也不是加速前后对比。
跨进程差用同宿主墙钟毫秒时间戳；TS内部相邻阶段为performance.now。
文件缓存未清空；每个阶段中位数相加不等于总中位数。

| 阶段（隔离源码启动，n=3） | p50（秒） | 最慢（秒） |
|---|---:|---:|
| Docker StartedAt → 首个 TS marker | 5.291 | 5.409 |
| 平台准备合计 | 0.373 | 0.388 |
| 其中 seed 校验 | 0.299 | 0.356 |
| 平台其余准备 | 0.040 | 0.092 |
| npm 启动 → gateway shell | 0.784 | 0.804 |
| shell 检查 → exec tsx | 0.006 | 0.006 |
| tsx/网关模块加载 → 监听 | 11.367 | 11.406 |
| Docker StartedAt → 网关监听 | 17.711 | 17.974 |

本条件下较长的部分在首个TS marker之前，以及gateway exec之后到监听之间，
seed/技能/配置准备只占约0.4秒。不能据此把生产12.470秒按同一比例分摊。
