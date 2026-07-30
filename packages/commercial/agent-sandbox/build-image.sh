#!/usr/bin/env bash
# v3 Phase 3B: openclaude-runtime 镜像 build + save 脚本
#
# 用法: ./build-image.sh [tag]   # tag 缺省 = 当前 v3 commit 短 sha
#
# 干啥(简单粗暴,符合 ops 脚本极简原则):
#   1. rsync 个人版源码到一个干净 build context(/tmp/oc-runtime-build/personal-version/)
#      —— 排除清单单一权威 runtime-src-excludes.txt(体积/产物 + leak hardening)
#   2. 把 Dockerfile + runtime/(薄壳)+ platform-runtime/(bundle 源,dev fallback)也搬过去
#   3. docker build -t openclaude/openclaude-runtime:<tag>
#   4. docker save | pigz(无则 gzip)> /var/lib/openclaude-v3/images/openclaude-runtime-<tag>.tar.gz
#      —— 该 tar 仅用于跨 host 分发/备份;单机池可 OC_BUILD_SKIP_TAR=1 跳过这步(省 ~55s)
#   5. 打印 summary(tag / sha256 / size / load 提示),给 5A deploy-to-remote-v3.sh 抄
#
# 注意:
#   - 要求 docker daemon 在跑且当前用户能用(root 或 docker group)
#   - 不上传任何远端 registry / 不打 latest tag,这两件事 5A 部署脚本统一管
#   - 失败立即 exit,不留半成品 image / tar(rm -f 兜底)

set -euo pipefail

# ───────────────────────────────────────────────
# 常量(硬编码,有意为之 — 不做"可配置")
# ───────────────────────────────────────────────
# PERSONAL_SRC = master 服务实际运行的源码树,deploy-v3.sh 把 45.32 上的 v3 仓 rsync
# 到这里 (kl-mirror:/opt/openclaude/openclaude/,KL prod primary) 后,本机所有
# 运行物 — gateway systemd 单元、compute-pool 模块、build-image 取的源 — 必须
# **唯一权威**地指向它,才能保证 "deploy 推什么,image 也 bake 什么"。
#
# 历史:在 KL 切为 primary 之前(2026-05-21 之前),master 是 Tokyo
# (commercial-v3)。那个阶段 PERSONAL_SRC 一度被错指到一棵孤立 source tree
# /opt/openclaude/openclaude-v3/,其 .git 是递归坏 worktree、deploy-v3.sh 不同步,
# 结果每次 deploy 推到 ./openclaude/、build 却从 ./openclaude-v3/ 取源,image 长期
# N commits 落后 master。2026-05-11 v1.0.124 hot fix(codex runner setTraceId
# no-op)就是踩这条坑。
#
# 单一权威源 invariant 保留至今,deploy 目标已迁到 KL primary。runtime image 通过
# rsync exclude packages/commercial/ 继续保留 "不含商用版代码" 这条不变量。
# PERSONAL_SRC 可经 env 覆盖:v5 ccb-only 镜像须指向 v5 树(/opt/openclaude/openclaude-v5),
# 否则会 bun-rebuild v3 生产树的 claude-code-best/dist(现网文件改动)。默认仍 v3,行为不变。
PERSONAL_SRC="${PERSONAL_SRC:-/opt/openclaude/openclaude}"
SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"  # 本脚本所在目录(agent-sandbox/)
BUILD_CTX="/tmp/oc-runtime-build"
IMAGE_REPO="openclaude/openclaude-runtime"
# tar 输出目录(仅 GC drill 用 env 覆盖到假树,生产恒默认值)
IMAGE_OUT_DIR="${OC_IMAGE_OUT_DIR:-/var/lib/openclaude-v3/images}"

# OC_EMBED_SOURCE(m4):=0 → **纯工具链镜像**,不内嵌个人版源码。此时 build context 只需
# Dockerfile+runtime/+platform-runtime/,**跳过 ccb prebuild(不需 bun)与个人源码 rsync**,
# 解除工具链镜像对源码树/bun 的耦合(Dockerfile 侧 COPY personal-version 已由 OC_EMBED_SOURCE
# 多阶段门控 embed-0/embed-1)。默认 1(内嵌,v3 行为不变);v5 hotcfg 瘦身镜像传 0。
OC_EMBED_SOURCE_VAL="${OC_EMBED_SOURCE:-1}"

# tag = 命令行第 1 参,没传就用 v3 仓库 HEAD 短 sha
TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG="$(cd "$SANDBOX_DIR" && git rev-parse --short=12 HEAD 2>/dev/null || true)"
  if [ -z "$TAG" ]; then
    echo "[build-image] FATAL: 无法从 git 拿 sha 且未传 tag 参数" >&2
    exit 1
  fi
fi

IMAGE_FULL="${IMAGE_REPO}:${TAG}"
TAR_PATH="${IMAGE_OUT_DIR}/openclaude-runtime-${TAG}.tar.gz"
CODEX_VERSION="0.144.0"

# The image tag is a deployment handle and may be chosen before the final source commit.
# Bind the image to the exact staged source independently so activation can reject a stale
# image even when the configured tag already exists locally.
SOURCE_COMMIT="${OC_RUNTIME_SOURCE_COMMIT:-}"
if [ -z "$SOURCE_COMMIT" ] && [ -f "$PERSONAL_SRC/VERSION.json" ]; then
  SOURCE_COMMIT="$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{7,40\}\)".*/\1/p' "$PERSONAL_SRC/VERSION.json" | head -1)"
fi
if [ -z "$SOURCE_COMMIT" ]; then
  SOURCE_COMMIT="$(git -C "$PERSONAL_SRC" rev-parse --short HEAD 2>/dev/null || true)"
fi
if [ -z "$SOURCE_COMMIT" ]; then
  if [ "$OC_EMBED_SOURCE_VAL" = "0" ]; then
    # 纯工具链镜像不内嵌源码,source_commit 非权威(运行物权威=hotcfg release digest)。
    SOURCE_COMMIT="toolchain"
  else
    echo "[build-image] FATAL: 无法确定 runtime source commit" >&2
    exit 1
  fi
fi

echo "[build-image] tag=$TAG"
echo "[build-image] image=$IMAGE_FULL"
echo "[build-image] source_commit=$SOURCE_COMMIT codex=$CODEX_VERSION"
echo "[build-image] tar=$TAR_PATH"

# ───────────────────────────────────────────────
# 前置检查
# ───────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "[build-image] FATAL: docker 不在 PATH" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[build-image] FATAL: docker daemon 不可用(检查 systemctl status docker / 用户 docker group)" >&2
  exit 1
fi

# 个人源码存在性:仅内嵌构建(EMBED≠0)硬需;EMBED=0 纯工具链镜像不 COPY/rsync 源码 → 不强求(m4)。
if [ "$OC_EMBED_SOURCE_VAL" != "0" ] && [ ! -d "$PERSONAL_SRC" ]; then
  echo "[build-image] FATAL: 个人版源码不存在: $PERSONAL_SRC" >&2
  exit 1
fi

# 取源指纹,让 ops 一眼确认 build 取的是 deploy 后的最新源,而不是某棵 stale 树。
# deploy-v3.sh 在 $PERSONAL_SRC/VERSION.json 写 {tag, commit, builtAt};没有(本地 dev
# / 首次 bootstrap)就回退到 mtime,信息少一些但不致命。EMBED=0 且无源码树时跳过指纹打印。
if [ "$OC_EMBED_SOURCE_VAL" = "0" ] && [ ! -d "$PERSONAL_SRC" ]; then
  echo "[build-image] source: <skipped, OC_EMBED_SOURCE=0 纯工具链镜像不内嵌源码>"
elif [ -f "$PERSONAL_SRC/VERSION.json" ]; then
  echo "[build-image] source: $PERSONAL_SRC  ($(cat "$PERSONAL_SRC/VERSION.json"))"
else
  echo "[build-image] source: $PERSONAL_SRC  (VERSION.json missing; mtime=$(stat -c '%y' "$PERSONAL_SRC"))"
fi

if [ ! -f "$SANDBOX_DIR/Dockerfile.openclaude-runtime" ]; then
  echo "[build-image] FATAL: Dockerfile 不存在: $SANDBOX_DIR/Dockerfile.openclaude-runtime" >&2
  exit 1
fi

if [ ! -d "$SANDBOX_DIR/runtime" ]; then
  echo "[build-image] FATAL: runtime 目录不存在: $SANDBOX_DIR/runtime" >&2
  exit 1
fi

if [ ! -d "$SANDBOX_DIR/platform-runtime" ]; then
  echo "[build-image] FATAL: platform-runtime 目录不存在: $SANDBOX_DIR/platform-runtime" >&2
  exit 1
fi
if [ ! -f "$SANDBOX_DIR/runtime-src-excludes.txt" ]; then
  echo "[build-image] FATAL: runtime-src-excludes.txt 不存在(rsync --exclude-from 单一权威)" >&2
  exit 1
fi

mkdir -p "$IMAGE_OUT_DIR"

# ───────────────────────────────────────────────
# image GC(函数化;正常流在 save 之后调用,OC_IMAGE_GC_ONLY=1 可单独跑)
# ───────────────────────────────────────────────
# 背景:每次 build 在 master 同时累积一份 docker image (~3.5GB) 和一份
# tar.gz (~660MB)。8 个 tag 就能把 49GB 根盘打到 99% (历史事件 2026-04-29)。
#
# 远端 host 已有 _pruneRemoteStaleImages 在分发后自动清旧 tag,master 没有
# 对应路径,所以这里收尾。
#
# 触发点:build-image.sh 末尾(build 是 rebuild 的唯一入口,GC 频率 ≈ 累积频率,
# 自然平衡,**不**写 systemd timer / cron);或 OC_IMAGE_GC_ONLY=1 手动/演练单跑。
#
# 保留集(tag 面)= {本次 build $TAG} ∪ {latest} ∪ {两 env OC_RUNTIME_IMAGE tag}
#         ∪ {emergency tuple image tag} ∪ {top OC_IMAGE_KEEP_LAST 个 by created desc}
# 保护集(**immutable ID 面,R2-M1**)= {两 env OC_RUNTIME_IMAGE 解析出的 .Id}
#         ∪ {emergency tuple 的 image_id}。候选 stale tag 删除前先 inspect .Id:
#         ∈ 保护集 → skip(tag 可被重打,同一镜像可能顶着别的 tag 在用);inspect
#         失败 → **保守跳过该 tag**(拿不到 ID 就不删)。
# emergency tuple JSON 解析失败(jq 报错/image・image_id 字段缺)→ **放弃本轮 GC**
# (R2-M1,禁 `|| true` 吞错:保护集算不全时删除面必须归零)。
#
# 边界:
#   - in-use image rmi 自然 fail,best-effort skip(脚本不抛)
#   - 不调 docker image prune / system prune(多租户主机越权 — archival
#     arc-mof4luq1-r9o8ze 教训)
#   - 不删 latest tag 自身;不动 dangling <none>:<none>;不删 build cache
#
# Env switches:
#   OC_IMAGE_KEEP_LAST=N      # 默认 3
#   OC_IMAGE_GC=0             # 整体跳过 GC(冻结历史 / 调试)
#   OC_IMAGE_GC_DRY_RUN=1     # 打印待清单不执行
#   OC_IMAGE_GC_ONLY=1        # 跳过 build/save 只跑 GC(手动清理/drill)
#   OC_IMAGE_GC_ENV_V5/V3     # env 文件路径覆盖(仅自测 stub 用)
image_gc() {
  if [ "${OC_IMAGE_GC:-1}" = "0" ]; then
    echo "[build-image] image-gc skipped (OC_IMAGE_GC=0)"
    return 0
  fi
  local KEEP_LAST DRY_RUN ENV_FILE_V5 ENV_FILE_V3
  KEEP_LAST="${OC_IMAGE_KEEP_LAST:-3}"
  DRY_RUN="${OC_IMAGE_GC_DRY_RUN:-0}"
  # B7:ENV_FILE 优先 v5(commercial-v5.env);同时并读 v3(commercial.env)兜底 v3 遗留镜像。
  ENV_FILE_V5="${OC_IMAGE_GC_ENV_V5:-/etc/openclaude/commercial-v5.env}"
  ENV_FILE_V3="${OC_IMAGE_GC_ENV_V3:-/etc/openclaude/commercial.env}"

  # 从 image ref 取 tag(最后一个冒号之后,不含路径分隔 /);无 tag → 空。
  tag_of_ref() { printf '%s' "$1" | sed -n 's|^.*:\([^:/]*\)$|\1|p'; }
  # 取某 env 文件 OC_RUNTIME_IMAGE 的完整 ref / tag(缺文件/缺键 → 空,不触发 set -e)
  env_runtime_ref() {
    local f="$1" line
    [ -f "$f" ] || return 0
    line="$(grep -E '^OC_RUNTIME_IMAGE=' "$f" 2>/dev/null | tail -n1 || true)"
    [ -n "$line" ] && printf '%s\n' "${line#OC_RUNTIME_IMAGE=}"
    return 0
  }
  env_runtime_tag() { tag_of_ref "$(env_runtime_ref "$1")"; return 0; }

  # emergency tuple(v5 env,JSON 单行 {image,image_id,bundle})严格解析(R2-M1):
  # 行存在但 jq 报错 / image・image_id 任一字段缺 → 返回 1 = 调用方放弃本轮 GC。
  # 逃生镜像常是更老的内嵌源码 tag,极易掉出 created-desc 的 KEEP_LAST 窗口,必须显式保护。
  local EMERG_TAG="" EMERG_IMAGE_ID=""
  parse_emergency() {
    local f="$1" line json img
    [ -f "$f" ] || return 0
    line="$(grep -E '^OC_RUNTIME_EMERGENCY_TUPLE=' "$f" 2>/dev/null | tail -n1 || true)"
    [ -n "$line" ] || return 0
    command -v jq >/dev/null 2>&1 || { echo "[build-image] FATAL: image-gc 需 jq 解析 emergency tuple 保护(防误删逃生镜像)" >&2; return 1; }
    json="${line#OC_RUNTIME_EMERGENCY_TUPLE=}"
    if ! img="$(printf '%s' "$json" | jq -r '.image // empty' 2>/dev/null)" \
       || ! EMERG_IMAGE_ID="$(printf '%s' "$json" | jq -r '.image_id // empty' 2>/dev/null)"; then
      echo "[build-image] ⚠ image-gc: emergency tuple JSON 解析失败(jq 报错)→ 放弃本轮 GC: $json" >&2
      return 1
    fi
    if [ -z "$img" ] || [ -z "$EMERG_IMAGE_ID" ]; then
      echo "[build-image] ⚠ image-gc: emergency tuple 缺 image/image_id 字段 → 放弃本轮 GC: $json" >&2
      return 1
    fi
    EMERG_TAG="$(tag_of_ref "$img")"
    return 0
  }
  if ! parse_emergency "$ENV_FILE_V5"; then
    echo "[build-image] image-gc aborted(emergency tuple 解析失败,保护集算不全 → 本轮不删任何镜像)"
    return 0
  fi

  # 展示用当前 tag(优先 v5,回退 v3)
  local CURRENT_TAG
  CURRENT_TAG="$(env_runtime_tag "$ENV_FILE_V5")"
  [ -n "$CURRENT_TAG" ] || CURRENT_TAG="$(env_runtime_tag "$ENV_FILE_V3")"

  # 列出本仓所有 tag,按 docker images 默认 created desc 顺序(最新在前)
  local ALL_TAGS_FILE KEEP_FILE PROTECT_FILE PROTECT_IDS_FILE
  ALL_TAGS_FILE="$(mktemp)"; KEEP_FILE="$(mktemp)"; PROTECT_FILE="$(mktemp)"; PROTECT_IDS_FILE="$(mktemp)"
  # EXIT 级清理(不能用 RETURN trap:它会在其后每次嵌套函数返回时都触发,把在建的临时文件删掉)。
  # 本脚本此前无其它 EXIT trap,覆盖安全;GC 在脚本尾段跑,EXIT 清理时效足够。
  # shellcheck disable=SC2064
  trap "rm -f '$ALL_TAGS_FILE' '$KEEP_FILE' '$PROTECT_FILE' '$PROTECT_IDS_FILE'" EXIT
  docker images "$IMAGE_REPO" --format '{{.Tag}}' > "$ALL_TAGS_FILE" 2>/dev/null || true

  # R2-M1:immutable ID 保护集 = 两 env OC_RUNTIME_IMAGE 解析出的 .Id + emergency image_id。
  # env 引用镜像本机 inspect 不到 → 本机没有"那一个镜像",无 ID 需保护(跳过,不视为错)。
  local _ref _id
  for _ref in "$(env_runtime_ref "$ENV_FILE_V5")" "$(env_runtime_ref "$ENV_FILE_V3")"; do
    [ -n "$_ref" ] || continue
    if _id="$(docker image inspect --format '{{.Id}}' "$_ref" 2>/dev/null)"; then
      [ -n "$_id" ] && printf '%s\n' "$_id" >> "$PROTECT_IDS_FILE"
    fi
  done
  [ -n "$EMERG_IMAGE_ID" ] && printf '%s\n' "$EMERG_IMAGE_ID" >> "$PROTECT_IDS_FILE"

  # 构建 keep set (tag 面;newline-separated 文本,grep -F -x -f 比较)。
  # 选 top KEEP_LAST 个历史 tag 时:**先**过滤掉所有 PROTECT tag,
  # 否则它们会占 KEEP_LAST 槽位,实际保留的独立历史版本数 < KEEP_LAST。
  {
    echo "$TAG"
    echo "latest"
    env_runtime_tag "$ENV_FILE_V5"
    env_runtime_tag "$ENV_FILE_V3"
    [ -n "$EMERG_TAG" ] && echo "$EMERG_TAG"
    :
  } | grep -v '^$' | sort -u > "$PROTECT_FILE"
  # `|| true` 兜底:全新机器首次 build 时 ALL_TAGS - PROTECT 可能为空,grep -v
  # 无匹配返回 exit 1,set -euo pipefail 下会让外层 { } 子块中断。
  {
    cat "$PROTECT_FILE"
    { grep -v '^<none>$' "$ALL_TAGS_FILE" | grep -F -x -v -f "$PROTECT_FILE" | head -n "$KEEP_LAST"; } || true
  } | sort -u > "$KEEP_FILE"

  # 待清 = ALL - KEEP, 跳过 <none>
  local STALE_TAGS
  STALE_TAGS="$(grep -v '^<none>$' "$ALL_TAGS_FILE" | grep -F -x -v -f "$KEEP_FILE" || true)"

  echo "[build-image] image-gc keep_last=$KEEP_LAST dry_run=$DRY_RUN current_tag=${CURRENT_TAG:-<none>}"
  echo "[build-image] image-gc keep set:"
  sed 's/^/  - /' "$KEEP_FILE"
  echo "[build-image] image-gc protected IDs:"
  sed 's/^/  - /' "$PROTECT_IDS_FILE"

  if [ -z "$STALE_TAGS" ]; then
    echo "[build-image] image-gc no stale tags to remove"
    return 0
  fi
  echo "[build-image] image-gc stale tags:"
  printf '  - %s\n' $STALE_TAGS
  if [ "$DRY_RUN" = "1" ]; then
    echo "[build-image] image-gc DRY_RUN — no changes"
    return 0
  fi
  local t tid STALE_TAR
  for t in $STALE_TAGS; do
    # R2-M1:删除前按 immutable ID 复核。inspect 失败 → 保守跳过(拿不到 ID 就不删);
    # .Id ∈ 保护集 → 跳过(该 tag 与某 env/emergency 在用镜像是同一实体,只是 tag 别名)。
    if ! tid="$(docker image inspect --format '{{.Id}}' "${IMAGE_REPO}:${t}" 2>/dev/null)"; then
      echo "[build-image] image-gc skip (inspect .Id 失败,保守不删): ${IMAGE_REPO}:${t}"
      continue
    fi
    if grep -qxF "$tid" "$PROTECT_IDS_FILE"; then
      echo "[build-image] image-gc skip (immutable ID 受保护 $tid): ${IMAGE_REPO}:${t}"
      continue
    fi
    if docker rmi "${IMAGE_REPO}:${t}" >/dev/null 2>&1; then
      echo "[build-image] image-gc rmi ok: ${IMAGE_REPO}:${t}"
      # 同时清对应 tar.gz(若存在)
      STALE_TAR="${IMAGE_OUT_DIR}/openclaude-runtime-${t}.tar.gz"
      if [ -f "$STALE_TAR" ]; then
        rm -f "$STALE_TAR" && echo "[build-image] image-gc rm tar: $STALE_TAR"
      fi
    else
      # 多半是 in-use(active container 引用),best-effort skip
      echo "[build-image] image-gc rmi skipped (in-use? other err): ${IMAGE_REPO}:${t}"
    fi
  done
  return 0
}

# OC_IMAGE_GC_ONLY=1 → 跳过 build/save,仅跑 GC(手动清理入口;drill 用 docker stub 覆盖)。
if [ "${OC_IMAGE_GC_ONLY:-0}" = "1" ]; then
  echo "[build-image] OC_IMAGE_GC_ONLY=1 → 只跑 image GC,跳过 build context/docker build/save"
  image_gc
  exit 0
fi

# ───────────────────────────────────────────────
# 1. 准备 build context
# ───────────────────────────────────────────────
# 不复用旧 BUILD_CTX(避免上一次残留污染),整个 wipe 重建
rm -rf "$BUILD_CTX"
mkdir -p "$BUILD_CTX"

# m4:EMBED=0 = 纯工具链镜像 —— Dockerfile 走 embed-0 阶段(不 COPY personal-version),故 build
# context **无需**个人源码,跳过 ccb prebuild(不依赖 bun)与源码 rsync,彻底解除工具链镜像↔源码/bun 耦合。
if [ "$OC_EMBED_SOURCE_VAL" = "0" ]; then
  echo "[build-image] OC_EMBED_SOURCE=0 → 跳过 ccb prebuild + personal-version rsync(纯工具链镜像,context 只含 Dockerfile+runtime+platform-runtime)"
else
  mkdir -p "$BUILD_CTX/personal-version"
  # 0. **预构建 claude-code-best dist** (容器内只有 node,没有 bun,需 prebuild)
  #    build.ts 走 Bun.build target=bun,后处理 import.meta.require → node 兼容
  #    产物 node dist/cli.js 直接可跑(MACRO defines 已烤进产物)
  #
  #    `--ignore-scripts`:跳过 ccb 的 `prepare` (git config core.hooksPath .githooks)。
  #    那条 hook 是给本地 dev 装的,build 完全不需要,而且 deploy-v3.sh rsync `.git/`
  #    exclude 把 ccb 子目录 .git 也排除了,跑 prepare 会向上找到根 .git(deploy 树
  #    根 .git 是个递归坏 worktree)→ fatal 128 → 整个 build 挂掉。跳过 install
  #    scripts 是 build env idiomatic 做法。
  if ! command -v bun >/dev/null 2>&1; then
    echo "[build-image] FATAL: 没 bun (~/.bun/bin/bun) — 无法 prebuild claude-code-best/dist" >&2
    exit 1
  fi
  if [ -d "$PERSONAL_SRC/claude-code-best" ]; then
    echo "[build-image] prebuild $PERSONAL_SRC/claude-code-best/dist (bun)"
    ( cd "$PERSONAL_SRC/claude-code-best" && bun install --silent --ignore-scripts && bun run build ) \
      || { echo "[build-image] FATAL: ccb prebuild 失败" >&2; exit 1; }
    if [ ! -f "$PERSONAL_SRC/claude-code-best/dist/cli.js" ]; then
      echo "[build-image] FATAL: prebuild 完成但 dist/cli.js 不存在" >&2
      exit 1
    fi
  fi

  echo "[build-image] rsync $PERSONAL_SRC → $BUILD_CTX/personal-version/"
  # --delete 让 dest 和 src 完全一致。排除清单(体积/产物 + leak hardening)已抽到单一权威文件
  # runtime-src-excludes.txt —— build-image.sh 与 deploy release 构建共用,禁内联漂移。语义(为何排
  # docs/deploy/scripts/凭据等)见该文件头。'/foo' 锚定源根,不误删 packages/*/foo 同名 child。
  rsync -a --delete \
    --exclude-from="$SANDBOX_DIR/runtime-src-excludes.txt" \
    "$PERSONAL_SRC/" "$BUILD_CTX/personal-version/"
fi

# 2. Dockerfile + runtime/(镜像薄壳+构建期文件) + platform-runtime/(bundle 源,dev fallback COPY)
cp "$SANDBOX_DIR/Dockerfile.openclaude-runtime" "$BUILD_CTX/Dockerfile.openclaude-runtime"
cp "$SANDBOX_DIR/playwright-cli.config.json" "$BUILD_CTX/playwright-cli.config.json"
rm -rf "$BUILD_CTX/runtime"
cp -r "$SANDBOX_DIR/runtime" "$BUILD_CTX/runtime"
rm -rf "$BUILD_CTX/platform-runtime"
cp -r "$SANDBOX_DIR/platform-runtime" "$BUILD_CTX/platform-runtime"

CTX_BYTES="$(du -sb "$BUILD_CTX" | awk '{print $1}')"
CTX_MB="$(( CTX_BYTES / 1024 / 1024 ))"
echo "[build-image] build context ready: ${CTX_MB} MiB at $BUILD_CTX"

# ───────────────────────────────────────────────
# 2. docker build
# ───────────────────────────────────────────────
echo "[build-image] docker build → $IMAGE_FULL"
# Capability labels (2026-05-05) — 让 master/supervisor 在 ensure-create 路径
# 通过 nodeAgent /image/inspect 验证 host 上加载的镜像具备 v3-sink 能力,
# 防 master sink call sites + 容器镜像版本错位的复发(症状:server-authored
# 文本截断,因为容器内 gateway 没有调 sink 的代码)。
#
# - oc.runtime.features: whitespace-separated token list。supervisor 用
#   case-sensitive 精确 token split 匹配("v3-sink" 命中,"V3-Sink" /
#   "v3sink" 不命中)
# - oc.runtime.git_sha: 与 v3 仓 HEAD 短 sha 一致($TAG 默认就是这个值,
#   上方 TAG 计算分支已 cd 到 SANDBOX_DIR 里 git rev-parse)
# OC_BUILD_NETWORK_HOST=1 → docker build 用宿主网络栈跑 RUN(buildkit --network=host)。
# 用于宿主 docker 容器 DNS 不可用(如 systemd-resolved 127.0.0.53 stub 未被 daemon.json
# DNS 兜底)时让 build 期 npm/playwright 能解析+走宿主代理。默认空=不加(v3 行为不变)。
#
# - model_authority_v1(2026-07-12,方案 §7 步 3/5):容器 gateway 消费 master 签名的
#   execution descriptor + hello attestation 的能力。**只有内嵌源码镜像(embed_source≠0)
#   才由镜像自证** —— 瘦身镜像的容器跑的是 runtime release 树的源码,能力声明在该 release
#   的 MANIFEST.capabilities(见 scripts/v5-runtime-release-lib.sh)。deploy 的兼容地板
#   (cutover 后)按这两处之一验证容器面能力,拒绝把 baked 判定的旧容器翻回来。
RUNTIME_FEATURES="v3-sink"
if [ "${OC_EMBED_SOURCE:-1}" != "0" ]; then
  RUNTIME_FEATURES="$RUNTIME_FEATURES model_authority_v1 lossless-turn-tape-v2"
fi
docker build \
  ${OC_BUILD_NETWORK_HOST:+--network=host} \
  --label "oc.runtime.features=$RUNTIME_FEATURES" \
  --label "oc.runtime.git_sha=$TAG" \
  --label "oc.runtime.source_commit=$SOURCE_COMMIT" \
  --label "oc.runtime.codex_version=$CODEX_VERSION" \
  --label "oc.runtime.include_codex=${OC_INCLUDE_CODEX:-1}" \
  --label "oc.runtime.embed_source=${OC_EMBED_SOURCE:-1}" \
  --build-arg "OC_INCLUDE_CODEX=${OC_INCLUDE_CODEX:-1}" \
  --build-arg "OC_EMBED_SOURCE=${OC_EMBED_SOURCE:-1}" \
  -f "$BUILD_CTX/Dockerfile.openclaude-runtime" \
  -t "$IMAGE_FULL" \
  "$BUILD_CTX"

IMAGE_SIZE_BYTES="$(docker image inspect "$IMAGE_FULL" --format '{{.Size}}')"
IMAGE_SIZE_MB="$(( IMAGE_SIZE_BYTES / 1024 / 1024 ))"
echo "[build-image] image size: ${IMAGE_SIZE_MB} MiB"

# ───────────────────────────────────────────────
# 3. docker save → gzip → tar.gz
# ───────────────────────────────────────────────
# OC_BUILD_SKIP_TAR=1 → **跳过整个 docker save + 压缩**(本步实测约占构建 ~55s,瓶颈是
#   docker save 读 1.4GB 镜像,不是压缩)。该 tar.gz 唯一硬用途是 **跨 compute host 分发**
#   (distribute-image-explicit.ts 读它传镜像);**单机池**(distribute 0 远端目标)用不到它,
#   镜像 build 完已在本地 docker store 直接可用,回滚走 OC_RUNTIME_IMAGE flip 回上一 tag
#   (image-gc 保留 last-3,本地 store 里仍在)。
#   ⚠️ **多机池 / 即将新增 compute host 时绝不要设此开关** —— 否则 distribute 无 tar 可传。
#   默认(不设)= 保持原行为,产出 tar(安全)。
if [ "${OC_BUILD_SKIP_TAR:-0}" = "1" ]; then
  echo "[build-image] OC_BUILD_SKIP_TAR=1 → 跳过 docker save|压缩(单机池;镜像已在本地 store,省 ~55s)"
  rm -f "${TAR_PATH}.partial" "$TAR_PATH"
  TAR_SIZE_MB="skipped"
  TAR_SHA256="skipped(OC_BUILD_SKIP_TAR=1)"
else
  TAR_TMP="${TAR_PATH}.partial"
  rm -f "$TAR_TMP" "$TAR_PATH"
  # 并行压缩:单线程 gzip 压 1.4GB 是可压缩耗时点(本机多核)。pigz 用满多核,**输出仍是
  # 标准 gzip 格式** —— 分发/回滚侧的 `gunzip -c | docker load` 完全不用改,零兼容风险。
  # pigz 不在则回退单线程 gzip。set -o pipefail 下 docker save 失败仍让整条管道失败(与原等价)。
  if command -v pigz >/dev/null 2>&1; then
    echo "[build-image] docker save | pigz(并行 $(nproc) 核)→ $TAR_PATH"
    docker save "$IMAGE_FULL" | pigz -c > "$TAR_TMP"
  else
    echo "[build-image] docker save | gzip(无 pigz,单线程回退)→ $TAR_PATH"
    docker save "$IMAGE_FULL" | gzip -c > "$TAR_TMP"
  fi
  mv "$TAR_TMP" "$TAR_PATH"
  chmod 0644 "$TAR_PATH"

  TAR_SIZE_BYTES="$(stat -c%s "$TAR_PATH")"
  TAR_SIZE_MB="$(( TAR_SIZE_BYTES / 1024 / 1024 ))"
  TAR_SHA256="$(sha256sum "$TAR_PATH" | awk '{print $1}')"
fi

# ───────────────────────────────────────────────
# 4. master-side image GC (保留最新 N 个 + latest + 当前在用 + 本次 build)
# ───────────────────────────────────────────────
image_gc

# ───────────────────────────────────────────────
# 5. summary
# ───────────────────────────────────────────────
cat <<EOF

[build-image] ====================================================================
[build-image]   tag        : $TAG
[build-image]   image      : $IMAGE_FULL
[build-image]   image size : ${IMAGE_SIZE_MB} MiB
[build-image]   tar path   : $TAR_PATH
[build-image]   tar size   : ${TAR_SIZE_MB} MiB
[build-image]   tar sha256 : $TAR_SHA256
[build-image] ====================================================================
EOF
if [ "${OC_BUILD_SKIP_TAR:-0}" = "1" ]; then
  cat <<EOF
[build-image]   tar 已跳过(OC_BUILD_SKIP_TAR=1)—— 镜像仅在本机 docker store。
[build-image]   单机池无需跨 host 传输;若要分发到其它 compute host,请去掉该开关重新 build。
[build-image] ====================================================================

EOF
else
  cat <<EOF
[build-image]   远端部署 (商用版 v3 生产 primary = 154.193.246.236 / ssh alias kl-mirror):
[build-image]     scp $TAR_PATH kl-mirror:/var/lib/openclaude-v3/images/
[build-image]     ssh kl-mirror "gunzip -c /var/lib/openclaude-v3/images/openclaude-runtime-${TAG}.tar.gz | docker load"
[build-image]     ssh kl-mirror "docker tag openclaude/openclaude-runtime:$TAG openclaude/openclaude-runtime:latest"
[build-image] ====================================================================

EOF
fi
