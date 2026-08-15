#!/usr/bin/env bash
# v5-worktree-new.sh — 创建 V5 worktree 并复用 node_modules / tsc 增量缓存。
#
# 目标:把「新任务分支冷启动」从数分钟(npm ci + 全量 tsc)压到秒级。
# 默认用 symlink 挂 donor 的 node_modules(含各 package 级);tsc 增量缓存
# 按 base commit 分桶拷贝,避免跨 commit 污染。
#
# 红线:只创建/删除本脚本自己建的 worktree;--report 只列不删。
set -euo pipefail

CANONICAL="${OC_V5_CANONICAL:-/opt/openclaude/openclaude-v5-aurora}"
BASE_DIR="${OC_V5_WORKTREE_BASE_DIR:-/opt/openclaude}"
CACHE_ROOT="${OC_V5_WORKTREE_CACHE:-/var/cache/openclaude-v5/worktree}"
DEFAULT_BASE="${OC_V5_WORKTREE_BASE_BRANCH:-feat/v5-aurora-rewrite}"
STAMP_NAME=".v5-worktree-cache.json"

usage() {
  cat <<'EOF'
Usage:
  scripts/v5-worktree-new.sh <name> [base-branch]
  scripts/v5-worktree-new.sh --fresh <name> [base-branch]
  scripts/v5-worktree-new.sh --heal <worktree-path>
  scripts/v5-worktree-new.sh --report
  scripts/v5-worktree-new.sh --self-test-share

Options:
  --donor PATH          依赖/缓存来源(默认 /opt/openclaude/openclaude-v5-aurora)
  --method symlink|hardlink   默认 symlink;hardlink 走 cp -al
  --base-dir PATH       worktree 父目录(默认 /opt/openclaude)
  --branch NAME         新分支名(默认 feat/v5-<name>)
  --path PATH           worktree 路径(默认 <base-dir>/openclaude-v5-<name>)
  --fresh               不复用,在新 worktree 里 npm ci
  --heal PATH           检测共享缓存损坏并自愈(拆坏链 / 丢弃污染的 tsbuildinfo)
  --report              列出重复 node_modules 磁盘占用;绝不删除
  --self-test-share     在临时目录实测 symlink vs hardlink 的 .bin 可用性

环境:
  OC_V5_CANONICAL  OC_V5_WORKTREE_BASE_DIR  OC_V5_WORKTREE_CACHE
  OC_V5_WORKTREE_BASE_BRANCH
EOF
}

die() { echo "✗ $*" >&2; exit 2; }

need_tool() {
  command -v "$1" >/dev/null 2>&1 || die "缺少必需命令:$1"
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

resolve_donor() {
  local donor="$1"
  [[ -d "$donor/.git" || -f "$donor/.git" ]] || die "donor 不是 git 工作树:$donor"
  [[ -d "$donor/node_modules" ]] || die "donor 没有 node_modules,无法复用:$donor(改用 --fresh 或先在 canonical 装依赖)"
  printf '%s\n' "$donor"
}

worktree_path_for_name() {
  local name="$1"
  printf '%s/openclaude-v5-%s\n' "$BASE_DIR" "$name"
}

valid_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && ${#1} -le 80 ]]
}

share_node_modules() {
  local src="$1" dst="$2" method="$3"
  if [[ -e "$dst" || -L "$dst" ]]; then
    echo "  · 已存在 $dst — 跳过"
    return 0
  fi
  if [[ ! -e "$src" ]]; then
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  case "$method" in
    symlink)
      ln -s "$src" "$dst"
      echo "  · symlink $dst -> $src"
      ;;
    hardlink)
      cp -al "$src" "$dst"
      echo "  · hardlink-tree $src -> $dst"
      ;;
    *) die "未知 method:$method" ;;
  esac
}

share_all_node_modules() {
  local donor="$1" wt="$2" method="$3" src rel
  share_node_modules "$donor/node_modules" "$wt/node_modules" "$method"
  # 根 workspace + 各 package(含 channels/*)的 node_modules 都要挂上。
  while IFS= read -r src; do
    rel="${src#"$donor"/}"
    share_node_modules "$src" "$wt/$rel" "$method"
  done < <(find "$donor/packages" -mindepth 2 -maxdepth 4 -type d -name node_modules 2>/dev/null || true)
}

# tsc 增量缓存按 base commit 分桶。只有 donor HEAD == 新 worktree HEAD 时才拷贝
# dist-types / tsbuildinfo,否则宁可冷启动,也不给出错误的增量结果。
install_tsc_cache() {
  local donor="$1" wt="$2" head="$3"
  local donor_head bucket src dest
  donor_head="$(git -C "$donor" rev-parse HEAD)"
  bucket="$CACHE_ROOT/tsc/$head"
  mkdir -p "$bucket"

  if [[ "$donor_head" != "$head" ]]; then
    echo "  · tsc 缓存跳过:donor HEAD=${donor_head:0:12} ≠ worktree HEAD=${head:0:12}(防跨 commit 污染)"
    return 0
  fi

  local copied=0
  while IFS= read -r src; do
    dest="$wt/${src#"$donor"/}"
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    cp -a "$src" "$dest"
    copied=$((copied + 1))
  done < <(find "$donor/packages" \( -name dist-types -o -name tsconfig.tsbuildinfo \) \
            -not -path '*/node_modules/*' 2>/dev/null || true)

  # 同步一份到按 commit 分桶的共享目录,供后续同 SHA worktree 复用。
  if [[ "$copied" -gt 0 ]]; then
    mkdir -p "$bucket/packages"
    rsync -a --delete \
      --include='*/' --include='dist-types/***' --include='tsconfig.tsbuildinfo' \
      --exclude='*' \
      "$donor/packages/" "$bucket/packages/" 2>/dev/null || true
    echo "  · tsc 增量缓存已从 donor 拷入 $copied 项(bucket=${head:0:12})"
  else
    echo "  · donor 无 tsbuildinfo/dist-types,tsc 将冷启动"
  fi
}

write_stamp() {
  local wt="$1" donor="$2" method="$3" head="$4" base="$5" fresh="$6"
  cat >"$wt/$STAMP_NAME" <<EOF
{
  "donor": "$(json_escape "$donor")",
  "method": "$(json_escape "$method")",
  "head": "$(json_escape "$head")",
  "base": "$(json_escape "$base")",
  "fresh": $fresh,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "created_by": "$(json_escape "${USER:-unknown}")"
}
EOF
}

verify_bins() {
  local wt="$1"
  local tsc="$wt/node_modules/.bin/tsc"
  local tsx="$wt/node_modules/.bin/tsx"
  [[ -x "$tsc" ]] || die "共享后 $tsc 不可执行(.bin 软链损坏?用 --heal 或 --fresh)"
  [[ -x "$tsx" ]] || die "共享后 $tsx 不可执行"
  "$tsc" --version >/dev/null || die "tsc --version 失败"
  "$tsx" --version >/dev/null || die "tsx --version 失败"
  echo "  · .bin 可用: tsc=$("$tsc" --version) tsx=$("$tsx" --version)"
}

create_worktree() {
  local name="$1" base_branch="$2" fresh="$3" method="$4" donor="$5"
  local branch path
  branch="${BRANCH_OVERRIDE:-feat/v5-$name}"
  path="${PATH_OVERRIDE:-$(worktree_path_for_name "$name")}"

  valid_name "$name" || die "非法 name:$name(用 [A-Za-z0-9._-],≤80)"
  [[ "$path" == "$BASE_DIR"/openclaude-v5-* || -n "${PATH_OVERRIDE:-}" ]] \
    || die "拒绝在约定前缀外建 worktree:$path"
  [[ ! -e "$path" ]] || die "目标路径已存在:$path(不会覆盖他人 worktree)"

  need_tool git
  donor="$(resolve_donor "$donor")"
  local repo
  repo="$(git -C "$donor" rev-parse --absolute-git-dir)"
  repo="${repo%.git}"
  repo="${repo%/.}"

  echo "══ v5-worktree-new name=$name base=$base_branch method=$method fresh=$fresh ══"
  echo "  donor=$donor"
  echo "  path=$path"
  echo "  branch=$branch"

  # 从 donor 所在仓库建 worktree。-b 新分支,起点是 base-branch。
  git -C "$donor" fetch origin --quiet 2>/dev/null || true
  local start
  start="$(git -C "$donor" rev-parse --verify "$base_branch^{commit}" 2>/dev/null \
    || git -C "$donor" rev-parse --verify "origin/$base_branch^{commit}" 2>/dev/null \
    || true)"
  [[ -n "$start" ]] || die "无法解析 base-branch:$base_branch"

  git -C "$donor" worktree add -b "$branch" "$path" "$start"
  local head
  head="$(git -C "$path" rev-parse HEAD)"
  echo "  HEAD=${head:0:12}"

  if [[ "$fresh" == 1 ]]; then
    need_tool npm
    echo "── --fresh: npm ci(不复用)──"
    (cd "$path" && npm ci)
  else
    echo "── 复用 node_modules($method)──"
    share_all_node_modules "$donor" "$path" "$method"
    verify_bins "$path"
    echo "── 安装 tsc 增量缓存──"
    install_tsc_cache "$donor" "$path" "$head"
  fi
  write_stamp "$path" "$donor" "$method" "$head" "$base_branch" "$fresh"
  echo "✓ worktree 就绪:$path"
  printf '%s\n' "$path"
}

heal_worktree() {
  local wt="$1"
  [[ -d "$wt" ]] || die "worktree 不存在:$wt"
  [[ -f "$wt/$STAMP_NAME" ]] || die "不是本脚本创建的 worktree(缺 $STAMP_NAME):$wt"

  echo "══ heal $wt ══"
  local broken=0
  if [[ ! -x "$wt/node_modules/.bin/tsc" ]] || ! "$wt/node_modules/.bin/tsc" --version >/dev/null 2>&1; then
    echo "  · node_modules/.bin 不可用 — 拆除共享链"
    if [[ -L "$wt/node_modules" ]]; then
      rm -f "$wt/node_modules"
    elif [[ -d "$wt/node_modules" ]]; then
      echo "  · $wt/node_modules 是真实目录,不自动删除。请人工确认后 --fresh 重建。"
    fi
    # package-level 坏链一并拆掉
    find "$wt/packages" -mindepth 2 -maxdepth 4 \( -type l -o -type d \) -name node_modules 2>/dev/null \
      | while IFS= read -r p; do
          if [[ -L "$p" ]]; then
            rm -f "$p"
            echo "  · 拆除 $p"
          fi
        done
    broken=1
  else
    echo "  · .bin 正常"
  fi

  # 共享 tsbuildinfo 导致「增量结果不对」时的自愈:丢掉本树缓存,下次 tsc 全量。
  # 判据:stamp.head 与当前 HEAD 不一致,或用户显式要求。
  local stamp_head current
  stamp_head="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('head',''))" "$wt/$STAMP_NAME" 2>/dev/null || true)"
  current="$(git -C "$wt" rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "$stamp_head" && -n "$current" && "$stamp_head" != "$current" ]]; then
    echo "  · HEAD 已离开缓存桶($stamp_head → $current) — 丢弃本树 tsbuildinfo"
    find "$wt/packages" \( -name .tsbuildinfo -o -name tsconfig.tsbuildinfo \) \
      -not -path '*/node_modules/*' -delete 2>/dev/null || true
    broken=1
  fi

  if [[ "$broken" == 1 ]]; then
    echo "  下一步:在 $wt 跑 scripts/v5-worktree-new.sh --fresh 对应 name,或从仍健康的 donor 重新 symlink。"
    echo "  本命令不自动 npm ci,也不删除他人 worktree。"
    return 1
  fi
  echo "✓ 共享缓存看起来健康"
  return 0
}

report_duplicates() {
  echo "══ V5 worktree node_modules 回收报告(只列不删)══"
  echo "扫描 $BASE_DIR/openclaude-v5* …"
  local n_real=0 n_link=0 total=0
  local path kind size
  printf '%-10s %12s  %s\n' "KIND" "BYTES" "PATH"
  # 用 find -maxdepth 2,避免深入 node_modules。
  while IFS= read -r path; do
    if [[ -L "$path" ]]; then
      kind="symlink"
      size=0
      n_link=$((n_link + 1))
    else
      kind="dir"
      size="$(du -sb "$path" 2>/dev/null | awk '{print $1}')"
      size="${size:-0}"
      n_real=$((n_real + 1))
      total=$((total + size))
    fi
    printf '%-10s %12s  %s\n' "$kind" "$size" "$path"
  done < <(find "$BASE_DIR" -maxdepth 2 -name node_modules \( -type d -o -type l \) 2>/dev/null \
            | grep -E '/openclaude-v5[^/]*/node_modules$' \
            | sort)

  echo ""
  echo "realdir=$n_real symlink=$n_link real_bytes=$total real_gib=$(awk -v t="$total" 'BEGIN{printf "%.2f", t/1024/1024/1024}')"
  echo "估算:若每份真实树 ≈ donor 体积,复用后可回收 realdir-1 份。"
  echo "本报告绝不删除任何目录。回收请人工确认后逐个处理。"
}

self_test_share() {
  local donor="$1"
  donor="$(resolve_donor "$donor")"
  local tmp
  tmp="$(mktemp -d /tmp/v5-share-probe.XXXXXX)"
  echo "══ self-test-share donor=$donor tmp=$tmp ══"
  local method dir tsc_ok tsx_ok
  for method in symlink hardlink; do
    dir="$tmp/$method"
    mkdir -p "$dir"
    share_node_modules "$donor/node_modules" "$dir/node_modules" "$method"
    tsc_ok=0; tsx_ok=0
    if [[ -x "$dir/node_modules/.bin/tsc" ]] && "$dir/node_modules/.bin/tsc" --version >/dev/null 2>&1; then
      tsc_ok=1
    fi
    if [[ -x "$dir/node_modules/.bin/tsx" ]] && "$dir/node_modules/.bin/tsx" --version >/dev/null 2>&1; then
      tsx_ok=1
    fi
    echo "  $method tsc=$tsc_ok tsx=$tsx_ok version=$("$dir/node_modules/.bin/tsc" --version 2>/dev/null || echo FAIL)"
  done
  rm -rf "$tmp"
  echo "✓ self-test-share 完成(临时目录已清)"
}

# ── argv ──
FRESH=0
METHOD="${OC_V5_WORKTREE_METHOD:-symlink}"
DONOR="$CANONICAL"
HEAL_PATH=""
DO_REPORT=0
DO_SELFTEST=0
BRANCH_OVERRIDE=""
PATH_OVERRIDE=""
NAME=""
BASE_BRANCH="$DEFAULT_BASE"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh) FRESH=1; shift ;;
    --heal) HEAL_PATH="${2:-}"; shift 2 ;;
    --report) DO_REPORT=1; shift ;;
    --self-test-share) DO_SELFTEST=1; shift ;;
    --donor) DONOR="${2:-}"; shift 2 ;;
    --method) METHOD="${2:-}"; shift 2 ;;
    --base-dir) BASE_DIR="${2:-}"; shift 2 ;;
    --branch) BRANCH_OVERRIDE="${2:-}"; shift 2 ;;
    --path) PATH_OVERRIDE="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "未知参数:$1" ;;
    *)
      if [[ -z "$NAME" ]]; then
        NAME="$1"
      elif [[ "$BASE_BRANCH" == "$DEFAULT_BASE" ]]; then
        BASE_BRANCH="$1"
      else
        die "多余参数:$1"
      fi
      shift
      ;;
  esac
done

[[ "$METHOD" == symlink || "$METHOD" == hardlink ]] || die "--method 只接受 symlink|hardlink"

if [[ "$DO_REPORT" == 1 ]]; then
  report_duplicates
  exit 0
fi
if [[ "$DO_SELFTEST" == 1 ]]; then
  self_test_share "$DONOR"
  exit 0
fi
if [[ -n "$HEAL_PATH" ]]; then
  heal_worktree "$HEAL_PATH"
  exit $?
fi
[[ -n "$NAME" ]] || { usage >&2; exit 2; }
create_worktree "$NAME" "$BASE_BRANCH" "$FRESH" "$METHOD" "$DONOR"
