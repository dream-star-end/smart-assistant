/**
 * P1 desktop virtual container feature flags.
 *
 * env 关 → settings 无权打开(fail-closed)。30s TTL cache 热读 system_settings。
 */

import { getSystemSetting } from "../admin/systemSettings.js";

export const DESKTOP_APP_ID = "chat.claudeai.clarvy";
export const DESKTOP_SPIFFE_PREFIX = "spiffe://openclaude/desktop-device/";
export const DESKTOP_TOKEN_TTL_SEC = 3600;
export const DESKTOP_ENROLL_TTL_MS = 10 * 60 * 1000;
export const DESKTOP_PENDING_GLOBAL_CAP = 10_000;
export const DESKTOP_PENDING_IP_CAP = 20;
export const DESKTOP_IDENTITY_PUBLIC_MESSAGE = "container identity verification failed";

const SETTINGS_TTL_MS = 30_000;

export interface DesktopFlagSnapshot {
  /** OC_DESKTOP_VIRTUAL_CONTAINER === "1" */
  envEnabled: boolean;
  /** OC_DESKTOP_KIND_KILLSWITCH === "1" */
  killSwitch: boolean;
  /** system_settings.desktop_virtual_container */
  settingsOn: boolean;
  allowlist: readonly number[];
  /** env on AND settings on */
  assembled: boolean;
}

type SettingsLoader = () => Promise<{ settingsOn: boolean; allowlist: readonly number[] }>;

let cache: { at: number; settingsOn: boolean; allowlist: readonly number[] } | null = null;
let loader: SettingsLoader | null = null;

export function readDesktopEnvFlags(env: NodeJS.ProcessEnv = process.env): {
  envEnabled: boolean;
  killSwitch: boolean;
  simEnroll: boolean;
} {
  return {
    envEnabled: env.OC_DESKTOP_VIRTUAL_CONTAINER === "1",
    killSwitch: env.OC_DESKTOP_KIND_KILLSWITCH === "1",
    simEnroll: env.OC_DESKTOP_SIM_ENROLL === "1" || env.NODE_ENV === "test",
  };
}

export function setDesktopSettingsLoader(fn: SettingsLoader | null): void {
  loader = fn;
  cache = null;
}

export function resetDesktopFlagCache(): void {
  cache = null;
}

async function loadSettings(now: number): Promise<{ settingsOn: boolean; allowlist: readonly number[] }> {
  if (cache && now - cache.at < SETTINGS_TTL_MS) {
    return { settingsOn: cache.settingsOn, allowlist: cache.allowlist };
  }
  const fn = loader ?? defaultLoadSettings;
  const snap = await fn();
  cache = { at: now, settingsOn: snap.settingsOn, allowlist: snap.allowlist };
  return snap;
}

async function defaultLoadSettings(): Promise<{ settingsOn: boolean; allowlist: readonly number[] }> {
  const [flag, list] = await Promise.all([
    getSystemSetting("desktop_virtual_container"),
    getSystemSetting("desktop_allowlist"),
  ]);
  const allowlist = Array.isArray(list.value)
    ? list.value.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  return { settingsOn: flag.value === true, allowlist };
}

export async function getDesktopFlagSnapshot(now = Date.now()): Promise<DesktopFlagSnapshot> {
  const env = readDesktopEnvFlags();
  const settings = env.envEnabled
    ? await loadSettings(now)
    : { settingsOn: false, allowlist: [] as const };
  return {
    envEnabled: env.envEnabled,
    killSwitch: env.killSwitch,
    settingsOn: settings.settingsOn,
    allowlist: settings.allowlist,
    assembled: env.envEnabled && settings.settingsOn,
  };
}

export function isSimEnrollAllowed(platform: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform !== "sim") return true;
  return readDesktopEnvFlags(env).simEnroll;
}

export function isDesktopEntitled(
  uid: number,
  role: string,
  allowlist: readonly number[],
): boolean {
  if (role === "admin") return true;
  return allowlist.includes(uid);
}
