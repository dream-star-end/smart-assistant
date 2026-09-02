/**
 * CCB (claude-code-best) deferred-tool wrappers.
 *
 * Fable / Cursor-over-Sand engines run claude-code-best, which does not expose
 * MCP tools directly. The model first calls `SearchExtraTools {query}` to find a
 * deferred tool, then `ExecuteExtraTool {tool_name, params}` to run it. The
 * success result is a JSON string `{"result":[{"type":"text","text":…}],"tool_name":…}`;
 * failures are plain `error: …` text with is_error.
 *
 * Both the tool-card display layer and the reducer (delegate → agent-group
 * conversion) must see through the wrapper, otherwise every MCP call renders as
 * a raw `ExecuteExtraTool` wrench card. Pure module (no React) shared by
 * lib/chat and components/tool.
 */

export const EXECUTE_EXTRA_TOOL = "ExecuteExtraTool";
export const SEARCH_EXTRA_TOOLS = "SearchExtraTools";

function normalizeName(name: string | undefined | null): string {
  return String(name ?? "")
    .trim()
    .replace(/[-_]/g, "")
    .toLowerCase();
}

export function isExecuteExtraToolName(name: string | undefined | null): boolean {
  return normalizeName(name) === "executeextratool";
}

export function isSearchExtraToolsName(name: string | undefined | null): boolean {
  return normalizeName(name) === "searchextratools";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || trimmed.length > 4_000_000) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export type ExtraToolCall = { name: string; params: Record<string, unknown> };

/**
 * `ExecuteExtraTool` input → inner `{name, params}`. Returns null when the
 * `tool_name` is missing (e.g. still streaming) so callers keep the wrapper.
 * `params` may arrive as a JSON string from some engines; tolerate that.
 */
export function unwrapExecuteExtraToolInput(input: unknown): ExtraToolCall | null {
  const obj = parseRecord(input);
  if (!obj) return null;
  const rawName = obj.tool_name ?? obj.toolName ?? obj.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) return null;
  const rawParams = obj.params ?? obj.arguments ?? obj.input ?? obj.tool_input;
  const params = parseRecord(rawParams) ?? {};
  return { name, params };
}

export type ExtraToolResult = {
  /** Inner tool name echoed by CCB (may be empty for legacy/partial rows). */
  toolName: string;
  /** Concatenated text of `result[].text`, or the string `result`. Empty when no text. */
  text: string;
};

/**
 * Parse the CCB `ExecuteExtraTool` success envelope. Returns null when `raw`
 * is not the envelope (plain `error: …` text, other JSON, etc.).
 */
export function parseExecuteExtraToolResult(raw: unknown): ExtraToolResult | null {
  const obj = parseRecord(raw);
  if (!obj || !("result" in obj)) return null;
  const toolName = typeof obj.tool_name === "string" ? obj.tool_name : "";
  // Envelope must look like CCB's: has tool_name or result is an MCP content array.
  const result = obj.result;
  if (!toolName && !Array.isArray(result)) return null;
  if (Array.isArray(result)) {
    const texts = result
      .map((part) => {
        const rec = asRecord(part);
        if (!rec) return typeof part === "string" ? part : "";
        if (typeof rec.text === "string") return rec.text;
        if (rec.type === "image" || rec.type === "resource") return "";
        return "";
      })
      .filter(Boolean);
    return { toolName, text: texts.join("\n") };
  }
  if (typeof result === "string") return { toolName, text: result };
  if (result === null || result === undefined) return { toolName, text: "" };
  const inner = asRecord(result);
  if (inner) {
    const content = Array.isArray(inner.content) ? inner.content : null;
    if (content) {
      const texts = content
        .map((part) => {
          const rec = asRecord(part);
          return rec && typeof rec.text === "string" ? rec.text : "";
        })
        .filter(Boolean);
      return { toolName, text: texts.join("\n") };
    }
    if (typeof inner.text === "string") return { toolName, text: inner.text };
  }
  try {
    return { toolName, text: JSON.stringify(result) };
  } catch {
    return { toolName, text: String(result) };
  }
}

/**
 * Best-effort text of an `ExecuteExtraTool` result: envelope text when it is
 * the CCB envelope, otherwise the raw string (error text) unchanged.
 */
export function executeExtraToolResultText(raw: unknown): string {
  const parsed = parseExecuteExtraToolResult(raw);
  if (parsed) return parsed.text;
  return typeof raw === "string" ? raw : "";
}

/** Strip the `select:` / `discover:` / `+` prefixes CCB uses in SearchExtraTools queries. */
export function searchExtraToolsQuery(input: unknown): string {
  const obj = parseRecord(input);
  const query = obj && typeof obj.query === "string" ? obj.query.trim() : "";
  return query.replace(/^(?:select|discover)\s*:\s*/i, "").replace(/^\+/, "");
}

/** Parse "Found N deferred tool(s): a, b, c.\nUse ExecuteExtraTool …" into names. */
export function parseSearchExtraToolsResult(
  raw: unknown,
): { found: string[]; none: boolean } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  if (/^No matching deferred tools?/i.test(text)) return { found: [], none: true };
  const match = /^Found\s+\d+\s+deferred tool\(?s?\)?\s*:\s*([\s\S]*?)(?:\.\s*(?:\n|$)|\n|$)/i.exec(
    text,
  );
  if (!match) return null;
  const found = match[1]
    .split(/\s*,\s*/)
    .map((name) => name.trim().replace(/\.$/, ""))
    .filter(Boolean);
  return { found, none: found.length === 0 };
}
