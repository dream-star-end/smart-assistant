#!/bin/bash
# 2J-1: host 侧网络隔离 — idempotent
#
# 作用:
#   1. 创建 docker bridge 网络 openclaude-v3-net (subnet 172.30.0.0/16, gateway 172.30.0.1, IPv6=false)
#   2. 添加 ufw 规则: 仅 172.30.0.0/16 可访问 172.30.0.1:18791 (内部代理 edge listener)
#
# 使用:  sudo bash setup-host-net.sh
#
# 幂等: 重复执行无副作用。docker network 已存在则只校验配置是否吻合;ufw 规则已存在则跳过。

set -e

NET_NAME="openclaude-v3-net"
SUBNET="172.30.0.0/16"
GATEWAY="172.30.0.1"
INTERNAL_PROXY_PORT="18791"

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
    local actual_subnet actual_gw actual_ipv6
    actual_subnet=$(docker network inspect "$NET_NAME" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
    actual_gw=$(docker network inspect "$NET_NAME" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
    actual_ipv6=$(docker network inspect "$NET_NAME" -f '{{.EnableIPv6}}')
    if [ "$actual_subnet" != "$SUBNET" ] || [ "$actual_gw" != "$GATEWAY" ] || [ "$actual_ipv6" != "false" ]; then
      echo "[ABORT] $NET_NAME 已存在但配置不符:"
      echo "  expect: subnet=$SUBNET gateway=$GATEWAY ipv6=false"
      echo "  actual: subnet=$actual_subnet gateway=$actual_gw ipv6=$actual_ipv6"
      echo "  → 需要手动 docker network rm $NET_NAME 后重跑"
      exit 1
    fi
    echo "[OK] $NET_NAME 已存在 (subnet=$SUBNET gateway=$GATEWAY ipv6=false)"
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

main() {
  require_root
  require_cmd docker
  require_cmd ufw

  echo "=== [1/2] 创建 docker bridge 网络 ${NET_NAME} ==="
  ensure_network

  echo ""
  echo "=== [2/2] 配置 ufw 入向规则 ==="
  ensure_ufw_rule

  echo ""
  echo "=== Done ==="
  echo "网络: ${NET_NAME} (${SUBNET}, gateway ${GATEWAY}, IPv6 disabled, ICC disabled)"
  echo "ufw: 仅 ${SUBNET} 可访问 ${GATEWAY}:${INTERNAL_PROXY_PORT}"
}

main "$@"
