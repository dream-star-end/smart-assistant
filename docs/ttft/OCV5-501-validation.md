# OCV5-501 429透明续接与明确出口错误验证

网关保持唯一 retry owner、共享10次重试预算、指数退避+抖动、Stop 和 native continuation 安全门；429 不受三次同类熔断提前终止，5xx/capacity 保留原熔断。合法 Retry-After 秒数/HTTP-date 编码绝对期限，经官方 CLI result→parser→adapter→runner；等待分片≤60s，避免 timer 溢出且仍可取消。仅确认UID出口缺失/非法且已授权候选内其它账号明确均无绑定时，才返回409 BOX_EGRESS_NOT_CONFIGURED，不空等、不记健康失败；临时/未知读取失败、有绑定或元数据不完整的其它候选保留基线自动恢复机会。

独立首审发现官方CLI synthetic assistant error可能把hint写入历史，已按具体反例修复：仅在既有错误展示边界剥离合法hint，先解码raw result；raw runtime event不变，正常user/model/tool文字绝不清理。真实SessionManager control/hint→429恢复成功的完成正文、live blocks、assistant segments及historical prompt逐字相同。

20:54前281项相关测试通过、typecheck/lint退出0、全diffr3 APPROVED；20:54任务完成增量的测试及独立审查另记，原批准不冒充当前代码批准。固定CLI2.1.302、network-none、仅合成loopback的control/hint各429+resume成功，system/tools/messages相同，hint不进入上游；409保留明确code；新增模拟授权修复后的同session resume检查，不增加真实调用。脚本在scripts/ocv5-501/official-cli-retry-hint.mjs，禁止继承真实登录，零真实供应商请求。

缺出口仅可免原 Box 第一次至最后一次重复失败间隔 **7.828秒**（候选未实测）；不是整个21.355秒的节省。429尊重上游期限可能等更久，保留自动恢复，**不承诺GLM省8.374秒**。风险中等：重试/取消/续接与错误历史，已覆盖预算、Retry-After、大期限、Stop、无续接及实际历史等反例。最新head CI另看PR，不合并不发布。

## 上游缓存对照与边界

真实 DeepSeek fresh local_catalog 受控调用：基线 I/R/W=256/12416/0，候选相同，cache_read/(I+R+W) **97.97979798%→97.97979798%**。预热另一次 I=12672/R=0；三次共有付费调用，不能按 PR 重复计费。765 自己容器正式路径，不复用旧 turn authority/lease/turnKey。各分支独立生成相同 46,753 字节完整 API body，SHA256 `4c2b8a88feaf93a2a7f99783a8eb0f9353747aef40298105d9493e7156e174aa`；24,820 字节平台 prompt、21 个完整平台 MCP schema 和顺序相同。最新导出 HEAD/摘要绑定在远端 `paid-evidence/final-source-export-manifest.json`。

这是完整受控平台上下文/API-body 的真实缓存证据；本地 persona/memory 固定为空，未复现 native CLI 隐藏 system/默认工具，未部署候选后端。只在此范围确认非下降，不能冒称所有原生引擎/实际用户上下文或候选后端网页均验收通过。离线 hash 是对照绑定，不能单独替代真实用量。共享摘要随本文保存为同号 cache-evidence.json。

证据：H/g500-ttft-approved-20261018/step2 与 paid-evidence；H=/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308。

## 用户任务完成影响（20:54增量）

临时故障继续由既有唯一retry owner透明恢复，候选范围/账号pin/native resume/continuation/Stop保持原策略；不实现新的跨账号迁移或默认模型回退。证明只使用原有候选元数据，不借765或其他账号出口。不确定时不提前终止，因此保留旧成功机会。确认无路则明确结束无效等待，保留上下文和已有模型切换入口；只有用户/管理员授权的出口修复后才能恢复同模型任务，不能宣称代码能自动修复配置。

回归增加 resolver临时恢复/绑定候选/未知候选/pin矩阵、真实ToolFetch→FirstRound错误传播，以及Text/Tool修复后原上下文完成。旧dc8托管CI唯一失败是共享model_not_available文案契约，被新Box专属文案意外改变；已恢复原共用文案并补测试，机器诊断code不变。新测试、审查和最新head CI需全部通过才交付，历史日志保留。

冷却边界补充：一次原始账号快照保留requiredAccountId范围；只有无路证明时忽略cooldown检查可能自行恢复的合法绑定账号，正常选择仍用原eligible。夹具推进1.001秒后既有resolve选到恢复的绑定账号完成目标交接，未借UID出口。Session JWT没有服务端自动refresh路径，不把需管理员重新登录的expired账号冒称自动恢复。

生产恢复范围：正常active列表/500上限完全不改。只在确认UID错误且当前快照无其它绑定时，补一次不读凭据的完整账号元数据查询；任意同pin范围cooldown账号、active绑定/未知字段、查询缺失/失败/截断均保持原重试。证明集不按瞬时Sand资格过滤，避免sweeper刷新资格时截断旧恢复机会。没有Box探测、账号重选或全局配置改动；正常成功路径没有新增查询。
