# OCV5-501 429透明续接与明确出口错误验证

网关保持唯一 retry owner、共享10次重试预算、指数退避+抖动、Stop 和 native continuation 安全门；429 不受三次同类熔断提前终止，5xx/capacity 保留原熔断。合法 Retry-After 秒数/HTTP-date 编码绝对期限，经官方 CLI result→parser→adapter→runner；等待分片≤60s，避免 timer 溢出且仍可取消。缺 Box 出口明确409 BOX_EGRESS_NOT_CONFIGURED，不空等、不记健康失败。

独立首审发现官方CLI synthetic assistant error可能把hint写入历史，已按具体反例修复：仅在既有错误展示边界剥离合法hint，先解码raw result；raw runtime event不变，正常user/model/tool文字绝不清理。真实SessionManager control/hint→429恢复成功的完成正文、live blocks、assistant segments及historical prompt逐字相同。

281项相关测试全部通过、typecheck/lint退出0；全diff复审APPROVED。固定CLI2.1.302、network-none、仅合成loopback的control/hint各429+resume成功，system/tools/messages相同，hint不进入上游；409保留明确code。脚本在scripts/ocv5-501/official-cli-retry-hint.mjs，禁止继承真实登录，零真实供应商请求。

缺出口仅可免原 Box 第一次至最后一次重复失败间隔 **7.828秒**（候选未实测）；不是整个21.355秒的节省。429尊重上游期限可能等更久，保留自动恢复，**不承诺GLM省8.374秒**。风险中等：重试/取消/续接与错误历史，已覆盖预算、Retry-After、大期限、Stop、无续接及实际历史等反例。最新head CI另看PR，不合并不发布。

## 上游缓存对照与边界

真实 DeepSeek fresh local_catalog 受控调用：基线 I/R/W=256/12416/0，候选相同，cache_read/(I+R+W) **97.97979798%→97.97979798%**。预热另一次 I=12672/R=0；三次共有付费调用，不能按 PR 重复计费。765 自己容器正式路径，不复用旧 turn authority/lease/turnKey。各分支独立生成相同 46,753 字节完整 API body，SHA256 `4c2b8a88feaf93a2a7f99783a8eb0f9353747aef40298105d9493e7156e174aa`；24,820 字节平台 prompt、21 个完整平台 MCP schema 和顺序相同。最新导出 HEAD/摘要绑定在远端 `paid-evidence/final-source-export-manifest.json`。

这是完整受控平台上下文/API-body 的真实缓存证据；本地 persona/memory 固定为空，未复现 native CLI 隐藏 system/默认工具，未部署候选后端。只在此范围确认非下降，不能冒称所有原生引擎/实际用户上下文或候选后端网页均验收通过。离线 hash 是对照绑定，不能单独替代真实用量。共享摘要随本文保存为同号 cache-evidence.json。

证据：H/g500-ttft-approved-20261018/step2 与 paid-evidence；H=/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308。
