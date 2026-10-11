import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const repo = mkdtempSync(join(tmpdir(), "biome-changed-"));
after(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}
function run(): { status: number | null; out: string } {
  const r = spawnSync("bash", [join(repo, "scripts/check-biome-changed.sh"), "--base", "base"], { cwd: repo, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

mkdirSync(join(repo, "scripts"));
mkdirSync(join(repo, "node_modules"));
copyFileSync(join(ROOT, "scripts/check-biome-changed.sh"), join(repo, "scripts/check-biome-changed.sh"));
copyFileSync(join(ROOT, "biome.json"), join(repo, "biome.json"));
symlinkSync(join(ROOT, "node_modules/.bin"), join(repo, "node_modules/.bin"));
writeFileSync(join(repo, ".gitignore"), "node_modules\n");
// one pre-existing error (noDelete)
writeFileSync(join(repo, "old.ts"), "const o: Record<string, number> = { a: 1 }\ndelete o.a\nexport { o }\n");
git("init", "-q", "-b", "base");
git("add", ".");
git("commit", "-q", "-m", "base");
git("checkout", "-q", "-b", "work");

test("touching a file with an old error passes", () => {
  writeFileSync(join(repo, "old.ts"), "const o: Record<string, number> = { a: 1, b: 2 }\ndelete o.a\nexport { o }\n");
  const r = run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /pre-existing errors/);
});

test("adding an error to a changed file fails", () => {
  writeFileSync(join(repo, "old.ts"), "const o: Record<string, number> = { a: 1, b: 2 }\ndelete o.a\ndelete o.b\nexport { o }\n");
  const r = run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /old\.ts: 2 biome errors \(was 1/);
});

test("a new file counts from zero", () => {
  writeFileSync(join(repo, "old.ts"), "const o: Record<string, number> = { a: 1 }\ndelete o.a\nexport { o }\n");
  writeFileSync(join(repo, "fresh.ts"), "const o: Record<string, number> = { a: 1 }\ndelete o.a\nexport { o }\n");
  git("add", "fresh.ts");
  const r = run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /fresh\.ts: 1 biome errors \(was 0/);
});
