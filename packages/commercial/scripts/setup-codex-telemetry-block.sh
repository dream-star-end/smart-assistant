#!/bin/bash
# ============================================================================
# openclaude v5 —— codex 遥测出网封堵(A 网络面 fail-closed 兜底)
# feat/v5-codex-telemetry-block
# ============================================================================
#
# 背景:codex 0.137 硬编码遥测端点(analytics events、ab.chatgpt.com/otlp statsig
#   metrics、chatgpt.com/backend-api/codex agent-identity、api.github.com update
#   check)会绕容器 loopback relay 直连,并带账号 token → chatgpt 侧同时看到账号
#   代理 IP + 宿主机真实 IP,破坏账号 IP 纯净。C1 配置面(managed_config + 每-spawn
#   `-c`)是主根治;本脚本是**网络面终极兜底**:即便 codex 版本升级新增遥测端点/
#   配置键漂移,只要它对这些 host 发直连 443,就被 REJECT。
#
# 作用面:**仅 v5 桥网段 172.31.0.0/16**。绝不碰 v3(172.30.0.0/16)链/规则/网段。
#   规则挂 DOCKER-USER(docker 认可的 FORWARD 用户链,docker restart 不清),按
#   **网段**匹配源(不写死桥名 —— 桥名 br-<hash> 运行时会变)。
#
# 机制:ipset(hash:ip)存被封域名解析出的 IP,DOCKER-USER 一条规则按 dst 匹配 set;
#   定时 refresh 走 **atomic swap**(nit3):解析新 IP 到临时 set → swap(名字不变、
#   内容整体替换、零窗口);DNS 全失败 → **绝不 swap 成空**,保留旧 set 继续封堵。
#   REJECT --reject-with tcp-reset(非 DROP):容器 connect 立即拿 RST 失败,不挂 5s
#   拖 turn 尾延迟。仅限 tcp dport 443,最小爆炸半径。
#
# IPv6(nit6):本脚本仅 v4。实测 openclaude-v5-net EnableIPv6=false + host 无 global
#   inet6 → v4-only 前提成立;install 时 assert_ipv6_disabled 硬断言,若将来 v5 桥
#   启用 IPv6 直接 ABORT(必须先补 ip6tables + hash:ip family inet6 才能用)。
#
# 用法:
#   sudo bash setup-codex-telemetry-block.sh              # install(建 ipset+规则+首刷)
#   sudo bash setup-codex-telemetry-block.sh refresh      # 仅刷新 ipset(timer 调用)
#   sudo bash setup-codex-telemetry-block.sh --uninstall  # 干净移除(删规则+销毁 ipset)
#   bash setup-codex-telemetry-block.sh --dry-run install # 打印将执行的命令,不改系统
#
# 幂等:重复 install 不叠规则(先 dedup 删光再插一条,setup-host-net.sh 同款);
#   refresh 不碰 iptables(规则按名引用 set)。
#
# 依赖:ipset、iptables、docker。locale 强制 C(输出英文,grep 不漂)。
# ----------------------------------------------------------------------------

export LANG=C
export LC_ALL=C

# ── 常量 ───────────────────────────────────────────────────────────────────
NET_NAME="openclaude-v5-net"
SUBNET="172.31.0.0/16"
SET_NAME="oc-v5-codex-tele-block"       # ≤31 字符(ipset 名长限制)
SET_TMP="${SET_NAME}-tmp"               # atomic swap 临时 set(26 字符)
DPORT=443
RULE_COMMENT="oc-v5 codex telemetry egress block"
SET_MAXELEM=4096

# 待封堵域名。CORE 恒封。
#   - chatgpt.com        : backend-api analytics-events / agent-identity 直连
#   - ab.chatgpt.com     : OTLP/statsig metrics(ab.chatgpt.com/otlp/v1/metrics)
#   - auth.openai.com    : 容器内 codex 不需要(v5 token refresh 走 master reverse-RPC),
#                          封它挡 codex 自发的 auth 直连;master 侧 refresh 源 IP 不在
#                          172.31.0.0/16,规则匹配不到 → 零误伤
DOMAINS_CORE=(chatgpt.com ab.chatgpt.com auth.openai.com)

# api.openai.com:v5 数据面走 loopback relay,容器内 codex **不直连**它,封它是保守
#   兜底但误伤面大(评审提示)。**单独一组便于快速移除**:清空下面数组(或注释此行)
#   后重跑 install/refresh,它即从 ipset 消失,规则本身不变。
DOMAINS_OPTIONAL=(api.openai.com)

# ── 运行态 ─────────────────────────────────────────────────────────────────
DRY_RUN=0
MODE=""

# ── 命令包装(支持 --dry-run:只打印不执行)─────────────────────────────────
run() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; return 0; fi
  "$@"
}
# 删除类命令:dry-run 打印一次并返回非零(终止 dedup while 循环);真实执行返回
# iptables -D 的退出码(删成功=0 继续删,无匹配=非零 停止)。
run_del() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; return 1; fi
  "$@" 2>/dev/null
}

require_root() {
  if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
  if [ "$(id -u)" -ne 0 ]; then
    echo "[ABORT] 必须以 root 运行(需要 ipset + iptables 权限)"
    exit 1
  fi
}

require_cmd() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] (require cmds: $*)"; return 0; fi
  local c
  for c in "$@"; do
    if ! command -v "$c" >/dev/null 2>&1; then
      echo "[ABORT] 缺少命令: $c(安装: apt-get install -y $c)"
      exit 1
    fi
  done
}

# nit6:v4-only 前提断言。
assert_ipv6_disabled() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] (assert $NET_NAME EnableIPv6=false)"; return 0; fi
  local v6
  v6=$(docker network inspect "$NET_NAME" -f '{{.EnableIPv6}}' 2>/dev/null || echo "unknown")
  if [ "$v6" = "unknown" ]; then
    echo "[ABORT] 查不到 $NET_NAME(docker 未起 / 网络未建?)先建 v5 网络再跑。"
    exit 1
  fi
  if [ "$v6" = "true" ]; then
    echo "[ABORT] $NET_NAME EnableIPv6=true,但本脚本仅 v4(ip_set family inet + iptables)。"
    echo "        必须先补 ip6tables + hash:ip family inet6 同步 set,才能启用 IPv6 封堵。"
    exit 1
  fi
  echo "[OK] $NET_NAME EnableIPv6=$v6(v4-only 封堵前提成立)"
}

ensure_docker_user_chain() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] (verify DOCKER-USER chain exists)"; return 0; fi
  if ! iptables -L DOCKER-USER -n >/dev/null 2>&1; then
    echo "[ABORT] DOCKER-USER 链不存在 —— docker daemon 未启动或版本过旧。先起 docker 再跑。"
    exit 1
  fi
}

# 解析域名的 IPv4(getent 走系统 resolver;去重)。
resolve_ipv4() {
  local domain="$1"
  getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u
}

# ── ipset atomic swap 刷新(nit3)────────────────────────────────────────────
refresh_set() {
  run ipset create "$SET_TMP" hash:ip family inet maxelem "$SET_MAXELEM" -exist
  run ipset flush "$SET_TMP"

  local total=0 d ip ips
  for d in "${DOMAINS_CORE[@]}" "${DOMAINS_OPTIONAL[@]}"; do
    [ -z "$d" ] && continue
    ips=$(resolve_ipv4 "$d")
    if [ -z "$ips" ]; then
      echo "[WARN] DNS 解析空: $d(本轮跳过,不影响旧 set 中既有 IP)"
      continue
    fi
    for ip in $ips; do
      run ipset add "$SET_TMP" "$ip" -exist
      total=$((total + 1))
      echo "[RESOLVE] $d -> $ip"
    done
  done

  # nit3 fail-closed:所有域名 DNS 都失败 → tmp 全空 → **绝不 swap 成空**。
  # 保留旧 set 原样(继续封堵),销毁 tmp,返回非零让 caller 知晓刷新失败。
  if [ "$total" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    echo "[ABORT-REFRESH] 所有域名 DNS 解析失败 —— 保留现有 ipset 不清空(fail-closed)"
    ipset destroy "$SET_TMP" 2>/dev/null || true
    return 1
  fi

  # 确保目标 set 存在(首次 install),再 atomic swap:名字不变、内容整体替换,
  # DOCKER-USER 规则按名引用,swap 期间零窗口。
  run ipset create "$SET_NAME" hash:ip family inet maxelem "$SET_MAXELEM" -exist
  run ipset swap "$SET_TMP" "$SET_NAME"
  run ipset destroy "$SET_TMP"
  echo "[OK] ipset $SET_NAME 已刷新: $total 条 IP(atomic swap)"
}

# ── DOCKER-USER 规则(幂等)──────────────────────────────────────────────────
# 规则:-s 172.31.0.0/16 -p tcp --dport 443 -m set --match-set <set> dst
#       -j REJECT --reject-with tcp-reset
RULE_MATCH=(-s "$SUBNET" -p tcp --dport "$DPORT" -m set --match-set "$SET_NAME" dst)
RULE_TARGET=(-j REJECT --reject-with tcp-reset)
RULE_CMT=(-m comment --comment "$RULE_COMMENT")

delete_all_rule_copies() {
  # 带 comment / 不带 comment 都删干净(iptables -D 需全 match 精确;comment 是 match)
  while run_del iptables -D DOCKER-USER "${RULE_MATCH[@]}" "${RULE_TARGET[@]}" "${RULE_CMT[@]}"; do :; done
  while run_del iptables -D DOCKER-USER "${RULE_MATCH[@]}" "${RULE_TARGET[@]}"; do :; done
}

ensure_rule() {
  ensure_docker_user_chain
  delete_all_rule_copies
  run iptables -I DOCKER-USER 1 "${RULE_MATCH[@]}" "${RULE_TARGET[@]}" "${RULE_CMT[@]}"
  echo "[OK] DOCKER-USER REJECT 规则就位: -s $SUBNET dport $DPORT match-set $SET_NAME dst (position 1, deduped)"
}

# ── uninstall(干净回滚)─────────────────────────────────────────────────────
do_uninstall() {
  echo "=== 移除 DOCKER-USER 规则 ==="
  delete_all_rule_copies
  echo "[OK] 规则已删(如有)"
  echo "=== 销毁 ipset(须在删规则之后,否则 set in use)==="
  run ipset destroy "$SET_NAME" 2>/dev/null || echo "[OK] ipset $SET_NAME 不存在/已移除"
  run ipset destroy "$SET_TMP" 2>/dev/null || true
  echo "=== Done(v5 codex 遥测封堵已回滚;v3 未受任何影响)==="
}

# ── main ────────────────────────────────────────────────────────────────────
# 参数:--dry-run(任意位置);模式 install(默认)/ refresh / --uninstall|uninstall
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall|uninstall) MODE="uninstall" ;;
    refresh) MODE="refresh" ;;
    install) MODE="install" ;;
    *) echo "[ABORT] 未知参数: $arg"; exit 1 ;;
  esac
done
[ -z "$MODE" ] && MODE="install"

echo "[MODE] $MODE  (dry_run=$DRY_RUN)  set=$SET_NAME  subnet=$SUBNET"

case "$MODE" in
  install)
    require_root
    require_cmd ipset iptables docker
    assert_ipv6_disabled
    echo "=== [1/2] 刷新 ipset(解析待封域名 → atomic swap)==="
    refresh_set
    echo ""
    echo "=== [2/2] 挂 DOCKER-USER REJECT 规则(仅 $SUBNET)==="
    ensure_rule
    echo ""
    echo "=== Done ==="
    echo "封堵: 172.31.0.0/16 容器 → {${DOMAINS_CORE[*]} ${DOMAINS_OPTIONAL[*]}}:443 → REJECT(tcp-reset)"
    echo "计数: iptables -L DOCKER-USER -v -n | grep '$RULE_COMMENT'"
    echo "内容: ipset list $SET_NAME"
    echo "刷新: 建议 enable openclaude-v5-codex-telemetry-block-refresh.timer(定时 atomic swap)"
    echo "回滚: sudo bash $0 --uninstall"
    ;;
  refresh)
    require_root
    require_cmd ipset
    refresh_set
    ;;
  uninstall)
    require_root
    require_cmd ipset iptables
    do_uninstall
    ;;
esac
