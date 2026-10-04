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
  match: (body: Body, expected: readonly Expected[]) => ReadonlyArray<{ modelToolUseId: string; content: unknown }>;
};

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
  return { gate: gate.validateBoxRequest, classify: prepared.classifyBoxContinuation,
    match: matcher.matchBoxToolResults };
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

async function main(): Promise<void> {
  const expectSha = parseArgs(process.argv);
  const deadline = setTimeout(() => {
    console.error("[box-incident-proofs] deadline exceeded");
    process.exit(1);
  }, LIMIT_MS);
  const api = await load();
  const proofs = [proveSkillContinuation(api), proveParallelSkillBodies(api), proveSkillBudgetTail(api),
    proveImageCaption(api)];
  clearTimeout(deadline);
  process.stdout.write(`${JSON.stringify({ ok: true, expectSha, candidate: CANDIDATE, proofs })}\n`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
