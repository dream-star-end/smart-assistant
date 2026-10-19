# 文献数据库登录底座（OCV5-524）

这一阶段是未上架的内部底座，不是已经可安装使用的插件。生产HTTP路由、账号绑定/撤销事务、worker/driver、前端、平台推理服务启用与计量持久化、登录后检索/下载尚未接线；不能把这些接口的fixture通过当真实站点验收。

- `policy.ts` 仅允许精确的 `www.jieyoutsg.com` HTTP80 / HTTPS443，使用共享公网DNS校验。通用HTTPS规则未改。
- `transport.ts` 用已验IP执行一个原生HTTP(S)请求，Host/SNI保留原域，使用一次性Agent，总超时包括DNS，响应限字节。它不跟跳、不重放POST；私有session必须逐跳选择Cookie（尤其不能把Secure cookie降级到HTTP）、重新pin并判断登录结果。Set-Cookie数组不合并拆逗号。
- `credentials.ts` 是严格AEAD seal/open接口，AAD绑定用户/账号/站点/随机seed。此层不自行持久化；后续必须通过已安装账户的授权、generation/CAS、解绑事务接入，不能把密文放到meta或绕过绑定。
- `captcha.ts` 只向已配置、经用途核对的非OpenAIadapter传合成/裁剪图片、固定诚实提示和输出预算。平台API密钥不进worker。adapter需把供应商拒绝映射为`LiteratureError('MODEL_REFUSED')`，同operation剩余流程不再换云provider。真实官方HTTP协议见`officialCaptchaReader.ts`，但没有服务启用配置或真实模型调用，也没有产生模型费用。
- `login.ts` 持有原私有session，默认最多4次自动表单提交、2次云调用、6次账户operation/小时；人工答案只消费一次。未知POST结果先probe一次，不能确认就停；取消/期限和清理屏障限制迟到结果。清理失败保留账户占用，shutdown不把未清理资源当成功。重启不恢复内存operation，不重放提交。
- `persist(state, context)` 是受信平台回调：真实DB实现必须在账户事务里检查同installation/owner/generation和撤权状态。`isCurrent()`/signal只辅助进程内检查，不能替代数据库CAS。基础测试只证明stub被正确调用，不宣称真实DB围栏通过。

验证使用合成凭据、合成图像、模拟私有session和回环HTTP socket；测试request factory是受信依赖注入，没有生产allowPrivate开关。TLS选项有断言，尚无本站TLS证书握手证明。待管家提供凭据文件绝对路径后继续真实适配；任何凭据内容不得出现在聊天、PR、日志或模型上下文。

`officialCaptchaReader.ts` 使用固定Claude/Gemini官方图片API协议，每次调用重选现有平台API-key池（claude/gemini），无env/OAuth回退、无用户模型扣费。`createCatalogCaptchaResolver`默认每次`getModelCatalogCache().assertFresh().resolve()`，只承认当前ccb/anthropic/vision及精确型号绑定，并要求另行服务端用途批准；当前catalog没有官方Gemini机制，因此Google resolver返回不可用。Google协议仅fixture验证，不冒充现有Gemini Go已支持图片。必须提供持久化平台用量sink和全局资源限额后才可服务启用；目前没有生产接线，也未读取实际可用API key。

明确供应商拒绝优先于答案/缺usage/计量超时，不能通过换provider继续。body最多64KiB、一次fetch、禁止跟跳、总计15秒，错误不含raw响应。meter事件只含本地随机ID、provider/model、整数usage和结果分类，不含图像/答案/key。Gemini prompt包含缓存子集；Claude缓存输入分量分开。密钥池返回JS string只能缩短引用，不能声称可靠清零。

供应商拒绝路径必须立即返回给solver锁存；用量sink/健康报告异步消费，不能等待挂住的sink让外层15秒期限覆盖拒绝。普通成功必须等sink确认后才返回答案；取消后meter仍被调度且迟到拒绝被消费，但当前没有持久化队列，不能宣称进程崩溃时的供应商用量已经完整入库。该队列/预算是服务启用前的接线依赖。

`jieyouHttpClient.ts`是私有预登录客户端：parse5按name解析真实表单/hidden/验证码路径，lifetime必须从实际选项显式选取，不猜CMS值；每实例独立tough-cookie jar并逐跳选cookie，HTTP不发送Secure cookie。只收同站点受pin约束的请求，GET最多3次重定向，challenge一次消费、POST绝不自动跟跳/重放。close中止在途并清空jar。原始page/response/cookie snapshot是私有证据，不得作为模型结果或公开管理API返回；snapshot并不证明登录成功。当前没有实现真实身份/错误分类、LiteratureLoginSession适配或DB保存，须测试账号校准。

parse5/tough-cookie已显式加入commercial runtime依赖，锁定现有8.0.1/6.0.1及原有传递版本；没有借dev依赖冒充生产可用，也未修改无关web包锁项。未来正常发布staging npm ci处理依赖，本轮未部署。

真实公开页（2026-10-19）使用<table><form>旧布局，parse5修复树后form为空、控件都不在其后代。解析器因此使用固定8.0.1 Parser的实际form指针，在节点插入时记录input/img归属；不扫描全页猜关联。真实关闭标签之后的控件、template和script/comment伪标签不会并入；本站未观察到的显式form=覆盖先拒绝。这一小适配依赖parse5 internal API，升级必须过旧布局/关闭边界回归。公开GET解析成功也不是登录成功或市场可用证明。


`platformUsage.ts`提供平台费用专用Postgres begin/finish sink：所有本地校验/选key通过后，必须先COMMIT新的reservation才准一次fetch。同IDbegin重复拒绝；全局500/用户20次UTC日上限，同用户operation最多4次全生命周期（受信服务配置，可收紧）。未知、拒绝、取消和进程崩溃均占额度，不自动退款；六分量usage未知留NULL，不能视为零成本。finish校验owner/operation/provider/model，完全相同重放幂等，冲突不覆盖。删除用户仅匿名保留global计数，解绑/卸载也不能退额度。未声称全局并发限制、token硬额度或精确货币账单；没有任何用户钱包/ledger调用。

新增0313迁移与空表rollback仅供评审，未apply生产。rollback拒绝丢弃已存在的用量；先停服务并保留审计历史才可另行批准清理。个人0310–0312已占，未来商业apply必须先解决小号合并/迁移顺序。本批仍没有已鉴权setup/runtime入口创建这个meter，尚未配置政策批准路由，也没有付费模型调用。refusal仍立即锁存，异步finish失败时reservation留unknown；不冒充完整供应商用量durable消息队列。

`accountState.ts`定义独立的`jieyou-http-cookies-v1`私有格式，不导入tough-cookie的jar options/store。仅允许精确本站及显式父域cookie，校验own data fields、64条/32KiB限额、属性/前缀/绝对日期，恢复时新建固定严格jar；旧通用browser secure/HTTPS验证器不变。客户端收cookie时将Max-Age按本次receipt转为绝对expires，读取或恢复不会延期；Session cookie仍为session标记，后续持久化服务必须另加会话TTL。raw cookie jar格式没有真实用户迁移负担，直接拒绝。codec只证明状态格式，不证明身份。

首次setup在LoginOwner中使用`kind:setup + userId + 固定site`，与真实accountId分开；并发与每小时起次按用户和站点聚合，operation ID由manager生成。首次登录成功后的真实账号分配/加密凭据持久化仍须受信bind事务，不伪造accountId或预建active账号。当前未开放setup路由。

本地验证仅可使用任务专有临时PostgreSQL实例和私有网络命名空间；即使使用dedicated数据库helper，也须将其base/admin连接指向该独立实例，禁止默认共享测试库。详见H交接和独立runner审计证据。

`builtinArtifact.ts/builtinContract.ts`定义尚未上架的0.1.0固定search/download接口（有界查询、opaque文献/平台文件编号，不收发任意URL/凭据）。compiler仅完整artifact hash匹配才生成本站HTTP transport/state discriminator；复制slug/driver不够。旧artifact不生成新字段，compiler version仍1。loader还要求平台review_source及原有效签名/功能核验/未撤销条件。

`accounts.ts`仅为该精确HTTP合同选择严格Cookie state，复用现有connections AEAD/AAD、bind锁/安装授权、generation/revision/CAS和撤销；原browser解密API及secure:true/HTTPS验证器保留，HTTP有专用解密器，不能走旧browser版本迁移。最终HTTP提交额外重新检查平台来源，防止审核来源在执行期间变化。此片只保存合成Cookie，不保存用户名/密码；未来真实setup需要另接凭据密文事务与会话TTL。没有市场seed、runtime driver注册、对外路由或真实身份判断，合同存在不代表可安装/可执行。integ中functionalVerified:true只指独立临时DB里的合成fixture，绝不是真实站点验收。
