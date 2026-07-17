# Tier2 Release Drill Ledger

本文件是 Tier2 代码自愈**放行→部署**闭环演练(release drill)的追加式台账。

每次低峰监督下真跑一次 release drill 时,由 codex 修复会话(执行侧 SKILL
`v5-incident-repair` 的 release 分支)在其 clone 内**追加一行**:

```
<repairId> <UTC ISO8601>
```

然后 commit → `oc-selfheal verify` → `oc-selfheal cutover` → `oc-selfheal report
progress "…等待放行"`。这一行 docs-only 改动就是被部署的"恰好获批 SHA"的载荷
(RFC-v5-selfheal-batch1b §4 / §5;分类器把 `docs/**` 归 master 面,走普通 deploy)。

演练纪律见 RFC §5 与 `scripts/v5-selfheal-drill.ts --release` / `--approve`:
condition 保持 firing 直到 `/version==候选 SHA` ∧ deployed 回调落库 ∧ repair 进
`verifying`;归因必须 `source=codex`(不被 probe 抢跑);清场后 policy 回
`auto_repair=false`、无活跃 release request/job、无熔断、无用户通知副作用。

**频率**:批1b 验收低峰真跑一次;之后仅在 release outbox/worker、deployDriver/
classifier、callback 状态机、push/ref 流程、deploy-v5 核心 lane、隧道或审批链变更后
触发,最多季度低峰人工监督一次(docs-only commit 仍会推进 canonical、重启 master)。

---

<!-- release drill 会话在此行以下追加 "<repairId> <UTC ISO>" 记录,每行一条 -->
