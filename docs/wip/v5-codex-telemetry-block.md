# v5 codex 遥测直连封堵(C1 配置面 + A 网络面)

分支 `feat/v5-codex-telemetry-block`(base aa54e894)。目标:封堵 v5 容器 codex 0.137
CLI 硬编码遥测端点绕 loopback relay 直连 chatgpt.com / ab.chatgpt.com,防账号代理 IP
与宿主机真实 IP 同时暴露给 chatgpt 侧(破坏账号 IP 纯净)。

## 威胁模型(codex 0.137 实测端点)

| 端点 | 用途 | 处置 |
|---|---|---|
| `ab.chatgpt.com/otlp/v1/metrics` | statsig/OTLP metrics(带 client key) | C1 `otel.metrics_exporter=none` + A ipset |
| `chatgpt.com/backend-api/codex/.../codex-backend/agent-identity` | agent identity | C1 `chatgpt_base_url`→loopback relay(404) + A ipset |
| `chatgpt.com/backend-api/codex/analytics-events/events` | analytics events | C1 `analytics.enabled=false` + relay allowlist 404 |
| `api.github.com/repos/openai/codex/releases/latest` | 启动更新检查 | C1 `check_for_update_on_startup=false`(不进 A,api.github 有合法用途) |

容器注入 `HTTPS_PROXY=172.31.0.1:18892`(内部 Anthropic egress 代理,supervisor.ts)。
codex reqwest 若继承,遥测直连会先 CONNECT 内部代理 → 网络层 A 按 dst IP 匹配看到的是
代理 IP 而非 chatgpt → 不 fail-closed。故 **nit1 scrub proxy env 是 A 生效前提**。

## 三层防御(defense-in-depth)

1. **C1 主根治 · 镜像 managed_config**(root-owned 用户不可覆盖):
   `/etc/codex/managed_config.toml`。
2. **C1 双保险 · 每-spawn `-c`**:`buildCodexTelemetryHardeningArgs()`,每次
   `codex app-server` spawn 无条件追加(不挂 provider override 成功路径)。
3. **A 终极兜底 · host ipset REJECT**:即便 codex 升级新增端点/配置键漂移,只要它对
   被封 host 发直连 443,DOCKER-USER 一条规则 REJECT(tcp-reset)。

## codex 0.137 配置键探针实证(2026-07-03,镜像 v5-ccb-5af8167f)

方法:`docker run -u 0 --entrypoint bash <image>`,原生二进制
`.../codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex` grep -a 扫串 +
运行时 `codex app-server` 加载 `/etc/codex/managed_config.toml` 看是否报错。

- `/etc/codex/managed_config.toml` **被 0.137 读取**(二进制含该路径串)。
- 有效键(全部 clean load,无 `unknown field`/`Invalid configuration`):
  - `check_for_update_on_startup`(顶层 bool)
  - `chatgpt_base_url`(顶层 string;独立于数据面 `model_providers.<id>.base_url`)
  - `[analytics] enabled`(bool;二进制字面量 `analytics] enabled`)
  - `[otel] trace_exporter` / `[otel] metrics_exporter`
- exporter 合法枚举实测 = `none` / `statsig` / `otlp-http` / `otlp-grpc`
  (`metrics_exporter="bogusvalue"` → `unknown variant ... expected one of none,statsig,otlp-http,otlp-grpc`)。
- **方案偏离**:方案原写 `[otel] log_exporter`,但 0.137 **无此键**(`[otel]` 不 deny
  unknown → 静默忽略,非真实开关)。真正承载遥测的是 `trace_exporter`(traces)与
  `metrics_exporter`(statsig 指标),两者置 `none` 即断流。已按实测剔除 `log_exporter`。
- **失败模式(关键)**:已知键的**非法值**会让 codex 丢弃**整份** managed_config 回落
  默认(`Invalid configuration; using defaults`)→ 全部遥测复活。故只放实测有效键值;
  这也是为什么必须有 A 网络面兜底。
- `-c` 覆盖路径接受同组键(managed_config + `-c` 组合加载 clean),双保险成立。

## 落点

C1:
- `packages/commercial/agent-sandbox/runtime/codex-managed-config.toml`(新)
- `packages/commercial/agent-sandbox/Dockerfile.openclaude-runtime`(codex 安装后 COPY)
- `packages/gateway/src/engine/codexShared.ts`:`buildCodexTelemetryHardeningArgs()` + `buildCodexEnv()` proxy scrub/NO_PROXY(nit1)
- `packages/gateway/src/engine/codexAppServerRunner.ts`:spawn args 无条件 spread telemetryArgs

A:
- `packages/commercial/scripts/setup-codex-telemetry-block.sh`(新)
- `packages/commercial/scripts/openclaude-v5-codex-telemetry-block{,.-refresh}.service` / `.timer`(新)

## host 侧安装 / 回滚(kl-mirror,仅 v5 网段 172.31.0.0/16)

前置:`apt-get install -y ipset`(kl-mirror 当前未装)。

```bash
# 安装(建 ipset + DOCKER-USER REJECT + 首刷)
sudo bash /opt/openclaude/openclaude-v5/packages/commercial/scripts/setup-codex-telemetry-block.sh install

# systemd(boot 自动 + 定时 atomic swap 刷新 DNS)
cp /opt/openclaude/openclaude-v5/packages/commercial/scripts/openclaude-v5-codex-telemetry-block*.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now openclaude-v5-codex-telemetry-block.service
systemctl enable --now openclaude-v5-codex-telemetry-block-refresh.timer

# 观测
iptables -L DOCKER-USER -v -n | grep 'oc-v5 codex telemetry egress block'   # 规则 + counters
ipset list oc-v5-codex-tele-block                                            # 当前封堵 IP

# 一键回滚(不影响 v3)
systemctl disable --now openclaude-v5-codex-telemetry-block-refresh.timer openclaude-v5-codex-telemetry-block.service
sudo bash /opt/openclaude/openclaude-v5/packages/commercial/scripts/setup-codex-telemetry-block.sh --uninstall
```

快速移除 `api.openai.com`(误伤面大):编辑脚本顶部 `DOMAINS_OPTIONAL=()` 清空 → `refresh`。

## 六 nit 落实

- **nit1** proxy scrub + `NO_PROXY=127.0.0.1,localhost,172.31.0.1`:`buildCodexEnv()`(A fail-closed 前提)。
- **nit2** relay 辅助路径 404 不 fetch/不 mark credential/不计费:`internalCodexRelay.test.ts` 锁定
  (PATH_NOT_ALLOWED 在 identity/dispatcher/fetch 之前拒)。
- **nit3** ipset atomic swap + DNS 失败保留旧 set(不 flush 成空) + 限 tcp/443 + counters + `--uninstall`。
- **nit6** IPv6:v5 net `EnableIPv6=false` + host 无 global inet6 → 脚本 `assert_ipv6_disabled` 硬断言 + 注释声明。

## 镜像重建后真机验证清单(镜像重建 + host unit 安装后执行)

1. **SNI 基线 vs 上线后**:`tcpdump -i br-<v5bridge> -n 'tcp port 443' | grep -i sni`
   基线应见 chatgpt/ab.chatgpt 直连 SNI → 上线后这些 dst 只剩 RST(REJECT)。
2. **容器内立即 RST(非挂 5s)**:`docker exec <v5容器> curl -sv --max-time 8 https://ab.chatgpt.com/`
   应立即 `Connection reset by peer`(REJECT --reject-with tcp-reset)。
3. **canary gpt-5.5 turn**:一轮 gpt-5.5 turn 完成 + 正常计费 + journal 无 fatal
   (遥测失败只允许 warn 级)。
4. **数据面仍走 relay**:relay 日志 `relay_upstream_response` 带 proxyId(账号绑定代理),
   模型调用未受影响。
5. **v3 零影响**:v3 容器健康;`iptables -L DOCKER-USER -v -n` 只有 172.31 一条我方规则,
   172.30 计数与规则不变;v3 桥流量正常。
6. **auth.openai.com 封锁不误伤 refresh**:造一个 access token 过期的绑定账号 → 一轮 turn
   触发 master reverse-RPC refresh 成功(容器内 codex 不直连 auth.openai.com,refresh 在
   master 侧,源 IP 不在 172.31.0.0/16 → 规则匹配不到)。

## 验收(commit 前已完成)

- typecheck rc=0;gateway 1216 pass/0 fail(基线 1211 + 新增 5);commercial:unit 失败集
  与 git stash 基线**零新增**(16 既有存量债不变)。
- host 脚本 `bash -n` OK;dry-run install/refresh/uninstall 命令序列正确;真实 iptables
  临时链验 dedup 三次仅 1 条规则(幂等)。
- managed_config 键名/`-c`/组合加载 codex 0.137 探针 clean。
