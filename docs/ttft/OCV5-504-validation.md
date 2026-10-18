# OCV5-504 用户自选速度与思考档验证

只展示普通/Fast现有目录价格和中性说明“较低档偏重响应速度，较高档偏重复杂任务。”；不改默认选择、effort=null/Follow、支持集合、请求wire或任何system/工具/上下文。58项UI/会话/wire回归、typecheck/lint和独立全diff首审通过；生产构建成功（oc-build00a443fa6546c4fd）。

实际用户收益只来自用户主动选择既有档位，未证明因果省秒，兑现预计 **0秒**；历史普通/Fast差不能用作保证。风险低：展示价格取真实目录，不写死2倍；高思考档说明不承诺质量，模型选择仍由用户决定。真实候选菜单用765普通网页登录后的零发送检查，不为展示改动额外消耗模型请求；最终菜单安全证据在paid-evidence/step6-live-menu-evidence.jsonl和step6-zero-send.exit。

最新文档head独立复审/CI另核，保持草稿，不合并不发布。商业版不操作。

## 上游缓存对照与边界

真实 DeepSeek fresh local_catalog 受控调用：基线 I/R/W=256/12416/0，候选相同，cache_read/(I+R+W) **97.97979798%→97.97979798%**。预热另一次 I=12672/R=0；三次共有付费调用，不能按 PR 重复计费。765 自己容器正式路径，不复用旧 turn authority/lease/turnKey。各分支独立生成相同 46,753 字节完整 API body，SHA256 `4c2b8a88feaf93a2a7f99783a8eb0f9353747aef40298105d9493e7156e174aa`；24,820 字节平台 prompt、21 个完整平台 MCP schema 和顺序相同。最新导出 HEAD/摘要绑定在远端 `paid-evidence/final-source-export-manifest.json`。

这是完整受控平台上下文/API-body 的真实缓存证据；本地 persona/memory 固定为空，未复现 native CLI 隐藏 system/默认工具，未部署候选后端。只在此范围确认非下降，不能冒称所有原生引擎/实际用户上下文或候选后端网页均验收通过。离线 hash 是对照绑定，不能单独替代真实用量。共享摘要随本文保存为同号 cache-evidence.json。

证据：H/g500-ttft-approved-20261018/step6 与 paid-evidence；H=/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308。
