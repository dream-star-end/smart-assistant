#!/usr/bin/env bash
# commercial-unit-gate.sh — 跑 v5 商业 unit 套件并应用基线失败集 diff 门。
# CI 与本地共用同一入口:npm run test:commercial:unit:gate
#
# 前置:PG 测试 fixture(默认 postgres://test:test@127.0.0.1:55432/openclaude_test,
# 可用 TEST_DATABASE_URL 覆盖)。REQUIRE_TEST_DB=1 强制生效,防 DB 门控测试静默 skip。
# 见 docs/V5_CI.md。
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# TAP 产物默认落**进程隔离**路径:仓根固定名会被并发跑(多 agent / 多 worktree 共享树)
# 互相截断 → diff 阶段报假的 "infrastructure failure"(2026-07-12 并行 agent 实测踩中)。
# **坑**:worktree 里 `.git` 是**文件**不是目录,不能直接写 `.git/xxx`(Not a directory)——
# 必须用 `git rev-parse --git-dir` 拿真实 git dir(worktree 下会指向 .../worktrees/<name>)。
# CI 单跑不受影响;要固定路径显式传 TAP_OUT=。
_gitdir="$(git rev-parse --git-dir 2>/dev/null || echo "${TMPDIR:-/tmp}")"
tap_out="${TAP_OUT:-$_gitdir/commercial-unit.$$.tap}"
baseline="${KNOWN_FAILURES:-.github/known-failures/commercial-unit.txt}"

# 防静默 skip:商业测试的 DB 门控是 CI==='true' || REQUIRE_TEST_DB==='1',
# 本地跑 gate 时也强制开启 —— 没有 PG fixture 就应该红,而不是绿着骗人。
export REQUIRE_TEST_DB=1

# ── 挂死看门狗(INC-20260906-COMMERCIAL-UNIT-HANG-DEFAULT-CODEX-MODEL)────────────
# 2026-09-06 PR #557:一条用例 await 容器帧永挂,TAP 从此零增长,job 吃满 30 min 才被
# GitHub cancel,且 cancel 后没有任何 JS 栈可查(两轮 = 1 小时盲等)。这里只看一个事实:
# TAP 文件多久没长。正常基线里最长的顶层套件 ~36s、最长叶用例 ~9s,连续
# COMMERCIAL_UNIT_IDLE_TIMEOUT(默认 240s)零字节增长就是挂死,不是慢。触发时:
#   1) 对 runner 派生的所有 node 进程发 SIGUSR2 → --report-on-signal 落 diagnostic report;
#   2) 把每份 report 的 JS 栈 + 活跃 libuv 句柄摘要以 `# hang-watchdog:` 注释追加进 TAP
#      (TAP 注释不影响 diff-known-failures 的判据;plan/汇总仍缺 → A 判据照样红);
#   3) 整棵进程树 TERM→KILL,退出码统一 124(与 test-mutex 看门狗语义一致)。
# 原始 report 含环境变量,只留在 0700 私有目录、不进 artifact。
idle_limit="${COMMERCIAL_UNIT_IDLE_TIMEOUT:-240}"
report_dir="${COMMERCIAL_UNIT_REPORT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/commercial-unit-reports.XXXXXX")}"
mkdir -p "$report_dir" && chmod 700 "$report_dir"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--report-on-signal --report-signal=SIGUSR2 --report-directory=$report_dir"

descendants() { local p; for p in $(pgrep -P "$1" 2>/dev/null); do echo "$p"; descendants "$p"; done; }
summarize_report() {
  python3 - "$1" <<'PYEOF'
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception as e:  # noqa: BLE001
    print(f"# hang-watchdog: unreadable report {sys.argv[1]}: {e}"); sys.exit(0)
h = r.get("header", {})
print(f"# hang-watchdog: report pid={h.get('processId')} ppid={h.get('parentProcessId')} node={h.get('nodejsVersion')} cmd={' '.join(h.get('commandLine', []))[:300]}")
js = r.get("javascriptStack", {})
print(f"# hang-watchdog:   js: {js.get('message', '')}")
for line in js.get("stack", [])[:25]:
    print(f"# hang-watchdog:     {line.strip()}")
active = [u for u in r.get("libuv", []) if u.get("is_active") and u.get("type") not in ("loop", "async", "signal")]
print(f"# hang-watchdog:   libuv active handles={len(active)}")
for u in active[:25]:
    extra = {k: u[k] for k in ("localEndpoint", "remoteEndpoint", "repeat", "firesInMsFromNow", "expired", "is_referenced") if k in u}
    print(f"# hang-watchdog:     {u.get('type')} {json.dumps(extra, ensure_ascii=False)[:200]}")
PYEOF
}

echo "running: npm run test:commercial:unit (TAP -> $tap_out; idle watchdog ${idle_limit}s; node reports -> $report_dir)"
npm run test:commercial:unit > "$tap_out" 2>&1 &
runner_pid=$!
last_size=-1; idle=0; hang=0
while kill -0 "$runner_pid" 2>/dev/null; do
  sleep 10
  size=$(stat -c %s "$tap_out" 2>/dev/null || echo 0)
  if [[ "$size" != "$last_size" ]]; then last_size=$size; idle=0; continue; fi
  idle=$((idle + 10))
  if (( idle >= idle_limit )); then hang=1; break; fi
done
if (( hang )); then
  echo "::error::commercial-unit hang watchdog: TAP has not grown for ${idle}s (size=${last_size} bytes). Dumping node diagnostic reports, then killing the runner (exit 124). See the '# hang-watchdog:' lines at the TAP tail." >&2
  {
    echo "# hang-watchdog: no TAP growth for ${idle}s at $(date -u +%FT%TZ); size=${last_size} bytes"
    echo "# hang-watchdog: last completed test above; the hung test is the next '# Subtest:' without an ok/not ok, or an unbounded await inside it"
  } >> "$tap_out"
  tree_pids=$(descendants "$runner_pid")
  for p in $tree_pids; do
    cmd=$(tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null || true)
    [[ "$cmd" == *node* ]] || continue
    echo "# hang-watchdog: SIGUSR2 -> pid $p $(grep -o 'src/[^ ]*\.test\.ts' <<<"$cmd" | head -3 | tr '\n' ' ')" >> "$tap_out"
    kill -USR2 "$p" 2>/dev/null || true
  done
  sleep 8
  shopt -s nullglob
  for r in "$report_dir"/*.json; do summarize_report "$r" >> "$tap_out" 2>&1; done
  shopt -u nullglob
  # shellcheck disable=SC2086
  kill -TERM $tree_pids "$runner_pid" 2>/dev/null || true
  sleep 3
  # shellcheck disable=SC2086
  kill -KILL $tree_pids "$runner_pid" 2>/dev/null || true
fi
wait "$runner_pid"; status=$?
if (( hang )); then status=124; fi
echo "test runner exit: $status"
echo "TAP path: $tap_out bytes=$(wc -c < "$tap_out" 2>/dev/null || echo 0)"

if [[ ! -s "$tap_out" ]]; then
  echo "::error::TAP output missing or empty: $tap_out (test runner exit=$status)" >&2
  echo "This is NOT a known-failures diff failure — the unit runner never produced TAP." >&2
  echo "Typical causes: this script never ran (npm ci / fixture wait failed), the runner crashed before TAP header, or TAP_OUT pointed at an unwritable path." >&2
  exit 1
fi

# 摘要可见性:把 TAP 汇总行打到 job log
grep -E '^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)' "$tap_out" || true

echo "----- TAP head (40) -----"
head -40 "$tap_out" || true
echo "----- TAP tail (80) -----"
tail -80 "$tap_out" || true

exec bash .github/scripts/diff-known-failures.sh "$tap_out" "$baseline" "$status"
