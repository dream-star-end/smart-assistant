#!/usr/bin/env node
/** Sequential read_link fixture. Rejects any path that is not the next file. */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const allow = JSON.parse(readFileSync(process.argv[2], "utf8"));
const logPath = process.argv[3];
const paths = allow.paths;
if (!Array.isArray(paths) || paths.length !== 5
  || paths.some((item) => typeof item !== "string")) process.exit(126);
let next = 0;
let failed = false;
const MAX = 1_048_576;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function log(entry) {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}
function fail(reason, path) {
  failed = true;
  log({ ok: false, reason, path, next });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.length > MAX) process.exit(126);
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    handle(line);
    nl = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(failed ? 2 : 0));

function handle(line) {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); }
  catch { return; }
  if (!request || request.jsonrpc !== "2.0" || request.id === undefined) return;
  const { method, id } = request;
  if (method === "initialize") {
    const version = request.params?.protocolVersion ?? "2025-06-18";
    emit({ jsonrpc: "2.0", id, result: { protocolVersion: version,
      capabilities: { tools: {} }, serverInfo: { name: "ocv5six", version: "1.0.0" } } });
    return;
  }
  if (method === "ping") { emit({ jsonrpc: "2.0", id, result: {} }); return; }
  if (method === "tools/list") {
    emit({ jsonrpc: "2.0", id, result: { tools: [{ name: "read_link",
      description: "Read one allowlisted synthetic file and return its exact text.",
      inputSchema: { type: "object", properties: { path: { type: "string" } },
        required: ["path"], additionalProperties: false } }] } });
    return;
  }
  if (method === "tools/call") {
    const params = request.params ?? {};
    const path = params.arguments?.path;
    if (params.name !== "read_link" || typeof path !== "string") {
      fail("bad-call", "");
      emit({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "rejected" }],
        isError: true } });
      return;
    }
    let reason = "";
    if (failed) reason = "latched";
    else if (!paths.includes(path)) reason = "illegal-path";
    else if (next >= paths.length || path !== paths[next]) reason = "out-of-order";
    if (reason) {
      fail(reason, path);
      emit({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "rejected" }],
        isError: true } });
      return;
    }
    const text = readFileSync(path, "utf8");
    const sha256 = createHash("sha256").update(text).digest("hex");
    log({ ok: true, seq: next + 1, path, sha256, bytes: Buffer.byteLength(text) });
    next += 1;
    emit({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    return;
  }
  emit({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}
