/** Administrative, local-only inspection. No network, Box launch, or journal writes. */
import { isAbsolute } from "node:path";
import { BoxFailureDiagnosticStore } from "../../packages/commercial/src/http/proxy/boxFailureDiagnosticStore.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--directory", "--id", "--uid", "--request-id"].includes(args[i])
      || !args[i + 1] || opts.has(args[i])) throw new Error("arguments");
    opts.set(args[i], args[i + 1]);
  }
  const directory = opts.get("--directory"), id = opts.get("--id");
  const uid = opts.get("--uid"), requestId = opts.get("--request-id");
  if (!directory || !isAbsolute(directory)
    || (id ? opts.size !== 2 || !/^bdiag_[a-f0-9]{24}$/.test(id)
      : opts.size !== 3 || !/^[1-9][0-9]{0,18}$/.test(uid ?? "")
        || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId ?? ""))) throw new Error("arguments");
  const store = new BoxFailureDiagnosticStore(directory);
  const records = id ? [await store.read(id)].filter(x => x !== null)
    : await store.findByRequest(BigInt(uid!), requestId!);
  process.stdout.write(JSON.stringify({ version: 1,
    status: records.length ? "found" : "not_found", records }, null, 2) + "\n");
  // Missing/expired/evicted/unreadable does not prove the execution succeeded.
  if (!records.length) process.exitCode = 3;
}
main().catch(() => {
  process.stderr.write("BOX_DIAGNOSTIC_INSPECT_FAILED: use --directory ABSOLUTE_PATH with --id bdiag_HEX or --uid UID --request-id REQUEST_ID\n");
  process.exitCode = 2;
});
