#!/usr/bin/env bash
# 本地干跑演练:build_platform_bundle + digest 幂等/确定性 + selfcheck 拒绝 + GC 保护集 + saga 回滚。
set -Eeuo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/v5-runtime-release-lib.sh"
WORK="$(mktemp -d /tmp/hotcfg-drill.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
chk()  { if eval "$2"; then ok "$1"; else bad "$1 [cond: $2]"; fi; }

export OC_HOTCFG_PLATFORM_ROOT="$WORK/platform"
export OC_HOTCFG_RELEASES_ROOT="$WORK/releases"
export OC_HOTCFG_ENV_FILE="$WORK/commercial-v5.env"
export OC_HOTCFG_HISTORY="$WORK/runtime-tuple.history"
# docker stub:默认无 v5 容器
export OC_DOCKER_BIN="$WORK/bin/docker"
mkdir -p "$WORK/bin" "$OC_HOTCFG_PLATFORM_ROOT/bundles" "$OC_HOTCFG_RELEASES_ROOT"
cat > "$OC_DOCKER_BIN" <<'DOCK'
#!/usr/bin/env bash
# 可切换的 docker stub:DOCKER_STUB_CIDS/ DOCKER_STUB_REL_<cid>/ DOCKER_STUB_BUN_<cid> / DOCKER_STUB_FAIL
[ -n "${DOCKER_STUB_FAIL:-}" ] && { echo "docker down" >&2; exit 1; }
case "$1" in
  ps) echo "${DOCKER_STUB_CIDS:-}" ;;
  inspect)
    fmt="$3"; cid="$4"
    case "$fmt" in
      *runtime.release*) eval "echo \"\${DOCKER_STUB_REL_${cid}:-}\"" ;;
      *runtime.bundle_rev*) eval "echo \"\${DOCKER_STUB_BUN_${cid}:-}\"" ;;
      *) echo "" ;;
    esac ;;
  *) echo "" ;;
esac
DOCK
chmod +x "$OC_DOCKER_BIN"

# shellcheck source=/dev/null
source "$LIB"

# 初始 env(含旧 tuple 供 saga 快照/回滚)
cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_CHANNEL=v5
OC_RUNTIME_IMAGE=openclaude/openclaude-runtime:OLD
OC_RUNTIME_IMAGE_ID=sha256:oldid
OC_RUNTIME_RELEASE=$OC_HOTCFG_RELEASES_ROOT/rel-oldrelease0
OC_PLATFORM_BUNDLE=$OC_HOTCFG_PLATFORM_ROOT/bundles/oldbundle0000
COMMERCIAL_AUTO_MIGRATE=0
EOF
chmod 600 "$OC_HOTCFG_ENV_FILE"

# ── 组装假 platform-runtime staging ──
mk_staging() {   # $1=dest  $2=extra_marker(用于制造不同内容)
  local d="$1"; rm -rf "$d"; mkdir -p "$d"/{bin,entrypoint,seed/skills/scientist,prompts,etc-codex,codex-skills}
  printf '#!/usr/bin/env bash\necho oc-web %s\n' "${2:-}" > "$d/bin/oc-web.sh"
  printf 'print("figcheck")\n' > "$d/bin/oc-figcheck.py"
  printf '// entrypoint %s\nconsole.log("boot")\n' "${2:-}" > "$d/entrypoint/entrypoint.ts"
  printf 'persona: main\n' > "$d/seed/skills/scientist/seed.yaml"
  printf '# Platform capabilities\ncapabilities text %s\n' "${2:-}" > "$d/prompts/platform-capabilities.md"
  printf 'model_reasoning_effort = "high"\n' > "$d/etc-codex/config.toml"
  printf '# skill\n' > "$d/codex-skills/base.md"
}

echo "== T1 build_platform_bundle + MANIFEST + digest 定名 =="
mk_staging "$OC_HOTCFG_PLATFORM_ROOT/bundles/.staging-a" A
REV1="$(oc_hotcfg_finalize_bundle "$OC_HOTCFG_PLATFORM_ROOT/bundles/.staging-a" 1 deadbeef)"
chk "digest 为 12 hex" "[[ '$REV1' =~ ^[0-9a-f]{12}$ ]]"
chk "bundle 目录按 digest 落定" "[ -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1' ]"
chk "MANIFEST.json 存在" "[ -f '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1/MANIFEST.json' ]"
chk "MANIFEST.digest == 目录名" "[ \"\$(jq -r .digest '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1/MANIFEST.json')\" = '$REV1' ]"
chk "MANIFEST.files 不含自身" "[ \"\$(jq -r '[.files[].path]|index(\"MANIFEST.json\")//\"nil\"' '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1/MANIFEST.json')\" = nil ]"
chk "bootHash 非空且 12hex" "[[ \"\$(jq -r .bootHash '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1/MANIFEST.json')\" =~ ^[0-9a-f]{12}$ ]]"
chk "bin/oc-web 剥扩展名且 0755" "[ \"\$(stat -c %a '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1/bin/oc-web')\" = 755 ]"
chk "bin/oc-figcheck 剥扩展名(.py)" "[ -f '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1/bin/oc-figcheck' ]"
chk "bin/ 无带扩展名残留" "[ -z \"\$(find '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1/bin' -name '*.sh' -o -name '*.py')\" ]"
chk "prompts md 落为 0644" "[ \"\$(stat -c %a '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1/prompts/platform-capabilities.md')\" = 644 ]"

echo "== T2 digest 幂等(同内容→同 rev,复用不覆盖)=="
mk_staging "$OC_HOTCFG_PLATFORM_ROOT/bundles/.staging-a2" A
# 制造不同 mtime,验证 digest 忽略 mtime
touch -d '2020-01-01' "$OC_HOTCFG_PLATFORM_ROOT/bundles/.staging-a2/bin/oc-web.sh"
REV1b="$(oc_hotcfg_finalize_bundle "$OC_HOTCFG_PLATFORM_ROOT/bundles/.staging-a2" 1 deadbeef)"
chk "同内容 → 同 digest(忽略 mtime)" "[ '$REV1b' = '$REV1' ]"
chk "复用后 staging 已清除" "[ ! -e '$OC_HOTCFG_PLATFORM_ROOT/bundles/.staging-a2' ]"

echo "== T3 内容变化 → 不同 rev =="
mk_staging "$OC_HOTCFG_PLATFORM_ROOT/bundles/.staging-b" B
REV2="$(oc_hotcfg_finalize_bundle "$OC_HOTCFG_PLATFORM_ROOT/bundles/.staging-b" 1 deadbeef)"
chk "内容不同 → digest 不同" "[ '$REV2' != '$REV1' ]"
chk "两个 bundle 目录并存" "[ -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1' ] && [ -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV2' ]"

echo "== T4 selfcheck 拒绝(非白名单顶层目录 / 敏感文件 / 坏扩展名 / bin 带扩展名)=="
# selfcheck 直调走"已剥名"形态(finalize 之后的树才是 selfcheck 的常态输入);
# 用 mk_checked 保证拒因恰是各用例注入的那条规则,不被 bin/*.sh 的剥名规则遮蔽。
mk_checked() { mk_staging "$1" "$2"; local f; for f in "$1"/bin/*.sh "$1"/bin/*.py; do [ -e "$f" ] && mv "$f" "${f%.*}"; done; return 0; }
mk_checked "$WORK/bad1" A; mkdir -p "$WORK/bad1/secret_stuff"; echo x > "$WORK/bad1/secret_stuff/a.sh"
chk "顶层非白名单目录被拒" "! oc_hotcfg_selfcheck_bundle '$WORK/bad1' 2>/dev/null"
mk_checked "$WORK/bad2" A; echo 'AKIA...' > "$WORK/bad2/bin/leaked.pem"
chk "敏感 *.pem 被拒" "! oc_hotcfg_selfcheck_bundle '$WORK/bad2' 2>/dev/null"
mk_checked "$WORK/bad3" A; echo x > "$WORK/bad3/seed/tool.exe"
chk "坏扩展名 .exe 被拒(非 bin 目录)" "! oc_hotcfg_selfcheck_bundle '$WORK/bad3' 2>/dev/null"
mk_checked "$WORK/bad5" A; echo x > "$WORK/bad5/bin/oc-left.sh"
chk "bin/ 带扩展名被拒(剥名失败形态)" "! oc_hotcfg_selfcheck_bundle '$WORK/bad5' 2>/dev/null"
mk_staging "$WORK/bad4" A  # 缺 prompts → finalize 应 fail-loud
rm -rf "$WORK/bad4/prompts"
chk "缺 prompts/ finalize fail-loud" "! oc_hotcfg_finalize_bundle '$WORK/bad4' 1 deadbeef 2>/dev/null"

echo "== T5 current 原子翻转(相对 symlink)=="
oc_hotcfg_flip_current "$REV1"
chk "current 为 symlink" "[ -L '$OC_HOTCFG_PLATFORM_ROOT/current' ]"
chk "current 相对指向 bundles/$REV1" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV1' ]"
oc_hotcfg_flip_current "$REV2"
chk "翻转到 REV2" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV2' ]"

echo "== T6 history append + checksum 校验 =="
oc_hotcfg_history_append "$OC_HOTCFG_HISTORY" img:1 sha256:id1 "$OC_HOTCFG_RELEASES_ROOT/rel-r1" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1"
oc_hotcfg_history_append "$OC_HOTCFG_HISTORY" img:2 sha256:id2 "$OC_HOTCFG_RELEASES_ROOT/rel-r2" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV2"
chk "history 有 2 行" "[ \"\$(wc -l < '$OC_HOTCFG_HISTORY')\" = 2 ]"
LAST="$(oc_hotcfg_history_last_committed "$OC_HOTCFG_HISTORY")"
chk "last committed seq=2" "[ \"\$(jq -r .seq <<<'$LAST')\" = 2 ]"
# 篡改末行 → last_committed 应回退到 seq=1
printf '{\"schemaVer\":1,\"seq\":3,\"ts\":\"x\",\"image\":\"tampered\",\"image_id\":\"z\",\"release\":\"r\",\"bundle\":\"b\",\"checksum\":\"deadbeef\"}\n' >> "$OC_HOTCFG_HISTORY"
LAST2="$(oc_hotcfg_history_last_committed "$OC_HOTCFG_HISTORY")"
chk "篡改行被 checksum 拒,回退 seq=2" "[ \"\$(jq -r .seq <<<'$LAST2')\" = 2 ]"
# 复位 history(去掉篡改行)供 GC 测试
head -n 2 "$OC_HOTCFG_HISTORY" > "$OC_HOTCFG_HISTORY.clean" && mv "$OC_HOTCFG_HISTORY.clean" "$OC_HOTCFG_HISTORY"

echo "== T7 GC 保护集(docker 容器 label 引用 + env tuple + history + emergency)=="
# 造若干 release/bundle 目录
mkdir -p "$OC_HOTCFG_RELEASES_ROOT"/rel-{r1,r2,r3,orphan} "$OC_HOTCFG_PLATFORM_ROOT/bundles/keepme000000" "$OC_HOTCFG_PLATFORM_ROOT/bundles/trueorphan00"
# env 当前 tuple 指 rel-r2 + REV2;emergency 指 rel-r1;history 指 rel-r1/rel-r2
sed -i "s|^OC_RUNTIME_RELEASE=.*|OC_RUNTIME_RELEASE=$OC_HOTCFG_RELEASES_ROOT/rel-r2|" "$OC_HOTCFG_ENV_FILE"
sed -i "s|^OC_PLATFORM_BUNDLE=.*|OC_PLATFORM_BUNDLE=$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV2|" "$OC_HOTCFG_ENV_FILE"
oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" >/dev/null  # 先占位(会写当前 tuple);再改成指 rel-r1
# 把 emergency tuple 改成引用 rel-r1 + keepme000000(用 jq 组值 + sed 换行,无 python 依赖)
EMERG_VAL="$(jq -cn --arg r "$OC_HOTCFG_RELEASES_ROOT/rel-r1" --arg b "$OC_HOTCFG_PLATFORM_ROOT/bundles/keepme000000" \
  '{image:"e",image_id:"e",release:$r,bundle:$b}')"
sed -i "s|^OC_RUNTIME_EMERGENCY_TUPLE=.*|OC_RUNTIME_EMERGENCY_TUPLE=$EMERG_VAL|" "$OC_HOTCFG_ENV_FILE"
# docker stub:一个 v5 容器引用 rel-r3 + keepme000000 bundle
export DOCKER_STUB_CIDS="cabc"
export DOCKER_STUB_REL_cabc="$OC_HOTCFG_RELEASES_ROOT/rel-r3"
export DOCKER_STUB_BUN_cabc="keepme000000"
oc_hotcfg_gc "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_HISTORY" 2>"$WORK/gc.log" || true
cat "$WORK/gc.log" | sed 's/^/    gc> /'
chk "rel-r1 (emergency+history) 保留" "[ -d '$OC_HOTCFG_RELEASES_ROOT/rel-r1' ]"
chk "rel-r2 (env+history) 保留" "[ -d '$OC_HOTCFG_RELEASES_ROOT/rel-r2' ]"
chk "rel-r3 (docker 容器) 保留" "[ -d '$OC_HOTCFG_RELEASES_ROOT/rel-r3' ]"
chk "rel-orphan 被回收" "[ ! -d '$OC_HOTCFG_RELEASES_ROOT/rel-orphan' ]"
chk "bundle keepme000000 (docker+emergency) 保留" "[ -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/keepme000000' ]"
chk "bundle REV1 (history seq1 引用) 保留" "[ -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1' ]"
chk "bundle trueorphan00 (无引用) 被回收" "[ ! -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/trueorphan00' ]"
chk "bundle REV2 (env current) 保留" "[ -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV2' ]"

echo "== T7b GC docker 失败 → 放弃回收(不误删)=="
mkdir -p "$OC_HOTCFG_RELEASES_ROOT/rel-shouldstay"
DOCKER_STUB_FAIL=1 oc_hotcfg_gc "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_HISTORY" 2>"$WORK/gc2.log" || true
grep -q '放弃 GC' "$WORK/gc2.log" && ok "docker 失败告警放弃 GC" || bad "docker 失败未放弃"
chk "docker 失败时孤儿未被删" "[ -d '$OC_HOTCFG_RELEASES_ROOT/rel-shouldstay' ]"

echo "== T8 saga 成功路径(全钩子 true)=="
# 重置 env tuple 为已知旧值
cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
OC_RUNTIME_RELEASE=/rel/OLD
OC_PLATFORM_BUNDLE=/bun/OLD
EOF
: > "$OC_HOTCFG_HISTORY"
oc_hotcfg_flip_current "$REV2"     # 旧 current=REV2
NEWHIST="$OC_HOTCFG_HISTORY"
if oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$NEWHIST" \
     img:NEW sha256:NEW /rel/NEW "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "true" "true"; then ok "saga 成功返回 0"; else bad "saga 应成功"; fi
chk "env OC_RUNTIME_IMAGE 更新为 NEW" "[ \"\$(grep ^OC_RUNTIME_IMAGE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = 'img:NEW' ]"
chk "env OC_RUNTIME_RELEASE 更新为 NEW" "[ \"\$(grep ^OC_RUNTIME_RELEASE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = '/rel/NEW' ]"
chk "current 翻到 REV1" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV1' ]"
chk "history 记录 committed 1 条" "[ \"\$(grep -c . '$NEWHIST')\" = 1 ]"

echo "== T9 saga 回滚(smoke 失败第 6 步)→ env/current 全复原 =="
cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
OC_RUNTIME_RELEASE=/rel/OLD
OC_PLATFORM_BUNDLE=/bun/OLD
EOF
: > "$OC_HOTCFG_HISTORY"
oc_hotcfg_flip_current "$REV2"   # 旧 current=REV2
RESTART_LOG="$WORK/restart.log"; : > "$RESTART_LOG"
if oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$OC_HOTCFG_HISTORY" \
     img:NEW sha256:NEW /rel/NEW "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "echo restart >>$RESTART_LOG" "false"; then
  bad "saga 应因 smoke 失败返回非 0"
else ok "saga 因 smoke 失败返回非 0"; fi
chk "env OC_RUNTIME_IMAGE 复原为 OLD" "[ \"\$(grep ^OC_RUNTIME_IMAGE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = 'img:OLD' ]"
chk "env OC_RUNTIME_RELEASE 复原为 OLD" "[ \"\$(grep ^OC_RUNTIME_RELEASE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = '/rel/OLD' ]"
chk "current 复原到 REV2" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV2' ]"
chk "history 未提交(空文件)" "[ ! -s '$OC_HOTCFG_HISTORY' ]"
chk "回滚后 restart 被调用 2 次(新+旧)" "[ \"\$(grep -c restart '$RESTART_LOG')\" = 2 ]"

echo "== T10 saga 回滚(第 3 步 extra_apply 失败)=="
cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
OC_RUNTIME_RELEASE=/rel/OLD
OC_PLATFORM_BUNDLE=/bun/OLD
EOF
oc_hotcfg_flip_current "$REV2"
if oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$OC_HOTCFG_HISTORY" \
     img:NEW sha256:NEW /rel/NEW "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "true" "true" "false" "echo revert"; then
  bad "extra_apply 失败应返回非 0"
else ok "extra_apply 失败返回非 0"; fi
chk "env 未被改(仍 OLD)" "[ \"\$(grep ^OC_RUNTIME_IMAGE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = 'img:OLD' ]"
chk "current 未被改(仍 REV2)" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV2' ]"

echo ""
echo "════════ 结果:PASS=$PASS FAIL=$FAIL ════════"
[ "$FAIL" = 0 ]
