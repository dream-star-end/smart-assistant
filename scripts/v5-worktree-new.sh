#!/usr/bin/env bash
# v5-worktree-new.sh — 创建 V5 worktree 并复用第三方依赖 / tsc 增量缓存。
#
# 第三方依赖从 donor 共享(省 npm ci)。工作区包(@openclaude/*)必须自指回
# **本 worktree** 的 packages/,绝不能整棵软链 node_modules —— Node 会解析到
# donor 源码,门绿但验的是别人的树。
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
  scripts/v5-worktree-new.sh --self-check <worktree-path>
  scripts/v5-worktree-new.sh --report
  scripts/v5-worktree-new.sh --self-test-share

Options:
  --donor PATH          依赖/缓存来源(默认 /opt/openclaude/openclaude-v5-aurora)
  --method symlink|hardlink   第三方依赖的共享方式;工作区包一律自指本树
  --base-dir PATH       worktree 父目录(默认 /opt/openclaude)
  --branch NAME         新分支名(默认 feat/v5-<name>)
  --path PATH           worktree 路径(默认 <base-dir>/openclaude-v5-<name>)
  --fresh               不复用,在新 worktree 里 npm ci
  --heal PATH           拆整棵 donor 软链、把 @openclaude/* 自指回本树
  --self-check PATH     只跑工作区自指断言(不改树)
  --report              列出重复 node_modules 磁盘占用;绝不删除
  --self-test-share     在临时目录实测第三方共享 + 工作区自指

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

# stdout: "name<TAB>relpath" 一行一个工作区包。无 package.json 则空。
list_workspace_packages() {
  local root="$1"
  python3 - "$root" <<'PY'
import json, glob, os, sys
root = sys.argv[1]
pj = os.path.join(root, "package.json")
if not os.path.isfile(pj):
    sys.exit(0)
meta = json.load(open(pj))
for pat in meta.get("workspaces") or []:
    for d in glob.glob(os.path.join(root, pat)):
        pkg = os.path.join(d, "package.json")
        if not os.path.isfile(pkg):
            continue
        name = json.load(open(pkg)).get("name") or ""
        if name:
            print(f"{name}\t{os.path.relpath(d, root)}")
PY
}

link_third_party() {
  local src="$1" dst="$2" method="$3"
  if [[ "$method" == hardlink ]]; then
    cp -al "$src" "$dst"
  else
    ln -s "$src" "$dst"
  fi
}

# 拆开共享:第三方条目链到 donor, @openclaude/* 绝对软链回本树 packages/。
share_root_node_modules() {
  local donor="$1" wt="$2" method="$3"
  local src="$donor/node_modules" dst="$wt/node_modules"
  if [[ -L "$dst" ]]; then
    echo "  · 拆除整棵 node_modules 软链(会把 @openclaude 解析进 donor)"
    rm -f "$dst"
  fi
  mkdir -p "$dst"

  local entry name
  shopt -s dotglob nullglob
  for entry in "$src"/*; do
    name="$(basename "$entry")"
    [[ "$name" == @openclaude ]] && continue
    if [[ -e "$dst/$name" || -L "$dst/$name" ]]; then
      continue
    fi
    link_third_party "$entry" "$dst/$name" "$method"
  done
  shopt -u dotglob nullglob

  rebind_workspace_packages "$wt"
  echo "  · 根 node_modules:第三方→$method donor, @openclaude/* → 本树 packages/"
}

rebind_workspace_packages() {
  local wt="$1" name rel dest
  if [[ ! -f "$wt/package.json" ]]; then
    echo "  · 无 package.json,跳过工作区自指"
    return 0
  fi
  # 整棵 @openclaude 若是指向 donor 的软链,mkdir -p 会跟进去改 donor。先拆掉。
  if [[ -L "$wt/node_modules/@openclaude" ]]; then
    rm -f "$wt/node_modules/@openclaude"
  fi
  mkdir -p "$wt/node_modules/@openclaude"
  while IFS=$'\t' read -r name rel; do
    [[ -n "$name" ]] || continue
    dest="$wt/node_modules/${name}"
    mkdir -p "$(dirname "$dest")"
    rm -f "$dest"
    ln -sfn "$wt/$rel" "$dest"
    echo "  · 自指 $name -> $wt/$rel"
  done < <(list_workspace_packages "$wt")
}

share_package_node_modules() {
  local src="$1" dst="$2" method="$3"
  if [[ -e "$dst" || -L "$dst" ]]; then
    return 0
  fi
  [[ -e "$src" ]] || return 0
  # 包级 node_modules 若含 @openclaude,整棵软链同样会泄漏到 donor。
  if [[ -e "$src/@openclaude" || -L "$src/@openclaude" ]]; then
    mkdir -p "$dst"
    local entry name
    shopt -s dotglob nullglob
    for entry in "$src"/*; do
      name="$(basename "$entry")"
      [[ "$name" == @openclaude ]] && continue
      link_third_party "$entry" "$dst/$name" "$method"
    done
    shopt -u dotglob nullglob
    echo "  · 包级拆分 $dst (去掉 @openclaude,避免二次泄漏)"
  else
    mkdir -p "$(dirname "$dst")"
    link_third_party "$src" "$dst" "$method"
    echo "  · 包级第三方 $dst -> $src"
  fi
}

share_all_node_modules() {
  local donor="$1" wt="$2" method="$3" src rel
  share_root_node_modules "$donor" "$wt" "$method"
  while IFS= read -r src; do
    rel="${src#"$donor"/}"
    share_package_node_modules "$src" "$wt/$rel" "$method"
  done < <(find "$donor/packages" -mindepth 2 -maxdepth 4 -type d -name node_modules 2>/dev/null || true)
}

# 0=通过。有 workspaces 时每个包的 realpath 必须在本树内;
# 非 --fresh 时第三方(typescript/tsx)必须仍落在 donor 内。
assert_workspace_self_point() {
  local wt="$1" donor="${2:-}"
  local name rel dest real wt_real leaked=0 expected=0
  wt_real="$(realpath "$wt")"
  while IFS=$'\t' read -r name rel; do
    [[ -n "$name" ]] || continue
    expected=$((expected + 1))
    dest="$wt/node_modules/${name}"
    if [[ ! -e "$dest" && ! -L "$dest" ]]; then
      echo "✗ 自检失败:缺少 $dest($name → $rel)" >&2
      leaked=1
      continue
    fi
    real="$(realpath "$dest")"
    if [[ "$real" != "$wt_real" && "$real" != "$wt_real"/* ]]; then
      echo "✗ 自检失败:$name → $real 不在本树 $wt_real" >&2
      echo "  Node 会解析软链到真实路径。整棵 node_modules 链到 donor 时,相对 ../../packages 会落到 donor 源码。" >&2
      leaked=1
    fi
  done < <(list_workspace_packages "$wt")
  if [[ "$expected" -gt 0 && "$leaked" != 0 ]]; then
    return 2
  fi
  if [[ "$expected" -gt 0 && ! -d "$wt/node_modules/@openclaude" ]]; then
    echo "✗ 自检失败:没有 $wt/node_modules/@openclaude —— 工作区包未自指,门会验到别的树" >&2
    return 2
  fi

  if [[ -n "$donor" && -d "$donor/node_modules" ]]; then
    local donor_real sample
    donor_real="$(realpath "$donor")"
    for sample in typescript tsx; do
      if [[ -e "$wt/node_modules/$sample" ]]; then
        real="$(realpath "$wt/node_modules/$sample")"
        if [[ "$real" != "$donor_real" && "$real" != "$donor_real"/* ]]; then
          echo "✗ 自检失败:第三方 $sample → $real 不在 donor $donor_real(共享被破坏)" >&2
          return 2
        fi
      fi
    done
    echo "  · 自检通过:工作区包 ${expected} 个全在本树内,第三方仍指向 donor"
  else
    echo "  · 自检通过:工作区包 ${expected} 个全在本树内"
  fi
  return 0
}

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

  echo "══ v5-worktree-new name=$name base=$base_branch method=$method fresh=$fresh ══"
  echo "  donor=$donor"
  echo "  path=$path"
  echo "  branch=$branch"

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
    assert_workspace_self_point "$path" "" || die "工作区自指自检失败,拒绝交付这棵树"
  else
    echo "── 复用第三方依赖($method)并自指工作区包──"
    share_all_node_modules "$donor" "$path" "$method"
    verify_bins "$path"
    assert_workspace_self_point "$path" "$donor" || die "工作区自指自检失败,拒绝交付这棵树"
    echo "── 安装 tsc 增量缓存──"
    install_tsc_cache "$donor" "$path" "$head"
  fi
  write_stamp "$path" "$donor" "$method" "$head" "$base_branch" "$fresh"
  echo "✓ worktree 就绪:$path"
  printf '%s\n' "$path"
}

infer_donor_from_tree() {
  local wt="$1" explicit="$2"
  if [[ -n "$explicit" && -d "$explicit/node_modules" ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  if [[ -f "$wt/$STAMP_NAME" ]]; then
    python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('donor',''))" "$wt/$STAMP_NAME"
    return 0
  fi
  if [[ -L "$wt/node_modules" ]]; then
    local nm
    nm="$(realpath "$wt/node_modules")"
    printf '%s\n' "$(dirname "$nm")"
    return 0
  fi
  if [[ -L "$wt/node_modules/typescript" ]]; then
    printf '%s\n' "$(dirname "$(dirname "$(realpath "$wt/node_modules/typescript")")")"
    return 0
  fi
  return 1
}

heal_worktree() {
  local wt="$1"
  [[ -d "$wt" ]] || die "worktree 不存在:$wt"

  echo "══ heal $wt ══"
  local donor method=symlink
  donor="$(infer_donor_from_tree "$wt" "$DONOR")" || {
    echo "✗ 无法推断 donor。请加 --donor /opt/openclaude/openclaude-v5-aurora" >&2
    return 2
  }
  donor="$(resolve_donor "$donor")"
  if [[ -f "$wt/$STAMP_NAME" ]]; then
    method="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('method','symlink'))" "$wt/$STAMP_NAME" 2>/dev/null || echo symlink)"
  fi
  [[ "$method" == hardlink || "$method" == symlink ]] || method=symlink

  local broken=0
  if [[ -L "$wt/node_modules" ]]; then
    echo "  · 整棵 node_modules 是软链 — 这会把 @openclaude 解析进 donor,正在拆开重绑"
    rm -f "$wt/node_modules"
    share_all_node_modules "$donor" "$wt" "$method"
    broken=1
  elif [[ -d "$wt/node_modules/@openclaude" ]]; then
    echo "  · 重绑 @openclaude/* 到本树"
    rebind_workspace_packages "$wt"
    broken=1
  fi

  if [[ ! -x "$wt/node_modules/.bin/tsc" ]] || ! "$wt/node_modules/.bin/tsc" --version >/dev/null 2>&1; then
    echo "  · .bin 不可用 — 重新共享第三方"
    share_all_node_modules "$donor" "$wt" "$method"
    broken=1
  else
    echo "  · .bin 正常"
  fi

  if ! assert_workspace_self_point "$wt" "$donor"; then
    echo "  · 自检仍失败,再拆一次根 node_modules 重绑"
    if [[ -L "$wt/node_modules" ]]; then
      rm -f "$wt/node_modules"
    elif [[ -d "$wt/node_modules/@openclaude" ]]; then
      rm -rf "$wt/node_modules/@openclaude"
    fi
    share_all_node_modules "$donor" "$wt" "$method"
    assert_workspace_self_point "$wt" "$donor" || die "heal 后自检仍失败"
    broken=1
  fi

  local stamp_head current
  if [[ -f "$wt/$STAMP_NAME" ]]; then
    stamp_head="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('head',''))" "$wt/$STAMP_NAME" 2>/dev/null || true)"
    current="$(git -C "$wt" rev-parse HEAD 2>/dev/null || true)"
    if [[ -n "$stamp_head" && -n "$current" && "$stamp_head" != "$current" ]]; then
      echo "  · HEAD 已离开缓存桶($stamp_head → $current) — 丢弃本树 tsbuildinfo"
      find "$wt/packages" \( -name .tsbuildinfo -o -name tsconfig.tsbuildinfo \) \
        -not -path '*/node_modules/*' -delete 2>/dev/null || true
      broken=1
    fi
  fi

  verify_bins "$wt"
  echo "✓ heal 完成(workspace 自指已修复,第三方仍共享 donor=$donor)"
  return 0
}

report_duplicates() {
  echo "══ V5 worktree node_modules 回收报告(只列不删)══"
  echo "扫描 $BASE_DIR/openclaude-v5* …"
  local n_real=0 n_link=0 total=0
  local path kind size
  printf '%-10s %12s  %s\n' "KIND" "BYTES" "PATH"
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
  # 用 donor 自己当「假 worktree 根」会自指回 donor,只能测 .bin。
  # 完整自指测试见 __tests__/v5WorktreeNew.test.ts。
  local method dir
  for method in symlink hardlink; do
    dir="$tmp/$method"
    mkdir -p "$dir"
    # 最小:只链第三方 typescript
    mkdir -p "$dir/node_modules"
    link_third_party "$donor/node_modules/typescript" "$dir/node_modules/typescript" "$method"
    link_third_party "$donor/node_modules/.bin" "$dir/node_modules/.bin" symlink
    echo "  $method tsc=$("$dir/node_modules/.bin/tsc" --version 2>/dev/null || echo FAIL)"
  done
  rm -rf "$tmp"
  echo "✓ self-test-share 完成(临时目录已清)"
}

FRESH=0
METHOD="${OC_V5_WORKTREE_METHOD:-symlink}"
DONOR="$CANONICAL"
HEAL_PATH=""
SELF_CHECK_PATH=""
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
    --self-check) SELF_CHECK_PATH="${2:-}"; shift 2 ;;
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
if [[ -n "$SELF_CHECK_PATH" ]]; then
  [[ -d "$SELF_CHECK_PATH" ]] || die "worktree 不存在:$SELF_CHECK_PATH"
  donor="$(infer_donor_from_tree "$SELF_CHECK_PATH" "$DONOR" || true)"
  assert_workspace_self_point "$SELF_CHECK_PATH" "$donor"
  exit $?
fi
[[ -n "$NAME" ]] || { usage >&2; exit 2; }
create_worktree "$NAME" "$BASE_BRANCH" "$FRESH" "$METHOD" "$DONOR"
