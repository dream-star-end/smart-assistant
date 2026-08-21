#!/usr/bin/env bash
# selfhost-import-personal-assets.sh — 把本机个人版 skill/memory/user 画像导入 V5 自用实例某用户的 data volume。
#
# 默认 dry-run,必须显式 --apply 才写盘。不要用 rsync --delete,不删目标已有内容。
#
# platform-baseline 排除集是运行时动态读出来的,不写死名单:
#   容器内 OPENCLAUDE_BASELINE_SKILLS_DIR=/run/oc/claude-config/skills
#   宿主侧来自 OC_V3_CCB_BASELINE_DIR/skills(selfhost unit 注入 worktree 的 ccb-baseline)。
#   解析顺序见 resolve_baseline_root。release 树当前不含 ccb-baseline,只作候选回落。
#   platform bundle 的 seed/skills 是 agent-seed,不是 platform-baseline,不进排除集。
#
# 用法:
#   scripts/selfhost-import-personal-assets.sh --uid <N> [--apply] [--src <dir>] [--agent <id>] [--overwrite] [--allow-running]
set -Eeuo pipefail
shopt -s nullglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SELFHOST_UNIT="openclaude-v5-selfhost.service"
SELFHOST_ENV="/etc/openclaude/commercial-v5-selfhost.env"
AGENT_UID=1000
AGENT_GID=1000
VALID_SKILL_NAME_RE='^[a-z0-9][a-z0-9-]*$'
MAX_SKILL_NAME_LEN=64

# V5 skill 文件管理 API 允许的子目录;其它子目录(bin/ history/)照拷但提示。
API_SKILL_SUBDIRS='references|assets|evals|scripts'

# 内容黑名单:可读数组,以后直接改这里。
#   glob:<fnmatch>   匹配 skill 目录名
#   content:<字面量> 匹配该 skill 目录下**任意文件**(SKILL.md、references/、scripts/ …)
# 命中即跳过;多规则命中只报第一条。
BLACKLIST_RULES=(
  'glob:personal-*'
  'glob:v5-*-debug'
  'glob:*-selfheal-*'
  'glob:system-ops'
  'content:45.32'
  'content:38.55'
  'content:kl-mirror'
)

# 生产运维黑名单:命中这些说明 skill 会教 agent 操作**商用生产**。
# 自用实例的 admin 容器能 SSH 到宿主,而宿主上就有 V5/v3 canonical 与官方部署脚本,
# 所以默认必须拦掉;确实要用时加 --allow-prod-skills 显式放行。
PROD_BLACKLIST_RULES=(
  'content:openclaude-v5-aurora'
  'content:commercial-v5.env'
  'content:commercial.env'
  'content:deploy-v5.sh'
  'content:deploy-v3.sh'
  'content:deploy-to-remote.sh'
  'content:openclaude-v3'
  'content:claudeai.chat'
)

DEFAULT_SRC="/root/.openclaude"
DEFAULT_AGENT="codex"
MERGE_AGENT="main"

SRC="$DEFAULT_SRC"
AGENT="$DEFAULT_AGENT"
TARGET_UID=""
APPLY=0
OVERWRITE=0
ALLOW_RUNNING=0
ALLOW_PROD_SKILLS=0

die() {
  echo "✗ $*" >&2
  exit 1
}

log() { echo "$*"; }

usage() {
  cat <<'EOF'
用法: scripts/selfhost-import-personal-assets.sh --uid <N> [--apply] [--src <dir>] [--agent <id>] [--overwrite] [--allow-running]

  --uid N            目标 V5 用户 id(必填,正整数)
  --src DIR          个人版 OPENCLAUDE_HOME,默认 /root/.openclaude
  --agent ID         主源 agent,默认 codex;另外始终再合并 main(若不同)
  --apply            真的写 volume;缺省只打印清单
  --overwrite        覆盖目标已存在的同名 skill / 非空 MEMORY.md / user.md
  --allow-running    允许在 oc-v5-u<uid> 仍运行时继续(强烈不建议)
  --allow-prod-skills 放行会教 agent 操作商用生产的 skill(默认拦截,见 PROD_BLACKLIST_RULES)

默认 dry-run。写之前会校验 docker volume oc-v5-data-u<uid> 存在。
EOF
}

need_arg() {
  [[ $# -ge 2 ]] || die "$1 需要参数"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uid)
      need_arg "$@"
      TARGET_UID="$2"
      shift 2
      ;;
    --uid=*) TARGET_UID="${1#*=}"; shift ;;
    --src)
      need_arg "$@"
      SRC="$2"
      shift 2
      ;;
    --src=*) SRC="${1#*=}"; shift ;;
    --agent)
      need_arg "$@"
      AGENT="$2"
      shift 2
      ;;
    --agent=*) AGENT="${1#*=}"; shift ;;
    --apply) APPLY=1; shift ;;
    --overwrite) OVERWRITE=1; shift ;;
    --allow-running) ALLOW_RUNNING=1; shift ;;
    --allow-prod-skills) ALLOW_PROD_SKILLS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -n "$TARGET_UID" ]] || die "必须指定 --uid <正整数>"
[[ "$TARGET_UID" =~ ^[1-9][0-9]*$ ]] || die "--uid 必须是正整数,收到: $TARGET_UID"
[[ "$AGENT" =~ ^[a-zA-Z0-9_-]+$ ]] || die "--agent 非法: $AGENT"
[[ -d "$SRC" ]] || die "源目录不存在: $SRC"

SRC="$(cd "$SRC" && pwd)"
PRIMARY_SKILLS="$SRC/agents/$AGENT/skills"
[[ -d "$PRIMARY_SKILLS" ]] || die "源 agent 没有 skills 目录: $PRIMARY_SKILLS"

VOLUME_NAME="oc-v5-data-u${TARGET_UID}"
CONTAINER_NAME="oc-v5-u${TARGET_UID}"

strip_quotes() {
  local v="$1"
  if [[ "$v" == \"*\" && "$v" == *\" ]]; then
    v="${v#\"}"
    v="${v%\"}"
  elif [[ "$v" == \'*\' && "$v" == *\' ]]; then
    v="${v#\'}"
    v="${v%\'}"
  fi
  printf '%s' "$v"
}

# 从正在跑的 selfhost 主进程 / systemd Environment= / env 文件读一个 key。
read_selfhost_env() {
  local key="$1" pid="" val="" line=""
  pid="$(systemctl show -p MainPID --value "$SELFHOST_UNIT" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/environ" ]]; then
    while IFS= read -r -d '' line || [[ -n "${line:-}" ]]; do
      if [[ "$line" == "$key"=* ]]; then
        strip_quotes "${line#*=}"
        return 0
      fi
    done < "/proc/$pid/environ"
  fi
  val="$(systemctl show -p Environment --value "$SELFHOST_UNIT" 2>/dev/null || true)"
  if [[ -n "$val" ]]; then
    local part
    # systemctl Environment= 是空格分隔的 KEY=VALUE;本实例路径不含空格。
    while IFS= read -r part; do
      [[ -n "$part" ]] || continue
      if [[ "$part" == "$key"=* ]]; then
        strip_quotes "${part#*=}"
        return 0
      fi
    done <<<"${val// /$'\n'}"
  fi
  if [[ -r "$SELFHOST_ENV" ]]; then
    val="$(awk -F= -v k="$key" '$1==k { print substr($0, index($0, "=") + 1) }' "$SELFHOST_ENV" | tail -n1)"
    if [[ -n "$val" ]]; then
      strip_quotes "$val"
      return 0
    fi
  fi
  return 1
}

dir_has_skill_md() {
  local root="$1" d
  [[ -d "$root/skills" ]] || return 1
  for d in "$root/skills"/*/; do
    [[ -f "${d}SKILL.md" ]] && return 0
  done
  return 1
}

# 运行时动态定位 platform-baseline 根(其下 skills/<name>/SKILL.md)。不写死名单。
resolve_baseline_root() {
  local -a cands=()
  local v rel c
  [[ -n "${OC_V3_CCB_BASELINE_DIR:-}" ]] && cands+=("$OC_V3_CCB_BASELINE_DIR")
  if v="$(read_selfhost_env OC_V3_CCB_BASELINE_DIR)"; then
    cands+=("$v")
  fi
  rel="${OC_RUNTIME_RELEASE:-}"
  if [[ -z "$rel" ]]; then
    rel="$(read_selfhost_env OC_RUNTIME_RELEASE || true)"
  fi
  if [[ -n "$rel" ]]; then
    cands+=("$rel/packages/commercial/agent-sandbox/ccb-baseline")
  fi
  cands+=("$REPO_ROOT/packages/commercial/agent-sandbox/ccb-baseline")

  local -A seen=()
  for c in "${cands[@]}"; do
    [[ -n "$c" ]] || continue
    [[ -z "${seen[$c]:-}" ]] || continue
    seen[$c]=1
    if dir_has_skill_md "$c"; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

load_baseline_names() {
  local root="$1" d name
  BASELINE_NAMES=()
  for d in "$root/skills"/*/; do
    [[ -f "${d}SKILL.md" ]] || continue
    name="$(basename "${d%/}")"
    BASELINE_NAMES["$name"]=1
  done
}

human_bytes() {
  local n="$1"
  if command -v numfmt >/dev/null 2>&1; then
    numfmt --to=iec --suffix=B "$n"
  else
    printf '%sB' "$n"
  fi
}

dir_bytes() {
  du -sb "$1" | awk '{print $1}'
}

file_bytes() {
  stat -c '%s' "$1"
}

extra_subdirs() {
  local skill_dir="$1" d b extras=()
  for d in "$skill_dir"/*/; do
    b="$(basename "${d%/}")"
    if [[ ! "$b" =~ ^($API_SKILL_SUBDIRS)$ ]]; then
      extras+=("$b")
    fi
  done
  if [[ ${#extras[@]} -gt 0 ]]; then
    local IFS=','
    printf '%s' "${extras[*]}"
  fi
}

blacklist_reason() {
  local name="$1" skill_dir="$2" rule kind pat rules=()
  rules=("${BLACKLIST_RULES[@]}")
  [[ "$ALLOW_PROD_SKILLS" == 1 ]] || rules+=("${PROD_BLACKLIST_RULES[@]}")
  for rule in "${rules[@]}"; do
    kind="${rule%%:*}"
    pat="${rule#*:}"
    case "$kind" in
      glob)
        # 右侧故意不引号:按 fnmatch 匹配目录名(personal-* / v5-*-debug 等)。
        # shellcheck disable=SC2053
        if [[ "$name" == $pat ]]; then
          printf '%s' "$rule"
          return 0
        fi
        ;;
      content)
        # 扫整棵 skill 树:危险内容常在 references/ 或 scripts/ 里,只看 SKILL.md 会漏。
        if grep -R -F -q -- "$pat" "$skill_dir" 2>/dev/null; then
          printf '%s' "$rule"
          return 0
        fi
        ;;
      *)
        die "黑名单条目非法(要 glob: 或 content:): $rule"
        ;;
    esac
  done
  return 1
}

# 记录一行。用 US(\x1f) 分隔,避免 bash read 把连续 tab 当成一个分隔符把空字段吃掉。
US=$'\x1f'
RECORD_LINES=()
declare -A SEEN_SKILLS=()
declare -A BASELINE_NAMES=()

record() {
  local action="$1" name="$2" agent="$3" src="$4" bytes="$5" reason="${6:-}" note="${7:-}"
  RECORD_LINES+=("${action}${US}${name}${US}${agent}${US}${src}${US}${bytes}${US}${reason}${US}${note}")
}

consider_skill() {
  local agent="$1" skill_dir="$2"
  local name src_dir skill_md bytes reason note dest
  name="$(basename "$skill_dir")"
  src_dir="$skill_dir"
  skill_md="$skill_dir/SKILL.md"
  bytes="$(dir_bytes "$skill_dir")"
  note="$(extra_subdirs "$skill_dir" || true)"

  if [[ -n "${SEEN_SKILLS[$name]:-}" ]]; then
    record SKIP "$name" "$agent" "$src_dir" "$bytes" "与主 agent ${SEEN_SKILLS[$name]} 同名" "$note"
    return 0
  fi
  SEEN_SKILLS["$name"]="$agent"

  if [[ ! -f "$skill_md" ]]; then
    record SKIP "$name" "$agent" "$src_dir" "$bytes" "无 SKILL.md" "$note"
    return 0
  fi
  if [[ ${#name} -gt $MAX_SKILL_NAME_LEN || ! "$name" =~ $VALID_SKILL_NAME_RE ]]; then
    record SKIP "$name" "$agent" "$src_dir" "$bytes" "名字不符合 V5 skill 约束" "$note"
    return 0
  fi
  if [[ -n "${BASELINE_NAMES[$name]:-}" ]]; then
    record SKIP "$name" "$agent" "$src_dir" "$bytes" "撞 platform-baseline" "$note"
    return 0
  fi
  if reason="$(blacklist_reason "$name" "$src_dir")"; then
    record SKIP "$name" "$agent" "$src_dir" "$bytes" "黑名单 ${reason}" "$note"
    return 0
  fi
  if [[ -n "${MOUNT:-}" ]]; then
    dest="$MOUNT/skills/$name"
    if [[ -L "$dest" ]]; then
      record SKIP "$name" "$agent" "$src_dir" "$bytes" "目标是符号链接,拒绝写入" "$note"
      return 0
    fi
    if [[ -e "$dest" && "$OVERWRITE" != 1 ]]; then
      record SKIP "$name" "$agent" "$src_dir" "$bytes" "目标已存在(需要 --overwrite)" "$note"
      return 0
    fi
    if [[ -e "$dest" && ! -d "$dest" ]]; then
      record SKIP "$name" "$agent" "$src_dir" "$bytes" "目标已存在但不是目录" "$note"
      return 0
    fi
  fi
  record IMPORT "$name" "$agent" "$src_dir" "$bytes" "" "$note"
}

scan_agent_skills() {
  local agent="$1"
  local root="$SRC/agents/$agent/skills"
  local d
  if [[ ! -d "$root" ]]; then
    log "  (跳过 agent ${agent}: 没有 skills 目录)"
    return 0
  fi
  for d in "$root"/*/; do
    consider_skill "$agent" "${d%/}"
  done
}

MEM_ACTION=""
MEM_SRC=""
MEM_BYTES=0
MEM_REASON=""
USER_ACTION=""
USER_SRC=""
USER_BYTES=0
USER_REASON=""

plan_memory_and_user() {
  local mem_src="$SRC/agents/$AGENT/MEMORY.md"
  local user_src="$SRC/agents/$AGENT/USER.md"
  local mem_dest="" user_dest=""

  MEM_SRC="$mem_src"
  USER_SRC="$user_src"

  if [[ "$mem_src" == *.recovered-full.md ]]; then
    MEM_ACTION=SKIP
    MEM_REASON="备份文件,不导入"
  elif [[ ! -f "$mem_src" ]]; then
    MEM_ACTION=SKIP
    MEM_REASON="源文件不存在"
  elif [[ ! -s "$mem_src" ]]; then
    MEM_ACTION=SKIP
    MEM_REASON="源文件为空"
  else
    MEM_BYTES="$(file_bytes "$mem_src")"
    MEM_ACTION=IMPORT
    if [[ -n "${MOUNT:-}" ]]; then
      mem_dest="$MOUNT/agents/main/MEMORY.md"
      if [[ -L "$MOUNT/agents" || -L "$MOUNT/agents/main" || -L "$mem_dest" ]]; then
        MEM_ACTION=SKIP
        MEM_REASON="目标路径含符号链接,拒绝写入"
      elif [[ -s "$mem_dest" && "$OVERWRITE" != 1 ]]; then
        MEM_ACTION=SKIP
        MEM_REASON="目标已有非空 MEMORY.md(需要 --overwrite)"
      fi
    fi
  fi

  if [[ "$user_src" == *.recovered-full.md ]]; then
    USER_ACTION=SKIP
    USER_REASON="备份文件,不导入"
  elif [[ ! -f "$user_src" ]]; then
    USER_ACTION=SKIP
    USER_REASON="源文件不存在"
  elif [[ ! -s "$user_src" ]]; then
    USER_ACTION=SKIP
    USER_REASON="源文件为空"
  else
    USER_BYTES="$(file_bytes "$user_src")"
    USER_ACTION=IMPORT
    if [[ -n "${MOUNT:-}" ]]; then
      user_dest="$MOUNT/user.md"
      if [[ -L "$user_dest" ]]; then
        USER_ACTION=SKIP
        USER_REASON="目标是符号链接,拒绝写入"
      elif [[ -e "$user_dest" && "$OVERWRITE" != 1 ]]; then
        USER_ACTION=SKIP
        USER_REASON="目标已有 user.md(不要覆盖 V5 自己生成的;需要 --overwrite)"
      fi
    fi
  fi
}

print_plan() {
  local line action name agent src bytes reason note
  local n_import=0 n_skip=0

  log "=== V5 platform-baseline(运行时动态读取,不是写死名单) ==="
  log "路径: ${BASELINE_ROOT}/skills"
  log "数量: ${#BASELINE_NAMES[@]}"
  log "名单:"
  local n
  while IFS= read -r n; do
    [[ -n "$n" ]] && log "  - $n"
  done < <(printf '%s\n' "${!BASELINE_NAMES[@]}" | sort)

  log ""
  log "=== 源 ==="
  log "src=$SRC  主 agent=$AGENT  合并 agent=$MERGE_AGENT"
  log "目标 volume=$VOLUME_NAME  容器=$CONTAINER_NAME"
  if [[ -n "${MOUNT:-}" ]]; then
    log "mount=$MOUNT"
  else
    log "mount=(卷不存在,无法检查目标已存在)"
  fi
  log "模式: $([[ "$APPLY" == 1 ]] && echo APPLY || echo dry-run)"

  log ""
  log "=== 将导入的 skill ==="
  for line in "${RECORD_LINES[@]}"; do
    IFS="$US" read -r action name agent src bytes reason note <<<"$line"
    if [[ "$action" == IMPORT ]]; then
      n_import=$((n_import + 1))
      printf 'IMPORT  %-48s agent=%-12s %10s' "$name" "$agent" "$(human_bytes "$bytes")"
      if [[ -n "$note" ]]; then
        printf '  提示: 含 %s/ ,V5 skill API 只管理 references|assets|evals|scripts,文件系统层仍照拷' "$note"
      fi
      printf '\n'
    fi
  done
  [[ "$n_import" -gt 0 ]] || log "(无)"

  log ""
  log "=== 跳过的 skill ==="
  for line in "${RECORD_LINES[@]}"; do
    IFS="$US" read -r action name agent src bytes reason note <<<"$line"
    if [[ "$action" == SKIP ]]; then
      n_skip=$((n_skip + 1))
      printf 'SKIP    %-48s agent=%-12s %10s  原因: %s\n' "$name" "$agent" "$(human_bytes "$bytes")" "$reason"
    fi
  done
  [[ "$n_skip" -gt 0 ]] || log "(无)"

  log ""
  log "=== memory / user 画像 ==="
  if [[ "$MEM_ACTION" == IMPORT ]]; then
    printf 'IMPORT  MEMORY.md → agents/main/MEMORY.md  agent=%s  %s\n' "$AGENT" "$(human_bytes "$MEM_BYTES")"
  else
    printf 'SKIP    MEMORY.md  原因: %s\n' "$MEM_REASON"
  fi
  if [[ "$USER_ACTION" == IMPORT ]]; then
    printf 'IMPORT  USER.md → user.md  agent=%s  %s\n' "$AGENT" "$(human_bytes "$USER_BYTES")"
  else
    printf 'SKIP    USER.md → user.md  原因: %s\n' "$USER_REASON"
  fi

  log ""
  log "=== 汇总 ==="
  log "skill import=${n_import} skip=${n_skip}  memory=${MEM_ACTION}  user=${USER_ACTION}"
  if [[ "$APPLY" != 1 ]]; then
    log "dry-run: 未写盘。确认后加 --apply。"
  fi
}

die_if_symlink() {
  local p="$1"
  if [[ -L "$p" ]]; then
    die "拒绝写入符号链接: $p"
  fi
}

# 从 volume 根走到 dest,每一级已存在的路径都不得是 symlink(不跟随)。
assert_dest_safe() {
  local dest="$1" acc rest part
  [[ -n "$MOUNT" ]] || die "内部错误: MOUNT 未设置"
  [[ "$dest" == "$MOUNT" || "$dest" == "$MOUNT"/* ]] || die "目标不在 volume 内: $dest"
  die_if_symlink "$MOUNT"
  [[ "$dest" == "$MOUNT" ]] && return 0
  acc="$MOUNT"
  rest="${dest#"$MOUNT"/}"
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    if [[ "$part" == "$rest" ]]; then
      rest=""
    else
      rest="${rest#*/}"
    fi
    [[ -n "$part" ]] || continue
    acc="$acc/$part"
    die_if_symlink "$acc"
  done
}

# 立即 chown 且不跟随 symlink;失败不得把 root 属主文件留到下一步。
verify_owner() {
  local p="$1" extra="${2:-}" bad
  # extra 为空=整棵树;传 -maxdepth 0 只查路径自身(新建目录 inode)。
  # shellcheck disable=SC2086
  bad="$(find -P "$p" $extra \( ! -user "$AGENT_UID" -o ! -group "$AGENT_GID" \) -print -quit)"
  if [[ -n "$bad" ]]; then
    die "chown 后仍有非 ${AGENT_UID}:${AGENT_GID} 属主: $bad"
  fi
}

chown_path() {
  local p="$1"
  [[ -e "$p" || -L "$p" ]] || die "写入后路径消失: $p"
  die_if_symlink "$p"
  chown -h -R "${AGENT_UID}:${AGENT_GID}" "$p"
  verify_owner "$p"
}

ensure_owned_dir() {
  local d="$1"
  assert_dest_safe "$d"
  mkdir -p "$d"
  die_if_symlink "$d"
  chown -h "${AGENT_UID}:${AGENT_GID}" "$d"
  verify_owner "$d" "-maxdepth 0"
}

# cp 即使失败也先 chown 已落盘内容,避免 root 属主残留。
copy_then_chown() {
  local src="$1" dest="$2" rc=0
  cp -a -- "$src" "$dest" || rc=$?
  if [[ -e "$dest" || -L "$dest" ]]; then
    chown_path "$dest"
  fi
  [[ "$rc" -eq 0 ]] || die "拷贝失败: $src → $dest"
}

# --overwrite 必须是真替换:先拷到同父目录的临时目录再原子换上,
# 否则目录合并会把上一版里已删掉的文件(旧凭据、生产运维引用)永久留在卷里。
copy_skill() {
  local src="$1" dest="$2" rc=0 tmp
  assert_dest_safe "$dest"
  die_if_symlink "$(dirname "$dest")"
  tmp="$(mktemp -d -- "${dest}.tmp.XXXXXX")"
  cp -a -- "$src/." "$tmp/" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    rm -rf -- "$tmp"
    die "拷贝 skill 失败: $src → $dest"
  fi
  chown_path "$tmp"
  rm -rf -- "$dest"
  mv -T -- "$tmp" "$dest"
}

apply_plan() {
  local line action name agent src bytes reason note dest
  ensure_owned_dir "$MOUNT/skills"

  for line in "${RECORD_LINES[@]}"; do
    IFS="$US" read -r action name agent src bytes reason note <<<"$line"
    [[ "$action" == IMPORT ]] || continue
    dest="$MOUNT/skills/$name"
    copy_skill "$src" "$dest"
    log "  已拷 skill $name ← $agent"
  done

  if [[ "$MEM_ACTION" == IMPORT ]]; then
    ensure_owned_dir "$MOUNT/agents"
    ensure_owned_dir "$MOUNT/agents/main"
    assert_dest_safe "$MOUNT/agents/main/MEMORY.md"
    copy_then_chown "$MEM_SRC" "$MOUNT/agents/main/MEMORY.md"
    log "  已拷 MEMORY.md → agents/main/MEMORY.md"
  fi

  if [[ "$USER_ACTION" == IMPORT ]]; then
    assert_dest_safe "$MOUNT/user.md"
    copy_then_chown "$USER_SRC" "$MOUNT/user.md"
    log "  已拷 USER.md → user.md"
  fi

  log "属主已校验为 ${AGENT_UID}:${AGENT_GID}"
}

# ── main ──

trap 'echo "✗ 脚本失败: ${BASH_COMMAND} (行 ${LINENO})" >&2' ERR

BASELINE_ROOT="$(resolve_baseline_root)" || die "找不到 V5 platform-baseline skills 目录(OC_V3_CCB_BASELINE_DIR / 本仓 ccb-baseline)。拒绝继续,以免漏判撞名。"
load_baseline_names "$BASELINE_ROOT"
[[ ${#BASELINE_NAMES[@]} -gt 0 ]] || die "baseline 目录没有 SKILL.md: ${BASELINE_ROOT}/skills"

MOUNT=""
VOLUME_MISSING=0
if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  MOUNT="$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME_NAME")"
  [[ -n "$MOUNT" && -d "$MOUNT" ]] || die "volume ${VOLUME_NAME} 的 Mountpoint 无效: ${MOUNT:-空}"
  if [[ -L "$MOUNT/skills" ]]; then
    die "目标 skills 是符号链接,拒绝写入(对齐 V5 normalizeMigratedSkillOwnership)"
  fi
  if [[ -e "$MOUNT/skills" && ! -d "$MOUNT/skills" ]]; then
    die "目标 skills 存在但不是目录: $MOUNT/skills"
  fi
else
  VOLUME_MISSING=1
fi

if [[ "$VOLUME_MISSING" == 1 && "$APPLY" == 1 ]]; then
  die "docker volume ${VOLUME_NAME} 不存在:该用户还没首次登录过,容器和卷尚未创建"
fi

CONTAINER_RUNNING=0
if docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -qx true; then
  CONTAINER_RUNNING=1
fi
if [[ "$CONTAINER_RUNNING" == 1 ]]; then
  log "⚠ 容器 ${CONTAINER_NAME} 正在运行。强烈建议先停再导入。"
  if [[ "$ALLOW_RUNNING" != 1 ]]; then
    die "拒绝在运行中的容器上继续。停容器后重试,或显式传 --allow-running"
  fi
  log "  --allow-running 已指定,继续。"
fi

if [[ "$APPLY" == 1 && "$(id -u)" != 0 ]]; then
  die "--apply 需要 root,以便把文件属主改成 ${AGENT_UID}:${AGENT_GID}"
fi

scan_agent_skills "$AGENT"
if [[ "$AGENT" != "$MERGE_AGENT" ]]; then
  scan_agent_skills "$MERGE_AGENT"
fi
plan_memory_and_user
print_plan

if [[ "$VOLUME_MISSING" == 1 ]]; then
  log ""
  die "docker volume ${VOLUME_NAME} 不存在:该用户还没首次登录过,容器和卷尚未创建(dry-run 已打印源侧清单;目标已存在检查未做)"
fi

if [[ "$APPLY" != 1 ]]; then
  exit 0
fi

log ""
log "=== 开始写入 ==="
apply_plan
log "完成。"
