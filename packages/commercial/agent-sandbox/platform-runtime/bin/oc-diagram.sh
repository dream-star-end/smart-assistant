#!/bin/bash
# oc-diagram — 容器内确定性矢量示意图渲染:Typst + CeTZ/fletcher 源(.typ)→ PDF(矢量)
# + 可选 SVG/PNG(位图,进报告)。用于精密机制/装置/几何/通路示意图 —— matplotlib 硬画
# 框线会是"草图感",生成式插画被禁,CeTZ 出的图矢量、对齐严谨、天生可投稿。
# CeTZ 0.4.2 / fletcher 0.5.8 已在 build 时预置到 /opt/typst-cache(runtime 无外网,离线可用)。
# 文档见 scientific-figures baseline skill。
set -euo pipefail

# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"

TOOL=oc-diagram
usage() {
  echo "用法: $TOOL <input.typ> [-o out.pdf] [--png] [--svg] [--ppi N]"
  echo "  默认出 PDF(矢量);--png 追加位图(进报告/前端图片卡),--svg 追加矢量 SVG。"
  echo "  产物绝对路径打印到 stdout(末行为主产物,有 --png 时末行=png)。"
}

[ $# -ge 1 ] || { usage >&2; exit 1; }
input=""; output=""; want_png=0; want_svg=0; ppi=300
while [ $# -gt 0 ]; do
  case "$1" in
    -o) output="${2:-}"; shift 2 ;;
    --png) want_png=1; shift ;;
    --svg) want_svg=1; shift ;;
    --ppi) ppi="${2:-300}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "$TOOL: 未知参数 $1" >&2; usage >&2; exit 1 ;;
    *) input="$1"; shift ;;
  esac
done
[ -n "$input" ] && [ -f "$input" ] || { echo "$TOOL: 找不到输入 .typ 源文件: $input" >&2; exit 1; }

# 定位 typst(Quarto 自带,架构无关地取);离线包缓存(build 预置的 CeTZ/fletcher)。
TYPST="$(ls /opt/quarto/bin/tools/*/typst 2>/dev/null | head -1 || true)"
[ -n "$TYPST" ] || TYPST="$(command -v typst 2>/dev/null || true)"
[ -n "$TYPST" ] || { echo "$TOOL: 未找到 typst(应随 Quarto 预装)" >&2; exit 1; }
export TYPST_PACKAGE_CACHE_PATH="${TYPST_PACKAGE_CACHE_PATH:-/opt/typst-cache}"

abspath() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$(pwd)" "$1" ;; esac; }
stem="${input%.*}"
[ -n "$output" ] || output="${stem}.pdf"
FONTS=/usr/share/fonts  # Noto Serif/Sans CJK 已装,CeTZ content 里的中文自动 fallback

render() { # <outfile>
  if ! "$TYPST" compile --font-path "$FONTS" --ppi "$ppi" "$input" "$1" 2>/tmp/ocdiag.err; then
    echo "$TOOL: typst 渲染失败(检查 .typ 语法 / CeTZ 版本 @preview/cetz:0.4.2):" >&2
    sed -n '1,25p' /tmp/ocdiag.err >&2
    return 1
  fi
}

# 主产物(默认 PDF 矢量)先渲染;SVG 次之;PNG 放最后 print —— 前端按末行产物路径渲染
# 图片卡片,进报告的位图应是 png,故末行优先给 png。
render "$output"
main_line="$(abspath "$output")"
[ "$want_svg" = 1 ] && { svg="${stem}.svg"; render "$svg" && echo "$(abspath "$svg")"; }
if [ "$want_png" = 1 ]; then
  png="${stem}.png"; render "$png" && { echo "$main_line"; echo "$(abspath "$png")"; }
else
  echo "$main_line"
fi
