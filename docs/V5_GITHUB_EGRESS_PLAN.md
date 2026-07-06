# v5 codex「github 残余直连」调研与封堵方案

> 归属:v5 codex 遥测封堵(feat/v5-codex-telemetry-block)roadmap P0.4 遗留项。
> 当时判「github 残余直连低危不封」,本文给出取证、风险定级与可执行方案。
> 校准:2026-07-06。取证基线:codex 0.138(本机 strace 实测)/ 0.137(线上镜像
> `v5-ccb-e5f0ff0b`,二进制串一致)。线上 kl-mirror 全程只读。

---

## 0. 一句话结论

v5 容器内 codex 的**唯一** github 残余直连 = **app-server 启动时一次匿名
`git ls-remote https://github.com/openai/plugins.git HEAD`**(codex 内建
plugins/marketplace 发现)。该请求**不带任何凭证**(无 chatgpt token、无 openai
凭证、**也不带用户 github PAT**),泄露面仅为「宿主机出口 IP + codex 版本指纹」,
**不违反账号 IP 纯净红线**。**配置面(managed_config)无任何可用键能关掉它**(已穷举
探针证明)。唯一可行的根治是 **git 层 `insteadOf` 重定向**(镜像面),精准且零误伤;
**网络面(ipset)不可行**(与合法 git clone 同 host 同 SNI,无法区分)。故:
**维持「低危」定级;若要根治走镜像面 git 重定向,不走网络面。**

---

## 1. 流量构成(取证)

### 1.1 取证方法(只读)
本机 codex 0.138(与线上 0.137 同 `@openai/codex` 二进制家族,github 串一致)下
`strace -f -e trace=execve,connect` 跟踪 `codex app-server --listen stdio://` 冷启动,
CODEX_HOME 用全新空目录(模拟容器首启)。

### 1.2 启动期实际外连(完整清单)
冷启动**只发起一条**对外 TCP:

```
execve(".../git", ["git","ls-remote","https://github.com/openai/plugins.git","HEAD"])
  → git-remote-https → CONNECT github.com:443
```

- 这是 codex 的 **plugins marketplace 发现**:内建「默认 marketplace」硬编码为
  `github.com/openai/plugins.git`,启动时 `git ls-remote` 拉 HEAD 探测版本。
- **匿名**:git 从 codex 进程 cwd 运行,**不在**用户绑定仓库目录 → 不继承 repo-local
  credential helper → **不带用户 github token**(见 §3.2 论证)。
- 走 `git` 子进程 → 继承 codex 进程 env。codexShared `buildCodexEnv()` 已 scrub
  `HTTP(S)_PROXY/ALL_PROXY` 并置 `NO_PROXY`,故 git **直连** github.com → 宿主机 NAT
  出口 IP 暴露给 github。**这正是残余直连的路径**。

### 1.3 澄清:哪些 github 串**不是**运行时外连
二进制 `grep` 到的其它 github 引用**均非启动期 fetch**,不构成残余直连:

| 串 | 性质 | 是否外连 |
|---|---|---|
| `github.com/openai/skills/tree/main/skills/.curated`(及 `.system`/`.experimental`) | **人读参考 URL**(`/tree/` 是网页浏览路径,非 git/api 端点)。system skills(imagegen 等)由二进制**内嵌资源** offline populate(Dockerfile build 阶段跑一次 app-server 落 `/opt/codex-system-skills`,无需 github) | ❌ 不外连 |
| `api.github.com/repos/openai/codex/releases/latest` | 启动更新检查 | 已被 managed_config `check_for_update_on_startup=false` 关闭 |
| `github.com/openai/codex/releases/latest` | 同上更新检查的展示 URL | 已关 |
| `raw.githubusercontent.com/openai/codex/main/announcement_tip.toml` | announcement tip | **app-server 启动期实测未触发**(strace connect 清单只有 github.com:443 一条);疑为 TUI-only / 门控路径。列为**潜在次要端点**,若将来观测到再处理 |
| `github.com/bazelbuild/...`、`clap-rs/...`、`git/git/...` 等 | 错误信息/文档字面量 | ❌ |

### 1.4 线上侧佐证(只读)
- 现役 v5 容器(`oc-v5-u1/u4/u105`,镜像 `v5-ccb-e5f0ff0b`)当前**无 codex 进程**
  (codex 为 lazy-spawn,首个 gpt-5.5 turn 才起)→ 无法在只读约束下抓到活体
  marketplace fetch(触发 turn 属写操作,不做)。流量构成以 §1.2 本机同二进制
  strace 为 ground truth。
- 线上 `iptables -L DOCKER-USER` 现有遥测封堵规则一条(172.31/16 → ipset
  `oc-v5-codex-tele-block` REJECT),ipset 6 条 IP(chatgpt/ab.chatgpt/auth/api.openai
  的 Cloudflare 段),**其中不含 github IP** —— 印证 github 从未进网络面封堵清单。

---

## 2. 配置面(managed_config)结论:无可用键(取证)

穷举探针 codex 0.137/0.138,试图用 managed_config / `-c` 关掉 marketplace git fetch,
**全部无效或致命**:

| 配置尝试 | 结果 |
|---|---|
| `marketplaces = []` / `plugins = []` | **codex 启动崩溃**(`invalid type: sequence, expected a map` → `error loading default config`)。不可用 |
| `marketplaces = {}`(空 map) | 干净启动,但 **ls-remote 照发** |
| `enable_plugins = false`(顶层) | 干净启动,**ls-remote 照发** |
| `[beta_settings] enable_plugins=false` | 干净启动,**ls-remote 照发** |
| `[experimental] plugins=false` | 干净启动,**ls-remote 照发** |
| `[plugins] enabled=false` | **Invalid configuration; using defaults**(整份 managed_config 被丢弃 → 连遥测保护一起失效)。危险,禁用 |
| `[marketplaces.openai] enabled=false` / `.path=<local>` / `.git=<local>` | 干净启动,**ls-remote 照发**(默认 marketplace 由 `build_default_marketplace` 无条件构建,不被这些键覆盖) |
| `default_marketplace_path=<local>` / `skills_root=<local>` | 干净启动,**ls-remote 照发** |

**结论**:codex 把默认 marketplace(`github.com/openai/plugins.git`)的启动刷新做成了
**无条件硬编码**,无任何合法配置键可关闭。**因此本轮配置面无任何可实施项** ——
强行写一个不存在/非法的键只会把整份 managed_config 连遥测保护一起打回默认(见遥测
封堵文档「已知键非法值 → 回落默认」教训),比不改更糟。这是本轮「已实施项 = 无」的
**架构结论,而非遗漏**。

---

## 3. 风险定级:低危(维持原判)

### 3.1 泄露内容
匿名 `git ls-remote github.com/openai/plugins.git` 暴露给 github 的仅:
1. **宿主机出口 IP** —— 但这本就是全体 v5 容器 egress 的共享 NAT 出口,github 早已从
   用户合法 `git clone github.com/...` 看到同一 IP。**无新增暴露面**。
2. **codex 版本指纹** —— 「某 host 匿名查询 openai/plugins」强指向「该 host 跑 codex」。
   属**指纹**,非凭证。

### 3.2 关键:不带任何凭证(与遥测漏洞的本质区别)
遥测直连之所以是**红线**,是因为它带 **chatgpt account token** → 账号代理 IP 与宿主机
真实 IP 在 chatgpt 侧被同一 token 关联,破坏账号 IP 纯净。**marketplace fetch 完全不同**:

- **无 chatgpt token / 无 openai 凭证**:目标是公共 github 仓,匿名请求。
- **不带用户 github PAT**:v5 仓库绑定的 token 注入是**仓库目录局部**的 ——
  `sessionRepoWorkspace.ts` 用 `git -C <repoDir> config credential.helper ...`
  (repo-local `.git/config`)+ 每次 clone 的 per-spawn `GIT_ASKPASS`,且 clone 时置
  `GIT_CONFIG_NOSYSTEM=1`。codex 的 marketplace ls-remote 从**不同 cwd**运行,**不继承**
  该 repo-local helper → 匿名。**取证**:本机复现 codex 启动 ls-remote,git 未读取任何
  仓库凭证,User-Agent 为裸 `git/2.43.0`,无 Authorization。

∴ **不触及账号 IP 纯净红线**。危害等级 = 「暴露一个已暴露的 IP + 一条版本指纹」= **低**。

### 3.3 与「不封 github」的合法业务约束
github.com 的 git 流量是 **v5 GitHub 仓库绑定功能**的合法业务面(用户绑仓 →
容器内 clone/push)。marketplace ls-remote 与用户 clone **同 host(github.com)、同端口
(443)、同 SNI、同为匿名/git 协议外观**,网络面无法区分 → 任何按 host/SNI/IP 的封堵
都会**误伤合法 clone**。这是「网络面不封」的硬约束根因。

---

## 4. 方案对比(按侵入度排序)

### 方案 A(推荐 · 镜像面):git `insteadOf` 局部重定向 —— 根治且零误伤
**思路**:不碰网络、不碰 codex 配置,直接在 git 层把 marketplace 的那**一个** URL 前缀
重定向到镜像内一个**本地空 bare 仓**,git 走本地文件、不出网。

**改动点(镜像面,`packages/commercial/agent-sandbox/`,非本轮 src 范围 → 待确认后执行)**:
1. build 阶段建一个本地空 bare 仓,如 `/opt/codex-empty-marketplace.git`
   (`git init --bare`),root-owned、all-read。
2. 写 **系统级** git 配置 `/etc/gitconfig`(root-owned):
   ```
   [url "file:///opt/codex-empty-marketplace.git/"]
       insteadOf = https://github.com/openai/plugins.git
       insteadOf = https://github.com/openai/plugins
   ```
3. 顺序:上述两步须在 Dockerfile 的「codex system skills populate」RUN **之前**,
   使 build 期那次 app-server 也走本地(无外连、无 build 网络依赖)。

**生效面**:codex marketplace `git ls-remote` 读 `/etc/gitconfig` → insteadOf 命中 →
用本地 bare 仓,**不 spawn git-remote-https、零 github 外连**。

**误伤面 = 零(已取证)**:
- 用户仓 clone 走 `GIT_CONFIG_NOSYSTEM=1`(sessionRepoWorkspace L804)→ **不读**
  `/etc/gitconfig` → insteadOf 对 clone **完全不生效** → 合法 clone 零影响。
- insteadOf 仅匹配 `github.com/openai/plugins` 前缀;其它 github 仓(用户任意 repo)
  不命中。唯一理论碰撞 = 用户仓恰为 `github.com/openai/plugins*`(不存在实际场景,
  且即便命中也只是拿到空仓,无凭证泄露)。
- 空 bare 仓 ls-remote 返回空 → codex marketplace 视为「无插件」优雅继续
  (codex 本就容忍 github 不可达),**功能零回归**。

**验证法**(镜像重建后,单容器探针,只读):
```bash
# 1) 启动期不再外连 github(容器内跑一次 app-server,strace 或抓包)
docker exec <v5容器> sh -c 'strace -f -e trace=execve codex app-server --listen stdio:// </dev/null 2>&1 | grep -c "git-remote-https"'
#   期望 0(基线为 ≥1)
# 2) 宿主机抓包确认 github SNI 归零(仅 v5 网段,10-30s,触发一次 codex turn)
tcpdump -i br-<v5bridge> -n 'tcp port 443' | grep -i github   # 期望空
# 3) 合法 clone 不受影响:v5 绑定一个 github 仓 → 容器内 clone 成功
# 4) marketplace 优雅降级:codex turn 正常、无 fatal(marketplace 失败只允许 warn)
```

**代价/技术债**:git `insteadOf` 是稳定的 git 机制,无版本耦合;唯一维护点 = 若
codex 未来改默认 marketplace URL,需同步更新 insteadOf 前缀(与遥测封堵「codex 版本
升级需复验」同类,已有复验清单文化)。

### 方案 B(维持现状 · 零改动):继续「低危不封」
**思路**:接受 §3 定级,不做任何改动,仅把结论固化进文档 backlog。

**理由**:泄露无凭证、无账号关联、IP 已暴露、仅版本指纹;codex 已有 marketplace
失败容忍。ROI 低。

**代价**:版本指纹长期存在;若将来威胁模型升级(如要求「宿主机不暴露跑 codex」),
需回到方案 A。

### 方案 C(不可行 · 记录以正视听):网络面 ipset 封 github
**结论:不可行,禁止实施**。github.com marketplace ls-remote 与用户合法 git clone
同 host/端口/SNI/协议外观,ipset(hash:ip,按 dst)无法区分 → 封则误伤
v5 GitHub 绑定功能(整条业务面挂掉)。这也是原 roadmap「网络面不封 github」的正确判断,
本文予以确认。

### 对比小结
| 维度 | A git 重定向 | B 维持现状 | C ipset |
|---|---|---|---|
| 根治残余直连 | ✅ 彻底 | ❌ | (不可行) |
| 误伤合法 clone | 零(取证) | 零 | **必误伤** |
| 侵入度 | 镜像面(需重建) | 零 | 网络面 |
| 版本耦合 | 低(URL 前缀) | 无 | — |
| 推荐度 | ★ 若要根治 | ★ 若接受低危 | ✗ |

---

## 5. 本轮已实施项

**无代码实施**。原因见 §2:配置面(managed_config,本轮唯一许可的实施面)**无任何
可用键**能关掉 marketplace 的 github fetch,强行写非法键会连遥测保护一起打回默认,
弊大于利。这是架构结论而非遗漏。方案 A(git 重定向)属镜像面,按约束**只出方案不执行**,
待确认。

---

## 6. 待确认项(交 boss/dx 决策)

1. **定级是否接受**:同意「低危(无凭证、无账号关联、仅 IP 指纹)」→ 可选方案 B 维持现状。
2. **是否根治**:若要根治,批准方案 A(镜像面 git `insteadOf` 重定向)。它需:
   - 改 `packages/commercial/agent-sandbox/Dockerfile.openclaude-runtime`(建空 bare 仓 +
     写 `/etc/gitconfig`,置于 codex populate RUN 之前);
   - **runtime image 重建**(deploy 生效面矩阵:runtime image)+ canary 单容器验证
     (§4 方案 A 验证法)。
3. **announcement_tip 次要端点**:是否需在同批把 `raw.githubusercontent.com/.../
   announcement_tip.toml` 一并纳入观测/重定向(当前启动期未触发,建议先只观测)。
4. **v3 同源**:v3 容器同一 codex 二进制、同样匿名 marketplace ls-remote。若采纳方案 A,
   `/etc/gitconfig` 重定向可**同构平移到 v3 runtime image**(v3 现网灰度门,单独排期)。
