import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function requireSecureDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("auth session parent must be a real directory");
  }
  if (stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("auth session parent must be owned by the current user with mode 0700");
  }
}

function requireSecureFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("auth session must be a regular file");
  }
  if (stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("auth session must be owned by the current user with mode 0600");
  }
}

function validateSession(session) {
  if (
    typeof session?.access_token !== "string" ||
    !session.access_token ||
    !Number.isSafeInteger(session.access_exp) ||
    session.access_exp <= 0 ||
    typeof session.refresh_cookie !== "string" ||
    !session.refresh_cookie
  ) {
    throw new Error("auth session is incomplete");
  }
  return session;
}

function readRefreshCookie(response) {
  const setCookies =
    response.headers.getSetCookie?.() ??
    [response.headers.get("set-cookie")].filter(Boolean);
  const value = setCookies
    .map((cookie) => /(?:^|;\s*)oc_rt=([^;]+)/.exec(cookie)?.[1])
    .find(Boolean);
  if (!value) throw new Error("auth response missing refresh cookie");
  return decodeURIComponent(value);
}

async function sessionFromResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = await response.json();
  return validateSession({
    access_token: body.access_token,
    access_exp: body.access_exp,
    refresh_cookie: readRefreshCookie(response),
  });
}

export function loadAuthSession(path) {
  requireSecureDirectory(dirname(path));
  requireSecureFile(path);
  return validateSession(JSON.parse(readFileSync(path, "utf8")));
}

export function writeAuthSession(path, session) {
  requireSecureDirectory(dirname(path));
  const validated = validateSession(session);
  const temp = `${dirname(path)}/.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temp, `${JSON.stringify(validated)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  requireSecureFile(path);
  return validated;
}

export async function loginAuthSession(base, email, password, fetchImpl = fetch) {
  const response = await fetchImpl(`${base.replace(/\/$/, "")}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, turnstile_token: "x" }),
  });
  return sessionFromResponse(response, "login");
}

export async function refreshAuthSession(base, path, fetchImpl = fetch) {
  const current = loadAuthSession(path);
  const response = await fetchImpl(`${base.replace(/\/$/, "")}/api/auth/refresh`, {
    method: "POST",
    headers: { Cookie: `oc_rt=${encodeURIComponent(current.refresh_cookie)}` },
  });
  const next = await sessionFromResponse(response, "refresh");
  return writeAuthSession(path, next);
}

export async function ensureAuthSession(base, path, fetchImpl = fetch, now = Date.now()) {
  const session = loadAuthSession(path);
  if (session.access_exp > Math.floor(now / 1000) + 120) return session;
  return refreshAuthSession(base, path, fetchImpl);
}

export async function authorizedFetch(base, path, url, init = {}, fetchImpl = fetch) {
  let session = await ensureAuthSession(base, path, fetchImpl);
  const send = () => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${session.access_token}`);
    return fetchImpl(url, { ...init, headers });
  };
  let response = await send();
  if (response.status === 401) {
    session = await refreshAuthSession(base, path, fetchImpl);
    response = await send();
  }
  return response;
}

export function updateAuthSessionRefreshCookie(path, refreshCookie) {
  if (typeof refreshCookie !== "string" || !refreshCookie) {
    throw new Error("browser refresh cookie is empty");
  }
  return writeAuthSession(path, {
    ...loadAuthSession(path),
    refresh_cookie: refreshCookie,
  });
}

export function updateAuthSessionFromBrowserCookies(path, cookies) {
  const refresh = cookies?.find((cookie) => cookie?.name === "oc_rt")?.value;
  if (!refresh) throw new Error("browser auth session lost oc_rt");
  return updateAuthSessionRefreshCookie(path, refresh);
}

export async function logoutAuthSession(base, path, fetchImpl = fetch) {
  const session = loadAuthSession(path);
  const response = await fetchImpl(`${base.replace(/\/$/, "")}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: `oc_rt=${encodeURIComponent(session.refresh_cookie)}` },
  });
  if (!response.ok) {
    throw new Error(`logout failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}

export function destroyAuthSession(path) {
  if (resolve(path) !== path || basename(path) !== "session.json") {
    throw new Error("auth session cleanup path must be canonical and end in session.json");
  }
  const parent = dirname(path);
  if (!/^\/tmp\/v5-parallel-auth\.[A-Za-z0-9]{6}$/.test(parent)) {
    throw new Error("auth session cleanup directory is not a direct mktemp child");
  }
  requireSecureDirectory(parent);
  const entries = readdirSync(parent);
  if (entries.some((entry) => entry !== "session.json")) {
    throw new Error("auth session cleanup directory contains unexpected files");
  }
  if (entries.includes("session.json")) {
    requireSecureFile(path);
    rmSync(path);
  }
  rmdirSync(parent);
}

export const _internals = {
  readRefreshCookie,
  requireSecureDirectory,
  requireSecureFile,
  sessionFromResponse,
  validateSession,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, ...argv] = process.argv.slice(2);
  const args = Object.fromEntries(
    Array.from({ length: Math.ceil(argv.length / 2) }, (_, index) => [
      argv[index * 2]?.replace(/^--/, ""),
      argv[index * 2 + 1],
    ]),
  );
  if (operation === "logout" && args.base && args.file) {
    await logoutAuthSession(args.base, args.file);
  } else if (operation === "cleanup" && args.file) {
    destroyAuthSession(args.file);
  } else {
    throw new Error(
      "usage: auth-session.mjs logout --base <url> --file <session.json> | " +
      "cleanup --file <session.json>",
    );
  }
}
