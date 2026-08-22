---
name: ssh
description: 使用容器内置 OpenSSH 客户端（ssh/scp/sftp/ssh-keygen）连接远程主机、拷文件或管理密钥。用户要 SSH 登录、scp/sftp、生成密钥，或在自用 V5 实例用 host 通道操作宿主机时使用。
tags: [ssh, scp, sftp, openssh, host]
priority: 4
---

# OpenSSH 客户端（容器内置）

当用户要 **SSH 登录、scp/sftp 传文件、生成或登记密钥**，或在**自用 V5** 里操作宿主机时，用镜像已安装的 OpenSSH，不要 `apt install openssh-client`，也不要把 `ssh`/`scp` 拷到 `~/.local/bin`。

## 内置命令

都在 `/usr/bin/`：`ssh`、`scp`、`sftp`、`ssh-keygen`、`ssh-add`、`ssh-agent`、`ssh-keyscan`。

`~/.local/bin` 在 PATH 最前。若那里还有旧的 `ssh`/`scp` 副本，会挡住系统包。优先写绝对路径 `/usr/bin/ssh`，或先 `command -v ssh ssh-keygen`。缺少 `ssh-keygen` 说明当前容器还是旧镜像，需要重建 runtime image 并回收容器，不要再现场 apt。

```bash
test -x /usr/bin/ssh && /usr/bin/ssh -V
command -v ssh ssh-keygen scp sftp ssh-agent
```

## 连接与拷文件

```bash
/usr/bin/ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new user@example.com
/usr/bin/scp -i ~/.ssh/id_ed25519 ./file user@example.com:/tmp/file
/usr/bin/sftp -i ~/.ssh/id_ed25519 user@example.com
```

- 密钥放 `~/.ssh/` 或 `~/.openclaude/.ssh/`，私钥 `chmod 600`，**永远不要在回复里打印私钥内容**。
- 默认公钥登录。只有用户明确要求口令登录时才考虑 `sshpass`；不要主动安装，也不要 `-o StrictHostKeyChecking=no`。
- 首次连接用 `accept-new` 写入 known_hosts；已有冲突先给用户看指纹，不要擅自删 known_hosts 后重连。

## 生成密钥

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
/usr/bin/ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C 'openclaude-agent'
chmod 600 ~/.ssh/id_ed25519
# 只把 .pub 交给用户或写入对方 authorized_keys
```

需要把公钥送到已有权限的机器时用 `ssh-copy-id` 或 `scp` 公钥；不要把私钥拷出去。

## 自用 V5 的 `host` 通道

仅管理员容器 → 本机宿主。包装器在 `~/.local/bin/host`，内部固定：

`/usr/bin/ssh -i ~/.openclaude/.ssh/id_ed25519 root@172.31.0.1`

```bash
host hostname
host 'git -C /opt/openclaude/openclaude-v5-selfhost rev-parse --short HEAD'
```

无参数是交互 shell。参数会原样交给远端，不要写成 `host cmd ...`。商业版容器没有这条通道。不要把宿主私钥或 `172.31.0.1` 的登录口令写进用户可见回复。

丢了云主机私钥、只能走厂商 VNC 补公钥时，改用 `skill_view("provider-novnc-ssh-key-recovery")`，不要在这里猜测口令。

## 失败处理

- `command not found` / 没有 `/usr/bin/ssh-keygen`：报当前镜像缺少 OpenSSH，请重建 `Dockerfile.openclaude-runtime` 所在 runtime image 并回收容器。
- `Permission denied (publickey)`：检查 `-i` 路径、公钥是否在对方 `authorized_keys`、权限是否 600/700。
- `Host key verification failed`：展示当前与 known_hosts 中的指纹，让用户确认后再改。
- 不要扫描网段、不要爆破口令、不要关闭公钥强制策略。
