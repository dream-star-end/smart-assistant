#!/bin/sh
# oc-cite — in-container CLI for citation grounding (identifier verify / retraction /
# BibTeX·GB-T7714·IEEE·Nature·APA formatting). Thin wrapper → gateway tsx entry (talks to master
# /v3/research/cite/* with the container token). See the `oc-cite` baseline skill.
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# help-fast-path: stdout usage + exit 0; do not start tsx/node/network.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  cat <<'EOF'
usage:
  oc-cite verify <id...>
  oc-cite format <id> [--style <style>] [--doc-id <docId>] [--span-id <spanId>] [--evidence-grade <A|B>]
  oc-cite check --manifest <file>
  oc-cite fix --manifest <file> --docs <docId,...>

id 支持:
  doi:/arxiv:/openalex:/pmid:/ads:<bibcode>

--style 支持 5 种格式:
  gb-t-7714-2015 (默认, 别名 gb-t-7714) | ieee | nature | apa | bibtex

format 可选参数:
  --doc-id <docId>           绑定已入库的本地权威文档 ID
  --span-id <spanId>         绑定本地文档的权威 span ID (需与 --doc-id 同时提供, 经 master 核验匹配后授分级 A)
  --evidence-grade <A|B>     证据来源分级 (显式传 B 可降级为摘要/题录级; A 仅由 master 本地全文核验铸造)

用法示例:
  oc-cite verify 10.1038/s41586-024-0001 arxiv:2301.00001
  oc-cite format 10.1038/s41586-024-0001 --style gb-t-7714-2015
  oc-cite format 10.1038/s41586-024-0001 --style ieee --doc-id doc:abc123 --span-id s0
  oc-cite format 10.1038/s41586-024-0001 --style nature
  oc-cite format 10.1038/s41586-024-0001 --style apa --evidence-grade B
  oc-cite format arxiv:2301.00001 --style bibtex
  oc-cite check --manifest manifest.json
  oc-cite fix --manifest manifest.json --docs doc:abc123,doc:def456
EOF
  exit 0
fi

cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocCiteCli.ts "$@"
