# P0 执行 / 验收 Runbook —— v5 Aurora 隔离空壳 + 标签分流

> 目标:v5 第二实例可经 secret 标签经 Caddy 命中(18790),控制面静默、不起容器、
> 现网 v3 零影响、一键回滚。**真实对话留 P1**(agent_containers channel 隔离后)。

## 前置门(全绿才执行 kl-mirror 变更)
- [ ] `npx tsc --build` → 0 error(已含本次顺带清理的 99 个 pre-existing)。
- [ ] `npm run test:gateway`(1200 pass / 0 fail)+ `npm run test:commercial:unit`(0 fail)。
- [ ] Codex 审 P0 代码 diff → PASS。

## 执行(全部在 v5 worktree 本机跑;脚本 ssh kl-mirror)
1. **首次 bootstrap**(建源码树/HOME/openclaude.json/env/unit + 拷依赖 + 起服务):
   ```bash
   scripts/deploy-v5.sh --dry-run     # 先预览
   scripts/deploy-v5.sh --bootstrap
   ```
   预期:`✓ bootstrap 完成`;smoke 显示 `channel=v5 / schedulers=[] / containerRuntime=disabled / agentRuntime=disabled`;v3 /healthz 正常。
2. **Caddy 标签分流**(最高风险,加法式 + 备份 + reload + 探活):
   ```bash
   scripts/v5-caddy-apply.sh --dry-run   # 预览生成的 Caddyfile
   scripts/v5-caddy-apply.sh             # 备份→validate→adapt diff→reload→验证
   ```
   预期:reload 期间无 `[probe] v3 miss`;`✓ 分流验证通过:无标签走 v3、带 secret 走 v5`。secret 打印在输出里,也存 `/etc/openclaude/v5-caddy-secret`。

## P0 验收(证据)
- [ ] **标签命中 v5**:`curl -H 'Host: claudeai.chat' -H "X-OC-V5-Secret: $SECRET" http://<kl>/healthz` → `"channel":"v5"`,登录现有账号见**共享余额/订单**(证共享身份计费)。
- [ ] **无标签零影响**:`curl -H 'Host: claudeai.chat' http://<kl>/healthz` → 仍 v3;reload 前后现网 WS 不掉、`/var/log/openclaude.log` 无异常。
- [ ] **控制面静默**:v5 healthz `schedulers=[]`;`/var/log/openclaude-v5.log` 无任何 scheduler tick;`agent_containers` 无 v5 写入;启动日志 `COMMERCIAL_AUTO_MIGRATE=0`。
- [ ] **环境隔离**:`systemctl show openclaude-v5 -p Environment` 含 `OPENCLAUDE_HOME=/root/.openclaude-v5`,无继承 v3 的 OC_RUNTIME_IMAGE/AGENT_IMAGE。

## 回滚演练(P0 必做)
```bash
scripts/v5-caddy-apply.sh --rollback   # 还原现网 Caddy(移除 v5 分流)+ reload
ssh kl-mirror 'systemctl stop openclaude-v5'   # 停 v5
```
预期:彻底退回现状,v3 完全不变。

## 红线
- 绝不 `systemctl restart openclaude`(v3);绝不改现网库结构(AUTO_MIGRATE=0);changelog 用户亲笔。
