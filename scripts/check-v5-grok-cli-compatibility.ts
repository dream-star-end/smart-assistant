/** Release gate for INC-20261001-GROK-CLI-426.
 * xAI rejects Grok CLI older than 1.0.13 with 426 Upgrade Required, so every
 * grok-build turn failed while the runtime image carried 1.0.5. deploy-v5.sh
 * runs this file from the pinned candidate archive:
 *   tsx scripts/check-v5-grok-cli-compatibility.ts --candidate-sha <40-hex>
 * It runs the three places in deploy-v5.sh that decide whether a runtime image
 * may be put in service (prepare_offline_cutover, assert_target_runtime_image_ready,
 * activate_staged_inner) by sourcing the real script and calling the real
 * functions with DRY=0. Only the transport is replaced: `ssh` runs the
 * unchanged command or heredoc locally inside a private capsule directory,
 * where docker, systemctl, curl, psql, hostname and npx are recording stand-ins
 * and scp is refused. Git is real, on a fixture repository. The fourth seam
 * is the master's Grok web search handler, served over loopback HTTP against a
 * stand-in upstream that applies xAI's version rule.
 * Not proven here: the binary inside a built image and a real upstream 426.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Total budget for the whole gate, fixture preparation included. The
 * consumers run synchronously, so each one is given what is left of it and is
 * killed with its whole process group when that runs out. */
const LIMIT_MS = 120_000;
const startedAt = Date.now();
const remainingMs = (): number => LIMIT_MS - (Date.now() - startedAt);
const CANDIDATE = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const DEPLOY = join(CANDIDATE, "scripts/deploy-v5.sh");
/** The oldest Grok CLI xAI still serves. */
const MINIMUM = "1.0.13";
const IMAGE = "openclaude/openclaude-runtime:v5-proof-slim";
const OLD_IMAGE = "openclaude/openclaude-runtime:v5-proof-previous";
const IMAGE_ID = `sha256:${"8".repeat(64)}`;
const OLD_IMAGE_ID = `sha256:${"7".repeat(64)}`;
const BUILD = "0123456789abcdef";
const NONCE = "a".repeat(32);

function fail(message: string): never {
  throw new Error(`[grok-cli-compatibility] ${message}`);
}
function parseArgs(argv: string[]): string {
  const args = argv.slice(2);
  if (args.length !== 2 || args[0] !== "--candidate-sha" || !/^[0-9a-f]{40}$/.test(args[1] ?? "")) {
    fail("usage: check-v5-grok-cli-compatibility.ts --candidate-sha <40-hex>");
  }
  return args[1]!;
}
const atLeast = (version: string, minimum: string): boolean => {
  const a = version.split(".").map(Number), b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** Stand-ins for the programs the production host runs. Each appends its
 * arguments to calls.log; what it answers is fixed by the capsule's state. */
const STANDINS: Record<string, string> = {
  hostname: `echo capsule-host`,
  curl: `echo '{"ok":true,"channel":"v5"}'`,
  npx: `exit 0`,
  systemctl: `case "$1" in
  is-active) if [[ "$STANDIN_UNIT" == active ]]; then [[ "\${2:-}" == --quiet ]] || echo active; exit 0; fi
    [[ "\${2:-}" == --quiet ]] || echo inactive; exit 3 ;;
  start) exit 77 ;;
  *) exit 64 ;;
esac`,
  psql: `case "$*" in
  *string_agg*) echo 0001_fixture ;;
  *"count(*) FROM schema_migrations"*) echo 1 ;;
  *information_schema.columns*) echo 1 ;;
  *0123_gpt56_models*) echo true ;;
  *) exit 64 ;;
esac`,
  docker: `case "$1 $2" in
  "image inspect")
    image="\${@: -1}"; id=${IMAGE_ID}; [[ "$image" == ${OLD_IMAGE} ]] && id=${OLD_IMAGE_ID}
    case "$*" in
      *"{{.Id}}|"*) echo "$id|$STANDIN_COMMIT|0|1" ;;
      *"{{.Id}}"*) echo "$id" ;;
      *oc.runtime.source_commit*) echo "$STANDIN_COMMIT" ;;
      *oc.runtime.codex_version*) echo 0.159.2 ;;
      *oc.runtime.include_grok*) echo 1 ;;
      *) : ;;
    esac ;;
  "run --rm")
    case "$*" in
      *"--entrypoint grok-native"*) echo "$STANDIN_GROK" ;;
      *"--entrypoint codex"*) echo "codex-cli 0.159.2" ;;
      *) exit 64 ;;
    esac ;;
  *) exit 64 ;;
esac`,
};

function sh(cwd: string, command: string, args: string[]): string {
  const ran = spawnSync(command, args, { cwd, encoding: "utf8", timeout: Math.max(1, remainingMs() - 2000),
    killSignal: "SIGKILL" });
  if (ran.status !== 0) fail(`FIXTURE_${command}_${args[0]}: ${ran.stderr}`);
  return ran.stdout.trim();
}

/** A private directory holding everything the three consumers touch: a clean
 * fixture repository standing for the canonical checkout, the "remote" source
 * tree, env file, cutover root and lock, and the stand-in programs. */
function capsule() {
  const root = mkdtempSync(join(tmpdir(), "ocv5-308-grok-"));
  const write = (path: string, content: string, mode = 0o600) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content, { mode });
  };
  write("repo/deploy/v5/commercial-v5.env.overrides", `OC_RUNTIME_IMAGE=${IMAGE}\n`);
  write("repo/deploy/v5/release-metadata.json", JSON.stringify({ databaseCompatibility: "backward-compatible",
    requiredMigrations: ["0001_fixture"] }));
  write("repo/packages/commercial/src/db/migrations/0001_fixture.sql", "SELECT 1;\n");
  write("repo/packages/web-react/dist/index.html", `<meta name="oc-build" content="${BUILD}">\n`);
  const repo = join(root, "repo");
  sh(repo, "git", ["init", "-q", "-b", "proof"]);
  sh(repo, "git", ["-c", "user.name=proof", "-c", "user.email=proof@invalid", "add", "-A"]);
  sh(repo, "git", ["-c", "user.name=proof", "-c", "user.email=proof@invalid", "commit", "-q", "-m", "fixture"]);
  const commit = sh(repo, "git", ["rev-parse", "HEAD"]);
  write("remote/src/VERSION.json", JSON.stringify({ commit: commit.slice(0, sh(repo, "git", ["rev-parse", "--short", "HEAD"]).length) }));
  write("remote/src/packages/web-react/dist/index.html", `<meta name="oc-build" content="${BUILD}">\n`);
  mkdirSync(join(root, "remote/cutovers"), { recursive: true });
  for (const [name, body] of Object.entries(STANDINS)) {
    write(`bin/${name}`, `#!/bin/bash\nprintf '%s\\n' "${name} $*" >> "$CAPSULE/calls.log"\n${body}\n`, 0o700);
    chmodSync(join(root, `bin/${name}`), 0o700);
  }
  return { root, commit,
    /** The env file as production has it before this run: the previous image is pinned. */
    resetEnv: () => write("remote/commercial-v5.env", `OC_RUNTIME_IMAGE=${OLD_IMAGE}\nDATABASE_URL=capsule\n`),
    calls: () => existsSync(join(root, "calls.log")) ? readFileSync(join(root, "calls.log"), "utf8").trim().split("\n") : [],
    resetCalls: () => rmSync(join(root, "calls.log"), { force: true }),
    read: (path: string) => readFileSync(join(root, path), "utf8"),
    exists: (path: string) => existsSync(join(root, path)),
    write, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** Source the real deploy-v5.sh and call one of its functions with DRY=0. */
function consumer(box: ReturnType<typeof capsule>, grok: string, unit: "active" | "inactive", call: string) {
  box.resetCalls();
  const harness = `set -euo pipefail
export V5_DEPLOY_SOURCE_ONLY=1
source '${DEPLOY}'
REPO_ROOT="$CAPSULE/repo"; RELEASE_METADATA="$REPO_ROOT/deploy/v5/release-metadata.json"
KL_HOST=capsule; REMOTE_SRC="$CAPSULE/remote/src"; V5_ENV="$CAPSULE/remote/commercial-v5.env"
V5_UNIT=capsule-proof.service; V5_PORT=1
CUTOVER_ROOT="$CAPSULE/remote/cutovers"; CUTOVER_LOCK="$CAPSULE/remote/cutover.lock"; DRY=0
# transport only: the command or heredoc deploy-v5.sh sends is run unchanged, inside the capsule
ssh() {
  shift
  if [[ "\${1:-}" == bash && "\${2:-}" == -s ]]; then shift 2; PATH="$CAPSULE/bin:/usr/bin:/bin" bash -s "$@"
  else PATH="$CAPSULE/bin:/usr/bin:/bin" bash -c "$*"; fi
}
scp() { echo 'capsule: scp refused' >&2; return 97; }
${call}
`;
  const seconds = Math.floor(remainingMs() / 1000) - 2;
  if (seconds < 1) fail("DEADLINE_EXCEEDED");
  // timeout(1) runs the harness in its own process group and kills the group, so nothing it started outlives it
  const ran = spawnSync("/usr/bin/timeout", ["--signal=KILL", String(seconds), "bash", "-c", harness], { encoding: "utf8",
    timeout: seconds * 1000 + 1500, killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin", HOME: box.root, CAPSULE: box.root, STANDIN_GROK: grok, STANDIN_UNIT: unit,
      STANDIN_COMMIT: box.commit, ALLOW_ANY_BRANCH: "1" } });
  if (ran.status === 137 || ran.signal === "SIGKILL" || ran.error) fail("DEADLINE_EXCEEDED");
  return { status: ran.status, out: `${ran.stdout}`, err: `${ran.stderr}`, calls: box.calls() };
}
const current = `grok ${MINIMUM} (capsule)`;
const previous = "grok 1.0.5 (previous commercial image)";

// The image that is about to be put in service is checked while v5 is still online.
function proveOfflinePrepare(box: ReturnType<typeof capsule>): string {
  const call = `CUTOVER_TARGET_IMAGE='${IMAGE}'; CUTOVER_NONCE='${NONCE}'; prepare_offline_cutover`;
  box.resetEnv();
  const old = consumer(box, previous, "active", call);
  if (old.status === 0 || !old.err.includes(`FATAL: image Grok binary mismatch (expected grok ${MINIMUM}`)) {
    fail(`OFFLINE_PREPARE_ACCEPTED_OLD_CLI_${old.status}: ${old.err.slice(-300)}`);
  }
  if (old.calls.some((line) => line.startsWith("psql ")) || box.exists(`remote/cutovers/${NONCE}`)) {
    fail("OFFLINE_PREPARE_OLD_CLI_WENT_ON");
  }
  const ok = consumer(box, current, "active", call);
  if (ok.status !== 0) fail(`OFFLINE_PREPARE_REFUSED_${ok.status}: ${ok.err.slice(-400)}`);
  const manifest = JSON.parse(box.read(`remote/cutovers/${NONCE}/manifest.json`)) as Record<string, unknown>;
  if (manifest.target_image !== IMAGE || manifest.target_image_id !== IMAGE_ID || manifest.old_image !== OLD_IMAGE
    || manifest.target_commit !== box.commit) fail("OFFLINE_PREPARE_MANIFEST");
  if (!ok.calls.includes(`docker run --rm --entrypoint grok-native ${IMAGE} --version`)) fail("OFFLINE_PREPARE_CLI_NOT_RUN");
  return "[grok-426-offline-prepare] PASS — the cutover is prepared only for an image whose Grok CLI is 1.0.13";
}

// The online slim image switch.
function proveOnlineImage(box: ReturnType<typeof capsule>): string {
  box.write("remote/commercial-v5.env", `OC_RUNTIME_IMAGE=${OLD_IMAGE}\nOC_RUNTIME_RELEASE=/runtime/current\nDATABASE_URL=capsule\n`);
  const call = `TARGET_RUNTIME_IMAGE='${IMAGE}'; TARGET_RUNTIME_IMAGE_ID='${IMAGE_ID}'; ENABLE_RELEASE_FLAG=1
assert_target_runtime_image_ready`;
  const old = consumer(box, previous, "active", call);
  if (old.status === 0 || !old.err.includes(`expected='grok ${MINIMUM}`)) {
    fail(`ONLINE_IMAGE_ACCEPTED_OLD_CLI_${old.status}: ${old.err.slice(-300)}`);
  }
  const ok = consumer(box, current, "active", call);
  if (ok.status !== 0 || !ok.out.includes(`grok=${current}`)) fail(`ONLINE_IMAGE_REFUSED_${ok.status}: ${ok.err.slice(-400)}`);
  return "[grok-426-online-image] PASS — the online image switch accepts only Grok CLI 1.0.13";
}

// The staged activation: the stopped unit may be started only on a checked image.
function proveStagedActivation(box: ReturnType<typeof capsule>): string {
  const bundle = `remote/cutovers/${NONCE}`;
  const call = `CUTOVER_NONCE='${NONCE}'; activate_staged_inner`;
  const staged = (grok: string) => {
    box.resetEnv();
    box.write(`${bundle}/state.json`, JSON.stringify({ state: "activating", updated_at: 1 }));
    return consumer(box, grok, "inactive", call);
  };
  const old = staged(previous);
  if (old.status === 0 || !old.err.includes(`runtime image Grok binary=${previous},expected='grok ${MINIMUM}`)) {
    fail(`STAGED_ACTIVATION_ACCEPTED_OLD_CLI_${old.status}: ${old.err.slice(-300)}`);
  }
  if (old.calls.some((line) => line.startsWith("systemctl start"))) fail("STAGED_ACTIVATION_OLD_CLI_STARTED");
  const ok = staged(current);
  if (!ok.out.includes(`✓ runtime image source=${box.commit},codex=codex-cli 0.159.2,grok=${current}`)) {
    fail(`STAGED_ACTIVATION_REFUSED_${ok.status}: ${ok.err.slice(-400)}`);
  }
  // the manifest's image was installed into the env file before the check, by the product's own step
  if (!box.read("remote/commercial-v5.env").includes(`OC_RUNTIME_IMAGE=${IMAGE}\n`)) fail("STAGED_ACTIVATION_ENV");
  return "[grok-426-staged-activation] PASS — the staged unit is checked against Grok CLI 1.0.13 before it may start";
}

/** xAI's CLI chat proxy as the incident recorded it: older clients get 426. */
function upstream(seen: Array<{ headers: IncomingMessage["headers"]; body: Record<string, unknown> }>): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      const version = String(req.headers["x-grok-client-version"] ?? "0");
      if (!atLeast(version, MINIMUM)) {
        res.writeHead(426, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Your Grok CLI version (${version}) is outdated. Please update to version ${MINIMUM} or later` }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: [
        { type: "web_search_call", action: { sources: [{ url: "https://example.com/bare" }] } },
        { type: "message", content: [{ type: "output_text",
          text: '{"results":[{"title":"result","url":"https://example.com/a","snippet":"found"}]}' }] }] }));
    });
  });
}
const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  resolve(typeof address === "object" && address ? address.port : 0);
}));

// The master's Grok web search calls the same upstream with a hard-coded client version.
async function proveWebSearchHeader(): Promise<string> {
  const proxy = await import(pathToFileURL(join(CANDIDATE, "packages/commercial/src/grok/webSearchProxy.ts")).href);
  const identity = await import(pathToFileURL(join(CANDIDATE, "packages/commercial/src/auth/containerIdentity.ts")).href);
  const { request } = await import("undici");
  const seen: Array<{ headers: IncomingMessage["headers"]; body: Record<string, unknown> }> = [];
  const xai = upstream(seen);
  const xaiPort = await listen(xai);
  const secret = "b".repeat(64);
  const handler = proxy.makeGrokWebSearchHandler({
    identityRepo: { findActiveByHostAndBoundIp: async () =>
      ({ id: 42, user_id: 7, bound_ip: "127.0.0.1", host_uuid: "proof-host", secret_hash: identity.hashSecret(secret) }) },
    pickAccountId: async () => 1n, freshToken: async () => Buffer.from("capsule-token"), recordStatus: async () => {},
    // the handler's own request, sent to the loopback upstream instead of xAI
    requestFn: (url: string, init: Record<string, unknown>) => {
      if (url !== proxy.GROK_SEARCH_UPSTREAM) fail("WEB_SEARCH_OTHER_UPSTREAM");
      return request(`http://127.0.0.1:${xaiPort}/v1/responses`, { ...init, dispatcher: undefined } as never);
    } });
  const master = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handler(req, res, { hostUuid: "proof-host", boundIp: "127.0.0.1" });
  });
  const masterPort = await listen(master);
  try {
    const answer = await fetch(`http://127.0.0.1:${masterPort}${proxy.GROK_WEB_SEARCH_PATH}`, { method: "POST",
      headers: { authorization: `Bearer oc-v3.42.${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ q: "release notes" }) });
    const sent = seen[0];
    if (!sent) fail("WEB_SEARCH_NO_UPSTREAM_CALL");
    const version = String(sent.headers["x-grok-client-version"]);
    if (!atLeast(version, MINIMUM)) fail(`WEB_SEARCH_CLIENT_VERSION_${version}`);
    if (answer.status !== 200) fail(`WEB_SEARCH_FAILED_${answer.status}`);
    const hits = (await answer.json() as { organic?: Array<{ url?: string }> }).organic ?? [];
    if (hits[0]?.url !== "https://example.com/a") fail("WEB_SEARCH_NO_RESULTS");
    if (sent.headers["x-grok-model-override"] !== "grok-build" || sent.headers.authorization !== "Bearer capsule-token"
      || !JSON.stringify(sent.body.tools).includes("web_search")) fail("WEB_SEARCH_REQUEST_SHAPE");
    return "[grok-426-web-search-header] PASS — the master's Grok web search presents a client version xAI serves";
  } finally {
    master.close();
    xai.close();
  }
}

// What a new runtime image is built with.
function proveImagePin(): string {
  const dockerfile = readFileSync(join(CANDIDATE, "packages/commercial/agent-sandbox/Dockerfile.openclaude-runtime"), "utf8");
  const build = readFileSync(join(CANDIDATE, "packages/commercial/agent-sandbox/build-image.sh"), "utf8");
  const arg = /^ARG OC_GROK_VERSION=([0-9.]+)$/m.exec(dockerfile)?.[1] ?? "";
  const pinned = /^GROK_VERSION="([0-9.]+)"$/m.exec(build)?.[1] ?? "";
  if (!arg || !atLeast(arg, MINIMUM)) fail(`IMAGE_PIN_DOCKERFILE_${arg || "missing"}`);
  if (pinned !== arg) fail(`IMAGE_PIN_BUILD_SCRIPT_${pinned || "missing"}`);
  return "[grok-426-image-pin] PASS — a new runtime image is built with a Grok CLI xAI serves";
}

async function main(): Promise<void> {
  const candidateSha = parseArgs(process.argv);
  let box: ReturnType<typeof capsule> | undefined;
  // covers the asynchronous web search seam; the synchronous consumers enforce the same budget themselves
  const deadline = setTimeout(() => {
    console.error("[grok-cli-compatibility] deadline exceeded");
    box?.remove();
    process.exit(1);
  }, Math.max(1, remainingMs()));
  try {
    box = capsule();
    const proofs = [proveOfflinePrepare(box), proveOnlineImage(box), proveStagedActivation(box),
      await proveWebSearchHeader(), proveImagePin()];
    const digest = createHash("sha256").update(readFileSync(DEPLOY)).digest("hex");
    process.stdout.write(`${JSON.stringify({ ok: true, candidateSha, candidate: CANDIDATE, deploySha256: digest, proofs })}\n`);
  } finally {
    clearTimeout(deadline);
    box?.remove();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
