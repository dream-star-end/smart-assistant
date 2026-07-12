#!/usr/bin/env bash
# =============================================================================
# selfheal-provision.sh — OpenClaude 个人版自愈体系执行侧 provision(幂等,root)
#
# 依据:selfheal-final-design §C6 + §D 步骤4。
# 原则:每步先检测再动作;重复执行安全;默认只做低风险落盘,
#       高风险面(agents.yaml / systemd unit / apt)默认只打印提示,须显式开关。
#
# 用法:
#   scripts/selfheal-provision.sh [--dry-run] [--apply-agents] [--apply-unit] [--apply-packages]
#
#   --dry-run         只读检测,零写入;所有将执行的动作打印为 [dry-run]。
#   --apply-agents    自动向 /root/.openclaude/agents.yaml 追加 codex-v5ops
#                     (追加前备份;默认只打印片段提示人工确认后追加)。
#   --apply-unit      自动写 openclaude.service drop-in
#                     (/etc/systemd/system/openclaude.service.d/selfheal.conf + daemon-reload;
#                      默认只打印提示)。
#   --apply-packages  自动 apt-get install -y autossh(默认只提示)。
#
# 本脚本不做的事(留给 runbook,见 docs/SELFHEAL-RUNBOOK.md):
#   - 不安装/启动隧道单元(deploy/openclaude-selfheal-tunnel.service 人工 cp+enable)
#   - 不改 kl-mirror 侧任何东西(authorized_keys 限权行只打印)
#   - 不重启 openclaude.service(交给 runbook 的 safe-restart 步骤)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
SECRETS_DIR=/root/.secrets/v5-selfheal
AGENTS_YAML=/root/.openclaude/agents.yaml
ENV_FILE=/etc/openclaude/selfheal.env
TMPFILES_CONF=/etc/tmpfiles.d/openclaude-selfheal.conf
RUN_DIR=/run/openclaude-selfheal
BROKER_SOCK="$RUN_DIR/broker.sock"
OCHEAL_USER=ocheal
OCHEAL_HOME=/home/ocheal
SELFHEAL_HOME_DIR="$OCHEAL_HOME/selfheal"
VERIFY_DIR=/var/lib/openclaude-selfheal/verifications
CLI_SRC_REL="ops/oc-selfheal.mjs"
CLI_DST=/usr/local/bin/oc-selfheal
DROPIN_DIR=/etc/systemd/system/openclaude.service.d
DROPIN_FILE="$DROPIN_DIR/selfheal.conf"
TUNNEL_UNIT_SRC_REL="deploy/openclaude-selfheal-tunnel.service"
TUNNEL_UNIT_DST=/etc/systemd/system/openclaude-selfheal-tunnel.service
CANONICAL_DIR=/opt/openclaude/openclaude-v5-aurora
CALLBACK_URL=http://127.0.0.1:18796
RESTART_UNITS=openclaude-v5.service

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY_RUN=0
APPLY_AGENTS=0
APPLY_UNIT=0
APPLY_PACKAGES=0

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --dry-run)        DRY_RUN=1 ;;
    --apply-agents)   APPLY_AGENTS=1 ;;
    --apply-unit)     APPLY_UNIT=1 ;;
    --apply-packages) APPLY_PACKAGES=1 ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
log()  { printf '[provision] %s\n' "$*"; }
warn() { printf '[provision][WARN] %s\n' "$*" >&2; }
die()  { printf '[provision][FATAL] %s\n' "$*" >&2; exit 1; }

# 执行(或 dry-run 打印)一条外部命令
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would run: %s\n' "$*"
  else
    "$@"
  fi
}

declare -a CHECKLIST=()
ok()   { CHECKLIST+=("OK    $*");  log "OK: $*"; }
todo() { CHECKLIST+=("TODO  $*"); log "TODO: $*"; }

# 读密钥文件(剥尾部换行),不打印值
read_secret() {
  local f="$1" v
  [ -f "$f" ] || die "missing secret file: $f"
  v="$(tr -d '\r\n' <"$f")"
  [ -n "$v" ] || die "empty secret file: $f"
  [ "${#v}" -ge 32 ] || die "secret too short (<32 chars): $f"
  printf '%s' "$v"
}

# 幂等目录:存在则校验 owner/mode,不存在则建
ensure_dir() {
  local dir="$1" owner="$2" group="$3" mode="$4"
  if [ -d "$dir" ]; then
    local cur
    cur="$(stat -c '%U:%G %a' "$dir")"
    if [ "$cur" = "$owner:$group $mode" ]; then
      ok "dir $dir ($owner:$group $mode)"
    else
      log "dir $dir exists with '$cur', fixing to $owner:$group $mode"
      run chown "$owner:$group" "$dir"
      run chmod "$mode" "$dir"
      if [ "$DRY_RUN" -eq 1 ]; then
        todo "dir $dir (would fix '$cur' -> $owner:$group $mode)"
      else
        ok "dir $dir (fixed -> $owner:$group $mode)"
      fi
    fi
  else
    run install -d -m "$mode" -o "$owner" -g "$group" "$dir"
    if [ "$DRY_RUN" -eq 1 ]; then
      todo "dir $dir (would create $owner:$group $mode)"
    else
      ok "dir $dir (created $owner:$group $mode)"
    fi
  fi
}

# ---------------------------------------------------------------------------
# 前置
# ---------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "must run as root"
[ "$DRY_RUN" -eq 1 ] && log "=== DRY-RUN mode: read-only detection, zero writes ==="

# ---------------------------------------------------------------------------
# 1. ocheal 用户/组 + setpriv
# ---------------------------------------------------------------------------
step_user() {
  log "--- step 1: ocheal user + setpriv ---"
  if id -u "$OCHEAL_USER" >/dev/null 2>&1; then
    ok "user $OCHEAL_USER exists (uid=$(id -u "$OCHEAL_USER") gid=$(id -g "$OCHEAL_USER"))"
  else
    run useradd --system --create-home --home-dir "$OCHEAL_HOME" --shell /usr/sbin/nologin "$OCHEAL_USER"
    if [ "$DRY_RUN" -eq 1 ]; then
      todo "user $OCHEAL_USER (would create)"
    else
      ok "user $OCHEAL_USER created"
    fi
  fi
  if command -v setpriv >/dev/null 2>&1; then
    ok "setpriv present ($(command -v setpriv))"
  else
    die "setpriv not found — broker 降权依赖它,请先安装 util-linux"
  fi
}

# ---------------------------------------------------------------------------
# 2. 目录 + tmpfiles.d
# ---------------------------------------------------------------------------
step_dirs() {
  log "--- step 2: directories + tmpfiles.d ---"
  if id -u "$OCHEAL_USER" >/dev/null 2>&1; then
    ensure_dir "$SELFHEAL_HOME_DIR" "$OCHEAL_USER" "$OCHEAL_USER" 750
    ensure_dir "$RUN_DIR" root "$OCHEAL_USER" 750
  else
    # dry-run 且用户尚不存在:只能提示
    todo "dir $SELFHEAL_HOME_DIR (needs user $OCHEAL_USER first)"
    todo "dir $RUN_DIR (needs user $OCHEAL_USER first)"
  fi
  ensure_dir /var/lib/openclaude-selfheal root root 700
  ensure_dir "$VERIFY_DIR" root root 700

  # /run 是 tmpfs,重启即失 —— tmpfiles.d 保证重建
  local want="d $RUN_DIR 0750 root $OCHEAL_USER -"
  if [ -f "$TMPFILES_CONF" ] && [ "$(cat "$TMPFILES_CONF")" = "$want" ]; then
    ok "tmpfiles.d $TMPFILES_CONF"
  else
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] would write %s:\n  %s\n' "$TMPFILES_CONF" "$want"
      todo "tmpfiles.d $TMPFILES_CONF (would write)"
    else
      printf '%s\n' "$want" >"$TMPFILES_CONF"
      chmod 0644 "$TMPFILES_CONF"
      systemd-tmpfiles --create "$TMPFILES_CONF"
      ok "tmpfiles.d $TMPFILES_CONF (written + applied)"
    fi
  fi
}

# ---------------------------------------------------------------------------
# 3. 安装 oc-selfheal CLI
# ---------------------------------------------------------------------------
step_cli() {
  log "--- step 3: oc-selfheal CLI ---"
  local src="$REPO_ROOT/$CLI_SRC_REL"
  if [ ! -f "$src" ]; then
    # 另一 agent 并行在写 ops/oc-selfheal.mjs —— 缺失只警告,不 fail
    warn "$src not found (parallel agent may still be writing it) — skipping CLI install"
    todo "CLI $CLI_DST (source missing, re-run provision after $CLI_SRC_REL lands)"
    return 0
  fi
  if [ -f "$CLI_DST" ] && cmp -s "$src" "$CLI_DST"; then
    ok "CLI $CLI_DST (up to date)"
  else
    run cp "$src" "$CLI_DST"
    run chmod 0755 "$CLI_DST"
    if [ "$DRY_RUN" -eq 1 ]; then
      todo "CLI $CLI_DST (would install/update)"
    else
      ok "CLI $CLI_DST (installed, mode 0755)"
    fi
  fi
}

# ---------------------------------------------------------------------------
# 4. agents.yaml — codex-v5ops 注册
# ---------------------------------------------------------------------------
AGENT_SNIPPET='  - id: codex-v5ops
    model: gpt-5.6-sol
    permissionMode: bypassPermissions
    provider: codex-native
    runnerKind: app-server
    runAsUser: ocheal
    displayName: codex-v5ops'

step_agents() {
  log "--- step 4: agents.yaml (codex-v5ops) ---"
  [ -f "$AGENTS_YAML" ] || die "agents.yaml not found at $AGENTS_YAML"
  if grep -qE '^\s+- id:\s*codex-v5ops\s*$' "$AGENTS_YAML"; then
    ok "agents.yaml already has codex-v5ops"
    return 0
  fi
  log "codex-v5ops NOT registered. Required snippet (insert inside 'agents:' list, BEFORE 'routes:'):"
  printf '%s\n' "$AGENT_SNIPPET"
  if [ "$APPLY_AGENTS" -ne 1 ]; then
    log "agents.yaml 是运行配置,默认不自动改;人工确认片段后重跑加 --apply-agents 自动追加。"
    todo "agents.yaml codex-v5ops (manual confirm, or re-run with --apply-agents)"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would backup %s and insert snippet before top-level "routes:" line\n' "$AGENTS_YAML"
    todo "agents.yaml codex-v5ops (would append)"
    return 0
  fi
  local backup="${AGENTS_YAML}.bak.$(date +%Y%m%d%H%M%S)"
  cp -a "$AGENTS_YAML" "$backup"
  log "backup: $backup"
  local tmp
  tmp="$(mktemp)"
  # agents.yaml 尾部有顶层 routes:/default: 键,必须插在 routes: 之前,不能 append 到 EOF
  awk -v snippet="$AGENT_SNIPPET" '
    !ins && /^routes:/ { print snippet; ins=1 }
    { print }
    END { if (!ins) { print snippet; exit_missing=1 } }
  ' "$AGENTS_YAML" >"$tmp"
  if ! grep -q '^routes:' "$AGENTS_YAML"; then
    warn "no top-level routes: anchor found — snippet appended at EOF, VERIFY YAML MANUALLY"
  fi
  chmod --reference="$AGENTS_YAML" "$tmp"
  mv "$tmp" "$AGENTS_YAML"
  ok "agents.yaml codex-v5ops (appended; backup=$backup)"
}

# ---------------------------------------------------------------------------
# 5. env 注入 /etc/openclaude/selfheal.env + service drop-in 提示
# ---------------------------------------------------------------------------
step_env() {
  log "--- step 5: $ENV_FILE ---"
  local uid gid
  uid="$(id -u "$OCHEAL_USER" 2>/dev/null || echo '<pending-user>')"
  gid="$(id -g "$OCHEAL_USER" 2>/dev/null || echo '<pending-user>')"

  if [ -f "$ENV_FILE" ]; then
    # 幂等:不覆盖既有文件(可能已被人工调过);只校验权限与键齐全
    local mode missing="" key
    mode="$(stat -c '%a' "$ENV_FILE")"
    if [ "$mode" != "600" ]; then
      run chmod 0600 "$ENV_FILE"
      log "fixed $ENV_FILE mode $mode -> 600"
    fi
    for key in OC_SELFHEAL_WEBHOOK_HMAC OC_SELFHEAL_VERIFY_HMAC OC_SELFHEAL_CALLBACK_URL \
               OC_SELFHEAL_BROKER_SOCK OC_SELFHEAL_OCHEAL_UID OC_SELFHEAL_OCHEAL_GID \
               OC_SELFHEAL_OCHEAL_HOME OC_SELFHEAL_CANONICAL_DIR OC_SELFHEAL_RESTART_UNITS \
               OC_SELFHEAL_AUTO_DEPLOY_TIER2 OC_SELFHEAL_WECOM_WEBHOOK; do
      grep -q "^${key}=" "$ENV_FILE" || missing="$missing $key"
    done
    if [ -z "$missing" ]; then
      ok "$ENV_FILE exists, all keys present (left untouched; delete file to regenerate)"
    else
      todo "$ENV_FILE exists but missing keys:$missing (append manually or delete file to regenerate)"
    fi
  else
    # 校验密钥可读(dry-run 同样校验,但不外泄值)
    local webhook_hmac verify_hmac
    webhook_hmac="$(read_secret "$SECRETS_DIR/webhook-hmac")"
    verify_hmac="$(read_secret "$SECRETS_DIR/verification-hmac")"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] would write %s (0600 root:root), HMAC values redacted:\n' "$ENV_FILE"
      sed 's/^/  /' <<EOF
OC_SELFHEAL_WEBHOOK_HMAC=<from $SECRETS_DIR/webhook-hmac>
OC_SELFHEAL_VERIFY_HMAC=<from $SECRETS_DIR/verification-hmac>
OC_SELFHEAL_CALLBACK_URL=$CALLBACK_URL
OC_SELFHEAL_BROKER_SOCK=$BROKER_SOCK
OC_SELFHEAL_OCHEAL_UID=$uid
OC_SELFHEAL_OCHEAL_GID=$gid
OC_SELFHEAL_OCHEAL_HOME=$OCHEAL_HOME
OC_SELFHEAL_CANONICAL_DIR=$CANONICAL_DIR
OC_SELFHEAL_RESTART_UNITS=$RESTART_UNITS
OC_SELFHEAL_AUTO_DEPLOY_TIER2=0
OC_SELFHEAL_WECOM_WEBHOOK=
EOF
      todo "$ENV_FILE (would write)"
    else
      local tmp
      tmp="$(mktemp /etc/openclaude/.selfheal.env.XXXXXX)"
      chmod 0600 "$tmp"
      cat >"$tmp" <<EOF
# Generated by scripts/selfheal-provision.sh on $(date -Is)
# OpenClaude 个人版自愈体系 env(由 openclaude.service EnvironmentFile 加载)。
# 密钥源:$SECRETS_DIR(双机留底,勿删)。

# webhook HMAC(与 kl-mirror commercial-v5.env 的 OC_SELFHEAL_WEBHOOK_HMAC 必须一致)
OC_SELFHEAL_WEBHOOK_HMAC=$webhook_hmac
# verification 签名 HMAC(verifier 落盘签名用)
OC_SELFHEAL_VERIFY_HMAC=$verify_hmac
# 回调出口:本机 18796 → autossh -L → kl-mirror v5 master 18790
OC_SELFHEAL_CALLBACK_URL=$CALLBACK_URL
# broker unix socket(目录 root:ocheal 0750,tmpfiles.d 保证重启重建)
OC_SELFHEAL_BROKER_SOCK=$BROKER_SOCK
OC_SELFHEAL_OCHEAL_UID=$uid
OC_SELFHEAL_OCHEAL_GID=$gid
OC_SELFHEAL_OCHEAL_HOME=$OCHEAL_HOME
OC_SELFHEAL_CANONICAL_DIR=$CANONICAL_DIR
OC_SELFHEAL_RESTART_UNITS=$RESTART_UNITS
# Tier2 自动部署总闸:0=一律 pending_release 走 boss 一键放行(默认;boss 拍板后才可置 1)
OC_SELFHEAL_AUTO_DEPLOY_TIER2=0
# 企微 webhook(pending_release 通知用):留空=不发;填 qyapi.weixin.qq.com robot webhook URL,国内直连禁代理
OC_SELFHEAL_WECOM_WEBHOOK=
EOF
      mv "$tmp" "$ENV_FILE"
      ok "$ENV_FILE (written, 0600 root)"
    fi
  fi

  # --- service drop-in ---
  local dropin_content="[Service]
EnvironmentFile=-$ENV_FILE"
  if [ -f "$DROPIN_FILE" ] && [ "$(cat "$DROPIN_FILE")" = "$dropin_content" ]; then
    ok "openclaude.service drop-in $DROPIN_FILE"
    return 0
  fi
  log "openclaude.service 需要加载 $ENV_FILE。提示:在 unit 加一行(推荐 drop-in,不改主 unit):"
  printf '  # %s\n  [Service]\n  EnvironmentFile=-%s\n' "$DROPIN_FILE" "$ENV_FILE"
  if [ "$APPLY_UNIT" -ne 1 ]; then
    log "默认不自动改 systemd unit;确认后重跑加 --apply-unit 自动写 drop-in + daemon-reload(不重启服务)。"
    todo "openclaude.service EnvironmentFile drop-in (manual, or re-run with --apply-unit)"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would write %s + systemctl daemon-reload\n' "$DROPIN_FILE"
    todo "openclaude.service drop-in (would write)"
    return 0
  fi
  install -d -m 0755 "$DROPIN_DIR"
  printf '%s\n' "$dropin_content" >"$DROPIN_FILE"
  chmod 0644 "$DROPIN_FILE"
  systemctl daemon-reload
  ok "openclaude.service drop-in $DROPIN_FILE (written + daemon-reload; restart left to runbook)"
}

# ---------------------------------------------------------------------------
# 6. autossh
# ---------------------------------------------------------------------------
step_autossh() {
  log "--- step 6: autossh ---"
  if command -v autossh >/dev/null 2>&1; then
    ok "autossh present ($(command -v autossh))"
    return 0
  fi
  if [ "$APPLY_PACKAGES" -ne 1 ]; then
    log "autossh 未安装。执行:apt-get install -y autossh(或重跑加 --apply-packages)"
    todo "autossh (apt-get install -y autossh, or re-run with --apply-packages)"
    return 0
  fi
  run apt-get install -y autossh
  if [ "$DRY_RUN" -eq 1 ]; then
    todo "autossh (would apt-get install)"
  else
    ok "autossh installed"
  fi
}

# ---------------------------------------------------------------------------
# 7. 隧道 key 校验 + kl-mirror authorized_keys 限权行
# ---------------------------------------------------------------------------
step_tunnel_key() {
  log "--- step 7: tunnel key ---"
  local key="$SECRETS_DIR/tunnel_key" pub="$SECRETS_DIR/tunnel_key.pub"
  [ -f "$key" ] || die "tunnel key missing: $key"
  [ -f "$pub" ] || die "tunnel pub key missing: $pub"
  local mode
  mode="$(stat -c '%a' "$key")"
  if [ "$mode" = "600" ]; then
    ok "tunnel key $key (0600)"
  else
    run chmod 0600 "$key"
    ok "tunnel key $key (mode $mode -> 600)"
  fi
  local publine
  publine="$(head -n1 "$pub")"
  log "kl-mirror ~/.ssh/authorized_keys 需追加的限权行(手工执行,见 runbook 步骤4):"
  printf '  restrict,no-pty,no-agent-forwarding,no-X11-forwarding,permitopen="127.0.0.1:18790",permitlisten="127.0.0.1:18795" %s\n' "$publine"
  todo "kl-mirror authorized_keys restricted line (manual, printed above)"

  if [ -f "$TUNNEL_UNIT_DST" ]; then
    ok "tunnel unit installed at $TUNNEL_UNIT_DST"
  else
    todo "tunnel unit: cp $REPO_ROOT/$TUNNEL_UNIT_SRC_REL /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now openclaude-selfheal-tunnel.service (manual, AFTER authorized_keys line installed)"
  fi
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
step_user
step_dirs
step_cli
step_agents
step_env
step_autossh
step_tunnel_key

log ""
log "================= provision checklist ================="
for item in "${CHECKLIST[@]}"; do
  printf '  %s\n' "$item"
done
log "======================================================="
if printf '%s\n' "${CHECKLIST[@]}" | grep -q '^TODO'; then
  log "存在 TODO 项:按上方提示处置后可重跑本脚本复核(幂等)。"
else
  log "全部 OK。下一步见 docs/SELFHEAL-RUNBOOK.md 步骤4(safe-restart + 隧道 + 开闸)。"
fi
