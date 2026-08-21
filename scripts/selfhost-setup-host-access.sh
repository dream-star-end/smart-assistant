#!/usr/bin/env bash
# 打通「管理员容器 → 宿主机」的 SSH 通道(自用实例专属能力)。
#
# 安全模型(2026-08-13 定稿,替代早期的「按容器 IP 放行」方案):
#   - 网络层:iptables 只放行 172.31.0.0/16 → 172.31.0.1:22,由
#     openclaude-v5-selfhost-sshgate.service 维护。容器 IP 由 pickIp 随机分配,
#     容器重建就会变,所以不能按单个 IP 放行。
#   - 身份层:私钥只投放到指定 uid 的 data volume。别的用户容器能连到 22 端口,
#     但没有私钥 → publickey 拒绝。
#   - sshd:对 172.31.0.0/16 强制 publickey-only,关掉密码与键盘交互,
#     防止容器内对宿主爆破口令。
#
# 幂等:重复执行只补齐缺失部分,已存在的密钥不会重新生成。
#
# 用法: selfhost-setup-host-access.sh --uid <admin_uid> [--apply]
#        不带 --apply 只打印将要做的改动。
set -euo pipefail

UID_ARG=""
APPLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uid) UID_ARG="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[[ "$UID_ARG" =~ ^[0-9]+$ ]] || { echo "用法: $0 --uid <admin_uid> [--apply]" >&2; exit 2; }

KEY=/root/.ssh/oc-v5-selfhost-container
KEY_TAG="oc-v5-selfhost admin container -> host"
AUTH=/root/.ssh/authorized_keys
SSHD=/etc/ssh/sshd_config
SUBNET=172.31.0.0/16
DATA_VOL="oc-v5-data-u${UID_ARG}"
LOCAL_VOL="oc-v5-userlocal-u${UID_ARG}"
CONTAINER="oc-v5-u${UID_ARG}"

say() { printf '%s\n' "$*"; }
todo() { printf '  [将执行] %s\n' "$*"; }
done_() { printf '  ✓ %s\n' "$*"; }
skip() { printf '  - %s(已就绪)\n' "$*"; }

data_mount=$(docker volume inspect "$DATA_VOL" --format '{{.Mountpoint}}' 2>/dev/null || true)
local_mount=$(docker volume inspect "$LOCAL_VOL" --format '{{.Mountpoint}}' 2>/dev/null || true)
[[ -n "$data_mount" ]] || { echo "✗ 找不到 volume $DATA_VOL(该用户还没开过容器?)" >&2; exit 1; }
[[ -n "$local_mount" ]] || { echo "✗ 找不到 volume $LOCAL_VOL" >&2; exit 1; }

say "admin uid = $UID_ARG"
say "data  vol = $DATA_VOL ($data_mount)"
say "local vol = $LOCAL_VOL ($local_mount)"
say "模式: $([[ $APPLY == 1 ]] && echo apply || echo dry-run)"
say ""

if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  say "⚠ 容器 $CONTAINER 正在运行。投放私钥不需要停容器(卷是热挂载),"
  say "  但容器内 PATH 缓存可能要等下次开会话才生效。"
  say ""
fi

# ─── 1. 宿主专用密钥对 ────────────────────────────────────────────────
say "=== 1. 宿主专用密钥对 ==="
if [[ -f "$KEY" ]]; then
  skip "$KEY"
else
  todo "ssh-keygen -t ed25519 -N '' -f $KEY"
  if [[ $APPLY == 1 ]]; then
    install -d -m 700 /root/.ssh
    ssh-keygen -t ed25519 -N '' -C "$KEY_TAG" -f "$KEY" >/dev/null
    done_ "已生成 $KEY"
  fi
fi

# ─── 2. authorized_keys ──────────────────────────────────────────────
say "=== 2. authorized_keys ==="
if [[ -f "$KEY.pub" ]] && grep -qF "$KEY_TAG" "$AUTH" 2>/dev/null; then
  skip "authorized_keys 已含该公钥"
elif [[ $APPLY == 1 ]]; then
  install -d -m 700 /root/.ssh
  touch "$AUTH" && chmod 600 "$AUTH"
  cat "$KEY.pub" >> "$AUTH"
  done_ "公钥已追加到 $AUTH"
else
  todo "把 $KEY.pub 追加到 $AUTH"
fi

# ─── 3. sshd:对容器网段强制 publickey-only ──────────────────────────
# Match 段之后的所有指令都归该段,所以必须追加在文件末尾。
say "=== 3. sshd Match $SUBNET ==="
if grep -q "^Match Address $SUBNET" "$SSHD"; then
  skip "sshd_config 已有 Match Address $SUBNET"
elif [[ $APPLY == 1 ]]; then
  # 校验必须在候选副本上做,再原子换上。直接追加主配置后再 sshd -t,
  # 一旦校验失败就把坏配置永久留在 /etc/ssh/sshd_config,下次重启会丢掉整机 SSH。
  bak="$SSHD.bak.$(date +%Y%m%d%H%M%S)"
  cp -a "$SSHD" "$bak"
  cand="$(mktemp)"
  cat "$SSHD" > "$cand"
  cat >> "$cand" <<EOF

# 容器 → 宿主通道(openclaude V5 自用实例):只认公钥,禁口令,防容器内爆破。
Match Address $SUBNET
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitRootLogin prohibit-password
EOF
  if ! sshd -t -f "$cand"; then
    rm -f "$cand" "$bak"
    echo "✗ sshd 配置校验失败,主配置未改动" >&2
    exit 1
  fi
  cat "$cand" > "$SSHD"
  rm -f "$cand"
  if ! sshd -t; then
    cat "$bak" > "$SSHD"
    echo "✗ 写入后校验失败,已回滚到 $bak" >&2
    exit 1
  fi
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  done_ "sshd 已加固并 reload(备份 $bak)"
else
  todo "在 $SSHD 末尾追加 Match Address $SUBNET(publickey-only)并 reload"
fi

# ─── 4. 私钥投放到 admin 的 data volume ──────────────────────────────
say "=== 4. 私钥投放 $DATA_VOL ==="
vol_key="$data_mount/.ssh/id_ed25519"
if [[ -f "$vol_key" ]] && cmp -s "$KEY" "$vol_key"; then
  skip "$vol_key"
elif [[ $APPLY == 1 ]]; then
  install -d -m 700 -o 1000 -g 1000 "$data_mount/.ssh"
  install -m 600 -o 1000 -g 1000 "$KEY" "$vol_key"
  done_ "私钥已投放并 chown 1000:1000"
else
  todo "把 $KEY 投放到 $vol_key(600, 1000:1000)"
fi

# ─── 5. ssh 客户端 + host wrapper 投放到 userlocal volume ────────────
# 运行时镜像不带 openssh-client。宿主的二进制与容器 base 的 Ubuntu 版本不同,
# 直接拷会有动态库版本风险,所以在容器内装再落到持久卷,重建容器也还在。
say "=== 5. ssh 客户端与 host wrapper ==="
need_client=0
for b in ssh scp; do
  [[ -x "$local_mount/bin/$b" ]] || need_client=1
done
if [[ $need_client == 0 ]]; then
  skip "$local_mount/bin/{ssh,scp}"
elif [[ $APPLY == 1 ]]; then
  docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true ||
    { echo "✗ 需要在运行中的 $CONTAINER 内安装 openssh-client,请先开一次会话" >&2; exit 1; }
  docker exec "$CONTAINER" bash -lc '
    set -e
    sudo apt-get update -qq
    sudo apt-get install -y -qq openssh-client
    mkdir -p ~/.local/bin
    cp "$(command -v ssh)" ~/.local/bin/ssh
    cp "$(command -v scp)" ~/.local/bin/scp
    chmod 755 ~/.local/bin/ssh ~/.local/bin/scp
  '
  done_ "已在容器内安装 openssh-client 并落到持久卷"
else
  todo "在 $CONTAINER 内 apt 安装 openssh-client 并拷到 ~/.local/bin"
fi

wrapper="$local_mount/bin/host"
wrapper_body='#!/bin/sh
# 到宿主机的固定通道。无参数=交互 shell,带参数=远程执行。
KEY="$HOME/.openclaude/.ssh/id_ed25519"
exec "$HOME/.local/bin/ssh" -i "$KEY" \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$HOME/.openclaude/.ssh/known_hosts" \
  -o ConnectTimeout=10 \
  root@172.31.0.1 "$@"
'
if [[ -f "$wrapper" ]] && printf '%s' "$wrapper_body" | cmp -s - "$wrapper"; then
  skip "$wrapper"
elif [[ $APPLY == 1 ]]; then
  install -d -m 755 -o 1000 -g 1000 "$local_mount/bin"
  printf '%s' "$wrapper_body" > "$wrapper"
  chmod 755 "$wrapper" && chown 1000:1000 "$wrapper"
  done_ "已写入 $wrapper"
else
  todo "写入 $wrapper"
fi

# ─── 6. iptables 放行(由 sshgate unit 维护)───────────────────────────
say "=== 6. iptables sshgate ==="
if systemctl is-enabled --quiet openclaude-v5-selfhost-sshgate.service 2>/dev/null; then
  if iptables -C V5_EGRESS_IN -s "$SUBNET" -d 172.31.0.1 -p tcp --dport 22 -j RETURN 2>/dev/null; then
    skip "放行规则在位"
  elif [[ $APPLY == 1 ]]; then
    systemctl restart openclaude-v5-selfhost-sshgate.service
    done_ "已重启 sshgate 装回规则"
  else
    todo "systemctl restart openclaude-v5-selfhost-sshgate.service"
  fi
else
  echo "  ✗ openclaude-v5-selfhost-sshgate.service 未安装,请先跑 deploy-v5-selfhost.sh" >&2
  exit 1
fi

say ""
if [[ $APPLY != 1 ]]; then
  say "dry-run: 未改动任何东西。确认后加 --apply。"
  exit 0
fi

# ─── 7. 验收 ─────────────────────────────────────────────────────────
say "=== 7. 验收 ==="
if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  if out=$(docker exec "$CONTAINER" sh -c '~/.local/bin/host "hostname"' 2>&1); then
    done_ "容器 → 宿主通道可用: $out"
  else
    echo "  ✗ 通道不通: $out" >&2
    exit 1
  fi
else
  say "  容器未运行,跳过在线验收。开一次会话后可执行:"
  say "    docker exec $CONTAINER sh -c '~/.local/bin/host hostname'"
fi
