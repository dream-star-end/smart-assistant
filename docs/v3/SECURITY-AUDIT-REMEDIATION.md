# v3 商用版安全审计 remediation(2026-04-21 ~ 2026-04-22)

Codex 4 轮审计闭环,本文档记录已修项、R4 PASS 后的遗留 NICE-TO-HAVE 和运维层根治项。

---

## 结论

**代码层 PASS**。4 轮累计修复如下:

| 轮次 | BLOCKING | IMPORTANT | NICE-TO-HAVE | 关键 commit |
|------|----------|-----------|--------------|-------------|
| R1 | 2 (B1/B2) | 7 (I3~I9) | 2 (N11/N13) | `e5e75f3`, `0214bcd` |
| R2 | 0 | 3 | — | `6827d05` |
| R3 | 0 | 1 | — | `8f8c313` |
| R4 | 0 | 2(均为运维层) | 6 | — |

---

## R1~R3 已修列表

### R1 BLOCKING

- **B1** `safeWsSend` 统一导出 + 6 个调用点替换(背压即 close 重连),修 WS 卡帧静默丢消息
- **B2** `openclaude-v3-host-firewall.service` drop-in,docker restart 后自动重放 iptables 规则(V3_EGRESS_IN 链)

### R1 IMPORTANT(I3~I9)

- **I3** `clientIpOf` 只信任 loopback peer 的 XFF / CF-Connecting-IP(R2/R3 后续加强)
- **I4** `pg-backup-openclaude.sh` umask 077 + `install -m 600` + 原子 rename,防备份文件泄漏
- **I5** `pg-backup-openclaude.service` flock 防并发 + `TimeoutStartSec=30min` + OnFailure 告警
- **I6** `docker-image-prune.sh` 收窄到 `openclaude/openclaude-runtime` + 保留最近 3 tag + 检查 in-use
- **I7** migration `0024_agent_containers_secret_hash_length.sql`:`octet_length(secret_hash)=32` CHECK 约束(NOT VALID + VALIDATE 模式)
- **I8** `wechat.js` 每轮 poll `timeout = min(POLL_TIMEOUT_MS, deadlineRemaining)`,防 deadline 过后 fetch 还在跑
- **I9** `markdown.js` 统一 `_safeAttr` helper,audio/video/pdf 的 `src/href` 过 `_safeMediaUrl + htmlSafeEscape`

### R1 NICE-TO-HAVE

- **N11** `sessionManager.ts` eviction 先 `await runner.shutdown()` 再从 map 删除,防尾字节丢失
- **N13** `v3-timer-failure-alert@.service` 统一告警模板(`logger local0.emerg`)

### R2 IMPORTANT

- **R2#1** `/stop` 命令必须 `ws.readyState === 1` 才允许,否则 teardown 会让重连后 hello 汇报 inFlight=false,旧 turn 继续跑
- **R2#2** `safeWsSend` 的 `ws.send()` 本身也 try/catch;失败主动 `close(4000)` 触发重连
- **R2#3** 信任 CF-Connecting-IP 前先校验 CF-RAY header(R3 替换为 CIDR 法)

### R3 IMPORTANT

- **R3** `clientIpOf` 真正信任根:验证 Caddy peer(XFF 首段,TCP 握手不可伪造)∈ Cloudflare IPv4/IPv6 edge CIDR,才信 CF-Connecting-IP;否则 peer 本身就是攻击者真实 IP,直接作 rate-limit key。CF CIDR 硬编码 15 IPv4 + 7 IPv6 段,2026-04-22 从官网 ips-v4/v6 校验。

---

## R4 遗留清单(不 block 收尾)

### R4 IMPORTANT — 运维层纵深防御

#### 1. GCP firewall 80/443 Cloudflare-only 白名单

**现状**:GCP `allow-https` firewall rule `source-ranges=0.0.0.0/0`,任何 IP 可直连 Caddy。

**为什么代码层已经够**:R3 修复让 `clientIpOf` 在非 CF peer 场景下用 TCP peer IP 作 rate-limit key,CF-Connecting-IP 不再被信任。应用层 WAF bypass 已堵死。

**为什么还想做**:纵深防御。直连 Caddy 仍可绕过 CF 的 WAF / DDoS / Bot 管理;如果未来有未修的 L7 漏洞,CF 前置规则能吸一波。

**风险(one-way door)**:
- CF 新增 IP 段需同步白名单,否则用户被拒
- boss 换 IP 直连调试需另留 rule
- GCP firewall 改错会锁 SSH(需先 copy 好 allow-ssh 且验证通)

**操作脚本**(未执行,待 boss 决策):
```bash
# CF IPv4 + IPv6 edge 段(源:https://www.cloudflare.com/ips-v4 / ips-v6 2026-04-22)
CF_V4="103.21.244.0/22,103.22.200.0/22,103.31.4.0/22,104.16.0.0/13,104.24.0.0/14,108.162.192.0/18,131.0.72.0/22,141.101.64.0/18,162.158.0.0/15,172.64.0.0/13,173.245.48.0/20,188.114.96.0/20,190.93.240.0/20,197.234.240.0/22,198.41.128.0/17"
CF_V6="2400:cb00::/32,2606:4700::/32,2803:f800::/32,2405:b500::/32,2405:8100::/32,2a06:98c0::/29,2c0f:f248::/32"

# GCP 默认 firewall rule "allow-http" / "allow-https" 先备份
gcloud compute firewall-rules describe allow-https --format=yaml > /tmp/allow-https.bak.yaml

# 收紧 source-ranges(先 IPv4,IPv6 另起一条 rule)
gcloud compute firewall-rules update allow-https \
  --source-ranges="$CF_V4"

# IPv6 rule 新建
gcloud compute firewall-rules create allow-https-cf-v6 \
  --direction=INGRESS --action=ALLOW --rules=tcp:443 \
  --source-ranges="$CF_V6" --target-tags=https-server

# 保留一条 emergency allow,限来源 = boss 调试 IP(放在 /etc/openclaude/boss-ip.txt,定期 rotate)
gcloud compute firewall-rules create allow-https-boss-emergency \
  --direction=INGRESS --action=ALLOW --rules=tcp:443 \
  --source-ranges="<BOSS_IP>/32" --target-tags=https-server
```

**触发条件**:下次出现 L7 相关事件 / boss 主动要求 / 每年一次定期复查。

#### 2. runtime docker 镜像刷新策略

**现状**:当前生产 image tag `806610b8aa64`,2026-04-21 12:08 构建;build-image.sh 已改为从 v3 仓库构建(memory `feedback_v3_image_built_from_master.md` 过时)。

**R4 为什么保留为 IMPORTANT**:R1/R2/R3 的 web/gateway 修复是否进了容器?

**实际验证结论**:`curl https://claudeai.chat/modules/commands.js | grep 'readyState !== 1'` = 1。web assets 从 host `/opt/openclaude/openclaude/packages/web/public/` 服务,不走容器。gateway `sessionManager.ts` 在容器内是 per-user 单 session,eviction 不 exercised。**实际不构成漏洞**。

**触发条件**:
- 容器内(非 host)代码层出了 P0/P1 安全问题
- 启用任何把 web 静态文件从容器服务的路径
- build-image.sh 再被改动

**SOP**(真要刷 image):
```bash
cd /opt/openclaude/openclaude-v3/packages/commercial/agent-sandbox
./build-image.sh "$(git rev-parse --short=12 HEAD)"
scp /var/lib/openclaude-v3/images/openclaude-runtime-<tag>.tar.gz commercial-v3:/tmp/
ssh commercial-v3 "docker load -i /tmp/openclaude-runtime-<tag>.tar.gz"
ssh commercial-v3 "sed -i 's|OC_RUNTIME_IMAGE=.*|OC_RUNTIME_IMAGE=openclaude/openclaude-runtime:<tag>|' /etc/openclaude/commercial.env"
ssh commercial-v3 "systemctl restart openclaude"
# 老容器自然 LRU 淘汰,用户下次启容器自动拿新 image
```

### R4 NICE-TO-HAVE(长期 backlog)

1. **CF CIDR 硬编码列表自动校验**。加 CI 脚本 `ci/validate-cf-cidr.sh` — 每周拉 `https://www.cloudflare.com/ips-v4` 和 `ips-v6` diff 本仓库 `util.ts` 里的 `CF_IPV4_CIDRS` / `CF_IPV6_CIDRS`,有差异 PR 或告警。触发:CF 改段(过去 3 年改过 1 次)。
2. **IPv6 parser 边界加固**。`util.ts` 里 `ipv6ToBigInt` 对多重 `::`、expanded IPv4-mapped、`::ffff:0102:0304` 已有 `isIP` 前置校验保护,不是可利用问题。未来若要作独立公共 API 再收紧。
3. **sessionManager eviction race**。`await runner.shutdown()` 期间 session 仍在 map,新请求可能拿到 shutdowning runner。加 `evictingSet` 或 shutdown 后重查 `lastUsedAt`。极小窗口,未见实际问题。
4. **pg-backup flock 非抢到直接 exit 0 与注释一致化**。当前 `flock -n` 拿不到锁 exit 1 会触发 OnFailure 告警,但注释说"直接退出 0"。改 `flock -n ... || exit 0`(注释里说的),避免 cron 偶发重叠时误告警。
5. **docker-image-prune dangling 仍是全局 scope**。tagged image 已 repo-scoped,但 `docker image prune -f` 会清所有 dangling。当前 v3 机器只跑 openclaude 栈,安全。未来该机跑别的 docker 服务时要改成 `--filter "label=com.openclaude.repo=runtime"` + label 源头打标。
6. **v3-timer-failure-alert 目前只 logger emerg**。未来接 webhook/Telegram 告警把 ExecStart 改一行。现在靠 journalctl 巡检兜底。
7. **deploy-v3 snapshot 只保留一代 `.prev/`**。回滚到上上代要手工。未来改 `.prev-<timestamp>/` 多代 + 记录 deployed commit marker。

---

## 发版脚注

- R3 deployed commit: `4c8e3cb` (chore(deploy): v8f8c313),2026-04-22
- 最后一次 healthz: 2026-04-22,`curl https://claudeai.chat/healthz` = OK
- 本文档由 Codex R4 audit 归档,下次重启审计周期以此为 baseline。
