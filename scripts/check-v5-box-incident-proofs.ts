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
import { realpathSync } from "node:fs";
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
  return { gate: gate.validateBoxRequest, classify: prepared.classifyBoxContinuation,
    match: matcher.matchBoxToolResults, fitForCli: images.normalizeBoxResultImagesForCli,
    echo: (expected) => new echo.BoxToolResultEcho(expected),
    decoder: (model, tools) => new handoff.BoxCliToolHandoffDecoder(model,
      catalog.compileBoxToolCatalog(tools, "natural")),
    pollSpool: poller.pollBoxSpoolLines,
    spoolAccess: () => access.makeBoxDetachedRunAccess({ runNonce: "a".repeat(24), detachedRunnerHash: "b".repeat(64) }),
    transportError: (code) => new transport.BoxExecTransportError(code, false) };
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
  return "[ocv5-302-result-rewrite-echo] PASS — a phone screenshot is published fitted and its echo binds byte for byte";
}

// INC-20261001-BOX-CLI-REJECTED-CALL-TURN-FAIL: the model called a tool name
// this Box invocation does not expose (bare Bash). Claude Code answered with
// its own <tool_use_error> and the model retried in a new message of the same
// run; the decoder rejected the first call with BOX_TOOL_ID_OR_NAME_INVALID
// and the turn failed. The client must see one continuing message and receive
// only the retried call, billed for both model calls.
function proveCliRejectedCall(api: Api): string {
  const model = "claude-opus-5-5";
  const boxName = "mcp__ocbridge__Bash";
  const tools = [{ name: "Bash", description: "Synthetic local tool",
    input_schema: { type: "object", properties: { value: { type: "string" } } } }];
  const event = (value: unknown) => ({ type: "stream_event", event: value });
  const init = { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] };
  const start = (id: string, input = 10, read = 0) => event({ type: "message_start", message: {
    id, model, role: "assistant", content: [],
    usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: read } } });
  const say = (id: string, index: number, value: string) => [
    event({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } }),
    { type: "assistant", message: { id, model, role: "assistant", content: [text(value)] } },
    event({ type: "content_block_stop", index })];
  const call = (id: string, index: number, toolId: string, name: string, prior: unknown[] = []) => [
    event({ type: "content_block_start", index, content_block: { type: "tool_use", id: toolId, name, input: {} } }),
    event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
    { type: "assistant", message: { id, model, role: "assistant",
      content: [...prior, { type: "tool_use", id: toolId, name, input: { value: "x" } }] } },
    event({ type: "content_block_stop", index })];
  const stop = (reason: string, output: number, input = 10) => [
    event({ type: "message_delta", delta: { stop_reason: reason }, usage: { input_tokens: input, output_tokens: output } }),
    event({ type: "message_stop" })];
  const cliError = (id: string, content = "<tool_use_error>Error: No such tool available: Bash</tool_use_error>") =>
    ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content }] },
      parent_tool_use_id: null, session_id: "12345678-1234-4123-8123-123456789abc" });
  const rejected = [start("msg_a"), ...say("msg_a", 0, "Let me run it."),
    ...call("msg_a", 1, "toolu_bad_1", "Bash", [text("Let me run it.")]), ...stop("tool_use", 7)];
  const retry = [start("msg_b", 30, 5), ...say("msg_b", 0, "Using the bridge."),
    ...call("msg_b", 1, "toolu_good_1", boxName, [text("Using the bridge.")]), ...stop("tool_use", 9, 30)];
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
  return "[ocv5-301-cli-rejected-call] PASS — a call the CLI rejects is retried inside one visible turn";
}

// INC-20261001-BOX-SPOOL-READ-TRANSIENT, live #2ee979cd: about 25 tool rounds
// into a long turn one exec request that reads the Box stdout spool was dropped
// at the network layer, and that single failed read ended the whole turn. The
// poller must read the same offset again and deliver the line; errors that say
// something about the account or the run itself are never retried.
async function proveSpoolReadTransient(api: Api): Promise<string> {
  const line = Buffer.from('{"type":"assistant"}\n', "utf8");
  const reply = (bytes: Buffer, offset: number) => ({ stdout: JSON.stringify({
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
    return reply(call === 3 ? line : Buffer.alloc(0), offset);
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
    proveImageCaption(api), await proveResultRewriteEcho(api), proveCliRejectedCall(api),
    await proveSpoolReadTransient(api)];
  clearTimeout(deadline);
  process.stdout.write(`${JSON.stringify({ ok: true, expectSha, candidate: CANDIDATE, proofs })}\n`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
