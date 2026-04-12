#!/bin/bash
set -e

echo "=== Step 1: Install @playwright/mcp globally ==="
npm install -g @playwright/mcp@latest 2>&1 | tail -5

echo
echo "=== Step 2: Install Chromium with system deps ==="
npx playwright install --with-deps chromium 2>&1 | tail -10

echo
echo "=== Step 3: Verify ==="
echo -n "playwright-mcp version: "
npx @playwright/mcp --version 2>&1 || echo "(no version flag)"
echo -n "chromium binary: "
npx playwright install --dry-run chromium 2>&1 | head -3 || which chromium-browser || which chromium || echo "check paths..."

echo
echo "=== Step 4: Quick test - headless launch ==="
timeout 10 npx @playwright/mcp --headless --caps core 2>&1 &
PID=$!
sleep 5
if kill -0 $PID 2>/dev/null; then
  echo "MCP server running (PID=$PID), killing..."
  kill $PID
  echo "OK - Playwright MCP works in headless mode"
else
  echo "WARNING: MCP server exited early"
fi

echo
echo "=== Done ==="
