/** First-round virtual-MCP assembly only. Do not enable the catalog path
 * until detached lifetime, durable tool handoff and multi-round resumption
 * pass real Box acceptance. OpenClaude alone executes client tools. */
import { createHash, randomBytes } from "node:crypto";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { ProxyBody } from "./shared.js";
import { makeBoxTextPlan, makeBoxAssetStage, makeBoxAssetsStage, BoxTextPlanError,
  type BoxTextPlan } from "./boxTextPlan.js";
import { compileBoxToolCatalog, mapBoxCliEffort,
  type BoxToolCatalog, type BoxMcpAliasMode } from "./boxToolCatalog.js";
import { BOX_TOOL_MAX_WALL_MS, BOX_TOOL_SPOOL_MAX_BYTES } from "./boxToolCapacity.js";

export interface BoxToolPlan extends BoxTextPlan {
  readonly stageVirtualMcp: BoxCcExecRequest;
  readonly virtualMcpHash: string;
  readonly catalog: BoxToolCatalog;
}

/**
 * OCV5-299: the OpenClaude-side instructions name tools by their plain client
 * names (Bash, Read, ExecuteExtraTool, …) while this CLI can only call the
 * virtual-MCP aliases. Observed live: the model first calls the plain name,
 * gets "No such tool available", and only then finds the alias. State the
 * mapping once in the system prompt so the first call already uses the alias,
 * as a native Claude Code session calls its own tool names directly.
 */
export function boxToolAliasNotice(catalog: Pick<BoxToolCatalog, "boxNameByClientName">): string {
  const lines = [...catalog.boxNameByClientName].map(([client, box]) => `- ${client} → ${box}`);
  return ["<tool-naming>",
    "In this session every tool is provided by the MCP server \"ocbridge\" under an alias.",
    "Wherever the instructions, tool descriptions or earlier messages name a tool by its plain name,",
    "call its alias instead. Plain names are not callable here and fail with \"No such tool available\".",
    ...lines,
    ...(catalog.boxNameByClientName.has("ExecuteExtraTool") ? [
      "Only the tools listed above exist in this run. Platform and MCP tools that are not listed",
      "(mcp__<server>__<tool>, e.g. mcp__openclaude-memory__delegate_task) are deferred tools: calling them",
      "by their own name fails with \"No such tool available\". Reach them through the listed ExecuteExtraTool",
      "alias with {\"tool_name\": \"<full tool name>\", \"params\": {...}}, and use SearchExtraTools first when unsure of the name.",
    ] : []),
    "</tool-naming>"].join("\n");
}

/** OCV5-302: effectively disables Claude Code's MCP output truncation. */
export const BOX_MCP_OUTPUT_TOKENS = "4000000";

export function makeBoxToolPlan(input: {
  body: ProxyBody;
  upstreamModel: string;
  maxOutputTokensLimit: number;
  supervisorAsset: Buffer;
  keeperAsset: Buffer;
  virtualMcpAsset: Buffer;
  runNonce?: string;
  leaseEpoch?: string;
  nativePersistence?: boolean;
  nativeResume?: { cliCwd: string; sessionId: string; expectedSha256: string };
  /** OCV5-304: resume a tool exchange whose live owner is gone (see mapper). */
  resumeToolResults?: boolean;
  toolAliasMode?: BoxMcpAliasMode;
}): BoxToolPlan {
  const choice = input.body.tool_choice;
  if (choice !== undefined && (choice === null || typeof choice !== "object"
    || Array.isArray(choice) || Object.keys(choice).join(",") !== "type"
    || (choice as { type?: unknown }).type !== "auto")) {
    throw new BoxTextPlanError("BOX_TOOL_CHOICE_UNMAPPED");
  }
  const catalog = compileBoxToolCatalog(input.body.tools, input.toolAliasMode);
  const effort = input.body.thinking === undefined && input.body.output_config === undefined
    ? null : mapBoxCliEffort(input.body.thinking, input.body.output_config);
  const runNonce = input.runNonce ?? randomBytes(12).toString("hex");
  if (!/^[0-9a-f]{24}$/.test(runNonce)) throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  const catalogRaw = Buffer.from(catalog.json, "utf8");
  const catalogPath = `/tmp/ocv5-289-run-${runNonce}/tool-catalog.json`;
  const { tools: _tools, tool_choice: _choice, thinking: _thinking,
    output_config: _output, ...textBody } = input.body;
  const base = makeBoxTextPlan({ body: textBody, upstreamModel: input.upstreamModel,
      ...(input.resumeToolResults ? { resumeToolResults: true } : {}),
      maxOutputTokensLimit: input.maxOutputTokensLimit,
      supervisorAsset: input.supervisorAsset, keeperAsset: input.keeperAsset,
      extraStageFiles: [{ path: catalogPath, raw: catalogRaw, hash: catalog.sha256 }],
       runNonce, leaseEpoch: input.leaseEpoch,
       supervisorDeadlineSeconds: BOX_TOOL_MAX_WALL_MS / 1000,
       nativePersistence: input.nativePersistence, nativeResume: input.nativeResume,
       toolAliases: catalog.boxNameByClientName,
       systemSuffix: boxToolAliasNotice(catalog) });
  const virtualMcpHash = createHash("sha256").update(input.virtualMcpAsset).digest("hex");
  const virtualMcpPath = `/tmp/ocv5-289-v2-box-virtual-mcp-${virtualMcpHash.slice(0, 16)}.py`;
  const stageVirtualMcp = makeBoxAssetStage(input.virtualMcpAsset, virtualMcpPath).request;
  const assetBatch = makeBoxAssetsStage([
    { asset: input.supervisorAsset, path: base.stageSupervisor.args[3]! },
    { asset: input.keeperAsset, path: base.stageKeeper.args[3]! },
    { asset: input.virtualMcpAsset, path: virtualMcpPath },
  ]);
  const mcpConfig = JSON.stringify({ mcpServers: { ocbridge: { type: "stdio",
    command: "/usr/bin/python3", args: ["-I", virtualMcpPath, base.cwd,
      catalog.sha256, String(BOX_TOOL_MAX_WALL_MS / 1000)] } } });
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
  // OCV5-302: the client already bounded this result exactly as native Claude
  // Code does. The CLI's own MCP truncation/large-output layer would replace
  // it with a preview of a file on the Box the model cannot read, and break
  // the result echo bind.
  const run: BoxCcExecRequest = { ...base.run, args,
    environment: { ...base.run.environment, MAX_MCP_OUTPUT_TOKENS: BOX_MCP_OUTPUT_TOKENS } };
  return { ...base, stageVirtualMcp, virtualMcpHash, catalog, run,
    stageAssets: assetBatch.request, assetManifest: assetBatch.manifest };
}
