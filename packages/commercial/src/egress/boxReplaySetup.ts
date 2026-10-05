/** One existing selfhost state root, no replay feature-flag maze.
 * OCV5-316: the commercial egress and master have no platform state root in
 * their environment. OC_BOX_REPLAY_DIR names the directory itself there; when
 * it is set, it alone decides, and a value that is not a clean absolute path
 * counts as no directory. */
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { readBoxReplayMessage, writeBoxReplayMessage,
  type BoxReplayMessagePointer,
  type BoxReplayMessageWriter } from "../http/proxy/boxReplayMessageFile.js";

export function boxReplayDirectory(platformRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.OC_BOX_REPLAY_DIR;
  if (explicit !== undefined && explicit !== "") {
    return isAbsolute(explicit) && normalize(explicit) === explicit && !explicit.endsWith("/")
      ? explicit : null;
  }
  return platformRoot && isAbsolute(platformRoot)
    ? join(dirname(normalize(platformRoot)), "box-replay-messages") : null;
}

/** Read-only recovery remains available when new Box launches are disabled. */
export function createBoxReplayReader(platformRoot: string | undefined, env: NodeJS.ProcessEnv = process.env):
  ((pointer: BoxReplayMessagePointer) => Promise<unknown>) | undefined {
  const directory = boxReplayDirectory(platformRoot, env);
  return directory ? (pointer) => readBoxReplayMessage(directory, pointer) : undefined;
}

export function createBoxReplayWriter(enabled: boolean, platformRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env): BoxReplayMessageWriter | undefined {
  if (!enabled) return undefined;
  const directory = boxReplayDirectory(platformRoot, env);
  if (!directory) {
    throw new Error("BOX_REPLAY_STATE_ROOT_MISSING");
  }
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(directory);
  if (!info.isDirectory() || typeof process.getuid !== "function"
    || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new Error("BOX_REPLAY_STATE_DIR_INVALID");
  }
  return (identity, message) => writeBoxReplayMessage(directory, identity, message);
}

/** A flag-off recovery worker may finish a previously admitted call, but
 * must not create Box storage on an instance that never enabled the route. */
export function createBoxReplayRecoveryWriter(platformRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env): BoxReplayMessageWriter | undefined {
  const directory = boxReplayDirectory(platformRoot, env);
  return directory && existsSync(directory)
    ? createBoxReplayWriter(true, platformRoot, env) : undefined;
}
