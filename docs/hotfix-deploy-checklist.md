# Hotfix 上线检查清单 (commercial-v3)

> 用户报"现网坏了"时,从看到截图到 commercial-v3 跑上新版本,目标 **15 分钟内**。
> 本清单基于 2026-05-16 Phase 2 read-path 修复中踩到的坑总结,每条都有
> 真实事故出处。

---

## Step 0 — 先诊断,别动代码 (2 分钟)

**反模式**: 看到截图就开 IDE 改代码。多花 90 秒诊断能节省 30 分钟瞎修。

```bash
# 在 commercial-v3 上
scripts/diagnose-user.sh <uid> --minutes=15
scripts/diagnose-user.sh <uid> --probe-node-agent  # 如果是 remote host
```

输出会告诉你:
- 用户容器在 **self 还是 remote 哪台 host**
- 容器 status / state 对不对 (running+active 才算 live)
- 最近 N 分钟相关日志条目 (按 uid 过滤过的)
- master 视角下 host-side 路径 / docker volume 实际状态

**事故出处**: 2026-05-16 Phase 2 修复浪费了 ~2 小时改 remote-host 读路径,
后来才发现用户容器实际在 self。如果当时第一步就跑这个,就能避免。

---

## Step 1 — 在 sg dev 上 reproduce + 改代码 + 单测 (5-10 分钟)

不要直接在 commercial-v3 改。sg dev 实例同源镜像,代码可直接改。

```bash
cd /opt/openclaude/openclaude-v3
# 改 go 源
vim packages/commercial/node-agent/internal/files/files.go
# 改 ts 源
vim packages/gateway/src/...
# 加测试
vim packages/commercial/node-agent/internal/files/files_test.go

# 单测必须全过
cd packages/commercial/node-agent && go test ./...
cd /opt/openclaude/openclaude-v3 && npm run test --workspace=packages/gateway
```

**坑 1.1**: commercial-v3 上**没装 Go**(它是 runtime host,不是 builder)。
任何 node-agent 重编都得在 sg 上做,别想着 ssh 过去现编。

```bash
# sg 上首次需要装
apt-get install -y golang-go  # 如未装
# 交叉编译 Linux/amd64
cd packages/commercial/node-agent
GOOS=linux GOARCH=amd64 go build -o node-agent ./cmd/node-agent
```

---

## Step 2 — Codex 双审 (必须,非可选) (3-5 分钟)

CLAUDE.md 规则:**任何代码修改必须 Codex 评审通过**。例外只有 single-line typo。

```
mcp__codex__codex(prompt = "...", model = 默认走 ~/.codex/config.toml")
```

**坑 2.1**: 不要"先上线再补审",上线后 Codex 提阻塞问题就尴尬了。
**坑 2.2**: Codex 反馈不等于必须照做 —— 反防御过度/反范围蠕变,见 CLAUDE.md "Codex Review ≠ Blind Acceptance"。

---

## Step 3 — 部署前的硬性 gate (1 分钟)

### 3.1 Changelog gate

`changelog.json` 的 `releases[]` 任何变化要求 `BOSS_APPROVED_CHANGELOG=1` 环境变量。
hotfix 通常只 bump `currentVersion`,不动 `releases[]`,所以**不**需要那个变量。

```bash
# 只 bump version,不动 releases
jq '.currentVersion = "v1.0.152"' changelog.json > /tmp/cl.json && \
  mv /tmp/cl.json changelog.json
```

### 3.2 Git push 的 proxy 坑

```bash
# 直接 git push 经常被 residential proxy 掐
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
  git push origin master
```

**事故出处**: 多次出现 `Connection reset by peer` / `RPC failed`。
这个 env 前缀是稳定 workaround。

---

## Step 4 — 部署到 commercial-v3 (3-5 分钟)

```bash
# 同样的 proxy 处理
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
  bash scripts/deploy-v3.sh
```

**坑 4.1 — WS-active gate**: 如果当前有用户在线 (`active_ws > 0`),
deploy-v3.sh 会**拒绝部署**。判断:
- 真的紧急 → `bash scripts/deploy-v3.sh --force`,但要清楚这会断 N 个用户的 WS
- 不紧急 → 等空闲窗口

`--force` 不能滥用 —— boss 历史上对"打断在线用户"很反感,要先权衡。

**坑 4.2 — node-agent binary 不在 deploy-v3.sh 范围内**:
deploy-v3.sh 只发 master 侧 (gateway / web / commercial)。**所有跑 node-agent 的
remote host 的 binary 必须单独 rollout**。

```bash
# 在 commercial-v3 上,跑 rollout 脚本
DATABASE_URL=... OPENCLAUDE_KMS_KEY=... \
  npx tsx scripts/rollout-node-agent.ts /path/to/node-agent
```

**坑 4.3 — KMS key**: rollout 脚本需要 `OPENCLAUDE_KMS_KEY` 来解 ssh 密码。
key 在 `/etc/openclaude/commercial.env`。**不要** `source` 整个文件到当前 shell
(把所有密钥拉进环境太脏),只 export 单独那个变量:

```bash
OPENCLAUDE_KMS_KEY=$(grep ^OPENCLAUDE_KMS_KEY /etc/openclaude/commercial.env | cut -d= -f2-) \
  DATABASE_URL=... \
  npx tsx scripts/rollout-node-agent.ts /path/to/node-agent
```

**坑 4.4 — 先查 placement 再决定要不要 rollout**:
如果出问题的用户容器都在 self,根本不需要 rollout binary 到 boheyun-1 / 别的 host。
diagnose-user.sh 第一步就能告诉你这点。

---

## Step 5 — Smoke + 现场验证 (2 分钟)

```bash
# commercial-v3 上
bash scripts/smoke-v3.sh   # 5/5 必须过

# 然后立刻 ping 报错的用户
scripts/diagnose-user.sh <uid> --minutes=2
# 看日志窗口里旧错误是否消失
```

**别等用户来说"好了"**, 主动验。

---

## 反模式 / 不要做

- ❌ 在 commercial-v3 上直接 vim 改代码 → 没有 git,改完 deploy 一覆盖就丢
- ❌ `source /etc/openclaude/commercial.env` 全文件 → 太多 secret 进环境
- ❌ 跳过 Codex 评审"先救火" → 救完火往往要回滚
- ❌ deploy 后不跑 smoke → smoke 5 秒,事故 5 小时
- ❌ 只在 self 改了 binary 但没 rollout → 用户去到 remote host 还是旧版
- ❌ 看到 503/404 就改代码 → 先看 placement,可能是用户容器根本没起来
- ❌ 改测试断言去配合 stale 行为 → 看 isFileAllowed 等权威源真实当前行为,反过来调测试

---

## 应急时的 boss 联络规则

- 5 分钟内能搞定 → 静默修完再说,boss 看 changelog 就行
- 超过 5 分钟仍未定位 → 写一行进度: "用户 28 下载 503, 在查 placement, 怀疑 X"
- 涉及 `--force` 断在线用户 → **先告诉 boss** 再做
- 涉及 rollback 已发布版本 → **先告诉 boss** 再做
- 改 secret / KMS / DB schema → **先告诉 boss** 再做

---

## 配套工具

- `scripts/diagnose-user.sh` — 用户级现场快照 (Step 0)
- `scripts/smoke-v3.sh` — 部署后 sanity (Step 5)
- `scripts/rollout-node-agent.ts` — node-agent binary 多机分发 (Step 4)
- `scripts/deploy-v3.sh` — master 侧部署 (Step 4)
