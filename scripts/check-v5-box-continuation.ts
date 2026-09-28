/** Semantic continuation gate for INC-20260928-BOX-MULTITOOL-CONTINUATION.
 * Zero network. Loads this candidate's real gate, normalizer, matcher, and
 * context modules. Does not start CCB and does not read capture files.
 *
 * Not a deploy-gate proof until a release script calls it. The source-text
 * guard in check-v5-session-unavailable-rootfix.ts is not this proof.
 *
 * Integration contract, from the candidate root:
 *   /usr/bin/tsx scripts/check-v5-box-continuation.ts --expect-sha <40-hex HEAD>
 * Exit 0 only when that tree passes and three isolated fault copies
 * (progress, keep-budget, promote-wrapper) each fail the same assertions.
 * Wire it beside check-v5-session-unavailable-rootfix.ts in deploy-v5.sh and
 * scripts/v5-selfhost-master-release-lib.sh. Do not claim the incident proof
 * layer closed before that call exists.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  annotationCounts, chain, composedRejects, historicalBudgetOnly, HOOK, legalWrapped,
  legalWrappedBytes, matchedTails, PROGRESS, rewrites, unknownMarker, unknownText, WRAPPED,
} from "./check-v5-box-continuation-fixture.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROXY = join(ROOT, "packages/commercial/src/http/proxy");
const ENTRIES = ["boxRequestGate.ts", "boxCacheAnnotations.ts", "boxToolResultMatcher.ts",
  "boxCallFingerprint.ts"];

type Api = {
  normalize: (body: Record<string, unknown>) => { messages: unknown[] };
  gate: (body: Record<string, unknown>, enabled: boolean) => string | null;
  match: (body: Record<string, unknown>, expected: readonly Record<string, unknown>[]) =>
    readonly { content: unknown }[];
  context: (body: Record<string, unknown>, completedToolTail?: boolean) => string;
  fingerprint: (uid: bigint, body: Record<string, unknown>) => { replayFingerprint: string };
};

function fail(message: string): never {
  throw new Error(message);
}
function flag(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function localSpecs(source: string): Array<{ spec: string; typeOnly: boolean }> {
  return [...source.matchAll(/import\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["'](\.[^"']+)["']/g)]
    .map((match) => ({ typeOnly: Boolean(match[1]), spec: match[2]! }));
}
function resolveSpec(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  const candidates = spec.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base]
    : [base, `${base}.ts`, `${base}.tsx`];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return fail(`UNRESOLVED ${spec} from ${fromFile}`);
}
function closure(dir: string): string[] {
  const pending = ENTRIES.map((name) => join(dir, name));
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    if (!inside(dir, file)) fail(`DEP_ESCAPE ${file}`);
    seen.add(file);
    for (const item of localSpecs(readFileSync(file, "utf8"))) {
      const next = resolveSpec(file, item.spec);
      if (!inside(dir, next)) {
        const entry = ENTRIES.some((name) => file.endsWith(`${sep}${name}`));
        if (entry && !item.typeOnly) fail(`DEP_ESCAPE ${next}`);
        continue;
      }
      pending.push(next);
    }
  }
  for (const name of ENTRIES) {
    if (![...seen].some((file) => file.endsWith(`${sep}${name}`))) fail(`MANIFEST_MISSING_${name}`);
  }
  return [...seen].sort();
}
function digest(dir: string): Array<{ path: string; sha256: string }> {
  return closure(dir).map((file) => ({ path: relative(dir, file), sha256: sha256(readFileSync(file)) }));
}
function head(): string {
  const value = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(value)) fail("HEAD_INVALID");
  return value;
}
async function load(dir: string): Promise<Api> {
  const gate = await import(pathToFileURL(join(dir, "boxRequestGate.ts")).href);
  const norm = await import(pathToFileURL(join(dir, "boxCacheAnnotations.ts")).href);
  const match = await import(pathToFileURL(join(dir, "boxToolResultMatcher.ts")).href);
  const finger = await import(pathToFileURL(join(dir, "boxCallFingerprint.ts")).href);
  return {
    normalize: norm.normalizeBoxSemanticBody,
    gate: gate.validateBoxRequest,
    match: match.matchBoxToolResults,
    context: finger.deriveBoxContextHash,
    fingerprint: finger.deriveBoxCallFingerprint,
  };
}
function countText(value: unknown, needle: string): number {
  if (typeof value === "string") return value.split(needle).length - 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countText(item, needle), 0);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce((sum, item) => sum + countText(item, needle), 0);
  }
  return 0;
}
function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    const actual = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : error instanceof Error ? error.message : String(error);
    if (actual !== code && !actual.includes(code)) fail(`EXPECTED_${code}_GOT_${actual}`);
    return;
  }
  fail(`EXPECTED_THROW_${code}`);
}
function checks(api: Api): void {
  if (chain.length !== 6 || annotationCounts.length !== 6) fail("CHAIN_COUNT");
  const normalized = chain.map((body) => {
    const snapshot = JSON.stringify(body);
    const once = api.normalize(body);
    const twice = api.normalize(once as unknown as Record<string, unknown>);
    if (JSON.stringify(body) !== snapshot) fail("RAW_MUTATED");
    if (!isDeepStrictEqual(once, twice)) fail("NOT_IDEMPOTENT");
    if (api.gate(body, true) !== null || api.gate(once as unknown as Record<string, unknown>, true) !== null) {
      fail("GATE_NOT_NULL");
    }
    if (api.fingerprint(3n, body).replayFingerprint
      !== api.fingerprint(3n, once as unknown as Record<string, unknown>).replayFingerprint) fail("FINGERPRINT_DRIFT");
    if (countText(once, "<total_tokens>") !== 0) fail("BUDGET_RETAINED");
    return once;
  });
  for (let i = 1; i < chain.length; i++) {
    if (api.context(chain[i]!, true) !== api.context(chain[i - 1]!)) fail(`CONTEXT_${i}`);
  }
  normalized.forEach((body, index) => {
    const expected = annotationCounts[index]!;
    if (countText(body, PROGRESS) !== expected.progress) fail(`PROGRESS_COUNT_${index}`);
    if (countText(body, HOOK) !== expected.hook) fail(`HOOK_COUNT_${index}`);
    if (countText(body, WRAPPED) !== expected.wrapped) fail(`WRAPPED_COUNT_${index}`);
  });
  for (const rewrite of rewrites) {
    const before = chain[rewrite.from]!.messages as unknown[];
    const after = chain[rewrite.to]!.messages as unknown[];
    if (!isDeepStrictEqual(before.at(-1), rewrite.cached)) fail("REWRITE_CACHED");
    if (!isDeepStrictEqual(after[before.length - 1], rewrite.historical)) fail("REWRITE_HISTORICAL");
    if (isDeepStrictEqual(rewrite.cached, rewrite.historical)) fail("REWRITE_SAME");
    if (typeof (rewrite.historical as { content?: unknown }).content !== "string") fail("REWRITE_NOT_STRING");
  }
  for (const tail of matchedTails) {
    const matched = api.match(chain[tail.step]!, [{ id: tail.id, clientName: "local_echo",
      boxName: "mcp__ocbridge__t0", input: { value: tail.input } }]);
    if (!isDeepStrictEqual(matched[0]?.content, tail.content)) fail(`MATCH_${tail.step}`);
    expectCode(() => api.match(chain[tail.step]!, [{ id: "toolu_other", clientName: "local_echo",
      boxName: "mcp__ocbridge__t0", input: { value: tail.input } }]), "BOX_TOOL_RESULT_");
    expectCode(() => api.match(chain[tail.step]!, [{ id: tail.id, clientName: "local_echo",
      boxName: "mcp__ocbridge__t0", input: { value: "other" } }]), "BOX_TOOL_RESULT_");
  }
  const wrappedOnce = api.normalize(legalWrapped);
  if (countText(wrappedOnce, legalWrappedBytes) !== 1) fail("WRAPPED_BYTES");
  if (api.gate(legalWrapped, true) !== null) fail("WRAPPED_GATE");
  if (!isDeepStrictEqual(wrappedOnce, api.normalize(wrappedOnce as unknown as Record<string, unknown>))) {
    fail("WRAPPED_IDEMPOTENT");
  }
  const historical = api.normalize(historicalBudgetOnly);
  if ((historical.messages as Array<{ role?: string }>).some((message) => message.role === "system")) {
    fail("HISTORICAL_BUDGET_KEPT");
  }
  if (api.gate(unknownText, true) !== "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION") fail("UNKNOWN_TEXT");
  const unknownOnce = api.normalize(unknownText);
  if (!isDeepStrictEqual(unknownOnce, api.normalize(unknownOnce as unknown as Record<string, unknown>))) {
    fail("UNKNOWN_TEXT_IDEMPOTENT");
  }
  if (!JSON.stringify(unknownOnce).includes("not an annotation")) fail("UNKNOWN_TEXT_DROPPED");
  if (api.gate(unknownMarker, true) !== "BOX_CACHE_ANNOTATION_INVALID") fail("UNKNOWN_MARKER");
  expectCode(() => api.normalize(unknownMarker), "BOX_CACHE_ANNOTATION_INVALID");
  for (const item of composedRejects) {
    const snapshot = JSON.stringify(item.body);
    if (api.gate(item.body, true) !== "BOX_CACHE_ANNOTATION_INVALID") fail("C2_GATE");
    expectCode(() => api.normalize(item.body), "BOX_CACHE_ANNOTATION_INVALID");
    expectCode(() => api.normalize(structuredClone(item.body)), "BOX_CACHE_ANNOTATION_INVALID");
    expectCode(() => api.context(item.body), "BOX_CACHE_ANNOTATION_INVALID");
    expectCode(() => api.match(item.body, [{ id: item.id, clientName: "local_echo",
      boxName: "mcp__ocbridge__t0", input: { value: item.input } }]), "BOX_CACHE_ANNOTATION_INVALID");
    if (JSON.stringify(item.body) !== snapshot) fail("C2_RAW_MUTATED");
    let drifted = false;
    try {
      const once = api.normalize(item.body);
      if (api.gate(item.body, true) === null
        || api.context(item.body) !== api.context(once as unknown as Record<string, unknown>)) drifted = true;
    } catch { /* stable rejection has no second hash */ }
    if (drifted) fail("C2_DRIFT");
  }
}
function patch(source: string, fault: string): string {
  if (fault === "progress") {
    const needle = "function bareHookBeforeBudget(text: string): string | null {\n";
    if (!source.includes(needle)) fail("FAULT_ANCHOR_PROGRESS");
    return source.replace(needle, `${needle}  if (text.startsWith(PROGRESS_SENTENCE)) return null;\n`);
  }
  if (fault === "keep-budget") {
    const needle = "function historicalBudgetString(text: string): boolean {\n  return exactMatch(BARE_BUDGET, text);\n}";
    if (!source.includes(needle)) fail("FAULT_ANCHOR_BUDGET");
    return source.replace(needle,
      "function historicalBudgetString(text: string): boolean {\n  return false && exactMatch(BARE_BUDGET, text);\n}");
  }
  if (fault === "promote-wrapper") {
    const needle = "function rejectIfUnapprovedBoundary(message: Record<string, unknown>): void {\n  if (unapprovedCollapsibleBoundary(message)) {";
    if (!source.includes(needle)) fail("FAULT_ANCHOR_WRAPPER");
    return source.replace(needle,
      "function rejectIfUnapprovedBoundary(message: Record<string, unknown>): void {\n  return;\n  if (unapprovedCollapsibleBoundary(message)) {");
  }
  return fail(`UNKNOWN_FAULT_${fault}`);
}
async function faultIsRed(name: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-294-b1-gate-"));
  try {
    for (const file of closure(PROXY)) copyFileSync(file, join(dir, relative(PROXY, file)));
    const target = join(dir, "boxCacheAnnotations.ts");
    const next = patch(readFileSync(target, "utf8"), name);
    if (sha256(next) === sha256(readFileSync(join(PROXY, "boxCacheAnnotations.ts")))) fail("FAULT_NOT_ISOLATED");
    writeFileSync(target, next);
    let red = false;
    try { checks(await load(dir)); }
    catch { red = true; }
    if (!red) fail(`FAULT_STILL_GREEN_${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const expectSha = flag("--expect-sha");
  const onlyFault = flag("--fault");
  const boundHead = head();
  if (expectSha && expectSha !== boundHead) fail("HEAD_MISMATCH");
  if (onlyFault) {
    await faultIsRed(onlyFault);
    console.log(JSON.stringify({ ok: true, faultRed: onlyFault, head: boundHead }));
    return;
  }
  const before = digest(PROXY);
  const api = await load(PROXY);
  const after = digest(PROXY);
  if (!isDeepStrictEqual(before, after)) fail("MANIFEST_DRIFT");
  checks(api);
  for (const name of ["progress", "keep-budget", "promote-wrapper"]) await faultIsRed(name);
  if (!existsSync(join(ROOT, "scripts/check-v5-box-continuation-fixture.ts"))) fail("FIXTURE_MISSING");
  console.log(JSON.stringify({
    ok: true, head: boundHead, modules: before.length, wired: false,
    annotations: sha256(readFileSync(join(PROXY, "boxCacheAnnotations.ts"))),
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
