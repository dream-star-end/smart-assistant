// Box incident proofs moved out of scripts/check-v5-box-incident-proofs.ts to keep it inside the file-size
// ratchet (OCV5-509; same split as scripts/lib/boxPendingUserProof.ts). Bodies are unchanged; what they used
// from that file is passed in.
import { isDeepStrictEqual } from "node:util";

type Body = Record<string, unknown>;
const MODEL = "box-api-claude-opus-5-5";
const text = (value: string) => ({ type: "text", text: value });
const tool = (name: string) => ({ name, description: name, input_schema: { type: "object" } });

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}

type Host = { round: () => Promise<{ kind: string }>; count: { launch: number }; handoffs: unknown[]; sse: () => string };
export type CliRepairKit = {
  boxHost: (spool: Buffer, faults?: { pendingArguments?: unknown }) => Host;
  spoolOf: (records: unknown[]) => Buffer;
  cliInit: unknown;
  start: (id: string) => unknown;
  event: (value: unknown) => unknown;
  stop: (reason: string, output: number) => unknown[];
  BOX_BASH: string;
  CLI_MODEL: string;
  must: <T>(label: string, pending: Promise<T>) => Promise<T>;
  codeOf: (run: () => Promise<unknown>) => Promise<string>;
};

/** INC-20261018-BOX-CLI-REPAIRED-TOOL-INPUT, commercial u4 webmvdqhzdqcghrvm (2026-10-18 11:27–12:34Z): every round
 * in which the model wrote its verification script failed at message_stop as BOX_TOOL_SNAPSHOT_MISMATCH, and each
 * re-read of it as 503 BOX_REPLAY_UNAVAILABLE, so the automatic recovery ran the same ten-minute call again and
 * again. Claude Code (2.1.299–2.1.302, MCP tools too) records and runs a streamed tool input after its own repair: a
 * literal `\uXXXX` such as a script's `[一-鿿]` becomes the character. The round must hand off the model's
 * own call; a record that differs in any other way is still refused. */
export async function proveCliRepairedToolInput(kit: CliRepairKit): Promise<string> {
  const { boxHost, spoolOf, cliInit, start, event, stop, BOX_BASH, CLI_MODEL, must, codeOf } = kit;
  const model = { value: "re.findall(r'[\\u4e00-\\u9fff]+', title)" };
  const repaired = { value: "re.findall(r'[一-鿿]+', title)" };
  const call = (recorded: unknown) => [start("msg_cjk"),
    event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_cjk_1", name: BOX_BASH, input: {} } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(model) } }),
    { type: "assistant", message: { id: "msg_cjk", model: CLI_MODEL, role: "assistant",
      content: [{ type: "tool_use", id: "toolu_cjk_1", name: BOX_BASH, input: recorded }] } },
    event({ type: "content_block_stop", index: 0 }), ...stop("tool_use", 9)];
  const host = boxHost(spoolOf([cliInit, ...call(repaired)]), { pendingArguments: repaired });
  const handed = await must("CLI_REPAIRED_ROUND", host.round());
  if (handed.kind !== "tool_handoff" || host.count.launch !== 1) fail(`CLI_REPAIRED_NO_HANDOFF_${handed.kind}`);
  const use = (host.handoffs.at(-1) as { toolUses: Array<{ input: unknown; cliInput?: unknown }> }).toolUses[0];
  if (!isDeepStrictEqual(use?.input, model) || !isDeepStrictEqual(use?.cliInput, repaired)) fail("CLI_REPAIRED_WRONG_INPUT");
  // the client runs what the model wrote
  if (!host.sse().includes(JSON.stringify(JSON.stringify(model)).slice(1, -1))) fail("CLI_REPAIRED_CLIENT_INPUT");
  const changed = boxHost(spoolOf([cliInit, ...call({ value: "re.findall(r'[a-z]+', title)" })]));
  if (await codeOf(changed.round) !== "BOX_TOOL_SNAPSHOT_MISMATCH") fail("CLI_REPAIRED_OTHER_CHANGE_ACCEPTED");
  return "[ocv5-509-cli-repaired-tool-input] PASS — a tool call the CLI records and runs unicode-repaired hands off the model's own input, and any other difference is still refused";
}

export type ForeignApi = {
  gate: (body: Body, toolBridgeEnabled: boolean) => string | null;
  classify: (body: Body) => { classification: string };
  compile: (body: Body) => { snapshotJsonl: string };
};

/** INC-20261008-BOX-FOREIGN-TOOL-HISTORY, commercial u1870 10:28 CST: the session had run k3-256k, whose tool calls
 * carry ids like `tool_…`. Switched to box-api-claude-opus-5-5, every request was refused before launch with 400
 * BOX_REQUEST_UNSUPPORTED (BOX_BLOCK_UNSUPPORTED). History from another model is admitted with its tool calls renamed
 * pair by pair; a live tool exchange keeps the strict Box ids. */
export function proveForeignToolHistory(api: ForeignApi): string {
  const history = (current: unknown): Body => ({ model: MODEL, stream: true, max_tokens: 64, tools: [tool("Bash"), tool("Read")],
    messages: [{ role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "k3-signature" },
        { type: "tool_use", id: "tool_Ab12Cd34Ef56", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_Ab12Cd34Ef56", content: "a" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "Read", input: { file_path: "/a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "A" }] },
      { role: "assistant", content: [text("done")] }, current] });
  const admitted = api.gate(history({ role: "user", content: "now continue with Claude" }), true);
  if (admitted !== null) fail(`FOREIGN_HISTORY_GATE_${admitted}`);
  // what the Box CLI is given: the same history, each call paired under one stable toolu_ id
  const staged = api.compile(history({ role: "user", content: "now continue with Claude" })).snapshotJsonl;
  const again = api.compile(history({ role: "user", content: "now continue with Claude" })).snapshotJsonl;
  const ids = staged.match(/toolu_oc[0-9a-f]{32}/g) ?? [];
  if (ids.length !== 4 || new Set(ids).size !== 2 || staged.includes("tool_Ab12Cd34Ef56") || staged.includes("call_9")
    || !isDeepStrictEqual(again.match(/toolu_oc[0-9a-f]{32}/g), ids)) fail(`FOREIGN_HISTORY_STAGED_${ids.length}`);
  // a pure Box history is staged byte for byte as before
  const box = api.compile({ model: MODEL, stream: true, max_tokens: 64, tools: [tool("Bash")], messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_keep_1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_keep_1", content: "x" }] },
    { role: "assistant", content: [text("ok")] }, { role: "user", content: "next" }] }).snapshotJsonl;
  if (!box.includes('"toolu_keep_1"') || box.includes("toolu_oc")) fail("FOREIGN_HISTORY_BOX_CHANGED");
  const classified = api.classify(history({ role: "user", content: "now continue with Claude" }));
  if (classified.classification !== "fresh") fail(`FOREIGN_HISTORY_CLASS_${classified.classification}`);
  // a current tool result under a foreign id is no live Box exchange and stays refused
  const live: Body = { model: MODEL, stream: true, max_tokens: 64, tools: [tool("Bash")], messages: [
    { role: "user", content: "run" },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] }] };
  if (api.gate(live, true) === null || api.classify(live).classification === "continuation_candidate") fail("FOREIGN_LIVE_ADMITTED");
  return "[ocv5-337-foreign-tool-history] PASS — tool history from another model is admitted and staged under paired Box tool ids";
}

/** OCV5-509 replay rejection: a Box run whose CLI record of the call is not the streamed one. */
export function misrecordedRun(h: { call: (id: string, index: number, toolId: string, name: string, prior?: unknown[]) => unknown[];
  cliInit: unknown; start: (id: string, input?: number, read?: number) => unknown;
  say: (id: string, index: number, value: string) => unknown[]; stop: (reason: string, output: number, input?: number) => unknown[];
  BOX_BASH: string; CLI_MODEL: string }): unknown[] {
  const misrecorded = h.call("msg_b", 1, "toolu_good_1", h.BOX_BASH, [text("Using the bridge.")]).map((record) =>
    (record as { type?: string }).type === "assistant" ? { type: "assistant", message: { id: "msg_b", model: h.CLI_MODEL,
      role: "assistant", content: [text("Using the bridge."), { type: "tool_use", id: "toolu_good_1", name: h.BOX_BASH,
        input: { value: "y" } }] } } : record);
  return [h.cliInit, h.start("msg_b", 30, 5), ...h.say("msg_b", 0, "Using the bridge."), ...misrecorded,
    ...h.stop("tool_use", 9, 30)];
}

/** What re-reading that run through the product decoder throws (null if it does not). */
export function rereadError(decoder: { push: (line: string) => unknown }, records: unknown[]): unknown {
  try {
    for (const record of records) decoder.push(`${JSON.stringify(record)}\n`);
  } catch (error) { return error; }
  return null;
}
