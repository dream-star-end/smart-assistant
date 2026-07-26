#!/usr/bin/env bash
# ------------------------------------------------------------
# ccb-upstream.sh — CCB(claude-code-best)vendored fork 的上游跟进工具
# ------------------------------------------------------------
# 背景:claude-code-best/ 是 vendored 的完整上游项目,是 v5 全部 Claude turn 的
# 唯一执行底座。历史上它是"一次性 vendored + 直接改源码",没有跟进机制,升级成本
# 随时间单调上升。本脚本 + claude-code-best/UPSTREAM.md 把跟进变成可重复操作。
#
# 核心设计:**不手工维护 patch 文件**。UPSTREAM.md 里 pin 了 vendored 时的上游
# commit,定制层 = `git diff <pin> HEAD`,由 git 现算 —— 永不腐坏。
#
# 用法:
#   scripts/ccb-upstream.sh status          当前 pin vs 上游最新,落后多少
#   scripts/ccb-upstream.sh diff [--stat]   导出定制层(相对 pin 的净改动)
#   scripts/ccb-upstream.sh plan <tag>      三方合并预演:冲突面 + 协议闸门
#
# 上游镜像缓存在 $OC_CCB_UPSTREAM_CACHE(默认 /var/cache/oc-ccb-upstream.git),
# 不存在则首次自动 clone(~95MB)。
# ------------------------------------------------------------
set -euo pipefail

UPSTREAM_URL="https://github.com/claude-code-best/claude-code.git"
CACHE="${OC_CCB_UPSTREAM_CACHE:-/var/cache/oc-ccb-upstream.git}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CCB_DIR="$REPO_ROOT/claude-code-best"
UPSTREAM_MD="$CCB_DIR/UPSTREAM.md"

die() { echo "✗ $*" >&2; exit 1; }

[ -d "$CCB_DIR" ] || die "找不到 $CCB_DIR"
[ -f "$UPSTREAM_MD" ] || die "找不到 $UPSTREAM_MD —— pin 的单一权威缺失"

# pin 从 UPSTREAM.md 读(单一权威,避免脚本里再存一份造成双权威)
read_pin() {
  local pin
  pin="$(grep -E '^\| *pinned commit *\|' "$UPSTREAM_MD" \
         | sed -E 's/.*`([0-9a-f]{7,40})`.*/\1/' | head -1)"
  [ -n "$pin" ] || die "UPSTREAM.md 里解析不到 pinned commit(表格行格式变了?)"
  printf '%s' "$pin"
}

ensure_cache() {
  if [ ! -d "$CACHE" ]; then
    echo "→ 首次使用,克隆上游镜像到 $CACHE …" >&2
    mkdir -p "$(dirname "$CACHE")"
    git clone --bare --quiet "$UPSTREAM_URL" "$CACHE" || die "克隆上游失败(检查出网)"
  fi
  git --git-dir="$CACHE" fetch --quiet --tags --force origin '+refs/heads/*:refs/remotes/origin/*' 2>/dev/null \
    || echo "⚠ fetch 上游失败,用本地缓存继续(结果可能不是最新)" >&2
}

# 把 vendored 目录当前状态导入上游镜像,parent 设为 pin —— 这样 git 能正确做三方
# 合并(base=pin / ours=我们的定制 / theirs=目标 tag)。产出分支名回显到 stdout。
build_fork_branch() {
  local pin="$1" wt branch
  wt="$(mktemp -d)"; branch="oc-fork-$$"
  git --git-dir="$CACHE" --work-tree="$wt" checkout -q -f "$pin" -- . 2>/dev/null \
    || die "checkout pin $pin 失败"
  # 不带 --delete:我们 vendored 时有意排除的上游文件(bun.lock 等)不应表现为删除
  rsync -a --exclude .git "$CCB_DIR/" "$wt/" 2>/dev/null || die "rsync vendored 目录失败"
  git --git-dir="$CACHE" --work-tree="$wt" add -A >/dev/null 2>&1
  local tree commit
  tree="$(git --git-dir="$CACHE" --work-tree="$wt" write-tree)"
  # 身份与时间戳显式固定:不依赖宿主 git 全局配置(裸机/CI 上常没配),
  # 且同一 vendored 状态每次算出同一个 commit sha(可复现、可缓存)。
  commit="$(echo "oc: v5 定制层(相对 $pin 的净改动)" \
            | GIT_AUTHOR_NAME=oc GIT_AUTHOR_EMAIL=oc@local \
              GIT_COMMITTER_NAME=oc GIT_COMMITTER_EMAIL=oc@local \
              GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' \
              GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' \
              git --git-dir="$CACHE" commit-tree "$tree" -p "$pin")"
  git --git-dir="$CACHE" branch -f "$branch" "$commit" >/dev/null 2>&1
  rm -rf "$wt"
  printf '%s' "$branch"
}

latest_tag() {
  git --git-dir="$CACHE" for-each-ref --sort=-creatordate \
    --format='%(refname:short)' 'refs/tags/v[0-9]*' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
}

cmd_status() {
  local pin latest behind branch custom
  pin="$(read_pin)"; ensure_cache
  latest="$(latest_tag)"
  behind="$(git --git-dir="$CACHE" rev-list --count "$pin..refs/tags/$latest" 2>/dev/null || echo '?')"
  branch="$(build_fork_branch "$pin")"
  custom="$(git --git-dir="$CACHE" diff --shortstat "$pin" "$branch" 2>/dev/null | sed 's/^ *//')"
  git --git-dir="$CACHE" branch -D "$branch" >/dev/null 2>&1 || true

  echo "上游      : $UPSTREAM_URL"
  echo "当前 pin  : $pin  ($(git --git-dir="$CACHE" log -1 --format='%ad %s' --date=short "$pin" 2>/dev/null))"
  echo "上游最新  : $latest  ($(git --git-dir="$CACHE" log -1 --format='%ad' --date=short "refs/tags/$latest" 2>/dev/null))"
  echo "落后      : $behind commits"
  echo "定制层    : ${custom:-(算不出)}"
  [ "$behind" != "0" ] && { echo; echo "→ 预演升级: $0 plan $latest"; }
  return 0
}

cmd_diff() {
  local pin branch; pin="$(read_pin)"; ensure_cache
  branch="$(build_fork_branch "$pin")"
  git --git-dir="$CACHE" diff "$pin" "$branch" "$@"
  git --git-dir="$CACHE" branch -D "$branch" >/dev/null 2>&1 || true
}

cmd_plan() {
  local target="${1:-}" pin branch
  [ -n "$target" ] || die "用法: $0 plan <tag>   (如 v2.8.4)"
  pin="$(read_pin)"; ensure_cache
  git --git-dir="$CACHE" rev-parse -q --verify "refs/tags/$target" >/dev/null \
    || die "上游没有 tag $target"

  echo "═══ 升级预演: $pin → $target ═══"
  echo "上游跨度  : $(git --git-dir="$CACHE" rev-list --count "$pin..refs/tags/$target") commits"
  git --git-dir="$CACHE" diff --shortstat "$pin" "refs/tags/$target" 2>/dev/null | sed 's/^/上游改动  :/'
  echo

  # ── 协议闸门:stream-json 帧类型只增不减 ──────────────────────────
  # gateway ccbMessageParser 吃这些帧,且 codex 引擎复用同一解析器。
  # 帧类型消失 = 停,先改 parser 再升(见 UPSTREAM.md §3)。
  local before after gone
  before="$(git --git-dir="$CACHE" show "$pin:src/cli/print.ts" 2>/dev/null \
            | grep -oE "type: *'[a-z_]+'" | sed -E "s/.*'(.*)'/\1/" | sort -u)"
  after="$(git --git-dir="$CACHE" show "refs/tags/$target:src/cli/print.ts" 2>/dev/null \
           | grep -oE "type: *'[a-z_]+'" | sed -E "s/.*'(.*)'/\1/" | sort -u)"
  if [ -z "$after" ]; then
    echo "⚠ 协议闸门 : src/cli/print.ts 在 $target 不在原路径 —— 需人工确认输出层位置"
  else
    gone="$(comm -23 <(echo "$before") <(echo "$after") | tr '\n' ' ')"
    if [ -n "${gone// /}" ]; then
      echo "✗ 协议闸门 : 帧类型消失 → $gone"
      echo "             必须先改 packages/gateway/src/ccbMessageParser.ts 再升级"
    else
      echo "✓ 协议闸门 : stream-json 帧类型只增不减(新增: $(comm -13 <(echo "$before") <(echo "$after") | tr '\n' ' '))"
    fi
  fi
  echo

  # ── 三方合并预演 ────────────────────────────────────────────────
  branch="$(build_fork_branch "$pin")"

  # merge-tree --write-tree --name-only 的 stdout 分三段,以空行分隔:
  #   ① tree oid  ② 冲突文件清单  ③ 人类可读的冲突说明
  # 只取 ②(awk 见空行即停),否则 ③ 的说明行会被误计成冲突文件。
  local merged conflicts info
  merged="$(git --git-dir="$CACHE" merge-tree --write-tree --name-only \
            "$branch" "refs/tags/$target" 2>/dev/null || true)"
  conflicts="$(printf '%s\n' "$merged" | awk 'NR>1 { if ($0 == "") exit; print }')"
  info="$(printf '%s\n' "$merged" | awk 'f { print } /^$/ { f=1 }')"

  if [ -z "$conflicts" ]; then
    echo "✓ 三方合并 : 无冲突,可直接合"
  else
    echo "冲突文件  : $(printf '%s\n' "$conflicts" | wc -l) 个"
    printf '%s\n' "$conflicts" | sed 's/^/            /'
    # 按类型归类:内容冲突要逐块裁定,file location 只是 rename 建议(照搬即可)
    echo
    echo "  内容冲突      : $(printf '%s\n' "$info" | grep -c 'CONFLICT (content)' || true) 处"
    echo "  路径搬迁建议  : $(printf '%s\n' "$info" | grep -c 'CONFLICT (file location)' || true) 处(按建议移动即可)"
    echo "  modify/delete : $(printf '%s\n' "$info" | grep -c 'CONFLICT (modify/delete)' || true) 处(需判定上游是否已内建)"
  fi

  git --git-dir="$CACHE" branch -D "$branch" >/dev/null 2>&1 || true
  echo
  echo "→ 实际合并在 worktree 内做,流程见 claude-code-best/UPSTREAM.md §4"
}

case "${1:-}" in
  status) shift; cmd_status "$@" ;;
  diff)   shift; cmd_diff "$@" ;;
  plan)   shift; cmd_plan "$@" ;;
  *) sed -n '/^# 用法:/,/^# ---/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//' ; exit 1 ;;
esac
