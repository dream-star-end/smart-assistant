/**
 * Docker error normalization, supply-chain & slim-image pre-provision guards,
 * placement admission validation, and startup image preheating.
 *
 * Layer: app-container (L4). Zero `process.env`, zero `syncIo`, zero `typeEscape`.
 */
import type Docker from "dockerode";
import { v3MayServe } from "../../channelMigration/channelState.js";
import { AgentAppError } from "../../compute-pool/nodeAgentClient.js";
import { getRuntimeChannel } from "../../runtimeChannel.js";
import { RUNTIME_EMBED_SOURCE_LABEL_KEY } from "../platformBundle.js";
import { SupervisorError } from "../types.js";
import {
  HOST_UUID_CANONICAL_RE,
  type V3ImagePreheatResult,
  type V3SupervisorDeps,
} from "./types.js";

const NODE_AGENT_IMAGE_MISSING_PATTERNS: RegExp[] = [
  /unable to find image/i,
  /pull access denied/i,
  /manifest unknown/i,
  /repository .* not found/i,
  /no such image/i,
];

const NODE_AGENT_HOST_FAULT_PATTERNS: RegExp[] = [
  /address already in use/i,
  /port is already allocated/i,
  /conflict.*container.*already in use/i,
];

const V3_RUNTIME_REQUIRED_FEATURE = "v3-sink";

export type V3ImageGuardMode = "enforce" | "warn" | "off";

export function parseV3ImageGuardMode(raw: string | undefined): V3ImageGuardMode {
  const norm = (raw ?? "").trim().toLowerCase();
  if (norm === "warn") return "warn";
  if (norm === "off") return "off";
  return "enforce";
}

export function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { statusCode?: unknown; httpStatus?: unknown };
  return e.statusCode === 404 || e.httpStatus === 404;
}

export function isNotModified(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode: number }).statusCode === 304
  );
}

export function isNameConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { statusCode?: unknown; httpStatus?: unknown };
  return e.statusCode === 409 || e.httpStatus === 409;
}

function wrapAgentAppError(err: AgentAppError): SupervisorError {
  const message = err.message;
  if (err.agentErrCode === "VOL_CREATE_FAIL") {
    return new SupervisorError("TransientHostFault", message, {
      statusCode: err.httpStatus,
      message,
    });
  }
  if (
    err.agentErrCode === "RUN_FAIL" &&
    NODE_AGENT_IMAGE_MISSING_PATTERNS.some((re) => re.test(message))
  ) {
    return new SupervisorError("ImageNotFound", message, {
      statusCode: err.httpStatus,
      message,
    });
  }
  if (
    err.agentErrCode === "RUN_FAIL" &&
    NODE_AGENT_HOST_FAULT_PATTERNS.some((re) => re.test(message))
  ) {
    return new SupervisorError("TransientHostFault", message, {
      statusCode: err.httpStatus,
      message,
    });
  }
  return new SupervisorError("Unknown", message, {
    statusCode: err.httpStatus,
    message,
  });
}

export function wrapDockerError(err: unknown): SupervisorError {
  if (err instanceof SupervisorError) return err;
  if (err instanceof AgentAppError) return wrapAgentAppError(err);

  const e = err as { statusCode?: number; message?: string; code?: string };
  const message = typeof e.message === "string" ? e.message : String(err);
  if (e.code === "ENOENT" || e.code === "EACCES" || e.code === "ECONNREFUSED") {
    return new SupervisorError("DockerUnavailable", `docker daemon unreachable: ${message}`, {
      message,
    });
  }
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : undefined;
  if (statusCode === 404) {
    if (/No such image/i.test(message) || /image.*not found/i.test(message)) {
      return new SupervisorError("ImageNotFound", message, { statusCode, message });
    }
    return new SupervisorError("NotFound", message, { statusCode, message });
  }
  if (statusCode === 409) {
    return new SupervisorError("NameConflict", message, { statusCode, message });
  }
  if (statusCode === 400) {
    return new SupervisorError("InvalidArgument", message, { statusCode, message });
  }
  return new SupervisorError("Unknown", message, { statusCode, message });
}

export function aggregatePartialV3Cleanup(
  failures: Array<{ stage: "stop" | "remove"; err: SupervisorError }>,
): SupervisorError {
  const stages = failures.map((f) => f.stage).join("+");
  const detail = failures.map((f) => `${f.stage}: ${f.err.message}`).join("; ");
  const firstCause = failures[0]?.err.cause;
  return new SupervisorError(
    "PartialV3Cleanup",
    `v3 container ${stages} failed after DB marked vanished: ${detail}`,
    firstCause,
  );
}

export async function inspectRuntimeImageLabels(
  deps: V3SupervisorDeps,
  hostId: string | undefined,
  image: string,
): Promise<Record<string, string> | null> {
  const resolvedHost = hostId ?? deps.selfHostId ?? "self";
  try {
    if (deps.containerService) {
      const inspected = await deps.containerService.inspectImage(resolvedHost, image);
      return inspected === null ? null : (inspected.labels ?? {});
    }
    try {
      const info = (await deps.docker.getImage(image).inspect()) as {
        Config?: { Labels?: Record<string, string> | null };
      };
      return info.Config?.Labels ?? {};
    } catch (err) {
      if ((err as { statusCode?: number } | null)?.statusCode === 404) return null;
      throw err;
    }
  } catch (err) {
    throw wrapDockerError(err);
  }
}

export async function assertImageHasV3Sink(
  deps: V3SupervisorDeps,
  hostId: string | undefined,
  image: string,
  mode: V3ImageGuardMode,
): Promise<void> {
  if (mode === "off") return;
  const resolvedHost = hostId ?? deps.selfHostId ?? "self";
  const labels = await inspectRuntimeImageLabels(deps, hostId, image);
  if (labels === null) return;

  const featuresRaw = (labels["oc.runtime.features"] ?? "").trim();
  const features = featuresRaw ? featuresRaw.split(/\s+/) : [];
  if (features.includes(V3_RUNTIME_REQUIRED_FEATURE)) return;

  const detail =
    `image=${image} host=${resolvedHost} ` +
    `oc.runtime.features=${JSON.stringify(featuresRaw)} ` +
    `(need token=${V3_RUNTIME_REQUIRED_FEATURE})`;

  if (mode === "warn") {
    console.warn(`[v3supervisor] image guard FAIL but mode=warn, allowing provision: ${detail}`);
    return;
  }
  throw new SupervisorError(
    "ImageOutdated",
    `runtime image missing required feature label: ${detail}`,
  );
}

export async function assertRuntimeSourcePresent(
  deps: V3SupervisorDeps,
  hostId: string | undefined,
  image: string,
  releasePath: string | undefined,
): Promise<void> {
  if (releasePath && releasePath.trim() !== "") return;
  const labels = await inspectRuntimeImageLabels(deps, hostId, image);
  if (labels === null) return;
  const embed = (labels[RUNTIME_EMBED_SOURCE_LABEL_KEY] ?? "").trim();
  if (embed !== "0") return;
  const resolvedHost = hostId ?? deps.selfHostId ?? "self";
  console.error(
    "[v3supervisor] slim image (oc.runtime.embed_source=0) with empty OC_RUNTIME_RELEASE; refusing provision",
    { image, host: resolvedHost },
  );
  throw new SupervisorError(
    "InvalidArgument",
    `slim runtime image (${RUNTIME_EMBED_SOURCE_LABEL_KEY}=0) requires OC_RUNTIME_RELEASE; got empty (image=${image} host=${resolvedHost})`,
  );
}

export function assertV5ReleaseResolvableOrThrow(deps: V3SupervisorDeps): void {
  if (getRuntimeChannel() !== "v5") return;
  const t = deps.runtimeTuple;
  const releaseConfigured = Boolean(t?.releasePath && t.releasePath.trim() !== "");
  if (!releaseConfigured) return;
  const releaseResolved = Boolean(t?.releaseResolvedPath && t.releaseResolvedPath.trim() !== "");
  if (releaseResolved) return;
  console.error(
    "[v3supervisor] OC_RUNTIME_RELEASE configured but failed startup validation; refusing provision (no OPTIONAL escape for release)",
    { releasePath: t!.releasePath },
  );
  throw new SupervisorError(
    "RuntimeReleaseInvalid",
    `runtime release configured but not resolved at startup (release=${t!.releasePath}); check gateway boot logs`,
  );
}

export async function validateProvisionPreflightAndHost(
  deps: V3SupervisorDeps,
  uid: number,
  hostId: string | undefined,
  imageGuardMode: V3ImageGuardMode,
): Promise<{ effectiveHostUuid: string; useRemote: boolean }> {
  if (getRuntimeChannel() === "v3") {
    const gate = await v3MayServe(uid);
    if (!gate.ok) {
      throw new SupervisorError("MigratedToV5", `v3 不再服务该用户(uid=${uid}): ${gate.reason}`);
    }
  }

  const effectiveHostUuid = typeof hostId === "string" ? hostId : (deps.selfHostId ?? "");
  if (!effectiveHostUuid) {
    throw new SupervisorError(
      "InvalidArgument",
      "provisionV3Container requires host context (hostId or deps.selfHostId)",
    );
  }
  if (!HOST_UUID_CANONICAL_RE.test(effectiveHostUuid)) {
    throw new SupervisorError(
      "InvalidArgument",
      `host uuid must be PG canonical lowercase 36-char form, got: ${JSON.stringify(effectiveHostUuid)}`,
    );
  }

  const useRemote =
    typeof deps.selfHostId === "string" &&
    effectiveHostUuid !== deps.selfHostId &&
    deps.containerService !== undefined;

  if (deps.runtimeTuple?.releasePath && useRemote) {
    console.error(
      "[v3supervisor] OC_RUNTIME_RELEASE set but placement is a remote host; refusing provision (release tree is master-local only)",
      { uid, hostId: effectiveHostUuid, selfHostId: deps.selfHostId, releasePath: deps.runtimeTuple.releasePath },
    );
    throw new SupervisorError(
      "RuntimePlacementInvalid",
      `runtime release requires self-host placement; remote host ${effectiveHostUuid} forbidden (release=${deps.runtimeTuple.releasePath})`,
    );
  }

  if (useRemote && getRuntimeChannel() === "v5") {
    throw new SupervisorError(
      "InvalidArgument",
      `v5 channel is local-only; remote host placement forbidden (hostId=${effectiveHostUuid}, selfHostId=${deps.selfHostId})`,
    );
  }

  await assertImageHasV3Sink(deps, hostId, deps.image, imageGuardMode);
  assertV5ReleaseResolvableOrThrow(deps);
  await assertRuntimeSourcePresent(
    deps,
    hostId,
    deps.image,
    deps.runtimeTuple?.releaseResolvedPath,
  );

  return { effectiveHostUuid, useRemote };
}

interface DockerPullClientShape {
  pull?: (
    img: string,
    cb: (err: Error | null, stream: NodeJS.ReadableStream) => void,
  ) => unknown;
  modem?: {
    followProgress?: (s: NodeJS.ReadableStream, cb: (err: Error | null) => void) => void;
  };
}

function pullImageAndFollowProgress(docker: Docker, image: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const client: DockerPullClientShape = docker;
    if (typeof client.pull !== "function" || typeof client.modem?.followProgress !== "function") {
      reject(new Error("docker client missing pull/modem.followProgress"));
      return;
    }
    const followProgress = client.modem.followProgress.bind(client.modem);
    client.pull.call(docker, image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        reject(err);
        return;
      }
      followProgress(stream, (err2: Error | null) => (err2 ? reject(err2) : resolve()));
    });
  });
}

export async function preheatV3Image(
  docker: Docker,
  image: string,
  logger?: { info?: (m: string, meta?: unknown) => void; warn?: (m: string, meta?: unknown) => void },
): Promise<V3ImagePreheatResult> {
  const startedAt = Date.now();
  if (typeof image !== "string" || image.trim() === "") {
    return { image, outcome: "error", error: "image is empty", durationMs: 0 };
  }
  try {
    await docker.getImage(image).inspect();
    const durationMs = Date.now() - startedAt;
    logger?.info?.("[v3 preheat] image already present locally", { image, durationMs });
    return { image, outcome: "already", durationMs };
  } catch (err) {
    if (!isNotFound(err)) {
      const durationMs = Date.now() - startedAt;
      const message = (err as Error)?.message ?? String(err);
      logger?.warn?.("[v3 preheat] image inspect failed; skipping pull", { image, error: message });
      return { image, outcome: "error", error: message, durationMs };
    }
  }
  try {
    await pullImageAndFollowProgress(docker, image);
    const durationMs = Date.now() - startedAt;
    logger?.info?.("[v3 preheat] image pulled", { image, durationMs });
    return { image, outcome: "pulled", durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = (err as Error)?.message ?? String(err);
    logger?.warn?.("[v3 preheat] image pull failed; first provision will pay latency", {
      image,
      error: message,
    });
    return { image, outcome: "error", error: message, durationMs };
  }
}
