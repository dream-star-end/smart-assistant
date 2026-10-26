#!/usr/bin/env bash
# v5-web-assets-pool-lib.sh — 个人版 /assets 资产池(OCV5-633,X-P1-1 PR-b)的纯函数库。
#
# 机制(master 侧见 packages/gateway/src/httpUploadStatic.ts staticFileCandidates,PR-a #1146):
#   <pool>/assets/<内容哈希文件>   历次 live 前端 serve 过的资产(加法式,不含 .map,不含符号链接)
#   master 在 spa 模式下 /assets/* 于当前 webRoot 未命中时回落这里(按真实路径判包含)。
# 发版前把「此刻 live 正在 serve 的资产」播种进池:切流后仍开着的旧标签页懒加载的正是这一份;
# 新 release 的资产由它自己的 webRoot 提供,下一次发版它成为 live 时再被播种。
# 与商业 union 池(deploy-v5.sh sync_assets_to_pool / gc_assets_pool)同语义:加法同步、排除 .map、
# 显式保护集 GC。差别:同步不保留源 mtime,池里文件的 mtime = 最近一次作为 live 被播种的时间,
# GC 的「超过 N 天」因此量的是「离开 live 多久」。
#
# 本文件只放可在临时目录里单测的函数(scripts/__tests__/v5WebAssetsPool.test.ts):
# 不取锁、不碰 systemd、不 die;失败 return 非零并把原因写 stderr。编排在部署脚本里。

wap_err() { echo "$*" >&2; }

# 此刻 master serve 的资产目录:live release 的 P0-Web 指针有效(与 webRootOverlay.ts 同判据:
# current 是符号链接且其下有 index.html)→ 指针 webroot/assets;否则 release 自带 dist/assets。
wap_live_assets_dir() { # <overlay-root> <live-release-abs> → stdout 目录
  local overlay="$1" live="$2" bucket
  [[ -n "$live" && -d "$live" ]] || { wap_err "live release 不存在: ${live:-<空>}"; return 1; }
  if [[ -n "$overlay" ]]; then
    bucket="$overlay/$(basename -- "$live")"
    if [[ -L "$bucket/current" && -f "$bucket/current/index.html" ]]; then
      printf '%s\n' "$bucket/current/assets"
      return 0
    fi
  fi
  printf '%s\n' "$live/packages/web-react/dist/assets"
}

# 加法同步:每个存在的源目录同步进 <pool>/assets。无 --delete;排除 *.map;只拷普通文件
# (rsync -r 不带 -l,符号链接跳过);不保留源 mtime(见文件头),且 -I 每次都重写:否则大小与
# mtime 恰好相同的文件会被 rsync 的快速比对跳过,mtime 不刷新,GC 会把仍在 live 的资产算成「已离开」。
# 每次约一份前端资产(~10MB)。不存在的源目录跳过。
wap_sync() { # <pool-root> <src-assets-dir>... → stdout synced=<n>
  local pool="$1" src n=0
  shift
  [[ "$pool" == /* ]] || { wap_err "资产池根必须是绝对路径: ${pool:-<空>}"; return 1; }
  command -v rsync >/dev/null || { wap_err "缺 rsync"; return 1; }
  mkdir -p -- "$pool/assets" || { wap_err "建不了 $pool/assets"; return 1; }
  for src in "$@"; do
    [[ -d "$src" ]] || continue
    rsync -r -I --exclude='*.map' "$src/" "$pool/assets/" \
      || { wap_err "rsync 失败: $src → $pool/assets"; return 1; }
    n=$((n + 1))
  done
  printf 'synced=%d\n' "$n"
}

# 显式保护集 GC:保护集 = 各保护目录下文件相对路径的并集;只删池内「不在保护集且 mtime 超过
# <days> 天」的条目。一个保护目录都不存在 → fail-closed,一个都不删。读保护目录出错 → 不删、rc≠0。
wap_gc() { # <pool-root> <max-age-days> <protected-assets-dir>... → stdout 摘要
  local pool="$1" days="$2" dir protect rel dirs=0 kept del=0
  shift 2
  [[ "$days" =~ ^[1-9][0-9]*$ ]] || { wap_err "非法天数: ${days:-<空>}"; return 1; }
  [[ -d "$pool/assets" ]] || { echo "池不存在,跳过"; return 0; }
  protect="$(mktemp)" || return 1
  for dir in "$@"; do
    [[ -d "$dir" ]] || continue
    dirs=$((dirs + 1))
    find "$dir" -type f -printf '%P\n' >>"$protect" \
      || { rm -f -- "$protect"; wap_err "读保护目录失败: $dir"; return 1; }
  done
  if ((dirs == 0)); then
    rm -f -- "$protect"
    echo "保护集为空,fail-closed 不删"
    return 0
  fi
  sort -u -o "$protect" "$protect"
  kept="$(wc -l <"$protect")"
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    grep -qxF -- "$rel" "$protect" && continue
    rm -f -- "$pool/assets/$rel" && del=$((del + 1))
  done < <(find "$pool/assets" \( -type f -o -type l \) -mtime "+$days" -printf '%P\n')
  rm -f -- "$protect"
  printf 'protected=%s deleted=%d\n' "$kept" "$del"
}

# 回落面探针:池里取一个当前 webRoot 没有的 .js,经 master GET 必须 200。池为空或没有这样的
# 文件(还没发过改前端的版本)→ 跳过(rc=0)。
wap_fallback_probe() { # <base-url> <pool-root> <webroot-assets-dir> → stdout 结论
  local base="$1" pool="$2" web="$3" f code
  [[ -d "$pool/assets" ]] || { echo "跳过:池为空"; return 0; }
  f="$(comm -23 \
    <(find "$pool/assets" -maxdepth 1 -type f -name '*.js' -printf '%P\n' | sort) \
    <(find "$web" -maxdepth 1 -type f -printf '%P\n' 2>/dev/null | sort) | head -1)"
  [[ -n "$f" ]] || { echo "跳过:池里没有当前 webRoot 之外的 chunk"; return 0; }
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$base/assets/$f" 2>/dev/null || true)"
  [[ "$code" == 200 ]] || { wap_err "GET /assets/$f → HTTP ${code:-000}(期望 200,来自池)"; return 1; }
  echo "/assets/$f 200(来自池)"
}
