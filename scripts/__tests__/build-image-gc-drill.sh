#!/usr/bin/env bash
# build-image.sh image GC(R2-M1)独立演练:OC_IMAGE_GC_ONLY=1 + PATH docker stub 全本地干跑。
# 覆盖:
#   ① immutable ID 保护 —— env 在用镜像 / emergency image_id 的 **tag 别名**(tag 不在 keep set
#      但 .Id 相同)不被删;
#   ② 候选 stale tag inspect .Id 失败 → 保守跳过不删;
#   ③ emergency tuple JSON 解析失败(jq 报错)/ image・image_id 字段缺 → **放弃本轮 GC**(零删除);
#   ④ 正常孤儿 tag(ID 不受保护)→ rmi + 对应 tar 清理;
#   ⑤ DRY_RUN 不删。
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BI="$HERE/../../packages/commercial/agent-sandbox/build-image.sh"
WORK="$(mktemp -d /tmp/imagegc-drill.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()  { echo "  ✓ $*"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
chk() { if eval "$2"; then ok "$1"; else bad "$1 [cond: $2]"; fi; }

REPO="openclaude/openclaude-runtime"
mkdir -p "$WORK/bin" "$WORK/images"
cat > "$WORK/bin/docker" <<'DOCK'
#!/usr/bin/env bash
# GC 演练 docker stub:
#   DOCKER_STUB_TAGS    —— `docker images <repo> --format {{.Tag}}` 输出(created desc 顺序)
#   DOCKER_STUB_ID_MAP  —— 文件,每行 "<ref> <id>";image inspect {{.Id}} 查它,查无 → exit 1
#   DOCKER_STUB_RMI_LOG —— 被 rmi 的 ref 记录文件
case "$1" in
  info)   exit 0 ;;
  images) printf '%s\n' "${DOCKER_STUB_TAGS:-}" ;;
  image)  # image inspect --format '{{.Id}}' <ref>
    ref="${*: -1}"
    id="$(awk -v r="$ref" '$1==r{print $2}' "${DOCKER_STUB_ID_MAP:-/dev/null}" 2>/dev/null | head -1)"
    [ -n "$id" ] || { echo "no such image: $ref" >&2; exit 1; }
    printf '%s\n' "$id" ;;
  rmi)
    echo "$2" >> "${DOCKER_STUB_RMI_LOG:-/dev/null}"
    exit 0 ;;
  *) exit 0 ;;
esac
DOCK
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"

ENV5="$WORK/v5.env"; ENV3="$WORK/v3.env"
IDMAP="$WORK/idmap"; RMILOG="$WORK/rmi.log"

# GC 单跑公共 env(OC_IMAGE_GC_ONLY=1 跳过 build/save;EMBED=0 免源码树;假 env/输出目录)
run_gc() {  # $1=输出捕获文件
  OC_IMAGE_GC_ONLY=1 OC_EMBED_SOURCE=0 OC_IMAGE_KEEP_LAST=0 \
  OC_IMAGE_GC_ENV_V5="$ENV5" OC_IMAGE_GC_ENV_V3="$ENV3" OC_IMAGE_OUT_DIR="$WORK/images" \
  DOCKER_STUB_ID_MAP="$IDMAP" DOCKER_STUB_RMI_LOG="$RMILOG" \
  bash "$BI" newbuild > "$1" 2>&1
}

echo "== G1 immutable ID 保护 + inspect 失败保守跳过 + 孤儿删除(R2-M1)=="
cat > "$ENV5" <<EOF
OC_RUNTIME_IMAGE=$REPO:v5cur
OC_RUNTIME_EMERGENCY_TUPLE={"image":"$REPO:emb","image_id":"sha256:idemb","bundle":"/b"}
EOF
: > "$ENV3"
cat > "$IDMAP" <<EOF
$REPO:v5cur sha256:idcur
$REPO:emb sha256:idemb
$REPO:aliascur sha256:idcur
$REPO:aliasemb sha256:idemb
$REPO:orphan sha256:idorphan
EOF
# tag 面 keep set = {newbuild, latest, v5cur, emb};aliascur/aliasemb/orphan/ghost 都是 stale 候选
export DOCKER_STUB_TAGS=$'v5cur\naliascur\naliasemb\norphan\nghost'
: > "$RMILOG"
touch "$WORK/images/openclaude-runtime-orphan.tar.gz"
if run_gc "$WORK/g1.out"; then ok "GC 单跑退出 0"; else bad "GC 单跑应退出 0"; sed 's/^/    g1> /' "$WORK/g1.out"; fi
chk "孤儿 tag(ID 不受保护)被 rmi" "grep -qxF '$REPO:orphan' '$RMILOG'"
chk "孤儿 tar 一并清理" "[ ! -e '$WORK/images/openclaude-runtime-orphan.tar.gz' ]"
chk "env 在用镜像的 tag 别名(同 .Id)被 ID 保护跳过" "! grep -qxF '$REPO:aliascur' '$RMILOG' && grep -q 'ID 受保护 sha256:idcur' '$WORK/g1.out'"
chk "emergency image_id 的 tag 别名被 ID 保护跳过" "! grep -qxF '$REPO:aliasemb' '$RMILOG' && grep -q 'ID 受保护 sha256:idemb' '$WORK/g1.out'"
chk "inspect .Id 失败的 tag 保守跳过" "! grep -qxF '$REPO:ghost' '$RMILOG' && grep -q '保守不删' '$WORK/g1.out'"
chk "仅删孤儿 1 个(删除面精确)" "[ \"\$(grep -c . '$RMILOG')\" = 1 ]"

echo "== G2 emergency JSON 解析失败 → 放弃本轮 GC(零删除)=="
cat > "$ENV5" <<EOF
OC_RUNTIME_IMAGE=$REPO:v5cur
OC_RUNTIME_EMERGENCY_TUPLE={not-json!!!
EOF
: > "$RMILOG"
run_gc "$WORK/g2.out" || true
chk "解析失败告警并放弃" "grep -q '放弃本轮 GC' '$WORK/g2.out'"
chk "零删除(orphan 也不动)" "[ ! -s '$RMILOG' ]"

echo "== G3 emergency 字段缺(无 image_id)→ 放弃本轮 GC =="
cat > "$ENV5" <<EOF
OC_RUNTIME_IMAGE=$REPO:v5cur
OC_RUNTIME_EMERGENCY_TUPLE={"image":"$REPO:emb","bundle":"/b"}
EOF
: > "$RMILOG"
run_gc "$WORK/g3.out" || true
chk "字段缺告警并放弃" "grep -q '缺 image/image_id 字段' '$WORK/g3.out' && grep -q '放弃本轮 GC' '$WORK/g3.out'"
chk "零删除" "[ ! -s '$RMILOG' ]"

echo "== G4 DRY_RUN 不删 =="
cat > "$ENV5" <<EOF
OC_RUNTIME_IMAGE=$REPO:v5cur
OC_RUNTIME_EMERGENCY_TUPLE={"image":"$REPO:emb","image_id":"sha256:idemb","bundle":"/b"}
EOF
: > "$RMILOG"
OC_IMAGE_GC_DRY_RUN=1 run_gc "$WORK/g4.out" || true
chk "DRY_RUN 打印待清单不执行" "grep -q 'DRY_RUN' '$WORK/g4.out' && [ ! -s '$RMILOG' ]"

echo ""
echo "════════ 结果:PASS=$PASS FAIL=$FAIL ════════"
[ "$FAIL" = 0 ]
