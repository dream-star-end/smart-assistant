import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
export async function buildBootstrapValidator() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./v5-bootstrap-env-validator.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", minify: true, write: false, logLevel: "silent",
  });
  const bytes = result.outputFiles[0].contents;
  return { sha256: createHash("sha256").update(bytes).digest("hex"),
    compressed: gzipSync(bytes).toString("base64"), size: bytes.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifact = await buildBootstrapValidator();
  process.stdout.write(artifact.sha256 + " " + artifact.compressed + "\n");
}
