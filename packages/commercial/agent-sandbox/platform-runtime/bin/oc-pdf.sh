#!/usr/bin/env bash
# oc-pdf — 容器内确定性 PDF 生成:源 Markdown/Quarto -> 排版良好的 PDF。
#
# 走 Quarto 内置的 **Typst** 引擎(不依赖 LaTeX/texlive,镜像更小),中文由
# fonts-noto-cjk 提供字形。适合报告/方案/合同/通知等"格式化文档 → PDF"。
# 需要精确坐标排版的票据/表单请在 office-pdf skill 里用 reportlab 直接写 Python。
set -euo pipefail

# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"

# 默认中文主字体(镜像预装 fonts-noto-cjk);可用 --mainfont 覆盖或 OC_PDF_MAINFONT 环境变量。
DEFAULT_MAINFONT="${OC_PDF_MAINFONT:-Noto Serif CJK SC}"

usage() {
  cat <<'USAGE'
用法:
  oc-pdf [--mainfont "字体名"] [-o OUTPUT.pdf] INPUT.{md,qmd}

示例:
  oc-pdf report.md
  oc-pdf plan.md -o /home/agent/.openclaude/plan.pdf
  oc-pdf --mainfont "Noto Sans CJK SC" notice.md

说明:
  - 走 Quarto 内置 Typst 引擎(无需 LaTeX);中文字体默认 "Noto Serif CJK SC"。
  - 支持标题/列表/表格/代码/LaTeX 数学 $...$。
  - 若未检测到 quarto,则降级产出 .qmd(可后续手动渲染)。
USAGE
}

mainfont="$DEFAULT_MAINFONT"
output=""
input=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mainfont)
      [[ $# -ge 2 ]] || { echo "oc-pdf: --mainfont 需要一个值" >&2; exit 2; }
      mainfont="$2"; shift 2 ;;
    -o|--output)
      [[ $# -ge 2 ]] || { echo "oc-pdf: --output 需要一个路径" >&2; exit 2; }
      output="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    --) shift; break ;;
    -*)
      echo "oc-pdf: 未知选项 $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$input" ]]; then input="$1"; else echo "oc-pdf: 只接受一个输入文件" >&2; exit 2; fi
      shift ;;
  esac
done
[[ -n "${1:-}" && -z "$input" ]] && input="$1"

[[ -n "$input" ]] || { usage >&2; exit 2; }
[[ -f "$input" ]] || { echo "oc-pdf: 输入文件不存在: $input" >&2; exit 1; }

case "$input" in
  *.md|*.qmd|*.markdown) : ;;
  *) echo "oc-pdf: 输入需为 .md / .qmd" >&2; exit 2 ;;
esac

# 输出路径:默认与输入同名 .pdf
if [[ -z "$output" ]]; then
  output="${input%.*}.pdf"
fi
# 确保输出目录存在(用户常给 /home/agent/.openclaude/子目录/x.pdf)
mkdir -p "$(dirname "$output")"
out_dir="$(cd "$(dirname "$output")" && pwd)"
out_base="$(basename "$output")"
out_abs="$out_dir/$out_base"

if ! command -v quarto >/dev/null 2>&1; then
  # 降级:拷成 .qmd 供后续手动渲染
  qmd="${output%.*}.qmd"
  cp "$input" "$qmd"
  echo "oc-pdf: 未检测到 quarto,已产出 $qmd(降级)" >&2
  echo "$qmd"
  exit 0
fi

# Typst 渲染。-M mainfont 让 Typst 用 CJK 字体,避免中文豆腐块。
# 用临时工作目录避免污染源目录的中间产物。**必须 cd 进 work 再 render**:quarto 的
# --output 是相对输入所在目录解析的,不 cd 会把产物写到意外的相对路径(../../),
# 与 oc-poster 的 cwd:dir 范式一致。
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
src_base="$(basename "$input")"
cp "$input" "$work/$src_base"

if ( cd "$work" && quarto render "$src_base" \
      --to typst \
      -M "mainfont:$mainfont" \
      --output "$out_base" ) >/dev/null 2>"$work/err.log"; then
  # quarto 把输出写到 work 目录(cwd);搬到目标目录
  produced="$work/$out_base"
  if [[ -f "$produced" ]]; then
    mv -f "$produced" "$out_abs"
  fi
  if [[ -f "$out_abs" ]]; then
    echo "$out_abs"
    exit 0
  fi
fi

# 渲染失败:降级产 .qmd 并回显 stderr 关键信息
qmd="${output%.*}.qmd"
cp "$input" "$qmd"
echo "oc-pdf: quarto typst 渲染失败,已降级产出 $qmd" >&2
sed -n '1,20p' "$work/err.log" >&2 || true
echo "$qmd"
exit 0
