# V5 容器工作区 inspect 数据面 — 威胁模型（PR8 / PR-A）

> 状态：实现前安全评审。本文件过 Codex PASS 之前禁止写生产代码。  
> 基线：`origin/feat/v5-aurora-rewrite` @ `e4f3fc930`  
> 工作树：`/Users/dengxuan/git_project/openclaude_v3/openclaude-v5-workspace-git-stat`  
> 分支：`feat/v5-workspace-git-stat`  
> 配套审计：`docs/V5_WEB_CODEX_DESKTOP_ALIGNMENT.md` §2 / §4.2 PR8 / §5「git/文件树安全」  
> 环境限制：本机没有 `oc-worktree` 注册表，按独立开发环境例外使用 `git worktree add`。  
> Codex 威胁模型审 #1：**FAIL**（5 Finding）。#2：**FAIL**（父目录 symlink 绕过 `.git` segment）。#3：**PASS**（`/tmp/codex-workspace-inspect-threat-r3.txt`）。  
> 方案迟到审查（对照 `45bc8802e`）补了 4 条威胁模型缺口，已写入 T2 hermetic gitdir / T2 结束复核 / T5 子进程终止 / T6 净化契约。  
> 方案 #3：**FAIL**（HEAD/objects 未锚定、准备阶段无资源闸、T6 测试漏 DEL/C1）。已写入 T2/T5/T6。实现方案 #4 PASS 前仍禁止写生产代码。

---

## 0. 一句话结论（安全签字）

**建议上线（降级后的 PR-A）：** 只对「本会话已 clone 且 `status=ready` 的 GitHub 工作树」提供两类只读 JSON：

1. **live git snapshot**：live HEAD（明确标 `authority: live`）+ `git diff --numstat` 合计 + 变更文件列表。  
2. **单层 list-dir**：每次只列工作树内一个目录的直接子项，禁止递归 dump。

已知路径的**内容读取**继续走现有 `GET /api/file`（`handleApiFile` + allowlist + blocklist + `openFileHardened`）。本协议**不得**让 `/api/file` 变成能枚举目录的东西。

**建议砍掉 / 永不做：**

| 能力 | 理由 |
|---|---|
| 整棵工作区递归文件树一次返回 | 资源耗尽面（`node_modules`、深树）+ 敏感路径枚举面同时放大；产品图右栏其实是变更列表，不是 IDE 全树 |
| 未绑定仓库时扫描 `/home/agent` 或默认 cwd 找 git | 把整个容器家目录变成浏览面；无 repo 必须返回空 |
| 跟随 symlink 进入工作树外 / 其它 volume | 经典逃逸 |
| 浏览或读取 `.git/` 内部（含 `config`） | `credential.helper` 指向 token 文件；对象库可被当数据面拖 |
| Commit & Push / Create PR / Undo / Approve | 审计已否决；写面 + OAuth 超出本数据面 |
| 第二套裸文件读取通道 | 必须复用 `/api/file` |
| 把 bind 快照 `RepoSelection.branch/head_sha` 标成「当前分支」 | 双权威 |

没有 ready 工作树时：**HTTP 200 + `empty: true` + `snapshot: null`**。禁止返回 `{added:0,deleted:0}` 或空树骨架。容器未就绪是 **503**，不是空态。

---

## 1. 资产与信任边界

### 1.1 资产

| 资产 | 位置 | 若泄漏 |
|---|---|---|
| 用户工作区源码与产物 | 容器 `/home/agent/.openclaude/repos/<sessionId>/<version>/` | 用户代码、可能含误提交的密钥 |
| GitHub PAT（clone 凭证） | `/home/agent/.openclaude/git-creds/<sessionId>/<version>/token`；`.git/config` 的 helper 命令含该 path | 冒充用户打 GitHub |
| 容器内运行时密钥 | `~/.codex/auth.json`、`~/.config/**`、`sessions.db`、`.env`、SSH key 等（已有 `FILE_BLOCKED_PATTERNS`） | 账号接管 / 跨会话 |
| 其它租户的 named volume | 宿主机 `/var/lib/docker/volumes/oc-v[35]-data-u<uid>/`；远端 compute host 上的对应用户卷 | 跨用户 IDOR |
| live HEAD / 工作区布局 | 本协议新暴露的元数据 | 信息泄漏（可接受，但必须绑当前用户容器） |

### 1.2 信任边界

```
浏览器  --JWT-->  v5 master commercial router
                      |  (只认 JWT.sub → 该 uid 的容器)
                      |  不读容器 FS，不信前端给的绝对路径当根
                      v
              containerApiProxy
              (bridge IP 白名单 + HMAC nonce + 本 channel docker 网段)
                      |
                      +-- 本机 dockerode fetch boundIp:18789
                      +-- 跨 host：node-agent tunnel（404 必须同时认 statusCode 与 httpStatus）
                      v
              容器内 gateway
              checkBridgeBypass (IP + containerId + nonce) 或用户 JWT
                      |
                      v
              SessionRepoWorkspaceManager.getRepoSnapshot(sessionId)
              仅当 status=ready 且 workspaceDir 落在 REPOS_ROOT 下
                      |
                      v
              git / readdir 采集（净化）──JSON──> 浏览器
              文件内容 ──仍走──> GET /api/file（独立通道，已有 ACL）
```

**不变量：**

- 前端传的 `sessionId` **不是租户键**。租户键只有 JWT.sub → 该用户自己的容器。同容器内用户只能看到自己的 session 工作树。
- master **从不**根据前端给的绝对路径去宿主机 `readdir` / `git`。跨 host 时 master 本机根本没有那份 volume。
- `/api/file` 继续拒绝目录（`!isFile()` → 404）。list-dir 是新路径。

### 1.3 工作区根的唯一定义

```
workspace root = SessionRepoWorkspaceManager.getRepoSnapshot(sessionId)
                 且 status === 'ready'
                 且 workspaceDir 是绝对路径
                 且 realpath(workspaceDir) 位于
                    realpath('/home/agent/.openclaude/repos') + '/' + sessionId + '/'
```

不扫描其它 git repo。不回落到 agent cwd / `/home/agent` / `/tmp`。unbind / cloning / failed / 无 snapshot → 空态。

---

## 2. 攻击者模型

| 角色 | 能力 | 目标 |
|---|---|---|
| 已登录用户（恶意或 XSS） | 合法 JWT；可对**自己的**容器发 HTTP | 读到 token、逃出工作树、拖 `node_modules`/`.git`、把 `/api/file` 变成枚举器 |
| 跨租户攻击者 | 合法 JWT，猜别人的 sessionId / 绝对路径 / volume 名 | 读别人容器 |
| 容器内 agent 进程 | 可在自己 volume 里 `ln -s`、`mv` 目录（TOCTOU） | 把 list-dir / git 引到 `/etc`、`/run/oc`、别人的 mount |
| 未认证 / 伪造 JWT | 无有效 cookie | 任何 inspect 数据 |
| 资源耗尽 | 并发打 git/list-dir；巨型仓库 | 打满容器 CPU / 撑爆 2MB API proxy |

XSS 不在本协议修复范围；本协议必须做到：**即便脚本能调 API，也拿不到工作树外的内容和密钥文件内容**。

---

## 3. 威胁与控制（拒绝矩阵）

每条：攻击 → 在哪一层拦 → 失败语义 → 测试落点。

### T1 路径穿越（`..` / 绝对路径 / 编码 / Windows 分隔符）

**攻击：** `path=../git-creds/...`、`path=/etc/passwd`、`path=%2e%2e%2f`、`path=..%2f`、`path=foo%00.png`、`path=foo\\..\\etc`、双重编码 `%252e%252e`。

**控制（gateway 采集层，fail-closed）：**

1. `sessionId`：`typeof string` 且 `^[A-Za-z0-9_-]+$`（与 `sessionRepoWorkspace.ts` 同一正则）。非法 → 400 `BAD_SESSION_ID`。
2. 相对路径 `rel`：只接受空（表示工作树根）或 UTF-8 字符串；长度 ≤ 4096。
3. **拒绝**（任一即 400 `BAD_PATH`）：含 `NUL` / 其它 C0 控制字符 / DEL；含 `\`；以 `/` 开头；Windows 盘符 `^[A-Za-z]:`；任意 path segment 为 `''` / `.` / `..`；decode 一次后仍含 `%2e`/`%2f`/`%5c` 这类「看起来还是编码穿越」的残留不是硬条件——权威是 segment 拆分 + 最终 realpath 前缀。
4. `URL.searchParams.get` 已经 decode 一次。不要再 decode 循环到「看起来干净」（避免 `%252e` → `%2e` → `.` 的宽松解码）。拆 segment 在 decode 之后做。
5. `join(workspaceDir, rel)` 后 `realpath`。`realpath` 失败 → 404 `NOT_FOUND`（不区分「不存在」与「无权限」以外的敏感目录；对 **blocked** 路径见 T4）。
6. 前缀检查必须用 `realRoot === realTarget || realTarget.startsWith(realRoot + '/')`。禁止裸 `startsWith(realRoot)`（避免 `repos/sess-1` 命中 `repos/sess-10`）。

**不在 `/api/file` 做。** `/api/file` 继续要求绝对路径且 `includes('..')` 直接 400，行为不变。

**测试：** `workspaceInspectPath.test.ts` 覆盖上列变体；断言 400/403，永不 200 出工作树外的 name。

### T2 符号链接逃逸 + TOCTOU

**攻击：** 工作树内 `ln -s /home/agent/.openclaude/git-creds s`；或 check 之后把目录换成 symlink（容器 uid 对 named volume 可写，见 `docs/audit-file-toctou.md`）。

**控制（语义选定：永不跟随目录 symlink）：**

- 工作树根与 list-dir 目标必须是**真实目录**，不是 symlink。`lstat` 为 symlink → 403 `PATH_DENIED`（作为目标时）或子项 `kind: "symlink"`（作为 child 时，无 `preview_path`，不展开）。这消除「`O_NOFOLLOW` vs 树内 symlink 目录可列」的矛盾。
- 打开目标：`openSync(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)`，记下 fd。Linux 再 `realpath(/proc/self/fd/n)` 做前缀检查。
- **`readdir` / child `lstat` 禁止退回原始目录 path。** Node 的 `fs.promises.opendir` **不接受数值 fd**，Linux 生产实现必须对**已验证 fd** 打开 `/proc/self/fd/<n>`（内核按该 inode 列目录，等价 openat），再对子项 `lstat('/proc/self/fd/<n>/'+name, {throwIfNoEntry})` 且 `O_NOFOLLOW`。darwin 单测没有 `/proc`：`lstat` 拒绝 symlink 目录 + `realpath` 前缀检查；注释标明生产路径是 `/proc/self/fd/<n>`，不在单测里假装 Linux fd 已覆盖。
- git 采集 **双 fd 锚定 + 受信临时 gitdir**（不得让 git 读攻击者可写的 `.git/config`）：
  1. `lstat` + `open(O_DIRECTORY|O_NOFOLLOW)` 工作树根 → `wfd`；同样打开真实 `.git` 目录 → `gfd`。`.git` 为 symlink 或 gitfile（`gitdir:` 文件）→ 空态 `not_a_repo`，不跟随。
  2. spawn **显式继承** `wfd`/`gfd`。argv 用 `--work-tree=/proc/self/fd/<wfd>`。**禁止**把 `--git-dir` 指到原始 `.git`（那会加载 local `filter.*.clean/process`、`core.worktree`、`include.path`）。
  3. 另建受信临时 gitdir：只写入最小 `config`（无 `filter.*` / `include` / `core.worktree` / hooks / fsmonitor）。`--git-dir` 只指向该临时目录。结束时删除临时目录。
     - **HEAD**：经 `gfd` 逐段 nofollow 打开。只接受 40-hex detached，或 `ref: refs/<rest>`（每段 `^[A-Za-z0-9._-]+$`，禁 `.`/`..`/空段）。`ref: ../../...` 等 → `not_a_repo`。
     - 拷贝 `HEAD`/`index`/`packed-refs`/那一个 ref：每跳 `O_NOFOLLOW|O_NONBLOCK`，`fstat` 必须 regular file（拒 FIFO）。上限 HEAD/ref 256B、packed-refs 2MiB、index 8MiB、合计 10MiB。
     - **objects 独立 `ofd`**：`open(O_DIRECTORY|O_NOFOLLOW)` 后继承进子进程；`alternates` 只写 `/proc/self/fd/<ofd>`。禁止 `/proc/self/fd/<gfd>/objects`。
     - 不拷贝、不 symlink 原始 `config`、`hooks`、`commondir`。
  4. 不能靠枚举 `filter.*` 再 `-c` 覆盖（竞态/漏项）。`--no-ext-diff --no-textconv` 仍加，但**不能**当作 filter 的替代。
  5. 结束复核**不能**对同一打开 fd 再 `fstat`（rename 后 ino 不变，且旧 version 目录故意保留）。必须再读 `getRepoSnapshot`，比较 `status+selectionVersion+workspaceDir`，再 open 当前权威路径比 inode。失败 → 丢弃结果，**HTTP 409** `WORKSPACE_CHANGED`。
  6. git 输出的路径仍走 T1 join+realpath；逃出则丢弃该条目。无路径的 live HEAD 依赖步骤 5，不单独信任。
- git 必须 **hermetic**（env + 临时 gitdir + 子进程生命周期）：
  - env 白名单：`PATH`、`LC_ALL=C`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`、`GIT_PAGER=cat`、`PAGER=cat`。不继承 `GIT_EXTERNAL_DIFF`、`GIT_TRACE`、`GIT_DIR`、`GIT_WORK_TREE`、`GIT_ASKPASS`。
  - argv 另加：`--no-optional-locks` `--ignore-submodules=all` `--no-lazy-fetch`；`diff`/`numstat` 加 `--no-ext-diff --no-textconv`。
  - `status` / `numstat` / `rev-parse` 一律 `-z` 或单行 40-hex；**禁止**按换行切 path 再净化。
  - 达 stdout/entries 上限必须 **关闭 pipe 并终止 git**（`SIGTERM` → 短等 → `SIGKILL`，始终 reap），stderr 独立限额并持续 drain；不得让 git 堵在满管道上占信号量。intentional truncation 是 200 + `truncated`；timeout 是 504 无 body。
- 内容读取的 TOCTOU 仍由现有 `openFileHardened` 关（本协议不读内容）。

**测试：** 真实 `symlinkSync` 指向 `/etc`、指向 `git-creds`、指向工作树外；目录 swap 用例至少覆盖「list 目标是 symlink 且 target 在树外 → 403」。gitdir：恶意 `HEAD` `ref: ../../tmp/x`、`objects` symlink/swap、`HEAD`/`index` 为 FIFO 均拒。

### T3 跨用户 / 跨容器 volume 越权

**攻击：** 用户 A 带自己的 JWT，请求 `sessionId=B的会话` 或 `/api/file?path=/var/lib/docker/volumes/oc-v5-data-uB/...`。跨 host 时 master 上没有 B 的 volume，错误形状还可能不是 dockerode 的 `statusCode=404`。

**控制：**

- master：JWT.sub → `getV3ContainerStatus(uid)` → **只**代理到该 uid 的容器。sessionId 到不了别的容器。
- 用户 A 的容器里没有用户 B 的 `repos/<B-sid>` → 空态或 404，不是 B 的数据。
- 新 API **不**走 host 侧 volume 路径，因此不引入新的 host-path IDOR。`COMMERCIAL_USER_VOLUME_MEDIA_GATE` 仍只服务 `/api/file`。
- 跨 host：沿用 `containerApiProxy` 的 tunnel。容器 vanished → `CONTAINER_NOT_RUNNING` 503。识别 missing 容器时若将来在本路径 catch docker 错误，必须同时认 `statusCode===404` 与 `httpStatus===404`（`v3-multihost-404-error-shapes`）。本 PR 的 proxy 层已按 status 对象而非 raw docker err 判断 `state !== 'running'`，不新开「只看 statusCode」的 catch。
- host singleton 兜底 **不能**只靠 `BLOCKED_FOR_USER_RULES`。现网 active admin 会 `blocked_for_user_admin_bypass` 后 `return false`，请求继续进 **host gateway**（`router.ts` ~1893；`blockedForUser.integ.test.ts` 锁定了这个行为）。若只登记 BLOCKED，admin + `X-OC-Host-Scope: 1` 会打到 master 的新 handler。
- 两道 terminal deny（admin 也不能绕）：
  1. **commercial router**：`/api/workspace/*` 在 containerApiProxy 命中且 `admin && x-oc-host-scope=1` 时 **直接 403** `HOST_FORBIDDEN`，禁止 fall through。普通 user/admin 无该头 → 仍代理进**自己的**容器。
  2. **容器 handler**：`process.env.OC_CONTAINER_ID` 未设置（即 host / 个人版 master 进程）→ 403 `HOST_FORBIDDEN`。即使 router 漏拦，host 上也没有用户 session repo。
- 测试：admin + `X-OC-Host-Scope: 1` GET `/api/workspace/git-snapshot` → 403，**不**进入 host handler（可用 handler 计数/探针断言）。

**测试：** allowlist/blocked 闭包（现有 `containerRouteProxyClosure.test.ts` 会强制登记）；handler 单测：无 snapshot → empty，不读传入的绝对路径。

### T4 敏感文件

**原则：allowlist 优先于 blacklist。** Blacklist 永远赶不上新密钥文件名。本数据面的 allow 根是「ready 的 session repo 工作树」，不是「`/home/agent` 减一段正则」。`FILE_BLOCKED_PATTERNS` 是第二道，用来挡住工作树里误放/symlink 进来的密钥，以及 `.git/`。

| 路径 / 名字 | list-dir | git entries | `/api/file` 预览 |
|---|---|---|---|
| 工作树内普通源码 | 可列 | 可列 | 走现有 ACL（trusted 模式下 `/home/agent/**` 允许） |
| `node_modules` / `.venv` / `dist` 等 vendor | `kind: skipped`，不展开 | 若 git 跟踪则出现在 entries，无 preview | 现有规则 |
| `.git` 目录 | `kind: skipped`（`reason=vcs`） | 不出现（不在 worktree） | 拒绝（新增：`.git/` 段必须进 block 或 list-dir 根拒绝） |
| `.git/config`、`git-creds/**`、`.env`、`.npmrc`、`id_rsa`、`.ssh`、`.config/**` | 不作为可预览项；若出现在 listings 则 `previewable: false` 且无 `preview_path` | 同左 | 已有 `isFileBlocked` → 403 |
| `/run/oc/**`、`/etc/**`、`sessions.db` | 403 / 不可达（根不在工作树） | 不可达 | 已有 blocklist |

**`.git` 必须进全局 `FILE_BLOCKED_PATTERNS`，且必须在 `realpathSync` 之前拦 lexical 路径（Codex #2 Finding 1，硬门槛）。**

商业容器固定 `OC_V3_TRUSTED_FILE_SERVE=1`，trusted 分支允许整个 `/home/agent/**` 再减 blocklist。当前 blocklist **没有** `.git` segment，因此现网 `GET /api/file?path=.../repos/<sid>/<ver>/.git/config` 会把 `credential.helper`（内含 `cat <tokenPath>`）当普通文件返回。inspect 层拒绝不够——预览点击走的就是 `/api/file`。

只把 regex 加进 `isFileBlocked(canonical)` **不够**。`handleApiFile` 今天是先 `realpathSync` 再跑 allow/block（`server.ts` ~6134 / ~6220）。攻击者可把 `.git` 目录挪到 `/home/agent/x`，再让工作树 `.git` → `/home/agent/x`：请求 `workspace/.git/config` 会被规范化成 `/home/agent/x/config`，canonical 上已经看不到 `.git` segment，trusted 模式又放行未被 block 的 `/home/agent/**`。`openFileHardened` 的 `O_NOFOLLOW` 只挡住最终那一跳，挡不住这种**稳定的父目录 symlink**。

本 PR **必须同时**做下面两道（不是二选一）：

1. **Lexical 预检（`realpathSync` 之前）**：对 `resolve(filePath)`（POSIX 规范化、**不跟随 symlink**）拆 path segment，任一 segment 为 `.git` → 403。这拦住请求文本里出现的 `.git`，无论后面 realpath 把它折叠成什么。
2. **Canonical 再检（`realpathSync` 之后）**：继续跑完整 `isFileAllowed` + `isFileBlocked`，其中 `FILE_BLOCKED_PATTERNS` **必须**含精确规则（只匹配 path segment `.git`，不误伤 `foo.git`）：

```ts
/(^|\/)\.git(\/|$)/
```

两道都要：lexical 防「请求里的 `.git` 被 realpath 吃掉」；canonical 防「realpath 之后路径仍带 `.git`」。覆盖攻击：工作树 `.git` → `/home/agent/x`，`GET /api/file?path=<workspace>/.git/config` 在 realpath 前就被 lexical 拦成 403。

残留（接受，不在本 Finding 范围）：攻击者若让客户端直接请求已改名、路径中不含 `.git` segment 的 `/home/agent/x/config`，lexical 看不见 `.git`。这要求攻击者另开一条已知绝对路径；内容读取仍受现有 blocklist，且本协议的 `preview_path` 不会为 `.git` 下发。不把「任意 `/home/agent/**` 文件」扩成默认拒绝。

测试至少锁定：

- trusted `isFileAllowed('/home/agent/.openclaude/repos/s/1/.git/config') === false`
- `isFileBlocked(.../.git/config) === true`；`.git/HEAD`、`.git/objects/...` 同拒
- `isFileBlocked('/home/agent/foo.git') === false`；`isFileAllowed` 在 trusted 下对 `foo.git` 仍按其它规则（**不误伤**）
- handler 往返：`GET /api/file?path=.../.git/config` → 403（直链 `.git` 目录）
- handler 往返：**父目录 `.git` 是 symlink**（`workspace/.git -> /home/agent/x`，请求 `workspace/.git/config`）仍 403；不得因为 realpath 变成 `/home/agent/x/config` 而 200

list-dir / git 路径规范化仍额外拒绝 `.git` segment（纵深），但不能替代 `/api/file` 这两道。

**测试：** `.env`、`.git/config`、`git-creds`、`.npmrc`、`id_rsa`、`.ssh/id_ed25519`、`.config/gh/hosts.yml` 全部不可预览；list-dir `path=.git` → 403。

### T5 资源耗尽

| 上限 | 值 | 超限语义（禁止静默截断） |
|---|---|---|
| git spawn 超时 | 5s | 504 `GIT_TIMEOUT`，**无部分 body** |
| list-dir 超时 | 2s | 504 `LIST_TIMEOUT`，无部分 body |
| git stdout | 1 MiB | 读到 cap 即**停消费、关 stdin/stdout、终止子进程并 reap**。若 `-z` 流在 cap 处截断导致最后一条不完整：**丢弃不完整记录**；`truncated: true` + `truncation.reason=stdout_limit`。合计数字仅在完整读完 numstat 时下发，否则 `diff: null`（禁止假 0） |
| git entries | 500 | 解析满 500 条即停读并按上条终止 git；`truncated: true` + `reason=max_entries`。`omitted` **不**承诺精确剩余数（可为 `null` 或 `"unknown"`） |
| list-dir entries | 200 | **流式 `opendir`**，读到 201 条即 stop。`truncated: true`；`omitted` 语义是「至少还有 1 条」，不是全量计数（全量计数等于把巨型目录扫完，与上限矛盾） |
| JSON 字节预算 | 256 KiB | 边组装边计 UTF-8 字节，超预算停止追加 entries，标 `reason=byte_budget`。必须保证序列化后 < `containerApiProxy` 的 2 MiB 硬顶，否则会变 502 |
| 相对路径深度 | 32 segment | 400 `BAD_PATH` |
| 单次 list 深度 | 1（不递归） | 协议层 |
| 并发 | **每容器（进程）inspect 信号量 = 2**；同 session 同时只允许 1 个。第二发 **立即 429 `IN_FLIGHT`**，禁止排队等待 | 多 session 不能绕过 per-session 锁打满 CPU |
| gitdir 准备（HEAD/index/packed-refs/ref） | regular file；HEAD/ref 256B、packed-refs 2MiB、index 8MiB、合计 10MiB；`O_NONBLOCK` | 非 regular / 超限 → 失败；FIFO 不得阻塞到 5s。计入同一 git deadline；`finally` 删临时目录并放信号量 |

Vendor 目录 `kind: skipped`，**不** `readdir` 展开。二进制：numstat 的 `-` `\t` `-` → `binary: true`，`added/deleted: null`，不读文件字节。

**测试：** 201+ dirent 断言 `truncated===true` 且未把全目录读进数组（可用 spy/计数）；超字节预算；timeout 无部分体；**同 session 第二个并发请求立即 429、无等待**；同容器两个不同 session 可各占 1 个槽，第三请求（第 3 个并发）429；**FIFO 或超大 index 后临时目录与信号量均释放**。

### T6 输出净化

git / `readdir` 可能吐出换行、ANSI、bidi override、`<script>` 文件名。选定契约（与「只去控制字符」一致，不再要求抹掉 HTML 标签字节）：

- 每个 `name` / `path`：删除 C0（U+0000–U+001F）、DEL（U+007F）、C1（U+0080–U+009F）、以及 bidi/isolate 控制符：U+061C、U+200E、U+200F、U+202A–U+202E、U+2066–U+2069。内嵌 `NUL` 的路径在解析阶段已 400。
- **不**删除 `<` `>` `&`。`JSON.stringify` 会保留 `<img>` 子串；这不是 XSS 漏洞。XSS 由 PR-B 用 textContent/text 节点渲染保证，本 PR 不把 HTML 标签当控制字符清掉。
- 紧凑 `JSON.stringify`（不 pretty-print），保证 wire 上的 JSON 字符串值不含 raw C0/C1/DEL/bidi。换行在 JSON 里以 `\n` 转义出现是允许的（那是两字节 `\`+`n`，不是 U+000A）。
- 不把路径写进普通 info 日志。warn 只用 `sessionId` + 错误码 + `rel` 的 hash 或截断到 64 且已净化的相对路径。

**测试：** 文件名含 `\n`、`\x1b[31m`、U+202E、**DEL(U+007F)**、**至少一个 C1（U+0085 或 U+009B）** → `JSON.parse` 后的 `name` 不含这些码点，响应 buffer 不含 raw ESC/bidi/DEL/C1。文件名含 `<img>` → 解析后的 name 可以含 `<img>`，**禁止**断言响应体没有 `<img>` 字节。

### T7 鉴权

| 层 | 要求 |
|---|---|
| master | 必须 commercial JWT。普通 user/admin → 只 proxy 进**自己的**容器。`admin && X-OC-Host-Scope: 1` → **terminal 403** `HOST_FORBIDDEN`，禁止 fall through 到 host gateway。 |
| 容器 | 新路径进 `BRIDGE_API_ALLOWLIST` 且 `proxyFromCommercial: true`。`checkBridgeBypass` 四条件 或（`OC_CONTAINER_ID` 已设置 **且** `checkHttpAuth`）。`OC_CONTAINER_ID` 空 → 403，挡住 host 进程。 |
| sessionId | 只在已经进入该用户容器之后解析工作树。 |
| 前端伪造 sessionId | 最多看到自己容器里没有的空态。 |

无 JWT → 401（现有 blocked/auth 链）。不要用「空态 200」掩盖未登录。

### T8 审计日志与隐私

- 禁止 log：文件内容、PAT、`git-creds` 绝对路径、完整 `workspaceDir`（info 最多 `repos/<sessionId>/<version>` 这种相对后缀）。
- 允许 log：`uid`、`sessionId`、错误码、`truncated`、耗时、route label。
- git stderr 截断进 failed status 前必须滤 token URL（clone 路径已有此纪律；inspect 的 git 不带 URL）。

---

## 4. 协议契约（实现必须遵守；细节以 protocol 模块为准）

### 4.1 路由

| 方法 | 路径 | 查询 |
|---|---|---|
| GET | `/api/workspace/git-snapshot` | `sessionId`（必填） |
| GET | `/api/workspace/list-dir` | `sessionId`（必填），`path`（可选，相对工作树，默认根） |

均 JSON，`Cache-Control: no-store`。无 body。

**`GET /api/file`：** 不改变路由、查询参数与响应契约（仍要求绝对路径、目录继续 404、不增加 `?list=1`）。**会增强其全局 ACL**：lexical `.git` segment 预检 + `FILE_BLOCKED_PATTERNS` 增加 `/(^|\/)\.git(\/|$)/`。这是内容读取通道的加固，不是新枚举能力。

### 4.2 空态（产品门控）

HTTP **200**：

```json
{
  "ok": true,
  "empty": true,
  "reason": "no_workspace",
  "snapshot": null
}
```

`reason`：`no_workspace` | `not_ready` | `not_a_repo`。  
前端（PR-B）：`empty===true` → **不渲染** git 卡 / 文件树（退回两栏）。禁止画 0 或骨架。

容器未运行：master **503** `CONTAINER_NOT_RUNNING` / `CONTAINER_UNREADY`。前端同样不画树。

### 4.3 git-snapshot 非空

```json
{
  "ok": true,
  "empty": false,
  "snapshot": {
    "live_head": {
      "authority": "live",
      "branch": "feat/x",
      "sha": "0123…40hex",
      "detached": false
    },
    "diff": { "added": 10, "deleted": 2 },
    "entries": [
      {
        "path": "src/a.ts",
        "status": "modified",
        "added": 8,
        "deleted": 1,
        "binary": false,
        "previewable": true,
        "preview_path": "/home/agent/.openclaude/repos/s1/1/src/a.ts"
      }
    ],
    "truncated": false,
    "truncation": null
  }
}
```

- `live_head.authority` 常量 `"live"`。**不**返回 bind 快照字段，避免一张卡两个权威。Bind 继续走现有 `RepoSelection`。
- `preview_path` 仅当 `previewable` 且通过 `isFileAllowed` + `!isFileBlocked` + 不在 `.git`。前端预览只许把它交给现有 `/api/file?path=`。
- detached HEAD：`branch: null`，`detached: true`，仍给 `sha`。
- 超限见 T5。`truncated===true` 时必须有 `truncation.reason`（`max_entries | stdout_limit | byte_budget`）。`omitted` 可为 `null` / `"unknown"`，禁止为了填精确数字而扫完全量。
- PR-B（本轮不做）渲染门：仅 `200 && empty===false && snapshot!=null`。`empty:true` 与任何非 2xx **禁止**画 `{added:0,deleted:0}`。

### 4.4 list-dir 非空

```json
{
  "ok": true,
  "empty": false,
  "cwd": "src",
  "entries": [
    { "name": "a.ts", "kind": "file", "previewable": true, "preview_path": "/home/agent/..." },
    { "name": "lib", "kind": "dir" },
    { "name": "node_modules", "kind": "skipped", "reason": "vendor" },
    { "name": "tmp_link", "kind": "symlink" }
  ],
  "truncated": false,
  "truncation": null
}
```

`kind`：`file | dir | symlink | skipped`。`skipped.reason`：`vendor | vcs | denied`。

### 4.5 错误

| HTTP | code | 何时 |
|---|---|---|
| 400 | `BAD_SESSION_ID` / `BAD_PATH` / `MISSING_SESSION_ID` | 输入非法 |
| 401 | 现有 auth | 未登录 |
| 403 | `PATH_DENIED` | 越出工作树 / `.git` / blocked 目录 |
| 404 | `NOT_FOUND` | 相对路径不存在（realpath 失败且非越权） |
| 429 | `IN_FLIGHT` | 同 session 采集未完成 |
| 503 | `CONTAINER_NOT_RUNNING` 等 | 容器没有 |
| 504 | `GIT_TIMEOUT` / `LIST_TIMEOUT` | 超时，无部分成功体 |
| 200 empty | — | 无 ready 工作树 |

非法穿越**不得**用空态 200 掩饰（否则前端会当成「没 repo」而不是攻击失败）。

---

## 5. 生效面（本轮不部署）

| 轴 | 要动吗 | 说明 |
|---|---|---|
| **runtime-source** | **要** | 容器内 `packages/gateway/**` + `packages/protocol/**` 采集与 handler。hotcfg release + tuple 激活后存量容器 runtimeStale 滚动 |
| **gateway / master** | **要** | `bridgeApiAllowlist`、`BLOCKED_FOR_USER_RULES`、闭包测试。master 只多认领两条 JSON 代理，不读 FS |
| **dist** | PR-A **不要** | 纯后端，未接入则前端无行为变化 |
| runtime image | 不要 | 不改 Dockerfile / git 二进制（镜像已有 git） |
| platform bundle | 不要 | |
| egress | 不要 | 不新访问 GitHub |
| migration | 不要 | |

回滚：revert PR-A → 容器 release 回上一 tuple 后新路由 404，前端 PR-B 尚未合入则用户无感。**禁止**只回 master 不回 runtime-source（静默不生效 / 半套协议）。

---

## 6. 与 PR-B / 前端 PR3

- PR-A 合入后 web-react **零 UI 变化**。
- PR-B 必须等 PR3 右栏壳扩展点合入；消费本 API，`xl:`（≥1280）门控，无数据隐藏。
- 并行线 `feat/v5-web-codex-token-density` 目前尚未见右栏扩展点；本轮不做 PR-B。
- 不做 Commit & Push / 会话文件夹。

---

## 7. 测试清单（质量门，不许为变绿放宽）

- [ ] T1 全部穿越变体被拒
- [ ] T2 symlink 指向树外 / git-creds / `/etc` 被拒
- [ ] T3 无 snapshot 空态；host blocked 规则存在；allowlist `proxyFromCommercial`
- [ ] T4 敏感路径不可预览；`.git/config` 全局 blocklist + `/api/file` 403；`foo.git` 不误伤
- [ ] `/api/file`：lexical `.git` 预检在 `realpathSync` 之前；**父 `.git` 为 symlink**（realpath 后路径不再含 `.git`）仍 403
- [ ] admin + `X-OC-Host-Scope: 1` → 403，不进 host handler；`OC_CONTAINER_ID` 空 → 403
- [ ] 无 repo → `empty: true`，JSON 无 `added: 0`
- [ ] 超大目录流式截断：`truncated===true`，`omitted` 不要求精确剩余数；字节预算
- [ ] **同 session 第二个并发请求立即 429、无等待**；同容器第三并发 429
- [ ] 超时 504 无部分体
- [ ] 输出无控制字符（含 DEL 与 C1；`<img>` 可保留）
- [ ] 恶意 HEAD ref / objects symlink / FIFO gitdir 输入被拒，临时目录与信号量释放
- [ ] `/api/file` 对目录仍 404（回归）
- [ ] gateway handler 往返 + 采集层单测；CI `typecheck` / `gateway` / `storage` / `commercial-unit` / `v5-ops`

不在真实用户容器做破坏性验证。不跑 `scripts/deploy-v5.sh`。

---

## 8. 残留风险（接受）

1. 工作树内用户**自己的源码**对已登录的该用户可见——这是产品意图。  
2. 变更列表可能包含用户误提交的密钥**文件名**（不含内容）。内容仍被 `/api/file` 拒绝。  
3. 单层 list-dir 仍可被客户端循环展开；靠 entries 上限 + vendor skip + 超时 + in-flight 锁，不能防一个决心耗 CPU 的合法用户。与现有 Bash 工具面同类。  
4. darwin 单测没有 `/proc/self/fd`；Linux 容器才有 fd-realpath。单测用 `lstat` + `realpath` 等价断言，并在注释标明生产路径。  
5. XSS 若能调 API，能看到该用户工作树布局。需 CSP / 前端文本渲染（PR-B）。  
6. 请求若直接指向已改名、路径中不含 `.git` segment 的 git 对象库（`/home/agent/x/config`），lexical 预检看不见 `.git`。不把整个 `/home/agent/**` 改成默认拒绝；`preview_path` 不会为 `.git` 下发。属于「已知绝对路径 + trusted ACL」的既有面，不是本协议新开的枚举面。

---

## 9. Codex 审查问题（本文件 · 第 3 轮）

#1 FAIL（5 Finding），#2 FAIL（仅剩父目录 symlink 绕过 `.git`）。本版针对 #2 唯一硬 Finding + 两条 Suggestion + Nit。请只审查增量，不要改代码。

闭合标准（全部满足才 PASS）：

1. `/api/file` 在 `realpathSync` **之前**对 lexical `resolve(filePath)` 做 `.git` segment block；realpath **之后**仍跑 canonical `isFileBlocked`（两道都要）。handler 测试包含「工作树 `.git` 是指向 `/home/agent/x` 的 symlink，请求 `.../.git/config` 仍 403」。`foo.git` 不误伤。
2. Linux list-dir 明确走已验证 fd 的 `/proc/self/fd/<n>`，不把 `fs.promises.opendir(原始 path)` 当生产路径。
3. 测试清单含「同 session 第二个并发请求立即 429、无等待」。
4. 正文不再写「明确不改 `/api/file`」，改为「不改路由/响应契约，但增强全局 ACL」。

要求格式：第一行 `PASS` / `FAIL` / `PARTIAL`。有新的必须修 Finding 就不要 PASS。不要改代码。
