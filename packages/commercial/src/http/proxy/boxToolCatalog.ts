/** Translate Anthropic Messages tool declarations from the OpenClaude-side
 * Claude Code request into a bounded Box virtual-MCP catalog. The mapping is
 * per invocation; Box never receives authority to execute the tool locally.
 */
import { createHash } from "node:crypto";
import { normalizeBoxToolDeclaration } from "./boxCacheAnnotations.js";

export class BoxToolCatalogError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolCatalogError"; }
}

export const BOX_MCP_SERVER = "ocbridge";
/** Every virtual-MCP alias this code may emit or accept: the legacy opaque
 * `tN` form, or the client tool's own name (OCV5-300). With the
 * `mcp__ocbridge__` prefix the full name stays within 64 characters. */
export const BOX_MCP_ALIAS = /^(?:t[0-9]{1,3}|[A-Za-z0-9_-]{1,48})$/;
export const BOX_MCP_TOOL_NAME = /^mcp__ocbridge__(?:t[0-9]{1,3}|[A-Za-z0-9_-]{1,48})$/;
const NATURAL_ALIAS = /^[A-Za-z0-9_-]{1,48}$/;
const OPAQUE_ALIAS = /^t[0-9]{1,3}$/;

/** The CLI-visible alias for the i-th declared client tool. A client name
 * that is already a valid MCP tool name is used as-is, so the model sees the
 * same names as a native Claude Code session (mcp__ocbridge__Bash, …). Names
 * that are too long, carry other characters, or look like the opaque form
 * fall back to `t{i}`; the two namespaces cannot collide. */
export function boxMcpAliasFor(clientName: string, index: number): string {
  return NATURAL_ALIAS.test(clientName) && !OPAQUE_ALIAS.test(clientName)
    ? clientName : `t${index}`;
}

/** `natural` (OCV5-300, selected by production admission) uses
 * boxMcpAliasFor; `opaque` (the compile default) reproduces a catalog staged
 * before OCV5-300 (every alias t{i}) so chains admitted on the old release
 * still rehydrate and bind byte-exactly. */
export type BoxMcpAliasMode = "natural" | "opaque";
export interface BoxMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface BoxToolCatalog {
  readonly tools: readonly BoxMcpTool[];
  /** Exact Anthropic tool name emitted by the Box CLI -> caller's tool name. */
  readonly clientNameByBoxName: ReadonlyMap<string, string>;
  readonly boxNameByClientName: ReadonlyMap<string, string>;
  readonly sha256: string;
  /** Binds original client tool names as well as remote alias/schema bytes. */
  readonly bindingSha256: string;
  readonly json: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject cycles and excessive nesting before a schema is staged as a Box
 * file. Property names are inert JSON data here: no object merge or dynamic
 * assignment ever interprets `__proto__`, `constructor`, etc. */
function validateJson(value: unknown, depth = 0): void {
  if (depth > 32) throw new BoxToolCatalogError("BOX_TOOL_SCHEMA_TOO_DEEP");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new BoxToolCatalogError("BOX_TOOL_SCHEMA_TOO_LARGE");
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (!record(value)) throw new BoxToolCatalogError("BOX_TOOL_SCHEMA_INVALID");
  const keys = Object.keys(value);
  if (keys.length > 4096) {
    throw new BoxToolCatalogError("BOX_TOOL_SCHEMA_INVALID");
  }
  for (const key of keys) validateJson(value[key], depth + 1);
}

export function compileBoxToolCatalog(rawTools: unknown,
  aliasMode: BoxMcpAliasMode = "opaque"): BoxToolCatalog {
  if (!Array.isArray(rawTools) || rawTools.length < 1 || rawTools.length > 128) {
    throw new BoxToolCatalogError("BOX_TOOL_COUNT_INVALID");
  }
  const tools: BoxMcpTool[] = [];
  const clientNameByBoxName = new Map<string, string>();
  const boxNameByClientName = new Map<string, string>();
  for (let i = 0; i < rawTools.length; i++) {
    let source: unknown;
    try { source = normalizeBoxToolDeclaration(rawTools[i]); }
    catch { throw new BoxToolCatalogError("BOX_TOOL_DECLARATION_INVALID"); }
    if (!record(source) || Object.keys(source).some((key) =>
      key !== "name" && key !== "description" && key !== "input_schema")
      || typeof source.name !== "string"
      || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(source.name)
      || boxNameByClientName.has(source.name)
      || typeof source.description !== "string"
      || Buffer.byteLength(source.description) > 16_384
      || !record(source.input_schema) || source.input_schema.type !== "object") {
      throw new BoxToolCatalogError("BOX_TOOL_DECLARATION_INVALID");
    }
    validateJson(source.input_schema);
    const schemaJson = JSON.stringify(source.input_schema);
    if (Buffer.byteLength(schemaJson) > 65_536) {
      throw new BoxToolCatalogError("BOX_TOOL_SCHEMA_TOO_LARGE");
    }
    const mcpName = aliasMode === "opaque" ? `t${i}` : boxMcpAliasFor(source.name, i);
    const boxName = `mcp__${BOX_MCP_SERVER}__${mcpName}`;
    // The CLI sees the MCP alias (the client name itself when it is a valid
    // MCP name, else t{i}), while the OpenClaude-side prompt and tool_choice
    // name the original client tool. Preserve that name in the model-visible
    // description; otherwise a model can truthfully say that e.g.
    // `local.echo` is unavailable despite t0 being present. This is identity
    // metadata, never execution authority.
    tools.push({ name: mcpName,
      description: `OpenClaude tool name: ${source.name}. ${source.description}`,
      inputSchema: source.input_schema });
    clientNameByBoxName.set(boxName, source.name);
    boxNameByClientName.set(source.name, boxName);
  }
  const json = JSON.stringify({ tools });
  if (Buffer.byteLength(json) > 1_048_576) {
    throw new BoxToolCatalogError("BOX_TOOL_CATALOG_TOO_LARGE");
  }
  const bindingJson = JSON.stringify({ catalog: json,
    clientNames: [...boxNameByClientName.keys()] });
  return { tools, clientNameByBoxName, boxNameByClientName,
    sha256: createHash("sha256").update(json).digest("hex"),
    bindingSha256: createHash("sha256").update(bindingJson).digest("hex"), json };
}

const STAGED_NAME_PREFIX = "OpenClaude tool name: ";

/** The alias mode a compiled catalog was built with. */
export function boxCatalogAliasMode(catalog: BoxToolCatalog): BoxMcpAliasMode {
  return catalog.tools.every((tool, index) => tool.name === `t${index}`) ? "opaque" : "natural";
}

/**
 * OCV5-300 rolling compatibility. A chain admitted before natural aliases
 * stored the binding of its opaque (t{i}) catalog. Given the catalog compiled
 * from the same request tools, return the variant whose binding equals the
 * stored hash, or null when neither does (a real catalog change).
 */
export function boxCatalogMatching(catalog: BoxToolCatalog, storedHash: unknown): BoxToolCatalog | null {
  if (catalog.bindingSha256 === storedHash) return catalog;
  if (typeof storedHash !== "string") return null;
  try {
    const declarations = catalog.tools.map((tool) => {
      const rest = tool.description.startsWith(STAGED_NAME_PREFIX)
        ? tool.description.slice(STAGED_NAME_PREFIX.length) : "";
      const cut = rest.indexOf(". ");
      if (cut <= 0) throw new BoxToolCatalogError("BOX_TOOL_CATALOG_REHYDRATE_INVALID");
      return { name: rest.slice(0, cut), description: rest.slice(cut + 2),
        input_schema: tool.inputSchema };
    });
    for (const mode of ["opaque", "natural"] as const) {
      const variant = compileBoxToolCatalog(declarations, mode);
      if (variant.bindingSha256 === storedHash) return variant;
    }
  } catch { /* malformed: not a match */ }
  return null;
}
const CLIENT_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

/** Rebuild the admitted catalog from the exact staged JSON. The raw bytes must
 * round-trip through compileBoxToolCatalog; nothing is trimmed or rewritten. */
export function rehydrateBoxToolCatalog(rawJson: string): BoxToolCatalog {
  if (typeof rawJson !== "string" || rawJson.length < 2
    || Buffer.byteLength(rawJson) > 1_048_576) {
    throw new BoxToolCatalogError("BOX_TOOL_CATALOG_REHYDRATE_INVALID");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); }
  catch { throw new BoxToolCatalogError("BOX_TOOL_CATALOG_REHYDRATE_INVALID"); }
  if (!record(parsed) || Object.keys(parsed).length !== 1
    || !Object.hasOwn(parsed, "tools") || !Array.isArray(parsed.tools)
    || parsed.tools.length < 1 || parsed.tools.length > 128) {
    throw new BoxToolCatalogError("BOX_TOOL_CATALOG_REHYDRATE_INVALID");
  }
  const declarations = parsed.tools.map((item, index) => {
    if (!record(item) || Object.keys(item).sort().join(",") !== "description,inputSchema,name"
      || typeof item.name !== "string" || !BOX_MCP_ALIAS.test(item.name)
      || typeof item.description !== "string"
      || !item.description.startsWith(STAGED_NAME_PREFIX)
      || !record(item.inputSchema)) {
      throw new BoxToolCatalogError("BOX_TOOL_CATALOG_REHYDRATE_INVALID");
    }
    const rest = item.description.slice(STAGED_NAME_PREFIX.length);
    const cut = rest.indexOf(". ");
    const name = cut > 0 ? rest.slice(0, cut) : "";
    if (!CLIENT_NAME.test(name)) {
      throw new BoxToolCatalogError("BOX_TOOL_CATALOG_REHYDRATE_INVALID");
    }
    const description = rest.slice(cut + 2);
    if (Buffer.byteLength(description) > 16_384) {
      throw new BoxToolCatalogError("BOX_TOOL_CATALOG_REHYDRATE_INVALID");
    }
    return { name, description, input_schema: item.inputSchema };
  });
  const opaque = parsed.tools.every((item, index) => record(item) && item.name === `t${index}`);
  let compiled: BoxToolCatalog;
  try { compiled = compileBoxToolCatalog(declarations, opaque ? "opaque" : "natural"); }
  catch (error) {
    if (error instanceof BoxToolCatalogError) {
      throw new BoxToolCatalogError("BOX_TOOL_CATALOG_REHYDRATE_INVALID");
    }
    throw error;
  }
  if (compiled.json !== rawJson) {
    throw new BoxToolCatalogError("BOX_TOOL_CATALOG_BINDING_MISMATCH");
  }
  return compiled;
}

/** Current real Claude Code 2.1.280 sends adaptive (display omitted) + medium.
 * The API makes display optional for adaptive thinking; on Opus 5.5 the
 * omitted display maps to the same CLI behavior as explicit "omitted".
 * Do not coerce summarized or fixed-budget thinking. */
export function mapBoxCliEffort(thinking: unknown, outputConfig: unknown): "low" | "medium" | "high" | "max" {
  if (!record(thinking) || thinking.type !== "adaptive"
    || (thinking.display !== undefined && thinking.display !== "omitted")
    || Object.keys(thinking).some((key) => key !== "type" && key !== "display")
    || !record(outputConfig) || typeof outputConfig.effort !== "string"
    || Object.keys(outputConfig).some((key) => key !== "effort")) {
    throw new BoxToolCatalogError("BOX_EFFORT_UNMAPPED");
  }
  if (outputConfig.effort !== "low" && outputConfig.effort !== "medium"
    && outputConfig.effort !== "high" && outputConfig.effort !== "max") {
    throw new BoxToolCatalogError("BOX_EFFORT_UNMAPPED");
  }
  return outputConfig.effort;
}
