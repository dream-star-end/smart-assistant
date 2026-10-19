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
