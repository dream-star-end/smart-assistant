/**
 * P0 flavor identity (OCV5-20 §2.7).
 *
 * Production authority is the artifact manifest plus the real hostname and
 * the effector's realpath. Env flags only narrow an already-proven selfhost
 * identity. Test injection is function parameters, never OC_FLAVOR_* env.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FLAVOR_MANIFEST_NAME = "flavor.manifest.json";
export const FLAVOR_RULES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "flavor-rules.json");

export type Flavor = "commercial" | "selfhost";
export type FlavorBuilder = "deploy-v5.sh" | "deploy-v5-selfhost.sh";
export type FlavorEffect =
  | "selfhost-pricing"
  | "selfhost-cursor-egress"
  | "selfhost-migrate-profile"
  | "selfhost-unit-install";

export type FlavorRules = {
  schema: number;
  schemaMustBeInteger: boolean;
  guardGeneration: number;
  requiredFields: string[];
  sourceCommitPattern: string;
  builders: Record<Flavor, FlavorBuilder>;
  selfhostDbName: string;
  selfhostProfile: string;
  egressFlagExact: string;
};

let cachedRules: FlavorRules | null = null;

export function loadFlavorRules(): FlavorRules {
  if (cachedRules) return cachedRules;
  cachedRules = JSON.parse(readFileSync(FLAVOR_RULES_PATH, "utf8")) as FlavorRules;
  return cachedRules;
}

export const FLAVOR_MANIFEST_SCHEMA = loadFlavorRules().schema;
export const SELFHOST_DB_NAME = loadFlavorRules().selfhostDbName;

export interface FlavorManifest {
  schema: number;
  flavor: Flavor;
  sourceCommit: string;
  builder: FlavorBuilder;
  expectedHosts: string[];
  expectedRoots: string[];
  expectedDbNames: string[];
  guardGeneration: number;
}

export class FlavorIdentityError extends Error {
  constructor(message: string) {
    super(`[flavor-identity] ${message}`);
    this.name = "FlavorIdentityError";
  }
}

/** Test-only injection. Production callers must omit these and use real host/root. */
export interface FlavorSignals {
  manifestPath?: string;
  hostname?: string;
  installRoot?: string;
  dbName?: string | null;
  dbProfile?: string | null;
  env?: NodeJS.ProcessEnv;
  dockerenv?: boolean;
  sidecar18992?: boolean;
  required?: boolean;
  generation?: number | null;
  effectorPath?: string;
}

export type FlavorIdentity =
  | { status: "skipped"; reason: "no-manifest" }
  | {
      status: "ok";
      flavor: Flavor;
      manifest: FlavorManifest;
      manifestPath: string;
    };

export function isFlavor(value: unknown): value is Flavor {
  return value === "commercial" || value === "selfhost";
}

export function builderForFlavor(flavor: Flavor): FlavorBuilder {
  return loadFlavorRules().builders[flavor];
}

export function isIntegerSchema(value: unknown, expected: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value === expected;
}

function envExact(env: NodeJS.ProcessEnv, key: string, want: string): boolean {
  return env[key] === want;
}

function pgOptionsHasSelfhostProfile(env: NodeJS.ProcessEnv): boolean {
  const raw = env.PGOPTIONS ?? "";
  return /openclaude\.migration_profile\s*=\s*v5-selfhost(?:\s|$)/.test(raw);
}

export function databaseUrlHasSelfhostProfile(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const decoded = decodeURIComponent(url);
    if (/[?&]options=/.test(url) || /[?&]options=/.test(decoded)) {
      return /openclaude\.migration_profile\s*=\s*v5-selfhost/.test(decoded);
    }
  } catch {
    /* fall through */
  }
  return /openclaude\.migration_profile\s*=\s*v5-selfhost/.test(url);
}

export function profileIsSelfhost(profile: string | null | undefined): boolean {
  return (profile ?? "").trim() === loadFlavorRules().selfhostProfile;
}

export function selfhostElevatingSignals(
  env: NodeJS.ProcessEnv,
  sidecar18992 = false,
): string[] {
  const hits: string[] = [];
  if (envExact(env, "OC_SELFHOST_ENGINE_LOCAL_TURNS", "1")) hits.push("OC_SELFHOST_ENGINE_LOCAL_TURNS");
  if (envExact(env, "SELFHOST_CURSOR_EGRESS", loadFlavorRules().egressFlagExact)) hits.push("SELFHOST_CURSOR_EGRESS");
  if (envExact(env, "OC_SELFHOST_CURSOR_EGRESS", loadFlavorRules().egressFlagExact)) hits.push("OC_SELFHOST_CURSOR_EGRESS");
  if (pgOptionsHasSelfhostProfile(env)) hits.push("PGOPTIONS=v5-selfhost");
  if (databaseUrlHasSelfhostProfile(env.DATABASE_URL)) hits.push("DATABASE_URL options=v5-selfhost");
  if (sidecar18992) hits.push("sidecar-18992");
  return hits;
}

export function parseFlavorManifest(raw: unknown, source = "flavor.manifest.json"): FlavorManifest {
  const rules = loadFlavorRules();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FlavorIdentityError(`${source} is not a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const missing = rules.requiredFields.filter((key) => obj[key] === undefined);
  if (missing.length > 0) {
    throw new FlavorIdentityError(`${source} missing fields: ${missing.join(", ")}`);
  }
  if (!isIntegerSchema(obj.schema, rules.schema)) {
    throw new FlavorIdentityError(
      `${source} schema must be integer ${rules.schema}, got ${JSON.stringify(obj.schema)}`,
    );
  }
  if (!isFlavor(obj.flavor)) {
    throw new FlavorIdentityError(`${source} flavor must be commercial|selfhost`);
  }
  if (typeof obj.sourceCommit !== "string" || !new RegExp(rules.sourceCommitPattern).test(obj.sourceCommit)) {
    throw new FlavorIdentityError(`${source} sourceCommit must be a full 40-hex SHA`);
  }
  const expectedBuilder = builderForFlavor(obj.flavor);
  if (obj.builder !== expectedBuilder) {
    throw new FlavorIdentityError(
      `${source} cross-write refused: flavor=${obj.flavor} requires builder=${expectedBuilder}, got ${String(obj.builder)}`,
    );
  }
  if (!isIntegerSchema(obj.guardGeneration, rules.guardGeneration) && typeof obj.guardGeneration !== "number") {
    throw new FlavorIdentityError(`${source} guardGeneration must be integer ${rules.guardGeneration}`);
  }
  if (!isIntegerSchema(obj.guardGeneration, rules.guardGeneration)) {
    throw new FlavorIdentityError(
      `${source} guardGeneration must be integer ${rules.guardGeneration}, got ${JSON.stringify(obj.guardGeneration)}`,
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

export function findReleaseRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i += 1) {
    if (
      existsSync(path.join(dir, FLAVOR_MANIFEST_NAME))
      || existsSync(path.join(dir, ".complete"))
      || existsSync(path.join(dir, "MANIFEST.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function readArtifactGeneration(root: string | null): number | null {
  if (!root) return null;
  for (const name of [FLAVOR_MANIFEST_NAME, ".complete", "MANIFEST.json"]) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    try {
      const obj = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const gen = obj.guardGeneration ?? obj.flavorGuardGeneration;
      if (typeof gen === "number" && Number.isInteger(gen) && gen >= 1) return gen;
    } catch {
      /* ignore unreadable markers */
    }
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

function hostnameAllowed(hostname: string, expectedHosts: string[]): boolean {
  return expectedHosts.includes(hostname);
}

export function resolveFlavorIdentity(signals: FlavorSignals = {}): FlavorIdentity {
  const env = signals.env ?? process.env;
  const effector = signals.effectorPath
    ?? path.dirname(fileURLToPath(import.meta.url));
  const releaseRoot = findReleaseRoot(signals.installRoot ?? effector);
  const generation = signals.generation ?? readArtifactGeneration(releaseRoot);
  const required = signals.required === true || (generation !== null && generation >= 1);

  let manifestPath: string | null = null;
  if (signals.manifestPath) {
    manifestPath = existsSync(signals.manifestPath) ? signals.manifestPath : null;
  } else if (releaseRoot && existsSync(path.join(releaseRoot, FLAVOR_MANIFEST_NAME))) {
    manifestPath = path.join(releaseRoot, FLAVOR_MANIFEST_NAME);
  }

  if (!manifestPath) {
    if (required) {
      throw new FlavorIdentityError(
        `flavor.manifest.json missing (guardGeneration=${generation ?? "required"})`,
      );
    }
    return { status: "skipped", reason: "no-manifest" };
  }

  const manifest = loadFlavorManifestFile(manifestPath);
  const hostname = signals.hostname ?? osHostname();
  const dockerenv = signals.dockerenv ?? existsSync("/.dockerenv");
  const installRoot = signals.installRoot ?? releaseRoot ?? path.resolve(effector);

  if (!pathMatchesExpectedRoot(installRoot, manifest.expectedRoots)) {
    throw new FlavorIdentityError(
      `install root ${installRoot} is not under expectedRoots=${manifest.expectedRoots.join(",")}`,
    );
  }

  if (hostnameAllowed(hostname, manifest.expectedHosts)) {
    /* host positive proof */
  } else if (dockerenv) {
    const otherHosts = manifest.flavor === "selfhost"
      ? ["kl-mirror", "ser135234097086"]
      : ["v3-dev-sg"];
    if (otherHosts.includes(hostname)) {
      throw new FlavorIdentityError(
        `container hostname ${hostname} belongs to the other flavor (manifest=${manifest.flavor})`,
      );
    }
    if (!pathMatchesExpectedRoot(installRoot, manifest.expectedRoots)) {
      throw new FlavorIdentityError(`container install root failed host/root proof`);
    }
  } else {
    throw new FlavorIdentityError(
      `hostname ${hostname} is not in expectedHosts=${manifest.expectedHosts.join(",")}`,
    );
  }

  const sidecar = signals.sidecar18992 ?? false;
  const elevating = selfhostElevatingSignals(env, sidecar);
  if (profileIsSelfhost(signals.dbProfile)) elevating.push("session-profile=v5-selfhost");
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
  const selfhostDb = loadFlavorRules().selfhostDbName;
  if (manifest.flavor === "selfhost") {
    if (dbName !== selfhostDb || !manifest.expectedDbNames.includes(dbName)) {
      throw new FlavorIdentityError(
        `selfhost migrate db must be ${selfhostDb}, got ${dbName}`,
      );
    }
    return;
  }
  if (dbName === selfhostDb) {
    throw new FlavorIdentityError(`commercial migrate refuses selfhost db ${selfhostDb}`);
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
    const want = loadFlavorRules().egressFlagExact;
    if (env.SELFHOST_CURSOR_EGRESS !== want && env.OC_SELFHOST_CURSOR_EGRESS !== want) {
      throw new FlavorIdentityError(`selfhost-cursor-egress requires SELFHOST_CURSOR_EGRESS=${want}`);
    }
  }
  return identity;
}

export async function assertFlavorForMigrate(
  signals: FlavorSignals = {},
  querySession?: () => Promise<{ dbName: string; dbProfile: string }>,
): Promise<FlavorIdentity> {
  const env = signals.env ?? process.env;
  const identity = assertFlavorIdentity({ ...signals, env });
  if (identity.status === "skipped") return identity;
  let dbName = signals.dbName ?? null;
  let dbProfile = signals.dbProfile ?? null;
  if ((dbName === null || dbProfile === null) && querySession) {
    const session = await querySession();
    dbName = dbName ?? session.dbName;
    dbProfile = dbProfile ?? session.dbProfile;
  }
  if (!dbName) {
    throw new FlavorIdentityError("migrate requires current_database() before any DDL");
  }
  if (dbProfile === null) {
    throw new FlavorIdentityError("migrate requires current_setting(openclaude.migration_profile) before any DDL");
  }
  assertDbName(identity.manifest, dbName);
  if (identity.flavor === "commercial" && profileIsSelfhost(dbProfile)) {
    throw new FlavorIdentityError("commercial migrate refuses session profile v5-selfhost");
  }
  if (identity.flavor === "selfhost" && !profileIsSelfhost(dbProfile)) {
    throw new FlavorIdentityError(
      `selfhost migrate requires session profile v5-selfhost, got ${JSON.stringify(dbProfile)}`,
    );
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
    schema: loadFlavorRules().schema,
    flavor: input.flavor,
    sourceCommit: input.sourceCommit,
    builder: builderForFlavor(input.flavor),
    expectedHosts: input.expectedHosts,
    expectedRoots: input.expectedRoots,
    expectedDbNames: input.expectedDbNames,
    guardGeneration: loadFlavorRules().guardGeneration,
  });
}
