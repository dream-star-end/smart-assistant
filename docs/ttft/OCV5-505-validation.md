# OCV5-505 工具说明等价计算验证状态

用户批准范围：19:12实现；19:14所有步骤缓存不得下降。不合并不发布，商业版不操作。

19项相关测试通过。固定68,576字节/14slot离线基准1500轮：partial baseline p50 2.410642ms→candidate 1.995267ms，省约0.000415秒；legacy/all-tools亦未观察到变慢。全工具、说明、顺序保持，不做摘要删减。

## 缓存硬门

| 数据 | base 67d13462e | candidate | 结论 |
|---|---|---|---|
| 真正上游cache_read/input/cache_write | 待合法受控对照 | 待合法受控对照 | **未验收** |
| cached tokens比例 | N/A | N/A | 无数据不记0%，不宣称非回归 |

将另保留完整prompt前缀字节/顺序对照作为补充，它不是上游用量证据。普通网页canary运行live而非本分支，不能冒称candidate。拟使用765自己容器的正式local_catalog静态API路径做候选请求的缓存连续性检查，若权限/环境不足则不绕过authority。Box/Grok/Gemini完整候选链尚无同等入口，不外推结论。新增付费请求暂0、扣费0，原测量175积分不是本PR实测。

计划独立审查APPROVED；全diff独立审查、前缀等价、typecheck/lint、托管CI和真实缓存门仍需补齐。PR保持草稿，不能合并/发布或交为验收通过。

远端证据：H/g500-ttft-approved-20261018/step7，H=/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308。
