# OCV5-501：Step 2 429透明自动退避重试与缺出口明确失败

## 用户授权与不可变条件

2026-10-18 19:12批准1/2/3/4/6/7，19:14补充缓存硬门。每步独立PR、测试、独立计划/代码审查和托管CI；不合并、不发布、不操作商业版、不使用cc1。第3步仅765出口最小开通为明确授权的现网例外。第5步只写设计。所有步骤都不降低用户体验、功能或速度；不改变默认模型/思考档。不改变system/tools/context的字节内容与顺序，不把动态计时、重试元数据塞入prompt。

每个PR验收必须包含真实上游cached tokens比例的改动前后数据；相同比较口径为cache_read/(uncached_input+cache_read+cache_write)，缺计数或分母0记N/A。不同供应商须先核验input是否已含cached，禁止重复相加。只读哈希/离线等价是必要补充，不能替代实际usage证据。下降或证据缺失时保持草稿、明确未验收，不宣称完成，不靠合并发布取证。账号765全部新增付费请求需要逐条usage/ledger/钱包对账，总量从严控制。原测量26次执行尝试/175积分不冒充候选代码数据。

## 验证与交付

计划先独立Codex审查APPROVED后才写产品代码；提交干净全diff再独立审查。测试先遵守列车和commercial互斥锁，只跑相关targeted tests，完整套件交托管CI。准备每步变更前后请求body逐字节比较（含工具和cache_control）；读取源/权限/目录/记忆始终实时。真实候选环境尚缺完整引擎入口：普通网页canary只测当前live；禁止借用旧token/route/lease/turnKey或改变765 active容器归属。若不能取得合法候选实测，PR保持未验收。

## 实现

缺Box出口目录/文件作为显式、白名单、不可重试的配置错误贯穿resolver→Box fetch→proxy→CCB parser/engine→gateway。读取权限和符号链接校验保留；不泄露路径/凭据；真实网络/5xx仍走现有策略。拒绝前不启动Box，不把配置错误包装为供应商capacity。

429继续透明自动重试，保留gateway现有单一共享最大10次预算与CLI maxRetries=0，不在proxy另建重发循环。actual official-cc 2.1.302隔离loopback已证明is_error终态保留api_error_status和API错误message内的明确机器标记；单靠fork sideband不覆盖本批实际产品。

复用parseRetryAfterMs支持秒/HTTP日期；proxy保持标准Retry-After和retry_after_ms，并在错误message末尾附一个版本化、严格schema的机器envelope（base64url JSON，仅status=429与绝对retryNotBeforeMs），不含正文/鉴权。native CLI保留后，由gateway只在is_error终态且对应429时解析，不从用户/assistant/thinking正文提取、不解析自然语言。terminal→TurnResult→TurnSummary→typed retry error携带该安全字段。网关等max(现有指数+抖动, retryNotBefore-now)，对429豁免same-class3次提前breaker，仍尊重共享max10、Stop、native continuation safety与原5xx breaker。睡眠使用signal，可分段等避免大定时器溢出；不能截短Retry-After提前重发。非本代理来源且无有效hint的429继续指数退避+抖动。API_KEY/pool/quota分类、现有fallback与账务finalizer原逻辑不改。

必须先用实际官方CLI+无外网loopback mock证明精确sendJsonError契约的hint终态保留，以及shutdown+resume后的下一次请求system/tools前缀相同、所有上游messages没有机器hint。若hint进入prompt或无法可靠提取，停止该设计，不交为通过。用户最终界面仍是既有rate_limited友好文案，机器信息不进入聊天正文。缺出口采用明确409机器码，避免官方CLI对400自动修复再发；用同mock证明一次请求/终态白名单可分类。

## 测试和收益

fake clock/transport：秒/日期/缺失/无效Retry-After；3次429后成功；不早于供应商要求；指数+抖动；总等待预算/最大次数/Stop取消不再发；429失败journal正常aborted，成功轮按现有单次结算；5xx原breaker；缺出口单次明确失败、无启动/无收费；stock CLI真实loopback mock（不接供应商）验证exhausted及配置机器码保留。成功TTFT预计0秒；缺出口同类失败可少等约7.828秒。429不再承诺少等8.374秒，按供应商恢复时刻可能更久但提高成功机会。风险中等，结构化sideband兼容和重试边界需要完整回归。
