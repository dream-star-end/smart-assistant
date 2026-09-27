/** One existing selfhost state root, no replay feature-flag maze. */
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { writeBoxReplayMessage,
  type BoxReplayMessageWriter } from "../http/proxy/boxReplayMessageFile.js";

export function createBoxReplayWriter(enabled: boolean,
  platformRoot: string | undefined): BoxReplayMessageWriter | undefined {
  if (!enabled) return undefined;
  if (!platformRoot || !isAbsolute(platformRoot)) {
    throw new Error("BOX_REPLAY_STATE_ROOT_MISSING");
  }
  const directory = join(dirname(normalize(platformRoot)), "box-replay-messages");
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
