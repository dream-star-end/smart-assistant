#!/usr/bin/env bash
# v5-web-overlay-lib.sh — P0-Web 前端构建目录热切换(OCV5-489)的纯函数库。
#
# 机制(master 侧见 packages/gateway/src/webRootOverlay.ts):
#   <overlay-root>/<rel-*>/current   → 符号链接,master 启动时若存在就 serve 这条路径
#   <overlay-root>/<rel-*>/webroots/<oc-build>/      一份完整 SPA(上一份 ∪ 新构建的 assets)
#   <overlay-root>/<rel-*>/webroots/<oc-build>.json  元数据(不放进 webroot,否则会被公开 serve)
#   <overlay-root>/<rel-*>/history                   每次翻转追加一行:<epoch> <target> <build> <sha>
# 指针按 release 目录名分桶:普通发布/回滚换了 release,master 查的是新 release 自己的桶,
# 旧 overlay 不可能套到新后端上。翻转 = 同目录 symlink + rename(原子),master 不重启。
#
# 本文件只放可在临时目录里单测的函数(scripts/__tests__/v5WebOverlay.test.ts):
# 不取锁、不碰 systemd、不 die;失败 return 非零并把原因写 stderr。编排在部署脚本里。

WO_KEEP_WEBROOTS="${WO_KEEP_WEBROOTS:-5}"

# P0-Web 允许的改动面(相对 live release 的 sourceCommit)。只要有一个文件不在这里 → 不是
# 纯前端静态面,必须走普通发布。package.json / lock / vite 配置刻意不在其中:
# 2026-10-17 #809 改了 web-react/package.json 版本号,打爆 runtime digest,重建了在线用户容器。
WO_ALLOWED_PATH_RE='^(packages/web-react/(src|public|browser-tests|docs)/|packages/web-react/(index|admin)\.html$|e2e/)'

wo_err() { echo "$*" >&2; }

wo_build_id_of() { # <dir> → stdout oc-build(8-32 hex);缺失 rc=1
  local id
  id="$(grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$1/index.html" 2>/dev/null \
    | grep -o '[0-9a-f]\{8,32\}' | head -1)" || return 1
  [[ -n "$id" ]] || return 1
  printf '%s\n' "$id"
}

wo_bucket() { # <overlay-root> <release-abs> → stdout 桶目录
  local key
  key="$(basename -- "$2")"
  [[ "$key" =~ ^rel-[A-Za-z0-9._-]+$ ]] || { wo_err "不是 rel-* release 目录: $2"; return 1; }
  printf '%s/%s\n' "$1" "$key"
}

wo_current_target() { # <bucket> → stdout 指针指向的绝对路径
  [[ -L "$1/current" ]] || return 1
  readlink -- "$1/current"
}

# 原子换指针:同目录建临时 symlink 再 rename(mv -T)。master 下一个请求经 stat 回验即跟随。
wo_point() { # <bucket> <target-abs>
  local bucket="$1" target="$2" tmp
  [[ -f "$target/index.html" ]] || { wo_err "目标缺 index.html: $target"; return 1; }
  mkdir -p -- "$bucket" || return 1
  tmp="$bucket/.current.tmp.$$"
  rm -f -- "$tmp"
  ln -s -- "$target" "$tmp" || return 1
  mv -T -- "$tmp" "$bucket/current" || { rm -f -- "$tmp"; return 1; }
}

wo_append_history() { # <bucket> <target> <build> <sha>
  printf '%s %s %s %s\n' "$(date +%s)" "$2" "$3" "$4" >>"$1/history"
}

# 普通发布 cutover 时调用:给新 release 建桶并把指针指向它自带的 dist。已有指针不动
# (同一 release 重复 cutover 时保留其上已生效的 P0-Web)。
wo_seed_pointer() { # <overlay-root> <release-abs> <source-sha>
  local bucket dist build
  bucket="$(wo_bucket "$1" "$2")" || return 1
  [[ -L "$bucket/current" ]] && return 0
  dist="$2/packages/web-react/dist"
  build="$(wo_build_id_of "$dist")" || { wo_err "release dist 缺 oc-build: $dist"; return 1; }
  wo_point "$bucket" "$dist" || return 1
  wo_append_history "$bucket" "$dist" "$build" "$3"
}

# 相对 live sourceCommit 的改动面判定。stdout 打印不在白名单的文件;全在白名单 rc=0。
# --no-renames:rename 拆成删除 + 新增,源路径(可能是后端文件)同样要过白名单。
wo_check_surface() { # <repo> <from-sha> <to-sha>
  local files bad
  files="$(git -C "$1" diff --name-only --no-renames "$2" "$3")" || { wo_err "git diff $2..$3 失败"; return 2; }
  [[ -n "$files" ]] || { wo_err "live 与目标之间没有改动"; return 2; }
  bad="$(grep -Ev "$WO_ALLOWED_PATH_RE" <<<"$files" || true)"
  if [[ -n "$bad" ]]; then
    printf '%s\n' "$bad"
    return 1
  fi
  return 0
}

# 组装新 webroot = 当前指针目标(硬链)∪ 新 dist。assets 只加不删:已打开的旧标签页懒加载的
# 旧 chunk 仍 200;根文件按新 dist 覆盖(--delete 只作用于 assets 以外)。rsync 先写临时文件再
# rename,不会改到与上一份 webroot(乃至不可变 release dist)共享 inode 的文件;--checksum 让同名
# 同内容的 chunk 保持硬链。刻意不用 -a:-t/-p 会对内容相同的硬链文件就地改 mtime/权限。
# 目录名 = <oc-build>-<sha12>-<基线8>:oc-build 只哈希 index.html,不同提交可能同 id;基线(组装时的
# 指针目标)不同,union 出来的 assets 也不同。三者都相同的目录内容必然相同,直接复用;本函数
# 从不删除任何已有 webroot(它可能正被 serve 或是回退目标)。
wo_stage_webroot() { # <bucket> <new-dist> <source-sha> <base-release> → stdout 新 webroot
  local bucket="$1" dist="$2" sha="$3" base="$4" build cur dest tmp name
  build="$(wo_build_id_of "$dist")" || { wo_err "新 dist 缺 oc-build meta"; return 1; }
  cur="$(wo_current_target "$bucket")" || { wo_err "桶内没有当前指针: $bucket"; return 1; }
  name="$build-${sha:0:12}-$(printf '%s' "$cur" | sha256sum | cut -c1-8)"
  dest="$bucket/webroots/$name"
  if [[ -d "$dest" && -f "$dest.json" ]]; then
    printf '%s\n' "$dest"
    return 0
  fi
  mkdir -p -- "$bucket/webroots" || return 1
  tmp="$bucket/webroots/.staging.$name.$$"
  rm -rf -- "$tmp"
  cp -al -- "$cur/." "$tmp/" 2>/dev/null || { rm -rf -- "$tmp"; cp -a -- "$cur/." "$tmp/"; } || return 1
  mkdir -p -- "$tmp/assets" || return 1
  rsync -rl --checksum --delete --exclude '/assets/' -- "$dist/" "$tmp/" || { rm -rf -- "$tmp"; return 1; }
  if [[ -d "$dist/assets" ]]; then
    rsync -rl --checksum -- "$dist/assets/" "$tmp/assets/" || { rm -rf -- "$tmp"; return 1; }
  fi
  jq -n --arg build "$build" --arg sha "$sha" --arg base "$base" --arg prev "$cur" \
    '{buildId: $build, sourceCommit: $sha, baseRelease: $base, previous: $prev, createdAt: (now | floor)}' \
    >"$dest.json" || { rm -rf -- "$tmp"; return 1; }
  mv -T -- "$tmp" "$dest" || { rm -rf -- "$tmp"; return 1; }
  printf '%s\n' "$dest"
}

# 切换前静态门:oc-build 等于期望;index.html / admin.html 引用的每个 /assets/* 都在 webroot 里。
wo_static_gate() { # <webroot> <expected-build>
  local root="$1" want="$2" got page ref missing=0
  got="$(wo_build_id_of "$root")" || { wo_err "webroot 缺 oc-build: $root"; return 1; }
  [[ "$got" == "$want" ]] || { wo_err "webroot oc-build=$got ≠ 期望 $want"; return 1; }
  [[ -f "$root/admin.html" ]] || { wo_err "webroot 缺 admin.html"; return 1; }
  for page in index.html admin.html; do
    while IFS= read -r ref; do
      [[ -n "$ref" ]] || continue
      if [[ ! -f "$root$ref" ]]; then
        wo_err "  $page 引用的 $ref 不存在"
        missing=1
      fi
    done < <(grep -oE '(src|href)="/assets/[^"?#]+' "$root/$page" | sed -E 's/^(src|href)="//' | sort -u)
  done
  [[ "$missing" == 0 ]]
}

# webroot 元数据记录的组装基线(组装时的指针目标)。切换前回验:等锁期间指针变了就不能切。
wo_staged_from() { # <webroot>
  jq -er '.previous' "$1.json" 2>/dev/null
}

# 回到上一份:history 里倒数第二个**不同于当前**的目标(默认 N=1)。
wo_previous_target() { # <bucket> [N]
  local bucket="$1" n="${2:-1}" cur line target seen=0
  cur="$(wo_current_target "$bucket")" || return 1
  [[ -f "$bucket/history" ]] || return 1
  while IFS= read -r line; do
    target="$(awk '{print $2}' <<<"$line")"
    [[ -n "$target" && "$target" != "$cur" && -f "$target/index.html" ]] || continue
    seen=$((seen + 1))
    if [[ "$seen" == "$n" ]]; then
      printf '%s\n' "$target"
      return 0
    fi
  done < <(tac -- "$bucket/history")
  return 1
}

# 当前是否有生效的 P0-Web overlay(指针不指向 release 自带 dist)。有 → stdout 它的 sourceCommit。
# 回退时 history 的 sha 列可能是 "revert",所以只认 webroot 自己的元数据。
wo_active_overlay_commit() { # <overlay-root> <release-abs>
  local bucket cur
  bucket="$(wo_bucket "$1" "$2")" || return 1
  cur="$(wo_current_target "$bucket")" || return 0
  [[ "$cur" == "$2/packages/web-react/dist" ]] && return 0
  jq -er '.sourceCommit' "$cur.json" 2>/dev/null || { wo_err "overlay 元数据缺失: $cur.json"; return 1; }
}

# release 已被 GC 的桶整桶删除(它的 webroot 硬链着已删 release 的 assets,不删就一直占盘)。
wo_gc_buckets() { # <overlay-root> <releases-root>
  local b
  [[ -d "$1" ]] || return 0
  for b in "$1"/rel-*/; do
    b="${b%/}"
    [[ -d "$b" && ! -L "$b" ]] || continue
    [[ -d "$2/$(basename -- "$b")" ]] && continue
    rm -rf -- "$b"
    echo "P0-Web overlay 桶已随 release 删除: $(basename -- "$b")"
  done
}

# 只留当前、history 里最近 WO_KEEP_WEBROOTS 个目标;其余 webroot 目录与元数据删除。
wo_gc_webroots() { # <bucket>
  local bucket="$1" cur keep d
  cur="$(wo_current_target "$bucket")" || return 0
  keep="$(printf '%s\n' "$cur"; [[ -f "$bucket/history" ]] && tac -- "$bucket/history" | awk '{print $2}' | awk '!s[$0]++' | head -n "$WO_KEEP_WEBROOTS")"
  for d in "$bucket"/webroots/*/; do
    d="${d%/}"
    [[ -d "$d" ]] || continue
    grep -qxF -- "$d" <<<"$keep" && continue
    rm -rf -- "$d" "$d.json"
  done
}
