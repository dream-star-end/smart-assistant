/**
 * Entry for the commercial pinned box-incident proofs gate.
 *
 * deploy-v5.sh used to invoke tsx on scripts/check-v5-box-incident-proofs.ts.
 * tsx compiled each dynamic import inside main(), and that compile sat inside
 * the 120s deadline. This process transpiles the TypeScript once, then loads
 * the same proof file. The deadline is still the setTimeout at the top of
 * main(); this file does not move it and does not change LIMIT_MS.
 *
 * argv is left intact. The proof reads process.argv.slice(2).
 */
import { register } from "node:module";

const loader = new URL("./lib/boxIncidentProofLoader.mjs", import.meta.url);
await register(loader.href, new URL(".", import.meta.url));
await import(new URL("./check-v5-box-incident-proofs.ts", import.meta.url));
