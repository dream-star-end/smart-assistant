#!/usr/bin/env bash
# v5-migration-claim.sh — 开写迁移之前先「申领」编号(只读)。
#
# 为什么要有它(2026-08-15 并行开发审计):
#   仓库同时挂着 80+ worktree。迁移是新建文件,**git 不会报重号冲突**,而
#   migrate.ts 的 out-of-order 门要求严格递增 —— 两支撞号时,先 apply 大号的那支
#   会让小号那支在部署期 MigrationIntegrityError、整个迁移运行 fail-closed。
#   事后检测太晚(代码全写完、编号散落在 SQL/测试/清单/对象名五处才发现要让号),
#   所以把它前移成开写前的一条命令。
#
# 只读:只跑 git ls-tree / ls,不改任何文件、不 fetch 写引用(除非 --fetch)。
#
# 用法:
#   scripts/v5-migration-claim.sh              # 占号表 + 建议编号
#   scripts/v5-migration-claim.sh --fetch      # 先 git fetch,再扫(跨机器协作时用)
#   BRANCH_SCAN_LIMIT=60 scripts/v5-migration-claim.sh
#
# 申领到编号之后:
#   * 若建议号 = canonical 最高号 + 1 → 直接用,没有顺序依赖。
#   * 若中间有别人占着的号(输出里会标 GAP)→ 你是后落的一方,必须在迁移文件头写
#       -- order-dependency: <那支的 version>
#     并在 PR 正文写明发布顺序。这条依赖消除不掉:让号只能改变方向,完整性门要求
#     的就是严格递增。scripts/check-migration-order.ts 会在 CI 里强制这条声明。

set -euo pipefail

CANONICAL_REF="${CANONICAL_REF:-origin/feat/v5-aurora-rewrite}"
BRANCH_SCAN_LIMIT="${BRANCH_SCAN_LIMIT:-40}"
MIG_DIR="packages/commercial/src/db/migrations"

cd "$(git rev-parse --show-toplevel)"

if [ "${1:-}" = "--fetch" ]; then
  echo "fetching origin ..." >&2
  git fetch origin -q
fi

versions_in_ref() {
  git ls-tree --name-only "$1" "$MIG_DIR/" 2>/dev/null |
    sed -n "s#^$MIG_DIR/\([0-9]\{4\}_[a-z0-9_]*\)\.sql\$#\1#p"
}

CANON_MAX="$(versions_in_ref "$CANONICAL_REF" | sort | tail -1)"
if [ -z "$CANON_MAX" ]; then
  echo "✗ 读不到 $CANONICAL_REF 的迁移目录;先 git fetch,或用 CANONICAL_REF= 指定正确的 canonical。" >&2
  exit 2
fi
CANON_NUM="${CANON_MAX:0:4}"

echo "canonical($CANONICAL_REF) 最高迁移号: $CANON_MAX"
echo
echo "占号表(高于 canonical 的在途编号):"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# a) 各 worktree 的工作区(含未提交/未跟踪的新文件 —— 并行会话最常见的状态就是
#    "正在写、还没 commit",只看远端分支会直接漏掉)。
git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
  [ -d "$wt/$MIG_DIR" ] || continue
  br="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  ls "$wt/$MIG_DIR" 2>/dev/null |
    sed -n 's#^\([0-9]\{4\}_[a-z0-9_]*\)\.sql$#\1#p' |
    while read -r v; do
      if [ "$v" \> "$CANON_MAX" ]; then
        printf '%s\tworktree %s [%s]\n' "$v" "$(basename "$wt")" "$br"
      fi
    done
done >> "$TMP"

# b) 最近推过的远端分支(已 push 但 worktree 已删的情况)。
# 用 --count 而不是 `| head`:后者在 refs 很多时会让 for-each-ref 吃 SIGPIPE,
# 在 `set -o pipefail` 下把整个脚本带死。
git for-each-ref --count="$BRANCH_SCAN_LIMIT" --sort=-committerdate \
  --format='%(refname:short)' refs/remotes/origin | while read -r br; do
    versions_in_ref "$br" | while read -r v; do
      if [ "$v" \> "$CANON_MAX" ]; then
        printf '%s\tremote %s\n' "$v" "$br"
      fi
    done
  done >> "$TMP"

if [ -s "$TMP" ]; then
  sort -u "$TMP" | awk -F'\t' '{ if ($1 != last) { printf "  %-34s %s\n", $1, $2; last=$1 } else printf "  %-34s %s\n", "", $2 }'
else
  echo "  (无)"
fi

TAKEN_MAX="$(cut -f1 "$TMP" | sort | tail -1)"
BASE_NUM="$CANON_NUM"
[ -n "$TAKEN_MAX" ] && BASE_NUM="${TAKEN_MAX:0:4}"
NEXT="$(printf '%04d' $((10#$BASE_NUM + 1)))"

echo
echo "建议申领: $NEXT"
if [ -n "$TAKEN_MAX" ]; then
  echo "  ⚠ GAP:$((10#$BASE_NUM - 10#$CANON_NUM)) 个在途编号排在你前面(见上表)。"
  echo "    你是后落的一方 —— 迁移文件头必须声明:"
  echo "      -- order-dependency: $TAKEN_MAX"
  echo "    并在 PR 正文写明「先合并并 apply $TAKEN_MAX,再合本支」。反了会让对方的迁移"
  echo "    运行整体 fail-closed。若那支后来被放弃,把声明改成 \`none <理由>\`,并重跑本脚本"
  echo "    确认当时的建议编号(不要凭记忆挪到某个别人可能已占的号)。"
else
  echo "  无在途占号,直接用即可,无顺序依赖。"
fi
