# OCV5-503 内容派生缓存验证状态

用户批准范围：19:12实现；19:14所有步骤缓存不得下降。不合并不发布，商业版不操作。

30项相关测试通过；固定37,083字节/14slot离线CPU基准250轮：baseline p50 4.090711ms，warm 0.016518ms，省约0.004074秒。cold/miss仍需计算，不能承诺整段TTFT收益。风险：2MiB UTF8/128条上限、完整内容key，源读取和可变meta不缓存。

## 缓存硬门

| 数据 | base 67d13462e | candidate | 结论 |
|---|---|---|---|
| 真正上游cache_read/input/cache_write | 待合法受控对照 | 待合法受控对照 | **未验收** |
| cached tokens比例 | N/A | N/A | 无数据不记0%，不宣称非回归 |

将另保留完整prompt前缀字节/顺序对照作为补充，它不是上游用量证据。普通网页canary运行live而非本分支，不能冒称candidate。拟使用765自己容器的正式local_catalog静态API路径做候选请求的缓存连续性检查，若权限/环境不足则不绕过authority。Box/Grok/Gemini完整候选链尚无同等入口，不外推结论。新增付费请求暂0、扣费0，原测量175积分不是本PR实测。

计划独立审查APPROVED；全diff独立审查、前缀等价、typecheck/lint、托管CI和真实缓存门仍需补齐。PR保持草稿，不能合并/发布或交为验收通过。

远端证据：H/g500-ttft-approved-20261018/step4，H=/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308。
