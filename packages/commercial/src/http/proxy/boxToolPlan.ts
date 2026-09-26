/** First-round virtual-MCP assembly only. Do not enable the catalog path
 * until detached lifetime, durable tool handoff and multi-round resumption
 * pass real Box acceptance. OpenClaude alone executes client tools. */
import { createHash, randomBytes } from "node:crypto";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { ProxyBody } from "./shared.js";
import { makeBoxTextPlan, makeBoxAssetStage, BoxTextPlanError,
  type BoxTextPlan } from "./boxTextPlan.js";
import { compileBoxToolCatalog, mapBoxCliEffort,
  type BoxToolCatalog } from "./boxToolCatalog.js";
import { BOX_TOOL_SPOOL_MAX_BYTES } from "./boxToolCapacity.js";

export interface BoxToolPlan extends BoxTextPlan {
  readonly stageVirtualMcp: BoxCcExecRequest;
  readonly virtualMcpHash: string;
  readonly catalog: BoxToolCatalog;
}

export function makeBoxToolPlan(input: {
  body: ProxyBody;
  upstreamModel: string;
  maxOutputTokensLimit: number;
  supervisorAsset: Buffer;
  keeperAsset: Buffer;
  virtualMcpAsset: Buffer;
  runNonce?: string;
  leaseEpoch?: string;
}): BoxToolPlan {
  const choice = input.body.tool_choice;
  if (choice !== undefined && (choice === null || typeof choice !== "object"
    || Array.isArray(choice) || Object.keys(choice).join(",") !== "type"
    || (choice as { type?: unknown }).type !== "auto")) {
    throw new BoxTextPlanError("BOX_TOOL_CHOICE_UNMAPPED");
  }
  const catalog = compileBoxToolCatalog(input.body.tools);
  const effort = input.body.thinking === undefined && input.body.output_config === undefined
    ? null : mapBoxCliEffort(input.body.thinking, input.body.output_config);
  const runNonce = input.runNonce ?? randomBytes(12).toString("hex");
  if (!/^[0-9a-f]{24}$/.test(runNonce)) throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  const catalogRaw = Buffer.from(catalog.json, "utf8");
  const catalogPath = `/tmp/ocv5-289-run-${runNonce}/tool-catalog.json`;
  const { tools: _tools, tool_choice: _choice, thinking: _thinking,
    output_config: _output, ...textBody } = input.body;
  const base = makeBoxTextPlan({ body: textBody, upstreamModel: input.upstreamModel,
      maxOutputTokensLimit: input.maxOutputTokensLimit,
      supervisorAsset: input.supervisorAsset, keeperAsset: input.keeperAsset,
      extraStageFiles: [{ path: catalogPath, raw: catalogRaw, hash: catalog.sha256 }],
      runNonce, leaseEpoch: input.leaseEpoch, supervisorDeadlineSeconds: 900 });
  const virtualMcpHash = createHash("sha256").update(input.virtualMcpAsset).digest("hex");
  const virtualMcpPath = `/tmp/ocv5-289-v2-box-virtual-mcp-${virtualMcpHash.slice(0, 16)}.py`;
  const stageVirtualMcp = makeBoxAssetStage(input.virtualMcpAsset, virtualMcpPath).request;
  const mcpConfig = JSON.stringify({ mcpServers: { ocbridge: { type: "stdio",
    command: "/usr/bin/python3", args: ["-I", virtualMcpPath, base.cwd, catalog.sha256, "900"] } } });
  const args = [...base.run.args];
  const outputAt = args.indexOf("--max-output");
  if (outputAt < 0 || args[outputAt + 1] !== "1048576") {
    throw new BoxTextPlanError("BOX_TOOL_PLAN_INVALID");
  }
  args[outputAt + 1] = String(BOX_TOOL_SPOOL_MAX_BYTES);
  args.splice(outputAt + 2, 0, "--stderr-limit", String(2 * 1024 * 1024));
  const deny = args.indexOf("--disallowedTools");
  if (deny < 0 || args[deny + 1] !== "mcp__*") throw new BoxTextPlanError("BOX_TOOL_PLAN_INVALID");
  args.splice(deny, 2);
  const configAt = args.indexOf("--mcp-config");
  if (configAt < 0) throw new BoxTextPlanError("BOX_TOOL_PLAN_INVALID");
  args[configAt + 1] = mcpConfig;
  const allowed = catalog.tools.map((tool) => `mcp__ocbridge__${tool.name}`).join(",");
  args.splice(configAt, 0, "--allowedTools", allowed);
  if (effort !== null) args.splice(configAt, 0, "--effort", effort);
  const run: BoxCcExecRequest = { ...base.run, args };
  return { ...base, stageVirtualMcp, virtualMcpHash, catalog, run };
}
