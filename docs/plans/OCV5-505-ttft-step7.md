# OCV5-505：Step 7 不删功能不改前缀的工具说明处理优化

## 用户授权与不可变条件

2026-10-18 19:12批准1/2/3/4/6/7，19:14补充缓存硬门。每步独立PR、测试、独立计划/代码审查和托管CI；不合并、不发布、不操作商业版、不使用cc1。第3步仅765出口最小开通为明确授权的现网例外。第5步只写设计。所有步骤都不降低用户体验、功能或速度；不改变默认模型/思考档。不改变system/tools/context的字节内容与顺序，不把动态计时、重试元数据塞入prompt。

每个PR验收必须包含真实上游cached tokens比例的改动前后数据；相同比较口径为cache_read/(uncached_input+cache_read+cache_write)，缺计数或分母0记N/A。不同供应商须先核验input是否已含cached，禁止重复相加。只读哈希/离线等价是必要补充，不能替代实际usage证据。下降或证据缺失时保持草稿、明确未验收，不宣称完成，不靠合并发布取证。账号765全部新增付费请求需要逐条usage/ledger/钱包对账，总量从严控制。原测量26次执行尝试/175积分不冒充候选代码数据。

## 验证与交付

计划先独立Codex审查APPROVED后才写产品代码；提交干净全diff再独立审查。测试先遵守列车和commercial互斥锁，只跑相关targeted tests，完整套件交托管CI。准备每步变更前后请求body逐字节比较（含工具和cache_control）；读取源/权限/目录/记忆始终实时。真实候选环境尚缺完整引擎入口：普通网页canary只测当前live；禁止借用旧token/route/lease/turnKey或改变765 active容器归属。若不能取得合法候选实测，PR保持未验收。

## 实现（受19:12/19:14约束后的替代方案）

不做原始的智能UI/技能摘要按需删减，因为会减少发现能力并改变上游缓存前缀。本步保留全部内容和原顺序，仅优化sanitizeUnavailableMcpClaims的等价计算：工具名转义正则预编译一次，每次build仅构造一次availability Set，按现有PLATFORM_MCP_TOOL_NAMES顺序替换。undefined继续保留legacy原文，[]仍精确清理，不缓存可变权限/availability，不改变工具可用性/提示字符串/顺序。global RegExp使用需保证重复调用状态复位，不能因lastIndex改变输出。

## 测试和收益

保留旧算法作为测试oracle，所有工具子集、重复词/括号/边界/换行/Unicode/重复调用/undefined/空集合逐字节相等，完整prompt snapshot回归。微基准报告旧新CPU耗时和分布，出现变慢则不能验收；完整请求前缀与tool schema等价+真实上游cached tokens不下降。预计秒数0–0.01秒/轮（待测，不再承诺token减少）。风险低，所有功能、prompt、权限读取和默认均保持。
