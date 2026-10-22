# OCV5-561 实施方案：Muse 图片/视频系统工具（个人版）

- 依据：`$H/DESIGN-20261022-muse-media.md` v3.1（用户 2026-10-22 03:42 CST 批准实现并上线个人版，只开放 user 3）。
- 本文是**实施方案**（plan review 用），列出具体文件、接口与相对设计的细化。只改个人版 `feat/v5-selfhost`。
- 不动：计费/积分（Muse 不消耗平台额度，不写 usage_records/credit_ledger）、模型目录、egress 代码、商业版。

## 1. 生效面

| 面 | 内容 | 发布方式 |
|---|---|---|
| master | 新模块 `packages/commercial/src/muse/*`；`index.ts` 装配；`http/router.ts` 新前缀；`config.ts` 新 env | 个人版发布（master 重启） |
| 迁移 | `0315_selfhost_muse_media.sql`（只建两张新表） | 个人版发布时 runner 自动执行（profile v5-selfhost） |
| 容器 | 平台 CLI `oc-muse`（platform-runtime/bin） + 用法说明 | runtime source release；已有容器重建后生效 |
| env | `OC_MUSE_*` 写入 `/etc/openclaude/commercial-v5-selfhost.env` | 发布前写入；`config.ts` 是非 strict 的 `z.object`，旧代码忽略未知键，所以一次发布即可生效 |
| bridge | `/workspace/muse-bridge/muse_bridge.py` 收进仓库 `packages/commercial/muse-bridge/`，CI 跑它的测试 | 不随发布进入 Muse VM，由用户自己拷贝 |

## 2. 数据库（`0315_selfhost_muse_media.sql`）

```sql
-- compat: additive selfhost-only tables for OCV5-561 (old readers never touch them)
CREATE TABLE IF NOT EXISTS muse_bridge_credentials (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  token_sha256 BYTEA NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  last_bridge_version TEXT);
CREATE TABLE IF NOT EXISTS muse_media_jobs (
  id TEXT PRIMARY KEY,                       -- mj_<uuid>
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container_id BIGINT,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  prompt_sha256 BYTEA NOT NULL,
  prompt_preview TEXT NOT NULL,              -- 前 500 字
  params JSONB NOT NULL,                     -- orientation/aspect/format/source_count/resumed
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  error_code TEXT, upstream_error_code TEXT,
  bridge_credential_id BIGINT REFERENCES muse_bridge_credentials(id) ON DELETE SET NULL,
  files JSONB,                               -- [{mime,bytes,sha256}]，不含 URL
  muse_artifact_ids TEXT[], muse_snapshot_id TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS muse_media_jobs_user_kind_queued_idx ON muse_media_jobs (user_id, kind, queued_at DESC);
```

- 文件头 `-- order-dependency: 0314_selfhost_box_gpt_6_astra_pro`。不写 GRANT：近期建表迁移（0200、0306–0308）都没有显式授权，依赖默认权限。

- 保留期：`muse_media_jobs` 进 `AUDIT_RETENTION_POLICIES`（`queued_at`，180 天）；`muse_bridge_credentials` 在 `retentionRegistry` 登记为 `durable`。
- 迁移只建表，不写数据。手工回滚：`DROP TABLE muse_media_jobs, muse_bridge_credentials;`（写进文件头）。

## 3. master 模块 `packages/commercial/src/muse/`

### 3.1 `config`（`config.ts` 新增，全部可选）

| env | 默认 | 说明 |
|---|---|---|
| `OC_MUSE_BRIDGE_ENABLED` | 关 | 不是 `1` 时：公网 `/api/muse-bridge/*` 一律 404，内部接口返回 `MUSE_NOT_ENABLED` |
| `OC_MUSE_ALLOWED_UIDS` | `3` | 逗号分隔的十进制 uid；包含 `4` 时忽略这一项并记 warn |
| `OC_MUSE_STATE_ROOT` | `/var/lib/openclaude-v5-selfhost/muse-media` | 成品暂存目录（master 的 StateDirectory 下） |
| `OC_MUSE_IMAGE_PER_HOUR` / `_PER_DAY` | 30 / 200 | 限频 |
| `OC_MUSE_VIDEO_PER_HOUR` / `_PER_DAY` | 10 / 40 | 限频（视频已可用，比设计 v1 略放宽） |

### 3.2 `MuseBridgeHub`（进程内单例，`hub.ts`）

- 状态：当前 session（`{id, credentialId, lastSeen, version}`），等待中的 poll（最多 1 个），FIFO 队列（≤ 3），当前运行的 job（≤ 1）。
- job 状态机（内存）：`queued → dispatched → running → succeeded|failed|cancelled`。
  - **`dispatched` 只存在于内存**。数据库的 `status` 在 dispatched 期间仍是 `queued`，收到 ack 后才写成 `running`。所以 CHECK 约束不需要改，启动收口（`queued`/`running` → `failed/MUSE_MASTER_RESTARTED`）也覆盖了 dispatched 期间重启的情况。（plan r1 P1-3）
  - **ack 是执行屏障**（plan r1 P1-2）：bridge 收到 job 后先发一次 heartbeat 作为 ack，**只有拿到 master 对这个 session/job/nonce 的 200 成功响应后才启动 CLI**。ack 失败时最多重试 3 次（每次间隔 2 s，总时长小于 master 的 20 s ack 超时）；仍然失败，或者收到 410，就放弃这个 job：不跑 CLI，也不回传结果，直接回到 poll。master 侧：dispatched 状态 20 s 内没有收到 ack，就把 job 放回队首并换一个新 nonce（最多派发 3 次，超过就记为 `MUSE_BRIDGE_LOST`）。旧 nonce 的 ack 一律返回 410。这样任何时刻最多只有一份生成在执行：bridge 拿到成功 ack 时，master 必然已把 job 标为 running，之后不会再重派；master 重派之前，bridge 必然没拿到成功 ack，所以也没有开始执行。
  - running 后 60 s 没有 heartbeat → `MUSE_BRIDGE_LOST`。
  - deadline（图片 180 s；视频 390 s；带源图再加 120 s）到了 → `MUSE_TIMEOUT`，下次 heartbeat 回 `cancel:true`。
- 只有一个 master 进程持有 hub（个人版 master 单实例）。重启时 hub 为空，启动时把 DB 里 `queued/running` 的行收口为 `failed / MUSE_MASTER_RESTARTED`。
- 成品：分片写入 `<STATE_ROOT>/<job>/<idx>.part`。result 时核对每个文件的分片数、总字节和 sha256，原子 rename 为 `<idx>.bin`。容器取完或 job 结束 1 h 后删除；另有每 10 分钟一次的清扫。
- 并发安全：所有状态变更在 hub 内同步执行（Node 单线程，没有 await 夹在检查和赋值之间）。

### 3.3 公网接口（`bridgeHttp.ts`，`/api/muse-bridge/v1/*`）

- `router.ts`：新增 `{ method: ANY_METHOD, pathPrefix: '/api/muse-bridge/', handler }`；`COMMERCIAL_ROUTE_PREFIXES` 加 `'/api/muse-bridge/'`（`routeOwnership.test.ts` 的两处同步契约）。不进维护期白名单（维护期 bridge 收到 503 后退避重试，与设计一致）。
- 鉴权：`Authorization: Bearer mbr_…` → sha256 → 查 `muse_bridge_credentials`（`revoked_at IS NULL`），用 `timingSafeEqual` 比较。失败：同一 `clientIp` 每分钟超过 10 次 → 429。日志只记 credential id 和 IP。
- 端点与设计 §3 一致：`hello`、`poll`（挂起 25 s。用 **`res` 的 `close` 事件，并判断 `!res.writableEnded`** 来识别客户端提前断开（`req` 的 close 在正常读完请求体后也会触发，不能用；plan r1 P1-1），断开就撤掉等待者。派发时如果 `res.destroyed` 或 `res.writableEnded`，就立即把 job 放回队首。万一写出成功但对端没收到，由上面的 ack 屏障兜底）、`jobs/:id/heartbeat`、`jobs/:id/files/:idx/chunks/:n`（PUT，≤ 4 MiB，校验 `X-Chunk-Sha256` 和 `X-Job-Nonce`，n 必须连续）、`jobs/:id/result`。`bridge.py` 下载接口不做。
- 请求体上限：JSON 64 KiB；分片按 `chunk_bytes + 1 KiB`。

### 3.4 容器内部接口（`internalHttp.ts`，`/internal/v3/muse-media/*`）

都先 `verifyContainerIdentity`，拿到 `userId` 后检查白名单。由 split egress 透明转发（不在 `/internal/v5`）。

| 方法与路径 | 作用 |
|---|---|
| `GET /internal/v3/muse-media/status` | `{enabled, bridge_online}`，`oc-muse` 用来给出清楚的提示 |
| `POST /internal/v3/muse-media/jobs` | 提交任务（JSON ≤ 60 MiB，含最多 4 张 base64 源图），校验后入队，立即返回 `202 {job_id}`；错误码：`MUSE_NOT_ENABLED` 403、`MUSE_INVALID_INPUT` 400、`MUSE_RATE_LIMITED` 429、`MUSE_BRIDGE_OFFLINE` 503、`MUSE_BUSY` 503 |
| `GET /internal/v3/muse-media/jobs/:id?wait=25` | 长轮询状态，最多 25 s：`{status, error?, files:[{idx,filename,mime,bytes,sha256}], snapshot_id}`；只能查自己 uid 的 job |
| `GET /internal/v3/muse-media/jobs/:id/files/:idx` | 原始字节流（不用 base64） |
| `DELETE /internal/v3/muse-media/jobs/:id` | 取消（`oc-muse` 收到 Ctrl-C 或超时时调用） |

**相对设计的细化**：设计 §7 写的是“一次请求同步返回 base64 文件”，这里改为“提交 + 长轮询 + 字节流下载”。原因：
- 视频 10.7 MB 的 base64 JSON 不用整个放进内存；
- 任何一次 HTTP 连接都不超过约 30 s，master 重启或 egress 抖动时 `oc-muse` 能明确得到 `MUSE_MASTER_RESTARTED`，不会挂着不动。

### 3.5 审计与限频

- `muse_media_jobs` 每个任务一行：入队时 INSERT，状态变化时 UPDATE。限频用同表计数（只算 `status <> 'failed' OR error_code NOT IN ('MUSE_BRIDGE_OFFLINE','MUSE_BUSY','MUSE_INVALID_INPUT')`）。
- 结构化日志：`muse_bridge_hello`、`muse_bridge_auth_fail`、`muse_media_job_*`。不记 token、fbcdn 链接，也不记 prompt 原文。

### 3.6 token 运维脚本 `scripts/muse-bridge-token.sh`（只在 v5-dev 上以 root 运行）

- `issue --label <x>`：用 `openssl rand` 生成 `mbr_<43 位 base64url>`；只把 sha256 写入 DB（`psql` 读 env 文件里的 `DATABASE_URL`，不打印）；明文写入 `/root/ocv5-muse/bridge-token-<id>`（0600）。终端只打印 id 和文件路径。
- `list`（id、label、创建时间、吊销时间、last_seen）；`revoke <id>`。

## 4. 容器侧

- `platform-runtime/bin/oc-muse.py`：Python 标准库。master 地址和容器 token 的获取方式与 `oc-minimax.py` 相同。
  - `oc-muse image|video "<prompt>" [--orientation] [--aspect-ratio] [--format(仅 image)] [--image PATH]… [--resume SNAPSHOT] [--json] [--timeout N]`
  - 流程：status 检查 → POST 提交（源图读成 base64）→ 循环 `GET ?wait=25` 直到终态 → 逐个下载文件到 `/home/agent/.openclaude/generated/muse-<kind>-<短id>-<n>.<ext>`，并核对 sha256 → stdout 每行一个绝对路径，最后一行 `snapshot_id: …`。失败时 stderr 输出一行 JSON，退出码 1；参数错误退出码 2。收到 SIGINT 或 SIGTERM 时发 DELETE 取消任务。
- 分发：`bin/` 下的文件随 hot platform bundle 自动进入所有容器（`deploy-v5-selfhost.sh` 的 `build_platform_bundle`；finalize 时去掉 `.py` 扩展名，变成 `oc-muse`；`current` 软链切换后，存量容器立刻可以读到）。默认引擎的 PATH 已包含 `/run/oc/platform/current/bin`。
- 加入 `entrypoint.ts` 的 `PLATFORM_LINKED_CLIS`：Codex（login shell 重置 PATH）、Cursor、Grok（钉死 PATH）需要 `/usr/local/bin` 软链。这些软链只在容器启动时建立，所以对这三个引擎来说，存量容器重建后才可用。同步更新 `entrypointPlatform.test.ts:489` 的固定列表正则。
- `ocCliSurfaceCoverage.test.ts`：在 `OC_SURFACES` 里加 `oc-muse` 行（`--help` 探测），并加 `museCommands()` 解析，与 `h3Commands()` 同法。
- 测试：仿照 `ocH3Cli.test.ts`，用 `node:http` 假 master 起 `python3 oc-muse.py`。
- **用法说明**：调研结论是没有按 uid 注入文字的现成机制（prompt slot 有 master 和 gateway 两层白名单，加新 slot 要改 gateway）。user 3 的角色是 `admin`，而 `ccb-baseline/AGENTS.admin.md` 只挂给 admin 用户（目前是 uid 2 和 3）。所以把 `oc-muse` 的简短用法写进 `AGENTS.admin.md`，完整说明放在 `oc-muse --help`。**权威门禁是 master 的白名单**：uid 2 能看到说明，但调用会得到 `MUSE_NOT_ENABLED`。AGENTS.admin.md 是创建容器时 bind mount 的，u3 的容器重建后才能看到这段文字（idle 30 分钟回收后自然重建）；在那之前 `oc-muse` 已经可用，只是 agent 不会主动想到它。uid 765（普通用户）实测时，在提示词里直接让 agent 用 `oc-muse`。
- 工具 schema 与设计 §8 一致：`muse_generate_image` / `muse_generate_video`。视频没有时长、分辨率参数。续接加新源图时，输出分辨率跟随新源图。

## 5. bridge v0.3.0（随本 PR 收进仓库）

- 收到 job 后**先 ack，拿到成功响应才开始**：ack 失败最多重试 3 次（每次间隔 2 s）；收到 410 或重试耗尽就放弃这个 job，不执行、不回传。ack 成功后每 15 s 发一次 heartbeat。
- 其它行为不变；测试一并进仓库。新增用例：ack 成功才执行；ack 收到 410 时不执行；ack 网络失败重试后放弃且不执行；master 侧“派发后 20 s 没有 ack → 换 nonce 重派，旧 nonce 返回 410”。

## 6. 测试

- master 单测：鉴权（缺失、错误、吊销、限流 429）、session 顶替 409、poll 超时 204、poll 断开不派发、ack 超时重派（新 nonce，旧 nonce 返回 410）、heartbeat 丢失、deadline 取消、分片顺序和 sha 校验、超限、result 核对、白名单（默认 3、空值、包含 4 时忽略）、限频、启动时收口残留 job、开关关闭时 404、内部接口只允许本 uid 读自己的 job。
- 契约：`routeOwnership.test.ts` 通过；retention 对账（integ）。
- 端到端（本地）：真实 master handler 加 hub，配真实 `bridge.py` 和 stub CLI，再加 `oc-muse.py`。覆盖文生图、两步图片编辑、图生视频、续接、10.7 MB 视频、`video_not_available`、bridge 离线。
- CI 跑 bridge 的 Python 测试：新增 `museBridgePy.test.ts`，在现有 commercial unit 作业里用 `node:child_process` 执行 `python3 -I packages/commercial/muse-bridge/test_muse_bridge.py`。现有的 `ocH3Cli.test.ts` 已经在 CI 里调用 python3，可以确认 CI 有 python3。
- 上线实测：uid 765（白名单临时改为 `3,765`，结束后改回 `3`），真实 Muse VM 上的 bridge。出图一次、出视频一次，截图留证。

## 7. 已知生效限制（发布后如实报告）

- 默认引擎：`oc-muse` 在 bundle 切换后立刻可用。Codex、Cursor、Grok 引擎要等容器重建（软链在启动时建立）。
- `AGENTS.admin.md` 里的用法说明：u3 的容器重建后才可见。

## 8. 提交与发布

一个 PR（`feat/v5-selfhost-ocv5-561-muse-media`）：方案文档 → master 端 → 容器端 → bridge 收编和测试，分成几个提交。过 Codex（方案一轮，代码最多 3 轮）和 CI。发布前写入 env：`OC_MUSE_BRIDGE_ENABLED=1`、`OC_MUSE_ALLOWED_UIDS=3`。发布走 `oc-lease.sh` ride。发布后签发 token，用户在 Muse VM 里 `set-token` 并 `start`。
