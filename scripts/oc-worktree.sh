#!/usr/bin/env bash
# oc-worktree — /opt/openclaude 下并行开发 worktree 的单一权威注册表 + 生命周期 CLI。
#
# 为什么存在(2026-07-18 多会话并行开发审计):
#   多个 codex/CC 会话并行开发,worktree 是"谁建的/给哪个任务/还活着吗"零记录 →
#   实际发生过:worktree 被 A 会话删除后 B 会话还在往里 apply_patch(上下文陈旧连环失败)、
#   69 个目录里 30 个是三周没人动的僵尸。注册表 = 创建即登记、合并即退役、删除前查活引用。
#
# 用法:
#   oc-worktree create <personal|v5> <slug> [--owner <who>] [--purpose <text>]
#   oc-worktree adopt  <dir> [--owner <who>] [--purpose <text>]   # 补登记已存在的目录
#   oc-worktree retire <dir>                                      # 已合并,标记退役(不删)
#   oc-worktree rm     <dir> [--force]                            # 安全删除(活引用/脏改动防线)
#   oc-worktree list                                              # 注册表 + 磁盘未登记项
#   oc-worktree audit                                             # 陈旧/已合并未退役/失踪项
#
# 设计约束:
#   - 注册表 = /opt/openclaude/worktrees-registry.json,flock 串行写,tmp+mv 原子落盘。
#   - rm 三道防线:① 任何运行进程 cwd 在目录内 → 拒;② 未 retire 且无 --force → 拒;
#     ③ 脏改动/未跟踪文件先 tar 归档到 /opt/openclaude/archive/ 再删。
#   - 分支 ref 归主仓所有,删 worktree 不删分支;分支清理按各仓 workflow skill 走。
set -euo pipefail

REG=/opt/openclaude/worktrees-registry.json
LOCK=/var/lock/oc-worktree-registry.lock
ARCH_ROOT=/opt/openclaude/archive
PERSONAL=/opt/openclaude/openclaude
V5=/opt/openclaude/openclaude-v5-aurora
V5_BASE=origin/feat/v5-aurora-rewrite

die() { echo "oc-worktree: $*" >&2; exit 1; }

# 所有注册表读写都经这个 helper(flock + python3 原子写)。
reg_py() { # reg_py <python-snippet reading REG as `reg` writing bool `changed`>
  flock -w 30 "$LOCK" python3 - "$REG" <<PY
import json, os, sys, tempfile, time
path = sys.argv[1]
try:
    reg = json.load(open(path))
except (FileNotFoundError, json.JSONDecodeError):
    reg = {"worktrees": {}}
changed = False
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
$1
if changed:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, "w") as f:
        json.dump(reg, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)
PY
}

owner_default() {
  # CC 会话有 CLAUDE_SESSION_ID;codex 无标准量 → 退回 "pid:<ppid链首进程名>"
  echo "${OPENCLAUDE_WORKTREE_OWNER:-${CLAUDE_SESSION_ID:-pid$PPID}}"
}

proc_refs() { # 打印 cwd 在 $1 内的进程 pid(空=无)
  local d="$1" p cwd
  for p in /proc/[0-9]*; do
    cwd=$(readlink "$p/cwd" 2>/dev/null) || continue
    case "$cwd" in "$d"|"$d"/*) echo "${p#/proc/}";; esac
  done
}

cmd="${1:-}"; shift || true
case "$cmd" in
create)
  repo="${1:?repo: personal|v5}"; slug="${2:?slug}"; shift 2
  owner="$(owner_default)"; purpose=""
  while [ $# -gt 0 ]; do case "$1" in
    --owner) owner="$2"; shift 2;; --purpose) purpose="$2"; shift 2;; *) die "unknown flag $1";;
  esac; done
  case "$repo" in
    personal) main="$PERSONAL"; base=origin/master; dir=/opt/openclaude/openclaude-"$slug";;
    v5)       main="$V5"; base="$V5_BASE"; dir=/opt/openclaude/openclaude-v5-"$slug";;
    *) die "repo must be personal|v5";;
  esac
  [ -e "$dir" ] && die "$dir already exists"
  branch_prefix=feat; case "$slug" in fix-*|hotfix-*) branch_prefix=fix;; esac
  case "$repo" in
    v5) branch="${OC_WORKTREE_BRANCH:-$branch_prefix/v5-$slug}";;
    *)  branch="${OC_WORKTREE_BRANCH:-$branch_prefix/$slug}";;
  esac
  git -C "$main" fetch origin -q
  git -C "$main" worktree add "$dir" -b "$branch" "$base" >/dev/null
  # 两仓都硬链 node_modules(秒级、共享磁盘);装新依赖时须在 worktree 内真 npm install
  if [ -d "$main/node_modules" ]; then
    cp -al "$main/node_modules" "$dir/node_modules" 2>/dev/null || true
  fi
  export _D="$dir" _R="$repo" _B="$branch" _O="$owner" _P="$purpose"
  reg_py 'd=os.environ["_D"]
reg["worktrees"][d] = {"repo": os.environ["_R"], "branch": os.environ["_B"],
  "owner": os.environ["_O"], "purpose": os.environ["_P"],
  "status": "active", "created": now, "updated": now}
changed = True'
  echo "created $dir (branch=$branch, owner=$owner)"
  ;;
adopt)
  dir="$(realpath -m "${1:?dir}")"; shift
  owner="$(owner_default)"; purpose=""
  while [ $# -gt 0 ]; do case "$1" in
    --owner) owner="$2"; shift 2;; --purpose) purpose="$2"; shift 2;; *) die "unknown flag $1";;
  esac; done
  [ -e "$dir/.git" ] || die "$dir is not a git worktree/clone"
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
  repo=personal; case "$dir" in */openclaude-v5-*) repo=v5;; esac
  export _D="$dir" _R="$repo" _B="$branch" _O="$owner" _P="$purpose"
  reg_py 'd=os.environ["_D"]
e = reg["worktrees"].get(d, {})
e.update({"repo": os.environ["_R"], "branch": os.environ["_B"],
  "owner": e.get("owner") or os.environ["_O"],
  "purpose": e.get("purpose") or os.environ["_P"],
  "status": e.get("status", "active"), "updated": now})
e.setdefault("created", now)
reg["worktrees"][d] = e
changed = True'
  echo "adopted $dir (branch=$branch)"
  ;;
retire)
  dir="$(realpath -m "${1:?dir}")"
  export _D="$dir"
  reg_py 'd=os.environ["_D"]
e = reg["worktrees"].get(d)
if e is None:
    sys.exit(f"not registered: {d} (先 oc-worktree adopt)")
e["status"] = "retired"; e["updated"] = now
changed = True'
  echo "retired $dir(目录保留,删除用 oc-worktree rm)"
  ;;
rm)
  dir="$(realpath -m "${1:?dir}")"; shift
  force=0; [ "${1:-}" = --force ] && force=1
  [ -d "$dir" ] || die "$dir not found"
  case "$dir" in
    "$PERSONAL"|"$V5"|/opt/openclaude/openclaude-v3) die "refusing to remove canonical checkout";;
    /opt/openclaude/openclaude-*) ;;
    *) die "refusing: $dir is outside /opt/openclaude/openclaude-*";;
  esac
  refs="$(proc_refs "$dir" | head -5 || true)"
  [ -n "$refs" ] && die "活跃进程 cwd 在目录内(pid: $(echo $refs | tr '\n' ' ')),先结束会话或等待"
  st="$(python3 -c "
import json,sys
try: reg=json.load(open('$REG'))
except Exception: reg={'worktrees':{}}
print(reg['worktrees'].get('$dir',{}).get('status','UNREGISTERED'))")"
  if [ "$st" != retired ] && [ "$force" != 1 ]; then
    die "status=$st(未退役);确认已合并后先 oc-worktree retire,或 --force"
  fi
  if [ -e "$dir/.git" ]; then
    dirty=$(git -C "$dir" status --porcelain 2>/dev/null | awk '{print $NF}' | grep -v node_modules | head -200 || true)
    if [ -n "$dirty" ]; then
      mkdir -p "$ARCH_ROOT"
      tarball="$ARCH_ROOT/$(basename "$dir")-dirty-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
      (cd "$dir" && echo "$dirty" | tar czf "$tarball" --ignore-failed-read -T - 2>/dev/null) \
        && echo "dirty 改动已归档: $tarball"
    fi
  fi
  rm -rf "$dir"
  git -C "$PERSONAL" worktree prune 2>/dev/null || true
  git -C "$V5" worktree prune 2>/dev/null || true
  export _D="$dir"
  reg_py 'd=os.environ["_D"]
if d in reg["worktrees"]:
    reg["worktrees"][d]["status"] = "removed"; reg["worktrees"][d]["updated"] = now
    changed = True'
  echo "removed $dir(分支 ref 仍在主仓,按 workflow skill 清理)"
  ;;
list|audit)
  mode="$cmd" python3 - "$REG" <<'PY'
import json, os, subprocess, sys, time, glob
path, mode = sys.argv[1], os.environ["mode"]
try:
    reg = json.load(open(path)).get("worktrees", {})
except Exception:
    reg = {}
def sh(*a, cwd=None):
    try:
        return subprocess.run(a, capture_output=True, text=True, cwd=cwd, timeout=20).stdout.strip()
    except Exception:
        return ""
on_disk = {d for d in glob.glob("/opt/openclaude/openclaude-*") if os.path.isdir(d)}
CANON = {"/opt/openclaude/openclaude-v5-aurora", "/opt/openclaude/openclaude-v3"}
rows, problems = [], []
now = time.time()
for d in sorted(on_disk - CANON):
    e = reg.get(d)
    if not os.path.exists(os.path.join(d, ".git")):
        rows.append((d, "-", "-", "NON-GIT", "-")); continue
    br = sh("git", "-C", d, "rev-parse", "--abbrev-ref", "HEAD") or "?"
    last = sh("git", "-C", d, "log", "-1", "--format=%cs")
    st = e["status"] if e else "UNREGISTERED"
    owner = (e or {}).get("owner", "-")
    rows.append((d, br, last, st, owner))
    if mode == "audit":
        if not e:
            problems.append(f"未登记: {d}(oc-worktree adopt 补登记)")
        try:
            age_d = (now - os.path.getmtime(os.path.join(d, ".git"))) / 86400
        except OSError:
            age_d = 0
        ts = sh("git", "-C", d, "log", "-1", "--format=%ct")
        commit_age = (now - int(ts)) / 86400 if ts.isdigit() else 999
        if st == "active" and commit_age > 14:
            problems.append(f"陈旧(>14d 无提交): {d} branch={br} last={last}")
        base = "origin/feat/v5-aurora-rewrite" if "/openclaude-v5-" in d else "origin/master"
        merged = subprocess.run(["git", "-C", d, "merge-base", "--is-ancestor", "HEAD", base],
                                capture_output=True).returncode == 0
        # merged 只是"HEAD 无独有提交"——刚建的/在用的目录也满足。只有同时
        # 干净+无进程引用+提交超 2 天,才能当"该退役"讲,否则是误报。
        dirty_n = len([l for l in sh("git", "-C", d, "status", "--porcelain").splitlines()
                       if "node_modules" not in l])
        def _cwd(p):
            try:
                return os.readlink(f"/proc/{p}/cwd")
            except OSError:
                return ""
        in_use = any(_cwd(p).startswith(d) for p in os.listdir("/proc") if p.isdigit())
        if st == "active" and merged and dirty_n == 0 and not in_use and commit_age > 2:
            problems.append(f"已合并未退役: {d} branch={br}(oc-worktree retire)")
for d, e in sorted(reg.items()):
    if e.get("status") in ("active", "retired") and d not in on_disk:
        problems.append(f"注册表有但磁盘失踪: {d}(status={e['status']})")
w = max((len(r[0]) for r in rows), default=10) + 1
print(f"{'DIR':<{w}}{'BRANCH':<42}{'LAST':<12}{'STATUS':<14}OWNER")
for r in rows:
    print(f"{r[0]:<{w}}{r[1]:<42}{r[2]:<12}{r[3]:<14}{r[4]}")
if mode == "audit":
    print("\n== 待处理 ==" if problems else "\n== audit 无问题 ==")
    for p in problems:
        print(" -", p)
PY
  ;;
*)
  sed -n '3,20p' "$0"; exit 1;;
esac
