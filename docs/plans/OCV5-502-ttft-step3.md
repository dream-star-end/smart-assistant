# OCV5-502：Step 3 测试账号765 Box出口最小开通

## 用户授权与不可变条件

2026-10-18 19:12批准1/2/3/4/6/7，19:14补充缓存硬门。每步独立PR、测试、独立计划/代码审查和托管CI；不合并、不发布、不操作商业版、不使用cc1。第3步仅765出口最小开通为明确授权的现网例外。第5步只写设计。所有步骤都不降低用户体验、功能或速度；不改变默认模型/思考档。不改变system/tools/context的字节内容与顺序，不把动态计时、重试元数据塞入prompt。

每个PR验收必须包含真实上游cached tokens比例的改动前后数据；相同比较口径为cache_read/(uncached_input+cache_read+cache_write)，缺计数或分母0记N/A。不同供应商须先核验input是否已含cached，禁止重复相加。只读哈希/离线等价是必要补充，不能替代实际usage证据。下降或证据缺失时保持草稿、明确未验收，不宣称完成，不靠合并发布取证。账号765全部新增付费请求需要逐条usage/ledger/钱包对账，总量从严控制。原测量26次执行尝试/175积分不冒充候选代码数据。

## 验证与交付

计划先独立Codex审查APPROVED后才写产品代码；提交干净全diff再独立审查。测试先遵守列车和commercial互斥锁，只跑相关targeted tests，完整套件交托管CI。准备每步变更前后请求body逐字节比较（含工具和cache_control）；读取源/权限/目录/记忆始终实时。真实候选环境尚缺完整引擎入口：普通网页canary只测当前live；禁止借用旧token/route/lease/turnKey或改变765 active容器归属。若不能取得合法候选实测，PR保持未验收。

## 操作设计

只给uid765创建root:root 0700目录/etc/openclaude/cursor-v5-u765和root:root 0600单链接普通文件.https-proxy。文件值只能从已运行个人版openclaude-v5-selfhost-cursor-proxy.service对应配置的明确inbound解析，不借u3/cc1、不改Box登录/全局pool/模型catalog/路由、不重启服务。assert-first、不可覆盖既有对象；在官方selfhost人工变更租约回调中执行，审计前后元数据和live SHA。

用户已允许开通后“同账号、同非cc1登录、未改代码”作为缓存对照，开通前N/A。当前pool account2优先并非硬隔离，可能溢出default，因此不能仅靠偏好做真实调用。必须先有不改变全局策略的受支持非cc1隔离入口，缺失则只完成出口开通，真实首轮/追问与缓存门标未通过。

## 测试和收益

在临时目录用fixture验证权限、符号链接拒绝、重跑不覆盖、只影响指定uid、值取自唯一已知inbound。现网只读核对监听/服务/live/canonical，按正式锁做已获授权的最小文件创建并记录。恢复可用性不是可兑现秒数；成功TTFT待测，预计省秒N/A。风险局限765出口文件，禁止扩大到登录/全局策略；本PR仅脚本/操作记录，不把现网例外扩展到发布。
