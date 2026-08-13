# V5 容器工作区 inspect — PR-A 实现方案

> 威胁模型：`docs/V5_WORKSPACE_INSPECT_THREAT_MODEL.md`（Codex #3 **PASS**）  
> 实现方案审 #1：**FAIL**（6 Finding）。本版已吸收；待 #2 PASS 才写生产代码。  
> 本轮：**纯后端**。合入后前端零行为变化。PR-B 不做。不部署、不合入。  
> 基线：`origin/feat/v5-aurora-rewrite` @ `e4f3fc930`  
> 分支：`feat/v5-workspace-git-stat`

权威边界以威胁模型为准。本文只写怎么落代码、改哪些文件、怎么测。

---

## 1. 包与文件所有权

| 包 | 文件 | 做什么 |
|---|---|---|
| protocol | `src/workspaceInspect.ts` + `index.ts` export | 常量、错误码、JSON 形状（无 IO） |
| gateway | `src/workspaceInspect.ts`（新） | 路径、hermetic git、list-dir、信号量 |
| gateway | `src/server.ts` | `FILE_BLOCKED_PATTERNS`；`handleApiFile` lexical `.git` 预检；两条 HTTP handler；dispatch |
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

### 4.1 工作区根

`getRepoSnapshot(sessionId)`，`status==='ready'`，`workspaceDir` 绝对。`realpath(workspaceDir)` 必须 `=== reposRoot/sessionId/version` 或以其 `+'/'` 为前缀。`reposRoot = realpath('/home/agent/.openclaude/repos')`（测试可注入）。否则空态，不扫 cwd / `/home/agent`。

无 `OC_CONTAINER_ID` → handler 直接 403 `HOST_FORBIDDEN`。

### 4.2 路径

`sessionId`：`^[A-Za-z0-9_-]+$`。相对 path：空=根；拒 NUL/C0/`\`/绝对/盘符/`.`/`..`/空 segment；深度≤32。join 后打开前再 `hasGitPathSegment`。前缀检查用 `realRoot + '/'`，禁止裸 `startsWith(realRoot)`。

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

### 4.4 hermetic git（fd 继承 + 钉死 worktree）

不能只写 `git -C /proc/self/fd/n`：Node `spawn` 默认 close-on-exec，子进程可能看不见该 fd；可写的 `.git/config` 里 `core.worktree=/etc` 会把 status/diff 指到工作树外。

必须：

1. `lstat` + `open(O_DIRECTORY|O_NOFOLLOW)` 工作树根 → `wfd`。realpath(`/proc/self/fd/wfd`) 必须仍在 `reposRoot/sessionId/version` 下。
2. 对 `<root>/.git` 同样 `lstat`（拒 symlink）+ `open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)` → `gfd`。`.git` 是文件（gitfile）→ 403/空态 `not_a_repo`，本 PR 不跟随 gitfile。
3. `spawn` **显式继承** `wfd`/`gfd`（`stdio` 传 fd 或 `ChildProcess` 的 fd 继承，禁止依赖「碰巧没 CLOEXEC」）。
4. argv 用 `--git-dir=/proc/self/fd/<gfd> --work-tree=/proc/self/fd/<wfd>`，**不用**单独的 `-C` 当唯一锚。再加 hermetic `-c`：`core.hooksPath=/dev/null` `core.fsmonitor=` `diff.external=` `core.worktree=` `--no-optional-locks`。`diff`/`numstat` 加 `--no-ext-diff --no-textconv`。
5. env 仅：`PATH` `LC_ALL=C` `GIT_CONFIG_NOSYSTEM=1` `GIT_CONFIG_GLOBAL=/dev/null` `GIT_TERMINAL_PROMPT=0` `GIT_OPTIONAL_LOCKS=0` `GIT_PAGER=cat` `PAGER=cat`。不继承 `GIT_EXTERNAL_DIFF` `GIT_DIR` `GIT_WORK_TREE` `GIT_ASKPASS` `GIT_TRACE`。
6. `status`/`numstat` 用 `-z`；`rev-parse` 校验 40-hex。禁止按换行切 path。stdout cap 1MiB；不完整记录丢弃；numstat 未完整则 `diff:null`（禁止假 0）。entries 满 500 停。
7. 结束后按 §4.3.8 复核 snapshot+inode；失败 409。

测试：`.git/config` 写入 `core.worktree=/etc` 不得列出 `/etc`；`.git` 本身是 symlink → 拒；hooks/fsmonitor 不被执行。

### 4.5 并发

进程级信号量 = 2；**每 session 同时 1 个**。争抢失败 **立即 429 `IN_FLIGHT`**，不排队。

超时：git 5s / list 2s → 504，无部分 body。

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
| `gateway/src/__tests__/workspaceInspect.test.ts` | 穿越；symlink 树外/git-creds/`/etc`；**list-dir 目标 `.config`/`.ssh` → 403**；blocked 子目录 `skipped/denied`；空态无 `added:0`；流式截断；字节预算；hermetic hooks/fsmonitor；**`core.worktree=/etc` 不逃逸**；**.git 为 symlink 拒**；snapshot 变更 → 409；同 session 第二请求立即 429；Linux 断言走 `/proc/self/fd`；净化控制字符 |
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

## 9. Codex 审查问题（方案 · 第 2 轮）

#1 FAIL 的 6 条 Finding 已写入正文。请确认是否闭合：

1. git：显式继承 wfd/gfd + `--git-dir/--work-tree=/proc/self/fd/...` + 覆盖 `core.worktree`；`.git` symlink 拒。
2. 结束复核改读 snapshot + 重开当前路径比 inode；HTTP 固定 409。
3. list-dir 目标 `isFileBlocked` → 403；blocked 子目录 `skipped/denied`。
4. admin host-scope 403 在 proxy deps 闸外；deps 缺失仍 403。
5. 显式路由断言，不依赖 closure 测试当证明。
6. `/api/file` 必须真实 handler 往返 + spy，guard 在 resolver 之前。

第一行 `PASS` / `FAIL` / `PARTIAL`。不要改代码。
