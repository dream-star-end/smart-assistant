# OCV5-524 无账号第二批实施预审
用户16:46已授权继续开发，无发布/上架/生产写授权，先做不依赖账号部分。第一批foundation代码独审r2另行进行，本批在方案APPROVED之前不写源码。

范围：plugins/literatureDb内新增officialCaptchaReader.ts与定向测试，只实现真实Claude/Gemini官方图片API协议和现有平台API-key池对接。无需测试网站账号，不发真实付费请求。后续站点driver另批，避免把“看似成功”当登录判据。

1. 保留CaptchaReader窄接口，新factory必须由受信控制面传固定canonicalModel、每次调用freshRouteResolver、recordPlatformUsage，不接受HTTP用户的model/URL/headers/批准。route必须当前enabled+supportsVision+精确provider+official-api路线+exact canonical/upstream绑定+用途批准；不批准即零选key、零fetch。prefix仅附加校验，不能代替当前目录校验。无默认启用配置，不改Grok/GeminiGo/OpenCode/Box路线，不调用OpenAI/OAuth/cc1。
2. 默认selectApiKey复用account-pool/apiKeyPool服务名claude/gemini，按调用选取（同一operation随机stickyKey由控制面注入），无池成员或失败直接MODEL_UNAVAILABLE，不env回退，不插入密钥/读打印DB。API key只用在固定官方host请求header，不进query/worker/日志/错误。reportApiKeyOutcome+classifyHttpOutcome复用池健康；无业务/用户扣费函数。
3. Claude固定https://api.anthropic.com/v1/messages，x-api-key + anthropic-version2023-06-01，max_tokens64，非stream，只有normalized PNG +固定诚实CAPTCHA_PROMPT，无tools/history。Gemini固定https://generativelanguage.googleapis.com/v1beta/models/<严格上游id>:generateContent，x-goog-api-key，inlineData+prompt，candidateCount1/maxOutputTokens64。model URL路径不接受斜杠/query/hash。
4. 每adapter调用最多一次网络fetch、redirect:error、15sec总超时包括body（及等待resolver/key/sink使用abort race），64KiB响应上限，JSON结构严格有限。已cancel不启动resolver/key/fetch；取消后不处理迟到答案、不自动provider重试/续聊。返回只经captchaAnswer。API错误只白名单code、不包含body/key/answer/image。
5. 明确refusal先于内容提取：Claude stop_reason或stop_details.type=refusal；Gemini prompt block或安全finish reason -> MODEL_REFUSED，使现有operation预算停止所有后续云模型。拒绝不当坏key认证。仅Claude end_turn及Gemini STOP可取最终text；thinking/thought文本不作为答案；工具、partial、多candidate、非JSON、缺usage、无text不返回答案。
6. 平台usage sink必填，事件仅本地requestId/provider/model/整数usage/结果枚举，不含图片/答案/凭据/上游raw；成功、拒绝与无效response均记attempt，缺usage记录null并拒绝答案。Claude缓存输入分量分开，Geminiprompt含cached子集、thoughts另列，不重复计费。不调用preCheck/settleUsageAndLedger，不扣免费插件用户。sink失败仅白名单错误，不能声称DB计量已接线；真实服务接线阶段必须提供持久化sink与全局平台资源限额。
7. 测试mock fetch和key池，只用合成图片/key：正确协议/固定host/header、私密字段缺席、撤批准/目录改provider/disabled/无vision/池空零网络、每次重新选key、拒绝优先和跨provider锁、工具/截断/非JSON/缺usage/多candidate、慢body取消/字节上限/redirect选项、meter失败不返回成功、无用户扣费。commercial测试依wait-for-trains和mutex，lint/typecheck，提交后独审/CI。真实模型可用性、许可、成功率/成本仍未验证，不伪称已可装。

依据：Claude API Messages/handling stop reasons；Gemini generateContent/image understanding官方文档（2026-10-19已由只读研究核对），现有apiKeyPool.ts178/247、policy/outcome.ts77。用途批准由平台受信策略独立核实，本批不宣称所有Claude/Gemini CAPTCHA用途已获许可。
