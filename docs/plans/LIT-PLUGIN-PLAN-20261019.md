# Aurora 文献数据库插件实施方案 v2

2026-10-19，OCV5-524，用户16:46审阅意见已采纳。PR #883继续用于本任务；商业版上架/发布尚未批准。

## 用户已定决定

- 仅使用 http://www.jieyoutsg.com；允许该站明确、可审计的HTTP登录例外，不全局放宽。凭据仍加密、不入日志。HTTP最后一段存在明文风险已经明确，由本次用户决定接受该站例外，不再以TLS作为开发阻断。
- 验证码目标全自动：优先平台自有且条款允许的非OpenAI多模态模型；本地OCR可快速首选或兜底。总计最多4次自动表单提交、多次失败才让用户输入一次，密码错/冻结/429等仍立即停止。不能把识字正确率当登录成功率。
- 账号由用户以文件提供，只接收绝对路径，不能回显内容。先做无账号部分，拿账号后适配实际检索/下载并真实验收。
- 首期免费安装、资源限额；正常PR/测试/独审/CI。上架、部署、激活、生产迁移前另报等批准，绝不抢发布队列/测试锁，不用cc1。

## 原调研保留事实

商业源码研究基线c67a9446d931290122d8bdda6776a9106268e39e。已有managed-browser的签名/账号加密/lease/fence/CLI可复用；但现有默认仅HTTPS，不可通过改共享normalizeHttpsOrigin放开所有插件。旧官方工件的compilerVersion及hash保持不变。

目标站公开首页转/e/member/login/；表单POST /e/member/doaction.php，username/password/key/lifetime；输入id与name反置，应按name定位。验证码/e/ShowKey/?v=login，一张样本为47×20字符JPEG，未解答/未登录。下游检索/下载域名、会话绑定、次数、按篇扣点和许可均待专用账号实测，不猜CNKI/万方等入口。

现有browserRuntime.runAction返回即销毁上下文，人工验证码须由独立login/setup-operation manager持有原会话；不能返回pending JSON后假定context仍在。微博worker使用--no-sandbox，新worker的sandbox能力单独验证。根密钥只在控制面使用，最小口令经私有stdin通道传worker，不入action参数。

现有oc-vision默认Grok；商业Gemini Go桥不接收图片；不能换model字符串冒称Claude/Gemini识图已可用。非OpenAI新solver接显式平台推理adapter，逐一核实实际模型能力与供应商用途政策。Anthropic/Google对第三方限制绕过有禁止条款，尚无该场景专门允许证据；不使用Claude in Chrome的验证码路线，也不以普通图片API绕Computer Use确认决策。无合规已配置adapter时可走用户已允许的本地OCR及人工，不调用OpenAI、不从用户模型回合暗扣识别费。

政策证据：[Anthropic AUP](https://www.anthropic.com/legal/aup)、[Claude Chrome安全](https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely)、[Gemini Computer Use](https://ai.google.dev/gemini-api/docs/computer-use#safety-and-security)、[Google Cloud agent指引](https://cloud.google.com/terms/agentic-ai-use-guidelines)。政策核对日期2026-10-19；没有专门允许证据不等于已经全面认定禁止所有图片OCR。

## 当前第一阶段：无账号登录底座（本轮先完成）

在plugins/literatureDb/内完成以下窄模块及行为测试，不改生产、不注册未验证listing，不伪造functionalVerified。原有QR插件、通用HTTPS和现有模型路由不变。

1. policy.ts：固定site origin为http://www.jieyoutsg.com:80；拒user-info、额外端口/裸域/子域/相似域/非http(s)协议；HTTPS该host也可用。每次请求/重定向都校验，复用resolvePinnedAddress全部A/AAAA公网检查，执行连接固定到已验IP。允许GET/HEAD/POST，绝不从用户输入扩展域名。
2. credentials.ts：严格versioned username/password schema；复用AEAD和loadKmsKey/zeroBuffer，AAD绑定userId/accountId/site随机seed。先提供可测seal/open接口，后续只通过现有账户绑定/撤权事务持久化；不能另建无授权凭据旁路，也不能提前声称已经持久保存用户账号。未知字段拒绝，秘值不入异常。
3. captcha.ts：窄inference adapter只有provider/model/图像/signal，平台配置用途核对后启用。OpenAI/GPT路线硬拒，不接任意URL，图片字节/尺寸/格式和答案长度/字符限制；固定诚实用途提示、无工具/无账号/无历史，超时/拒绝不无限重试。注入本地OCR作为可选首选/兜底。识别预算按请求数/超时控制，后续真实平台推理还须资源计量，不对免费安装用户暗扣。
4. login.ts：持有原session的多用户operation manager，原始图片仅通过user/op/challenge鉴权取用；每账号单飞、全局容量、随机挑战ID、TTL、一次消费；自动最多4次提交，captcha明确错才重试、每次新图。未知提交结果先probe，禁止盲重发。两次读同挑战、重复答案、跨租户请求、取消、超时、关机均可验证。人工只输入/提交一次，失败明示；private session负责保存成功state并在关闭前确认完成，错误输出只白名单code。
5. transport.ts：受固定policy约束的原始HTTP/HTTPS表单客户端（不执行网页JS），连接用已验pin，cookie严格限制到该host并防header注入，重定向逐跳验证；POST不能携口令跨origin或被307自动重发，读字节/超时受限；没有为fixture放开生产私网。后续真实worker可沿同策略实现浏览器absolute-form HTTP relay，保留network=none与broker，不复用微博只支持CONNECT的relay冒称HTTP浏览器可用。

第一阶段是真实可调用/测试的登录底座，不是已经完成产品接线。尚不把它当runtime已支持HTTP、市场已可装或网站已可用。

## 后续阶段（持续推进；依账号才能确定站点结构）

- worker/setup/runtime接线：文献专用driver/launcher、private credential与challenge/answer帧、账户envelope显式版本、同账户lease与generation/CAS；HTTP例外仅新artifact显式签入，driver maximum也核对，旧hash不动。新worker HTTP absolute-form GET/POST通过broker到已验pin，旧QR插件不动。不能给所有artifact加默认字段或全局bump编译器导致POLICY_STALE。
- 管理中心：新增密码/会话授权与验证码接管UI，不能回落知识星球QR弹窗；图片no-store、短效、无公共URL，密码与答案不进聊天。
- 账号到位后：只取该账号可见的实际入口，按真实字段实现list_databases/search/get_record；逐库域名、重定向与权限准确登记，未适配项明确不可用，不猜链接。
- 授权单篇下载：服务端只收opaque recordId，流式文件artifact交付，MIME/magic/hash/大小/租户校验；HTML登录页不能当PDF，CAJ分开处理。若目标站按篇扣点，用户确认后派发，不自动充值或重发未知结果。
- 官方market seed和listing gate：复用审核/签名/功能证明，无真实站点验收不开放；免费安装，账户/站点限流，OCR/多模态平台成本独立记量。自动识别次数默认4、单次模型15秒、每任务总自动阶段60秒、manual TTL120秒，均为待实测初值。

## 测试、审查与发布边界

第一阶段用合成机密/图像和独立模拟session测试正常流、错误密码/429立即停止、4次上限、新图、人工一次、归属、并发、过期、取消/迟到回调、AAD调包、禁止OpenAI/错误输出/超时、SSRF/重定向/pin和资源上限。fixture网络只通过测试注入，不放宽生产policy。保护性质用真实反例与红绿对照，不写镜像实现的浅测试。

改码前正式Codex审此方案，通过后根唯一写码；code diff再独审到通过。commercial定向测试先wait-for-trains并经mutex，typecheck/lint与协议门；本地不跑commercial/gateway全量，CI全量。已存在失败用实证归因，不削门、不增豁免/待证明名额、不把skip当通过。

后续真实验收分别报告验证码exact-match/接受率/完整登录率、搜索/下载分子分母、P50/P95、人工率和403/429，样本不够不承诺99%SLA。低频分时操作，账号/口令仅凭据文件路径、无注册/暴力测试/cc1。正式功能验收、发布批准与代码测试通过分开报告。

开发依赖模块、worker/setup、UI、检索、下载、上架证明仍按原约22–35人日估算，依真实入口复杂度调整；第一阶段范围缩小不代表整个插件已经完成。发布路径若变更先个人版验证，但个人发布/生产迁移也需批准；本轮无任何部署授权。进度写H/CONTINUE-20261019-OCV5-524-lit-plugin-plan.md，PR保留draft，拿到账号继续真实适配；上架/发布前汇报。

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
