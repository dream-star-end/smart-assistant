/** Request-level fail-closed gate for the first (off-by-default) Box route.
 * Later tool/vision/effort support must be added with protocol evidence, not
 * silently stripped from an authenticated Claude Code request.
 */
import type { ProxyBody } from "./shared.js";
import { BoxMessagesShapeError, compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";

export function validateBoxTextRequest(body: ProxyBody): string | null {
  if (body.stream !== true) return "BOX_STREAM_REQUIRED";
  if (body.tools?.length || body.tool_choice !== undefined) return "BOX_TOOLS_REQUIRE_LIVE_BRIDGE";
  if (body.thinking !== undefined || body.output_config !== undefined) return "BOX_EFFORT_UNMAPPED";
  if (body.context_management !== undefined || body.stop_sequences !== undefined
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
