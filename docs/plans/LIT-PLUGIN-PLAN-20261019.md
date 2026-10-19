# Aurora「文献数据库检索」服务端插件调研与实施方案

日期：2026-10-19；调研工单：OCV5-524；状态：**方案待用户审阅，未实施、未上架、未发布**。

## 1. 建议与可行性结论

建议沿现有微博插件的 **`managed-browser` 官方服务端插件**体系实现，名称可用「文献数据库检索」，slug 暂定 `literature-db`。先只支持 jieyoutsg 的一个经授权数据库入口，完成登录、检索、详情和单篇授权下载，再逐库扩展。普通字符验证码优先在受限 worker 内用 ddddocr；自动提交总计最多两次，仍失败再让用户输入一次。优先复用有效会话，减少登录和验证码次数。

**当前不能直接承诺可以商业上架，需先解决两项有证据的前置条件：**

1. **认证传输安全。** 本轮从 v5-dev 实际读到的首页、登录页、表单 POST 均为 HTTP；HTTPS 从 v5-dev 连接被拒绝，本机 TLS 失败。现有插件网络和账户状态要求 HTTPS / secure cookies。必须找到并验证站方支持的 HTTPS 登录入口、官方 API 或覆盖到站方的获准安全通道。Aurora 自己的 HTTPS、数据库加密、导入 Cookie、在 Aurora 前加反向代理，都不能修复最后一段 HTTP。保留现有安全门，不加 HTTP 例外。两个出口失败不等于证明网站在所有网络都不支持 HTTPS。
2. **实际入口和使用许可。** 未登录看不到检索入口，尚不能确认 CNKI / 万方 / 维普等实际目标、登录态能否跨服务器复用、下载是否消耗余额，以及授权是否允许第三方服务器代理和自动化。用户拥有账号也不自动意味着获得商用代理、全文缓存或再分发许可。先完成获准验证，再确定适配范围。

这两项未解决时，可以做离线 OCR、模拟站点和架构验证；不向当前 HTTP 端点提交真实密码或重放真实认证 Cookie，不开放商业托管服务。若站方无法提供安全且获准的访问方式，结论应是暂停该站适配，改接有授权 API 的数据库；不能用降低安全门来完成上线。

## 2. 本轮范围、环境与证据

用户授权：先调研出方案，不写产品代码、不发布；只读公开访问，不注册、不暴力请求；禁用 cc1，不删 `/tmp/tsx-0`，不输出密钥或完整 env，不改生产，不抢发布队列和测试锁；完成后停止等用户审方案。

已读指定 `/home/box/agent-data/workflows/ocv5-remote-dev/SKILL.md` 和 `~/.codex/skills/` 下四个 V5 skill，并按指定 sudo SSH 连上 v5-dev。08:28:59 UTC 宿主为 `v3-dev-sg`；商业 canonical 为 `c67a9446d931290122d8bdda6776a9106268e39e`，个人 canonical 为 `4437ceb73`，两者当时均干净；08:29:01 UTC `wait-for-trains.sh --once` 为 FREE。此快照只用于避让，不是未来发布或验收证据。

代码结论固定到商业 SHA `c67a9446d931290122d8bdda6776a9106268e39e`，不把个人版作者文档当商业运行事实。另建纯文档 worktree：v5-dev `/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-524-lit-plugin-plan`，分支 `docs/v5-ocv5-524-lit-plugin-plan`；不安装依赖、不运行产品测试、不占锁。本轮未连接 `kl-mirror`，未重新查询生产 deploy_state/health，故不声明任何生产状态通过。

公开站点证据：[访问记录及结构说明](ocv5-524-public-site/README.md)、[单张验证码元数据](ocv5-524-public-site/captcha-metadata.json)。这些只含公开访问摘要及公开图片；不保存响应 Cookie 值。下文的“已确认”限于该时刻、该页面；工程阈值和工作量均为拟议值。

## 3. 商业版现有插件体系

### 3.1 定义、发布工件和执行链

| 路线 | 当前定义和用途 | 对本任务的适用性 |
|---|---|---|
| 容器本机插件 | `plugin.json` / `openclaude-plugin/1`，skills/bin/data/ui，容器内命令 | 不能仅填一个 browser 组件就变成服务端插件；该 schema 明确拒绝尚不支持的 http/browser 组件 |
| 声明式 HTTP 插件 | `plugin-blueprint-v1` 编译到 ConnectorSpec，经审核签名；`oc-connect` 调用 | 若站方提供正式 HTTPS API，优先选此路线 |
| 受管浏览器插件 | `schemaVersion:1, pluginType:managed-browser`，固定 driver/version、account contract、actions、网络及账户来源白名单 | 与网页登录/检索最匹配；微博、知乎、知识星球、B站账号可参考 |

服务端浏览器工件由 `plugins/contracts.ts` 编译，动作有 `id/description/effect/timeoutSeconds/params/result`；账户必须绑定，网络 exact HTTPS origins 和 account origins 各最多 16 个，逐跳重验并钉公网 IPv4；禁止 DoH/QUIC/WebSocket/WebRTC/worker 等旁路。新增真实数据库或 CDN 域名须逐一确认并重新审核，不能用任意 URL 或广域通配符替代。[C1][C2]

执行拓扑：

```text
用户安装并绑定账号
  → marketplace_installs / capability bindings / connections
模型经 app-connectors 技能发现插件
  → oc-plugin catalog/list/call
  → /v3/plugins/*（校验容器双因子身份，服务端推导 userId）
  → PluginRuntimeFacade（启用/安装/归属/签名合约/参数/账户租约）
  → 隔离 Docker worker + Playwright + 受限网络 broker
  → 结构化结果回模型；文件另走归属校验的 artifact 通道
```

市场元数据在 PostgreSQL 的 `marketplace_skill_listings`、`marketplace_skill_versions`、`marketplace_installs` 等表；列表中插件底层 `kind='connector'`，浏览器子类型是 `managed-browser`。安装固定版本和工件 hash，Agent 作用域走 capability bindings。工具主要通过 CLI 和按需说明暴露，不能假设安装后就向所有模型原生注册一组新工具；沿现有 CLI/RPC 同时验证 CCB 和 Codex。[C3][C4]

### 3.2 凭据与账户状态

现有 managed-browser 账户保存的是**严格验证的 browser storageState**，不是通用用户名/密码凭据箱：cookie、localStorage 受契约域名限制，cookie 要求 `secure=true`；额外 password/sessionStorage/IndexedDB 字段不能直接塞进去。`connections` 中密文与账户、用户、provider 关联，envelope 还绑定版本/合约，升级需走受控重绑。[C5]

现有加密为 AES-256-GCM，随机 12-byte nonce、16-byte tag；密钥来自环境键名 `OPENCLAUDE_KMS_KEY`，AAD 为 `conn:{aad_seed}:{user_id}:{provider}`，加解密临时 Buffer 有清零。这里是现有应用密钥机制，**不是已经部署外部 KMS 或完整自动轮转系统**。账户更新有 generation fence/CAS；同账户浏览器运行有 Redis 排他租约。[C5][C6]

因此复用登录会话的工作量较小；“平台替用户记住密码并重新登录”需要独立的、带版本的凭据 schema 和安全 UI。建议默认会话托管；用户明确选择保存密码时再启用可逆加密的密码托管，不能把密码做不可逆 hash 后还承诺可自动登录。

### 3.3 微博参考与不能照搬的部分

微博参考链：`weiboContract.ts` → `weibo.ts` / `weiboWorkerSource.ts` → `weiboSetup.ts` → `seedWeiboPlugin.ts`。worker 在独立 Docker 中执行，机密经 attach stdin 帧传递，避免 argv/env；已有 Docker 禁止保存 worker stdout 日志、stderr 结构化白名单范本。[C7]

可复用：审核签名、安装授权、账号加密、代际围栏、排他 lease、浏览器沙箱、域名和 IP broker、setup 会话归属校验、状态查询与取消。

必须新增：

- 微博遇验证码/极验会停止；现有登录事件只有 QR/authenticated/failed 等，没有 OCR 或字符答案恢复通道。`knowledgePlanetVerificationHandoff` 是发布验证账号的加密交接，不是用户验证码接管接口。
- 当前 setup 入口以 `acceptTerms/accountId?` 开始，GET 状态/二维码、DELETE 取消；没有安全密码输入、challenge 图片 GET / answer POST。
- CLI 虽有 `--out`，不代表大 PDF 可透传：微博 worker 单帧 1 MiB，runtime 结果也有 stdout 上限，broker 有连接字节预算。下载应流式进入租户文件存储并返回 artifact ID。[C7][C8]

### 3.4 上架与计费现状

普通发布 API `/api/marketplace/connector/publish` 目前是声明式 HTTP 路线，提交后 pending。浏览器插件走平台维护的 runtime artifact 审核；普通 runtime 审核要求非作者的有效管理员、安全审核及真实功能验证，再写入绑定 artifact/execContract/compiler/policy 的 `plugin-v2` 签名；不能由发布者自称安全就执行。[C9]

微博官方 seed 是**该插件精确 slug/version/hash 的专用通道**，不能用它换个 slug 上架。`seedWeiboPlugin.ts` 先要求 `functionalVerified`、发布和签名，再做安装/加密账号版本 transition，最后开放 listing gate。正式流程还与部署脚本中的 exact worker 功能证明和补偿衔接。文献插件应新增自己的受审通道和真实验证，不传假 `functionalVerified=true`；计划中的 mock 通过也不能代替真实站点验证。[C10]

**在已读市场安装、连接器 RPC、runtime/browser 执行路径中，未发现通用插件购买、插件每调用积分扣费或作者分成闭环。** 安装事务固定版本和作用域，RPC 做限频/确认/执行；不能把动作审计账本误称收费账本。对话调用模型仍走既有模型计费；知识星球自动化内有模型调用结算，属于特定功能，不等于插件统一计价。[C3][C4][C11]

建议首期免费安装，设资源配额；是否免费试用、订阅或按成功检索/下载收费由用户审方案决定，未定价时不得暗扣。若收费，作为独立工作项补齐报价展示、余额预留、唯一 requestId、成功结算、失败释放、崩溃恢复和重放幂等；只能复用平台钱包收口，不另写 users.credits UPDATE。插件费用单列，不伪装模型 token 消耗。验收为插件用量记录、结算记录、credit_ledger 对应且一次业务仅扣一次；模型用量仍按原模型三账核对。[C11]

### 3.5 已有文献能力的边界

商业树已有 `oc-lit` 多源元数据检索（OpenAlex/Crossref/arXiv/PubMed/Semantic Scholar）、去重/OA 发现、OA fetch 与文献入库；旧 `/v3/literature/search` 是 DeepXiv/arXiv 代理。`oc-lit` 技能明确不代爬知网/万方付费墙全文。[C12]

新插件可复用后续引用、解析和文献库链，但不得把它伪装成 OA 来源或静默扩张 `oc-lit` 的授权范围。新结果携带 `sourceProvider=jieyoutsg`、实际数据库、源记录 ID、访问时间和来源链接；只有权限允许才下载或入库，不能把某用户认证下载的文件变成公共缓存。

## 4. jieyoutsg 公开页面调查

来源：[首页](http://www.jieyoutsg.com/)、[登录页](http://www.jieyoutsg.com/e/member/login/)及其明确引用的公开资源。目标站公开页面的本轮取证时间是 08:28–08:31 UTC。

| 项目 | 已确认 | 未确认/影响 |
|---|---|---|
| 首页 | HTTP 200，1045 bytes，未登录提示，JS 3 秒后去 `/e/member/login/` | 没有看到登录后目录或检索表单 |
| 登录提交 | `POST /e/member/doaction.php`；主要 name 为 `username/password/key/lifetime`；hidden 为 ecmsfrom/enews/tobind | 未提交；成功/失败响应、CSRF/会话绑定、锁定策略未知。未见显式 CSRF 字段不等于证明无 CSRF 防护 |
| 表单定位 | 用户名和密码的 id 反置 | 应按 name/表单语义定位，不能照 id 填反 |
| 验证码 | 图片 `/e/ShowKey/?v=login` + key 文本输入；点击刷新加随机参数 | 一次样本为 47×20 JPEG、灰底白色四位数字；不能据单张保证恒为四位数字或成功率 |
| 挑战类型 | 登录 HTML 和两个实际读取脚本未见滑块、点选、极验等 SDK | 未执行 JS、未登录；不能排除风控升级、二次验证或下游第三方挑战 |
| 检索去向 | 登录页提及 PubMed/ACS/Wiley/Proquest 使用说明、资源列表链接；站方自述提供数据库内容下载入口 | CNKI/万方/维普/读秀仅见第三方 SEO 摘要，未把它们当实时事实。各入口是外链、反代、机构漫游还是 API 均未知 |
| HTTPS | 本机 TLS EOF，v5-dev HTTPS 连接拒绝；已确认表单相对端点仍为 HTTP | 未证实站方其它合法 TLS 入口；不得用忽略证书校验“解决” |
| 反爬 | 公开登录有图片验证码；未见 WAF 挑战页 | 不能推出无 WAF；IP 绑定、并发、UA/行为检测、二次登录、下载风控均未知 |

子代理共做 8 次脚本 GET（6 次经 v5-dev），另 1 次 web 打开尝试；主代理另 1 次 web 打开尝试未取到页面。两次 web 工具内部请求次数未知，不能把逻辑打开数写成准确网络请求数。只取一张验证码判别类型，未识别答案、未提交登录、未注册、未检索或下载；未继续访问帮助/资源/充值/客服链接。完整记录见证据目录。

后续在安全通道确认且用户审准后，只用专用测试账号低频记录：入口跳转域名链、二次认证位置、实际检索字段、结果分页、文件下载链、Cookie 属性/期限、是否跨 IP 失效、是否有并发登录或按篇扣点。每个数据库单独验收，不以总站登录成功代替下游可用。

## 5. 验证码自动识别方案比较

**当前三类方案在 jieyoutsg 的 OCR exact-match、验证码接受率和完整登录成功率均未测。** 官方广告、别站经验不能充作该站成功率。

| 方案 | 成功率判断 | 成本 | 延迟 | 适配与合规风险 |
|---|---|---|---|---|
| 本地 ddddocr | 适合先测普通英数字符图；支持概率/字符集限制，单样本不足以设纯数字假定 | MIT，无按次 API 费；有 CPU/内存、镜像和维护成本 | 预热推理 ≤1秒为拟议目标，不是实测。初始化常驻，报告冷/热 P50/P95 | 图片不出 worker；仍须确认自动化许可。模型/依赖固定版本并核对分发许可 |
| 其它本地/云多模态 | 可能读字符，但识字对不代表会话和风控通过；目标站无基准 | 本地有模型硬件成本；云按图片输入及输出 token 计费，选定允许该用途的供应商后才能报价 | 本轮无可用实测；须量 P50/P95，预算不无限等待 | **OpenAI 官方 vision 文档明确阻止 CAPTCHA 提交，因此不采用其路线。** 其它供应商必须先核条款/数据处理；不得把用户挑战直接交 Aurora 通用对话模型 |
| 第三方打码 | 无本站独立验证，不能承诺 99%/100% | 2Captcha 普通图 US$0.50–1/1000；Anti-Captcha Images US$0.50–0.70/1000，调研时页面报价，非采购承诺 | Anti-Captcha 首页展示约5秒，非 SLA；2Captcha 展示0秒不能当端到端延迟。异步总预算可先定45秒 | 默认关；用户选择、站点许可和供应商数据条款核对后才启用；仅发送挑战裁剪图，不发账号/密码/Cookie/完整页面。图片处理地区与留存需另确认 |

来源：[ddddocr 官方说明](https://github.com/sml2h3/ddddocr)、[许可证](https://github.com/sml2h3/ddddocr/blob/master/LICENSE)、[OpenAI vision 限制官方 Markdown](https://developers.openai.com/api/docs/guides/images-vision.md)、[2Captcha 报价](https://2captcha.com/pricing)、[Anti-Captcha 报价](https://anti-captcha.com/)、[ImageToTextTask](https://anti-captcha.com/apidoc/task-types/ImageToTextTask)。官方文档和报价核对日期均为 2026-10-19；供应商页面不提供本站成功率。

推荐顺序为：有效会话 → 本地 OCR → 新挑战一次重试 → 人工。用户若选第三方，可用第三方替代第二次 OCR，**不是每种 solver 各重试两次**。若未来出现滑块/点选/极验，不把字符 OCR 当通用解法，先停到用户交互或站方正式支持接口，不做隐身插件、指纹伪造或 IP 轮换规避。

成本核算：`总成本 = 浏览器执行时间 + OCR计算 + 所有付费挑战尝试 + 下载流量/存储 + 运维`；`单成功任务成本 = 总成本 / 成功任务数`。例：10万次字符图付费尝试按上述报价约 US$50–100（2Captcha）或 US$50–70（Anti-Captcha），不含税/汇率/退款/其它资源。若只在一部分登录触发 fallback，应按实际尝试数计算，不能按搜索次数直接乘验证码单价；多数搜索应复用会话。

## 6. 推荐技术与用户流程

### 6.1 登录、会话与验证码状态机

拟新增独立的文献站 adapter，固定站点 URL 与域名契约；模型不能传任意网站、脚本、请求头或浏览器指令。认证信息通过管理中心受保护输入或文件导入，不走聊天、技能文本或工具参数。

```text
任务进入 → 校验安装/用户/账号/版本及配额 → 获取账户 lease
  → 恢复有效会话 → 站点登录态探测
    → 有效：检索/详情/授权下载
    → 失效：读取获准的 credentialRef → 取本会话挑战 → OCR → 提交
      → 明确验证码错误：刷新新挑战，最多再自动提交一次
      → 两次仍失败：needs_user_action → 用户输入一次 → 恢复原任务
  → 结果/文件落盘并登记 → 按代际 CAS 保存加密会话 → 释放 lease
```

错误密码、账号冻结、403/429、明显风控立即停止，不能被当成 OCR 错误反复登录。POST 超时先探测登录状态，结果未知时不盲重发。验证码图片必须来自同一 BrowserContext、同一会话；刷新后旧答案作废。登录成功应同时验证身份标志和受保护页面，不能只凭 HTTP 200。

现有 RPC 业务信封没有专用验证码分支。MVP 可让插件 action 的严格 result schema 返回 `status/operationId/nextAction`，并在管理中心展示待办；如需通用 `needs_user_action` RPC 信封，协议、CLI、两引擎、前端必须同 PR 更新，不能只改 worker 输出一个未知事件。**新增 setup/login-operation manager 专门持有等待验证码的 worker/context**：现有 `browserRuntime.runAction` 返回时会关闭 session、终止 launcher、删除 profile（`browserRuntime.ts:459–499`），不能仅返回一个 pending JSON 就声称原上下文还在。通用 action 只返回 operationId；manager 完成登录、围栏保存状态后，由原业务 operation 调度检索并提供结果查询，不能在模型端重建一次登录来冒充恢复。

人工接管需新增 challenge 对象和接口（名称待实现评审定稿）：受鉴权图片 GET、答案 POST、取消；绑定 user/account/installation/operation/context generation、随机 nonce，单次消费，短 TTL（初始120秒，按站点期限收敛），禁缓存、禁公共图片 URL。验证码答案不进入模型上下文和日志。用户输一次仍失败就明确停止/重新授权，不在后台循环复用答案。

等待人工期间只保留有界的隔离上下文，不长期占用数据库事务；账户执行权受租约和 generation 控制。TTL 超时、进程重启、取消、卸载或撤权后不能继续旧上下文；恢复只承认同一 operation/fence。MVP 可在进程丢失后要求重新授权，不声称无缝恢复。状态轮询沿已有 setup 节奏，有截止时间，不能让模型一直轮询耗 token。

### 6.2 无头浏览器、出口和频率

复用受限 Docker worker/Playwright，而不是在 Aurora master 中启动任意浏览器。为文献插件固定镜像摘要和 worker digest；本地 OCR 在同一受限 worker 或无网 OCR sidecar 内执行。新插件目标是非 root、Chromium sandbox、只读根文件系统、最小挂载和资源限制，不挂 Docker socket/宿主凭据。**现有微博启动参数含 `--no-sandbox`（`weiboWorkerSource.ts:2456–2464`），不能声称已具备 Chromium 内层 sandbox。** 启用它属于新增镜像、宿主内核和 seccomp/user namespace 兼容验证，计入 M0/PR-C；保留现有 CapDrop/no-new-privileges 等容器限制，不以 privileged 绕过。兼容性未证实前不把这层保护写成通过。Playwright 默认 Docker 示例不能原样作为访问不可信网站的生产沙箱。[官方 Docker 指引](https://playwright.dev/docs/docker)

按 `(userId, pluginInstallationId, accountId)` 隔离；有组织归属时增加服务端推导的 org/tenant 上下文，不能信客户端传 tenantId。每账户独立加密状态，任务独立 BrowserContext、临时目录和下载目录。BrowserContext 不是 OS 安全边界，跨租户不共享已认证浏览器进程；可以复用已有按次独立 worker。Playwright storageState 原生覆盖 cookies/localStorage，可选 IndexedDB，**不自动持久化 sessionStorage**；现有 V5 schema 更严格，确需扩展才增版本，不直接放宽。[Context](https://playwright.dev/docs/browser-contexts)、[认证](https://playwright.dev/docs/auth)

使用稳定可审计出口，确认机房 IP/地区和账号并发登录限制；本轮仅证明 v5-dev 可以取公开 HTTP 页，没有验证生产出口。按账户串行，站点聚合节流也要有；现有 RPC 的60/5分钟、600/小时不是数据库的安全阈值，且读限流 Redis 故障可放行，需新增该站 fail-closed 调度限额。[C4]

建议灰度初值：每账户1个在途任务、每10秒最多1次检索动作、每任务1篇下载、每账户每天最多3次自动登录任务；403/429/冻结即暂停并给出明确原因。数字只是待审试运行配置，必须依据站方许可、配额和 PoC 调整，不能宣称可防封号。遵守 Retry-After，不轮换代理继续冲击；独立账号可减少牵连，但共享机房 IP 仍有全站连带封禁风险。

保留 broker 对导航/重定向/子资源/XHR/下载的统一验证、公网地址 pin 和私网阻断；不因第三方库加载失败就放开整个互联网。下载额外预算按合约声明并审查，不能全局抬高现有32MiB预算。DNS rebinding、非HTTP旁路、Service Worker 要在出口层处理，不能只靠页面 route。[OWASP SSRF](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

### 6.3 检索、结果和下载

建议首期动作：`list_databases`、`search`、`get_record`、`download`。前三项只返回实际可访问、已经适配的库及结构化结果；搜索参数限定 query/数据库/年份/页码/条数。结果含 title/authors/year/DOI（确有才填）/abstract/source URL/source database/accessedAt；缺字段留空，绝不补造。每个库的字段映射、分页和去重分别测试。

`download` 只接受当前账户检索产生的 opaque recordId，不接受任意 URL/文件路径；由服务端解析最终下载位置、逐跳验域名，流式写隔离存储，校验 MIME、magic、大小、hash，防止把登录页当 PDF 成功。PDF 和 CAJ 分开处理；CAJ 不能仅改后缀或承诺现有解析器可读。

输出 `{artifactId, filename, mediaType, size, sha256}`，走既有文件鉴权/短效签名的适配接口；用户点击时重验归属、必要时重签，不把上游认证下载 URL 暴露给模型。Context 关闭会删临时下载，须登记完成后再释放。[Playwright downloads](https://playwright.dev/docs/downloads)

若下载会消耗网站积分/购买配额，须在派发前展示实际消耗并经已有写确认或新增费用确认授权；结果未知不自动重试。MVP 禁自动充值、购买、批量抓取和跨用户全文共享；即使搜索 action 语义只读，也单独统计目标站额度。付费/有副作用下载不能标成无需确认的 read。

## 7. 安全与合规设计

| 对象/边界 | 实施要求与验证 |
|---|---|
| 主密码 | 默认不长期保存；用户选择托管才保存。复用AEAD底层，为 password credential 单设 version/kind/AAD scope，不冒充现有 storageState。仅平台控制面短期解密，将本次登录所需最小口令经attach stdin传入隔离worker；应用根密钥不得进入浏览器worker，明文不写文件/argv/env |
| 会话 | Cookie、localStorage及确需的其它认证状态全部加密；过期/撤权重验；版本和代际绑定，不跨账号套用 |
| 密钥 | 服务端原位使用，不进Git、数据库明文、工具参数或用户容器。记录keyId和可验证的轮转/备份恢复方案；若当前框架不足，单独扩展，不能声称现成外部KMS |
| 日志/遥测 | 不记录密码、Cookie、Authorization、表单体、认证URL查询、完整页面/trace/HAR；只留operationId、阶段、耗时、错误分类、solver及额度。异常报错同样脱敏；扫码/认证截图不作普通附件 |
| 租户与对象授权 | userId由登录/容器身份推导；account、challenge、operation、artifact每次均校验归属和安装状态；组织安装不共享成员私人数据库账号；跨用户ID枚举、旧generation重放均拒绝 |
| 撤销与留存 | 解绑先阻新任务、撤销待办并围栏旧worker，再按批准的留存策略清密文及临时文件；备份有独立到期策略。审计保留操作事实，不保留凭据值；本轮不执行删除 |
| 外部内容 | 文献摘要/页面/文件都是不可信输入；只作检索数据，不执行其指令、不导出密钥；不让网页文本改变出口或读取其它账户 |
| 第三方solver | 独立默认关闭开关、显式用途说明、仅发最小图片；核对处理地区/留存/合同。含姓名等个人信息时先去除，无法安全裁剪就不用该通道 |

应确认网站/下游数据库许可是否允许服务端代理、自动识别挑战、下载和缓存，尤其不把认证凭据等同全文版权授权。是否构成规避技术措施取决于措施用途、权利和授权，不能仅凭“用户账号”下合法结论；合作/API优先。涉及受保护全文的复制和传播需按授权范围处理。[国家版权局法律正文](https://www.ncac.gov.cn/xxfb/flfg/flfg_532/202103/t20210309_50530.html)

个人信息处理需明确目的、最小保存、撤回/删除；委托第三方及可能的境外处理须核对适用义务和具体数据流。solver 裁剪图不必然含个人信息，不能一概认定，但也不能把完整页面/账号随图外发。本文提出工程与法务核对事项，不把未核实的网站条款写成已许可。[个人信息保护法官方正文](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm)

## 8. 里程碑、工作量与 PR 拆分

估算以1名熟悉V5的工程师加独立审查计算，为**工程人日**，不含等用户/站方、安全通道、授权和测试样本的日历时间。完整首库MVP约 **22–35人日**；若PoC发现多层代理/CAJ/二次挑战，重新估算，不把多个数据库包进同一承诺。第三方solver和独立收费另计。每个实现PR对应独立子工单、worktree和验收；本轮只有OCV5-524文档。

| 阶段/拟PR | 范围 | 人日 | 退出条件 |
|---|---|---:|---|
| M0：获准可行性，PR-A证据与定稿 | 安全入口/许可、测试账号低频PoC、首个库、登录与下载链、样本OCR评测、数据契约定稿 | 2–4 | TLS/许可成立，明确一个可用库和成功证据；不成立则暂停该站，产出原因 |
| M1：PR-B账户/setup扩展 | 密码/会话凭据schema、安全输入与加密、lease/fence、撤权；确需SQL时新增迁移 | 4–6 | 模拟站真实浏览器与真实隔离DB；跨租户/密文替换/撤权竞态均拒绝 |
| M1：PR-C字符挑战与OCR | ddddocr固定依赖、OCR事件/预算、两次上限、challenge图片/答案/过期/取消恢复 | 4–6 | 离线测量，模拟站红绿，人工一次接管可继续且不能重放 |
| M2：PR-D首库检索adapter | 固定driver/artifact、网络域与IP、list/search/detail、限频与错误映射 | 4–6 | 授权账号真实结果与用户浏览器相符，无伪造字段/入口 |
| M2：PR-E下载与交付 | 下载artifact、文件检查/配额、费用确认/未知结果、PDF/CAJ边界 | 3–5 | 单篇获准文件真实可打开，hash一致，越权失败，超限/HTML拒绝 |
| M3：PR-F市场与模型入口 | 官方seed/审核、最小CLI结果契约、管理中心、按需技能说明、CCB/Codex适配 | 3–5 | 安装→绑定→自然语言检索→下载闭环，禁用/卸载真生效 |
| M3：PR-G发布证明与小流量观察 | exact worker证明、listing gate/补偿、运维指标和真实验收记录 | 2–3 | 全部适用CI/独审后，另获发布批准才进入发布窗口 |

PR-B/C必要的schema和协议应按依赖顺序合并；不能为了表面拆小而让中间版本将新机密传给旧worker。各PR在边界定义后可部分并行，合并仍按保护分支流程。PR-G涉及发布路径时与前面的产品实现分开，免得未获准真实验证的候选挡住其他功能发布。

可选PR-H：第三方solver，约2–3人日，加供应商审核等待；可选PR-I：插件独立收费，约4–7人日，需报价、钱包与崩溃幂等专审。不默认给首期加作者分成或订阅系统。

**是否个人版先行：**不用为了商业专属listing/计价把整套插件先上线个人版。共享browser/challenge能力先在隔离fixture验证；如修改发布脚本、seed发布门、队列/lease/部署补偿，按V5规则该发布路径部分必须先个人版验证再商业。由于推荐复用微博官方seed/gate，PR-G按个人版先行预留。个人版发布/迁移同样停下等管家转达批准；商业版上线也须用户单独批准。本轮没有任何发布授权。

## 9. 测试与真实验收

### 9.1 自动验证

- 真实隔离DB测试：账户/凭据版本、AEAD AAD防调包、归属、安装撤销、generation CAS、并发登录lease、挑战单次消费、worker迟到更新拒绝；新SQL登记迁移顺序与integ梯队。
- 本地模拟站+真实Chromium：验证码错一次后新挑战成功、两次错误转人工、过期/刷新使旧答案失效、用户输一次恢复、密码错/429立即停止、POST响应丢失不重复提交、取消/重启不继续旧操作。对关键保护做撤掉修复的红绿证明，避免只测实现字符串。
- 网络/文件：重定向到新域/私网/metadata、DNS rebinding、未知origin、跨租户artifact、HTML伪PDF、超大/截断文件、恶意文件名、CAJ不支持、下载额度未知结果。大文件走artifact，不能抬stdout上限蒙混。
- 前端真浏览器：安全输入、验证码显示/一次提交/过期/取消、移动端可操作，秘密不出DOM持久缓存/聊天/日志；CCB与Codex自然语言调用各验一个完整链路。
- 收费若纳入：余额不足不派发；双击/重放/超时/崩溃仅一次结算；失败释放；后台重启恢复预留；独立费用与模型费用各自对账。未选择收费则不做真实扣款试验。

后续测试前先在v5-dev运行 `$H/wait-for-trains.sh --self '<本任务owner>'`；commercial定向测试经现有mutex，列车进来让路；本地不跑commercial/gateway/web-react全量，全量交托管CI。运行相关typecheck/lint、迁移/协议门、fix-trailers和独立Codex方案/代码审查；不削门、不将skip当通过。不在生产库造fixture。本轮仅文档和只读调研，不声称上述测试已经通过。

### 9.2 目标站测量和验收指标

先用经授权、离线保存且无账户信息的至少100张字符样本做初筛，比较基础OCR与必要预处理，记录 exact-match 分子/分母及冷/热延迟；别为凑样本在线连刷100次。本轮只有1张公开类型样本，没有可宣称的OCR基准。

账号可用且安全通道通过后，分时低频做约20次完整链路初验，优先复用会话，分别计：验证码接受率、完整登录成功率、搜索成功率、下载成功率、P50/P95、自动提交次数、人工接管率、403/429/冻结次数及实际费用。样本不足时保留原始分母和失败原因；20次不能证明长期99% SLA。

拟议放行标准（需用户审定，当前未达标）：字符OCR初筛≥95/100；20次代表性检索至少19次成功且每条结果可回查；至少3篇用户指定且许可下载的文件能打开/hash相符；强制制造的验证码两次失败场景全部只提示一次人工接管并正确恢复；跨租户越权、秘密泄漏、重复扣费为0。搜索/下载成功需与用户浏览器同一账号对照，不能仅看worker返回success；真实429/封号不刻意触发，在fixture覆盖，现场出现就暂停。

另验证一次会话过期/撤权和两个独立测试用户隔离；第二身份不能借用cc1或借管理员真实凭据。真实网站未给第二账号时，隔离fixture证明与真实双账号验收分别报告。短期canary后建议7天小流量观察，再逐步增加并发；下载量须在授权额度内，不做压测。

### 9.3 需要用户提供的内容

**本轮不需要提供账号。** 用户审准方案、确认安全入口和授权后，PoC需要一个专用低权限测试账号（有首库检索及少量下载额度）。届时**只提供凭据文件的绝对路径**，不要在聊天、工单或PR贴用户名、密码、Cookie、验证码答案；文件放v5-dev root可读、权限0600的约定目录，由受控loader直接交worker，绝不cat给模型。可提供密码文件或会话文件，但会话导入不能替代传输安全要求。

同时需要指定：最常用的一个实际数据库入口、2–3个代表性检索词、3篇允许下载的文献和每日可消耗额度。账号的站方授权与少量下载许可由用户确认；不代注册、不自动充值。后续真实商业下载/扣费/发布均按该阶段批准范围执行，未批准的不做。

## 10. 生效面和上线条件

本方案的产品实施预计涉及commercial master、web-react dist、CLI/技能的runtime source或platform bundle；浏览器/OCR镜像是独立固定摘要。新增worker依赖需明确安装与镜像制作，不假设普通代码发布自动安装；如修改egress/钱包需按实际diff判断`--egress`，不把所有插件操作都放入模型egress。

涉及migration/env/image/seed激活都单独列审批和证据；新迁移先申领编号并验证旧代码兼容，不在本文猜下一个号。账户升级/回滚沿exact contract和加密重绑，listing尚未开放前保持不可用，真实证明与候选SHA/工件/镜像一致。现有发布路径改动先个人版。新增插件证明不能让无关商业发布依赖一个未准备好的用户账号；采用明确安装/启用条件及离线fixture门，但真实站点功能未验不能公开该插件。

用户批准未来上线后，才按当时最新队列/FIFO/租约执行官方发布；有独立停用listing/停止新任务的方案及账户撤权路径。故障时先限制本插件新任务，不能自行重启全站或借他人的发布owner做回滚。此处是待实施设计，未执行任何生产动作。

## 11. 待审决定

建议用户先审四个决定：

1. 同意先做M0，安全入口/使用许可不成立就暂停jieyoutsg适配，不降低现有HTTPS门。
2. 首期范围为一个真实数据库、单篇授权下载；账号默认只保存会话，密码托管由用户选择。
3. 默认本地OCR、自动提交最多两次、再让用户输入一次；第三方打码默认关闭，多模态不采用OpenAI路线。
4. 先免费安装并限制资源，独立收费和作者分成另立项；正式部署/迁移/激活另等批准。

本轮产出即本方案及公开证据，完成后停止等待审阅。真实登录、OCR成功率、第三方库适配、真实下载、生产可用性与费用验收均未做，不以调研结论替代。

## 12. 固定代码证据索引

以下均为同一商业SHA；链接指向私有仓库，需已有访问权限。行号用于定位，证据是代码行为本身。

| 编号 | 代码位置与支持内容 |
|---|---|
| C1 | [contracts.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/plugins/contracts.ts#L74)：动作/账户/网络合约；L446结果预算，L650起HTTPS及origin约束 |
| C2 | [pluginManifest.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/protocol/src/pluginManifest.ts#L1)：本机清单和http/browser不支持；[plugin-authoring.md](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/docs/plugin-authoring.md)（原文标个人版，须结合商业代码读取） |
| C3 | [marketplaceDb.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/marketplace/marketplaceDb.ts#L2020)：安装事务/版本pin/作用域；该函数未见购买扣费 |
| C4 | [connectors/rpc.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/connectors/rpc.ts#L1)：CLI身份/RPC/限流；L852起runtime分流；[app-connectors技能](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/agent-sandbox/ccb-baseline/skills/app-connectors/SKILL.md)；[ocPluginCli.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/gateway/src/ocPluginCli.ts) |
| C5 | [accounts.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/plugins/accounts.ts#L117)：状态验证；L320加解密，L820起generation/CAS；[runtime.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/plugins/runtime.ts#L1959)：账户lease |
| C6 | [crypto/aead.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/crypto/aead.ts#L1)、[crypto/keys.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/crypto/keys.ts#L1)、[connectors/store.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/connectors/store.ts#L99)：AES/AAD/密钥来源 |
| C7 | [weibo.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/plugins/weibo.ts#L141)：事件和stdin传机密；[weiboWorkerSource.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/plugins/weiboWorkerSource.ts#L269)：验证码停止；[weiboWriteObservability.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/plugins/weiboWriteObservability.ts#L128)：日志策略 |
| C8 | [http/plugins.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/http/plugins.ts#L248)：setup；[weiboSetup.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/plugins/weiboSetup.ts#L55)；[browserBroker.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/plugins/browserBroker.ts#L47)：broker预算；[ocConnectCli.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/gateway/src/ocConnectCli.ts#L494)：out通道 |
| C9 | [marketplaceRoutes.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/marketplace/marketplaceRoutes.ts#L392)：普通发布为声明式；[plugins/review.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/plugins/review.ts#L112)：审核签名 |
| C10 | [seedWeiboPlugin.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/marketplace/seedWeiboPlugin.ts#L240)、[专用发布检查](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/marketplace/marketplaceDb.ts#L744)、[deploy-v5.sh](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/scripts/deploy-v5.sh#L8005)：官方seed/gate/transition |
| C11 | [V5_DEV_PLAYBOOK.md](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/docs/V5_DEV_PLAYBOOK.md)：钱包/生效面/发布纪律；[knowledgePlanetAutomationScheduler.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/plugins/knowledgePlanetAutomationScheduler.ts#L7)：特定自动化模型计费 |
| C12 | [oc-lit技能](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/agent-sandbox/ccb-baseline/skills/oc-lit/SKILL.md)、[literatureProxy.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/literatureProxy.ts#L1)、[literatureSkill.ts](https://github.com/dream-star-end/smart-assistant/blob/c67a9446d931290122d8bdda6776a9106268e39e/packages/commercial/src/literatureSkill.ts#L146)：现有多源/OA能力与旧代理 |
