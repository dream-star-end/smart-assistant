// Loopback-only synthetic API serving the actual AccountsPage. Not cloud E2E.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { build } = createRequire(import.meta.url)("esbuild");
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./sand-accounts-harness.tsx", import.meta.url))],
  bundle: true, write: false, format: "iife", jsx: "automatic",
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
  alias: { "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)) },
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' }, logLevel: "error",
});
let rows = []; const calls = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  let chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(); const data = raw ? JSON.parse(raw) : {};
  res.setHeader("Content-Type", "application/json");
  let out = {};
  if (path === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
  if (path === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>'); return; }
  if (path === "/fixture") {
    if (req.method === "POST") for (const r of rows) r.cursor_sand_box = { phase: data.phase, ...(data.errorCode ? { errorCode: data.errorCode } : {}) };
    out = { rows, calls };
  } else if (path === "/api/admin/accounts" && req.method === "POST") {
    calls.push({ method: req.method, path, body: { ...data, oauth_access_token: undefined } });
    const now = new Date().toISOString();
    rows.push({ ...data, id: "synthetic199", status: "active", health_score: 1, cursor_quota_class: "unknown", cursor_credential_kind: "api_key", success_count: "0", fail_count: "0", created_at: now, updated_at: now, cursor_sand_box: { phase: "preparing" } });
    out = { account: rows[0], id: rows[0].id };
  } else if (path === "/api/admin/accounts/synthetic199" && req.method === "PATCH") {
    calls.push({ method: req.method, path, body: data }); Object.assign(rows[0], data);
    rows[0].cursor_sand_box = { phase: data.status === "disabled" ? "disabled" : "ready" }; out = { ok: true };
  } else if (path === "/api/admin/accounts/synthetic199" && req.method === "DELETE") {
    calls.push({ method: req.method, path }); rows = []; out = { ok: true };
  } else if (path === "/api/admin/accounts") out = { rows };
  else if (["/api/admin/account-groups", "/api/admin/egress-proxies"].includes(path)) out = { rows: [] };
  else if (path.includes("stats")) out = null;
  else { res.statusCode = 404; out = { error: "UNEXPECTED_SYNTHETIC_REQUEST", path }; }
  res.end(JSON.stringify(out));
});
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close());
