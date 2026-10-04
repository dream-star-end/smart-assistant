/** Release gate for Box incidents whose only evidence was unit tests.
 * deploy-v5.sh runs this file from the pinned candidate archive:
 *   tsx scripts/check-v5-box-incident-proofs.ts --expect-sha <40-hex>
 * Each proof sends the request shape recorded for one incident through the
 * product's own admission and matching entry points and requires the outcome
 * the user needed: the turn continues. Shapes that must stay rejected are
 * checked next to it. A proof names its incident in the receipt.
 * --expect-sha is the builder archive SHA; the archive has no .git, so it is
 * recorded in the receipt and not compared here.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const LIMIT_MS = 60_000;
const CANDIDATE = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const PROXY = join(CANDIDATE, "packages/commercial/src/http/proxy");
const LIVE_ONLY = "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION";

type Body = Record<string, unknown>;
type Expected = { id: string; boxName: string; clientName: string; input: Record<string, unknown> };
type Api = {
  gate: (body: Body, toolBridgeEnabled: boolean) => string | null;
  classify: (body: Body) => { classification: string; rejectCode: string | null; toolIds?: readonly string[] };
  match: (body: Body, expected: readonly Expected[]) => ReadonlyArray<Matched>;
  fitForCli: (results: readonly Matched[]) => Promise<readonly Matched[]>;
  echo: (expected: readonly EchoExpected[]) => { accept: (raw: unknown) => void;
    verifyDeferred: () => Promise<void>; assertComplete: () => void };
  decoder: (model: string, tools: unknown[]) => Decoder;
  pollSpool: (input: { exec: unknown; access: unknown; startOffset: number; deadlineMs: number;
    pollIntervalMs: number; retryDelaysMs?: readonly number[] }) => AsyncGenerator<{ text: string; endOffset: number }>;
  spoolAccess: () => unknown;
  transportError: (code: string) => Error;
  firstRound: (input: unknown, deps: unknown) => Promise<{ kind: string }>;
  textFetch: (deps: unknown) => { fetch: (input: unknown) => Promise<Response> };
  registry: () => { open: (input: { uid: bigint; sessionId: string; accountId: bigint }) => unknown;
    confirmRemoteStopped: (lease: unknown) => void };
  waitCapacity: (attempt: () => unknown, signal: AbortSignal, options?: { maxWaitMs?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number }) => Promise<unknown>;
  capacityWaitMs: number;
  published: (exec: unknown, cwd: string, expected: readonly EchoExpected[]) => Promise<readonly EchoExpected[]>;
  boxEndpoint: string;
  asset: (name: string) => Buffer;
  continuation: (input: unknown, deps: unknown) => Promise<{ kind: string }>;
  catalogHash: (tools: unknown[]) => string;
  observeText: (input: unknown) => Promise<{ proof: { reason: string }; message: unknown }>;
};
type Decoder = {
  push: (chunk: string) => { sse: string; candidate: { toolUses: ReadonlyArray<{ id: string; clientName: string }>;
    inputTokens: number; outputTokens: number; cacheReadTokens: number } | null; finalCandidate: unknown };
  completedMessage: () => { id?: unknown; content?: unknown };
  commitHandoff: (proof: { durableRevision: string; journaledToolUseIds: string[];
    verifiedPendingToolUseIds: string[] }) => string;
};
type Matched = { modelToolUseId: string; isError: boolean; contentHash: string;
  content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }> };
type EchoExpected = { modelToolUseId: string; isError: boolean; contentHash: string; content?: unknown };

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}
function parseArgs(argv: string[]): string {
  const args = argv.slice(2);
  if (args.length !== 2 || args[0] !== "--expect-sha" || !/^[0-9a-f]{40}$/.test(args[1] ?? "")) {
    fail("usage: check-v5-box-incident-proofs.ts --expect-sha <40-hex>");
  }
  return args[1]!;
}
async function load(): Promise<Api> {
  const gate = await import(pathToFileURL(join(PROXY, "boxRequestGate.ts")).href);
  const prepared = await import(pathToFileURL(join(PROXY, "boxPreparedContinuation.ts")).href);
  const matcher = await import(pathToFileURL(join(PROXY, "boxToolResultMatcher.ts")).href);
  const images = await import(pathToFileURL(join(PROXY, "boxToolResultImages.ts")).href);
  const echo = await import(pathToFileURL(join(PROXY, "boxToolResultEcho.ts")).href);
  const handoff = await import(pathToFileURL(join(PROXY, "boxCliToolHandoff.ts")).href);
  const catalog = await import(pathToFileURL(join(PROXY, "boxToolCatalog.ts")).href);
  const poller = await import(pathToFileURL(join(PROXY, "boxSpoolPoller.ts")).href);
  const access = await import(pathToFileURL(join(PROXY, "boxDetachedRunAccess.ts")).href);
  const transport = await import(pathToFileURL(join(PROXY, "boxExecTransport.ts")).href);
  const firstRound = await import(pathToFileURL(join(PROXY, "boxToolFirstRound.ts")).href);
  const textFetch = await import(pathToFileURL(join(PROXY, "boxTextFetch.ts")).href);
  const registry = await import(pathToFileURL(join(PROXY, "boxInvocationRegistry.ts")).href);
  const capacity = await import(pathToFileURL(join(PROXY, "boxCapacityWait.ts")).href);
  const published = await import(pathToFileURL(join(PROXY, "boxPublishedResults.ts")).href);
  const upstream = await import(pathToFileURL(join(PROXY, "upstream.ts")).href);
  const continuation = await import(pathToFileURL(join(PROXY, "boxToolContinuation.ts")).href);
  const observe = await import(pathToFileURL(join(PROXY, "boxDetachedTextObserve.ts")).href);
  return { gate: gate.validateBoxRequest, classify: prepared.classifyBoxContinuation,
    match: matcher.matchBoxToolResults, fitForCli: images.normalizeBoxResultImagesForCli,
    echo: (expected) => new echo.BoxToolResultEcho(expected),
    decoder: (model, tools) => new handoff.BoxCliToolHandoffDecoder(model,
      catalog.compileBoxToolCatalog(tools, "natural")),
    pollSpool: poller.pollBoxSpoolLines,
    spoolAccess: () => access.makeBoxDetachedRunAccess({ runNonce: "a".repeat(24), detachedRunnerHash: "b".repeat(64) }),
    transportError: (code) => new transport.BoxExecTransportError(code, false),
    firstRound: firstRound.runBoxToolFirstRound,
    textFetch: (deps) => new textFetch.BoxTextFetch(deps),
    registry: () => new registry.BoxInvocationRegistry({ maxPerUser: 1, maxPerAccount: 1, leaseMs: 600_000 }),
    waitCapacity: capacity.waitingForBoxCapacity, capacityWaitMs: capacity.BOX_CAPACITY_WAIT_MS,
    published: published.withPublishedBoxResults, boxEndpoint: upstream.BOX_INTERNAL_ENDPOINT,
    asset: (name) => readFileSync(join(CANDIDATE, "scripts/ocv5-289", name)),
    continuation: continuation.runBoxToolContinuation,
    catalogHash: (tools) => catalog.compileBoxToolCatalog(tools, "natural").bindingSha256,
    observeText: observe.observeBoxDetachedText };
}

const MODEL = "box-api-claude-opus-5-5";
const text = (value: string) => ({ type: "text", text: value });
const tool = (name: string) => ({ name, description: name, input_schema: { type: "object" } });
const skillUse = (id: string, name: string) => ({ type: "tool_use", id, name: "Skill", input: { skill: name } });
const launch = (id: string, name: string) => ({ type: "tool_result", tool_use_id: id,
  content: `Launching skill: ${name}` });
const skillBody = (name: string) =>
  `Base directory for this skill: /home/agent/.openclaude/skills/${name}\n\n# Title\nSteps.`;
const skillExpected = (id: string, name: string): Expected =>
  ({ id, boxName: "mcp__ocbridge__Skill", clientName: "Skill", input: { skill: name } });
const foldedContent = (name: string, ...bodies: string[]) =>
  [text(`Launching skill: ${name}`), ...bodies.map(text)];

/** The turn continues: admitted, classified as a continuation of exactly these
 * tool calls, and every Skill result carries its own body. */
function continues(api: Api, code: string, body: Body, ids: readonly string[],
  skills: ReadonlyArray<{ id: string; name: string }>, others: readonly Expected[] = []): void {
  const snapshot = JSON.stringify(body);
  const rejected = api.gate(body, true);
  if (rejected !== null) fail(`${code}_GATE_${rejected}`);
  const classified = api.classify(body);
  if (classified.classification !== "continuation_candidate") fail(`${code}_CLASS_${classified.rejectCode}`);
  if (!isDeepStrictEqual([...(classified.toolIds ?? [])], [...ids])) fail(`${code}_TOOL_IDS`);
  const matched = api.match(body, [...others, ...skills.map((skill) => skillExpected(skill.id, skill.name))]);
  for (const skill of skills) {
    const row = matched.find((item) => item.modelToolUseId === skill.id);
    if (!row || !isDeepStrictEqual(row.content, foldedContent(skill.name, skillBody(skill.name)))) {
      fail(`${code}_BODY_${skill.id}`);
    }
  }
  if (JSON.stringify(body) !== snapshot) fail(`${code}_RAW_MUTATED`);
}
/** Text that cannot be attributed to a launch is a new user request. */
function staysRejected(api: Api, code: string, body: Body, reject = LIVE_ONLY): void {
  if (api.gate(body, true) !== reject) fail(`${code}_ADMITTED`);
  if (api.classify(body).classification === "continuation_candidate") fail(`${code}_CLASSIFIED`);
}

// INC-20261001-BOX-SKILL-CONTINUATION, live #aacd65f7: the model called Skill,
// Claude Code answered "Launching skill: X" and appended the skill body as
// user text after the tool_result. The continuation was refused with 409.
function proveSkillContinuation(api: Api): string {
  const name = "deploy";
  const request = (...rest: unknown[]): Body => ({ model: MODEL, stream: true, max_tokens: 64,
    tools: [tool("Skill"), tool("Read")],
    messages: [{ role: "user", content: "deploy it" },
      { role: "assistant", content: [skillUse("toolu_skill", name)] }, ...rest] });
  const one = [{ id: "toolu_skill", name }];
  continues(api, "SKILL_SAME_MESSAGE", request({ role: "user",
    content: [launch("toolu_skill", name), text(skillBody(name))] }), ["toolu_skill"], one);
  continues(api, "SKILL_CACHED_BODY", request({ role: "user", content: [launch("toolu_skill", name),
    { ...text(skillBody(name)), cache_control: { type: "ephemeral" } }] }), ["toolu_skill"], one);
  continues(api, "SKILL_NEXT_MESSAGE", request({ role: "user", content: [launch("toolu_skill", name)] },
    { role: "user", content: skillBody(name) }), ["toolu_skill"], one);
  staysRejected(api, "SKILL_FAILED_LAUNCH", request({ role: "user",
    content: [{ ...launch("toolu_skill", name), content: "Skill failed" }, text(skillBody(name))] }));
  staysRejected(api, "SKILL_FOREIGN_RESULT", request({ role: "user",
    content: [launch("toolu_other", name), text(skillBody(name))] }));
  return "[ocv5-303-skill-continuation] PASS — a Skill launch with its injected body continues";
}

// INC-20261003-BOX-PARALLEL-SKILL-BODIES, live #72191544: two Skills in one
// step, one injected body per launch. Both bodies stayed in the tool-result
// message and the continuation was refused with 409.
function proveParallelSkillBodies(api: Api): string {
  const a = "v5-session-goal-start-triage";
  const b = "openclaude-instance-topology";
  const request = (...rest: unknown[]): Body => ({ model: MODEL, stream: true, max_tokens: 64,
    tools: [tool("Skill"), tool("Read")],
    messages: [{ role: "user", content: "deploy it" },
      { role: "assistant", content: [skillUse("toolu_a", a), skillUse("toolu_b", b)] }, ...rest] });
  const both = [{ id: "toolu_a", name: a }, { id: "toolu_b", name: b }];
  const ids = ["toolu_a", "toolu_b"];
  continues(api, "PARALLEL_INTERLEAVED", request({ role: "user", content: [launch("toolu_a", a),
    text(skillBody(a)), launch("toolu_b", b), text(skillBody(b))] }), ids, both);
  continues(api, "PARALLEL_RESULTS_FIRST", request({ role: "user", content: [launch("toolu_a", a),
    launch("toolu_b", b), text(skillBody(b)),
    { ...text(skillBody(a)), cache_control: { type: "ephemeral" } }] }), ids, both);
  continues(api, "PARALLEL_NEXT_MESSAGES", request(
    { role: "user", content: [launch("toolu_a", a), launch("toolu_b", b)] },
    { role: "user", content: skillBody(a) }, { role: "user", content: [text(skillBody(b))] }), ids, both);
  staysRejected(api, "PARALLEL_UNKNOWN_HEADER", request({ role: "user",
    content: [launch("toolu_a", a), launch("toolu_b", b), text(skillBody("other"))] }));
  staysRejected(api, "PARALLEL_TWO_BODIES_ONE_LAUNCH", request({ role: "user",
    content: [launch("toolu_a", a), launch("toolu_b", b), text(skillBody(a)), text(skillBody(a))] }));
  // A following message without a skill header is the user's own new request.
  const userTurn = request({ role: "user", content: [launch("toolu_a", a), launch("toolu_b", b)] },
    { role: "user", content: "and then deploy" });
  if (api.classify(userTurn).classification !== "fresh") fail("PARALLEL_REAL_USER_TURN_NOT_FRESH");
  return "[ocv5-314-parallel-skill-bodies] PASS — each parallel Skill body joins its own launch";
}

// INC-20261003-BOX-SKILL-BUDGET-TAIL, live #b6df9aee, Claude Code 2.1.280:
// after a Bash + Skill step CCB appends the <total_tokens> budget as a system
// message. The tail was stripped before the Skill body was folded, so every
// such step was refused with 409.
function proveSkillBudgetTail(api: Api): string {
  const a = "v5-session-goal-start-triage";
  const b = "openclaude-instance-topology";
  const budget = "<total_tokens>14999985 tokens left</total_tokens>";
  const bash = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: "echo a" } });
  const step = (bashId: string, skillId: string, name: string) => [
    { role: "assistant", content: [bash(bashId), skillUse(skillId, name)] },
    { role: "user", content: [{ tool_use_id: bashId, type: "tool_result", content: "a", is_error: false },
      launch(skillId, name), text(skillBody(name))] }];
  const request = (...rest: unknown[]): Body => ({ model: MODEL, stream: true, max_tokens: 64,
    tools: [tool("Skill"), tool("Read"), tool("Bash")],
    messages: [{ role: "user", content: [text("<system-reminder>\nctx\n</system-reminder>"), text("run")] },
      { role: "system", content: [text("# Environment\nYou have been invoked in the following environment:")] },
      ...rest] });
  const tail = { role: "system", content: [{ ...text(budget), cache_control: { type: "ephemeral" } }] };
  const bashExpected = (id: string): Expected =>
    ({ id, boxName: "mcp__ocbridge__Bash", clientName: "Bash", input: { command: "echo a" } });
  continues(api, "BUDGET_FIRST_STEP", request(...step("toolu_a1", "toolu_a2", a), tail),
    ["toolu_a1", "toolu_a2"], [{ id: "toolu_a2", name: a }], [bashExpected("toolu_a1")]);
  continues(api, "BUDGET_SECOND_STEP", request(...step("toolu_a1", "toolu_a2", a),
    { role: "system", content: budget }, ...step("toolu_b1", "toolu_b2", b), tail),
    ["toolu_b1", "toolu_b2"], [{ id: "toolu_b2", name: b }], [bashExpected("toolu_b1")]);
  const other = request(...step("toolu_a1", "toolu_a2", a),
    { role: "system", content: [text("do something else")] });
  if (api.gate(other, true) === null) fail("BUDGET_FOREIGN_SYSTEM_TAIL_ADMITTED");
  if (api.classify(other).classification === "continuation_candidate") fail("BUDGET_FOREIGN_SYSTEM_TAIL_CLASSIFIED");
  return "[ocv5-317-skill-budget-tail] PASS — a Skill step followed by the CCB budget tail continues";
}

/** A real solid-colour RGB PNG of the given pixel size. */
function png(width: number, height: number): string {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3, 0x60);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

// INC-20261001-BOX-CCB-IMAGE-META-CONTINUATION, live #f82c733f: the client Read
// a 1290x2796 phone screenshot; Claude Code showed it at 923x2000 and appended
// "[Image: original …, displayed at …]" after the tool_result, with its
// prompt-cache breakpoint on that caption. Only two observed sizes were
// accepted, so the continuation was refused with 409.
function proveImageCaption(api: Api): string {
  const shown = png(923, 2000);
  const caption = (ow: number, oh: number, dw: number, dh: number, scale = (ow / dw).toFixed(2)) =>
    `[Image: original ${ow}x${oh}, displayed at ${dw}x${dh}. Multiply coordinates by ${scale} to map to original image.]`;
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: shown } };
  const request = (tail: unknown[], next: unknown[] = []): Body => ({ model: MODEL, stream: true, max_tokens: 64,
    tools: [tool("Read")],
    messages: [{ role: "user", content: "看图" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_img", name: "Read",
        input: { file_path: "/a.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_img", content: [image] }, ...tail] },
      ...next] });
  const cached = (value: string, cache: unknown = { type: "ephemeral" }) => ({ ...text(value), cache_control: cache });
  const continuesWith = (code: string, body: Body, expected: string) => {
    const rejected = api.gate(body, true);
    if (rejected !== null) fail(`${code}_GATE_${rejected}`);
    const classified = api.classify(body);
    if (classified.classification !== "continuation_candidate") fail(`${code}_CLASS_${classified.rejectCode}`);
    const [row] = api.match(body, [{ id: "toolu_img", boxName: "mcp__ocbridge__Read", clientName: "Read",
      input: { file_path: "/a.png" } }]);
    if (!row || !isDeepStrictEqual(row.content,
      [{ type: "image", data: shown, mimeType: "image/png" }, text(expected)])) fail(`${code}_RESULT`);
  };
  // the live image with Claude Code's cache breakpoint on the caption
  continuesWith("IMAGE_LIVE_CACHED", request([cached(caption(1290, 2796, 923, 2000))]), caption(1290, 2796, 923, 2000));
  continuesWith("IMAGE_LIVE_CACHED_1H", request([cached(caption(1290, 2796, 923, 2000), { type: "ephemeral", ttl: "1h" })]),
    caption(1290, 2796, 923, 2000));
  // another phone size: proven by this image's own pixel size, not a size list
  continuesWith("IMAGE_OTHER_SIZE", request([text(caption(1179, 2556, 923, 2000))]), caption(1179, 2556, 923, 2000));
  // CCB sends the caption as its own cached user message
  continuesWith("IMAGE_SEPARATE_MESSAGE", request([], [{ role: "user",
    content: [cached(caption(1179, 2556, 923, 2000))] }]), caption(1179, 2556, 923, 2000));
  for (const [code, tail] of [
    ["IMAGE_WRONG_DISPLAY", [text(caption(1179, 2556, 900, 2000))]],
    ["IMAGE_FORGED_SCALE", [text(caption(1179, 2556, 923, 2000, "1.30"))]],
    ["IMAGE_WRONG_ASPECT", [text(caption(3000, 2000, 923, 2000))]],
    ["IMAGE_NOT_DOWNSCALED", [text(caption(923, 2000, 923, 2000))]],
    ["IMAGE_EXTRA_REQUEST", [text(caption(1179, 2556, 923, 2000)), text("also delete my files")]],
  ] as const) staysRejected(api, code, request([...tail]));
  staysRejected(api, "IMAGE_ODD_CACHE_KEY", request([cached(caption(1179, 2556, 923, 2000), { type: "persistent" })]),
    "BOX_CACHE_ANNOTATION_INVALID");
  return "[ocv5-302-image-caption] PASS — a resized Read image continues when the caption is proven by the image";
}

function pngSize(data: string): [number, number] {
  const bytes = Buffer.from(data, "base64");
  if (bytes.readUInt32BE(0) !== 0x89504e47) fail("NOT_A_PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
async function echoCode(run: () => Promise<void> | void): Promise<string> {
  try { await run(); } catch (error) { return String((error as { code?: unknown }).code ?? "THREW"); }
  return "ACCEPTED";
}

// INC-20261001-BOX-CLI-RESULT-REWRITE-ECHO, live #f82c733f: the client Read a
// 1290x2796 screenshot, the Box CLI resized it to 923x2000 before echoing it,
// the strict echo bind saw other bytes and the turn failed. OpenClaude now
// publishes the image already fitted to the CLI limits, so the CLI passes it
// through and the echo is byte-exact; the CLI's two text rewrites are accepted
// only when they are exact rewrites of what was published.
async function proveResultRewriteEcho(api: Api): Promise<string> {
  const original = png(1290, 2796);
  const body: Body = { model: MODEL, stream: true, max_tokens: 64, tools: [tool("Read")],
    messages: [{ role: "user", content: "看图" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_shot", name: "Read",
        input: { file_path: "/shot.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_shot", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: original } }] }] }] };
  if (api.gate(body, true) !== null) fail("REWRITE_GATE");
  const matched = api.match(body, [{ id: "toolu_shot", boxName: "mcp__ocbridge__Read", clientName: "Read",
    input: { file_path: "/shot.png" } }]);
  const [published] = await api.fitForCli(matched);
  const image = published?.content.find((block) => block.type === "image");
  if (!published || !image?.data) fail("REWRITE_NO_IMAGE");
  if (!isDeepStrictEqual(pngSize(image.data), [923, 2000])) fail("REWRITE_IMAGE_NOT_FITTED");
  if (published.contentHash === matched[0]!.contentHash) fail("REWRITE_HASH_NOT_RECOMPUTED");
  const again = await api.fitForCli([published]);
  if (again[0] !== published) fail("REWRITE_NOT_IDEMPOTENT");
  const echoed = (data: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result",
    tool_use_id: "toolu_shot", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }] } });
  const bind = (expected: EchoExpected, raw: unknown) => echoCode(async () => {
    const echo = api.echo([expected]);
    echo.accept(raw);
    await echo.verifyDeferred();
    echo.assertComplete();
  });
  // the CLI passes the fitted bytes through: the bind holds and the turn goes on
  if (await bind(published, echoed(image.data)) !== "ACCEPTED") fail("REWRITE_EXACT_ECHO_REFUSED");
  // any other picture of the same size is still refused
  if (await bind(published, echoed(png(923, 2000))) !== "BOX_TOOL_ECHO_CONTENT_MISMATCH") fail("REWRITE_OTHER_BYTES");
  const hash = (content: unknown) => createHash("sha256").update(JSON.stringify({ content, isError: false })).digest("hex");
  const textResult = (content: Array<{ type: "text"; text: string }>): EchoExpected =>
    ({ modelToolUseId: "toolu_shot", isError: false, contentHash: hash(content), content });
  const textEcho = (content: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result",
    tool_use_id: "toolu_shot", content }] } });
  const marker = "(mcp__ocbridge__Bash completed with no output)";
  if (await bind(textResult([{ type: "text", text: "" }]), textEcho(marker)) !== "ACCEPTED") fail("REWRITE_EMPTY_MARKER");
  if (await bind(textResult([{ type: "text", text: "data" }]), textEcho(marker)) !== "BOX_TOOL_ECHO_CONTENT_MISMATCH") {
    fail("REWRITE_MARKER_FOR_REAL_OUTPUT");
  }
  const skipped = api.echo([textResult([{ type: "text", text: "" }])]);
  skipped.accept(textEcho(marker));
  if (await echoCode(() => skipped.assertComplete()) !== "BOX_TOOL_ECHO_UNVERIFIED") fail("REWRITE_UNVERIFIED_COMPLETES");
  // text over Claude Code's 50k-char limit is echoed as its <persisted-output> preview of what was published
  const lines = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const big = [{ type: "text" as const, text: lines }];
  const size = (chars: number) => chars < 1024 * 1024 ? `${(chars / 1024).toFixed(1).replace(/\.0$/, "")}KB`
    : `${(chars / 1024 / 1024).toFixed(1).replace(/\.0$/, "")}MB`;
  const persisted = (content: Array<{ type: "text"; text: string }>, file = "toolu_shot.json") => {
    const source = JSON.stringify(content, null, 2);
    const newline = source.slice(0, 2000).lastIndexOf("\n");
    return `<persisted-output>\nOutput too large (${size(source.length)}). Full output saved to: `
      + `/home/box/.claude/projects/p/tool-results/${file}\n\nPreview (first 2KB):\n`
      + `${source.slice(0, newline > 1000 ? newline : 2000)}\n...\n</persisted-output>`;
  };
  if (await bind(textResult(big), textEcho(persisted(big))) !== "ACCEPTED") fail("REWRITE_PERSISTED_REFUSED");
  for (const [code, expected, raw] of [
    ["REWRITE_PERSISTED_ALTERED", textResult(big), persisted(big).replace("line 3 ", "line 9 ")],
    ["REWRITE_PERSISTED_OTHER_FILE", textResult(big), persisted(big, "other.json")],
    ["REWRITE_PERSISTED_OTHER_SIZE", textResult([{ type: "text", text: lines + "!".repeat(200_000) }]), persisted(big)],
    ["REWRITE_PERSISTED_BELOW_LIMIT", textResult([{ type: "text", text: lines.slice(0, 40_000) }]),
      persisted([{ type: "text", text: lines.slice(0, 40_000) }])],
  ] as const) {
    if (await bind(expected, textEcho(raw)) !== "BOX_TOOL_ECHO_CONTENT_MISMATCH") fail(code);
  }
  // recovery holds only the journaled hash; it reads the published result file back in chunks and
  // accepts it only when it hashes to the journal, after which the same rewrite is recognized
  const journaled: EchoExpected = { modelToolUseId: "toolu_shot", isError: false, contentHash: hash(big) };
  if (await bind(journaled, textEcho(persisted(big))) !== "BOX_TOOL_ECHO_CONTENT_MISMATCH") fail("REWRITE_HASH_ONLY_RELAXED");
  const runDir = `/tmp/ocv5-289-run-${"a".repeat(24)}`;
  const resultFile = (content: unknown, id = "toolu_shot") => {
    const file = Buffer.from(JSON.stringify({ version: 1, modelToolUseId: id, mcpRequestId: 3, content, isError: false }));
    const reads: number[] = [];
    return { reads, run: async (request: { args: string[] }) => {
      const offset = Number(request.args.at(-1));
      reads.push(offset);
      return { stdout: JSON.stringify({ size: file.length, b64: file.subarray(offset, offset + 700_000).toString("base64") }) };
    } };
  };
  const onBox = resultFile(big);
  const [recovered] = await api.published(onBox, runDir, [journaled]);
  if (!recovered || !isDeepStrictEqual(recovered.content, big)) fail("REWRITE_RECOVERY_NO_CONTENT");
  if (onBox.reads.length < 3 || onBox.reads[1] !== 700_000) fail("REWRITE_RECOVERY_NOT_CHUNKED");
  if (await bind(recovered, textEcho(persisted(big))) !== "ACCEPTED") fail("REWRITE_RECOVERY_REFUSED");
  for (const [code, exec, cwd] of [
    ["REWRITE_RECOVERY_ALTERED_FILE", resultFile([{ type: "text", text: `${lines}!` }]), runDir],
    ["REWRITE_RECOVERY_FOREIGN_FILE", resultFile(big, "toolu_other"), runDir],
    ["REWRITE_RECOVERY_FOREIGN_DIR", resultFile(big), "/tmp/elsewhere"],
  ] as const) {
    const [same] = await api.published(exec, cwd, [journaled]);
    if (same !== journaled) fail(code);
  }
  // the turn the user was in: the fitted image is published, the CLI echoes it unchanged and the model answers
  const turn = boxContinuation(api, [published], [echoed(image.data), ...FINAL_ANSWER]);
  const answered = await turn.round().catch((error: unknown) =>
    fail(`REWRITE_TURN_FAILED_${String((error as { code?: unknown }).code)}`));
  if (!endedWithAnswer(answered, turn)) fail("REWRITE_TURN_NO_ANSWER");
  const longTurn = boxContinuation(api, [textResult(big)], [textEcho(persisted(big)), ...FINAL_ANSWER]);
  if (!endedWithAnswer(await must("REWRITE_PERSISTED_TURN", longTurn.round()), longTurn)) fail("REWRITE_PERSISTED_TURN_NO_ANSWER");
  // an echo of other bytes still ends the round unknown rather than billing an unbound result
  const foreign = boxContinuation(api, [published], [echoed(png(923, 2000)), ...FINAL_ANSWER]);
  if (await codeOf(foreign.round) !== "BOX_TOOL_ECHO_CONTENT_MISMATCH"
    || !foreign.sequence.includes("unknown:continuation_unknown") || foreign.sequence.includes("complete")) {
    fail("REWRITE_FOREIGN_ECHO_SETTLED");
  }
  // the launched CLI is told not to truncate MCP results: the client already bounded them
  const launched = boxHost(api, spoolOf([cliInit, ...BRIDGE_CALL]));
  await must("REWRITE_LAUNCH", launched.round());
  if (!(Number(launched.launchEnvironment.MAX_MCP_OUTPUT_TOKENS) >= 4_000_000)) fail("REWRITE_CLI_TRUNCATION_ON");
  return "[ocv5-302-result-rewrite-echo] PASS — a phone screenshot is published fitted and its echo binds byte for byte";
}

// The CLI stream of a Box tool round, as the detached runner spools it.
const CLI_MODEL = "claude-opus-5-5";
const BOX_BASH = "mcp__ocbridge__Bash";
const CLI_TOOLS = [{ name: "Bash", description: "Synthetic local tool",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }];
const event = (value: unknown) => ({ type: "stream_event", event: value });
const cliInit = { type: "system", subtype: "init", tools: [BOX_BASH], mcp_servers: [{}] };
const start = (id: string, input = 10, read = 0) => event({ type: "message_start", message: {
  id, model: CLI_MODEL, role: "assistant", content: [],
  usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: read } } });
const say = (id: string, index: number, value: string) => [
  event({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } }),
  { type: "assistant", message: { id, model: CLI_MODEL, role: "assistant", content: [text(value)] } },
  event({ type: "content_block_stop", index })];
const call = (id: string, index: number, toolId: string, name: string, prior: unknown[] = []) => [
  event({ type: "content_block_start", index, content_block: { type: "tool_use", id: toolId, name, input: {} } }),
  event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
  { type: "assistant", message: { id, model: CLI_MODEL, role: "assistant",
    content: [...prior, { type: "tool_use", id: toolId, name, input: { value: "x" } }] } },
  event({ type: "content_block_stop", index })];
const stop = (reason: string, output: number, input = 10) => [
  event({ type: "message_delta", delta: { stop_reason: reason }, usage: { input_tokens: input, output_tokens: output } }),
  event({ type: "message_stop" })];
const cliError = (id: string, content = "<tool_use_error>Error: No such tool available: Bash</tool_use_error>") =>
  ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content }] },
    parent_tool_use_id: null, session_id: "12345678-1234-4123-8123-123456789abc" });
/** The model calls bare Bash, which this Box invocation does not expose. */
const REJECTED_CALL = [start("msg_a"), ...say("msg_a", 0, "Let me run it."),
  ...call("msg_a", 1, "toolu_bad_1", "Bash", [text("Let me run it.")]), ...stop("tool_use", 7)];
/** Its retry through the bridge, in a new message of the same run. */
const BRIDGE_CALL = [start("msg_b", 30, 5), ...say("msg_b", 0, "Using the bridge."),
  ...call("msg_b", 1, "toolu_good_1", BOX_BASH, [text("Using the bridge.")]), ...stop("tool_use", 9, 30)];
const spoolOf = (records: unknown[]) => Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(""));

type ExecRequest = { args: string[]; environment?: Record<string, string> };
type ExecReply = { stdout: string; stderrBytes: number; exitCode: 0 };
const reply = (stdout = ""): ExecReply => ({ stdout, stderrBytes: 0, exitCode: 0 });
const isRunner = (args: string[]) => args[0] === "-I" && args[1] === "-c"
  && args[2]?.includes("sys.argv=[p,*argv]") === true
  && args[3]?.startsWith("/tmp/ocv5-289-v2-detached-runner-") === true;
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The awaited product call must succeed; its failure is named after the proof step. */
const must = <T>(label: string, pending: Promise<T>): Promise<T> => pending.catch((error: unknown) =>
  fail(`${label}_${String((error as { code?: unknown }).code ?? (error as Error).message ?? "THREW")}`));
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try { await run(); } catch (error) {
    return String((error as { code?: unknown }).code ?? (error as Error).message ?? "THREW");
  }
  return "RETURNED";
}

/** A Box account as the product reaches it: the exec endpoint that stages the
 * assets, launches one detached CLI and serves its stdout spool, pending tool
 * files and terminal proof, plus the durable journal. `faults` let one call
 * fail the way the incident recorded it. The round under test is the
 * product's own runBoxToolFirstRound. */
function boxHost(api: Api, spool: Buffer, faults: {
  admit?: (call: number) => Promise<void> | void;
  spoolRead?: (call: number) => void;
  pendingRead?: (call: number) => void;
  proofRead?: (call: number) => void;
  capacityWaitMs?: number;
  signal?: AbortSignal } = {}) {
  const sequence: string[] = [];
  const emitted: string[] = [];
  const count = { admit: 0, launch: 0, spoolRead: 0, pendingRead: 0, proofRead: 0 };
  let nonce = "", epoch = "", controlHash = "", disposed = false;
  let launchEnvironment: Record<string, string> = {};
  const run = async (request: ExecRequest): Promise<ExecReply> => {
    const args = request.args;
    if (args[2]?.includes("identity['identityHash']")) {
      const manifest = { accountId: args[5], controlDev: "2049", controlId: args[6], controlIno: "9001",
        leaseEpoch: args[4], lockDev: "2049", lockIno: "9002", runNonce: args[3], version: 2 };
      controlHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
      return reply(`${JSON.stringify({ ...manifest, identityHash: controlHash })}\n`);
    }
    if (args[2]?.includes("def clean_dir(parent_path,name,allowed):")) return reply(`cleaned:${controlHash}\n`);
    if (isRunner(args) && args[5] !== "--read") {
      sequence.push("launch");
      count.launch++;
      launchEnvironment = { ...request.environment };
      return reply("launched\n");
    }
    if (isRunner(args)) {
      faults.spoolRead?.(++count.spoolRead);
      const offset = Number(args[7]);
      const bytes = spool.subarray(offset);
      return reply(JSON.stringify({ data: bytes.toString("base64"), offset: offset + bytes.length }));
    }
    if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("pending.")) {
      faults.pendingRead?.(++count.pendingRead);
      return reply(JSON.stringify({ version: 1, modelToolUseId: args[4], mcpRequestId: 7,
        name: "Bash", arguments: { value: "x" } }));
    }
    if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("terminal.json")) {
      faults.proofRead?.(++count.proofRead);
      return reply(`${JSON.stringify({ runNonce: nonce, leaseEpoch: epoch, keeperPid: 101, cliPid: 102,
        reason: "worker_complete", revision: 1 })}\n`);
    }
    if (args[2]?.includes("print('staged:'+str(len(steps)))")) {
      const steps = JSON.parse(Buffer.from(args[3]!, "base64").toString("utf8")) as unknown[];
      return reply(`staged:${steps.length}\n`);
    }
    if (args[0] === "-I" && args[1] === "-c" && args[3]?.startsWith("/tmp/ocv5-289-")
      && !args[3].startsWith("/tmp/ocv5-289-run-")) {
      sequence.push("stage");
      return reply(`${Array.from({ length: (args.length - 3) / 4 }, (_, i) => args[5 + i * 4]).join(",")}\n`);
    }
    return reply("ok\n");
  };
  const journal = {
    admit: async (identity: { runNonce: string; leaseEpoch: string }) => {
      await faults.admit?.(++count.admit);
      sequence.push("admit");
      nonce = identity.runNonce;
      epoch = identity.leaseEpoch;
    },
    recordPrelaunchControl: async () => {},
    armGuardedLaunch: async () => {},
    markGuardedPrestartStopped: async () => { sequence.push("prestart-stopped"); },
    markPrestartStopped: async () => { sequence.push("prestart-stopped"); },
    markUnknown: async (arg: { phase: string }) => { sequence.push(`unknown:${arg.phase}`); },
    recordToolHandoff: async (arg: { candidate: { toolUses: ReadonlyArray<{ id: string }> };
      verifiedPendingToolUseIds: string[] }) => {
      sequence.push("handoff");
      return { durableRevision: "rev-1", journaledToolUseIds: arg.candidate.toolUses.map((use) => use.id),
        verifiedPendingToolUseIds: arg.verifiedPendingToolUseIds };
    },
    complete: async () => { sequence.push("complete"); },
  };
  const body = { model: CLI_MODEL, max_tokens: 128, stream: true,
    messages: [{ role: "user", content: "run it" }], tools: CLI_TOOLS, tool_choice: { type: "auto" },
    metadata: { user_id: JSON.stringify({ session_id: "session-proof", oc_turn_key: "a".repeat(64) }) } };
  const round = () => api.firstRound({ uid: 3n, sessionId: "session-proof", requestId: "box-proof",
    canonicalModel: MODEL, canonicalBody: { ...body, model: MODEL }, upstreamModel: CLI_MODEL,
    url: api.boxEndpoint, init: { method: "POST", body: JSON.stringify(body),
      ...(faults.signal ? { signal: faults.signal } : {}) },
    emit: (sse: string) => { emitted.push(sse); } },
  { supervisorAsset: api.asset("box_supervisor.py"), keeperAsset: api.asset("box_keeper.py"),
    virtualMcpAsset: api.asset("box_virtual_mcp.py"), detachedRunnerAsset: api.asset("box_detached_runner.py"),
    toolAliasMode: "natural", journal, maxOutputTokensForModel: () => 128_000,
    ...(faults.capacityWaitMs === undefined ? {} : { capacityWaitMs: faults.capacityWaitMs }),
    resolveTarget: async () => ({ accountId: 20n, dispose: async () => { disposed = true; }, exec: { run } }),
    onUnknown: async () => {}, retainUnknownTarget: () => { sequence.push("retain-unknown"); },
    retainCleanupTarget: () => {} });
  return { round, sequence, count, sse: () => emitted.join(""),
    get disposed() { return disposed; }, get launchEnvironment() { return launchEnvironment; } };
}

/** Round N of a Box turn: the client's tool results were published to the
 * waiting CLI, which echoes them and lets the model go on. `results` is what
 * OpenClaude published; `records` is what the CLI then wrote to its spool. The
 * round under test is the product's own runBoxToolContinuation. */
function boxContinuation(api: Api, results: readonly EchoExpected[], records: unknown[], faults: {
  spoolRead?: (call: number) => void;
  pendingRead?: (call: number) => void;
  proofRead?: (call: number) => void } = {}) {
  const sequence: string[] = [];
  const emitted: string[] = [];
  const count = { spoolRead: 0, pendingRead: 0, proofRead: 0 };
  const offsets: number[] = [];
  const claim = { ownerRequestId: "box-owner", accountId: 20n, runNonce: "a".repeat(24),
    leaseEpoch: "b".repeat(32), spoolOffset: 1234, roundNo: 2, detachedRunnerHash: "b".repeat(64),
    catalogHash: api.catalogHash(CLI_TOOLS), durableRevision: "rev-1", results,
    toolUses: results.map((result) => ({ id: result.modelToolUseId, boxName: BOX_BASH, clientName: "Bash",
      inputHash: "f".repeat(64) })) };
  const bytes = spoolOf(records);
  const run = async (request: ExecRequest): Promise<ExecReply> => {
    const args = request.args;
    if (args[5] === "--read") {
      const offset = Number(args[7]);
      offsets.push(offset);
      faults.spoolRead?.(++count.spoolRead);
      const part = bytes.subarray(Math.max(0, offset - claim.spoolOffset), Math.max(0, offset - claim.spoolOffset) + 65536);
      return reply(JSON.stringify({ offset: offset + part.length, data: part.toString("base64") }));
    }
    if (args[2]?.includes("pending.")) {
      faults.pendingRead?.(++count.pendingRead);
      return reply(JSON.stringify({ version: 1, modelToolUseId: args[4], mcpRequestId: 7,
        name: "Bash", arguments: { value: "x" } }));
    }
    faults.proofRead?.(++count.proofRead);
    return reply(`${JSON.stringify({ runNonce: claim.runNonce, leaseEpoch: claim.leaseEpoch, keeperPid: 101,
      cliPid: 102, reason: "worker_complete", revision: 1 })}\n`);
  };
  const journal = {
    recordToolHandoff: async (arg: { candidate: { toolUses: ReadonlyArray<{ id: string }> };
      verifiedPendingToolUseIds: string[] }) => {
      sequence.push("handoff");
      return { durableRevision: "rev-2", journaledToolUseIds: arg.candidate.toolUses.map((use) => use.id),
        verifiedPendingToolUseIds: arg.verifiedPendingToolUseIds };
    },
    completeToolChain: async () => { sequence.push("complete"); },
    markUnknown: async (arg: { phase: string }) => { sequence.push(`unknown:${arg.phase}`); } };
  const round = () => api.continuation({ published: { claim, target: { accountId: 20n, exec: { run } },
    access: api.spoolAccess() }, uid: 3n, requestId: "box-next",
  canonicalBody: { model: MODEL, max_tokens: 128, stream: true, tools: CLI_TOOLS,
    messages: [{ role: "user", content: "run it" }] }, upstreamModel: CLI_MODEL,
  emit: (sse: string) => { emitted.push(sse); } },
  { journal, retainUnknownTarget: () => { sequence.push("retain-unknown"); }, onUnknown: async () => {} });
  return { round, sequence, count, offsets, sse: () => emitted.join("") };
}
/** The model's closing answer and the CLI's result record. */
const FINAL_ANSWER = [start("msg_final"), ...say("msg_final", 0, "done"), ...stop("end_turn", 4),
  { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 4 } }];
const echoOf = (id: string, content: unknown) => ({ type: "user", message: { role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }] } });
const publishedText = (id: string, value: string): EchoExpected => ({ modelToolUseId: id, isError: false,
  content: [text(value)], contentHash: createHash("sha256")
    .update(JSON.stringify({ content: [text(value)], isError: false })).digest("hex") });
/** The user-visible end of a continued turn: the answer arrived, usage was
 * settled once and nothing was left unknown. */
function endedWithAnswer(result: { kind: string }, round: ReturnType<typeof boxContinuation>): boolean {
  return result.kind === "final" && round.sse().includes("done")
    && (round.sse().match(/event: message_stop/g) ?? []).length === 1
    && isDeepStrictEqual(round.sequence, ["complete"]);
}

const TEXT_MODEL = "claude-opus-5";
const TEXT_USAGE = { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 20 };
/** A no-tool Box text round as the CLI spools it. */
const TEXT_ANSWER = [{ type: "system", subtype: "init", tools: [], mcp_servers: [] },
  event({ type: "message_start", message: { id: "msg_text", model: TEXT_MODEL, role: "assistant", content: [],
    usage: { ...TEXT_USAGE, output_tokens: 0 } } }),
  event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
  { type: "assistant", message: { id: "msg_text", model: TEXT_MODEL, role: "assistant", content: [text("answer")] } },
  event({ type: "content_block_stop", index: 1 }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: TEXT_USAGE }),
  event({ type: "message_stop" }),
  { type: "result", subtype: "success", is_error: false, usage: TEXT_USAGE }];
/** The text lane's Box account: BoxTextFetch with the product's own in-memory
 * lease registry, one CLI that answers "answer", its proof and cleanup. */
function boxTextHost(api: Api, capacityWaitMs: number) {
  const model = TEXT_MODEL;
  const body = { model, max_tokens: 256, stream: true,
    metadata: { user_id: JSON.stringify({ oc_turn_key: "a".repeat(64), session_id: "session-proof" }) },
    messages: [{ role: "user", content: "synthetic text only" }] };
  const output = spoolOf(TEXT_ANSWER).toString("utf8");
  const calls: string[] = [];
  let proofDir = "", leaseEpoch = "";
  const run = async (request: ExecRequest, options: { onStdout?: (chunk: string) => void }): Promise<ExecReply> => {
    const args = request.args;
    if (args[0] === "-I" && args[1]?.startsWith("/tmp/ocv5-289-v2-keeper-")) {
      calls.push("model");
      proofDir = args[args.indexOf("--proof-dir") + 1] ?? "";
      leaseEpoch = args[args.indexOf("--lease-epoch") + 1] ?? "";
      options.onStdout?.(output);
      return reply(output);
    }
    if (args[3]?.startsWith("/tmp/ocv5-289-v2-supervisor-") || args[3]?.startsWith("/tmp/ocv5-289-v2-keeper-")) {
      return reply(Array.from({ length: (args.length - 3) / 4 }, (_, i) => args[5 + i * 4]).join(","));
    }
    if (args[2]?.includes("print('staged:'+str(len(steps)))")) {
      const steps = JSON.parse(Buffer.from(args[3]!, "base64").toString("utf8")) as unknown[];
      return reply(`staged:${steps.length}\n`);
    }
    if (args[2]?.includes("print('clean')")) return reply("clean\n");
    if (args[2]?.includes("terminal.json")) {
      return reply(`${JSON.stringify({ runNonce: proofDir.slice(-24), leaseEpoch, keeperPid: 101, cliPid: 102,
        reason: "worker_complete", revision: 1 })}\n`);
    }
    return reply();
  };
  const registry = api.registry();
  const journal = { admit: async () => { calls.push("admit"); }, markRunning: async () => {},
    markPrestartStopped: async () => { calls.push("prestart-stopped"); }, markUnknown: async () => {},
    complete: async () => {} };
  const service = api.textFetch({ supervisorAsset: api.asset("box_supervisor.py"),
    keeperAsset: api.asset("box_keeper.py"), registry, journal,
    maxOutputTokensForModel: () => 128_000, resolveTarget: async () => ({ accountId: 20n, exec: { run } }),
    onUnknown: async () => {}, budgetMs: 600_000, capacityWaitMs });
  const fetch = (signal?: AbortSignal) => service.fetch({ uid: 3n, sessionId: "session-proof",
    requestId: "req-proof", canonicalModel: model, canonicalBody: body, upstreamModel: model,
    url: api.boxEndpoint, init: { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) } });
  return { fetch, registry, journal, calls };
}

// INC-20261001-BOX-CLI-REJECTED-CALL-TURN-FAIL: the model called a tool name
// this Box invocation does not expose (bare Bash). Claude Code answered with
// its own <tool_use_error> and the model retried in a new message of the same
// run; the decoder rejected the first call with BOX_TOOL_ID_OR_NAME_INVALID
// and the turn failed. The client must see one continuing message and receive
// only the retried call, billed for both model calls.
// The same incident: a message sent right after the previous turn of the
// session, which was still settling, was refused with BOX_CAPACITY_HELD
// ("消息未开始处理"). Admission waits up to 45s for the slot; a caller that left
// never gets a late admission, and one that commits anyway is prestart-closed.
async function proveCliRejectedCall(api: Api): Promise<string> {
  const model = CLI_MODEL;
  const boxName = BOX_BASH;
  const tools = CLI_TOOLS;
  const init = cliInit;
  const rejected = REJECTED_CALL;
  const retry = BRIDGE_CALL;
  const feed = (records: unknown[]) => {
    const decoder = api.decoder(model, tools);
    let sse = "";
    let last: ReturnType<Decoder["push"]> | null = null;
    for (const record of records) {
      last = decoder.push(`${JSON.stringify(record)}\n`);
      sse += last.sse;
      if (last.candidate || last.finalCandidate) break;
    }
    return { decoder, sse, last };
  };
  const failsWith = (records: unknown[]): string => {
    try { feed(records); } catch (error) { return String((error as { code?: unknown }).code ?? "THREW"); }
    return "ACCEPTED";
  };
  let run: ReturnType<typeof feed>;
  try { run = feed([init, ...rejected, cliError("toolu_bad_1"), ...retry]); } catch (error) {
    fail(`REJECTED_CALL_TURN_FAILED_${String((error as { code?: unknown }).code ?? "THREW")}`);
  }
  const candidate = run.last?.candidate;
  if (!candidate) fail("REJECTED_CALL_NO_HANDOFF");
  if ((run.sse.match(/event: message_start/g) ?? []).length !== 1) fail("REJECTED_CALL_SECOND_MESSAGE");
  if (run.sse.includes("toolu_bad_1")) fail("REJECTED_CALL_VISIBLE");
  if (!run.sse.includes("Let me run it.") || !run.sse.includes("Using the bridge.")) fail("REJECTED_CALL_TEXT_LOST");
  if (!isDeepStrictEqual(candidate.toolUses.map((use) => [use.id, use.clientName]), [["toolu_good_1", "Bash"]])) {
    fail("REJECTED_CALL_WRONG_HANDOFF");
  }
  if (!isDeepStrictEqual([candidate.inputTokens, candidate.outputTokens, candidate.cacheReadTokens], [40, 16, 5])) {
    fail("REJECTED_CALL_USAGE");
  }
  if (!isDeepStrictEqual(run.decoder.completedMessage().content, [text("Let me run it."), text("Using the bridge."),
    { type: "tool_use", id: "toolu_good_1", name: "Bash", input: { value: "x" } }])) fail("REJECTED_CALL_CONTENT");
  const held = run.decoder.commitHandoff({ durableRevision: "rev-1", journaledToolUseIds: ["toolu_good_1"],
    verifiedPendingToolUseIds: ["toolu_good_1"] });
  if (!held.includes('"name":"Bash"') || (held.match(/event: message_stop/g) ?? []).length !== 1) fail("REJECTED_CALL_HELD");
  // only Claude Code's own unknown-tool answer for that call is merged
  if (failsWith([init, ...rejected, ...retry]) !== "BOX_TOOL_CLI_ERROR_MISSING") fail("REJECTED_CALL_NO_CLI_ERROR");
  if (failsWith([init, ...rejected, cliError("toolu_bad_1", "ran fine")]) !== "BOX_TOOL_CLI_ERROR_INVALID") {
    fail("REJECTED_CALL_FREE_TEXT");
  }
  if (failsWith([init, ...rejected, cliError("toolu_other")]) !== "BOX_TOOL_CLI_ERROR_INVALID") fail("REJECTED_CALL_OTHER_ID");
  if (failsWith([init, start("msg_a"), ...call("msg_a", 0, "toolu_good", boxName),
    ...call("msg_a", 1, "toolu_bad_1", "Bash", [{ type: "tool_use", id: "toolu_good", name: boxName,
      input: { value: "x" } }])]) !== "BOX_TOOL_ID_OR_NAME_INVALID") fail("REJECTED_CALL_MIXED_MESSAGE");
  // the whole first round: launched once, the retry is handed off, nothing is left unknown
  const whole = boxHost(api, spoolOf([init, ...rejected, cliError("toolu_bad_1"), ...retry]));
  const handoff = await whole.round().catch((error: unknown) =>
    fail(`REJECTED_CALL_ROUND_FAILED_${String((error as { code?: unknown }).code ?? (error as Error).message)}`));
  if (handoff.kind !== "tool_handoff" || whole.count.launch !== 1) fail("REJECTED_CALL_ROUND_NO_HANDOFF");
  if ((whole.sse().match(/event: message_start/g) ?? []).length !== 1 || whole.sse().includes("toolu_bad_1")
    || !whole.sse().includes('"name":"Bash"') || !whole.sse().trimEnd().endsWith("}")
    || (whole.sse().match(/event: message_stop/g) ?? []).length !== 1) fail("REJECTED_CALL_ROUND_SSE");
  if (whole.sequence.some((step) => step.startsWith("unknown") || step === "retain-unknown")) {
    fail("REJECTED_CALL_ROUND_LEFT_UNKNOWN");
  }

  // the same collision in a later round of the turn
  const laterRound = boxContinuation(api, [publishedText("toolu_prior", "ok")],
    [echoOf("toolu_prior", "ok"), ...rejected, cliError("toolu_bad_1"), ...retry]);
  const laterHandoff = await laterRound.round().catch((error: unknown) =>
    fail(`REJECTED_CALL_CONTINUATION_FAILED_${String((error as { code?: unknown }).code)}`));
  if (laterHandoff.kind !== "tool_handoff" || !isDeepStrictEqual(laterRound.sequence, ["handoff"])
    || (laterRound.sse().match(/event: message_start/g) ?? []).length !== 1
    || laterRound.sse().includes("toolu_bad_1")) fail("REJECTED_CALL_CONTINUATION");

  // the next message while the previous turn still holds the slot
  const slotHeld = () => new Error("BOX_CAPACITY_HELD");
  const settling = boxHost(api, spoolOf([init, ...retry]), { admit: (n) => { if (n < 3) throw slotHeld(); } });
  const started = await settling.round().catch((error: unknown) =>
    fail(`CAPACITY_NOT_WAITED_${String((error as Error).message)}`));
  if (started.kind !== "tool_handoff" || settling.count.admit !== 3 || settling.count.launch !== 1) {
    fail("CAPACITY_WAIT_DID_NOT_START_TURN");
  }
  // bounded: a slot that stays held ends in the original rejection, nothing staged or launched
  const stuck = boxHost(api, spoolOf([init, ...retry]), { admit: () => { throw slotHeld(); }, capacityWaitMs: 900 });
  if (await codeOf(stuck.round) !== "BOX_CAPACITY_HELD") fail("CAPACITY_WAIT_REJECTION_CHANGED");
  if (stuck.count.admit < 2 || stuck.count.launch !== 0 || stuck.sequence.includes("stage") || !stuck.disposed) {
    fail("CAPACITY_WAIT_UNBOUNDED_OR_STAGED");
  }
  // the production window is 45s, with backoff, and returns the first rejection unchanged
  if (api.capacityWaitMs !== 45_000) fail("CAPACITY_WINDOW_NOT_45S");
  let clock = 0, attempts = 0;
  const first = slotHeld();
  const lasted = await api.waitCapacity(() => { attempts++; throw attempts === 1 ? first : slotHeld(); },
    new AbortController().signal, { now: () => clock, sleep: async (ms: number) => { clock += ms; } })
    .catch((error: unknown) => error);
  if (!(lasted instanceof Error) || lasted.message !== "BOX_CAPACITY_HELD") fail("CAPACITY_WINDOW_RESULT");
  if (clock > 45_000 || clock < 40_000 || attempts < 20) fail(`CAPACITY_WINDOW_${clock}_${attempts}`);
  let other = 0;
  await api.waitCapacity(() => { other++; throw new Error("BOX_JOURNAL_BASIS_INVALID"); },
    new AbortController().signal, { now: () => 0, sleep: async () => {} }).catch(() => {});
  if (other !== 1) fail("CAPACITY_WAIT_RETRIED_OTHER_FAILURE");
  // the caller leaves during the wait: no further admission attempt, no launch
  const leaving = new AbortController();
  const left = boxHost(api, spoolOf([init, ...retry]), { admit: () => { throw slotHeld(); }, signal: leaving.signal });
  const gone = codeOf(left.round);
  await tick(100);
  const attemptsAtAbort = left.count.admit;
  leaving.abort();
  if (await gone !== "BOX_TOOL_ABORTED" && await gone !== "BOX_CAPACITY_HELD") fail(`CAPACITY_ABORT_${await gone}`);
  await tick(700);
  if (left.count.admit !== attemptsAtAbort || left.count.launch !== 0) fail("CAPACITY_ADMITTED_AFTER_ABORT");
  // an admission still in flight when the caller left commits late: prestart-closed, never launched
  const lateAbort = new AbortController();
  let commit: () => void = () => {};
  const late = boxHost(api, spoolOf([init, ...retry]), { signal: lateAbort.signal,
    admit: () => new Promise<void>((resolve) => { commit = resolve; }) });
  const lateRound = codeOf(late.round);
  await tick(20);
  lateAbort.abort();
  if (await lateRound !== "BOX_TOOL_ABORTED") fail("CAPACITY_LATE_NOT_ABORTED");
  commit();
  await tick(20);
  if (!late.sequence.includes("prestart-stopped") || late.count.launch !== 0) fail("CAPACITY_LATE_ADMISSION_HELD");

  // the text lane: the session's previous turn frees its lease while the new message waits
  const waited = boxTextHost(api, 5_000);
  const previous = waited.registry.open({ uid: 3n, sessionId: "session-proof", accountId: 20n });
  setTimeout(() => waited.registry.confirmRemoteStopped(previous), 300);
  const response = await waited.fetch().catch((error: unknown) =>
    fail(`CAPACITY_TEXT_NOT_WAITED_${String((error as { code?: unknown }).code)}`));
  if (response.status !== 200 || !(await response.text()).includes("answer")) fail("CAPACITY_TEXT_NO_ANSWER");
  const busy = boxTextHost(api, 0);
  const holder = busy.registry.open({ uid: 3n, sessionId: "session-proof", accountId: 20n });
  if (await codeOf(() => busy.fetch()) !== "BOX_CAPACITY_HELD" || busy.calls.length !== 0) fail("CAPACITY_TEXT_NO_WAIT_CHANGED");
  busy.registry.confirmRemoteStopped(holder);
  const textAbort = new AbortController();
  const lateText = boxTextHost(api, 5_000);
  let commitText: () => void = () => {};
  lateText.journal.admit = () => new Promise<void>((resolve) => { commitText = () => { lateText.calls.push("admit"); resolve(); }; });
  const lateFetch = codeOf(() => lateText.fetch(textAbort.signal));
  await tick(50);
  textAbort.abort();
  await lateFetch;
  commitText();
  await tick(50);
  if (!isDeepStrictEqual(lateText.calls, ["admit", "prestart-stopped"])) fail(`CAPACITY_TEXT_LATE_${lateText.calls.join(",")}`);
  return "[ocv5-301-cli-rejected-call] PASS — a call the CLI rejects is retried inside one visible turn";
}

// INC-20261001-BOX-SPOOL-READ-TRANSIENT, live #2ee979cd: about 25 tool rounds
// into a long turn one exec request that reads the Box stdout spool was dropped
// at the network layer, and that single failed read ended the whole turn. The
// poller must read the same offset again and deliver the line; errors that say
// something about the account or the run itself are never retried.
async function proveSpoolReadTransient(api: Api): Promise<string> {
  const line = Buffer.from('{"type":"assistant"}\n', "utf8");
  const chunk = (bytes: Buffer, offset: number) => ({ stdout: JSON.stringify({
    data: bytes.toString("base64"), offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 as const });
  const poll = (run: (offset: number, call: number) => unknown) => {
    const offsets: number[] = [];
    const exec = { run: async (request: { args: string[] }) => {
      const offset = Number(request.args[7]);
      offsets.push(offset);
      return run(offset, offsets.length);
    } };
    return { offsets, lines: api.pollSpool({ exec, access: api.spoolAccess(), startOffset: 7,
      deadlineMs: 5000, pollIntervalMs: 1, retryDelaysMs: [1, 1] }) };
  };
  const dropped = poll((offset, call) => {
    if (call === 1) throw api.transportError("BOX_EXEC_TRANSPORT_UNKNOWN");
    if (call === 2) throw api.transportError("BOX_EXEC_HTTP_502");
    return chunk(call === 3 ? line : Buffer.alloc(0), offset);
  });
  let first: IteratorResult<{ text: string; endOffset: number }>;
  try { first = await dropped.lines.next(); } catch (error) {
    fail(`SPOOL_DROPPED_READ_ENDED_TURN_${String((error as { code?: unknown }).code ?? "THREW")}`);
  }
  await dropped.lines.return(undefined);
  if (first.value?.text !== line.toString("utf8") || first.value.endOffset !== 7 + line.length) fail("SPOOL_LINE_LOST");
  if (!isDeepStrictEqual(dropped.offsets, [7, 7, 7])) fail("SPOOL_OFFSET_MOVED");
  const surfaces = async (code: string, expectCalls: number, label: string) => {
    const run = poll(() => { throw api.transportError(code); });
    const seen = await echoCode(async () => { await run.lines.next(); });
    if (seen !== code) fail(`${label}_${seen}`);
    if (run.offsets.length !== expectCalls) fail(`${label}_CALLS_${run.offsets.length}`);
  };
  await surfaces("BOX_EXEC_ACCOUNT_GUARD_FAILED", 1, "SPOOL_ACCOUNT_GUARD_RETRIED");
  await surfaces("BOX_EXEC_TRANSPORT_UNKNOWN", 3, "SPOOL_RETRY_UNBOUNDED");
  // the incident path: a later round of a long turn polls the spool and one read is dropped
  const drop = (call: number) => { if (call === 1) throw api.transportError("BOX_EXEC_TRANSPORT_UNKNOWN"); };
  const prior = publishedText("toolu_prior", "round 25");
  const closing = [echoOf("toolu_prior", "round 25"), ...FINAL_ANSWER];
  const cut = boxContinuation(api, [prior], closing, { spoolRead: drop });
  const ended = await cut.round().catch((error: unknown) =>
    fail(`SPOOL_CONTINUATION_ENDED_TURN_${String((error as { code?: unknown }).code)}`));
  if (!endedWithAnswer(ended, cut)) fail("SPOOL_CONTINUATION_NO_ANSWER");
  if (cut.offsets[0] !== 1234 || cut.offsets[1] !== 1234) fail("SPOOL_CONTINUATION_OFFSET_MOVED");
  // the terminal-proof read and the pending-call read of that round ride out the same drop
  const proofCut = boxContinuation(api, [prior], closing, { proofRead: drop });
  if (!endedWithAnswer(await must("SPOOL_PROOF_READ", proofCut.round()), proofCut) || proofCut.count.proofRead !== 2) fail("SPOOL_PROOF_READ");
  const pendingCut = boxContinuation(api, [prior], [echoOf("toolu_prior", "round 25"), ...BRIDGE_CALL],
    { pendingRead: drop });
  if ((await must("SPOOL_PENDING_READ", pendingCut.round())).kind !== "tool_handoff" || pendingCut.count.pendingRead !== 2
    || !isDeepStrictEqual(pendingCut.sequence, ["handoff"])) fail("SPOOL_PENDING_READ");
  // an error about the account itself still ends the round, unsettled
  const guarded = boxContinuation(api, [prior], closing,
    { spoolRead: () => { throw api.transportError("BOX_EXEC_ACCOUNT_GUARD_FAILED"); } });
  if (await codeOf(guarded.round) !== "BOX_EXEC_ACCOUNT_GUARD_FAILED" || guarded.count.spoolRead !== 1
    || guarded.sequence.includes("complete")) fail("SPOOL_ACCOUNT_GUARD_CONTINUED");
  // the first round of a turn reads through the same loops
  const firstHandoff = boxHost(api, spoolOf([cliInit, ...BRIDGE_CALL]), { spoolRead: drop, pendingRead: drop });
  if ((await must("SPOOL_FIRST_ROUND_HANDOFF", firstHandoff.round())).kind !== "tool_handoff" || firstHandoff.count.pendingRead !== 2) fail("SPOOL_FIRST_ROUND_HANDOFF");
  const firstFinal = boxHost(api, spoolOf([cliInit, ...FINAL_ANSWER]), { proofRead: drop });
  if ((await must("SPOOL_FIRST_ROUND_FINAL", firstFinal.round())).kind !== "final" || firstFinal.count.proofRead !== 2
    || !firstFinal.sequence.includes("complete")) fail("SPOOL_FIRST_ROUND_FINAL");
  // and so does a detached text round
  const textSpool = spoolOf(TEXT_ANSWER);
  let textProofReads = 0;
  const observed = await api.observeText({ access: api.spoolAccess(), expectedModel: TEXT_MODEL,
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), deadlineMs: 30_000,
    target: { accountId: 20n, exec: { run: async (request: ExecRequest) => {
      if (request.args[5] === "--read") {
        const offset = Number(request.args[7]);
        return reply(JSON.stringify({ data: textSpool.subarray(offset).toString("base64"), offset: Math.max(offset, textSpool.length) }));
      }
      drop(++textProofReads);
      return reply(`${JSON.stringify({ runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), keeperPid: 101,
        cliPid: 102, reason: "worker_complete", revision: 1 })}\n`);
    } } } }).catch((error: unknown) => fail(`SPOOL_TEXT_ROUND_${String((error as { code?: unknown }).code)}`));
  if (observed.proof.reason !== "worker_complete" || textProofReads !== 2) fail("SPOOL_TEXT_PROOF_READ");
  return "[ocv5-306-spool-read-transient] PASS — a dropped spool read is read again at the same offset";
}

async function main(): Promise<void> {
  const expectSha = parseArgs(process.argv);
  const deadline = setTimeout(() => {
    console.error("[box-incident-proofs] deadline exceeded");
    process.exit(1);
  }, LIMIT_MS);
  const api = await load();
  const proofs = [proveSkillContinuation(api), proveParallelSkillBodies(api), proveSkillBudgetTail(api),
    proveImageCaption(api), await proveResultRewriteEcho(api), await proveCliRejectedCall(api),
    await proveSpoolReadTransient(api)];
  clearTimeout(deadline);
  process.stdout.write(`${JSON.stringify({ ok: true, expectSha, candidate: CANDIDATE, proofs })}\n`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
