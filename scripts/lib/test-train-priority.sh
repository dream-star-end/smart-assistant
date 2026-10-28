#!/usr/bin/env bash
# Short admission critical section, shared with the existing selfhost deploy
# flock. Never retain this fd while waiting for a test mutex or running tests.
TEST_TRAIN_PRIORITY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_train_priority_leave() {
  if [[ -n "${test_train_priority_fd:-}" ]]; then
    exec {test_train_priority_fd}<&-
    unset test_train_priority_fd
  fi
}

test_train_priority_enter() {
  local lock="${OC_V5_SELFHOST_DEPLOY_LOCK:-/run/openclaude-v5-selfhost/deploy.lock}" rc=0
  test_train_priority_leave
  if [[ -e "$lock" || -L "$lock" ]]; then
    if [[ ! -f "$lock" || -L "$lock" ]] || ! { exec {test_train_priority_fd}<"$lock"; } 2>/dev/null; then
      echo "[test-mutex] 无法只读打开 selfhost deploy.lock；拒绝新测试。核查后运行 wait-for-trains.sh。" >&2
      return 2
    fi
    flock -s -n -E 75 "$test_train_priority_fd" || rc=$?
    if (( rc != 0 )); then
      test_train_priority_leave
      if (( rc != 75 )); then
        echo "[test-mutex] 无法检查 selfhost deploy.lock；拒绝新测试。核查后运行 wait-for-trains.sh。" >&2
        return 2
      fi
      # A train's own callback proof also uses test-mutex. Verify its executor
      # ancestry and kernel flock evidence; no caller-controlled bypass flag.
      python3 "$TEST_TRAIN_PRIORITY_LIB_DIR/test-train-priority.py" --require-train-owner
      return $?
    fi
  fi
  # Python also checks missing/invalid configured paths and inaccessible state.
  python3 "$TEST_TRAIN_PRIORITY_LIB_DIR/test-train-priority.py" || rc=$?
  if (( rc != 0 )); then test_train_priority_leave; fi
  return "$rc"
}
