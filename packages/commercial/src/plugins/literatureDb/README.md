# 文献数据库登录底座（OCV5-524）

这一阶段是未上架的内部底座，不是已经可安装使用的插件。生产HTTP路由、账号绑定/撤销事务、worker/driver、前端、实际平台推理和登录后检索/下载尚未接线；不能把这些接口的fixture通过当真实站点验收。

- `policy.ts` 仅允许精确的 `www.jieyoutsg.com` HTTP80 / HTTPS443，使用共享公网DNS校验。通用HTTPS规则未改。
- `transport.ts` 用已验IP执行一个原生HTTP(S)请求，Host/SNI保留原域，使用一次性Agent，总超时包括DNS，响应限字节。它不跟跳、不重放POST；私有session必须逐跳选择Cookie（尤其不能把Secure cookie降级到HTTP）、重新pin并判断登录结果。Set-Cookie数组不合并拆逗号。
- `credentials.ts` 是严格AEAD seal/open接口，AAD绑定用户/账号/站点/随机seed。此层不自行持久化；后续必须通过已安装账户的授权、generation/CAS、解绑事务接入，不能把密文放到meta或绕过绑定。
- `captcha.ts` 只向已配置、经用途核对的非OpenAIadapter传合成/裁剪图片、固定诚实提示和输出预算。平台API密钥不进worker。adapter需把供应商拒绝映射为`LiteratureError('MODEL_REFUSED')`，同operation剩余流程不再换云provider。当前没有接真实模型供应商，也没有产生模型费用。
- `login.ts` 持有原私有session，默认最多4次自动表单提交、2次云调用、6次账户operation/小时；人工答案只消费一次。未知POST结果先probe一次，不能确认就停；取消/期限和清理屏障限制迟到结果。清理失败保留账户占用，shutdown不把未清理资源当成功。重启不恢复内存operation，不重放提交。
- `persist(state, context)` 是受信平台回调：真实DB实现必须在账户事务里检查同installation/owner/generation和撤权状态。`isCurrent()`/signal只辅助进程内检查，不能替代数据库CAS。基础测试只证明stub被正确调用，不宣称真实DB围栏通过。

验证使用合成凭据、合成图像、模拟私有session和回环HTTP socket；测试request factory是受信依赖注入，没有生产allowPrivate开关。TLS选项有断言，尚无本站TLS证书握手证明。待管家提供凭据文件绝对路径后继续真实适配；任何凭据内容不得出现在聊天、PR、日志或模型上下文。
