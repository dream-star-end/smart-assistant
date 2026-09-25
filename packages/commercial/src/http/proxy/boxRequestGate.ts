/** Request-level fail-closed gate for the first (off-by-default) Box route.
 * Later tool/vision/effort support must be added with protocol evidence, not
 * silently stripped from an authenticated Claude Code request.
 */
import type { ProxyBody } from "./shared.js";
import { BoxMessagesShapeError, compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";
import { compileBoxToolCatalog, mapBoxCliEffort } from "./boxToolCatalog.js";
import { isBoxNoopContextManagement } from "./boxCacheAnnotations.js";

export function validateBoxTextRequest(body: ProxyBody): string | null {
  if (body.stream !== true) return "BOX_STREAM_REQUIRED";
  if (body.tools?.length || body.tool_choice !== undefined) return "BOX_TOOLS_REQUIRE_LIVE_BRIDGE";
  if (body.thinking !== undefined || body.output_config !== undefined) return "BOX_EFFORT_UNMAPPED";
  if (body.context_management !== undefined && !isBoxNoopContextManagement(body)) {
    return "BOX_PARAMETER_UNMAPPED";
  }
  if (body.stop_sequences !== undefined
    || body.temperature !== undefined || body.top_p !== undefined
    || body.top_k !== undefined || body.service_tier !== undefined) {
    return "BOX_PARAMETER_UNMAPPED";
  }
  try {
    compileBoxCliSyntheticTurn(body, {
      cwd: "/tmp/ocv5-289-run-000000000000000000000000",
      cliVersion: "2.1.280",
    });
  } catch (error) {
    return error instanceof BoxMessagesShapeError ? error.code : "BOX_REQUEST_INVALID";
  }
  return null;
}

/** Tool calls remain disabled in the public route until the entire detached
 * cross-HTTP coordinator passes real Box acceptance. This guard never strips
 * an unsupported Claude Code parameter to make a request appear valid. */
export function validateBoxToolRequest(body: ProxyBody): string | null {
  if (body.stream !== true) return "BOX_STREAM_REQUIRED";
  if (!Array.isArray(body.tools) || body.tools.length < 1) return "BOX_TOOLS_REQUIRED";
  if (body.tool_choice !== undefined && (body.tool_choice === null
    || typeof body.tool_choice !== "object" || Array.isArray(body.tool_choice)
    || Object.keys(body.tool_choice).length !== 1
    || !Object.hasOwn(body.tool_choice, "type")
    || (body.tool_choice as { type?: unknown }).type !== "auto")) {
    return "BOX_TOOL_CHOICE_UNMAPPED";
  }
  if (body.context_management !== undefined && !isBoxNoopContextManagement(body)) {
    return "BOX_PARAMETER_UNMAPPED";
  }
  if (body.stop_sequences !== undefined
    || body.temperature !== undefined || body.top_p !== undefined
    || body.top_k !== undefined || body.service_tier !== undefined) {
    return "BOX_PARAMETER_UNMAPPED";
  }
  try {
    compileBoxToolCatalog(body.tools);
    if (body.thinking !== undefined || body.output_config !== undefined) {
      mapBoxCliEffort(body.thinking, body.output_config);
    }
    const last = Array.isArray(body.messages) ? body.messages.at(-1) : null;
    const content = last && typeof last === "object" && "content" in last
      ? last.content : null;
    const isResume = last && typeof last === "object" && "role" in last
      && last.role === "user" && Array.isArray(content) && content.length > 0
      && content.every((block) => block && typeof block === "object"
        && "type" in block && block.type === "tool_result");
    if (!isResume) {
      const { tools: _tools, tool_choice: _choice, thinking: _thinking,
        output_config: _output, ...textBody } = body;
      compileBoxCliSyntheticTurn(textBody, {
        cwd: "/tmp/ocv5-289-run-000000000000000000000000",
        cliVersion: "2.1.280",
      });
    }
  } catch (error) {
    return error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code : error instanceof BoxMessagesShapeError
        ? error.code : "BOX_TOOL_REQUEST_INVALID";
  }
  return null;
}

export function validateBoxRequest(body: ProxyBody, toolBridgeEnabled: boolean): string | null {
  if (body.tools !== undefined && !Array.isArray(body.tools)) return "BOX_TOOL_COUNT_INVALID";
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return toolBridgeEnabled ? validateBoxToolRequest(body)
      : "BOX_TOOLS_REQUIRE_LIVE_BRIDGE";
  }
  return validateBoxTextRequest(body);
}
