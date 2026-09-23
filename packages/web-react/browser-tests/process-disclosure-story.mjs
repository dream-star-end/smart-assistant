/** Acceptance fixture for the inventory-board gallery. Not a production artifact. */

export const OLD_TS = 1_700_000_000_000;
export const CSV_NAME = "inventory-board-north-south-available-acceptance-fixture.csv";
export const CSV_PATH = `/home/agent/.openclaude/generated/${CSV_NAME}`;
export const CSV_BODY = "sku,warehouse,available\nA-1,北仓,80\nA-1,南仓,48\n";
export const STAGE_TEXT = "先按北仓和南仓核对可售口径，冻结库存不进看板。";
export const BASH_CMD = "node scripts/summarize-stock.mjs";
export const READ_PATH = "inventory/thresholds.md";
export const BOARD_SESSION = "ocv5board01";
export const WAIT_SESSION = "ocv5wait01";
/** Dedicated route for the 2023-11-15 meta line. Not the default gallery. */
export const OLD_SESSION = "ocv5old01";

export const DASHBOARD_HTML = [
  "<style>",
  "body{font-family:sans-serif;margin:0;padding:12px;background:#fafafb;color:#15151b}",
  "h1{font-size:16px;margin:0 0 8px}",
  "table{border-collapse:collapse;width:100%}",
  "td{border:1px solid #e9e9ef;padding:6px 8px}",
  "</style>",
  "<h1>库存看板</h1>",
  "<p>可售合计 128。这是界面验收夹具，不是线上库存。</p>",
  "<table><tr><td>北仓</td><td>80</td></tr><tr><td>南仓</td><td>48</td></tr></table>",
].join("");

export function answerText() {
  return [
    "看板已经做好。可售合计 128，北仓 80、南仓 48。",
    "",
    "```htmlpreview",
    DASHBOARD_HTML,
    "```",
    "",
    `明细表：${CSV_PATH}`,
    "",
    "预览和 CSV 是界面验收夹具，不是线上库存。",
  ].join("\n");
}

export function recentTs() {
  return Date.now() - 2_000;
}
