/** Reuse the already-proven detached runner/spool for no-tool text turns.
 * Private input staging and native CLI cwd remain the BoxTextPlan's work;
 * a terminal-proof cleanup must use the shared idempotent run cleanup. */
import { createHash } from "node:crypto";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import { makeBoxAssetsStage, makeBoxAssetStage,
  makeBoxTextPlan, type BoxTextPlan } from "./boxTextPlan.js";
import { makeBoxDetachedRunAccess, makeBoxPinnedRunnerRequest } from "./boxDetachedRunAccess.js";

export interface BoxDetachedTextPlan {
  readonly text: Omit<BoxTextPlan, "cleanup" | "discardNativeCleanup">;
  /** Safe only before the durable paid launch permit; after launch use the
   * idempotent, terminal-proof-gated makeBoxRunCleanup instead. */
  readonly prelaunchCleanup: BoxCcExecRequest;
  readonly detachedRunnerHash: string;
  readonly stageDetachedRunner: BoxCcExecRequest;
  readonly stageAssets: BoxCcExecRequest;
  readonly assetManifest: string;
  readonly launch: BoxCcExecRequest;
  readSpool(offset: number, limit?: number): BoxCcExecRequest;
}

export function makeBoxDetachedTextPlan(input: Parameters<typeof makeBoxTextPlan>[0] & {
  detachedRunnerAsset: Buffer;
}): BoxDetachedTextPlan {
  const { detachedRunnerAsset, ...textInput } = input;
  const text = makeBoxTextPlan(textInput);
  const detachedRunnerHash = createHash("sha256").update(detachedRunnerAsset).digest("hex");
  const access = makeBoxDetachedRunAccess({ runNonce: text.runNonce,
    detachedRunnerHash });
  const stageDetachedRunner = makeBoxAssetStage(detachedRunnerAsset,
    access.runnerPath).request;
  const assets = makeBoxAssetsStage([
    { asset: input.supervisorAsset, path: text.stageSupervisor.args[3]! },
    { asset: input.keeperAsset, path: text.stageKeeper.args[3]! },
    { asset: detachedRunnerAsset, path: access.runnerPath },
  ]);
  if (text.run.args[0] !== "-I") {
    throw new Error("BOX_DETACHED_PYTHON_ISOLATION_MISSING");
  }
  const runnerArgs = [text.cwd, ...text.run.args.slice(1, 3),
    ...(text.cliCwd === text.cwd ? [] : ["--cli-cwd", text.cliCwd]),
    ...text.run.args.slice(3)];
  const launch = makeBoxPinnedRunnerRequest({ runnerPath: access.runnerPath,
    detachedRunnerHash, args: runnerArgs, cwd: text.cwd,
    environment: text.run.environment });
  const { cleanup, discardNativeCleanup, ...textCore } = text;
  // A newly minted native project has no paid transcript before permit.
  // Remove the staged synthetic history too; the keep variant would leave it.
  const prelaunchCleanup = discardNativeCleanup ?? cleanup;
  return { text: textCore, prelaunchCleanup,
    detachedRunnerHash, stageDetachedRunner,
    stageAssets: assets.request, assetManifest: assets.manifest,
    launch, readSpool: access.readSpool };
}
