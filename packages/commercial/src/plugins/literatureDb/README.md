# 文献数据库插件（literature-db，OCV5-524 / OCV5-585）

**现状（2026-10-23）**：商业版已上架并接线（市场 seed、私密 setup、HTTP runtime 检索/下载、自动重登、私有 PDF 交付）。下文从 `policy.ts` 起是 OCV5-524 开发期的设计记录，其中“未接线/未上架”等表述描述的是当时状态，以本段为准。

运行要点（OCV5-585）：
- **错误码**：上游登录页（解忧会员页登录提示、`/e/member/login` 跳转、401）才是 `SESSION_EXPIRED`，只有它会自动重登、重登后仍失效才标 `relink_required`。无订阅/权限页与 403 → `LITERATURE_NO_ACCESS`；429/限流页 → `LITERATURE_UPSTREAM_RATE_LIMITED`；验证码/风控页 → `LITERATURE_UPSTREAM_CHALLENGE`；无法识别的检索页 → `LITERATURE_UPSTREAM_CHANGED`（不当零结果）。万方 gRPC 以 `grpc-status`（头或 trailer 帧）判错。页面标记来自 `ocv5-308/g585-upstream-samples.md` 的只读样本，见 `upstreamClassify.ts`。
- **PDF 暂存**（`artifactStore.ts`）：进程内、按真实字节计（每进程 160MiB / 每用户 80MiB、16 份），发布后 30 分钟到期；需要腾空间时先逐出已保存（owner GET 成功）的文件，再逐出该用户自己最旧的未保存文件，绝不逐出他人未保存文件，否则报 `LITERATURE_ARTIFACT_CAPACITY`（独立码，不再显示为 RATE_LIMITED）。同 owner + 账号实例 + 同篇重复下载复用已校验文件。重启或请求落到另一实例时文件不可见，保存卡经 `GET /api/plugins/literature-db/artifacts/<id>/meta` 显示期限并提示重新下载。documentId 24 小时 ≠ 文件 30 分钟。
- **观测**（`observability.ts`）：每次调用一行 `literature_plugin_call`、暂存事件一行 `literature_artifact`（白名单字段，无检索词/编号/文件名/URL/cookie）。7/14 天聚合：`npx tsx packages/commercial/scripts/literature-plugin-metrics.ts /var/log/openclaude-v5.log* /var/log/openclaude-v5-b.log*`（默认排除测试账号 uid 247，client 类错误单列）。

- `policy.ts` 仅允许精确的 `www.jieyoutsg.com` HTTP80 / HTTPS443，使用共享公网DNS校验。通用HTTPS规则未改。
- `transport.ts` 用已验IP执行一个原生HTTP(S)请求，Host/SNI保留原域，使用一次性Agent，总超时包括DNS，响应限字节。它不跟跳、不重放POST；私有session必须逐跳选择Cookie（尤其不能把Secure cookie降级到HTTP）、重新pin并判断登录结果。Set-Cookie数组不合并拆逗号。
- `credentials.ts` 是严格AEAD seal/open接口，AAD绑定用户/账号/站点/随机seed。此模块不自行持久化；`accounts.ts`已在受信绑定事务中先分配真实connectionId，再加密写入，复用安装授权、generation/CAS与解绑规则。不能把密文放到meta或绕过绑定；真实登录会话工厂尚未接入。
- `captcha.ts` 只向已配置、经用途核对的非OpenAIadapter传合成/裁剪图片、固定诚实提示和输出预算。平台API密钥不进worker。adapter需把供应商拒绝映射为`LiteratureError('MODEL_REFUSED')`，同operation剩余流程不再换云provider。真实官方HTTP协议见`officialCaptchaReader.ts`，但没有服务启用配置或真实模型调用，也没有产生模型费用。
- `login.ts` 持有原私有session，默认最多4次自动表单提交、2次云调用、6次账户operation/小时；人工答案只消费一次。未知POST结果先probe一次，不能确认就停；取消/期限和清理屏障限制迟到结果。清理失败保留账户占用，shutdown不把未清理资源当成功。重启不恢复内存operation，不重放提交。
- `persist(state, context)` 是受信平台回调，必须在账户事务里检查同installation/owner/generation和撤权状态。`isCurrent()`/signal只辅助进程内检查，不能替代数据库CAS。登录manager的stub测试与独立临时PostgreSQL中的账户绑定/CAS事务测试分别覆盖各层；真实站点会话到这些事务的装配仍未实现。

自动化验证使用合成凭据、合成图像、模拟私有session、独立临时PostgreSQL和回环HTTP socket；测试request factory是受信依赖注入，没有生产allowPrivate开关。开发机离线OCR bundle及合成识别实跑已通过，不代表本站准确率。TLS选项有断言，尚无本站TLS证书握手证明。指定凭据文件路径已收到，首次私密观察只完成匿名GET、没有登录POST或检索/下载成功证明。任何凭据内容不得出现在聊天、PR、日志或模型上下文。

`officialCaptchaReader.ts` 使用固定Claude/Gemini官方图片API协议，每次调用重选现有平台API-key池（claude/gemini），无env/OAuth回退、无用户模型扣费。`createCatalogCaptchaResolver`默认每次`getModelCatalogCache().assertFresh().resolve()`，只承认当前ccb/anthropic/vision及精确型号绑定，并要求另行服务端用途批准；当前catalog没有官方Gemini机制，因此Google resolver返回不可用。Google协议仅fixture验证，不冒充现有Gemini Go已支持图片。必须提供持久化平台用量sink和全局资源限额后才可服务启用；目前没有生产接线，也未读取实际可用API key。

明确供应商拒绝优先于答案/缺usage/计量超时，不能通过换provider继续。body最多64KiB、一次fetch、禁止跟跳、总计15秒，错误不含raw响应。meter事件只含本地随机ID、provider/model、整数usage和结果分类，不含图像/答案/key。Gemini prompt包含缓存子集；Claude缓存输入分量分开。密钥池返回JS string只能缩短引用，不能声称可靠清零。

供应商拒绝路径必须立即返回给solver锁存；用量sink/健康报告异步消费，不能等待挂住的sink让外层15秒期限覆盖拒绝。普通成功必须等sink确认后才返回答案；取消后meter仍被调度且迟到拒绝被消费，但当前没有持久化队列，不能宣称进程崩溃时的供应商用量已经完整入库。持久化reservation与额度模块见`platformUsage.ts`；它不等于供应商finish事件的持久化队列，实际服务工厂仍未装配。

`jieyouHttpClient.ts`是私有预登录客户端：parse5按name解析真实表单/hidden/验证码路径，lifetime必须从实际选项显式选取，不猜CMS值；每实例独立tough-cookie jar并逐跳选cookie，HTTP不发送Secure cookie。只收同站点受pin约束的请求，GET最多3次重定向，challenge一次消费、POST绝不自动跟跳/重放。close中止在途并清空jar。原始page/response/cookie snapshot是私有证据，不得作为模型结果或公开管理API返回；snapshot并不证明登录成功。当前没有实现真实身份/错误分类或LiteratureLoginSession适配；Cookie与凭据DB事务已提供内部接口，真实会话保存仍须测试账号校准。

parse5/tough-cookie已显式加入commercial runtime依赖，锁定现有8.0.1/6.0.1及原有传递版本；没有借dev依赖冒充生产可用，也未修改无关web包锁项。未来正常发布staging npm ci处理依赖，本轮未部署。

真实公开页（2026-10-19）使用<table><form>旧布局，parse5修复树后form为空、控件都不在其后代。解析器因此使用固定8.0.1 Parser的实际form指针，在节点插入时记录input/img归属；不扫描全页猜关联。真实关闭标签之后的控件、template和script/comment伪标签不会并入；本站未观察到的显式form=覆盖先拒绝。这一小适配依赖parse5 internal API，升级必须过旧布局/关闭边界回归。公开GET解析成功也不是登录成功或市场可用证明。


`platformUsage.ts`提供平台费用专用Postgres begin/finish sink：所有本地校验/选key通过后，必须先COMMIT新的reservation才准一次fetch。同IDbegin重复拒绝；全局500/用户20次UTC日上限，同用户operation最多4次全生命周期（受信服务配置，可收紧）。未知、拒绝、取消和进程崩溃均占额度，不自动退款；六分量usage未知留NULL，不能视为零成本。finish校验owner/operation/provider/model，完全相同重放幂等，冲突不覆盖。删除用户仅匿名保留global计数，解绑/卸载也不能退额度。未声称全局并发限制、token硬额度或精确货币账单；没有任何用户钱包/ledger调用。

新增0316迁移与空表rollback仅供评审，未apply生产；它声明order-dependency 0315_commercial_reviewer_off_zai（#902），须在其后合并与apply。rollback拒绝丢弃已存在的用量；先停服务并保留审计历史才可另行批准清理。私密setup入口已存在，但尚无真实reader/session工厂创建这个meter，HTTP runtime也未接入；尚未配置用途批准的模型绑定，也没有实际付费模型调用。refusal仍立即锁存，异步finish失败时reservation留unknown；不冒充完整供应商用量durable消息队列。

`accountState.ts`定义独立的`jieyou-http-cookies-v1`私有格式，不导入tough-cookie的jar options/store。仅允许精确本站及显式父域cookie，校验own data fields、64条/32KiB限额、属性/前缀/绝对日期，恢复时新建固定严格jar；旧通用browser secure/HTTPS验证器不变。客户端收cookie时将Max-Age按本次receipt转为绝对expires，读取或恢复不会延期；Session cookie仍为session标记；持久化HTTP envelope已强制`verifiedAt`/`expiresAt`和最多24小时的非滑动绝对期限，读取/刷新Cookie不能续期。raw cookie jar格式没有真实用户迁移负担，直接拒绝。receipt只忽略无本站域权限且已有效过期的显式外域删除Cookie，不存储/发送外域状态，不改变本站删除或存储状态校验；live foreign Cookie仍拒绝。codec只证明状态格式，不证明身份。

首次setup在LoginOwner中使用`kind:setup + userId + 固定site`，与真实accountId分开；并发与每小时起次按用户和站点聚合，operation ID由manager生成。受信`bind`事务已提供真实账号分配及加密凭据持久化，不伪造accountId或预建active账号。私密setup路由与设置表单已接入，包含归属、挑战图片、人工一次与取消边界；缺少真实session工厂时，在授权前返回`UNAVAILABLE`，不假装已经保存真实登录会话。

本地验证仅可使用任务专有临时PostgreSQL实例和私有网络命名空间；即使使用dedicated数据库helper，也须将其base/admin连接指向该独立实例，禁止默认共享测试库。详见H交接和独立runner审计证据。

`builtinArtifact.ts/builtinContract.ts`定义尚未上架的0.1.0固定search/download接口（有界查询、opaque文献/平台文件编号，不收发任意URL/凭据）。compiler仅完整artifact hash匹配才生成本站HTTP transport/state discriminator；复制slug/driver不够。旧artifact不生成新字段，compiler version仍1。loader还要求平台review_source及原有效签名/功能核验/未撤销条件。

`accounts.ts`仅为该精确HTTP合同选择严格Cookie state，复用现有connections AEAD/AAD、bind锁/安装授权、generation/revision/CAS和撤销；原browser解密API及secure:true/HTTPS验证器保留，HTTP有专用解密器，不能走旧browser版本迁移。最终HTTP提交额外重新检查平台来源，防止审核来源在执行期间变化。固定HTTP envelope现可同事务保存绑定真实connectionId的credentialSeal；refresh保留、replace默认清旧、replay保留最新seal，revoke擦除密文。HTTP envelope的24h非滑动TTL与私密setup服务/API/表单已实现，但未装配真实登录工厂，未保存真实用户凭据。没有市场seed、HTTP runtime执行或真实身份判断，合同及私密管理入口存在不代表可安装/可执行。integ中functionalVerified:true只指独立临时DB里的合成fixture，绝不是真实站点验收。

`LiteratureLoginManager`现在只接受每operation的同步solver factory；它收到冻结的owner副本和manager内部生成的真实operationId，在session open前构造一次。一个manager仍统一执行容量/频控，不能按operation新建manager；生产factory必须用同一userId+operationId绑定所有reader与持久化meter。自动重试复用局部solver和预算，取消/绝对期限已到时不构造reader；factory失败用原清理路径释放占用。仅合成官方fetch+独立DB用例证明两个用户交错和重试归属，尚无真实reader/session工厂的服务装配。

`requestToSink` 是内部单跳有界原始流：固定25MiB实际字节上限，保留DNS/pin、Host/SNI、TLS、期限和不跟跳/POST不重放语义。pipeline向独占Writable传播背压；成功、错误与取消都等待consumer、sink清理和物理socket关闭。sink必须是新建的受信流；有原生资源的sink保留默认autoDestroy/emitClose并在`_destroy`排空自己的I/O（如原生fs.WriteStream）；本层不接受文件路径，失败partial由调用方删除。status/headers/bytes不是有效PDF或artifact证明，格式/账号/租约/ready发布仍未接线；旧buffer路径仍默认1MiB、最大8MiB。

The offline CPU reader uses a trusted, server-owned absolute bundle root containing
`venv/bin/python` (Python 3.12) and `runner.py` copied from `localCaptchaRunner.py`.
Build the Linux x86_64 bundle from the eight exact wheels in
`localCaptchaRequirements.lock`; verify complete wheel hashes before an offline
`--no-index --require-hashes --only-binary=:all: --no-deps` install, run `pip check`,
and preserve every wheel's LICENSE/NOTICE. Never install or download models at
request time. The worker also checks its pinned model, charset and SDK source.
A development bundle or synthetic smoke does not prove target-site accuracy.
Production bundle/configuration and marketplace activation require separate approval.

Each recognition owns one short-lived process, private pixel stdin and <=256B JSON
stdout. It inherits no service environment or credentials. Limits are 15s wall,
10s CPU time and 2GiB virtual address space, with one worker slot per service process.
The pinned SDK lacks a SessionOptions hook, so only this worker temporarily supplies
ORT's explicit single-thread session options and restores the original constructor.
The limits and actual resource use must be verified for the target bundle; address
space is not a promise about RSS or a platform-wide CPU quota. Cancellation sends
TERM then KILL after 100ms and waits for actual process/stdio close before releasing
capacity. Login cancellation, expiry and shutdown also wait for that local cleanup;
cloud readers retain bounded cancellation even if they ignore their signal.
