# OCV5-506：Step 5 CLI常驻与逐轮鉴权的详细研究方案

## 用户授权与不可变条件

2026-10-18 19:12批准1/2/3/4/6/7，19:14补充缓存硬门。每步独立PR、测试、独立计划/代码审查和托管CI；不合并、不发布、不操作商业版、不使用cc1。第3步仅765出口最小开通为明确授权的现网例外。第5步只写设计。所有步骤都不降低用户体验、功能或速度；不改变默认模型/思考档。不改变system/tools/context的字节内容与顺序，不把动态计时、重试元数据塞入prompt。

每个PR验收必须包含真实上游cached tokens比例的改动前后数据；相同比较口径为cache_read/(uncached_input+cache_read+cache_write)，缺计数或分母0记N/A。不同供应商须先核验input是否已含cached，禁止重复相加。只读哈希/离线等价是必要补充，不能替代实际usage证据。下降或证据缺失时保持草稿、明确未验收，不宣称完成，不靠合并发布取证。账号765全部新增付费请求需要逐条usage/ledger/钱包对账，总量从严控制。原测量26次执行尝试/175积分不冒充候选代码数据。

## 验证与交付

计划先独立Codex审查APPROVED后才写产品代码；提交干净全diff再独立审查。测试先遵守列车和commercial互斥锁，只跑相关targeted tests，完整套件交托管CI。准备每步变更前后请求body逐字节比较（含工具和cache_control）；读取源/权限/目录/记忆始终实时。真实候选环境尚缺完整引擎入口：普通网页canary只测当前live；禁止借用旧token/route/lease/turnKey或改变765 active容器归属。若不能取得合法候选实测，PR保持未验收。

## 仅文档范围

详细设计CLI常驻/逐轮鉴权，不实现、不删除shutdown/fingerprint、不启动常驻服务。拆分已测4.356–5.270秒组合段，标明未分解部分；收益研究上限0–约5.3秒/轮不能兑现为点估计。

威胁模型：旧CLI在result后仍可能晚发HTTP请求，inflight=0不足以安全换绑；稳定relay credential+可变active binding不能保证账务归属。需要官方热header/control协议或可证明的逐请求可信generation token。明确准入签发/分发、per-request不可变authority snapshot、CAS/fence/renew、晚包拒绝、Stop/drain/crash/resume/并发、多模型多session计费及回滚。给出PoC前置不变量、故障注入测试、实验预算与不可实施条件。

## 验证

文档独立审查、CI、代码diff证明没有运行时修改。上游缓存没有candidate变化，任何真实before/after缺失仍记N/A，不能伪称通过硬门。风险高，继续保持当前shutdown+resume。
