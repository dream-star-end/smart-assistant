# OCV5-501：Step 2 429透明自动退避重试与缺出口明确失败

## 用户授权与不可变条件

2026-10-18 19:12批准1/2/3/4/6/7，19:14补充缓存硬门。每步独立PR、测试、独立计划/代码审查和托管CI；不合并、不发布、不操作商业版、不使用cc1。第3步仅765出口最小开通为明确授权的现网例外。第5步只写设计。所有步骤都不降低用户体验、功能或速度；不改变默认模型/思考档。不改变system/tools/context的字节内容与顺序，不把动态计时、重试元数据塞入prompt。

每个PR验收必须包含真实上游cached tokens比例的改动前后数据；相同比较口径为cache_read/(uncached_input+cache_read+cache_write)，缺计数或分母0记N/A。不同供应商须先核验input是否已含cached，禁止重复相加。只读哈希/离线等价是必要补充，不能替代实际usage证据。下降或证据缺失时保持草稿、明确未验收，不宣称完成，不靠合并发布取证。账号765全部新增付费请求需要逐条usage/ledger/钱包对账，总量从严控制。原测量26次执行尝试/175积分不冒充候选代码数据。

## 验证与交付

计划先独立Codex审查APPROVED后才写产品代码；提交干净全diff再独立审查。测试先遵守列车和commercial互斥锁，只跑相关targeted tests，完整套件交托管CI。准备每步变更前后请求body逐字节比较（含工具和cache_control）；读取源/权限/目录/记忆始终实时。真实候选环境尚缺完整引擎入口：普通网页canary只测当前live；禁止借用旧token/route/lease/turnKey或改变765 active容器归属。若不能取得合法候选实测，PR保持未验收。

## 实现

缺Box出口目录/文件作为显式、白名单、不可重试的配置错误贯穿resolver→Box fetch→proxy→CCB parser/engine→gateway。读取权限和符号链接校验保留；不泄露路径/凭据；真实网络/5xx仍走现有策略。拒绝前不启动Box，不把配置错误包装为供应商capacity。

429继续透明自动重试，gateway为产品重试唯一owner（产品CLI maxRetries=0）。保留供应商Retry-After秒数和HTTP日期，通过结构化terminal/turn结果传播retryAfterMs，绝不解析自然语言/塞入prompt。等待至少Retry-After，否则指数退避+抖动。对429豁免same-error三次提前breaker，但共享最大重试次数、Stop/连接存活/取消约束仍有效；5xxbreaker不变。含CLI/proxy原有Retry-After解析的兼容修正，防止固定60秒掩盖有效日期，不多层重复sleep。

## 测试和收益

fake clock/transport：秒/日期/缺失/无效Retry-After；3次429后成功；不早于供应商要求；指数+抖动；最大次数/Stop取消不再发；5xx原breaker；缺出口单次明确失败、无启动/无收费。成功TTFT预计0秒；缺出口同类失败可少等约7.828秒。429不再承诺少等8.374秒，按供应商恢复时刻可能更久但提高成功机会。风险中等，结构化sideband兼容和重试边界需要完整回归。
