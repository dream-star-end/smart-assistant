#!/usr/bin/env bash
# Fail before npm test starts its first suite; leaf mutexes recheck admission.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/test-train-priority.sh"
test_train_priority_enter
test_train_priority_leave
