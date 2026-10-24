// Pure contract policy: importing this module never starts a browser or reads secrets.
export const TOTAL_TIMEOUT = 240_000;
export const CASES = ["C1 cold UI login without auth hint", "C2 collapsed model reaches outbound request", "C3 one model per engine, two turns in one session"];
export function parseModels(value = "grok-build,deepseek-v4-flash") {
  const models = value.split(",").map((x) => x.trim());
  if (!models.length || models.some((x) => !/^[a-zA-Z0-9._-]+$/.test(x)) || new Set(models).size !== models.length) throw new Error("Invalid/duplicate contract models");
  return models;
}
export function parseOptions(env) {
  const base = new URL(env.V5_E2E_BASE || "http://127.0.0.1:18790");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("V5_E2E_BASE must be an HTTP origin");
  const email = env.V5_CANARY_EMAIL || "v5-selfhost-canary@claudeai.chat";
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("Invalid canary email");
  const cost = env.V5_CONTRACT_COST ?? "dry";
  if (!["dry", "live"].includes(cost)) throw new Error("V5_CONTRACT_COST must be dry or live");
  const model = parseModels(env.V5_CONTRACT_MODEL_ID ?? "gpt-6-luna");
  if (model.length !== 1) throw new Error("Expected one contract model");
  return { base: base.origin, email, passwordFile: env.V5_CANARY_PASSWORD_FILE || "/etc/openclaude/selfhost-canary.password", cost, model: model[0], models: parseModels(env.V5_CONTRACT_MODELS) };
}
export function turnPolicy(cost) {
  if (cost === "dry") return { forward: false, waitForCompletion: false };
  if (cost === "live") return { forward: true, waitForCompletion: true };
  throw new Error("Invalid cost mode");
}
export function engineMatrix(ids, catalog) {
  const matrix = ids.map((id) => {
    const rows = catalog.filter((m) => m.id === id);
    if (rows.length !== 1 || !["codex", "ccb", "grok", "cursor", "zcode"].includes(rows[0].engine)) throw new Error(`Missing/ambiguous catalog engine: ${id}`);
    return { id, engine: rows[0].engine };
  });
  if (new Set(matrix.map((m) => m.engine)).size !== matrix.length || matrix.length < 2) throw new Error("Contract matrix needs at least two distinct engines, one model each");
  return matrix;
}
export function parseFrame(raw) { try { return JSON.parse(String(raw)); } catch { return null; } }
export function assertOutbound(frame, { model, text, engine }, catalog) {
  if (frame?.type !== "inbound.message" || frame.model !== model || frame.content?.text !== text || !frame.peer?.id || !frame.clientMessageId || frame.teamMode === true) throw new Error("Outbound turn identity/model mismatch");
  if (engine && catalog.find((m) => m.id === frame.model)?.engine !== engine) throw new Error("Outbound catalog engine mismatch");
  return frame;
}
export function turnEvidence(frames, sent) {
  const own = frames.filter((f) => f?.peer?.id === sent.peer.id && f.clientMessageId === sent.clientMessageId);
  const error = own.some((f) => f.error || ["outbound.error", "outbound.turn_error", "error"].includes(f.type));
  const complete = own.some((f) => f.type === "outbound.message" && f.isFinal === true);
  return { error, complete };
}
// Continuation (OCV5-405): a first turn that only works in isolation is not a
// working chat. Turn 2 must recall a random code that appears only in turn 1,
// in the same session (same peer), so a lost or rebuilt context fails the gate.
// Wording (OCV5-417): an ordinary order number, no "暗号/记住/只回答". grok-build
// classified "请记住暗号 X，只回答2" as a prompt-injection canary and refused to
// repeat it, failing ~1/3 of trains although the context was intact.
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export function continuationCode(randomInt = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n) {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
  for (let i = 0; i < 4; i++) code += String(randomInt(10));
  return code;
}
export function continuationPrompts(code) {
  if (!/^[A-Z]{4}[0-9]{4}$/.test(code)) throw new Error("Invalid continuation code");
  const id = crypto.randomUUID();
  return {
    // Agent memory is shared across sessions: each probe names its own purchase entity.
    first: `采购批次 R2-${id} 的第一张采购单编号是 PO-${code}。收到请回复「收到」。`,
    second: `采购批次 R2-${id} 的第一张采购单编号是多少？`,
  };
}
export function assertSameSession(first, second) {
  if (!first?.peer?.id || first.peer.id !== second?.peer?.id) throw new Error("Continuation turn left the first turn's session");
  if (!second.clientMessageId || first.clientMessageId === second.clientMessageId) throw new Error("Continuation turn reused the first message id");
}
export function assertContinuationAnswer(text, code) {
  // Models may wrap the code in quotes, markdown or a short sentence. The code
  // itself must appear intact as one token; nothing else is accepted.
  const tokens = String(text ?? "").toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  if (!tokens.includes(code)) throw new Error("Continuation turn did not recall the first turn's code");
}
// OCV5-460: Grok CLI cut every request over ~20 KB, saved it to
// sessions/<id>/prompts/prompt_N.txt and told the model to read it back, so the
// model opened its own request with a file tool before answering. A contract turn
// whose tool calls touch such a file did not have the user's message in context.
const OFFLOADED_REQUEST_FILE = /\/prompts\/prompt_\d+\.txt\b/;
export function offloadedRequestReads(frames, sent) {
  const own = frames.filter((f) => f?.peer?.id === sent.peer.id && f.clientMessageId === sent.clientMessageId);
  return own
    .flatMap((f) => (Array.isArray(f.blocks) ? f.blocks : []))
    .filter((b) => b?.kind === "tool_use" && OFFLOADED_REQUEST_FILE.test(JSON.stringify(b)))
    .map((b) => b.toolName);
}
export function tapResult(ok, n, name, ms, error) {
  const clean = (s) => String(s).replace(/[\r\n]+/g, " ");
  return `${ok ? "ok" : "not ok"} ${n} - ${clean(name)}\n# duration_ms ${n} ${Math.round(ms)}${error ? `\n# error ${clean(error)}` : ""}`;
}
