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
4. login.ts：持有原session的多用户operation manager，原始图片仅通过user/op/challenge鉴权取用；每账号单飞、默认每账号每小时最多6个登录operation、全局容量、随机挑战ID、TTL、一次消费；自动最多4次提交，captcha明确错才重试、每次新图。未知提交结果先probe，禁止盲重发。两次读同挑战、重复答案、跨租户请求、取消、超时、关机均可验证。人工只输入/提交一次，失败明示；private session负责保存成功state并在关闭前确认完成，错误输出只白名单code。
5. transport.ts：受固定policy约束的原始HTTP/HTTPS表单客户端（不执行网页JS），连接用已验pin，防cookie头注入并保留Set-Cookie数组给私有session；本层只执行单跳请求并验证Location，不自动跟跳或重发POST，session后续按domain/path/secure选择cookie、逐跳重验和重新pin，读字节/超时受限；没有为fixture放开生产私网。后续真实worker可沿同策略实现浏览器absolute-form HTTP relay，保留network=none与broker，不复用微博只支持CONNECT的relay冒称HTTP浏览器可用。

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

## 第二批无账号实现与后续验收边界

[官方图片API适配预审方案](OCV5-524-OFFICIAL-CAPTCHA-ADAPTER-PLAN.md)已通过独立方案审查后实施；固定Claude/Gemini官方协议、每次从既有平台API-key池选key、不env回退，显式平台用量sink，不扣免费插件用户。当前目录只有可核验的官方Claude机制；Gemini Go不支持图片且不是官方generateContent，不将其伪装为已接线。本批Google仅协议fixture，不新增目录/生产配置。Claude默认fresh resolver读取唯一catalog cache的assertFresh、精确ccb/anthropic/vision与model/upstream绑定；目录可路由不等于用途批准，两者均需当前有效。

## 第三批：私有预登录客户端

[第三批实施预审](OCV5-524-JIEYOU-HTTP-CLIENT-PLAN.md)已APPROVED后实现真实HTTP私有客户端：parse5解析表单、显式runtime CookieJar、同会话挑战、逐跳pin/选cookie、一次性POST、取消与资源预算。hidden/lifetime/Submit值运行时取，不用未归档的CMS默认常量。尚未向目标站提交凭据/POST，也未把返回200/Cookie/退出链接认作成功。该客户端尚不等于整个LiteratureLoginSession或产品接线；账号到位后校准实际身份/错误页及下游。

先验证原生HTTP是否足够；若足够，在如实签入HTTP例外/会话类型的固定官方driver执行分支内复用安装/审核/租户/lease/CAS门，不必为了静态表单先引浏览器。若真实库需JS，再实现受限浏览器HTTP relay。不能从新产品HTTP路由直接绕过runtime校验开跑。依赖锁变更沿正规发布staging npm ci处理，不手改生产安装。

## 公开页实测带来的解析修正

54项fixture通过后，一次真实匿名GET发现旧表格表单的DOM归属差异：parse5将form置为table内空元素，12个控件都在form外。已补实际结构元数据（无字段值/Cookie），并通过独立修正方案预审。按锁定parse5版本的解析时form指针关联真实控件，保留唯一form、精确地址/字段/重复拒绝；不靠全页扫描或正则猜归属。internal API局限明确，升级需回归。新增旧表格、真实关闭边界、script/template伪标签与显式归属覆盖测试；仍无账号、真实登录POST或检索下载。

## 商业体系与拆分细化（16:46决定后的现行版本）

- 服务端采用官方managed-browser/固定driver和受签工件，而非用户上传任意JS。现有本机plugin.json不支持browser/http组件，声明HTTP蓝图也不能表达等待验证码的登录生命周期。工具沿app-connectors→oc-plugin catalog/list/call→容器双因子RPC→安装/签名/账户lease→受限worker，不假定所有模型自动原生注册工具。
- 市场install固定版本/hash与agent作用域；账号connections保存受限storageState，现有严格schema不能塞password/HTTP cookie。新字段或envelope必须显式版本，维持锁序、generation/CAS、撤权和兼容性，管理API不投影secret。新账号setup draft与真实connectionId分开，INSERT RETURNING id后同事务seal/write，不能bind返回后另事务补密码。
- 微博可复用attach stdin、日志白名单、签名/审核/lease；验证码停止、QR setup和返回即清理不能照搬为字符challenge。下载不走stdout大JSON。现有通用安装未实现插件购买/按次扣费/作者分成；第一期确定免费，不新增钱包扣款。

| 识别方案 | 本站成功率 | 成本与延迟 | 当前采用及限制 |
|---|---|---|---|
| 本地ddddocr | 未测，单张公开样本不能保证4位数字 | 无按次API费；CPU/内存/初始化成本，预热≤1秒仅目标 | 可快速首选/兜底，固定依赖与模型；尚未安装或测真实OCR |
| 平台非OpenAI多模态 | 未测；字符对不代表登录成功 | 按实际图片输入/输出token和请求数计平台成本；单次15秒超时，不是实测延迟 | 用户优先路线，逐模型/机制/用途核对；只发裁剪图、无账号/历史/tools，明确拒绝停止云尝试 |
| 第三方打码 | 无本站独立验证 | 按挑战尝试数、非检索次数；公开报价不等于端到端SLA | 默认关闭，不作为第一期依赖，另核供应商处理地区/留存和用途 |

本地说明：[ddddocr](https://github.com/sml2h3/ddddocr)、[MIT许可证](https://github.com/sml2h3/ddddocr/blob/master/LICENSE)。第三方调研参考：[2Captcha报价](https://2captcha.com/pricing)、[Anti-Captcha图像任务](https://anti-captcha.com/apidoc/task-types/ImageToTextTask)，2026-10-19调研原报价普通字符图约US$0.50–1/千次，未采购、未实测。真实模型成本应记录输入、输出、缓存、拒绝和失败尝试，再除以成功登录数；没有已批准目录与用量样本时不猜单次成本/成功率。

无头浏览器拟固定出口、每账户独立context/profile/cookie jar、单飞lease；不轮换IP规避封禁。每用户/账号/站点节流与全局CPU/内存/下载字节配额独立，403/429/冻结即停。当前HTTP原生客户端不执行JS；是否需要Playwright及具体下游脚本，等账号实测。若需浏览器，必须实现HTTP absolute-form受限relay和network=none隔离，不能沿微博443 CONNECT改端口冒称完成。当前微博--no-sandbox，新增sandbox能力未验证。用户接受本站HTTP最后一段明文风险；例外精确白名单，不关闭TLS证书验证。

| 里程碑/提交批次 | 人日估算 | 退出条件 |
|---|---:|---|
| A 无账号底座与明确API协议（当前PR883） | 3–5 | 合成机密/模拟网络、定向测试、独审、CI；不宣称可安装 |
| B 账号/setup事务、worker私有通道、管理中心 | 5–7 | 真实隔离DB与浏览器夹具；撤权/租户/generation围栏，秘密不入聊天/日志 |
| C 获准账号登录及首个实际库检索/detail | 4–6 | 真实身份标记、字段/分页与用户同账号浏览器对照；不猜第三方域名 |
| D 单篇下载artifact | 3–5 | opaque recordId、逐跳白名单、magic/MIME/hash/大小、归属；HTML伪PDF拒绝，CAJ单列 |
| E 市场/模型CLI/真实证明/发布准备 | 4–6 | 免费install→绑定→自然语言检索→下载，CCB/Codex各实验；尚未获批不开放listing |
| F 独审修正、CI与低频观察 | 3–6 | 独审APPROVED、适用CI全过、用户真实验收；另报商业上架/发布批准 |

仍按完整首库约22–35工程人日评估，实际下游复杂度和等待账号时间另计。当前使用同一任务WT/PR继续；后续独立子票按一票一WT一PR拆，保持依赖顺序，不以拆分绕开完整机密/协议边界。若改发布脚本/seed门/队列/部署补偿，其发布路径部分先个人版验证，整套商业插件不必个人版先上；个人版发布同样要批准。

真实验收仅接收v5-dev凭据文件绝对路径（不要贴用户名/口令/Cookie），受控loader使用文件而不cat给模型。账号到位后低频确定正向身份标记，公开登录页本身就有退出链接，不能以退出链接/200/有Cookie判登录成功。先用用户指定代表性检索词和少量可下载文献，分别记录验证码接受率、完整登录率、检索/下载分子分母、P50/P95/人工率和403/429。若按篇扣站方额度须用户确认，不充值、不盲重试未知购买/下载结果。

建议小样本验收目标：至少20次分时代表性检索中19次成功、至少3篇获准文件可打开且hash匹配；不为凑样本刷验证码，强制错误/429/封禁在fixture测。统计目标待样本实测收敛，20次不能承诺99%长期SLA。跨用户隔离、AAD调包、撤权/CAS、挑战重放、POST丢响应、DNS重绑定、私网跳转、artifact越权与超限都要自动测试；真实双账号未获提供就明确列缺口，不借cc1。发布前再给候选SHA/工件/镜像/迁移/env生效面、真实证明、回滚/停用路径和未覆盖项，等待批准。

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


第四批不依赖账号的资源实现：[平台免费验证码计量预审](OCV5-524-PLATFORM-CAPTCHA-METER-PLAN.md)已APPROVED。每次模型fetch前先持久化新request ID的quota预留，默认全局500/用户20次UTC日、operation4次全生命周期；失败未知不退款，同ID不准再次外发。finish只填现有同归属记录，实际六项tokens可未知，无用户扣费。删除用户匿名保留global记录。拟新增0313迁移/rollback与requiredMigrations登记均未应用生产，小号0310–0312的未来商业迁移顺序必须先解决。验证结果见PR/交接，不把模块存在当产品已接线。
