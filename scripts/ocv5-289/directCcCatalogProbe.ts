/** Offline real Claude Code 2.1.280 -> synthetic Messages API. Verifies that
 * the *actual* built-in tool declarations fit our Box virtual-MCP catalog
 * compiler without storing user prompts, descriptions or schema bodies. */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { compileBoxToolCatalog, mapBoxCliEffort } from
  "../../packages/commercial/src/http/proxy/boxToolCatalog.js";

const version = execFileSync("/usr/local/bin/claude", ["--version"],
  { encoding: "utf8", timeout: 5000 }).trim();
if (version !== "2.1.280 (Claude Code)") throw new Error("DIRECT_CC_VERSION_UNEXPECTED");
const syntheticTurnKey = "a".repeat(64);
const home = mkdtempSync("/tmp/ocv5-289-cc-catalog-");
let seen = 0;
let summary: Record<string, unknown> | null = null;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) { res.writeHead(413).end(); return; }
  }
  if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") {
    res.writeHead(404).end(); return;
  }
  seen++;
  const body = JSON.parse(raw) as Record<string, unknown>;
  try {
    const catalog = compileBoxToolCatalog(body.tools);
    const effort = mapBoxCliEffort(body.thinking, body.output_config);
    const meta = body.metadata as { user_id?: unknown; session_id?: unknown } | undefined;
    const userMeta = typeof meta?.user_id === "string"
      ? JSON.parse(meta.user_id) as Record<string, unknown> : {};
    summary = { count: catalog.tools.length, hash: catalog.sha256,
      effort, aliasesUnique: catalog.clientNameByBoxName.size === catalog.tools.length,
      turnKeyPropagated: userMeta.oc_turn_key === syntheticTurnKey,
      outerSessionPresent: typeof meta?.session_id === "string",
      innerSessionPresent: typeof userMeta.session_id === "string",
      sessionIdsAgree: typeof meta?.session_id === "string"
        && typeof userMeta.session_id === "string"
        && meta.session_id === userMeta.session_id,
      topLevelKeys: [...new Set((body.tools as Array<Record<string, unknown>>)
        .flatMap((item) => Object.keys(item)))].sort() };
  } catch (error) {
    summary = { code: error instanceof Error ? error.message : "BOX_CATALOG_PROBE_FAILED" };
  }
  const event = (name: string, data: unknown): void => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  event("message_start", { type: "message_start", message: {
    id: "msg_catalog_fixture", type: "message", role: "assistant", model: body.model,
    content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
  event("content_block_start", { type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" } });
  event("content_block_delta", { type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: "ok" } });
  event("content_block_stop", { type: "content_block_stop", index: 0 });
  event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 } });
  event("message_stop", { type: "message_stop" });
  res.end();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("LOOPBACK_INVALID");
const child = spawn("/usr/local/bin/claude", ["-p", "Reply exactly ok.", "--model",
  "claude-opus-5-5", "--output-format", "json", "--no-session-persistence",
  "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
{ env: { HOME: home, CLAUDE_CONFIG_DIR: home, PATH: "/usr/local/bin:/usr/bin:/bin",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  ANTHROPIC_AUTH_TOKEN: "synthetic-only", CLAUDE_CODE_MAX_RETRIES: "0",
  CLAUDE_CODE_EXTRA_METADATA: JSON.stringify({ oc_turn_key: syntheticTurnKey }),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_PROXY: "127.0.0.1,localhost" },
  stdio: ["ignore", "pipe", "pipe"] });
child.stdout.resume(); child.stderr.resume();
const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
let exit: number | null;
try { exit = await new Promise((resolve) => child.once("close", resolve)); }
finally {
  clearTimeout(timer);
  server.close();
  rmSync(home, { recursive: true, force: true });
}
if (exit !== 0 || seen !== 1 || summary?.count !== 20
  || summary.effort !== "medium" || summary.aliasesUnique !== true
  || summary.turnKeyPropagated !== true) {
  throw new Error("DIRECT_CC_TOOL_CATALOG_CONTRACT_FAILED");
}
process.stdout.write(JSON.stringify({ version, synthetic: true,
  requests: seen, ...summary }) + "\n");
