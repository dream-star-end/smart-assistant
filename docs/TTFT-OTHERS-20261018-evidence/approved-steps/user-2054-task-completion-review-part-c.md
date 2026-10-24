用户20:54任务完成门：独立只读复核 Part C

范围：第3步 `ddfc60324` 与第5步 `0b2213a9e` 相对付费基线 `67d13462e` 的完整差异、操作脚本、测试源码、验证文档及冻结证据。仅读代码与已有文件；未运行模型、测试、浏览器、配置操作、发布或新的真实请求数据库查询。

结论：第3步已恢复765的Box可用性，未发现由该最小文件操作引入、可实际触发的上下文删减、任务恢复或缓存退化反例。第5步交付的是详细设计，运行时代码无变化；不能把设计完成写成常驻CLI已经安全、提速或通过实际恢复/缓存验收。

第3步的任务与上下文证据：

- 11:43:26 UTC在官方个人版锁内，仅创建固定765的0700目录/0600单链接出口文件，使用已有专用listener；未改模型路由、登录池、登录文件、服务或默认项。脚本同值不写入，异值/不安全对象拒绝；4项已有测试覆盖创建幂等、其它uid不变、异值拒绝、符号链接/权限与错误listener。此轮只读审查测试源码，没有重复执行操作。
- 恢复后原后端67d13462e的普通网页首轮/追问成功并终结；实际profile均account2，非cc1。候选前端两轮也均account2。关联依据是活动journal nonce→准确native cwd→实际claude进程中仅CLAUDE_CONFIG_DIR值，r2原始共享cwd误匹配有明确排除，r5排除终态请求。没有以亲和表或时间相近的login日志代替实际profile。
- 各会话内追问复用同一个native session与原cwd，但CLI PID不同：证实正常native resume，不能冒称进程常驻。没有为测试删除原上下文、工具、技能或记忆。恢复前全失败，无成功tokens，缓存基线N/A；不能造作0%。
- 恢复后基线I/R/W：首轮2/0/47741、追问4/47725/493；候选为2/34577/13163、4/47724/379。缓存读比例分别0%→72.42469943%、98.96935009%→99.20385807%，此样本无明显下降。两次生成历史长度不同，比例改善不归因出口/前端；未抓取Box全部隐藏native前缀，未验证崩溃/跨权限/长任务恢复或回答语义穷举。
- 操作wrapper固定原canonical/live SHA；后续canonical前进时会拒绝再次操作，这是边界保护，不影响已存在的765出口。不能把它当成可在任意未来版本重跑的通用运维脚本，也没有必要放宽guard。

第5步的具体反例及设计处理：

| 可触发顺序 | 若错误实现会怎样 | 本设计的处理与未验证边界 |
|---|---|---|
| A已有result且inflight=0，切到B，再收到A延迟背景请求 | 稳定relay key配合active binding会把A的权限/收费归B；mutex/CAS也不能证明来源 | 明确拒绝该方案；每请求不可变可信authority/generation是PoC前置，当前official-cc完整支持尚未证明 |
| A Stop/crash后B准入，A的close/renew/finalize或付费尾流迟到 | B被旧回调结束，A用量丢失、重扣或串轮；未完成任务无法正确resume | 接受方fencing、durable owner恢复、撤销新增准入与付费drain分开；保留当前shutdown/resume。故障矩阵已列，未执行PoC，不宣称已验收 |
| 仅热换headers，却沿用旧system/工具/技能/记忆或权限上下文 | 新轮能力缺失或过期权限，任务恢复用错历史；缓存前缀内容/顺序可能变动 | 文档要求完整上下文字节与顺序不变，不能证明安全的变化继续回收；未来必须证明完整调用/上下文更新协议，不能凭一次普通问答放宽spawn fingerprint |
| 将generation/nonce/时间戳塞进prompt或重排tools/cache_control | 缓存读下降，即使首字快也牺牲原任务上下文 | 只许受控transport/control通道，禁止进入prompt/工具参数/历史；未来完整native前缀与实际usage另验 |

上述是被排除方案/未来实现的具体反例，不是声称当前只改文档的PR已经产生运行时回归。设计保留停止、迟到包、工具后续、checkpoint/delegate、重连、并发、价格冻结、预留过期、crash/resume与回退矩阵；请求执行与账务终结分开。不存在可信逐请求协议时停在设计，不能靠“暂未见晚包”或少做任务交付常驻。当前0–约5.3秒仅研究上界，不是已证实可省时间。

缓存与完成口径：共享受控完整平台API body为46753B且最终源码导出相等，真实DeepSeek前后97.97979798%；仅覆盖受控context，不能证明未来常驻CLI隐藏system/tools、所有persona/memory或恢复流程。Grok缓存R1152不变/input+2的历史严格pending保留，按用户20:39新判定接受为噪声；这不是第5步未来PoC的验收。第3步的成功基线是出口恢复后同账号/同原后端，而非不存在的恢复前成功样本。

证据：`step3/code-review-r3.txt`、`step5/code-review-r2.txt`；对应git文档`docs/ttft/OCV5-502-validation.md`与`docs/ttft/OCV5-506-resident-cli-design.md`；`paid-evidence/{billing-agent-box-base-audit.json,billing-agent-box-candidate-audit.json,billing-agent-box-profile-observer-r2.jsonl,billing-agent-box-profile-observer-r5.jsonl,final-source-export-manifest.json,shared-cache-evidence.json,user-2039-cache-acceptance.json,billing-agent-phase-audit-final.json}`。

只核冻结账务：新增9成功/46分；原始加新增29成功，另3次零收费GLM429，合计32次有证据的供应商模型尝试，原Box本地未launch3另列；钱包35181→35135，9条新增结算链闭合。本复核新增调用/扣费0。没有读取凭据或修改产品、池、路由、账务；只新增本0600审查文件。CI及其它步骤由根代理另外收口。
