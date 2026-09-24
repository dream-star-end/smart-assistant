/** Offline assembly for a detached supervised Box tool invocation. It is not
 * a production route until actual Box cgroup survival and multi-round replay
 * fences pass. OpenClaude owns agent execution, tools, memory and Skills. */
import { createHash } from "node:crypto";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { ProxyBody } from "./shared.js";
import { makeBoxAssetStage } from "./boxTextPlan.js";
import { makeBoxToolPlan, type BoxToolPlan } from "./boxToolPlan.js";

const PYTHON = "/usr/bin/python3";
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
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
}): BoxDetachedToolPlan {
  const { detachedRunnerAsset, ...toolInput } = input;
  const base = makeBoxToolPlan(toolInput);
  const detachedRunnerHash = createHash("sha256").update(detachedRunnerAsset).digest("hex");
  const runnerPath = `/tmp/ocv5-289-detached-runner-${detachedRunnerHash.slice(0, 16)}.py`;
  const stageDetachedRunner = makeBoxAssetStage(detachedRunnerAsset, runnerPath).request;
  const launch: BoxCcExecRequest = { command: PYTHON,
    args: [runnerPath, base.cwd, base.run.args[0]!, base.run.args[1]!,
      ...base.run.args.slice(2)], cwd: base.cwd,
    environment: base.run.environment };
  const readSpool = (offset: number, limit = 65536): BoxCcExecRequest => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 8 * 1024 * 1024
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536) {
      throw new Error("BOX_SPOOL_READ_INVALID");
    }
    return { command: PYTHON, args: [runnerPath, "--read", base.cwd,
      String(offset), String(limit)], cwd: "/tmp", environment: ENV };
  };
  // Only after nonce/epoch-bound remote terminal proof: stdout/stderr contain
  // model output and must be removed with the private input/catalog files.
  const cleanup: BoxCcExecRequest = { ...base.cleanup,
    args: [...base.cleanup.args, `${base.cwd}/stdout.jsonl`, `${base.cwd}/stderr.log`] };
  return { ...base, cleanup, stageDetachedRunner, detachedRunnerHash, launch, readSpool };
}
