#!/usr/bin/env bash
# deploy-v5-selfhost.sh — 把 V5 商业版独立部署到本机自用。
#
# 本机即目标机(不走 SSH),与 kl-mirror 生产实例零耦合:
#   - 源码树   /opt/openclaude/openclaude-v5-selfhost (本 worktree,就地使用)
#   - HOME     /root/.openclaude-v5-selfhost
#   - env      /etc/openclaude/commercial-v5-selfhost.env
#   - 端口     master 127.0.0.1:18790 / egress 172.31.0.1:18892
#   - systemd  openclaude-v5-selfhost.service + -egress + -hostnet + -sshgate
#   - PG       openclaude_v5_selfhost / role oc_v5_selfhost
#   - Redis    redis://127.0.0.1:6379/3
#
# 红线:绝不 touch 个人版 openclaude.service / 18789 / openclaude_personal_sessions /
#       Redis db0,也不写生产 commercial-v5.env 或 /opt/openclaude/openclaude-v5。
#
# 用法:
#   scripts/deploy-v5-selfhost.sh --preflight
#   scripts/deploy-v5-selfhost.sh --bootstrap [--force-env]
#   scripts/deploy-v5-selfhost.sh --deploy
#   scripts/deploy-v5-selfhost.sh --deploy --allow-dirty --platform-from-head
#   scripts/deploy-v5-selfhost.sh --build-master-only [--force-npm-ci]
#   scripts/deploy-v5-selfhost.sh --smoke
#   scripts/deploy-v5-selfhost.sh --status
#   scripts/deploy-v5-selfhost.sh --bootstrap --dry-run
#
# bootstrap 之后的一次性配套(各自幂等,详见脚本内注释):
#   scripts/selfhost-setup-host-access.sh --uid <admin_uid> --apply   宿主 SSH 通道
#   scripts/selfhost-import-personal-assets.sh --uid <admin_uid> --apply  个人版 skill/memory
#   systemctl enable --now cloudflared-v5-selfhost.service            公网入口(按需)
#   scripts/selfhost-sync-tunnel-url.sh --apply                       同步 COMMERCIAL_BASE_URL
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

INSTANCE_ID="v5-selfhost-sg"
V5_HOME="/root/.openclaude-v5-selfhost"
V5_ENV="/etc/openclaude/commercial-v5-selfhost.env"
V5_UNIT="openclaude-v5-selfhost.service"
V5_EGRESS_UNIT="openclaude-v5-selfhost-egress.service"
V5_HOSTNET_UNIT="openclaude-v5-selfhost-hostnet.service"
V5_SSHGATE_UNIT="openclaude-v5-selfhost-sshgate.service"
V5_TUNNEL_UNIT="cloudflared-v5-selfhost.service"
V5_PORT="18790"
V5_EGRESS_BIND="172.31.0.1"
V5_EGRESS_PORT="18892"
V5_CONTROL_BIND="127.0.0.1"
V5_CONTROL_PORT="18894"
V5_BASELINE_PORT="18893"
PG_DB="openclaude_v5_selfhost"
PG_ROLE="oc_v5_selfhost"
# catalog mutation 专用低权角色。必须与 PG_ROLE 不同名,否则 master 开 model authority 拒启。
CATALOG_ADMIN_ROLE="${PG_ROLE}_catalog_admin"
REDIS_URL="redis://127.0.0.1:6379/3"
RUNTIME_IMAGE="openclaude/openclaude-runtime:v5-grok-21e30788a613-slim"
SECRETS_ENV="/etc/openclaude/secrets.env"
PERSONAL_UNIT="openclaude.service"
PERSONAL_PORT="18789"
SETUP_HOST_NET="$REPO_ROOT/packages/commercial/scripts/setup-host-net.sh"
UNIT_DIR="$REPO_ROOT/deploy/v5-selfhost"
EXCLUDES="$REPO_ROOT/packages/commercial/agent-sandbox/runtime-src-excludes.txt"
SEED_CLI="$REPO_ROOT/packages/commercial/agent-sandbox/platform-runtime/entrypoint/validatePlatformSeedCli.ts"
PLATFORM_SRC="$REPO_ROOT/packages/commercial/agent-sandbox/platform-runtime"

export OC_HOTCFG_PLATFORM_ROOT="${OC_HOTCFG_PLATFORM_ROOT:-/var/lib/openclaude-v5-selfhost/platform}"
export OC_HOTCFG_RELEASES_ROOT="${OC_HOTCFG_RELEASES_ROOT:-/var/lib/openclaude-v5-selfhost/runtime-releases}"
export OC_HOTCFG_ENV_FILE="$V5_ENV"
export OC_HOTCFG_HISTORY="${OC_HOTCFG_HISTORY:-/etc/openclaude/runtime-tuple-selfhost.history}"
export OC_BUN_BIN="${OC_BUN_BIN:-$(command -v bun || echo /usr/local/bin/bun)}"

RUNTIME_LIB="$SCRIPT_DIR/v5-runtime-release-lib.sh"
# shellcheck source=scripts/v5-runtime-release-lib.sh
# shellcheck disable=SC1091
source "$RUNTIME_LIB"
MASTER_RELEASE_LIB="$SCRIPT_DIR/v5-selfhost-master-release-lib.sh"

DRY=0
FORCE_ENV=0
ALLOW_DIRTY=0
PLATFORM_FROM_HEAD=0
FORCE_NPM_CI=0
MODE=""

# 本实例专属发布锁。禁止复用:
#   /var/lock/oc-v5-deploy.lock                      V5 商业版生产(deploy-v5.sh / 发布队列 / 自愈)
#   /run/openclaude-v5/production-mutation.lock      V5 商业版生产 mutation lease
#   /var/lock/openclaude-v5-deploy.lock              宿主遗留(2026-07-27起),现网脚本已不引用
#   /var/lock/openclaude-v5-production-mutation.lock 宿主遗留(2026-07-24起),现网脚本已不引用
# 锁目录必须在 /run 下本实例专属路径: /run 为 0755 root:root,非特权用户无法在此创建/替换条目;
# /run/lock(以及 /var/lock→/run/lock)是 1777,不能再当锁目录。/run 是 tmpfs,每次运行自愈创建。
SELFHOST_DEPLOY_LOCK_DIR="/run/openclaude-v5-selfhost"
SELFHOST_DEPLOY_LOCK="${OC_V5_SELFHOST_DEPLOY_LOCK:-${SELFHOST_DEPLOY_LOCK_DIR}/deploy.lock}"
SELFHOST_DEPLOY_LOCK_WAIT="${OC_V5_SELFHOST_DEPLOY_LOCK_WAIT:-2400}"
SELFHOST_DEPLOY_LOCK_POLL="${OC_V5_SELFHOST_DEPLOY_LOCK_POLL:-15}"
SELFHOST_DEPLOY_LOCK_HOLDER=""
SELFHOST_DEPLOY_LOCK_HOLDER_OWNED=0
PLATFORM_ARCHIVE_TMP=""

die() {
  echo "✗ $*" >&2
  exit 1
}

# shellcheck source=scripts/v5-selfhost-master-release-lib.sh
# shellcheck disable=SC1091
source "$MASTER_RELEASE_LIB"

log() { echo "$*"; }

run() {
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] $*"
    return 0
  fi
  # shellcheck disable=SC2294
  eval "$@"
}

own_instance_present() {
  [[ -f "$V5_ENV" ]] || systemctl cat "$V5_UNIT" >/dev/null 2>&1
}

cleanup_selfhost_deploy() {
  if [[ -n "${PLATFORM_ARCHIVE_TMP:-}" && -d "$PLATFORM_ARCHIVE_TMP" ]]; then
    rm -rf "$PLATFORM_ARCHIVE_TMP"
    PLATFORM_ARCHIVE_TMP=""
  fi
  cleanup_master_staging
  if [[ "${SELFHOST_DEPLOY_LOCK_HOLDER_OWNED:-0}" == 1 && -n "${SELFHOST_DEPLOY_LOCK_HOLDER:-}" ]]; then
    rm -f "$SELFHOST_DEPLOY_LOCK_HOLDER"
    SELFHOST_DEPLOY_LOCK_HOLDER_OWNED=0
  fi
}
trap cleanup_selfhost_deploy EXIT

selfhost_lock_holder_info() {
  local lock="$1" holder_path holder pids
  holder_path="${lock}.holder"
  holder=""
  # 读 holder 也不跟随符号链接:存在即 -L 则当未知,避免把链接目标内容当持锁者。
  if [[ -L "$holder_path" ]]; then
    holder="拒绝读取(holder 是符号链接)"
  elif [[ -f "$holder_path" ]]; then
    holder="$(cat "$holder_path" 2>/dev/null || true)"
  fi
  pids="$(fuser "$lock" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//' || true)"
  printf 'holder=%s fuser_pids=%s' "${holder:-未知}" "${pids:-?}"
}

# O_NOFOLLOW 打开/创建锁与 holder。环境变量覆盖的路径也走这里,不因来源跳过。
# python 用 O_NOFOLLOW|O_DIRECTORY 打开目录、O_NOFOLLOW 打开文件,避免跟随符号链接截断目标。
selfhost_lock_py() {
  command -v python3 >/dev/null 2>&1 || die "缺少 python3(锁文件必须以 O_NOFOLLOW 打开)。补救: 安装 python3。"
  python3 - "$@" <<'PY'
import errno
import os
import stat
import sys


def die(msg):
    sys.stderr.write("✗ " + msg + "\n")
    sys.exit(1)


def world_writable(st):
    return bool(st.st_mode & stat.S_IWOTH)


def open_dir_nofollow(path):
    try:
        return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        if e.errno == errno.ELOOP:
            die("路径是符号链接,拒绝: %s。补救: 锁目录必须是普通目录,不能是链接。" % path)
        if e.errno == errno.ENOTDIR:
            die("路径不是目录,拒绝: %s" % path)
        if e.errno == errno.ENOENT:
            die("路径不存在: %s" % path)
        die("无法打开目录 %s: %s" % (path, e))


def validate_dir_fd(fd, path, tighten=False):
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode):
        die("不是目录: %s" % path)
    if st.st_uid != 0:
        die("目录 owner 不是 root: %s (uid=%s)。补救: 锁必须放在 root 所有的目录里。" % (path, st.st_uid))
    if world_writable(st):
        die(
            "目录世界可写,拒绝: %s (mode=%04o)。补救: 不要把锁放到 /tmp 或 /run/lock;默认用 /run/openclaude-v5-selfhost。"
            % (path, st.st_mode & 0o7777)
        )
    if tighten:
        os.fchmod(fd, 0o700)
        st = os.fstat(fd)
        if st.st_uid != 0 or world_writable(st) or (st.st_mode & 0o077):
            die("无法将锁目录收紧为 0700: %s" % path)


def prepare(lock_path, canon_dir):
    if not lock_path.startswith("/") or lock_path != os.path.normpath(lock_path):
        die("锁路径必须是规范化的绝对路径: %s" % lock_path)
    if lock_path.endswith("/"):
        die("锁路径不能是目录: %s" % lock_path)
    parent = os.path.dirname(lock_path)
    if parent in ("/", ""):
        die("拒绝把锁文件放在 / 下: %s" % lock_path)
    gp = os.path.dirname(parent)

    # 先校验祖父目录:必须已存在、不是符号链接、root 所有、非世界可写。
    # 不在世界可写目录里 mkdir,否则非特权用户可抢先建同名条目。
    gp_fd = open_dir_nofollow(gp)
    try:
        validate_dir_fd(gp_fd, gp, tighten=False)
    finally:
        os.close(gp_fd)

    # os.mkdir 不跟随最后一级符号链接:若该名已是链接则 EEXIST,随后 O_NOFOLLOW 打开会 ELOOP。
    try:
        os.mkdir(parent, 0o700)
    except FileExistsError:
        pass
    except OSError as e:
        die("无法创建锁目录 %s: %s" % (parent, e))

    pfd = open_dir_nofollow(parent)
    try:
        validate_dir_fd(pfd, parent, tighten=(parent == canon_dir))
    finally:
        os.close(pfd)

    flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
    try:
        fd = os.open(lock_path, flags, 0o600)
    except OSError as e:
        if e.errno == errno.ELOOP:
            die("锁路径是符号链接,拒绝: %s。补救: 删除该链接;锁必须是普通文件。" % lock_path)
        if e.errno == errno.EISDIR:
            die("锁路径是目录,拒绝: %s" % lock_path)
        die("无法打开锁文件 %s: %s" % (lock_path, e))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            die("锁路径不是普通文件,拒绝: %s" % lock_path)
        if st.st_uid != 0:
            die("锁文件 owner 不是 root: %s (uid=%s)。补救: 删除该文件,让脚本以 root 重建。" % (lock_path, st.st_uid))
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)


def write_holder(path, data):
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
    try:
        fd = os.open(path, flags, 0o600)
    except OSError as e:
        if e.errno == errno.ELOOP:
            die("holder 路径是符号链接,拒绝: %s。补救: 删除该链接后再发布。" % path)
        die("无法写入 holder %s: %s" % (path, e))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            die("holder 不是普通文件,拒绝: %s" % path)
        if st.st_uid != 0:
            die("holder owner 不是 root: %s (uid=%s)" % (path, st.st_uid))
        os.fchmod(fd, 0o600)
        payload = data.encode("utf-8")
        written = 0
        while written < len(payload):
            n = os.write(fd, payload[written:])
            if n <= 0:
                die("写入 holder 不完整: %s" % path)
            written += n
    finally:
        os.close(fd)


cmd = sys.argv[1]
if cmd == "prepare":
    prepare(sys.argv[2], sys.argv[3])
elif cmd == "write-holder":
    write_holder(sys.argv[2], sys.argv[3])
else:
    die("内部错误:未知 lock helper 命令 %s" % cmd)
PY
}

# fd 8 排他 flock:进程退出/被杀时内核释放,不手删锁文件。
# OC_V5_SELFHOST_DEPLOY_LOCK_HELD=1 表示本进程链已持锁(内层跳过,防将来 $0 自调用把自己锁死)。
acquire_selfhost_deploy_lock() {
  local lock wait_s interval waited info holder_line
  if [[ "${OC_V5_SELFHOST_DEPLOY_LOCK_HELD:-}" == 1 ]]; then
    log "  ↻ 本进程链已持 selfhost 发布锁,跳过加锁(可重入)"
    return 0
  fi
  command -v flock >/dev/null 2>&1 || die "缺少 flock。补救: 安装 util-linux。"
  lock="$SELFHOST_DEPLOY_LOCK"
  wait_s="$SELFHOST_DEPLOY_LOCK_WAIT"
  interval="$SELFHOST_DEPLOY_LOCK_POLL"
  [[ "$wait_s" =~ ^[0-9]+$ ]] || die "OC_V5_SELFHOST_DEPLOY_LOCK_WAIT 必须是非负整数秒(当前=$wait_s)"
  [[ "$interval" =~ ^[1-9][0-9]*$ ]] || die "OC_V5_SELFHOST_DEPLOY_LOCK_POLL 必须是正整数秒(当前=$interval)"
  if (( interval > wait_s && wait_s > 0 )); then
    interval="$wait_s"
  fi
  # 默认路径与 OC_V5_SELFHOST_DEPLOY_LOCK 覆盖都走同一套校验,不跳过。
  selfhost_lock_py prepare "$lock" "$SELFHOST_DEPLOY_LOCK_DIR"
  # bash 再 lstat 一次:python 关 fd 到 exec 之间若被换成链接则中止(0700 目录下仅 root 能换)。
  [[ -L "$lock" ]] && die "锁路径是符号链接,拒绝: $lock"
  [[ -f "$lock" ]] || die "锁路径不是普通文件,拒绝: $lock"
  # <> 不截断已有内容;锁文件本身不承载业务数据,避免 exec 8> 跟随链接截断目标。
  exec 8<>"$lock" || die "无法打开锁文件 $lock"
  if ! flock -n 8; then
    waited=0
    while ! flock -n 8; do
      if (( waited >= wait_s )); then
        info="$(selfhost_lock_holder_info "$lock")"
        echo "✗ 等待 selfhost 发布锁超时(${wait_s}s)。锁=$lock $info
补救: 等对方 --deploy/--bootstrap 结束;若持锁 pid 已死仍超时,查 fuser $lock。不要复用商业版 /var/lock/oc-v5-deploy.lock。" >&2
        exit 1
      fi
      info="$(selfhost_lock_holder_info "$lock")"
      log "⏳ 排队等 selfhost 发布锁: $info 已等 ${waited}s / ${wait_s}s"
      sleep "$interval"
      waited=$((waited + interval))
    done
  fi
  SELFHOST_DEPLOY_LOCK_HOLDER="${lock}.holder"
  holder_line="$(printf 'pid=%s user=%s tree=%s started=%s\n' \
    "$$" "$(id -un 2>/dev/null || echo ?)" "${REPO_ROOT:-?}" "$(date -Is)")"
  selfhost_lock_py write-holder "$SELFHOST_DEPLOY_LOCK_HOLDER" "$holder_line"
  SELFHOST_DEPLOY_LOCK_HOLDER_OWNED=1
  export OC_V5_SELFHOST_DEPLOY_LOCK_HELD=1
  log "  ✓ 已取得 selfhost 发布锁 $lock pid=$$"
}

# --status/--smoke/--preflight 与 --dry-run 只读/轻量,不加锁,避免被发布堵住。
# --build-master-only 持锁,避免与别人的 --deploy 撞车。
maybe_acquire_selfhost_deploy_lock() {
  case "$MODE" in
    deploy|bootstrap|build-master-only)
      [[ "$DRY" == 1 ]] && return 0
      acquire_selfhost_deploy_lock
      ;;
  esac
}

usage() {
  cat <<'EOF'
用法: scripts/deploy-v5-selfhost.sh --preflight|--bootstrap|--deploy|--build-master-only|--smoke|--status [--dry-run] [--force-env] [--allow-dirty] [--platform-from-head] [--force-npm-ci]

  --preflight           只读硬门(残留/端口/密钥/个人版)。任何一条不满足即非 0 退出
  --bootstrap           首次完整安装(开头跑全套 preflight)
  --deploy              更新代码后重建 release 树、重写四元组、重启服务
  --build-master-only   只建一份不可变 master rel-*(不迁库/不装 unit/不切 symlink/不重启)
  --smoke               只读健康检查(含个人版回归)
  --status              打印当前状态
  --dry-run             与上述组合:打印将执行的命令,不改任何东西
  --allow-dirty         仅配合 --deploy:工作区有未提交改动时仍部署(默认拒绝,见 cmd_deploy 脏门)
  --platform-from-head  仅配合 --deploy/--bootstrap:平台 bundle 从 git archive 取已提交的 platform-runtime(默认仍拷工作树)
  --force-env           仅配合 --bootstrap:覆盖已存在的 env 文件
  --force-npm-ci        仅配合 --build-master-only:跳过硬链,在 staging 内冷装(测 H1)

  写路径(--deploy/--bootstrap/--build-master-only,非 dry-run)会在 /run/openclaude-v5-selfhost/deploy.lock 上排队等锁,默认 2400s。
  覆盖: OC_V5_SELFHOST_DEPLOY_LOCK / OC_V5_SELFHOST_DEPLOY_LOCK_WAIT / OC_V5_SELFHOST_DEPLOY_LOCK_POLL
  覆盖路径同样校验(普通文件、root 所有、目录非世界可写、拒绝跟随符号链接)。

示例:
  scripts/deploy-v5-selfhost.sh --preflight
  scripts/deploy-v5-selfhost.sh --bootstrap --dry-run
  scripts/deploy-v5-selfhost.sh --bootstrap
  scripts/deploy-v5-selfhost.sh --deploy
  scripts/deploy-v5-selfhost.sh --deploy --allow-dirty --platform-from-head
  scripts/deploy-v5-selfhost.sh --build-master-only
  scripts/deploy-v5-selfhost.sh --build-master-only --force-npm-ci
  scripts/deploy-v5-selfhost.sh --smoke
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --force-env) FORCE_ENV=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --platform-from-head) PLATFORM_FROM_HEAD=1 ;;
    --force-npm-ci) FORCE_NPM_CI=1 ;;
    --preflight|--bootstrap|--deploy|--smoke|--status|--build-master-only)
      [[ -z "$MODE" ]] || die "只能指定一个主模式(已有 --$MODE,又收到 $arg)"
      MODE="${arg#--}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$MODE" ]] || { usage >&2; exit 2; }
[[ "$FORCE_ENV" == 1 && "$MODE" != "bootstrap" ]] && die "--force-env 只能与 --bootstrap 同用"
[[ "$ALLOW_DIRTY" == 1 && "$MODE" != "deploy" ]] && die "--allow-dirty 只能与 --deploy 同用"
[[ "$PLATFORM_FROM_HEAD" == 1 && "$MODE" != "deploy" && "$MODE" != "bootstrap" ]] \
  && die "--platform-from-head 只能与 --deploy 或 --bootstrap 同用"
[[ "$FORCE_NPM_CI" == 1 && "$MODE" != "build-master-only" ]] \
  && die "--force-npm-ci 只能与 --build-master-only 同用"
[[ -f "$MASTER_RELEASE_LIB" ]] || die "缺 master release lib: $MASTER_RELEASE_LIB"

# 锁自测钩子:只加锁再 sleep,不碰发布路径。给并发/超时验证用,生产勿设。
if [[ -n "${OC_V5_SELFHOST_LOCK_SELFTEST_SLEEP:-}" ]]; then
  [[ "$OC_V5_SELFHOST_LOCK_SELFTEST_SLEEP" =~ ^[0-9]+$ ]] \
    || die "OC_V5_SELFHOST_LOCK_SELFTEST_SLEEP 必须是非负整数秒"
  acquire_selfhost_deploy_lock
  log "selftest: 持锁 pid=$$ sleep=${OC_V5_SELFHOST_LOCK_SELFTEST_SLEEP}s lock=$SELFHOST_DEPLOY_LOCK"
  sleep "$OC_V5_SELFHOST_LOCK_SELFTEST_SLEEP"
  log "selftest: sleep 结束,进程退出后内核释放锁"
  exit 0
fi

[[ "$REPO_ROOT" == /opt/openclaude/openclaude-v5-selfhost ]] \
  || die "必须在 /opt/openclaude/openclaude-v5-selfhost 内执行(当前 REPO_ROOT=$REPO_ROOT)。补救: cd 到该 worktree 再跑。"

maybe_acquire_selfhost_deploy_lock

# ── 只读检查 ─────────────────────────────────────────────────────────────

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令 $1。补救: 安装后再跑。"
}

port_in_use() {
  local port="$1"
  ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .
}

assert_personal_alive() {
  local st code
  st="$(systemctl is-active "$PERSONAL_UNIT" 2>/dev/null || true)"
  [[ "$st" == active ]] || die "个人版 $PERSONAL_UNIT 不是 active(当前=${st:-<none>})。部署不得在个人版掉线时继续。补救: systemctl start $PERSONAL_UNIT 并确认 127.0.0.1:$PERSONAL_PORT/healthz 为 200。"
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PERSONAL_PORT}/healthz" || true)"
  [[ "$code" == 200 ]] || die "个人版 127.0.0.1:${PERSONAL_PORT}/healthz 不是 200(got=${code:-<empty>})。补救: 先恢复个人版再部署。"
}

assert_secrets() {
  [[ -f "$SECRETS_ENV" ]] || die "缺少 $SECRETS_ENV。补救: 确认本机模型密钥文件存在。"
  grep -qE '^ARK_CODING_PLAN_KEY=.+' "$SECRETS_ENV" \
    || die "$SECRETS_ENV 未包含非空 ARK_CODING_PLAN_KEY(glm-5.2 必需)。补救: 写入该键后再跑(脚本不会把密钥打印到 stdout)。"
}

assert_runtime_image() {
  local id
  id="$(docker image inspect --format '{{.Id}}' "$RUNTIME_IMAGE" 2>/dev/null || true)"
  [[ -n "$id" ]] || die "本机没有 runtime 镜像 $RUNTIME_IMAGE。本方案不 build 镜像。补救: 先把该 slim 镜像 load/tag 到本机 docker。"
  log "  ✓ runtime image $RUNTIME_IMAGE id=${id:0:19}…"
}

subnet_conflict() {
  local nets info subnet
  nets="$(docker network ls -q 2>/dev/null || true)"
  [[ -n "$nets" ]] || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    info="$(docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}' "$id" 2>/dev/null || true)"
    subnet="${info##* }"
    [[ "$subnet" == 172.31.0.0/16 ]] || continue
    [[ "$info" == openclaude-v5-net* ]] && continue
    echo "$info"
    return 0
  done <<<"$nets"
  return 1
}

preflight_residue() {
  local leftover
  if docker network inspect openclaude-v5-net >/dev/null 2>&1; then
    die "发现 docker 网络 openclaude-v5-net。视为 V5 残留,拒绝自动 adopt/删除。补救: 人工确认来源后自行 docker network rm,或若这是本 selfhost 实例请改跑 --deploy。"
  fi
  leftover="$(docker ps -a --filter label=com.openclaude.v3.runtime_channel=v5 --format '{{.ID}} {{.Names}}' 2>/dev/null || true)"
  [[ -z "$leftover" ]] || die "发现 channel=v5 容器:
$leftover
拒绝自动 adopt/删除。补救: 人工确认后 docker rm,或改跑 --deploy。"
  leftover="$(docker volume ls --filter label=com.openclaude.v3.runtime_channel=v5 --format '{{.Name}}' 2>/dev/null || true)"
  [[ -z "$leftover" ]] || die "发现 channel=v5 volume:
$leftover
拒绝自动 adopt/删除。补救: 人工确认后 docker volume rm。"
  leftover="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep '^oc-v5-' || true)"
  [[ -z "$leftover" ]] || die "发现 oc-v5-* volume:
$leftover
拒绝自动 adopt/删除。补救: 人工确认后 docker volume rm。"
}

preflight_ports_idle() {
  local p
  for p in "$V5_PORT" "$V5_EGRESS_PORT" "$V5_BASELINE_PORT"; do
    if port_in_use "$p"; then
      die "端口 $p 已被占用。补救: ss -ltnp sport = :$p 查占用进程;本实例 master=$V5_PORT egress=$V5_EGRESS_PORT,18893 必须空闲。"
    fi
  done
  if port_in_use "$V5_CONTROL_PORT"; then
    die "端口 $V5_CONTROL_PORT 已被占用(OC_EGRESS_SPLIT 控制口 INTERNAL_CONTROL_PORT)。补救: ss -ltnp sport = :$V5_CONTROL_PORT。"
  fi
}

preflight_common() {
  require_cmd docker
  require_cmd psql
  require_cmd jq
  require_cmd curl
  require_cmd openssl
  require_cmd rsync
  require_cmd git
  require_cmd ss
  require_cmd systemctl
  require_cmd iptables
  require_cmd npm
  [[ -x "$OC_BUN_BIN" ]] || die "找不到 bun($OC_BUN_BIN)。release 构建的 ccb dist 需要它。补救: 安装 bun 到 /usr/local/bin/bun。"
  [[ -x "$SETUP_HOST_NET" ]] || die "缺 setup-host-net.sh: $SETUP_HOST_NET"
  [[ -f "$RUNTIME_LIB" ]] || die "缺 runtime release lib: $RUNTIME_LIB"
  [[ -f "$EXCLUDES" ]] || die "缺 runtime-src-excludes.txt: $EXCLUDES"
  [[ -d "$PLATFORM_SRC" ]] || die "缺 platform-runtime 源: $PLATFORM_SRC"
  [[ -f "$SEED_CLI" ]] || die "缺 seed 校验 CLI: $SEED_CLI"
  [[ -f "$UNIT_DIR/$V5_UNIT" ]] || die "缺 unit 模板: $UNIT_DIR/$V5_UNIT"
  assert_secrets
  assert_personal_alive
  assert_runtime_image
  local conflict
  conflict="$(subnet_conflict || true)"
  [[ -z "$conflict" ]] || die "网段 172.31.0.0/16 被其它 docker 网络占用: $conflict。补救: 人工处理冲突网络,不要改 selfhost 网段。"
}

cmd_preflight() {
  log "══ selfhost preflight(只读) ══"
  preflight_common
  preflight_residue
  preflight_ports_idle
  log "✓ preflight 通过:无 V5 残留,端口空闲,密钥在,个人版仍 active。"
}

# ── PG / migration ───────────────────────────────────────────────────────

psql_as_postgres() {
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 "$@"
}

pg_role_exists() {
  [[ "$(psql_as_postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='${PG_ROLE}'")" == 1 ]]
}

pg_db_exists() {
  [[ "$(psql_as_postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'")" == 1 ]]
}

assert_connected_db() {
  local url="$1" got
  got="$(psql "$url" -X -tAc "SELECT current_database();" | tr -d '[:space:]')"
  log "  current_database()=${got}"
  [[ "$got" == "$PG_DB" ]] || die "连库闸失败: current_database()='${got}' 不等于 '${PG_DB}'。拒绝继续,防止误连生产/个人版库。补救: 检查 DATABASE_URL 只指向 127.0.0.1:5432/${PG_DB}。"
}

ensure_pg() {
  local pass="$1"
  log "── 建 PG role/库 ${PG_ROLE}/${PG_DB} ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] CREATE/ALTER ROLE $PG_ROLE + CREATE DATABASE $PG_DB (已存在则跳过;密码不打印)"
    return 0
  fi
  if pg_role_exists; then
    log "  ⚠ role $PG_ROLE 已存在 → 跳过 CREATE ROLE,按本次密码 ALTER。"
    psql_as_postgres -c "ALTER ROLE ${PG_ROLE} WITH LOGIN PASSWORD '${pass}'"
  else
    psql_as_postgres -c "CREATE ROLE ${PG_ROLE} LOGIN PASSWORD '${pass}'"
    log "  ✓ 已创建 role $PG_ROLE"
  fi
  if pg_db_exists; then
    log "  ⚠ 库 $PG_DB 已存在 → 跳过 CREATE DATABASE"
  else
    psql_as_postgres -c "CREATE DATABASE ${PG_DB} OWNER ${PG_ROLE}"
    log "  ✓ 已创建库 $PG_DB"
  fi
}

run_migrations() {
  local url="$1" migration_pgoptions
  log "── 跑 commercial 全量 migration(仓库既有 runner) ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 断言 current_database()=$PG_DB; migration_profile=v5-selfhost; DATABASE_URL=<redacted> REDIS_URL=$REDIS_URL npx --no-install tsx packages/commercial/src/db/migrate.ts"
    return 0
  fi
  assert_connected_db "$url"
  [[ -d "$REPO_ROOT/node_modules" ]] || die "worktree 无 node_modules,无法跑 migration runner。补救: 先 npm ci。"
  # 0210 的生产 users 1/4 grant 契约不适用于独立 selfhost 用户 ID 空间。
  # 只把 exact profile 绑到本 migration 子进程；不得 export 到 deploy 的其它步骤。
  migration_pgoptions="${PGOPTIONS:+${PGOPTIONS} }-c openclaude.migration_profile=v5-selfhost"
  env PGOPTIONS="$migration_pgoptions" DATABASE_URL="$url" REDIS_URL="$REDIS_URL" \
    COMMERCIAL_ENABLED=1 COMMERCIAL_AUTO_MIGRATE=1 \
    npx --no-install tsx packages/commercial/src/db/migrate.ts \
    || die "migration 失败。补救: 看上方 [commercial/migrate] 日志;确认连的是 ${PG_DB} 且 pgcrypto 可由库 owner 创建。"
}

enable_registration() {
  local url="$1"
  log "── 打开 system_settings.allow_registration ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 断言 current_database()=$PG_DB; INSERT allow_registration=true ON CONFLICT UPDATE"
    return 0
  fi
  assert_connected_db "$url"
  psql "$url" -X -v ON_ERROR_STOP=1 -c \
    "INSERT INTO system_settings(key, value, updated_at)
     VALUES ('allow_registration','true'::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW();" \
    || die "写 allow_registration 失败。补救: 确认 migration 已建 system_settings 且连的是 ${PG_DB}。"
  log "  ✓ allow_registration=true"
}

# ── model authority ──────────────────────────────────────────────────────
#
# 不开 OC_MODEL_AUTHORITY,master 不处理容器 attest → containerHasDurableDispatch 恒 false
# → 永不 admitUserTurn → turn_dispatches 空 → liveTurnFrames 的 streamKey 退化成
# legacy:<容器>:<会话>(不含 clientMessageId)→ 同一会话第二条消息撞上第一条建的
# client_session_live_streams 行 → "live frame stream identity conflict" → 整条连接断。
# 生产这个键由 deploy-v5.sh --enable-model-authority 单独写入,不在 commercial-v5.env.overrides
# 里,照抄 overrides 就会漏(2026-08-14 本实例即因此每个会话只能发一条消息)。
#
# 开 flag 后 master 启动期 fail-closed 要求 MODEL_CATALOG_ADMIN_DATABASE_URL 指向一个与
# app role **不同名**的角色(modelCatalogAdmin.ts:26),所以角色与 flag 必须同一步写齐,
# 否则 master 拒启。授权只走 0144 定义的 fn_model_authority_grant_admin_role:它先撤直写
# 权限再授 SELECT + 受控 mutation procedure + admin_audit,手工授表权限既过宽又会漏审计权限。
#
# 回滚不是「删掉 flag 重启」:已带 flag 的容器仍要求签名 envelope,而关掉的 master 不再
# 签发,清退完成前用户消息会被 runtime 拒(modelAuthorityRollback.ts:4-8)。正确顺序是
# ① 保持 OC_MODEL_AUTHORITY=1,先把 OC_MODEL_AUTHORITY_PROVISION_REQUIRED 改 0 并重启,
# 停止制造新强制容器;② authenticated drain 掉所有 flagged/provisioning/unknown 容器并
# 满足 quiet window;③ 最后才关总 flag,且仍按 egress→master 顺序切。

ensure_model_authority() {
  local pass admin_url cur got
  log "── 启用 model authority(durable turn dispatch 的前置)──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 建 role ${CATALOG_ADMIN_ROLE} + fn_model_authority_grant_admin_role();upsert MODEL_CATALOG_ADMIN_DATABASE_URL / OC_MODEL_AUTHORITY=1 / OC_MODEL_AUTHORITY_PROVISION_REQUIRED=1"
    return 0
  fi
  [[ -f "$V5_ENV" ]] || die "缺 $V5_ENV。补救: write_env_file 应先跑。"

  # 已有可连的 admin URL 就不轮换密码,避免每次 deploy 无谓改密。
  cur="$(oc_hotcfg_env_get "$V5_ENV" MODEL_CATALOG_ADMIN_DATABASE_URL)"
  if [[ -n "$cur" ]] && psql "$cur" -X -tAc 'SELECT 1' >/dev/null 2>&1; then
    admin_url="$cur"
    log "  ⚠ catalog admin 连接已可用 → 保留现有密码"
  else
    # hex 密码:URL 里无需 percent-encode。
    pass="$(openssl rand -hex 24)"
    psql_as_postgres -d "$PG_DB" -c "
      DO \$\$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${CATALOG_ADMIN_ROLE}') THEN
          ALTER ROLE ${CATALOG_ADMIN_ROLE} WITH LOGIN PASSWORD '${pass}';
        ELSE
          CREATE ROLE ${CATALOG_ADMIN_ROLE} LOGIN PASSWORD '${pass}';
        END IF;
      END
      \$\$;
      GRANT CONNECT ON DATABASE ${PG_DB} TO ${CATALOG_ADMIN_ROLE};
      GRANT USAGE ON SCHEMA public TO ${CATALOG_ADMIN_ROLE};" \
      || die "建 catalog admin role 失败。补救: 确认能 sudo -u postgres 且库 ${PG_DB} 可连。"
    admin_url="postgres://${CATALOG_ADMIN_ROLE}:${pass}@127.0.0.1:5432/${PG_DB}"
    log "  ✓ role ${CATALOG_ADMIN_ROLE} 就绪"
  fi

  # 幂等,且后续 migration 新增受控 procedure 后能补授权,所以每次都重跑。
  psql_as_postgres -d "$PG_DB" -c "SELECT fn_model_authority_grant_admin_role('${CATALOG_ADMIN_ROLE}')" >/dev/null \
    || die "fn_model_authority_grant_admin_role 执行失败。补救: 确认 0144_model_authority_guards 已 apply(run_migrations 应先跑)。"

  # 启动期断言等价校验:角色解析正确 + 真拿到 catalog 读与审计写。
  got="$(psql "$admin_url" -X -tAc "SELECT current_user || ':' || has_table_privilege('model_catalog','SELECT')::text || ':' || has_table_privilege('admin_audit','INSERT')::text" | tr -d '[:space:]')"
  # boolean::text 是 'true'/'false',不是 psql 布尔列显示的 t/f。
  [[ "$got" == "${CATALOG_ADMIN_ROLE}:true:true" ]] \
    || die "catalog admin 权限校验失败(得到 '${got}',期望 '${CATALOG_ADMIN_ROLE}:true:true')。补救: 检查 fn_model_authority_grant_admin_role 是否覆盖 model_catalog/admin_audit。"

  ensure_env_kv "$V5_ENV" MODEL_CATALOG_ADMIN_DATABASE_URL "$admin_url"
  ensure_env_kv "$V5_ENV" OC_MODEL_AUTHORITY 1
  ensure_env_kv "$V5_ENV" OC_MODEL_AUTHORITY_PROVISION_REQUIRED 1
  log "  ✓ OC_MODEL_AUTHORITY=1 / PROVISION_REQUIRED=1 / MODEL_CATALOG_ADMIN_DATABASE_URL"
}

# ── env / HOME ───────────────────────────────────────────────────────────

# 从 secrets.env 追加 provider 相关键。永不把值打印到 stdout。
# 跳过任何 DATABASE/REDIS/SESSION/JWT/KMS/HUPIJIAO,避免把个人版库 URL 写进来。
append_provider_keys() {
  local dest="$1" line key
  [[ -f "$SECRETS_ENV" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    case "$key" in
      *DATABASE*|*REDIS*|HUPIJIAO*|COMMERCIAL_JWT*|JWT_SECRET|OPENCLAUDE_KMS*|PLATFORM_HMAC*|OC_EGRESS_SECRET*)
        continue
        ;;
    esac
    case "$key" in
      ARK_*|DEEPSEEK_*|DEEPGRAM_*|EMBEDDING_*|OPENAI_*|ANTHROPIC_*|GLM_*|DASHSCOPE_*|MOONSHOT_*|MINIMAX_*|GROK_*|GEMINI_*|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|*_API_KEY|*_API_TOKEN)
        printf '%s\n' "$line" >>"$dest"
        ;;
    esac
  done <"$SECRETS_ENV"
}

write_env_file() {
  local pass="$1" jwt kms hmac egress tmp
  log "── 生成 $V5_ENV ──"
  if [[ -f "$V5_ENV" && "$FORCE_ENV" != 1 ]]; then
    log "  ⚠ $V5_ENV 已存在 → 保留不覆盖(权威=现网文件)。要重建请加 --force-env"
    return 0
  fi
  if [[ -f "$V5_ENV" && "$FORCE_ENV" == 1 ]]; then
    log "  ⚠ --force-env:将覆盖已存在的 env(旧文件备份为 ${V5_ENV}.bak-force)"
    run "cp -a '$V5_ENV' '${V5_ENV}.bak-force-$(date -u +%Y%m%d%H%M%S)'"
  fi
  jwt="$(openssl rand -hex 32)"
  # crypto/keys.ts 要求 OPENCLAUDE_KMS_KEY 是 base64(32 bytes),不是 hex。
  kms="$(openssl rand -base64 32 | tr -d '\n')"
  hmac="$(openssl rand -hex 32)"
  egress="$(openssl rand -hex 32)"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 写 $V5_ENV (mode 600;密钥不打印)"
    return 0
  fi
  tmp="$(mktemp)"
  local old_umask
  old_umask="$(umask)"
  umask 077
  cat >"$tmp" <<EOF
# commercial-v5-selfhost.env — 本机自用 V5,由 scripts/deploy-v5-selfhost.sh 生成。
# 人工不要手改 OC_RUNTIME_* 四元组;由 hotcfg saga 原子写入。
COMMERCIAL_ENABLED=1
OC_RUNTIME_CHANNEL=v5
OC_CONTROL_PLANE_LEADER=1
OC_SELFHEAL_DISABLED=1
OC_INSTANCE_ID=${INSTANCE_ID}
OC_SLOT=A
DATABASE_URL=postgres://${PG_ROLE}:${pass}@127.0.0.1:5432/${PG_DB}
REDIS_URL=${REDIS_URL}
COMMERCIAL_JWT_SECRET=${jwt}
OPENCLAUDE_KMS_KEY=${kms}
PLATFORM_HMAC_SECRET=${hmac}
OC_EGRESS_SECRET=${egress}
OC_V3_MEMORY_MB=4096
OC_V3_CPUS=2
OC_V3_PIDS_LIMIT=4096
OC_IDLE_SWEEP_DISABLED=1
OC_VOLUME_GC_DISABLED=1
COMMERCIAL_AUTO_MIGRATE=0
# 制品根覆盖:OC_HOTCFG_* 只决定构建产物落在哪,master 侧校验 release/bundle 走这两个键。
# 不配则回落 DEFAULT_*_ROOT(/var/lib/openclaude-v5/...) → 本实例 release 一律判 invalid、拒 provision。
# 下面两行在生成时展开为真实路径(EnvironmentFile 不会二次展开)。
OC_PLATFORM_ROOT=${OC_HOTCFG_PLATFORM_ROOT}
OC_RUNTIME_RELEASES_ROOT=${OC_HOTCFG_RELEASES_ROOT}
# 与 sessions_store_migration_state=pg_authoritative + 本地 manifest 三件套必须同时到位,
# 否则启动矩阵 fail-closed 拒起(env≠pg 不得退回 SQLite)。
OC_SESSIONS_STORE=pg
TURNSTILE_ENFORCE=0
WECHAT_BROKER_ENABLED=0
OC_EGRESS_SPLIT=1
INTERNAL_PROXY_BIND=${V5_EGRESS_BIND}
INTERNAL_PROXY_PORT=${V5_EGRESS_PORT}
INTERNAL_CONTROL_BIND=${V5_CONTROL_BIND}
INTERNAL_CONTROL_PORT=${V5_CONTROL_PORT}
AGENT_RPC_SOCKET_DIR=/var/run/openclaude-agent-rpc-v5-selfhost
AGENT_DOCKER_SOCKET=/var/run/docker.sock
OC_RUNTIME_IMAGE=${RUNTIME_IMAGE}
OC_PREHEAT_DISABLED=1
OC_IMAGE_DISTRIBUTE_DISABLED=1
OC_MIGRATION_RECONCILER_DISABLED=1
OC_HEALTH_POLLER_DISABLED=1
EOF
  append_provider_keys "$tmp"
  mkdir -p "$(dirname "$V5_ENV")"
  mv -f "$tmp" "$V5_ENV"
  chmod 600 "$V5_ENV"
  umask "$old_umask"
  log "  ✓ 已写入 $V5_ENV (mode 600;密钥未打印)"
}

ensure_home_config() {
  local json="$V5_HOME/openclaude.json" token
  log "── HOME $V5_HOME / openclaude.json ──"
  run "mkdir -p '$V5_HOME'"
  if [[ -f "$json" ]]; then
    log "  ⚠ openclaude.json 已存在 → 保留(权威=现网 HOME)"
    return 0
  fi
  token="$(openssl rand -hex 24)"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 写 $json (bind=127.0.0.1 port=$V5_PORT model=glm-5.2 channels.webchat only)"
    return 0
  fi
  local old_umask
  old_umask="$(umask)"
  umask 077
  cat >"$json" <<EOF
{
  "version": 1,
  "gateway": {
    "bind": "127.0.0.1",
    "port": ${V5_PORT},
    "accessToken": "${token}"
  },
  "auth": {
    "mode": "custom_platform",
    "claudeCodePath": "${REPO_ROOT}/claude-code-best",
    "claudeCodeEntry": "src/entrypoints/cli.tsx",
    "claudeCodeRuntime": "bun"
  },
  "defaults": {
    "model": "glm-5.2",
    "permissionMode": "acceptEdits"
  },
  "channels": {
    "webchat": { "enabled": true }
  }
}
EOF
  chmod 600 "$json"
  umask "$old_umask"
  log "  ✓ 已写 $json (accessToken 不打印;默认模型 glm-5.2;未启用 telegram/wechat)"
}

# 幂等 upsert env 键。值不含换行/|;不打印 val(可能跟在含密钥的文件里)。
ensure_env_kv() {
  local file="$1" key="$2" val="$3" cur
  cur="$(oc_hotcfg_env_get "$file" "$key")"
  if [[ "$cur" == "$val" ]]; then
    return 0
  fi
  if grep -Eq "^[[:space:]]*${key}=" "$file"; then
    sed -i "s|^[[:space:]]*${key}=.*|${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >>"$file"
  fi
  chmod 600 "$file"
}

ensure_selfhost_env_keys() {
  log "── 确认制品根 + OC_SESSIONS_STORE=pg 写在 $V5_ENV ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] upsert OC_PLATFORM_ROOT OC_RUNTIME_RELEASES_ROOT OC_SESSIONS_STORE=pg"
    return 0
  fi
  [[ -f "$V5_ENV" ]] || die "缺 $V5_ENV。补救: write_env_file 应先跑。"
  ensure_env_kv "$V5_ENV" OC_PLATFORM_ROOT "$OC_HOTCFG_PLATFORM_ROOT"
  ensure_env_kv "$V5_ENV" OC_RUNTIME_RELEASES_ROOT "$OC_HOTCFG_RELEASES_ROOT"
  ensure_env_kv "$V5_ENV" OC_SESSIONS_STORE pg
  log "  ✓ OC_PLATFORM_ROOT / OC_RUNTIME_RELEASES_ROOT / OC_SESSIONS_STORE=pg"
}

ensure_worktree_complete() {
  local sha marker tmp uid mode perm
  sha="$(source_commit)"
  marker="$REPO_ROOT/.complete"
  log "── 写 $marker (sourceCommit=$sha) ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] jq {sourceCommit:$sha} → $marker (root:root 644)"
    return 0
  fi
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "HEAD 不是 40 位 hex: $sha"
  uid="$(stat -c '%u' "$REPO_ROOT")"
  perm="$(stat -c '%a' "$REPO_ROOT")"
  [[ "$uid" == 0 ]] || die "worktree $REPO_ROOT 属主 uid=$uid 不是 root。readSyntheticEvalReleaseSourceCommit 会 lstat cwd 并要求 root 拥有。补救: chown root:root $REPO_ROOT"
  if (( (8#$perm & 8#022) != 0 )); then
    die "worktree $REPO_ROOT mode=$perm 对 group/other 可写。assertRootOwnedSafe 会拒。补救: chmod go-w $REPO_ROOT(不要对子树乱 chmod)。"
  fi
  tmp="$REPO_ROOT/.complete.tmp.$$"
  jq -n --arg sourceCommit "$sha" '{sourceCommit:$sourceCommit}' >"$tmp" \
    || { rm -f "$tmp"; die "写 $tmp 失败"; }
  chmod 644 "$tmp"
  chown root:root "$tmp"
  mv -f "$tmp" "$marker"
  read -r uid mode < <(stat -Lc '%u %a' "$marker")
  [[ "$uid" == 0 && "$mode" == 644 ]] \
    || die "$marker 属主/权限不可信(uid=$uid mode=$mode,期望 uid=0 mode=644)。"
  [[ "$(jq -er '.sourceCommit' "$marker")" == "$sha" ]] \
    || die "$marker sourceCommit 与 HEAD 不一致。"
  log "  ✓ $marker sourceCommit=$sha uid=0 mode=644"
}

assert_selfhost_master_stopped() {
  local st
  st="$(systemctl is-active "$V5_UNIT" 2>/dev/null || true)"
  if [[ "$st" == "active" || "$st" == "activating" ]]; then
    die "$V5_UNIT 仍在运行(is-active=$st)。会话割接要求 master 已停(工具默认查的是生产 unit 名,本机等于假通过,所以这里查我们自己的 unit)。补救: systemctl stop $V5_UNIT 后再跑 --bootstrap。"
  fi
  log "  ✓ $V5_UNIT 已停(is-active=${st:-unknown})"
}

ensure_sessions_sqlite() {
  local sqlite="$V5_HOME/sessions.db"
  if [[ -f "$sqlite" ]]; then
    log "  ✓ $sqlite 已存在"
    return 0
  fi
  log "  sessions.db 不存在 → 用官方 getSessionsDb() 建空库 schema(割接工具要求文件+六表存在)"
  env OPENCLAUDE_HOME="$V5_HOME" npx --no-install tsx -e \
    'import { getSessionsDb, closeSessionsDb } from "@openclaude/storage"; await getSessionsDb(); await closeSessionsDb();' \
    || die "初始化 $sqlite 失败。补救: 确认 node_modules 与 @openclaude/storage 可 import。"
  [[ -f "$sqlite" ]] || die "getSessionsDb 跑完仍无 $sqlite"
  log "  ✓ 已建空 $sqlite"
}

cutover_sessions_to_pg() {
  local url="$1" sqlite manifest auth gen cutover mf_auth mf_gen mf_cut nonempty
  sqlite="$V5_HOME/sessions.db"
  manifest="$V5_HOME/sessions-store-authority.json"
  log "── 会话权威割接 SQLite → PG ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 断言 $V5_UNIT 已停; 若尚未 pg_authoritative 则 v5-sessions-backfill-pg.ts initial --yes"
    return 0
  fi
  assert_connected_db "$url"
  assert_selfhost_master_stopped
  auth="$(psql "$url" -X -tAc "SELECT authority FROM sessions_store_migration_state WHERE singleton = true;" | tr -d '[:space:]')"
  gen="$(psql "$url" -X -tAc "SELECT generation::text FROM sessions_store_migration_state WHERE singleton = true;" | tr -d '[:space:]')"
  cutover="$(psql "$url" -X -tAc "SELECT cutover_id FROM sessions_store_migration_state WHERE singleton = true;" | tr -d '[:space:]')"
  if [[ "$auth" == "pg_authoritative" ]]; then
    [[ -f "$manifest" ]] || die "PG 已是 pg_authoritative 但缺 $manifest。补救: npx tsx scripts/v5-sessions-backfill-pg.ts repair-manifest --cutover-id $cutover --manifest $manifest"
    mf_auth="$(jq -er '.authority' "$manifest")"
    mf_gen="$(jq -er '.generation|tostring' "$manifest")"
    mf_cut="$(jq -er '.cutoverId' "$manifest")"
    if [[ "$mf_auth" == "pg_authoritative" && "$mf_gen" == "$gen" && "$mf_cut" == "$cutover" ]]; then
      log "  ✓ 已是 pg_authoritative(generation=$gen)且 manifest 一致 → 跳过 initial"
      return 0
    fi
    die "PG 已是 pg_authoritative 但 manifest 不一致(manifest={authority:$mf_auth,generation:$mf_gen,cutover:$mf_cut} PG={generation:$gen,cutover:$cutover})。补救: repair-manifest,不要重跑 initial。"
  fi
  if [[ -n "$auth" ]]; then
    die "sessions_store_migration_state.authority=$auth,不是首次无行态,bootstrap 不自动 retry/disaster。补救: 按官方工具子命令人工处理(retry-initial / re-cutover-from-sqlite)。"
  fi
  nonempty="$(psql "$url" -X -tAc "
    SELECT string_agg(format('%s(%s)', t, n), ', ')
    FROM (
      SELECT 'client_sessions' AS t, count(*) AS n FROM client_sessions
      UNION ALL SELECT 'client_session_archive_chunks', count(*) FROM client_session_archive_chunks
      UNION ALL SELECT 'client_session_archived_ids', count(*) FROM client_session_archived_ids
      UNION ALL SELECT 'server_authored_request_map', count(*) FROM server_authored_request_map
      UNION ALL SELECT 'pending_usage_patches', count(*) FROM pending_usage_patches
      UNION ALL SELECT 'wechat_bindings', count(*) FROM wechat_bindings
    ) s WHERE n > 0;
  " | tr -d '\n')"
  if [[ -n "$nonempty" ]]; then
    die "会话六表非空: ${nonempty}。这是全新库首次 bootstrap 才应执行的步骤,若表非空说明已有数据,请人工确认。本脚本不会自动 DELETE。"
  fi
  ensure_sessions_sqlite
  [[ -f "$REPO_ROOT/scripts/v5-sessions-backfill-pg.ts" ]] \
    || die "缺 scripts/v5-sessions-backfill-pg.ts"
  log "  跑官方 initial --yes (DATABASE_URL 不打印;OC_V5_UNIT=$V5_UNIT)"
  env DATABASE_URL="$url" OPENCLAUDE_HOME="$V5_HOME" OC_V5_UNIT="$V5_UNIT" \
    npx --no-install tsx "$REPO_ROOT/scripts/v5-sessions-backfill-pg.ts" initial \
      --sqlite "$sqlite" \
      --manifest "$manifest" \
      --yes \
    || die "会话割接 initial 失败。状态可能留在 prepared(master 会拒起)。补救: 看上方工具输出;不要手写状态行。"
  log "  ✓ 会话权威已割接到 PG"
}

ensure_node_modules() {
  log "── worktree node_modules ──"
  if [[ -d "$REPO_ROOT/node_modules" ]]; then
    log "  ✓ node_modules 已存在,跳过 npm ci"
    return 0
  fi
  [[ -f "$REPO_ROOT/package-lock.json" ]] || die "缺 package-lock.json,无法 npm ci。"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] npm ci --no-audit --no-fund (worktree 无 node_modules,gateway/migrate 都需要)"
    return 0
  fi
  npm ci --no-audit --no-fund || die "npm ci 失败。补救: 检查网络/npm registry 后重跑。"
  log "  ✓ npm ci 完成"
}

build_frontend() {
  # master 在 OC_RUNTIME_CHANNEL=v5 时从 packages/cli/src/commands/gateway.ts
  # resolve(..., '../../../web-react/dist') 即本 worktree 的 packages/web-react/dist
  # 自己 serve SPA(Gateway spa 模式 + index.html fallback)。无 Caddy;产物不必进
  # runtime-releases(那是容器源,runtime-src-excludes 排除 /dist/)。
  local dist="$REPO_ROOT/packages/web-react/dist"
  log "── 构建 web-react SPA (npm run build → tsc -b && vite build) ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] NODE_OPTIONS=--max-old-space-size=4096 npm run build --workspace packages/web-react"
    return 0
  fi
  # 本机 ~15GiB 且个人版在跑。max-old-space-size 是堆上限不是预留;vite/tsc 通常 1-2GiB。
  NODE_OPTIONS='--max-old-space-size=4096' npm run build --workspace packages/web-react \
    || die "web-react 构建失败。补救: 看上方 tsc/vite 输出;内存紧张时确认个人版未把 RAM 吃满。"
  [[ -f "$dist/index.html" ]] || die "构建后缺 $dist/index.html。master 从该路径 serve SPA(无 Caddy)。"
  local build_id
  build_id="$(grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$dist/index.html" | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
  [[ -n "$build_id" ]] || die "dist/index.html 缺 oc-build meta(vite ocBuildMeta 插件失效?)"
  log "  ✓ web-react dist oc-build=$build_id"
}

# ── 网络 / unit / release ────────────────────────────────────────────────

setup_v5_net() {
  log "── setup-host-net.sh v5(完整执行,含 iptables egress guard) ──"
  [[ -x "$SETUP_HOST_NET" ]] || die "setup-host-net.sh 不可执行"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] bash $SETUP_HOST_NET v5   # 不用 SETUP_NET_ONLY=1"
    return 0
  fi
  bash "$SETUP_HOST_NET" v5 || die "setup-host-net.sh v5 失败。补救: 看其 [ABORT] 输出;网络已存在但配置不符时需人工 docker network rm。"
}

install_unit() {
  local src="$1" name
  name="$(basename "$src")"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] install $src → /etc/systemd/system/$name"
    return 0
  fi
  install -m 0644 "$src" "/etc/systemd/system/$name"
}

install_units() {
  log "── 安装 systemd unit ──"
  install_unit "$UNIT_DIR/$V5_HOSTNET_UNIT"
  install_unit "$UNIT_DIR/$V5_SSHGATE_UNIT"
  install_unit "$UNIT_DIR/$V5_EGRESS_UNIT"
  install_unit "$UNIT_DIR/$V5_UNIT"
  install_unit "$UNIT_DIR/$V5_TUNNEL_UNIT"
  run "systemctl daemon-reload"
  run "systemctl enable '$V5_HOSTNET_UNIT' '$V5_SSHGATE_UNIT'"
}

restart_sshgate() {
  log "── 显式 restart $V5_SSHGATE_UNIT(setup-host-net 会 flush V5_EGRESS_IN,oneshot 不会自己再跑) ──"
  run "systemctl enable '$V5_HOSTNET_UNIT' '$V5_SSHGATE_UNIT'"
  run "systemctl restart '$V5_SSHGATE_UNIT'"
}

read_env_db_url() {
  [[ -f "$V5_ENV" ]] || die "缺 env 文件 $V5_ENV。补救: 先 --bootstrap。"
  grep -E '^DATABASE_URL=' "$V5_ENV" | tail -n1 | cut -d= -f2-
}

source_commit() {
  git -C "$REPO_ROOT" rev-parse HEAD
}

runtime_caps_from_metadata() {
  local sha="$1"
  git -C "$REPO_ROOT" show "${sha}:deploy/v5/release-metadata.json" \
    | jq -er '.runtimeCapabilities | join(" ")'
}

build_platform_bundle() {
  local sha="$1" nonce staging rev src
  log "── build platform bundle ──"
  src="$PLATFORM_SRC"
  if [[ "$PLATFORM_FROM_HEAD" == 1 ]]; then
    log "  源: git archive $sha (已提交 platform-runtime;忽略工作树脏文件)"
  else
    log "  源: 工作树 $PLATFORM_SRC"
    [[ -d "$PLATFORM_SRC/prompts" ]] || die "platform-runtime 缺 prompts/"
  fi
  if [[ "$DRY" == 1 ]]; then
    if [[ "$PLATFORM_FROM_HEAD" == 1 ]]; then
      echo "  [dry-run] git archive $sha platform-runtime → tmp; validatePlatformSeedCli; oc_hotcfg_finalize_bundle"
    else
      echo "  [dry-run] cp platform-runtime → bundles/.staging; validatePlatformSeedCli; oc_hotcfg_finalize_bundle"
    fi
    BUILT_BUNDLE_REV="dryrunbundle0"
    return 0
  fi
  if [[ "$PLATFORM_FROM_HEAD" == 1 ]]; then
    PLATFORM_ARCHIVE_TMP="$(mktemp -d -t oc-v5-selfhost-platform.XXXXXX)" \
      || die "mktemp 平台 bundle 临时目录失败"
    git -C "$REPO_ROOT" archive --format=tar "$sha" -- packages/commercial/agent-sandbox/platform-runtime \
      | tar -x -C "$PLATFORM_ARCHIVE_TMP" \
      || { rm -rf "$PLATFORM_ARCHIVE_TMP"; PLATFORM_ARCHIVE_TMP=""; die "git archive platform-runtime 失败"; }
    src="$PLATFORM_ARCHIVE_TMP/packages/commercial/agent-sandbox/platform-runtime"
  fi
  [[ -d "$src/prompts" ]] || die "platform-runtime 缺 prompts/: $src"
  nonce="$(openssl rand -hex 8)"
  staging="$OC_HOTCFG_PLATFORM_ROOT/bundles/.staging-$nonce"
  mkdir -p "$OC_HOTCFG_PLATFORM_ROOT/bundles"
  rm -rf "$staging"
  mkdir -p "$staging"
  cp -a "$src/." "$staging/"
  ( cd "$REPO_ROOT" && npx --no-install tsx "$SEED_CLI" "$staging" ) \
    || { rm -rf "$staging"; die "seed 语义校验失败"; }
  rev="$(oc_hotcfg_finalize_bundle "$staging" 1 "$sha")" \
    || die "bundle finalize 失败"
  rev="$(printf '%s' "$rev" | tr -d '[:space:]')"
  [[ "$rev" =~ ^[0-9a-f]{12}$ ]] || die "bundle rev 非法: $rev"
  BUILT_BUNDLE_REV="$rev"
  if [[ -n "${PLATFORM_ARCHIVE_TMP:-}" ]]; then
    rm -rf "$PLATFORM_ARCHIVE_TMP"
    PLATFORM_ARCHIVE_TMP=""
  fi
  log "  ✓ platform bundle rev=$BUILT_BUNDLE_REV"
}

build_runtime_release() {
  local sha="$1" caps nonce raw staging prev image_id
  log "── build runtime release(git archive + prune + finalize) ──"
  caps="$(runtime_caps_from_metadata "$sha")" \
    || die "读 release-metadata.json runtimeCapabilities 失败"
  image_id="$(docker image inspect --format '{{.Id}}' "$RUNTIME_IMAGE")" \
    || die "inspect runtime 镜像失败"
  RUNTIME_IMAGE_ID="$image_id"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] git archive $sha → prune --exclude-from=$EXCLUDES → oc_hotcfg_finalize_release"
    BUILT_RUNTIME_RELEASE="$OC_HOTCFG_RELEASES_ROOT/rel-dryrunrelease"
    return 0
  fi
  prev="$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_RELEASE || true)"
  nonce="$(openssl rand -hex 8)"
  raw="$OC_HOTCFG_RELEASES_ROOT/.raw-$nonce"
  staging="$OC_HOTCFG_RELEASES_ROOT/.staging-$nonce"
  mkdir -p "$OC_HOTCFG_RELEASES_ROOT"
  rm -rf "$raw" "$staging"
  mkdir -p "$raw" "$staging"
  git -C "$REPO_ROOT" archive --format=tar "$sha" | tar -x -C "$raw" \
    || { rm -rf "$raw" "$staging"; die "git archive 失败"; }
  rsync -a --exclude-from="$EXCLUDES" "$raw/" "$staging/" \
    || { rm -rf "$raw" "$staging"; die "rsync prune 失败"; }
  rm -rf "$raw"
  BUILT_RUNTIME_RELEASE="$(oc_hotcfg_finalize_release "$staging" "$image_id" "$sha" "${prev:-}" "$caps")" \
    || { rm -rf "$staging"; die "release finalize 失败(npm ci / ccb bun build / MANIFEST)"; }
  BUILT_RUNTIME_RELEASE="$(printf '%s' "$BUILT_RUNTIME_RELEASE" | tr -d '[:space:]')"
  [[ "$BUILT_RUNTIME_RELEASE" == "$OC_HOTCFG_RELEASES_ROOT"/rel-* ]] \
    || die "release 目录非法: $BUILT_RUNTIME_RELEASE"
  log "  ✓ runtime release=$BUILT_RUNTIME_RELEASE"
}

hotcfg_smoke_cmd() {
  # 该字符串稍后由 oc_hotcfg_activate_saga eval;单引号是故意的,让 $hz/$i 在 eval 时展开。
  # shellcheck disable=SC2016
  printf '%s' 'hz=""; for i in $(seq 1 30); do hz=$(curl -fsS --max-time 5 http://127.0.0.1:'"$V5_PORT"'/healthz 2>/dev/null||true); echo "$hz" | jq -e ".ok==true and .runtime.controlPlaneEnabled==true and .runtime.leadership.state==\"leader\"" >/dev/null 2>&1 && break; sleep 2; done; echo "$hz" | jq -e ".ok==true and .runtime.controlPlaneEnabled==true and .runtime.leadership.state==\"leader\"" >/dev/null'
}

# egress 必须先于 master 就绪:反过来会出现「新 master 已签发 authority envelope、
# 旧 egress 还没 enforce」的 fail-open 窗口(尤其 ensure_model_authority 刚把 flag 从
# 无写到有的那次 deploy)。一次 systemctl 传两个 unit 是并行提交 job,不保证顺序,
# 两个 unit 之间也没有 Before/After 依赖,所以这里显式串行 + 就绪断言。
#
# 判据用端口而不是解析 append-only 日志:egress/main.ts 里 model_catalog_ready(:189)
# 早于 egress_listening(:493),所以「端口可连」即「catalog 已就绪且 enforce 已定」。
egress_then_master_restart_cmd() {
  printf '%s' "systemctl restart '$V5_EGRESS_UNIT' && timeout 90 bash -c 'until (exec 3<>/dev/tcp/$V5_EGRESS_BIND/$V5_EGRESS_PORT) 2>/dev/null; do sleep 1; done' && systemctl restart '$V5_UNIT'"
}

activate_tuple() {
  local image_id bundle_val restart_cmd smoke_cmd
  log "── 激活 runtime tuple saga ──"
  image_id="$RUNTIME_IMAGE_ID"
  bundle_val="$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV"
  restart_cmd="$(egress_then_master_restart_cmd)"
  smoke_cmd="$(hotcfg_smoke_cmd)"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] oc_hotcfg_activate_saga env=$V5_ENV image=$RUNTIME_IMAGE release=$BUILT_RUNTIME_RELEASE bundle=$bundle_val restart='$restart_cmd'"
    return 0
  fi
  mkdir -p "$(dirname "$OC_HOTCFG_HISTORY")"
  oc_hotcfg_activate_saga \
    "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$BUILT_BUNDLE_REV" "$OC_HOTCFG_HISTORY" \
    "$RUNTIME_IMAGE" "$image_id" "$BUILT_RUNTIME_RELEASE" "$bundle_val" \
    "$restart_cmd" "$smoke_cmd" \
    "" "" "$REPO_ROOT" "$REPO_ROOT" \
    "" "" "" "tuple-only" \
    || die "激活 saga 失败(已按 lib 回滚 env/current)。补救: 看 FATAL[hotcfg] 与 journalctl -u $V5_UNIT。"
  log "  ✓ tuple 已原子写入 $V5_ENV"
}

enable_now_services() {
  log "── enable --now egress + master(egress 先就绪,理由见 egress_then_master_restart_cmd)──"
  run "systemctl enable '$V5_EGRESS_UNIT' '$V5_UNIT'"
  run "systemctl start '$V5_EGRESS_UNIT'"
  run "timeout 90 bash -c 'until (exec 3<>/dev/tcp/$V5_EGRESS_BIND/$V5_EGRESS_PORT) 2>/dev/null; do sleep 1; done'"
  run "systemctl start '$V5_UNIT'"
}

# ── smoke / status ───────────────────────────────────────────────────────

assert_ssh_rule_before_drop() {
  local listing ssh_line drop_line
  listing="$(iptables -L V5_EGRESS_IN -n --line-numbers 2>/dev/null || true)"
  [[ -n "$listing" ]] || die "iptables 链 V5_EGRESS_IN 不存在。补救: 重跑 bootstrap 的 setup-host-net,或确认未用 SETUP_NET_ONLY=1。"
  ssh_line="$(awk '/dpt:22/ && /RETURN/ {print $1; exit}' <<<"$listing")"
  drop_line="$(awk '/DROP/ {print $1; exit}' <<<"$listing")"
  [[ -n "$ssh_line" ]] || die "V5_EGRESS_IN 没有宿主 22 RETURN 规则。补救: systemctl restart $V5_SSHGATE_UNIT(必须在 setup-host-net 之后)。"
  [[ -n "$drop_line" ]] || die "V5_EGRESS_IN 没有 DROP 规则,链形态异常。"
  [[ "$ssh_line" -lt "$drop_line" ]] || die "SSH RETURN 规则(行 $ssh_line)不在 DROP(行 $drop_line)之前。补救: 规则必须 -I V5_EGRESS_IN 1;restart $V5_SSHGATE_UNIT。"
  log "  ✓ V5_EGRESS_IN SSH RETURN 在 DROP 之前 (ssh=$ssh_line drop=$drop_line)"
}

cmd_smoke() {
  local hz i ok=0 code
  log "══ selfhost smoke ══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] curl healthz + leadership=leader + GET / oc-build + SSH 规则 + 个人版 18789"
    return 0
  fi
  for i in $(seq 1 30); do
    hz="$(curl -fsS --max-time 5 "http://127.0.0.1:${V5_PORT}/healthz" 2>/dev/null || true)"
    if echo "$hz" | jq -e '.ok==true and .runtime.controlPlaneEnabled==true and .runtime.leadership.state=="leader"' >/dev/null 2>&1; then
      ok=1
      break
    fi
    log "  /healthz 未收敛 leadership=leader,重试 $i/30…"
    sleep 2
  done
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${V5_PORT}/healthz" || true)"
  [[ "$code" == 200 ]] || die "selfhost /healthz HTTP $code(期望 200)。补救: journalctl -u $V5_UNIT -n 80。"
  [[ "$ok" == 1 ]] || die "healthz HTTP 200 但未收敛: ok=true 且 runtime.controlPlaneEnabled=true 且 runtime.leadership.state=leader。
  最近响应: ${hz:-<empty>}
  说明: V5 channel 走 leader lease(不是只看 OC_CONTROL_PLANE_LEADER);0135 seed desired_leader_slot=A,本实例 OC_SLOT 默认 A。补救: 查 journalctl 是否拒启,以及 deploy_state / leader_lease 行。"
  log "  ✓ /healthz 200 + controlPlaneEnabled + leadership.state=leader"
  [[ -f "$REPO_ROOT/packages/web-react/dist/index.html" ]] \
    || die "缺 packages/web-react/dist/index.html。master 从此路径 serve SPA。补救: 重跑 --deploy 以构建前端。"
  local html spa_ok=0
  for i in $(seq 1 15); do
    html="$(curl -fsS --max-time 5 "http://127.0.0.1:${V5_PORT}/" 2>/dev/null || true)"
    if echo "$html" | grep -q 'name="oc-build"'; then
      spa_ok=1
      break
    fi
    log "  GET / 尚未 serve SPA,重试 $i/15…"
    sleep 2
  done
  [[ "$spa_ok" == 1 ]] \
    || die "GET / 不是 SPA index.html(缺 oc-build meta)。补救: 确认 OC_RUNTIME_CHANNEL=v5 且 dist 已构建后 restart master。"
  log "  ✓ GET / 返回 SPA index.html(含 oc-build)"
  assert_ssh_rule_before_drop
  assert_personal_alive
  log "  ✓ 个人版 $PERSONAL_UNIT 仍 active 且 :$PERSONAL_PORT 仍 200"
  log "✓ smoke 通过"
}

cmd_status() {
  log "══ selfhost status ══"
  log "  worktree: $REPO_ROOT"
  log "  HEAD: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  log "  env: $V5_ENV $([ -f "$V5_ENV" ] && echo present || echo MISSING) mode=$(stat -c %a "$V5_ENV" 2>/dev/null || echo -)"
  if [[ -f "$V5_ENV" ]]; then
    log "  OC_RUNTIME_IMAGE=$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_IMAGE)"
    log "  OC_RUNTIME_IMAGE_ID=$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_IMAGE_ID)"
    log "  OC_RUNTIME_RELEASE=$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_RELEASE)"
    log "  OC_PLATFORM_BUNDLE=$(oc_hotcfg_env_get "$V5_ENV" OC_PLATFORM_BUNDLE)"
    log "  OC_CONTROL_PLANE_LEADER=$(oc_hotcfg_env_get "$V5_ENV" OC_CONTROL_PLANE_LEADER)"
  fi
  log "  unit master:  $(systemctl is-active "$V5_UNIT" 2>/dev/null || echo n/a)"
  log "  unit egress:  $(systemctl is-active "$V5_EGRESS_UNIT" 2>/dev/null || echo n/a)"
  log "  unit hostnet: $(systemctl is-active "$V5_HOSTNET_UNIT" 2>/dev/null || echo n/a)"
  log "  unit sshgate: $(systemctl is-active "$V5_SSHGATE_UNIT" 2>/dev/null || echo n/a)"
  # tunnel 是公网入口,不随部署自动 enable —— 由人显式决定是否对外暴露。
  log "  unit tunnel:  $(systemctl is-active "$V5_TUNNEL_UNIT" 2>/dev/null || echo inactive) (enable 后跑 scripts/selfhost-sync-tunnel-url.sh --apply)"
  if [[ -f "$REPO_ROOT/packages/web-react/dist/index.html" ]]; then
    log "  spa dist:    present"
  else
    log "  spa dist:    MISSING"
  fi
  if [[ -f "$REPO_ROOT/.complete" ]]; then
    log "  .complete:   present $(jq -er '.sourceCommit' "$REPO_ROOT/.complete" 2>/dev/null || echo '?')"
  else
    log "  .complete:   MISSING"
  fi
  if [[ -f "$V5_ENV" ]]; then
    log "  OC_SESSIONS_STORE=$(oc_hotcfg_env_get "$V5_ENV" OC_SESSIONS_STORE)"
  fi
  log "  personal:     $(systemctl is-active "$PERSONAL_UNIT" 2>/dev/null || echo n/a)"
  if docker network inspect openclaude-v5-net >/dev/null 2>&1; then
    log "  net: openclaude-v5-net 存在"
  else
    log "  net: openclaude-v5-net 不存在"
  fi
  if sudo -u postgres psql -X -tAc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" >/dev/null 2>&1; then
    if pg_db_exists; then
      log "  pg: $PG_DB 存在"
    else
      log "  pg: $PG_DB 不存在"
    fi
  else
    log "  pg: 无法查询(postgres 不可达)"
  fi
  local p
  for p in "$V5_PORT" "$V5_EGRESS_PORT" "$PERSONAL_PORT"; do
    if port_in_use "$p"; then log "  port $p: listen"; else log "  port $p: idle"; fi
  done
}

# ── bootstrap / deploy ───────────────────────────────────────────────────

cmd_bootstrap() {
  local pass url
  log "══ v5 selfhost bootstrap ══"
  preflight_common
  if own_instance_present; then
    log "  ⚠ 检测到本实例 env/unit 已存在 → 视为重跑,跳过「残留必须为空 / 端口必须空闲」硬门(那些是防外来残留,不是防自己)。"
  else
    preflight_residue
    preflight_ports_idle
  fi

  pass="$(openssl rand -hex 16)"
  if [[ -f "$V5_ENV" && "$FORCE_ENV" != 1 ]]; then
    url="$(read_env_db_url)"
    [[ -n "$url" ]] || die "已有 env 但缺 DATABASE_URL"
    log "  使用已有 env 的 DATABASE_URL(密码不打印)"
  else
    ensure_pg "$pass"
    url="postgres://${PG_ROLE}:${pass}@127.0.0.1:5432/${PG_DB}"
  fi

  ensure_node_modules
  build_frontend
  run_migrations "$url"
  enable_registration "$url"
  write_env_file "$pass"
  ensure_selfhost_env_keys
  ensure_model_authority
  ensure_home_config
  ensure_worktree_complete
  cutover_sessions_to_pg "$url"
  run "mkdir -p '$OC_HOTCFG_RELEASES_ROOT' '$OC_HOTCFG_PLATFORM_ROOT/bundles'"
  setup_v5_net
  install_units
  restart_sshgate

  local sha
  sha="$(source_commit)"
  build_runtime_release "$sha"
  build_platform_bundle "$sha"
  run "systemctl enable '$V5_EGRESS_UNIT' '$V5_UNIT'"
  activate_tuple
  enable_now_services
  cmd_smoke
  log "✓ bootstrap 完成"
}

cmd_deploy() {
  log "══ v5 selfhost deploy ══"
  preflight_common
  # 脏工作区门(2026-08-16):master 直接跑本 worktree 源码(unit WorkingDirectory 即
  # REPO_ROOT),deploy 打包的是「工作区现状」而非某个 commit —— 多会话并行开发时,
  # 任何一次 deploy/restart 都会把树上未提交的半成品一起带上线(实例:liveTurnFrames.ts
  # 带类型错误被别的会话差点部署)。门:git status --porcelain 必须为空;确认要带脏
  # 部署(明白会把未提交改动一并上线)显式加 --allow-dirty。
  if [[ "$ALLOW_DIRTY" != 1 ]]; then
    local dirty
    dirty="$(git -C "$REPO_ROOT" status --porcelain)"
    if [[ -n "$dirty" ]]; then
      die "工作区不干净(存在未提交改动),deploy 会把这些半成品一起带上线:
$dirty
补救: 提交或 stash 后再 deploy;确要带脏部署(明白风险)加 --allow-dirty。"
    fi
  fi
  [[ -f "$V5_ENV" ]] || die "缺 $V5_ENV,这不是更新路径。补救: 先 --bootstrap。"
  docker network inspect openclaude-v5-net >/dev/null 2>&1 \
    || die "openclaude-v5-net 不存在。补救: 先 --bootstrap(不要在 deploy 里建网,以免误伤残留策略)。"
  ensure_node_modules
  build_frontend
  ensure_worktree_complete
  install_units
  # env 固定 COMMERCIAL_AUTO_MIGRATE=0,新代码要的表/列没人建。runner 靠
  # schema_migrations 记账幂等,所以每次 deploy 都跑,且必须赶在切 tuple 重启之前。
  run_migrations "$(read_env_db_url)"
  # 老实例升级路径:bootstrap 时还没有这段的实例,在这里补齐 flag 与 catalog admin 角色。
  ensure_model_authority
  local sha
  sha="$(source_commit)"
  build_runtime_release "$sha"
  build_platform_bundle "$sha"
  activate_tuple
  cmd_smoke
  log "✓ deploy 完成"
}

case "$MODE" in
  preflight) cmd_preflight ;;
  bootstrap) cmd_bootstrap ;;
  deploy) cmd_deploy ;;
  build-master-only) cmd_build_master_only ;;
  smoke) cmd_smoke ;;
  status) cmd_status ;;
  *) die "内部错误:未知 MODE=$MODE" ;;
esac
