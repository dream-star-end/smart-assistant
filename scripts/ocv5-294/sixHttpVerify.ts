/** Offline check of six saved CCB bodies against this worktree's gate and matcher.
 * Raw messages are never rewritten. A missing server turnKey is hashed only on
 * a labeled synthetic auth-envelope copy. */
import { createHash } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateBoxRequest } from "../../packages/commercial/src/http/proxy/boxRequestGate.js";
import { normalizeBoxSemanticBody } from "../../packages/commercial/src/http/proxy/boxCacheAnnotations.js";
import { matchBoxToolResults } from "../../packages/commercial/src/http/proxy/boxToolResultMatcher.js";
import { compileBoxToolCatalog } from "../../packages/commercial/src/http/proxy/boxToolCatalog.js";
import { deriveBoxCallFingerprint, deriveBoxContextHash } from "../../packages/commercial/src/http/proxy/boxCallFingerprint.js";
import type { ProxyBody } from "../../packages/commercial/src/http/proxy/shared.js";

const TOOL = "mcp__ocv5six__read_link";
const sources = [
  "packages/commercial/src/http/proxy/boxCacheAnnotations.ts",
  "packages/commercial/src/http/proxy/boxRequestGate.ts",
  "packages/commercial/src/http/proxy/boxToolResultMatcher.ts",
].map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(new URL(`../../${path}`, import.meta.url))).digest("hex") }));

type Sent = { id: string; name: string; input: { path: string } };
type McpRow = { ok?: boolean; seq?: number; path?: string; sha256?: string };
type Wire = { bodies?: ProxyBody[]; raws?: string[]; rawSha256?: string[]; sent?: Sent[]; mcp?: McpRow[] };

function stable(value: unknown): string {
  return JSON.stringify(value);
}
function exclusiveWrite(path: string, text: string): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeSync(fd, text); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function flag(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

const wirePath = flag("--wire");
const reportPath = flag("--report");
let firstError: string | null = null;
const fail = (message: string): void => { firstError ??= message; };
const gate: Array<{ index: number; raw: string | null; normalized: string | null; error: string | null }> = [];
const matched: string[] = [];
let contextOk = true;
let fingerprintOk = true;

try {
  const wire = JSON.parse(readFileSync(wirePath, "utf8")) as Wire;
  const bodies = Array.isArray(wire.bodies) ? wire.bodies : [];
  const raws = Array.isArray(wire.raws) ? wire.raws : [];
  const sent = Array.isArray(wire.sent) ? wire.sent : [];
  const mcp = Array.isArray(wire.mcp) ? wire.mcp : [];
  const digests = Array.isArray(wire.rawSha256) ? wire.rawSha256 : [];
  if (bodies.length !== 6 || raws.length !== 6 || sent.length !== 5 || mcp.length !== 5
    || digests.length !== 6) fail("VERIFY_COUNT");
  if (new Set(sent.map((item) => item.id)).size !== sent.length) fail("TOOL_ID_DUP");
  if (!firstError) {
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i]!;
      if (createHash("sha256").update(raw).digest("hex") !== digests[i]) fail(`RAW_DIGEST_${i}`);
      const parsed = JSON.parse(raw) as ProxyBody;
      if (stable(parsed) !== stable(bodies[i])) fail(`RAW_BODY_DIVERGED_${i}`);
      const before = stable(parsed);
      let rawCode: string | null = null;
      let normCode: string | null = null;
      let error: string | null = null;
      try { rawCode = validateBoxRequest(parsed, true); }
      catch (err) { error = err instanceof Error ? err.message : "gate-threw"; }
      const once = normalizeBoxSemanticBody(structuredClone(parsed));
      const twice = normalizeBoxSemanticBody(structuredClone(once));
      if (stable(once) !== stable(twice)) fail(`NORMALIZE_NOT_IDEMPOTENT_${i}`);
      if (stable(parsed) !== before) fail(`RAW_MUTATED_${i}`);
      try { normCode = validateBoxRequest(once, true); }
      catch (err) { error = `${error ?? ""} ${err instanceof Error ? err.message : "norm-gate"}`.trim(); }
      if (rawCode !== null) fail(`GATE_${i}_${rawCode}`);
      if (normCode !== rawCode) fail(`GATE_DIVERGED_${i}`);
      if (error) fail(`GATE_THROW_${i}`);
      gate.push({ index: i, raw: rawCode, normalized: normCode, error });
      if (i > 0) {
        try {
          const previous = JSON.parse(raws[i - 1]!) as ProxyBody;
          if (deriveBoxContextHash(parsed, true) !== deriveBoxContextHash(previous)) {
            contextOk = false; fail(`CONTEXT_${i}`);
          }
        } catch { contextOk = false; fail(`CONTEXT_THROW_${i}`); }
        const prior = sent[i - 1]!;
        const row = mcp[i - 1]!;
        if (prior.name !== TOOL || row.ok !== true || row.seq !== i
          || row.path !== prior.input.path || typeof row.sha256 !== "string") fail(`MCP_ROW_${i}`);
        let boxName = "";
        try { boxName = compileBoxToolCatalog(parsed.tools).boxNameByClientName.get(prior.name) ?? ""; }
        catch { fail(`CATALOG_${i}`); }
        if (!boxName) fail(`CATALOG_ALIAS_${i}`);
        try {
          const result = matchBoxToolResults(parsed, [{ id: prior.id,
            clientName: prior.name, boxName, input: prior.input }]);
          const item = result[0];
          matched.push(item?.contentHash ?? "");
          if (!item || item.isError || item.content.length !== 1 || item.content[0]?.type !== "text") {
            fail(`MCP_CONTENT_${i}`);
          } else if (createHash("sha256").update(item.content[0].text).digest("hex") !== row.sha256) {
            fail(`MCP_CONTENT_${i}`);
          }
        } catch (err) { fail(`MATCH_${i}_${err instanceof Error ? err.message : "throw"}`); }
      }
      const envelope = structuredClone(parsed);
      envelope.metadata = { user_id: JSON.stringify({ oc_turn_key: "c".repeat(64),
        session_id: "ocv5-six-synthetic" }) };
      try {
        const left = deriveBoxCallFingerprint(3n, envelope).replayFingerprint;
        const right = deriveBoxCallFingerprint(3n, normalizeBoxSemanticBody(structuredClone(envelope))).replayFingerprint;
        if (left !== right) { fingerprintOk = false; fail(`FINGERPRINT_${i}`); }
      } catch { fingerprintOk = false; fail(`FINGERPRINT_THROW_${i}`); }
    }
  }
} catch (err) { fail(err instanceof Error ? err.message : "VERIFY_THROW"); }

const report = { module: fileURLToPath(import.meta.url), sources, gate, contextOk,
  fingerprintOk, syntheticAuthEnvelope: true, matched, firstError,
  loadedGate: fileURLToPath(new URL("../../packages/commercial/src/http/proxy/boxRequestGate.ts", import.meta.url)) };
const text = `${JSON.stringify(report)}\n`;
if (reportPath) exclusiveWrite(reportPath, text);
process.stdout.write(text);
process.exit(firstError ? 2 : 0);
