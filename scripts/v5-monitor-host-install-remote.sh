#!/usr/bin/env bash
# deploy-v5.sh --install-monitor 的远端原子安装 payload；不可单独用于生产变更。

set -Eeuo pipefail

stage="$1"
root="$2"
bundle_sha="$3"
state_file="$4"
release="$root/releases/monitor-$bundle_sha"
current="$root/current"
monitor_unit=openclaude-v5-monitor.service
timer_unit=openclaude-v5-monitor.timer
daily_unit=openclaude-v5-daily.service
daily_timer_unit=openclaude-v5-daily.timer
alert_unit='openclaude-v5-alert-fail@.service'
env_file="${OC_V5_MONITOR_ENV:-/etc/openclaude/commercial-v5.env}"
systemd_dir="${OC_V5_SYSTEMD_DIR:-/etc/systemd/system}"
monitor_log="${OC_V5_MONITOR_LOG:-/var/log/openclaude-v5-monitor.log}"
backup_root="${OC_V5_MONITOR_BACKUP_ROOT:-/var/lib/openclaude-v5}"
backup="$(mktemp -d "$backup_root/.monitor-backup.XXXXXX")"
timer_restore_armed=0
surface_rollback_armed=0
timer_was_active=0
daily_timer_was_active=0
state_existed=0
current_existed=0
monitor_unit_existed=0
timer_unit_existed=0
daily_unit_existed=0
daily_timer_unit_existed=0
alert_unit_existed=0

monitor_counts() {
  local dburl
  dburl="$(grep '^DATABASE_URL=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)"
  [[ -n "$dburl" ]] || return 1
  psql "$dburl" -Atq -v ON_ERROR_STOP=1 <<'SQL'
SELECT
  (SELECT count(*) FROM inbox_messages WHERE title LIKE '[v5监控]%')::text
  || '|'
  || (SELECT count(*) FROM admin_alert_outbox WHERE event_type LIKE 'ops.monitor_%')::text;
SQL
}

drain_attempts="${OC_V5_MONITOR_DRAIN_ATTEMPTS:-200}"
drain_sleep="${OC_V5_MONITOR_DRAIN_SLEEP_SECONDS:-0.25}"
[[ "$drain_attempts" =~ ^[1-9][0-9]*$ ]] || { echo "FATAL:monitor drain attempts 非正整数" >&2; exit 1; }

wait_monitor_surface_quiet() {
  local stable=0 busy
  for _ in $(seq 1 "$drain_attempts"); do
    busy=0
    systemctl is-active --quiet "$monitor_unit" && busy=1
    systemctl is-active --quiet "$daily_unit" && busy=1
    systemctl list-jobs --no-legend --no-pager 2>/dev/null \
      | grep -Eq 'openclaude-v5-(monitor|daily|alert-fail@).*\.service' && busy=1
    systemctl list-units 'openclaude-v5-alert-fail@*.service' --all --no-legend --no-pager 2>/dev/null \
      | awk '$3 ~ /^(activating|active|deactivating)$/ { found=1 } END { exit found ? 0 : 1 }' && busy=1
    if [[ "$busy" == 0 ]]; then stable=$((stable + 1)); else stable=0; fi
    [[ "$stable" -ge 2 ]] && return 0
    sleep "$drain_sleep"
  done
  return 1
}

stop_and_wait_monitor_surface() {
  local unit stable=0 busy
  systemctl stop "$timer_unit" >/dev/null 2>&1 || return 1
  systemctl stop "$daily_timer_unit" >/dev/null 2>&1 || return 1
  systemctl stop "$monitor_unit" >/dev/null 2>&1 || return 1
  # daily 分阶段写 outbox/inbox/log，绝不强停；只停止 timer 并等待已有 oneshot 自然结束。
  # OnFailure 可能在 monitor start 返回失败后才排队。循环停止当前可见的 monitor /
  # alert-fail job/实例，再要求连续两次完全静止。
  for _ in $(seq 1 "$drain_attempts"); do
    while IFS= read -r unit; do
      [[ -n "$unit" ]] && systemctl stop "$unit" >/dev/null 2>&1 || true
    done < <(systemctl list-jobs --no-legend --no-pager 2>/dev/null \
      | awk '$2 ~ /^openclaude-v5-(monitor|alert-fail@).*\.service$/ { print $2 }')
    while IFS= read -r unit; do
      [[ -n "$unit" ]] && systemctl stop "$unit" >/dev/null 2>&1 || true
    done < <(systemctl list-units 'openclaude-v5-alert-fail@*.service' --all --no-legend --no-pager 2>/dev/null \
      | awk '$3 ~ /^(activating|active|deactivating)$/ { print $1 }')
    busy=0
    systemctl is-active --quiet "$monitor_unit" && busy=1
    systemctl is-active --quiet "$daily_unit" && busy=1
    systemctl list-jobs --no-legend --no-pager 2>/dev/null \
      | grep -Eq 'openclaude-v5-(monitor|daily|alert-fail@).*\.service' && busy=1
    systemctl list-units 'openclaude-v5-alert-fail@*.service' --all --no-legend --no-pager 2>/dev/null \
      | awk '$3 ~ /^(activating|active|deactivating)$/ { found=1 } END { exit found ? 0 : 1 }' && busy=1
    if [[ "$busy" == 0 ]]; then stable=$((stable + 1)); else stable=0; fi
    [[ "$stable" -ge 2 ]] && return 0
    sleep "$drain_sleep"
  done
  return 1
}

restore_timer_only() {
  local rc=0
  if [[ "$timer_was_active" == 1 ]]; then
    systemctl start "$timer_unit" >/dev/null 2>&1 || rc=1
    systemctl is-active --quiet "$timer_unit" || rc=1
  fi
  if [[ "$daily_timer_was_active" == 1 ]]; then
    systemctl start "$daily_timer_unit" >/dev/null 2>&1 || rc=1
    systemctl is-active --quiet "$daily_timer_unit" || rc=1
  fi
  return "$rc"
}

restore_unit_file() { # <unit> <existed-flag>
  local unit="$1" existed="$2" tmp="$systemd_dir/.$1.restore.$$"
  if [[ "$existed" == 1 ]]; then
    cp -a -- "$backup/$unit" "$tmp" || return 1
    mv -f -- "$tmp" "$systemd_dir/$unit" || return 1
  else
    rm -f -- "$systemd_dir/$unit" || return 1
  fi
}

restore_previous() {
  stop_and_wait_monitor_surface || return 1
  restore_unit_file "$monitor_unit" "$monitor_unit_existed" || return 1
  restore_unit_file "$timer_unit" "$timer_unit_existed" || return 1
  restore_unit_file "$daily_unit" "$daily_unit_existed" || return 1
  restore_unit_file "$daily_timer_unit" "$daily_timer_unit_existed" || return 1
  restore_unit_file "$alert_unit" "$alert_unit_existed" || return 1
  if [[ "$current_existed" == 1 ]]; then
    ln -s -- "$(cat "$backup/current-target")" "$root/.current.restore.$$" || return 1
    mv -Tf -- "$root/.current.restore.$$" "$current" || return 1
  else
    rm -f -- "$current" || return 1
  fi
  if [[ "$state_existed" == 1 ]]; then
    cp -a -- "$backup/monitor-state.json" "${state_file}.restore.$$" || return 1
    mv -f -- "${state_file}.restore.$$" "$state_file" || return 1
  else
    rm -f -- "$state_file" || return 1
  fi
  systemctl daemon-reload >/dev/null 2>&1 || return 1
  restore_timer_only || return 1
  echo "$(TZ=Asia/Shanghai date '+%F %T') INSTALL-ROLLBACK host monitor bundle=$bundle_sha" >> "$monitor_log" || return 1
}

finish() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [[ "$rc" != 0 ]]; then
    if [[ "$surface_rollback_armed" == 1 ]]; then
      restore_previous || rc=86
    elif [[ "$timer_restore_armed" == 1 ]]; then
      restore_timer_only || rc=86
    fi
  fi
  if [[ "$rc" != 86 ]]; then rm -rf -- "$stage" "$backup"; fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

[[ -d "$stage" && ! -L "$stage" ]] || { echo "FATAL:monitor stage 不可信:$stage" >&2; exit 1; }
(cd "$stage" && sha256sum -c SHA256SUMS)
[[ "$(sha256sum "$stage/SHA256SUMS" | awk '{print $1}')" == "$bundle_sha" ]] \
  || { echo "FATAL:monitor bundle identity 与 SHA256SUMS 不一致" >&2; exit 1; }
bash -n "$stage/v5-monitor.sh" "$stage/v5-daily-check.sh" "$stage/v5-alert-fail.sh"
grep -Fqx 'WorkingDirectory=/opt/openclaude/v5-monitor/current' "$stage/$monitor_unit"
grep -Fqx 'ExecStart=/usr/bin/flock --shared --nonblock --conflict-exit-code 0 /run/openclaude-v5/production-mutation.lock /usr/bin/bash /opt/openclaude/v5-monitor/current/v5-monitor.sh' "$stage/$monitor_unit"
grep -Fqx 'WorkingDirectory=/opt/openclaude/v5-monitor/current' "$stage/$daily_unit"
grep -Fqx 'ExecStart=/usr/bin/bash /opt/openclaude/v5-monitor/current/v5-daily-check.sh' "$stage/$daily_unit"
grep -Fqx 'WorkingDirectory=/opt/openclaude/v5-monitor/current' "$stage/$alert_unit"
grep -Fqx 'ExecStart=/usr/bin/bash /opt/openclaude/v5-monitor/current/v5-alert-fail.sh %i' "$stage/$alert_unit"
systemd-analyze verify "$stage/$monitor_unit" "$stage/$timer_unit" \
  "$stage/$daily_unit" "$stage/$daily_timer_unit" "$stage/$alert_unit"

systemctl is-active --quiet "$timer_unit" && timer_was_active=1
systemctl is-active --quiet "$daily_timer_unit" && daily_timer_was_active=1
[[ "$timer_was_active" == 1 ]] || { echo "FATAL:$timer_unit 原本未 active，拒绝把既有监控停摆伪装成安装成功" >&2; exit 1; }
[[ "$daily_timer_was_active" == 1 ]] || { echo "FATAL:$daily_timer_unit 原本未 active，拒绝把既有日报停摆伪装成安装成功" >&2; exit 1; }
timer_restore_armed=1
systemctl stop "$timer_unit" >/dev/null 2>&1 \
  || { echo "FATAL:$timer_unit stop 失败" >&2; exit 1; }
systemctl stop "$daily_timer_unit" >/dev/null 2>&1 \
  || { echo "FATAL:$daily_timer_unit stop 失败" >&2; exit 1; }
timer_stopped=0
daily_timer_stopped=0
for _ in $(seq 1 "$drain_attempts"); do
  if ! systemctl is-active --quiet "$timer_unit"; then timer_stopped=1; break; fi
  sleep "$drain_sleep"
done
[[ "$timer_stopped" == 1 ]] || { echo "FATAL:$timer_unit stop 后仍 active/activating" >&2; exit 1; }
for _ in $(seq 1 "$drain_attempts"); do
  if ! systemctl is-active --quiet "$daily_timer_unit"; then daily_timer_stopped=1; break; fi
  sleep "$drain_sleep"
done
[[ "$daily_timer_stopped" == 1 ]] || { echo "FATAL:$daily_timer_unit stop 后仍 active/activating" >&2; exit 1; }

# timers 停止后同时等待 monitor/daily oneshot、排队 job 与 alert-fail 实例自然排空。
wait_monitor_surface_quiet \
  || { echo "FATAL:monitor/daily/alert-fail 在有界等待内未排空" >&2; exit 1; }

install -d -m 0755 "$root" "$root/releases"
if [[ -f "$systemd_dir/$monitor_unit" ]]; then cp -a -- "$systemd_dir/$monitor_unit" "$backup/$monitor_unit"; monitor_unit_existed=1; fi
if [[ -f "$systemd_dir/$timer_unit" ]]; then cp -a -- "$systemd_dir/$timer_unit" "$backup/$timer_unit"; timer_unit_existed=1; fi
if [[ -f "$systemd_dir/$daily_unit" ]]; then cp -a -- "$systemd_dir/$daily_unit" "$backup/$daily_unit"; daily_unit_existed=1; fi
if [[ -f "$systemd_dir/$daily_timer_unit" ]]; then cp -a -- "$systemd_dir/$daily_timer_unit" "$backup/$daily_timer_unit"; daily_timer_unit_existed=1; fi
if [[ -f "$systemd_dir/$alert_unit" ]]; then cp -a -- "$systemd_dir/$alert_unit" "$backup/$alert_unit"; alert_unit_existed=1; fi
if [[ -L "$current" ]]; then readlink "$current" > "$backup/current-target"; current_existed=1; elif [[ -e "$current" ]]; then echo "FATAL:$current 不是 symlink" >&2; exit 1; fi
if [[ -L "$state_file" || ( -e "$state_file" && ! -f "$state_file" ) ]]; then echo "FATAL:monitor state 不是可信普通文件" >&2; exit 1; fi
if [[ -f "$state_file" ]]; then cp -a -- "$state_file" "$backup/monitor-state.json"; state_existed=1; fi
surface_rollback_armed=1

# 先用新脚本只读探测；任何当前 bad 都在状态/通知写入前拒绝安装。
#
# V5MON_BACKUP_DIR 透传(2026-07-26):新增的 check_backup_fresh 读的是绝对路径
# /var/backups/openclaude-v5。安装器此前把该路径当成不可变的生产假设,于是
#   ①测试/预发宿主的备份目录布局不同 → 装不上;
#   ②本机备份目录本来就不在默认位置时 → 门恒红。
# 这与仓内"不许硬编码生产假设"的证据门铁律冲突(同 CADDY_HTTP_PORT 那条)。
# 故:调用方给了就透传,没给则沿用脚本默认 = 生产行为逐字节不变。
declare -a monitor_env=(
  "V5MON_ENV_FILE=$env_file"
  "V5MON_STATE_FILE=$state_file"
  "V5MON_LOG_FILE=$monitor_log"
)
[[ -n "${V5MON_BACKUP_DIR:-}" ]] && monitor_env+=("V5MON_BACKUP_DIR=$V5MON_BACKUP_DIR")

dry_out="$backup/dry-run.out"
env "${monitor_env[@]}" bash "$stage/v5-monitor.sh" --dry-run > "$dry_out"
if awk '$2 == "bad" { found=1 } END { exit found ? 0 : 1 }' "$dry_out"; then
  echo "FATAL:新 monitor dry-run 存在 bad check" >&2
  cat "$dry_out" >&2
  exit 1
fi

old_bad="$(jq -c '[(.checks // {}) | to_entries[] | select(.value.status == "bad") | .key] | sort' "$state_file" 2>/dev/null)" \
  || { echo "FATAL:monitor state 不是合法 JSON" >&2; exit 1; }
if [[ "$old_bad" == '["pool"]' ]]; then
  before_counts="$(monitor_counts)" || { echo "FATAL:无法读取迁移前 monitor 通知计数" >&2; exit 1; }
  env "${monitor_env[@]}" bash "$stage/v5-monitor.sh" --migrate-obsolete-pool-state
  after_counts="$(monitor_counts)" || { echo "FATAL:无法读取迁移后 monitor 通知计数" >&2; exit 1; }
  [[ "$before_counts" == "$after_counts" ]] || {
    echo "FATAL:pool 状态迁移期间 monitor 通知计数变化(before=$before_counts after=$after_counts)，保留真实记录并回滚安装" >&2
    exit 1
  }
elif [[ "$old_bad" != '[]' ]]; then
  echo "FATAL:拒绝静默迁移非 pool 历史异常:$old_bad" >&2
  exit 1
fi

if [[ -e "$release" && ( ! -d "$release" || -L "$release" ) ]]; then echo "FATAL:monitor release path 不可信:$release" >&2; exit 1; fi
if [[ ! -d "$release" ]]; then
  release_tmp="$root/releases/.monitor-$bundle_sha.$$"
  install -d -m 0755 "$release_tmp"
  install -m 0755 "$stage/v5-monitor.sh" "$stage/v5-daily-check.sh" \
    "$stage/v5-alert-fail.sh" \
    "$stage/v5-monitor-host-install-remote.sh" "$release_tmp/"
  install -m 0644 "$stage/v5-alert-fanout.sql" "$stage/SHA256SUMS" \
    "$stage/$monitor_unit" "$stage/$timer_unit" \
    "$stage/$daily_unit" "$stage/$daily_timer_unit" "$stage/$alert_unit" "$release_tmp/"
  chown -R root:root "$release_tmp"
  mv -- "$release_tmp" "$release"
fi
(cd "$release" && sha256sum -c SHA256SUMS)
ln -s -- "releases/monitor-$bundle_sha" "$root/.current.new.$$"
mv -Tf -- "$root/.current.new.$$" "$current"
install -m 0644 "$stage/$monitor_unit" "$systemd_dir/.$monitor_unit.new.$$"
install -m 0644 "$stage/$timer_unit" "$systemd_dir/.$timer_unit.new.$$"
install -m 0644 "$stage/$daily_unit" "$systemd_dir/.$daily_unit.new.$$"
install -m 0644 "$stage/$daily_timer_unit" "$systemd_dir/.$daily_timer_unit.new.$$"
install -m 0644 "$stage/$alert_unit" "$systemd_dir/.$alert_unit.new.$$"
mv -f -- "$systemd_dir/.$monitor_unit.new.$$" "$systemd_dir/$monitor_unit"
mv -f -- "$systemd_dir/.$timer_unit.new.$$" "$systemd_dir/$timer_unit"
mv -f -- "$systemd_dir/.$daily_unit.new.$$" "$systemd_dir/$daily_unit"
mv -f -- "$systemd_dir/.$daily_timer_unit.new.$$" "$systemd_dir/$daily_timer_unit"
mv -f -- "$systemd_dir/.$alert_unit.new.$$" "$systemd_dir/$alert_unit"
systemctl daemon-reload
systemctl start "$monitor_unit"
[[ "$(jq -c '[(.checks // {}) | to_entries[] | select(.value.status == "bad") | .key] | sort' "$state_file")" == '[]' ]] \
  || { echo "FATAL:新 monitor 首轮出现真实异常" >&2; exit 1; }
[[ "$(readlink -f "$current")" == "$release" ]] || { echo "FATAL:monitor current 未指向目标 release" >&2; exit 1; }
restore_timer_only
surface_rollback_armed=0
timer_restore_armed=0
echo "$(TZ=Asia/Shanghai date '+%F %T') INSTALL-OK host monitor bundle=$bundle_sha" >> "$monitor_log"
echo "✓ host monitor bundle=$bundle_sha current=$release timers_restored=monitor:$timer_was_active,daily:$daily_timer_was_active"
