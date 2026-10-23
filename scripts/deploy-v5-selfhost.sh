#!/usr/bin/env bash
# deploy-v5-selfhost.sh — 把 V5 商业版独立部署到本机自用。
#
# 本机即目标机(不走 SSH),与 kl-mirror 生产实例零耦合:
#   - 源码树   /opt/openclaude/openclaude-v5-selfhost (本 worktree,就地使用)
#   - HOME     /root/.openclaude-v5-selfhost
#   - env      /etc/openclaude/commercial-v5-selfhost.env
#   - 端口     master 127.0.0.1:18790 / egress 172.31.0.1:18892
#   - systemd  openclaude-v5-selfhost.service + -egress + -hostnet + -ccb-proxy + -sshgate
#   - PG       openclaude_v5_selfhost / role oc_v5_selfhost
#   - Redis    redis://127.0.0.1:6379/3
#
# 红线:绝不 touch 个人版 openclaude.service / 18789 / openclaude_personal_sessions /
#       Redis db0,也不写生产 commercial-v5.env 或 /opt/openclaude/openclaude-v5。
#
# 用法:
#   scripts/deploy-v5-selfhost.sh --preflight
#   scripts/deploy-v5-selfhost.sh --bootstrap [--force-env]   # 仅首次安装;已有 live 请用 --deploy
#   scripts/deploy-v5-selfhost.sh --deploy
#   scripts/deploy-v5-selfhost.sh --deploy --allow-dirty --platform-from-head
#   scripts/deploy-v5-selfhost.sh --build-master-only [--force-npm-ci]
#   scripts/deploy-v5-selfhost.sh --cutover [--release=/abs/rel-*] [--dry-run]
#   scripts/deploy-v5-selfhost.sh --smoke
#   scripts/deploy-v5-selfhost.sh --status
#   scripts/deploy-v5-selfhost.sh --bootstrap --dry-run
#
# --deploy = 构建不可变 master release + 容器制品,再走与 --cutover 同一套
# 翻转状态机(统一补偿 / 两级回滚 / phase-aware survivor / 候选内 snapshot unit)。
# 不要另写一套并行翻转逻辑。--cutover 仍是「已有 rel-*、只翻转」的手动逃生入口。
#
# 脏工作树三面语义(2026-08-18 根治后):
#   master live     : 永远 git archive HEAD,脏文件不会进线上进程
#   runtime-release : 永远 git archive HEAD,给 agent 容器 bind
#   platform bundle : 默认拷工作树(可能带脏);--platform-from-head 则 archive
# 默认仍拒脏,避免 platform 半成品进全员容器。别人的未提交文件挡路时:
#   --allow-dirty --platform-from-head  (master/runtime/platform 三面都干净)
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
# shellcheck source=scripts/lib/assert-flavor.sh
source "$SCRIPT_DIR/lib/assert-flavor.sh"
if [[ "${1:-}" == "--mint-flavor-manifest" ]]; then
  dest="${2:?usage: --mint-flavor-manifest DIR [flavor] [commit]}"
  flavor="${3:-selfhost}"
  commit="${4:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
  write_flavor_manifest "$dest" "$flavor" "$commit"
  exit $?
fi

INSTANCE_ID="v5-selfhost-sg"
V5_HOME="/root/.openclaude-v5-selfhost"
V5_ENV="/etc/openclaude/commercial-v5-selfhost.env"
V5_UNIT="openclaude-v5-selfhost.service"
V5_EGRESS_UNIT="openclaude-v5-selfhost-egress.service"
# 蓝绿双槽 egress(2026-09-05):模板 unit + 每槽私有健康口。legacy 单 unit 仅作
# break-glass / 旧 release 回滚目标保留。
V5_EGRESS_SLOT_SOCKET_TPL="openclaude-v5-selfhost-egress@.socket"
V5_EGRESS_SLOT_SERVICE_TPL="openclaude-v5-selfhost-egress@.service"
V5_EGRESS_SYSCTL_FILE="99-openclaude-v5-selfhost-egress.sysctl.conf"
V5_EGRESS_SLOT_A_PORT="18898"
V5_EGRESS_SLOT_B_PORT="18899"
V5_HOSTNET_UNIT="openclaude-v5-selfhost-hostnet.service"
V5_CCB_PROXY_UNIT="openclaude-v5-selfhost-ccb-proxy.service"
V5_CURSOR_PROXY_UNIT="openclaude-v5-selfhost-cursor-proxy.service"
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
# model-authority cutover evidence is deliberately written under a distinct
# NOLOGIN deploy role. The catalog admin role is read-only on deploy_state.
MODEL_AUTHORITY_DEPLOY_ROLE="${PG_ROLE}_model_deploy"
REDIS_URL="redis://127.0.0.1:6379/3"
# Runtime image pin. Rebuild with:
#   OC_FLAVOR=selfhost OC_RUNTIME_SOURCE_COMMIT=$(git rev-parse HEAD) \
#     packages/commercial/agent-sandbox/build-image.sh v5-cli-cc2302-codex01630-grok1062-zcode3153-agy140-slim
# which sources deploy/v5-selfhost/runtime-build.env (OC_INCLUDE_ZCODE=1, OC_INCLUDE_ANTIGRAVITY=1).
# cc2280 = official Claude Code 2.1.280 (recognizes claude-opus-5-5). The
# previous tag stays on the 2.1.278 image so a tuple flip can roll back.
# agy134 (OCV5-415) = patch of the v5-cli-cc2280-codex01592-grok1013-zcode381-slim image that adds the official
# Antigravity CLI 1.3.4 (same RUN block as Dockerfile.openclaude-runtime, sha512-pinned);
# the previous tag stays for rollback.
# cc2302/codex01630/grok1062/zcode3153/agy140 (OCV5-470) = Claude Code 2.1.302, Codex 0.163.0,
# Grok 1.0.62, ZCode 3.15.3 (CLI 0.16.9), Antigravity 1.4.0 and Cursor Agent 2026.10.16-e3cb207; the agy134 tag stays for rollback.
RUNTIME_IMAGE="openclaude/openclaude-runtime:v5-cli-cc2302-codex01630-grok1062-zcode3153-agy140-slim"
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
# Explicit per-train policy; legacy invocations keep the original default.
source "$SCRIPT_DIR/lib/v5-selfhost-release-policy.sh"
MASTER_RELEASE_LIB="$SCRIPT_DIR/v5-selfhost-master-release-lib.sh"

DRY=0
FORCE_ENV=0
ALLOW_DIRTY=0; ALLOW_INFLIGHT=0
PLATFORM_FROM_HEAD=0
FORCE_NPM_CI=0
MODE=""
CUTOVER_RELEASE=""
DEPLOY_BUILT_RELEASE=""
# Internal invocation provenance; never inherit an expected source from the environment.
DEPLOY_BUILT_SOURCE_COMMIT=""
CUTOVER_JOINT=0
CUTOVER_TUPLE_BUNDLE=""
# OCV5-534 --rollback 的已验证身份只由 cmd_rollback 设置;绝不从环境继承(否则 --cutover 可伪造回退身份绕过 HEAD 校验与迁移门)。
CUTOVER_ROLLBACK=0
ROLLBACK_SHA=""
ROLLBACK_FROM=""
ROLLBACK_ORIG_PREV=""
# Lease Center(OCV5-131):worker 发车时传 --lease-train=<tr-*> --target-sha=<sha>;
# 人工直跑 --deploy 时脚本自己登记一条 manual train,让 worker 能对账、不会在同一窗口再发一班。
LEASE_TRAIN_ID=""
LEASE_TARGET_SHA=""
RELEASE_POLICY_RESUME=0
LEASE_LIB="$SCRIPT_DIR/v5-lease-lib.sh"
# Incident trailer 发布前快检(2026-09-09):selfhost 此前从不跑 trailer 门,坏 trailer 一律
# 上线后才被 CI 发现,已上线源提交不可 amend,只能一次次冻结 tip(已冻 18 条)。这里在构建
# 三面制品之前 fail-closed;规则与 check-v5-incident-regressions.ts 逐条对齐(有单测交叉对拍)。
# 豁免只给真·止血:OC_V5_SKIP_TRAILER_GATE=1(会打 ⚠ 并写进 deploy 日志,不静默)。
FIX_TRAILER_GATE="$SCRIPT_DIR/check-v5-fix-trailers.sh"
# OCV5-418 门禁失败策略(只个人版):rollback(默认)= 现有补偿;stay = 新版已切换且在跑时
# 门禁/冒烟失败不回滚,留在新版排查(用户 2026-10-14 02:54:个人版只有本人在用)。
# 取值顺序:环境变量 > 策略文件(KEY=VALUE 解析,不 source;须本用户所有、组/他人不可写)。
SELFHOST_POLICY_FILE="${OC_V5_SELFHOST_POLICY_FILE:-/etc/openclaude/selfhost-deploy-policy.env}"
V5_WATCH_MAINT="${V5_WATCH_MAINT:-/run/openclaude-v5-selfhost/planned-maintenance}"
CUTOVER_GATE_FAILED=""
CUTOVER_LAST_FAIL=""
CUTOVER_KEPT_FAILED_REL=""
CUTOVER_RECOVERY_REQUIRED=0

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
# 个人版 PG 备份(scripts/v5-selfhost-pg-backup.sh)整次运行共享持锁(OCV5-600),每周全量可超过
# 一小时。持锁者是活着的备份时,等待不计入上面的超时,改按这个上限排队。
SELFHOST_DEPLOY_LOCK_BACKUP_WAIT="${OC_V5_SELFHOST_DEPLOY_LOCK_BACKUP_WAIT:-14400}"
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
# shellcheck source=lib/v5-selfhost-env.sh
source "$SCRIPT_DIR/lib/v5-selfhost-env.sh"
# shellcheck source=lib/v5-selfhost-rollback.sh
source "$SCRIPT_DIR/lib/v5-selfhost-rollback.sh"
# shellcheck source=lib/v5-selfhost-train-summary.sh
source "$SCRIPT_DIR/lib/v5-selfhost-train-summary.sh"   # OCV5-539: <trainId>.summary.json, record only
source "$SCRIPT_DIR/lib/v5-selfhost-workspace-links.sh"  # OCV5-549: ws_links_ensure
# P0-Web 前端热切换(OCV5-489):overlay 指针根 + 纯函数库 + --p0-web* 编排。
WEB_OVERLAY_ROOT="${OC_V5_WEB_OVERLAY_ROOT:-/var/lib/openclaude-v5-selfhost/web-overlay}"
# shellcheck source=scripts/v5-web-overlay-lib.sh
source "$SCRIPT_DIR/v5-web-overlay-lib.sh"
# shellcheck source=scripts/v5-selfhost-p0-web-lib.sh
source "$SCRIPT_DIR/v5-selfhost-p0-web-lib.sh"
BOOT_SCRIPT_DIR="${BOOT_SCRIPT_DIR:-${BREAKGLASS_ROOT}/boot}"
# 看护 timer 执行的是这个安装目录里的 watch.sh,不是 release(OCV5-404)。
V5_WATCH_DIR="${V5_WATCH_DIR:-/opt/openclaude/v5-selfhost-watch}"
V5_WATCH_RUN_STATUS="${V5_WATCH_RUN_STATUS:-/run/openclaude-v5-selfhost/watch-status}"

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
  local exit_rc=$?
  tsum_finish "$exit_rc" 2>/dev/null || :
  # Owner loss forbids successor state/holder writes from this invocation.
  [[ "$exit_rc" == 86 ]] && return 86
  if release_policy_enabled && ! release_policy_require_owner; then
    trap - EXIT
    exit 86
  fi
  if [[ "$exit_rc" != 0 ]]; then release_policy_abort_unexposed || true; fi
  if [[ "$exit_rc" != 0 ]] && declare -F rollback_restore_prev_if_unchanged >/dev/null 2>&1; then
    rollback_restore_prev_if_unchanged || true
  fi
  # 后台 runtime release 段必须先收尾,再释放锁/train(否则下一次 deploy 可能与它并发写 runtime-releases)。
  if declare -F reap_runtime_release_bg >/dev/null 2>&1; then reap_runtime_release_bg || true; fi
  # 函数定义在后面;参数校验阶段的 die 也会进这里,此时函数尚不存在。
  if declare -F lease_train_on_exit >/dev/null 2>&1; then lease_train_on_exit "$exit_rc" || true; fi
  if [[ -n "${PLATFORM_ARCHIVE_TMP:-}" && -d "$PLATFORM_ARCHIVE_TMP" ]]; then
    rm -rf "$PLATFORM_ARCHIVE_TMP"
    PLATFORM_ARCHIVE_TMP=""
  fi
  cleanup_master_staging
  cleanup_cutover_unit_snap
  p0web_cleanup_build || true
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

# /proc/<pid>/stat 第 22 字段(starttime)。必须读持锁的 deploy 进程本身($$):
# 以前在 python3 -c 里读 os.getpid(),拿到的是 python 子进程,看护比对永远不匹配,
# 发布锁豁免从未生效(OCV5-418)。comm 可含空格/括号,从最后一个 ) 往后数。
proc_starttime_of() { # <pid>
  python3 -c 'import sys
t=open("/proc/%d/stat"%int(sys.argv[1])).read(); print(t[t.rfind(")")+2:].split()[19])' "$1"
}

# 备份持锁时写 <lock>.backup(pid/starttime/tier/started)。pid 活着、/proc starttime 一致、
# cmdline 是备份脚本才算数(防 PID 复用和残留文件);是则打印该行并返回 0。
selfhost_backup_lock_holder() {
  local marker="${1}.backup" line pid st cur
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  line="$(head -n1 -- "$marker" 2>/dev/null)" || return 1
  [[ "$line" =~ ^pid=([0-9]+)\ starttime=([0-9]+)\  ]] || return 1
  pid="${BASH_REMATCH[1]}"; st="${BASH_REMATCH[2]}"
  cur="$(proc_starttime_of "$pid" 2>/dev/null)" || return 1
  [[ "$cur" == "$st" ]] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'v5-selfhost-pg-backup\.sh' || return 1
  printf '%s' "$line"
}

# fd 8 排他 flock:进程退出/被杀时内核释放,不手删锁文件。
# OC_V5_SELFHOST_DEPLOY_LOCK_HELD=1 表示本进程链已持锁(内层跳过,防将来 $0 自调用把自己锁死)。
acquire_selfhost_deploy_lock() {
  local lock wait_s interval waited info holder_line starttime backup_waited backup_info backup_wait
  if [[ "${OC_V5_SELFHOST_DEPLOY_LOCK_HELD:-}" == 1 ]]; then
    release_policy_mutation_barrier || exit "$?"
    log "  ↻ 本进程链已持 selfhost 发布锁,跳过加锁(可重入)"
    return 0
  fi
  command -v flock >/dev/null 2>&1 || die "缺少 flock。补救: 安装 util-linux。"
  lock="$SELFHOST_DEPLOY_LOCK"
  wait_s="$SELFHOST_DEPLOY_LOCK_WAIT"
  interval="$SELFHOST_DEPLOY_LOCK_POLL"
  # 十进制、无前导零:bash 算术把 08 当八进制并报错,比较恒假就会永远等(Codex r2)。
  [[ "$wait_s" =~ ^(0|[1-9][0-9]*)$ ]] || die "OC_V5_SELFHOST_DEPLOY_LOCK_WAIT 必须是非负整数秒(当前=$wait_s)"
  [[ "$interval" =~ ^[1-9][0-9]*$ ]] || die "OC_V5_SELFHOST_DEPLOY_LOCK_POLL 必须是正整数秒(当前=$interval)"
  # 非法值会让下面的算术比较恒假,备份持锁时就永远等下去(Codex r1)。
  backup_wait="${SELFHOST_DEPLOY_LOCK_BACKUP_WAIT:-14400}"
  [[ "$backup_wait" =~ ^(0|[1-9][0-9]*)$ ]] \
    || die "OC_V5_SELFHOST_DEPLOY_LOCK_BACKUP_WAIT 必须是非负整数秒(当前=$backup_wait)"
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
    backup_waited=0
    while ! flock -n 8; do
      # 备份占锁:排队等它结束,不计入 wait_s,也不当成超时失败(OCV5-600)。
      if backup_info="$(selfhost_backup_lock_holder "$lock")"; then
        if (( backup_waited >= backup_wait )); then
          echo "✗ 个人版 PG 备份占锁中,已排队 ${backup_waited}s 仍未结束(上限 ${backup_wait}s)。锁=$lock 备份=$backup_info
补救: systemctl status openclaude-v5-selfhost-pg-backup-full.service / openclaude-v5-selfhost-pg-backup.service;备份结束后重发。" >&2
          exit 1
        fi
        if (( backup_waited % 300 == 0 )); then
          log "⏳ 个人版 PG 备份占锁中($backup_info),列车排队等它结束: 已等 ${backup_waited}s / ${backup_wait}s(不计入 ${wait_s}s 超时)"
        fi
        sleep "$interval"
        backup_waited=$((backup_waited + interval))
        continue
      fi
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
  release_policy_mutation_barrier || exit "$?"
  SELFHOST_DEPLOY_LOCK_HOLDER="${lock}.holder"
  starttime="$(proc_starttime_of "$$")" \
    || die "无法读取 /proc/$$/stat starttime(看护靠它防 PID reuse)"
  [[ "$starttime" =~ ^[0-9]+$ ]] || die "starttime 非法: $starttime"
  holder_line="$(printf 'pid=%s user=%s tree=%s started=%s starttime=%s\n' \
    "$$" "$(id -un 2>/dev/null || echo ?)" "${REPO_ROOT:-?}" "$(date -Is)" "$starttime")"
  selfhost_lock_py write-holder "$SELFHOST_DEPLOY_LOCK_HOLDER" "$holder_line"
  SELFHOST_DEPLOY_LOCK_HOLDER_OWNED=1
  export OC_V5_SELFHOST_DEPLOY_LOCK_HELD=1
  log "  ✓ 已取得 selfhost 发布锁 $lock pid=$$"
}

# --status/--smoke/--preflight 与 --dry-run 只读/轻量,不加锁,避免被发布堵住。
# --build-master-only / --cutover 持锁,避免与别人的 --deploy 撞车。
maybe_acquire_selfhost_deploy_lock() {
  case "$MODE" in
    deploy|bootstrap|build-master-only|cutover|rollback)
      [[ "$DRY" == 1 ]] && return 0
      acquire_selfhost_deploy_lock
      ;;
  esac
}
usage() {
  cat <<'EOF'
用法: scripts/deploy-v5-selfhost.sh --preflight|--bootstrap|--deploy|--build-master-only|--cutover|--rollback|--smoke|--status [--dry-run] [--force-env] [--allow-dirty] [--platform-from-head] [--force-npm-ci] [--release=PATH]

日常发布(另一位 agent 请看这里):
  scripts/deploy-v5-selfhost.sh --deploy
  scripts/deploy-v5-selfhost.sh --deploy --allow-dirty --platform-from-head

  --preflight           只读硬门(残留/端口/密钥/个人版)。任何一条不满足即非 0 退出
  --bootstrap           仅首次安装。本机已有 live symlink / env 时请改用 --deploy
  --deploy              常规发布:构建不可变 master release(staging 内 vite)+容器制品,再走 --cutover 同一套翻转状态机
  --build-master-only   只建一份不可变 master rel-*(不迁库/不装 unit/不切 symlink/不重启)
  --cutover             手动逃生:已有 rel-* 时只做翻转(静态门+迁移门+备份+survivor+装 unit+symlink+重启+smoke)
  --rollback            退回 .prev-release 及它当时的运行四元组(一次一步;不跑迁移、不回滚 schema;
                        上一版之后有破坏性迁移、history 血缘断开、制品已回收时拒绝)。走同一套 joint
                        状态机与门禁,登记 manual train;先 --rollback --dry-run 看计划
  --smoke               只读健康检查(含个人版回归;live 存在时比对 release dist oc-build)
  --status              打印当前状态(含 live / .prev-release / 四元组)
  --dry-run             与上述组合:打印将执行的命令,不改任何东西
  --release=PATH        仅配合 --cutover:指定候选 rel-* 绝对路径(默认=sourceCommit 等于 HEAD 的最新完整 release)
  --allow-inflight      仅selfhost正式列车的精确源授权:跳过600s空闲检查,接受在途回合中断;其余门不变
  --allow-dirty         仅配合 --deploy:工作区有未提交改动时仍部署(默认拒绝,防脏 platform 进全员容器)
  --platform-from-head  仅配合 --deploy/--bootstrap:平台 bundle 从 git archive 取已提交的 platform-runtime(默认仍拷工作树)
  --resume-release-policy --lease-train=ID --target-sha=SHA
                        仅核对/补齐同 operation 历史与验收;不切流、不重启,未知现场保持阻塞
  --lease-train=ID --target-sha=SHA
                        仅配合 --deploy:由 v5-lease-worker 发车时传入;HEAD 必须精确等于 SHA,否则拒绝。
                        人工直跑 --deploy 会自动登记 manual train(有 open train 时拒绝并行发布)。见 scripts/oc-lease.sh
  env OC_V5_SKIP_TRAILER_GATE=1
                        仅配合 --deploy:跳过构建前的 Incident trailer 门(scripts/check-v5-fix-trailers.sh)。
                        仅限止血;会打 ⚠ 留痕,CI check:v5:incidents 仍会红,事后必须补 waiver / 冻结 tip。
  --force-env           仅配合 --bootstrap:覆盖已存在的 env 文件
  --force-npm-ci        配合 --build-master-only 或 --deploy:跳过硬链,在 staging 内冷装
  --p0-web --target-sha=SHA
                        P0 纯前端热修(OCV5-489):只换前端构建目录,不重启 master/不动 runtime。相对 live
                        只改前端静态面才放行;切换后握手+UI 门 C1+C2,失败自动切回。构建在锁外,切换持锁
  --p0-web-revert       切回上一份前端构建目录(秒级,不重启)
  --p0-web-status       打印 overlay 指针、生效的 P0-Web sourceCommit 与最近 history

脏工作树三面:
  master live     = git archive HEAD → 脏文件不会上线
  runtime-release = git archive HEAD → 脏文件不会进容器 bind
  platform bundle = 默认拷工作树(可能带脏);加 --platform-from-head 则干净
  别人在树上改文件时推荐: --deploy --allow-dirty --platform-from-head

  写路径(--deploy/--bootstrap/--build-master-only/--cutover,非 dry-run)会在 /run/openclaude-v5-selfhost/deploy.lock 上排队等锁,默认 2400s。
  覆盖: OC_V5_SELFHOST_DEPLOY_LOCK / OC_V5_SELFHOST_DEPLOY_LOCK_WAIT / OC_V5_SELFHOST_DEPLOY_LOCK_POLL
  覆盖路径同样校验(普通文件、root 所有、目录非世界可写、拒绝跟随符号链接)。

示例:
  scripts/deploy-v5-selfhost.sh --deploy
  scripts/deploy-v5-selfhost.sh --deploy --allow-dirty --platform-from-head
  scripts/deploy-v5-selfhost.sh --build-master-only
  scripts/deploy-v5-selfhost.sh --cutover --dry-run
  scripts/deploy-v5-selfhost.sh --rollback --dry-run
  scripts/deploy-v5-selfhost.sh --cutover --release=/opt/openclaude/openclaude-v5-selfhost-releases/rel-...
  scripts/deploy-v5-selfhost.sh --smoke
EOF
}
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --force-env) FORCE_ENV=1 ;;
    --allow-inflight) ALLOW_INFLIGHT=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --platform-from-head) PLATFORM_FROM_HEAD=1 ;;
    --force-npm-ci) FORCE_NPM_CI=1 ;;
    --release=*) CUTOVER_RELEASE="${arg#--release=}" ;;
    --resume-release-policy) RELEASE_POLICY_RESUME=1 ;;
    --lease-train=*) LEASE_TRAIN_ID="${arg#--lease-train=}" ;;
    --target-sha=*) LEASE_TARGET_SHA="${arg#--target-sha=}" ;;
    --preflight|--bootstrap|--deploy|--smoke|--status|--build-master-only|--cutover|--rollback|--p0-web|--p0-web-revert|--p0-web-status)
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
if [[ "$RELEASE_POLICY_RESUME" == 1 ]]; then
  [[ "$MODE" == deploy && -n "$LEASE_TRAIN_ID" && -n "$LEASE_TARGET_SHA" && "$DRY" != 1 ]] \
    || die "--resume-release-policy requires --deploy --lease-train=<original> --target-sha=<original>; no dry-run"
fi
[[ "$FORCE_ENV" == 1 && "$MODE" != "bootstrap" ]] && die "--force-env 只能与 --bootstrap 同用"
[[ "$ALLOW_DIRTY" == 1 && "$MODE" != "deploy" ]] && die "--allow-dirty 只能与 --deploy 同用"
[[ "$PLATFORM_FROM_HEAD" == 1 && "$MODE" != "deploy" && "$MODE" != "bootstrap" ]] \
  && die "--platform-from-head 只能与 --deploy 或 --bootstrap 同用"
[[ "$FORCE_NPM_CI" == 1 && "$MODE" != "build-master-only" && "$MODE" != "deploy" ]] \
  && die "--force-npm-ci 只能与 --build-master-only 或 --deploy 同用"
[[ -n "$CUTOVER_RELEASE" && "$MODE" != "cutover" ]] \
  && die "--release= 只能与 --cutover 同用"
[[ -n "$LEASE_TRAIN_ID" && "$MODE" != "deploy" ]] \
  && die "--lease-train= 只能与 --deploy 同用"
[[ -n "$LEASE_TARGET_SHA" && "$MODE" != "deploy" && "$MODE" != "p0-web" ]] \
  && die "--target-sha= 只能与 --deploy 或 --p0-web 同用"
[[ "$DRY" == 1 && "$MODE" == p0-web* ]] && die "--p0-web* 没有 dry-run(构建在锁外、切换可秒级回退)"
[[ -n "$LEASE_TRAIN_ID" && -z "$LEASE_TARGET_SHA" ]] && die "--lease-train= 必须同时给 --target-sha="
[[ -z "$LEASE_TARGET_SHA" || "$LEASE_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--target-sha= 必须是 40 位 sha"
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

if [[ "$DRY" != 1 ]]; then
  case "$MODE" in
    deploy|bootstrap|build-master-only|cutover|rollback|p0-web|p0-web-revert)
      if [[ "$RELEASE_POLICY_RESUME" != 1 ]]; then
        release_policy_context_present && { log "unresolved release-policy context blocks mutation"; exit 79; }
      fi ;;
  esac
fi
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
    "claudeCodePath": "${MASTER_LIVE_LINK}/claude-code-best",
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
    # OCV5-549:之后新增的工作区包(如 @openclaude/kernel)在已有 node_modules 里没有链接
    ws_links_ensure "$REPO_ROOT" || die "worktree node_modules 缺工作区链接且无法安全补上。补救: 在 $REPO_ROOT 跑 npm ci。"
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
  install -m 0644 "$src" "/etc/systemd/system/$name" || return 1
}

# 双槽 egress 模板 unit + sysctl。<src-dir> 是候选 release 的 deploy/v5-selfhost 或其
# root-owned snapshot。旧 release(无模板)→ 跳过并返回 2,调用方按 legacy 走。
install_egress_slot_units_from() { # <src-dir>
  local dir="$1" f
  if [[ ! -f "$dir/$V5_EGRESS_SLOT_SERVICE_TPL" || ! -f "$dir/$V5_EGRESS_SLOT_SOCKET_TPL" ]]; then
    return 2
  fi
  for f in "$V5_EGRESS_SLOT_SOCKET_TPL" "$V5_EGRESS_SLOT_SERVICE_TPL"; do
    install_unit "$dir/$f" || return 1
  done
  if [[ -f "$dir/$V5_EGRESS_SYSCTL_FILE" ]]; then
    if [[ "$DRY" == 1 ]]; then
      echo "  [dry-run] install $dir/$V5_EGRESS_SYSCTL_FILE → /etc/sysctl.d/ && sysctl -w net.ipv4.tcp_migrate_req=1"
    else
      install -m 0644 "$dir/$V5_EGRESS_SYSCTL_FILE" "/etc/sysctl.d/$V5_EGRESS_SYSCTL_FILE" || return 1
      sysctl -q -w net.ipv4.tcp_migrate_req=1 || return 1
    fi
  fi
}

# 把开机 oneshot 脚本拷到固定目录。ExecStart 不跟 rel-* 变,也不钉 git 工作树。
sync_boot_scripts_from() {
  local src="$1" hostnet_src sshgate_src flavor_lib_src flavor_rules_src tmp have_flavor=0
  [[ -n "$src" && -d "$src" ]] || die "sync_boot_scripts_from: 缺源目录 $src"
  hostnet_src="$src/packages/commercial/scripts/setup-host-net.sh"
  sshgate_src="$src/deploy/v5-selfhost/sshgate-insert.sh"
  flavor_lib_src="$src/scripts/lib/assert-flavor.sh"
  flavor_rules_src="$src/scripts/lib/flavor-rules.json"
  [[ -f "$hostnet_src" && ! -L "$hostnet_src" ]] || die "缺 setup-host-net.sh: $hostnet_src"
  [[ -f "$sshgate_src" && ! -L "$sshgate_src" ]] || die "缺 sshgate-insert.sh: $sshgate_src"
  if [[ -f "$flavor_lib_src" && ! -L "$flavor_lib_src" && -f "$flavor_rules_src" && ! -L "$flavor_rules_src" ]]; then
    have_flavor=1
  fi
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] install $hostnet_src + $sshgate_src + flavor helper → $BOOT_SCRIPT_DIR"
    return 0
  fi
  mkdir -p -- "$BOOT_SCRIPT_DIR/scripts/lib" || return 1
  tmp="$(mktemp -d -- "$BOOT_SCRIPT_DIR/.staging.XXXXXX")" || return 1
  mkdir -p -- "$tmp/scripts/lib" || return 1
  install -m 0755 "$hostnet_src" "$tmp/setup-host-net.sh" || return 1
  install -m 0755 "$sshgate_src" "$tmp/sshgate-insert.sh" || return 1
  mv -f -- "$tmp/setup-host-net.sh" "$BOOT_SCRIPT_DIR/setup-host-net.sh" || return 1
  mv -f -- "$tmp/sshgate-insert.sh" "$BOOT_SCRIPT_DIR/sshgate-insert.sh" || return 1
  if [[ "$have_flavor" == 1 ]]; then
    install -m 0755 "$flavor_lib_src" "$tmp/scripts/lib/assert-flavor.sh" || return 1
    install -m 0644 "$flavor_rules_src" "$tmp/scripts/lib/flavor-rules.json" || return 1
    mv -f -- "$tmp/scripts/lib/assert-flavor.sh" "$BOOT_SCRIPT_DIR/scripts/lib/assert-flavor.sh" || return 1
    mv -f -- "$tmp/scripts/lib/flavor-rules.json" "$BOOT_SCRIPT_DIR/scripts/lib/flavor-rules.json" || return 1
    log "  ✓ 已同步开机脚本 → $BOOT_SCRIPT_DIR (from $src; flavor helper included)"
  else
    log "  ⚠ src $src 无 flavor helper, boot 仅同步 hostnet/sshgate (setup-host-net will skip flavor check)"
  fi
  rm -rf -- "$tmp" || return 1
}

# OCV5-404:08-18 装上的 watch.sh 一直没被替换,9 月的双槽改动从没到过宿主,停用后也没人发现。
# committed 之后从新 live 原子同步:同目录临时文件,内容一致且语法通过才 mv -T。
# OCV5-410 起 alert.sh 同样随 release 同步(仓库 scripts/v5-selfhost-watch-alert.sh)。
# watch.env、告警配置 /etc/openclaude/selfhost-watch-alert.env、停用标记一律不动,
# 重新武装只走人工 watch.sh --rearm。
WATCH_SYNC_FILES=("v5-selfhost-watch.sh:watch.sh" "v5-selfhost-watch-alert.sh:alert.sh")

watch_install_state() { # <release-root> → same|drift|missing-src|not-installed
  local rel="$1" pair src dst state=same
  [[ -f "$V5_WATCH_DIR/watch.sh" ]] || { echo not-installed; return 0; }
  for pair in "${WATCH_SYNC_FILES[@]}"; do
    src="$rel/scripts/${pair%%:*}"
    dst="$V5_WATCH_DIR/${pair##*:}"
    if [[ ! -f "$src" || -L "$src" ]]; then echo missing-src; return 0; fi
    if [[ ! -f "$dst" ]] || ! cmp -s -- "$src" "$dst"; then state=drift; fi
  done
  echo "$state"
}

install_watch_file() { # <src> <dst>  同目录临时文件 + cmp + bash -n + mv -T;失败不动 dst
  local src="$1" dst="$2" tmp
  if [[ -f "$dst" ]] && cmp -s -- "$src" "$dst"; then return 0; fi
  if ! bash -n -- "$src"; then
    log "  ⚠ 看护同步拒绝: $src 语法检查失败,$dst 未变"
    return 1
  fi
  tmp="$(mktemp -- "$V5_WATCH_DIR/$(basename -- "$dst").XXXXXX")" || { log "  ⚠ 看护同步失败: 无法建临时文件"; return 1; }
  if ! { cp -- "$src" "$tmp" && cmp -s -- "$src" "$tmp" && bash -n -- "$tmp" \
      && chmod 0755 -- "$tmp" && mv -T -- "$tmp" "$dst"; }; then
    rm -f -- "$tmp"
    log "  ⚠ 看护同步失败,$dst 未变"
    return 1
  fi
}

sync_watch_from() { # <release-root>  失败只 return 1,已安装副本保持原样
  local rel="$1" pair rc=0
  case "$(watch_install_state "$rel")" in
    same) log "  ✓ 看护已是本 release 版本 ($(sha256sum <"$V5_WATCH_DIR/watch.sh" | cut -c1-12))"; return 0 ;;
    not-installed) log "  ⚠ 本机未安装看护($V5_WATCH_DIR/watch.sh 不存在),不同步"; return 0 ;;
    missing-src) log "  ⚠ 看护同步跳过: release 缺看护脚本"; return 1 ;;
  esac
  if [[ "$DRY" == 1 ]]; then
    log "  [dry-run] 原子安装 watch.sh / alert.sh → $V5_WATCH_DIR(不动 watch.env / 告警配置 / 停用标记)"
    return 0
  fi
  # alert.sh 先装:新 watch.sh 依赖它的参数;反过来旧 watch.sh 不调用 alert.sh,先换无害。
  for pair in "${WATCH_SYNC_FILES[@]}"; do
    [[ "${pair##*:}" == alert.sh ]] || continue
    install_watch_file "$rel/scripts/${pair%%:*}" "$V5_WATCH_DIR/alert.sh" || rc=1
  done
  if ((rc == 0)); then
    install_watch_file "$rel/scripts/v5-selfhost-watch.sh" "$V5_WATCH_DIR/watch.sh" || rc=1
  fi
  if ((rc != 0)); then return 1; fi
  log "  ✓ 看护已同步 → $V5_WATCH_DIR watch.sh $(sha256sum <"$V5_WATCH_DIR/watch.sh" | cut -c1-12) alert.sh $(sha256sum <"$V5_WATCH_DIR/alert.sh" | cut -c1-12) (from $rel)"
}

# --status / --smoke 用:安装副本对 live、停用标记、看护最近一次状态。
watch_summary() { # <live-root-or-empty>
  local live_root="$1" state="no-live" marker="absent" st="$V5_WATCH_RUN_STATUS" armed health checked
  [[ -n "$live_root" ]] && state="$(watch_install_state "$live_root")"
  if [[ -e "$V5_WATCH_DIR/watch-disarmed" ]]; then
    marker="present($(sed -n 's/^reason=//p' "$V5_WATCH_DIR/watch-disarmed" 2>/dev/null | head -n1 | tr -cd 'A-Za-z0-9._:,+-'))"
  fi
  armed="$(sed -n 's/^recovery_armed=//p' "$st" 2>/dev/null | head -n1)"
  health="$(sed -n 's/^health=//p' "$st" 2>/dev/null | head -n1)"
  checked="$(sed -n 's/^checked_at=//p' "$st" 2>/dev/null | head -n1)"
  local alert="absent"
  # 旧 alert.sh 把任何参数当单元名写一行假告警,只对带 OCV5-410 标识的新版调 --status。
  if [[ -f "$V5_WATCH_DIR/alert.sh" ]]; then
    alert="legacy"
    if [[ -x "$V5_WATCH_DIR/alert.sh" ]] && grep -q 'OCV5-410' "$V5_WATCH_DIR/alert.sh" 2>/dev/null; then
      alert="$(timeout 10 "$V5_WATCH_DIR/alert.sh" --status 2>/dev/null | head -n1 | tr ' ' ',' || true)"
      [[ -n "$alert" ]] || alert="status-unavailable"
    fi
  fi
  echo "install=$state disarm=$marker recovery_armed=${armed:-?} health=${health:-?} checked_at=${checked:-?} alert=${alert}"
}

assert_watch_matches_live() { # <live-root>
  local live_root="$1" state
  if [[ -z "$live_root" ]]; then
    log "  ⚠ 看护比对跳过: 无 live release"
    return 0
  fi
  state="$(watch_install_state "$live_root")"
  case "$state" in
    same) log "  ✓ 看护安装副本 = live release 版本 ($(watch_summary "$live_root"))" ;;
    not-installed) log "  ⚠ 本机未安装看护($V5_WATCH_DIR/watch.sh 不存在)" ;;
    *) die "看护安装副本与 live release 不一致(state=$state)。timer 执行的是 $V5_WATCH_DIR/watch.sh,不是 release。
  补救: 按 scripts/v5-selfhost-watch-install.md 原子安装,或重跑 --deploy(committed 后会同步)。" ;;
  esac
}

# 优先当前 live;尚未翻转时用工作树(仅 bootstrap)。
sync_boot_scripts_best_effort() {
  local live_root=""
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    live_root="$(readlink -f "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  fi
  if [[ -n "$live_root" && -d "$live_root" ]]; then
    sync_boot_scripts_from "$live_root"
  else
    sync_boot_scripts_from "$REPO_ROOT"
  fi
}

assert_aux_execstart_not_worktree() {
  local u line
  [[ "$DRY" == 1 ]] && return 0
  for u in "$V5_HOSTNET_UNIT" "$V5_CCB_PROXY_UNIT" "$V5_CURSOR_PROXY_UNIT" "$V5_SSHGATE_UNIT"; do
    line="$(grep -E '^ExecStart=' "/etc/systemd/system/$u" || true)"
    [[ -n "$line" ]] || die "aux unit $u 缺 ExecStart"
    if [[ "$line" == *"/opt/openclaude/openclaude-v5-selfhost/"* && "$line" != *"-live"* ]]; then
      die "aux unit $u ExecStart 仍钉工作树: $line"
    fi
  done
}

# OCV5-306: proxy units whose unit file this deploy actually changed. Only these
# may be bounced; a running proxy carries every in-flight Box/CCB stream.
AUX_PROXY_UNITS_CHANGED=()

install_aux_units() {
  log "── 安装辅助 systemd unit(hostnet/ccb-proxy/sshgate/tunnel;master/egress 只从候选 release snapshot 装) ──"
  sync_boot_scripts_best_effort
  install_unit "$UNIT_DIR/$V5_HOSTNET_UNIT"
  local u
  for u in "$V5_CCB_PROXY_UNIT" "$V5_CURSOR_PROXY_UNIT"; do
    cmp -s -- "$UNIT_DIR/$u" "/etc/systemd/system/$u" || AUX_PROXY_UNITS_CHANGED+=("$u")
  done
  install_unit "$UNIT_DIR/$V5_CCB_PROXY_UNIT"
  install_unit "$UNIT_DIR/$V5_CURSOR_PROXY_UNIT"
  install_unit "$UNIT_DIR/$V5_SSHGATE_UNIT"
  install_unit "$UNIT_DIR/$V5_TUNNEL_UNIT"
  run "systemctl daemon-reload"
  run "systemctl enable '$V5_HOSTNET_UNIT' '$V5_CCB_PROXY_UNIT' '$V5_CURSOR_PROXY_UNIT' '$V5_SSHGATE_UNIT'"
  assert_aux_execstart_not_worktree
}

install_units() {
  log "── 安装 systemd unit ──"
  assert_unit_templates_live_wd "$UNIT_DIR"
  sync_boot_scripts_best_effort
  install_unit "$UNIT_DIR/$V5_HOSTNET_UNIT"
  install_unit "$UNIT_DIR/$V5_CCB_PROXY_UNIT"
  install_unit "$UNIT_DIR/$V5_CURSOR_PROXY_UNIT"
  install_unit "$UNIT_DIR/$V5_SSHGATE_UNIT"
  install_unit "$UNIT_DIR/$V5_EGRESS_UNIT"
  install_egress_slot_units_from "$UNIT_DIR" || [[ $? == 2 ]] || die "安装双槽 egress unit 失败"
  install_unit "$UNIT_DIR/$V5_UNIT"
  install_unit "$UNIT_DIR/$V5_TUNNEL_UNIT"
  run "systemctl daemon-reload"
  run "systemctl enable '$V5_HOSTNET_UNIT' '$V5_CCB_PROXY_UNIT' '$V5_CURSOR_PROXY_UNIT' '$V5_SSHGATE_UNIT'"
  assert_aux_execstart_not_worktree
}

restart_sshgate() {
  log "── 显式 restart $V5_SSHGATE_UNIT(setup-host-net 会 flush V5_EGRESS_IN,oneshot 不会自己再跑) ──"
  run "systemctl enable '$V5_HOSTNET_UNIT' '$V5_SSHGATE_UNIT'"
  run "systemctl restart '$V5_SSHGATE_UNIT'"
}

refresh_ccb_proxy_path() {
  log "── 刷新 CCB 日本 HTTPS proxy listener + V5_EGRESS_IN ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] sync setup-host-net.sh from HEAD; re-apply it in place (no $V5_HOSTNET_UNIT restart); enable --now $V5_CCB_PROXY_UNIT; restart $V5_SSHGATE_UNIT"
    return 0
  fi
  # install_aux_units intentionally prefers the old live boot script. This
  # pre-cutover step installs the committed HEAD script so port 18991 exists
  # before any new runtime container can receive the proxy env.
  sync_boot_scripts_from "$REPO_ROOT"
  # OCV5-306 (#2ee979cd): never `systemctl restart` hostnet here. ccb-proxy,
  # cursor-proxy (the Box exec egress) and sshgate Require= it, so a restart
  # also bounces both HTTPS proxies and cuts every in-flight Box/CCB stream
  # mid-turn ("任务执行失败" right after a tool succeeded). setup-host-net.sh is
  # idempotent, so re-apply it in place and only start what is not running.
  bash "$BOOT_SCRIPT_DIR/setup-host-net.sh" v5 \
    || die "setup-host-net.sh v5 failed while enabling CCB proxy path"
  systemctl start "$V5_HOSTNET_UNIT" \
    || die "$V5_HOSTNET_UNIT failed to start"
  systemctl enable --now "$V5_CCB_PROXY_UNIT" \
    || die "$V5_CCB_PROXY_UNIT failed to start"
  local changed
  for changed in "${AUX_PROXY_UNITS_CHANGED[@]}"; do
    log "  ⚠ $changed unit 文件已变 → try-restart(会中断其上在飞的连接)"
    systemctl try-restart "$changed" || die "$changed restart failed after unit change"
  done
  systemctl restart "$V5_SSHGATE_UNIT" \
    || die "$V5_SSHGATE_UNIT restart failed after hostnet flush"
  iptables -C V5_EGRESS_IN -d 172.31.0.1 -p tcp --dport 18991 \
    -m comment --comment "v5 CCB -> stable HTTPS proxy" -j RETURN \
    || die "V5_EGRESS_IN missing 172.31.0.1:18991 RETURN"
  timeout 10 bash -c 'exec 3<>/dev/tcp/172.31.0.1/18991' \
    || die "CCB HTTPS proxy listener 172.31.0.1:18991 is unreachable"
  if [[ -f /etc/sing-box/openclaude-cursor-egress-proxy.json ]]; then
    assert_allows selfhost-unit-install \
      || die "flavor identity refused $V5_CURSOR_PROXY_UNIT"
    systemctl enable --now "$V5_CURSOR_PROXY_UNIT" \
      || die "$V5_CURSOR_PROXY_UNIT failed to start"
    iptables -C V5_EGRESS_IN -d 172.31.0.1 -p tcp --dport 18992 \
      -m comment --comment "v5 Cursor -> dedicated HTTPS proxy" -j RETURN \
      || die "V5_EGRESS_IN missing 172.31.0.1:18992 RETURN"
    timeout 10 bash -c 'exec 3<>/dev/tcp/172.31.0.1/18992' \
      || die "Cursor HTTPS proxy listener 172.31.0.1:18992 is unreachable"
  fi
  log "  ✓ CCB HTTPS proxy listener + firewall ready"
}

read_env_db_url() {
  [[ -f "$V5_ENV" ]] || die "缺 env 文件 $V5_ENV。补救: 先 --bootstrap。"
  grep -E '^DATABASE_URL=' "$V5_ENV" | tail -n1 | cut -d= -f2-
}

source_commit() {
  git -C "$REPO_ROOT" rev-parse HEAD
}

# ── Lease Center train 账本(OCV5-131)────────────────────────────────────────
# 入口要求捕获的 HEAD 与已验证 train target 相同；之后三面传同一 immutable SHA。
# 只有 platform-from-head 路径可跨共享 HEAD 前进继续切流，工作树 platform 仍走旧 strict 门。
lease_train_enabled() { [[ -n "$LEASE_TRAIN_ID" || -f "$LEASE_LIB" ]]; }
lease_train_load_lib() {
  [[ -f "$LEASE_LIB" ]] || return 1
  # shellcheck disable=SC1090
  source "$LEASE_LIB"
}
# 进入 --deploy:worker 列车 → CAS planned/building→building 并记 pid;人工直跑 → 插 manual train(有 open train 则拒)。
lease_train_begin() {
  lease_train_load_lib || { [[ -z "$LEASE_TRAIN_ID" ]] && return 0; die "缺 $LEASE_LIB,无法校验 --lease-train"; }
  [[ "$DRY" == 1 ]] && return 0
  lease_init_db
  local head="${1:-$(source_commit)}"
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || die "列车 source 不是 40 位 commit SHA"
  if [[ -n "$LEASE_TRAIN_ID" ]]; then
    lease_valid_train_id "$LEASE_TRAIN_ID" || die "非法 --lease-train=$LEASE_TRAIN_ID"
    [[ "$head" == "$LEASE_TARGET_SHA" ]] \
      || die "工作树 HEAD $head ≠ --target-sha $LEASE_TARGET_SHA。列车只发固定 sha;先把工作树对齐(ff-merge)再发。"
    local st tgt pid
    st="$(train_field "$LEASE_TRAIN_ID" status)"; tgt="$(train_field "$LEASE_TRAIN_ID" target_sha)"; pid="$(train_field "$LEASE_TRAIN_ID" executor_pid)"
    [[ -n "$st" ]] || die "train 不存在:$LEASE_TRAIN_ID"
    [[ "$tgt" == "$LEASE_TARGET_SHA" ]] || die "train $LEASE_TRAIN_ID target_sha=$tgt ≠ --target-sha"
    [[ "$st" == planned || "$st" == building ]] || die "train $LEASE_TRAIN_ID status=$st,不可执行"
    [[ -z "$pid" || "$pid" == 0 || "$pid" == "$$" || "$pid" == "$PPID" ]] || { kill -0 "$pid" 2>/dev/null && die "train $LEASE_TRAIN_ID 已有活执行器 pid=$pid"; }
    lease_tx <<SQL || die "train CAS building 写失败(sqlite),fail-closed"
BEGIN IMMEDIATE;
UPDATE train SET status='building', executor_pid=$$, started_at=COALESCE(started_at,'$(lease_now)'), updated_at='$(lease_now)'
 WHERE id='$LEASE_TRAIN_ID' AND status IN ('planned','building');
$(lease_event_sql "$LEASE_TRAIN_ID" executor-begin "deploy:$$" "head=$head")
COMMIT;
SQL
    log "  🎫 lease train $LEASE_TRAIN_ID building(pid $$,target ${LEASE_TARGET_SHA:0:12})"
  else
    # 人工直跑:登记 manual train。已有 open train(worker 列车在跑)→ 拒,避免双发布线。
    local open
    open="$(lease_sql "SELECT id||'('||status||')' FROM train WHERE resource='deploy:selfhost' AND status NOT IN ('committed','failed') LIMIT 1;")"
    [[ -z "$open" ]] || die "Lease Center 有 open train $open,拒绝并行人工发布。查看:scripts/oc-lease.sh status"
    LEASE_TRAIN_ID="$(lease_new_id tr)"; LEASE_TARGET_SHA="$head"
    lease_tx <<SQL || { log "  ⚠ manual train 登记失败(sqlite),继续发布但 worker 无法对账"; LEASE_TRAIN_ID=""; return 0; }
BEGIN IMMEDIATE;
INSERT INTO train(id,resource,target_sha,status,owner,executor_pid,created_at,started_at,updated_at)
VALUES('$LEASE_TRAIN_ID','deploy:selfhost','$head','building','manual:$$',$$,'$(lease_now)','$(lease_now)','$(lease_now)');
$(lease_event_sql "$LEASE_TRAIN_ID" train-manual "deploy:$$" "head=$head")
COMMIT;
SQL
    log "  ⚠ 人工发布已登记为 manual train $LEASE_TRAIN_ID(worker 据此对账;搭车会话将在 committed 后自动结算)"
  fi
  LEASE_TRAIN_ACTIVE=1
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
  write_flavor_manifest "$staging" selfhost "$sha" \
    || { rm -rf "$staging"; die "写 runtime flavor.manifest.json 失败"; }
  BUILT_RUNTIME_RELEASE="$(oc_hotcfg_finalize_release "$staging" "$image_id" "$sha" "${prev:-}" "$caps")" \
    || { rm -rf "$staging"; die "release finalize 失败(npm ci / ccb bun build / MANIFEST)"; }
  BUILT_RUNTIME_RELEASE="$(printf '%s' "$BUILT_RUNTIME_RELEASE" | tr -d '[:space:]')"
  [[ "$BUILT_RUNTIME_RELEASE" == "$OC_HOTCFG_RELEASES_ROOT"/rel-* ]] \
    || die "release 目录非法: $BUILT_RUNTIME_RELEASE"
  log "  ✓ runtime release=$BUILT_RUNTIME_RELEASE"
}

# ── runtime release 与 master release 并行构建(2026-10-08 devflow-opt)──
# 两者都只读 pinned SHA 的 git archive,写各自独立的 staging(runtime: $OC_HOTCFG_RELEASES_ROOT,
# master: $MASTER_RELEASES_ROOT),互不依赖;实测串行时 runtime 段约 3.5 分钟。
# 后台段的输出落独立日志,收尾时整段回放,保持 train 日志可读;结果经结果文件回传父 shell。
# 父 shell 无论成功失败退出,EXIT 清理都会先等后台段结束(不留在飞写 runtime-releases 的进程)。
# 父进程被直接杀掉(不走 EXIT)时:后台段继承了发布锁 fd 8,锁会一直持有到它结束,不会有第二趟发布并发写。
RUNTIME_BG_PID=""
RUNTIME_BG_LOG=""
RUNTIME_BG_RESULT=""
RUNTIME_BG_RC=""

start_runtime_release_bg() { # <sha>
  local sha="$1"
  if [[ "$DRY" == 1 || "${OC_V5_SERIAL_RUNTIME_BUILD:-0}" == 1 ]]; then
    return 0   # dry-run / 显式串行:由 collect_runtime_release_bg 就地构建
  fi
  RUNTIME_BG_LOG="$(mktemp "${TMPDIR:-/tmp}/ocv5-runtime-release-bg.XXXXXX.log")" || die "mktemp runtime bg log 失败"
  RUNTIME_BG_RESULT="$(mktemp "${TMPDIR:-/tmp}/ocv5-runtime-release-bg.XXXXXX.env")" || die "mktemp runtime bg result 失败"
  log "  runtime release 后台并行构建 → $RUNTIME_BG_LOG"
  (
    trap - EXIT
    build_runtime_release "$sha"
    printf 'BUILT_RUNTIME_RELEASE=%q\nRUNTIME_IMAGE_ID=%q\n' "$BUILT_RUNTIME_RELEASE" "$RUNTIME_IMAGE_ID" >"$RUNTIME_BG_RESULT"
  ) >"$RUNTIME_BG_LOG" 2>&1 &
  RUNTIME_BG_PID=$!
}

# OCV5-557:Box 门不和后台段并行。build_master_release 在 Box 门前调这里,只等它结束、记下退出码;
# 日志回放、结果读取、失败处理仍由 collect_runtime_release_bg 照旧做。
await_runtime_release_bg() {
  [[ -n "${RUNTIME_BG_PID:-}" && -z "${RUNTIME_BG_RC:-}" ]] || return 0
  local rc=0
  log "  Box 门前先等后台 runtime release 构建结束(不与之并行)pid=$RUNTIME_BG_PID"
  wait "$RUNTIME_BG_PID" || rc=$?
  RUNTIME_BG_RC="$rc"
  return 0
}

collect_runtime_release_bg() { # <sha>
  local sha="$1" rc=0 line
  if [[ -z "${RUNTIME_BG_PID:-}" ]]; then
    build_runtime_release "$sha"
    return 0
  fi
  if [[ -n "${RUNTIME_BG_RC:-}" ]]; then
    rc="$RUNTIME_BG_RC"
  else
    wait "$RUNTIME_BG_PID" || rc=$?
  fi
  RUNTIME_BG_PID=""
  RUNTIME_BG_RC=""
  log "── runtime release(后台段日志回放)──"
  cat "$RUNTIME_BG_LOG" 2>/dev/null || true
  if [[ "$rc" != 0 ]]; then
    rm -f "$RUNTIME_BG_LOG" "$RUNTIME_BG_RESULT"   # 日志已回放进本次输出
    die "runtime release 后台构建失败 rc=$rc(live 未改;日志见上)"
  fi
  BUILT_RUNTIME_RELEASE=""
  RUNTIME_IMAGE_ID=""
  while IFS= read -r line; do
    case "$line" in
      BUILT_RUNTIME_RELEASE=*|RUNTIME_IMAGE_ID=*) eval "$line" ;;
      *) die "runtime bg 结果文件含非法行: $line" ;;
    esac
  done <"$RUNTIME_BG_RESULT"
  [[ "$BUILT_RUNTIME_RELEASE" == "$OC_HOTCFG_RELEASES_ROOT"/rel-* && -d "$BUILT_RUNTIME_RELEASE" ]] \
    || die "runtime bg 结果非法: BUILT_RUNTIME_RELEASE=$BUILT_RUNTIME_RELEASE"
  [[ "$RUNTIME_IMAGE_ID" == sha256:* ]] || die "runtime bg 结果非法: RUNTIME_IMAGE_ID=$RUNTIME_IMAGE_ID"
  rm -f "$RUNTIME_BG_LOG" "$RUNTIME_BG_RESULT"
  RUNTIME_BG_LOG=""
  RUNTIME_BG_RESULT=""
}

# EXIT 清理用:父 shell 提前失败时,等后台段自然结束(它自己的失败路径会清 staging),再回放日志。
reap_runtime_release_bg() {
  [[ -n "${RUNTIME_BG_PID:-}" ]] || return 0
  if [[ -z "${RUNTIME_BG_RC:-}" ]]; then
    echo "  等待后台 runtime release 构建收尾(pid=$RUNTIME_BG_PID)…" >&2
    wait "$RUNTIME_BG_PID" 2>/dev/null || true
  fi
  RUNTIME_BG_PID=""
  RUNTIME_BG_RC=""
  [[ -n "${RUNTIME_BG_LOG:-}" ]] && cat "$RUNTIME_BG_LOG" >&2 2>/dev/null || true
  rm -f "${RUNTIME_BG_LOG:-}" "${RUNTIME_BG_RESULT:-}"
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
#
# 2026-09-05 蓝绿双槽:egress 不再 `systemctl restart`(单 unit 停机 = 关监听 + 等 drain
# ≤31min,期间容器 ECONNREFUSED 18892,grok 报「unknown model id」)。改为槽翻转:
# 起空闲槽 → 私有健康口就绪 → stop --no-block 旧槽(旧槽只 drain 自己的在飞流)。
# restart_cmd 由 oc_hotcfg_activate_saga 在本 shell eval,所以可以直接引用函数名。
egress_then_master_restart_cmd() {
  printf '%s' "egress_slot_flip_then_master_restart"
}

egress_slot_unit() { # <A|B> <socket|service>
  local tpl
  if [[ "$2" == socket ]]; then tpl="$V5_EGRESS_SLOT_SOCKET_TPL"; else tpl="$V5_EGRESS_SLOT_SERVICE_TPL"; fi
  printf '%s' "${tpl/@./@$1.}"
}

egress_slot_private_port() { # <A|B>
  if [[ "$1" == A ]]; then printf '%s' "$V5_EGRESS_SLOT_A_PORT"; else printf '%s' "$V5_EGRESS_SLOT_B_PORT"; fi
}

egress_slot_is_active() { # <A|B>
  [[ "$(systemctl is-active "$(egress_slot_unit "$1" service)" 2>/dev/null || true)" == active ]]
}

# 当前 live release 是否自带双槽 unit 模板。回滚到旧 release 时为假 → 走 legacy 单 unit。
egress_live_release_has_slots() {
  local live
  live="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  [[ -n "$live" && -f "$live/deploy/v5-selfhost/$V5_EGRESS_SLOT_SERVICE_TPL" \
     && -f "$live/deploy/v5-selfhost/$V5_EGRESS_SLOT_SOCKET_TPL" ]]
}

egress_wait_shared_port() {
  timeout 90 bash -c "until (exec 3<>/dev/tcp/$V5_EGRESS_BIND/$V5_EGRESS_PORT) 2>/dev/null; do sleep 1; done"
}

# 等某槽私有健康口回 ok 且 slot 字段吻合(不能拿共享口判定:共享口可能由旧槽应答)。
egress_wait_slot_ready() { # <A|B>
  local s="$1" port body i
  port="$(egress_slot_private_port "$s")"
  for i in $(seq 1 90); do
    body="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/internal/v5/egress-slot-health" 2>/dev/null || true)"
    if echo "$body" | jq -e --arg s "$s" '.ok==true and .slot==$s and .listenMode=="sd_activation"' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "  ✗ egress slot $s 私有健康口 90s 未就绪: ${body:0:200}" >&2
  return 1
}

# legacy 单 unit 路径(live release 无双槽模板,即回滚到旧 release)。先把槽全停
# (Conflicts= 也会做,这里显式化便于日志),再 restart legacy 并等端口。
egress_restart_legacy_single_unit() {
  local s
  echo "  egress: live release 无双槽模板 → legacy 单 unit 路径(会有 drain 停机窗口)" >&2
  for s in A B; do
    systemctl stop "$(egress_slot_unit "$s" socket)" "$(egress_slot_unit "$s" service)" 2>/dev/null || true
  done
  systemctl restart "$V5_EGRESS_UNIT" && egress_wait_shared_port
}

# 槽翻转主体。幂等:任何一步失败 return 1(saga 会回滚并重跑本函数,彼时 live 已翻回)。
egress_slot_flip() {
  local cur="" target old_sock old_svc new_sock new_svc legacy_state
  if ! egress_live_release_has_slots; then
    egress_restart_legacy_single_unit
    return
  fi
  # sysctl:旧槽 close() 时 accept 队列半开连接迁到另一槽,而不是 RST。
  if [[ "$(sysctl -n net.ipv4.tcp_migrate_req 2>/dev/null || echo 0)" != 1 ]]; then
    sysctl -w net.ipv4.tcp_migrate_req=1 >/dev/null || { echo "  ✗ sysctl tcp_migrate_req=1 失败" >&2; return 1; }
  fi
  # 两槽都 active(上次翻转半途被杀):阻塞停掉更老的那个,回到单槽态再翻。
  if egress_slot_is_active A && egress_slot_is_active B; then
    local ta tb older
    ta="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$(egress_slot_unit A service)")"
    tb="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$(egress_slot_unit B service)")"
    if (( ${ta:-0} <= ${tb:-0} )); then older=A; else older=B; fi
    echo "  egress: A/B 同时 active,先阻塞停掉更老的槽 $older(会等其 drain)" >&2
    systemctl stop "$(egress_slot_unit "$older" socket)" "$(egress_slot_unit "$older" service)" || return 1
  fi
  if egress_slot_is_active A; then cur=A; target=B
  elif egress_slot_is_active B; then cur=B; target=A
  else target=A
  fi
  new_sock="$(egress_slot_unit "$target" socket)"
  new_svc="$(egress_slot_unit "$target" service)"
  # 首次迁移:legacy 单 unit 还在跑,持有 18892 普通 bind。必须先停它(这一次仍会
  # 等 drain ≤31min;之后再没有这种窗口)。
  legacy_state="$(systemctl is-active "$V5_EGRESS_UNIT" 2>/dev/null || true)"
  if [[ "$legacy_state" == active || "$legacy_state" == activating || "$legacy_state" == deactivating ]]; then
    echo "  egress: 首次迁移 legacy→双槽,阻塞 stop $V5_EGRESS_UNIT(等其 drain,最后一次停机窗口)" >&2
    systemctl stop "$V5_EGRESS_UNIT" || return 1
    systemctl disable "$V5_EGRESS_UNIT" >/dev/null 2>&1 || true
  fi
  # 若目标槽残留(deactivating 中的旧进程)则等它真正退出,否则 start 会排在 stop 之后无谓等待。
  local st
  st="$(systemctl is-active "$new_svc" 2>/dev/null || true)"
  if [[ "$st" == deactivating ]]; then
    echo "  egress: 目标槽 $target 仍在 deactivating,等待其退出…" >&2
    timeout 1900 bash -c "while [[ \"\$(systemctl is-active '$new_svc' 2>/dev/null)\" == deactivating ]]; do sleep 2; done" || return 1
  fi
  echo "  egress: 起槽 $target ($new_sock + $new_svc)${cur:+,当前槽 $cur}" >&2
  systemctl start "$new_sock" || return 1
  if ! systemctl start "$new_svc"; then
    journalctl -u "$new_svc" -n 20 --no-pager >&2 || true
    tail -n 40 /var/log/openclaude-v5-selfhost-egress.log >&2 || true
    systemctl stop "$new_sock" "$new_svc" 2>/dev/null || true
    return 1
  fi
  if ! egress_wait_slot_ready "$target"; then
    tail -n 40 /var/log/openclaude-v5-selfhost-egress.log >&2 || true
    # 新槽没起来:旧槽(若有)仍在服务,撤回新槽,保持现网不动。
    systemctl stop "$new_sock" "$new_svc" 2>/dev/null || true
    return 1
  fi
  egress_wait_shared_port || return 1
  # 新槽已接管共享口 → 摘旧槽。socket 与 service 都要停:只停 service 会留下一个
  # 没人 accept 的 listener(systemd 会按需再拉起),连接会卡在它的 backlog 里。
  #
  # 2026-09-07 实发(tr-…081722Z / tr-…091334Z 两班 `cutover smoke: egress-health 失败`):
  # `systemctl stop --no-block old.socket old.service` 一条命令下去,service 有
  # Requires=socket,systemd 把 socket 的 stop job **排在 service stop 之后**;service 收到
  # SIGTERM 后 server.close() 摘掉自己的 fd,但 .socket 单元在 service 整个 drain 期间
  # (≤31min)仍持有同一 reuseport 组里的 listener → 内核继续按哈希把约一半新连接分给这个
  # 没人 accept 的 fd(ss 里 users:(("systemd",pid=1)) 独占、Recv-Q 递增),连接卡到超时。
  # 沙箱复现:drain 期 12 次探活 5 成功 7 超时;先关 socket 再停 service 则 12/12。
  # 所以必须**先阻塞关旧 .socket**(--job-mode=ignore-dependencies 绕开 Requires 反向传播,
  # 关 socket 是毫秒级、不等 drain),再 --no-block 停 service 让它只 drain 在飞流。
  if [[ -n "$cur" ]]; then
    old_sock="$(egress_slot_unit "$cur" socket)"
    old_svc="$(egress_slot_unit "$cur" service)"
    echo "  egress: 新槽 $target 就绪,先关旧槽 $cur 的共享 listener(.socket),再 stop --no-block 其 service(后台 drain)" >&2
    systemctl stop --job-mode=ignore-dependencies "$old_sock" || return 1
    systemctl stop --no-block "$old_svc" || return 1
    systemctl disable "$old_sock" "$old_svc" >/dev/null 2>&1 || true
  fi
  systemctl enable "$new_sock" "$new_svc" >/dev/null 2>&1 || true
  # 旧槽 close() 后共享口必须仍可连(reuseport 组里还有新槽),且 reuseport 组里不得再有
  # 只由 systemd 持有(无 service 进程 accept)的孤儿 listener —— 那正是上面的黑洞形态。
  egress_wait_shared_port || return 1
  egress_assert_no_orphan_listener
}

# reuseport 组里「只有 systemd(pid 1)持有、没有任何 service 进程 accept」的 listener =
# 黑洞:内核仍会把新连接哈希到它,永远没人 accept。翻转后必须为 0。
# ss 非 0 / 空输出 / 无法解析的 listener 集合一律 fail-closed:不能先过滤再把
# 「零孤儿」当成成功(OCV5-161:ss rc=2 或空表曾让 HTTP 重试在黑洞上假绿)。
egress_assert_no_orphan_listener() {
  local ss_out ss_rc=0 line listeners=0
  ss_out="$(ss -Hltnp "sport = :${V5_EGRESS_PORT}" 2>/dev/null)" || ss_rc=$?
  if (( ss_rc != 0 )); then
    echo "  ✗ egress 共享口 ${V5_EGRESS_BIND}:${V5_EGRESS_PORT} ss 失败 rc=${ss_rc},无法证明无孤儿 listener" >&2
    return 1
  fi
  if [[ -z "${ss_out//[$' \t\r\n']/}" ]]; then
    echo "  ✗ egress 共享口 ${V5_EGRESS_BIND}:${V5_EGRESS_PORT} ss 输出为空,无法证明无孤儿 listener" >&2
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line//[$' \t\r']/}" ]] && continue
    if ! grep -q '^LISTEN' <<<"$line" || ! grep -Eq ":${V5_EGRESS_PORT}([[:space:]]|$)" <<<"$line"; then
      echo "  ✗ egress 共享口 ${V5_EGRESS_BIND}:${V5_EGRESS_PORT} ss 输出不是有效 listener 集合" >&2
      printf '%s\n' "$ss_out" >&2
      return 1
    fi
    if ! grep -Eq 'users:\((\([^)]*\),)*\("node",pid=[0-9]+' <<<"$line"; then
      echo "  ✗ egress 共享口 ${V5_EGRESS_BIND}:${V5_EGRESS_PORT} 存在无 node 持有者的 listener" >&2
      ss -ltnp "sport = :${V5_EGRESS_PORT}" >&2 || true
      return 1
    fi
    listeners=$((listeners + 1))
  done <<<"$ss_out"
  if (( listeners < 1 )); then
    echo "  ✗ egress 共享口 ${V5_EGRESS_BIND}:${V5_EGRESS_PORT} ss 未解析出有效 listener,无法证明无孤儿" >&2
    return 1
  fi
  return 0
}

egress_slot_flip_then_master_restart() {
  egress_slot_flip && systemctl restart "$V5_UNIT"
}

# 当前对外服务的 egress 描述(status / 日志用)。
egress_describe_topology() {
  local out="" s
  for s in A B; do
    egress_slot_is_active "$s" && out="${out:+$out,}slot$s"
  done
  [[ "$(systemctl is-active "$V5_EGRESS_UNIT" 2>/dev/null || true)" == active ]] && out="${out:+$out,}legacy"
  printf '%s' "${out:-none}"
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

# joint: 四元组 + masterRelease=候选 rel 绝对路径 + transitionKind=joint。
# 失败只 return,由 cutover 统一补偿(symlink/unit 两级)。不 die。
activate_tuple_joint() { # <master-rel> <prev-master-or-none>
  local master_rel="$1" prev_master="$2" image_id bundle_val restart_cmd smoke_cmd prev_arg policy_adapter="" extra_apply="" extra_revert="" saga_rc=0
  image_id="${RUNTIME_IMAGE_ID:-}"
  bundle_val="${CUTOVER_TUPLE_BUNDLE:-$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV}"
  [[ -n "$image_id" ]] || { cutover_clog "joint: 缺 RUNTIME_IMAGE_ID"; return 1; }
  [[ -n "$BUILT_RUNTIME_RELEASE" ]] || { cutover_clog "joint: 缺 BUILT_RUNTIME_RELEASE"; return 1; }
  [[ -n "$BUILT_BUNDLE_REV" ]] || { cutover_clog "joint: 缺 BUILT_BUNDLE_REV"; return 1; }
  restart_cmd="$(egress_then_master_restart_cmd)"
  # 正向 smoke 比新 rel dist;saga 回滚时 lib 置 HOTCFG_SAGA_ROLLING_BACK=1,
  # 只验旧现场 healthz(不得拿新 dist 比已回滚的旧进程)。
  # 正向走 cutover_gate_against_release:policy=stay 时门禁失败返回 0 并置 CUTOVER_GATE_FAILED,
  # saga 因此保留新运行面(lib 不改,商业版不受影响),cmd_cutover 随后走 cutover_keep_failed。
  smoke_cmd="if [[ \"\${HOTCFG_SAGA_ROLLING_BACK:-}\" == 1 ]]; then cutover_smoke_healthz_only; else cutover_gate_against_release $(printf '%q' "$master_rel"); fi"
  prev_arg="$prev_master"
  if [[ "$prev_arg" == "none" || "$prev_arg" == "NONE" ]]; then
    prev_arg=""
  fi
  cutover_clog "  oc_hotcfg_activate_saga transitionKind=joint masterRelease=$master_rel prev=${prev_arg:-<empty>}"
  mkdir -p "$(dirname "$OC_HOTCFG_HISTORY")"
  if release_policy_enabled; then
    policy_adapter=release_policy_saga_adapter
    extra_apply="release_policy_flip_live $(printf '%q' "$master_rel")"
    extra_revert="release_policy_restore_live_before $(printf '%q' "$prev_arg")"
  fi
  oc_hotcfg_activate_saga \
    "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$BUILT_BUNDLE_REV" "$OC_HOTCFG_HISTORY" \
    "$RUNTIME_IMAGE" "$image_id" "$BUILT_RUNTIME_RELEASE" "$bundle_val" \
    "$restart_cmd" "$smoke_cmd" \
    "$extra_apply" "$extra_revert" "$master_rel" "$prev_arg" \
    "" "" "" "joint" "$policy_adapter" \
    || saga_rc=$?
  if [[ "$saga_rc" != 0 ]]; then
    cutover_clog "joint activate_saga failed rc=$saga_rc policy=${RELEASE_POLICY_MODE:-legacy}"
    return "$saga_rc"
  fi
  cutover_clog "  ✓ joint tuple 已写入 $V5_ENV masterRelease=$master_rel"
}

enable_now_services() {
  log "── enable --now egress + master(egress 先就绪,理由见 egress_then_master_restart_cmd)──"
  if [[ -f "/etc/systemd/system/$V5_EGRESS_SLOT_SERVICE_TPL" ]]; then
    run "systemctl enable '$V5_UNIT'"
    if [[ "$DRY" == 1 ]]; then
      echo "  [dry-run] egress_slot_flip (起槽 A,等私有口 $V5_EGRESS_SLOT_A_PORT 就绪)"
    else
      egress_slot_flip || die "bootstrap: egress 槽启动失败"
    fi
  else
    run "systemctl enable '$V5_EGRESS_UNIT' '$V5_UNIT'"
    run "systemctl start '$V5_EGRESS_UNIT'"
    run "timeout 90 bash -c 'until (exec 3<>/dev/tcp/$V5_EGRESS_BIND/$V5_EGRESS_PORT) 2>/dev/null; do sleep 1; done'"
  fi
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

# Fail closed; the caller owns the existing compensation/exit path.
user_contract_gate() { # <candidate release>
  local rel="${1:-}"
  local password_file=/etc/openclaude/selfhost-canary.password
  [[ -f "$password_file" && -r "$password_file" && -s "$password_file" ]] \
    || { echo "FATAL: user contract canary password missing/unreadable/empty: $password_file" >&2; return 1; }
  tsum_mark F.prewarm 2>/dev/null || :
  # OCV5-429: the cutover may recycle the canary container onto the new runtime tuple (or it was
  # idle-swept); its cold start outlasts C2's 20s window. Warm it first (same UI login, no message,
  # wait for relay_ready). Not part of the verdict: a prewarm that never gets ready only warns.
  V5_E2E_BASE="http://127.0.0.1:${V5_PORT}" \
    V5_CANARY_EMAIL="${V5_CANARY_EMAIL:-v5-selfhost-canary@claudeai.chat}" \
    V5_CANARY_PASSWORD_FILE="$password_file" \
    node "$SCRIPT_DIR/v5-user-contract-prewarm.mjs" \
    || echo "  ⚠ canary 预热未就绪,门禁照跑(由 C1–C3 判定)" >&2
  tsum_mark F.C1-C3 2>/dev/null || :
  V5_E2E_BASE="http://127.0.0.1:${V5_PORT}" \
    V5_CANARY_EMAIL="${V5_CANARY_EMAIL:-v5-selfhost-canary@claudeai.chat}" \
    V5_CANARY_PASSWORD_FILE="$password_file" V5_CONTRACT_COST=live \
    node "$SCRIPT_DIR/v5-user-contract-smoke.mjs" || return 1
  tsum_mark F.G1 2>/dev/null || :
  # OCV5-432: a real multi-turn OpenCode Go chat must read the upstream prompt cache
  # (INC-20261015-GO-CACHE-PREFIX wrote the whole prompt every request and read 0).
  if [[ -n "$rel" ]] && go_cache_user_waiver_matches "$rel"; then
    cutover_clog "  ⚠ G1 Go 缓存实测: 经用户批准跳过，原因是 Go 无额度 (OCV5-496; sourceCommit=$(jq -r '.sourceCommit' "$rel/.complete"))"
  else
    V5_E2E_BASE="http://127.0.0.1:${V5_PORT}" \
      V5_CANARY_EMAIL="${V5_CANARY_EMAIL:-v5-selfhost-canary@claudeai.chat}" \
      V5_CANARY_PASSWORD_FILE="$password_file" \
      node "$SCRIPT_DIR/v5-go-cache-contract.mjs" || return 1
  fi
  tsum_mark F.S1 2>/dev/null || :
  # OCV5-435: a Stop sent while the turn's engine is still starting must stop that turn
  # (INC-20261015-PRESTART-STOP-LOST answered it TURN_NOT_ACTIVE and the turn ran unseen).
  V5_E2E_BASE="http://127.0.0.1:${V5_PORT}" \
    V5_CANARY_EMAIL="${V5_CANARY_EMAIL:-v5-selfhost-canary@claudeai.chat}" \
    V5_CANARY_PASSWORD_FILE="$password_file" \
    node "$SCRIPT_DIR/v5-stop-before-start-contract.mjs"
}

cmd_smoke() {
  local hz i ok=0 code
  log "══ selfhost smoke ══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] curl healthz + leadership=leader + GET / oc-build + SSH 规则 + 个人版 18789"
    return 0
  fi
  for i in $(seq 1 90); do
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
  local dist_html="" live_root=""
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    live_root="$(readlink -f "$MASTER_LIVE_LINK" 2>/dev/null || true)"
    if [[ -n "$live_root" && -f "$live_root/packages/web-react/dist/index.html" ]]; then
      dist_html="$live_root/packages/web-react/dist/index.html"
    fi
  fi
  if [[ -z "$dist_html" ]]; then
    dist_html="$REPO_ROOT/packages/web-react/dist/index.html"
  fi
  [[ -f "$dist_html" ]] \
    || die "缺 SPA dist/index.html($dist_html)。master 从 live release 的 packages/web-react/dist serve。补救: 重跑 --deploy。"
  local html spa_ok=0 expected_build got_build
  expected_build="$(grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$dist_html" | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
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
  got_build="$(echo "$html" | grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
  if [[ -n "$expected_build" && -n "$got_build" && "$got_build" != "$expected_build" ]]; then
    die "GET / oc-build=$got_build 不等于 ${dist_html} 的 $expected_build。补救: 确认 live 指向本次 release 后 restart master。"
  fi
  log "  ✓ GET / 返回 SPA index.html(oc-build=${got_build:-present} src=${dist_html})"
  assert_ssh_rule_before_drop
  assert_personal_alive
  log "  ✓ 个人版 $PERSONAL_UNIT 仍 active 且 :$PERSONAL_PORT 仍 200"
  assert_watch_matches_live "$live_root"
  log "✓ smoke 通过"
}

# One state word per unit. `systemctl is-active` prints "inactive"/"failed" AND exits
# non-zero, so `$(systemctl is-active X || echo n/a)` printed two lines (OCV5-449).
status_unit_state() { # <unit> [fallback]
  local s
  s="$(systemctl is-active "$1" 2>/dev/null)" || true
  printf '%s' "${s:-${2:-n/a}}"
}

cmd_status() {
  local live_now prev_now
  log "══ selfhost status ══"
  log "  worktree: $REPO_ROOT"
  log "  HEAD: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    live_now="$(readlink -f "$MASTER_LIVE_LINK" 2>/dev/null || echo dangling)"
    log "  live: $MASTER_LIVE_LINK → $live_now"
  else
    log "  live: MISSING $MASTER_LIVE_LINK"
  fi
  if [[ -f "$MASTER_RELEASES_ROOT/.prev-release" ]]; then
    prev_now="$(tr -d '[:space:]' <"$MASTER_RELEASES_ROOT/.prev-release")"
    log "  prev: $prev_now"
  else
    log "  prev: MISSING"
  fi
  log "  env: $V5_ENV $([ -f "$V5_ENV" ] && echo present || echo MISSING) mode=$(stat -c %a "$V5_ENV" 2>/dev/null || echo -)"
  if [[ -f "$V5_ENV" ]]; then
    log "  OC_RUNTIME_IMAGE=$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_IMAGE)"
    log "  OC_RUNTIME_IMAGE_ID=$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_IMAGE_ID)"
    log "  OC_RUNTIME_RELEASE=$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_RELEASE)"
    log "  OC_PLATFORM_BUNDLE=$(oc_hotcfg_env_get "$V5_ENV" OC_PLATFORM_BUNDLE)"
    log "  OC_CONTROL_PLANE_LEADER=$(oc_hotcfg_env_get "$V5_ENV" OC_CONTROL_PLANE_LEADER)"
  fi
  log "  unit master:  $(status_unit_state "$V5_UNIT" n/a)"
  log "  unit egress:  legacy=$(status_unit_state "$V5_EGRESS_UNIT" n/a) slotA=$(status_unit_state "$(egress_slot_unit A service)" n/a) slotB=$(status_unit_state "$(egress_slot_unit B service)" n/a) serving=$(egress_describe_topology) tcp_migrate_req=$(sysctl -n net.ipv4.tcp_migrate_req 2>/dev/null || echo n/a)"
  log "  unit hostnet: $(status_unit_state "$V5_HOSTNET_UNIT" n/a)"
  log "  unit ccb-proxy: $(status_unit_state "$V5_CCB_PROXY_UNIT" n/a)"
  log "  unit sshgate: $(status_unit_state "$V5_SSHGATE_UNIT" n/a)"
  # tunnel 是公网入口,不随部署自动 enable —— 由人显式决定是否对外暴露。
  log "  unit tunnel:  $(status_unit_state "$V5_TUNNEL_UNIT" inactive) (enable 后跑 scripts/selfhost-sync-tunnel-url.sh --apply)"
  # What is served is the live release, not this worktree (OCV5-449).
  if [[ -n "${live_now:-}" && -d "$live_now" ]]; then
    if [[ -f "$live_now/packages/web-react/dist/index.html" ]]; then
      log "  spa dist:    present (live)"
    else
      log "  spa dist:    MISSING (live $live_now)"
    fi
    if [[ -f "$live_now/.complete" ]]; then
      log "  .complete:   present (live) $(jq -er '.sourceCommit' "$live_now/.complete" 2>/dev/null || echo '?')"
    else
      log "  .complete:   MISSING (live $live_now)"
    fi
  else
    log "  spa dist:    n/a (no live release)"
    log "  .complete:   n/a (no live release)"
  fi
  log "  watch:       $(watch_summary "${live_now:-}")"
  log "  gate-fail:   policy=$(gate_fail_policy 2>/dev/null) survivor-phase=$(sed -n 's/^phase=//p' "${SURVIVOR_STATE:-/run/openclaude-v5-selfhost/cutover-survivor.state}" 2>/dev/null | head -n1 || true) maint=$(sed -n 's/^until=//p' "$V5_WATCH_MAINT" 2>/dev/null | head -n1 || true)"
  if [[ -f "$V5_ENV" ]]; then
    log "  OC_SESSIONS_STORE=$(oc_hotcfg_env_get "$V5_ENV" OC_SESSIONS_STORE)"
    log "  env keys:    $(bash "$SCRIPT_DIR/v5-selfhost-env-drift.sh" --env "$V5_ENV" --quiet \
      --template "$REPO_ROOT/deploy/v5-selfhost/commercial-v5-selfhost.env.template" 2>&1 | tail -n1 || true)"
  fi
  log "  personal:     $(status_unit_state "$PERSONAL_UNIT" n/a)"
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

# ── bootstrap / deploy / cutover ─────────────────────────────────────────

cmd_bootstrap() {
  log "══ v5 selfhost bootstrap ══"
  if [[ -L "$MASTER_LIVE_LINK" ]] || own_instance_present; then
    die "本实例已经安装(env/unit 或 live symlink 存在)。--bootstrap 只用于首次从零安装。
日常发布请用:
  scripts/deploy-v5-selfhost.sh --deploy
  scripts/deploy-v5-selfhost.sh --deploy --allow-dirty --platform-from-head
手动逃生(已有 rel-* 只翻转):
  scripts/deploy-v5-selfhost.sh --cutover --release=/abs/rel-*
应急把 unit 装回工作树:
  /opt/openclaude/v5-selfhost-breakglass/restore-worktree-units.sh
说明: master 现在跑 /opt/openclaude/openclaude-v5-selfhost-live → 不可变 rel-*;
工作树 $REPO_ROOT 只用来改代码,重启不会再吃未提交 TS。"
  fi
  die "首次安装路径尚未在本轮合入(本机已是 live 实例,不会走到这里)。若你在全新机器上:
1) 确认没有 $V5_ENV / $V5_UNIT / $MASTER_LIVE_LINK
2) 联系维护者跑带 joint 的首次 bootstrap,或先手工写 env/网再 --deploy。"
}

explain_dirty_semantics() {
  log "── 脏工作树三面语义 ──"
  log "  master live     : git archive HEAD → 脏文件不会进线上进程 cwd"
  log "  runtime-release : git archive HEAD → 脏文件不会进容器 bind"
  if [[ "$PLATFORM_FROM_HEAD" == 1 ]]; then
    log "  platform bundle : --platform-from-head → 也从已提交树 archive,不带脏"
  else
    log "  platform bundle : 默认拷工作树 → 未提交的 platform-runtime 会进全员容器"
    log "                    要干净请加 --platform-from-head"
  fi
}

# 发布前 Incident trailer 快检。放在 lease_train_begin 之后、构建之前:
#   · 之后 —— 失败要经 EXIT trap 把本班 train 记 failed(worker 对同 target 不自动重发,
#     不会像 0274 迁移门那样每 15min 烧一班);
#   · 之前 —— 十几分钟的 vite/runtime/platform 构建一下都不跑,几秒内红。
# 只查 HEAD 已提交历史(git show <sha>:path),工作区脏文件与 --allow-dirty 无关。
assert_fix_trailers() {
  local head="$1"
  if [[ "${OC_V5_SKIP_TRAILER_GATE:-0}" == 1 ]]; then
    log "  ⚠ OC_V5_SKIP_TRAILER_GATE=1:跳过 Incident trailer 门(仅限止血;CI check:v5:incidents 仍会红,事后必须补 waiver/冻结)"
    return 0
  fi
  [[ -x "$FIX_TRAILER_GATE" ]] || die "缺 $FIX_TRAILER_GATE(或不可执行)。补救: git checkout -- scripts/check-v5-fix-trailers.sh;止血可 OC_V5_SKIP_TRAILER_GATE=1。"
  log "── Incident trailer 门(HEAD=${head:0:12},构建前 fail-closed) ──"
  local rc=0 out
  out="$("$FIX_TRAILER_GATE" --repo "$REPO_ROOT" --head "$head" 2>&1)" || rc=$?
  case "$rc" in
    0) log "  ${out##*$'\n'}" ;;
    2) log "  ⚠ trailer 门不可判(rc=2),放行但请人工核对:"; log "$out" ;;
    *) die "Incident trailer 门拒绝发布(rc=$rc):
$out
补救:
  在源提交 trailer 写 Incident: INC-YYYYMMDD-SLUG 并登记 e2e/session-display/incidents.json
  或 Incident: none (<理由>) + e2e/session-display/incident-waivers.json
  已上线不可改写的提交才走 check-v5-incident-regressions.ts 的 IMPORTED_TRAILER_HISTORY_TIPS
  真·止血: OC_V5_SKIP_TRAILER_GATE=1 scripts/deploy-v5-selfhost.sh --deploy …(会留痕)" ;;
  esac
}

cmd_deploy() {
  local sha dirty
  if [[ "$RELEASE_POLICY_RESUME" == 1 ]]; then
    local recovery_rc=0
    release_policy_recover_forward || recovery_rc=$?
    [[ "$recovery_rc" == 0 ]] || exit "$recovery_rc"
    log "✓ same-operation policy recovery verified; no serving pointer changed"
    return 0
  fi
  tsum_init 2>/dev/null || :
  log "══ v5 selfhost --deploy(不可变 master + 容器制品 + joint 翻转) ══"
  log "流程: 构建 master release(staging vite) → runtime-release → platform bundle"
  log "      → 复用 --cutover 同一套状态机翻转(survivor / 两级回滚 / 候选 snapshot unit)"
  log "      前端不再吃工作树;masterRelease/transitionKind 记新 live rel-*"
  preflight_common
  explain_dirty_semantics
  dirty="$(git -C "$REPO_ROOT" status --porcelain)"
  if [[ -n "$dirty" && "$ALLOW_DIRTY" != 1 ]]; then
    die "工作区不干净。master/runtime 虽来自 git archive、不受这些脏文件污染,
但默认 platform bundle 仍拷工作树,脏的 platform-runtime 会进全员容器:
$dirty
补救:
  提交后再 --deploy
  或 --deploy --allow-dirty --platform-from-head   # 三面都走已提交树(推荐,别人也在改时)
  或 --deploy --allow-dirty                        # 允许脏 platform(明白风险)"
  fi
  if [[ -n "$dirty" ]]; then
    log "  ⚠ 工作区有未提交改动(--allow-dirty)。它们不会进入 master live / runtime-release。"
    if [[ "$PLATFORM_FROM_HEAD" != 1 ]]; then
      log "  ⚠ platform bundle 将带这些脏文件。建议下次加 --platform-from-head。"
    fi
    log "$dirty"
  fi
  sha="$(source_commit)"
  local policy_bind_rc=0
  release_policy_bind_official_train_request "$sha" || policy_bind_rc=$?
  [[ "$policy_bind_rc" == 0 ]] || exit "$policy_bind_rc"
  cutover_adopt_inflight_request "$sha" || exit "$?"
  [[ -f "$V5_ENV" ]] || die "缺 $V5_ENV,这不是更新路径。补救: 首次安装走 --bootstrap;本机已有实例则检查 env 是否被挪走。"
  ensure_selfhost_env_keys
  docker network inspect openclaude-v5-net >/dev/null 2>&1 \
    || die "openclaude-v5-net 不存在。补救: 不要在 --deploy 里建网;确认 bootstrap 做过或手工恢复该网。"
  [[ -L "$MASTER_LIVE_LINK" ]] \
    || die "缺 live symlink $MASTER_LIVE_LINK。本 --deploy 假定首次翻转已完成。
补救: --cutover --release=<已有 rel-*> 完成首次翻转,或跑应急 restore-worktree-units.sh。"

  ensure_node_modules
  install_aux_units
  refresh_ccb_proxy_path
  ensure_model_authority
  assert_env_key_drift
  if [[ "${LEASE_TRAIN_ACTIVE:-0}" != 1 ]]; then
    sha="$(source_commit)"
    lease_train_begin "$sha"
  fi
  selfhost_release_preflight "${LEASE_TARGET_SHA:-$sha}"; assert_fix_trailers "$sha"  # L0 在 begin 之后:拒绝即 deploy 上报的失败,worker 不重发(OCV5-581)
  assert_p0_web_overlay_contained "$sha"
  log "── source=$sha 构建三面制品(失败则 live 不动) ──"
  start_runtime_release_bg "$sha"
  build_master_release "$sha"
  [[ -n "$BUILT_MASTER_RELEASE" ]] || die "build_master_release 未设置 BUILT_MASTER_RELEASE"
  if [[ "$DRY" != 1 ]]; then
    [[ -f "$BUILT_MASTER_RELEASE/.complete" ]] || die "缺 .complete: $BUILT_MASTER_RELEASE"
    log "  ✓ master release=$BUILT_MASTER_RELEASE donor 优先 live,不吃工作树/.poisoned"
  fi
  tsum_mark P.runtime-wait 2>/dev/null || :
  collect_runtime_release_bg "$sha"
  tsum_mark P.platform-bundle 2>/dev/null || :
  build_platform_bundle "$sha"
  CUTOVER_TUPLE_BUNDLE="$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV"
  DEPLOY_BUILT_RELEASE="$BUILT_MASTER_RELEASE"
  DEPLOY_BUILT_SOURCE_COMMIT="$sha"
  CUTOVER_JOINT=1
  log "── 进入 --cutover 翻转窗口(同一套状态机,不是第二份逻辑) release=$DEPLOY_BUILT_RELEASE ──"
  cmd_cutover
  lease_train_finish committed "cutover committed live=$DEPLOY_BUILT_RELEASE"
  log "✓ --deploy 完成 live → $DEPLOY_BUILT_RELEASE"
}

cutover_clog() {
  local msg
  msg="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  echo "$msg"
  if [[ -n "${CUTOVER_LOG:-}" ]]; then
    echo "$msg" >>"$CUTOVER_LOG"
  fi
}

# 预期由调用方处理失败:只 return,绝不 exit/die。
cutover_fail() {
  CUTOVER_LAST_FAIL="$*"
  cutover_clog "✗ $*"
  return 1
}

cutover_smoke_against_release() { # <rel>
  local rel="$1" hz i ok=0 html spa_ok=0 expected_build got_build
  expected_build="$(dist_oc_build "$rel")"
  [[ -n "$expected_build" ]] || { cutover_fail "smoke: release dist 缺 oc-build"; return 1; }
  for i in $(seq 1 90); do
    hz="$(curl -fsS --max-time 5 "http://127.0.0.1:${V5_PORT}/healthz" 2>/dev/null || true)"
    if echo "$hz" | jq -e '.ok==true and .runtime.controlPlaneEnabled==true and .runtime.leadership.state=="leader"' >/dev/null 2>&1; then
      ok=1
      break
    fi
    cutover_clog "  /healthz 未收敛,重试 $i/90"
    sleep 2
  done
  [[ "$ok" == 1 ]] || { cutover_fail "cutover smoke 失败: healthz 未收敛 ok+controlPlaneEnabled+leadership=leader"; return 1; }
  cutover_clog "  ✓ healthz ok + controlPlaneEnabled + leadership=leader"
  for i in $(seq 1 15); do
    html="$(curl -fsS --max-time 5 "http://127.0.0.1:${V5_PORT}/" 2>/dev/null || true)"
    if echo "$html" | grep -q 'name="oc-build"'; then
      spa_ok=1
      break
    fi
    sleep 2
  done
  [[ "$spa_ok" == 1 ]] || { cutover_fail "cutover smoke: GET / 缺 oc-build"; return 1; }
  got_build="$(echo "$html" | grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
  [[ "$got_build" == "$expected_build" ]] \
    || { cutover_fail "cutover smoke: GET / oc-build=$got_build 不等于 release dist $expected_build"; return 1; }
  cutover_clog "  ✓ GET / oc-build=$got_build 匹配 release dist"
  # egress-health:5 次 × 2s 有界重试。单次 curl 丢一条连接就否掉整班 20 分钟的列车
  # 不成比例;真缺陷(孤儿 listener 黑洞)由 egress_slot_flip 末尾的
  # egress_assert_no_orphan_listener 与下面的双槽拓扑断言兜住,这里的重试不会把它盖掉。
  local eg eg_ok=0
  for i in $(seq 1 5); do
    eg="$(curl -fsS --max-time 5 "http://${V5_EGRESS_BIND}:${V5_EGRESS_PORT}/internal/v5/egress-health" 2>/dev/null || true)"
    if echo "$eg" | jq -e '.ok==true' >/dev/null 2>&1; then eg_ok=1; break; fi
    cutover_clog "  egress-health 未通,重试 $i/5"
    sleep 2
  done
  [[ "$eg_ok" == 1 ]] || { cutover_fail "cutover smoke: egress-health 失败"; return 1; }
  cutover_clog "  ✓ egress-health ok (slot=$(echo "$eg" | jq -r '.slot // "legacy"') mode=$(echo "$eg" | jq -r '.listenMode // "self_bind"') serving=$(egress_describe_topology))"
  # 双槽下额外要求:恰有一个槽 active(翻转后旧槽 deactivating 不算 active)且共享口
  # 应答就来自它 —— 防「新槽私有口绿、共享口仍全由旧槽应答」的假绿。
  if egress_live_release_has_slots; then
    local a b want got
    egress_slot_is_active A && a=1 || a=0
    egress_slot_is_active B && b=1 || b=0
    (( a + b == 1 )) || { cutover_fail "cutover smoke: 双槽 egress 应恰一槽 active,实际 A=$a B=$b"; return 1; }
    want="$([[ $a == 1 ]] && echo A || echo B)"
    got="$(echo "$eg" | jq -r '.slot // empty')"
    [[ "$got" == "$want" ]] || { cutover_fail "cutover smoke: 共享口应答槽=$got,active 槽=$want 不一致"; return 1; }
    cutover_clog "  ✓ egress 双槽拓扑一致:active=$want"
  fi
  # Must pass before either branch persists phase=smoked (survivor invariant).
  user_contract_gate "$rel" || { cutover_fail "cutover smoke: 用户契约门禁(C1–C3 + G1 Go 缓存)失败"; return 1; }
}

cutover_smoke_healthz_only() {
  local hz i ok=0 eg
  for i in $(seq 1 90); do
    hz="$(curl -fsS --max-time 5 "http://127.0.0.1:${V5_PORT}/healthz" 2>/dev/null || true)"
    if echo "$hz" | jq -e '.ok==true and .runtime.controlPlaneEnabled==true and .runtime.leadership.state=="leader"' >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 2
  done
  [[ "$ok" == 1 ]] || return 1
  eg="$(curl -fsS --max-time 5 "http://${V5_EGRESS_BIND}:${V5_EGRESS_PORT}/internal/v5/egress-health" 2>/dev/null || true)"
  echo "$eg" | jq -e '.ok==true' >/dev/null 2>&1
}

cutover_survivor_script() {
  printf '%s\n' "${CUTOVER_SURVIVOR_SCRIPT:-/opt/openclaude/v5-selfhost-breakglass/cutover-survivor.sh}"
}

# phase 必须在覆盖第一个 unit 之前落盘;写失败不得 || true 吞掉。
cutover_persist_phase() {
  local phase="$1" state script
  release_policy_guard_owner || return 86
  CUTOVER_PHASE="$phase"
  state="${SURVIVOR_STATE:-/run/openclaude-v5-selfhost/cutover-survivor.state}"
  if [[ ! -f "$state" || -L "$state" ]]; then
    if release_policy_enabled && [[ "$phase" != pre-install ]]; then return 79; fi
    return 0
  fi
  script="$(cutover_survivor_script)"
  [[ -x "$script" ]] || { cutover_clog "缺 survivor 脚本 $script,无法持久化 phase=$phase"; return 1; }
  SURVIVOR_STATE="$state" bash "$script" --set-phase "$phase"
}

cutover_persist_phase_or_compensate() { # <phase> <reason>
  local phase="$1" reason="$2"
  if ! cutover_persist_phase "$phase"; then
    cutover_compensate "persist-phase-${reason}"
    return $?
  fi
}

cutover_arm_survivor() { # <backup-dir>
  local backup="$1" script src
  release_policy_guard_owner || return 86
  src="$SCRIPT_DIR/v5-selfhost-cutover-survivor.sh"
  [[ -f "$src" ]] || { cutover_clog "缺仓库 survivor 脚本 $src"; return 1; }
  mkdir -p -- "$BREAKGLASS_ROOT"
  install -m 0755 "$src" "$BREAKGLASS_ROOT/cutover-survivor.sh" || return 1
  script="$(cutover_survivor_script)"
  [[ -x "$script" ]] || { cutover_clog "缺 survivor 脚本 $script"; return 1; }
  if [[ "$backup" == *"/pre-cutover-20260818-144626" ]]; then
    cutover_clog "拒绝武装:backup 是陈旧 Aug18 工作树路径 $backup"
    return 1
  fi
  CUTOVER_SURVIVOR_ARMED=1
  bash "$script" --arm "$$" "$backup" || return 1
}

cutover_disarm_survivor() {
  local script
  script="$(cutover_survivor_script)"
  release_policy_guard_owner || return 86
  if [[ "${CUTOVER_SURVIVOR_ARMED:-0}" == 1 && -x "$script" ]]; then
    bash "$script" --disarm || return 1
  fi
  CUTOVER_SURVIVOR_ARMED=0
}

cutover_backup_units_are_live_wd() { # <backup-dir>
  local backup="$1" wd_m wd_e
  [[ -d "$backup" && -f "$backup/$V5_UNIT" && -f "$backup/$V5_EGRESS_UNIT" ]] || return 1
  wd_m="$(unit_template_working_directory "$backup/$V5_UNIT")"
  wd_e="$(unit_template_working_directory "$backup/$V5_EGRESS_UNIT")"
  [[ "$wd_m" == "$MASTER_LIVE_LINK" && "$wd_e" == "$MASTER_LIVE_LINK" ]]
}

cutover_tier2_restore() { # <backup-dir>
  local backup="$1" restore
  restore="/opt/openclaude/v5-selfhost-breakglass/restore-worktree-units.sh"
  [[ -d "$backup" ]] || { cutover_clog "二级失败:备份目录不存在 $backup"; return 1; }
  if ! cutover_backup_units_are_live_wd "$backup"; then
    cutover_clog "二级拒绝:备份 $backup 不是本次 live WD forensics(禁止装工作树 unit)"
    printf 'reason=cutover-tier2-refused-worktree-backup\nbackup=%s\nwritten=%s\n' \
      "$backup" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >"$MASTER_RELEASES_ROOT/.manual-recovery-required"
    return 1
  fi
  [[ -x "$restore" ]] || { cutover_clog "二级失败:缺 $restore"; return 1; }
  bash "$restore" --backup-dir "$backup"
  if ! cutover_smoke_healthz_only; then
    cutover_clog "二级恢复后 healthz 未绿 backup=$backup"
    return 1
  fi
}

cutover_rollback_inplace() { # <failed-rel> <backup-dir>
  local backup="$2" raw prev
  cutover_clog "── 统一补偿出口 phase=${CUTOVER_PHASE:-?} ──"
  write_cutover_grace || true
  raw="$(tr -d '[:space:]' <"$MASTER_RELEASES_ROOT/.prev-release" 2>/dev/null || true)"
  prev=""
  if prev="$(canonicalize_prev_release "$raw")"; then
    cutover_clog "  一级: canonicalize+digest 通过 → $prev"
    if atomic_flip_live_symlink "$prev"; then
      write_cutover_grace || true
      if eval "$(egress_then_master_restart_cmd)"; then
        if cutover_smoke_healthz_only; then
          cutover_clog "  一级回滚后复合健康通过"
          return 0
        fi
        cutover_clog "  一级 smoke 失败,立刻降二级"
      else
        cutover_clog "  一级 restart 失败,立刻降二级"
      fi
    else
      cutover_clog "  一级 symlink 失败,立刻降二级"
    fi
  else
    cutover_clog "  一级无合法 prev(首次 none 或 digest/路径失败),降二级"
  fi
  cutover_clog "  二级: 从本次 forensics $backup 恢复 live unit"
  if cutover_tier2_restore "$backup"; then
    cutover_clog "  二级恢复且健康确认"
    return 0
  fi
  printf 'reason=cutover-rollback-smoke-failed\nwritten=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$MASTER_RELEASES_ROOT/.manual-recovery-required"
  cutover_clog "两级补偿后仍失败。已写 $MASTER_RELEASES_ROOT/.manual-recovery-required"
  cutover_clog "应急: 从 pre-cutover-<本次> 装 live unit,并 cutover-survivor.sh --disarm"
  return 1
}

cutover_compensate() { # <reason>
  local reason="$1" policy_rc=0
  tsum_mark X.compensate 2>/dev/null || :
  if release_policy_enabled; then
    release_policy_failure "$reason" || policy_rc=$?
    case "$policy_rc" in
      0) : ;;
      78|79|86) release_policy_keep_failed "${CUTOVER_REL:-}" "$reason" "$policy_rc"; return $? ;;
      *) return 79 ;;
    esac
  fi
  cutover_clog "补偿: reason=$reason mutated=${CUTOVER_MUTATED:-0} phase=${CUTOVER_PHASE:-?}"
  if [[ "${CUTOVER_MUTATED:-0}" != 1 ]]; then
    cutover_clog "尚未覆盖 installed unit,无需回滚"
    return 1
  fi
  local rb_rc=0
  cutover_rollback_inplace "${CUTOVER_REL:-}" "${CUTOVER_BACKUP:-missing}" || rb_rc=$?
  # 无论补偿成败都必须解除幸存者布防,否则 timeout 会在健康 live 上再装陈旧备份。
  cutover_disarm_survivor || cutover_clog "补偿后 disarm 失败(不掩盖补偿结果 rc=$rb_rc)"
  if [[ "$rb_rc" != 0 ]]; then
    # disarm 已把 phase 写成 committed;改落 compensate-failed,worker 才不会把现网当 committed 去结算搭车。
    CUTOVER_RECOVERY_REQUIRED=1
    cutover_persist_phase compensate-failed \
      || cutover_clog "  ⚠ 无法落盘 phase=compensate-failed(列车仍记 recovery_required)"
  fi
  if release_policy_enabled; then
    [[ "$rb_rc" == 0 ]] || return 79
    release_policy_finish_compensation
    return $?
  fi
  return 1
}

# ── OCV5-418 门禁失败留在新版(stay)────────────────────────────────────────
# 只覆盖「新 release 已切换、restart 成功」之后的正向门禁:healthz 收敛、GET / oc-build、
# egress、C1–C3。安装 / 迁移 / 翻转 / restart 失败时新版可能根本没起来,照旧补偿。

selfhost_policy_get() { # <key> → 值(可为空)。告警走 stderr,stdout 只给值。
  local k="$1" v f="$SELFHOST_POLICY_FILE" mode
  v="${!k:-}"
  if [[ -z "$v" && -f "$f" && ! -L "$f" ]]; then
    mode="$(stat -c '%a' -- "$f" 2>/dev/null || echo 777)"
    if [[ "$(stat -c '%u' -- "$f" 2>/dev/null)" == "$(id -u)" ]] && (( (8#$mode & 8#022) == 0 )); then
      v="$(sed -n "s/^${k}=//p" "$f" | tail -n1 | tr -d "\"'[:space:]")"
    else
      cutover_clog "  ⚠ 策略文件 $f 不是本用户所有或组/他人可写,忽略" >&2
    fi
  fi
  printf '%s' "$v"
}

# OCV5-496: explicit user approval for one personal release with an unfunded Go key.
# Bind only G1 to the candidate source SHA; another release defaults to the full gate.
go_cache_user_waiver_matches() { # <rel>
  local want sha
  want="$(selfhost_policy_get OC_V5_SELFHOST_SKIP_GO_CACHE_SHA)"
  [[ "$want" =~ ^[0-9a-f]{40}$ ]] || return 1
  sha="$(jq -er '.sourceCommit' "$1/.complete" 2>/dev/null || true)"
  [[ "$sha" == "$want" ]]
}

gate_fail_policy() { # → rollback|stay;非法值按 rollback(保持旧行为)
  local p
  p="$(selfhost_policy_get OC_V5_SELFHOST_ON_GATE_FAIL)"
  case "$p" in
    stay) printf 'stay' ;;
    rollback | '') printf 'rollback' ;;
    *)
      cutover_clog "  ⚠ OC_V5_SELFHOST_ON_GATE_FAIL=$(printf '%s' "$p" | tr -cd 'a-z_-' | cut -c1-20) 非法,按 rollback" >&2
      printf 'rollback'
      ;;
  esac
}

stay_window_sec() { # 维护窗口秒数,默认 2h(用户 2026-10-14 03:15 确认)
  local w
  w="$(selfhost_policy_get OC_V5_SELFHOST_STAY_WINDOW_SEC)"
  [[ "$w" =~ ^[1-9][0-9]{1,5}$ ]] || w=7200
  printf '%s' "$w"
}

# 演练:策略文件写明精确 40 位 sourceCommit 时,真实门禁跑完且通过后仍判失败一次。
# 绑定精确 SHA,下一班(不同 SHA)自动失效;不能用来跳过任何门禁。
gate_fail_drill_armed() { # <rel>
  local want sha
  want="$(selfhost_policy_get OC_V5_SELFHOST_GATE_FAIL_DRILL_SHA)"
  [[ "$want" =~ ^[0-9a-f]{40}$ ]] || return 1
  sha="$(jq -er '.sourceCommit' "$1/.complete" 2>/dev/null || true)"
  [[ "$sha" == "$want" ]]
}

cutover_gate_against_release() { # <rel>
  local rel="$1" rc=0
  CUTOVER_GATE_FAILED=""
  CUTOVER_LAST_FAIL=""
  cutover_smoke_against_release "$rel" || rc=$?
  if [[ "$rc" == 0 ]] && gate_fail_drill_armed "$rel"; then
    cutover_fail "门禁失败演练:策略文件指定本 sourceCommit,真实门禁已通过,按演练判失败" || true
    rc=99
  fi
  if [[ "$rc" == 0 ]]; then
    release_policy_enabled && RELEASE_POLICY_GATES_PASSED=1
    return 0
  fi
  if release_policy_enabled; then
    CUTOVER_GATE_FAILED=smoke
    return "$rc"
  fi
  if [[ "$(gate_fail_policy)" == stay ]]; then
    if [[ "$rc" == 99 ]]; then CUTOVER_GATE_FAILED="drill"; else CUTOVER_GATE_FAILED="smoke"; fi
    cutover_clog "  ⚠ 门禁失败 policy=stay:不回滚运行面,保留 $rel 现场(${CUTOVER_GATE_FAILED}: ${CUTOVER_LAST_FAIL:-?})"
    return 0
  fi
  return "$rc"
}

write_stay_maintenance() { # <rel> <until-epoch>;已有更晚的窗口则保留
  local rel="$1" until_ts="$2" cur tmp
  if [[ -f "$V5_WATCH_MAINT" && ! -L "$V5_WATCH_MAINT" ]]; then
    cur="$(sed -n 's/^until=\([0-9][0-9]*\)$/\1/p' "$V5_WATCH_MAINT" | head -n1)"
    if [[ "$cur" =~ ^[0-9]+$ ]] && (( cur >= until_ts )); then
      cutover_clog "  · 已有更晚的维护窗口 until=$cur,保留"
      return 0
    fi
  fi
  [[ -L "$V5_WATCH_MAINT" ]] && { cutover_clog "  ✗ 维护标记是符号链接,拒绝写 $V5_WATCH_MAINT"; return 1; }
  mkdir -p -- "$(dirname -- "$V5_WATCH_MAINT")" || return 1
  tmp="$V5_WATCH_MAINT.tmp.$$"
  printf 'until=%s\nsource=deploy-gate-fail-stay\nrel=%s\nwritten=%s\n' \
    "$until_ts" "$rel" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp" \
    && mv -f -- "$tmp" "$V5_WATCH_MAINT" || { rm -f -- "$tmp"; return 1; }
}

# 下一班 committed 时撤掉本机制写的维护窗口(人工写的不动)。
clear_stay_maintenance() {
  [[ -f "$V5_WATCH_MAINT" && ! -L "$V5_WATCH_MAINT" ]] || return 0
  grep -qx 'source=deploy-gate-fail-stay' "$V5_WATCH_MAINT" || return 0
  rm -f -- "$V5_WATCH_MAINT" && cutover_clog "  ✓ 已撤销上一班 stay 留下的维护窗口"
}

deploy_alert() { # <event> <rel> <message>;critical,只入队+补投,失败不影响结果
  local bin="$V5_WATCH_DIR/alert.sh"
  if [[ ! -x "$bin" ]]; then
    cutover_clog "  ⚠ 缺 $bin,未发 $1 告警"
    return 0
  fi
  timeout 10 "$bin" --event "$1" --severity critical --live "$2" --message "$3" >/dev/null 2>&1 \
    || cutover_clog "  ⚠ 告警入队失败 event=$1"
  timeout 30 "$bin" --flush >/dev/null 2>&1 || cutover_clog "  ⚠ 告警补投失败(下一拍看护会重投)"
  return 0
}

# stay 收尾:不补偿、不写不可逆 model authority marker、不 GC、不同步看护/开机脚本;
# survivor 落 kept-failed 后解除;写维护窗口挡看护回切;列车记 failed;发 critical 告警。
# kept-failed 落盘失败则退回原补偿(survivor 仍按旧 phase 判定,不能留半截状态)。
cutover_keep_failed() { # <rel>
  local rel="$1" win until_ts reason
  CUTOVER_KEPT_FAILED_REL="$rel"
  cutover_clog "══ 门禁失败,按 OC_V5_SELFHOST_ON_GATE_FAIL=stay 留在新版 $rel ══"
  if ! cutover_persist_phase kept-failed; then
    CUTOVER_KEPT_FAILED_REL=""
    cutover_clog "  ✗ 无法落盘 phase=kept-failed,退回原补偿路径"
    cutover_compensate "persist-phase-kept-failed"
    return $?
  fi
  if [[ "${CUTOVER_SURVIVOR_ARMED:-0}" == 1 ]]; then
    if bash "$(cutover_survivor_script)" --disarm-kept; then
      CUTOVER_SURVIVOR_ARMED=0
    else
      cutover_clog "  ⚠ survivor --disarm-kept 失败;phase=kept-failed 时 survivor 也不会恢复"
    fi
  fi
  win="$(stay_window_sec)"
  until_ts=$(( $(date +%s) + win ))
  if write_stay_maintenance "$rel" "$until_ts"; then
    cutover_clog "  ✓ 看护维护窗口 ${win}s(until=$until_ts):窗口内看护不回切,过期后恢复保护"
  else
    cutover_clog "  ⚠ 维护窗口写入失败:看护 grace 过后若复合健康红会按阈值回切"
  fi
  reason="gate-failed-kept-live=$rel gate=${CUTOVER_GATE_FAILED:-?} detail=${CUTOVER_LAST_FAIL:-?}"
  lease_train_finish failed "$reason"
  deploy_alert deploy_gate_failed_kept "$rel" "个人版门禁失败,按 stay 策略留在新版 ${rel##*/}。失败项:${CUTOVER_LAST_FAIL:-?}。维护窗口 ${win}s 内看护不回切。现场:${CUTOVER_LOG:-?}。下一步:修好后发新列车前滚;要回上一版按 runbook 人工回滚(.prev-release 未改)。"
  cutover_clog "  现场保留:cutover 日志 ${CUTOVER_LOG:-?};未跑 release GC;.prev-release 仍指向上一版"
  cutover_clog "✗ --cutover 门禁失败(已留在新版 $rel):$reason"
  return 1
}

# Selfhost has no commercial canary/observation lane. Once a deterministic
# joint cutover has activated one exact source/runtime tuple and the live
# master+egress smoke proves all model-authority capabilities, persist the
# irreversible step-5 marker here. Never run this from ensure_model_authority:
# that function executes before migrations/build/cutover and would bind the
# evidence to the previous live tuple.
persist_selfhost_model_authority_cutover() { # <exact live master release>
  local rel="$1" live source_sha image image_id runtime_release bundle
  local runtime_sha runtime_caps master_caps egress_caps insert_result
  local db_exists role_check stored_ok db_recheck env_recheck

  if [[ "$DRY" == 1 ]]; then
    cutover_clog "  [dry-run] smoke 后以 NOLOGIN role ${MODEL_AUTHORITY_DEPLOY_ROLE} 写 DB cutover marker,再写 OC_MODEL_AUTHORITY_CUTOVER=1"
    return 0
  fi

  [[ "$(oc_hotcfg_env_get "$V5_ENV" OC_MODEL_AUTHORITY)" == 1 ]] \
    || die "model authority marker 拒写:OC_MODEL_AUTHORITY≠1"
  [[ "$(oc_hotcfg_env_get "$V5_ENV" OC_MODEL_AUTHORITY_PROVISION_REQUIRED)" == 1 ]] \
    || die "model authority marker 拒写:OC_MODEL_AUTHORITY_PROVISION_REQUIRED≠1"

  # Existing DB evidence is irreversible. Do not rewrite its historical tuple;
  # only repair the secondary env source if an earlier write stopped halfway.
  db_exists="$(psql_as_postgres -d "$PG_DB" -qAt -c \
    "SELECT EXISTS(SELECT 1 FROM model_authority_deploy_state WHERE key='cutover')::text" | tr -d '[:space:]')" \
    || die "model authority marker 探测失败"
  if [[ "$db_exists" == true ]]; then
    ensure_env_kv "$V5_ENV" OC_MODEL_AUTHORITY_CUTOVER 1
    env_recheck="$(oc_hotcfg_env_get "$V5_ENV" OC_MODEL_AUTHORITY_CUTOVER)"
    [[ "$env_recheck" == 1 ]] || die "DB marker 已存在,但 env marker 修复失败"
    cutover_clog "  ✓ model authority cutover marker 已存在;env 双源已补齐"
    return 0
  fi
  if [[ "${CUTOVER_JOINT:-0}" != 1 ]]; then
    cutover_clog "  · model authority DB marker 尚无;non-joint cutover 只切 master,不得创建 tuple cutover 证据"
    return 0
  fi

  live="$(readlink -f "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  [[ -n "$live" && "$live" == "$rel" ]] \
    || die "model authority marker 拒写:live=$live 不等于本次 smoke release=$rel"
  case "$live" in
    "$MASTER_RELEASES_ROOT"/rel-*) ;;
    *) die "model authority marker 拒写:live 不在 releases 根:$live" ;;
  esac
  source_sha="$(jq -er '.sourceCommit | select(test("^[0-9a-f]{40}$"))' "$live/.complete")" \
    || die "model authority marker 拒写:live .complete 缺精确 sourceCommit"

  # Re-derive the active tuple after joint activation. Do not trust the build
  # globals: env is what the restarted supervisor actually consumes.
  image="$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_IMAGE)"
  image_id="$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_IMAGE_ID)"
  runtime_release="$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_RELEASE)"
  bundle="$(oc_hotcfg_env_get "$V5_ENV" OC_PLATFORM_BUNDLE)"
  [[ -n "$image" && -n "$image_id" && -n "$runtime_release" && -n "$bundle" ]] \
    || die "model authority marker 拒写:active runtime tuple 不完整"
  [[ "$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)" == "$image_id" ]] \
    || die "model authority marker 拒写:runtime image tag↔ID 漂移"
  case "$runtime_release" in
    "$OC_HOTCFG_RELEASES_ROOT"/rel-*) ;;
    *) die "model authority marker 拒写:runtime release 路径非法:$runtime_release" ;;
  esac
  case "$bundle" in
    "$OC_HOTCFG_PLATFORM_ROOT"/bundles/*) ;;
    *) die "model authority marker 拒写:platform bundle 路径非法:$bundle" ;;
  esac
  [[ -f "$runtime_release/MANIFEST.json" && -f "$bundle/MANIFEST.json" ]] \
    || die "model authority marker 拒写:active runtime/bundle manifest 缺失"
  runtime_sha="$(jq -er '.sourceCommit' "$runtime_release/MANIFEST.json")" \
    || die "model authority marker 拒写:runtime release 缺 sourceCommit"
  [[ "$runtime_sha" == "$source_sha" ]] \
    || die "model authority marker 拒写:master/runtime source 不同($source_sha != $runtime_sha)"
  runtime_caps="$(jq -er '(.capabilities // []) | join(" ")' "$runtime_release/MANIFEST.json")" \
    || die "model authority marker 拒写:runtime capabilities 不可读"
  case " $runtime_caps " in *" model_authority_v1 "*) ;; *) die "model authority marker 拒写:runtime 未声明 model_authority_v1" ;; esac

  master_caps="$(curl -fsS --max-time 5 "http://127.0.0.1:${V5_PORT}/healthz" \
    | jq -er '(.runtime.capabilities // []) | join(" ")')" \
    || die "model authority marker 拒写:master 活体 capability 不可读"
  case " $master_caps " in *" model_authority_v1 "*) ;; *) die "model authority marker 拒写:master 活体缺 model_authority_v1" ;; esac
  egress_caps="$(curl -fsS --max-time 5 \
    "http://${V5_EGRESS_BIND}:${V5_EGRESS_PORT}/internal/v5/egress-health" \
    | jq -er '(.capabilities // []) | join(" ")')" \
    || die "model authority marker 拒写:egress 活体 capability 不可读"
  case " $egress_caps " in *" model_authority_v1-egress "*) ;; *) die "model authority marker 拒写:egress 活体缺 model_authority_v1-egress" ;; esac

  # postgres assumes the NOLOGIN deploy role only for the evidence transaction;
  # migration 0144 remains the sole grant authority.
  psql_as_postgres -d "$PG_DB" -q <<SQL
DO \$role\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${MODEL_AUTHORITY_DEPLOY_ROLE}') THEN
    ALTER ROLE ${MODEL_AUTHORITY_DEPLOY_ROLE} NOLOGIN;
  ELSE
    CREATE ROLE ${MODEL_AUTHORITY_DEPLOY_ROLE} NOLOGIN;
  END IF;
END
\$role\$;
GRANT CONNECT ON DATABASE ${PG_DB} TO ${MODEL_AUTHORITY_DEPLOY_ROLE};
SELECT fn_model_authority_grant_deploy_role('${MODEL_AUTHORITY_DEPLOY_ROLE}');
SQL
  role_check="$(psql_as_postgres -d "$PG_DB" -qAt <<SQL
BEGIN;
SET LOCAL ROLE ${MODEL_AUTHORITY_DEPLOY_ROLE};
SELECT current_user || ':' ||
  has_table_privilege(current_user,'model_authority_deploy_state','SELECT,INSERT,UPDATE')::text || ':' ||
  has_table_privilege(current_user,'model_catalog','UPDATE')::text;
ROLLBACK;
SQL
)"
  role_check="$(printf '%s' "$role_check" | tr -d '[:space:]')"
  [[ "$role_check" == "${MODEL_AUTHORITY_DEPLOY_ROLE}:true:false" ]] \
    || die "model authority deploy role 权限边界错误:$role_check"
  [[ "$(psql_as_postgres -d "$PG_DB" -qAt -c \
    "SELECT (NOT rolcanlogin)::text FROM pg_roles WHERE rolname='${MODEL_AUTHORITY_DEPLOY_ROLE}'" | tr -d '[:space:]')" == true ]] \
    || die "model authority deploy role 必须 NOLOGIN"

  # Lock the singleton epoch in the same transaction that inserts the evidence.
  # ON CONFLICT never rewrites irreversible history: a concurrent winner turns
  # this attempt into the same env-repair path as the precheck above.
  insert_result="$(psql_as_postgres -d "$PG_DB" -qAt \
    -v release_sha="$source_sha" -v master_release="$live" \
    -v image="$image" -v image_id="$image_id" \
    -v runtime_release="$runtime_release" -v bundle="$bundle" <<SQL
BEGIN;
SET LOCAL ROLE ${MODEL_AUTHORITY_DEPLOY_ROLE};
WITH locked_epoch AS MATERIALIZED (
  SELECT epoch FROM model_security_epoch WHERE id FOR UPDATE
), inserted AS (
  INSERT INTO model_authority_deploy_state(key,value,description)
  SELECT 'cutover',jsonb_build_object(
    'at',NOW()::text,
    'by','deploy-v5-selfhost.sh',
    'kind','selfhost_deterministic_cutover',
    'release_sha',:'release_sha',
    'master_release',:'master_release',
    'runtime_tuple',jsonb_build_object(
      'image',:'image','image_id',:'image_id','release',:'runtime_release','bundle',:'bundle'
    ),
    'security_epoch',locked_epoch.epoch::text
  ),'selfhost deterministic model-authority cutover after exact joint tuple smoke; baked rollback forbidden'
  FROM locked_epoch
  ON CONFLICT (key) DO NOTHING
  RETURNING 1
)
SELECT CASE WHEN EXISTS(SELECT 1 FROM inserted) THEN 'inserted' ELSE 'existing' END;
COMMIT;
SQL
)" || die "model authority DB marker 事务失败"
  insert_result="$(printf '%s' "$insert_result" | tr -d '[:space:]')"
  [[ "$insert_result" == inserted || "$insert_result" == existing ]] \
    || die "model authority DB marker 事务返回非法:$insert_result"

  if [[ "$insert_result" == inserted ]]; then
    stored_ok="$(psql_as_postgres -d "$PG_DB" -qAt \
      -v release_sha="$source_sha" -v master_release="$live" \
      -v image="$image" -v image_id="$image_id" \
      -v runtime_release="$runtime_release" -v bundle="$bundle" <<SQL
SELECT (
  value->>'kind'='selfhost_deterministic_cutover'
  AND value->>'release_sha'=:'release_sha'
  AND value->>'master_release'=:'master_release'
  AND value->'runtime_tuple'->>'image'=:'image'
  AND value->'runtime_tuple'->>'image_id'=:'image_id'
  AND value->'runtime_tuple'->>'release'=:'runtime_release'
  AND value->'runtime_tuple'->>'bundle'=:'bundle'
  AND value->>'security_epoch' ~ '^[0-9]+$'
)::text FROM model_authority_deploy_state WHERE key='cutover';
SQL
)" || die "model authority DB marker exact tuple 回读失败"
    stored_ok="$(printf '%s' "$stored_ok" | tr -d '[:space:]')"
    [[ "$stored_ok" == true ]] || die "model authority DB marker 回读与 exact tuple 不一致"
  else
    cutover_clog "  · 并发 deploy 已先写不可逆 marker;保留既有 DB 证据,只补 env"
  fi

  # DB is durable authority. Only after insert/existing confirmation may the env floor be set.
  ensure_env_kv "$V5_ENV" OC_MODEL_AUTHORITY_CUTOVER 1

  db_recheck="$(psql_as_postgres -d "$PG_DB" -qAt -c \
    "SELECT EXISTS(SELECT 1 FROM model_authority_deploy_state WHERE key='cutover')::text" | tr -d '[:space:]')"
  env_recheck="$(oc_hotcfg_env_get "$V5_ENV" OC_MODEL_AUTHORITY_CUTOVER)"
  [[ "$db_recheck" == true && "$env_recheck" == 1 ]] \
    || die "model authority 双源 marker 复核失败(DB=$db_recheck env=$env_recheck)"
  cutover_clog "  ✓ model authority cutover marker 已按 DB→env 顺序绑定 exact live tuple"
}

# Only an internally built, from-head invocation owns a pinned expected source.
# Legacy worktree-platform deploy and standalone cutover keep their current-HEAD gate.
cutover_expected_source_commit() {
  if [[ "${CUTOVER_ROLLBACK:-0}" == 1 ]]; then
    [[ "${ROLLBACK_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die "回退缺已验证的目标 sourceCommit,拒绝切流"
    printf "%s\n" "$ROLLBACK_SHA"
    return 0
  fi
  if [[ -n "${DEPLOY_BUILT_RELEASE:-}" && "${PLATFORM_FROM_HEAD:-0}" == 1 ]]; then
    [[ "${DEPLOY_BUILT_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] \
      || die "本次构建缺已验证 sourceCommit,拒绝切流"
    printf "%s\n" "$DEPLOY_BUILT_SOURCE_COMMIT"
  else
    source_commit
  fi
}

cmd_cutover() {
  local rel head backup prev_val live_now expected_build step unit_snap
  CUTOVER_MUTATED=0
  CUTOVER_PHASE="pre-mutation"
  CUTOVER_BACKUP=""
  CUTOVER_REL=""
  CUTOVER_SURVIVOR_ARMED=0
  backup=""
  unit_snap=""
  mkdir -p /opt/openclaude/tmp
  if [[ "$DRY" == 1 ]]; then
    CUTOVER_LOG="/opt/openclaude/tmp/cutover-dry-run-$(date -u +%Y%m%d-%H%M%S).log"
  else
    CUTOVER_LOG="/opt/openclaude/tmp/cutover-$(date -u +%Y%m%d-%H%M%S).log"
  fi
  : >"$CUTOVER_LOG"
  cutover_clog "══ v5 selfhost --cutover DRY=$DRY JOINT=${CUTOVER_JOINT:-0} log=$CUTOVER_LOG ══"
  head="$(cutover_expected_source_commit)" || die "无法确定本次切流 sourceCommit"

  step=1
  if [[ "$DRY" == 1 ]]; then
    cutover_clog "STEP $step [dry-run] 持发布锁 $SELFHOST_DEPLOY_LOCK (dry-run 不加锁,避免堵住别人)"
  else
    cutover_clog "STEP $step 已持发布锁 $SELFHOST_DEPLOY_LOCK pid=$$"
  fi

  step=2
  if [[ -n "${DEPLOY_BUILT_RELEASE:-}" ]]; then
    rel="$DEPLOY_BUILT_RELEASE"
    cutover_clog "STEP $step 候选来自本次 --deploy 刚构建的 master release"
  else
    rel="$(resolve_cutover_release)"
  fi
  CUTOVER_REL="$rel"
  cutover_clog "STEP $step 候选 release=$rel"
  tsum_mark E1 2>/dev/null || :
  cutover_clog "  跑静态门 + digest 复算 + tsx 自检(只读,dry-run 也跑)"
  assert_master_release_static_gate "$rel" "$head"
  assert_master_release_tsx_selfcheck "$rel"
  cutover_clog "  Box success recovery 已在 build_master_release 封存前执行;已封存 rel 的切流与回退不再依赖该脚本"
  expected_build="$(dist_oc_build "$rel")"
  cutover_clog "  dist oc-build=$expected_build"
  # OCV5-489:master 启动前给候选建 P0-Web overlay 指针(指向它自带 dist,serve 内容不变)。
  # 失败只失去热切换能力:master 找不到指针就回落 release dist。
  if [[ "$DRY" != 1 ]] && ! wo_seed_pointer "$WEB_OVERLAY_ROOT" "$rel" "$head"; then
    cutover_clog "  ⚠ P0-Web overlay 指针未建立(仅失去前端热切换能力)"
  fi
  cutover_clog "  从已过 digest 的候选快照 unit(危险窗口不再读工作树)"
  if [[ "$DRY" == 1 ]]; then
    assert_unit_templates_live_wd "$rel/deploy/v5-selfhost"
    unit_snap="$rel/deploy/v5-selfhost"
    cutover_clog "  [dry-run] 断言候选 $unit_snap WD 以 -live 结尾"
  else
    snapshot_cutover_units_from_release "$rel" unit_snap \
      || die "从候选快照 unit 失败。尚未覆盖 installed unit。"
    cutover_clog "  unit snapshot=$unit_snap"
  fi

  step=3
  tsum_mark E2 2>/dev/null || :
  if [[ "${CUTOVER_ROLLBACK:-0}" == 1 ]]; then
    cutover_clog "STEP $step 回退 schema 门(只读;回退不跑迁移、不回滚 schema)"
    rollback_schema_gate "$rel" "$(readlink -f -- "$MASTER_LIVE_LINK")" \
      || die "回退 schema 门不通过。尚未改任何东西。"
    CUTOVER_HAS_MIGRATION=0
  else
  cutover_clog "STEP $step 迁移门(DB 缺口权威;git diff fail-closed;不用工作树 .complete)"
  gate_cutover_migrations "$rel"
  fi
  if [[ "$CUTOVER_HAS_MIGRATION" == 1 ]]; then
    cutover_clog "  HAS_MIGRATION=1 → apply 与翻转必须同一把锁、同一窗口"
    if [[ "$DRY" == 1 ]]; then
      cutover_clog "  [dry-run] 对着 $rel 跑 migration runner(失败则不翻转,不回滚 schema)"
    fi
  else
    cutover_clog "  HAS_MIGRATION=0,跳过 apply"
  fi

  live_now=""
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    live_now="$(readlink -f "$MASTER_LIVE_LINK" || true)"
  fi
  if [[ -n "$live_now" ]]; then
    prev_val="$live_now"
  else
    prev_val="none"
  fi

  tsum_mark E3.prep 2>/dev/null || :
  if release_policy_enabled && [[ "$DRY" != 1 ]]; then
    [[ "${CUTOVER_JOINT:-0}" == 1 && "$prev_val" != none ]] || return 2
    release_policy_install_guards "$rel" "$prev_val" || return $?
    release_policy_prepare_candidate "$rel" "$prev_val" || return $?
  fi

  step=4
  cutover_clog "STEP $step 备份当前 master+egress unit"
  if [[ "$DRY" == 1 ]]; then
    cutover_clog "  [dry-run] cp /etc/systemd/system/{$V5_UNIT,$V5_EGRESS_UNIT} → $BREAKGLASS_ROOT/unit-backups/pre-cutover-<ts>/"
    if [[ "$prev_val" == "none" ]]; then
      cutover_clog "  [dry-run] 写 .prev-release=none (首次无上一份 release,回滚只能靠恢复 unit)"
    else
      cutover_clog "  [dry-run] 写 .prev-release=$prev_val"
    fi
    cutover_clog "  [dry-run] 第一次覆盖 unit 前武装宿主 survivor(独立 systemd-run,不依赖网关)"
  else
    release_policy_guard_owner || return 86
    backup_installed_units_for_cutover backup \
      || die "备份 installed unit 失败。尚未覆盖 unit,worktree-current 未指向坏备份。"
    CUTOVER_BACKUP="$backup"
    cutover_clog "  backup=$backup"
    release_policy_guard_owner || return 86
    write_prev_release_file "$prev_val" \
      || die "写 .prev-release 失败。尚未覆盖 unit。"
    cutover_clog "  .prev-release=$prev_val"
  fi
  tsum_mark E3.wait-idle 2>/dev/null || :
  cutover_wait_for_user_idle || return 1
  # 第一次覆盖 installed unit 之前:明确 phase/mutated,并武装 survivor。
  if [[ "$DRY" != 1 ]]; then
    cutover_persist_phase "pre-install"
    cutover_arm_survivor "$backup" \
      || die "武装 survivor 失败。尚未覆盖 unit。"
    # phase=mutated 必须在覆盖第一个 unit 之前 durable 落盘。
    # 失败则拒绝进入 mutation:survivor 仍为 armed,健康绿不会误回切。
    cutover_persist_phase "mutated" \
      || die "无法持久化 phase=mutated。尚未覆盖 unit。"
    CUTOVER_MUTATED=1
  fi

  step=5
  tsum_mark E3.units 2>/dev/null || :
  cutover_clog "STEP $step 从候选 snapshot 装 live unit + daemon-reload"
  if [[ "$DRY" == 1 ]]; then
    cutover_clog "  [dry-run] install $unit_snap/$V5_UNIT → /etc/systemd/system/$V5_UNIT"
    cutover_clog "  [dry-run] install $unit_snap/$V5_EGRESS_UNIT → /etc/systemd/system/$V5_EGRESS_UNIT"
    if [[ -f "$unit_snap/$V5_EGRESS_SLOT_SERVICE_TPL" ]]; then
      cutover_clog "  [dry-run] install $unit_snap/{$V5_EGRESS_SLOT_SOCKET_TPL,$V5_EGRESS_SLOT_SERVICE_TPL} + sysctl tcp_migrate_req=1"
    else
      cutover_clog "  [dry-run] 候选无双槽 egress 模板 → 翻转后走 legacy 单 unit"
    fi
    cutover_clog "  [dry-run] systemctl daemon-reload"
  else
    release_policy_guard_owner || return 86
    if ! install_unit "$unit_snap/$V5_EGRESS_UNIT"; then
      cutover_compensate "install-egress-unit"
      return $?
    fi
    # 双槽模板(候选自带才装;旧候选无模板 rc=2 → 保留 installed 的旧模板文件不动,
    # egress_slot_flip 会按 live 是否自带模板决定走槽还是 legacy)。
    release_policy_guard_owner || return 86
    install_egress_slot_units_from "$unit_snap"
    case $? in
      0) cutover_clog "  ✓ 双槽 egress 模板 + sysctl 已装" ;;
      2) cutover_clog "  · 候选无双槽 egress 模板,翻转后走 legacy 单 unit" ;;
      *) cutover_compensate "install-egress-slot-units"; return $? ;;
    esac
    cutover_persist_phase_or_compensate "units-partial" "units-partial" || return $?
    release_policy_guard_owner || return 86
    if ! install_unit "$unit_snap/$V5_UNIT"; then
      cutover_compensate "install-master-unit"
      return $?
    fi
    cutover_persist_phase_or_compensate "units-installed" "units-installed" || return $?
    release_policy_guard_owner || return 86
    if ! systemctl daemon-reload; then
      cutover_compensate "daemon-reload"
      return $?
    fi
    cutover_persist_phase_or_compensate "reloaded" "reloaded" || return $?
  fi

  step=6
  cutover_clog "STEP $step 写 cutover grace 标记 $CUTOVER_GRACE_FILE (until=now+${CUTOVER_GRACE_SEC}s)"
  if [[ "$DRY" == 1 ]]; then
    cutover_clog "  [dry-run] printf until=<epoch> > $CUTOVER_GRACE_FILE"
  else
    release_policy_guard_owner || return 86
    if ! write_cutover_grace; then
      cutover_compensate "write-grace"
      return $?
    fi
    cutover_persist_phase_or_compensate "grace" "grace" || return $?
  fi

  if [[ "$CUTOVER_HAS_MIGRATION" == 1 ]]; then
    cutover_clog "STEP 6b 含 migration: 当场 apply(与下一步翻转同一把锁、同一窗口)"
    if [[ "$DRY" == 1 ]]; then
      cutover_clog "  [dry-run] 对着 $rel 跑 migration runner(失败则不翻转,不回滚 schema)"
    else
      release_policy_guard_owner || return 86
      tsum_mark E2.apply 2>/dev/null || :
      if ! run_migrations_from_release "$rel"; then
        cutover_compensate "migration-apply"
        return $?
      fi
      cutover_persist_phase_or_compensate "migrated" "migrated" || return $?
    fi
  fi

  step=7
  tsum_mark E4 2>/dev/null || :
  cutover_clog "STEP $step 原子挂 live symlink $MASTER_LIVE_LINK → $rel"
  if [[ "$DRY" == 1 ]]; then
    cutover_clog "  [dry-run] ln -s $rel ${MASTER_LIVE_LINK}.newlink.\$\$ && mv -T ${MASTER_LIVE_LINK}.newlink.\$\$ $MASTER_LIVE_LINK"
  elif release_policy_enabled && [[ "${CUTOVER_JOINT:-0}" == 1 ]]; then
    cutover_clog "  policy joint: live flip is guarded inside the real saga after prechecks"
  else
    if ! atomic_flip_live_symlink "$rel"; then
      cutover_compensate "symlink-flip"
      return $?
    fi
    cutover_persist_phase_or_compensate "symlink-flipped" "symlink-flipped" || return $?
  fi

  step=8
  if [[ "${CUTOVER_JOINT:-0}" == 1 ]]; then
    cutover_clog "STEP $step joint: oc_hotcfg_activate_saga 写四元组 + restart + smoke(transitionKind=joint masterRelease=$rel)"
    if [[ "$DRY" == 1 ]]; then
      cutover_clog "  [dry-run] activate_saga joint image=$RUNTIME_IMAGE release=$BUILT_RUNTIME_RELEASE bundle=$CUTOVER_TUPLE_BUNDLE master=$rel prev=$prev_val"
      cutover_clog "  [dry-run] smoke 含 healthz + GET / oc-build == $expected_build + egress-health"
    else
      local joint_rc=0
      activate_tuple_joint "$rel" "$prev_val" || joint_rc=$?
      if [[ "$joint_rc" != 0 ]]; then
        if release_policy_enabled; then
          case "$joint_rc" in
            86) return 86 ;;
            78|79) release_policy_keep_failed "$rel" joint-activate "$joint_rc"; return $? ;;
            1)
              if [[ "${RELEASE_POLICY_OUTCOME:-}" == COMPENSATE_USER_IMPAIRMENT || "${RELEASE_POLICY_OUTCOME:-}" == PREPARATION_ABORT ]]; then
                release_policy_finish_compensation; return $?
              fi ;;
          esac
        fi
        cutover_compensate "joint-activate"
        return $?
      fi
      if [[ -n "$CUTOVER_GATE_FAILED" ]]; then
        cutover_keep_failed "$rel"
        return 1
      fi
      cutover_persist_phase_or_compensate "restarted" "restarted" || return $?
      cutover_persist_phase_or_compensate "smoked" "smoked" || return $?
    fi
  else
    cutover_clog "STEP $step 按现有顺序重启(先 egress 槽翻转/就绪、等 ${V5_EGRESS_BIND}:${V5_EGRESS_PORT} 可连、再 master)"
    if [[ "$DRY" == 1 ]]; then
      cutover_clog "  [dry-run] $(egress_then_master_restart_cmd) (当前 egress 拓扑: $(egress_describe_topology))"
    else
      if ! eval "$(egress_then_master_restart_cmd)"; then
        cutover_compensate "restart"
        return $?
      fi
      cutover_persist_phase_or_compensate "restarted" "restarted" || return $?
    fi

    step=9
    cutover_clog "STEP $step smoke: healthz ok+controlPlaneEnabled+leader; GET / oc-build == $expected_build; egress-health"
    if [[ "$DRY" == 1 ]]; then
      cutover_clog "  [dry-run] curl 127.0.0.1:${V5_PORT}/healthz | jq ok+controlPlaneEnabled+leadership=leader"
      cutover_clog "  [dry-run] curl 127.0.0.1:${V5_PORT}/ 比对 oc-build=$expected_build"
      cutover_clog "  [dry-run] curl ${V5_EGRESS_BIND}:${V5_EGRESS_PORT}/internal/v5/egress-health"
    else
      if ! cutover_gate_against_release "$rel"; then
        cutover_compensate "smoke"
        return $?
      fi
      if [[ -n "$CUTOVER_GATE_FAILED" ]]; then
        cutover_keep_failed "$rel"
        return 1
      fi
      cutover_persist_phase_or_compensate "smoked" "smoked" || return $?
    fi
  fi

  step=10
  tsum_mark G 2>/dev/null || :
  cutover_clog "STEP $step 失败则走统一补偿(本步仅在失败路径执行)"
  if [[ "$DRY" == 1 ]]; then
    cutover_clog "  [dry-run] 覆盖 unit 前: 武装独立 systemd-run survivor + 先落盘 phase=mutated"
    cutover_clog "  [dry-run] survivor: 未 smoked/committed 的 mutation phase 在 executor 消失时即使健康绿也二级恢复"
    cutover_clog "  [dry-run] 一级: canonicalize prev + 路径在 releases 根 + 复算 digest; restart/smoke 任一失败立刻降二级"
    cutover_clog "  [dry-run] 二级: 应急脚本原子恢复备份 unit + daemon-reload + restart + 复合健康硬门"
    cutover_clog "  [dry-run] 回滚后再失败 → 写 $MASTER_RELEASES_ROOT/.manual-recovery-required 并大声退出"
    cutover_clog "  [dry-run] 门禁失败策略 OC_V5_SELFHOST_ON_GATE_FAIL=$(gate_fail_policy)(stay: restart 后门禁失败不回滚,phase=kept-failed + 维护窗口 $(stay_window_sec)s + 列车 failed + critical 告警)"
    cutover_clog "  [dry-run] 成功路径 --disarm 必须确认 durable committed marker;失败不报告 cutover 成功"
  fi

  if [[ "$DRY" == 1 ]]; then
    cutover_clog "✓ --cutover --dry-run 执行计划结束(未改 unit / 未切 symlink / 未重启 / 未迁库 / 未武装真 survivor)"
    cutover_clog "  log=$CUTOVER_LOG"
    return 0
  fi
  if release_policy_enabled; then
    local finalize_rc=0
    release_policy_finalize_forward "$rel" || finalize_rc=$?
    if [[ "$finalize_rc" != 0 ]]; then
      [[ "$finalize_rc" == 86 ]] && return 86
      release_policy_keep_failed "$rel" finalization "$finalize_rc"
      return $?
    fi
  else
  cutover_persist_phase "committed" \
    || die "无法持久化 phase=committed。smoke 已通过,拒绝报告成功(survivor 仍可能误恢复)。"
  cutover_disarm_survivor \
    || die "disarm 失败: committed marker 未确认写入。smoke 已通过,拒绝报告成功。"
  clear_stay_maintenance || cutover_clog "  ⚠ 撤销 stay 维护窗口失败(到期后看护自动忽略)"
  persist_selfhost_model_authority_cutover "$rel"
  sync_boot_scripts_from "$rel"
  sync_watch_from "$rel" \
    || cutover_clog "  ⚠ 看护同步失败(仅告警,不回滚;--smoke 会因看护漂移失败)"
  fi
  # 收尾 GC(镜像 deploy-v5.sh gc_releases/oc_hotcfg_gc 同款:仅告警,不回滚)。
  # master release:引用感知 v5-release-gc.sh,keep 3(OCV5-376:当前 + 上一个 + 一个回滚点;根盘曾 96%,
  # <8GiB 时发布拒绝构建);live/.prev-release/unit cwd/
  # 容器 baseline bind 全在保护集,校验失败 rc=75 整轮安全跳过零删除。
  # runtime tuple:oc_hotcfg_gc,history 最近 N 条 committed + env tuple + 容器 label 保护。
  bash "$SCRIPT_DIR/v5-release-gc.sh" \
    "$MASTER_RELEASES_ROOT" 3 \
    "$MASTER_LIVE_LINK" "$MASTER_LIVE_LINK" "$MASTER_LIVE_LINK" \
    "$MASTER_RELEASES_ROOT/.prev-release" \
    "$V5_UNIT" "$(egress_slot_unit A service)" "$(egress_slot_unit B service)" \
    '' '' '' 2>&1 | sed 's/^/  /' \
    || cutover_clog "  ⚠ master release GC 失败/安全跳过(仅告警,不回滚)"
  oc_hotcfg_gc "$V5_ENV" "$OC_HOTCFG_HISTORY" 2>&1 | sed 's/^/  /' \
    || cutover_clog "  ⚠ runtime GC 失败(仅告警,不回滚)"
  wo_gc_buckets "$WEB_OVERLAY_ROOT" "$MASTER_RELEASES_ROOT" 2>&1 | sed 's/^/  /' \
    || cutover_clog "  ⚠ P0-Web overlay 桶 GC 失败(仅告警,不回滚)"
  cutover_clog "✓ --cutover 完成 live → $rel"
}

case "$MODE" in
  preflight) cmd_preflight ;;
  bootstrap) cmd_bootstrap ;;
  deploy) cmd_deploy ;;
  build-master-only) cmd_build_master_only ;;
  cutover) cmd_cutover ;;
  rollback) cmd_rollback ;;
  smoke) cmd_smoke ;;
  status) cmd_status ;;
  p0-web) cmd_p0_web ;;
  p0-web-revert) cmd_p0_web_revert ;;
  p0-web-status) cmd_p0_web_status ;;
  *) die "内部错误:未知 MODE=$MODE" ;;
esac
