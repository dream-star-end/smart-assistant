/** Comparison-only alias for one bound Edit default. Stored digests stay raw. */
import type { BoxToolCatalog } from "./boxToolCatalog.js";
import { hashBoxToolInput, type BoxToolUseDigest } from "./boxToolInputHash.js";

export class BoxToolInputEchoError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolInputEchoError"; }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function inputSchemaFor(catalog: BoxToolCatalog, clientName: string): Record<string, unknown> | null {
  const boxName = catalog.boxNameByClientName.get(clientName);
  const mcpName = boxName?.split("__").at(-1);
  const tool = catalog.tools.find((item) => item.name === mcpName);
  return tool && record(tool.inputSchema) ? tool.inputSchema : null;
}

/** True only when this bound declaration itself says replace_all is an
 * optional boolean whose default is exactly false. The name Edit is required
 * and is not sufficient. */
export function editReplaceAllFalseDefault(clientName: string, schema: Record<string, unknown> | null): boolean {
  if (clientName !== "Edit" || !schema || schema.type !== "object") return false;
  if (Array.isArray(schema.required) && schema.required.includes("replace_all")) return false;
  if (!record(schema.properties)) return false;
  const property = schema.properties.replace_all;
  if (!record(property) || property.type !== "boolean" || property.default !== false) return false;
  return true;
}

function aliasInput(input: Record<string, unknown>): Record<string, unknown> | null {
  if (!Object.hasOwn(input, "replace_all")) return { ...input, replace_all: false };
  if (input.replace_all !== false) return null;
  const copy = { ...input };
  delete copy.replace_all;
  return copy;
}

/** Raw form wins. Otherwise at most one strict omit↔false variant. */
export function selectStoredToolInput(input: unknown, storedHash: string,
  clientName: string, schema: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record(input)) return null;
  if (hashBoxToolInput(input) === storedHash) return input;
  if (!editReplaceAllFalseDefault(clientName, schema)) return null;
  const variant = aliasInput(input);
  if (!variant || hashBoxToolInput(variant) !== storedHash) return null;
  return variant;
}

export function comparableAssistantContent(content: unknown,
  digests: readonly Pick<BoxToolUseDigest, "clientName" | "inputHash">[],
  catalog: BoxToolCatalog): unknown[] {
  if (!Array.isArray(content)) throw new BoxToolInputEchoError("BOX_TOOL_RESULT_HISTORY_MISMATCH");
  let index = 0;
  const view = content.map((block) => {
    if (!record(block) || block.type !== "tool_use") return block;
    const digest = digests[index];
    index += 1;
    if (!digest || block.name !== digest.clientName) {
      throw new BoxToolInputEchoError("BOX_TOOL_RESULT_HISTORY_MISMATCH");
    }
    const selected = selectStoredToolInput(block.input, digest.inputHash, digest.clientName,
      inputSchemaFor(catalog, digest.clientName));
    if (!selected) throw new BoxToolInputEchoError("BOX_TOOL_RESULT_HISTORY_MISMATCH");
    return { ...block, input: selected };
  });
  if (index !== digests.length) throw new BoxToolInputEchoError("BOX_TOOL_RESULT_HISTORY_MISMATCH");
  return view;
}
