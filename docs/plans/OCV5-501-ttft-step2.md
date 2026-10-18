# OCV5-501：Step 2 429透明自动退避重试与缺出口明确失败

## 用户授权与不可变条件

2026-10-18 19:12批准1/2/3/4/6/7，19:14补充缓存硬门。每步独立PR、测试、独立计划/代码审查和托管CI；不合并、不发布、不操作商业版、不使用cc1。第3步仅765出口最小开通为明确授权的现网例外。第5步只写设计。所有步骤都不降低用户体验、功能或速度；不改变默认模型/思考档。不改变system/tools/context的字节内容与顺序，不把动态计时、重试元数据塞入prompt。

每个PR验收必须包含真实上游cached tokens比例的改动前后数据；相同比较口径为cache_read/(uncached_input+cache_read+cache_write)，缺计数或分母0记N/A。不同供应商须先核验input是否已含cached，禁止重复相加。只读哈希/离线等价是必要补充，不能替代实际usage证据。下降或证据缺失时保持草稿、明确未验收，不宣称完成，不靠合并发布取证。账号765全部新增付费请求需要逐条usage/ledger/钱包对账，总量从严控制。原测量26次执行尝试/175积分不冒充候选代码数据。

## 验证与交付

计划先独立Codex审查APPROVED后才写产品代码；提交干净全diff再独立审查。测试先遵守列车和commercial互斥锁，只跑相关targeted tests，完整套件交托管CI。准备每步变更前后请求body逐字节比较（含工具和cache_control）；读取源/权限/目录/记忆始终实时。真实候选环境尚缺完整引擎入口：普通网页canary只测当前live；禁止借用旧token/route/lease/turnKey或改变765 active容器归属。若不能取得合法候选实测，PR保持未验收。

## 实现

缺Box出口目录/文件作为显式、白名单、不可重试的配置错误贯穿resolver→Box fetch→proxy→CCB parser/engine→gateway。读取权限和符号链接校验保留；不泄露路径/凭据；真实网络/5xx仍走现有策略。拒绝前不启动Box，不把配置错误包装为供应商capacity。

429继续透明自动重试，实际HTTP owner proxy在原请求尚未输出前对可安全重放的静态API做窄重试。当前实际official-cc不是仓内fork，不能靠修改fork terminal sideband假装覆盖。保持CLI maxRetries=0，固定同一session/key/endpoint/headers/dispatcher与body字节，不改prompt。按现有parseRetryAfterMs支持秒/HTTP日期，delay=max(Retry-After,指数退避+抖动)，缺头走指数。最多10次HTTP尝试，总等待预算240秒，超过预算时不截短Retry-After提前重发，返回明确rate-limited exhausted。保留现有quota_exhausted分类及已声明fallback优先级。Box、nonreplayable和专用transport不纳入自动重发。

中间429只上报已有pool健康结果，不finalize、不release、不换号；最终success只commit一次，最终failure只fail一次。等待共享现有ac.signal，可取消，取消后不得再发。预算比300秒软预留和30分钟journal/slot期限更短。最终429用明确机器错误code表明proxy已拥有重试预算；必须用实际官方CLI+loopback mock证明其在is_error terminal诊断中保留。gateway仅从error terminal诊断识别该机器码并停止外层重复重试，普通用户/assistant正文绝不能触发。若stock CLI丢弃该标记，停止此设计，不提交成已覆盖，另设计鉴权request-scoped sidechannel。其它engine现有自动重试不缩减；Grok/AG没有同样可重放API路径，不能以CCB结论冒称全引擎覆盖。

## 测试和收益

fake clock/transport：秒/日期/缺失/无效Retry-After；3次429后成功；不早于供应商要求；指数+抖动；总等待预算/最大次数/Stop取消不再发；中间失败不结算、成功只扣一次；5xx原breaker；缺出口单次明确失败、无启动/无收费；stock CLI真实loopback mock（不接供应商）验证exhausted及配置机器码保留。成功TTFT预计0秒；缺出口同类失败可少等约7.828秒。429不再承诺少等8.374秒，按供应商恢复时刻可能更久但提高成功机会。风险中等，结构化sideband兼容和重试边界需要完整回归。
