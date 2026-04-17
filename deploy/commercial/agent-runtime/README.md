# openclaude/agent-runtime

Per-user agent sandbox container image. 对齐 05-SEC §13 + 01-SPEC F-5 + T-50 supervisor 的强制参数。

## 组成

| 文件 | 用途 |
|------|------|
| `Dockerfile` | 镜像构建,base `node:22-slim` + bun + git/curl/ripgrep/jq/tini + 用户 `agent` (uid=1000) |
| `supervisor.sh` | 容器内 PID 1 (经由 tini) 启动脚本,T-51 阶段是占位,T-52 替换成真正的 agent RPC server |
| `agent_seccomp.json` | seccomp 白名单,T-53 lifecycle provision 时读取并传给 supervisor `createContainer` |
| `build.sh` | 本地构建 + 基本 smoke test (whoami=agent, bun/node 可用, /root 可写) |

## 构建

```bash
./build.sh                    # 构建 latest
TAG=v0.1 ./build.sh           # 指定 tag
```

构建后可以用 T-50 supervisor 本地起容器验证:

```bash
# 伪代码:实际通过 T-53 lifecycle 或者下面的 integ 测试路径
docker run --rm \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --security-opt seccomp=$(cat agent_seccomp.json) \
    --read-only \
    --tmpfs /tmp:size=64m,noexec,nosuid,nodev \
    --pids-limit 200 \
    --cpus 0.2 --memory 384m --memory-swap 384m \
    --network agent-net \
    --user 1000:1000 \
    -v agent-u1-workspace:/workspace \
    -v agent-u1-home:/root \
    openclaude/agent-runtime:latest
```

## 与 T-50 supervisor 的契约

| 契约点 | 镜像侧保证 | supervisor 侧保证 |
|-------|-----------|-------------------|
| 非 root 运行 | Dockerfile `USER agent:agent` | `User: "1000:1000"` 强制覆盖 |
| 可写目录 | /workspace + /root owner=1000 | `Binds` 两个 named volume 分别挂到这两个路径 |
| tmpfs /tmp | 无(由宿主机提供) | `Tmpfs: "/tmp": size=64m,noexec,nosuid,nodev` |
| readonly rootfs | 无(镜像不设) | `ReadonlyRootfs: true` |
| seccomp profile | 本目录 `agent_seccomp.json` | `SecurityOpt: "seccomp=<json>"` |
| 出口代理 | supervisor.sh 读 env `HTTP_PROXY` 再透传给子进程 | 注入 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` env |

## T-52/T-53 的 TODO

- [ ] supervisor.sh 里把 `tail -f /dev/null` 替换成 `bun run /usr/local/agent-rpc/server.ts`
- [ ] agent RPC server 监听 `/var/run/agent-rpc.sock` (需要 T-50 supervisor 把 socket 目录挂进来)
- [ ] 添加 `HEALTHCHECK`(T-52 有了 RPC server 才能写健康检查)

## seccomp profile 的来源

见 `agent_seccomp.json` 顶部 `_comment_` 块。采用的策略是 **default=ALLOW + 精选 deny list**,而不是 docker 官方的 default=ERRNO + 300+ whitelist,原因:

1. 与 capabilities 层配合(CapDrop=ALL + no-new-privileges 已经把很多"allow 也执行不了"的 syscall 挡掉)
2. 维护成本低:内核迭代新 syscall 不用追着更新 allowlist
3. 通过 supervisor 层强制校验"必须有 deny 规则"来防止被退化成 unconfined

长期上线一段时间 profile 稳定后再迁移到 deny-default。
