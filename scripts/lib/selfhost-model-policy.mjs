import { readFileSync } from "node:fs";

export function readSelfhostModelPolicy(file = new URL("../../deploy/v5-selfhost/model-availability.json", import.meta.url)) {
  const policy = JSON.parse(readFileSync(file, "utf8"));
  if (!policy || typeof policy.grokEnabled !== "boolean") throw new Error("Selfhost model policy requires boolean grokEnabled");
  return policy;
}
