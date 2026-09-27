/** One existing selfhost state root, no replay feature-flag maze. */
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { readBoxReplayMessage, writeBoxReplayMessage,
  type BoxReplayMessagePointer,
  type BoxReplayMessageWriter } from "../http/proxy/boxReplayMessageFile.js";

export function boxReplayDirectory(platformRoot: string | undefined): string | null {
  return platformRoot && isAbsolute(platformRoot)
    ? join(dirname(normalize(platformRoot)), "box-replay-messages") : null;
}

/** Read-only recovery remains available when new Box launches are disabled. */
export function createBoxReplayReader(platformRoot: string | undefined):
  ((pointer: BoxReplayMessagePointer) => Promise<unknown>) | undefined {
  const directory = boxReplayDirectory(platformRoot);
  return directory ? (pointer) => readBoxReplayMessage(directory, pointer) : undefined;
}

export function createBoxReplayWriter(enabled: boolean,
  platformRoot: string | undefined): BoxReplayMessageWriter | undefined {
  if (!enabled) return undefined;
  const directory = boxReplayDirectory(platformRoot);
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
