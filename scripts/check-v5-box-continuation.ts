/** Formal continuation gate for INC-20260928-BOX-MULTITOOL-CONTINUATION.
 * Release scripts call this file. The receipt wired field is true.
 *
 * From the candidate root, with that tree's node or tsx:
 *   tsx scripts/check-v5-box-continuation.ts --expect-sha <40-hex>
 *   node scripts/check-v5-box-continuation.ts --expect-sha <40-hex>
 * The process that parses arguments is only a supervisor. It uses node
 * builtins, starts the worker in a new process group, and enforces LIMIT_MS
 * from before that spawn. A synchronous worker cannot postpone the deadline.
 * There is no CLI switch that skips the deadline or the business receipt.
 * Node 22 receives --experimental-transform-types on the worker spawn, not
 * via a re-exec that runs before supervision. --expect-sha is required and
 * is the builder archive SHA. Unknown arguments fail. A tree with no .git
 * still runs. Fault mutations live in check-v5-box-continuation.negative.ts.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const LIMIT_MS = 60_000;
const RECEIPT = "ocv5-b1-continuation-pass";
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
  match: (body: Record<string, unknown>, expected: readonly Record<string, unknown>[],
    catalog?: unknown) =>
    readonly { modelToolUseId: string; content: ReadonlyArray<{ type?: string; text?: string }>; isError: boolean }[];
  proveEditDefault: () => void;
  context: (body: Record<string, unknown>, completedToolTail?: boolean) => string;
  fingerprint: (uid: bigint, body: Record<string, unknown>) => { replayFingerprint: string };
};
type Digest = Array<{ path: string; sha256: string }>;
type Fixture = {
  annotationCounts: Array<{ progress: number; hook: number; wrapped: number }>;
  chain: Array<Record<string, unknown>>;
  composedRejects: Array<{ id: string; input: string; body: Record<string, unknown> }>;
  historicalBudgetOnly: Record<string, unknown>;
  HOOK: string;
  legalWrapped: Record<string, unknown>;
  legalWrappedBytes: string;
  openingResult: { id: string; input: string; isError: false; content: Array<{ type: "text"; text: string }> };
  continuationResults: Array<{ id: string; input: string; isError: false; content: Array<{ type: "text"; text: string }> }>;
  rewriteProofs: Array<{ previous: number; next: number; id: string;
    result: { id: string; input: string; isError: false; content: Array<{ type: "text"; text: string }> } }>;
  wrappedResult: { id: string; input: string; isError: false; content: Array<{ type: "text"; text: string }> };
  PROGRESS: string;
  rewrites: Array<{ from: number; to: number; cached: unknown; historical: { content?: unknown } }>;
  unknownMarker: Record<string, unknown>;
  unknownText: Record<string, unknown>;
  WRAPPED: string;
};

let scratch = "";
let fx: Fixture;
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
function gitCrossCheck(expectSha: string): Promise<"absent" | "match"> {
  if (!existsSync(join(CANDIDATE, ".git"))) return Promise.resolve("absent");
  return new Promise((resolveGit, rejectGit) => {
    const child = spawn("git", ["-C", CANDIDATE, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, value?: "match"): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectGit(error);
      else resolveGit(value ?? "match");
    };
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(new Error("GIT_CROSSCHECK_TIMEOUT"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => finish(new Error("GIT_CROSSCHECK_FAILED")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) { finish(new Error("GIT_CROSSCHECK_FAILED")); return; }
      const value = out.trim();
      if (!/^[0-9a-f]{40}$/.test(value)) finish(new Error("GIT_HEAD_INVALID"));
      else if (value !== expectSha) finish(new Error("GIT_SHA_MISMATCH"));
      else finish(null, "match");
    });
  });
}
function isolate(dir: string): void {
  for (const name of ["home", "state", "tmp"]) mkdirSync(join(dir, name), { recursive: true });
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
  const catalogMod = await import(pathToFileURL(join(PROXY, "boxToolCatalog.ts")).href);
  const hashMod = await import(pathToFileURL(join(PROXY, "boxToolInputHash.ts")).href);
  const echoMod = await import(pathToFileURL(join(PROXY, "boxToolInputEcho.ts")).href);
  return {
    normalize: norm.normalizeBoxSemanticBody,
    gate: gate.validateBoxRequest,
    match: match.matchBoxToolResults,
    context: finger.deriveBoxContextHash,
    fingerprint: finger.deriveBoxCallFingerprint,
    proveEditDefault: () => proveEditDefault({
      match: match.matchBoxToolResults,
      compile: catalogMod.compileBoxToolCatalog,
      hashInput: hashMod.hashBoxToolInput,
      project: echoMod.comparableAssistantContent,
      accept: finger.incomingAssistantAccepted,
      hashFull: finger.hashBoxAssistantContent,
      hashNoCaller: finger.hashBoxAssistantNoCallerContent,
      hashEcho: finger.hashBoxAssistantEchoContent,
    }),
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
function useOf(spec: { id: string; input: string }): Record<string, unknown> {
  return { id: spec.id, clientName: "local_echo", boxName: "mcp__ocbridge__t0", input: { value: spec.input } };
}
function expectTail(api: Api, body: Record<string, unknown>,
  spec: { id: string; input: string; isError: false; content: Array<{ type: "text"; text: string }> },
  label: string): ReadonlyArray<{ type?: string; text?: string }> {
  const matched = api.match(body, [useOf(spec)]);
  if (matched.length !== 1) fail(`${label}_COUNT`);
  const row = matched[0]!;
  if (row.modelToolUseId !== spec.id) fail(`${label}_ID`);
  if (row.isError !== spec.isError) fail(`${label}_ISERROR`);
  if (row.content.length !== spec.content.length) fail(`${label}_BLOCKS`);
  for (let index = 0; index < spec.content.length; index++) {
    const actual = row.content[index]?.text;
    const expected = spec.content[index]!.text;
    if (actual !== expected || row.content[index]?.type !== "text") fail(`${label}_TEXT_${index}`);
  }
  if (!isDeepStrictEqual(row.content, spec.content)) fail(`${label}_BYTES`);
  return row.content;
}
function sliceThroughTool(body: Record<string, unknown>, id: string): Record<string, unknown> {
  const messages = body.messages as Array<{ role?: string; content?: unknown }>;
  let userIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    if (content.some((block) => block && typeof block === "object"
      && (block as { tool_use_id?: unknown }).tool_use_id === id)) userIndex = index;
  }
  if (userIndex < 0) fail(`SLICE_${id}`);
  let end = userIndex;
  if (messages[userIndex + 1]?.role === "system") end = userIndex + 1;
  return { ...body, messages: messages.slice(0, end + 1) };
}
function proveEditDefault(api: {
  match: Api["match"];
  compile: (tools: unknown) => { bindingSha256: string };
  hashInput: (input: unknown) => string;
  project: (content: unknown, digests: readonly { clientName: string; inputHash: string }[],
    catalog: unknown) => unknown[];
  accept: (content: unknown, stored: { assistantContentHash: string;
    assistantNoCallerHash?: string; assistantEchoHash?: string }) => boolean;
  hashFull: (content: unknown) => string;
  hashNoCaller: (content: unknown) => string;
  hashEcho: (content: unknown) => string;
}): void {
  const edit = {
    name: "Edit", description: "edit a file",
    input_schema: { type: "object", required: ["file_path", "old_string", "new_string"],
      properties: { file_path: { type: "string" }, old_string: { type: "string" },
        new_string: { type: "string" }, replace_all: { type: "boolean", default: false } } },
  };
  const read = { name: "Read", description: "read a file",
    input_schema: { type: "object", required: ["file_path"],
      properties: { file_path: { type: "string" }, limit: { type: "integer" } } } };
  const catalog = api.compile([read, edit]);
  const plain = { file_path: "/tmp/ocv5-edit-default/sample.txt", old_string: "OLD", new_string: "NEW" };
  const explicit = { ...plain, replace_all: false };
  const stored = [api.hashInput(plain), api.hashInput(explicit)];
  const echoed = [
    { type: "tool_use", id: "toolu_edit_omit", name: "Edit", input: explicit },
    { type: "tool_use", id: "toolu_edit_false", name: "Edit", input: explicit },
  ];
  const body = { model: "box-api-claude-opus-5-5", messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: echoed },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_edit_omit", content: "ok" },
      { type: "tool_result", tool_use_id: "toolu_edit_false", content: "ok" },
    ] },
  ] };
  const expected = [
    { id: "toolu_edit_omit", clientName: "Edit", inputHash: stored[0] },
    { id: "toolu_edit_false", clientName: "Edit", inputHash: stored[1] },
  ];
  const snapshot = JSON.stringify(body);
  const matched = api.match(body, expected, catalog);
  if (matched.length !== 2 || JSON.stringify(body) !== snapshot) fail("EDIT_DEFAULT_MATCH");
  const storedContent = [
    { ...echoed[0], input: plain },
    echoed[1],
  ];
  const view = api.project(echoed, expected, catalog);
  const storedHashes = {
    assistantContentHash: api.hashFull(storedContent),
    assistantNoCallerHash: api.hashNoCaller(storedContent),
    assistantEchoHash: api.hashEcho(storedContent),
  };
  if (api.hashFull(view) !== storedHashes.assistantContentHash) fail("EDIT_DEFAULT_FULL");
  if (!api.accept(view, storedHashes)) fail("EDIT_DEFAULT_ASSISTANT");
  const tampered = view.map((block) => block && typeof block === "object"
    ? { ...(block as object), caller: { type: "tampered" } } : block);
  if (api.accept(tampered, storedHashes)) fail("EDIT_DEFAULT_CALLER");
  const metaStored = [
    { type: "tool_use", id: "toolu_meta", name: "Edit", input: plain,
      caller: { type: "direct" }, provider_meta: "keep" },
  ];
  const metaIncoming = [
    { type: "tool_use", id: "toolu_meta", name: "Edit", input: explicit, provider_meta: "keep" },
  ];
  const metaExpected = [{ id: "toolu_meta", clientName: "Edit", inputHash: api.hashInput(plain) }];
  const metaView = api.project(metaIncoming, metaExpected, catalog);
  const metaHashes = {
    assistantContentHash: api.hashFull(metaStored),
    assistantNoCallerHash: api.hashNoCaller(metaStored),
    assistantEchoHash: api.hashEcho(metaStored),
  };
  if (api.hashFull(metaView) !== metaHashes.assistantNoCallerHash) fail("EDIT_DEFAULT_NOCALLER");
  if (api.hashFull(metaView) === metaHashes.assistantContentHash
    || api.hashFull(metaView) === metaHashes.assistantEchoHash) fail("EDIT_DEFAULT_NOCALLER_DISTINCT");
  if (!api.accept(metaView, metaHashes)) fail("EDIT_DEFAULT_NOCALLER_ACCEPT");
  const echoStored = [
    { type: "thinking", thinking: "note", signature: "sig-a" },
    { type: "tool_use", id: "toolu_echo", name: "Edit", input: plain, caller: { type: "direct" } },
  ];
  const echoIncoming = [
    { type: "tool_use", id: "toolu_echo", name: "Edit", input: explicit },
  ];
  const echoExpected = [{ id: "toolu_echo", clientName: "Edit", inputHash: api.hashInput(plain) }];
  const echoView = api.project(echoIncoming, echoExpected, catalog);
  const echoHashes = {
    assistantContentHash: api.hashFull(echoStored),
    assistantNoCallerHash: api.hashNoCaller(echoStored),
    assistantEchoHash: api.hashEcho(echoStored),
  };
  if (api.hashFull(echoView) !== echoHashes.assistantEchoHash) fail("EDIT_DEFAULT_ECHO");
  if (api.hashFull(echoView) === echoHashes.assistantContentHash
    || api.hashFull(echoView) === echoHashes.assistantNoCallerHash) fail("EDIT_DEFAULT_ECHO_DISTINCT");
  if (!api.accept(echoView, echoHashes)) fail("EDIT_DEFAULT_ECHO_ACCEPT");
  const signed = [
    { type: "thinking", thinking: "note", signature: "sig-b" },
    echoStored[1],
  ];
  if (api.accept(api.project(signed, echoExpected, catalog), echoHashes)) fail("EDIT_DEFAULT_SIGNATURE");
  const redacted = [{ type: "redacted_thinking", data: "opaque" }, ...echoIncoming];
  if (api.accept(api.project(redacted, echoExpected, catalog), echoHashes)) fail("EDIT_DEFAULT_REDACTED");
  expectCode(() => api.match(body, [
    { id: "toolu_edit_omit", clientName: "Edit", inputHash: stored[0] },
    { id: "toolu_edit_false", clientName: "Edit", inputHash: api.hashInput({ ...explicit, replace_all: true }) },
  ], catalog), "BOX_TOOL_RESULT_HISTORY_MISMATCH");
}

function checks(api: Api): void {
  const { annotationCounts, chain, composedRejects, continuationResults, historicalBudgetOnly, HOOK,
    legalWrapped, legalWrappedBytes, openingResult, PROGRESS, rewriteProofs, rewrites, unknownMarker,
    unknownText, WRAPPED, wrappedResult } = fx;
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
  const opening = expectTail(api, chain[0]!, openingResult, "OPENING");
  if (opening.length !== 1 || opening[0]?.text !== "r1") fail("OPENING_TEXT_0");
  const tails = continuationResults.map((spec, index) =>
    expectTail(api, chain[index + 1]!, spec, `CONTINUATION_${index + 1}`));
  for (const proof of rewriteProofs) {
    const previous = expectTail(api, chain[proof.previous]!, proof.result, `REWRITE_PREV_${proof.id}`);
    const historical = expectTail(api, sliceThroughTool(chain[proof.next]!, proof.id), proof.result,
      `REWRITE_HIST_${proof.id}`);
    if (!isDeepStrictEqual(historical, previous)) fail(`REWRITE_DRIFT_${proof.id}`);
    if (!isDeepStrictEqual(historical, proof.result.content)) fail(`REWRITE_EXPECTED_${proof.id}`);
  }
  if (tails[3]?.[1]?.text !== HOOK) fail("HOOK_CURRENT_TEXT");
  for (const rewrite of rewrites) {
    const before = chain[rewrite.from]!.messages as unknown[];
    const after = chain[rewrite.to]!.messages as unknown[];
    if (!isDeepStrictEqual(before.at(-1), rewrite.cached)) fail("REWRITE_CACHED");
    if (!isDeepStrictEqual(after[before.length - 1], rewrite.historical)) fail("REWRITE_HISTORICAL");
    if (isDeepStrictEqual(rewrite.cached, rewrite.historical)) fail("REWRITE_SAME");
    if (typeof (rewrite.historical as { content?: unknown }).content !== "string") fail("REWRITE_NOT_STRING");
  }
  for (const [body, spec] of [[chain[2]!, continuationResults[1]!],
    [chain[4]!, continuationResults[3]!], [chain[5]!, continuationResults[4]!]] as const) {
    expectCode(() => api.match(body, [{ id: "toolu_other", clientName: "local_echo",
      boxName: "mcp__ocbridge__t0", input: { value: spec.input } }]), "BOX_TOOL_RESULT_");
    expectCode(() => api.match(body, [{ id: spec.id, clientName: "local_echo",
      boxName: "mcp__ocbridge__t0", input: { value: "other" } }]), "BOX_TOOL_RESULT_");
  }
  const wrappedBlocks = expectTail(api, legalWrapped, wrappedResult, "WRAPPED");
  if (wrappedBlocks[1]?.text !== legalWrappedBytes) fail("WRAPPED_TEXT_1");
  const wrappedOnce = api.normalize(legalWrapped);
  if (countText(wrappedOnce, legalWrappedBytes) !== 1) fail("WRAPPED_COUNT");
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
  api.proveEditDefault();
}

function procField(pid: number, index: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[index] ?? "";
}
function groupAlive(pgid: number): boolean {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (Number(procField(Number(name), 2)) === pgid) return true;
    } catch { /* process exited while scanning */ }
  }
  return false;
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}
function workerLaunch(expectSha: string): { cmd: string; args: string[] } {
  const args = process.execArgv.filter((arg) => arg !== "-e" && !arg.startsWith("--eval"));
  const tsx = args.some((arg) => arg.includes("/tsx/"));
  const major = Number(process.versions.node.split(".")[0]);
  if (!tsx && major >= 22 && !args.includes("--experimental-transform-types")) {
    args.push("--experimental-transform-types");
  }
  args.push(SELF, "--expect-sha", expectSha);
  return { cmd: process.execPath, args };
}
function whitelist(dir: string, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "SystemRoot"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = join(dir, "home");
  env.OPENCLAUDE_HOME = join(dir, "state");
  env.TMPDIR = join(dir, "tmp");
  env.TEMP = env.TMPDIR;
  env.TMP = env.TMPDIR;
  env.NO_COLOR = "1";
  env.OC_B1_SUPERVISED = "1";
  env.OC_B1_PARENT_PID = String(process.pid);
  env.OC_B1_SCRATCH = dir;
  env.OC_B1_WORKER_TOKEN = token;
  env.OC_B1_WORKER_TOKEN_FILE = join(dir, "token");
  return env;
}
function acceptReceipt(stdout: string, expectSha: string): boolean {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  try {
    const body = JSON.parse(line) as { ok?: boolean; wired?: boolean; expectSha?: string;
      receipt?: string; runtimeModules?: number; homeIsolated?: boolean; database?: boolean };
    return body.ok === true && body.wired === true && body.expectSha === expectSha
      && body.receipt === RECEIPT && (body.runtimeModules ?? 0) >= 9
      && body.homeIsolated === true && body.database === false;
  } catch { return false; }
}
async function supervise(expectSha: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-b1-home-"));
  for (const name of ["home", "state", "tmp"]) mkdirSync(join(dir, name), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(join(dir, "token"), token, { mode: 0o600 });
  const started = Date.now();
  let worker = 0;
  let reason: string | null = null;
  let closed = false;
  const stop = (next: string): void => {
    if (reason || closed) return;
    reason = next;
    if (!worker) return;
    signalGroup(worker, "SIGTERM");
    setTimeout(() => signalGroup(worker, "SIGKILL"), 1_000);
  };
  const onSignal = (): void => stop("SUPERVISOR_SIGNAL");
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const timer = setTimeout(() => stop("SUPERVISOR_TIMEOUT"), LIMIT_MS);
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let code = 1;
  try {
  const launch = workerLaunch(expectSha);
  const child = spawn(launch.cmd, launch.args, {
    cwd: CANDIDATE, env: whitelist(dir, token), detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) fail("SUPERVISOR_SPAWN");
  worker = child.pid;
  const starttime = procField(worker, 19);
  process.stderr.write(`OC_B1_SUPERVISOR worker=${worker} pgid=${worker} starttime=${starttime} start=${started} scratch=${dir}\n`);
  const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
    bytes += chunk.length;
    if (bytes > 1_000_000) { stop("SUPERVISOR_OUTPUT"); return; }
    const text = chunk.toString("utf8");
    if (target === "stdout") stdout += text;
    else { stderr += text; process.stderr.write(text); }
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  child.on("error", () => stop("SUPERVISOR_SPAWN"));
  code = await new Promise<number>((resolveCode) => {
    child.on("close", (status) => { closed = true; resolveCode(status ?? 1); });
  });
  child.stdout.destroy();
  child.stderr.destroy();
  } finally {
  clearTimeout(timer);
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
  if (worker && groupAlive(worker)) {
    signalGroup(worker, "SIGKILL");
    const end = Date.now() + 1_000;
    while (Date.now() < end && groupAlive(worker)) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  rmSync(dir, { recursive: true, force: true });
  }
  if (worker && groupAlive(worker)) fail("SUPERVISOR_ORPHAN");
  if (reason) fail(reason);
  if (code !== 0 || !acceptReceipt(stdout, expectSha)) {
    fail(code !== 0 ? "SUPERVISOR_WORKER_FAILED" : "SUPERVISOR_MISSING_RECEIPT");
  }
  process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
}
async function workerMain(expectSha: string): Promise<void> {
  const token = process.env.OC_B1_WORKER_TOKEN ?? "";
  const tokenFile = process.env.OC_B1_WORKER_TOKEN_FILE ?? "";
  const parent = Number(process.env.OC_B1_PARENT_PID ?? "");
  if (process.env.OC_B1_SUPERVISED !== "1" || process.ppid !== parent
    || !/^[0-9a-f]{64}$/.test(token) || readFileSync(tokenFile, "utf8") !== token) {
    fail("WORKER_TOKEN_MISMATCH");
  }
  scratch = process.env.OC_B1_SCRATCH ?? "";
  if (!scratch) fail("WORKER_SCRATCH");
  isolate(scratch);
  installResolveHook();
  fx = await import("./check-v5-box-continuation-fixture.ts");
  const git = await gitCrossCheck(expectSha);
  const before = digest();
  const api = await load();
  const after = digest();
  if (!isDeepStrictEqual(before, after)) fail("MANIFEST_DRIFT_AFTER_LOAD");
  checks(api);
  const end = digest();
  if (!isDeepStrictEqual(before, end)) fail("MANIFEST_DRIFT_FINAL");
  const runtime = before.filter((item) => item.path.startsWith(`packages${sep}commercial${sep}src${sep}http${sep}proxy${sep}`));
  console.log(JSON.stringify({
    ok: true, wired: true, receipt: RECEIPT, expectSha, candidate: CANDIDATE, git,
    runtimeModules: runtime.length, modules: before.length, digest: before,
    node: process.version, execPath: realpathSync(process.execPath),
    homeIsolated: process.env.HOME === join(scratch, "home"),
    database: process.env.DATABASE_URL !== undefined,
  }));
}

async function entry(): Promise<void> {
  const { expectSha } = parseArgs(process.argv);
  if (process.env.OC_B1_SUPERVISED === "1") await workerMain(expectSha);
  else await supervise(expectSha);
}
entry().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
