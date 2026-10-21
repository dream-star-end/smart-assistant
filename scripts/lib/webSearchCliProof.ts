import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaledMs } from "./gateLoadScale.js";

/** Actual CLI process + authenticated loopback proxy; no provider/model or production state is used. */
export async function proveWebSearchCli(root: string, entry = join(root, "packages/gateway/src/ocWebCli.ts")) {
  const home = await mkdtemp(join(tmpdir(), "oc-web-search-proof-"));
  // OCV5-557: the child's own tsx cache. Without TMPDIR it compiled into the shared /tmp/tsx-<uid>
  // (GBs, scanned linearly), and under load the cold start ran past the limit (exit=null).
  const cache = await mkdtemp(join(tmpdir(), "oc-web-search-tsx-"));
  const identity = "fixture-proof-container";
  const query = "ocv5-510-proof-query";
  const sourceUrl = "https://example.test/ocv5-510-source";
  const requests: { path: string; body: unknown; auth: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/v3/minimax-search") res.end('{"organic":[]}');
    else if (req.url === "/internal/v3/grok-search") res.end(JSON.stringify({ organic: [{ title: "Verified fixture source", url: sourceUrl, snippet: "Fixture content" }] }));
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    await mkdir(join(home, ".openclaude"));
    await writeFile(join(home, ".openclaude/container-auth.json"), JSON.stringify({ masterBaseUrl: `http://127.0.0.1:${address.port}`, containerToken: identity }), { mode: 0o600 });
    // Codex removes OPENCLAUDE_*; retain only a minimal nonsecret process environment.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", TMPDIR: cache };
    // Compile the CLI once before the timed run; this run's outcome is not part of the proof.
    await new Promise<void>((done) => {
      execFile(process.execPath, ["--import", "tsx", entry, "--help"], { cwd: root, encoding: "utf8",
        timeout: scaledMs(60_000), env }, () => done());
    });
    const output = await new Promise<{ stdout: string; stderr: string }>((done, fail) => {
      execFile(process.execPath, ["--import", "tsx", entry, "search", query, "--json", "--timeout-ms", "3000"], {
        cwd: root, encoding: "utf8", timeout: scaledMs(15000), env,
      }, (error, stdout, stderr) => {
        if (error) fail(new Error(`SEARCH_CLI_PROCESS_FAILED exit=${error.code}`));
        else done({ stdout, stderr });
      });
    });
    assert.ok(!output.stdout.includes(identity) && !output.stderr.includes(identity), "SEARCH_CLI_IDENTITY_DISCLOSED");
    const result = JSON.parse(output.stdout);
    assert.equal(result.ok, true, "SEARCH_CLI_RESULT_FAILED");
    assert.equal(result.results?.[0]?.url, sourceUrl, "SEARCH_CLI_SOURCE_MISSING");
    assert.deepEqual(requests, [
      { path: "/internal/v3/minimax-search", body: { q: query }, auth: `Bearer ${identity}` },
      { path: "/internal/v3/grok-search", body: { q: query }, auth: `Bearer ${identity}` },
    ], "SEARCH_CLI_AUTH_OR_FALLBACK_MISSING");
    return { requests: requests.length, sourceUrl };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
}
