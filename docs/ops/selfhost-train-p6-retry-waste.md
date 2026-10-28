# Selfhost P6 retry waste — 2026-10-28

DO NOT MERGE — 待真 Grok OD / 管家。

仅个人版，基线 `35326165f`。本分支不登记 ride、不合并、不发布。涉及 train 路径，须等当前 tip 列车 live 后由管家安排合入顺序（P2→P5→P1）。部署脚本变更未来随 selfhost canonical checkout 生效，不需要重建 runtime image；本次没有执行部署。

## 行为与边界

- 构建前复用现有用户 idle 查询做一次快照；E3 仍保留 600s 最终等待。只有查询成功且确实忙才产生 `user-idle-deferred`，查询错误继续失败。该专用失败原因允许 worker 在后续 tick 重试同 target，普通门禁失败仍禁止自动重发。
- 仅 legacy、platform-from-head、持官方部署锁且尚未暴露的 joint candidate 可写 `.idle-retry.json`。记录放在 release 根目录，原子写入并 fsync。重试要求相同完整 SHA、镜像 ID、可信路径/权限和 marker，且完整验证 master/runtime/bundle 内容。消费记录后进入普通 E1–G 门禁；只省构建，不省验证、smoke 或回滚保护。策略发布继续使用自己的恢复协议。
- worker 在 deploy.lock/planned/spawn 之前复用原来的 host busy 探测，忙则保持排队；构建内部原有 admission 仍保留。
- L0 磁盘不足时，仅 real deploy 的锁 owner 可执行一次原有 `v5-release-gc.sh`，保留 live、previous、unit/container 引用及待重试 candidate，然后重跑完整 L0。GC 引用检查不明、空间仍不足均拒绝。dry-run 不 GC。

## G1 证据与尚未完成的根治

**不能将本次 G1 harness 修复称为历史上游故障的根治。续作已通过原严格 live smoke；P6(d) 仍待历史上游中断根因闭环。**

失败列车 `tr-20261027T094003Z-7365e3ea6441` 的 session `g432mvqj6ups0a8114ed356d` 只有两笔成功计费：input/read 为 `30883/0` 与 `100/30833`。第三轮 dispatch `be326ee3-7eb2-41da-850f-8844b9c9c9bf` 以 `crashed/bad_request` 结束。三轮 stable prompt hash 相同（`3e76c7943c35`），不能据此认定缓存被逐出。

只读历史证据：

- `/opt/openclaude/tmp/lease-trains/tr-20261027T094003Z-7365e3ea6441.log`：G1 requests=2、ratio=0.499，报 expected ≥3 billed requests。
- `/var/log/openclaude-v5-selfhost-egress.log.1`，trace `a15de555070fd90c9c015f9313066650`：2026-10-27 10:17:22 UTC 收到 HTTP 200，firstText=null，10:18:11 报 `OpenCode Go stream ended without a successful complete response`；随后请求报 400。
- `/var/log/openclaude-v5-containers/0ae4cc8645e2-2026-10-27T10-48-29-769Z-stop_and_remove.log`：第三轮 `API Error: 400 invalid request body`。
- 后续列车 `tr-20261027T101920Z-2f005ceffb73` 三笔成功、ratio=0.657。缺少失败请求的原始上游 SSE，无法确定是上游截断还是桥接兼容性问题。

旧 harness 接受任意 `isFinal`，把失败终态和内容终帧都视为成功。现在必须收到匹配 peer/cmid 的 `tape_commit/turn_completed`，再等待该轮计费可见才发下一轮；崩溃终态直接失败。回归覆盖内容终帧/提交帧同批到达、延迟提交、第三轮崩溃、错误归属、缺少提交和延迟计费。

固定 Go 模型、三轮、≥3 笔计费、命中率 ≥0.5 均不变；不 skip、不重发 turn、不自动重跑 session。首次会话没有调用 Go；下方续作补充了实际验证，不能把当前成功样本当成历史故障根治。

### 2026-10-28 G1 续作：安全采样与严格 smoke

历史日志再次核实：失败请求 `39147f04f83a041427b5ea6a4998a00a` 的桥接首字节为 2192ms，首文本为空，约 50s 后由完整响应检查拒绝。首字节只说明桥接已开始输出，不证明存在完整上游终态。

新增手动诊断工具 `scripts/v5-go-responses-diagnose.mjs` 与纯采样器 `scripts/lib/go-responses-sse-trace.mjs`。工具复用现有 Responses serializer/translator、协议映射 `muse-spark-1.3-go → muse-spark-1.3-contributor`、固定三条 G1 prompt、同一 session header 和成功历史。使用合成稳定前缀，不读取真实用户 prompt；它是上游协议诊断，不能替代产品会话与计费门禁。

- 采样发生在翻译前，逐字节透传、单 reader、遵守背压，没有 tee、提前抽干或重试。
- 只保存白名单事件名、状态/原因枚举、token/字符计数和耗时；未知字符串归为 `other`。不保存正文、思考、工具名/参数、ID、错误原文、请求体、header 或凭据。
- 单事件解析上限 256 Ki 字符，输入按 8192 字节分片；事件序列最多 48 段，终态元数据独立保留。超限/畸形计数和省略段数明确记录。成功历史最多采集 256 KiB；每轮 120s、整会话 300s，首个失败立即退出。
- 分别记录 `eof`、`read_error`、`cancelled` 和 bridge 结果。`[DONE]`、EOF、上游失败或观测超限都不会升级为成功。截断观测、本地 deadline/cancel 或合成快照 fixture 不能作为历史上游截断的证明。
- 代码没有接入运行中的 egress，没有修改生产 bridge、会话重试、缓存/计费阈值或线上配置。未来运行前仍须 `wait-for-trains.sh --self train-p6` 返回 FREE。

显式 env-key 诊断命令（会消费一次真实 Go 会话；没有自动 key fallback）：

```bash
node --import tsx scripts/v5-go-responses-diagnose.mjs --live \
  --env-file /etc/openclaude/commercial-v5-selfhost.env
```

本次 env-key 诊断在第一笔请求收到 HTTP 401，未进入 SSE。只读核对确认 env member 已 disabled，产品 canary 使用现有 active admin-key affinity；不能把这次 401 归因于历史中断，也不能用它判断产品 key pool 不可用。任务证据目录中的 `G1-POOL-PROBE.mjs` 用 READ ONLY 事务读取该 canary 的现有有效绑定，在内存中经原 KMS/AEAD helper 解密后调用同一诊断 runner，不选择、续期、重绑或修改成员状态。该独立调用是显式修正凭据来源，不是新增自动重试。

原严格产品 G1 在 FREE 后执行一次，目标由 `deploy_state.active_slot=A` 与对应运行 unit 配置推导：session `g432mvrqhmgz52eb2fc030be`，三轮成功、requests=3、prompt=94410、cache_read=62690、cache_write=0、ratio=0.664，40.6s，PASS。三轮成功和每轮计费可见性仍由原 harness 断言。

验证：采样器与 G1 相关 Node 测试 18 pass / 0 fail / 0 skip；真实 bridge 定向 fixture 与既有 Responses bridge 测试 23 pass / 0 fail / 0 skip；`npm run typecheck` 与增量 lint 通过。新增 fixture 进入 selfhost CI，完整套件只交 CI。证据保存在 `$H/train-p6-20261028/evidence/g1-*`，不持久化原始 SSE。

## 用例卫生

原 source-pin/idle 测试因 `cmd_deploy` 新增前置 idle 与 reuse 分支，需同步 stub 和截取边界；原断言不放宽。outer-policy fixture 同步加载 `cmd_cutover` 新增的真实 E3 helper 依赖。host gate 函数移到共享 helper 后，原测试从两份文件拼接提取。worker 测试增加私有 host load/proc/lock fixture，使真实宿主繁忙不能改变用例结果。新增测试通过 selfhost gates CI 执行；全量 commercial/gateway/web-react 留给 CI。

首次 CI 的 lease fixture 继承了 runner 的 `INVOCATION_ID`，误走真实 systemd 发车分支，fake deploy 启动数为零。用拒绝所有 systemd 命令的私有桩重现 T1 的 5 项失败后，fixture 清除该外部 service 标识；CI 显式注入同类标识来覆盖隔离行为。原有 64 项断言不变。
