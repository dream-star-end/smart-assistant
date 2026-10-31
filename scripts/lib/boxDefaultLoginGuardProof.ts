/** Release-gate proof: the live guard covers the default Box login. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOX_PROFILE_GUARD_REFUSED, makeBoxProfileGuard } from "../../packages/commercial/src/http/proxy/boxProfileDiscovery.js";

function run(home: string, profile: string): string {
  const request = makeBoxProfileGuard(profile);
  const args = request.args.map((arg) => arg.replaceAll("/home/box", home));
  try {
    return execFileSync(request.command, args, { encoding: "utf8" }).trim();
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    const out = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
    if (out.includes("SECRET-CREDENTIAL-TOKEN") || out.includes("@")) throw new Error("guard output leaked");
    return `exit ${failed.status}`;
  }
}

export function proveBoxDefaultLoginGuard(): string {
  const home = mkdtempSync(join(tmpdir(), "box-default-guard-"));
  const secret = "SECRET-CREDENTIAL-TOKEN";
  const mail = "alice.example@mail.example.com";
  try {
    mkdirSync(`${home}/.claude/projects`, { recursive: true });
    writeFileSync(`${home}/.claude/.credentials.json`, `{"token":"${secret}"}`);
    writeFileSync(`${home}/.claude.json`, JSON.stringify({
      hasCompletedOnboarding: true, oauthAccount: { emailAddress: mail } }));
    if (run(home, "default") !== "ok") throw new Error("complete default login was refused");
    rmSync(`${home}/.claude/.credentials.json`);
    if (run(home, "default") !== `exit ${BOX_PROFILE_GUARD_REFUSED}`) throw new Error("missing credential was accepted");
    writeFileSync(`${home}/.claude/.credentials.json`, `{"token":"${secret}"}`);
    writeFileSync(`${home}/.claude.json`, JSON.stringify({ hasCompletedOnboarding: false }));
    if (run(home, "default") !== `exit ${BOX_PROFILE_GUARD_REFUSED}`) throw new Error("unfinished onboarding was accepted");
    writeFileSync(`${home}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: mail } }));
    if (run(home, "default") !== `exit ${BOX_PROFILE_GUARD_REFUSED}`) throw new Error("missing onboarding flag was accepted");
    mkdirSync(`${home}/.claude-b`);
    writeFileSync(`${home}/.claude-b/.credentials.json`, "{}");
    symlinkSync(`${home}/.claude/projects`, `${home}/.claude-b/projects`);
    if (run(home, "b") !== "ok") throw new Error("named login regressed");
    return "[ocv5-box-default-login-guard] PASS — a default login with no credential or unfinished onboarding is refused and a complete one is accepted";
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
