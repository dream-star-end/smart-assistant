# P1 桌面虚拟容器运维说明

功能默认关。未完成 canonical 前置（18445 TLS passthrough、user-chat-bridge 与 desktop WSS 同进程亲和）不得开生产旗。

## 旗子

| 旗子 | 默认 | 作用 |
|---|---|---|
| `OC_DESKTOP_VIRTUAL_CONTAINER` | 未设 / 非 `1` = 关 | 装配 enrollment、18445、desktop 身份 |
| `OC_DESKTOP_KIND_KILLSWITCH` | 未设 = 开路 | 切断 desktop 面（enroll/token/18445 → 503，身份 401）；docker 不变 |
| `system_settings.desktop_virtual_container` | off | 热开关；**env 关则无权打开** |
| `system_settings.desktop_allowlist` | 空 | 非 admin uid 白名单 |
| `OC_DESKTOP_SIM_ENROLL` | 关 | `platform=sim` 免深链 |
| `OC_DESKTOP_TLS_BIND` / `OC_DESKTOP_TLS_PORT` | `127.0.0.1` / `18445` | **master** 设备 mTLS 面（WSS register + 白名单 `/internal/v3/*`） |
| `OC_DESKTOP_EGRESS_TLS_BIND` / `OC_DESKTOP_EGRESS_TLS_PORT` | 同 bind / `18446` | **egress** 设备 mTLS 面（仅 `POST /v1/messages`；WSS register **404**） |

旗子关：enrollment 404、不 bind 18445、docker 路径字节级不变。

## 端口

| 端口 | 用途 |
|---|---|
| 18445 | master：desktop HTTPS + **WSS register**（设备 mTLS，device CA，loopback） |
| 18446 | split 下 egress：desktop `POST /v1/messages`（同 device CA；**不**接受 register） |
| 18443 | node-agent host mTLS（**不**给 desktop） |
| 18892 | docker 容器 → egress `/v1/messages` |
| 18789 | 桌面本机 gateway（P2 local-bridge token；P1 禁止 `OPENCLAUDE_TRUST_BRIDGE_IP=127.0.0.1`） |

Device CA：`$OPENCLAUDE_DEVICE_CA_DIR` 或 `/etc/openclaude/device-ca/{ca.key,ca.crt,origin.key,origin.crt}`，与 18443 host CA 隔离。

## 18445 进程归属（split）

`DesktopTunnelRegistry` 与 `userChatBridge` 都在 **master** 进程内。WSS `GET /ws/desktop-container-register` **必须**与 registry 同进程，否则 attach 的隧道 bridge 看不见。

因此：

| 路径 | 非 split（仅 master） | split |
|---|---|---|
| WSS register | master:18445 | **只** master:18445。egress:18446 对该 upgrade **404**（禁止第二份 registry） |
| `POST /v1/messages` | master:18445 | **egress:18446**（LLM 与 docker 18892 同进程，master 重启不掐流） |
| `POST /api/desktop/token` 与 `/api/desktop/token/refresh` | master:18445 | **只** master:18445（与 register 同进程，要 pin 设备证 fp）。egress:18446 **404** |
| 白名单 `/internal/v3/*` | master:18445 | master:18445。egress 不转发这些路径：desktop 身份是 mTLS+token，HTTP 转发会丢掉对端证，master 的 docker 双因子无法重建 |

公网 commercial router 上的 `/api/desktop/token` 与 `/refresh` **保留但恒 401**：外层 TLS 已终止，Node 拿不到设备证，生产装配也不得注入 `desktopPeerCert`（那是 test/sim 注入点）。设备必须打 18445 mTLS 面。自报 `x-oc-device-*` header 在 listener 入口被剥掉，不能绕过。

18445 未登记路径（含 Grok/Codex/ZCode relay 前缀）统一 **404**。非 CCB 的 `ENGINE_NOT_ENABLED` 403 只出现在 user-chat-bridge turn admission gate。

同机 split 不得让两进程抢 `127.0.0.1:18445`；egress 默认 18446。Ingress 按上表分流。旗子关：两进程都不 bind。

## 回滚两轨（设计稿 §10.3）

**轨 A — 新 binary 关旗（零 down-migration）**

1. 去掉 `OC_DESKTOP_VIRTUAL_CONTAINER` 或保持非 `1`。
2. 不 bind 18445；enrollment 404。
3. 残留 `runtime_kind='desktop'` 行不会进入 docker provision/media/容量/dispatch（kind 过滤已部署）。
4. 不 DROP 列。

**轨 B — 回旧 binary（无 kind 过滤）**

数据清理是必需前置：

1. 关旗、kill switch。
2. drop 全部 desktop registry。
3. `UPDATE agent_containers SET state='vanished' WHERE runtime_kind='desktop' AND state='active';`
4. `UPDATE desktop_devices SET revoked_at=NOW() WHERE revoked_at IS NULL;`
5. 确认无 active desktop 行后再部署旧 binary。

一次回退后禁止无证据重开旗子。

## 0255 invalid 索引恢复 runbook

`CREATE UNIQUE INDEX CONCURRENTLY` 中断会留下同名 `indisvalid=false` 索引。0255 已改为 fail-loud（无 `IF NOT EXISTS`，invalid 同名先 `RAISE EXCEPTION`），失败时 **不会** 写入 `schema_migrations`。

1. 确认：
   ```sql
   SELECT c.relname, i.indisvalid
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'uniq_ac_user_channel_kind_active';
   SELECT version FROM schema_migrations WHERE version = '0255_desktop_kind_unique_index';
   ```
2. 若 `indisvalid=false`：`DROP INDEX CONCURRENTLY uniq_ac_user_channel_kind_active;`
3. 确认 ledger 无 0255 行后重跑 migrate。不要手工 INSERT ledger。
4. 清理后重跑应建出 `indisvalid=true` 的索引并登记 0255。
