# OCV5-500：Step 1 非Codex正文绘制与引擎分段计时

## 用户授权与不可变条件

2026-10-18 19:12批准1/2/3/4/6/7，19:14补充缓存硬门。每步独立PR、测试、独立计划/代码审查和托管CI；不合并、不发布、不操作商业版、不使用cc1。第3步仅765出口最小开通为明确授权的现网例外。第5步只写设计。所有步骤都不降低用户体验、功能或速度；不改变默认模型/思考档。不改变system/tools/context的字节内容与顺序，不把动态计时、重试元数据塞入prompt。

每个PR验收必须包含真实上游cached tokens比例的改动前后数据；相同比较口径为cache_read/(uncached_input+cache_read+cache_write)，缺计数或分母0记N/A。不同供应商须先核验input是否已含cached，禁止重复相加。只读哈希/离线等价是必要补充，不能替代实际usage证据。下降或证据缺失时保持草稿、明确未验收，不宣称完成，不靠合并发布取证。账号765全部新增付费请求需要逐条usage/ledger/钱包对账，总量从严控制。原测量26次执行尝试/175积分不冒充候选代码数据。

## 验证与交付

计划先独立Codex审查APPROVED后才写产品代码；提交干净全diff再独立审查。测试先遵守列车和commercial互斥锁，只跑相关targeted tests，完整套件交托管CI。准备每步变更前后请求body逐字节比较（含工具和cache_control）；读取源/权限/目录/记忆始终实时。真实候选环境尚缺完整引擎入口：普通网页canary只测当前live；禁止借用旧token/route/lease/turnKey或改变765 active容器归属。若不能取得合法候选实测，PR保持未验收。

## 实现

修复ProcessDisclosure正文的首绘制探针：抽取共享双rAF组件，单独传稳定回调，在首个非空、可展示正文节点挂载。以同一个临时probe对象的WeakSet跨过程区/最终区重挂去重；双rAF真正提交才claim，取消不claim。保持精确trace/cmid/active/history门和toStored剥离。不得改变Markdown、折叠、排序或节点文本。

补非Codex被动阶段计时：subprocess spawn请求/实际spawn/首stdout/system-init（只叫sdk_init_received，不冒称MCPready），proxy收到/precheck/选路/fetch attempt/headers，SSE首字节与首正文明确分开。尽可能沿现有解析/流观察点记录，不增加reader或重排流，不增加等待。子进程冻结trace/generation，避免旧stdout串新轮。只记录白名单ID/阶段/耗时/结果，不记录prompt/env/argv/header/rawerror。

## 测试和收益

真实MessageList过程正文→最终正文只报一次；切换早于2帧可由最终补报；thinking/空/工具/历史/错trace/无cmid不报；存储无probe。后台遥测fake process/stream覆盖旧child/空delta/推理/分块UTF8/结束，内容/计费不变。实际UX提速预计0秒；修正此前典型7.100–9.593秒的计量延后。风险为误归因/重复报告，必须由反例测试约束。
