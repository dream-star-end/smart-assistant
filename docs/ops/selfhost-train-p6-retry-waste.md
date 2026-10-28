# Selfhost P6 retry waste — 2026-10-28

DO NOT MERGE — 待真 Grok OD / 管家。

仅个人版，基线 `35326165f`。本分支不登记 ride、不合并、不发布。涉及 train 路径，须等当前 tip 列车 live 后由管家安排合入顺序（P2→P5→P1）。部署脚本变更未来随 selfhost canonical checkout 生效，不需要重建 runtime image；本次没有执行部署。

## 行为与边界

- 构建前复用现有用户 idle 查询做一次快照；E3 仍保留 600s 最终等待。只有查询成功且确实忙才产生 `user-idle-deferred`，查询错误继续失败。该专用失败原因允许 worker 在后续 tick 重试同 target，普通门禁失败仍禁止自动重发。
- 仅 legacy、platform-from-head、持官方部署锁且尚未暴露的 joint candidate 可写 `.idle-retry.json`。记录放在 release 根目录，原子写入并 fsync。重试要求相同完整 SHA、镜像 ID、可信路径/权限和 marker，且完整验证 master/runtime/bundle 内容。消费记录后进入普通 E1–G 门禁；只省构建，不省验证、smoke 或回滚保护。策略发布继续使用自己的恢复协议。
- worker 在 deploy.lock/planned/spawn 之前复用原来的 host busy 探测，忙则保持排队；构建内部原有 admission 仍保留。
- L0 磁盘不足时，仅 real deploy 的锁 owner 可执行一次原有 `v5-release-gc.sh`，保留 live、previous、unit/container 引用及待重试 candidate，然后重跑完整 L0。GC 引用检查不明、空间仍不足均拒绝。dry-run 不 GC。

## G1 证据与尚未完成的根治

**不能将本次 G1 harness 修复称为历史上游故障的根治。P6(d) 仍待上游中断根因闭环及 live smoke。**

失败列车 `tr-20261027T094003Z-7365e3ea6441` 的 session `g432mvqj6ups0a8114ed356d` 只有两笔成功计费：input/read 为 `30883/0` 与 `100/30833`。第三轮 dispatch `be326ee3-7eb2-41da-850f-8844b9c9c9bf` 以 `crashed/bad_request` 结束。三轮 stable prompt hash 相同（`3e76c7943c35`），不能据此认定缓存被逐出。

只读历史证据：

- `/opt/openclaude/tmp/lease-trains/tr-20261027T094003Z-7365e3ea6441.log`：G1 requests=2、ratio=0.499，报 expected ≥3 billed requests。
- `/var/log/openclaude-v5-selfhost-egress.log.1`，trace `a15de555070fd90c9c015f9313066650`：2026-10-27 10:17:22 UTC 收到 HTTP 200，firstText=null，10:18:11 报 `OpenCode Go stream ended without a successful complete response`；随后请求报 400。
- `/var/log/openclaude-v5-containers/0ae4cc8645e2-2026-10-27T10-48-29-769Z-stop_and_remove.log`：第三轮 `API Error: 400 invalid request body`。
- 后续列车 `tr-20261027T101920Z-2f005ceffb73` 三笔成功、ratio=0.657。缺少失败请求的原始上游 SSE，无法确定是上游截断还是桥接兼容性问题。

旧 harness 接受任意 `isFinal`，把失败终态和内容终帧都视为成功。现在必须收到匹配 peer/cmid 的 `tape_commit/turn_completed`，再等待该轮计费可见才发下一轮；崩溃终态直接失败。回归覆盖内容终帧/提交帧同批到达、延迟提交、第三轮崩溃、错误归属、缺少提交和延迟计费。

固定 Go 模型、三轮、≥3 笔计费、命中率 ≥0.5 均不变；不 skip、不重发 turn、不自动重跑 session。现有真实 Go smoke 仍须由受权环境执行，本会话未调用该模型。下一步需要保存失败请求的安全脱敏 SSE 事件序列/终止类型，复现协议问题后修对应实现，并以同一严格 smoke 验证。

## 用例卫生

原 source-pin/idle 测试因 `cmd_deploy` 新增前置 idle 与 reuse 分支，需同步 stub 和截取边界；原断言不放宽。outer-policy fixture 同步加载 `cmd_cutover` 新增的真实 E3 helper 依赖。host gate 函数移到共享 helper 后，原测试从两份文件拼接提取。worker 测试增加私有 host load/proc/lock fixture，使真实宿主繁忙不能改变用例结果。新增测试通过 selfhost gates CI 执行；全量 commercial/gateway/web-react 留给 CI。
