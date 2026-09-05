// Pure contract policy: importing this module never starts a browser or reads secrets.
export const TOTAL_TIMEOUT = 240_000;
export const CASES = ["C1 cold UI login without auth hint", "C2 collapsed model reaches outbound request", "C3 one model per engine"];
export function parseModels(value = "gpt-5.6-sol,deepseek-v4-flash") {
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
  const model = parseModels(env.V5_CONTRACT_MODEL_ID ?? "gpt-5.6-luna");
  if (model.length !== 1) throw new Error("Expected one collapsed model");
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
export function tapResult(ok, n, name, ms, error) {
  const clean = (s) => String(s).replace(/[\r\n]+/g, " ");
  return `${ok ? "ok" : "not ok"} ${n} - ${clean(name)}\n# duration_ms ${n} ${Math.round(ms)}${error ? `\n# error ${clean(error)}` : ""}`;
}
