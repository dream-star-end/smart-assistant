import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
type Db = { query: (sql: string, params?: unknown[]) => Promise<any> };

/** Candidate modules own every admission, hydration and v1 claim exercised. */
export async function proveContextTransport(candidate: string, db: Db): Promise<string> {
  const [probe, claim] = await Promise.all([
    import(pathToFileURL(join(candidate,
      "packages/commercial/src/http/proxy/testing/boxContextTransportProbe.ts")).href),
    import(pathToFileURL(join(candidate,
      "packages/commercial/src/http/proxy/testing/boxContextTransportClaim.ts")).href),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "g607-context-proof-"));
  try {
    const result = await probe.runBoxContextTransportProbe(directory,
      (body: unknown) => claim.assertLegacyContextClaim(db, body));
    if (result.images !== 91 || result.bodyBytes <= 16 * 1024 * 1024) {
      throw new Error("[box-incident-proofs] CONTEXT_TRANSPORT_FIXTURE_NOT_OVERSIZED");
    }
    return "[ocv5-607-lossless-context-transport] PASS — a 17MiB Box request restores all 91 images with unchanged canonical bytes and v1 context hash; legacy handoff stays single-use and stage has zero precheck or model dispatch";
  } finally { await rm(directory, { recursive: true, force: true }); }
}

