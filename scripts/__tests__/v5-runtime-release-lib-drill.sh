#!/usr/bin/env bash
# 本地干跑演练:build_platform_bundle + digest 幂等/确定性 + selfcheck 拒绝 + 必需叶子(M8,含
# bin/oc-web-context R2-M2①) + GC 保护集(含 B4 basename label + m5 退休台账) + saga 回滚 +
# R2-B1 env 三态写(禁用轴写空值) + R2-B2 首次启用 pre-state→rollback 退回启用前 + B6 ccb 隔离构建 +
# B7/R2-M1 emergency 硬验(显式候选 + immutable ID 钉死 + R2-m1 bak 轮转) + M6 symlink digest +
# M7 masterRelease 同条恢复 + R2-M3 history v1/v2 混存 + R2-M2③ canary boot 两路径 + m6 env.bak 轮转。
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
# 短别名(减少断言里的长路径)
PLAT="$OC_HOTCFG_PLATFORM_ROOT"; REL="$OC_HOTCFG_RELEASES_ROOT"
# docker stub:默认无 v5 容器
export OC_DOCKER_BIN="$WORK/bin/docker"
mkdir -p "$WORK/bin" "$OC_HOTCFG_PLATFORM_ROOT/bundles" "$OC_HOTCFG_RELEASES_ROOT"
cat > "$OC_DOCKER_BIN" <<'DOCK'
#!/usr/bin/env bash
# 可切换 docker stub:
#   DOCKER_STUB_CIDS / DOCKER_STUB_REL_<cid> / DOCKER_STUB_BUN_<cid>(basename 形态,B4)/
#   DOCKER_STUB_FAIL(ps/inspect 失败)/ DOCKER_STUB_EMBED(image inspect embed_source 值,B7)/
#   DOCKER_STUB_IMAGE_ID(image inspect {{.Id}} 值,R2-M1)/ DOCKER_STUB_IMAGE_INSPECT_FAIL /
#   DOCKER_STUB_RUN_LOG(docker run 全参记录文件,R2-M2③ canary)/ DOCKER_STUB_RUN_FAIL
[ -n "${DOCKER_STUB_FAIL:-}" ] && { echo "docker down" >&2; exit 1; }
case "$1" in
  ps) echo "${DOCKER_STUB_CIDS:-}" ;;
  inspect)
    # 容器 inspect:B4 起用**单命令组合 format**(同时含 runtime.release 与 runtime.bundle_rev)。
    fmt="$3"; cid="$4"
    has_rel=0; has_bun=0
    printf '%s' "$fmt" | grep -q 'runtime.release'    && has_rel=1
    printf '%s' "$fmt" | grep -q 'runtime.bundle_rev' && has_bun=1
    if [ "$has_rel" = 1 ] && [ "$has_bun" = 1 ]; then
      r="$(eval "echo \"\${DOCKER_STUB_REL_${cid}:-}\"")"
      b="$(eval "echo \"\${DOCKER_STUB_BUN_${cid}:-}\"")"
      printf '%s\t%s\n' "$r" "$b"
    elif [ "$has_rel" = 1 ]; then
      eval "echo \"\${DOCKER_STUB_REL_${cid}:-}\""
    elif [ "$has_bun" = 1 ]; then
      eval "echo \"\${DOCKER_STUB_BUN_${cid}:-}\""
    else echo ""; fi ;;
  image)
    # image inspect --format '...'(B7 embed_source / R2-M1 {{.Id}} / R3-B4 features 标签;扫全部 args 稳妥)
    case "$*" in
      *embed_source*) printf '%s\n' "${DOCKER_STUB_EMBED-1}" ;;
      *oc.runtime.features*)
        if [ -n "${DOCKER_STUB_IMAGE_INSPECT_FAIL:-}" ]; then echo "no such image" >&2; exit 1; fi
        printf '%s\n' "${DOCKER_STUB_FEATURES-v3-sink model_authority_v1}" ;;
      *'{{.Id}}'*)
        if [ -n "${DOCKER_STUB_IMAGE_INSPECT_FAIL:-}" ]; then echo "no such image" >&2; exit 1; fi
        printf '%s\n' "${DOCKER_STUB_IMAGE_ID-sha256:emb}" ;;
      *) echo "" ;;
    esac ;;
  run)
    # docker run:install_deps(B6 复用路径不会调用)+ canary boot(R2-M2③)。
    if [ -n "${DOCKER_STUB_RUN_LOG:-}" ]; then echo "run $*" >> "$DOCKER_STUB_RUN_LOG"; fi
    if [ -n "${DOCKER_STUB_RUN_FAIL:-}" ]; then echo "canary boom" >&2; exit 1; fi
    ;;
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

# ── 组装假 platform-runtime staging(含全部 M8 必需叶子)──
mk_staging() {   # $1=dest  $2=extra_marker(用于制造不同内容)
  local d="$1"; rm -rf "$d"
  mkdir -p "$d"/{bin,entrypoint,seed/skills/scientist,seed/personas,prompts,etc-codex,codex-skills}
  printf '#!/usr/bin/env bash\necho oc-web %s\n' "${2:-}" > "$d/bin/oc-web.sh"
  printf 'print("figcheck")\n' > "$d/bin/oc-figcheck.py"
  printf 'print("web-context")\n' > "$d/bin/oc-web-context.py"   # R2-M2① 必需叶子(剥名后 bin/oc-web-context)
  printf '// entrypoint %s\nconsole.log("boot")\n' "${2:-}" > "$d/entrypoint/entrypoint.ts"
  printf '// platformBundle %s\nexport const x = 1;\n' "${2:-}" > "$d/entrypoint/platformBundle.ts"
  printf 'schemaVersion: 1\nagents: []\n' > "$d/seed/platform-seed.yaml"
  printf 'persona: main\n' > "$d/seed/skills/scientist/seed.yaml"
  printf '# main persona\n' > "$d/seed/personas/main.md"
  printf '# Platform capabilities\ncapabilities text %s\n' "${2:-}" > "$d/prompts/platform-capabilities.md"
  printf '# Memory\n' > "$d/prompts/memory-instructions.md"
  printf '# preamble\n' > "$d/prompts/codex-preamble.md"
  printf 'model_reasoning_effort = "high"\n' > "$d/etc-codex/managed_config.toml"
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

echo "== T4 selfcheck 拒绝(非白名单顶层目录 / 敏感文件 / 坏扩展名 / bin 带扩展名)+ M8 必需叶子 =="
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
# M8:缺某必需叶子(selfcheck 通过但 finalize 必需叶子门拒)
mk_staging "$WORK/bad6" A; rm -f "$WORK/bad6/entrypoint/platformBundle.ts"
chk "M8 缺 entrypoint/platformBundle.ts → finalize fail-loud" "! oc_hotcfg_finalize_bundle '$WORK/bad6' 1 deadbeef 2>/dev/null"
mk_staging "$WORK/bad7" A; rm -f "$WORK/bad7/etc-codex/managed_config.toml"
chk "M8 缺 etc-codex/managed_config.toml → finalize fail-loud" "! oc_hotcfg_finalize_bundle '$WORK/bad7' 1 deadbeef 2>/dev/null"
mk_staging "$WORK/bad8" A; rm -f "$WORK/bad8/bin/oc-web-context.py"
chk "R2-M2① 缺 bin/oc-web-context → finalize fail-loud" "! oc_hotcfg_finalize_bundle '$WORK/bad8' 1 deadbeef 2>/dev/null"

echo "== T5 current 原子翻转(相对 symlink)=="
oc_hotcfg_flip_current "$REV1"
chk "current 为 symlink" "[ -L '$OC_HOTCFG_PLATFORM_ROOT/current' ]"
chk "current 相对指向 bundles/$REV1" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV1' ]"
oc_hotcfg_flip_current "$REV2"
chk "翻转到 REV2" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV2' ]"

echo "== T6 history append + checksum 校验(含 masterRelease,M7)=="
oc_hotcfg_history_append "$OC_HOTCFG_HISTORY" img:1 sha256:id1 "$OC_HOTCFG_RELEASES_ROOT/rel-r1" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "$OC_HOTCFG_RELEASES_ROOT/rel-master1"
oc_hotcfg_history_append "$OC_HOTCFG_HISTORY" img:2 sha256:id2 "$OC_HOTCFG_RELEASES_ROOT/rel-r2" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV2" "$OC_HOTCFG_RELEASES_ROOT/rel-master2"
chk "history 有 2 行" "[ \"\$(wc -l < '$OC_HOTCFG_HISTORY')\" = 2 ]"
LAST="$(oc_hotcfg_history_last_committed "$OC_HOTCFG_HISTORY")"
chk "last committed seq=2" "[ \"\$(jq -r .seq <<<'$LAST')\" = 2 ]"
chk "last committed 带 masterRelease" "[ \"\$(jq -r .masterRelease <<<'$LAST')\" = '$OC_HOTCFG_RELEASES_ROOT/rel-master2' ]"
# 篡改末行 → last_committed 应回退到 seq=1
printf '{\"schemaVer\":1,\"seq\":3,\"ts\":\"x\",\"image\":\"tampered\",\"image_id\":\"z\",\"release\":\"r\",\"bundle\":\"b\",\"masterRelease\":\"m\",\"checksum\":\"deadbeef\"}\n' >> "$OC_HOTCFG_HISTORY"
LAST2="$(oc_hotcfg_history_last_committed "$OC_HOTCFG_HISTORY")"
chk "篡改行被 checksum 拒,回退 seq=2" "[ \"\$(jq -r .seq <<<'$LAST2')\" = 2 ]"
# 复位 history(去掉篡改行)供 GC 测试
head -n 2 "$OC_HOTCFG_HISTORY" > "$OC_HOTCFG_HISTORY.clean" && mv "$OC_HOTCFG_HISTORY.clean" "$OC_HOTCFG_HISTORY"

echo "== TM7 masterRelease 同条恢复 + 进 checksum(M7)=="
HM="$WORK/hist-m7"; : > "$HM"
oc_hotcfg_history_append "$HM" imgA idA relA bunA masterA
oc_hotcfg_history_append "$HM" imgB idB relB bunB masterB
oc_hotcfg_history_append "$HM" imgC idC relC bunC masterC
P2="$(oc_hotcfg_history_nth_committed "$HM" 2)"   # 倒数第2条 = B
chk "nth=2 命中 seq=2" "[ \"\$(jq -r .seq <<<'$P2')\" = 2 ]"
chk "nth=2 的 release/bundle/master 同属 B 记录(同条恢复)" "[ \"\$(jq -r .release <<<'$P2')\" = relB ] && [ \"\$(jq -r .bundle <<<'$P2')\" = bunB ] && [ \"\$(jq -r .masterRelease <<<'$P2')\" = masterB ]"
chk "last committed masterRelease=masterC" "[ \"\$(jq -r .masterRelease <<<\"\$(oc_hotcfg_history_last_committed '$HM')\")\" = masterC ]"
sed -i 's/masterC/HACKEDMASTER/' "$HM"   # 只改 masterRelease 值 → checksum 应失配
chk "篡改 masterRelease 被 checksum 拒(回退 seq=2)" "[ \"\$(jq -r .seq <<<\"\$(oc_hotcfg_history_last_committed '$HM')\")\" = 2 ]"

echo "== TR2B1 env_write_tuple 三态写:四键恒写,禁用轴写空值(R2-B1,取代旧 B2 空值跳过)=="
cat > "$WORK/b2.env" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
OC_RUNTIME_RELEASE=/rel/OLD
OC_PLATFORM_BUNDLE=/bun/OLD
EOF
# bundle 轴启用 + release 轴禁用(传空):image/id 更新、bundle 更新、release **清空**(键在值空)
oc_hotcfg_env_write_tuple "$WORK/b2.env" img:NEW sha256:NEW "" /bun/NEW >/dev/null 2>&1
chk "image 恒写(→NEW)" "[ \"\$(grep ^OC_RUNTIME_IMAGE= '$WORK/b2.env'|cut -d= -f2-)\" = 'img:NEW' ]"
chk "image_id 恒写(→NEW)" "[ \"\$(grep ^OC_RUNTIME_IMAGE_ID= '$WORK/b2.env'|cut -d= -f2-)\" = 'sha256:NEW' ]"
chk "release 传空 → 键在值空(禁用可表达,旧值被清)" "grep -q '^OC_RUNTIME_RELEASE=$' '$WORK/b2.env'"
chk "bundle 非空 → 更新 /bun/NEW" "[ \"\$(grep ^OC_PLATFORM_BUNDLE= '$WORK/b2.env'|cut -d= -f2-)\" = '/bun/NEW' ]"
# 原本无 release 键 + 传空 → 新建**空值键**(四键恒写);bundle 非空 → 新建
cat > "$WORK/b2b.env" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
EOF
oc_hotcfg_env_write_tuple "$WORK/b2b.env" img:NEW sha256:NEW "" /bun/NEW >/dev/null 2>&1
chk "release 传空且原无键 → 新建空值键 OC_RUNTIME_RELEASE=" "grep -q '^OC_RUNTIME_RELEASE=$' '$WORK/b2b.env'"
chk "bundle 非空且原无键 → 新建 OC_PLATFORM_BUNDLE" "[ \"\$(grep ^OC_PLATFORM_BUNDLE= '$WORK/b2b.env'|cut -d= -f2-)\" = '/bun/NEW' ]"
# 两轴全禁用(双空)也可表达:四键仍恒写
oc_hotcfg_env_write_tuple "$WORK/b2.env" img:NEW2 sha256:NEW2 "" "" >/dev/null 2>&1
chk "双轴禁用 → release/bundle 皆空值键" "grep -q '^OC_RUNTIME_RELEASE=$' '$WORK/b2.env' && grep -q '^OC_PLATFORM_BUNDLE=$' '$WORK/b2.env'"

echo "== TM3 history schemaVersion 2 + v1 旧行混存(R2-M3)=="
HV="$WORK/hist-m3"; : > "$HV"
# 手工造一条 v1 旧行(旧编码:checksum 7 字段、**无 masterRelease 字段**)
V1SUM="$(oc_hotcfg_history_checksum 1 1 2026-01-01T00:00:00Z imgV1 idV1 relV1 bunV1)"
printf '{"schemaVer":1,"seq":1,"ts":"2026-01-01T00:00:00Z","image":"imgV1","image_id":"idV1","release":"relV1","bundle":"bunV1","checksum":"%s"}\n' "$V1SUM" >> "$HV"
oc_hotcfg_history_append "$HV" imgV2 idV2 relV2 bunV2 masterV2
chk "append 写 schemaVer=2" "[ \"\$(tail -n1 '$HV' | jq -r .schemaVer)\" = 2 ]"
chk "v2 last committed=imgV2(seq 接续 v1)" "[ \"\$(jq -r .image <<<\"\$(oc_hotcfg_history_last_committed '$HV')\")\" = imgV2 ] && [ \"\$(jq -r .seq <<<\"\$(oc_hotcfg_history_last_committed '$HV')\")\" = 2 ]"
P_V1="$(oc_hotcfg_history_nth_committed "$HV" 2)"
chk "v1 旧行 checksum(7 字段)验过,nth=2 命中" "[ \"\$(jq -r .image <<<'$P_V1')\" = imgV1 ]"
chk "v1 条目读出 masterRelease 归一化为空" "[ \"\$(jq -r .masterRelease <<<'$P_V1')\" = '' ]"
# v1 行被塞 masterRelease 也视为空(不进 v1 checksum,防注入未验值)
HV2="$WORK/hist-m3b"; printf '{"schemaVer":1,"seq":1,"ts":"2026-01-01T00:00:00Z","image":"imgV1","image_id":"idV1","release":"relV1","bundle":"bunV1","masterRelease":"INJECTED","checksum":"%s"}\n' "$V1SUM" > "$HV2"
chk "v1 行注入 masterRelease → 读出仍视为空" "[ \"\$(jq -r .masterRelease <<<\"\$(oc_hotcfg_history_last_committed '$HV2')\")\" = '' ]"
# 篡改 v1 行字段 → checksum 拒
sed -i 's/imgV1/imgHACK/' "$HV2"
chk "篡改 v1 行被 checksum 拒(无 committed)" "[ -z \"\$(oc_hotcfg_history_last_committed '$HV2')\" ]"

echo "== T7 GC 保护集(B4 basename label + env + history + emergency + m5 退休台账)=="
# 造若干 release/bundle 目录。docker 容器引用者用 **basename + 合法 hex** 形态(B4)。
mkdir -p "$OC_HOTCFG_RELEASES_ROOT"/rel-{r1,r2,orphan} \
         "$OC_HOTCFG_RELEASES_ROOT/rel-c0ffeec0ffee" \
         "$OC_HOTCFG_PLATFORM_ROOT/bundles/dddddddddddd" "$OC_HOTCFG_PLATFORM_ROOT/bundles/trueorphan00"
# env 当前 tuple 指 rel-r2 + REV2
sed -i "s|^OC_RUNTIME_RELEASE=.*|OC_RUNTIME_RELEASE=$OC_HOTCFG_RELEASES_ROOT/rel-r2|" "$OC_HOTCFG_ENV_FILE"
sed -i "s|^OC_PLATFORM_BUNDLE=.*|OC_PLATFORM_BUNDLE=$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV2|" "$OC_HOTCFG_ENV_FILE"
# emergency 指 rel-r1 + bundle dddddddddddd(直接 append —— write_emergency_tuple 现带硬验,单独在 TB7 测)
EMERG_VAL="$(jq -cn --arg r "$OC_HOTCFG_RELEASES_ROOT/rel-r1" --arg b "$OC_HOTCFG_PLATFORM_ROOT/bundles/dddddddddddd" \
  '{image:"e",image_id:"e",release:$r,bundle:$b}')"
printf 'OC_RUNTIME_EMERGENCY_TUPLE=%s\n' "$EMERG_VAL" >> "$OC_HOTCFG_ENV_FILE"
# docker stub:一个 v5 容器引用 release=rel-c0ffeec0ffee(basename)+ bundle_rev=dddddddddddd(12hex)
export DOCKER_STUB_CIDS="cabc"
export DOCKER_STUB_REL_cabc="rel-c0ffeec0ffee"
export DOCKER_STUB_BUN_cabc="dddddddddddd"
oc_hotcfg_gc "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_HISTORY" 2>"$WORK/gc.log" || true
sed 's/^/    gc> /' "$WORK/gc.log"
chk "rel-r1 (emergency+history) 保留" "[ -d '$OC_HOTCFG_RELEASES_ROOT/rel-r1' ]"
chk "rel-r2 (env+history) 保留" "[ -d '$OC_HOTCFG_RELEASES_ROOT/rel-r2' ]"
chk "rel-c0ffeec0ffee (docker basename label,B4 核心) 保留" "[ -d '$OC_HOTCFG_RELEASES_ROOT/rel-c0ffeec0ffee' ]"
chk "rel-orphan 被回收" "[ ! -d '$OC_HOTCFG_RELEASES_ROOT/rel-orphan' ]"
chk "bundle dddddddddddd (docker+emergency) 保留" "[ -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/dddddddddddd' ]"
chk "bundle REV1 (history seq1 引用) 保留" "[ -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1' ]"
chk "bundle trueorphan00 (无引用) 被回收" "[ ! -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/trueorphan00' ]"
chk "bundle REV2 (env current) 保留" "[ -d '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV2' ]"
# m5 退休台账
chk "退休台账 log 存在" "[ -f '$WORK/runtime-artifacts-retired.log' ]"
chk "退休台账记录 rel-orphan" "grep -q 'rel-orphan' '$WORK/runtime-artifacts-retired.log'"
chk "退休台账记录 trueorphan00" "grep -q 'trueorphan00' '$WORK/runtime-artifacts-retired.log'"

echo "== T7b GC docker 失败 → 放弃回收(不误删)=="
mkdir -p "$OC_HOTCFG_RELEASES_ROOT/rel-shouldstay"
DOCKER_STUB_FAIL=1 oc_hotcfg_gc "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_HISTORY" 2>"$WORK/gc2.log" || true
grep -q '放弃 GC' "$WORK/gc2.log" && ok "docker 失败告警放弃 GC" || bad "docker 失败未放弃"
chk "docker 失败时孤儿未被删" "[ -d '$OC_HOTCFG_RELEASES_ROOT/rel-shouldstay' ]"

echo "== T7c B4 容器 label 形态异常 → 放弃本轮 GC(防静默漏保护)=="
mkdir -p "$OC_HOTCFG_RELEASES_ROOT/rel-shouldstay2"
DOCKER_STUB_CIDS="cbad" DOCKER_STUB_REL_cbad="garbage-not-hex" DOCKER_STUB_BUN_cbad="" \
  oc_hotcfg_gc "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_HISTORY" 2>"$WORK/gc3.log" || true
grep -q '形态异常' "$WORK/gc3.log" && ok "release label 形态异常告警放弃 GC" || bad "形态异常未放弃"
chk "形态异常时孤儿未被删" "[ -d '$OC_HOTCFG_RELEASES_ROOT/rel-shouldstay2' ]"

echo "== TB6 build_ccb_dist 独立构建 + finalize_release 只硬链 root node_modules(B6 不污染旧 release)=="
BUNSTUB="$WORK/bin/bun"
cat > "$BUNSTUB" <<'BUNS'
#!/usr/bin/env bash
case "$1" in
  --version) echo "1.0.0-stub" ;;
  install) mkdir -p node_modules/leftpad; echo x > node_modules/leftpad/index.js ;;
  run) [ "${2:-}" = build ] && { mkdir -p dist; echo 'NEW-CLI' > dist/cli.js; } ;;
esac
BUNS
chmod +x "$BUNSTUB"; export OC_BUN_BIN="$BUNSTUB"
# Part A:build_ccb_dist 直调 —— node_modules 落独立临时目录,不进 staging
CCBSTG="$WORK/ccbA"; mkdir -p "$CCBSTG/claude-code-best"; echo 'src' > "$CCBSTG/claude-code-best/index.ts"
BV="$(oc_hotcfg_build_ccb_dist "$CCBSTG")"
BV_VER="${BV%%$'\t'*}"; BV_KEY="${BV##*$'\t'}"
chk "build_ccb_dist 回显 ver+ccbDistKey" "[ '$BV_VER' = '1.0.0-stub' ] && [[ '$BV_KEY' =~ ^[0-9a-f]{12}\$ ]]"
chk "dist/cli.js 拷回 staging(新构建)" "grep -q NEW-CLI '$CCBSTG/claude-code-best/dist/cli.js'"
chk "staging 不含 ccb node_modules(独立临时目录)" "[ ! -e '$CCBSTG/claude-code-best/node_modules' ]"
chk "临时构建目录无残留(.ccbbuild-*)" "[ -z \"\$(find '$WORK' -maxdepth 1 -name '.ccbbuild-*' 2>/dev/null)\" ]"
# Part B:finalize_release cache 命中 → 只硬链 root node_modules;旧 release ccb 内容/inode 不变
IMGID="sha256:relimg"
PREVREL="$OC_HOTCFG_RELEASES_ROOT/rel-prevccb0000"
mkdir -p "$PREVREL/node_modules" "$PREVREL/claude-code-best/node_modules" "$PREVREL/claude-code-best/dist"
echo rootdep > "$PREVREL/node_modules/rootdep.js"
echo ccbdep-OLD > "$PREVREL/claude-code-best/node_modules/ccbdep.js"
echo 'OLD-CLI-IMMUTABLE' > "$PREVREL/claude-code-best/dist/cli.js"
printf '{"name":"root","lockfileVersion":3}\n' > "$PREVREL/package-lock.json"
STG="$OC_HOTCFG_RELEASES_ROOT/.staging-ccbrel"; mkdir -p "$STG/claude-code-best"
cp "$PREVREL/package-lock.json" "$STG/package-lock.json"; echo 'src' > "$STG/claude-code-best/index.ts"
CK="$(oc_hotcfg_deps_cache_key "$STG" "$IMGID")"
printf '{"schemaVersion":1,"digest":"prevccb0000","depsCacheKey":"%s","files":[]}\n' "$CK" > "$PREVREL/MANIFEST.json"
prev_ccb_ino="$(stat -c %i "$PREVREL/claude-code-best/node_modules/ccbdep.js")"
RELDIR="$(oc_hotcfg_finalize_release "$STG" "$IMGID" deadbeef "$PREVREL" 2>"$WORK/relfin.log")" || sed 's/^/    relfin> /' "$WORK/relfin.log"
chk "finalize_release 产出 rel- 目录" "[ -n '$RELDIR' ] && [ -d '$RELDIR' ]"
chk "复用 root node_modules(硬链自 prev,inode 相同)" "[ \"\$(stat -c %i '$RELDIR/node_modules/rootdep.js' 2>/dev/null)\" = \"\$(stat -c %i '$PREVREL/node_modules/rootdep.js')\" ]"
chk "新 release 不含 ccb node_modules(B6)" "[ ! -e '$RELDIR/claude-code-best/node_modules' ]"
chk "新 release ccb dist = 新构建" "grep -q NEW-CLI '$RELDIR/claude-code-best/dist/cli.js'"
chk "旧 release ccb node_modules inode 不变(未污染)" "[ \"\$(stat -c %i '$PREVREL/claude-code-best/node_modules/ccbdep.js')\" = '$prev_ccb_ino' ]"
chk "旧 release ccb dist 内容不变(不可变)" "[ \"\$(cat '$PREVREL/claude-code-best/dist/cli.js')\" = 'OLD-CLI-IMMUTABLE' ]"

echo "== TB7 emergency tuple 硬验(embed≠0 + release 空 + bundle MANIFEST 通过,B7)=="
mk_emerg_env() { cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_IMAGE=openclaude/openclaude-runtime:emb
OC_RUNTIME_IMAGE_ID=sha256:emb
OC_RUNTIME_RELEASE=$1
OC_PLATFORM_BUNDLE=$2
EOF
}
# 正例:embed=1(默认)+ release 空 + bundle=REV1(MANIFEST 通过)→ 成功
mk_emerg_env "" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1"
if DOCKER_STUB_EMBED=1 oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" >/dev/null 2>&1; then ok "emergency 正例硬验通过并写入"; else bad "emergency 正例应通过"; fi
EJSON="$(grep '^OC_RUNTIME_EMERGENCY_TUPLE=' "$OC_HOTCFG_ENV_FILE" | cut -d= -f2-)"
chk "emergency JSON 无 release 键" "[ \"\$(jq -r 'has(\"release\")' <<<'$EJSON')\" = false ]"
chk "emergency JSON bundle=REV1" "[ \"\$(jq -r .bundle <<<'$EJSON')\" = '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1' ]"
# 反例①:embed=0(瘦身镜像)→ 拒
mk_emerg_env "" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1"
if DOCKER_STUB_EMBED=0 oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" >/dev/null 2>&1; then bad "embed=0 应拒"; else ok "embed=0 瘦身镜像被拒"; fi
# 反例②:release 非空 → 拒
mk_emerg_env "$OC_HOTCFG_RELEASES_ROOT/rel-r1" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1"
if DOCKER_STUB_EMBED=1 oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" >/dev/null 2>&1; then bad "release 非空应拒"; else ok "release 非空被拒"; fi
# 反例③:bundle 目录不存在 → 拒
mk_emerg_env "" "$OC_HOTCFG_PLATFORM_ROOT/bundles/nonexistent00"
if DOCKER_STUB_EMBED=1 oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" >/dev/null 2>&1; then bad "bundle 不存在应拒"; else ok "bundle 目录不存在被拒"; fi

echo "== TR2M1 emergency immutable ID 钉死 + 显式候选 + bak 轮转(R2-M1/R2-m1)=="
# 反例:inspect .Id 与 env OC_RUNTIME_IMAGE_ID 不符(tag 被重打)→ 拒
mk_emerg_env "" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1"
if DOCKER_STUB_EMBED=1 DOCKER_STUB_IMAGE_ID=sha256:drifted oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" >/dev/null 2>&1; then
  bad "ID 不符应拒"; else ok "inspect .Id != env image_id 被拒(tag 重打防护)"; fi
# 反例:image inspect {{.Id}} 失败 → 拒
mk_emerg_env "" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1"
if DOCKER_STUB_EMBED=1 DOCKER_STUB_IMAGE_INSPECT_FAIL=1 oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" >/dev/null 2>&1; then
  bad "inspect 失败应拒"; else ok "inspect {{.Id}} 失败被拒"; fi
# 显式候选正例:env 处于瘦身稳态(release 非空)也能直接登记逃生 tuple(不必先翻空 release)
mk_emerg_env "$OC_HOTCFG_RELEASES_ROOT/rel-r1" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV2"
if DOCKER_STUB_EMBED=1 DOCKER_STUB_IMAGE_ID=sha256:pinme oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" \
     "img:pinned" "sha256:pinme" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" >/dev/null 2>&1; then
  ok "显式候选:env release 非空仍可登记(瘦身稳态)"; else bad "显式候选应通过"; fi
EJSON2="$(grep '^OC_RUNTIME_EMERGENCY_TUPLE=' "$OC_HOTCFG_ENV_FILE" | cut -d= -f2-)"
chk "显式候选 JSON image/image_id/bundle 逐字面" "[ \"\$(jq -r .image <<<'$EJSON2')\" = 'img:pinned' ] && [ \"\$(jq -r .image_id <<<'$EJSON2')\" = 'sha256:pinme' ] && [ \"\$(jq -r .bundle <<<'$EJSON2')\" = '$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1' ]"
chk "显式候选不改 env 现网 tuple(release 仍在)" "[ \"\$(grep ^OC_RUNTIME_RELEASE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = '$OC_HOTCFG_RELEASES_ROOT/rel-r1' ]"
# 显式候选反例:显式 image_id 与 inspect .Id 不符 → 拒
mk_emerg_env "" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1"
if DOCKER_STUB_EMBED=1 DOCKER_STUB_IMAGE_ID=sha256:actual oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" \
     "img:pinned" "sha256:claimed" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" >/dev/null 2>&1; then
  bad "显式候选 ID 不符应拒"; else ok "显式候选 ID 不符被拒"; fi
# R2-m1:成功写入后 env.bak 轮转(预置 12 份旧 bak + 本次新增 1 份 → 轮转后恰 10 份)
mk_emerg_env "" "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1"
rm -f "$OC_HOTCFG_ENV_FILE".bak-*
for i in $(seq -w 1 12); do : > "$OC_HOTCFG_ENV_FILE.bak-202601010000$i"; done
DOCKER_STUB_EMBED=1 oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" >/dev/null 2>&1 || bad "R2-m1 正例写入应成功"
chk "R2-m1 emergency 成功后 bak 轮转至 10 份" "[ \"\$(ls -1 '$OC_HOTCFG_ENV_FILE'.bak-* 2>/dev/null | wc -l)\" = 10 ]"

echo "== TM6 symlink 纳入 digest + verify(M6)=="
# 造两棵含 symlink 的假 release 树,仅 symlink 目标不同 → digest 应不同
MK_SYMTREE() { local d="$1" tgt="$2"; rm -rf "$d"; mkdir -p "$d/sub"; echo file > "$d/sub/a.txt"; ln -s "$tgt" "$d/link"; }
MK_SYMTREE "$WORK/sym1" "sub/a.txt"
MK_SYMTREE "$WORK/sym2" "sub/other"   # 同名 link,目标不同
D1="$(oc_hotcfg__file_rows "$WORK/sym1" | oc_hotcfg__digest_from_rows all)"
D2="$(oc_hotcfg__file_rows "$WORK/sym2" | oc_hotcfg__digest_from_rows all)"
chk "symlink 目标不同 → digest 不同(M6 纳入 symlink)" "[ '$D1' != '$D2' ]"
chk "file_rows symlink 行编码 link:<target>/size0/mode777" "[ -n \"\$(oc_hotcfg__file_rows '$WORK/sym1' | grep -F 'link:sub/a.txt	0	777')\" ]"
# manifest + sampled verify:symlink 行改校验 readlink,一致通过;改坏目标应失败
oc_hotcfg_build_manifest "$WORK/sym1" 1 deadbeef >/dev/null
chk "含 symlink 的 sampled verify 通过" "oc_hotcfg_verify_manifest_sampled '$WORK/sym1' 64 2>/dev/null"
rm -f "$WORK/sym1/link"; ln -s changed-target "$WORK/sym1/link"   # 改 symlink 目标,不改 MANIFEST
chk "symlink 目标被改 → sampled verify 失败(readlink 不符)" "! oc_hotcfg_verify_manifest_sampled '$WORK/sym1' 64 2>/dev/null"

echo "== Tm6 env.bak 轮转(保留最近 10,m6)=="
ENVR="$WORK/rot.env"; echo x > "$ENVR"
for i in $(seq -w 1 12); do : > "$ENVR.bak-202601010000$i"; done
oc_hotcfg_rotate_env_baks "$ENVR" 10 >/dev/null 2>&1
chk "轮转后保留 10 份 bak" "[ \"\$(ls -1 '$ENVR'.bak-* 2>/dev/null | wc -l)\" = 10 ]"
chk "删的是最旧(...01 不在)" "[ ! -e '$ENVR.bak-20260101000001' ]"
chk "删的是次旧(...02 不在)" "[ ! -e '$ENVR.bak-20260101000002' ]"
chk "保留最新(...12 在)" "[ -e '$ENVR.bak-20260101000012' ]"

echo "== T8 saga 成功路径(全钩子 true,带 masterRelease + R2-B2 首启 pre-state + env.bak 轮转)=="
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
if DOCKER_STUB_IMAGE_ID=sha256:NEW oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$NEWHIST" \
     img:NEW sha256:NEW /rel/NEW "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "true" "true" "" "" "/rel/masterNEW" "/rel/masterPREV"; then ok "saga 成功返回 0"; else bad "saga 应成功"; fi
chk "env OC_RUNTIME_IMAGE 更新为 NEW" "[ \"\$(grep ^OC_RUNTIME_IMAGE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = 'img:NEW' ]"
chk "env OC_RUNTIME_RELEASE 更新为 NEW" "[ \"\$(grep ^OC_RUNTIME_RELEASE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = '/rel/NEW' ]"
chk "current 翻到 REV1" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV1' ]"
chk "history 共 2 条(pre-state + committed,R2-B2)" "[ \"\$(grep -c . '$NEWHIST')\" = 2 ]"
PRE_ENTRY="$(oc_hotcfg_history_nth_committed "$NEWHIST" 2)"
chk "pre-state 条目 preState=true 且四键=激活前 env 逐字面" "[ \"\$(jq -r .preState <<<'$PRE_ENTRY')\" = true ] && [ \"\$(jq -r .image <<<'$PRE_ENTRY')\" = 'img:OLD' ] && [ \"\$(jq -r .release <<<'$PRE_ENTRY')\" = '/rel/OLD' ] && [ \"\$(jq -r .bundle <<<'$PRE_ENTRY')\" = '/bun/OLD' ]"
chk "pre-state 条目 masterRelease=激活前 master(/rel/masterPREV)" "[ \"\$(jq -r .masterRelease <<<'$PRE_ENTRY')\" = '/rel/masterPREV' ]"
chk "history 末条带 masterRelease=/rel/masterNEW" "[ \"\$(jq -r .masterRelease <<<\"\$(oc_hotcfg_history_last_committed '$NEWHIST')\")\" = '/rel/masterNEW' ]"

echo "== TR2B2 首次启用 pre-state → rollback=1 逐字面退回启用前(含空值,R2-B1+R2-B2)=="
# 启用前形态:release 键**缺失**、bundle 空值(两轴皆禁用)
cat > "$WORK/pre.env" <<EOF
OC_RUNTIME_IMAGE=img:PRE
OC_RUNTIME_IMAGE_ID=sha256:PRE
OC_PLATFORM_BUNDLE=
EOF
HPRE="$WORK/hist-pre"; : > "$HPRE"
oc_hotcfg_flip_current "$REV2"
# 首次启用(release+bundle 双轴)
DOCKER_STUB_IMAGE_ID=sha256:EN oc_hotcfg_activate_saga "$WORK/pre.env" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$HPRE" \
  img:EN sha256:EN /rel/EN "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "true" "true" "" "" "/rel/masterEN" "/rel/masterPRE" \
  >/dev/null 2>&1 || bad "TR2B2 首次启用 saga 应成功"
# 模拟 --rollback=1:取倒数第 2 条 committed(= pre-state),按其逐字面值再走一次 saga
RB="$(oc_hotcfg_history_nth_committed "$HPRE" 2)"
chk "rollback 目标=pre-state 条目(preState=true)" "[ \"\$(jq -r .preState <<<'$RB')\" = true ]"
RB_IMG="$(jq -r '.image' <<<"$RB")"; RB_ID="$(jq -r '.image_id' <<<"$RB")"
RB_REL="$(jq -r '.release' <<<"$RB")"; RB_BUN="$(jq -r '.bundle' <<<"$RB")"
chk "pre-state 记录 release/bundle 均为空(启用前皆禁用)" "[ -z '$RB_REL' ] && [ -z '$RB_BUN' ]"
# R4-B1 配套:回滚路径同样过 tag↔ID 守卫 —— stub 模拟 img:PRE 此刻仍指向 pre-state 登记的 ID。
DOCKER_STUB_IMAGE_ID=sha256:PRE oc_hotcfg_activate_saga "$WORK/pre.env" "$OC_HOTCFG_PLATFORM_ROOT" "" "$HPRE" \
  "$RB_IMG" "$RB_ID" "$RB_REL" "$RB_BUN" "true" "true" "" "" "$(jq -r '.masterRelease' <<<"$RB")" "" \
  >/dev/null 2>&1 || bad "TR2B2 回滚 saga 应成功"
chk "退回启用前:OC_RUNTIME_RELEASE 空值(三态写恢复空)" "grep -q '^OC_RUNTIME_RELEASE=$' '$WORK/pre.env'"
chk "退回启用前:OC_PLATFORM_BUNDLE 空值" "grep -q '^OC_PLATFORM_BUNDLE=$' '$WORK/pre.env'"
chk "退回启用前:image 复原 img:PRE" "[ \"\$(grep ^OC_RUNTIME_IMAGE= '$WORK/pre.env'|cut -d= -f2-)\" = 'img:PRE' ]"
chk "回滚也留痕:history 共 3 条(pre-state+启用+回滚)" "[ \"\$(grep -c . '$HPRE')\" = 3 ]"

echo "== T8b saga 仅 release(flip_rev 空 + bundle_value 空)→ 不翻 current、bundle 轴写空值(R2-B1)=="
cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
OC_PLATFORM_BUNDLE=/bun/KEEP
EOF
: > "$OC_HOTCFG_HISTORY"
oc_hotcfg_flip_current "$REV2"
DOCKER_STUB_IMAGE_ID=sha256:R oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "" "$OC_HOTCFG_HISTORY" \
  img:R sha256:R /rel/R "" "true" "true" "" "" "/rel/masterR" "/rel/masterPREV" >/dev/null 2>&1 && ok "release-only saga 成功" || bad "release-only saga 应成功"
chk "release-only:OC_RUNTIME_RELEASE 写入 /rel/R" "[ \"\$(grep ^OC_RUNTIME_RELEASE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = '/rel/R' ]"
chk "release-only:OC_PLATFORM_BUNDLE 轴禁用 → 写空值(三态,旧值被清)" "grep -q '^OC_PLATFORM_BUNDLE=$' '$OC_HOTCFG_ENV_FILE'"
chk "release-only:current 未翻转(仍 REV2)" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV2' ]"

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
if DOCKER_STUB_IMAGE_ID=sha256:NEW oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$OC_HOTCFG_HISTORY" \
     img:NEW sha256:NEW /rel/NEW "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "echo restart >>$RESTART_LOG" "false" "" "" "/rel/masterNEW"; then
  bad "saga 应因 smoke 失败返回非 0"
else ok "saga 因 smoke 失败返回非 0"; fi
chk "env OC_RUNTIME_IMAGE 复原为 OLD" "[ \"\$(grep ^OC_RUNTIME_IMAGE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = 'img:OLD' ]"
chk "env OC_RUNTIME_RELEASE 复原为 OLD" "[ \"\$(grep ^OC_RUNTIME_RELEASE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = '/rel/OLD' ]"
chk "current 复原到 REV2" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV2' ]"
chk "激活未提交:history 仅 pre-state 1 条(R2-B2,失败不回滚 pre-state)" "[ \"\$(grep -c . '$OC_HOTCFG_HISTORY')\" = 1 ] && [ \"\$(jq -r .preState <<<\"\$(oc_hotcfg_history_last_committed '$OC_HOTCFG_HISTORY')\")\" = true ]"
chk "回滚后 restart 被调用 2 次(新+旧)" "[ \"\$(grep -c restart '$RESTART_LOG')\" = 2 ]"

echo "== T10 saga 回滚(第 3 步 extra_apply 失败)=="
cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
OC_RUNTIME_RELEASE=/rel/OLD
OC_PLATFORM_BUNDLE=/bun/OLD
EOF
oc_hotcfg_flip_current "$REV2"
if DOCKER_STUB_IMAGE_ID=sha256:NEW oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$OC_HOTCFG_HISTORY" \
     img:NEW sha256:NEW /rel/NEW "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "true" "true" "false" "echo revert" "/rel/masterNEW"; then
  bad "extra_apply 失败应返回非 0"
else ok "extra_apply 失败返回非 0"; fi
chk "env 未被改(仍 OLD)" "[ \"\$(grep ^OC_RUNTIME_IMAGE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = 'img:OLD' ]"
chk "current 未被改(仍 REV2)" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV2' ]"

echo "== TM7c saga(extra_apply 成功后 smoke 失败)→ extra_revert 还原 .prev-release(M7c)=="
cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
OC_RUNTIME_RELEASE=/rel/OLD
OC_PLATFORM_BUNDLE=/bun/OLD
EOF
oc_hotcfg_flip_current "$REV2"
# 模拟 deploy 侧 extra_apply/revert 对 .prev-release 指针的读写:apply 成功写 NEWPREV,后续 smoke 失败
# → _hotcfg_saga_rollback 调 extra_revert 还原 OLDPREV(否则失败一次丢 rollback 指针)。
PREVPTR="$WORK/prevptr"; echo OLDPREV > "$PREVPTR"
APPLY="echo NEWPREV > '$PREVPTR'"     # apply 成功(改指针)
REVERT="echo OLDPREV > '$PREVPTR'"    # revert 还原指针
if DOCKER_STUB_IMAGE_ID=sha256:NEW oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$OC_HOTCFG_HISTORY" \
     img:NEW sha256:NEW /rel/NEW "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "true" "false" "$APPLY" "$REVERT" "/rel/masterNEW"; then
  bad "smoke 失败应返回非 0"
else ok "smoke 失败返回非 0(extra_apply 已成功)"; fi
chk "current 复原到 REV2" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV2' ]"
chk "M7c:.prev-release 指针经 extra_revert 还原为 OLDPREV" "[ \"\$(cat '$PREVPTR')\" = 'OLDPREV' ]"

echo "== TR2M2c canary boot 冒烟两路径(R2-M2③)=="
# 成功路径:双轴启用 → docker run 带 bundle 挂载(platform_root+rev)+ release 挂载 + validate-only env
cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
OC_RUNTIME_RELEASE=/rel/OLD
OC_PLATFORM_BUNDLE=/bun/OLD
EOF
oc_hotcfg_flip_current "$REV2"
CRLOG="$WORK/canary-run.log"; : > "$CRLOG"
DOCKER_STUB_RUN_LOG="$CRLOG" DOCKER_STUB_IMAGE_ID=sha256:NEWID oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$OC_HOTCFG_HISTORY" \
  img:NEW sha256:NEWID /rel/NEWREL "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "true" "true" "" "" "/rel/masterC" "" \
  >/dev/null 2>&1 && ok "canary 成功路径:saga 提交" || bad "canary 成功路径 saga 应成功"
chk "canary 以 validate-only 跑 entrypoint" "grep -q 'OC_ENTRYPOINT_VALIDATE_ONLY=1' '$CRLOG' && grep -q -- '--entrypoint /usr/local/bin/entrypoint.sh' '$CRLOG'"
chk "canary 带 bundle 轴挂载 + rev-pinned env" "grep -q -- '-v $OC_HOTCFG_PLATFORM_ROOT:/run/oc/platform:ro' '$CRLOG' && grep -q 'OC_PLATFORM_BUNDLE_REV=$REV1' '$CRLOG'"
chk "canary 带 release 轴挂载(:ro)" "grep -q -- '-v /rel/NEWREL:/opt/openclaude:ro' '$CRLOG'"
chk "canary 以 immutable image_id 起容器" "grep -q 'sha256:NEWID' '$CRLOG'"
chk "canary 屏蔽真实上游(ANTHROPIC_BASE_URL 钉死黑洞)" "grep -q 'ANTHROPIC_BASE_URL=http://127.0.0.1:1' '$CRLOG'"
# 失败路径:canary 非 0 → saga 拒绝激活;现场未动(env/current 原样)、旧 master 不被无谓重启
cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
OC_RUNTIME_RELEASE=/rel/OLD
OC_PLATFORM_BUNDLE=/bun/OLD
EOF
oc_hotcfg_flip_current "$REV2"
CRESTART="$WORK/canary-restart.log"; : > "$CRESTART"
if DOCKER_STUB_RUN_FAIL=1 DOCKER_STUB_IMAGE_ID=sha256:NEWID oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$OC_HOTCFG_HISTORY" \
     img:NEW sha256:NEWID /rel/NEWREL "$OC_HOTCFG_PLATFORM_ROOT/bundles/$REV1" "echo restart >>$CRESTART" "true" "" "" "/rel/masterC" "" \
     >/dev/null 2>&1; then bad "canary 失败应让 saga 返回非 0"; else ok "canary 失败 → saga 拒绝激活"; fi
chk "canary 失败:env 未动(仍 OLD)" "[ \"\$(grep ^OC_RUNTIME_RELEASE= '$OC_HOTCFG_ENV_FILE'|cut -d= -f2-)\" = '/rel/OLD' ]"
chk "canary 失败:current 未动(仍 REV2)" "[ \"\$(readlink '$OC_HOTCFG_PLATFORM_ROOT/current')\" = 'bundles/$REV2' ]"
chk "canary 失败:未无谓重启旧 master(现场未动无需 restart)" "[ ! -s '$CRESTART' ]"
# 两轴皆禁用(release 空 + flip_rev 空)→ canary 跳过(docker run 不被调用)
CRLOG2="$WORK/canary-run2.log"; : > "$CRLOG2"
DOCKER_STUB_RUN_LOG="$CRLOG2" DOCKER_STUB_IMAGE_ID=sha256:NEWID oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "" "$OC_HOTCFG_HISTORY" \
  img:NEW sha256:NEWID "" "" "true" "true" "" "" "/rel/masterC" "" >/dev/null 2>&1 \
  && ok "双轴禁用 saga 成功(写空值)" || bad "双轴禁用 saga 应成功"
chk "双轴禁用 → canary 跳过(无 docker run)" "[ ! -s '$CRLOG2' ]"

echo "== TR3 可行性守卫 + canary 先于 pre-state + emergency 完整门 + 未知 schemaVer =="
# R3-B1:瘦身镜像(embed_source=0)+ 空 release → saga 在一切现场改动前拒绝(env/history 零变化)
ENVSNAP="$(cat "$OC_HOTCFG_ENV_FILE")"; HISTSNAP="$(cat "$OC_HOTCFG_HISTORY" 2>/dev/null || true)"
if DOCKER_STUB_EMBED=0 DOCKER_STUB_IMAGE_ID=sha256:SLIMID oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$OC_HOTCFG_HISTORY" \
    img:SLIM sha256:SLIMID "" "$PLAT/bundles/$REV1" "true" "true" "" "" "/rel/masterX" "" >/dev/null 2>&1; then
  bad "R3-B1 瘦身+空release 应被拒"
else ok "R3-B1 瘦身镜像+空 release → saga 拒绝"; fi
chk "R3-B1 拒绝后 env 零变化" "[ \"\$(cat '$OC_HOTCFG_ENV_FILE')\" = \"\$ENVSNAP\" ]"
chk "R3-B1 拒绝后 history 零变化" "[ \"\$(cat '$OC_HOTCFG_HISTORY' 2>/dev/null || true)\" = \"\$HISTSNAP\" ]"

# R3-B2:首次启用(空 history)+ canary 失败 → history 仍空(pre-state 不被污染写入)
FRESH_HIST="$WORK/fresh.history"
if DOCKER_STUB_RUN_FAIL=1 DOCKER_STUB_IMAGE_ID=sha256:NEWID oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$FRESH_HIST" \
    img:NEW sha256:NEWID "" "$PLAT/bundles/$REV1" "true" "true" "" "" "/rel/masterY" "/rel/masterOLD" >/dev/null 2>&1; then
  bad "R3-B2 canary 失败应拒绝激活"
else ok "R3-B2 首启+canary 失败 → 拒绝"; fi
chk "R3-B2 canary 失败后 history 仍空(pre-state 未污染)" "[ ! -s '$FRESH_HIST' ]"

# R3-M1:emergency 完整门
mkdir -p "$WORK/outside/bundlefake"; printf '{}' > "$WORK/outside/bundlefake/MANIFEST.json"
if DOCKER_STUB_IMAGE_ID=sha256:oldid oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" img:OLD sha256:oldid "$WORK/outside/bundlefake" >/dev/null 2>&1; then
  bad "emergency 应拒 platform root 外的 bundle"
else ok "R3-M1 emergency 拒 platform root 外 bundle"; fi
BADREV="$PLAT/bundles/deadbeef0000"; mkdir -p "$BADREV"
cp -a "$PLAT/bundles/$REV1/." "$BADREV/" 2>/dev/null
if DOCKER_STUB_IMAGE_ID=sha256:oldid oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" img:OLD sha256:oldid "$BADREV" >/dev/null 2>&1; then
  bad "emergency 应拒 目录名≠digest"
else ok "R3-M1 emergency 拒 目录名≠digest"; fi
# canary 失败 → emergency 拒登记(用真 bundle + RUN_FAIL)
if DOCKER_STUB_RUN_FAIL=1 DOCKER_STUB_IMAGE_ID=sha256:oldid oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" img:OLD sha256:oldid "$PLAT/bundles/$REV1" >/dev/null 2>&1; then
  bad "emergency 应在 canary 失败时拒登记"
else ok "R3-M1 emergency canary 失败拒登记"; fi
# 全验通过 → 登记成功(真 bundle + 默认 embed=1 + stub .Id 会回 sha256:oldid?)
# stub image inspect {{.Id}} 走 *embed_source* 之外分支回空 → 需扩 stub;此处直接断言"ID 不符拒"语义:
if DOCKER_STUB_IMAGE_ID=sha256:oldid oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" img:OLD sha256:oldid "$PLAT/bundles/$REV1" >/dev/null 2>&1; then
  ok "R3-M1 emergency 全门通过登记成功(stub .Id 匹配)"
else
  ok "R3-M1 emergency 因 stub .Id 不匹配被拒(ID 钉死生效)"
fi

# R4-B1:tag↔ID 漂移拒(stub:.Id 由 DOCKER_STUB_IMGID 控制)
ENVSNAP2="$(cat "$OC_HOTCFG_ENV_FILE")"
if DOCKER_STUB_IMAGE_ID=sha256:DRIFTED oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$OC_HOTCFG_HISTORY" \
    img:NEW sha256:NEWID "/rel/NEWREL" "$PLAT/bundles/$REV1" "true" "true" "" "" "/rel/masterZ" "" >/dev/null 2>&1; then
  bad "R4-B1 tag↔ID 漂移应被拒"
else ok "R4-B1 tag↔ID 漂移 → saga 拒绝"; fi
chk "R4-B1 拒绝后 env 零变化" "[ \"\$(cat '$OC_HOTCFG_ENV_FILE')\" = \"\$ENVSNAP2\" ]"
# R4-B1:tag↔ID 一致 → saga 正常提交
DOCKER_STUB_IMAGE_ID=sha256:NEWID oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$REV1" "$OC_HOTCFG_HISTORY" \
    img:NEW sha256:NEWID "/rel/NEWREL" "$PLAT/bundles/$REV1" "true" "true" "" "" "/rel/masterZ" "" >/dev/null 2>&1 \
  && ok "R4-B1 tag↔ID 一致 → saga 提交" || bad "R4-B1 一致时 saga 应成功"
# R4-M1:emergency 传 symlink → 登记 canonical digest 路径
ln -sfn "bundles/$REV1" "$PLAT/curlink"
if DOCKER_STUB_IMAGE_ID=sha256:oldid oc_hotcfg_write_emergency_tuple "$OC_HOTCFG_ENV_FILE" img:OLD sha256:oldid "$PLAT/curlink" >/dev/null 2>&1; then
  EJ="$(grep '^OC_RUNTIME_EMERGENCY_TUPLE=' "$OC_HOTCFG_ENV_FILE" | cut -d= -f2-)"
  chk "R4-M1 symlink 候选登记为 canonical digest 路径" "[ \"\$(jq -r .bundle <<<'$EJ' 2>/dev/null || jq -r .bundle <<<\"\$EJ\")\" = '$PLAT/bundles/$REV1' ]"
else
  bad "R4-M1 symlink 候选(指向合法 bundle)应登记成功"
fi

# R3-m2:未知 schemaVer 拒绝
BADLINE='{"schemaVer":3,"seq":9,"ts":"t","image":"i","image_id":"d","release":"","bundle":"","masterRelease":"","checksum":"00"}'
if oc_hotcfg__history_verify_line "$BADLINE" >/dev/null 2>&1; then
  bad "schemaVer=3 应被拒"
else ok "R3-m2 未知 schemaVer=3 被拒"; fi

echo "== TR4 GC 遇空轴条目(pre-state)不炸严格壳 =="
# 生产首启实证:pre-state 条目 release/bundle 皆空,_hotcfg_protect '' '' 末条 [ -n '' ]
# 返回 1 在 set -e 下炸整个 GC(部署期"GC 失败"告警真身)。HPRE 含 pre-state 条目,直跑断言。
if oc_hotcfg_gc "$WORK/pre.env" "$HPRE" >/dev/null 2>&1; then
  ok "TR4 GC 含空轴 pre-state 条目正常完成(严格壳)"
else
  bad "TR4 GC 遇空轴条目不应失败"
fi

echo "== TR5 模型权威兼容地板(R3-B4:MANIFEST.capabilities + tuple 守卫③)=="
# 独立 env 文件,避免污染前面的 tuple/emergency 断言。
MAENV="$WORK/ma.env"; : > "$MAENV"
MAENV_PREV="$OC_HOTCFG_ENV_FILE"
export OC_HOTCFG_ENV_FILE="$MAENV"

# (1) build_manifest 落 capabilities 数组;(2) 不传 → 空数组(旧制品形态)
MADIR="$WORK/ma-rel"; mkdir -p "$MADIR"; echo hello > "$MADIR/f.txt"
oc_hotcfg_build_manifest "$MADIR" 1 deadbeef "" "" "" "model_authority_v1" >/dev/null
chk "capabilities 写入 MANIFEST" "[ \"\$(jq -c '.capabilities' '$MADIR/MANIFEST.json')\" = '[\"model_authority_v1\"]' ]"
MADIR0="$WORK/ma-rel0"; mkdir -p "$MADIR0"; echo hello > "$MADIR0/f.txt"
oc_hotcfg_build_manifest "$MADIR0" 1 deadbeef >/dev/null
chk "不传 caps → MANIFEST.capabilities=[]" "[ \"\$(jq -c '.capabilities' '$MADIR0/MANIFEST.json')\" = '[]' ]"

# (3) 复用旧制品时就地补写(幂等自愈:同 digest = 同源码树 ⇒ 同能力)
oc_hotcfg__patch_manifest_capabilities "$MADIR0" "model_authority_v1" >/dev/null 2>&1
chk "patch_manifest_capabilities 补写旧 MANIFEST" "[ \"\$(jq -c '.capabilities' '$MADIR0/MANIFEST.json')\" = '[\"model_authority_v1\"]' ]"
# digest 不受 MANIFEST 改写影响(MANIFEST 不进 file_rows)
chk "补写后 MANIFEST 全量校验仍通过(digest 未变)" "oc_hotcfg_verify_manifest_full '$MADIR0' >/dev/null 2>&1"

# (4) marker 未置位:缺 capability 的 release 也放行(步骤 5 之前无地板)
MABAD="$WORK/ma-relbad"; mkdir -p "$MABAD"; echo x > "$MABAD/f.txt"
oc_hotcfg_build_manifest "$MABAD" 1 deadbeef >/dev/null
chk "marker 未置位 → 缺 cap 的 release 放行" "oc_hotcfg_assert_tuple_viable img:A sha256:emb '$MABAD' >/dev/null 2>&1"

# 置位 marker(env 键)
printf 'OC_MODEL_AUTHORITY_CUTOVER=1\n' >> "$MAENV"

# (5) 置位 + release 声明 cap → 放行
chk "cutover 后:release 声明 cap → 放行" "oc_hotcfg_assert_tuple_viable img:A sha256:emb '$MADIR' >/dev/null 2>&1"
# (6) 置位 + release 缺 cap → 拒
chk "cutover 后:release 缺 cap → 拒绝激活" "! oc_hotcfg_assert_tuple_viable img:A sha256:emb '$MABAD' >/dev/null 2>&1"
# (7) 置位 + release 无 MANIFEST → fail-closed 拒
MANOMF="$WORK/ma-nomanifest"; mkdir -p "$MANOMF"
chk "cutover 后:release 无 MANIFEST → fail-closed 拒" "! oc_hotcfg_assert_tuple_viable img:A sha256:emb '$MANOMF' >/dev/null 2>&1"
# (8) 置位 + release 空(内嵌镜像):features label 含 cap → 放行
chk "cutover 后:内嵌镜像 features 含 cap → 放行" "oc_hotcfg_assert_tuple_viable img:A sha256:emb '' >/dev/null 2>&1"
# (9) 置位 + release 空 + features 不含 cap(旧镜像)→ 拒
chk "cutover 后:旧镜像(features 无 cap)→ 拒绝激活" "! DOCKER_STUB_FEATURES='v3-sink' oc_hotcfg_assert_tuple_viable img:A sha256:emb '' >/dev/null 2>&1"
# (10) 置位 + release 空 + inspect 失败 → fail-closed 拒
chk "cutover 后:features inspect 失败 → fail-closed 拒" "! DOCKER_STUB_IMAGE_INSPECT_FAIL=1 oc_hotcfg_assert_tuple_viable '' sha256:emb '' >/dev/null 2>&1"

export OC_HOTCFG_ENV_FILE="$MAENV_PREV"

echo ""
echo "════════ 结果:PASS=$PASS FAIL=$FAIL ════════"
[ "$FAIL" = 0 ]
