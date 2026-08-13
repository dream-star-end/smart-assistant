# V5 容器工作区 inspect — PR-A 实现方案

> 威胁模型：`docs/V5_WORKSPACE_INSPECT_THREAT_MODEL.md`（Codex #3 **PASS**；迟到审查补丁已写入 T2/T5/T6）  
> 实现方案审 #1：**FAIL**（6 Finding，已闭合于 `b685671d3`）。#2：**PASS**（只核对该 6 条）。  
> 迟到审查（对照 `45bc8802e`）：**FAIL**，另 4 条硬 Finding（filter 执行、ACL 单一权威、子进程生命周期、T6 净化）。本版已吸收；待 #3 PASS 才写生产代码。  
> 本轮：**纯后端**。合入后前端零行为变化。PR-B 不做。不部署、不合入。  
> 基线：`origin/feat/v5-aurora-rewrite` @ `e4f3fc930`  
> 分支：`feat/v5-workspace-git-stat`

权威边界以威胁模型为准。本文只写怎么落代码、改哪些文件、怎么测。

---

## 1. 包与文件所有权

| 包 | 文件 | 做什么 |
|---|---|---|
| protocol | `src/workspaceInspect.ts` + `index.ts` export | 常量、错误码、JSON 形状（无 IO） |
| gateway | `src/workspaceInspect.ts`（新） | 路径、受信 gitdir、list-dir、信号量。**禁止** import `server.ts` |
| gateway | `src/sessionRepoWorkspace.ts` | 导出 sessionId 校验与 reposRoot；`resolveReadyWorkspace` 权威方法 |
| gateway | `src/server.ts` | `FILE_BLOCKED_PATTERNS`；`handleApiFile` lexical `.git` 预检；两条 HTTP handler；向采集层 **注入** 同一套 `isFileAllowed`/`isFileBlocked`/`getRepoSnapshot` |
| gateway | `src/bridgeApiAllowlist.ts` | GET 两条，`proxyFromCommercial: true` |
| gateway | `src/index.ts` | 如需 re-export 采集层给 commercial 测试（尽量不） |
| commercial | `src/http/router.ts` | BLOCKED 兜底；admin host-scope **terminal 403（在 proxy deps 闸外）**；`COMMERCIAL_ROUTE_PREFIXES` 加 `/api/workspace/`（注意尾斜杠） |
| tests | 见 §6 | 不许为变绿放宽安全断言 |

不改 `containerFileProxy`（仍只服务 `/api/file`+`/api/media`）。新 JSON 走现有 `containerApiProxy`。

---

## 2. `/api/file` ACL 加固（威胁模型 T4，不改路由契约）

导出 `hasGitPathSegment(p: string): boolean`：按 `/` 拆 segment（先 `path.resolve`，不 `realpath`），精确等于 `.git` 才 true。`foo.git` / `.github` / `bar.git.bak` 为 false。

`FILE_BLOCKED_PATTERNS` 追加：

```ts
/(^|\/)\.git(\/|$)/
```

`handleApiFile` 顺序变为：

1. 缺 path / `includes('..')` / 非绝对 → 400（现有）
2. `lexical = resolve(filePath)`
3. **`hasGitPathSegment(filePath) || hasGitPathSegment(lexical)` → 403**  
   必须紧挨 `resolve` 之后、**`_resolveMediaDirs` / `realpathSync` / remote pull 之前**。否则 `.git` 请求仍会打 resolver 与远端。
4. `_resolveMediaDirs`（现有）
5. `realpathSync`（现有）
6. `isFileAllowed` + `isFileBlocked`（canonical，含新 regex）
7. `openFileHardened`（现有）

目录仍 404。无 `?list=1`。测试必须是真实 handler/HTTP 往返 + spy：被拒的 `.git` 请求 **不得**调用 `_resolveMediaDirs`、`realpathSync`、远端拉取。禁止用抽出的 `denyIfGitPath` 替代 handler 往返。

---

## 3. 新协议（protocol）

常量：`WORKSPACE_INSPECT_PROTOCOL_VERSION = 1`；entries 200 / git entries 500 / git stdout 1MiB / JSON 256KiB / git timeout 5s / list timeout 2s / 深度 32 / 容器信号量 2。

错误码：`BAD_SESSION_ID` `BAD_PATH` `MISSING_SESSION_ID` `PATH_DENIED` `NOT_FOUND` `IN_FLIGHT` `HOST_FORBIDDEN` `GIT_TIMEOUT` `LIST_TIMEOUT` `WORKSPACE_CHANGED`。  
`WORKSPACE_CHANGED` 的 HTTP **固定 409**（威胁模型曾写 504/409，实现以本方案为准）。

空态：`{ ok:true, empty:true, reason, snapshot:null }`，`reason ∈ no_workspace|not_ready|not_a_repo`。

非空 git-snapshot / list-dir 字段与威胁模型 §4.3–4.4 一致。`truncation.omitted` 为 `null | "unknown"`，禁止精确剩余数。`live_head.authority` 字面量 `"live"`。不返回 bind 快照。

Vendor/VCS skip 名：`node_modules` `.git` `.svn` `.hg` `.venv` `venv` `__pycache__` `dist` `build` `.next` `.nuxt` `coverage` `.turbo` `.cache` `vendor`。

---

## 4. gateway 采集层

### 4.1 工作区根与单一权威（禁止第二套 ACL / 第二套 root）

`workspaceInspect.ts` **禁止** `import` `server.ts`（否则与 `server.ts → workspaceInspect.ts` 循环）。也禁止复制 `isFileAllowed` / `isFileBlocked` / `FILE_BLOCKED_PATTERNS` / `SESSION_ID_RE` / `REPOS_ROOT`。

接线：

- `SessionRepoWorkspaceManager` 导出 `isValidSessionRepoId`（现有 `SESSION_ID_RE`）和 `getSessionReposRoot()`（现有 `REPOS_ROOT`），并新增权威方法 `resolveReadyWorkspace(sessionId)`：内部 `getRepoSnapshot` + sessionId 校验 + `workspaceDir` 必须落在 `realpath(reposRoot)/sessionId/<version>`（`===` 或 `realRoot+'/'` 前缀）。不 ready / 无 snapshot / 路径越界 → `{ empty:true, reason }`。测试可注入 manager 或 root。
- HTTP handler 在 `server.ts` 把 **同一份** 已导出的 `isFileAllowed` / `isFileBlocked` 作为 deps 注入采集层。`preview_path` 只经这套 predicate；内容读取仍只走现有 `/api/file`。
- 无 `OC_CONTAINER_ID` → handler 直接 403 `HOST_FORBIDDEN`。不扫 cwd / `/home/agent`。

### 4.2 路径

`sessionId` 只用 `isValidSessionRepoId`，不另写正则。相对 path：空=根；拒 NUL/C0/`\`/绝对/盘符/`.`/`..`/空 segment；深度≤32。join 后打开前再 `hasGitPathSegment`。前缀检查用 `realRoot + '/'`，禁止裸 `startsWith(realRoot)`。

### 4.3 list-dir（Linux 生产）

1. 相对 path 规范化 + `hasGitPathSegment`。目标 join 后 `lstat`：symlink → 403 `PATH_DENIED`（作为目标）或 child `kind:symlink`。
2. 打开目标：`openSync(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`，`realpath(/proc/self/fd/n)` 做工作树前缀检查。
3. **canonical 目标命中 `isFileBlocked` → 403 `PATH_DENIED`**（覆盖 `path=.config`、`.ssh`、`.git` 等直接展开）。
4. **`opendir('/proc/self/fd/'+n)`**，子项 `lstat('/proc/self/fd/'+n+'/'+name)`。禁止 `opendir(原始 path)`。Linux 测试必须断言实际打开了 `/proc/self/fd/` 前缀，不能静默落入 darwin fallback。
5. blocked **子目录** → `kind:"skipped", reason:"denied"`，无导航、无 `preview_path`。vendor/vcs 仍 `skipped` + 对应 reason。
6. 流式读到 201 条即停；`truncated:true`，`omitted:"unknown"`。
7. 边拼 JSON 边计 UTF-8 字节，超 256KiB 停，`reason=byte_budget`。
8. **结束时不靠「同一 fd 的 fstat ino」判断 workspace 是否换掉**（打开着的 inode 在 rename 后仍是旧 inode，且 SessionRepoWorkspaceManager 故意保留旧 version 目录）。必须：
   - 再读 `getRepoSnapshot(sessionId)`；
   - 比较 `status === 'ready'` 且 `selectionVersion` + `workspaceDir` 与采集开始时一致；
   - 再 `open` **当前** `workspaceDir` 比对 dev/ino。任一失败 → 丢弃结果，**409 `WORKSPACE_CHANGED`**（HTTP 固定 409，不用 504）。
9. darwin 单测：无 `/proc` 时 `lstat`+`realpath`+`opendir(realpath)`，注释标明非生产路径。V5 CI 是 `ubuntu-latest`，gateway 测试必须走 Linux 分支。

`preview_path` 仅常规文件且 `isFileAllowed && !isFileBlocked && !hasGitPathSegment`。

### 4.4 hermetic git（受信临时 gitdir，不读仓库 local config）

不能只写 `git -C /proc/self/fd/n`，也不能把 `--git-dir` 指到原始 `.git`：Node `spawn` 默认 close-on-exec；可写的 `.git/config` 里 `core.worktree=/etc`、`filter.*.clean/process` + `.gitattributes` 会在 `git diff`/`status` 里 exec 攻击者命令。`--no-ext-diff --no-textconv` **不**禁用 clean/process filter。禁止靠枚举 `filter.*` 再逐个 `-c` 覆盖。

必须：

1. `lstat` + `open(O_DIRECTORY|O_NOFOLLOW)` 工作树根 → `wfd`。realpath(`/proc/self/fd/wfd`) 必须仍在 `resolveReadyWorkspace` 给出的根下。
2. 对 `<root>/.git` 同样 `lstat`（拒 symlink）+ `open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)` → `gfd`。`.git` 是文件（gitfile / `gitdir:`）→ 空态 `not_a_repo`，本 PR 不跟随。
3. **受信临时 gitdir**（`mkdtemp`）：只写最小 `config`（无 `filter.*` / `include.path` / `includeIf` / `core.worktree` / hooks / fsmonitor）。用 `O_NOFOLLOW` 从 `gfd` 拷贝 `HEAD`、`index`、可选 `packed-refs`、以及 HEAD 指向的单个 ref（任一段 symlink → 失败）。`objects/info/alternates` 写 `/proc/self/fd/<gfd>/objects`。不拷贝、不 symlink 原始 `config`、`hooks`、`commondir`。`finally` 删除临时目录。
4. `spawn` **显式继承** `wfd`/`gfd`。argv：`--git-dir=<tmpdir> --work-tree=/proc/self/fd/<wfd>` `--no-optional-locks` `--ignore-submodules=all` `--no-lazy-fetch`。`diff`/`numstat` 加 `--no-ext-diff --no-textconv`（纵深，不是 filter 的替代）。
5. env 仅：`PATH` `LC_ALL=C` `GIT_CONFIG_NOSYSTEM=1` `GIT_CONFIG_GLOBAL=/dev/null` `GIT_TERMINAL_PROMPT=0` `GIT_OPTIONAL_LOCKS=0` `GIT_PAGER=cat` `PAGER=cat`。不继承 `GIT_EXTERNAL_DIFF` `GIT_DIR` `GIT_WORK_TREE` `GIT_ASKPASS` `GIT_TRACE`。
6. `status`/`numstat` 用 `-z`；`rev-parse` 校验 40-hex。禁止按换行切 path。stdout cap 1MiB；不完整记录丢弃；numstat 未完整则 `diff:null`（禁止假 0）。entries 满 500 停。
7. **达 cap/entries 上限：立即停消费、关闭 pipes、`SIGTERM` → 200ms → `SIGKILL`、始终 reap。** stderr 独立 64KiB 限额并持续 drain，避免 git 堵在满 stderr 上。intentional truncation → 200 + `truncated`；timeout → 504 无 body。任何路径（含异常）在 `finally` 释放 per-session 与全局信号量。
8. 结束后按 §4.3.8 复核 snapshot+inode；失败 409。

测试：`.git/config` 写入 `core.worktree=/etc` 不得列出 `/etc`；`.git` 本身是 symlink 或 gitfile → 拒；hooks/fsmonitor 不被执行；**恶意 `filter.pwn.clean/process` + `.gitattributes` `* filter=pwn` 的 sentinel 命令不得执行**（sentinel 文件不得出现）。

### 4.5 并发

进程级信号量 = 2；**每 session 同时 1 个**。争抢失败 **立即 429 `IN_FLIGHT`**，不排队。

超时：git 5s / list 2s → 终止子进程（同 §4.4.7）后 504，无部分 body。

### 4.6 输出净化（T6）

每个 `name` / `path`：删除 C0、DEL、C1、以及 bidi/isolate（U+061C、U+200E、U+200F、U+202A–U+202E、U+2066–U+2069）。**不**删除 `<` `>` `&`。响应用紧凑 `JSON.stringify`。`<img>` 可出现在 JSON 字节里；XSS 是 PR-B textContent 的责任。

---

## 5. HTTP 接线

容器 `server.ts`：`GET /api/workspace/git-snapshot`、`GET /api/workspace/list-dir`。鉴权：`checkBridgeBypass || (OC_CONTAINER_ID && checkHttpAuth)`。JSON `Cache-Control: no-store`。日志只打 sessionId / 错误码 / truncated / 耗时，不打完整路径或内容。

`BRIDGE_API_ALLOWLIST`：两条 GET，`proxyFromCommercial: true`。

commercial `router.ts`：

1. **admin host-scope terminal 403 必须在 `deps.v3Supervisor && deps.bridgeSecret` 闸之外。**  
   条件：`path.startsWith('/api/workspace/')` 且 `admin && X-OC-Host-Scope:1` → **立刻** `return true` + 403 `HOST_FORBIDDEN`。  
   不能写在 proxy 分支内部：装配缺失时该分支不进，随后 BLOCKED admin bypass `return false` 会进 host gateway。测试必须覆盖 **proxy deps 缺失** 仍 403、handler 计数为 0。
2. 普通 user/admin（无 host-scope）且 proxy deps 齐全 → `matchContainerApiProxyRoute` 代理进自己的容器。
3. `BLOCKED_FOR_USER_RULES` 加全方法精确两条：`/api/workspace/git-snapshot`、`/api/workspace/list-dir`。
4. `COMMERCIAL_ROUTE_PREFIXES` 加 **`/api/workspace/`**（尾斜杠，避免认领 `/api/workspaceevil`）。维护期 503。未声明的 `/api/workspace/foo` 走 commercial `__unmatched__` 404——可接受；已声明两条必须被 proxy/BLOCKED 接管。

**不要**把「闭包测试会绿」当成 BLOCKED/proxy 已登记的证明。`containerRouteProxyClosure` 只要求「已代理，或明确不代理且 BLOCKED」，**不会**要求「已代理的也有 BLOCKED」。`routeOwnership` 只验 `routes ⊆ prefixes`。必须另写显式断言（§6）。

---

## 6. 测试

| 文件 | 覆盖 |
|---|---|
| `protocol/src/__tests__/workspaceInspect.test.ts` | 常量、空态形状、错误码 |
| `gateway/src/__tests__/security.test.ts` | 新 regex；`foo.git` 不误伤；trusted `.git/config` `isFileAllowed===false` |
| `gateway/src/__tests__/workspaceInspect.test.ts` | 穿越；symlink 树外/git-creds/`/etc`；**list-dir 目标 `.config`/`.ssh` → 403**；blocked 子目录 `skipped/denied`；空态无 `added:0`；流式截断；字节预算；hermetic hooks/fsmonitor；**`core.worktree=/etc` 不逃逸**；**.git 为 symlink/gitfile 拒**；**filter clean/process sentinel 不执行**；snapshot 变更 → 409；同 session 第二请求立即 429；Linux 断言走 `/proc/self/fd`；达 cap 后 git 被 kill 且信号量释放；T6：C0/ESC/bidi 从 parse 后的 name 消失，`<img>` 允许保留 |
| `gateway/src/__tests__/apiFileGitAcl.test.ts` | **真实 handler/HTTP 往返**（不许用抽出 guard 替代）：直链 `.git/config` 403；父 `.git` 为 symlink 仍 403；spy 证明未调用 `_resolveMediaDirs` / `realpathSync` / remote pull；目录仍 404；`foo.git` 不被这段误伤 |
| `gateway/src/__tests__/bridgeApiAllowlist.test.ts` | 两条 GET 可代理；POST 不可 |
| `commercial/src/__tests__/workspaceInspectRoutes.test.ts`（新） | **显式**：两条均可 `matchCommercialContainerApiProxy` GET；POST 否；两条均命中 `BLOCKED_FOR_USER_RULES`；user 与 admin（无 host-scope）进入 container proxy；admin+host-scope **即使 v3Supervisor/bridgeSecret 缺失** 仍 403 且不进 host handler |

`WORKSPACE_CHANGED` HTTP **409**。`IN_FLIGHT` 429。超时 504。

---

## 7. 生效面 / 回滚（PR 描述用）

- runtime-source：容器 gateway + protocol  
- master gateway：allowlist / BLOCKED / prefixes / host-scope 403  
- dist：否  
回滚：revert PR-A + runtime tuple 回滚。禁止只回 master。

---

## 8. 明确不做

PR-B UI、Commit/Push、Undo、递归整树、未绑定仓库扫描、第二套文件读取、自行 merge、`deploy-v5.sh`。

---

## 9. Codex 审查问题（方案 · 第 3 轮）

迟到审查（对照旧快照 `45bc8802e`）的 4 条新 Finding 已写入正文与威胁模型。请确认是否闭合，并核对与威胁模型 T2/T5/T6 无矛盾：

1. git **不读** 原始 `.git/config`：受信临时 gitdir + objects alternates；恶意 `filter.*.clean/process` sentinel 不得执行。不能只靠 `--no-ext-diff/--no-textconv` 或枚举 `-c filter.*`。
2. ACL/root 单一权威：采集层不 import `server.ts`、不复制 blocklist/session 正则；`resolveReadyWorkspace` + 注入同一份 `isFileAllowed`/`isFileBlocked`。
3. 达 stdout/entries 上限立即 kill+reap git，stderr drain，truncation≠timeout，信号量必释放。
4. T6：删 C0/DEL/C1/bidi；**不**删 `<img>` 字节；测试按此断言。

顺带确认 #1/#2 已闭合项仍在：fd 继承、`.git` symlink/gitfile 拒、结束复核 snapshot+inode、HTTP 409、blocked 目录、host-scope 403 在 deps 闸外、真实 `/api/file` handler 往返。

第一行 `PASS` / `FAIL` / `PARTIAL`。Finding 必须修才能写代码。不要改代码。
