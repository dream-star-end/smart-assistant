#!/bin/bash
cd /opt/openclaude/openclaude/packages/web/public
mkdir -p vendor

echo "=== downloading CDN deps ==="
curl -sL "https://cdn.jsdelivr.net/npm/marked@12/marked.min.js" -o vendor/marked.min.js
curl -sL "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/highlight.min.js" -o vendor/highlight.min.js
curl -sL "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/styles/github-dark.min.css" -o vendor/github-dark.min.css
curl -sL "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/styles/github.min.css" -o vendor/github.min.css
curl -sL "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" -o vendor/mermaid.min.js
curl -sL "https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js" -o vendor/purify.min.js
curl -sL "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js" -o vendor/chart.umd.min.js

echo "=== verify sizes ==="
ls -lh vendor/
echo
echo "total: $(du -sh vendor/ | cut -f1)"
