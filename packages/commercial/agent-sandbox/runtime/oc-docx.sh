#!/usr/bin/env bash
# OpenClaude DOCX helper: source Markdown/Quarto -> high-quality Word .docx.
set -euo pipefail

DEFAULT_REFERENCE_DOC="/usr/local/share/openclaude-docgen/reference.docx"

usage() {
  cat <<'USAGE'
Usage:
  oc-docx [--quarto|--pandoc] [--reference-doc PATH|--no-reference-doc] [-o OUTPUT.docx] INPUT.{md,qmd}

Examples:
  oc-docx report.qmd
  oc-docx report.md -o /home/agent/.openclaude/report.docx
  oc-docx --pandoc --reference-doc custom-reference.docx draft.md

Notes:
  - .qmd defaults to Quarto (`quarto render --to docx`).
  - .md defaults to Pandoc (`pandoc --to docx`) via Quarto's bundled Pandoc.
  - If present, /usr/local/share/openclaude-docgen/reference.docx is used as the default Word style reference.
  - Keep equations as LaTeX `$...$` or `$$...$$`; the DOCX should contain native Word OMML equations.
USAGE
}

engine=""
reference_doc="$DEFAULT_REFERENCE_DOC"
use_reference=1
output=""
input=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quarto)
      engine="quarto"
      shift
      ;;
    --pandoc)
      engine="pandoc"
      shift
      ;;
    --reference-doc)
      if [[ $# -lt 2 ]]; then echo "oc-docx: --reference-doc requires a path" >&2; exit 2; fi
      reference_doc="$2"
      use_reference=1
      shift 2
      ;;
    --no-reference-doc)
      use_reference=0
      shift
      ;;
    -o|--output)
      if [[ $# -lt 2 ]]; then echo "oc-docx: --output requires a path" >&2; exit 2; fi
      output="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -* )
      echo "oc-docx: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$input" ]]; then echo "oc-docx: only one input file is supported" >&2; exit 2; fi
      input="$1"
      shift
      ;;
  esac
done

if [[ -z "$input" ]]; then
  usage >&2
  exit 2
fi
if [[ ! -f "$input" ]]; then
  echo "oc-docx: input not found: $input" >&2
  exit 1
fi
if [[ "$use_reference" -eq 1 && ! -f "$reference_doc" ]]; then
  echo "oc-docx: reference doc not found: $reference_doc" >&2
  exit 1
fi

input_abs="$(readlink -f "$input")"
input_dir="$(dirname "$input_abs")"
input_base="$(basename "$input_abs")"
stem="${input_base%.*}"
ext="${input_base##*.}"
case "${ext,,}" in
  qmd) default_engine="quarto" ;;
  md|markdown) default_engine="pandoc" ;;
  *) default_engine="pandoc" ;;
esac
if [[ -z "$engine" ]]; then engine="$default_engine"; fi

if [[ -z "$output" ]]; then
  output="$input_dir/$stem.docx"
fi
output_dir_input="$(dirname "$output")"
mkdir -p "$output_dir_input"
output_dir="$(cd "$output_dir_input" && pwd)"
output_abs="$output_dir/$(basename "$output")"

case "$engine" in
  pandoc)
    args=(
      "$input_abs"
      --standalone
      --from=markdown+tex_math_dollars+pipe_tables+raw_html+fenced_divs+footnotes+definition_lists
      --to=docx
      --output "$output_abs"
      --toc
      --number-sections
    )
    if [[ "$use_reference" -eq 1 ]]; then
      args+=(--reference-doc "$reference_doc")
    fi
    pandoc "${args[@]}"
    ;;
  quarto)
    # Quarto's --output accepts only a filename, not a path. Render in the input
    # directory and move the result when the requested output path is elsewhere.
    render_name="$(basename "$output_abs")"
    final_in_input_dir="$input_dir/$render_name"
    if [[ "$output_dir" != "$input_dir" ]]; then
      render_name=".oc-docx-${stem}-$$.docx"
      final_in_input_dir="$input_dir/$render_name"
    fi
    rm -f "$final_in_input_dir"
    qargs=(render "$input_base" --to docx --output "$render_name")
    if [[ "$use_reference" -eq 1 ]]; then
      qargs+=(-M "reference-doc=$reference_doc")
    fi
    (cd "$input_dir" && quarto "${qargs[@]}")
    if [[ "$final_in_input_dir" != "$output_abs" ]]; then
      mv -f "$final_in_input_dir" "$output_abs"
    fi
    ;;
  *)
    echo "oc-docx: invalid engine: $engine" >&2
    exit 2
    ;;
esac

test -s "$output_abs"
printf '%s\n' "$output_abs"
