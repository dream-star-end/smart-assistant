# node-agent /files TOCTOU 防御审计 (2026-05-16)

## 背景

Phase 2 (v1.0.151) 上线时,为 `handleGet` 加了 fd-realpath 后置校验 (读 `/proc/self/fd/<n>` 反查),关掉 `resolveParentNoSymlink → OpenFile` 之间最后一段 parent-symlink race window。

举一反三:**同一段代码里 `handlePut` / `handleStat` / `handleDelete` 也用类似的 "validate → 操作" 模式,race 是否同样存在?**

结论:**存在,程度不一**。本文给出现状评级 + 修复方案,由 boss 决定优先级。

---

## 2026-05-16 范围扩展:gateway master 进程的 self-host 写路径

`node-agent` 当前实际部署形态是 dormant 代码(self host 不跑 node-agent,
boheyun 已废弃 → 0 实例)。**真正的攻击面在 gateway 主进程内的 self-host
文件 IO 上**,具体是 `server.ts: handleUpload` 这个写路径 —— 它 PUT 进
docker 命名卷的 host-side mountpoint,而 baseline 镜像把
`/home/agent/.openclaude` 设 `agent:agent`,所以 host 侧 `uploads/`
`generated/` 目录 owner = uid 1000 = 容器可写。攻击者可 `rename` 这两个目录
本身、或在 parent (`_data/`) 也是 uid 1000 时直接 swap 成 symlink。

修复(v1.0.155):

- **fd-first open**:`openSync(tmpPath, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)`,
  原子创建 + 最后一段 symlink 防御。
- **post-open verify**:`realpathSync('/proc/self/fd/<n>') === tmpPath`,关掉
  parent-symlink race window(对齐 `openFileHardened` 模式)。
- **fd-based chmod/chown**:之前 `chmodSync(path)` / `chownSync(path)` 可被
  rename-swap 把 root 的 chown 转到 `/etc/某文件`;改成 `fchmodSync(fd)` /
  `fchownSync(fd, 1000, 1000)` 完全规避。
- **post-link triple verify**:`linkSync` 之后再次 `openSync(finalPath, NOFOLLOW)`
  + `realpathSync(/proc/self/fd)` + `fstat(tmpFd).dev/ino === fstat(finalFd).dev/ino`,
  确保 finalPath 指向我们刚生成的 inode 而非攻击者塞入的碰撞。
- **try/finally fd 生命周期**:外层 `closeTmpFd` 在所有错误路径都关 fd,
  避免 fd 泄漏。`ws` 用 `{ fd, autoClose: false }` 让 fd lifetime 集中管理。
- **测试 seam**:`__setUploadFsOpsForTests` 包装 fchmod/fchown/link,future
  unit test 可注入 EPERM / EXDEV 而无需 root 或 docker。

剩余风险(未根治):
- `unlinkSync(tmpFdReal)` 和 `unlinkSync(finalPath)` 这两个错误清理路径仍是
  path-based,理论上可被二次 swap 让 unlink 删错文件 → 但攻击者要先成功
  发起一次 parent-symlink swap,此时清理失败最多是磁盘泄漏 DoS,不会扩大
  权限边界。同 handleGet/handlePut 的剩余 race 等价。
- `remoteUpload` 分支的 `readFile(tmpPath)` 是 path-based,可被并发 swap
  污染。但目标是 root-owned 的远程目录(node-agent 自己再 validate),且
  内容已 hash → digest 已下发给客户端,内容篡改会被客户端发现 sha 不符。
  无权限提升,接受现状。
- 中期方案:用 `openat2(RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH)` 在 syscall
  层一次性根治。Node 无内置绑定,需 native addon 或 ffi-napi,工作量
  4-8 小时,排进 backlog。

---

## 以下章节为原 node-agent 层审计(2026-05-16 上半部分),保留供参考。
**node-agent 当前不在生产环境运行;改这块代码无运行时收益**。

---

## 攻击者模型

```
container (uid 1000, agent:agent)
   ↓ docker named volume `oc-v3-data-u<uid>`
host /var/lib/docker/volumes/oc-v3-data-u<uid>/_data/{uploads,generated}/
   ↑ node-agent (root) 调 syscall 读写
```

**关键事实**: docker volume **首次 mount 保留 image mountpoint ownership**;
baseline image 把 `/home/agent/.openclaude` 设为 `agent:agent`,所以 host 侧
`uploads/` `generated/` 这两个目录 **owner = uid 1000**。容器进程能:

- `rename` 这两个目录本身
- 在 parent (`_data/`) 也是 uid 1000 owned 的话,直接 swap 它们成 symlink

→ TOCTOU 攻击条件成立。

非攻击条件:`AllowedRoots` 里的 `/var/lib/openclaude/baseline` 等是 root:root, 容器
碰不到,只有 `AllowedDirRegexes` 命中的动态 volume 子目录是攻击面。

---

## 每个 handler 的 race 分析

### handleGet (✅ 已修, v1.0.151)

```
validatePath          ← 文本白名单
resolveParentNoSymlink ← parent EvalSymlinks
OpenFile(NOFOLLOW)    ← race window 在这里 ↓
verifyFdTarget        ← 新加: /proc/self/fd 反查 close race window
fd.Stat → io.Copy
```

### handlePut (❌ 高风险 gap)

```
validatePath
resolveParentNoSymlink
OpenFile(tmp, CREATE|TRUNC|NOFOLLOW)  ← race: parent 此刻可能已是 symlink
io.Copy / Sync / Close
chown(tmp, container_uid) / chmod(tmp, mode)
Rename(tmp, p)                         ← race: rename 后 p 可能落在 /etc
```

**最坏后果**:
1. tmp 写到 `/etc/foo.tmp` (root 写,owner=1000 mode=0400)
2. rename 成 `/etc/foo`
3. master 以为成功,容器内 uid 1000 进程 **可读** `/etc/foo` (但写不了);
   host 上其他 uid 进程读不了
4. 权限提升路径不直接,但 **DoS / 占名** 攻击有效 (把 `/etc/某关键文件` 顶掉)

**修复**:
- (a) rename 后立刻 `os.Lstat(p)` 验 p 仍在 `AllowedRoots` / `AllowedDirRegexes` 内,不在则 `os.Remove(p)` + 报错。
- (b) **更稳**: open tmp 后调 `verifyFdTarget(tmp.Fd())` 与 GET 对齐。tmp 此时如果不在白名单,直接拒、不再 rename。

### handleStat (⚠ 中风险 gap — 信息泄露)

```
validatePath
[no resolveParentNoSymlink]            ← 第一道 gap
Lstat(p)
OpenFile(p, RDONLY|NOFOLLOW) for hash  ← race window
io.Copy → sha256.Sum
```

**最坏后果**:master 拿到 `/etc/某文件` 的 sha256。配合公开文件指纹库 (rainbow table on
common config files) 可反推内容。比 PUT 风险低,但 **隐蔽性高,无对外 IO 痕迹**。

**修复**: 与 GET 完全对齐 — 加 `resolveParentNoSymlink` + `verifyFdTarget`。

### handleDelete (⚠ 中风险 gap)

```
validatePath
[no resolveParentNoSymlink]            ← 第一道 gap
Lstat(p) → check not symlink
Remove(p)                               ← race window
```

**注意**: `Remove`/`unlink` syscall **不解析符号链接**,所以 p 本身是 symlink 时
不会删 target。但 **parent 被替换成 symlink** 时,`Remove("parent/p")` 在 parent 已
是 symlink → /etc 的情况下会去 `/etc/p` unlink。

**最坏后果**: 容器配合一次 parent rename 触发 `Remove("/etc/某文件")`。DoS-y 攻击。

**修复**: 加 `resolveParentNoSymlink`,与 PUT 对齐。fd-realpath 不适用 (unlink 没 fd)。

---

## 中期方案:openat2 一次性根治

Linux 5.6+ 的 `openat2(2)` 支持 `RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH`,把"路径解析必须不跨 symlink + 不越出指定根"直接压到 syscall 层。一次解决所有 race。

Go 标准库未暴露,但 `golang.org/x/sys/unix.Openat2` 提供 wrapper。代码量小:

```go
import "golang.org/x/sys/unix"

how := &unix.OpenHow{
    Flags:   uint64(os.O_RDONLY),
    Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_BENEATH,
}
dirfd, _ := unix.Open(allowedRoot, unix.O_PATH|unix.O_DIRECTORY, 0)
fd, err := unix.Openat2(dirfd, relPath, how)
```

收益:**完全消除** parent-symlink TOCTOU,fd-realpath 后置校验也可以撤掉(syscall 层
已保证)。

代价:Linux 5.6+ only (Ubuntu 20.04+ 满足);需要把"路径"重构成 "root + rel"
两段;现有 validatePath 逻辑也要重构。约 200 行代码,2-3 小时工作量。

---

## 推荐路径

### 不修也行 (现状评估)

- 攻击者需要 (a) 拿到 uid 1000 容器内代码执行 (b) 精确时间窗 syscall race
- (a) 已经是严重事件;有 (a) 后能做的事远多于 file TOCTOU。这是"防御纵深"层面
- 用户没碰到这类问题,纯硬化

### 短期 (本周内 followup, ~1 小时)

逐 handler 加最小防御,对齐 GET 强度:
1. handlePut: tmp open 后加 `verifyFdTarget`,rename 后再加 `os.Lstat(p) + 路径在白名单` 验
2. handleStat: 加 `resolveParentNoSymlink` + `verifyFdTarget`
3. handleDelete: 加 `resolveParentNoSymlink`
4. 每个加 1-2 个测试 (复用 GET 那批的测试模式)

### 中期 (有空一次性根治, 2-3 小时)

切 openat2 + RESOLVE_BENEATH。撤掉 verifyFdTarget / resolveParentNoSymlink (syscall 保证)。
留 validatePath (文本白名单仍有用,挡明显非法请求,省 syscall)。

---

## boss 决策点

- [ ] 不修 (接受现状,记入已知 debt)
- [ ] 短期 hardening 三件套 (我现在动手)
- [ ] 中期 openat2 一次性重构 (排进 backlog)
- [ ] 三选其它组合 (你说)

---

## 2026-05-16 实际选型 + 后续

boss 选了"只动 v3 commercial 真攻击面" → 上面整段 gateway master 进程
self-host 写路径 hardening 在 **v1.0.155** 一次性落地(commit
`fix(gateway): handleUpload TOCTOU hardening`)。node-agent 这部分代码仍保留
现状,排进 backlog 等 boheyun-style remote host 重新上线再统一收。

Backlog:
1. `openat2(RESOLVE_BENEATH)` 一次性根治(self-host + remote-host 都受益)。
   需 native addon / ffi-napi。
2. node-agent /files handlePut / handleStat / handleDelete 应用同款
   fd-realpath verify(只有 remote host 重新上线后才有意义)。
3. handleUpload 错误清理路径 path-based unlink 的剩余 race 用 openat/unlinkat
   收尾(同 1 一起做)。
