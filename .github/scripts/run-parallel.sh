#!/usr/bin/env bash
# 在同一个 CI job 里并行跑几组互相独立的门,check 上下文名不变。
#
# 为什么(2026-10-08 devflow-opt):`web-react` 是 required check,原先串行跑
# check:v5:incidents(约 7 分钟)→ e2e-selectors → tutorials → test:web-react(vitest
# --maxWorkers=1,约 7.5 分钟),整条 PR CI 的关键路径就是它(15–20 分钟,其余 job ≤10 分钟)。
# 拆成两个 job 会让事故门离开 required context 与发布 CI 绿门 —— 等于削门;所以留在同一 job 里并行。
#
# 语义:每组用 `bash -eo pipefail -c` 跑;输出实时打印,每行带 [组号] 前缀(挂死到 job 超时也留得下日志;
# `::` 开头的工作流命令行不加前缀);
# 全部结束后打印汇总;任一组非零 → 本脚本退出 1。组内的命令顺序与 && 短路不变。
#
# 用法: run-parallel.sh '<cmd1>' '<cmd2>' ...
set -uo pipefail

[[ $# -ge 1 ]] || { echo "usage: run-parallel.sh '<cmd>' ['<cmd>' ...]" >&2; exit 2; }

pids=()
i=0
for cmd in "$@"; do
  i=$((i + 1))
  echo "[run-parallel] 启动组 [$i]: $cmd"
  # 外层 pipefail 让组的退出码穿过 sed;sed -u 逐行刷新,不攒缓冲。
  # 以 `::` 开头的 GitHub 工作流命令(::error:: / ::group:: 等)不加前缀,保持注解可识别。
  bash -o pipefail -c "bash -eo pipefail -c \"\$1\" 2>&1 | sed -u \"/^::/!s/^/[\$2] /\"" _ "$cmd" "$i" &
  pids+=("$!")
done

rc=0
summary=()
i=0
for cmd in "$@"; do
  pid="${pids[$i]}"
  i=$((i + 1))
  if wait "$pid"; then st=0; else st=$?; fi
  summary+=("[$i] rc=$st :: $cmd")
  if [[ "$st" != 0 ]]; then
    rc=1
    echo "::error::并行组 [$i] 失败(rc=$st):$cmd"
  fi
done

echo "[run-parallel] 汇总:"
printf '  %s\n' "${summary[@]}"
exit "$rc"
