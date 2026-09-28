/** Formal continuation gate for INC-20260928-BOX-MULTITOOL-CONTINUATION.
 * Not a deploy-gate proof. wired stays false until a release script calls it.
 *
 * From the candidate root, with that tree's node or tsx:
 *   tsx scripts/check-v5-box-continuation.ts --expect-sha <40-hex>
 *   node scripts/check-v5-box-continuation.ts --expect-sha <40-hex>
 * Node 22 re-execs with --experimental-transform-types. --expect-sha is required
 * and is the builder archive SHA, not this process's git HEAD. Unknown
 * arguments fail. A tree with no .git still runs. Fault mutations are not
 * accepted here; they live in check-v5-box-continuation.negative.ts.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  annotationCounts, chain, composedRejects, historicalBudgetOnly, HOOK, legalWrapped,
  legalWrappedBytes, matchedTails, PROGRESS, rewrites, unknownMarker, unknownText, WRAPPED,
} from "./check-v5-box-continuation-fixture.ts";

const LIMIT_MS = 60_000;
const CANDIDATE = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const PROXY = realpathSync(join(CANDIDATE, "packages/commercial/src/http/proxy"));
const SELF = realpathSync(fileURLToPath(import.meta.url));
const FIXTURE = realpathSync(fileURLToPath(new URL("./check-v5-box-continuation-fixture.ts", import.meta.url)));
const LOADER = realpathSync(fileURLToPath(new URL("./check-v5-box-continuation-resolve.mjs", import.meta.url)));
const ENTRIES = ["boxRequestGate.ts", "boxCacheAnnotations.ts", "boxToolResultMatcher.ts",
  "boxCallFingerprint.ts"];
const KNOWN = new Set(["--expect-sha"]);

type Api = {
  normalize: (body: Record<string, unknown>) => { messages: unknown[] };
  gate: (body: Record<string, unknown>, enabled: boolean) => string | null;
  match: (body: Record<string, unknown>, expected: readonly Record<string, unknown>[]) =>
    readonly { content: unknown }[];
  context: (body: Record<string, unknown>, completedToolTail?: boolean) => string;
  fingerprint: (uid: bigint, body: Record<string, unknown>) => { replayFingerprint: string };
};
type Digest = Array<{ path: string; sha256: string }>;

let scratch = "";
function fail(message: string): never {
  throw new Error(message);
}
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function underTsx(): boolean {
  return process.execArgv.some((arg) => arg.includes("/tsx/"));
}
function contained(file: string): boolean {
  const rel = relative(CANDIDATE, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function parseArgs(argv: string[]): { expectSha: string } {
  let expectSha = "";
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!KNOWN.has(arg)) fail(`UNKNOWN_ARG ${arg}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) fail("EXPECT_SHA_REQUIRED");
    if (expectSha) fail("EXPECT_SHA_DUPLICATE");
    if (!/^[0-9a-f]{40}$/.test(value)) fail("EXPECT_SHA_INVALID");
    expectSha = value;
  }
  if (!expectSha) fail("EXPECT_SHA_REQUIRED");
  return { expectSha };
}
function ensureNodeTransform(): void {
  if (underTsx()) return;
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22 || process.execArgv.includes("--experimental-transform-types")) return;
  const child = spawnSync(process.execPath,
    ["--experimental-transform-types", ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(child.status === null ? 1 : child.status);
}
function installResolveHook(): void {
  if (underTsx()) return;
  register(pathToFileURL(LOADER).href);
}
function typeOnlyClause(prefix: string | undefined, clause: string): boolean {
  if (prefix) return true;
  const body = clause.trim();
  if (!body.startsWith("{")) return false;
  const inside = body.slice(1, body.lastIndexOf("}"));
  const parts = inside.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => part.startsWith("type "));
}
function parseSpecs(source: string): Array<{ spec: string; typeOnly: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  const re = /(^|\n)\s*import\s+(type\s+)?([\s\S]*?)\sfrom\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(re)) {
    const clause = match[3] ?? "";
    if (clause.includes(";") || /\n\s*import\s/.test(clause)) continue;
    const spec = match[4]!;
    if (!spec.startsWith(".")) continue;
    out.push({ spec, typeOnly: typeOnlyClause(match[2], clause) });
  }
  return out;
}
function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = spec.endsWith(".js")
    ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`, base]
    : [base, `${base}.ts`, `${base}.tsx`];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  }
  return null;
}
function digest(): Digest {
  const pending = ENTRIES.map((name) => realpathSync(join(PROXY, name)));
  const seen = new Set<string>();
  const files = new Set<string>([SELF, FIXTURE, LOADER]);
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    if (!contained(file)) fail(`DEP_ESCAPE ${file}`);
    seen.add(file);
    files.add(file);
    for (const item of parseSpecs(readFileSync(file, "utf8"))) {
      const next = resolveLocal(file, item.spec);
      if (item.typeOnly) {
        if (next && contained(next)) files.add(next);
        continue;
      }
      if (!next) fail(`UNRESOLVED ${item.spec} from ${file}`);
      if (!contained(next)) fail(`DEP_ESCAPE ${next}`);
      pending.push(next);
    }
  }
  const proxyCount = [...files].filter((file) => file.startsWith(`${PROXY}${sep}`)).length;
  if (proxyCount < 9) fail(`RUNTIME_MODULES_${proxyCount}`);
  for (const file of files) {
    if (!contained(file)) fail(`DEP_ESCAPE ${file}`);
  }
  return [...files].sort().map((file) => ({
    path: relative(CANDIDATE, file),
    sha256: sha256(readFileSync(file)),
  }));
}
function gitCrossCheck(expectSha: string): "absent" | "match" {
  if (!existsSync(join(CANDIDATE, ".git"))) return "absent";
  const status = spawnSync("git", ["-C", CANDIDATE, "rev-parse", "HEAD"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (status.status !== 0) fail("GIT_CROSSCHECK_FAILED");
  const value = (status.stdout ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(value)) fail("GIT_HEAD_INVALID");
  if (value !== expectSha) fail("GIT_SHA_MISMATCH");
  return "match";
}
function isolate(dir: string): void {
  for (const name of ["home", "state", "tmp"]) mkdirSync(join(dir, name));
  const kept: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "SystemRoot"]) {
    if (process.env[key] !== undefined) kept[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, kept, {
    HOME: join(dir, "home"),
    OPENCLAUDE_HOME: join(dir, "state"),
    TMPDIR: join(dir, "tmp"),
    TEMP: join(dir, "tmp"),
    TMP: join(dir, "tmp"),
    NO_COLOR: "1",
  });
}
async function load(): Promise<Api> {
  const gate = await import(pathToFileURL(join(PROXY, "boxRequestGate.ts")).href);
  const norm = await import(pathToFileURL(join(PROXY, "boxCacheAnnotations.ts")).href);
  const match = await import(pathToFileURL(join(PROXY, "boxToolResultMatcher.ts")).href);
  const finger = await import(pathToFileURL(join(PROXY, "boxCallFingerprint.ts")).href);
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

function cleanup(): void {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
process.on("SIGTERM", () => { cleanup(); process.exit(1); });
process.on("SIGINT", () => { cleanup(); process.exit(1); });

async function main(): Promise<void> {
  ensureNodeTransform();
  const timer = setTimeout(() => { cleanup(); process.exit(1); }, LIMIT_MS);
  const { expectSha } = parseArgs(process.argv);
  const git = gitCrossCheck(expectSha);
  scratch = mkdtempSync(join(tmpdir(), "ocv5-b1-home-"));
  try {
    isolate(scratch);
    installResolveHook();
    const before = digest();
    const api = await load();
    const after = digest();
    if (!isDeepStrictEqual(before, after)) fail("MANIFEST_DRIFT_AFTER_LOAD");
    checks(api);
    const end = digest();
    if (!isDeepStrictEqual(before, end)) fail("MANIFEST_DRIFT_FINAL");
    const runtime = before.filter((item) => item.path.startsWith(`packages${sep}commercial${sep}src${sep}http${sep}proxy${sep}`));
    console.log(JSON.stringify({
      ok: true, wired: false, expectSha, candidate: CANDIDATE, git,
      runtimeModules: runtime.length, modules: before.length, digest: before,
      node: process.version, execPath: realpathSync(process.execPath),
      homeIsolated: process.env.HOME === join(scratch, "home"),
      database: process.env.DATABASE_URL !== undefined,
    }));
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

main().catch((error: unknown) => {
  cleanup();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
