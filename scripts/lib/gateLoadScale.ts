/**
 * OCV5-557: release gates scale their wait budgets with host load.
 * The selfhost release computes clamp(load1 / 8, 1, 3) right before a gate runs and passes it
 * as OC_V5_GATE_LOAD_SCALE; the value is written to the train summary. Only waits are scaled,
 * never an assertion, a count or a fake-clock window. A missing or malformed value is 1, and
 * nothing can raise it above 3.
 */
export const GATE_LOAD_SCALE_KEY = "OC_V5_GATE_LOAD_SCALE";
export const GATE_LOAD_SCALE_MAX = 3;

export function gateLoadScale(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[GATE_LOAD_SCALE_KEY];
  if (!raw || !/^[0-9]+(\.[0-9]+)?$/.test(raw)) return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(value, GATE_LOAD_SCALE_MAX);
}

export function scaledMs(ms: number, env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(ms * gateLoadScale(env));
}
