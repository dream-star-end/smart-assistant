/**
 * codexAuthFile — per-container codex auth.json writer for v3 commercial.
 *
 * **Why this file exists separately from gateway's `codexAuthSync.ts`**:
 * v3 commercial tracks codex tokens **per-account** (`claude_accounts WHERE
 * provider='codex'`), and each user container is sticky-bound to one of those
 * accounts via `agent_containers.codex_account_id`. Each bound container
 * receives its own auth.json under `<codexContainerDir>/<container_id>/`,
 * mounted ro into the container at `/home/agent/.codex/`. The legacy
 * gateway path (`syncCodexAuthFile`) writes a single shared dir from
 * `config.auth.codexOAuth` and is preserved untouched for backward
 * compatibility with NULL-codex_account_id containers.
 *
 * **Container variant strips `refresh_token`**: only access_token (+ auth_mode
 * "chatgpt" + account_id) is written. The codex CLI inside the container has
 * no refresh_token so it cannot self-refresh — the commercial-side refresh
 * actor (G2) is the single source of truth, preventing rotate races between
 * a container and the gateway/actor.
 *
 * **Atomic write protocol** (matches plan M2 invariant):
 *   1. mkdir parent dir 0o755 (so container agent uid 1000 can enter)
 *   2. writeFile tmp 0o600
 *   3. chown tmp → containerUid (so codex CLI can read once we chmod 0o400)
 *   4. chmod tmp 0o400
 *   5. atomic rename tmp → final
 *
 * Caller (provision F1 / actor G2 / lazy migrate G5) must wrap this in
 * a `SELECT ... FOR UPDATE` transaction held until the rename completes
 * to serialize with concurrent writers — see plan decision M2 / N2.
 *
 * **Path validation** (plan note 19): final filePath is resolved and must
 * start with `<rootDir>/`, no `..` traversal — defends against future bugs
 * passing tainted container_id into the path.
 */

import { chmod, chown, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

import { extractChatGptAccountId } from "./extractAccountId.js";

export interface CodexContainerAuthInput {
  /** Plaintext access_token from the codex OAuth pool row (decrypted by caller). */
  accessToken: string;
  /** ISO timestamp of when this token was last refreshed; written into `last_refresh`. */
  lastRefreshIso: string;
}

export interface WriteCodexContainerAuthFileOptions {
  /** Root dir all per-container files must live under (e.g. `/var/lib/openclaude-v3/codex-container-auth`). */
  rootDir: string;
  /** Container id — used as subdir name. Caller must pre-validate it is a digit string. */
  containerId: string;
  /** UID/GID owning the written file (= container agent uid, default 1000). */
  containerUid: number;
  containerGid: number;
  /** Token material to write. */
  auth: CodexContainerAuthInput;
}

export interface WriteCodexContainerAuthFileResult {
  /** Final absolute path written, e.g. `<rootDir>/<containerId>/auth.json`. */
  filePath: string;
}

/**
 * Validate that resolving `<rootDir>/<containerId>/auth.json` stays under
 * `<rootDir>/`. Rejects empty / non-digit container_id and any traversal.
 */
function resolveAuthPath(rootDir: string, containerId: string): {
  parentDir: string;
  filePath: string;
} {
  if (!/^\d+$/.test(containerId)) {
    throw new Error(`codexAuthFile: invalid containerId (must be digits): ${containerId}`);
  }
  const rootResolved = resolve(rootDir);
  const parent = resolve(rootResolved, containerId);
  const final = resolve(parent, "auth.json");
  const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  if (!parent.startsWith(rootWithSep) || !final.startsWith(rootWithSep)) {
    throw new Error(
      `codexAuthFile: resolved path escapes rootDir (rootDir=${rootResolved} cid=${containerId})`,
    );
  }
  return { parentDir: parent, filePath: final };
}

/**
 * Write the per-container `auth.json` atomically.
 *
 * **Throws** on any IO failure — caller is expected to catch and rollback
 * the surrounding DB transaction (plan F1 / N2 ROLLBACK paths).
 */
export async function writeCodexContainerAuthFile(
  opts: WriteCodexContainerAuthFileOptions,
): Promise<WriteCodexContainerAuthFileResult> {
  const { parentDir, filePath } = resolveAuthPath(opts.rootDir, opts.containerId);
  const accountId = extractChatGptAccountId(opts.auth.accessToken) ?? "";

  // Parent must allow agent uid to enter (0o755 owner=root rwx, others=r-x).
  await mkdir(parentDir, { recursive: true, mode: 0o755 });

  // Container variant: NO refresh_token. id_token empty (not preserved across
  // accounts — different codex accounts may have different identities, and
  // chatgpt auth_mode tolerates empty id_token because the access_token
  // carries identity).
  const content = JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    tokens: {
      id_token: "",
      access_token: opts.auth.accessToken,
      refresh_token: "",
      account_id: accountId,
    },
    last_refresh: opts.auth.lastRefreshIso,
  });

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  let tmpWritten = false;
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    tmpWritten = true;
    // chown before rename so the final file is owned correctly even if
    // chmod-after-rename loses the race. Requires CAP_CHOWN on caller.
    await chown(tmp, opts.containerUid, opts.containerGid);
    await chmod(tmp, 0o400);
    await rename(tmp, filePath);
    return { filePath };
  } catch (err) {
    if (tmpWritten) {
      // best-effort cleanup; ignore missing file etc.
      await unlink(tmp).catch(() => {});
    }
    throw err;
  }
}

/**
 * Best-effort cleanup of a per-container auth dir on container removal
 * (plan F3). Never throws — caller's container-remove flow should not be
 * broken by leftover host files.
 */
export async function removeCodexContainerAuthDir(
  rootDir: string,
  containerId: string,
): Promise<void> {
  if (!/^\d+$/.test(containerId)) return;
  const { parentDir, filePath } = resolveAuthPath(rootDir, containerId);
  await unlink(filePath).catch(() => {});
  // rmdir not strictly necessary; leaving empty dir is harmless. We try
  // anyway so the host doesn't accumulate stopped-container dirs.
  await import("node:fs/promises")
    .then((fs) => fs.rmdir(parentDir).catch(() => {}))
    .catch(() => {});
}
