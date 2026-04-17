# syntax=docker/dockerfile:1.7
# ------------------------------------------------------------
# openclaude/agent-runtime
# ------------------------------------------------------------
# 用户订阅 agent 时 supervisor 会 provision 一个容器,镜像就是这个。
# 设计目标:
#   - 非 root 运行(uid=1000,对齐 05-SEC §13 / T-50 supervisor 的强制 User)
#   - 自带 bun + ccb CLI + 常用命令行工具(git/curl/ripgrep)
#   - ENTRYPOINT 是 supervisor.sh:起 agent RPC server,监听 unix socket
#     (T-52 才会实现真正的 RPC 协议;T-51 阶段只确保"容器能起、whoami=agent"
#      即可,supervisor.sh 里目前是一个占位 `exec tail -f /dev/null`)
#
# 安全基线(配合 T-50 supervisor 的运行时参数):
#   - base `node:22-slim` 比 `node:22` 小很多,但带足 glibc/openssl
#   - 容器内挂载路径:/workspace + /root(都来自 volume,rw);根 fs 是 readonly
#   - /tmp 是 tmpfs(在 T-50 设的 64MB,noexec)
#   - 不装 sudo / su / polkit,防止权限升级
# ------------------------------------------------------------

FROM node:22-slim AS base

# 时区 + 语言环境。node:22-slim 默认 UTC + C,这里显式设成 Asia/Shanghai
# 避免用户 agent 看到奇怪的时间戳。
ENV TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DEBIAN_FRONTEND=noninteractive \
    # 禁用 npm 的 usage 统计(出口流量都走代理,少一个外呼更省事)
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    # bun 安装路径,下面会加入 PATH
    BUN_INSTALL=/usr/local/bun

# 必装工具(精挑,避免镜像膨胀):
#   - git:agent 要 clone/pull
#   - curl + ca-certificates:走代理访问 API / 下载 bun
#   - ripgrep:Claude Code 默认搜索工具
#   - jq:shell 工具链里常见
#   - tini:做 PID 1,转发 SIGTERM,避免 zombie 进程
#   - unzip:bun 安装器需要
#   - bash:supervisor.sh 用 bash,不是 /bin/sh
# 不装的东西:sudo, su, nano, vim, python3(agent 需要 python 时可以自己装到 /workspace)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        ripgrep \
        jq \
        tini \
        unzip \
        bash \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
    # 清掉 setuid/setgid 二进制(05-SEC §13 精神,减少本地提权面)
    # find 不走 -exec 免得 suid 被 fork,改用 chmod 一批一批清
    && find / -xdev -perm -4000 -type f 2>/dev/null | xargs -r chmod u-s \
    && find / -xdev -perm -2000 -type f 2>/dev/null | xargs -r chmod g-s

# ------------------------------------------------------------
# 安装 bun(固定版本,避免"最新"跳来跳去)
# ------------------------------------------------------------
# BUN_VERSION 锁死到一个我们已验证的版本;升级时改这一行并重建镜像。
# 不走 `curl -fsSL install.sh | bash` —— 那个脚本本身从网络拉二进制,层层间接
# 在离线/代理 env 里会踩坑,不如直接下 release zip。
ARG BUN_VERSION=1.1.34

RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) BUN_ARCH=x64;; \
        arm64) BUN_ARCH=aarch64;; \
        *) echo "unsupported arch"; exit 1;; \
    esac; \
    mkdir -p "$BUN_INSTALL/bin"; \
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" -o /tmp/bun.zip; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    mv /tmp/bun/bun-linux-${BUN_ARCH}/bun "$BUN_INSTALL/bin/bun"; \
    chmod +x "$BUN_INSTALL/bin/bun"; \
    ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun; \
    rm -rf /tmp/bun /tmp/bun.zip; \
    bun --version

# ------------------------------------------------------------
# 账户 agent(uid=1000)
# ------------------------------------------------------------
# node:22-slim 里已经有一个 `node` 用户(uid=1000)。为避免撞号,先 userdel 它
# 再建 agent,使得镜像里 uid=1000 一定是 agent。
# T-50 supervisor `User: "1000:1000"` 是按 uid 认,而不是按名;这里保持名字也叫
# agent,是为了 ps 里一眼看得出。
RUN set -eux; \
    if id -u node >/dev/null 2>&1; then userdel -r node; fi; \
    groupadd -g 1000 agent; \
    # 关键:T-50 supervisor 把 home volume 挂到 **/root**(不是 /home/agent),
    # 所以 agent 的 passwd home 也必须是 /root —— 否则 git/bun/npm 查 $HOME 会
    # 落到 /home/agent(readonly root fs 下不可写),一写就 EROFS。
    # 不走 `useradd -m`:不再需要 /home/agent 这个目录;/root 已经存在。
    useradd -u 1000 -g 1000 -d /root -s /bin/bash agent; \
    # /workspace:T-50 把 workspace volume 挂到这里。预建空目录并 chown,
    # 避免首次挂载时目录 root-owned agent 写不了。
    mkdir -p /workspace; \
    chown -R agent:agent /workspace; \
    # /root 同样:agent 的 $HOME,volume 挂到这里。镜像里预填一些 dotfile
    # 也行,但 T-51 保持干净(只有 owner/perm),让 volume 内容由首次启动的
    # agent 进程初始化。
    chown -R agent:agent /root; \
    chmod 750 /root

# ------------------------------------------------------------
# Agent supervisor script
# ------------------------------------------------------------
# supervisor.sh 在容器里做:
#   1. 启动 agent RPC server(T-52 会实现;MVP 占位 = 等信号)
#   2. 捕获 SIGTERM 清理
COPY --chown=root:root supervisor.sh /usr/local/bin/supervisor.sh
RUN chmod 0755 /usr/local/bin/supervisor.sh

# ------------------------------------------------------------
# 运行时配置
# ------------------------------------------------------------
# WORKDIR 放 /workspace —— agent 处理用户代码的默认目录,volume 会覆盖进来。
WORKDIR /workspace

# 强制非 root(双重保险,supervisor 层也设了 User)
USER agent:agent

# tini 做 PID 1,然后才是 supervisor.sh。`--` 分隔 tini flags 和被执行命令。
# 注意:ENTRYPOINT JSON 形式不经过 shell,不会走 PATH 查找,所以写绝对路径。
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/supervisor.sh"]

# CMD 目前是空占位(supervisor.sh 自己决定做什么);保留 LABEL 便于审计
LABEL org.opencontainers.image.title="openclaude-agent-runtime" \
      org.opencontainers.image.description="Per-user agent sandbox runtime (bun + ccb + tools)" \
      org.opencontainers.image.source="https://github.com/anthropics/openclaude" \
      org.opencontainers.image.licenses="proprietary"
