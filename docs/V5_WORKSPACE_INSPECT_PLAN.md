# V5 容器工作区 inspect — PR-A 实现方案

> 威胁模型：`docs/V5_WORKSPACE_INSPECT_THREAT_MODEL.md`（Codex #3 **PASS**）  
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
| commercial | `src/http/router.ts` | BLOCKED 兜底；admin host-scope **terminal 403**；`COMMERCIAL_ROUTE_PREFIXES` 加 `/api/workspace`（维护期 503） |
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
3. **`hasGitPathSegment(filePath) || hasGitPathSegment(lexical)` → 403**（realpath **之前**）
4. `realpathSync`（现有）
5. `isFileAllowed` + `isFileBlocked`（canonical，含新 regex）
6. `openFileHardened`（现有）

目录仍 404。无 `?list=1`。

---

## 3. 新协议（protocol）

常量：`WORKSPACE_INSPECT_PROTOCOL_VERSION = 1`；entries 200 / git entries 500 / git stdout 1MiB / JSON 256KiB / git timeout 5s / list timeout 2s / 深度 32 / 容器信号量 2。

错误码：`BAD_SESSION_ID` `BAD_PATH` `MISSING_SESSION_ID` `PATH_DENIED` `NOT_FOUND` `IN_FLIGHT` `HOST_FORBIDDEN` `GIT_TIMEOUT` `LIST_TIMEOUT` `WORKSPACE_CHANGED`。

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

1. 目标 `lstat`：symlink → 403 `PATH_DENIED`（目标）或 child `kind:symlink`。
2. `openSync(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`，`fstat` 记 ino。
3. `realpath(/proc/self/fd/n)` 做工作树前缀检查。
4. **`opendir('/proc/self/fd/'+n)`**，子项 `lstat('/proc/self/fd/'+n+'/'+name)`。禁止 `opendir(原始 path)`。
5. 流式读到 201 条即停；`truncated:true`，`omitted:"unknown"`。
6. 边拼 JSON 边计 UTF-8 字节，超 256KiB 停，`reason=byte_budget`。
7. 结束再 `fstat(fd)`，ino 变 → 丢弃，`WORKSPACE_CHANGED`。
8. darwin 测试：无 `/proc` 时 `lstat`+`realpath`+`opendir(realpath)`，注释标明非生产路径。

`preview_path` 仅常规文件且 `isFileAllowed && !isFileBlocked && !hasGitPathSegment`。

### 4.4 hermetic git

`open` 工作树根（`O_DIRECTORY|O_NOFOLLOW`）。Linux：`git -C /proc/self/fd/n`。结束后 ino 复核，变则丢弃全部（含 live HEAD）。

env 仅：`PATH` `LC_ALL=C` `GIT_CONFIG_NOSYSTEM=1` `GIT_CONFIG_GLOBAL=/dev/null` `GIT_TERMINAL_PROMPT=0` `GIT_OPTIONAL_LOCKS=0` `GIT_PAGER=cat` `PAGER=cat`。不继承 `GIT_EXTERNAL_DIFF` `GIT_DIR` `GIT_WORK_TREE` `GIT_ASKPASS` `GIT_TRACE`。

argv：`-c core.hooksPath=/dev/null` `-c core.fsmonitor=` `-c diff.external=` `--no-optional-locks`。`diff`/`numstat` 加 `--no-ext-diff --no-textconv`。`status`/`numstat` 用 `-z`；`rev-parse` 校验 40-hex。禁止按换行切 path。

stdout cap 1MiB；不完整 `-z` 记录丢弃；numstat 未完整则 `diff:null`（禁止假 0）。entries 满 500 停。

### 4.5 并发

进程级信号量 = 2；**每 session 同时 1 个**。争抢失败 **立即 429 `IN_FLIGHT`**，不排队。

超时：git 5s / list 2s → 504，无部分 body。

---

## 5. HTTP 接线

容器 `server.ts`：`GET /api/workspace/git-snapshot`、`GET /api/workspace/list-dir`。鉴权：`checkBridgeBypass || (OC_CONTAINER_ID && checkHttpAuth)`。JSON `Cache-Control: no-store`。日志只打 sessionId / 错误码 / truncated / 耗时，不打完整路径或内容。

`BRIDGE_API_ALLOWLIST`：两条 GET，`proxyFromCommercial: true`。

commercial `router.ts`：

1. `matchContainerApiProxyRoute` 已命中且 `admin && X-OC-Host-Scope:1` 且 path 以 `/api/workspace` 开头 → **`return true` + 403 `HOST_FORBIDDEN`**，禁止 fall through（admin bypass 会进 host gateway）。
2. `BLOCKED_FOR_USER_RULES` 加全方法 `/api/workspace/git-snapshot` 与 `/api/workspace/list-dir`（host singleton 兜底）。
3. `COMMERCIAL_ROUTE_PREFIXES` 加 `/api/workspace`（维护期 503，对齐 `/api/agents`）。

`containerRouteProxyClosure` 会强制 allowlist + blocked 同步；实现时让它绿。

---

## 6. 测试

| 文件 | 覆盖 |
|---|---|
| `protocol/src/__tests__/workspaceInspect.test.ts` | 形状常量、`hasGitPathSegment` 若放 protocol 则在此 |
| `gateway/src/__tests__/security.test.ts` | 新 regex；`foo.git` 不误伤；trusted `.git/config` `isFileAllowed===false` |
| `gateway/src/__tests__/workspaceInspect.test.ts` | 穿越变体；symlink 树外/git-creds/`/etc`；空态无 `added:0`；流式截断；字节预算；hermetic（hooks/fsmonitor 不被执行）；ino 变化丢弃；同 session 第二请求立即 429；净化控制字符 |
| `gateway/src/__tests__/apiFileGitAcl.test.ts` | **handler 往返**：直链 `.git/config` 403；**父 `.git` 为 symlink**（realpath 后无 `.git` 字样）仍 403；目录仍 404 |
| `gateway/src/__tests__/bridgeApiAllowlist.test.ts` | 两条 GET 可代理；POST 不可 |
| commercial router / closure / 既有 proxy 测试 | host-scope 403；BLOCKED 存在 |

`/api/file` handler 往返：抽 `assertApiFileDenied(reqPath)` 用 mock `IncomingMessage`/`ServerResponse` 调导出的 guard + 若 Gateway 过重则测 `handleApiFile` 的抽出函数 `denyIfGitPath(filePath)` 在 realpath 前返回 deny。至少用真实 `symlinkSync('.git', targetDir)` + lexical path 含 `.git` 断言 deny，**在调用 realpath 之前**。

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

## 9. Codex 审查问题

1. `handleApiFile` 的 lexical-before-realpath 是否足够挡住「`.git` → `/home/agent/x`」？还要不要在 realpath 后对每个祖先 `lstat`？
2. admin host-scope 在 proxy 分支 terminal 403，是否会误伤其它 `/api/workspace*` 未来路由？正则是否应精确到两条 path？
3. darwin 测试用 `opendir(realpath)` 会不会让 CI（macOS）假绿、Linux 生产路径未测？
4. 把 `/api/workspace` 放进 `COMMERCIAL_ROUTE_PREFIXES` 会不会让未代理请求被 commercial `__unmatched__` 吃掉而不是 403？
5. 还有哪些必须修才能写代码？

要求：`PASS / FAIL / PARTIAL`；不要改代码。
