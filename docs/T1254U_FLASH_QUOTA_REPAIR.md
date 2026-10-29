# t1254u：Flash 识图与月赠额度结清

2026-10-29 只读取证。代码/文案修复可审查；商业目录修复尚未执行。

## Flash：源码已修，商业目录仍在官方文本路由

商业 active entry 200：`deepseek-v4-flash` → `deepseek/deepseek-flash`，
`supports_vision=false`；别名 `deepseek-v4-flash-opencode-go` 同样指向 200。
这是 2026-10-17 OCV5-482 的临时官方路由（admin_audit 3331）。
个人 active entry 261 已是 `opencodego/deepseek-v4.1-flash`，`supports_vision=true`。
OCV5-547 的真实上游键修复已在两侧源码及商业 live `eaebc3c98` 内，不能再修改
白名单或把官方文本路由标为支持识图来掩盖目录差异。

个人验证证据：OCV5-547 在 entry 261 下，测试用户通过真实 Read 图片回答
`723899, 红色`，无 image omitted，usage 26153/26154 与 journal 成功。
本 PR 的 `openCodeGoModelEffort` 回归覆盖 canonical/alias 的正确 Go upstream，
并拒绝旧 upstream 键及官方文本路由谎报 vision。

### 商业空窗内的目录修复（交发布 owner，非本 PR 自动副作用）

1. 不占用或接管 `codex-full-sync-ship` 的 PR/队列。可在 #1218 同一空窗搭车，
   由当时唯一的 queue/production-mutation lease owner 执行。核实实际远端 flock、
   fencing holder/deploy_id，并独立验证该 invocation 保存的 marker nonce。
2. 再读 deploy_state，要求 stable、candidate 空；由 active_slot 推导 health/version。
   核对 master、egress 与容器 runtime 的真实 release 包含 OCV5-547/482 机制。
   只读核对 Go 有可用 key/额度；不打印凭据。目录切换会 bump security epoch，必须等空窗。
3. 保存 active 行（含 lock_version/profile/schema/context）、alias、pricing/visibility、
   model_security_epoch 和现有会话影响范围。若路由已变或 Go 不可用，停止本步骤重新判断；
   不直接 UPDATE catalog，不重用历史 entry/lock_version。
4. 用既有管理入口 `POST /api/admin/model-catalog/switch`（内部 `switchVersion`）提交：

   ```json
   {
     "model_id": "deepseek-v4-flash",
     "engine": "ccb",
     "provider_id": "opencodego",
     "upstream_model_id": "deepseek-v4.1-flash",
     "context_window": 1000000,
     "capability_schema_version": 1,
     "capability_profile": {
       "ccb": {"capability_zero": true, "supports_thinking": true},
       "reasoning": {"supported": [], "codex_model_default": null},
       "supports_vision": true
     },
     "lock_version": 1
   }
   ```

   上述是本次快照的目标示例。执行时 `lock_version` 必须来自刚读取的 active 行，
   其余未改字段必须与该行严格一致；发生漂移先重新评审。仅改 provider、upstream 和
   supports_vision；不修改价格、倍率、可见性、用户余额。不要重新激活旧的禁用别名行。
5. 回读 active 新版本与 alias 指针、pricing/visibility 不变，记录 admin_audit ID。
   用授权 canary 账号通过产品完整链路读取随机数字/颜色图片（新会话、Read tool_result、
   隔 5 分钟续聊），核对实际 Go 服务路由、无 image omitted、正确答案、usage/journal/ledger。
   再验证文本与已有官方 fallback 行为。官方路由仍为 text-only，不能承诺其能承接图片；
   Go 不可用或 capability gate 拒绝时记录未覆盖/失败，不可放宽能力上限让检查变绿。
6. 新异常由同一 owner 用已保存配置通过 `switchVersion` 回退（新读取的 lock_version），
   保留审计与失败证据。旧 retired 行不能直接激活。代码发布异常仍走官方 abort/rollback。

本任务实际不做目录切换、合并、发车或真实计费 canary。交接必须标明“待空窗 apply”。
本 PR 不要求重建 runtime image，也无 schema migration；前端文案需正式 dist 发布。
如搭车批次涉及 egress，依生效面矩阵带 `--egress`，不据本 PR 范围省掉该批次参数。

## 月赠：付款更换期内桶，不是分钟级 TTL

复现：新用户发放 free 300；约 5 分钟后购买 Lite，同一付款事务写
`subscription_expire -300` 与 `subscription +4000`，关联同一订单；随后升级 Pro
按现有余额补足至 10000。首次发放与购买后的周期均为 30 天，持久钱包不动。
近 30 天内发放后不足 10 分钟即结清的记录只有该一笔，且关联订单；
当次全库检查无不足 29 天的 active 周期。这是取证范围内结论，不代表无限期保证。

`subscription_expire` 同时承载自动轮转和订单生效时的旧桶结清，旧 memo 的
`expire … renew/rollover` 容易被理解为月赠提前失效。前端现在把订单关联结清显示为
“订单生效，旧额度结清”，无订单时显示“周期额度结清”；`subscription` 正流水显示
“订阅额度到账”。只翻译严格匹配的旧 memo，未知备注仍原样可见，不改历史账本。

余额重置、真实到期、免费首发防重、支付幂等及锁序都保持原有契约；集成回归验证
五分钟后购 Lite 的 -300/+4000 与新 30 天周期。未证实异常扣款，无需补发。
若用户另有赠额叠加政策诉求，另列金额与依据，补发前在交接标注：
**需管家转用户确认补发金额**。禁止本轮直接加款。
