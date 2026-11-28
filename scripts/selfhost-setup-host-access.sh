#!/usr/bin/env bash
# 打通「管理员容器 → 宿主机」的 SSH 通道(自用实例专属能力),并安装权威 SSH 并发/内存/cgroup 闸门。
#
# 安全模型(2026-08-13 定稿,2026-11-28 升级 OCV5-931 Layer 2 闸门):
#   - 网络层:iptables 只放行 172.31.0.0/16 → 172.31.0.1:22,由
#     openclaude-v5-selfhost-sshgate.service 维护。容器 IP 由 pickIp 随机分配,
#     容器重建就会变,所以不能按单个 IP 放行。
#   - 身份层:私钥只投放到指定 uid 的 data volume。别的用户容器能连到 22 端口,
#     但没有私钥 → publickey 拒绝。
#   - sshd:对 172.31.0.0/16 强制 publickey-only,关掉密码与键盘交互,
#     防止容器内对宿主爆破口令。
#   - 闸门层:在 authorized_keys 中对容器专用公钥绑定
#     command="/usr/local/bin/oc-host-cmd-gate",由宿主机统一做轻/重任务分类、
#     重任务有界并发槽位、MemAvailable 水位准入与 oc-host-cmd.slice cgroup 隔离。
#
# 幂等:重复执行只补齐缺失部分,已存在的密钥不会重新生成,人工公钥逐字节原样保留。
#
# 用法:
#   selfhost-setup-host-access.sh --uid <admin_uid> [--dry-run|--apply]
#   selfhost-setup-host-access.sh --gate-only [--uid <admin_uid>] [--dry-run|--apply]
#   不带 --apply 默认 dry-run,只打印将要做的改动。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

UID_ARG=""
APPLY=0
GATE_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uid) UID_ARG="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --gate-only) GATE_ONLY=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [[ $GATE_ONLY -eq 0 ]]; then
  [[ "$UID_ARG" =~ ^[0-9]+$ ]] || { echo "用法: $0 --uid <admin_uid> [--dry-run|--apply] | --gate-only [--dry-run|--apply]" >&2; exit 2; }
elif [[ -n "$UID_ARG" ]]; then
  [[ "$UID_ARG" =~ ^[0-9]+$ ]] || { echo "用法: --uid 必须为数字" >&2; exit 2; }
fi

KEY="${OC_SETUP_KEY:-/root/.ssh/oc-v5-selfhost-container}"
KEY_TAG="oc-v5-selfhost admin container -> host"
AUTH="${OC_SETUP_AUTH:-/root/.ssh/authorized_keys}"
SSHD="${OC_SETUP_SSHD:-/etc/ssh/sshd_config}"
GATE_SRC="${OC_SETUP_GATE_SRC:-${SCRIPT_DIR}/host/oc-host-cmd-gate.sh}"
GATE_DST="${OC_SETUP_GATE_DST:-/usr/local/bin/oc-host-cmd-gate}"
GATE_CMD="${OC_SETUP_GATE_CMD:-/usr/local/bin/oc-host-cmd-gate}"
WRAPPER_DST_OVERRIDE="${OC_SETUP_WRAPPER_DST:-}"
SUBNET=172.31.0.0/16

say() { printf '%s\n' "$*"; }
todo() { printf '  [将执行] %s\n' "$*"; }
done_() { printf '  ✓ %s\n' "$*"; }
skip() { printf '  - %s(已就绪)\n' "$*"; }

# ─── 辅助函数:原子安装 oc-host-cmd-gate ───────────────────────────────────────
install_host_cmd_gate() {
  say "=== 安装 oc-host-cmd-gate ==="
  [[ -f "$GATE_SRC" ]] || { echo "✗ 找不到 gate 源文件: $GATE_SRC" >&2; exit 1; }
  if [[ -f "$GATE_DST" && -x "$GATE_DST" ]] && cmp -s "$GATE_SRC" "$GATE_DST"; then
    skip "$GATE_DST"
    return 0
  fi
  if [[ $APPLY == 1 ]]; then
    local dst_dir tmp_dst
    dst_dir="$(dirname "$GATE_DST")"
    install -d -m 0755 "$dst_dir"
    tmp_dst="${dst_dir}/.oc-host-cmd-gate.tmp.$$"
    install -m 0755 "$GATE_SRC" "$tmp_dst"
    mv -Tf "$tmp_dst" "$GATE_DST"
    done_ "已原子安装 $GATE_DST"
  else
    todo "原子安装 $GATE_SRC -> $GATE_DST (0755)"
  fi
}

# ─── 辅助函数:安全精确更新 authorized_keys ────────────────────────────────────
# 按 OpenSSH authorized_keys 语法解析可选 options 字段后的 (key_type, key_blob),
# 使用纯字面相等比较(避免 base64 中 '+'/'/' 被正则误解析),
# 仅匹配 $KEY.pub 的精确公钥行并确保绑定 command="$GATE_CMD"(含非首位 command="..."
# 原地替换防重复),并发写入由 ${AUTH}.lock flock 互斥保护;
# 逐字节原样保留其它所有人工/外部公钥与注释/空行。
_AUTH_MATCH_OPTS=""
_AUTH_MATCH_REST=""

_auth_line_matches_key() {
  local line="$1" want_type="$2" want_blob="$3"
  _AUTH_MATCH_OPTS=""
  _AUTH_MATCH_REST=""
  local len=${#line} i=0 in_q=0 ch
  local tok1="" tok2="" tok3="" tok_idx=0 cur="" has_cur=0
  local tok1_start=0 tok2_start=0 cur_start=0

  while (( i < len )); do
    ch="${line:i:1}"
    if (( in_q )); then
      cur+="$ch"
      if [[ "$ch" == '"' ]]; then
        in_q=0
      elif [[ "$ch" == '\' && $(( i + 1 )) -lt len ]]; then
        (( i += 1 ))
        cur+="${line:i:1}"
      fi
    else
      case "$ch" in
        '"')
          (( ! has_cur )) && cur_start=$i
          in_q=1
          cur+="$ch"
          has_cur=1
          ;;
        ' '|$'\t')
          if (( has_cur )); then
            tok_idx=$(( tok_idx + 1 ))
            case "$tok_idx" in
              1) tok1="$cur"; tok1_start=$cur_start ;;
              2) tok2="$cur"; tok2_start=$cur_start ;;
              3) tok3="$cur"; break ;;
            esac
            cur=""
            has_cur=0
          fi
          ;;
        *)
          (( ! has_cur )) && cur_start=$i
          cur+="$ch"
          has_cur=1
          ;;
      esac
    fi
    (( i += 1 ))
  done
  if (( has_cur && tok_idx < 3 )); then
    tok_idx=$(( tok_idx + 1 ))
    case "$tok_idx" in
      1) tok1="$cur"; tok1_start=$cur_start ;;
      2) tok2="$cur"; tok2_start=$cur_start ;;
      3) tok3="$cur" ;;
    esac
  fi

  if [[ "$tok1" == "$want_type" && "$tok2" == "$want_blob" ]]; then
    _AUTH_MATCH_OPTS=""
    _AUTH_MATCH_REST="${line:tok1_start}"
    return 0
  fi
  if [[ "$tok2" == "$want_type" && "$tok3" == "$want_blob" ]]; then
    _AUTH_MATCH_OPTS="$tok1"
    _AUTH_MATCH_REST="${line:tok2_start}"
    return 0
  fi
  return 1
}

# Rewrite options string on a matched authorized_keys line so that command="..."
# is set to $cmd_opt (replacing any existing leading or non-leading command="...",
# without ever duplicating command=). Sets _REWRITTEN_LINE and _LINE_CHANGED (0|1).
_REWRITTEN_LINE=""
_LINE_CHANGED=0

_rewrite_matched_auth_line() {
  local orig_line="$1" opts="$2" rest="$3" cmd_opt="$4"
  _REWRITTEN_LINE="$orig_line"
  _LINE_CHANGED=0

  if [[ -z "$opts" ]]; then
    _REWRITTEN_LINE="${cmd_opt} ${rest}"
    _LINE_CHANGED=1
    return 0
  fi

  # Split opts by unquoted commas
  local parts=() cur="" in_q=0 i=0 len=${#opts} ch
  while (( i < len )); do
    ch="${opts:i:1}"
    if (( in_q )); then
      cur+="$ch"
      if [[ "$ch" == '"' ]]; then
        in_q=0
      elif [[ "$ch" == '\' && $(( i + 1 )) -lt len ]]; then
        (( i += 1 ))
        cur+="${opts:i:1}"
      fi
    else
      if [[ "$ch" == '"' ]]; then
        in_q=1
        cur+="$ch"
      elif [[ "$ch" == ',' ]]; then
        parts+=("$cur")
        cur=""
      else
        cur+="$ch"
      fi
    fi
    (( i += 1 ))
  done
  parts+=("$cur")

  local new_parts=() saw_cmd=0 changed=0 p
  for p in "${parts[@]}"; do
    if [[ "$p" == command=* ]]; then
      if (( ! saw_cmd )); then
        saw_cmd=1
        if [[ "$p" == "$cmd_opt" ]]; then
          new_parts+=("$p")
        else
          new_parts+=("$cmd_opt")
          changed=1
        fi
      else
        # Drop duplicate command= options
        changed=1
      fi
    else
      new_parts+=("$p")
    fi
  done

  if (( ! saw_cmd )); then
    new_parts=("$cmd_opt" "${new_parts[@]}")
    changed=1
  fi

  if (( ! changed )); then
    return 0
  fi

  local joined=""
  for p in "${new_parts[@]}"; do
    if [[ -z "$joined" ]]; then
      joined="$p"
    else
      joined="${joined},${p}"
    fi
  done
  _REWRITTEN_LINE="${joined} ${rest}"
  _LINE_CHANGED=1
}

update_authorized_keys_with_gate() {
  say "=== authorized_keys (绑定 $GATE_CMD) ==="
  if [[ ! -f "${KEY}.pub" ]]; then
    if [[ $APPLY == 1 ]]; then
      echo "✗ 找不到公钥文件: ${KEY}.pub" >&2
      exit 1
    else
      todo "待生成 ${KEY}.pub 后,在 $AUTH 中绑定 command=\"${GATE_CMD}\""
      return 0
    fi
  fi

  local pub_line="" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    pub_line="$line"
    break
  done < "${KEY}.pub"

  local key_type key_blob _rest
  read -r key_type key_blob _rest <<< "$pub_line"
  if [[ -z "$key_type" || -z "$key_blob" ]]; then
    echo "✗ 无法从 ${KEY}.pub 解析 key_type 与 key_blob" >&2
    exit 1
  fi

  local cmd_opt="command=\"${GATE_CMD}\""
  local found=0 needs_update=0
  local tmp_out="" lock_fd_open=0 orig_umask
  local auth_existed_before=0 auth_hash_before=""
  orig_umask="$(umask)"

  _cleanup_auth_update() {
    rm -f "${tmp_out:-}"
    if (( lock_fd_open )); then
      exec 7>&-
      lock_fd_open=0
    fi
    umask "$orig_umask"
  }
  trap '_cleanup_auth_update' RETURN

  if [[ $APPLY == 1 ]]; then
    umask 077
    install -d -m 700 "$(dirname "$AUTH")"
    exec 7>>"${AUTH}.lock"
    lock_fd_open=1
    flock -x 7
  fi

  if [[ -f "$AUTH" ]]; then
    auth_existed_before=1
    auth_hash_before="$(sha256sum "$AUTH" | awk '{print $1}')"
    if [[ $APPLY == 1 ]]; then
      tmp_out="$(mktemp "${AUTH}.tmp.XXXXXX")"
    else
      tmp_out="$(mktemp)"
    fi

    while IFS= read -r line || [[ -n "$line" ]]; do
      # 空行与注释原样保留
      if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
        printf '%s\n' "$line" >> "$tmp_out"
        continue
      fi

      # 精确字面匹配 (key_type, key_blob),正确处理含 '+'/'/'/'=' 的 base64 公钥
      if _auth_line_matches_key "$line" "$key_type" "$key_blob"; then
        found=1
        _rewrite_matched_auth_line "$line" "$_AUTH_MATCH_OPTS" "$_AUTH_MATCH_REST" "$cmd_opt"
        if (( _LINE_CHANGED )); then
          needs_update=1
        fi
        printf '%s\n' "$_REWRITTEN_LINE" >> "$tmp_out"
      else
        printf '%s\n' "$line" >> "$tmp_out"
      fi
    done < "$AUTH"
  fi

  if [[ $found -eq 1 && $needs_update -eq 0 ]]; then
    _cleanup_auth_update
    trap - RETURN
    skip "authorized_keys 已绑定 ${cmd_opt}"
    return 0
  fi

  if [[ $APPLY != 1 ]]; then
    _cleanup_auth_update
    trap - RETURN
    if [[ $found -eq 1 ]]; then
      todo "备份 $AUTH 并为匹配公钥添加 ${cmd_opt} 前缀(其它公钥原样保留)"
    else
      todo "向 $AUTH 追加 ${cmd_opt} <${KEY}.pub>"
    fi
    return 0
  fi

  # 写前二次校验 $AUTH 哈希,防止锁外人工并发编辑被 mv -Tf 覆盖
  if (( auth_existed_before )); then
    local auth_hash_now=""
    if [[ -f "$AUTH" ]]; then
      auth_hash_now="$(sha256sum "$AUTH" | awk '{print $1}')"
    fi
    if [[ "$auth_hash_now" != "$auth_hash_before" ]]; then
      _cleanup_auth_update
      trap - RETURN
      echo "✗ 检测到 $AUTH 在读取后被锁外并发修改,已安全中止以避免覆盖人工编辑" >&2
      exit 1
    fi
  elif [[ -e "$AUTH" ]]; then
    _cleanup_auth_update
    trap - RETURN
    echo "✗ 检测到 $AUTH 在读取后被锁外并发创建,已安全中止" >&2
    exit 1
  fi

  if [[ $found -eq 1 ]]; then
    local bak="${AUTH}.bak.$(date +%Y%m%d%H%M%S)"
    cp -a "$AUTH" "$bak"
    chmod 600 "$tmp_out"
    mv -Tf "$tmp_out" "$AUTH"
    tmp_out=""
    _cleanup_auth_update
    trap - RETURN
    done_ "已为 $AUTH 中的容器公钥绑定 ${cmd_opt}(备份 $bak,其它公钥原样保留)"
  else
    if [[ -z "$tmp_out" ]]; then
      tmp_out="$(mktemp "${AUTH}.tmp.XXXXXX")"
    fi
    printf '%s %s\n' "$cmd_opt" "$pub_line" >> "$tmp_out"
    chmod 600 "$tmp_out"
    mv -Tf "$tmp_out" "$AUTH"
    tmp_out=""
    _cleanup_auth_update
    trap - RETURN
    done_ "已向 $AUTH 追加绑定 ${cmd_opt} 的容器公钥"
  fi
}

# ─── 辅助函数:生成 2026-11-17+ 同步版 host wrapper(含 OC_HOST_CLASS 透传 + 脱敏日志) ─
render_host_wrapper() {
  cat <<'EOF'
#!/bin/sh
# 到宿主机的固定通道。无参数=交互 shell,带参数=远程执行。
# Cursor / Antigravity 会为每个回合换成临时 HOME；宿主凭据始终在持久 home。
# 默认在宿主机为本次调用建独立进程组(setsid -w)，当容器侧 ssh 因超时/取消断开时，
# 宿主机看门狗 1s 内自动 TERM→KILL 回收整个远端进程组，防孤儿 tsc/测试进程堆积抢核。
# 若确需投递常驻后台守护任务，显式传 OC_HOST_DETACH=1。
# 若需显式指定闸门分类，传 OC_HOST_CLASS=heavy 或 OC_HOST_CLASS=light。
PERSISTENT_HOME=/home/agent
KEY="$PERSISTENT_HOME/.openclaude/.ssh/id_ed25519"
SSH_BIN="${OC_HOST_SSH_BIN:-/usr/bin/ssh}"
CALLER_SESSION="${OC_SESSION_ID:-${OC_SESSION_KEY:-}}"
if [ -z "$CALLER_SESSION" ]; then
  case "$PWD" in
    */sessions/*)
      CALLER_SESSION=$(printf '%s' "$PWD" | sed -n 's|.*/sessions/\([^/]*\).*|\1|p')
      ;;
  esac
fi
CALLER_SESSION=$(printf '%s' "${CALLER_SESSION:-unknown}" | tr -cd 'A-Za-z0-9_.:-')
CALLER_AGENT=$(printf '%s' "${OC_AGENT_ID:-main}" | tr -cd 'A-Za-z0-9_.:-')
CALLER_TURN=$(printf '%s' "${OC_TURN_KEY:-none}" | tr -cd 'A-Za-z0-9_.:-')
CALLER_PWD=$(printf '%s' "${PWD:-unknown}" | tr -cd 'A-Za-z0-9_./:-')
DETACH_FLAG=$(printf '%s' "${OC_HOST_DETACH:-0}" | tr -cd '0-9')
HOST_CLASS=$(printf '%s' "${OC_HOST_CLASS:-}" | tr -cd 'A-Za-z0-9_-')

if [ "$#" -gt 0 ]; then
  REMOTE_CMD="$*"
  CMD_BYTES=$(printf '%s' "$REMOTE_CMD" | wc -c | tr -cd '0-9')
  CMD_HEAD="cmd"
  set -f
  for _oc_tok in $REMOTE_CMD; do
    case "$_oc_tok" in
      export|env|exec|nohup|command|time|'!'|sudo) continue ;;
      *=*) continue ;;
      -*) continue ;;
      *)
        _oc_tok="${_oc_tok##*/}"
        _oc_tok=$(printf '%s' "$_oc_tok" | tr -cd 'A-Za-z0-9._:-' | cut -c1-48)
        if [ -n "$_oc_tok" ]; then
          CMD_HEAD="$_oc_tok"
          break
        fi
        ;;
    esac
  done
  set +f
  B64_CMD=$(printf '%s' "$REMOTE_CMD" | base64 | tr -d '\n\r ')
  REMOTE_WRAP="export OC_CALLER_SESSION='${CALLER_SESSION}' OC_CALLER_AGENT='${CALLER_AGENT}' OC_CALLER_TURN='${CALLER_TURN}' OC_HOST_DETACH='${DETACH_FLAG}' OC_HOST_CLASS='${HOST_CLASS}'; \
logger -t oc-host-cmd -- 'session=${CALLER_SESSION} agent=${CALLER_AGENT} turn=${CALLER_TURN} pwd=${CALLER_PWD} cmd_head=${CMD_HEAD} bytes=${CMD_BYTES}' </dev/null 2>/dev/null || true; \
export _OC_SSHD_PID=\$PPID _OC_B64_CMD='${B64_CMD}'; \
exec setsid -w /bin/bash -c '
  _oc_pgid=\$\$
  _oc_sshd=\"\$_OC_SSHD_PID\"
  _oc_done=/run/oc-host-done.\$\$
  if [ \"\${OC_HOST_DETACH:-0}\" != \"1\" ] && [ -n \"\$_oc_sshd\" ]; then
    (
      while kill -0 \"\$_oc_sshd\" 2>/dev/null && kill -0 \"\$_oc_pgid\" 2>/dev/null; do
        sleep 1
      done
      if [ ! -e \"\$_oc_done\" ] && ! kill -0 \"\$_oc_sshd\" 2>/dev/null; then
        kill -TERM -\"\$_oc_pgid\" 2>/dev/null || true
        sleep 1
        kill -KILL -\"\$_oc_pgid\" 2>/dev/null || true
      fi
    ) </dev/null >/dev/null 2>&1 &
    _oc_wd=\$!
  fi
  _oc_cmd=\$(printf \"%s\" \"\$_OC_B64_CMD\" | base64 -d)
  unset _OC_B64_CMD _OC_SSHD_PID
  /bin/bash -c \"\$_oc_cmd\"
  _oc_rc=\$?
  : > \"\$_oc_done\" 2>/dev/null || true
  if [ -n \"\${_oc_wd:-}\" ]; then
    kill \"\$_oc_wd\" 2>/dev/null || true
  fi
  rm -f \"\$_oc_done\" 2>/dev/null || true
  exit \"\$_oc_rc\"
'"
  exec "$SSH_BIN" -i "$KEY" \
    -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$PERSISTENT_HOME/.openclaude/.ssh/known_hosts" \
    -o ConnectTimeout=10 \
    root@172.31.0.1 "$REMOTE_WRAP"
fi

exec "$SSH_BIN" -i "$KEY" \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$PERSISTENT_HOME/.openclaude/.ssh/known_hosts" \
  -o ConnectTimeout=10 \
  root@172.31.0.1
EOF
}

install_host_wrapper() {
  local wrapper="$1"
  local wrapper_body
  wrapper_body="$(render_host_wrapper)"
  # Preserve trailing newline
  wrapper_body="${wrapper_body}"$'\n'
  if [[ -f "$wrapper" && -x "$wrapper" ]] && printf '%s' "$wrapper_body" | cmp -s - "$wrapper"; then
    skip "$wrapper"
  elif [[ $APPLY == 1 ]]; then
    local wdir
    wdir="$(dirname "$wrapper")"
    if [[ "$(id -u)" -eq 0 ]]; then
      install -d -m 755 -o 1000 -g 1000 "$wdir"
      printf '%s' "$wrapper_body" > "${wrapper}.tmp.$$"
      chmod 755 "${wrapper}.tmp.$$" && chown 1000:1000 "${wrapper}.tmp.$$"
      mv -Tf "${wrapper}.tmp.$$" "$wrapper"
    else
      install -d -m 755 "$wdir"
      printf '%s' "$wrapper_body" > "${wrapper}.tmp.$$"
      chmod 755 "${wrapper}.tmp.$$"
      mv -Tf "${wrapper}.tmp.$$" "$wrapper"
    fi
    done_ "已写入 $wrapper"
  else
    todo "写入 $wrapper"
  fi
}

# ─── --gate-only 快速路径 ─────────────────────────────────────────────────────
if [[ $GATE_ONLY -eq 1 ]]; then
  say "模式: gate-only / $([[ $APPLY == 1 ]] && echo apply || echo dry-run)"
  say "gate src = $GATE_SRC"
  say "gate dst = $GATE_DST"
  say "auth     = $AUTH"
  say ""

  # 先装 gate 可执行文件,再在 authorized_keys 中绑定 command=,避免空指针窗口
  install_host_cmd_gate
  update_authorized_keys_with_gate

  if [[ -n "$WRAPPER_DST_OVERRIDE" ]]; then
    say "=== host wrapper ==="
    install_host_wrapper "$WRAPPER_DST_OVERRIDE"
  elif [[ -n "$UID_ARG" ]]; then
    LOCAL_VOL="oc-v5-userlocal-u${UID_ARG}"
    local_mount=$(docker volume inspect "$LOCAL_VOL" --format '{{.Mountpoint}}' 2>/dev/null || true)
    [[ -n "$local_mount" ]] || { echo "✗ 找不到 volume $LOCAL_VOL" >&2; exit 1; }
    say "=== host wrapper ==="
    install_host_wrapper "$local_mount/bin/host"
  fi

  say ""
  if [[ $APPLY != 1 ]]; then
    say "dry-run: 未改动任何东西。确认后加 --apply。"
  fi
  exit 0
fi

# ─── 完整流程 ─────────────────────────────────────────────────────────────────
DATA_VOL="oc-v5-data-u${UID_ARG}"
LOCAL_VOL="oc-v5-userlocal-u${UID_ARG}"
CONTAINER="oc-v5-u${UID_ARG}"

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
    install -d -m 700 "$(dirname "$KEY")"
    ssh-keygen -t ed25519 -N '' -C "$KEY_TAG" -f "$KEY" >/dev/null
    done_ "已生成 $KEY"
  fi
fi

# ─── 2. 安装 oc-host-cmd-gate 并绑定 authorized_keys ──────────────────
install_host_cmd_gate
update_authorized_keys_with_gate

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

# ─── 5. 镜像内置 OpenSSH + host wrapper ──────────────────────────────
# runtime 镜像已带 openssh-client(/usr/bin/ssh 等)。旧脚本曾把 ssh/scp 拷到
# userlocal ~/.local/bin,PATH 会挡住系统包且漏掉 ssh-keygen;这里删除旧副本,
# host wrapper 固定走 /usr/bin/ssh。
say "=== 5. OpenSSH 与 host wrapper ==="
if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  if docker exec "$CONTAINER" sh -c 'test -x /usr/bin/ssh && test -x /usr/bin/ssh-keygen && test -x /usr/bin/scp && test -x /usr/bin/sftp'; then
    skip "容器 /usr/bin/{ssh,ssh-keygen,scp,sftp}"
  else
    echo "✗ 运行中的 $CONTAINER 缺少 /usr/bin/ssh-keygen。请用已内置 openssh-client 的 runtime 镜像回收该容器,不要再 apt 拷贝到 ~/.local/bin。" >&2
    exit 1
  fi
else
  say "  容器未运行,跳过镜像内 OpenSSH 在线检查。"
fi

for b in ssh scp; do
  leftover="$local_mount/bin/$b"
  if [[ -e "$leftover" ]]; then
    todo "rm $leftover (旧 workaround,会挡住 /usr/bin/$b)"
    if [[ $APPLY == 1 ]]; then
      rm -f "$leftover"
      done_ "已删除 $leftover"
    fi
  else
    skip "$leftover 不存在"
  fi
done

wrapper="${WRAPPER_DST_OVERRIDE:-$local_mount/bin/host}"
install_host_wrapper "$wrapper"

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
