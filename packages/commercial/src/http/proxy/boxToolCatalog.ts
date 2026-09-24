/** Translate Anthropic Messages tool declarations from the OpenClaude-side
 * Claude Code request into a bounded Box virtual-MCP catalog. The mapping is
 * per invocation; Box never receives authority to execute the tool locally.
 */
import { createHash } from "node:crypto";

export class BoxToolCatalogError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolCatalogError"; }
}

export const BOX_MCP_SERVER = "ocbridge";
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
  readonly json: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject cycles, excessive nesting and dangerous keys before any schema is
 * staged as a Box file. JSON.stringify alone does not enforce depth. */
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
  if (keys.length > 4096 || keys.some((key) => key === "__proto__"
    || key === "constructor" || key === "prototype")) {
    throw new BoxToolCatalogError("BOX_TOOL_SCHEMA_INVALID");
  }
  for (const key of keys) validateJson(value[key], depth + 1);
}

export function compileBoxToolCatalog(rawTools: unknown): BoxToolCatalog {
  if (!Array.isArray(rawTools) || rawTools.length < 1 || rawTools.length > 128) {
    throw new BoxToolCatalogError("BOX_TOOL_COUNT_INVALID");
  }
  const tools: BoxMcpTool[] = [];
  const clientNameByBoxName = new Map<string, string>();
  const boxNameByClientName = new Map<string, string>();
  for (let i = 0; i < rawTools.length; i++) {
    const source = rawTools[i];
    if (!record(source) || typeof source.name !== "string"
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
    const mcpName = `t${i}`;
    const boxName = `mcp__${BOX_MCP_SERVER}__${mcpName}`;
    tools.push({ name: mcpName, description: source.description,
      inputSchema: source.input_schema });
    clientNameByBoxName.set(boxName, source.name);
    boxNameByClientName.set(source.name, boxName);
  }
  const json = JSON.stringify({ tools });
  if (Buffer.byteLength(json) > 1_048_576) {
    throw new BoxToolCatalogError("BOX_TOOL_CATALOG_TOO_LARGE");
  }
  return { tools, clientNameByBoxName, boxNameByClientName,
    sha256: createHash("sha256").update(json).digest("hex"), json };
}

/** Current real Claude Code 2.1.280 default is adaptive/omitted + medium.
 * Do not silently coerce fixed-budget thinking or unsupported effort levels. */
export function mapBoxCliEffort(thinking: unknown, outputConfig: unknown): "low" | "medium" | "high" | "max" {
  if (!record(thinking) || thinking.type !== "adaptive"
    || thinking.display !== "omitted"
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
