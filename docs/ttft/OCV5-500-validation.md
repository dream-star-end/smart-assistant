# OCV5-500 非Codex链路首字计时验证

可见 process 正文双 rAF 补 paint；按 probe 对象 WeakSet 去重，取消不提前认领，晚到/替换 probe 使用最新引用。引擎/代理阶段时钟冻结 trace、model 和 process generation，不额外读取流，不改 system/tools/messages/cache_control。Grok relay 仅用本身 HTTP requestId/slot，不猜测平台 trace；AG relay 复用唯一 reader，不伪造正文/ready。

直接 TTFT 节省 **0 秒**。风险：少量计时/日志开销，前端去重/取消时序；有真实 MessageList、remount、取消、替换/晚到 probe、分块SSE/UTF8、backpressure、usage不变和迟到进程测试。

85 项后端、41 项原生 relay、64 项网页测试通过；生产前端构建通过。最终类型检查/最新 head CI 以 PR 状态和远端退出码为准，不把旧 head 的绿灯挪用。独立全 diff 首轮 APPROVED 后已修复 currentModel 计量归属，最终 head 继续独立复审。

765 普通真实网页、仅该浏览器静态 GET 覆盖候选生产资产（oc-build 22968b188e236e0c）；API/WS/Origin/认证保持原站。临时 context 仅给该 loopback origin 授予 local-network-access，处理 Chromium 拦截，不关闭浏览器安全检查。Box 两轮 account2：首字/paint 28.127/28.348 秒、15.770/15.981 秒；Grok 首字/paint 60.813/61.140 秒。runtime 后端均仍 67d13462e；Grok 变慢不能凭单次波动归因前端，也不能隐去。此验证支持过程首绘制修复，**不支持候选后端阶段日志已在线运行**。

## 上游缓存对照与边界

真实 DeepSeek fresh local_catalog 受控调用：基线 I/R/W=256/12416/0，候选相同，cache_read/(I+R+W) **97.97979798%→97.97979798%**。预热另一次 I=12672/R=0；三次共有付费调用，不能按 PR 重复计费。765 自己容器正式路径，不复用旧 turn authority/lease/turnKey。各分支独立生成相同 46,753 字节完整 API body，SHA256 `4c2b8a88feaf93a2a7f99783a8eb0f9353747aef40298105d9493e7156e174aa`；24,820 字节平台 prompt、21 个完整平台 MCP schema 和顺序相同。最新导出 HEAD/摘要绑定在远端 `paid-evidence/final-source-export-manifest.json`。

这是完整受控平台上下文/API-body 的真实缓存证据；本地 persona/memory 固定为空，未复现 native CLI 隐藏 system/默认工具，未部署候选后端。只在此范围确认非下降，不能冒称所有原生引擎/实际用户上下文或候选后端网页均验收通过。离线 hash 是对照绑定，不能单独替代真实用量。共享摘要随本文保存为同号 cache-evidence.json。

证据：H/g500-ttft-approved-20261018/step1 与 paid-evidence；H=/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308。
