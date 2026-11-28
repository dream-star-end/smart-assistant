/**
 * Pure container environment builders and whitelist validators for V3/V5 containers.
 *
 * Layer: app-container (L4). Zero `process.env`, zero `syncIo`, zero `interface-http` imports.
 */
import type { Cc5PreparedContainer } from "@openclaude/gateway/cc5-container-runtime";
import { assertFlavorIdentity, FlavorIdentityError } from "../../flavor/assertFlavor.js";
import {
  OPENCLAUDE_DEFAULT_WORKSPACE_VALUE,
  OPENCLAUDE_PLATFORM_PROMPTS_DIR_VALUE,
  OPENCLAUDE_WEB_CONTEXT_BIN_VALUE,
} from "../platformBundle.js";
import { SYNTHETIC_EVAL_PROMPTS_BIND_TARGET } from "../syntheticEvalOverlayRuntime.js";
import { SupervisorError } from "../types.js";
import {
  DELEGATE_KNOB_CONTAINER_ENV_KEYS,
  V3_CODEX_LOCAL_RELAY_ORIGIN,
  type V3SupervisorDeps,
  type V5LocalCcbTransportEnvInput,
} from "./types.js";

const LEGACY_CODEX_CONTAINER_ENV_KEYS = [
  "OC_CODEX_MODEL_PROVIDER",
  "OC_CODEX_PROVIDER_NAME",
  "OC_CODEX_BASE_URL",
  "OC_CODEX_WIRE_API",
  "OC_CODEX_PREFERRED_AUTH_METHOD",
  "OC_CODEX_DISABLE_RESPONSE_STORAGE",
] as const;

const LOCAL_RELAY_CODEX_CONTAINER_ENV_KEYS = [
  "OC_CODEX_MODEL_PROVIDER",
  "OC_CODEX_PROVIDER_NAME",
  "OC_CODEX_WIRE_API",
  "OC_CODEX_PREFERRED_AUTH_METHOD",
  "OC_CODEX_DISABLE_RESPONSE_STORAGE",
] as const;

export function resolveV5LocalCcbTransportEnv(
  input: V5LocalCcbTransportEnvInput,
): string[] {
  if (input.runtimeChannel !== "v5" || input.useRemote) return [];

  const proxy = input.proxyUrl?.trim();
  if (!proxy) return [];

  let parsed: URL;
  try {
    parsed = new URL(proxy);
  } catch {
    throw new SupervisorError("InvalidArgument", "OC_CLAUDE_CODE_HTTPS_PROXY must be a valid URL");
  }
  const invalidProtocol = parsed.protocol !== "http:" && parsed.protocol !== "https:";
  const hasCredentials = Boolean(parsed.username || parsed.password);
  const invalidPath = parsed.pathname !== "" && parsed.pathname !== "/";
  if (invalidProtocol || hasCredentials || !parsed.hostname || invalidPath || parsed.search || parsed.hash) {
    throw new SupervisorError(
      "InvalidArgument",
      "OC_CLAUDE_CODE_HTTPS_PROXY must be a credential-free http(s) origin",
    );
  }

  const noProxy = Array.from(
    new Set(
      [
        ...(input.noProxy ?? "").split(","),
        "localhost",
        "127.0.0.1",
        "::1",
        input.hostGatewayIp,
      ]
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ).join(",");

  return [
    `OPENCLAUDE_CCB_HTTPS_PROXY=${parsed.toString().replace(/\/$/, "")}`,
    `OPENCLAUDE_CCB_NO_PROXY=${noProxy}`,
  ];
}

export function resolveUserTimeZoneEnv(raw: string | undefined): string[] {
  const tz = raw?.trim() ?? "";
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return [];
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format();
  } catch {
    return [];
  }
  return [`OC_USER_TZ=${tz}`];
}

export function isCodexLocalRelayEnabledFromEnv(sourceEnv: NodeJS.ProcessEnv): boolean {
  const raw = sourceEnv.OC_V3_CODEX_LOCAL_RELAY_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function buildCodexRelayContainerEnvWithDeps(
  sourceEnv: NodeJS.ProcessEnv,
  resolveLocalRelayBaseUrl: (origin: string, env: NodeJS.ProcessEnv) => string,
): string[] {
  const out: string[] = [];

  if (!isCodexLocalRelayEnabledFromEnv(sourceEnv)) {
    if (!sourceEnv.OC_CODEX_MODEL_PROVIDER?.trim()) return out;
    for (const key of LEGACY_CODEX_CONTAINER_ENV_KEYS) {
      const value = sourceEnv[key]?.trim();
      if (value) out.push(`${key}=${value}`);
    }
    if (!sourceEnv.OC_CODEX_BASE_URL?.trim()) {
      const dedicatedUpstream = sourceEnv.OC_CODEX_UPSTREAM_BASE_URL?.trim();
      if (dedicatedUpstream) out.push(`OC_CODEX_BASE_URL=${dedicatedUpstream}`);
    }
    return out;
  }

  const mdlProvider = sourceEnv.OC_CODEX_MODEL_PROVIDER?.trim();
  if (!mdlProvider) return out;

  out.push(`OC_CODEX_MODEL_PROVIDER=${mdlProvider}`);
  for (const key of LOCAL_RELAY_CODEX_CONTAINER_ENV_KEYS) {
    if (key === "OC_CODEX_MODEL_PROVIDER") continue;
    const value = sourceEnv[key]?.trim();
    if (value) out.push(`${key}=${value}`);
  }

  out.push(`OC_CODEX_BASE_URL=${resolveLocalRelayBaseUrl(V3_CODEX_LOCAL_RELAY_ORIGIN, sourceEnv)}`);
  return out;
}

export function buildDelegateKnobContainerEnvFromEnv(sourceEnv: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const key of DELEGATE_KNOB_CONTAINER_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value && /^[0-9]+$/.test(value)) out.push(`${key}=${value}`);
  }
  return out;
}

/** `OC_ADVISOR_OPEN_ENGINES=<list>` for the container, or null. Only `codex` is a known advisor engine. */
export function advisorOpenEnginesEnv(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const engines = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (engines.length === 0 || engines.some((e) => e !== "codex")) return null;
  return `OC_ADVISOR_OPEN_ENGINES=${[...new Set(engines)].join(",")}`;
}

export interface ModelAuthorityContainerEnvInput {
  modelAuthority: NonNullable<V3SupervisorDeps["modelAuthority"]>;
  uid: number;
  promptQueueEnabled: boolean;
  cc5Prepared: Cc5PreparedContainer | null;
  cc5KeyringAssignment: string | undefined;
  selfhostEngineLocalTurns: string | undefined;
  advisorOpenEnginesRaw: string | undefined;
}

export function appendModelAuthorityContainerEnv(
  env: string[],
  input: ModelAuthorityContainerEnvInput,
): void {
  const keyringAssignment = input.modelAuthority.keyringEnvAssignment;
  env.push(
    input.cc5KeyringAssignment ??
      (typeof keyringAssignment === "function" ? keyringAssignment() : keyringAssignment),
  );
  if (input.cc5Prepared) {
    env.push(
      "OC_SELFHOST_CC5_T1555U_ENABLED=1",
      `OC_SELFHOST_CC5_T1555U_TEST_UID=${input.uid}`,
    );
  }
  if (!input.promptQueueEnabled) {
    env.push(`OC_USER_ID=${String(input.uid)}`);
  }
  if (input.modelAuthority.required) {
    env.push("OC_MODEL_AUTHORITY=1");
  }
  if (input.selfhostEngineLocalTurns === "1") {
    try {
      assertFlavorIdentity();
    } catch (err) {
      if (err instanceof FlavorIdentityError) {
        throw new SupervisorError(
          "InvalidArgument",
          `selfhost engine-local-turn env refused: ${err.message}`,
        );
      }
      throw err;
    }
    env.push("OC_SELFHOST_ENGINE_LOCAL_TURNS=1");
  }
  const advisorOpen = advisorOpenEnginesEnv(input.advisorOpenEnginesRaw);
  if (advisorOpen) env.push(advisorOpen);
  for (const aux of input.modelAuthority.auxModels ?? []) {
    env.push(`OPENCLAUDE_SECONDARY_MODEL=${aux}`);
    break;
  }
}

export function appendPlatformTupleAndOverlayEnv(
  env: string[],
  opts: {
    injectPlatformEnv: boolean;
    injectedBundleRev: string;
    hasSyntheticEvalOverlay: boolean;
    injectReleaseEnv: boolean;
  },
): void {
  if (opts.injectPlatformEnv) {
    env.push(
      `OPENCLAUDE_PLATFORM_PROMPTS_DIR=${OPENCLAUDE_PLATFORM_PROMPTS_DIR_VALUE}`,
      `OPENCLAUDE_WEB_CONTEXT_BIN=${OPENCLAUDE_WEB_CONTEXT_BIN_VALUE}`,
      `OC_PLATFORM_BUNDLE_REV=${opts.injectedBundleRev}`,
    );
  }
  if (opts.hasSyntheticEvalOverlay) {
    const prefix = "OPENCLAUDE_PLATFORM_PROMPTS_DIR=";
    const existing = env.findIndex((item) => item.startsWith(prefix));
    if (existing >= 0) env.splice(existing, 1);
    env.push(`OPENCLAUDE_PLATFORM_PROMPTS_DIR=${SYNTHETIC_EVAL_PROMPTS_BIND_TARGET}`);
  }
  if (opts.injectReleaseEnv) {
    env.push(`OPENCLAUDE_DEFAULT_WORKSPACE=${OPENCLAUDE_DEFAULT_WORKSPACE_VALUE}`);
  }
}
