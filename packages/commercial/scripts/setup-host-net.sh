#!/bin/bash
# 2J-1 + 2J-2: host 侧网络隔离 — idempotent
#
# 作用:
#   1. 创建 docker bridge 网络 openclaude-v3-net (subnet 172.30.0.0/16, gateway 172.30.0.1,
#      IPv6=false, ICC=false 防容器横向)
#   2. 添加 ufw 规则: 仅 172.30.0.0/16 可访问 172.30.0.1:18791 (内部代理 edge listener)
#   3. **2J-2 (2026-04-21 安全审计 BLOCKER#2 修复)**: 用 iptables 独立链 V3_EGRESS_IN,
#      把"v3 容器→host 横向访问"硬封死 —— 仅允许容器到 internal proxy 18791,
#      其他 host 端口(PG 5432 / Redis 6379 / gateway 18789 admin / SSH 22 / etc)全部 DROP。
#
#      不动 FORWARD 链(容器→公网仍开),否则 browser-automation / web-search /
#      MCP server fetch 全瘫 — 个人版那批工具就是直连公网的。
#
# 使用:  sudo bash setup-host-net.sh
#
# 幂等: 重复执行无副作用。docker network 已存在则校验 subnet/gateway/ipv6/icc 全吻合;
#       ufw 规则走自身幂等 ("Skipping adding existing rule") + 解析 stderr 决定 [OK]/[ADDED];
#       iptables 用独立 V3_EGRESS_IN 链 + flush 重建 → 重跑保证终态一致。
#
# locale: 强制 LANG=C 确保 ufw / docker 输出英文 (codex 审计:Skipping/Rule added 是英文串,
#         非英文 locale 下 grep 会漂)。

set -e
export LANG=C
export LC_ALL=C

NET_NAME="openclaude-v3-net"
SUBNET="172.30.0.0/16"
GATEWAY="172.30.0.1"
INTERNAL_PROXY_PORT="18791"
# 容器→host 横向防火墙独立链
V3_HOST_GUARD_CHAIN="V3_EGRESS_IN"

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "[ABORT] 必须以 root 运行 (需要 docker + ufw 权限)"
    exit 1
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[ABORT] 缺少命令: $1"
    exit 1
  fi
}

ensure_network() {
  if docker network inspect "$NET_NAME" >/dev/null 2>&1; then
    local actual_subnet actual_gw actual_ipv6 actual_icc
    actual_subnet=$(docker network inspect "$NET_NAME" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
    actual_gw=$(docker network inspect "$NET_NAME" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
    actual_ipv6=$(docker network inspect "$NET_NAME" -f '{{.EnableIPv6}}')
    # icc opt 缺失时 docker 默认开启 → 视为 "true"。我们必须显式 false。
    actual_icc=$(docker network inspect "$NET_NAME" -f '{{index .Options "com.docker.network.bridge.enable_icc"}}')
    if [ -z "$actual_icc" ]; then actual_icc="true"; fi
    if [ "$actual_subnet" != "$SUBNET" ] || [ "$actual_gw" != "$GATEWAY" ] \
       || [ "$actual_ipv6" != "false" ] || [ "$actual_icc" != "false" ]; then
      echo "[ABORT] $NET_NAME 已存在但配置不符:"
      echo "  expect: subnet=$SUBNET gateway=$GATEWAY ipv6=false icc=false"
      echo "  actual: subnet=$actual_subnet gateway=$actual_gw ipv6=$actual_ipv6 icc=$actual_icc"
      echo "  → 需要手动 docker network rm $NET_NAME 后重跑"
      exit 1
    fi
    echo "[OK] $NET_NAME 已存在 (subnet=$SUBNET gateway=$GATEWAY ipv6=false icc=false)"
  else
    docker network create \
      --driver bridge \
      --subnet "$SUBNET" \
      --gateway "$GATEWAY" \
      --ipv6=false \
      --opt com.docker.network.bridge.enable_icc=false \
      "$NET_NAME"
    echo "[CREATED] $NET_NAME (subnet=$SUBNET gateway=$GATEWAY ipv6=false icc=false)"
  fi
}

apply_ufw() {
  # 直接 invoke ufw,它本身幂等 (重复时输出 "Skipping adding existing rule")
  local label="$1"
  shift
  local out
  out=$(ufw "$@" 2>&1)
  if echo "$out" | grep -q "Skipping"; then
    echo "[OK]    $label (already present)"
  elif echo "$out" | grep -qE "Rule added|Rule updated"; then
    echo "[ADDED] $label"
  else
    echo "[?] $label → $out"
  fi
}

ensure_ufw_rule() {
  if ! ufw status | grep -q "Status: active"; then
    echo "[WARN] ufw 未激活,跳过规则添加。手动: ufw enable && 重跑此脚本"
    return
  fi
  apply_ufw "allow ${SUBNET} → ${INTERNAL_PROXY_PORT}/tcp" \
    allow proto tcp from "$SUBNET" to any port "$INTERNAL_PROXY_PORT" comment 'openclaude-v3 internal proxy (172.30.0.1:18791)'
  # 防御性显式 deny — ufw default 是 deny 但写一条审计可见,且兼容 default allow 的环境
  apply_ufw "deny v4/v6 → ${INTERNAL_PROXY_PORT}/tcp (除 ${SUBNET} 外)" \
    deny in proto tcp to any port "$INTERNAL_PROXY_PORT"
}

ensure_v3_host_guard() {
  # 2J-2 BLOCKER 修复:用 iptables 独立链阻止容器→host 横向。
  # 设计:
  #   - 创建链 V3_EGRESS_IN(若已存在 → flush 重建,保证幂等且终态一致)
  #   - 链内规则:目的=172.30.0.1:18791/tcp → RETURN(放行,继续走 INPUT 默认策略)
  #                其他 → DROP
  #   - INPUT 入口在第 1 条插一条 jump:`-s 172.30.0.0/16 -j V3_EGRESS_IN`
  #     幂等检查用 -C(只查不存在再插)。
  #
  # 不开 FORWARD 链:容器→公网允许通过(浏览器/搜索/MCP fetch 必须),
  # 出口策略走未来的 SNAT/代理统一(留给 Phase B,见 docs)。
  #
  # 备注:在 docker daemon 启动后跑此脚本,以免 docker 重置 iptables 时清掉我们的规则。
  #       建议配套用 systemd unit "openclaude-v3-host-firewall.service" 在
  #       docker.service After= 之后跑(本仓库 packages/commercial/scripts/ 同目录)。

  if ! command -v iptables >/dev/null 2>&1; then
    echo "[ABORT] 缺少 iptables 命令"
    exit 1
  fi

  # 1) 创建/重置链
  if iptables -L "$V3_HOST_GUARD_CHAIN" -n >/dev/null 2>&1; then
    iptables -F "$V3_HOST_GUARD_CHAIN"
    echo "[FLUSH] iptables chain $V3_HOST_GUARD_CHAIN"
  else
    iptables -N "$V3_HOST_GUARD_CHAIN"
    echo "[CREATE] iptables chain $V3_HOST_GUARD_CHAIN"
  fi

  # 2) 链内规则:允许 internal proxy / 拒绝其他
  iptables -A "$V3_HOST_GUARD_CHAIN" \
    -d "$GATEWAY" -p tcp --dport "$INTERNAL_PROXY_PORT" -j RETURN \
    -m comment --comment "v3 container -> internal proxy"
  # ICMP echo 留着,容器内 ping 网关用作 readiness 检测可以;ICMP 不会泄露敏感
  iptables -A "$V3_HOST_GUARD_CHAIN" \
    -d "$GATEWAY" -p icmp --icmp-type echo-request -j RETURN \
    -m comment --comment "v3 container -> gateway icmp (readiness)"
  iptables -A "$V3_HOST_GUARD_CHAIN" \
    -d "$GATEWAY" -j DROP \
    -m comment --comment "v3 container -> any other host port: deny"
  # 注意:不在链内匹配 src=172.30.0.0/16,src 已在 INPUT jump 时过滤
  echo "[ADDED] $V3_HOST_GUARD_CHAIN allow $GATEWAY:$INTERNAL_PROXY_PORT, deny rest"

  # 3) INPUT 入口 jump(真正幂等 — 2026-04-22 R2 B2 修复)
  #
  # 旧代码用 `iptables -C INPUT -s $SUBNET -j $V3_HOST_GUARD_CHAIN` 检查是否存在,
  # 然后插入时带 `-m comment --comment "..."`。iptables -C 要求**全部 match**精确
  # 相同(包括 comment match):不带 comment 的 -C 永远匹配不到带 comment 的现有
  # 规则 → 每次重跑加一条新的。ExecStartPost on docker.service 把本脚本变成
  # "每次 docker restart 都跑一次",就会累积重复 jump(实测 3 次重启后 INPUT
  # 上有 3 条 V3_EGRESS_IN jump,功能无害但脏)。
  #
  # 新做法:先 while-loop 删光所有匹配(带/不带 comment 都试),再插入一条。
  # 天然幂等,终态唯一。
  while iptables -D INPUT -s "$SUBNET" -j "$V3_HOST_GUARD_CHAIN" \
        -m comment --comment "v3 container egress isolation" 2>/dev/null; do :; done
  while iptables -D INPUT -s "$SUBNET" -j "$V3_HOST_GUARD_CHAIN" 2>/dev/null; do :; done
  iptables -I INPUT 1 -s "$SUBNET" -j "$V3_HOST_GUARD_CHAIN" \
    -m comment --comment "v3 container egress isolation"
  echo "[ADDED] INPUT -s $SUBNET -j $V3_HOST_GUARD_CHAIN (at position 1, deduped)"
}

main() {
  require_root
  require_cmd docker
  require_cmd ufw

  echo "=== [1/3] 创建 docker bridge 网络 ${NET_NAME} ==="
  ensure_network

  echo ""
  echo "=== [2/3] 配置 ufw 入向规则 (internal proxy 18791) ==="
  ensure_ufw_rule

  echo ""
  echo "=== [3/3] 配置 iptables 容器→host 横向阻断 (V3_EGRESS_IN 链) ==="
  ensure_v3_host_guard

  echo ""
  echo "=== Done ==="
  echo "网络: ${NET_NAME} (${SUBNET}, gateway ${GATEWAY}, IPv6 disabled, ICC disabled)"
  echo "ufw: 仅 ${SUBNET} 可访问 ${GATEWAY}:${INTERNAL_PROXY_PORT}"
  echo "iptables: 容器只能访问 ${GATEWAY}:${INTERNAL_PROXY_PORT}, 其他 host 端口全部 DROP"
  echo ""
  echo "建议: enable 配套的 systemd unit (boot 后自动应用 iptables 规则)"
  echo "  cp packages/commercial/scripts/openclaude-v3-host-firewall.service /etc/systemd/system/"
  echo "  systemctl enable --now openclaude-v3-host-firewall"
}

main "$@"
