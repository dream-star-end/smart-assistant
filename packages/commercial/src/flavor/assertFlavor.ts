/**
 * P0 flavor identity (OCV5-20 §2.7).
 *
 * Authority is the immutable artifact manifest plus host/root/(migrate) DB
 * evidence. Env flags may only narrow an already-proven selfhost identity;
 * they must never upgrade commercial → selfhost. Missing manifest is a
 * no-op so current artifacts keep working until the first pack that writes
 * flavor.manifest.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import path from "node:path";

export const FLAVOR_MANIFEST_SCHEMA = 1;
export const FLAVOR_MANIFEST_NAME = "flavor.manifest.json";
export const SELFHOST_DB_NAME = "openclaude_v5_selfhost";

export type Flavor = "commercial" | "selfhost";
export type FlavorBuilder = "deploy-v5.sh" | "deploy-v5-selfhost.sh";
export type FlavorEffect =
  | "selfhost-pricing"
  | "selfhost-cursor-egress"
  | "selfhost-migrate-profile"
  | "selfhost-unit-install";

export interface FlavorManifest {
  schema: number;
  flavor: Flavor;
  sourceCommit: string;
  builder: FlavorBuilder;
  expectedHosts: string[];
  expectedRoots: string[];
  expectedDbNames: string[];
}

export class FlavorIdentityError extends Error {
  constructor(message: string) {
    super(`[flavor-identity] ${message}`);
    this.name = "FlavorIdentityError";
  }
}

export interface FlavorSignals {
  manifestPath?: string;
  hostname?: string;
  installRoot?: string;
  dbName?: string | null;
  env?: NodeJS.ProcessEnv;
  dockerenv?: boolean;
  sidecar18992?: boolean;
  required?: boolean;
}

export type FlavorIdentity =
  | { status: "skipped"; reason: "no-manifest" }
  | {
      status: "ok";
      flavor: Flavor;
      manifest: FlavorManifest;
      manifestPath: string;
    };

const BUILDER_FOR: Record<Flavor, FlavorBuilder> = {
  commercial: "deploy-v5.sh",
  selfhost: "deploy-v5-selfhost.sh",
};

const SELFHOST_ENV_KEYS = [
  "OC_SELFHOST_ENGINE_LOCAL_TURNS",
  "SELFHOST_CURSOR_EGRESS",
  "OC_SELFHOST_CURSOR_EGRESS",
];

export function isFlavor(value: unknown): value is Flavor {
  return value === "commercial" || value === "selfhost";
}

export function builderForFlavor(flavor: Flavor): FlavorBuilder {
  return BUILDER_FOR[flavor];
}

function envFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = env[key];
  return raw !== undefined && raw !== "";
}

function pgOptionsHasSelfhostProfile(env: NodeJS.ProcessEnv): boolean {
  const raw = env.PGOPTIONS ?? "";
  return /openclaude\.migration_profile\s*=\s*v5-selfhost(?:\s|$)/.test(raw);
}

export function selfhostElevatingSignals(env: NodeJS.ProcessEnv, sidecar18992 = false): string[] {
  const hits: string[] = [];
  for (const key of SELFHOST_ENV_KEYS) {
    if (envFlag(env, key)) hits.push(key);
  }
  if (pgOptionsHasSelfhostProfile(env)) hits.push("PGOPTIONS=v5-selfhost");
  if (sidecar18992) hits.push("sidecar-18992");
  return hits;
}

export function parseFlavorManifest(raw: unknown, source = "flavor.manifest.json"): FlavorManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FlavorIdentityError(`${source} is not a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const missing = [
    "schema",
    "flavor",
    "sourceCommit",
    "builder",
    "expectedHosts",
    "expectedRoots",
    "expectedDbNames",
  ].filter((key) => obj[key] === undefined);
  if (missing.length > 0) {
    throw new FlavorIdentityError(`${source} missing fields: ${missing.join(", ")}`);
  }
  if (obj.schema !== FLAVOR_MANIFEST_SCHEMA) {
    throw new FlavorIdentityError(`${source} schema must be ${FLAVOR_MANIFEST_SCHEMA}, got ${String(obj.schema)}`);
  }
  if (!isFlavor(obj.flavor)) {
    throw new FlavorIdentityError(`${source} flavor must be commercial|selfhost`);
  }
  if (typeof obj.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(obj.sourceCommit)) {
    throw new FlavorIdentityError(`${source} sourceCommit must be a full 40-hex SHA`);
  }
  const expectedBuilder = builderForFlavor(obj.flavor);
  if (obj.builder !== expectedBuilder) {
    throw new FlavorIdentityError(
      `${source} cross-write refused: flavor=${obj.flavor} requires builder=${expectedBuilder}, got ${String(obj.builder)}`,
    );
  }
  for (const key of ["expectedHosts", "expectedRoots", "expectedDbNames"] as const) {
    if (!Array.isArray(obj[key]) || obj[key].length === 0 || obj[key].some((item) => typeof item !== "string" || !item)) {
      throw new FlavorIdentityError(`${source} ${key} must be a non-empty string array`);
    }
  }
  return obj as unknown as FlavorManifest;
}

export function loadFlavorManifestFile(manifestPath: string): FlavorManifest {
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new FlavorIdentityError(`manifest missing: ${manifestPath}`);
    }
    throw new FlavorIdentityError(`manifest unreadable: ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FlavorIdentityError(`manifest not JSON: ${manifestPath}`);
  }
  return parseFlavorManifest(parsed, manifestPath);
}

function defaultInstallRoot(env: NodeJS.ProcessEnv): string {
  return env.OC_FLAVOR_INSTALL_ROOT
    || env.OC_RUNTIME_RELEASE
    || process.cwd();
}

export function candidateManifestPaths(signals: FlavorSignals = {}): string[] {
  const env = signals.env ?? process.env;
  const installRoot = signals.installRoot ?? defaultInstallRoot(env);
  const out: string[] = [];
  const add = (p?: string) => {
    if (p && !out.includes(p)) out.push(p);
  };
  add(signals.manifestPath);
  add(env.OC_FLAVOR_MANIFEST);
  add(path.join(process.cwd(), FLAVOR_MANIFEST_NAME));
  if (installRoot) add(path.join(installRoot, FLAVOR_MANIFEST_NAME));
  if (env.OC_RUNTIME_RELEASE) add(path.join(env.OC_RUNTIME_RELEASE, FLAVOR_MANIFEST_NAME));
  if (env.OC_PLATFORM_ROOT) add(path.join(env.OC_PLATFORM_ROOT, FLAVOR_MANIFEST_NAME));
  return out;
}

function findManifestPath(signals: FlavorSignals = {}): string | null {
  if (signals.manifestPath) {
    return existsSync(signals.manifestPath) ? signals.manifestPath : null;
  }
  for (const candidate of candidateManifestPaths(signals)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function pathMatchesExpectedRoot(installRoot: string, expectedRoots: string[]): boolean {
  const normalized = path.resolve(installRoot);
  for (const root of expectedRoots) {
    const expected = path.resolve(root);
    if (normalized === expected) return true;
    if (normalized === `${expected}-live`) return true;
    if (normalized.startsWith(`${expected}/`)) return true;
    if (normalized.startsWith(`${expected}-releases/`)) return true;
    if (normalized.startsWith(`${expected}-live/`)) return true;
  }
  return false;
}

function hostnameAllowed(hostname: string, expectedHosts: string[], env: NodeJS.ProcessEnv): boolean {
  const allowed = new Set(expectedHosts.filter(Boolean));
  if (env.KL_HOST) allowed.add(env.KL_HOST);
  return allowed.has(hostname);
}

export function resolveFlavorIdentity(signals: FlavorSignals = {}): FlavorIdentity {
  const env = signals.env ?? process.env;
  const required = signals.required ?? env.OC_FLAVOR_GUARD_REQUIRED === "1";
  const manifestPath = findManifestPath(signals);
  if (!manifestPath) {
    if (required) {
      throw new FlavorIdentityError("flavor.manifest.json missing (OC_FLAVOR_GUARD_REQUIRED=1)");
    }
    return { status: "skipped", reason: "no-manifest" };
  }
  const manifest = loadFlavorManifestFile(manifestPath);
  const hostname = signals.hostname ?? env.OC_FLAVOR_HOSTNAME ?? osHostname();
  const dockerenv = signals.dockerenv
    ?? (env.OC_FLAVOR_DOCKERENV === "1" ? true
      : env.OC_FLAVOR_DOCKERENV === "0" ? false
        : existsSync("/.dockerenv"));
  const otherFlavorHosts = manifest.flavor === "selfhost"
    ? ["kl-mirror", "ser135234097086"]
    : ["v3-dev-sg"];
  if (!dockerenv) {
    if (!hostnameAllowed(hostname, manifest.expectedHosts, env)) {
      throw new FlavorIdentityError(
        `hostname ${hostname} is not in expectedHosts=${manifest.expectedHosts.join(",")}`,
      );
    }
  } else if (otherFlavorHosts.includes(hostname)) {
    throw new FlavorIdentityError(
      `container hostname ${hostname} belongs to the other flavor (manifest=${manifest.flavor})`,
    );
  }
  const installRoot = signals.installRoot ?? defaultInstallRoot(env);
  if (!pathMatchesExpectedRoot(installRoot, manifest.expectedRoots)) {
    throw new FlavorIdentityError(
      `install root ${installRoot} is not under expectedRoots=${manifest.expectedRoots.join(",")}`,
    );
  }
  const sidecar = signals.sidecar18992 ?? false;
  const elevating = selfhostElevatingSignals(env, sidecar);
  if (manifest.flavor === "commercial" && elevating.length > 0) {
    throw new FlavorIdentityError(
      `commercial identity cannot be upgraded by ${elevating.join(", ")}`,
    );
  }
  if (signals.dbName) {
    assertDbName(manifest, signals.dbName);
  }
  return { status: "ok", flavor: manifest.flavor, manifest, manifestPath };
}

function assertDbName(manifest: FlavorManifest, dbName: string): void {
  if (manifest.flavor === "selfhost") {
    if (dbName !== SELFHOST_DB_NAME || !manifest.expectedDbNames.includes(dbName)) {
      throw new FlavorIdentityError(
        `selfhost migrate db must be ${SELFHOST_DB_NAME}, got ${dbName}`,
      );
    }
    return;
  }
  if (dbName === SELFHOST_DB_NAME) {
    throw new FlavorIdentityError(`commercial migrate refuses selfhost db ${SELFHOST_DB_NAME}`);
  }
  if (!manifest.expectedDbNames.includes(dbName)) {
    throw new FlavorIdentityError(
      `commercial db ${dbName} not in expectedDbNames=${manifest.expectedDbNames.join(",")}`,
    );
  }
}

export function assertFlavorIdentity(signals: FlavorSignals = {}): FlavorIdentity {
  return resolveFlavorIdentity(signals);
}

export function assertAllows(effect: FlavorEffect, signals: FlavorSignals = {}): FlavorIdentity {
  const identity = assertFlavorIdentity(signals);
  if (identity.status === "skipped") return identity;
  if (identity.flavor !== "selfhost") {
    throw new FlavorIdentityError(`effect ${effect} is forbidden for flavor=${identity.flavor}`);
  }
  if (effect === "selfhost-cursor-egress") {
    const env = signals.env ?? process.env;
    const flagged = envFlag(env, "SELFHOST_CURSOR_EGRESS") || envFlag(env, "OC_SELFHOST_CURSOR_EGRESS");
    if (!flagged) {
      throw new FlavorIdentityError("selfhost-cursor-egress requires SELFHOST_CURSOR_EGRESS=1");
    }
  }
  return identity;
}

export async function assertFlavorForMigrate(
  signals: FlavorSignals = {},
  queryDbName?: () => Promise<string>,
): Promise<FlavorIdentity> {
  const env = signals.env ?? process.env;
  const identity = assertFlavorIdentity({ ...signals, env });
  if (identity.status === "skipped") return identity;
  let dbName = signals.dbName ?? null;
  if (!dbName && queryDbName) {
    dbName = await queryDbName();
  }
  if (!dbName) {
    throw new FlavorIdentityError("migrate requires current_database() before any DDL");
  }
  assertDbName(identity.manifest, dbName);
  if (pgOptionsHasSelfhostProfile(env)) {
    assertAllows("selfhost-migrate-profile", { ...signals, env, dbName });
  }
  return identity;
}

export function buildFlavorManifest(input: {
  flavor: Flavor;
  sourceCommit: string;
  expectedHosts: string[];
  expectedRoots: string[];
  expectedDbNames: string[];
}): FlavorManifest {
  return parseFlavorManifest({
    schema: FLAVOR_MANIFEST_SCHEMA,
    flavor: input.flavor,
    sourceCommit: input.sourceCommit,
    builder: builderForFlavor(input.flavor),
    expectedHosts: input.expectedHosts,
    expectedRoots: input.expectedRoots,
    expectedDbNames: input.expectedDbNames,
  });
}
