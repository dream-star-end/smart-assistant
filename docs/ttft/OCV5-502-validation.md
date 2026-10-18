# OCV5-502 测试号765 Box出口最小开通验证

用户19:12批准最小开通、后续明确允许正常池default溢出并记录profile；未使用或修改cc1。仅创建root:root0700用户目录和0600单硬链接代理文件，引用现存765出口；同值重复无写入，异值拒绝，不改全局路由/池/登录/目录项/服务。

11:43:26UTC官方个人版部署锁内执行成功；前后canonical/live均67d13462e，没有重启。4项脚本测试、bash语法及两轮独立审查通过，原head14项CI绿；最终文档head独立复审/CI另核。恢复前全部请求失败，cached比例N/A，不记0。

用户允许恢复后同765、非cc1、未改后端代码作基线。普通网页Box首轮/追问27.279/13.243秒，I/R/W=2/0/47741、4/47725/493，对应0%/98.96935009%；两轮actual profile account2。后续同账号、同account2、相同后端，仅候选前端paint计量的复测：28.127/15.770秒，I/R/W=2/34577/13163、4/47724/379，比例72.42469943%/99.20385807%，对应轮次未下降。生成答案长度不同，不能把改善归因开通或代码优化；所有native隐藏前缀未抓取。profile由journal nonce→准确cwd→实际claude进程CLAUDE_CONFIG_DIR值关联，不读取登录内容。

收益是失败→可用，没有开通前成功TTFT，不能承诺省21.355秒。风险低、限765文件；回滚须新授权，不自动删文件。不合并不发布，商业版不动。

## 上游缓存对照与边界

真实 DeepSeek fresh local_catalog 受控调用：基线 I/R/W=256/12416/0，候选相同，cache_read/(I+R+W) **97.97979798%→97.97979798%**。预热另一次 I=12672/R=0；三次共有付费调用，不能按 PR 重复计费。765 自己容器正式路径，不复用旧 turn authority/lease/turnKey。各分支独立生成相同 46,753 字节完整 API body，SHA256 `4c2b8a88feaf93a2a7f99783a8eb0f9353747aef40298105d9493e7156e174aa`；24,820 字节平台 prompt、21 个完整平台 MCP schema 和顺序相同。最新导出 HEAD/摘要绑定在远端 `paid-evidence/final-source-export-manifest.json`。

这是完整受控平台上下文/API-body 的真实缓存证据；本地 persona/memory 固定为空，未复现 native CLI 隐藏 system/默认工具，未部署候选后端。只在此范围确认非下降，不能冒称所有原生引擎/实际用户上下文或候选后端网页均验收通过。离线 hash 是对照绑定，不能单独替代真实用量。共享摘要随本文保存为同号 cache-evidence.json。

证据：H/g500-ttft-approved-20261018/step3 与 paid-evidence；H=/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308。
