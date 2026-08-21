/** Commercial builds can hide the taskboard while keeping the shared code/API intact. */
export function taskboardEnabledFromBuildEnv(raw: unknown): boolean {
  return raw !== "0";
}

/** Selfhost/default stays enabled; official commercial deploy sets the flag to 0. */
export const TASKBOARD_ENABLED = taskboardEnabledFromBuildEnv(
  import.meta.env.VITE_TASKBOARD_ENABLED,
);
