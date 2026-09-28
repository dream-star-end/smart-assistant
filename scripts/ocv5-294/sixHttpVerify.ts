/** Offline check of six saved CCB bodies against this worktree's gate and matcher.
 * Raw messages are never rewritten. A missing server turnKey is hashed only on
 * a labeled synthetic auth-envelope copy. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { candidateManifest, manifestDrift, proxyFileUrl, type ManifestEntry } from "./candidateManifest.ts";
import { annotationsForLastHandoff, checkMatchedContent } from "./matchedContentOracle.ts";
import type { ProxyBody } from "../../packages/commercial/src/http/proxy/shared.ts";

const TOOL = "mcp__ocv5six__read_link";
const SEALED = "bcaf4fba7bcf111c";

type Sent = { id: string; name: string; input: { path: string } };
type McpRow = { ok?: boolean; seq?: number; path?: string; sha256?: string };
type Wire = { bodies?: ProxyBody[]; raws?: string[]; rawSha256?: string[]; sent?: Sent[]; mcp?: McpRow[] };

function stable(value: unknown): string {
  return JSON.stringify(value);
}
function exclusiveWrite(path: string, text: string): void {
  if (path.includes(SEALED) || path.endsWith("ocv5-294-captured-wire.json")) {
    throw new Error("REFUSING_SEALED_EVIDENCE");
  }
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeSync(fd, text); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function flag(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function headNow(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function main(): Promise<void> {
  const wirePath = flag("--wire");
  const reportPath = flag("--report");
  const expectPath = flag("--expect");
  let firstError: string | null = null;
  const fail = (message: string): void => { firstError ??= message; };
  const expected = expectPath
    ? JSON.parse(readFileSync(expectPath, "utf8")) as { head?: string; manifest?: ManifestEntry[] }
    : null;
  const before = candidateManifest();
  if (expected?.manifest && manifestDrift(expected.manifest, before)) fail("MANIFEST_BEFORE");
  if (expected?.head && headNow() !== expected.head) fail("HEAD_BEFORE");
  const gateMod = await import(proxyFileUrl("boxRequestGate.ts").href);
  const normMod = await import(proxyFileUrl("boxCacheAnnotations.ts").href);
  const matchMod = await import(proxyFileUrl("boxToolResultMatcher.ts").href);
  const catalogMod = await import(proxyFileUrl("boxToolCatalog.ts").href);
  const fingerMod = await import(proxyFileUrl("boxCallFingerprint.ts").href);
  const after = candidateManifest();
  const drift = manifestDrift(expected?.manifest ?? before, after);
  if (drift) fail(expected ? "MANIFEST_AFTER" : drift);
  if (expected?.head && headNow() !== expected.head) fail("HEAD_AFTER");
  const gate: Array<{ index: number; raw: string | null; normalized: string | null; error: string | null }> = [];
  const matched: string[] = [];
  const contentOracle: Array<string | null> = [];
  let contextOk = true;
  let fingerprintOk = true;
  let manifest: ManifestEntry[] = before;
  try {
    if (firstError) throw new Error(firstError);
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
        const beforeBody = stable(parsed);
        let rawCode: string | null = null;
        let normCode: string | null = null;
        let error: string | null = null;
        try { rawCode = gateMod.validateBoxRequest(parsed, true); }
        catch (err) { error = err instanceof Error ? err.message : "gate-threw"; }
        const once = normMod.normalizeBoxSemanticBody(structuredClone(parsed));
        const twice = normMod.normalizeBoxSemanticBody(structuredClone(once));
        if (stable(once) !== stable(twice)) fail(`NORMALIZE_NOT_IDEMPOTENT_${i}`);
        if (stable(parsed) !== beforeBody) fail(`RAW_MUTATED_${i}`);
        try { normCode = gateMod.validateBoxRequest(once, true); }
        catch (err) { error = `${error ?? ""} ${err instanceof Error ? err.message : "norm-gate"}`.trim(); }
        if (rawCode !== null) fail(`GATE_${i}_${rawCode}`);
        if (normCode !== rawCode) fail(`GATE_DIVERGED_${i}`);
        if (error) fail(`GATE_THROW_${i}`);
        gate.push({ index: i, raw: rawCode, normalized: normCode, error });
        if (i > 0) {
          try {
            const previous = JSON.parse(raws[i - 1]!) as ProxyBody;
            if (fingerMod.deriveBoxContextHash(parsed, true) !== fingerMod.deriveBoxContextHash(previous)) {
              contextOk = false; fail(`CONTEXT_${i}`);
            }
          } catch { contextOk = false; fail(`CONTEXT_THROW_${i}`); }
          const prior = sent[i - 1]!;
          const row = mcp[i - 1]!;
          if (prior.name !== TOOL || row.ok !== true || row.seq !== i
            || row.path !== prior.input.path || typeof row.sha256 !== "string") fail(`MCP_ROW_${i}`);
          let boxName = "";
          try { boxName = catalogMod.compileBoxToolCatalog(parsed.tools).boxNameByClientName.get(prior.name) ?? ""; }
          catch { fail(`CATALOG_${i}`); }
          if (!boxName) fail(`CATALOG_ALIAS_${i}`);
          const expected = annotationsForLastHandoff(parsed.messages ?? []);
          if (expected.unknown) fail(`ANNOTATION_UNKNOWN_${i}`);
          try {
            const result = matchMod.matchBoxToolResults(parsed, [{ id: prior.id,
              clientName: prior.name, boxName, input: prior.input }]);
            const item = result[0];
            matched.push(item?.contentHash ?? "");
            const oracle = item ? checkMatchedContent({
              content: item.content, isError: item.isError, contentHash: item.contentHash,
              mcpSha256: row.sha256, toolIndexes: [0], annotations: expected.annotations,
            }) : "MCP_CONTENT";
            contentOracle.push(oracle);
            if (oracle) fail(`MCP_CONTENT_${i}_${oracle}`);
          } catch (err) { contentOracle.push("throw"); fail(`MATCH_${i}_${err instanceof Error ? err.message : "throw"}`); }
        }
        const envelope = structuredClone(parsed);
        envelope.metadata = { user_id: JSON.stringify({ oc_turn_key: "c".repeat(64),
          session_id: "ocv5-six-synthetic" }) };
        try {
          const left = fingerMod.deriveBoxCallFingerprint(3n, envelope).replayFingerprint;
          const right = fingerMod.deriveBoxCallFingerprint(3n,
            normMod.normalizeBoxSemanticBody(structuredClone(envelope))).replayFingerprint;
          if (left !== right) { fingerprintOk = false; fail(`FINGERPRINT_${i}`); }
        } catch { fingerprintOk = false; fail(`FINGERPRINT_THROW_${i}`); }
      }
    }
  } catch (err) { fail(err instanceof Error ? err.message : "VERIFY_THROW"); }
  manifest = candidateManifest();
  const finalExpect = expected?.manifest ?? before;
  if (manifestDrift(finalExpect, manifest)) fail(expected ? "MANIFEST_FINAL" : "MANIFEST_DRIFT_FINAL");
  if (expected?.head && headNow() !== expected.head) fail("HEAD_FINAL");
  const report = { module: fileURLToPath(import.meta.url), manifest, gate, contextOk,
    fingerprintOk, syntheticAuthEnvelope: true, matched, contentOracle, firstError,
    boundHead: expected?.head ?? null,
    manifestStable: manifestDrift(finalExpect, manifest) === null };
  const text = `${JSON.stringify(report)}\n`;
  if (reportPath) exclusiveWrite(reportPath, text);
  process.stdout.write(text);
  process.exit(firstError ? 2 : 0);
}

if ((process.argv[1] ?? "").includes("sixHttpVerify")) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : "FAILED"}\n`);
    process.exit(1);
  });
}
