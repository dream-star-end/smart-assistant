# OCV5-498 独立复核记录

主代理根据两路只读代理的独立复算结果整理；未发额外产品请求、未修改生产数据。

- 账务复核：重新读取REPEATABLE READ READ ONLY数据库集合并使用Decimal复算16条冻结价格，175积分；ledger逐行余额、全钱包集合和计数一致，无额外／遗漏流水。14个committed journal及6个零扣费aborted；Gemini 3relay→2settled turn→2usage/ledger独立链正确。Grok原生4+3modelCalls与loop_started及DB tokens一致。无具体账务反例。
- 计时复核：从原始browser events、gateway/master、dispatch/trace/friction逐轮重算16成功样本，身份唯一、四个gateway阶段各1条、正文TTFT与报告分段表一致。DeepSeek A追问11.808秒恢复正确，未重发。
- DOM复核：12个观测均为本轮process:<cmid>或精确正文messageId，帧至DOM中位数190.5ms，范围88–389ms。旧绘制探针遗漏过程区，不能把旧probe延后等同实际渲染阻塞。
- 请求复核：18计划发送、19传输帧、18dispatch（16completed/2crashed）；恢复帧无新增dispatch。26是执行尝试，Box3未启动至供应商，不写成26次付费或已发供应商。
- 已接受具体反例：B版DOM fallback若旧assistant重挂，WeakSet不能认旧节点；采后仅保留process本轮cmid或exact messageId，D版取消不严格fallback。非阻断命名差异（Gemini替代结算链字段仍叫journal_matches）按settlement_path解释，没有为命名修改产品逻辑。

引擎根因与方案复核：通过，未发现具体反例；未夸大收益，未错误套用Codex/official-cc预热、Fast因果或Gemini checkpoint假设。主代理随后把静态构建收益进一步收紧为本批实测0–0.18秒，并明确CCB与Grok/Gemini提示估算差异。
