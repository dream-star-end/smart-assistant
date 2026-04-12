#!/bin/bash
cd /opt/openclaude/openclaude
echo "=== run tests ==="
npx tsx --test packages/gateway/src/__tests__/security.test.ts 2>&1 | tail -10
echo
echo "=== file structure ==="
echo "index.html: $(wc -l < packages/web/public/index.html) lines"
echo "style.css: $(wc -l < packages/web/public/style.css) lines"
echo "app.js: $(wc -l < packages/web/public/app.js) lines"
echo
echo "=== npm scripts ==="
node -e "const p=require('./package.json');console.log(Object.keys(p.scripts).join(', '))"
