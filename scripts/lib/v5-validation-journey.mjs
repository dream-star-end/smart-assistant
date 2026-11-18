import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_JOURNEY_MODEL_ID = "grok-build";
const PROFILE_HELPER = fileURLToPath(new URL("./v5-validation-profile.py", import.meta.url));

/** Select once, before credentials, tunnels or browser work. No environment override. */
export function selectJourneyValidation(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("invalid journey arguments");
  }
  if (args.length === 0) return { model: DEFAULT_JOURNEY_MODEL_ID, scope: null };
  const prefix = "--validation-scope=";
  if (args.length !== 1 || !args[0].startsWith(prefix)) {
    throw new Error("expected only --validation-scope=<base64 canonical JSON>");
  }
  const encoded = args[0].slice(prefix.length);
  if (!encoded || encoded.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("invalid validation scope base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("invalid validation scope base64");
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid validation scope JSON");
  }
  if (!value || Array.isArray(value) || ["sourceSha", "queueId", "operationId"].some(
    (key) => typeof value[key] !== "string" || !value[key].trim(),
  )) {
    throw new Error("validation scope requires bound source, queue and operation");
  }
  let canonical;
  try {
    canonical = execFileSync("python3", [PROFILE_HELPER, "validate",
      `--source-sha=${value.sourceSha}`, `--queue-id=${value.queueId}`,
      `--operation-id=${value.operationId}`], {
      input: text, encoding: "utf8", timeout: 5_000, maxBuffer: 32_768,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("validation scope rejected by profile validator");
  }
  if (text !== canonical) throw new Error("validation scope must use canonical JSON");
  const scope = JSON.parse(canonical);
  if (scope.profile !== "skip-grok" || scope.journeyModel !== "deepseek-v4-flash") {
    throw new Error("unsupported journey validation scope");
  }
  return { model: scope.journeyModel, scope };
}
