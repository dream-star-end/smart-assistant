# OCV5-503：Step 4 字节等价的静态提示派生复用

## 用户授权与不可变条件

2026-10-18 19:12批准1/2/3/4/6/7，19:14补充缓存硬门。每步独立PR、测试、独立计划/代码审查和托管CI；不合并、不发布、不操作商业版、不使用cc1。第3步仅765出口最小开通为明确授权的现网例外。第5步只写设计。所有步骤都不降低用户体验、功能或速度；不改变默认模型/思考档。不改变system/tools/context的字节内容与顺序，不把动态计时、重试元数据塞入prompt。

每个PR验收必须包含真实上游cached tokens比例的改动前后数据；相同比较口径为cache_read/(uncached_input+cache_read+cache_write)，缺计数或分母0记N/A。不同供应商须先核验input是否已含cached，禁止重复相加。只读哈希/离线等价是必要补充，不能替代实际usage证据。下降或证据缺失时保持草稿、明确未验收，不宣称完成，不靠合并发布取证。账号765全部新增付费请求需要逐条usage/ledger/钱包对账，总量从严控制。原测量26次执行尝试/175积分不冒充候选代码数据。

## 验证与交付

计划先独立Codex审查APPROVED后才写产品代码；提交干净全diff再独立审查。测试先遵守列车和commercial互斥锁，只跑相关targeted tests，完整套件交托管CI。准备每步变更前后请求body逐字节比较（含工具和cache_control）；读取源/权限/目录/记忆始终实时。真实候选环境尚缺完整引擎入口：普通网页canary只测当前live；禁止借用旧token/route/lease/turnKey或改变765 active容器归属。若不能取得合法候选实测，PR保持未验收。

## 实现

仅缓存已经实时读取/完整装配后的纯字符串派生量：UTF8字节、SHA256、token estimate。以完整string作key，LRU同时限制条目数与总保留字节，超大输入bypass；不以mtime/TTL充当失效。共享值仅冻结primitive派生对象，per-turn applied/meta/frozenProjectContext仍新建，MODEL_HINT canonicalId每轮保留。不缓存目录、权限、prompt source fetch、skills/memory/roster、MCP/鉴权文件或完整buildPromptContext。动态内容变一字即miss。最终content和slot顺序逐字节不变。

## 测试和收益

纯函数单元测内容变化/Unicode/并发/逐出/超限不缓存；跨模型/权限/工具/记忆变化的完整prompt回归与base/candidate等价，meta不共享。冷热微基准只报告CPU派生收益，不冒充完整TTFT；本批prompt构建总耗时0.064–0.183秒，实际预计0–0.18秒/轮，收益大概率更小。风险为缓存内存/跨轮污染，以容量界限和纯输入输出测试控制。真实cached tokens门须另取候选上游usage。
