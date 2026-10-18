# OCV5-505 MCP文案处理验证

仅把原先每slot重复的Set/RegExp构造移为每次完整prompt构建一次。工具名单、正则语义/顺序/全局lastIndex、undefined与空集合语义、文本与所有功能保留；不删MCP、schema、checkpoint或技能，不改变注册、发现或默认行为。

19项相关测试首轮通过；覆盖全部工具边界、中文/CRLF/嵌套括号、随机子集、重复调用与完整prompt。fixture已改为真实provider=grok，并继续跑最终回归。14slot/68576字节、1500轮离线基准：partial p50 2.410642→1.995267ms（省0.000415秒）、all-tools 0.025780→0.002786ms、legacy 0.002473→0.001497ms；无观测到CPU路径变慢。host长尾噪声很大，不承诺整段TTFT收益。

## 上游缓存对照

详见OCV5-505-cache-evidence.json。base/Step4/本候选各自源码输出的完整受控body46753字节逐字相同，完整21个已配置平台MCP schema、remote IUI/model hint和目录固定，顺序/内容/cache_control均相同。765正式fresh local_catalog真实DeepSeek调用的未改代码基线与candidate均I256/R12416/W0；R/(I+R+W)=97.97979798%→97.97979798%，未下降。另1次warmup I12672/R0/W0；三笔总扣4分、按共享实验一次计数。

受控对照未复现原生CLI隐藏system/默认工具、765真实persona/memory，不能声称候选后端完整网页TTFT/全部引擎已验。代码保持所有功能，性能数据的覆盖边界单列，未覆盖不算通过。计划/代码r1独立审查通过；最终复审/当前head CI待收口。草稿，不合并不发布，商业版不动。证据H/g500-ttft-approved-20261018/step7与paid-evidence。
