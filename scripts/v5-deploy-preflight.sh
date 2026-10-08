#!/usr/bin/env bash
# 发车前只读预检:scripts/v5-deploy-detached.sh start 在 systemd-run 之前调用。
#
# 为什么(2026-10-04..07 实测):30 次 detached 发车失败 6 次,其中 4 次是几秒就能判定的
# 确定性错误,却要等 transient unit 跑 20s–7min 才由 deploy-v5.sh 报出:
#   · 漏 OC_V5_PROOF_TEST_DATABASE_URL ×2(build_release 的 Box 证明门,约 6 分钟后才失败)
#   · 改了 egress 面却没带 --egress ×1(egress surface gate)
#   · 发布队列项不是 active ×1
#
# 不变量:
#   · 只读、不阻塞。不取任何锁(队列走 v5-release-queue.sh check)、不写队列、不碰远端状态;
#     egress 判定只经 ssh 读 egress 进程 cwd 与 release 元数据。
#   · 不另起口径:MODE / --egress / 队列 / egress 面全部复用 deploy-v5.sh 的真实变量与函数
#     (V5_DEPLOY_SOURCE_ONLY=1 source),预检只会比 deploy-v5.sh **更早**拒绝,不会放行它会拒的东西。
#   · deploy-v5.sh 自己的门一个不少照跑;本脚本不是门禁的替代。
#   · --dry-run 不预检(dry-run 不连远端、不需要队列与测试库)。
#
# 用法: scripts/v5-deploy-preflight.sh -- [deploy-v5.sh args...]
# 退出码: 0 = 通过;非 0 = 预检拒绝(stderr 说明原因与改法)。stdout 恒为空(wrapper 的 stdout 只给 unit 名)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ "${1-}" == "--" ]] || { echo "✗ 用法: v5-deploy-preflight.sh -- [deploy-v5.sh args...]" >&2; exit 2; }
shift

# 子 shell:deploy-v5.sh 顶层在参数/分支非法时直接 exit,子 shell 隔离后这里仍能给出统一结论。
if ! (
  # deploy-v5.sh 顶层只做参数解析、常量与函数定义,source-only 在任何锁/trap/远端动作之前返回。
  # 参数非法时它会自己 exit,这里原样转成预检失败。
  V5_DEPLOY_SOURCE_ONLY=1 source "$SCRIPT_DIR/deploy-v5.sh" "$@" >&2 || exit 2
  set +e

  if [[ "${DRY:-0}" == 1 ]]; then echo "  · 预检:--dry-run,跳过" >&2; exit 0; fi

  fail=0

  # 1) 发布队列:判据同 deploy-v5.sh 持锁后的 assert_development_release_queue(active + 已 pin +
  #    pinned 是 HEAD 祖先),但走 v5-release-queue.sh check —— 只读、不取队列锁、不建库,
  #    别人持有队列锁时也不会挂住。check 退出 3 = 读不到:预检不替 deploy-v5.sh 下结论,只告警放行。
  if release_queue_required_for_mode "$MODE"; then
    "$RELEASE_QUEUE_SCRIPT" check --id "${OC_V5_RELEASE_QUEUE_ID:-}" >&2
    case $? in
      0) ;;
      3) echo "  ⚠ 预检:发布队列状态读不到,交给 deploy-v5.sh 的 assert 判定" >&2 ;;
      *)
        echo "✗ 预检:发布队列未就绪(MODE=$MODE)。先 submit → acquire → pin,并在同一条命令里带 OC_V5_RELEASE_QUEUE_ID" >&2
        fail=1
        ;;
    esac
  fi

  # 2) Box 证明门测试库:build_release 要求显式测试库。transient unit 只继承 OC_V5_PROOF_TEST_DATABASE_URL
  #    (见 v5-deploy-detached.sh add_optional_env),调用方 shell 里的 TEST_DATABASE_URL 带不进 unit,故只认前者。
  builds_release=0
  # 与 deploy-v5.sh 里 build_release 的全部调用方一一对应(deploy / deploy_dist / canary 新建 /
  # knowledge_planet_build_release_mutation);v5DeployDetached.test.ts 钉住调用方清单,新增调用方会让测试变红。
  case "$MODE" in
    deploy|dist|knowledge-planet-verify) builds_release=1 ;;
    canary) [[ -z "${CANARY_RELEASE:-}" ]] && builds_release=1 ;;
  esac
  if [[ "$builds_release" == 1 && -z "${OC_V5_PROOF_TEST_DATABASE_URL:-}" ]]; then
    echo "✗ 预检:MODE=$MODE 会 build_release,但未设置 OC_V5_PROOF_TEST_DATABASE_URL(Box 证明门的本机回环 *_test 库)。" >&2
    echo "   在同一条 start 命令前带上它;detached unit 不继承调用方的其它环境变量。" >&2
    fail=1
  fi

  # 3) egress surface gate:deploy-v5.sh 的同名函数(只在 MODE=deploy 且未带 --egress 时有判定)。
  if ! assert_egress_surface_covered >&2; then
    echo "✗ 预检:egress surface gate 不通过(见上);按提示加 --egress 后重新 start" >&2
    fail=1
  fi

  [[ "$fail" == 0 ]] || exit 2
  echo "  ✓ 发车预检通过(MODE=$MODE egress=${RESTART_EGRESS:-0})" >&2
); then
  echo "✗ 发车预检未通过:未创建 detached unit,live 未改" >&2
  exit 2
fi

# 只提示、不阻断:integ nightly 连续红(2026-10-08 devflow-opt)。
# nightly 梯队的 integ 只在 v5-integ-nightly.yml 跑,PR CI 不覆盖;它曾连续红 39/40 次没人看见。
# 预检通过后让发车人看见它。查询失败/超时一律静默跳过,不影响发车;OC_V5_PREFLIGHT_NIGHTLY=0 关闭。
nightly_advisory() {
  [[ "${OC_V5_PREFLIGHT_NIGHTLY:-1}" == 1 ]] || return 0
  command -v gh >/dev/null 2>&1 || return 0
  local rows red=0 total=0 first="" latest_id="" latest_at="" c id at shards streak
  rows="$(cd "$SCRIPT_DIR/.." && timeout 15 gh run list --workflow v5-integ-nightly.yml --limit 30 \
    --json conclusion,createdAt,databaseId \
    --jq '.[] | select((.conclusion // "") != "") | "\(.conclusion) \(.databaseId) \(.createdAt)"' 2>/dev/null)" || return 0
  while read -r c id at; do
    [[ -n "$c" ]] || continue
    total=$((total + 1))
    if [[ -z "$latest_id" ]]; then latest_id="$id"; latest_at="$at"; fi
    [[ "$c" == failure ]] || break
    red=$((red + 1))
    first="$at"
  done <<<"$rows"
  (( red > 0 )) || return 0
  streak="$red"
  (( red == total && total >= 30 )) && streak="≥$red"   # 只查了最近 30 次,全红时真实连红更长
  shards="$(cd "$SCRIPT_DIR/.." && timeout 15 gh api "repos/{owner}/{repo}/actions/runs/$latest_id/jobs" \
    --jq '[.jobs[] | select(.conclusion == "failure") | .name] | join(", ")' 2>/dev/null || true)"
  echo "  ⚠ 提示(不阻断):integ nightly 已连续 $streak 次红(最早 ${first%%T*},最近 ${latest_at%%T*} run $latest_id;红分片:${shards:-?})。" >&2
  echo "    这些 integ 只在 nightly 跑、PR CI 不覆盖;发车前确认本次改动没碰到它们:gh run view $latest_id --log-failed" >&2
}
nightly_advisory || true
