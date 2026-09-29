/** Formal continuation gate for INC-20260928-BOX-MULTITOOL-CONTINUATION.
 * Release scripts call this file. The receipt wired field is true.
 *
 * From the candidate root, with that tree's node or tsx:
 *   tsx scripts/check-v5-box-continuation.ts --expect-sha <40-hex>
 *   node scripts/check-v5-box-continuation.ts --expect-sha <40-hex>
 * The process that parses arguments is only a supervisor. It uses node
 * builtins, starts the worker in a new process group, and enforces LIMIT_MS
 * from before that spawn. A synchronous worker cannot postpone the deadline.
 * Before spawn the supervisor exclusively creates one /tmp/ocv5-289-run-<24 hex>
 * directory, passes that path to the worker, and removes it only after the
 * worker process group has drained. The worker does not create or delete it.
 * A path that already exists is left untouched. There is no CLI switch that
 * skips the deadline or the business receipt.
 * Node 22 receives --experimental-transform-types on the worker spawn, not
 * via a re-exec that runs before supervision. --expect-sha is required and
 * is the builder archive SHA. Unknown arguments fail. A tree with no .git
 * still runs. Fault mutations live in check-v5-box-continuation.negative.ts.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const LIMIT_MS = 60_000;
const PUBLISH_DIR = /^\/tmp\/ocv5-289-run-[0-9a-f]{24}$/;
const RECEIPT = "ocv5-b1-continuation-pass";
const CANDIDATE = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const PROXY = realpathSync(join(CANDIDATE, "packages/commercial/src/http/proxy"));
const SELF = realpathSync(fileURLToPath(import.meta.url));
const FIXTURE = realpathSync(fileURLToPath(new URL("./check-v5-box-continuation-fixture.ts", import.meta.url)));
const LOADER = realpathSync(fileURLToPath(new URL("./check-v5-box-continuation-resolve.mjs", import.meta.url)));
const ENTRIES = ["boxRequestGate.ts", "boxCacheAnnotations.ts", "boxToolResultMatcher.ts",
  "boxCallFingerprint.ts", "boxToolResultPlan.ts", "boxToolResultEcho.ts"];
const IMAGE_FILE = realpathSync(fileURLToPath(new URL("./check-v5-box-continuation-859.png", import.meta.url)));
const ORACLE_FILE = realpathSync(fileURLToPath(new URL("./check-v5-box-continuation-859.oracle.json", import.meta.url)));
const SEALED_IMAGE_SHA = "a9491d8d9cb458b11d4ac6c5fc4b5c2d4d370a1d9b6f7960cc5dffae678538a0";
const SEALED_CAPTION = "[Image: original 80x2200, displayed at 73x2000. Multiply coordinates by 1.10 to map to original image.]";
const SEALED_CAPTION_SHA = "0fffd83f1a3c5d2e5f9f19d4c034008715f2d6bbc4c5689e4c635695326f77cb";
const SEALED_CONTENT_HASH = "bbf51fecfe97c9c846f25efd38c7198f4faf0adcc5e17f764c15623f9ddc4eae";
const SEALED_ID = "toolu_img_b1";
const SEALED_NOTE = "toolu_note_b1";
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
  echoAccept: (id: string, hash: string, raw: unknown) => void;
  publishImage: (row: PublishedMatch) => PublishedFile;
  classify: (body: Record<string, unknown>) => { classification: string; rejectCode: string | null };
  projectAuthority: (kind: unknown, authorityTurnId: unknown) => { kind: string };
  bindAuthority: (left: { kind: string }, right: { kind: string }) => { ok: boolean };
  bindIdentity: (left: { uid: bigint; sessionId: string; canonicalModel: string; turnKey: string;
    authority: { kind: string } }, right: { uid: bigint; sessionId: string; canonicalModel: string;
    turnKey: string; authority: { kind: string } }) => { ok: boolean };
  resumeMayPublish: (decision: { kind: string }) => boolean;
};
type Digest = Array<{ path: string; realpath: string; sha256: string }>;
type ImageOracle = {
  id: string; noteId: string; imageSha256: string; caption: string;
  captionSha256: string; contentHash: string;
};
type PublishedPart = { type?: string; data?: string; mimeType?: string; text?: string };
type PublishedFile = { modelToolUseId?: unknown; isError?: unknown; content?: PublishedPart[] };
type PublishedMatch = {
  modelToolUseId: string;
  content: ReadonlyArray<PublishedPart>;
  isError: boolean;
  contentHash: string;
};
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
let publishDir = "";
let fx: Fixture;
function fail(message: string): never {
  throw new Error(message);
}
function sha256(text: string | Buffer): string {
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
  const files = new Set<string>([SELF, FIXTURE, LOADER, IMAGE_FILE, ORACLE_FILE]);
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
    realpath: file,
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
  const resultEcho = await import(pathToFileURL(join(PROXY, "boxToolResultEcho.ts")).href);
  const planMod = await import(pathToFileURL(join(PROXY, "boxToolResultPlan.ts")).href);
  const prepared = await import(pathToFileURL(join(PROXY, "boxPreparedContinuation.ts")).href);
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
    echoAccept: (id: string, hash: string, raw: unknown) => {
      const verifier = new resultEcho.BoxToolResultEcho([{ modelToolUseId: id,
        contentHash: hash, isError: false }]);
      verifier.accept(raw);
      verifier.assertComplete();
    },
    classify: prepared.classifyBoxContinuation,
    projectAuthority: prepared.projectAuthority,
    bindAuthority: prepared.authoritiesBind,
    bindIdentity: prepared.trustedIdentitiesBind,
    resumeMayPublish: prepared.resumeMayPublish,
    publishImage: (row) => {
      const cwd = publishDir;
      if (!PUBLISH_DIR.test(cwd) || !existsSync(cwd)) fail("IMAGE_PUBLISH_DIR");
      const plan = planMod.makeBoxToolResultPlan({ cwd,
        expected: { id: row.modelToolUseId, clientName: "Read", boxName: "mcp__ocbridge__t0",
          input: { file_path: "a.png" } },
        pending: { version: 1, modelToolUseId: row.modelToolUseId, mcpRequestId: 1,
          name: "t0", arguments: { file_path: "a.png" } },
        matched: row });
      if (plan.requests.length < 1) fail("IMAGE_PUBLISH_EMPTY");
      for (const request of plan.requests) {
        const ran = spawnSync(request.command, request.args, {
          cwd: request.cwd, env: request.environment, encoding: "utf8",
        });
        if (ran.status !== 0) fail(`IMAGE_PUBLISH_${ran.status ?? "SPAWN"}`);
      }
      return JSON.parse(readFileSync(plan.path, "utf8")) as PublishedFile;
    },
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
  proveImageCaption(api);
  provePrepared(api);
}

// prepared route, authority, and single publish
function provePrepared(api: Api): void {
  const currentBody = fx.chain[1] ?? {};
  if (api.gate(currentBody, true) !== null) fail("WRONG_ROUTE");
  if (api.classify(currentBody).classification !== "continuation_candidate") fail("WRONG_ROUTE");
  if (api.gate(fx.unknownText, true) !== "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION") fail("WRONG_ROUTE");
  const signed = api.projectAuthority("bridge_signed", "ab".repeat(16));
  const other = api.projectAuthority("bridge_signed", "cd".repeat(16));
  const legacy = api.projectAuthority("local_catalog", null);
  const broken = api.projectAuthority("bridge_signed", "short");
  const base = { uid: 3n, sessionId: "sess-prepared", canonicalModel: "box-api-claude-opus-5-5",
    turnKey: "ab".repeat(32), authority: signed };
  if (api.bindIdentity(base, { ...base, authority: other }).ok
    || api.bindIdentity(base, { ...base, authority: legacy }).ok
    || api.bindIdentity(base, { ...base, sessionId: "other-session" }).ok
    || broken.kind !== "malformed" || api.bindAuthority(broken, legacy).ok) {
    fail("AUTHORITY_BYPASS");
  }
  if (!api.bindIdentity(base, base).ok || !api.bindIdentity(
    { ...base, authority: legacy }, { ...base, authority: legacy }).ok) {
    fail("AUTHORITY_BYPASS");
  }
  let publishes = 0;
  for (const decision of [{ kind: "new_claim" }, { kind: "in_progress_or_unknown" }, { kind: "reject" }]) {
    if (!api.resumeMayPublish(decision)) continue;
    publishes += 1;
  }
  if (publishes !== 1) fail("DUPLICATE_PUBLISH");
}

async function provePublisher(): Promise<void> {
  const publishMod = await import(pathToFileURL(join(PROXY, "boxToolResumePublish.ts")).href);
  const hashMod = await import(pathToFileURL(join(PROXY, "boxToolInputHash.ts")).href);
  const nonce = publishDir.slice("/tmp/ocv5-289-run-".length);
  const id = "toolu_pub_once";
  const text = "b1-once";
  writeFileSync(`${publishDir}/pending.${id}.json`, JSON.stringify({
    version: 1, modelToolUseId: id, mcpRequestId: 3, name: "t0",
    arguments: { value: "ping" } }), { mode: 0o600 });
  const content = [{ type: "text", text }];
  const contentHash = createHash("sha256").update(JSON.stringify({ content, isError: false })).digest("hex");
  const canonicalBody = { model: "box-api-claude-opus-5-5", max_tokens: 64, stream: true,
    tools: [{ name: "local_echo", description: "synthetic",
      input_schema: { type: "object", properties: { value: { type: "string" } } } }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id, name: "local_echo", input: { value: "ping" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    ], metadata: { user_id: JSON.stringify({ session_id: "b1-publish", oc_turn_key: "a".repeat(64) }) } };
  let finishes = 0;
  const claim = { ownerRequestId: "box-owner", accountId: 20n, runNonce: nonce,
    leaseEpoch: "b".repeat(32), spoolOffset: 8, roundNo: 2, detachedRunnerHash: "c".repeat(64),
    catalogHash: "d".repeat(64), durableRevision: "b1-publish",
    toolUses: [{ id, boxName: "mcp__ocbridge__t0", clientName: "local_echo",
      inputHash: hashMod.hashBoxToolInput({ value: "ping" }) }],
    results: [{ modelToolUseId: id, content, isError: false, contentHash }] };
  const exec = { run: async (request: { command: string; args: string[]; cwd: string;
    environment?: Record<string, string> }) => {
    if (request.command !== "/usr/bin/python3") fail("DUPLICATE_PUBLISH");
    const ran = spawnSync(request.command, request.args, { cwd: request.cwd,
      env: { ...process.env, ...request.environment }, encoding: "utf8", timeout: 5000 });
    if (ran.status === 0 && request.args.some((arg) => typeof arg === "string" && arg.includes("os.link("))) {
      finishes += 1;
    }
    if (ran.status !== 0) fail("DUPLICATE_PUBLISH");
    return { stdout: ran.stdout ?? "", stderrBytes: Buffer.byteLength(ran.stderr ?? ""), exitCode: 0 as const };
  } };
  try {
    await publishMod.publishBoxToolResume({
      uid: 3n, sessionId: "b1-publish", requestId: "box-next", canonicalModel: canonicalBody.model,
      canonicalBody, upstreamModel: "claude-opus-5-5",
      url: "box-cli://messages", init: { method: "POST", body: JSON.stringify({ ...canonicalBody,
        model: "claude-opus-5-5" }) },
    }, { journal: { claimToolResume: async () => claim, markUnknown: async () => fail("DUPLICATE_PUBLISH"),
      decideToolResume: async () => ({ kind: "new_claim", claim }) },
      resolveTarget: async () => ({ accountId: 20n, exec }),
      retainUnknownTarget: () => fail("DUPLICATE_PUBLISH"),
      onUnknown: async () => fail("DUPLICATE_PUBLISH") });
  } catch {
    fail("DUPLICATE_PUBLISH");
  }
  const file = JSON.parse(readFileSync(`${publishDir}/result.${id}.json`, "utf8")) as {
    modelToolUseId?: string; content?: Array<{ text?: string }> };
  if (file.modelToolUseId !== id || file.content?.[0]?.text !== text) fail("DUPLICATE_PUBLISH");
  if (finishes !== 1) fail("DUPLICATE_PUBLISH");
}

function imageFixture(): { oracle: ImageOracle; png: string } {
  const raw = readFileSync(IMAGE_FILE);
  const oracle = JSON.parse(readFileSync(ORACLE_FILE, "utf8")) as ImageOracle;
  if (sha256(raw) !== SEALED_IMAGE_SHA || oracle.imageSha256 !== SEALED_IMAGE_SHA) fail("IMAGE_FIXTURE_SHA");
  if (oracle.caption !== SEALED_CAPTION || sha256(oracle.caption) !== SEALED_CAPTION_SHA
    || oracle.captionSha256 !== SEALED_CAPTION_SHA) fail("IMAGE_FIXTURE_CAPTION");
  if (oracle.id !== SEALED_ID || oracle.noteId !== SEALED_NOTE) fail("IMAGE_FIXTURE_ID");
  if (oracle.contentHash !== SEALED_CONTENT_HASH) fail("IMAGE_ORACLE_HASH");
  const png = raw.toString("base64");
  const locked = sha256(JSON.stringify({ content: [
    { type: "image", data: png, mimeType: "image/png" },
    { type: "text", text: SEALED_CAPTION },
  ], isError: false }));
  if (locked !== SEALED_CONTENT_HASH) fail("IMAGE_ORACLE_HASH");
  return { oracle, png };
}
function publishedEcho(file: PublishedFile): unknown {
  if (!Array.isArray(file.content)) fail("IMAGE_PUBLISHED_SHAPE");
  const content = file.content.map((part) => {
    if (part.type === "image") {
      return { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } };
    }
    if (part.type === "text") return { type: "text", text: part.text };
    return fail("IMAGE_PUBLISHED_SHAPE");
  });
  const block: Record<string, unknown> = { type: "tool_result", tool_use_id: file.modelToolUseId, content };
  if (file.isError === true) block.is_error = true;
  return { type: "user", message: { role: "user", content: [block] } };
}
function proveImageCaption(api: Api): void {
  const { oracle, png } = imageFixture();
  const caption = oracle.caption;
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: png } };
  const hook = "<system-reminder>\nPreToolUse:Read hook additional context: b1 figure.\n</system-reminder>";
  const base = { model: "box-api-claude-opus-5-5", stream: true, max_tokens: 64,
    tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
      { name: "Note", description: "note", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: "look" },
      { role: "assistant", content: [
        { type: "tool_use", id: SEALED_ID, name: "Read", input: { file_path: "a.png" } },
        { type: "tool_use", id: SEALED_NOTE, name: "Note", input: { file_path: "a.md" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: SEALED_ID, content: [image] },
        { type: "tool_result", tool_use_id: SEALED_NOTE, content: "note" },
        { type: "text", text: caption },
        { type: "text", text: hook },
      ] },
      { role: "system", content: [{ type: "text", text: "<total_tokens>12 tokens left</total_tokens>",
        cache_control: { type: "ephemeral" } }] },
    ] };
  const snapshot = JSON.stringify(base);
  if (api.gate(base, true) !== null) fail("IMAGE_GATE");
  const once = api.normalize(base);
  if (!isDeepStrictEqual(once, api.normalize(once as unknown as Record<string, unknown>))) fail("IMAGE_IDEMPOTENT");
  if (JSON.stringify(base) !== snapshot) fail("IMAGE_RAW");
  const encoded = JSON.stringify(once);
  if (encoded.split(caption).length - 1 !== 1
    || encoded.split(hook.replaceAll("\n", "\\n")).length - 1 !== 1) fail("IMAGE_COUNTS");
  if (encoded.includes("<total_tokens>")) fail("IMAGE_BUDGET");
  const user = (once.messages as Array<{ content: Array<Record<string, unknown>> }>).at(-1)!;
  const owned = user.content.find((part) => part.tool_use_id === SEALED_ID);
  const note = user.content.find((part) => part.tool_use_id === SEALED_NOTE);
  if (!owned || JSON.stringify(owned).split(caption).length - 1 !== 1) fail("IMAGE_OWNER");
  if (!note || JSON.stringify(note).includes(caption)) fail("IMAGE_NOT_LAST");
  const matched = api.match(base, [
    { id: SEALED_ID, clientName: "Read", boxName: "mcp__ocbridge__t0", input: { file_path: "a.png" } },
    { id: SEALED_NOTE, clientName: "Note", boxName: "mcp__ocbridge__t0", input: { file_path: "a.md" } },
  ]);
  const row = matched.find((item) => item.modelToolUseId === SEALED_ID) as PublishedMatch | undefined;
  if (!row || JSON.stringify(row.content) !== JSON.stringify([
    { type: "image", data: png, mimeType: "image/png" }, { type: "text", text: caption }])) {
    fail("IMAGE_MATCH_BYTES");
  }
  if (row.modelToolUseId !== SEALED_ID || !/^[a-f0-9]{64}$/.test(row.contentHash)) fail("IMAGE_MATCH_BYTES");
  const published = api.publishImage(row);
  api.echoAccept(SEALED_ID, SEALED_CONTENT_HASH, publishedEcho(published));
  if (JSON.stringify(published).split(caption).length - 1 !== 1) fail("IMAGE_PUBLISHED_CAPTION");
  if (published.modelToolUseId !== SEALED_ID) fail("IMAGE_PUBLISHED_ID");
  const stored = published.content?.find((part) => part.type === "image");
  if (!stored?.data || sha256(Buffer.from(stored.data, "base64")) !== SEALED_IMAGE_SHA) fail("IMAGE_PUBLISHED_SHA");
  expectCode(() => api.echoAccept(SEALED_ID, SEALED_CONTENT_HASH, { type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: SEALED_ID, content: [image] }] } }), "BOX_TOOL_ECHO_CONTENT_MISMATCH");
  const nudged = `${caption.slice(0, -2)}X]`;
  expectCode(() => api.echoAccept(SEALED_ID, SEALED_CONTENT_HASH, { type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: SEALED_ID,
    content: [image, { type: "text", text: nudged }] }] } }), "BOX_TOOL_ECHO_CONTENT_MISMATCH");
  const flipped = Buffer.from(png, "base64");
  flipped[flipped.length - 1] ^= 0xff;
  const flippedImage = { type: "image", source: { type: "base64", media_type: "image/png",
    data: flipped.toString("base64") } };
  if (api.gate({ ...base, messages: base.messages.map((message, index) => index === 2
    ? { ...message, content: [
      { type: "tool_result", tool_use_id: SEALED_ID, content: [flippedImage] },
      { type: "tool_result", tool_use_id: SEALED_NOTE, content: "note" },
      { type: "text", text: caption }, { type: "text", text: hook }] } : message) }, true) !== null) {
    fail("IMAGE_BYTE_STILL_CANONICAL");
  }
  expectCode(() => api.echoAccept(SEALED_ID, SEALED_CONTENT_HASH, { type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: SEALED_ID,
    content: [flippedImage, { type: "text", text: caption }] }] } }), "BOX_TOOL_ECHO_CONTENT_MISMATCH");
  expectCode(() => api.echoAccept(SEALED_ID, SEALED_CONTENT_HASH, { type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: SEALED_NOTE,
    content: [image, { type: "text", text: caption }] }] } }), "BOX_TOOL_ECHO_");
  const dropped = JSON.parse(snapshot) as typeof base;
  (dropped.messages[2] as { content: unknown[] }).content =
    (dropped.messages[2] as { content: unknown[] }).content.filter((part) =>
      !(part && typeof part === "object" && (part as { text?: string }).text === caption));
  if (encoded.split(caption).length - 1 === JSON.stringify(api.normalize(dropped)).split(caption).length - 1) {
    fail("IMAGE_DROPPED_STILL_PRESENT");
  }
  const oneByte = JSON.parse(snapshot) as typeof base;
  const sibling = ((oneByte.messages[2] as { content: Array<{ text?: string }> }).content)
    .find((part) => part.text === caption)!;
  sibling.text = nudged;
  if (api.gate(oneByte, true) === null) fail("IMAGE_ONE_BYTE_GATE");
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
function whitelist(dir: string, token: string, publish: string): NodeJS.ProcessEnv {
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
  env.OC_B1_PUBLISH_DIR = publish;
  env.OC_B1_WORKER_TOKEN = token;
  env.OC_B1_WORKER_TOKEN_FILE = join(dir, "token");
  return env;
}
function claimPublishDir(record: (dir: string) => void): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimed = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
    try {
      mkdirSync(claimed, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    record(claimed);
    return claimed;
  }
  fail("IMAGE_PUBLISH_CLAIM");
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
  let ownedRun = "";
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
  const publish = claimPublishDir((claimed) => { ownedRun = claimed; });
  const launch = workerLaunch(expectSha);
  const child = spawn(launch.cmd, launch.args, {
    cwd: CANDIDATE, env: whitelist(dir, token, publish), detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) fail("SUPERVISOR_SPAWN");
  worker = child.pid;
  const starttime = procField(worker, 19);
  process.stderr.write(`OC_B1_SUPERVISOR worker=${worker} pgid=${worker} starttime=${starttime} start=${started} scratch=${dir} publish=${publish}\n`);
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
  if (ownedRun && PUBLISH_DIR.test(ownedRun)) rmSync(ownedRun, { recursive: true, force: true });
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
  publishDir = process.env.OC_B1_PUBLISH_DIR ?? "";
  if (!PUBLISH_DIR.test(publishDir)) fail("IMAGE_PUBLISH_DIR");
  scratch = process.env.OC_B1_SCRATCH ?? "";
  if (!scratch) fail("WORKER_SCRATCH");
  isolate(scratch);
  if (process.env.OC_B1_PUBLISH_DIR !== undefined) fail("IMAGE_PUBLISH_DIR");
  installResolveHook();
  fx = await import("./check-v5-box-continuation-fixture.ts");
  const git = await gitCrossCheck(expectSha);
  const before = digest();
  const api = await load();
  const after = digest();
  if (!isDeepStrictEqual(before, after)) fail("MANIFEST_DRIFT_AFTER_LOAD");
  checks(api);
  await provePublisher();
  const end = digest();
  if (!isDeepStrictEqual(before, end)) fail("MANIFEST_DRIFT_FINAL");
  const runtime = before.filter((item) => item.path.startsWith(`packages${sep}commercial${sep}src${sep}http${sep}proxy${sep}`));
  process.stdout.write(`${JSON.stringify({
    ok: true, wired: true, receipt: RECEIPT, expectSha, candidate: CANDIDATE, git,
    runtimeModules: runtime.length, modules: before.length, digest: before,
    node: process.version, execPath: realpathSync(process.execPath),
    homeIsolated: process.env.HOME === join(scratch, "home"),
    database: process.env.DATABASE_URL !== undefined,
  })}\n`);
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
