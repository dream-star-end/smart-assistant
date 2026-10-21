# OCV5-549: workspace links in an existing worktree node_modules.
#
# deploy-v5-selfhost.sh skips `npm ci` when the worktree already has node_modules (other worktrees
# share it; reinstalling under them is disruptive). A workspace package added later (P0c:
# @openclaude/kernel) then has no node_modules/<name> link there, and anything run from the worktree
# (migration runner, seed CLI) fails with ERR_MODULE_NOT_FOUND once code imports it.
#
# ws_links_ensure <repo>: for every root package.json workspace, node_modules/<name> must be a link
# to that workspace. Missing → create the same relative link `npm ci` would; only when every
# dependency the package declares is already installed (else exit 1: run npm ci). Present but not
# pointing at the workspace → exit 1 (never repaired silently). DRY=1 → print, change nothing.
# Prints one line per link created; nothing when all links are in place.

ws_links_ensure() { # <repo-root>
  local root="$1" lines rc=0 name dir deps link want rel d missing
  lines="$(node -e '
    const fs = require("fs"), path = require("path"), root = process.argv[1];
    const ws = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).workspaces || [];
    const pkgs = [];
    for (const dir of ws) {
      const f = path.join(root, dir, "package.json");
      if (!fs.existsSync(f)) { console.log(["MISSING", dir].join("\t")); continue; }
      pkgs.push([dir, JSON.parse(fs.readFileSync(f, "utf8"))]);
    }
    // a dependency on another workspace is satisfied by that workspace (linked in this same pass)
    const names = new Set(pkgs.map(([, p]) => p.name));
    for (const [dir, p] of pkgs) {
      const deps = Object.keys({ ...(p.dependencies || {}), ...(p.optionalDependencies || {}) });
      console.log(["PKG", p.name, dir, deps.filter((d) => !names.has(d)).join(" ")].join("\t"));
    }
  ' "$root")" || { echo "  ✗ 读不了 $root/package.json 的 workspaces" >&2; return 1; }
  while IFS=$'\t' read -r kind name dir deps; do
    [[ -n "$kind" ]] || continue
    if [[ "$kind" == MISSING ]]; then
      echo "  ✗ workspace $name 没有 package.json" >&2; rc=1; continue
    fi
    link="$root/node_modules/$name"
    want="$(cd "$root/$dir" && pwd -P)"
    if [[ -e "$link" || -L "$link" ]]; then
      if [[ "$(cd "$link" 2>/dev/null && pwd -P)" != "$want" ]]; then
        echo "  ✗ node_modules/$name 不指向 $dir(补救: 在 $root 跑 npm ci)" >&2; rc=1
      fi
      continue
    fi
    missing=""
    for d in $deps; do
      [[ -e "$root/node_modules/$d" ]] || missing+=" $d"
    done
    if [[ -n "$missing" ]]; then
      echo "  ✗ node_modules/$name 缺失,且它的依赖未安装:$missing(补救: 在 $root 跑 npm ci)" >&2
      rc=1; continue
    fi
    # same relative form npm ci writes: node_modules/@scope/x -> ../../dir, node_modules/x -> ../dir
    if [[ "$name" == */* ]]; then rel="../../$dir"; else rel="../$dir"; fi
    if [[ "${DRY:-0}" == 1 ]]; then
      echo "  [dry-run] ln -s $rel node_modules/$name"
      continue
    fi
    mkdir -p "$(dirname "$link")" && ln -s "$rel" "$link" || { echo "  ✗ 无法创建 node_modules/$name" >&2; rc=1; continue; }
    echo "  + node_modules/$name -> $rel"
  done <<<"$lines"
  return "$rc"
}
