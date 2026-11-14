#!/usr/bin/env bash
# push 到 feat/v5-aurora-rewrite 时判断:这次 push 的 commit 的 tree,是否已被某次全绿的 pull_request
# 运行**原样测过**。是 → skip=true,v5-ci.yml 的重 job 全部跳过。
#
# 为什么(2026-10-08 devflow-opt):每次合并后 push 都把 23 个 job 原样再跑一遍(14–20 分钟 runner),
# 与并行中的 PR 抢 runner(实测别的 PR 的 job 因此晚起 15 / 55 分钟)。最近 15 次合并里 12 次
# merge commit 的 tree 与 PR head 完全相同。
#
# 证据链(全部满足才 skip):
#   1. push commit 的某个父提交 p 与 push commit 同 tree(候选:合并进来的 PR head);
#   2. 本 workflow 对 head_sha=p 的**最近一次** pull_request 运行 completed/success;
#   3. 该运行的 tested-tree job 上传的 ci-tested-tree 产物里记录的 tree(= 它 checkout 的
#      refs/pull/N/merge 的 tree,即真正被测的内容)与 push commit 的 tree 逐字节相同。
#   第 3 条是关键:pull_request 运行测的是当时的合并预览,不是 PR head;base 在运行后变过时,
#   被测内容可能与最终合并结果不同,只看 head_sha 不够。
# tree 不同(base 前进、合并引入别的改动 —— 正是 strict=false 下 push CI 要抓的语义冲突)一律全量跑。
# 任何查询/下载失败、产物缺失(本机制上线前的旧运行)→ skip=false(全量跑),绝不因为本脚本出错而少跑。
# 发布门也不信任这里的结论:deploy-v5.sh 的 CI 绿门不把 skipped 当绿,会自己按 same-tree 规则核对父提交。
#
# 用法: ci-same-tree-evidence.sh <sha>     需要 GH_TOKEN、GH_REPO;结论写 $GITHUB_OUTPUT(未设则只打印)。
set -uo pipefail

sha="${1:-}"
repo="${GH_REPO:-}"
workflow="${CI_WORKFLOW_FILE:-v5-ci.yml}"
out="${GITHUB_OUTPUT:-/dev/null}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

emit() { # <true|false> <why>
  printf 'skip=%s\n' "$1" >>"$out"
  echo "same-tree-evidence: skip=$1 — $2"
  exit 0
}

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || emit false "sha 非法:'$sha'"
[[ -n "$repo" ]] || emit false "缺 GH_REPO"

commit="$(gh api "repos/$repo/git/commits/$sha" 2>/dev/null)" || emit false "查询 commit 失败"
tree="$(jq -r '.tree.sha // empty' <<<"$commit" 2>/dev/null)"
[[ "$tree" =~ ^[0-9a-f]{40}$ ]] || emit false "取不到 tree"
parents="$(jq -r '.parents[]?.sha // empty' <<<"$commit" 2>/dev/null)"
[[ -n "$parents" ]] || emit false "没有父提交"

while IFS= read -r p; do
  [[ "$p" =~ ^[0-9a-f]{40}$ ]] || continue
  ptree="$(gh api "repos/$repo/git/commits/$p" --jq '.tree.sha' 2>/dev/null)" || continue
  if [[ "$ptree" != "$tree" ]]; then
    echo "  · 父 ${p:0:12}:tree 不同,不复用"
    continue
  fi
  latest="$(gh api "repos/$repo/actions/workflows/$workflow/runs?head_sha=$p&event=pull_request&per_page=50" \
    --jq '[.workflow_runs[]] | sort_by(.created_at) | last | if . == null then "" else "\(.status) \(.conclusion // "none") \(.id)" end' 2>/dev/null)" || continue
  read -r st concl rid <<<"$latest"
  if [[ "$st" != completed || "$concl" != success || ! "$rid" =~ ^[0-9]+$ ]]; then
    echo "  · 父 ${p:0:12}:tree 相同但最近的 pull_request 运行不是全绿(${latest:-无运行})"
    continue
  fi
  rm -rf "$work/a"
  if ! gh run download "$rid" -R "$repo" -n ci-tested-tree -D "$work/a" >/dev/null 2>&1; then
    echo "  · 父 ${p:0:12}:运行 $rid 没有 ci-tested-tree 产物(或下载失败),无法证明被测 tree"
    continue
  fi
  tested="$(tr -d '[:space:]' <"$work/a/tree" 2>/dev/null)"
  if [[ "$tested" == "$tree" ]]; then
    emit true "pull_request 运行 $rid(head ${p:0:12})全绿,且其被测 tree 与本 commit 的 tree 相同"
  fi
  echo "  · 父 ${p:0:12}:运行 $rid 被测 tree=${tested:-?} ≠ 本 commit tree=$tree(base 在运行后变过)"
done <<<"$parents"

emit false "没有「被测 tree 与本 commit 相同且全绿」的 pull_request 运行"
