# shellcheck shell=bash
# v5-runtime-release-lib.sh —— runtime tuple / platform bundle 的**宿主本地纯函数库**。
#
# 设计不变量(RFC docs/V5_RUNTIME_HOTCFG_PLAN.md §1.1/1.2/1.5/3.1):
#   - 本文件**不含任何 ssh**。所有函数只操作"当前主机的本地文件系统 + 本地命令"。
#     · 真实部署:deploy-v5.sh 把本文件 ship 到 kl-mirror 后 source,函数在制品所在主机
#       (制品 /var/lib/openclaude-v5/... 与 docker/bun 都在那台)本地执行 → digest 在
#       制品真实树上算,权威唯一。
#     · 自测:直接 source 本文件,用 env 覆盖根路径指向 /tmp 假树、OC_DOCKER_BIN 指向
#       stub,即可本地干跑 bundle 构建 / digest 幂等 / GC 保护集 / 激活 saga 回滚。
#     → 同一份代码两处跑 = 无第二权威源、无漂移(CLAUDE.md「权威源不分裂」)。
#   - digest 契约(四 agent 统一):对**规范化相对路径 LC_ALL=C 排序**后的每个正则文件,
#     取行 (path + NUL + sha256 + NUL + mode + LF) 顺序拼接求 sha256 → 前 12 hex。
#     忽略 uid/gid/mtime;mode = `stat -c %a`(八进制无前导 0,如 755/644)。bootHash 同法
#     但仅 entrypoint/ 与 seed/ 前缀行。**awk 的 \0 会截断格式串,故 digest 一律 bash printf。**
#   - MANIFEST.json 由本库生成(jq 组装),files[] **不含 MANIFEST 自身**。
#
# 依赖(kl-mirror 与自测机都具备):bash4+ / jq / sha256sum / find(GNU 兼容)/ sort / xargs /
#   stat / date / mv / ln / rm / cp。docker/bun 仅 release 面用,经 OC_DOCKER_BIN / OC_BUN_BIN
#   间接调用(自测可 stub)。

# ── 根路径 / 权威文件(deploy-v5.sh 或自测可用 env 覆盖;`:-` 保证不覆盖调用方已设值)──
: "${OC_HOTCFG_PLATFORM_ROOT:=/var/lib/openclaude-v5/platform}"
: "${OC_HOTCFG_RELEASES_ROOT:=/var/lib/openclaude-v5/runtime-releases}"
: "${OC_HOTCFG_ENV_FILE:=/etc/openclaude/commercial-v5.env}"
: "${OC_HOTCFG_HISTORY:=/etc/openclaude/runtime-tuple.history}"
: "${OC_HOTCFG_KEEP_TUPLES:=5}"       # GC 保护:history 最近 N 条 committed tuple 引用
: "${OC_DOCKER_BIN:=docker}"          # 自测 stub 注入点
: "${OC_BUN_BIN:=}"                   # 空 → 运行期解析(~/.bun/bin/bun 或 PATH)

# tuple 四键(激活原子单元;emergency 是第 5 个独立键,不随普通激活写)。顺序即写入/快照顺序。
OC_HOTCFG_TUPLE_KEYS=(OC_RUNTIME_IMAGE OC_RUNTIME_IMAGE_ID OC_RUNTIME_RELEASE OC_PLATFORM_BUNDLE)
OC_HOTCFG_EMERGENCY_KEY="OC_RUNTIME_EMERGENCY_TUPLE"

# ── 模型权威兼容地板(方案 §7 步 5,R3-B4 + R4-M2)────────────────────────────
# 容器面 capability token(= protocol MODEL_AUTHORITY_CAPABILITY = hello attestation 字符串)。
# 容器代码的来源有两处,故 capability 的自证也有两处(取哪处取决于 tuple 的 release 是否为空):
#   - release 轴启用 → 容器跑 release 树的源码 → 声明在 release 的 MANIFEST.capabilities;
#   - release 为空(内嵌源码镜像 / emergency 逃生)→ 容器跑镜像 baked 源码 → 声明在
#     镜像 label `oc.runtime.features`(build-image.sh 写,token 空格分隔)。
# cutover marker(env 键)置位后,任何 tuple 激活/回滚都必须证明容器面带该 capability,
# 否则 = 容器退回 baked 判定,而 DB catalog 里已经有 baked 不认识的行 → 判定源分叉。
OC_HOTCFG_MODEL_AUTHORITY_CAP="model_authority_v1"
OC_HOTCFG_MODEL_AUTHORITY_CUTOVER_KEY="OC_MODEL_AUTHORITY_CUTOVER"
OC_HOTCFG_IMAGE_FEATURES_LABEL="oc.runtime.features"
OC_HOTCFG_LOSSLESS_TURN_TAPE_CAP="lossless-turn-tape-v2"
OC_HOTCFG_LOSSLESS_RUNTIME_BATCH_CAP="lossless-turn-runtime-batch-v1"

# bundle 顶层目录白名单(§1.2:与 TS 侧 platformBundle.ts 校验语义一致的 bash 版)。
OC_HOTCFG_BUNDLE_TOPDIRS="bin entrypoint etc-codex codex-skills seed prompts"
# 允许扩展名(§1.3)。
OC_HOTCFG_BUNDLE_EXTS="sh py ts toml md yaml json"
# 敏感名 denylist(§1.3 / §3.1 产物阶段扫描)。find -name 通配。
OC_HOTCFG_SENSITIVE_GLOBS='.env* id_rsa* *.pem *.key .npmrc .netrc'
# bundle 结构上限(§1.3)。
OC_HOTCFG_BUNDLE_MAX_FILE=$((1024 * 1024))         # 单文件 ≤1MB
OC_HOTCFG_BUNDLE_MAX_TOTAL=$((32 * 1024 * 1024))   # 总量 ≤32MB
OC_HOTCFG_BUNDLE_MAX_ENTRIES=512
OC_HOTCFG_BUNDLE_MAX_DEPTH=6

# bundle 必需叶子清单(M8)。finalize_bundle 校验每一项都存在,缺任一 fail-loud。
# ⚠ **与 TS 侧 packages/commercial/src/agent-sandbox/platformBundle.ts 的 PLATFORM_BUNDLE_REQUIRED_LEAVES
#   完全同列表 —— 两侧同步义务**:改任一侧必同改另一侧,runtimeArtifactConformance.test.ts 用真实
#   fixture 双跑锁死(fixture 缺任一叶子即红)。这些是 supervisor/entrypoint/gateway 冷启必须存在的
#   平台配置叶子(缺则容器起不来/gateway LKG 快照读空)。bin/ 叶子按**剥扩展名后**的 PATH 命令名列
#   (源仓是 bin/oc-web-context.py,finalize 剥名后才校验;R2-M2①,supervisor WEB_CONTEXT_BIN 依赖)。
OC_HOTCFG_BUNDLE_REQUIRED_LEAVES=(
  bin/oc-web-context
  entrypoint/entrypoint.ts
  entrypoint/platformBundle.ts
  seed/platform-seed.yaml
  prompts/platform-capabilities.md
  prompts/memory-instructions.md
  prompts/codex-preamble.md
  etc-codex/managed_config.toml
)

oc_hotcfg__die() { echo "FATAL[hotcfg]: $*" >&2; return 1; }
oc_hotcfg__log() { echo "  [hotcfg] $*" >&2; }

# ─────────────────────────── digest / MANIFEST 核心 ───────────────────────────

# 产出**已按 path LC_ALL=C 排序**的文件行 TSV:<relpath>\t<sha256>\t<size>\t<mode>。
# 排除根下 MANIFEST.json(与 .tmp)。并行 sha256(xargs -P nproc)后再按 path 重排 → 既快又确定。
# 注:release node_modules 可含数万文件;假设路径无 TAB/换行(bundle selfcheck 强制,npm 包名规范)。
#
# **符号链接(M6)**:release 树(node_modules 的 .bin/* 等)常含 symlink,须纳入 digest 才能
# 让"仅 symlink 目标不同"的树产生不同 digest。symlink 行 = `path\tlink:<readlink 原始 target>\t0\t777`
# —— sha256 字段放**字面** `link:<target>`、size=0、mode=777(与 TS 侧 ManifestFileEntry symlink 编码
# 逐字节一致)。digest_from_rows 只用 (path, sha256字段, mode),故 symlink 与常规文件同一拼行规则。
# bundle 侧 selfcheck 仍**拒** symlink(bundle 无 symlink),故 bundle digest 不受本分支影响。
oc_hotcfg__file_rows() {
  local root="$1"
  [ -d "$root" ] || { oc_hotcfg__die "file_rows: 目录不存在 $root"; return 1; }
  ( cd "$root" || exit 1
    {
      find . -type f ! -name 'MANIFEST.json' ! -name 'MANIFEST.json.tmp' -print0 \
        | xargs -0 -P"$(nproc)" -I '{}' sh -c '
            f=${1#./}
            h=$(sha256sum "$1" | cut -d" " -f1) || exit 1
            s=$(stat -c "%s" "$1") || exit 1
            m=$(stat -c "%a" "$1") || exit 1
            printf "%s\t%s\t%s\t%s\n" "$f" "$h" "$s" "$m"
          ' _ '{}'
      # symlink 行:sha256 字段=字面 link:<原始 target(readlink,不解析)>,size=0,mode=777
      find . -type l -print0 \
        | xargs -0 -P"$(nproc)" -I '{}' sh -c '
            f=${1#./}
            t=$(readlink "$1") || exit 1
            printf "%s\tlink:%s\t0\t777\n" "$f" "$t"
          ' _ '{}'
    } | LC_ALL=C sort -t "$(printf '\t')" -k1,1
  )
}

# TSV(stdin) → files[] JSON 数组。size 转数字。
oc_hotcfg__rows_to_json() {
  jq -R -s -c '
    split("\n") | map(select(length > 0)) | map(split("\t"))
    | map({path: .[0], sha256: .[1], size: (.[2] | tonumber), mode: .[3]})
  '
}

# TSV(stdin) → 12hex digest。$1: all|boot(boot 仅 entrypoint/ 与 seed/ 前缀行)。
# **bash printf 逐行输出真实 NUL 字节**(awk 会在 \0 处截断格式串,故不可用 awk)。
oc_hotcfg__digest_from_rows() {
  local mode="${1:-all}" p h s m
  {
    while IFS=$'\t' read -r p h s m; do
      [ -n "$p" ] || continue
      if [ "$mode" = boot ]; then
        case "$p" in entrypoint/*|seed/*) : ;; *) continue ;; esac
      fi
      printf '%s\0%s\0%s\n' "$p" "$h" "$m"
    done
  } | sha256sum | cut -c1-12
}

# 在 <root> 写 MANIFEST.json 并 echo digest。
# 用法:oc_hotcfg_build_manifest <root> <schemaVersion> <sourceCommit> [bunVersion] [depsCacheKey] [ccbDistKey] [capabilities]
# capabilities:空格分隔 token(如 "model_authority_v1")→ MANIFEST.capabilities 数组。
#   **不进 digest**(digest 只认文件内容行)—— capability 是"这棵树实现了什么协议"的**声明**,
#   由制品的权威源(deploy/v5/release-metadata.json.runtimeCapabilities,与源码同 commit)提供;
#   digest 相同的树声明必然相同,故同 rev 复用时若发现声明漂移(旧制品建于本特性之前)可就地补写。
oc_hotcfg_build_manifest() {
  local root="$1" schema="$2" commit="$3" bun="${4:-}" cache="${5:-}" ccbkey="${6:-}" caps="${7:-}"
  local rows digest boothash builtAt files_tmp caps_json
  caps_json="$(printf '%s' "$caps" | tr ' ' '\n' | jq -R -s -c 'split("\n") | map(select(length > 0))')" || return 1
  rows="$(oc_hotcfg__file_rows "$root")" || return 1
  digest="$(printf '%s\n' "$rows" | oc_hotcfg__digest_from_rows all)" || return 1
  boothash="$(printf '%s\n' "$rows" | oc_hotcfg__digest_from_rows boot)" || return 1
  builtAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # files[] 经临时文件 + --slurpfile 传入:release 树数万文件的 JSON 几十 MB,走 --argjson
  # 会撑爆 execve 参数上限(2026-07-12 首启实测 jq: Argument list too long)。
  files_tmp="$(mktemp)"
  if ! printf '%s\n' "$rows" | oc_hotcfg__rows_to_json > "$files_tmp"; then rm -f "$files_tmp"; return 1; fi
  jq -n \
    --argjson schemaVersion "$schema" \
    --arg digest "$digest" --arg bootHash "$boothash" \
    --arg sourceCommit "$commit" --arg builtAt "$builtAt" \
    --arg bunVersion "$bun" --arg depsCacheKey "$cache" --arg ccbDistKey "$ccbkey" \
    --argjson capabilities "$caps_json" \
    --slurpfile files "$files_tmp" '
    {schemaVersion: $schemaVersion, digest: $digest, bootHash: $bootHash,
     sourceCommit: $sourceCommit, builtAt: $builtAt, capabilities: $capabilities, files: $files[0]}
    + (if $bunVersion == "" then {} else {bunVersion: $bunVersion} end)
    + (if $depsCacheKey == "" then {} else {depsCacheKey: $depsCacheKey} end)
    + (if $ccbDistKey == "" then {} else {ccbDistKey: $ccbDistKey} end)
  ' > "$root/MANIFEST.json.tmp" || { rm -f "$files_tmp"; return 1; }
  rm -f "$files_tmp"
  mv -f "$root/MANIFEST.json.tmp" "$root/MANIFEST.json" || return 1
  printf '%s\n' "$digest"
}

# MANIFEST.capabilities 就地补写(幂等)。MANIFEST.json 不进 file_rows/digest,故改它不动 digest,
# 也不影响 verify_manifest_full/sampled(两者只比对 .files[] 与实际文件)。
oc_hotcfg__patch_manifest_capabilities() {
  local root="$1" caps="${2:-}" want have tmp
  [ -f "$root/MANIFEST.json" ] || { oc_hotcfg__die "patch_capabilities: 缺 MANIFEST.json @ $root"; return 1; }
  want="$(printf '%s' "$caps" | tr ' ' '\n' | jq -R -s -c 'split("\n") | map(select(length > 0)) | sort')" || return 1
  have="$(jq -c '(.capabilities // []) | sort' "$root/MANIFEST.json")" || return 1
  [ "$have" = "$want" ] && return 0
  tmp="$root/MANIFEST.json.tmp"
  jq --argjson capabilities "$(printf '%s' "$caps" | tr ' ' '\n' | jq -R -s -c 'split("\n") | map(select(length > 0))')" \
     '.capabilities = $capabilities' "$root/MANIFEST.json" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$root/MANIFEST.json" || return 1
  oc_hotcfg__log "MANIFEST.capabilities 补写 @ $root: $have → $want"
}

# 全量重校验:重算 digest 并与 MANIFEST.json.digest 比对(用于同 rev 目录已存在时的幂等信任前置,
# R3-minor:不能仅因目录存在就信任)。bundle 用(文件少);release 全量太贵,改用抽样版。
oc_hotcfg_verify_manifest_full() {
  local root="$1" rows have want
  [ -f "$root/MANIFEST.json" ] || { oc_hotcfg__die "verify: 缺 MANIFEST.json @ $root"; return 1; }
  want="$(jq -r '.digest // empty' "$root/MANIFEST.json")" || return 1
  [ -n "$want" ] || { oc_hotcfg__die "verify: MANIFEST 无 digest @ $root"; return 1; }
  rows="$(oc_hotcfg__file_rows "$root")" || return 1
  have="$(printf '%s\n' "$rows" | oc_hotcfg__digest_from_rows all)" || return 1
  [ "$have" = "$want" ] || { oc_hotcfg__die "verify: digest 不符 @ $root (实算=$have manifest=$want)"; return 1; }
  return 0
}

# 抽样重校验(release 大树):文件数一致 + 随机 N 个文件 sha256 与 MANIFEST 相符。
# 取样理由:release 含 node_modules 数万文件,全量 sha256 每次幂等命中都跑一遍代价过高;
# 目录已 content-addressed 命名(digest 前 12 hex 撞库概率极低),抽样足以抓到"目录被篡改/半写"。
oc_hotcfg_verify_manifest_sampled() {
  local root="$1" n="${2:-64}" mf_count fs_count bad=0 line p want have
  [ -f "$root/MANIFEST.json" ] || { oc_hotcfg__die "verify: 缺 MANIFEST.json @ $root"; return 1; }
  mf_count="$(jq -r '.files | length' "$root/MANIFEST.json")" || return 1
  # 文件计数须与 MANIFEST 一致 —— MANIFEST 含常规文件 + symlink(M6),故 fs 计数两类都算。
  fs_count="$(cd "$root" && find . \( \( -type f ! -name 'MANIFEST.json' \) -o -type l \) -printf '.' | wc -c)" || return 1
  [ "$mf_count" = "$fs_count" ] || { oc_hotcfg__die "verify: 文件数不符 @ $root (manifest=$mf_count fs=$fs_count)"; return 1; }
  # 随机取 N 行 {path,sha256} 校验。link:<target> 行改比 readlink 一致(sha256sum 会跟随软链取目标 hash,
  # 与字面 link:<target> 恒不符,故必须分流,M6)。
  while IFS=$'\t' read -r p want; do
    [ -n "$p" ] || continue
    case "$want" in
      link:*)
        have="link:$(readlink "$root/$p" 2>/dev/null)"
        [ "$have" = "$want" ] || { echo "  [hotcfg] 抽样 symlink 不符: $p (实=$have manifest=$want)" >&2; bad=1; } ;;
      *)
        have="$(sha256sum "$root/$p" 2>/dev/null | cut -d' ' -f1)"
        [ "$have" = "$want" ] || { echo "  [hotcfg] 抽样不符: $p" >&2; bad=1; } ;;
    esac
  done < <(jq -r '.files[] | [.path, .sha256] | @tsv' "$root/MANIFEST.json" | shuf | head -n "$n")
  [ "$bad" = 0 ] || { oc_hotcfg__die "verify: 抽样 sha256 不符 @ $root"; return 1; }
  return 0
}

# ─────────────────────────── 敏感文件扫描 ───────────────────────────
# 命中任一敏感名即 fail(§3.1 产物阶段红线)。bundle 与 release 产物都过。
oc_hotcfg_scan_sensitive() {
  local root="$1" g hit=0 found
  for g in $OC_HOTCFG_SENSITIVE_GLOBS; do
    found="$(cd "$root" && find . -name "$g" -print 2>/dev/null | head -5)"
    if [ -n "$found" ]; then
      echo "  [hotcfg] 敏感文件命中 '$g':" >&2; printf '    %s\n' $found >&2; hit=1
    fi
  done
  [ "$hit" = 0 ] || { oc_hotcfg__die "scan_sensitive: 产物含敏感文件,拒绝发布 @ $root"; return 1; }
  return 0
}

# ─────────────────────────── bundle 结构自检(§1.3 轻量 bash 版)───────────────────────────
oc_hotcfg_selfcheck_bundle() {
  local root="$1" e name base ext total entries depth bad=0
  [ -d "$root" ] || { oc_hotcfg__die "selfcheck: 目录不存在 $root"; return 1; }
  # 1) 顶层白名单:目录 ∈ TOPDIRS,文件仅 MANIFEST.json
  for e in "$root"/* "$root"/.*; do
    [ -e "$e" ] || continue
    base="$(basename "$e")"
    case "$base" in .|..) continue ;; esac
    if [ -d "$e" ]; then
      case " $OC_HOTCFG_BUNDLE_TOPDIRS " in *" $base "*) : ;; *)
        echo "  [hotcfg] 顶层非白名单目录: $base" >&2; bad=1 ;; esac
    elif [ -f "$e" ]; then
      [ "$base" = "MANIFEST.json" ] || { echo "  [hotcfg] 顶层非法文件: $base" >&2; bad=1; }
    else
      echo "  [hotcfg] 顶层非常规条目(symlink/设备/socket): $base" >&2; bad=1
    fi
  done
  # 2) 逐文件:类型(拒 symlink/设备/FIFO/socket/nlink>1)、扩展名白名单、单文件大小
  while IFS= read -r -d '' e; do
    if [ -L "$e" ]; then echo "  [hotcfg] 含 symlink: ${e#"$root"/}" >&2; bad=1; continue; fi
    if [ ! -f "$e" ]; then echo "  [hotcfg] 非常规文件: ${e#"$root"/}" >&2; bad=1; continue; fi
    local nlink; nlink="$(stat -c '%h' "$e")"
    [ "$nlink" -le 1 ] || { echo "  [hotcfg] 硬链接 nlink=$nlink: ${e#"$root"/}" >&2; bad=1; }
    name="$(basename "$e")"; ext="${name##*.}"
    # bin/ 例外(与 TS 侧 platformBundle.ts collectBundleFiles 同规则):bin/ 下必须
    # **无扩展名**(PATH 命令名即工具名;finalize_bundle 已剥 .sh/.py),其余目录走白名单。
    case "${e#"$root"/}" in
      bin/*)
        if [ "$ext" != "$name" ]; then
          echo "  [hotcfg] bin/ 下必须无扩展名(finalize 剥失败?): ${e#"$root"/}" >&2; bad=1
        fi ;;
      *)
        if [ "$ext" = "$name" ]; then
          echo "  [hotcfg] 无扩展名文件(白名单外): ${e#"$root"/}" >&2; bad=1
        else
          case " $OC_HOTCFG_BUNDLE_EXTS " in *" $ext "*) : ;; *)
            echo "  [hotcfg] 扩展名 .$ext 不在白名单: ${e#"$root"/}" >&2; bad=1 ;; esac
        fi ;;
    esac
    local sz; sz="$(stat -c '%s' "$e")"
    [ "$sz" -le "$OC_HOTCFG_BUNDLE_MAX_FILE" ] || { echo "  [hotcfg] 单文件超 1MB($sz): ${e#"$root"/}" >&2; bad=1; }
  done < <(find "$root" -type f ! -name 'MANIFEST.json' -print0)
  # 3) 总量 / 条目数 / 深度上限(超限**拒绝**而非截断放行)
  entries="$(find "$root" ! -name 'MANIFEST.json' -mindepth 1 | wc -l)"
  [ "$entries" -le "$OC_HOTCFG_BUNDLE_MAX_ENTRIES" ] || { echo "  [hotcfg] 条目数 $entries > $OC_HOTCFG_BUNDLE_MAX_ENTRIES" >&2; bad=1; }
  total="$(du -sb --exclude MANIFEST.json "$root" | cut -f1)"
  [ "$total" -le "$OC_HOTCFG_BUNDLE_MAX_TOTAL" ] || { echo "  [hotcfg] 总量 $total > $OC_HOTCFG_BUNDLE_MAX_TOTAL" >&2; bad=1; }
  depth="$(find "$root" -type f -printf '%d\n' | sort -n | tail -1)"; depth="${depth:-0}"
  [ "$depth" -le "$OC_HOTCFG_BUNDLE_MAX_DEPTH" ] || { echo "  [hotcfg] 目录深度 $depth > $OC_HOTCFG_BUNDLE_MAX_DEPTH" >&2; bad=1; }
  # 4) 敏感名
  oc_hotcfg_scan_sensitive "$root" || bad=1
  [ "$bad" = 0 ] || { oc_hotcfg__die "selfcheck_bundle: 结构校验失败 @ $root"; return 1; }
  oc_hotcfg__log "bundle 结构自检通过(entries=$entries total=${total}B depth=$depth)"
  return 0
}

# 必需叶子校验(M8,单一权威;finalize_bundle 与 write_emergency_tuple 共用):
# 平台冷启/gateway LKG 快照依赖的叶子必须齐全,缺任一 fail-loud。
# 清单 = OC_HOTCFG_BUNDLE_REQUIRED_LEAVES(与 TS PLATFORM_BUNDLE_REQUIRED_LEAVES 同步义务,见其定义处)。
oc_hotcfg_assert_required_leaves() {
  local root="$1" leaf missing=0
  for leaf in "${OC_HOTCFG_BUNDLE_REQUIRED_LEAVES[@]}"; do
    [ -f "$root/$leaf" ] || { echo "  [hotcfg] 缺必需叶子: $leaf" >&2; missing=1; }
  done
  [ "$missing" = 0 ] || { oc_hotcfg__die "缺必需叶子(与 TS PLATFORM_BUNDLE_REQUIRED_LEAVES 同步义务)@ $root"; return 1; }
  return 0
}

# 规范化 bundle 制品权限:目录 0755、文件 0644、bin/ 下 .sh/.py 与可执行脚本 0755;全 root:root。
# (仅当以 root 运行时 chown 才成功;非 root 自测环境 chown 失败降级为跳过并不 fail,只保证权限位。)
oc_hotcfg_normalize_bundle_perms() {
  local root="$1"
  chown -R root:root "$root" 2>/dev/null || oc_hotcfg__log "chown root:root 跳过(非 root 环境)"
  find "$root" -type d -exec chmod 0755 {} +
  find "$root" -type f -exec chmod 0644 {} +
  # bin/ 下脚本与顶层 *.sh/*.py 置可执行
  if [ -d "$root/bin" ]; then find "$root/bin" -type f -exec chmod 0755 {} +; fi
  find "$root" -type f \( -name '*.sh' -o -name '*.py' \) -exec chmod 0755 {} +
}

# 规范化 release 制品(M6:与 bundle 同款,release 补):全 root:root + 去 group/other 写位。
# 与 bundle 不同,release 含 node_modules 可执行入口(.bin/*)与 ccb dist,**不**统一 0644/0755
# (会破坏可执行位);只做 supervisor assertBaselineLeaf 关心的两条不变量:owner=root、非
# group-other 可写。symlink 不 chmod(find -type f/-type d 已排除;chmod 软链会改目标态)。
# 非 root 自测:chown 失败静默降级(2>/dev/null),只保证写位规范化。
oc_hotcfg_normalize_release_perms() {
  local root="$1"
  chown -R root:root "$root" 2>/dev/null || oc_hotcfg__log "chown root:root 跳过(非 root 环境)"
  find "$root" -type d -exec chmod go-w {} + 2>/dev/null || true
  find "$root" -type f -exec chmod go-w {} + 2>/dev/null || true
}

# ─────────────────────────── bundle 落定(§1.1/1.2)───────────────────────────
# 从已组装好的 staging 目录 → 规范权限 → 自检 → 生成 MANIFEST → 按 digest 定名 mv -T 落正式。
# 幂等:同 rev 目录已存在 → **先全量重校验其 MANIFEST**(R3-minor)再丢弃 staging;校验失败 fail-loud。
# echo bundleRev(=digest 前 12 hex)到 stdout。
# 用法:oc_hotcfg_finalize_bundle <staging_dir> <schemaVersion> <sourceCommit>
oc_hotcfg_finalize_bundle() {
  local staging="$1" schema="$2" commit="$3"
  [ -d "$staging" ] || { oc_hotcfg__die "finalize_bundle: staging 不存在 $staging"; return 1; }
  # prompts/ 子目录缺失 → fail-loud(agent D 依赖)
  [ -d "$staging/prompts" ] || { oc_hotcfg__die "finalize_bundle: 缺 prompts/ 子目录(agent D 未就位?)@ $staging"; return 1; }
  # bin/ 剥扩展名:源仓 bin/ 里是 oc-*.sh/.py(git 可读性),bundle 里必须是 PATH 命令名
  # (`oc-docx` 而非 `oc-docx.sh`,镜像 dev-fallback COPY 也是逐文件重命名的同一语义)。
  # 剥完撞名 = 源目录同名 .sh/.py 并存,fail-loud 人工处置。
  if [ -d "$staging/bin" ]; then
    local f bare
    for f in "$staging"/bin/*.sh "$staging"/bin/*.py; do
      [ -e "$f" ] || continue
      bare="${f%.*}"
      [ ! -e "$bare" ] || { oc_hotcfg__die "finalize_bundle: bin/ 剥扩展名撞名 $(basename "$bare")"; return 1; }
      mv "$f" "$bare" || return 1
    done
  fi
  oc_hotcfg_normalize_bundle_perms "$staging"
  oc_hotcfg_selfcheck_bundle "$staging" || return 1
  # 必需叶子校验(M8):单一权威函数(emergency 硬验④亦复用,禁再散装内联)。
  oc_hotcfg_assert_required_leaves "$staging" || return 1
  local digest target
  digest="$(oc_hotcfg_build_manifest "$staging" "$schema" "$commit")" || return 1
  target="$OC_HOTCFG_PLATFORM_ROOT/bundles/$digest"
  mkdir -p "$OC_HOTCFG_PLATFORM_ROOT/bundles"
  if [ -d "$target" ]; then
    oc_hotcfg__log "bundle rev=$digest 已存在 → 全量重校验后复用(不信任裸存在)"
    if oc_hotcfg_verify_manifest_full "$target"; then
      rm -rf "$staging"
      printf '%s\n' "$digest"; return 0
    fi
    oc_hotcfg__die "bundle rev=$digest 目录存在但 MANIFEST 校验失败 → 需人工处置(疑被篡改/半写),拒绝复用"
    return 1
  fi
  mv -T "$staging" "$target" || { oc_hotcfg__die "bundle mv -T 落定失败"; return 1; }
  oc_hotcfg__log "bundle 落定 → $target"
  printf '%s\n' "$digest"
}

# current 相对 symlink 原子翻转(§1.2:挂载源永不变,翻转对存量容器原子生效)。
oc_hotcfg_flip_current() {
  local rev="$1" root="${2:-$OC_HOTCFG_PLATFORM_ROOT}" tmp
  [ -d "$root/bundles/$rev" ] || { oc_hotcfg__die "flip_current: 目标 bundle 不存在 bundles/$rev"; return 1; }
  tmp="$root/.current.$$.$RANDOM"
  rm -f "$tmp"
  ln -s "bundles/$rev" "$tmp"      # 相对目标
  mv -T "$tmp" "$root/current"     # 原子替换
}

# ─────────────────────────── release 依赖缓存键(§3.1)───────────────────────────
# key = sha256( root lock sha256 + image immutable ID + arch )。
# **不含 ccb lock**(2026-07-12 集成取证):claude-code-best 依赖用 `workspace:*` 协议,
# npm 根本不支持(npm ci/install 皆报 Unsupported URL Type)—— 镜像里那步 ccb npm install
# 一直走 WARN fallback,生产容器从未有过 ccb node_modules;真正运行物是 bun build 的
# **自足** dist/cli.js(build.ts 无 externals、target=node,全量打包),其 bytes 已进
# release 树 digest。故 release 只装 root 一套依赖,ccb 只有 host bun build(见下)。
oc_hotcfg_deps_cache_key() {
  local root="$1" image_id="$2" root_lock arch
  [ -f "$root/package-lock.json" ] || { oc_hotcfg__die "deps_cache_key: 缺 root package-lock.json @ $root"; return 1; }
  root_lock="$(sha256sum "$root/package-lock.json" | cut -d' ' -f1)"
  arch="$(uname -m)"
  printf '%s\n' "$(printf '%s\0%s\0%s' "$root_lock" "$image_id" "$arch" | sha256sum | cut -c1-64)"
}

# 在目标 runtime 镜像的**一次性容器内**装 root 依赖(§3.1:与容器运行时同 ABI)。
# npm ci 失败即整体失败(§3.1e 不降级 npm install;root lock 已实证 ci 通过)。
# ccb 不装(见 deps_cache_key 头注:workspace:* npm 不支持,dist/cli.js 自足)。
oc_hotcfg_install_deps_in_image() {
  local staging="$1" image_id="$2"
  oc_hotcfg__log "docker 一次性容器内 npm ci(root)@ image=$image_id"
  # --network=host:kl-mirror docker bridge 网络 DNS 不通(systemd-resolved stub 未被
  # daemon.json 兜底,与 build-image.sh 的 OC_BUILD_NETWORK_HOST 同一类坑,2026-07-12 实测
  # bridge 下 npm ping 挂死/host 下 297ms PONG,npm 崩为 "Exit handler never called")。
  # 构建期一次性容器,走宿主网络栈无隔离顾虑。
  # >&2:npm 的进度输出走 stdout("added N packages in Ns"),而本函数链上层
  # (finalize_release → deploy 的 $(…) 捕获)约定 stdout 只承载结果值 —— 混入即污染
  # 返回值(2026-07-12 首启实测 release 路径被拼上 npm 输出被合法性守卫拦下)。
  "$OC_DOCKER_BIN" run --rm --network=host --entrypoint /bin/sh --user 0:0 \
    -v "$staging:/build" -w /build "$image_id" -c '
      set -e
      npm ci --include=dev --no-audit --no-fund
    ' >&2 || { oc_hotcfg__die "npm ci 失败(整体失败,不降级 npm install)"; return 1; }
}

# ccb dist:host bun install --ignore-scripts + bun run build,产物 dist/cli.js。记录 bun --version 供 MANIFEST。
#
# **B6 隔离构建**:在 staging **外**的独立临时目录里 install+build,只把 dist/ 拷回 staging/claude-code-best/dist。
# 根治链:finalize_release 的 depsCacheKey 命中会 `cp -al` 复用上一 release 的 node_modules(硬链共享 inode);
# 若在 staging/claude-code-best 内直接 bun install/build,bun 改写这些硬链文件 → **污染上一不可变 release
# 的 ccb node_modules**。改为独立临时目录构建 → staging 与最终 release **均不含 ccb node_modules**
# (node_modules 只活在临时目录,构建后即删),ccb 运行物只有自足的 dist/cli.js(§3.1)。
# 临时目录取 staging 的兄弟目录(同文件系统,空间充足;避免 /tmp tmpfs 撑爆),函数退出前必删。
oc_hotcfg_build_ccb_dist() {
  local staging="$1" prev="${2:-}" bun ver ccb_build src_rows src_key
  bun="$OC_BUN_BIN"
  [ -n "$bun" ] || { if [ -x "$HOME/.bun/bin/bun" ]; then bun="$HOME/.bun/bin/bun"; else bun="$(command -v bun || true)"; fi; }
  [ -n "$bun" ] && [ -x "$bun" ] || { oc_hotcfg__die "build_ccb_dist: 找不到 host bun(~/.bun/bin/bun 或 PATH)"; return 1; }
  [ -d "$staging/claude-code-best" ] || { oc_hotcfg__die "build_ccb_dist: staging 无 claude-code-best"; return 1; }
  ver="$("$bun" --version 2>/dev/null)" || { oc_hotcfg__die "bun --version 失败"; return 1; }
  # ── ccb dist 内容寻址缓存(2026-07-12 首启实证):bun build **不可复现**(同源同目录重建
  # bytes 都不同,内嵌时间戳类噪声)→ 若每次 deploy 都重建,release digest 恒变 = "只改
  # master/前端 → 零容器 churn"承诺失效(全量用户容器每次 deploy 被滚动)。
  # 根治:key = digest(ccb 源子树 rows) + bun 版本;命中上一 release 的 MANIFEST.ccbDistKey
  # → **cp -a 真拷贝**其 dist(几 MB,不用硬链,零跨 release inode 共享)跳过 bun build。
  # 源变/bun 升版 → key 变 → 重建(容器滚动,正确)。
  src_rows="$(oc_hotcfg__file_rows "$staging/claude-code-best")" || return 1
  src_key="$(printf '%s\0%s' "$(printf '%s\n' "$src_rows" | oc_hotcfg__digest_from_rows all)" "$ver" | sha256sum | cut -c1-12)"
  if [ -n "$prev" ] && [ -f "$prev/MANIFEST.json" ] && [ -d "$prev/claude-code-best/dist" ] \
     && [ "$(jq -r '.ccbDistKey // empty' "$prev/MANIFEST.json")" = "$src_key" ]; then
    oc_hotcfg__log "ccbDistKey 命中上一 release → cp -a 复用 dist(跳过 bun build,digest 幂等)"
    rm -rf "$staging/claude-code-best/dist"
    cp -a "$prev/claude-code-best/dist" "$staging/claude-code-best/dist" \
      || { oc_hotcfg__die "build_ccb_dist: 复用 dist 拷贝失败"; return 1; }
    printf '%s\t%s\n' "$ver" "$src_key"
    return 0
  fi
  ccb_build="$(dirname "$staging")/.ccbbuild-$$.$RANDOM"
  rm -rf "$ccb_build"
  # 拷 ccb 源到独立临时目录(不含 staging 的 node_modules —— B6 后 staging 本就无 ccb node_modules;防御性再清一遍)
  cp -a "$staging/claude-code-best" "$ccb_build" \
    || { oc_hotcfg__die "build_ccb_dist: cp ccb 源到临时目录失败"; rm -rf "$ccb_build"; return 1; }
  rm -rf "$ccb_build/node_modules"
  # PATH 前置 bun 所在目录:`bun run build` 会经 shell 执行 package.json 的
  # "build": "bun run build.ts",嵌套调用按**名字**找 bun —— 非交互 ssh 的 PATH 不含
  # ~/.bun/bin(playbook §4.3 已知坑),只用绝对路径调外层不够(2026-07-12 首启实测
  # bash: bun: command not found exit 127)。
  if ! ( cd "$ccb_build" && PATH="$(dirname "$bun"):$PATH" "$bun" install --ignore-scripts && PATH="$(dirname "$bun"):$PATH" "$bun" run build ) >&2; then
    oc_hotcfg__die "ccb bun install/build 失败"; rm -rf "$ccb_build"; return 1
  fi
  [ -f "$ccb_build/dist/cli.js" ] || { oc_hotcfg__die "ccb dist/cli.js 未产出"; rm -rf "$ccb_build"; return 1; }
  # 只把 dist/ 拷回 staging(staging/claude-code-best 因此只含源 + dist,无 node_modules)
  rm -rf "$staging/claude-code-best/dist"
  cp -a "$ccb_build/dist" "$staging/claude-code-best/dist" \
    || { oc_hotcfg__die "build_ccb_dist: dist 拷回 staging 失败"; rm -rf "$ccb_build"; return 1; }
  rm -rf "$ccb_build"
  printf '%s\t%s\n' "$ver" "$src_key"
}

# release 落定(§3.1 d/e):在已 archive+prune+敏感扫描过的 staging 上装依赖、建 ccb dist、
# 生成 MANIFEST(含 depsCacheKey/bunVersion)、按 digest 定名 mv -T。
# 依赖形态(R2-m2 表述更正,无"两套 node_modules"):root 一套 npm ci;CCB 独立 bun build 仅拷
# dist(无 node_modules)。依赖缓存:cache key 与上一 release 同 → cp -al 复用 root node_modules 跳过 ci。
# 幂等:同 digest 已存在 → 抽样重校验后复用。echo releaseDir。
# 用法:oc_hotcfg_finalize_release <staging> <image_id> <sourceCommit> <prev_release_or_empty>
oc_hotcfg_finalize_release() {
  local staging="$1" image_id="$2" commit="$3" prev="${4:-}" caps="${5:-}"
  [ -d "$staging" ] || { oc_hotcfg__die "finalize_release: staging 不存在 $staging"; return 1; }
  local cache reuse=0 bunver
  cache="$(oc_hotcfg_deps_cache_key "$staging" "$image_id")" || return 1
  # 依赖复用判定:上一 release 的 depsCacheKey 相同且 root node_modules 在 → cp -al。
  # **只复用 root node_modules**(B6):ccb 无 node_modules(dist/cli.js 自足,§3.1),既不复用也不新装;
  # 历史上对 claude-code-best/node_modules 的 cp -al 复用是"污染旧 release"的源头(硬链共享 inode +
  # 旧实现在 staging 内 bun build 改写),已连同 build_ccb_dist 一起根治,故此处**不再触碰 ccb node_modules**。
  if [ -n "$prev" ] && [ -d "$prev" ] && [ -f "$prev/MANIFEST.json" ]; then
    local prev_key
    prev_key="$(jq -r '.depsCacheKey // empty' "$prev/MANIFEST.json")"
    if [ "$prev_key" = "$cache" ] && [ -d "$prev/node_modules" ]; then
      oc_hotcfg__log "depsCacheKey 命中上一 release → cp -al 复用 root node_modules(跳过 npm ci;ccb 不装依赖)"
      cp -al "$prev/node_modules" "$staging/node_modules"
      reuse=1
    fi
  fi
  [ "$reuse" = 1 ] || oc_hotcfg_install_deps_in_image "$staging" "$image_id" || return 1
  local ccb_out ccb_key
  ccb_out="$(oc_hotcfg_build_ccb_dist "$staging" "$prev")" || return 1
  bunver="${ccb_out%%$'\t'*}"; ccb_key="${ccb_out##*$'\t'}"
  # 产物阶段敏感扫描(node_modules 可能夹带 .pem 测试夹具 → 只扫源码顶层,node_modules 排除以免误杀依赖自带证书夹具)
  # 说明:敏感扫描针对**源码树被误纳入凭据**,node_modules 里第三方包自带的 *.pem 测试夹具非本仓凭据,
  # 扫描 node_modules 会大量误报;故 release 敏感扫描排除 node_modules(bundle 无 node_modules 不受影响)。
  local scan_bad=0 g found
  for g in $OC_HOTCFG_SENSITIVE_GLOBS; do
    found="$(cd "$staging" && find . -path ./node_modules -prune -o -path './claude-code-best/node_modules' -prune -o -name "$g" -print 2>/dev/null | head -5)"
    [ -n "$found" ] && { echo "  [hotcfg] release 源码敏感命中 '$g':" >&2; printf '    %s\n' $found >&2; scan_bad=1; }
  done
  [ "$scan_bad" = 0 ] || { oc_hotcfg__die "finalize_release: 源码树含敏感文件"; return 1; }

  # 规范化制品(M6):root:root + 去 group/other 写位(supervisor assertBaselineLeaf 不变量)。
  # 必须在 build_manifest **之前**(digest 记录规范化后的 mode)。
  oc_hotcfg_normalize_release_perms "$staging"

  local digest target
  digest="$(oc_hotcfg_build_manifest "$staging" 1 "$commit" "$bunver" "$cache" "$ccb_key" "$caps")" || return 1
  target="$OC_HOTCFG_RELEASES_ROOT/rel-$digest"
  mkdir -p "$OC_HOTCFG_RELEASES_ROOT"
  if [ -d "$target" ]; then
    oc_hotcfg__log "release rel-$digest 已存在 → 抽样重校验后复用"
    if oc_hotcfg_verify_manifest_sampled "$target" 64; then
      # capability 声明补写(幂等自愈):同 digest = 同源码树 ⇒ 同 capability。旧制品建于本
      # 特性之前(MANIFEST 无 capabilities)会被兼容地板判为"容器面不具备能力"而拒绝激活 ——
      # 那是**假阴性**(树里明明有代码)。此处按当前 caps 就地补写(MANIFEST 不进 digest,
      # 文件内容与校验语义均不受影响)。声明不同 → 同样以本次为准并记日志。
      oc_hotcfg__patch_manifest_capabilities "$target" "$caps" || return 1
      rm -rf "$staging"; printf '%s\n' "$target"; return 0
    fi
    oc_hotcfg__die "release rel-$digest 存在但抽样校验失败 → 人工处置"; return 1
  fi
  mv -T "$staging" "$target" || { oc_hotcfg__die "release mv -T 落定失败"; return 1; }
  oc_hotcfg__log "release 落定 → $target"
  printf '%s\n' "$target"
}

# ─────────────────────────── env tuple 读写(§1.1)───────────────────────────
oc_hotcfg_env_get() {
  local env_file="$1" key="$2"
  grep -E "^[[:space:]]*${key}=" "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# 原子写 tuple 四键:先 cp 备份 env.bak-<ts>,再逐键 sed-替换-或-append,tmp+mv 原子落盘。
# 用法:oc_hotcfg_env_write_tuple <env_file> <image> <image_id> <release> <bundle>
#
# **R2-B1 三态写(取代旧 B2"空值跳过")**:四键**恒写**,逐字面落值(含空串)。
#   - enabled 判定的单一权威 = "值非空"(deploy 侧 hotcfg_*_enabled 同语义);键在值空 = 该轴禁用。
#   - 禁用轴 = 写空值 → "禁用/清空"从此可表达:emergency 稳态(release 空)、--disable-* 轴、
#     "回滚到启用前"(pre-state 记录里的空值,R2-B2)都能写回。
#   - 不互染:各轴独立传值,调用方按轴启用态传新值或空串,互不沿用旧值。
#   旧 B2 的"空值=不写该键"无法表达禁用(emergency 要求 release 空与回滚到启用前均不可达),已废弃。
oc_hotcfg_env_write_tuple() {
  local env_file="$1"; shift
  local vals=("$@") keys=("${OC_HOTCFG_TUPLE_KEYS[@]}")
  [ "${#vals[@]}" -eq "${#keys[@]}" ] || { oc_hotcfg__die "env_write_tuple: 值个数 ${#vals[@]} != 键 ${#keys[@]}"; return 1; }
  local ts; ts="$(date -u +%Y%m%d%H%M%S)"
  cp -a "$env_file" "$env_file.bak-$ts" || return 1
  local tmp="$env_file.tuple.$$"
  cp -a "$env_file" "$tmp" || return 1
  local i k v
  for i in "${!keys[@]}"; do
    k="${keys[$i]}"; v="${vals[$i]}"
    if grep -Eq "^[[:space:]]*${k}=" "$tmp"; then
      # 替换(用 | 作分隔避免路径 / 冲突;值不含 | 假设成立,路径/镜像 ref 不含 |)
      sed -i "s|^[[:space:]]*${k}=.*|${k}=${v}|" "$tmp"
    else
      printf '%s=%s\n' "$k" "$v" >> "$tmp"
    fi
  done
  chmod --reference="$env_file" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$env_file"
  oc_hotcfg__log "env tuple 写入(备份 $env_file.bak-$ts)"
}

# 快照 tuple 四键当前值(每行 KEY=VAL;缺失键记 KEY=<UNSET>)供回滚复原。
oc_hotcfg_env_snapshot_tuple() {
  local env_file="$1" k v
  for k in "${OC_HOTCFG_TUPLE_KEYS[@]}"; do
    if grep -Eq "^[[:space:]]*${k}=" "$env_file"; then
      v="$(oc_hotcfg_env_get "$env_file" "$k")"
      printf '%s=%s\n' "$k" "$v"
    else
      printf '%s=<UNSET>\n' "$k"
    fi
  done
}

# 用快照复原 tuple 四键(<UNSET> → 删除该键行)。snapshot 经 stdin 或 $2 文件。
oc_hotcfg_env_restore_tuple() {
  local env_file="$1" snap_file="$2" tmp="$env_file.restore.$$" line k v
  cp -a "$env_file" "$tmp" || return 1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    k="${line%%=*}"; v="${line#*=}"
    # 先删该键所有行
    sed -i "/^[[:space:]]*${k}=/d" "$tmp"
    # <UNSET> 表示原本无此键 → 保持删除;否则 append 原值
    [ "$v" = "<UNSET>" ] || printf '%s=%s\n' "$k" "$v" >> "$tmp"
  done < "$snap_file"
  chmod --reference="$env_file" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$env_file"
  oc_hotcfg__log "env tuple 已复原"
}

# env.bak-<ts> 轮转(m6):保留最近 keep 份,删更旧。bak 命名 ts=YYYYmmddHHMMSS,字典序=时间序。
# **只在 saga commit 成功后调用**(见 activate_saga):失败现场的备份是最近的 → 恒被保留,不受影响。
oc_hotcfg_rotate_env_baks() {
  local env_file="$1" keep="${2:-10}" baks total
  baks="$(ls -1d "$env_file".bak-* 2>/dev/null | LC_ALL=C sort)" || return 0
  [ -n "$baks" ] || return 0
  total="$(printf '%s\n' "$baks" | grep -c .)"
  [ "$total" -gt "$keep" ] || return 0
  printf '%s\n' "$baks" | head -n "$((total - keep))" | while IFS= read -r f; do
    [ -n "$f" ] && rm -f "$f"
  done
  oc_hotcfg__log "env.bak 轮转:保留最近 $keep 份(删 $((total - keep)) 份旧备份)"
}

# emergency tuple(§1.1 / B7 / R2-M1):把逃生 pinned tuple 写入 OC_RUNTIME_EMERGENCY_TUPLE。
# 逃生态的定义 = "**内嵌源码镜像** + release 空 + 固定 bundle"。
# 用法:oc_hotcfg_write_emergency_tuple <env_file> [image] [image_id] [bundle]
#   候选缺省(空串)= 取当前 env 对应键;R2-M1 起支持**显式候选**(瘦身稳态下直接登记逃生 tuple,
#   不必先把现网翻到空 release)。候选 release **恒为空**:显式路径由构造保证;env 快照路径取
#   env 现值并要求为空(否则拒 —— 现网跑着 release 的 tuple 不是逃生形态)。
# 硬验(任一不符 fail-loud,而非把一条不能逃生的 tuple 静默记成逃生点):
#   ① 候选 image 的 label oc.runtime.embed_source ≠ "0"(缺 label = 旧镜像,视为内嵌,放行);
#   ② **immutable ID 钉死(R2-M1)**:`docker image inspect --format {{.Id}} <image>` 必须 ==
#      候选 image_id(缺省即 env OC_RUNTIME_IMAGE_ID;显式候选同理)—— tag 可被重打,ID 不会,
#      防"tag 已漂到别的镜像却按旧 ID 记账"的错位逃生点;
#   ③ 候选 release 为空(逃生靠镜像内嵌源码,不依赖 release 树);
#   ④ 候选 bundle 目录存在且 MANIFEST 全量校验通过。
# 通过后写 JSON 单行 {image,image_id,bundle}(release 逃生态恒空,不入 JSON;GC 的 .release // empty
# 兜空),并轮转 env.bak(R2-m1)。
oc_hotcfg_write_emergency_tuple() {
  local env_file="$1" image="${2:-}" image_id="${3:-}" bundle="${4:-}"
  local explicit=0 release="" embed live_id val
  [ -n "$image$image_id$bundle" ] && explicit=1
  [ -n "$image" ]    || image="$(oc_hotcfg_env_get "$env_file" OC_RUNTIME_IMAGE)"
  [ -n "$image_id" ] || image_id="$(oc_hotcfg_env_get "$env_file" OC_RUNTIME_IMAGE_ID)"
  [ -n "$bundle" ]   || bundle="$(oc_hotcfg_env_get "$env_file" OC_PLATFORM_BUNDLE)"
  # 候选 release:显式候选路径由构造恒空;env 快照路径取现值(硬验 ③ 要求为空)。
  [ "$explicit" = 1 ] || release="$(oc_hotcfg_env_get "$env_file" OC_RUNTIME_RELEASE)"
  # 硬验 ①:候选 image 必须是内嵌源码镜像(embed_source≠0)。
  [ -n "$image" ] || { oc_hotcfg__die "emergency: 候选 image 为空(env 无 OC_RUNTIME_IMAGE 且未显式传 --image)"; return 1; }
  embed="$("$OC_DOCKER_BIN" image inspect --format '{{ index .Config.Labels "oc.runtime.embed_source" }}' "$image" 2>/dev/null)" \
    || { oc_hotcfg__die "emergency: docker image inspect 失败(镜像不存在?): $image"; return 1; }
  if [ "$embed" = "0" ]; then
    oc_hotcfg__die "emergency: 候选镜像 embed_source=0(瘦身镜像,无内嵌源码)—— emergency tuple 必须钉内嵌源码镜像(可用显式候选 --image= 指内嵌镜像)。"
    return 1
  fi
  # 硬验 ②(R2-M1):候选 image 的 immutable ID 必须与候选 image_id 一致。
  [ -n "$image_id" ] || { oc_hotcfg__die "emergency: 候选 image_id 为空(env 无 OC_RUNTIME_IMAGE_ID 且未显式传 --image-id)—— ID 钉死无从校验"; return 1; }
  live_id="$("$OC_DOCKER_BIN" image inspect --format '{{.Id}}' "$image" 2>/dev/null)" \
    || { oc_hotcfg__die "emergency: docker image inspect {{.Id}} 失败: $image"; return 1; }
  [ "$live_id" = "$image_id" ] \
    || { oc_hotcfg__die "emergency: 镜像 immutable ID 不符(inspect=$live_id 候选=$image_id)—— tag 可能已被重打,拒绝记错位逃生点"; return 1; }
  # 硬验 ③:候选 release 必须为空。
  if [ -n "$release" ]; then
    oc_hotcfg__die "emergency: 候选 OC_RUNTIME_RELEASE 非空($release)—— 逃生态要求 release=空(靠镜像内嵌源码)。瘦身稳态请改用显式候选(--image=/--image-id=/--bundle= 指内嵌镜像),不必先把现网翻到空 release。"
    return 1
  fi
  # 硬验 ④(R3-M1 升级):候选 bundle 复用正常 bundle 的完整门 —— 仅 digest 自洽不够,
  # 任意"自洽 MANIFEST 目录"都能过 verify_manifest_full,恢复时才被 supervisor/entrypoint 拒。
  # 登记时就必须证明"完整可启动":containment + 目录名==digest + 结构 schema + 必需叶子 +
  # rev-pinned validate-only canary(候选内嵌镜像真跑 entrypoint 校验链,覆盖 seed 语义)。
  [ -n "$bundle" ] || { oc_hotcfg__die "emergency: 候选 OC_PLATFORM_BUNDLE 为空"; return 1; }
  [ -d "$bundle" ] || { oc_hotcfg__die "emergency: 候选 bundle 目录不存在: $bundle"; return 1; }
  local bundle_real bundles_real rev
  bundle_real="$(readlink -f "$bundle")" || { oc_hotcfg__die "emergency: 候选 bundle realpath 失败: $bundle"; return 1; }
  bundles_real="$(readlink -f "$OC_HOTCFG_PLATFORM_ROOT/bundles" 2>/dev/null || true)"
  case "$bundle_real" in
    "$bundles_real"/*) : ;;
    *) oc_hotcfg__die "emergency: 候选 bundle 不在 platform root bundles/ 下: $bundle_real"; return 1 ;;
  esac
  rev="$(basename "$bundle_real")"
  [[ "$rev" =~ ^[0-9a-f]{12}$ ]] || { oc_hotcfg__die "emergency: 候选 bundle 目录名非 12hex rev: $rev"; return 1; }
  [ "$(jq -r '.digest // empty' "$bundle_real/MANIFEST.json" 2>/dev/null)" = "$rev" ] \
    || { oc_hotcfg__die "emergency: 候选 bundle 目录名与 MANIFEST.digest 不符: $rev"; return 1; }
  oc_hotcfg_verify_manifest_full "$bundle_real" || { oc_hotcfg__die "emergency: 候选 bundle MANIFEST 全量校验失败: $bundle_real"; return 1; }
  oc_hotcfg_selfcheck_bundle "$bundle_real" || { oc_hotcfg__die "emergency: 候选 bundle 结构 schema 校验失败"; return 1; }
  oc_hotcfg_assert_required_leaves "$bundle_real" || { oc_hotcfg__die "emergency: 候选 bundle 缺必需叶子"; return 1; }
  oc_hotcfg_canary_boot "$image_id" "$OC_HOTCFG_PLATFORM_ROOT" "$rev" "" \
    || { oc_hotcfg__die "emergency: 候选 tuple canary boot 失败(该 bundle+镜像组合不可启动,拒登记)"; return 1; }
  # 硬验通过 → 写 {image,image_id,bundle}
  # R4-M1:登记 canonical 路径(bundle_real,恒为 bundles/<12hex> 固定 digest 目录)——
  # 传 current 之类 symlink 也被解析钉死,GC 保护与激活取 rev 都作用在真实 digest 目录上。
  val="$(jq -cn --arg image "$image" --arg image_id "$image_id" --arg bundle "$bundle_real" \
    '{image:$image, image_id:$image_id, bundle:$bundle}')"
  local ts; ts="$(date -u +%Y%m%d%H%M%S)"
  cp -a "$env_file" "$env_file.bak-$ts"
  local tmp="$env_file.emerg.$$"; cp -a "$env_file" "$tmp"
  sed -i "/^[[:space:]]*${OC_HOTCFG_EMERGENCY_KEY}=/d" "$tmp"
  printf '%s=%s\n' "$OC_HOTCFG_EMERGENCY_KEY" "$val" >> "$tmp"
  chmod --reference="$env_file" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$env_file"
  oc_hotcfg__log "emergency tuple 写入(硬验通过,ID 钉死): $val"
  # R2-m1:成功后轮转 env.bak(与 saga commit 同策略,保留最近 10 份)。
  oc_hotcfg_rotate_env_baks "$env_file" 10 || true
}

# ─────────────────────────── tuple history(§1.1)───────────────────────────
# schemaVersion 编码(R2-M3/R5):
#   v3(现行,append 恒写 v3):v2 八字段后追加 transitionKind + previousMasterRelease。
#     transitionKind=joint|master-only|tuple-only|prestate；父 master 与类型一起进 checksum，
#     让 rollback 区分“只切 master(P3)”与“只切 tuple(emergency)”，连续反向也不丢血缘。
#   v2(只读兼容):checksum = sha256( 2\0seq\0ts\0image\0image_id\0release\0bundle\0masterRelease )
#     前 64 hex。masterRelease(M7)= 激活时当前 master 蓝绿 release 目录 —— 与 tuple 同属一次 deploy
#     的孪生产物,进 checksum 保证篡改被拒;rollback 从**同一条**记录同时取 master 与 tuple。
#   v1(只读兼容,旧编码**无 masterRelease 字段**):checksum = sha256( 1\0seq\0ts\0image\0image_id\0
#     release\0bundle )。v1 条目读出时 masterRelease 视为空(verify 归一化补 "")。
#   历史教训:M7 把 masterRelease 加进 checksum 却没 bump schemaVer,导致 v1 旧行按 8 字段验必失配
#   被静默丢弃 —— R2-M3 起编码变更必须 bump schemaVer 并在 verify 按行内 schemaVer 分支。
oc_hotcfg_history_checksum() {
  local schemaVer="$1" seq="$2" ts="$3" image="$4" image_id="$5" release="$6" bundle="$7" masterRelease="${8:-}"
  local transitionKind="${9:-}" previousMasterRelease="${10:-}"
  # 未知 schemaVer **显式拒绝**(R3-m2):否则伪造/未来版本只要沿用 v2 编码即被静默接受,
  # "按版本分支验证"失去升版语义(编码变更必 bump schemaVer + 必在此显式登记)。
  case "$schemaVer" in
    1)
      printf '%s\0%s\0%s\0%s\0%s\0%s\0%s' \
        "$schemaVer" "$seq" "$ts" "$image" "$image_id" "$release" "$bundle" | sha256sum | cut -c1-64 ;;
    2)
      printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s' \
        "$schemaVer" "$seq" "$ts" "$image" "$image_id" "$release" "$bundle" "$masterRelease" | sha256sum | cut -c1-64 ;;
    3)
      printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s' \
        "$schemaVer" "$seq" "$ts" "$image" "$image_id" "$release" "$bundle" "$masterRelease" \
        "$transitionKind" "$previousMasterRelease" | sha256sum | cut -c1-64 ;;
    *)
      oc_hotcfg__die "history_checksum: 未知 schemaVer=$schemaVer(已知 1|2|3)"; return 1 ;;
  esac
}

# 校验单行 history 条目(R2-M3 单一权威:last/nth/GC 三处共用,禁再散装内联)。
# 按行内 schemaVer 分支验 v1/v2/v3；旧格式归一化补 transitionKind/previousMasterRelease。
oc_hotcfg__history_verify_line() {
  local line="$1" schemaVer seq ts image image_id release bundle master kind previous want sum
  schemaVer="$(jq -r '.schemaVer // empty' <<<"$line" 2>/dev/null)" || return 1
  [ -n "$schemaVer" ] || return 1
  seq="$(jq -r '.seq' <<<"$line")"; ts="$(jq -r '.ts' <<<"$line")"
  image="$(jq -r '.image' <<<"$line")"; image_id="$(jq -r '.image_id' <<<"$line")"
  release="$(jq -r '.release' <<<"$line")"; bundle="$(jq -r '.bundle' <<<"$line")"
  # v1/v2 没有受 checksum 保护的类型/父字段，必须忽略任何注入值并按旧语义归一化。
  if [ "$schemaVer" = 1 ]; then master=""; else master="$(jq -r '.masterRelease // ""' <<<"$line")"; fi
  if [ "$schemaVer" = 3 ]; then
    kind="$(jq -r '.transitionKind // ""' <<<"$line")"
    previous="$(jq -r '.previousMasterRelease // ""' <<<"$line")"
    case "$kind" in joint|master-only|tuple-only|prestate) : ;; *) return 1 ;; esac
  else
    kind="$(jq -r 'if .preState == true then "prestate" else "joint" end' <<<"$line")"
    previous=""
  fi
  want="$(jq -r '.checksum' <<<"$line")"
  sum="$(oc_hotcfg_history_checksum "$schemaVer" "$seq" "$ts" "$image" "$image_id" "$release" "$bundle" "$master" "$kind" "$previous")"
  [ "$sum" = "$want" ] || return 1
  jq -c --arg master "$master" --arg kind "$kind" --arg previous "$previous" \
    '.masterRelease=$master | .transitionKind=$kind | .previousMasterRelease=$previous' <<<"$line"
}

# 返回最后一条 checksum 通过的 committed 条目(归一化 JSON 单行)到 stdout;无则空。
oc_hotcfg_history_last_committed() {
  local hist="$1" line out
  [ -f "$hist" ] || return 0
  # 逆序遍历,首个校验通过者即结果
  tac "$hist" 2>/dev/null | while IFS= read -r line; do
    [ -n "$line" ] || continue
    if out="$(oc_hotcfg__history_verify_line "$line")"; then printf '%s\n' "$out"; break; fi
  done
}

# 取倒数第 N 条 checksum 通过的 committed 条目(N=1 即 last,N=2 即上一条)。归一化 JSON 单行到 stdout。
oc_hotcfg_history_nth_committed() {
  local hist="$1" n="${2:-1}" cnt=0 line out
  [ -f "$hist" ] || return 0
  tac "$hist" 2>/dev/null | while IFS= read -r line; do
    [ -n "$line" ] || continue
    out="$(oc_hotcfg__history_verify_line "$line")" || continue
    cnt=$((cnt+1))
    if [ "$cnt" -eq "$n" ]; then printf '%s\n' "$out"; break; fi
  done
}

# 把当前 env 四键包装成与 history committed 条目同形的恢复计划。P3 finalize 只切 master、
# 不改 runtime tuple，因此当 history.last.masterRelease != deploy_state.active_release 时，
# 即时回滚应保留这组 live tuple，只把 master 切回 previous_active_release。
oc_hotcfg_env_tuple_json() {  # $1=env_file $2=master_release
  local env_file="$1" master="$2" image image_id release bundle
  image="$(oc_hotcfg_env_get "$env_file" OC_RUNTIME_IMAGE)"
  image_id="$(oc_hotcfg_env_get "$env_file" OC_RUNTIME_IMAGE_ID)"
  release="$(oc_hotcfg_env_get "$env_file" OC_RUNTIME_RELEASE)"
  bundle="$(oc_hotcfg_env_get "$env_file" OC_PLATFORM_BUNDLE)"
  jq -cn --arg image "$image" --arg image_id "$image_id" --arg release "$release" \
    --arg bundle "$bundle" --arg masterRelease "$master" \
    '{image:$image,image_id:$image_id,release:$release,bundle:$bundle,masterRelease:$masterRelease}'
}

# 追加一条 committed tuple(schemaVer=3):seq=上一 committed +1,temp+fsync+rename 落盘。
# 用法:... [masterRelease] [prestate] [transitionKind] [previousMasterRelease]
# masterRelease(M7)= 激活时 master 蓝绿 release 目录名;rollback 从同一条记录取回对齐 master 源码。
# $7 传字面 "prestate" → 条目附 preState:true(布尔仅供审计)且 transitionKind=prestate
# 进入 checksum；恢复语义由四键+master+kind+parent 共同承载。
oc_hotcfg_history_append() {
  local hist="$1" image="$2" image_id="$3" release="$4" bundle="$5" master="${6:-}" flag="${7:-}"
  local kind="${8:-joint}" previous="${9:-}"
  local last seq ts sum line dir prestate=false
  if [ "$flag" = prestate ]; then prestate=true; kind=prestate; fi
  case "$kind" in joint|master-only|tuple-only|prestate) : ;; *) oc_hotcfg__die "history_append: 非法 transitionKind=$kind"; return 1 ;; esac
  last="$(oc_hotcfg_history_last_committed "$hist")"
  if [ -n "$last" ]; then seq=$(( $(jq -r '.seq' <<<"$last") + 1 )); else seq=1; fi
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sum="$(oc_hotcfg_history_checksum 3 "$seq" "$ts" "$image" "$image_id" "$release" "$bundle" "$master" "$kind" "$previous")"
  line="$(jq -cn --argjson schemaVer 3 --argjson seq "$seq" --arg ts "$ts" \
    --arg image "$image" --arg image_id "$image_id" --arg release "$release" --arg bundle "$bundle" \
    --arg masterRelease "$master" --arg transitionKind "$kind" --arg previousMasterRelease "$previous" \
    --arg checksum "$sum" --argjson preState "$prestate" \
    '{schemaVer:$schemaVer, seq:$seq, ts:$ts, image:$image, image_id:$image_id, release:$release, bundle:$bundle, masterRelease:$masterRelease, transitionKind:$transitionKind, previousMasterRelease:$previousMasterRelease, checksum:$checksum}
     + (if $preState then {preState:true} else {} end)')"
  dir="$(dirname "$hist")"; mkdir -p "$dir"
  local tmp="$hist.append.$$"
  # 先把已有内容复制进 tmp 再追加,tmp fsync 后 rename(整文件原子替换,防半写)
  if [ -f "$hist" ]; then cp -a "$hist" "$tmp"; else : > "$tmp"; fi
  printf '%s\n' "$line" >> "$tmp"
  # fsync tmp 与目录
  { command -v sync >/dev/null && sync "$tmp" 2>/dev/null; } || sync || true
  mv -f "$tmp" "$hist"
  sync "$dir" 2>/dev/null || sync || true
  oc_hotcfg__log "history 追加 committed tuple seq=$seq"
}

# canary boot 冒烟(R2-M2③):以 validate-only 模式跑一次 entrypoint —— EG2 契约:容器内
# entrypoint 见 OC_ENTRYPOINT_VALIDATE_ONLY=1 时只做 env 清洗/bundle 解析/seed 语义校验后 exit 0,
# 不 spawn gateway、不要求真实 master。挂载按轴:bundle 轴启用 → 挂 platform_root+传 rev;release
# 轴启用 → 挂 release 树。全 rev-pinned(不依赖 current symlink / env 文件),因此可以放在 saga
# 一切现场改动**之前**跑:失败=什么都没动,直接拒绝激活(无需回滚、不无谓重启旧 master),
# 且恒满足"restart 前"契约。
# 用法:oc_hotcfg_canary_boot <image_id> <platform_root> <bundle_rev_or_empty> <release_dir_or_empty>
oc_hotcfg_canary_boot() {
  local image_id="$1" platform_root="$2" bundle_rev="${3:-}" release_dir="${4:-}"
  [ -n "$image_id" ] || { oc_hotcfg__die "canary_boot: image_id 为空,无法冒烟(镜像未 inspect 出 ID?)"; return 1; }
  local args=(run --rm --entrypoint /usr/local/bin/entrypoint.sh
    -e OC_ENTRYPOINT_VALIDATE_ONLY=1
    -e ANTHROPIC_BASE_URL=http://127.0.0.1:1
    -e ANTHROPIC_AUTH_TOKEN=canary
    -e CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1)
  [ -n "$bundle_rev" ]  && args+=(-v "$platform_root:/run/oc/platform:ro" -e "OC_PLATFORM_BUNDLE_REV=$bundle_rev")
  [ -n "$release_dir" ] && args+=(-v "$release_dir:/opt/openclaude:ro")
  args+=("$image_id")
  oc_hotcfg__log "canary boot 冒烟(validate-only)image=$image_id bundle_rev=${bundle_rev:-<off>} release=${release_dir:-<off>}"
  "$OC_DOCKER_BIN" "${args[@]}" \
    || { oc_hotcfg__die "canary boot 冒烟失败(entrypoint validate-only 非 0)→ 拒绝激活"; return 1; }
}

# tuple 可行性守卫(R3-B1 + R4-B1 + R3-B4):saga 一切现场改动之前(**两轴全空也要跑**)拦三类坏 tuple:
#   ① tag↔ID 漂移:tuple 记 {image(tag), image_id(权威)},但容器最终以 tag 起(supervisor
#      deps.image)——若 tag 已被重打到别的镜像,提交后=运行镜像与 stale 权威 ID 不同,
#      错误镜像启动 + 存量容器持续 runtimeStale 循环。强制 inspect(image).Id == image_id。
#   ② 瘦身镜像(embed_source=0)+ 空 release:新容器无源码可跑,provision 真空。
#   ③ **模型权威兼容地板**(cutover marker 置位后):容器面必须自证 model_authority_v1 ——
#      release 非空看 MANIFEST.capabilities,release 空(内嵌/emergency)看镜像 features label。
#      不满足 = 该 tuple 的容器会退回 baked 判定,而 catalog 里已有 baked 不认识的行 → 拒。
# 缺 label 视为内嵌镜像(兼容旧镜像)放行 ①②;inspect 失败 = 无法证明可行,拒绝。
oc_hotcfg_assert_tuple_viable() {
  local image="$1" image_id="$2" release="$3" live_id embed
  # ① tag↔ID 一致性(image/image_id 都非空才可验;正常 saga 两者恒非空)。
  if [ -n "$image" ] && [ -n "$image_id" ]; then
    live_id="$("$OC_DOCKER_BIN" image inspect --format '{{.Id}}' "$image" 2>/dev/null)" \
      || { oc_hotcfg__die "tuple_viable: 无法 inspect 镜像 tag $image(镜像不存在?)"; return 1; }
    [ "$live_id" = "$image_id" ] \
      || { oc_hotcfg__die "tuple_viable: tag↔ID 漂移(inspect($image).Id=$live_id ≠ tuple.image_id=$image_id)—— tag 已被重打,拒绝提交错位 tuple"; return 1; }
  fi
  # ③ 模型权威地板(先于 ② 的 early-return,两种 release 形态都要过)。
  oc_hotcfg_assert_tuple_model_authority "$image_id" "$release" || return 1
  # ④ 无损 turn-tape 地板:一旦存在 finalized v2 tape,任何实际激活/回滚
  # tuple 都必须自证 writer capability。DB 不可读时 fail-closed。
  oc_hotcfg_assert_tuple_lossless_floor "$image_id" "$release" || return 1
  # ② 瘦身+空 release(按权威 immutable ID 查 label,不再信 tag)。
  [ -n "$release" ] && return 0
  embed="$("$OC_DOCKER_BIN" image inspect --format '{{index .Config.Labels "oc.runtime.embed_source"}}' "$image_id" 2>/dev/null)" \
    || { oc_hotcfg__die "tuple_viable: 无法 inspect 镜像 $image_id(release 为空时必须证明镜像内嵌源码)"; return 1; }
  if [ "$embed" = "0" ]; then
    oc_hotcfg__die "tuple_viable: 拒绝激活'瘦身镜像(embed_source=0)+ 空 release'——须带显式内嵌镜像(--image/--image-id)或走 --activate-emergency-tuple"
    return 1
  fi
  return 0
}

# 无条件核验一个实际 runtime tuple 是否声明 lossless writer capability。
# release 轴开启看 MANIFEST.capabilities；空 release 看 immutable image label。
oc_hotcfg_assert_tuple_lossless_capability() {
  local image_id="$1" release="$2" caps
  if [ -n "$release" ]; then
    [ -f "$release/MANIFEST.json" ] \
      || { oc_hotcfg__die "tuple_viable: runtime release 无 MANIFEST.json,无法自证 $OC_HOTCFG_LOSSLESS_TURN_TAPE_CAP: $release"; return 1; }
    caps="$(jq -r '(.capabilities // []) | join(" ")' "$release/MANIFEST.json" 2>/dev/null)" \
      || { oc_hotcfg__die "tuple_viable: 读 runtime release MANIFEST.capabilities 失败: $release"; return 1; }
  else
    [ -n "$image_id" ] \
      || { oc_hotcfg__die "tuple_viable: release 为空且 image_id 为空,无法自证 $OC_HOTCFG_LOSSLESS_TURN_TAPE_CAP"; return 1; }
    caps="$("$OC_DOCKER_BIN" image inspect --format "{{index .Config.Labels \"$OC_HOTCFG_IMAGE_FEATURES_LABEL\"}}" "$image_id" 2>/dev/null)" \
      || { oc_hotcfg__die "tuple_viable: 无法 inspect 镜像 $image_id 的 $OC_HOTCFG_IMAGE_FEATURES_LABEL label"; return 1; }
  fi
  case " $caps " in
    *" $OC_HOTCFG_LOSSLESS_TURN_TAPE_CAP "*) return 0 ;;
    *) oc_hotcfg__die "tuple_viable: 目标 runtime tuple 未声明 '$OC_HOTCFG_LOSSLESS_TURN_TAPE_CAP'(caps=[${caps:-<none>}],release=${release:-<embedded>},image_id=${image_id:-<none>})"; return 1 ;;
  esac
}

# Tri-state master reader probe: 0=present, 1=metadata explicitly absent/lacks
# the declaration, 2=read/parse failure. Callers deciding whether a candidate
# may have served must treat 2 like 0. Missing, malformed, or unreadable
# metadata is unknown; only a parsed artifact lacking the token is explicit.
oc_hotcfg_probe_master_lossless_capability() {
  local master_release="$1" metadata caps
  [ -n "$master_release" ] || return 2
  metadata="$master_release/deploy/v5/release-metadata.json"
  [ -e "$metadata" ] || return 2
  [ -r "$metadata" ] || return 2
  caps="$(jq -r '(.capabilities // []) | join(" ")' "$metadata" 2>/dev/null)" || return 2
  case " $caps " in
    *" $OC_HOTCFG_LOSSLESS_TURN_TAPE_CAP "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Master reader capability is separate from the actual runtime writer tuple.
# Both are required before an automatic compensation may restore a stack after
# a lossless-capable candidate has possibly accepted traffic.
oc_hotcfg_assert_master_lossless_capability() {
  local master_release="$1" rc=0
  oc_hotcfg_probe_master_lossless_capability "$master_release" || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) oc_hotcfg__die "lossless rollback: master release 未声明 '$OC_HOTCFG_LOSSLESS_TURN_TAPE_CAP':${master_release:-<empty>}" ;;
    *) oc_hotcfg__die "lossless rollback: master release capability 不可核验(读/解析失败):${master_release:-<empty>}" ;;
  esac
  return 1
}

oc_hotcfg_probe_master_runtime_batch_capability() {
  local master_release="$1" metadata caps
  [ -n "$master_release" ] || return 2
  metadata="$master_release/deploy/v5/release-metadata.json"
  [ -r "$metadata" ] || return 2
  caps="$(jq -r '(.capabilities // []) | if type == "array" then join(" ") else error("not array") end' "$metadata" 2>/dev/null)" || return 2
  case " $caps " in
    *" $OC_HOTCFG_LOSSLESS_RUNTIME_BATCH_CAP "*) return 0 ;;
    *) return 1 ;;
  esac
}

oc_hotcfg_assert_master_runtime_batch_capability() {
  local master_release="$1" rc=0
  oc_hotcfg_probe_master_runtime_batch_capability "$master_release" || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) oc_hotcfg__die "runtime-batch rollback: master release 未声明 '$OC_HOTCFG_LOSSLESS_RUNTIME_BATCH_CAP':${master_release:-<empty>}" ;;
    *) oc_hotcfg__die "runtime-batch rollback: master release capability 不可核验:${master_release:-<empty>}" ;;
  esac
  return 1
}

# 0=armed, 1=definitively inactive, 2=unknown. The env opt-in closes the
# first-write race; persisted format-3 rows keep the reader floor irreversible.
oc_hotcfg_probe_runtime_batch_floor() {
  local env_file="$1" state="" rc=0
  [ -r "$env_file" ] || return 2
  state="$(
    set -a
    # shellcheck disable=SC1090
    . "$env_file" 2>/dev/null || exit 21
    set +a
    case "${LOSSLESS_TURN_TAPE_RUNTIME_BATCHING:-}" in 1|true|TRUE|on|ON) printf true; exit 0 ;; esac
    [ -n "${DATABASE_URL:-}" ] || exit 22
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc \
      "SELECT EXISTS (SELECT 1 FROM client_session_turn_tapes WHERE finalized_at IS NOT NULL AND record_storage_format >= 3)::text" 2>/dev/null
  )" || rc=$?
  state="$(printf '%s' "$state" | tr -d '[:space:]')"
  [ "$rc" -eq 0 ] && [ "$state" = true ] && return 0
  [ "$rc" -eq 0 ] && [ "$state" = false ] && return 1
  return 2
}

oc_hotcfg_assert_master_runtime_batch_pair() {
  local env_file="$1" target_master="$2" previous_master="$3" rc=0
  oc_hotcfg_probe_runtime_batch_floor "$env_file" || rc=$?
  [ "$rc" -eq 1 ] && return 0
  [ "$rc" -eq 2 ] && oc_hotcfg__log "runtime-event batch 地板状态不可核验 → master pair fail-closed"
  oc_hotcfg_assert_master_runtime_batch_capability "$target_master" \
    && oc_hotcfg_assert_master_runtime_batch_capability "$previous_master"
}

# DB 中首个 finalized v2 tape 是不可逆地板。无 DATABASE_URL 仅用于本地 fixture/
# bootstrap，放行；生产 env 有 URL 但查询失败则按地板已生效处理。
oc_hotcfg_assert_tuple_lossless_floor() {
  local image_id="$1" release="$2" finalized="" rc=0
  [ -f "$OC_HOTCFG_ENV_FILE" ] || return 0
  finalized="$(
    set -a
    # shellcheck disable=SC1090
    . "$OC_HOTCFG_ENV_FILE" 2>/dev/null || exit 21
    set +a
    [ -n "${DATABASE_URL:-}" ] || exit 22
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc \
      "SELECT EXISTS (SELECT 1 FROM client_session_turn_tapes WHERE finalized_at IS NOT NULL)::text" 2>/dev/null
  )" || rc=$?
  finalized="$(printf '%s' "$finalized" | tr -d '[:space:]')"
  [ "$rc" -eq 22 ] && return 0
  if [ "$rc" -eq 0 ] && [ "$finalized" = false ]; then return 0; fi
  if [ "$rc" -ne 0 ] || [ "$finalized" != true ]; then
    oc_hotcfg__log "lossless tape 状态不可核验(rc=$rc result=${finalized:-<empty>})→ runtime tuple fail-closed"
  fi
  oc_hotcfg_assert_tuple_lossless_capability "$image_id" "$release"
}

# 容器面(runtime tuple)的模型权威 capability 地板。marker 未置位 → 放行(步骤 5 之前无地板)。
# fail-closed:探测不到声明(MANIFEST 缺失 / inspect 失败)一律拒 —— 不确定即拒。
oc_hotcfg_assert_tuple_model_authority() {
  local image_id="$1" release="$2" cutover caps
  [ -f "$OC_HOTCFG_ENV_FILE" ] || return 0
  cutover="$(oc_hotcfg_env_get "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_MODEL_AUTHORITY_CUTOVER_KEY")"
  [ "$cutover" = "1" ] || return 0
  if [ -n "$release" ]; then
    [ -f "$release/MANIFEST.json" ] \
      || { oc_hotcfg__die "tuple_viable: cutover 已置位,但 release 无 MANIFEST.json,无法自证 $OC_HOTCFG_MODEL_AUTHORITY_CAP: $release"; return 1; }
    caps="$(jq -r '(.capabilities // []) | join(" ")' "$release/MANIFEST.json" 2>/dev/null)" \
      || { oc_hotcfg__die "tuple_viable: 读 release MANIFEST.capabilities 失败: $release"; return 1; }
    case " $caps " in
      *" $OC_HOTCFG_MODEL_AUTHORITY_CAP "*) return 0 ;;
      *) oc_hotcfg__die "tuple_viable: 兼容地板拒绝 —— 步骤 5 已 cutover($OC_HOTCFG_MODEL_AUTHORITY_CUTOVER_KEY=1),但目标 runtime release 未声明 '$OC_HOTCFG_MODEL_AUTHORITY_CAP'(caps=[${caps}]):$release。该 release 的容器不认签名 execution descriptor → 退回 baked 判定。回滚只能翻到同样声明该 capability 的 release。"; return 1 ;;
    esac
  fi
  # release 为空:容器跑镜像内嵌源码 → 声明在镜像 features label。
  caps="$("$OC_DOCKER_BIN" image inspect --format "{{index .Config.Labels \"$OC_HOTCFG_IMAGE_FEATURES_LABEL\"}}" "$image_id" 2>/dev/null)" \
    || { oc_hotcfg__die "tuple_viable: cutover 已置位,但无法 inspect 镜像 $image_id 的 $OC_HOTCFG_IMAGE_FEATURES_LABEL label"; return 1; }
  case " $caps " in
    *" $OC_HOTCFG_MODEL_AUTHORITY_CAP "*) return 0 ;;
    *) oc_hotcfg__die "tuple_viable: 兼容地板拒绝 —— 步骤 5 已 cutover,但内嵌源码镜像 $image_id 的 $OC_HOTCFG_IMAGE_FEATURES_LABEL=[${caps}] 不含 '$OC_HOTCFG_MODEL_AUTHORITY_CAP'。逃生镜像必须由带该能力的 commit 构建(build-image.sh 写 label)。"; return 1 ;;
  esac
}

# ─────────────────────────── 激活 saga(§1.5)───────────────────────────
# 宿主本地、可注入 restart/smoke/extra 钩子 → 直接自测(模拟第 N 步失败断言复原)。
# 真实部署:deploy-v5.sh ship 本库到 kl-mirror 后以远端命令做钩子调用本函数。
#
# 顺序:[tuple 可行性守卫(R3-B1)]→ [canary boot(R2-M2③,失败零 history 污染)]→ [pre-state history(R2-B2,
#       仅两轴任一启用)]→ snapshot(旧 env 四键 + 旧 current 目标)→ [extra_apply(master 源码
#       symlink 翻转)]→ 写 env tuple → 翻 current → restart → smoke → [commit_apply(deploy_state CAS)]
#       → history append(fsync)→
#       解 trap → GC(库外)。
# **snapshot 之后任一步(含 history 写)失败 → 恢复全部(current/env/extra 逆操作)并 restart 旧
# master → return 1**;pre-state/canary 在 snapshot 之前、不动任何现场,失败直接 return 1(无需回滚)。
# trap 持续到 history fsync 成功后才解除(R3-minor)。
#
# 两机制独立开关(§5)+ 三态写(R2-B1):flip_rev 空 → 不翻 current(bundle 轴未启用);
# release/bundle_value 按轴传新值或**空串**(空串=该轴禁用,env_write_tuple 恒写四键、空值落盘)。
# 用法:oc_hotcfg_activate_saga <env_file> <platform_root> <flip_rev> <hist> \
#         <image> <image_id> <release> <bundle_value> <restart_cmd> <smoke_cmd> \
#         [extra_apply_cmd] [extra_revert_cmd] [master_release] [prev_master_release] \
#         [commit_apply_cmd] [commit_revert_cmd] [manual_recovery_marker] [transition_kind]
# master_release(M7):激活时 master 蓝绿 release 目录,进 history 条目;rollback 从同一条记录取回对齐。
# prev_master_release:激活前 live master；既供首次 pre-state，也作为 v3 previousMasterRelease 入账。
oc_hotcfg_activate_saga() {
  local env_file="$1" platform_root="$2" flip_rev="$3" hist="$4"
  local image="$5" image_id="$6" release="$7" bundle_value="$8"
  local restart_cmd="$9" smoke_cmd="${10}"
  local extra_apply="${11:-}" extra_revert="${12:-}" master_release="${13:-}" prev_master_release="${14:-}"
  local commit_apply="${15:-}" commit_revert="${16:-}" recovery_marker="${17:-}" transition_kind="${18:-joint}"
  case "$transition_kind" in joint|master-only|tuple-only) : ;; *) oc_hotcfg__die "activate_saga: 非法 transition_kind=$transition_kind"; return 1 ;; esac

  # 上一次外部权威提交若处于 unknown，禁止覆盖现场证据或开始另一轮激活。
  if [ -n "$recovery_marker" ] && [ -e "$recovery_marker" ]; then
    oc_hotcfg__die "activate_saga: 存在人工恢复标记，拒绝新激活: $recovery_marker"
    return 1
  fi

  # 0) R3-B1:tuple 可行性守卫(两轴全空也要跑 —— --disable-* 恰是高危场景)。
  #    R3-B2:守卫与 canary 都必须在 pre-state 记账**之前**:canary 失败若已留 history 条目,
  #    hotcfg_history_present 会把 --rollback 导向 tuple 路径而倒数第 2 条不存在 = rollback 报废。
  oc_hotcfg_assert_tuple_viable "$image" "$image_id" "$release" || return 1
  # Master-only format 3:when opt-in is armed or any format-3 tape exists,
  # prove both sides before the candidate can serve. This preserves automatic
  # compensation without a check-then-first-write race.
  oc_hotcfg_assert_master_runtime_batch_pair "$env_file" "$master_release" "$prev_master_release" || return 1

  # 0.3) R2-M2③:canary boot 冒烟(仅两轴任一启用;rev-pinned,不依赖 current/env → 现场未动,
  #      失败直接拒绝激活,无需回滚、history 零污染)。
  if [ -n "$release" ] || [ -n "$flip_rev" ]; then
    oc_hotcfg_canary_boot "$image_id" "$platform_root" "$flip_rev" "$release" || return 1
  fi

  # 0.6) R2-B2:首次启用 pre-state —— history 尚无 committed 条目时,先原子 append 一条"激活前
  #    live 状态"(env 四键**逐字面**,缺键记空 + 激活前 master,preState:true)。保证首次启用后
  #    --rollback=1 能退回启用前(倒数第 2 条=pre-state,配合 R2-B1 三态写把空值也恢复回去)。
  #    该记录反映真实旧现场:saga 后续失败也**不**回滚它;有 committed 条目即不再补(幂等)。
  #    置于守卫/canary 之后(R3-B2):所有"零现场改动即可失败"的检查都过了才记账。
  if [ -z "$(oc_hotcfg_history_last_committed "$hist")" ]; then
    local pre_image pre_image_id pre_release pre_bundle
    pre_image="$(oc_hotcfg_env_get "$env_file" OC_RUNTIME_IMAGE)"
    pre_image_id="$(oc_hotcfg_env_get "$env_file" OC_RUNTIME_IMAGE_ID)"
    pre_release="$(oc_hotcfg_env_get "$env_file" OC_RUNTIME_RELEASE)"
    pre_bundle="$(oc_hotcfg_env_get "$env_file" OC_PLATFORM_BUNDLE)"
    if ! oc_hotcfg_history_append "$hist" "$pre_image" "$pre_image_id" "$pre_release" "$pre_bundle" "$prev_master_release" prestate prestate ""; then
      oc_hotcfg__die "activate_saga: pre-state history 记录写入失败(现场未动,拒绝继续激活)"; return 1
    fi
    oc_hotcfg__log "pre-state 已记账(首次启用;--rollback=1 可退回启用前)"
  fi

  # 1) 快照旧现场(旧 env 四键 + 旧 current 目标)
  local snap; snap="$(mktemp)"
  oc_hotcfg_env_snapshot_tuple "$env_file" > "$snap"
  local old_current=""
  [ -L "$platform_root/current" ] && old_current="$(readlink "$platform_root/current" || true)"

  # 已完成阶段的进度旗标,回滚只逆做已生效者。这些是本函数的局部状态,rollback 闭包内引用。
  local extra_done=0 env_done=0 current_done=0 commit_state=none
  local lossless_writer_candidate=0 lossless_writer_may_have_served=0 lossless_writer_probe_rc=0
  # A capable master can accept v2 tapes. Arm conservatively even if the actual
  # runtime tuple later proves incapable; that only makes rollback stricter.
  # Critically, metadata read/parse failure (rc=2) is "may have served", not
  # "legacy": otherwise a transient probe failure lets compensation fail open.
  oc_hotcfg_probe_master_lossless_capability "$master_release" >/dev/null 2>&1 \
    || lossless_writer_probe_rc=$?
  [ "$lossless_writer_probe_rc" != 1 ] && lossless_writer_candidate=1

  _hotcfg_mark_manual_recovery() { # $1=reason；保持新运行面不动，供人工按标记收敛。
    local reason="$1" tmp
    echo "FATAL [hotcfg] $reason；停止运行面补偿，进入人工恢复态" >&2
    if [ -n "$recovery_marker" ]; then
      tmp="$recovery_marker.tmp.$$"
      umask 077
      mkdir -p "$(dirname "$recovery_marker")" 2>/dev/null || true
      {
        printf 'ts=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf 'reason=%s\n' "$reason"
        printf 'master_target=%s\nmaster_previous=%s\n' "$master_release" "$prev_master_release"
        printf 'history=%s\nsnapshot=%s\n' "$hist" "$snap"
      } > "$tmp" && mv -f "$tmp" "$recovery_marker" \
        || echo "FATAL [hotcfg] 人工恢复标记写入失败:$recovery_marker" >&2
      echo "FATAL [hotcfg] 标记:$recovery_marker（核对 state/runtime 后人工移除）" >&2
    fi
  }

  # 集中回滚(不依赖 ERR trap;由各步 `if ! step` 显式触发。逆序复原后 restart 旧 master)。
  # trap 语义(§1.5)由"任一步失败→_saga_rollback→return 1"等价实现,且覆盖到 history 写为止:
  # history 写在最后一步,其失败同样走本回滚 → 满足"trap 持续到 history fsync 成功后才解除"。
  _hotcfg_saga_rollback() {
    local rb_failed=0 old_image_id old_release
    # Check before deploy_state or any runtime compensation. Once restart was
    # attempted, the candidate may have finalized the first v2 tape. The old
    # stack therefore has to prove reader+writer support unconditionally; a
    # DB floor query here would have a check-then-first-write race.
    if [ "$lossless_writer_may_have_served" = 1 ]; then
      old_image_id="$(oc_hotcfg_env_get "$snap" OC_RUNTIME_IMAGE_ID)"
      old_release="$(oc_hotcfg_env_get "$snap" OC_RUNTIME_RELEASE)"
      [ "$old_image_id" = "<UNSET>" ] && old_image_id=""
      [ "$old_release" = "<UNSET>" ] && old_release=""
      if ! oc_hotcfg_assert_master_lossless_capability "$prev_master_release" \
          || ! oc_hotcfg_assert_tuple_lossless_capability "$old_image_id" "$old_release"; then
        _hotcfg_mark_manual_recovery "lossless writer 已可能对外服务,旧 master/runtime 未证明 $OC_HOTCFG_LOSSLESS_TURN_TAPE_CAP,禁止自动补偿"
        return 1
      fi
    fi
    # deploy_state 是 release 血缘权威。只要提交已尝试且未明确 original，就先用幂等
    # reconcile 钩子把 applied/不确定回执裁决并收敛到 old；未确认前绝不回切运行面。
    if [ "$commit_state" = applied ] || [ "$commit_state" = uncertain ]; then
      if [ -z "$commit_revert" ] || ! eval "$commit_revert"; then
        _hotcfg_mark_manual_recovery "deploy_state commit/revert 无法确认(old 未证实,commit_state=$commit_state)"
        return 1
      fi
      commit_state=old
    fi
    echo "⚠ [hotcfg] 激活 saga 失败且 deploy_state=old 已确认 → 回滚运行面并 restart 旧 master" >&2
    if [ "$current_done" = 1 ]; then
      if [ -n "$old_current" ]; then
        local t="$platform_root/.current.rb.$$"
        rm -f "$t"
        ln -s "$old_current" "$t" && mv -T "$t" "$platform_root/current" 2>/dev/null || rb_failed=1
      else
        rm -f "$platform_root/current" 2>/dev/null || rb_failed=1
      fi
    fi
    if [ "$env_done" = 1 ]; then oc_hotcfg_env_restore_tuple "$env_file" "$snap" || rb_failed=1; fi
    if [ "$extra_done" = 1 ] && [ -n "$extra_revert" ]; then eval "$extra_revert" || rb_failed=1; fi
    eval "$restart_cmd" || rb_failed=1
    # 回滚后的旧现场也必须过与新现场同强度 smoke；否则不能把“命令跑过”当作已收敛。
    eval "$smoke_cmd" || rb_failed=1
    if [ "$rb_failed" != 0 ]; then
      _hotcfg_mark_manual_recovery "deploy_state 已恢复 old，但 env/current/master/restart/smoke 至少一项补偿失败"
      return 1
    fi
    rm -f "$snap"
    return 0
  }

  # 2) extra:master 源码 symlink 翻转(可选,由 deploy-v5.sh 注入)
  if [ -n "$extra_apply" ]; then
    # apply 可能在多条命令中途失败；先标记 attempted，让补偿钩子也覆盖“部分生效”现场。
    extra_done=1
    if ! eval "$extra_apply"; then _hotcfg_saga_rollback; return 1; fi
  fi
  # 3) 写 env tuple
  if ! oc_hotcfg_env_write_tuple "$env_file" "$image" "$image_id" "$release" "$bundle_value"; then
    _hotcfg_saga_rollback; return 1; fi
  env_done=1
  # 4) 翻 current(仅 bundle 机制启用时;flip_rev 空 → 跳过)
  if [ -n "$flip_rev" ]; then
    if ! oc_hotcfg_flip_current "$flip_rev" "$platform_root"; then _hotcfg_saga_rollback; return 1; fi
    current_done=1
  fi
  # 5) restart 新 master
  [ "$lossless_writer_candidate" = 1 ] && lossless_writer_may_have_served=1
  if ! eval "$restart_cmd"; then _hotcfg_saga_rollback; return 1; fi
  # 6) smoke
  if ! eval "$smoke_cmd"; then _hotcfg_saga_rollback; return 1; fi
  # 6.5) 可选外部权威提交(P3=deploy_state release CAS)。失败仍回滚 symlink/env/current+旧 master；
  #       成功后 history 若失败，commit_revert 与其它现场一起补偿。
  if [ -n "$commit_apply" ]; then
    # hook rc:0=applied；10=not-applied 且 original 已确认；其它=unknown。
    # unknown 仍交给幂等 commit_revert 做最终 reconcile；失败则停止运行面补偿并落恢复标记。
    if eval "$commit_apply"; then
      commit_state=applied
    else
      local commit_rc=$?
      if [ "$commit_rc" = 10 ]; then commit_state=old; else commit_state=uncertain; fi
      _hotcfg_saga_rollback || true
      return 1
    fi
  fi
  # 7) commit:history append(fsync,含 masterRelease)。写失败仍触发回滚(覆盖到 history fsync+外部权威)
  if ! oc_hotcfg_history_append "$hist" "$image" "$image_id" "$release" "$bundle_value" "$master_release" "" "$transition_kind" "$prev_master_release"; then
    _hotcfg_saga_rollback; return 1; fi
  # 8) 提交成功 → 轮转 env.bak(m6:只在 commit 成功路径,保留最近 10 份;失败现场备份最近 → 恒保留)
  oc_hotcfg_rotate_env_baks "$env_file" 10 || true
  rm -f "$snap"
  oc_hotcfg__log "激活 saga 提交完成 kind=$transition_kind image_id=$image_id release=$release bundle=${flip_rev:-<unchanged>} master=${master_release:-<unchanged>} parent=${prev_master_release:-<none>}"
  return 0
}

# ─────────────────────────── GC(§1.4)───────────────────────────
# 保护集 = {history 最近 N 条 committed 引用} ∪ {emergency tuple 引用} ∪ {当前 env tuple + 上一条 committed}
#        ∪ {docker managed 容器 label 引用的 release/bundle_rev} ∪ {.staging-*}
# docker 命令失败 → 本轮**放弃 GC** 并告警(不误删运行中容器仍引用的制品)。
# 其余 rel-*/bundles/* 目录 rm -rf 并记 artifact_retired。
# 容器 label:com.openclaude.runtime.release / com.openclaude.runtime.bundle_rev
# managed 过滤 label:com.openclaude.runtime_channel=v5
oc_hotcfg_gc() {
  local env_file="${1:-$OC_HOTCFG_ENV_FILE}" hist="${2:-$OC_HOTCFG_HISTORY}"
  local protect_rel protect_bun tmp_rel tmp_bun
  tmp_rel="$(mktemp)"; tmp_bun="$(mktemp)"
  # 退休台账(m5):删除成功后向 history 同目录的 runtime-artifacts-retired.log 原子 append。
  local retire_log; retire_log="$(dirname "$hist")/runtime-artifacts-retired.log"
  _hotcfg_retire() {  # $1=abs path;记一行 ts\tpath(O_APPEND 短行原子)
    local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    mkdir -p "$(dirname "$retire_log")" 2>/dev/null || true
    printf '%s\t%s\n' "$ts" "$1" >> "$retire_log" 2>/dev/null || true
  }

  _hotcfg_protect() {  # $1=release_path $2=bundle_path(abs)
    [ -n "$1" ] && printf '%s\n' "$1" >> "$tmp_rel"
    [ -n "$2" ] && printf '%s\n' "$2" >> "$tmp_bun"
    # 显式 return 0:两参皆可为空(pre-state/禁用轴 tuple),末条 [ -n '' ] 的 1 会在
    # set -e 严格壳里炸掉整个 GC(2026-07-12 部署期"GC 失败"告警的真身,手动宽松壳跑不出来)。
    return 0
  }

  # (a) history 最近 N 条 committed(校验走 oc_hotcfg__history_verify_line 单一权威,R2-M3:v1/v2 混存都认)
  local n=0 line verified release bundle
  while IFS= read -r line && [ "$n" -lt "$OC_HOTCFG_KEEP_TUPLES" ]; do
    [ -n "$line" ] || continue
    verified="$(oc_hotcfg__history_verify_line "$line")" || continue
    release="$(jq -r '.release' <<<"$verified")"; bundle="$(jq -r '.bundle' <<<"$verified")"
    _hotcfg_protect "$release" "$bundle"; n=$((n+1))
  done < <(tac "$hist" 2>/dev/null || true)

  # (b) emergency tuple 引用
  if [ -f "$env_file" ]; then
    local emerg; emerg="$(oc_hotcfg_env_get "$env_file" "$OC_HOTCFG_EMERGENCY_KEY")"
    if [ -n "$emerg" ]; then
      _hotcfg_protect "$(jq -r '.release // empty' <<<"$emerg" 2>/dev/null)" "$(jq -r '.bundle // empty' <<<"$emerg" 2>/dev/null)"
    fi
    # (c) 当前 env tuple
    _hotcfg_protect "$(oc_hotcfg_env_get "$env_file" OC_RUNTIME_RELEASE)" "$(oc_hotcfg_env_get "$env_file" OC_PLATFORM_BUNDLE)"
  fi

  # (d) docker managed 容器 label —— 失败即放弃 GC。
  # B4:supervisor label 值是 **basename**(release=rel-<12hex>、bundle_rev=<12hex>),不是绝对路径;
  # 单次 inspect 同时取两 label(任一容器 inspect 失败=放弃本轮,不再 `|| true` 静默);对取回值做
  # 格式校验后再拼 releases/bundles 根为绝对路径入保护集。空值=该容器无此机制引用(跳过);非空但
  # 格式不符=视为 inspect 失败(放弃本轮 GC,防"形态异常的 label 实指某 release 却漏保护"静默漏删)。
  local cids cid pair rel bun
  if ! cids="$("$OC_DOCKER_BIN" ps -aq --filter 'label=com.openclaude.runtime_channel=v5' 2>/dev/null)"; then
    echo "⚠ [hotcfg] docker ps 失败 → 本轮放弃 GC(不误删运行中容器仍引用的制品)" >&2
    rm -f "$tmp_rel" "$tmp_bun"; return 0
  fi
  for cid in $cids; do
    if ! pair="$("$OC_DOCKER_BIN" inspect --format '{{ index .Config.Labels "com.openclaude.runtime.release" }}{{"\t"}}{{ index .Config.Labels "com.openclaude.runtime.bundle_rev" }}' "$cid" 2>/dev/null)"; then
      echo "⚠ [hotcfg] docker inspect $cid 失败 → 本轮放弃 GC" >&2
      rm -f "$tmp_rel" "$tmp_bun"; return 0
    fi
    rel="${pair%%$'\t'*}"; bun="${pair#*$'\t'}"
    if [ -n "$rel" ]; then
      if [[ "$rel" =~ ^rel-[0-9a-f]{12}$ ]]; then
        printf '%s\n' "$OC_HOTCFG_RELEASES_ROOT/$rel" >> "$tmp_rel"
      else
        echo "⚠ [hotcfg] 容器 $cid release label 形态异常('$rel' 非 rel-<12hex>)→ 本轮放弃 GC(防静默漏保护)" >&2
        rm -f "$tmp_rel" "$tmp_bun"; return 0
      fi
    fi
    if [ -n "$bun" ]; then
      if [[ "$bun" =~ ^[0-9a-f]{12}$ ]]; then
        printf '%s\n' "$OC_HOTCFG_PLATFORM_ROOT/bundles/$bun" >> "$tmp_bun"
      else
        echo "⚠ [hotcfg] 容器 $cid bundle_rev label 形态异常('$bun' 非 <12hex>)→ 本轮放弃 GC(防静默漏保护)" >&2
        rm -f "$tmp_rel" "$tmp_bun"; return 0
      fi
    fi
  done

  local protect_rel_set protect_bun_set
  protect_rel_set="$(LC_ALL=C sort -u "$tmp_rel")"; protect_bun_set="$(LC_ALL=C sort -u "$tmp_bun")"
  rm -f "$tmp_rel" "$tmp_bun"

  # (e) 回收 release:rel-* 目录不在保护集 → rm -rf
  local d
  if [ -d "$OC_HOTCFG_RELEASES_ROOT" ]; then
    for d in "$OC_HOTCFG_RELEASES_ROOT"/rel-*; do
      [ -d "$d" ] || continue
      if ! grep -qxF "$d" <<<"$protect_rel_set"; then
        rm -rf "$d" && { echo "  [hotcfg] artifact_retired release: $d" >&2; _hotcfg_retire "$d"; }
      fi
    done
    # 清孤儿 staging / ccb 构建临时目录(>1 天)
    find "$OC_HOTCFG_RELEASES_ROOT" -maxdepth 1 \( -name '.staging-*' -o -name '.raw-*' -o -name '.ccbbuild-*' \) -mtime +1 -exec rm -rf {} + 2>/dev/null || true
  fi
  # (f) 回收 bundle:bundles/* 目录不在保护集 → rm -rf(current 指向者一定在 env tuple 保护集内)
  if [ -d "$OC_HOTCFG_PLATFORM_ROOT/bundles" ]; then
    for d in "$OC_HOTCFG_PLATFORM_ROOT"/bundles/*; do
      [ -d "$d" ] || continue
      if ! grep -qxF "$d" <<<"$protect_bun_set"; then
        rm -rf "$d" && { echo "  [hotcfg] artifact_retired bundle: $d" >&2; _hotcfg_retire "$d"; }
      fi
    done
    find "$OC_HOTCFG_PLATFORM_ROOT/bundles" -maxdepth 1 \( -name '.staging-*' -o -name '.ccbbuild-*' \) -mtime +1 -exec rm -rf {} + 2>/dev/null || true
  fi
  oc_hotcfg__log "GC 完成(保护 release=$(grep -c . <<<"$protect_rel_set") bundle=$(grep -c . <<<"$protect_bun_set"))"
}
