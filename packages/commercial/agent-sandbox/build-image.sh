#!/usr/bin/env bash
# v3 Phase 3B: openclaude-runtime 镜像 build + save 脚本
#
# 用法: ./build-image.sh [tag]   # tag 缺省 = 当前 v3 commit 短 sha
#
# 干啥(简单粗暴,符合 ops 脚本极简原则):
#   1. rsync 个人版源码到一个干净 build context(/tmp/oc-runtime-build/personal-version/)
#      —— 排除 node_modules / .git / dist / cache / *.log / 各种生成产物
#   2. 把 Dockerfile + runtime/ 也搬过去
#   3. docker build -t openclaude/openclaude-runtime:<tag>
#   4. docker save | gzip > /var/lib/openclaude-v3/images/openclaude-runtime-<tag>.tar.gz
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
# v3 仓库本身包含完整个人版代码树 (packages/{channels,cli,gateway,mcp-memory,plugin-sdk,protocol,storage,web} + claude-code-best)
# 外加 v3 专属的 packages/commercial/。从 v3 构建可以拿到所有 v3-only 的 gateway 修复
# (CCB 401、OAuth refresh、resume_failed 系列),不会再被 memory feedback_v3_image_built_from_master
# 里描述的"重建镜像丢 v3 修复"坑炸。rsync 时排除 packages/commercial/ 即可避免容器
# 里混入商用版代码。
PERSONAL_SRC="/opt/openclaude/openclaude-v3"
SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"  # 本脚本所在目录(agent-sandbox/)
BUILD_CTX="/tmp/oc-runtime-build"
IMAGE_REPO="openclaude/openclaude-runtime"
IMAGE_OUT_DIR="/var/lib/openclaude-v3/images"

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

echo "[build-image] tag=$TAG"
echo "[build-image] image=$IMAGE_FULL"
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

if [ ! -d "$PERSONAL_SRC" ]; then
  echo "[build-image] FATAL: 个人版源码不存在: $PERSONAL_SRC" >&2
  exit 1
fi

if [ ! -f "$SANDBOX_DIR/Dockerfile.openclaude-runtime" ]; then
  echo "[build-image] FATAL: Dockerfile 不存在: $SANDBOX_DIR/Dockerfile.openclaude-runtime" >&2
  exit 1
fi

if [ ! -d "$SANDBOX_DIR/runtime" ]; then
  echo "[build-image] FATAL: runtime 目录不存在: $SANDBOX_DIR/runtime" >&2
  exit 1
fi

mkdir -p "$IMAGE_OUT_DIR"

# ───────────────────────────────────────────────
# 1. 准备 build context
# ───────────────────────────────────────────────
# 不复用旧 BUILD_CTX(避免上一次残留污染),整个 wipe 重建
rm -rf "$BUILD_CTX"
mkdir -p "$BUILD_CTX/personal-version"

# 0. **预构建 claude-code-best dist** (容器内只有 node,没有 bun,需 prebuild)
#    build.ts 走 Bun.build target=bun,后处理 import.meta.require → node 兼容
#    产物 node dist/cli.js 直接可跑(MACRO defines 已烤进产物)
if ! command -v bun >/dev/null 2>&1; then
  echo "[build-image] FATAL: 没 bun (~/.bun/bin/bun) — 无法 prebuild claude-code-best/dist" >&2
  exit 1
fi
if [ -d "$PERSONAL_SRC/claude-code-best" ]; then
  echo "[build-image] prebuild $PERSONAL_SRC/claude-code-best/dist (bun)"
  ( cd "$PERSONAL_SRC/claude-code-best" && bun install --silent && bun run build ) \
    || { echo "[build-image] FATAL: ccb prebuild 失败" >&2; exit 1; }
  if [ ! -f "$PERSONAL_SRC/claude-code-best/dist/cli.js" ]; then
    echo "[build-image] FATAL: prebuild 完成但 dist/cli.js 不存在" >&2
    exit 1
  fi
fi

echo "[build-image] rsync $PERSONAL_SRC → $BUILD_CTX/personal-version/"
# --delete 让 dest 和 src 完全一致;
# 排除所有镜像里不需要 + 体积大的东西:node_modules(容器内 npm install 重装),
# .git / dist / build 产物 / 缓存 / 日志 / IDE / OS 杂物。
#
# v3 leak hardening (2026-04-29) — 紧跟下面那一组 `/foo` 锚定 exclude:
#   镜像 /opt/openclaude/ 在容器内 agent shell 可读。容器只跑 npm run gateway
#   (走 packages/cli),根目录 *.md / docs / evals / infra / deploy / scripts
#   对 runtime 0 依赖,但暴露 boss 名字 / 45.32 master / Codex workflow /
#   内网 IP / SSH 凭据路径等平台敏感信息。Layer 1 (subprocessRunner.ts
#   --setting-sources user) 已堵住 ccb 自动加载注入,本组 exclude 关闭剩余
#   "用户 cat 直读" 攻击面。
#   '/foo' 锚定 src 根,不会误删 packages/*/foo 之类的同名 child
#   (claude-code-best/scripts/ 等保留)。用户数据走 named volume +
#   /run/oc/claude-config tmpfs,与 build context 0 重叠,不受影响。
rsync -a --delete \
  --exclude='node_modules/' \
  --exclude='.git/' \
  --exclude='.gitignore' \
  --exclude='/dist/' \
  --exclude='build/' \
  --exclude='packages/commercial/' \
  --exclude='packages/commercial' \
  --exclude='.next/' \
  --exclude='.turbo/' \
  --exclude='coverage/' \
  --exclude='.cache/' \
  --exclude='.npm/' \
  --exclude='.bun/' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='.vscode/' \
  --exclude='.idea/' \
  --exclude='tmp/' \
  --exclude='.tmp/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.openclaude/' \
  --exclude='.openclaude-dev/' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude='.ssh/' \
  --exclude='.aws/' \
  --exclude='.gnupg/' \
  --exclude='.npmrc' \
  --exclude='.netrc' \
  --exclude='.bash_history' \
  --exclude='.zsh_history' \
  --exclude='.claude/' \
  --exclude='.codex/' \
  --exclude='.codex' \
  --exclude='.playwright-mcp/' \
  --exclude='/CLAUDE.md' \
  --exclude='/README.md' \
  --exclude='/AUDIT_REMEDIATION_TASKS_*.md' \
  --exclude='/CCB_ASSISTANT_REFACTOR_PLAN_*.md' \
  --exclude='/docs/' \
  --exclude='/evals/' \
  --exclude='/infra/' \
  --exclude='/deploy/' \
  --exclude='/scripts/' \
  --exclude='/claude-code-best/CLAUDE.md' \
  --exclude='/claude-code-best/DEV-LOG.md' \
  --exclude='/claude-code-best/README.md' \
  --exclude='/claude-code-best/SECURITY.md' \
  --exclude='/claude-code-best/TODO.md' \
  --exclude='/claude-code-best/docs/' \
  "$PERSONAL_SRC/" "$BUILD_CTX/personal-version/"

# 2. Dockerfile + runtime/
cp "$SANDBOX_DIR/Dockerfile.openclaude-runtime" "$BUILD_CTX/Dockerfile.openclaude-runtime"
rm -rf "$BUILD_CTX/runtime"
cp -r "$SANDBOX_DIR/runtime" "$BUILD_CTX/runtime"

CTX_BYTES="$(du -sb "$BUILD_CTX" | awk '{print $1}')"
CTX_MB="$(( CTX_BYTES / 1024 / 1024 ))"
echo "[build-image] build context ready: ${CTX_MB} MiB at $BUILD_CTX"

# ───────────────────────────────────────────────
# 2. docker build
# ───────────────────────────────────────────────
echo "[build-image] docker build → $IMAGE_FULL"
docker build \
  -f "$BUILD_CTX/Dockerfile.openclaude-runtime" \
  -t "$IMAGE_FULL" \
  "$BUILD_CTX"

IMAGE_SIZE_BYTES="$(docker image inspect "$IMAGE_FULL" --format '{{.Size}}')"
IMAGE_SIZE_MB="$(( IMAGE_SIZE_BYTES / 1024 / 1024 ))"
echo "[build-image] image size: ${IMAGE_SIZE_MB} MiB"

# ───────────────────────────────────────────────
# 3. docker save → gzip → tar.gz
# ───────────────────────────────────────────────
TAR_TMP="${TAR_PATH}.partial"
rm -f "$TAR_TMP" "$TAR_PATH"
echo "[build-image] docker save | gzip → $TAR_PATH"
docker save "$IMAGE_FULL" | gzip -c > "$TAR_TMP"
mv "$TAR_TMP" "$TAR_PATH"
chmod 0644 "$TAR_PATH"

TAR_SIZE_BYTES="$(stat -c%s "$TAR_PATH")"
TAR_SIZE_MB="$(( TAR_SIZE_BYTES / 1024 / 1024 ))"
TAR_SHA256="$(sha256sum "$TAR_PATH" | awk '{print $1}')"

# ───────────────────────────────────────────────
# 4. master-side image GC (保留最新 N 个 + latest + 当前在用 + 本次 build)
# ───────────────────────────────────────────────
# 背景:每次 build 在 master 同时累积一份 docker image (~3.5GB) 和一份
# tar.gz (~660MB)。8 个 tag 就能把 49GB 根盘打到 99% (历史事件 2026-04-29)。
#
# 远端 host 已有 _pruneRemoteStaleImages 在分发后自动清旧 tag,master 没有
# 对应路径,所以这里收尾。
#
# 触发点:仅 build-image.sh 末尾。**不**写 systemd timer / cron — build 是
# rebuild 的唯一入口,GC 频率 ≈ 累积频率,自然平衡。
#
# 保留集 = {本次 build $TAG} ∪ {latest} ∪ {OC_RUNTIME_IMAGE 当前指向 tag}
#         ∪ {top OC_IMAGE_KEEP_LAST 个 by created desc}
#
# 边界:
#   - in-use image rmi 自然 fail,best-effort skip(脚本不抛)
#   - 不调 docker image prune / system prune(多租户主机越权 — archival
#     arc-mof4luq1-r9o8ze 教训)
#   - 不删 latest tag 自身
#   - 不动 dangling <none>:<none>
#   - 不删 build cache(boss 自管 docker builder prune)
#
# Env switches:
#   OC_IMAGE_KEEP_LAST=N      # 默认 3
#   OC_IMAGE_GC=0             # 整体跳过 GC(冻结历史 / 调试)
#   OC_IMAGE_GC_DRY_RUN=1     # 打印待清单不执行
if [ "${OC_IMAGE_GC:-1}" = "0" ]; then
  echo "[build-image] image-gc skipped (OC_IMAGE_GC=0)"
else
  KEEP_LAST="${OC_IMAGE_KEEP_LAST:-3}"
  DRY_RUN="${OC_IMAGE_GC_DRY_RUN:-0}"
  ENV_FILE="/etc/openclaude/commercial.env"

  # 当前在用 tag(从 OC_RUNTIME_IMAGE env 提取 ":<tag>" 部分)
  # 文件不存在 / 行不存在都返回空字符串,不让 set -e 中断
  CURRENT_TAG=""
  if [ -f "$ENV_FILE" ]; then
    OC_LINE="$(grep -E '^OC_RUNTIME_IMAGE=' "$ENV_FILE" 2>/dev/null || true)"
    if [ -n "$OC_LINE" ]; then
      # OC_RUNTIME_IMAGE=openclaude/openclaude-runtime:<tag>  →  <tag>
      CURRENT_TAG="$(printf '%s' "$OC_LINE" | sed -n 's/^OC_RUNTIME_IMAGE=.*:\([^[:space:]]*\)$/\1/p')"
    fi
  fi

  # 列出本仓所有 tag,按 docker images 默认 created desc 顺序
  # --format 用 \t 分隔,docker 自身保证 created desc(最新在前)
  ALL_TAGS_FILE="$(mktemp)"
  trap 'rm -f "$ALL_TAGS_FILE"' EXIT
  docker images "$IMAGE_REPO" --format '{{.Tag}}' > "$ALL_TAGS_FILE" 2>/dev/null || true

  # 构建 keep set (用 newline-separated 文本,grep -F -x -f 比较)。
  # 选 top KEEP_LAST 个历史 tag 时:**先**过滤掉 latest / TAG / CURRENT_TAG,
  # 否则它们会占 KEEP_LAST 槽位,实际保留的独立历史版本数 < KEEP_LAST。
  KEEP_FILE="$(mktemp)"
  trap 'rm -f "$ALL_TAGS_FILE" "$KEEP_FILE"' EXIT
  PROTECT_FILE="$(mktemp)"
  trap 'rm -f "$ALL_TAGS_FILE" "$KEEP_FILE" "$PROTECT_FILE"' EXIT
  {
    echo "$TAG"
    echo "latest"
    [ -n "$CURRENT_TAG" ] && echo "$CURRENT_TAG"
  } | sort -u > "$PROTECT_FILE"
  # `|| true` 兜底:全新机器首次 build 时 ALL_TAGS - PROTECT 可能为空,grep -v
  # 无匹配返回 exit 1,set -euo pipefail 下会让外层 { } 子块中断。
  {
    cat "$PROTECT_FILE"
    { grep -v '^<none>$' "$ALL_TAGS_FILE" | grep -F -x -v -f "$PROTECT_FILE" | head -n "$KEEP_LAST"; } || true
  } | sort -u > "$KEEP_FILE"

  # 待清 = ALL - KEEP, 跳过 <none>
  STALE_TAGS="$(grep -v '^<none>$' "$ALL_TAGS_FILE" | grep -F -x -v -f "$KEEP_FILE" || true)"

  echo "[build-image] image-gc keep_last=$KEEP_LAST dry_run=$DRY_RUN current_tag=${CURRENT_TAG:-<none>}"
  echo "[build-image] image-gc keep set:"
  sed 's/^/  - /' "$KEEP_FILE"

  if [ -z "$STALE_TAGS" ]; then
    echo "[build-image] image-gc no stale tags to remove"
  else
    echo "[build-image] image-gc stale tags:"
    printf '  - %s\n' $STALE_TAGS
    if [ "$DRY_RUN" = "1" ]; then
      echo "[build-image] image-gc DRY_RUN — no changes"
    else
      for t in $STALE_TAGS; do
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
    fi
  fi
fi

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
[build-image]   远端部署 (商用版 v3 生产 = 34.146.172.239 / ssh alias commercial-v3):
[build-image]     scp $TAR_PATH commercial-v3:/var/lib/openclaude-v3/images/
[build-image]     ssh commercial-v3 "gunzip -c /var/lib/openclaude-v3/images/openclaude-runtime-${TAG}.tar.gz | docker load"
[build-image]     ssh commercial-v3 "docker tag openclaude/openclaude-runtime:$TAG openclaude/openclaude-runtime:latest"
[build-image] ====================================================================

EOF
