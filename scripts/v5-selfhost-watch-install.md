# v5 selfhost watch 安装说明

本文件只说明安装。实现回合不执行这里的命令，不替换宿主 `/opt/openclaude/v5-selfhost-watch/watch.sh`，不删除 `watch-disarmed`。

timer 实际执行的是安装目录里的 `watch.sh`，不是 git 工作树。

从 OCV5-404 起，`scripts/deploy-v5-selfhost.sh --deploy` 在 committed 之后会从新 live release 原子同步 `watch.sh`（同目录临时文件，内容一致且 `bash -n` 通过才 `mv -T`），只换这一支脚本，`watch.env`、`alert.sh`、停用标记都不动。同步失败只告警不回滚；`--smoke` 会因看护漂移失败，`--status` 的 `watch:` 行显示 `install=same|drift`。下面的手工步骤只在同步失败或首次安装时用。

## 不要做的事

- 不要 `rm` `/opt/openclaude/v5-selfhost-watch/watch-disarmed`，不要改它的内容。`WATCH_DRY=0` 时这个文件是自动回滚的闸门。
- 不要改 `watch.env` 里的 `WATCH_DRY`。
- 不要在 timer 还在用目标文件时，用重定向或 `cp` 把 `watch.sh` 原地截断覆盖。
- 不要 `systemctl restart openclaude-v5-selfhost.service`，也不要重启 egress。
- 不要因为 `recovery_armed=false` 去制造每拍非 0 退出。停用不是 healthy，但只读观察正常完成时进程退出码是 0。健康看状态文件的 `health=`。

## 原子替换

在安装目录内写临时文件，校验后再 `mv -T`。同一目录的 rename 不会留下半截旧脚本。

整段在 `set -euo pipefail` 的子 shell 里执行：任何一步失败都会在 `mv -T` 之前退出，临时文件由 trap 删除，已安装的 `watch.sh` 保持原样。源文件用仓库根目录的绝对路径，不依赖当前目录。

```bash
(
  set -euo pipefail
  d=/opt/openclaude/v5-selfhost-watch
  repo=/opt/openclaude/openclaude-v5-selfhost   # 已快进到含本改动的提交
  src="$repo/scripts/v5-selfhost-watch.sh"
  test -s "$src"
  bash -n "$src"
  before="$(stat -c '%i %y %s' "$d/watch-disarmed") $(sha256sum < "$d/watch-disarmed")"
  tmp="$(mktemp "$d/watch.sh.XXXXXX")"
  trap 'rm -f -- "$tmp"' EXIT
  cp -- "$src" "$tmp"
  test "$(sha256sum < "$src")" = "$(sha256sum < "$tmp")"
  bash -n "$tmp"
  chmod 0755 "$tmp"
  mv -T -- "$tmp" "$d/watch.sh"
  trap - EXIT
  after="$(stat -c '%i %y %s' "$d/watch-disarmed") $(sha256sum < "$d/watch-disarmed")"
  test "$before" = "$after"
  sha256sum "$src" "$d/watch.sh"
  echo INSTALL_OK
)
```

没有打印 `INSTALL_OK` 就是没装上：已安装副本没有被替换，不要手工补做后面的步骤。

标记的 inode / mtime / 大小 / sha256 在安装前后必须一致（上面的 `test "$before" = "$after"`）。alert.sh 这次不用换：观察成功退出 0，不会每 30 秒触发 `OnFailure`。

下一拍 timer（约 30 秒，AccuracySec 5 秒）会执行新文件。装完后只读核对状态文件：`recovery_armed=false`，`observation_executed=true`，`health` 为 `green` 或 `red`，`checked_at` 有值。日志里不能把 `recovery_armed=false` 写成 healthy。

## 重新武装（OCV5-404）

停用标记不要 `rm`。OCV5-420 起由 lease worker 的 autorecover 自动解除（见文末「自动恢复」）；需要立即手动时仍可用已安装副本的 `--rearm`：

```bash
/opt/openclaude/v5-selfhost-watch/watch.sh --rearm
```

整个检查和归档都持有 selfhost 发布锁（`/run/openclaude-v5-selfhost/deploy.lock` 的 flock）：期间不会有 `--deploy` 开始（deploy 拿不到锁会排队重试），也不会有第二个 `--rearm`。锁被占用就直接拒绝。

它要求：`WATCH_DRY=0`；已安装副本就是正在执行的这份；连续 `WATCH_REARM_CHECKS`（默认 3，间隔 `WATCH_REARM_INTERVAL_SEC` 默认 5 秒）次都满足——标记是普通文件、没有 manual-recovery、没有活的发布锁 holder / 维护窗口 / cutover grace、复合健康绿、healthz 明确给出 `deps.pg=ok`（缺字段也拒绝）；最后一次探针后、归档前再查一遍标记、manual-recovery、维护和 grace。任一不满足打印 `REARM_REFUSED <原因>` 并退出 1，标记和失败计数都不动。

全部通过后在锁内把失败计数清零，再把标记改名为 `watch-disarmed.rearmed-<UTC>` 留作证据；改名失败就把计数恢复原值并拒绝。成功时状态文件写 `recovery_armed=true`，打印 `REARM_OK archived=<路径>`。

下一拍 timer 按武装路径检查，日志应出现 `复合健康绿,清失败计数`。

## 告警（OCV5-410）

`alert.sh`（仓库 `scripts/v5-selfhost-watch-alert.sh`）随部署与 `watch.sh` 一起同步。看护在回切、FAIL-LOUD、两级兜底失败、停用期间变红 / 恢复、`--rearm` 时调用它；systemd 的 `OnFailure` 仍以 `alert.sh <unit>` 调用。

模式由 root 0600 文件 `/etc/openclaude/selfhost-watch-alert.env` 的 `WATCH_ALERT_MODE` 决定，**默认 dry**：

- `off`：只写看护日志。
- `dry`：写看护日志，并把本会发出的告警存为 `/var/lib/openclaude-v5-selfhost-watch/alert-dry/*.json`（最近 200 条），不连网、不写库。
- `live`：企微群机器人 webhook（`WATCH_ALERT_WECOM_KEY`，带外，不依赖 master / PG）+ 站内信（`WATCH_ALERT_INBOX_UID`，默认 3）与 `admin_alert_outbox`（同一事务）。任一通道失败写 `alert-spool/`，下一拍重投；超过 50 次或 24 小时转 `alert-spool/dead/`。

配置文件只按 `KEY=VALUE` 解析，不执行；权限不是 600/400 时不使用其中的 key。日志只记 key 指纹。`alert.sh --status` 显示模式、通道、积压；`deploy-v5-selfhost.sh --status` 的 `watch:` 行也带这一段。

切 live 前须用户：建企微群机器人并写 key、确认收件人 uid、同意先发一条带「测试」字样的消息。


## 门禁失败留在新版（OCV5-418）

个人版只有本人在用（用户 2026-10-14 02:54 规则），发布后门禁失败可以留在新版排查、前滚修复。商业版不受影响。

开关在 root 0600 文件 `/etc/openclaude/selfhost-deploy-policy.env`（只按 `KEY=VALUE` 解析，不执行；不是本用户所有或组/他人可写时整份忽略）。环境变量同名优先，供人工 `--deploy` 用：

- `OC_V5_SELFHOST_ON_GATE_FAIL=rollback|stay`：缺省或非法值都是 `rollback`，即原有补偿。
- `OC_V5_SELFHOST_STAY_WINDOW_SEC`：维护窗口秒数，默认 `7200`（2 小时）。
- `OC_V5_SELFHOST_GATE_FAIL_DRILL_SHA=<40 位 sha>`：演练用。只对这一个 sourceCommit 生效：真实门禁照跑，通过后仍判失败一次。用完删掉这行。

`stay` 只覆盖「新 release 已切换、restart 成功」之后的正向门禁：healthz 收敛（不收敛也留）、`GET /` oc-build、egress、C1–C3。安装 / 迁移 / 翻转 / restart 失败时新版可能根本没起来，照旧补偿回滚。

门禁失败且 `stay` 时：

- 不补偿，saga 不回滚运行面（runtime tuple 照常记入 history，便于之后按 history 回退）。
- survivor 落 `phase=kept-failed` 后 `--disarm-kept`（不写 committed marker）；该 phase 下健康红也不恢复。
- 写 `/run/openclaude-v5-selfhost/planned-maintenance`（`until=now+窗口`，`source=deploy-gate-fail-stay`），窗口内看护不回切；过期后看护恢复保护，复合健康红达到阈值仍会回切。下一班 committed 时撤掉这份窗口（人工写的维护标记不动）。
- 不写 model authority 不可逆 marker、不跑 release GC、不同步看护与开机脚本；`.prev-release` 仍指向上一版。
- 列车记 `failed`，reason 以 `gate-failed-kept-live=<rel>` 开头并带失败项；worker 不结算搭车（survivor phase 不是 committed），在这班之前登记的搭车会收到失败回调，同一 tip 不自动重发。
- 发 critical 告警 `deploy_gate_failed_kept`（走 `alert.sh`，模式同上）。
- 现场：cutover 日志路径写在告警正文与列车 evidence_json 里。

收尾：修好后 push 新 tip 并搭车前滚；或按 runbook 人工回到 `.prev-release`。`deploy-v5-selfhost.sh --status` 的 `gate-fail:` 行显示当前策略、survivor phase 与维护窗口。

宿主现状（2026-10-14 起）：策略文件已按用户确认写成 `OC_V5_SELFHOST_ON_GATE_FAIL=stay`，窗口用默认 2 小时。首次上线后用 `OC_V5_SELFHOST_GATE_FAIL_DRILL_SHA` 演练过一次门禁失败，演练行已删除。要恢复旧行为，把该行改成 `rollback` 或删掉文件。

## 自动恢复（OCV5-420）

这是纯 AI 项目，没有人会来跑 `train resolve`、`--rearm` 或应急恢复脚本。以前停下来等人的三处现在由 lease worker 每拍（30s）调用的 `scripts/v5-selfhost-autorecover.sh` 接管：

- 列车 `recovery_required`（发布中途被打断，或补偿本身失败）；
- `.manual-recovery-required`（cutover 两级补偿失败、看护 FAIL-LOUD 或两级兜底失败）；
- `watch-disarmed`（看护停用）。

每拍先让路：发布进程在跑、cutover survivor 还在、上一个恢复动作没结束时不动。动作是已安装看护的 `watch.sh --auto-recover`，经 `systemd-run`（unit `openclaude-v5-selfhost-autorecover-action`）异步执行并持发布锁：

- 连续 `WATCH_REARM_CHECKS` 次复合健康绿且 `deps.pg=ok` → 把 `.manual-recovery-required` 改名为 `.autocleared-<UTC>`、`watch-disarmed` 改名为 `.autorearmed-<UTC>`，失败计数清零，看护恢复全部保护。
- 仍红：外部依赖（pg / redis / docker）、schema、env 类不回切（回切救不了，等依赖恢复或修代码）；其余走与阈值路径相同的两级兜底（tier1 回上一份 release → tier2 恢复备份 unit）。
- 退出码：0 绿、1 仍红、3 不回切类、75 现在不能动（锁 / 维护窗口 / grace / 演练模式，不计次数）。

兜底按退避执行：立即、5 分钟、15 分钟，共 3 次；之后每 15 分钟只探测（`--probe-only`），绿了照样自动归档标记。

绿了之后，`recovery_required` 列车由 autorecover 结成 `failed`（事件 `autorecover-resolved`）。worker 的「同 target 不自动重发」只认执行器自报的失败，所以仍在登记中的搭车会自动再发一班，即重跑被打断的列车。同一 target 24 小时内自动重跑超过 2 次就不再重跑：搭车失败回调给登记它的会话 / 工单，并升级。

升级：兜底 3 次仍红、事件超过 30 分钟未恢复、重跑超限或缺看护时，用 `oc-task`（uid 3）在 OCV5 项目开一张 P1 bug 并 `ticket approve`（agent 身份），bug 首站是 AI 巡检站，PatrolEngine 会派给 AI。每个事件只开一张；之后恢复了会在该单留言「已自愈」。

告警只做记录：`autorecover_started` / `autorecover_escalated` / `autorecover_closed`（alert.sh，模式同上）。状态在 `/var/lib/openclaude-v5-selfhost-watch/autorecover/`（`incident.env`、`history/`）。参数可用 `OC_V5_AUTORECOVER_*` 环境变量覆盖（`/etc/openclaude/lease-worker.env`）。
