独立复核通过。范围为报告事实、计数、账务、缓存证据适用范围和风险收益文案；本记录不代表工程 CI 或尚未完成的代码审查通过。

复核时间：2026-10-18T12:49:56.014552+00:00。报告快照 SHA256：`a8a916582a44ecdeea0841a889cdf443bdbcbaf802590d1662b5cafa0935a4a3`。

- 独立重算新增 9 条 usage 的冻结价 Decimal 向上取整，全部一致；9 journal、9 ledger、6 网页 dispatch。Box 12 分、Grok 30 分、受控 API 4 分，共 46 分；钱包 35181→35135，ledger 合计 -46。原始与新增累计为 29 次成功模型调用、3 次供应商 GLM429、32 次供应商尝试；另加 3 次 Box 本地未 launch 失败，共 35 次执行尝试、25 条收费 usage、221 分。没有以成功数代替总请求数。
- 共享受控 API 仅 3 次调用，不按 PR 重复计数；完整受控平台 context 与 21 个平台 MCP schema 的 body 为 46753B。缓存读比例 97.97979798%→同值；报告明确其不覆盖隐藏 native CLI 输入、真实 persona/memory、所有引擎或候选后端部署。
- Grok 原生比较保留精确数值和旧严格门 false；用户 20:39 的“无明显变差”验收政策另列 accepted=true。该政策记录与冻结账务 SHA 绑定一致；2-token 精确因果仍为 N/A，没有以缓存读均为 1152 来声称比例相等。
- 最终 source manifest 含 base 与七个独立分支的完整 source HEAD、依赖路径及 cold/warm 结果。八份 body 摘要一致，均为 `4c2b8a88feaf93a2a7f99783a8eb0f9353747aef40298105d9493e7156e174aa`；prompt 摘要也一致。七个分支依赖路径分别指向自己的 worktree，记录为前后 clean。绑定范围止于该 manifest 记录的源码快照，不替代工程 CI。
- 两处前次文档问题已核实修正：“目录”明确为“模型目录”；新增 Step7 r1 安全结果支持 partial p50 节省 0.000415375000004s，r2 支持 0.000015255999999s，与报告约 0.000015–0.000415s 一致。这是离线 CPU 数据，未冒称网页 TTFT 收益。
- Step7 覆盖措辞为“全部工具边界、128 个确定性子集与完整 prompt 对照”，没有声称穷举 2^N。第 1 步直接提速 0 秒、第 2 步仅缺 Box 出口同类失败约 7.828 秒、第 5 步仅设计等边界清楚。候选 Grok 更慢样本、原始预算约 30 与实际 32 次供应商尝试的差额均保留。
- 报告全部 Markdown 本地证据链接存在；未发现过期的“候选网页进行中”状态。原始与批准后阶段、候选静态资产与仍为基线的后端、共享实验与单 PR 证据均有区分。

工程 CI、最终 source/CI 汇总和 Step1 r4 审查的队列闭合仍由根代理负责；本独立复核没有将这些排队项认定通过。所有 PR 维持草稿，不以本记录授权合并或发布。

本轮只读核对既有文件并新增本复核记录；未修改报告、产品、worktree、配置或账务，未运行测试、登录、发模型请求或新增采样。未保存正文、凭据或工具 schema 内容。

证据：[报告](../../TTFT-OTHERS-20261018.md)、[冻结账务](paid-evidence/billing-agent-phase-audit-final.json)、[用户验收政策](paid-evidence/user-2039-cache-acceptance.json)、[原生缓存独立比较](paid-evidence/grok-native-cache-comparison.json)、[最终源码绑定](paid-evidence/final-source-export-manifest.json)、[Step7 r1](step7/bench-r1-result.json)、[Step7 r2](step7/bench-r2-result.json)。

最终源码绑定文件 SHA256：`74f78145efdbba802380bc24352752e3801d33f135efd3eb199c4e3cf875d5ea`。
