# OCV5-506：常驻 CLI 与逐轮鉴权研究方案

状态：仅设计；用户2026-10-18 19:12暂不批准实施。保持现有shutdown+resume、spawn fingerprint和逐轮鉴权。不启动常驻进程、不修改配置、不合并、不发布，商业版不操作。

## 问题和可兑现收益的边界

个人版67d13462e实测Kimi/DeepSeek使用official-cc。每轮authority headers/turnKey改变，不能通过stdin热更新，spawn fingerprint变化后重启是当前正确隔离行为。context_ready到首journal事务锚点约4.356–5.270秒，这包含上下文读取、进程准备、CLI初始化、代理准入等，并不是独立的CLI启动耗时。

研究收益上限为0–约5.3秒/轮，不能承诺省5秒。已测prompt构建0.064–0.183秒，单独缓存不会覆盖整个组合段。先补分段：runtime解析、需要回收的判定、stdout drain/shutdown、prompt/MCP准备、spawn、SDK init、代理identity/precheck/选路、fetch/headers/首正文。SDK init不代表MCP就绪，首SSE字节也不代表正文。每个边界使用冻结turn/child generation与单调时钟，不能用事务NOW倒推。

## 必须先解决的不变量

1. 每个真实上游请求在进入代理时，能拿到不可伪造、不可变的request-scoped authority与generation；不是从“当前active turn”临时猜测。
2. 已签发的A轮请求无论何时到达，均只能归A或被明确拒绝，绝不能被B的新binding接管。结果完成、inflight=0、短暂静默均不是证明。
3. 每个request的定价snapshot、权限、quota、dispatch/attempt、parent/delegate关系与账务owner在准入时冻结，后续换绑不得更改。
4. Stop撤销旧generation的新增准入；已产生的真实用量仍按原轮结算。不能为了快停丢弃已收到的付费尾流。
5. 不能把稳定relay key当作轮次authority，也不能降低当前签名、模型目录epoch、容器绑定IP或租约校验。
6. system、tools、context、cache_control及其顺序与基线完全相同；不把nonce/generation/时间戳写进prompt。每PR实际cached tokens比例下降即不验收。

反例：A收到result后inflight为0，网关切到B；CLI的延迟背景请求随后发出。如果relay只读active binding，它会把A请求记在B下，即使切换用了mutex/CAS仍然错误。因此“稳定凭据+可变active binding”不是可接受方案。

## 候选协议与选择门

| 候选 | 可研究条件 | 当前结论 |
|---|---|---|
| 官方支持每请求动态header/control协议 | CLI在发送每个请求时附带可信generation；含background、重试、工具后续、checkpoint等所有请求 | 首选研究，当前未证明存在完整支持 |
| CLI维护多个不可变transport实例，turn显式绑定其一 | 所有API调用都带确定turn上下文；旧transport关闭/过期不影响已付费尾流 | 需上游支持或受控fork，当前official-cc不能假设具备 |
| 本地代理按连接/时间窗口推断轮次 | HTTP连接可能复用、重试和背景包可能延迟 | 拒绝；不能从连接或时间推断authority |
| 稳定relay token+原子active binding | 只证明换绑原子，无法证明迟到请求来源 | 拒绝，不进入PoC |
| 维持逐轮shutdown+resume | 当前鉴权与进程生命周期已绑定 | 继续使用，收益0秒，风险已知 |

只在第一或第二条通过协议级证据后才批准PoC。不存在可信generation传播机制时，研究停在方案，不以“暂时没观察到晚包”代替证明。

## 若协议前置通过，拟议状态机

`idle → preparing(g) → admitted(g) → running(g) → draining(g) → retired(g)`；异常进入`aborted(g)`或`crashed(g)`。下一轮g+1的admitted不得改变任何已准入g请求的snapshot。

准入由master签发短期、限定uid/container/session/model/dispatch/attempt/generation的凭据。CLI每次请求携带它，relay验证签名、有效期、epoch、owner和generation后创建不可变request context。凭据只在受控transport/control通道传递，不能进入prompt、工具参数、用户正文、日志或磁盘历史。跨模型/权限范围变化若协议不能保证安全，继续回收进程。

轮次控制使用单调generation与CAS更新，旧worker的renew/finalize不得改新generation；fencing必须由实际authority接受方校验，不能只有本地锁。租约过期后拒绝新增请求，已准入请求按原owner完成或中止。后台工作若跨轮有合法需求，必须独立authority/预算与可见生命周期，不能隐式借下一轮权限。

Stop先撤销准入，再向CLI发终止/取消；等待可验证的stdout/HTTP drain边界，保留已付费的结果。到达超时后保持旧generation终态，晚到请求拒绝，不重归类到新轮。crash恢复先从durable dispatch/journal恢复owner，再决定resume，不能根据当前聊天窗口拼身份。

## 账务和幂等

request ID每次真实请求唯一，重试是否复用由既有结算契约决定；不复用旧轮turnKey/lease。每条usage保留request/generation/dispatch/attempt/provider/account/冻结价格与父子关系。成功、无用量拒绝、客户端取消、部分流中断分别按既有finalizer语义结算一次。

请求执行和账务完成是两个状态；result到达不等于所有上游请求已结算。换绑不能触发旧请求重复扣款或将其清零。必须覆盖预留过期、多个并发模型调用、工具后继续、checkpoint、delegate、resume和迟到尾流，不能只测一条普通问答。

## PoC和故障注入验收（未授权执行）

| 场景 | 必须观察的结果 |
|---|---|
| A完成后延迟发包，再准入B | A包按A拒绝/结算；B无新增用量 |
| A正在fetch时Stop，立即提交B | A新增准入被撤销；已产生用量仍归A；B不受A回调覆盖 |
| A与B不同模型/权限/父agent | 不串凭据、定价、工具权限、账务和历史 |
| 旧generation renew/CAS/finalize在新轮之后到达 | fence拒绝旧更新，不能结束新轮 |
| 网络重连、HTTP/2连接复用、SDK自动重试 | 每次请求仍有正确request-scoped authority |
| CLI crash、网关crash、relay crash、master重启 | durable owner可恢复，不重扣、不借当前active绑定 |
| 工具后续、背景调用、checkpoint/delegate | 全部经过相同逐请求验证，不存在未标记旁路 |
| stdout exit先于付费尾流close | 保留全部已收到帧后终结；旧close不结束新进程 |
| 凭据/epoch过期，模型撤权，计费快照变化 | 新请求重新准入或明确失败，不能沿用旧权限 |
| 缓存对照与功能回归 | prompt/tool bytes及顺序相同，真实cached比率不降，原能力不减 |

先用完全本地fake transport+可控调度器做全部故障注入；无任何供应商调用。通过后另报PoC最小diff、正式候选验证环境、账号/模型/预算与停止条件，由用户决定是否授权。不能为取证先合并/发布。

## 性能实验与决策

先独立测冷CLI、已运行CLI、每轮shutdown+resume三种路径，保持模型、账号、prompt长度、思考档、工具调用数、缓存状态可比。采用交错顺序，报告首轮/追问、首推理/首正文、失败、所有尝试和扣费，不删离群值或把不同工具行为当因果收益。

研究是否值得的门：可消除启动段必须明显高于新增控制协议开销；所有功能/停止/恢复/并发行为不变；错误率不升；真实cached tokens比例不降。没有完整协议和反例测试时，即使p50快数秒也不实施。详细节省秒数在分段实测后重新估算，当前仍0–约5.3秒研究上限。

回退必须能对后续轮恢复既有spawn fingerprint+shutdown/resume；旧generation继续drain/finalize，不重放已收费请求。回退不应要求改用户会话或删除历史。上线/迁移/灰度均不在本次授权内。

## 当前证据状态

此PR只有计划和设计文档，运行时代码相对67d13462e没有变化。未执行PoC，新增供应商请求0，新增扣费0。真实cached tokens的候选对照尚无，记N/A；不能把无代码变化、哈希相等或旧175积分样本冒充新的上游验收证据。该门和用户后续实施批准均未满足，不交付为“可上线”。

## 本设计PR的缓存证据范围

本PR仅文档，不实现常驻、不更改请求；各源码分支导出的受控body相同，真实共享API缓存对照97.97979798%→97.97979798%。三次实际调用共享计数，不按PR重复收费。完整证据见H/g500-ttft-approved-20261018/paid-evidence/shared-cache-evidence.json及final-source-export-manifest.json。该证据只针对现有未实现代码，绝不是常驻方案的cache验收；未来实施必须另外证明完整native前缀稳定和真实命中非下降。未新建进程/服务/PoC。
