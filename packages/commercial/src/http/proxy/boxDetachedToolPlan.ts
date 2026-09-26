/** Offline assembly for a detached supervised Box tool invocation. It is not
 * a production route until actual Box cgroup survival and multi-round replay
 * fences pass. OpenClaude owns agent execution, tools, memory and Skills. */
import { createHash } from "node:crypto";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { ProxyBody } from "./shared.js";
import { makeBoxAssetStage, makeBoxAssetsStage } from "./boxTextPlan.js";
import { makeBoxToolPlan, type BoxToolPlan } from "./boxToolPlan.js";
import { makeBoxDetachedRunAccess, makeBoxPinnedRunnerRequest } from "./boxDetachedRunAccess.js";

export interface BoxDetachedToolPlan extends BoxToolPlan {
  readonly stageDetachedRunner: BoxCcExecRequest;
  readonly detachedRunnerHash: string;
  readonly launch: BoxCcExecRequest;
  readSpool(offset: number, limit?: number): BoxCcExecRequest;
}

export function makeBoxDetachedToolPlan(input: {
  body: ProxyBody;
  upstreamModel: string;
  maxOutputTokensLimit: number;
  supervisorAsset: Buffer;
  keeperAsset: Buffer;
  virtualMcpAsset: Buffer;
  detachedRunnerAsset: Buffer;
  runNonce?: string;
  leaseEpoch?: string;
  nativePersistence?: boolean;
  nativeResume?: { cliCwd: string; sessionId: string; expectedSha256: string };
}): BoxDetachedToolPlan {
  const { detachedRunnerAsset, ...toolInput } = input;
  const base = makeBoxToolPlan(toolInput);
  const detachedRunnerHash = createHash("sha256").update(detachedRunnerAsset).digest("hex");
  const access = makeBoxDetachedRunAccess({ runNonce: base.runNonce, detachedRunnerHash });
  const runnerPath = access.runnerPath;
  const stageDetachedRunner = makeBoxAssetStage(detachedRunnerAsset, runnerPath).request;
  const assetBatch = makeBoxAssetsStage([
    { asset: input.supervisorAsset, path: base.stageSupervisor.args[3]! },
    { asset: input.keeperAsset, path: base.stageKeeper.args[3]! },
    { asset: input.virtualMcpAsset, path: base.stageVirtualMcp.args[3]! },
    { asset: detachedRunnerAsset, path: runnerPath },
  ]);
  // The pinned runner owns the interpreter invocation. Do not pass Python's
  // -I switch as its first business argument (which must be the keeper path).
  if (base.run.args[0] !== "-I") throw new Error("BOX_DETACHED_PYTHON_ISOLATION_MISSING");
  const runnerArgs = [base.cwd, ...base.run.args.slice(1, 3),
    ...(base.cliCwd === base.cwd ? [] : ["--cli-cwd", base.cliCwd]),
    ...base.run.args.slice(3)];
  const launch: BoxCcExecRequest = makeBoxPinnedRunnerRequest({ runnerPath,
    detachedRunnerHash, args: runnerArgs, cwd: base.cwd,
    environment: base.run.environment });
  // Only after nonce/epoch-bound remote terminal proof: stdout/stderr contain
  // model output and must be removed with the private input/catalog files.
  const cleanup: BoxCcExecRequest = { ...base.cleanup,
    args: [...base.cleanup.args, `${base.cwd}/stdout.jsonl`, `${base.cwd}/stderr.log`] };
  const discardNativeCleanup = base.discardNativeCleanup
    ? { ...base.discardNativeCleanup, args: [...base.discardNativeCleanup.args,
      `${base.cwd}/stdout.jsonl`, `${base.cwd}/stderr.log`] } : undefined;
  return { ...base, cleanup,
    ...(discardNativeCleanup ? { discardNativeCleanup } : {}),
    stageDetachedRunner, detachedRunnerHash, launch,
    stageAssets: assetBatch.request, assetManifest: assetBatch.manifest,
    readSpool: access.readSpool };
}
